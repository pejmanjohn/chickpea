import { randomUUID, timingSafeEqual } from 'node:crypto';

// Shared secret gating the internal `/agents/slack-thread/:id` HTTP endpoint.
// The Slack channel is the only intended caller (it self-calls with a
// conversation key derived from a signature-verified event) — this token
// stops anyone else who can reach the app from driving the agent directly
// (LLM cost, channel-brief disclosure) and bypassing Slack signature
// verification entirely.
//
// Prefer an operator-configured token so external callers (and multi-process
// deployments) can be authorized deliberately. Otherwise fall back to a
// per-process random token generated once at module scope: `flue dev` runs
// the channel and the agent in the same process, so the self-call and the
// route guard share this value even though no token was configured.
export const INTERNAL_AGENT_TOKEN = process.env.FLUE_AGENT_API_TOKEN ?? randomUUID();

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
  return constantTimeEquals(candidate, INTERNAL_AGENT_TOKEN);
}
