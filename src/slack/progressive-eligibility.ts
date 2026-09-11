import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import type { SlackProgressiveEligibilityReason } from './run-presentations.ts';

interface ProgressiveEligibilityInput {
  runtimePlan?: RuntimePlanV2;
  operationsEnabled: boolean;
  memorySelected: boolean;
  recoveryRequired: boolean;
  concurrentAttributionProven: boolean;
  /** Another post-read policy can withhold or replace the model draft. */
  replacementCapable: boolean;
}

export interface ProgressiveEligibilityDecision {
  allowed: boolean;
  reason: SlackProgressiveEligibilityReason;
}

/** Admission-frozen release policy for answer text, ordered fail-closed. */
export function decideProgressiveEligibility(
  input: ProgressiveEligibilityInput,
): ProgressiveEligibilityDecision {
  if (!input.operationsEnabled) {
    return { allowed: false, reason: 'operations_disabled' };
  }
  if (input.recoveryRequired) return { allowed: false, reason: 'recovery' };
  if (input.memorySelected) return { allowed: false, reason: 'memory' };
  if (input.replacementCapable) return { allowed: false, reason: 'other' };
  if (!input.concurrentAttributionProven) {
    return { allowed: false, reason: 'concurrent_join' };
  }
  const plan = input.runtimePlan;
  if (!plan) return { allowed: false, reason: 'other' };
  if (plan.sandbox.mode === 'cloudflare') {
    return { allowed: false, reason: 'sandbox' };
  }
  if (
    plan.mcpConnections.length > 0 ||
    plan.apiConnections.length > 0 ||
    plan.repositories.length > 0
  ) {
    return { allowed: false, reason: 'effect_capable' };
  }
  return { allowed: true, reason: 'safe_early_release' };
}
