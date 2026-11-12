/**
 * Admin's Usage page where the host installed a billing port. It reports
 * what the Plan page counts: billed usage the host returns, joined to Core's
 * activity by the run key both sides record. The Admin API loads this module
 * on first use, handlers included; see tests/worker-startup-imports.test.ts.
 */
import type { Context } from 'hono';

import { requireInstallationScope } from '../config/installation-scope.ts';
import {
  platformBilling,
  type BilledUsageRow,
  type BillingFunding,
  type BillingSummary,
  type PlatformBillingPort,
} from '../config/platform-billing.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { activeModelCatalogSnapshot } from '../model-catalog/index.ts';
import { UsageStateError } from '../usage/store-error.ts';
import { USAGE_RAW_RETENTION_DAYS } from '../usage/retention.ts';
import type { UsageActivityAttribution, UsageOperationDetail, UsageStore } from '../usage/types.ts';
import { formatPriceCents, formatUsageDollars, type UsageMicros } from '../usage/usage-display.ts';
import { balance, type BillingBalance } from './billing-balance.ts';
import { formatTasks } from './billing-tasks.ts';

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
  /** Who uses it most: a person's name, "Routines", "Practice runs", or null. */
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
  /**
   * `autoTopUp` is null where the host offers none. Admins see this page,
   * so a pause reads "on", as the Plan page shows them; its reason is an Owner's.
   */
  plan: { left: string; autoTopUp: 'on' | 'off' | null } | null;
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
  /** Null unless an Owner's own session asks, as the Plan page's "By person" is an Owner's. */
  people: ReportRow[] | null;
  /** Null with an Agent selected. */
  agents: ReportAgentRow[] | null;
}

/** Added to each `GET /admin/api/usage/operations` item where the host installed a billing port. */
export interface ActivityExtras {
  /** The person who asked, "Routine" for a routine run, or null: always null where `people` is. */
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
  /** Null where the viewer sees no one's usage. */
  people: ReadonlyMap<string, string> | null;
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

const DAY_MS = 86_400_000;
const MICROS_PER_CENT = 10_000;
const CHARTED_AGENTS = 4;
const LISTED_ROWS = 5;
const FALLBACK_DAYS = 30;
const ROUTINES = 'routines';
const TEST_RUNS = 'test_runs';
const OTHER = 'Other';
// UTC, as the Plan page's dates read.
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/**
 * One amount in the report's measure and whom it counts for: a billed row of
 * one run, or one activity. A billed row whose run matches no activity
 * counts for nobody, so it lands in every list's gathered row.
 */
interface Charge {
  /** Days since the epoch, UTC. */
  day: number;
  value: number;
  agentId: string | null;
  /** `routines`, or the requester's membership ID. */
  person: string | null;
  /** `provider/model`. */
  model: string | null;
  /** Whether Core lists the activity it came from. */
  matched: boolean;
}

interface Row {
  key: string | null;
  name: string;
  value: number;
}

type Window = { readonly from: number; readonly to: number };

/** The range a request names, and the one before it that `change` and `chart.prior` compare against. */
export function reportRanges(
  request: UsageReportRange,
  summary: BillingSummary,
  now: number,
): Pick<UsageReportInputs, 'range' | 'prior'> {
  const { period } = summary;
  if ('period' in request && period) {
    const start = period.start.getTime();
    const monthBack = monthsBefore(period.start, 1);
    return request.period === 'this_billing_period'
      ? { range: { from: start, to: now + 1, period: request.period }, prior: { from: monthBack, to: start } }
      : {
        range: { from: monthBack, to: start, period: request.period },
        prior: { from: monthsBefore(period.start, 2), to: monthBack },
      };
  }
  const today = dayNumber(now) * DAY_MS;
  const window = 'period' in request ? { from: today - (FALLBACK_DAYS - 1) * DAY_MS, to: today + DAY_MS } : request;
  // Outside a billing period only attributable usage counts, and activity older than raw retention is gone.
  const from = Math.min(Math.max(window.from, retainedFrom(now)), window.to);
  return {
    range: { from, to: window.to, period: null },
    prior: { from: 2 * from - window.to, to: from },
  };
}

function retainedFrom(now: number): number {
  return now - USAGE_RAW_RETENTION_DAYS * DAY_MS;
}

/** The same UTC time `months` calendar months earlier, on that month's last day when it is shorter. */
function monthsBefore(date: Date, months: number): number {
  const month = date.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return Date.UTC(
    date.getUTCFullYear(), month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  );
}

export function buildUsageReport(inputs: UsageReportInputs): UsageReport {
  const { summary, range, prior, billed, agentId, names, now } = inputs;
  const measure: UsageReportMeasure = summary.funding === 'own_key' ? 'estimate' : billed ? 'usage' : 'activity';
  const runs = runIndex(inputs.attributions);
  const startedIn = (window: Window) =>
    inputs.attributions.filter((attribution) => attribution.startedAt >= window.from && attribution.startedAt < window.to);
  // Usage Core can't attribute, mostly private routines', counts only in a billing period, as the
  // Plan page counts it; a range of any other bounds could single out when one ran.
  const billable = (row: BilledUsageRow) => range.period !== null || (row.runId !== null && runs.has(row.runId));
  const charges = (window: Window, rows: readonly BilledUsageRow[] | undefined): Charge[] => measure === 'usage'
    ? (rows ?? []).filter(billable).map((row) => ({
      day: dayNumber(Date.parse(row.day)),
      value: net([row]),
      ...attributed(row.runId === null ? undefined : runs.get(row.runId)),
    }))
    : startedIn(window).map((attribution) => ({
      day: dayNumber(attribution.startedAt),
      value: measure === 'activity' ? 1 : attribution.estimateMicros ?? 0,
      ...attributed(attribution),
    }));
  const mine = (list: Charge[]) => agentId === null ? list : list.filter((charge) => charge.agentId === agentId);
  const workspace = charges(range, billed?.current);
  const current = mine(workspace);
  const previous = mine(charges(prior, billed?.prior));
  const total = sumOf(current);

  const amount = (value: number): ReportAmount => ({ value, text: measure === 'activity' ? count(value) : dollars(value) });
  // Each list's amounts read as cents that add up to the total's.
  const listed = <T extends Row>(rows: readonly T[]): (T & ReportRow)[] => {
    const cents = measure === 'activity' ? [] : apportionCents(rows.map((row) => row.value), Math.floor(total / MICROS_PER_CENT));
    return rows.map((row, index) => ({
      ...row,
      amount: measure === 'activity' ? amount(row.value) : { value: row.value, text: centsText(row.value, cents[index] ?? 0) },
      share: percent(row.value, total),
    }));
  };
  const agentName = (id: string) => names.agents.get(id);
  // A billing period's people, as the Plan page's By person; a narrower range could name who asked for one private run.
  const people = range.period === null ? null : names.people;
  const personName = (key: string) => key === ROUTINES ? 'Routines' : key === TEST_RUNS ? 'Practice runs' : people?.get(key);
  // An Agent with no name now reads as the gathered row, as on the Plan page.
  const agentRow = (id: string | null) => id !== null && names.agents.has(id) ? id : null;

  const firstDay = dayNumber(range.from);
  const chartEnd = range.period === 'this_billing_period' && summary.period ? summary.period.end.getTime() : range.to;
  const dayCount = Math.max(0, dayNumber(chartEnd - 1) - firstDay + 1);
  const elapsed = Math.min(dayCount, Math.max(0, dayNumber(now) - firstDay + 1));
  const byDay = (list: readonly Charge[], first: number) => {
    const values = new Array<number>(dayCount).fill(0);
    for (const charge of list) {
      const index = charge.day - first;
      if (index >= 0 && index < dayCount) values[index] = (values[index] ?? 0) + charge.value;
    }
    return values;
  };
  const byAgent = tally(current, (charge) => agentRow(charge.agentId), agentName);
  // Usage Core can't attribute, mostly private routines', counts in totals and lists but never by day.
  const attributable = current.filter((charge) => charge.matched);
  const lines = ranked(attributable, (charge) => agentRow(charge.agentId), agentName, CHARTED_AGENTS, OTHER);
  const charted = new Set(lines.map((line) => line.key));
  const line = (charge: Charge) => charted.has(agentRow(charge.agentId)) ? agentRow(charge.agentId) : null;
  // Attributable usage on both sides, so a day of private usage last period never moves the change; a finished
  // range compares whole sums, so a 31-day prior month keeps its last day.
  const priorAttributable = previous.filter((charge) => charge.matched);
  // Last billing period's own prior starts up to three months back, past retention too.
  const priorKnown = prior.from >= retainedFrom(now);
  const finished = elapsed >= dayCount;
  const priorLine = byDay(priorAttributable, dayNumber(prior.from));
  const priorSoFar = finished ? sumOf(priorAttributable) : sum(priorLine.slice(0, elapsed));
  const currentSoFar = finished ? sumOf(attributable) : sum(byDay(attributable, firstDay).slice(0, elapsed));

  const choiceIds = new Set([...startedIn(range), ...workspace].flatMap((item) => {
    const id = agentRow(item.agentId);
    return id === null ? [] : [id];
  }));
  if (agentId !== null) choiceIds.add(agentId);
  const agentChoices = [...choiceIds]
    .map((id) => ({ id, name: names.agents.get(id) ?? OTHER }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const tasks = measure === 'estimate' && billed ? keptTasks(billed.current.filter(billable), runs) : null;
  const thisPeriod = range.period === 'this_billing_period';
  const tasksUsed = tasks ? count(tasks.filter((task) => agentId === null || task === agentId).length)
    : thisPeriod && agentId === null && summary.planUsage
      ? formatTasks(summary.planUsage.usedMicros, 'own_key', summary.offers)
      : null;
  const onPace = summary.planUsage?.onPacePercent ?? null;

  return {
    measure,
    funding: summary.funding,
    range: { from: range.from, to: range.to, since: SHORT_DATE.format(range.from), period: range.period },
    billingPeriod: summary.period !== null,
    agent: agentId === null ? null : { id: agentId, name: names.agents.get(agentId) ?? OTHER },
    agentChoices,
    plan: planStrip(summary),
    total: amount(total),
    perDay: amount(elapsed === 0 ? 0 : measure === 'activity' ? Math.round(total * 10 / elapsed) / 10 : Math.round(total / elapsed)),
    change: !priorKnown || priorSoFar === 0 ? null : Math.round((currentSoFar - priorSoFar) * 100 / priorSoFar),
    share: agentId === null ? null : percent(total, sumOf(workspace)),
    pace: measure === 'usage' && thisPeriod && agentId === null && summary.period && onPace !== null
      ? { percent: onPace, by: SHORT_DATE.format(summary.period.end) }
      : null,
    tasks: measure === 'estimate' && tasksUsed !== null
      ? { used: tasksUsed, left: thisPeriod ? planBalance(summary)?.tasksLeft ?? null : null }
      : null,
    providers: measure === 'estimate'
      ? tally(current, (charge) => charge.model && charge.model.slice(0, charge.model.indexOf('/')), (key) => key).rows.map(({ key }) => key)
      : [],
    chart: {
      days: Array.from({ length: dayCount }, (_, index) => SHORT_DATE.format((firstDay + index) * DAY_MS)),
      elapsed,
      series: lines.map(({ key, name }) => ({ key, name, values: byDay(attributable.filter((charge) => line(charge) === key), firstDay) })),
      prior: !priorKnown || priorLine.every((value) => value === 0) ? null : priorLine,
    },
    models: listed(ranked(current, (charge) => charge.model, names.model, LISTED_ROWS, OTHER)).map(reportRow),
    people: people && listed(ranked(current, (charge) => charge.person, personName, LISTED_ROWS, 'Everyone else')).map(reportRow),
    agents: agentId !== null ? null : listed([
      ...agentChoices.map(({ id, name }) => ({ key: id, name, value: byAgent.rows.find((agent) => agent.key === id)?.value ?? 0 }))
        .sort(largestFirst),
      // On an own key, tasks of runs Core has no activity for still need a row.
      ...(byAgent.unnamed === null && !tasks?.some((task) => agentRow(task) === null)
        ? [] : [{ key: null, name: OTHER, value: byAgent.unnamed ?? 0 }]),
    ]).map((agent) => {
      const own = current.filter((charge) => agentRow(charge.agentId) === agent.key);
      return {
        ...reportRow(agent),
        topPerson: people && (tally(own, (charge) => charge.person, personName).rows[0]?.name ?? null),
        mainModel: tally(own, (charge) => charge.model, names.model).rows[0]?.name ?? null,
        tasks: tasks && count(tasks.filter((task) => agentRow(task) === agent.key).length),
      };
    }),
  };
}

/** Each named key's amount, largest first, and the amount of charges with no name; `unnamed` is null when there are none. */
function tally(
  list: readonly Charge[],
  keyOf: (charge: Charge) => string | null,
  nameOf: (key: string) => string | undefined,
): { rows: (Row & { key: string })[]; unnamed: number | null } {
  const named = new Map<string, Row & { key: string }>();
  let unnamed: number | null = null;
  for (const charge of list) {
    const key = keyOf(charge);
    const name = key === null ? undefined : nameOf(key);
    if (key === null || name === undefined) {
      unnamed = (unnamed ?? 0) + charge.value;
      continue;
    }
    const entry = named.get(key) ?? { key, name, value: 0 };
    entry.value += charge.value;
    named.set(key, entry);
  }
  return { rows: [...named.values()].sort(largestFirst), unnamed };
}

/**
 * The `limit` largest named keys, then one row gathering the rest and every
 * charge with no name. A gathered row that would hold one named key shows
 * that key instead.
 */
function ranked(
  list: readonly Charge[],
  keyOf: (charge: Charge) => string | null,
  nameOf: (key: string) => string | undefined,
  limit: number,
  gatheredName: string,
): Row[] {
  const { rows, unnamed } = tally(list, keyOf, nameOf);
  const hidden = rows.slice(limit);
  if (unnamed === null && hidden.length <= 1) return rows;
  return [...rows.slice(0, limit), { key: null, name: gatheredName, value: sumOf(hidden) + (unnamed ?? 0) }];
}

function reportRow({ key, name, amount, share }: ReportRow): ReportRow {
  return { key, name, amount, share };
}

/**
 * Whole cents for each value that sum to `totalCents`: each value's cents
 * rounded down, then one more cent for the largest remainders.
 */
function apportionCents(values: readonly number[], totalCents: number): number[] {
  const cents = values.map((value) => Math.floor(value / MICROS_PER_CENT));
  const remainder = (index: number) => values[index]! - cents[index]! * MICROS_PER_CENT;
  let left = totalCents - sum(cents);
  for (const index of values.map((_, index) => index).sort((a, b) => remainder(b) - remainder(a))) {
    if (left <= 0) break;
    cents[index]! += 1;
    left -= 1;
  }
  return cents;
}

/** A nonzero amount that gets no whole cent reads "<$0.01". */
function centsText(micros: number, cents: number): string {
  return cents === 0 && micros > 0 ? '<$0.01' : formatPriceCents(cents);
}

function largestFirst(left: Row, right: Row): number {
  return right.value - left.value || left.name.localeCompare(right.name);
}

/** Each billing run key's activity. */
function runIndex(attributions: readonly UsageActivityAttribution[]): Map<string, UsageActivityAttribution> {
  return new Map(attributions.flatMap((attribution) => attribution.billingRunIds.map((runId) => [runId, attribution] as const)));
}

function attributed(attribution: UsageActivityAttribution | undefined): Pick<Charge, 'agentId' | 'person' | 'model' | 'matched'> {
  if (!attribution) return { agentId: null, person: null, model: null, matched: false };
  return {
    agentId: attribution.agentId,
    person: attribution.operationKind === 'routine_run' ? ROUTINES
      : attribution.operationKind === 'test_turn' ? TEST_RUNS
      : attribution.requesterMembershipId,
    model: attribution.model,
    matched: true,
  };
}

/**
 * The Agent of each run that drew a task fee the host did not credit back.
 * A row that names no run counts alone.
 */
function keptTasks(rows: readonly BilledUsageRow[], runs: ReadonlyMap<string, UsageActivityAttribution>): (string | null)[] {
  const named = new Map<string, BilledUsageRow[]>();
  const loose: BilledUsageRow[][] = [];
  for (const row of rows) {
    if (row.runId === null) loose.push([row]);
    else named.set(row.runId, (named.get(row.runId) ?? []).concat(row));
  }
  const kept = (runRows: readonly BilledUsageRow[]) =>
    runRows.some((row) => row.task) && runRows.every((row) => row.creditedBackMicros === 0);
  return [
    ...[...named].filter(([, runRows]) => kept(runRows)).map(([runId]) => runs.get(runId)?.agentId ?? null),
    ...loose.filter(kept).map(() => null),
  ];
}

/** What rows of one run drew: model and fee charges less what was credited back. */
function net(rows: readonly BilledUsageRow[]): number {
  return rows.reduce((total, row) => total + row.modelMicros + row.feeMicros - row.creditedBackMicros, 0);
}

/** `isPublic`: whether the item's run is public; a private channel's or DM's row names nobody, as its labels are redacted. */
export function activityExtras(
  items: readonly UsageOperationDetail[],
  billed: readonly BilledUsageRow[] | null,
  names: UsageReportNames,
  isPublic: (item: UsageOperationDetail) => boolean,
): ActivityExtras[] {
  const byRun = new Map<string, BilledUsageRow[]>();
  for (const row of billed ?? []) {
    if (row.runId !== null) byRun.set(row.runId, (byRun.get(row.runId) ?? []).concat(row));
  }
  return items.map((item) => {
    const { operation, measurements } = item;
    const model = detailModel(operation, measurements.at(-1));
    const runIds = new Set(measurements.flatMap((measurement) => measurement.billingRunId ? [measurement.billingRunId] : []));
    const rows = [...runIds].flatMap((runId) => byRun.get(runId) ?? []);
    return {
      requester: names.people === null ? null : operation.operationKind === 'routine_run' ? 'Routine'
        : operation.requesterMembershipId === null || !isPublic(item) ? null
        : names.people?.get(operation.requesterMembershipId) ?? null,
      modelName: model === null ? null : names.model(model),
      billed: rows.length === 0 ? null : {
        amount: dollars(net(rows)),
        model: dollars(sum(rows.map((row) => row.modelMicros))),
        fee: dollars(sum(rows.map((row) => row.feeMicros))),
        task: rows.some((row) => row.task),
        creditedBack: rows.some((row) => row.creditedBackMicros > 0),
      },
    };
  });
}

/** As the store attributes one: its last measurement's returned model, else that one's requested model, else the operation's. */
function detailModel(
  operation: UsageOperationDetail['operation'],
  last: UsageOperationDetail['measurements'][number] | undefined,
): string | null {
  return pair(last?.returnedProvider, last?.returnedModel) ?? pair(last?.requestedProvider, last?.requestedModel) ??
    pair(operation.requestedProvider, operation.requestedModel);
}

function pair(provider: string | null | undefined, model: string | null | undefined): string | null {
  return provider && model ? `${provider}/${model}` : null;
}

/** The strip's facts, from the summary as the Plan page reads it. */
export function planStrip(summary: BillingSummary): UsageReport['plan'] {
  const left = planBalance(summary);
  const topUp = summary.autoTopUp;
  const on = topUp && summary.plan && topUp.enabled && summary.pendingChange?.kind !== 'ends';
  return left && { left: left.left, autoTopUp: !topUp ? null : on ? 'on' : 'off' };
}

/** The Plan page's balance, which it does not show for an own key without a plan. */
function planBalance(summary: BillingSummary): BillingBalance | null {
  if (summary.funding === 'own_key' && summary.plan === null) return null;
  return balance(summary, summary.plan && summary.offers.plans.find((offer) => offer.key === summary.plan?.key));
}

function dayNumber(at: number): number {
  return Math.floor(at / DAY_MS);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumOf(items: readonly { value: number }[]): number {
  return sum(items.map((item) => item.value));
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round(part * 100 / whole);
}

function count(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/** Rounded down as the Plan page's meter reads, and a nonzero amount under a cent as "<$0.01". */
function dollars(micros: number): string {
  return micros > 0 && micros < MICROS_PER_CENT ? '<$0.01' : formatUsageDollars(micros as UsageMicros, 'down');
}

/** What the hosted handlers read through the Usage Admin API. */
interface HostedUsageOptions {
  store: (c: Context) => UsageStore;
  agentNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
  personNames: (c: Context) => Promise<ReadonlyMap<string, string> | null>;
}

type BilledUsageRead = NonNullable<PlatformBillingPort['usage']>;

const MAX_QUERY_RANGE_MS = 366 * DAY_MS;
// A run billed in range may have started a little before it.
const RUN_LEAD_MS = 2 * DAY_MS;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/;

/** `GET /usage/report`; undefined where the host installed no billing port for the installation. */
export async function hostedUsageReport(c: Context, options: HostedUsageOptions, now = Date.now()): Promise<UsageReport | undefined> {
  const hosted = hostedBilling(c);
  if (!hosted) return undefined;
  const request = reportRequest(c);
  const agentId = c.req.query('agent') ?? null;
  if (agentId !== null && !AGENT_ID.test(agentId)) throw invalidQuery();
  const summary = await hosted.port.summary(hosted.installationId);
  const { range, prior } = reportRanges(request, summary, now);
  const [billed, attributions, names] = await Promise.all([
    billedUsage(hosted.port, async (read) => {
      const [current, previous] = await Promise.all([billedRows(read, hosted.installationId, range), billedRows(read, hosted.installationId, prior)]);
      return { current, prior: previous };
    }),
    options.store(c).listActivityAttributions({ from: Math.max(prior.from - RUN_LEAD_MS, range.to - MAX_QUERY_RANGE_MS), to: range.to }),
    reportNames(c, options),
  ]);
  return buildUsageReport({ summary, range, prior, billed, attributions, agentId, names, now });
}

/** Each `GET /usage/operations` item's hosted facts; undefined where the host installed no billing port for the installation. */
export async function hostedActivity(
  c: Context,
  options: HostedUsageOptions,
  items: readonly UsageOperationDetail[],
  isPublic: (item: UsageOperationDetail) => boolean,
  now = Date.now(),
): Promise<ActivityExtras[] | undefined> {
  const hosted = hostedBilling(c);
  if (!hosted) return undefined;
  // Only the page's own runs, whole: from the UTC day the oldest started to a day after the last finished.
  const pageWindow = items.length === 0 ? null : {
    from: dayNumber(Math.min(...items.map(({ operation }) => operation.startedAt))) * DAY_MS,
    to: Math.min(now + 1, Math.max(...items.map(({ operation }) => operation.finishedAt ?? now)) + DAY_MS),
  };
  const [rows, names] = await Promise.all([
    pageWindow && pageWindow.from < pageWindow.to
      ? billedUsage(hosted.port, (read) => billedRows(read, hosted.installationId, pageWindow))
      : null,
    reportNames(c, options),
  ]);
  return activityExtras(items, rows, names, isPublic);
}

function hostedBilling(c: Context): { port: PlatformBillingPort; installationId: string } | undefined {
  const port = platformBilling();
  const installationId = port && requireInstallationScope(c.env as PlatformEnv | undefined)?.installationId;
  return port && installationId ? { port, installationId } : undefined;
}

function reportRequest(c: Context): UsageReportRange {
  const period = c.req.query('period');
  if (period === 'this_billing_period' || period === 'last_billing_period') return { period };
  if (period !== undefined) throw invalidQuery();
  const time = (name: string) => {
    const value = c.req.query(name);
    return value && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  };
  const from = time('from');
  const to = time('to');
  // NaN compares false, so a missing or malformed bound is refused here too.
  if (!(from < to) || to - from > MAX_QUERY_RANGE_MS) throw invalidQuery();
  return { from, to };
}

function invalidQuery(): UsageStateError {
  return new UsageStateError('usage_query_invalid', 'Usage report query is invalid.');
}

/** Null when the host has no `usage` method or the read fails; a failure logs one line with no amounts or IDs. */
async function billedUsage<T>(port: PlatformBillingPort, read: (usage: BilledUsageRead) => Promise<T>): Promise<T | null> {
  if (!port.usage) return null;
  try {
    return await read(port.usage.bind(port));
  } catch {
    console.warn(JSON.stringify({ component: 'platform_billing', event: 'billed_usage_unavailable' }));
    return null;
  }
}

async function billedRows(read: BilledUsageRead, installationId: string, window: Window): Promise<readonly BilledUsageRow[]> {
  return (await read(installationId, { from: new Date(window.from), to: new Date(window.to) })).rows;
}

async function reportNames(c: Context, options: HostedUsageOptions): Promise<UsageReportNames> {
  const [agents, people] = await Promise.all([options.agentNames(c), options.personNames(c)]);
  const models = new Map(activeModelCatalogSnapshot(c.env as PlatformEnv | undefined).entries
    .flatMap((entry) => entry.displayName ? [[entry.id as string, entry.displayName] as const] : []));
  return { agents, people, model: (model) => models.get(model) ?? model.slice(model.indexOf('/') + 1) };
}
