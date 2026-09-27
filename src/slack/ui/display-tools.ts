import * as v from 'valibot';

import {
  PresentCardsSchema,
  PresentChartSchema,
  PresentDetailsSchema,
  SLACK_PRESENT_CARDS_TOOL_NAME,
  SLACK_PRESENT_CHART_TOOL_NAME,
  SLACK_PRESENT_DETAILS_TOOL_NAME,
  SLACK_PRESENTATION_TOOL_DEFINITIONS,
  SlackPresentationInputError,
  validatePresentCards,
  validatePresentChart,
  validatePresentDetails,
  type PresentCardsInput,
  type PresentChartInput,
  type PresentDetailsInput,
} from './presentation-tools.ts';
import type { DisplaySurfaceSpec } from './surface.ts';

/**
 * present_cards, present_chart and present_details: display components that
 * ride in the answer message. Each call is validated at once (a teaching error
 * on bad input) and written as a data part; the host re-validates, stores and
 * compiles them at delivery. Two per reply, cards at most once.
 */
export const SLACK_DISPLAY_COMPONENTS_DATA_NAME = 'slackDisplayComponents';
export const MAX_DISPLAY_COMPONENTS = 2;

export const SlackDisplayComponentSchema = v.strictObject({
  kind: v.picklist(['cards', 'chart', 'details']),
  spec: v.unknown(),
});
export type SlackDisplayComponentPart = v.InferOutput<typeof SlackDisplayComponentSchema>;

function describe(name: string): string {
  return SLACK_PRESENTATION_TOOL_DEFINITIONS.find((tool) => tool.name === name)!.description;
}

/** Re-validate stored or written components; anything invalid is dropped. */
export function parseDisplayComponents(value: unknown): DisplaySurfaceSpec[] {
  const parts = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const components: DisplaySurfaceSpec[] = [];
  for (const part of parts) {
    const parsed = v.safeParse(SlackDisplayComponentSchema, part);
    if (!parsed.success) continue;
    try {
      const { kind, spec } = parsed.output;
      if (kind === 'cards') components.push({ kind, cards: validatePresentCards(v.parse(PresentCardsSchema, spec)) });
      if (kind === 'chart') components.push({ kind, chart: validatePresentChart(v.parse(PresentChartSchema, spec)) });
      if (kind === 'details') components.push({ kind, details: validatePresentDetails(v.parse(PresentDetailsSchema, spec)) });
    } catch {
      // A component that no longer validates is left out; the prose stands alone.
    }
    if (components.length === MAX_DISPLAY_COMPONENTS) break;
  }
  return components;
}

const DISPLAY_NOUNS = { cards: 'Cards', chart: 'Chart', details: 'Details' } as const;

/** The production result a display tool returns; the eval returns the same text. */
export function displayToolAcknowledgement(kind: SlackDisplayComponentPart['kind'], left: number): string {
  return `${DISPLAY_NOUNS[kind]} recorded under your answer${left ? `; ${left} more display component allowed` : ''}. Don't repeat its contents in prose.`;
}

export function createDisplayTools(write: (part: SlackDisplayComponentPart) => void) {
  let used = 0;
  let cardsUsed = false;
  const record = (kind: SlackDisplayComponentPart['kind'], spec: unknown): { output: string } => {
    if (used >= MAX_DISPLAY_COMPONENTS) {
      throw new Error('This reply already has two display components; put anything else in prose.');
    }
    if (kind === 'cards' && cardsUsed) throw new Error('Use present_cards once per reply.');
    write({ kind, spec });
    used += 1;
    if (kind === 'cards') cardsUsed = true;
    return { output: displayToolAcknowledgement(kind, MAX_DISPLAY_COMPONENTS - used) };
  };
  const teaching = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof SlackPresentationInputError) throw new Error(error.message);
      throw error;
    }
  };
  return {
    cards: {
      name: SLACK_PRESENT_CARDS_TOOL_NAME,
      description: describe(SLACK_PRESENT_CARDS_TOOL_NAME),
      input: PresentCardsSchema,
      output: v.string(),
      run: ({ data }: { data: PresentCardsInput }) =>
        teaching(() => record('cards', validatePresentCards(data))),
    },
    chart: {
      name: SLACK_PRESENT_CHART_TOOL_NAME,
      description: describe(SLACK_PRESENT_CHART_TOOL_NAME),
      input: PresentChartSchema,
      output: v.string(),
      run: ({ data }: { data: PresentChartInput }) =>
        teaching(() => record('chart', validatePresentChart(data))),
    },
    details: {
      name: SLACK_PRESENT_DETAILS_TOOL_NAME,
      description: describe(SLACK_PRESENT_DETAILS_TOOL_NAME),
      input: PresentDetailsSchema,
      output: v.string(),
      run: ({ data }: { data: PresentDetailsInput }) =>
        teaching(() => record('details', validatePresentDetails(data))),
    },
  };
}
