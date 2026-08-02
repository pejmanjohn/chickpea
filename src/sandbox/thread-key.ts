import { baseSlackThreadKey } from '../slack/thread-key.ts';

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
