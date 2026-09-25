/** Slack Events API retries span about an hour; retain claims with margin. */
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/** Bound joined-thread state and its frozen snapshot to the same horizon. */
export const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Active-work markers only hint the interaction classifier and must self-heal
 * after a crashed worker, so an ordinary turn's marker lapses quickly. */
export const ACTIVE_WORK_TTL_MS = 20 * 60 * 1000;

/** A turn that delegated a coding task can run for up to its submission
 * budget (see CHICKPEA_SUBMISSION_DURABILITY in
 * src/agents/coding-worker-task.ts); its marker outlives that budget. */
export const CODING_ACTIVE_WORK_TTL_MS = 160 * 60 * 1000;
