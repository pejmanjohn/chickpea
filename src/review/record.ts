/**
 * One run's review copy, `chickpea.run-review.v1`: what the prompt carried
 * this turn, the steps the Agent took, and how it ended. The builder scrubs
 * every string before the record exists; a port never sees one unscrubbed.
 */

import { createHmac } from 'node:crypto';

import { redactCredentialLikeContent } from '../security/content-validation.ts';

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
  trigger: { author: RunReviewPseudonym | 'routine'; text: string; files: RunReviewFileNote[] };
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
  trigger: { author: string; text: string; files: readonly RunReviewFileNote[] };
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
}

export const RUN_REVIEW_FIELD_BYTES = 16 * 1024;
export const RUN_REVIEW_RECORD_BYTES = 256 * 1024;

/**
 * Slack reading tools that can read a conversation other than the current
 * one. Their authority lets an Agent read another Channel of this workspace
 * even when that Channel is shared through Slack Connect, which no copy keeps.
 */
export const RUN_REVIEW_CONVERSATION_READ_TOOLS: ReadonlySet<string> = new Set(['read_slack_thread', 'read_slack_channel']);
export const OTHER_CONVERSATION_OMITTED = '[other conversation omitted]';

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
 * The record a port stores. Every string loses recognizable credentials,
 * then every Slack user ID, then is cut to its cap; file notes keep only a
 * name and size, and a reading tool's result from another conversation is
 * omitted. The builder adds no Slack team, channel, thread or message IDs.
 * Past the record cap the oldest steps go first, then the oldest context.
 */
export function buildRunReviewRecord(
  input: RunReviewInput,
  pseudonymOf: (slackUserId: string) => RunReviewPseudonym,
): RunReviewRecordV1 {
  let truncated = input.truncated;
  const field = (text: string): string => {
    const scrubbed = redactCredentialLikeContent(text).replace(SLACK_USER_ID, (id) => pseudonymOf(id));
    const capped = capUtf8(scrubbed, RUN_REVIEW_FIELD_BYTES);
    if (capped.length < scrubbed.length) truncated = true;
    return capped;
  };
  const files = (notes: readonly RunReviewFileNote[]): RunReviewFileNote[] =>
    notes.map((note) => ({ name: field(note.name), ...(note.size === undefined ? {} : { size: note.size }) }));
  const record: RunReviewRecordV1 = {
    format: RUN_REVIEW_RECORD_FORMAT,
    runId: field(input.runId),
    recordedAt: input.recordedAt,
    surface: input.surface,
    agentId: field(input.agentId),
    ...(input.model === undefined ? {} : { model: field(input.model) }),
    trigger: {
      author: input.trigger.author === 'routine' ? 'routine' : pseudonymOf(input.trigger.author),
      text: field(input.trigger.text),
      files: files(input.trigger.files),
    },
    context: input.context.map((message) => ({
      author: message.role === 'human' ? pseudonymOf(message.author) : field(message.author),
      role: message.role,
      text: field(message.text),
      files: files(message.files),
    })),
    steps: input.steps.map((step): RunReviewStep => step.kind === 'tool'
      ? {
          kind: 'tool',
          name: field(step.name),
          input: field(step.input),
          ...(step.output === undefined ? {} : { output: field(keptReadOutput(step.name, step.output)) }),
          ...(step.error === undefined ? {} : { error: field(step.error) }),
          ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
        }
      : { kind: step.kind, text: field(step.text) }),
    ...(input.answer === undefined ? {} : { answer: field(input.answer) }),
    outcome: input.outcome,
    ...(input.error ? { error: { class: field(input.error.class), message: field(input.error.message) } } : {}),
    timings: input.timings,
    truncated: false,
    source: input.source,
  };
  return fitRecord({ ...record, truncated });
}

/** A reading tool's result is kept only when it says it read the current conversation, or read nothing. */
function keptReadOutput(toolName: string, output: string): string {
  if (!RUN_REVIEW_CONVERSATION_READ_TOOLS.has(toolName)) return output;
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

/** The longest prefix of `text` within `maxBytes` of UTF-8, never splitting a character. */
function capUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;
  const { read } = encoder.encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
}
