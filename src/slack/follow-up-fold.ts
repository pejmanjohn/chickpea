import { useAgentFinish, useDelivery, usePersistentState, useResponseStart } from '@flue/runtime';

import { validTurnJobId } from '../agents/turn-input.ts';
import { currentRequestEnvelopeText, parseCurrentRequestEnvelope } from '../memory/tool-policy.ts';
import { publishActivityStatus } from './activity-publisher.ts';
import { foldActivityStatus, followUpSignalBody, MAX_FOLD_CYCLES } from './follow-ups.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from './presentation-intent.ts';
import type { TurnFoldClaim, TurnFoldRequest } from './turn-job-types.ts';

/** Late folds this response appended; written in the same durable batch as each append. */
export const SLACK_FOLLOW_UP_STATE_NAME = 'chickpeaSlackFollowUps';

interface FollowUpFoldState {
  cycles: number;
}

export type LateFoldRequest = Extract<TurnFoldRequest, { phase: 'finish' }>;

/**
 * Steering B: when the reply is about to settle, messages the same person
 * sent since the turn started join it before anything posts. The model reads
 * them as the same Slack turn (a `slack_message` signal with the head's
 * identity and envelope) and writes one reply to everything.
 *
 * Every would-stop of a Slack turn asks the state store once. The gate shuts
 * after a successful `stream_answer` (answer text may already be in Slack),
 * on a v1 envelope (it streams without one), after MAX_FOLD_CYCLES, and while
 * file delivery is unchecked or repairing. A shut gate still tells the store
 * how many folds were appended, which is how a fold's messages come to end
 * with this reply: the store counts a fold as read only when a later call
 * confirms it. A failed call ends the response unfolded; any message the
 * model never saw then runs as its own turn.
 */
export function useSlackFollowUpFold(input: {
  instanceId: string;
  /** True while another would-stop continuation must finish first (file delivery). */
  blocked: () => boolean;
  /** The state store's fold (TurnJobStoreLogic.fold); undefined where the store has none. */
  fold: (request: LateFoldRequest) => Promise<TurnFoldClaim | undefined>;
}): void {
  const delivery = useDelivery();
  const [, update] = usePersistentState<FollowUpFoldState>(SLACK_FOLLOW_UP_STATE_NAME, { cycles: 0 });
  useResponseStart(() => { update({ cycles: 0 }); });
  useAgentFinish(async ({ append, response, log }) => {
    if (delivery.kind !== 'signal') return;
    let cycles = 0;
    update((previous) => { cycles = previous.cycles; return previous; });
    const envelope = currentRequestEnvelopeText(delivery.body);
    const take = cycles < MAX_FOLD_CYCLES &&
      delivery.type === 'slack.message' && delivery.tagName === 'slack_message' &&
      envelope !== undefined && parseCurrentRequestEnvelope(envelope)?.schemaVersion === 2 &&
      !response.toolCalls.some((call) => call.tool === SLACK_STREAM_ANSWER_TOOL_NAME && !call.isError) &&
      !input.blocked();
    if (!take && cycles === 0) return;
    try {
      const claim = await input.fold({
        phase: 'finish',
        headId: validTurnJobId(delivery.attributes?.turnJobId),
        instanceId: input.instanceId,
        received: cycles,
        take,
      });
      if (!claim?.messages.length || envelope === undefined) return;
      const attributes = delivery.attributes ?? {};
      append({
        kind: 'signal',
        type: 'slack.message',
        tagName: 'slack_message',
        attributes: { ...attributes, requesterText: claim.requesterText },
        body: followUpSignalBody({
          messages: claim.messages,
          userId: claim.messages[0]!.userId,
          timezone: attributes.requesterTimezone ?? 'UTC',
          envelope,
        }),
      });
      update({ cycles: cycles + 1 });
      publishActivityStatus(input.instanceId, foldActivityStatus(claim.messages.length, 'finish'));
    } catch {
      log.warn('Could not check for follow-up messages; the reply answers what the Agent has read');
    }
  });
}
