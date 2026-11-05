import type { BillingSummary, PlanOffer } from '../config/platform-billing.ts';
import { formatUsageDollars, type UsageMicros } from '../usage/usage-display.ts';
import { formatTasks } from './billing-tasks.ts';

/** What the workspace can spend now, and the tasks it covers. `tasksLeft` is null when a task draws nothing. */
export interface BillingBalance {
  left: string;
  tasksLeft: string | null;
  exhausted: boolean;
}

/**
 * What the workspace can spend now, as the host counts it: what is left of
 * the plan's usage, what carried over, extra usage a plan unfreezes, and any
 * trial usage, less what the workspace owes. A plan with no meter yet counts
 * its whole usage.
 */
export function balance(summary: BillingSummary, planOffer: PlanOffer | null | undefined): BillingBalance {
  const { planUsage, rollover, extraUsage, trial } = summary;
  const plan = !summary.plan ? 0
    : planUsage ? Math.max(0, planUsage.includedMicros - planUsage.usedMicros)
    : planOffer?.includedMicros ?? 0;
  const spendable = plan + (rollover?.remainingMicros ?? 0) + (extraUsage && !extraUsage.frozen ? extraUsage.remainingMicros : 0) +
    (trial?.remainingMicros ?? 0) - summary.debtMicros;
  const left = Math.max(0, spendable) as UsageMicros;
  return { left: formatUsageDollars(left, 'down'), tasksLeft: formatTasks(left, summary.funding, summary.offers), exhausted: left === 0 };
}
