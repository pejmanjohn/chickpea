import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { baseSlackThreadKey, slackAgentThreadKey, slackConversationKey } from '../slack/thread-key.ts';
import type { TurnJob } from '../slack/turn-job-types.ts';
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
 * A guest's own coding Sandbox (guestSandboxKey), or undefined for the
 * thread's owner, which uses the thread's. Read from a plan the caller
 * already parsed, on every render, so it validates nothing again.
 */
export function runtimePlanGuestSandboxKey(
  plan: Pick<RuntimePlanV2, 'agentId' | 'conversation'>,
): string | undefined {
  return plan.conversation.guest
    ? guestSandboxKey(slackConversationKey(plan.conversation), plan.agentId)
    : undefined;
}

/**
 * The Sandbox Durable Object a Slack turn's coding workspace uses, as the
 * runner reads it: a guest's own when the turn's frozen plan says so, else
 * the thread's. The plan decides, not the assignment, so the runner reads
 * where the Agent wrote: a guest turn whose plan was frozen before plans
 * carried `guest` used the thread's. A turn without a frozen plan opened no
 * workspace, and the thread's key is as good as any.
 */
export function slackTurnSandboxKey(job: Pick<TurnJob, 'turn' | 'assignment' | 'runtimePlan'>): string {
  const guest = job.runtimePlan ? runtimePlanGuestSandboxKey(job.runtimePlan) : undefined;
  return guest ?? sandboxThreadKey(slackAgentThreadKey(job.turn, job.assignment));
}
