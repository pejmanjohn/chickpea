import type { BillingSummary, PlanOffer } from '../config/platform-billing.ts';
import { formatUsageDollars, type UsageMicros } from '../usage/usage-display.ts';
import { formatTasks, taskRates } from './billing-tasks.ts';

/** Formatted dollars and tasks; `stage` says whether they count the plan's usage or, once it is used up, extra usage. */
export interface BillingBalance {
  readonly left: string;
  readonly tasksLeft: string | null;
  readonly exhausted: boolean;
  readonly stage: 'plan' | 'extra';
}

/**
 * What the big number counts, in the order the host spends usage. While the
 * plan's usage, what carried over, or trial usage beside it is left, it
 * counts only those, less what the workspace owes, so it agrees with the
 * plan's meter and renewal date. Once they are used up it counts the extra
 * usage a plan unfreezes. `exhausted` means nothing at all is left. A plan
 * with no meter yet counts its usage as on its way, less what the host holds
 * for an own key.
 */
export function balance(summary: BillingSummary, planOffer: PlanOffer | null | undefined): BillingBalance {
  const { planUsage, rollover, extraUsage, trial } = summary;
  const plan = !summary.plan ? 0
    : planUsage ? Math.max(0, planUsage.includedMicros - planUsage.usedMicros)
    : Math.max(0, (planOffer?.includedMicros ?? 0) - (summary.heldForOwnKey?.usageMicros ?? 0));
  const first = plan + (rollover?.remainingMicros ?? 0) + (trial?.remainingMicros ?? 0) - summary.debtMicros;
  const extra = extraUsage && !extraUsage.frozen ? extraUsage.remainingMicros : 0;
  const stage = summary.plan && first <= 0 && first + extra > 0 ? 'extra' : 'plan';
  const all = Math.max(0, first + extra) as UsageMicros;
  const left = (stage === 'plan' && summary.plan ? Math.max(0, first) : all) as UsageMicros;
  return {
    left: formatUsageDollars(left, 'down'),
    tasksLeft: formatTasks(left, summary.funding, taskRates(summary.offers, stage)),
    exhausted: all === 0,
    stage,
  };
}
