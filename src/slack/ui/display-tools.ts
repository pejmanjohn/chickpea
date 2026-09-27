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
import { UI_SURFACE_MAX_SPEC_BYTES, type DisplaySurfaceSpec } from './surface.ts';

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
/** The data part's value: every display component this reply recorded, in call order. */
export const SlackDisplayComponentsSchema = v.pipe(
  v.array(SlackDisplayComponentSchema),
  v.maxLength(MAX_DISPLAY_COMPONENTS),
);
type DisplayKind = SlackDisplayComponentPart['kind'];
/** The component each display tool records; the policy rebuilds a reply's history by it. */
export const DISPLAY_TOOL_KINDS: Readonly<Record<string, DisplayKind>> = {
  [SLACK_PRESENT_CARDS_TOOL_NAME]: 'cards',
  [SLACK_PRESENT_CHART_TOOL_NAME]: 'chart',
  [SLACK_PRESENT_DETAILS_TOOL_NAME]: 'details',
};

function describe(name: string): string {
  return SLACK_PRESENTATION_TOOL_DEFINITIONS.find((tool) => tool.name === name)!.description;
}

/** The record the host stores for a component; the surface store caps a spec's size. */
function storedSpecBytes(kind: DisplayKind, spec: unknown): number {
  return new TextEncoder().encode(JSON.stringify({ kind, [kind]: spec })).byteLength;
}

function displaySurfaceSpec(kind: DisplayKind, spec: unknown): DisplaySurfaceSpec {
  switch (kind) {
    case 'cards': return { kind, cards: validatePresentCards(v.parse(PresentCardsSchema, spec)) };
    case 'chart': return { kind, chart: validatePresentChart(v.parse(PresentChartSchema, spec)) };
    case 'details': return { kind, details: validatePresentDetails(v.parse(PresentDetailsSchema, spec)) };
  }
}

/**
 * Re-validate stored or written components under the tools' own rules: two
 * per reply, cards once, and only a spec the store can keep. Anything else is
 * left out and the prose stands alone.
 */
export function parseDisplayComponents(value: unknown): DisplaySurfaceSpec[] {
  // A data part keeps its latest write, and each write is the reply's whole
  // list; take the last list written (a lone part is still accepted).
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const latest = [...entries].reverse().find(Array.isArray) as unknown[] | undefined;
  const parts = latest ?? entries;
  const components: DisplaySurfaceSpec[] = [];
  for (const part of parts) {
    if (components.length === MAX_DISPLAY_COMPONENTS) break;
    const parsed = v.safeParse(SlackDisplayComponentSchema, part);
    if (!parsed.success) continue;
    const { kind, spec } = parsed.output;
    if (kind === 'cards' && components.some((component) => component.kind === 'cards')) continue;
    if (storedSpecBytes(kind, spec) > UI_SURFACE_MAX_SPEC_BYTES) continue;
    try {
      components.push(displaySurfaceSpec(kind, spec));
    } catch {
      // A component that no longer validates is left out.
    }
  }
  return components;
}

const DISPLAY_NOUNS = { cards: 'Cards', chart: 'Chart', details: 'Details' } as const;

/** The production result a display tool returns; the eval returns the same text. */
export function displayToolAcknowledgement(kind: DisplayKind, left: number): string {
  return `${DISPLAY_NOUNS[kind]} recorded under your answer${left ? `; ${left} more display component allowed` : ''}. Don't repeat its contents in prose.`;
}

/** A display component this reply already recorded, keyed by the tool call that recorded it. */
export interface RecordedDisplayComponent extends SlackDisplayComponentPart {
  toolCallId: string;
}

const part = ({ kind, spec }: RecordedDisplayComponent): SlackDisplayComponentPart => ({ kind, spec });

export function createDisplayTools(
  /** Receives the reply's whole list each time: a later write replaces the part. */
  write: (parts: SlackDisplayComponentPart[]) => void,
  options: {
    /** Whether a card button without a url can be clicked here (see interactiveSurfaceScope). */
    requestButtons?: boolean;
    /**
     * Components this reply recorded through earlier tool closures, rebuilt
     * from the durable transcript. Flue renders the agent (and so these tools)
     * again before every model turn, so a closure only ever sees its own batch.
     */
    history?: () => readonly RecordedDisplayComponent[];
  } = {},
) {
  /** This closure's own calls: the ones the transcript cannot show yet. */
  const written: RecordedDisplayComponent[] = [];
  /** Earlier turns first (the transcript), then this closure's own, once each. */
  const recorded = (): RecordedDisplayComponent[] => {
    const earlier = options.history?.() ?? [];
    const seen = new Set(earlier.map((component) => component.toolCallId));
    return [...earlier, ...written.filter((component) => !seen.has(component.toolCallId))];
  };
  const record = (kind: DisplayKind, spec: unknown, toolCallId: string): { output: string } => {
    const prior = recorded();
    if (prior.length >= MAX_DISPLAY_COMPONENTS) {
      throw new Error('This reply already has two display components; put anything else in prose.');
    }
    if (kind === 'cards' && prior.some((component) => component.kind === 'cards')) {
      throw new Error('Use present_cards once per reply.');
    }
    if (storedSpecBytes(kind, spec) > UI_SURFACE_MAX_SPEC_BYTES) {
      throw new Error(
        `This component is too large to keep (over ${UI_SURFACE_MAX_SPEC_BYTES / 1024} KiB); shorten its text and links or show fewer items.`,
      );
    }
    const component = { toolCallId, kind, spec };
    written.push(component);
    write([...prior, component].map(part));
    return { output: displayToolAcknowledgement(kind, MAX_DISPLAY_COMPONENTS - prior.length - 1) };
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
      run: ({ data, toolCallId }: { data: PresentCardsInput; toolCallId: string }) => teaching(() => {
        const cards = validatePresentCards(data);
        // A request button nobody could ever press is refused while the model can still fix it.
        if (options.requestButtons === false &&
            cards.cards.some((card) => card.actions?.some((action) => !action.url))) {
          throw new Error('Card buttons here can only open links: give each button a url, or leave it out.');
        }
        return record('cards', cards, toolCallId);
      }),
    },
    chart: {
      name: SLACK_PRESENT_CHART_TOOL_NAME,
      description: describe(SLACK_PRESENT_CHART_TOOL_NAME),
      input: PresentChartSchema,
      output: v.string(),
      run: ({ data, toolCallId }: { data: PresentChartInput; toolCallId: string }) =>
        teaching(() => record('chart', validatePresentChart(data), toolCallId)),
    },
    details: {
      name: SLACK_PRESENT_DETAILS_TOOL_NAME,
      description: describe(SLACK_PRESENT_DETAILS_TOOL_NAME),
      input: PresentDetailsSchema,
      output: v.string(),
      run: ({ data, toolCallId }: { data: PresentDetailsInput; toolCallId: string }) =>
        teaching(() => record('details', validatePresentDetails(data), toolCallId)),
    },
  };
}
