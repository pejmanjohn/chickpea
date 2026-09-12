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
import {
  artifactFilename,
  MAX_ARTIFACT_FILENAME_CHARS,
  type SlackArtifactStageInput,
  type SlackArtifactStageOutcome,
} from './artifact-tool.ts';

export const RENDER_CHART_TOOL_NAME = 'render_chart';
const DEFAULT_CHART_FILENAME = 'chart.png';
const CHART_EXTENSION = 'png';

export interface ChartArtifactToolOptions {
  channel: string;
  threadTs?: string;
  stageArtifact(input: SlackArtifactStageInput): Promise<SlackArtifactStageOutcome>;
}

export type ChartArtifactResult =
  | { attached: true; filename: string; width: number; height: number; byteLength: number }
  | (Extract<SlackArtifactStageOutcome, { attached: false }> & { filename: string });

const CHART_TOOL_INPUT = v.object({
  ...chartSpecSchema.entries,
  filename: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_ARTIFACT_FILENAME_CHARS)),
  ),
});

/**
 * Render a chart PNG inside the runtime and stage it for the bound Slack
 * destination. No sandbox, container, repository grant, or paid plan is
 * involved: the renderer is a bounded pure-JS rasterizer, and staging reuses
 * the same destination-bound receipt path and side-effect policy as
 * `post_artifact`; the host publishes the file with the final reply.
 */
export function createChartArtifactTool(options: ChartArtifactToolOptions) {
  return defineTool({
    name: RENDER_CHART_TOOL_NAME,
    description:
      `Render a bar, line, or pie chart as a PNG image and attach it to your final reply in the bound Slack destination. Give category labels and one or more numeric series with one value per label (up to ${CHART_MAX_CATEGORIES} categories and ${CHART_MAX_SERIES} series; a pie chart takes one series of non-negative values and at most ${CHART_MAX_PIE_SLICES} slices). Values are printed on the chart, so pass exact numbers, plus valuePrefix such as "$" or valueSuffix such as "%" when the unit matters. State the key figures in the final reply as well. If the result reports attached: false, explain the returned reason and describe the figures instead.`,
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
      const result = await options.stageArtifact({
        bytes: rendered.png,
        filename: name,
        ...(spec.title === undefined ? {} : { title: spec.title }),
        kind: 'chart',
      });
      const output: ChartArtifactResult = result.attached
        ? {
            attached: true,
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
  return artifactFilename(requested, DEFAULT_CHART_FILENAME, CHART_EXTENSION);
}
