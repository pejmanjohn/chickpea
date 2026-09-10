import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import {
  CHART_MAX_CATEGORIES,
  CHART_MAX_PIE_SLICES,
  CHART_MAX_SERIES,
  ChartSpecError,
  chartSpecSchema,
  renderChart,
  validateChartSpec,
} from '../charts/render-chart.ts';
import { assertArtifactDeliveryAllowed } from '../memory/tool-policy.ts';
import type {
  SlackArtifactInput,
  SlackArtifactResult,
} from '../slack/web-client-presenter.ts';

export const RENDER_CHART_TOOL_NAME = 'render_chart';
const DEFAULT_CHART_FILENAME = 'chart.png';
const MAX_FILENAME_CHARS = 64;

export interface ChartArtifactToolOptions {
  channel: string;
  threadTs?: string;
  postArtifact(input: SlackArtifactInput): Promise<SlackArtifactResult>;
}

export type ChartArtifactResult =
  | { uploaded: true; filename: string; width: number; height: number; byteLength: number }
  | (Extract<SlackArtifactResult, { uploaded: false }> & { filename: string });

const CHART_TOOL_INPUT = v.object({
  ...chartSpecSchema.entries,
  filename: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_FILENAME_CHARS))),
});

/**
 * Render a chart PNG inside the runtime and attach it to the bound Slack
 * thread. No sandbox, container, repository grant, or paid plan is involved:
 * the renderer is a bounded pure-JS rasterizer, and delivery reuses the same
 * destination-bound upload path and side-effect policy as `post_artifact`.
 */
export function createChartArtifactTool(options: ChartArtifactToolOptions) {
  return defineTool({
    name: RENDER_CHART_TOOL_NAME,
    description:
      `Render a bar, line, or pie chart as a PNG image and attach it to the bound Slack destination. Give category labels and one or more numeric series with one value per label (up to ${CHART_MAX_CATEGORIES} categories and ${CHART_MAX_SERIES} series; a pie chart takes one series of non-negative values and at most ${CHART_MAX_PIE_SLICES} slices). Values are printed on the chart, so pass exact numbers, plus valuePrefix such as "$" or valueSuffix such as "%" when the unit matters. State the key figures in the final reply as well. If the result reports uploaded: false, explain the returned reason and describe the figures instead.`,
    input: CHART_TOOL_INPUT,
    async run({ data }) {
      assertArtifactDeliveryAllowed();
      const { filename, ...spec } = data;
      try {
        validateChartSpec(spec);
      } catch (error) {
        if (error instanceof ChartSpecError) throw new Error(`chart spec is invalid: ${error.message}`);
        throw error;
      }
      const rendered = await renderChart(spec);
      const name = chartFilename(filename);
      const result = await options.postArtifact({
        channel: options.channel,
        ...(options.threadTs ? { threadTs: options.threadTs } : {}),
        bytes: rendered.png,
        filename: name,
        ...(spec.title === undefined ? {} : { title: spec.title }),
      });
      const output: ChartArtifactResult = result.uploaded
        ? {
            uploaded: true,
            filename: name,
            width: rendered.width,
            height: rendered.height,
            byteLength: rendered.png.byteLength,
          }
        : { ...result, filename: name };
      return { output };
    },
  });
}

/** Keep the Slack-visible filename to a safe basename with a `.png` suffix. */
export function chartFilename(requested: string | undefined): string {
  const base = (requested ?? DEFAULT_CHART_FILENAME)
    .split(/[\\/]/)
    .pop()!
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, MAX_FILENAME_CHARS);
  if (base.length === 0) return DEFAULT_CHART_FILENAME;
  return /\.png$/i.test(base) ? base : `${base.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.png`;
}
