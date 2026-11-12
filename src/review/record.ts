/**
 * One run's review copy, `chickpea.run-review.v1`: what the prompt carried
 * this turn, the steps the Agent took, and how it ended. The builder scrubs
 * every string before the record exists; a port never sees one unscrubbed.
 */

import { createHmac } from 'node:crypto';

import { BROWSER_TOOL_NAMES } from '../browser/tools.ts';
import { CREDENTIAL_REPLACEMENT, redactCredentialLikeContent } from '../security/content-validation.ts';
import { SLACK_CANVAS_TOOL_NAMES } from '../slack/canvases/tools.ts';
import { SLACK_LIST_TOOL_NAMES } from '../slack/lists/tools.ts';
import { websiteLoginScrub, type RunReviewWebsiteLogins } from './website-logins.ts';

export { RunReviewScrubLimit } from './website-logins.ts';

export const RUN_REVIEW_RECORD_FORMAT = 'chickpea.run-review.v1';

/** A Slack user's stand-in: an HMAC of their ID under the installation's own review key. */
export type RunReviewPseudonym = `u_${string}`;

export interface RunReviewFileNote {
  name: string;
  size?: number;
}

export type RunReviewSurface = 'channel' | 'dm' | 'group_dm' | 'routine';

export type RunReviewOutcome = 'succeeded' | 'no_op' | 'failed' | 'stopped';

export type RunReviewStep =
  | { kind: 'text' | 'reasoning'; text: string }
  | { kind: 'tool'; name: string; input: string; output?: string; error?: string; durationMs?: number };

export interface RunReviewContextMessage {
  /** A person's pseudonym, or an app's or Agent's label. */
  author: RunReviewPseudonym | string;
  role: 'human' | 'agent' | 'app';
  text: string;
  files: RunReviewFileNote[];
}

export interface RunReviewRecordV1 {
  format: typeof RUN_REVIEW_RECORD_FORMAT;
  /** The canonical run ID, else the turn ID on the legacy path without one. */
  runId: string;
  /** ISO 8601. */
  recordedAt: string;
  surface: RunReviewSurface;
  agentId: string;
  /** The model the provider reported answering with. */
  model?: string;
  /**
   * The request. `text` holds every message of it, one per paragraph;
   * `followUps`, present when it had more than one message, repeats those
   * after the first, each with its sender, since a teammate's can be among
   * them. `author` is the first message's sender.
   */
  trigger: {
    author: RunReviewPseudonym | 'routine';
    text: string;
    files: RunReviewFileNote[];
    followUps?: Array<{ author: RunReviewPseudonym; text: string }>;
  };
  context: RunReviewContextMessage[];
  steps: RunReviewStep[];
  /** The Agent's delivered text. */
  answer?: string;
  outcome: RunReviewOutcome;
  error?: { class: string; message: string };
  /** ISO 8601. */
  timings: { receivedAt?: string; admittedAt?: string; settledAt: string };
  /** Something was cut to fit the caps. */
  truncated: boolean;
  /** Which trace produced `steps`: the observed stream, or the settled history read afterwards. */
  source: 'stream' | 'history';
}

/** What the builder scrubs into a record; people are named by their raw Slack user IDs. */
export interface RunReviewInput {
  runId: string;
  recordedAt: string;
  surface: RunReviewSurface;
  agentId: string;
  model?: string;
  trigger: {
    author: string;
    text: string;
    files: readonly RunReviewFileNote[];
    /** Slack user IDs, as `author`. */
    followUps?: readonly { author: string; text: string }[];
  };
  context: readonly {
    /** A person's Slack user ID, or an app's or Agent's label. */
    author: string;
    role: RunReviewContextMessage['role'];
    text: string;
    files: readonly RunReviewFileNote[];
  }[];
  steps: readonly RunReviewStep[];
  answer?: string;
  outcome: RunReviewOutcome;
  error?: { class: string; message: string };
  timings: RunReviewRecordV1['timings'];
  /** The trace was already cut while it was collected. */
  truncated: boolean;
  source: RunReviewRecordV1['source'];
  /** Every website login the installation saved, whichever Agents it is granted to. */
  websiteLogins: RunReviewWebsiteLogins;
  /**
   * The run grants a website login: each browser step keeps its tool name,
   * whether it failed, and its duration, and nothing else.
   */
  browserStepsWithheld: boolean;
}

export const RUN_REVIEW_FIELD_BYTES = 16 * 1024;
export const RUN_REVIEW_RECORD_BYTES = 256 * 1024;

/**
 * Slack reads whose results a copy omits unless they say they read the
 * current conversation. They can read another Channel of this workspace even
 * when it is shared through Slack Connect, which no copy keeps.
 */
export const RUN_REVIEW_READS_OMITTED_UNLESS_CURRENT: ReadonlySet<string> = new Set(['read_slack_thread', 'read_slack_channel']);
export const OTHER_CONVERSATION_OMITTED = '[other conversation omitted]';
export const BROWSER_STEP_OMITTED = '[browser step omitted]';

const PSEUDONYM_LABEL = 'chickpea-run-review-user-v1\0';
const PSEUDONYM_HEX_CHARS = 20;
// A mention's ID, or a bare token shaped like a Slack user ID. The digit
// lookahead keeps words such as UNDERSTAND intact.
const SLACK_USER_ID = /(?<=<@)[UW][A-Z0-9]{2,}(?=[|>])|\b[UW](?=[A-Z0-9]*\d)[A-Z0-9]{8,10}\b/g;

/**
 * Pseudonyms under one installation's review key, apart from the product
 * telemetry key and label. Lowercase hex never reads as a Slack user ID.
 */
export function runReviewPseudonymizer(key: Uint8Array): (slackUserId: string) => RunReviewPseudonym {
  const known = new Map<string, RunReviewPseudonym>();
  return (slackUserId) => {
    let pseudonym = known.get(slackUserId);
    if (!pseudonym) {
      const digest = createHmac('sha256', key).update(PSEUDONYM_LABEL).update(slackUserId).digest('hex');
      pseudonym = `u_${digest.slice(0, PSEUDONYM_HEX_CHARS)}`;
      known.set(slackUserId, pseudonym);
    }
    return pseudonym;
  };
}

/**
 * The record a port stores. Each field is first cut to its cap, and the
 * record to its cap, so the scrub reads about what a copy keeps rather than
 * all the collector held. Then every string that is left goes through, in
 * order: the link rules for website logins and the hosted browser, which must
 * see each URL whole; each key the run saved with save_connection_key or tried
 * with try_connection; each saved website login's username, except in the
 * run ID, Agent ID and model, which no page or person writes; recognizable
 * credentials; every Slack user ID; then its cap again, since a replacement
 * can be longer than what it replaced. File notes keep only a name and size;
 * a Slack List or canvas tool's output and error, a Slack read's result from
 * another conversation, and, in a run that grants a website login, every
 * browser step's input, output and error are omitted. The builder adds no Slack
 * team, channel, thread or message IDs. Past the record cap the oldest steps
 * go first, then the oldest context.
 *
 * Throws RunReviewScrubLimit when the scrub passes its budget, or the logins
 * pass its caps: such a copy is not kept, rather than kept part scrubbed.
 */
export function buildRunReviewRecord(
  input: RunReviewInput,
  pseudonymOf: (slackUserId: string) => RunReviewPseudonym,
): RunReviewRecordV1 {
  // A key saved in a step the cap drops still leaves every field that is kept.
  const keys = savedConnectionKeys(input.steps);
  const unscrubbed = fitRecord(shapeRecord(input, pseudonymOf, (text) => cutField(text, keys).text));
  const kept: RunReviewInput = {
    ...input,
    steps: input.steps.slice(input.steps.length - unscrubbed.steps.length),
    context: input.context.slice(input.context.length - unscrubbed.context.length),
  };
  let truncated = input.truncated || unscrubbed.truncated;
  const logins = websiteLoginScrub(input.websiteLogins);
  const record = shapeRecord(kept, pseudonymOf, (whole, kind) => {
    const { text, cut } = cutField(whole, keys);
    if (cut) truncated = true;
    const browserStep = kind === 'browser';
    const linked = logins.links(text, browserStep);
    logins.spend(linked.length * keys.length);
    const keyed = keys.reduce((value, key) => value.split(key).join(CREDENTIAL_REPLACEMENT), linked);
    const named = kind === 'fixed' && FIXED_TOKEN.test(text) ? keyed : logins.usernames(keyed, { browserStep, cut });
    logins.spend(named.length);
    const scrubbed = redactCredentialLikeContent(named).replace(SLACK_USER_ID, (id) => pseudonymOf(id));
    const capped = capUtf8(scrubbed, RUN_REVIEW_FIELD_BYTES);
    if (capped.length < scrubbed.length) truncated = true;
    return capped;
  });
  return fitRecord({ ...record, truncated });
}

/** The record's shape, with each string passed through `field`. */
function shapeRecord(
  input: RunReviewInput,
  pseudonymOf: (slackUserId: string) => RunReviewPseudonym,
  field: (text: string, kind: FieldKind) => string,
): RunReviewRecordV1 {
  const files = (notes: readonly RunReviewFileNote[]): RunReviewFileNote[] =>
    notes.map((note) => ({ name: field(note.name, 'text'), ...(note.size === undefined ? {} : { size: note.size }) }));
  return {
    format: RUN_REVIEW_RECORD_FORMAT,
    runId: field(input.runId, 'fixed'),
    recordedAt: input.recordedAt,
    surface: input.surface,
    agentId: field(input.agentId, 'fixed'),
    ...(input.model === undefined ? {} : { model: field(input.model, 'fixed') }),
    trigger: {
      author: input.trigger.author === 'routine' ? 'routine' : pseudonymOf(input.trigger.author),
      text: field(input.trigger.text, 'text'),
      files: files(input.trigger.files),
      ...(input.trigger.followUps?.length
        ? {
            followUps: input.trigger.followUps.map((message) => ({
              author: pseudonymOf(message.author),
              text: field(message.text, 'text'),
            })),
          }
        : {}),
    },
    context: input.context.map((message) => ({
      author: message.role === 'human' ? pseudonymOf(message.author) : field(message.author, 'text'),
      role: message.role,
      text: field(message.text, 'text'),
      files: files(message.files),
    })),
    steps: input.steps.map((step): RunReviewStep => {
      if (step.kind !== 'tool') return { kind: step.kind, text: field(step.text, 'text') };
      if (input.browserStepsWithheld && BROWSER_TOOLS.has(step.name)) return withheldBrowserStep(step);
      const kind: FieldKind = BROWSER_TOOLS.has(step.name) ? 'browser' : 'text';
      return {
        kind: 'tool',
        name: field(step.name, 'text'),
        input: field(keptInput(step.name, step.input), kind),
        ...(step.output === undefined ? {} : { output: field(keptOutput(step.name, step.output), kind) }),
        ...(step.error === undefined
          ? {}
          : { error: field(sharingUnknownTool(step.name) ? OTHER_CONVERSATION_OMITTED : step.error, kind) }),
        ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      };
    }),
    ...(input.answer === undefined ? {} : { answer: field(input.answer, 'text') }),
    outcome: input.outcome,
    ...(input.error
      ? { error: { class: field(input.error.class, 'text'), message: field(input.error.message, 'text') } }
      : {}),
    timings: input.timings,
    truncated: false,
    source: input.source,
  };
}

/**
 * A Slack List or canvas linked from an unshared Channel may be shared
 * through Slack Connect, no List or canvas tool says where it is shared, and
 * a write's result and error carry what it read back.
 */
function sharingUnknownTool(toolName: string): boolean {
  return (SLACK_LIST_TOOL_NAMES as readonly string[]).includes(toolName) ||
    (SLACK_CANVAS_TOOL_NAMES as readonly string[]).includes(toolName);
}

const BROWSER_TOOLS: ReadonlySet<string> = new Set(BROWSER_TOOL_NAMES);

/**
 * A browser step of a run that may browse signed in. Its name is one of
 * Chickpea's own tool names, so it is kept as written and never scrubbed; the
 * rest could hold a signed-in page, a sign-in link or a typed credential in
 * any form. A step that failed, as the framework or the tool itself reports
 * it, keeps an error; one that worked keeps an output.
 */
function withheldBrowserStep(step: Extract<RunReviewStep, { kind: 'tool' }>): RunReviewStep {
  const failed = step.error !== undefined || (step.output !== undefined && browserOutputFailed(step.output));
  return {
    kind: 'tool',
    name: step.name,
    input: BROWSER_STEP_OMITTED,
    ...(failed ? { error: BROWSER_STEP_OMITTED } : step.output === undefined ? {} : { output: BROWSER_STEP_OMITTED }),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
  };
}

/** A browser tool returns its own failures and refusals as output: an `error`, `refused: true` or `attached: false` (browser/tools.ts). */
function browserOutputFailed(output: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const result = parsed as { error?: unknown; refused?: unknown; attached?: unknown };
  return result.error !== undefined || result.refused === true || result.attached === false;
}

/**
 * What a field holds: text, a browser step's text, or a token that Chickpea
 * or the model provider writes: the run ID, the Agent ID and the model. A
 * username that is an ordinary word would break a token, and `agentId` files
 * the copy, so tokens skip the username rule. A tool's name and an error's
 * class are text: a model can call a tool by any name, and an error can carry
 * any.
 */
type FieldKind = 'text' | 'browser' | 'fixed';
/** A fixed token's shape. One that holds anything else, such as an email address, gets the username rule after all. */
const FIXED_TOKEN = /^[A-Za-z0-9_.:\/-]{1,200}$/;

/** The tools whose input carries a key the person pasted. */
const CONNECTION_KEY_TOOLS: ReadonlySet<string> = new Set(['save_connection_key', 'try_connection']);
const KEY_INPUT_OMITTED = '[input omitted]';

/**
 * Each key the run saved or tried, as typed and as JSON escapes it, so a copy
 * drops it from the person's message and the answer as well as from the call.
 */
function savedConnectionKeys(steps: readonly RunReviewStep[]): string[] {
  return steps.flatMap((step) => {
    if (step.kind !== 'tool' || !CONNECTION_KEY_TOOLS.has(step.name)) return [];
    const key = parsedKey(step.input);
    return key ? [key, JSON.stringify(key).slice(1, -1)] : [];
  }).sort((left, right) => right.length - left.length);
}

function parsedKey(input: string): string | undefined {
  try {
    const key = (JSON.parse(input) as { key?: unknown } | null)?.key;
    return typeof key === 'string' && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A key tool's call whose key cannot be read back, as when the collector cut
 * it, is dropped whole. A try_connection call with no key tried a saved one.
 */
function keptInput(toolName: string, input: string): string {
  if (!CONNECTION_KEY_TOOLS.has(toolName) || parsedKey(input) !== undefined) return input;
  return toolName === 'try_connection' && withoutKey(input) ? input : KEY_INPUT_OMITTED;
}

/** Whether a call's input parses whole and names no key. */
function withoutKey(input: string): boolean {
  try {
    const parsed = JSON.parse(input) as { key?: unknown } | null;
    return typeof parsed === 'object' && parsed !== null && parsed.key === undefined;
  } catch {
    return false;
  }
}

/** None of a Slack List or canvas tool's; a Slack read's only when it says it read the current conversation, or read nothing. */
function keptOutput(toolName: string, output: string): string {
  if (sharingUnknownTool(toolName)) return OTHER_CONVERSATION_OMITTED;
  if (!RUN_REVIEW_READS_OMITTED_UNLESS_CURRENT.has(toolName)) return output;
  let result: { status?: unknown; conversation?: { current?: unknown } } | null;
  try {
    result = JSON.parse(output) as typeof result;
  } catch {
    return OTHER_CONVERSATION_OMITTED;
  }
  return result?.status === 'not_read' || result?.conversation?.current === true
    ? output
    : OTHER_CONVERSATION_OMITTED;
}

function fitRecord(record: RunReviewRecordV1): RunReviewRecordV1 {
  let size = jsonBytes(record);
  if (size <= RUN_REVIEW_RECORD_BYTES) return record;
  // A dropped element takes its separating comma with it.
  const drop = <T>(items: readonly T[]): T[] => {
    let index = 0;
    while (size > RUN_REVIEW_RECORD_BYTES && index < items.length) {
      size -= jsonBytes(items[index]) + 1;
      index += 1;
    }
    return items.slice(index);
  };
  const steps = drop(record.steps);
  const context = drop(record.context);
  return { ...record, steps, context, truncated: true };
}

const encoder = new TextEncoder();

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/**
 * `text` cut to the field cap, before any rule reads it. A cut inside a URL,
 * a key or a token would leave a start no rule recognizes, and none of them
 * holds whitespace, a double quote or an angle bracket, so the cut moves back
 * to the last of those within CUT_LOOKBACK_CHARS. Where there is none, or the
 * cut would split a key the run saved, which may hold one, the text stays
 * whole: the scrub reads it all and the cap cuts it after. Either way `cut`
 * says the end may hold the start of a username.
 */
function cutField(text: string, keys: readonly string[]): { text: string; cut: boolean } {
  const capped = capUtf8(text, RUN_REVIEW_FIELD_BYTES);
  if (capped.length === text.length) return { text, cut: false };
  const floor = Math.max(capped.length - CUT_LOOKBACK_CHARS, 0);
  let end = capped.length - 1;
  while (end >= floor && !CUT_BOUNDARY.test(capped[end]!)) end -= 1;
  const clean = end >= floor && !keys.some((key) => runsAcross(text, key, end));
  return { text: clean ? capped.slice(0, end) : text, cut: true };
}

/** Whether `key` starts before `at` in `text` and ends after it. */
function runsAcross(text: string, key: string, at: number): boolean {
  const start = text.indexOf(key, Math.max(at - key.length + 1, 0));
  return start >= 0 && start < at;
}

const CUT_BOUNDARY = /[\s"<>]/;
const CUT_LOOKBACK_CHARS = 4096;

/** The longest prefix of `text` within `maxBytes` of UTF-8, never splitting a character. */
function capUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;
  const { read } = encoder.encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
}
