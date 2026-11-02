import { useTool } from '@flue/runtime';
import * as v from 'valibot';

import { isCloudflareTarget } from '../config/runtime-target.ts';
import { getSlackStateStore, type PlatformEnv } from '../config/state-backend.ts';
import { currentFlueObservationContext } from '../work/model-invocation.ts';
import type { SlackFollowUps } from './follow-up-fold.ts';
import { SLACK_REPLY_IN_THREAD_TOOL_NAME } from './follow-ups.ts';
import type { SlackPresentationMidRunReply } from './run-presentations.ts';
import { defaultSlackStatusRegistry } from './status-registry.ts';
import { threadRunnerStub } from './thread-runner-rpc.ts';

/**
 * Steering C (KTD14): while it works, the Agent may answer a message it read
 * mid-run with one short threaded reply, as itself, and keep working. Its
 * final reply still answers the whole request. It posts no progress updates
 * of its own accord, only when someone in the thread asked for one.
 *
 * The tool runs in the Agent and checks what this response read; the turn's
 * host posts through its presenter (the same sender as the final reply) and
 * records each post on the run presentation, which holds the limits below.
 */

/** A reply's length; longer text is cut at a word. */
export const MAX_MIDRUN_REPLY_CHARS = 600;
/** Replies one response may post. */
export const MAX_MIDRUN_REPLIES = 3;
/** The least time between two replies of one response. */
export const MIDRUN_REPLY_SPACING_MS = 20_000;

/** A message this response's model read mid-run (a late fold). */
export interface MidRunReadMessage {
  messageTs: string;
  /** Read for information only: the Agent must not answer it (see foldedInformationOnly). */
  informationOnly?: true;
}

export interface MidRunReplyRequest {
  /** The read message the reply answers. */
  messageTs: string;
  text: string;
}

/** Why the host did not post a reply. */
export type MidRunReplyRefusal =
  | 'answered'
  | 'limit'
  | 'too_soon'
  | 'final_started'
  | 'unavailable'
  | 'failed';

export type MidRunReplyOutcome = { posted: true } | { posted: false; refusal: MidRunReplyRefusal };

/** Posts one reply for the live turn, or says why not. */
export type MidRunReplyHandler = (request: MidRunReplyRequest) => Promise<MidRunReplyOutcome>;

const SLACK_TS = /^\d{1,12}\.\d{1,8}$/;

/** A request that crossed an isolate boundary, or undefined when it is not one. */
export function parseMidRunReplyRequest(value: unknown): MidRunReplyRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { messageTs, text } = value as Record<string, unknown>;
  if (typeof messageTs !== 'string' || !SLACK_TS.test(messageTs)) return undefined;
  if (typeof text !== 'string' || text.trim().length === 0 || Array.from(text).length > MAX_MIDRUN_REPLY_CHARS) {
    return undefined;
  }
  return { messageTs, text };
}

/** The text a reply posts: trimmed, and cut at a word with an ellipsis past MAX_MIDRUN_REPLY_CHARS. */
export function capMidRunReplyText(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text.trim());
  if (chars.length <= MAX_MIDRUN_REPLY_CHARS) return { text: chars.join(''), truncated: false };
  const room = chars.slice(0, MAX_MIDRUN_REPLY_CHARS - 1).join('');
  const atWord = room.replace(/\s+\S*$/, '');
  return { text: `${(atWord || room).trimEnd()}…`, truncated: true };
}

/** Why the replies this response already recorded leave no room for this one. */
export function midRunReplyRefusal(
  replies: readonly SlackPresentationMidRunReply[],
  messageTs: string,
  now: number,
): MidRunReplyRefusal | undefined {
  if (replies.some((reply) => reply.messageTs === messageTs)) return 'answered';
  if (replies.length >= MAX_MIDRUN_REPLIES) return 'limit';
  const last = Math.max(...replies.map((reply) => reply.at));
  if (now - last < MIDRUN_REPLY_SPACING_MS) return 'too_soon';
  return undefined;
}

/**
 * The host's side: check the limits against the run presentation, record the
 * reply there before it posts (so a restart never answers a message twice),
 * post it, then mark it posted. A post that fails keeps its place.
 */
export function createMidRunReplyHandler(input: {
  presentation: {
    midRunReplies(): Promise<readonly SlackPresentationMidRunReply[]>;
    /** Records the reply at the store's time; refused once the final is under way. */
    reserveMidRunReply(messageTs: string): Promise<void>;
    recordMidRunReplyPosted(messageTs: string): Promise<void>;
  };
  /** Posts the text as one threaded message under the reply's sender. */
  post: (text: string) => Promise<unknown>;
  onPosted?: () => void;
  now?: () => number;
}): MidRunReplyHandler {
  const now = input.now ?? Date.now;
  return async ({ messageTs, text }) => {
    try {
      const refusal = midRunReplyRefusal(await input.presentation.midRunReplies(), messageTs, now());
      if (refusal) return { posted: false, refusal };
      await input.presentation.reserveMidRunReply(messageTs);
    } catch {
      return { posted: false, refusal: 'unavailable' };
    }
    try {
      await input.post(text);
    } catch {
      return { posted: false, refusal: 'failed' };
    }
    input.onPosted?.();
    await input.presentation.recordMidRunReplyPosted(messageTs).catch(() => {
      console.warn('[chickpea] a mid-run reply posted but could not be recorded');
    });
    return { posted: true };
  };
}

/**
 * The Agent's side of the post: the live turn's registry in this process on
 * Node, or the thread runner that executes the turn on Cloudflare. Only a
 * runner's turn reads messages mid-run there (see slackTurnFold).
 */
export async function relayMidRunReply(request: MidRunReplyRequest): Promise<MidRunReplyOutcome> {
  const context = currentFlueObservationContext();
  const target = context?.target;
  if (!context || !target) return { posted: false, refusal: 'unavailable' };
  if (!isCloudflareTarget()) {
    return defaultSlackStatusRegistry.midRunReply(context.instanceId, target.generation, request);
  }
  try {
    const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
    const env = getCloudflareContext().env as PlatformEnv;
    const route = target.runnerKey
      ? target
      : await getSlackStateStore(env).matchFlueObservation?.(context.instanceId, context.submissionId);
    if (route?.executor !== 'runner' || !route.runnerKey) return { posted: false, refusal: 'unavailable' };
    const runner = threadRunnerStub(env, route.runnerKey);
    if (!runner) return { posted: false, refusal: 'unavailable' };
    return await runner.midRunReply(context.instanceId, context.submissionId, request);
  } catch {
    return { posted: false, refusal: 'failed' };
  }
}

const POSTED = 'Posted in the thread. Keep working; your final reply still answers the whole request.';
const TRUNCATED = ` The reply was cut to ${MAX_MIDRUN_REPLY_CHARS} characters.`;
const NOT_POSTED: Record<MidRunReplyRefusal | 'not_read' | 'information_only', string> = {
  not_read: 'Not posted: that ts is not a message that arrived while you worked. Reply only to those messages.',
  information_only: 'Not posted: that message is for information only, so do not answer it. It gets its own reply.',
  answered: 'Not posted: you already replied to that message. Put anything more in your final reply.',
  limit: `Not posted: this response already posted ${MAX_MIDRUN_REPLIES} replies. Answer the rest in your final reply.`,
  too_soon: `Not posted: replies need ${MIDRUN_REPLY_SPACING_MS / 1_000} seconds between them. Answer this in your final reply.`,
  final_started: 'Not posted: your final reply is already being delivered.',
  unavailable: 'Not posted: this response cannot post in the thread. Answer in your final reply.',
  failed: 'Not posted: Slack did not accept the reply. Answer in your final reply.',
};

const ReplyInThreadInput = v.strictObject({
  message_ts: v.pipe(
    v.string(),
    v.description('The ts of the message you answer, from its row among the messages that arrived while you worked.'),
  ),
  text: v.pipe(
    v.string(),
    v.minLength(1),
    v.description(`Your reply in Slack markdown, at most ${MAX_MIDRUN_REPLY_CHARS} characters.`),
  ),
});

/**
 * reply_in_thread: answers one message this response read mid-run. A
 * message it did not read, or read for information only, is refused here;
 * the host refuses the rest. Every refusal names its reason, so the model
 * does not try again.
 */
export function createSlackMidRunReplyTool(input: {
  /** The messages this response read mid-run so far. */
  read: () => readonly MidRunReadMessage[];
  post?: (request: MidRunReplyRequest) => Promise<MidRunReplyOutcome>;
}) {
  const post = input.post ?? relayMidRunReply;
  return {
    name: SLACK_REPLY_IN_THREAD_TOOL_NAME,
    description: 'Post a short reply in this Slack thread now, as yourself, while you keep working, to a message that arrived while you worked: answer its question, or give the progress update it asked for. Never post progress updates nobody asked for. Your final reply still answers everything.',
    input: ReplyInThreadInput,
    output: v.string(),
    run: async ({ data }: { data: v.InferOutput<typeof ReplyInThreadInput> }) => {
      const message = input.read().find((read) => read.messageTs === data.message_ts);
      if (!message) return { output: NOT_POSTED.not_read };
      if (message.informationOnly) return { output: NOT_POSTED.information_only };
      const capped = capMidRunReplyText(data.text);
      const outcome = await post({ messageTs: message.messageTs, text: capped.text });
      if (!outcome.posted) return { output: NOT_POSTED[outcome.refusal] };
      return { output: capped.truncated ? `${POSTED}${TRUNCATED}` : POSTED };
    },
  };
}

/**
 * Mounts reply_in_thread on every Slack turn, in the tools every turn shares
 * (see shared-prefix.ts), so the prompt cache holds across turns and renders.
 * A response that cannot read messages mid-run has read none, so the tool
 * refuses every reply there.
 */
export function useSlackMidRunReplyTool(followUps: SlackFollowUps): void {
  useTool(createSlackMidRunReplyTool({ read: followUps.read }));
}
