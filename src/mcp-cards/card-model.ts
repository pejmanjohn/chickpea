/**
 * What every card's state machine shares: the events a host and a person
 * make, the effects a card asks for, how a reply finds the view that asked,
 * and what a card shows. Each card's `step` returns the next state and its
 * effects; its `present` decides everything the card draws. Pure, so Node
 * tests drive the cards with real tool results.
 */

/** A tool result as a host delivers it. Untrusted: only its shape is checked. */
export interface ToolResult {
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface CardState<V extends { kind: string }> {
  view: V;
  /** A tool call the card made is in flight; every button waits. */
  busy: boolean;
  error?: string | undefined;
  /** Counts views, so a reply is used only by the view that made its call. */
  seq: number;
}

export interface Call {
  tool: string;
  args: Record<string, unknown>;
  /** The view that made the call; `sequenced` sets it. */
  seq?: number;
}

export type Effect =
  | { type: 'call'; call: Call }
  /** Fire one `tick` after this long, replacing any earlier timer. */
  | { type: 'timer'; inMs: number }
  /** Put `draft` in the composer when the host can; otherwise send `sent`. */
  | { type: 'message'; draft?: string; sent: string }
  | { type: 'open'; url: string };

export type CardEvent<A extends string> =
  | { type: 'result'; result: ToolResult; now: number }
  | { type: 'press'; action: A; now: number }
  /** A reply to a call the card made, even one that comes after `unreachable`. */
  | { type: 'reply'; call: Call; result: ToolResult; now: number }
  /** The host refused a call or gave up waiting. A write may still have run. */
  | { type: 'unreachable'; call: Call; now: number }
  /** The host did not open a link or take a message. */
  | { type: 'refused'; now: number }
  /** No result is coming: the host cancelled the tool call or never connected. */
  | { type: 'no_result'; now: number }
  | { type: 'tick'; now: number }
  /** The card mounted with a state it kept, or came back into view. */
  | { type: 'reread'; now: number };

export const POLL_INTERVAL_MS = 2_000;
/** A failed poll doubles the wait before the next, up to this. */
export const POLL_BACKOFF_MAX_MS = 16_000;
export const POLL_CEILING_MS = 2 * 60_000;

export function pollDelay(failures = 0): number {
  return Math.min(POLL_INTERVAL_MS * 2 ** failures, POLL_BACKOFF_MAX_MS);
}

export interface Step<V extends { kind: string }> {
  state: CardState<V>;
  effects: Effect[];
}

export type Next<V extends { kind: string }> = {
  state: Omit<CardState<V>, 'seq'> & { seq?: number };
  effects: Effect[];
};

export const stay = <V extends { kind: string }>(state: Next<V>['state'], effects: Effect[] = []): Next<V> => ({ state, effects });
export const show = <V extends { kind: string }>(view: V, effects: Effect[] = []): Next<V> => ({ state: { view, busy: false }, effects });
export const call = (tool: string, args: Record<string, unknown>): Effect => ({ type: 'call', call: { tool, args } });

/**
 * A card's `step`: a new view counts up `seq`, and each call it makes is
 * stamped with the view that made it.
 */
export function sequenced<V extends { kind: string }, A extends string>(
  transition: (state: CardState<V>, event: CardEvent<A>) => Next<V>,
): (state: CardState<V>, event: CardEvent<A>) => Step<V> {
  return (state, event) => {
    const next = transition(state, event);
    const seq = next.state.view === state.view ? state.seq : state.seq + 1;
    return {
      state: { ...next.state, seq },
      effects: next.effects.map((effect) => effect.type === 'call' ? { ...effect, call: { ...effect.call, seq } } : effect),
    };
  };
}

/**
 * A reply the card no longer waits for: a read an earlier view made, or a
 * write's second answer after its first moved the card on. The view stands
 * still while a write is in flight, so a call belongs to the view only when
 * seq matches.
 */
export function outdated(state: { seq: number }, made: Call): boolean {
  return made.seq !== state.seq;
}

export const GENERIC = 'That did not work. Try again.';
export const UNREACHABLE = 'Chickpea could not be reached. Try again.';
export const NOTHING = { kind: 'notice', title: 'Nothing to show here.' } as const;

/** Only a web link opens: a result is untrusted, and hosts open nothing else. */
export function httpsUrl(url: unknown): string | undefined {
  return typeof url === 'string' && URL.parse(url)?.protocol === 'https:' ? url : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorOf(result: ToolResult): string | undefined {
  if (!result.isError) return undefined;
  const error = isRecord(result.structuredContent) ? result.structuredContent.error : undefined;
  return isRecord(error) && typeof error.message === 'string' ? error.message : GENERIC;
}

export function errorCode(result: ToolResult): string | undefined {
  const error = isRecord(result.structuredContent) ? result.structuredContent.error : undefined;
  return result.isError && isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

/** The tool a result came from: hosts do not say, so card tools name it in `_meta`. */
export function toolOf(result: ToolResult): string | undefined {
  const tool = result._meta?.['chickpea/tool'];
  return typeof tool === 'string' ? tool : undefined;
}

// What a card shows. Fields from a result are only ever drawn as text.

export type Tone = 'ok' | 'warn';
export interface Inline { text: string; tone?: Tone }

/** One line of a list: a mark, what it is, and at most one thing to press. */
export interface Row<A extends string = string> {
  icon: 'done' | 'now' | 'failed' | 'warning' | 'unknown' | 'tile';
  /** With the tile icon: the letter on the tile. */
  tile?: string;
  title: string;
  detail?: string | undefined;
  tone?: Tone;
  /** A small button at the end of the row, or a text link: one that goes somewhere, or one that shows more. */
  control?: { label: string; action: A; style: 'primary' | 'secondary' | 'link' | 'toggle' };
}

export type Block<A extends string = string> =
  | { kind: 'text'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'section'; label: string }
  | { kind: 'note'; text: string; tone?: Tone }
  | { kind: 'exchange'; ask: string; answer: string; agent: string }
  | { kind: 'facts'; rows: Array<{ label: string; value: string; chips?: string[]; note?: string }> }
  | { kind: 'steps'; steps: Array<{ label: string; state: 'done' | 'now' | 'todo' | 'failed' }> }
  | { kind: 'rows'; rows: Array<Row<A>> };

export interface Button<A extends string = string> {
  label: string;
  action: A;
  tone: 'primary' | 'danger' | 'secondary';
}

export interface Presentation<A extends string = string> {
  avatar: 'agent' | 'alert' | 'none';
  title: string;
  /** A check mark before the title. */
  done?: true;
  subtitle?: Inline[];
  blocks: Array<Block<A>>;
  /** The line right above the buttons. */
  foot?: string;
  /** At most two, the primary first. */
  buttons: Array<Button<A>>;
  busy: boolean;
  error?: string | undefined;
}

/** A result that is not the shape it claims draws as nothing to show, with no buttons. */
export function presentSafely<S extends { busy: boolean; error?: string | undefined }, A extends string>(
  present: (state: S) => Presentation<A>,
): (state: S) => Presentation<A> {
  return (state) => {
    try {
      return present(state);
    } catch {
      return { busy: state.busy, error: state.error, avatar: 'none', title: NOTHING.title, blocks: [], buttons: [] };
    }
  };
}

/** Every button a person can press on the card, the row controls that are buttons included. */
export function buttonCount(shown: Presentation): number {
  const inRows = shown.blocks.flatMap((block) => block.kind === 'rows' ? block.rows : [])
    .filter(({ control }) => control?.style === 'primary' || control?.style === 'secondary').length;
  return shown.buttons.length + inRows;
}
