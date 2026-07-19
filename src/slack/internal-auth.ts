import { randomUUID, timingSafeEqual } from 'node:crypto';

// Shared secret gating the internal `/agents/slack-thread/:id` HTTP endpoint.
// The Slack channel is the only intended caller (it dispatches in-process with
// a conversation key derived from a signature-verified event) — this token
// stops anyone else who can reach the app from driving the agent directly
// (LLM cost, channel-brief disclosure) and bypassing Slack signature
// verification entirely.
//
// Prefer an operator-configured token so external callers (and multi-process
// deployments) can be authorized deliberately. Otherwise fall back to a
// random token generated once per process/isolate: the channel and the agent
// route share this module instance, so the dispatcher and the route guard
// agree even though no token was configured.
//
// Resolved LAZILY (first use, inside a request) rather than at module scope:
// workerd forbids generating random values during isolate startup, so a
// module-scope randomUUID() crashes the Cloudflare worker before it serves a
// single request whenever TAG_AGENT_API_TOKEN is unset.
let cachedToken: string | undefined;

export function getInternalAgentToken(): string {
  cachedToken ??= process.env.TAG_AGENT_API_TOKEN ?? randomUUID();
  return cachedToken;
}

export const INTERNAL_AGENT_TOKEN_HEADER = 'x-flue-internal-token';

export function constantTimeEquals(
  candidate: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

/** Constant-time comparison against the configured/generated internal token. */
export function isValidInternalAgentToken(candidate: string | null | undefined): boolean {
  return constantTimeEquals(candidate, getInternalAgentToken());
}
