import type { WebClient } from '@slack/web-api';

import type { NormalizedSlackTurn } from './types.ts';
import { countOf } from './message-format.ts';
import type { SlackRunFactsView } from './status-registry.ts';
import { slackConversationKind } from './thread-key.ts';
import { threadRunnerStub } from './thread-runner-rpc.ts';
import type { TurnRunRoute } from './turn-job-types.ts';

/**
 * Where a steering reply goes: the person it answers, in the thread it is
 * about. Only that person may see it (R11).
 */
export interface SteeringReplyTarget {
  channelId: string;
  /** The thread the stop or check-in addressed; absent for a top-level DM. */
  threadTs?: string;
  userId: string;
  conversation: ReturnType<typeof slackConversationKind>;
}

export function steeringReplyTarget(
  turn: Pick<NormalizedSlackTurn, 'channelId' | 'threadTs' | 'userId' | 'source' | 'channelType'>,
): SteeringReplyTarget {
  return {
    channelId: turn.channelId,
    ...(turn.threadTs ? { threadTs: turn.threadTs } : {}),
    userId: turn.userId,
    conversation: slackConversationKind(turn),
  };
}

/**
 * Chickpea's own reply to a stop or check-in, never the busy Agent's (KTD8):
 * an ephemeral message in the thread for channels and group DMs, and an
 * ordinary threaded reply in a DM, where only the person and the Agent are.
 */
export async function postSteeringReply(
  client: Pick<WebClient, 'chat'>,
  target: SteeringReplyTarget,
  text: string,
): Promise<void> {
  if (target.conversation === 'im') {
    await client.chat.postMessage({
      channel: target.channelId,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      text,
    });
    return;
  }
  await client.chat.postEphemeral({
    channel: target.channelId,
    user: target.userId,
    ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
    text,
  });
}

/** Chickpea's fixed steering copy; none of it names a person, Agent or run detail. */
export const STEERING_REPLY_TEXT = {
  /** R3: someone who may not use the thread's Agent typed a stop. */
  ineligibleStop: "You can't stop this run. Only people who can use this Agent here can stop it.",
  /** A top-level stop or check-in in a DM while none of the sender's conversations is running. */
  directNoneRunning: 'Nothing is running for you here right now.',
  /** ...while more than one is. */
  directSeveralRunning:
    'More than one of your conversations here is running. Reply "stop" or "status" in the thread you mean.',
} as const;

/**
 * The check-in answer (R9, KTD8): the run's current fixed-copy step, the
 * bucketed time since its last real progress, and how long it has been
 * running. Without facts it says only what the state store knows.
 */
export function slackCheckInReply(input: {
  facts?: SlackRunFactsView | undefined;
  /** Whether the run's Flue dispatch started. */
  dispatched: boolean;
}): string {
  const { facts } = input;
  if (!facts) {
    return input.dispatched
      ? 'Still working on this. Progress details are not available right now.'
      : "Queued. This hasn't started yet.";
  }
  return [
    'Still working on this.',
    ...(facts.step ? [`• Current step: ${facts.step}`] : []),
    facts.quietFor
      ? `• No new progress for ${facts.quietFor} minutes`
      : '• Last progress under 5 minutes ago',
    `• Running for ${runDuration(facts.at - facts.startedAt)}`,
  ].join('\n');
}

function runDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return countOf(minutes, 'minute', 'minutes');
  return rest === 0
    ? countOf(hours, 'hour', 'hours')
    : `${countOf(hours, 'hour', 'hours')} ${countOf(rest, 'minute', 'minutes')}`;
}

/**
 * A check-in's run facts: its thread runner's for a runner turn, else those
 * of the state store's own executor (the alarm executor, the Node relay).
 * Undefined when neither has them or the read fails; a check-in never waits
 * on, or touches, the run itself.
 */
export async function readSteeringRunFacts(
  route: Pick<TurnRunRoute, 'turnJobId' | 'runnerKey' | 'executor'>,
  sources: {
    env?: Record<string, unknown> | undefined;
    state: { runFacts?(turnJobId: string): Promise<SlackRunFactsView | undefined> };
  },
): Promise<SlackRunFactsView | undefined> {
  try {
    if (route.executor === 'runner') {
      const read = await threadRunnerStub(sources.env, route.runnerKey)?.runFacts(route.turnJobId);
      return read?.ok ? read.value ?? undefined : undefined;
    }
    return await sources.state.runFacts?.(route.turnJobId);
  } catch {
    return undefined;
  }
}
