/** Slack Events API retries span about an hour; retain claims with margin. */
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/** Bound joined-thread state and its frozen snapshot to the same horizon. */
export const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Active-work markers are only a concurrency hint and must self-heal after a
 * crashed worker. Cloudflare turns have a 15-minute wall-time ceiling. */
export const ACTIVE_WORK_TTL_MS = 20 * 60 * 1000;
