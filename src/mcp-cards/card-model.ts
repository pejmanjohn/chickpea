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
  /**
   * The host answered the card's call with a JSON-RPC error instead of the
   * result: its own failure, such as ChatGPT's "MCP Resource not found" for a
   * tool it has not listed yet. ChatGPT also answers this way for a result
   * with `isError`, keeping only its text (probe 12), so a card session gets
   * Chickpea's refusals as results. Another host's `data` may carry one.
   * Never the error's message (`hostErrorOf`).
   */
  hostError?: HostError;
}

export interface HostError {
  code?: unknown;
  data?: unknown;
}

/**
 * A host's JSON-RPC error as a card keeps it: its code, and `data`, which
 * may carry Chickpea's refusal. Its message is the host's own words, which
 * can be a whole web page, such as Cloudflare's 504 page with the person's
 * IP address that ChatGPT sends when a call runs past 300 s (probe 13), so
 * it is dropped where the error comes in, and a card can never show or log it.
 */
export function hostErrorOf(error: unknown): HostError {
  if (!isRecord(error)) return {};
  return { ...'code' in error ? { code: error.code } : {}, ...isRecord(error.data) ? { data: error.data } : {} };
}

export interface CardState<V extends { kind: string }> {
  view: V;
  /** A tool call the card made is in flight; every button waits. */
  busy: boolean;
  error?: string | undefined;
  /** Counts views, so a reply is used only by the view that made its call. */
  seq: number;
  /** Everything this card told the host's model, oldest first, bounded. */
  told?: string[];
  /**
   * What the card's presses came to, for a card that mounts again with the
   * result it first had. Each card says what it keeps; never a token.
   */
  outcome?: unknown;
  /** The card sent its message that carries the job on (`carryOn`), here or before it mounted again. */
  continued?: true;
  /** The card mounted, and this many of its first reads are out: every button waits until each answers or fails. */
  checking?: number;
}

/**
 * What a card keeps in the host's widget state: what it already told the
 * host's model, its outcome, and whether it carried the job on.
 */
export interface Memory {
  told: string[];
  outcome?: unknown;
  continued?: true;
}

/**
 * The widget state a card writes: `modelContent` is what it told the host's
 * model, and `privateContent` holds the same sentences and the outcome for a
 * card that mounts again. ChatGPT hides `privateContent` from its model only
 * beside a `modelContent`, even an empty one (probe 12), so both always go,
 * in one write (`hostWrites`).
 * `modelContent` holds no ID, token or instructions. `privateContent` holds
 * no instructions, and one token only: a practice run's, while it is still
 * going (first-answer.ts `stillAnswering`).
 */
export function keptState(
  { told = [], outcome, continued }: { told?: string[] | undefined; outcome?: unknown; continued?: true | undefined },
  version: number,
) {
  return {
    modelContent: told.join('\n'),
    privateContent: { card: { version, told, ...outcome === undefined ? {} : { outcome }, ...continued ? { continued } : {} } },
  };
}

/** A sentence a host kept that is longer than any a card writes is not one. */
const TOLD_SENTENCE_MAX = 1_000;

/** What a card of this version kept in its host's widget state, read as untrusted. */
export function keptMemory(saved: unknown, version: number): Memory | undefined {
  const content = isRecord(saved) ? saved.privateContent : undefined;
  const card = isRecord(content) && isRecord(content.card) ? content.card : undefined;
  if (card?.version !== version || !Array.isArray(card.told)) return undefined;
  const told = card.told.filter((line): line is string => typeof line === 'string' && line.length <= TOLD_SENTENCE_MAX);
  return {
    told: boundedTold(told),
    ...card.outcome === undefined ? {} : { outcome: card.outcome },
    ...card.continued === true ? { continued: true as const } : {},
  };
}

/** What a card sends its host after a step, besides its calls, timers, links and messages. */
export type HostWrite =
  /** The widget state of a host that keeps one: what the card told the model, and what it keeps for a remount. */
  | { type: 'state'; state: ReturnType<typeof keptState> }
  /** `ui/update-model-context`, to a host that keeps no widget state. */
  | { type: 'context'; text: string };

/**
 * What the host's model learns of a step, and what a host that keeps widget
 * state keeps of it. ChatGPT keeps a `ui/update-model-context` in the place
 * it keeps a card's widget state, so one sent after the state replaced it:
 * a reloaded card found nothing it had kept, and offered Create, Save or
 * Turn off again (live check 2 bug 3, dry run M4). A host with widget state
 * gets only the state, whose `modelContent` its model reads; any other host
 * gets the model update. The state is written when what the card told or
 * its outcome moved, never for the result it mounts with.
 */
export function hostWrites<V extends { kind: string }>(
  before: CardState<V>,
  event: CardEvent<string>,
  next: Step<V>,
  host: { keepsState: boolean; version: number },
): HostWrite[] {
  if (!host.keepsState) return next.effects.flatMap((effect): HostWrite[] => effect.type === 'context' ? [{ type: 'context', text: effect.text }] : []);
  const moved = next.state.told !== before.told || next.state.outcome !== before.outcome || next.state.continued !== before.continued;
  return moved && event.type !== 'result' ? [{ type: 'state', state: keptState(next.state, host.version) }] : [];
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
  /**
   * Put `draft` in the composer when the host can; otherwise send `sent`.
   * `continues`: a message that carries the job on (`carryOn`).
   */
  | { type: 'message'; draft?: string; sent: string; continues?: true }
  | { type: 'open'; url: string }
  /**
   * What the card did, for the host's model on its next turn. A model's
   * `tell` names the newest press's outcome, never what the card shows;
   * `sequenced` sends it with everything the card told before, because each
   * update replaces this card's last one. `hostWrites` says how it goes.
   */
  | { type: 'context'; text: string };

export type CardEvent<A extends string> =
  /**
   * The result the card is drawn with: on its first mount, or again when a
   * chat reopens. `kept` is what the host kept of this card since.
   */
  | { type: 'result'; result: ToolResult; now: number; kept?: Memory | undefined }
  | { type: 'press'; action: A; now: number }
  /** A reply to a call the card made, even one that comes after `unreachable`. */
  | { type: 'reply'; call: Call; result: ToolResult; now: number }
  /** The host refused a call or gave up waiting. A write may still have run. */
  | { type: 'unreachable'; call: Call; now: number }
  /**
   * The host did not open a link or take a message. A host that never
   * answers says so a minute later, so the card checks it is the one it offers.
   */
  | { type: 'refused'; effect: Extract<Effect, { type: 'open' | 'message' }>; now: number }
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
/** The same step, and the host's model learns what the person did. */
export const tell = <V extends { kind: string }>(next: Next<V>, text: string): Next<V> =>
  ({ ...next, effects: [{ type: 'context', text }, ...next.effects] });

/**
 * The same step, and the card sends `text` in the chat as the person, so the
 * host's model carries the job on after a press that succeeded. A card sends
 * one such message in its life: `sequenced` drops any after the first, and
 * the host keeps that it sent one, so a chat that reopens never sends it again.
 */
export const carryOn = <V extends { kind: string }>(next: Next<V>, text: string): Next<V> =>
  ({ ...next, effects: [...next.effects, { type: 'message', sent: text, continues: true }] });

/**
 * A name in a message the card sends as the person, which the host's model
 * reads as the person's own words: quoted, on one line and cut short, since
 * a member chose it, so it reads as a name and never as an instruction.
 */
export function nameInMessage(name: string): string {
  const line = name.replace(/\s+/g, ' ').trim();
  return JSON.stringify(line.length > NAMED_MAX ? `${line.slice(0, NAMED_MAX - 1)}…` : line);
}

/** How one card remembers its presses' outcomes and comes back to them. */
export interface Remembering<V extends { kind: string }> {
  /** What a view a press's outcome left means for a card that mounts again; undefined keeps the last. */
  remember?: (view: V) => unknown;
  /** The view for the result a card mounts with, after what it kept; undefined shows the result's own. */
  resume?: (view: V, outcome: unknown) => V | undefined;
}

/** The most sentences a card sends its host's model at once, and their length together. */
export const TOLD_MAX = 6;
export const TOLD_CHARS = 1_500;

/**
 * A card's `step`: a new view counts up `seq`, and each call it makes is
 * stamped with the view that made it. A result mounts the card: it shows
 * what the card kept of its presses, then reads where things stand now, and
 * its buttons wait until each of those reads answers or fails. Everything
 * the card told the host's model goes with each new sentence, and a
 * sentence told again moves to the end instead of taking a second place.
 * A message that carries the job on goes once: one after it, or one from a
 * card that mounts again having sent it, is dropped, and so is the host's
 * refusal of it, since the press it follows did what it should.
 */
export function sequenced<V extends { kind: string }, A extends string>(
  transition: (state: CardState<V>, event: CardEvent<A>) => Next<V>,
  remembering: Remembering<V> = {},
): (state: CardState<V>, event: CardEvent<A>) => Step<V> {
  return (state, event) => {
    if (state.checking && event.type === 'press') return { state, effects: [] };
    if (event.type === 'refused' && event.effect.type === 'message' && event.effect.continues) return { state, effects: [] };
    let next = transition(state, event.type === 'result' || event.type === 'reply' ? { ...event, result: withHeld(event.result) } : event);
    let { told = [], outcome, continued } = state;
    let checking = 0;
    if (event.type === 'result') {
      ({ told, outcome, continued } = event.kept ?? { told: [] });
      const resumed = outcome === undefined ? undefined : remembering.resume?.(next.state.view, outcome);
      if (resumed) next = { state: { view: resumed, busy: false }, effects: [] };
      const reread = transition({ ...next.state, seq: state.seq }, { type: 'reread', now: event.now });
      checking = reread.effects.filter(({ type }) => type === 'call').length;
      // The re-read's calls and timer supersede the ones the result asked for.
      const superseded = new Set(reread.effects.map(({ type }) => type));
      next = { state: reread.state, effects: [...next.effects.filter(({ type }) => !superseded.has(type)), ...reread.effects] };
    } else if (state.checking && next.state.view === state.view) {
      const answered = (event.type === 'reply' || event.type === 'unreachable') && event.call.seq === state.seq;
      checking = state.checking - (answered ? 1 : 0);
    }
    const sentences = next.effects.flatMap((effect) => effect.type === 'context' ? [effect.text] : []);
    if (sentences.length > 0) {
      told = boundedTold([...told.filter((line) => !sentences.includes(line)), ...sentences]);
      outcome = remembering.remember?.(next.state.view) ?? outcome;
    }
    const seq = next.state.view === state.view ? state.seq : state.seq + 1;
    const { told: _told, outcome: _outcome, continued: _continued, checking: _checking, ...rest } = next.state;
    const effects = next.effects.flatMap((effect): Effect[] => {
      if (effect.type === 'context') return [];
      if (effect.type === 'call') return [{ ...effect, call: { ...effect.call, seq } }];
      if (effect.type !== 'message' || !effect.continues) return [effect];
      if (continued) return [];
      continued = true;
      return [effect];
    });
    return {
      state: {
        ...rest,
        seq,
        ...told.length ? { told } : {},
        ...outcome === undefined ? {} : { outcome },
        ...continued ? { continued } : {},
        ...checking > 0 ? { checking } : {},
      },
      effects: [...sentences.length > 0 ? [{ type: 'context' as const, text: told.join('\n') }] : [], ...effects],
    };
  };
}

/** The newest sentences, as many as fit: the newest always stays. */
export function boundedTold(told: readonly string[]): string[] {
  let kept = told.slice(-TOLD_MAX);
  while (kept.length > 1 && kept.join('\n').length > TOLD_CHARS) kept = kept.slice(1);
  return kept;
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

/**
 * A result with the tokens a card host gave the card in `_meta` back where
 * the shapes name them, so a card reads every result the same way.
 */
function withHeld(result: ToolResult): ToolResult {
  const held = result._meta?.['chickpea/held'];
  const content = result.structuredContent;
  if (!isRecord(held) || !isRecord(content)) return result;
  const confirmToken = typeof held.confirmToken === 'string' ? held.confirmToken : undefined;
  const undoToken = typeof held.undoToken === 'string' ? held.undoToken : undefined;
  return {
    ...result,
    structuredContent: {
      ...content,
      ...undoToken ? { undoToken } : {},
      ...confirmToken && isRecord(content.confirmation) ? { confirmation: { ...content.confirmation, confirmToken } } : {},
    },
  };
}

export const GENERIC = 'That did not work. Try again.';
export const UNREACHABLE = 'Chickpea could not be reached. Try again.';
export const NOTHING = { kind: 'notice', title: 'Nothing to show here.' } as const;

/** Only a web link opens: a result is untrusted, and hosts open nothing else. */
export function httpsUrl(url: unknown): string | undefined {
  return typeof url === 'string' && URL.parse(url)?.protocol === 'https:' ? url : undefined;
}

/** The longest Agent name a sentence for the host's model quotes whole. */
const NAMED_MAX = 60;

/**
 * An Agent in a sentence for the host's model: quoted and short, so a name
 * a member chose reads as a name and never as the host's own words.
 */
export function agentNamed(name: string, handle?: string): string {
  const short = name.length > NAMED_MAX ? `${name.slice(0, NAMED_MAX - 1)}…` : name;
  return `the Agent ${JSON.stringify(short)}${handle ? ` (@${handle})` : ''}`;
}

/**
 * A tool result with the `_meta` its host holds for the card, where the
 * card's tokens and tool name travel: ChatGPT's canonical place is
 * `window.openai.toolResponseMetadata`. A host may also send `_meta` of its
 * own, even empty, on the notification; both are kept, and the
 * notification's keys win.
 */
export function withResponseMeta<T extends ToolResult>(result: T, meta: unknown): T {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return result;
  return { ...result, _meta: { ...meta as Record<string, unknown>, ...result._meta } };
}

/** The longest server summary a sentence for the host's model appends. */
const SUMMARY_MAX = 200;

/**
 * A server summary at the end of a sentence for the host's model: one line,
 * cut short, since it can carry a name a member chose.
 */
export function summaryLine(summary: string): string {
  const line = summary.replace(/\s+/g, ' ').trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/**
 * Words from a result in a sentence for the host's model: a summary, a
 * service's name or a button's label, quoted as one short line, so they read
 * as Chickpea's or a member's words and never as the host's own.
 */
export function quoted(words: string): string {
  return JSON.stringify(summaryLine(words));
}

/**
 * Where to try an Agent: a mention reaches it only in its Channels, and a
 * direct message always does.
 */
export function tryIt(handle: string, channels: readonly string[]): string {
  if (channels.length === 0) return `Try it: message @${handle} in Slack.`;
  const where = channels.length <= 2 ? channels.join(' or ') : `${channels.slice(0, -1).join(', ')} or ${channels.at(-1)}`;
  return `Try it: mention @${handle} in ${where}.`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Chickpea refusal: its code and its sentence, written for the person. */
export interface Refusal {
  code: string;
  message: string;
  retryable?: unknown;
  fix?: unknown;
}

/**
 * Chickpea's refusal, wherever its host put it: in the result's
 * `structuredContent`, where a card session gets it in a result without
 * `isError`, or in the whole result a host keeps beside it (the
 * `mcp_tool_result` or `call_tool_result` ChatGPT puts in a result's `_meta`)
 * or sends with a JSON-RPC error. Never a host's own words: a failure with
 * no code is the host's, and may have happened after the call ran.
 */
export function refusalOf(result: ToolResult): Refusal | undefined {
  for (const place of carriers(result)) {
    const error = isRecord(place.structuredContent) ? place.structuredContent.error : undefined;
    if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
      return { code: error.code, message: error.message, retryable: error.retryable, fix: error.fix };
    }
  }
  return undefined;
}

/** The result, and every whole result a host may carry with it, nearest first. */
function carriers(result: ToolResult): Array<Record<string, unknown>> {
  const data = result.hostError?.data;
  const envelopes = (holder: unknown) => isRecord(holder)
    ? [holder.mcp_tool_result, holder.call_tool_result].filter(isRecord)
    : [];
  return [
    result as Record<string, unknown>,
    ...envelopes(result._meta),
    ...isRecord(data) ? [data, ...envelopes(data), ...envelopes(data._meta)] : [],
  ];
}

export function errorOf(result: ToolResult): string | undefined {
  return refusalOf(result)?.message ?? (result.isError ? GENERIC : undefined);
}

export function errorCode(result: ToolResult): string | undefined {
  return refusalOf(result)?.code;
}

/** A host's failure with no refusal of Chickpea's in it: like no answer, a write may have run. */
export function hostFailed(result: ToolResult): boolean {
  return result.hostError !== undefined && refusalOf(result) === undefined;
}

/** A way to fix something: a link, or a tool with its arguments. */
export type Fix = { label: string; url: string } | { label: string; tool: string; arguments: Record<string, unknown> };

/** Absent, a link, or a tool with its arguments: a press reads no other shape. */
export function isFix(fix: unknown): fix is Fix | undefined {
  return fix === undefined || (isRecord(fix) && typeof fix.label === 'string' &&
    (typeof fix.url === 'string' || (typeof fix.tool === 'string' && isRecord(fix.arguments))));
}

/**
 * Tools whose only effect is a setup link, so the press that calls one may
 * also open it: the person fixes on Chickpea's page. A fix with any other
 * tool goes to the chat, where the model proposes it first.
 */
export function opensSetupLink(fix: Extract<Fix, { tool: string }>): boolean {
  return fix.tool === 'reconnect_service' || fix.tool === 'connect_model_provider' ||
    (fix.tool === 'connect_service' && !('custom' in fix.arguments));
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
  /** A short label, such as a verdict, drawn as a chip before its detail. */
  chip?: string;
  /**
   * A small button at the end of the row, or a text link: one that goes
   * somewhere, or one that shows more. `expanded`: a toggle's state.
   */
  control?: { label: string; action: A; style: 'primary' | 'secondary' | 'link' | 'toggle'; expanded?: boolean };
  /** What the row shows under itself while its toggle has it open. */
  open?: Array<Block<A>>;
}

export type Block<A extends string = string> =
  | { kind: 'text'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'section'; label: string }
  | { kind: 'note'; text: string; tone?: Tone }
  /**
   * A question and the Agent's answer as Slack would show them, by picture
   * alone; a screen reader hears who says each. Long ones show their start,
   * or with `whole`, all of it.
   */
  | { kind: 'exchange'; ask: string; answer: string; agent: string; whole?: true }
  /** A line of small print: words, a stressed part, and services as chips. */
  | { kind: 'line'; parts: Array<{ text: string; strong?: true } | { chip: string }> }
  | { kind: 'steps'; steps: Array<{ label: string; state: 'done' | 'now' | 'todo' | 'failed' }> }
  | { kind: 'rows'; rows: Array<Row<A>> }
  /** Side by side where there is room: each pane's label, then its text as written. */
  | { kind: 'panes'; panes: Array<{ label: string; text: string }> };

export interface Button<A extends string = string> {
  label: string;
  action: A;
  tone: 'primary' | 'danger' | 'secondary';
}

export interface Presentation<A extends string = string> {
  avatar: 'agent' | 'alert' | 'none';
  /** The Agent's picture, drawn in place of the art when it loads. */
  avatarUrl?: string | undefined;
  title: string;
  /** What a screen reader hears when it changes; the title when absent. */
  announce?: string;
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

/**
 * A result that is not the shape it claims draws as nothing to show, with no
 * buttons. A card still checking where things stand draws its buttons
 * waiting, so it keeps its height and nothing can be pressed.
 */
export function presentSafely<S extends { busy: boolean; error?: string | undefined; checking?: number }, A extends string>(
  present: (state: S) => Presentation<A>,
): (state: S) => Presentation<A> {
  return (state) => {
    let shown: Presentation<A>;
    try {
      shown = present(state);
    } catch {
      return { busy: state.busy, error: state.error, avatar: 'none', title: NOTHING.title, blocks: [], buttons: [] };
    }
    return state.checking ? { ...shown, busy: true } : shown;
  };
}

/** Every button a person can press on the card, the row controls that are buttons included. */
export function buttonCount(shown: Presentation): number {
  const inRows = shown.blocks.flatMap((block) => block.kind === 'rows' ? block.rows : [])
    .filter(({ control }) => control?.style === 'primary' || control?.style === 'secondary').length;
  return shown.buttons.length + inRows;
}
