import type { BillingFunding, BillingSummary } from '../config/platform-billing.ts';
import type { UsageMicros } from '../usage/usage-display.ts';

/** What a task draws: its fee, and with models included, a typical task's tokens. */
export type TaskRates = Pick<BillingSummary['offers'], 'taskFeeMicros' | 'typicalTaskMicros'>;

const MICROS_PER_CENT = 10_000;
const TASKS = new Intl.NumberFormat('en-US');

/** Whole cents, so a fee like 30¢ divides usage exactly. */
const cents = (micros: UsageMicros): number => Math.floor(micros / MICROS_PER_CENT);

/**
 * An estimate reads as one and never promises more than the typical mix: down
 * to 10 under 100, to 25 under 500, and to 100 from 500. Chickpea's pricing
 * page rounds the same way, so its task counts and Admin's agree.
 */
function roughly(tasks: number): number {
  const step = tasks < 100 ? 10 : tasks < 500 ? 25 : 100;
  return Math.floor(tasks / step) * step;
}

/**
 * The tasks `usage` covers. On an own key the provider bills the tokens and
 * usage pays only the task fee, so the count is exact: "400". With models
 * included usage also pays each task's tokens, so the count assumes a typical
 * task and reads as an estimate: "about 250", or "under 10" for a little.
 * Null when a task draws nothing, so there is no count to give.
 */
export function formatTasks(usage: UsageMicros, funding: BillingFunding, rates: TaskRates): string | null {
  const perTask = cents(rates.taskFeeMicros) + (funding === 'own_key' ? 0 : cents(rates.typicalTaskMicros));
  if (perTask <= 0) return null;
  const tasks = Math.max(0, cents(usage)) / perTask;
  if (funding === 'own_key') return TASKS.format(Math.floor(tasks));
  if (tasks === 0) return '0';
  return tasks < 10 ? 'under 10' : `about ${TASKS.format(roughly(tasks))}`;
}
