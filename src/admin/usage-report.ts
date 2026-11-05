/**
 * Admin's Usage page where the host installed a billing port. It reports
 * what the Plan page counts: billed usage the host returns, joined to Core's
 * activity by the run key both sides record. Loaded on first use; see
 * tests/worker-startup-imports.test.ts.
 */
import type { BilledUsageRow, BillingFunding, BillingSummary } from '../config/platform-billing.ts';
import type { UsageActivityAttribution, UsageOperationDetail } from '../usage/types.ts';

/** What the report's amounts count. */
export type UsageReportMeasure =
  /** Billed usage, the Plan page's unit: models included, and the host answered `usage`. */
  | 'usage'
  /** Activities: models included, and the host gave no amounts. */
  | 'activity'
  /** Core's list-price estimate of provider spend: the installation pays with its own key. */
  | 'estimate';

export type UsageReportPeriod = 'this_billing_period' | 'last_billing_period';

export type UsageReportRange =
  | { readonly period: UsageReportPeriod }
  | { readonly from: number; readonly to: number };

/** A value in the report's measure (USD micros, or a count) and its display text: "$36.60", "<$0.01", "276". */
export interface ReportAmount {
  value: number;
  text: string;
}

export interface ReportRow {
  /** An Agent ID, a membership ID, `routines`, or `provider/model`; null for the row gathering the rest. */
  key: string | null;
  name: string;
  amount: ReportAmount;
  /** Whole percent of the report's total. */
  share: number;
}

export interface ReportAgentRow extends ReportRow {
  /** Who uses it most: a person's name, "Routines", or null. */
  topPerson: string | null;
  /** The model with the most of its amount, by display name. */
  mainModel: string | null;
  /** Own key, while the host answers `usage`: the tasks it ran, "61". */
  tasks: string | null;
}

/** `GET /admin/api/usage/report`. */
export interface UsageReport {
  measure: UsageReportMeasure;
  funding: BillingFunding;
  range: {
    from: number;
    to: number;
    /** The range's first UTC day, "Oct 7". */
    since: string;
    period: UsageReportPeriod | null;
  };
  /**
   * Whether the workspace has a billing period, so the Period choices offer
   * it. Without one, a billing period request falls back to the last 30 days.
   */
  billingPeriod: boolean;
  agent: { id: string; name: string } | null;
  /** The Agent picker: every Agent with activity or usage in the range, and the selected one. */
  agentChoices: { id: string; name: string }[];
  /** What's left, as the Plan page's balance counts it; null for an own key without a plan. */
  plan: { left: string; autoTopUp: boolean | null } | null;
  total: ReportAmount;
  perDay: ReportAmount;
  /** Whole percent against the same days last period; null with nothing to compare. */
  change: number | null;
  /** With an Agent selected: its whole percent of the workspace's total. */
  share: number | null;
  /** This billing period, every Agent, models included: the plan meter's pace. */
  pace: { percent: number; by: string } | null;
  /** Own key: the tasks the plan counted in the range, and those left this billing period. */
  tasks: { used: string; left: string | null } | null;
  /** Own key: provider IDs the estimate covers, largest first. */
  providers: string[];
  chart: {
    /** A UTC day label, "Oct 7", for every day of the range. */
    days: string[];
    /** Days so far: bars draw for indexes below it. */
    elapsed: number;
    /** Stacked bottom to top: the largest Agents, then one row gathering the rest (key null). */
    series: { key: string | null; name: string; values: number[] }[];
    /** The same days last period, by day index. */
    prior: number[] | null;
  };
  models: ReportRow[];
  people: ReportRow[];
  /** Null with an Agent selected. */
  agents: ReportAgentRow[] | null;
}

/** Added to each `GET /admin/api/usage/operations` item where the host installed a billing port. */
export interface ActivityExtras {
  /** The person who asked, "Routine" for a routine run, or null. */
  requester: string | null;
  modelName: string | null;
  /** The host's billed usage for the activity's run keys; null without an answer or a key. */
  billed: {
    amount: string;
    model: string;
    fee: string;
    task: boolean;
    creditedBack: boolean;
  } | null;
}

export interface UsageReportNames {
  agents: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, string>;
  model(model: string): string;
}

export interface UsageReportInputs {
  summary: BillingSummary;
  range: { from: number; to: number; period: UsageReportPeriod | null };
  prior: { from: number; to: number };
  /** Null when the host has no `usage` method or it failed. */
  billed: { current: readonly BilledUsageRow[]; prior: readonly BilledUsageRow[] } | null;
  /** Activities started from before `prior.from` to `range.to`. */
  attributions: readonly UsageActivityAttribution[];
  agentId: string | null;
  names: UsageReportNames;
  now: number;
}

export function buildUsageReport(_inputs: UsageReportInputs): UsageReport {
  throw new Error('not implemented');
}

export function activityExtras(
  _items: readonly UsageOperationDetail[],
  _billed: readonly BilledUsageRow[] | null,
  _names: UsageReportNames,
): ActivityExtras[] {
  throw new Error('not implemented');
}

/** The strip's facts, from the summary as the Plan page reads it. */
export function planStrip(_summary: BillingSummary): UsageReport['plan'] {
  throw new Error('not implemented');
}
