/** Slack Events API retries span about an hour; retain claims with margin. */
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/** Bound joined-thread state and its frozen snapshot to the same horizon. */
export const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
