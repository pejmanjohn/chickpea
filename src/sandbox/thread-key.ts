import type { ResolvedAssignment } from '../config/types.ts';
import {
  baseSlackThreadKey,
  conversationThreadTs,
  guestSandboxOwner,
  slackAgentThreadKey,
} from '../slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import { opaqueId } from '../work/admission.ts';

const OWNER_BOUND_SANDBOX_KEY = /^sandbox_[a-f0-9]{40}$/;

/**
 * Memory epochs isolate agent transcripts, not operational workspaces. Keep
 * every transcript for one Slack thread on the same Sandbox Durable Object so
 * the relay's prepared turn context is visible when the agent activates it.
 */
export function sandboxThreadKey(conversationKey: string): string {
  if (OWNER_BOUND_SANDBOX_KEY.test(conversationKey)) return conversationKey;
  return baseSlackThreadKey(conversationKey);
}

/**
 * The Sandbox Durable Object a Slack turn's coding workspace uses: the
 * thread's own, or a guest's own (the same owner-bound key the Agent side
 * derives from its runtime plan, runtimePlanGuestSandboxKey).
 */
export function slackTurnSandboxKey(
  turn: NormalizedSlackTurn,
  assignment: Pick<ResolvedAssignment, 'runtimeContract' | 'ownerIncarnation' | 'agentId' | 'threadGuest'>,
): string {
  if (!assignment.threadGuest) return sandboxThreadKey(slackAgentThreadKey(turn, assignment));
  const conversationKey = [
    turn.workspaceId,
    turn.channelId,
    conversationThreadTs(turn, assignment.runtimeContract),
  ].join(':');
  return opaqueId('sandbox', `${conversationKey}:${guestSandboxOwner(assignment.agentId)}`);
}
