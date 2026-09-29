import type { ResolvedAssignment } from '../config/types.ts';
import {
  baseSlackThreadKey,
  conversationThreadTs,
  slackAgentThreadKey,
  slackConversationKey,
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
 * A Sandbox Durable Object bound to one owner of a conversation, apart from
 * the thread's own. The opaque key binds the canonical Slack coordinate and
 * the frozen owner identity while staying below Cloudflare Sandbox's
 * 63-character id limit; sandboxThreadKey keeps it as it is.
 */
export function ownerBoundSandboxKey(conversationKey: string, ownerId: string): string {
  return opaqueId('sandbox', `${conversationKey}:${ownerId}`);
}

/**
 * The Sandbox of an Agent answering an ask in a thread another Agent owns.
 * A guest never shares that thread's Sandbox: each guest has its own
 * workspaces, checkpoints and coding tasks there.
 */
export function guestSandboxKey(conversationKey: string, agentId: string): string {
  return ownerBoundSandboxKey(conversationKey, `guest:${agentId}`);
}

/**
 * The Sandbox Durable Object a Slack turn's coding workspace uses: the
 * thread's own, or a guest's own (the key the Agent side derives from its
 * runtime plan, runtimePlanGuestSandboxKey).
 */
export function slackTurnSandboxKey(
  turn: NormalizedSlackTurn,
  assignment: Pick<ResolvedAssignment, 'runtimeContract' | 'ownerIncarnation' | 'agentId' | 'threadGuest'>,
): string {
  if (!assignment.threadGuest) return sandboxThreadKey(slackAgentThreadKey(turn, assignment));
  return guestSandboxKey(
    slackConversationKey({
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadTs: conversationThreadTs(turn, assignment.runtimeContract),
    }),
    assignment.agentId,
  );
}
