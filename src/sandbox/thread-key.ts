import { baseSlackThreadKey } from '../slack/thread-key.ts';

/**
 * Memory epochs isolate agent transcripts, not operational workspaces. Keep
 * every transcript for one Slack thread on the same Sandbox Durable Object so
 * the relay's prepared turn context is visible when the agent activates it.
 */
export function sandboxThreadKey(conversationKey: string): string {
  return baseSlackThreadKey(conversationKey);
}
