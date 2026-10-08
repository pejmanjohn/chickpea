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
