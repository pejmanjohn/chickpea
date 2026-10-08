import type { DurabilityConfig } from '@flue/runtime';

/**
 * The budget of one coordinator submission (Flue's default is one hour and 10
 * attempts). It covers `MAX_WORKSPACE_TASKS_PER_RESPONSE` full-length coding
 * tasks plus the coordinator's own model time.
 */
export const CHICKPEA_SUBMISSION_DURABILITY: DurabilityConfig = {
  maxAttempts: 10,
  timeoutMs: 155 * 60_000,
};

/**
 * A coding worker settles on its own before the coordinator's longest wait
 * ends, so a runaway task can never outlive the turn that asked for it.
 */
export const CODING_WORKER_DURABILITY = { maxAttempts: 5, timeoutMs: 65 * 60_000 } as const satisfies DurabilityConfig;
