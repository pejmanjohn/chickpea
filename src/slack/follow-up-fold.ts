import { AsyncLocalStorage } from 'node:async_hooks';

import {
  useAgentFinish, useDelivery, useDispatchMessage, usePersistentState, useResponseStart,
  type DeliveredMessageInput, type FlueExecutionInterceptor,
} from '@flue/runtime';

import { CHICKPEA_SLACK_AGENT_NAME } from '../agents/names.ts';
import { validTurnJobId } from '../agents/turn-input.ts';
import { currentRequestEnvelopeText, parseCurrentRequestEnvelope } from '../memory/tool-policy.ts';
import { publishActivityStatus } from './activity-publisher.ts';
import { foldActivityStatus, followUpSignalBody, MAX_FOLD_CYCLES, MAX_TURN_FOLD_CYCLES } from './follow-ups.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from './presentation-intent.ts';
import type { TurnFoldClaim, TurnFoldRequest } from './turn-job-types.ts';

/** Late folds this response's model read; written in the same durable batch as each fold. */
const SLACK_FOLLOW_UP_STATE_NAME = 'chickpeaSlackFollowUps';

interface FollowUpFoldState {
  /** Every late fold: the store's cycle sequence for this head. */
  cycles: number;
  /** Of them, would-stop folds; absent where an older release wrote the state, when every fold was one. */
  finishes?: number;
}

export type LateFoldRequest = Exclude<TurnFoldRequest, { phase: 'start' }>;

/**
 * Steering B and C: messages people send while the Agent works join its
 * response. The model reads them as the same Slack turn (a `slack_message`
 * signal with the head's identity and envelope) and writes one reply to
 * everything.
 *
 * After each tool batch (see slackToolBoundaryFoldInterceptor) the Agent
 * asks the state store for new messages and dispatches them into its own
 * response, which Flue joins before the next model call, so the model can
 * change course before more work. When the reply is about to settle, every
 * would-stop asks once more and appends what arrived. Both count one
 * sequence of folds, so neither takes the other's messages again.
 *
 * The gate shuts after a successful `stream_answer` (answer text may already
 * be in Slack), on a v1 envelope (it streams without one), past each phase's
 * cap, and while file delivery is unchecked or repairing. A shut would-stop
 * gate still tells the store how many folds the model read, which is how a
 * fold's messages come to end with this reply: the store counts a fold as
 * read only when a later call confirms it. A failed call leaves the response
 * as it was; any message the model never saw then runs as its own turn.
 */
export function useSlackFollowUpFold(input: {
  instanceId: string;
  /** True while another would-stop continuation must finish first (file delivery). */
  blocked: () => boolean;
  /** The state store's fold (TurnJobStoreLogic.fold); undefined where the store has none. */
  fold: (request: LateFoldRequest) => Promise<TurnFoldClaim | undefined>;
}): void {
  const delivery = useDelivery();
  const dispatch = useDispatchMessage();
  const [, update] = usePersistentState<FollowUpFoldState>(SLACK_FOLLOW_UP_STATE_NAME, { cycles: 0, finishes: 0 });
  useResponseStart(() => { update({ cycles: 0, finishes: 0 }); });
  const current = (): Required<FollowUpFoldState> => {
    let state: FollowUpFoldState = { cycles: 0 };
    update((previous) => { state = previous; return previous; });
    return { cycles: state.cycles, finishes: state.finishes ?? state.cycles };
  };
  const signal = delivery.kind === 'signal' ? delivery : undefined;
  const attributes = signal?.attributes ?? {};
  const envelope = signal && currentRequestEnvelopeText(signal.body);
  const requesterId = attributes.slackUserId;
  const framing = requesterId !== undefined && envelope !== undefined &&
    signal?.type === 'slack.message' && signal.tagName === 'slack_message' &&
    parseCurrentRequestEnvelope(envelope)?.schemaVersion === 2
    ? { requesterId, envelope }
    : undefined;
  const claim = (phase: LateFoldRequest['phase'], received: number, take: boolean) => input.fold({
    phase,
    headId: validTurnJobId(attributes.turnJobId),
    instanceId: input.instanceId,
    received,
    take,
  });
  const followUp = (
    claimed: TurnFoldClaim,
    phase: LateFoldRequest['phase'],
    { requesterId, envelope }: NonNullable<typeof framing>,
  ) => ({
    kind: 'signal',
    type: 'slack.message',
    tagName: 'slack_message',
    attributes: { ...attributes, requesterText: claimed.requesterText },
    body: followUpSignalBody({
      messages: claimed.messages,
      requesterId,
      timezone: attributes.requesterTimezone ?? 'UTC',
      envelope,
      phase,
    }),
  } satisfies DeliveredMessageInput);

  // Nothing to confirm here when the gate is shut: the would-stop call does.
  bindToolBoundaryFold(async () => {
    const { cycles, finishes } = current();
    if (!framing || cycles >= MAX_TURN_FOLD_CYCLES || input.blocked()) return;
    const claimed = await claim('turn', cycles, true);
    if (!claimed?.messages.length) return;
    // Counted only once dispatched: a lost dispatch is claimed again, never confirmed unread.
    await dispatch(followUp(claimed, 'turn', framing));
    update({ cycles: cycles + 1, finishes });
    publishActivityStatus(input.instanceId, foldActivityStatus(claimed.messages.length, 'turn'));
  });

  useAgentFinish(async ({ append, response, log }) => {
    if (!signal) return;
    const { cycles, finishes } = current();
    const take = framing !== undefined && finishes < MAX_FOLD_CYCLES &&
      !response.toolCalls.some((call) => call.tool === SLACK_STREAM_ANSWER_TOOL_NAME && !call.isError) &&
      !input.blocked();
    if (!take && cycles === 0) return;
    try {
      const claimed = await claim('finish', cycles, take);
      if (!claimed?.messages.length || !framing) return;
      append(followUp(claimed, 'finish', framing));
      update({ cycles: cycles + 1, finishes: finishes + 1 });
      publishActivityStatus(input.instanceId, foldActivityStatus(claimed.messages.length, 'finish'));
    } catch {
      log.warn('Could not check for follow-up messages; the reply answers what the Agent has read');
    }
  });
}

interface ToolBoundary {
  /** Model tool calls running now: Pi runs a batch's calls in parallel. */
  running: number;
  /** A successful stream_answer: its answer may already be in Slack. */
  answerDeclared: boolean;
  /** The latest render's check (useSlackFollowUpFold). */
  pull?: () => Promise<void>;
  /** The check in progress, so two never claim the same cycle. */
  pulling: Promise<void>;
}

const toolBoundaries = new AsyncLocalStorage<ToolBoundary>();

function bindToolBoundaryFold(pull: () => Promise<void>): void {
  const boundary = toolBoundaries.getStore();
  if (boundary) boundary.pull = pull;
}

/**
 * The tool boundary of a Slack response: when a model tool call ends and no
 * other call of its batch is still running, the Agent checks for new
 * messages before the batch's results go back to the model. Every model
 * tool passes through here (its own, MCP and sandbox tools alike). Mounted
 * inside the presentation policy, so a tool that policy refuses after an
 * answer was declared never reaches it. The check never fails the tool.
 */
export const slackToolBoundaryFoldInterceptor: FlueExecutionInterceptor = async (operation, context, next) => {
  const boundary = toolBoundaries.getStore();
  if (operation.type === 'agent' && context.agentName === CHICKPEA_SLACK_AGENT_NAME && boundary === undefined) {
    return toolBoundaries.run({ running: 0, answerDeclared: false, pulling: Promise.resolve() }, next);
  }
  if (operation.type !== 'tool' || boundary === undefined) return next();
  boundary.running += 1;
  try {
    const result = await next();
    if (operation.toolName === SLACK_STREAM_ANSWER_TOOL_NAME) boundary.answerDeclared = true;
    return result;
  } finally {
    boundary.running -= 1;
    const pull = boundary.pull;
    if (boundary.running === 0 && !boundary.answerDeclared && pull) {
      boundary.pulling = boundary.pulling.then(pull).catch(() => {
        console.warn('[chickpea] Could not check for follow-up messages after a tool batch');
      });
      await boundary.pulling;
    }
  }
};
