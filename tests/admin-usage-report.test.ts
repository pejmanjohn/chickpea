import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildUsageReport,
  reportRanges,
  type UsageReport,
  type UsageReportNames,
  type UsageReportRange,
} from '../src/admin/usage-report.ts';
import type { BilledUsageRow, BillingSummary } from '../src/config/platform-billing.ts';
import type { UsageActivityAttribution } from '../src/usage/types.ts';
import { NO_PLAN, OWN_KEY_NO_PLAN, PERIOD, TEAM_PLAN, usd } from './helpers/billing-summaries.ts';

/** Oct 20, 12:00 UTC: day 14 of the Team plan's period, Oct 7 17:00 to Nov 7 17:00. */
const NOW = Date.UTC(2026, 9, 20, 12);
const OWN_KEY_TEAM: BillingSummary = { ...TEAM_PLAN, funding: 'own_key' };

const NAMES: UsageReportNames = {
  agents: new Map([['agent_a', 'Atlas'], ['agent_b', 'Birch'], ['agent_c', 'Cedar'], ['agent_d', 'Dune'], ['agent_e', 'Elm']]),
  people: new Map([['membership_maya', 'Maya Chen'], ['membership_li', 'Li Wei']]),
  model: (model) => model === 'anthropic/claude-sonnet-5' ? 'Claude Sonnet 5' : model.slice(model.indexOf('/') + 1),
};

function activity(id: string, agentId: string | null, at: string, overrides: Partial<UsageActivityAttribution> = {}): UsageActivityAttribution {
  return {
    operationId: `op_${id}`, operationKind: 'interactive_turn', startedAt: Date.parse(at), agentId,
    requesterMembershipId: 'membership_maya', model: 'anthropic/claude-sonnet-5', estimateMicros: null,
    billingRunIds: [`sub_${id}`], ...overrides,
  };
}

function billedRow(runId: string | null, day: string, model: number, overrides: Partial<BilledUsageRow> = {}): BilledUsageRow {
  return { runId, day, modelMicros: usd(model), feeMicros: usd(0), task: false, creditedBackMicros: usd(0), ...overrides };
}

const ACTIVITY = [
  activity('p1', 'agent_a', '2026-09-08T09:00:00Z', { estimateMicros: usd(0.9) }),
  activity('a1', 'agent_a', '2026-10-08T09:00:00Z', { estimateMicros: usd(1.2) }),
  activity('a2', 'agent_a', '2026-10-10T09:00:00Z', { requesterMembershipId: 'membership_li', model: 'openai/gpt-6', estimateMicros: usd(0.8) }),
  activity('b1', 'agent_b', '2026-10-10T10:00:00Z', { operationKind: 'routine_run', estimateMicros: usd(0.5) }),
  activity('c1', 'agent_c', '2026-10-11T09:00:00Z', { model: 'anthropic/claude-haiku-5', estimateMicros: usd(0.3) }),
  activity('d1', 'agent_d', '2026-10-12T09:00:00Z', { model: 'openai/gpt-6-mini', estimateMicros: usd(0.1) }),
  activity('e1', 'agent_e', '2026-10-12T10:00:00Z', { model: 'openai/gpt-6-nano' }),
  // An Agent deleted since: it has no name now.
  activity('gone', 'agent_gone', '2026-10-13T09:00:00Z', { estimateMicros: usd(0.05) }),
  activity('credited', 'agent_b', '2026-10-15T09:00:00Z', {
    requesterMembershipId: 'membership_li', model: 'openai/gpt-6', estimateMicros: usd(0.4),
  }),
];

const BILLED = {
  current: [
    billedRow('sub_a1', '2026-10-08', 2, { feeMicros: usd(0.3), task: true }),
    billedRow('sub_a1', '2026-10-09', 0.5),
    billedRow('sub_a2', '2026-10-10', 1),
    billedRow('sub_b1', '2026-10-10', 0.4, { feeMicros: usd(0.3), task: true }),
    billedRow('sub_c1', '2026-10-11', 0.6),
    billedRow('sub_d1', '2026-10-12', 0.2),
    billedRow('sub_e1', '2026-10-12', 0.1),
    billedRow('sub_gone', '2026-10-13', 0.05),
    // A private routine's run, which the store never lists, and a row that names no run.
    billedRow('sub_private_routine', '2026-10-13', 0.25),
    billedRow(null, '2026-10-14', 0.15),
    billedRow('sub_credited', '2026-10-15', 0.8, { feeMicros: usd(0.3), task: true, creditedBackMicros: usd(1.1) }),
  ],
  prior: [billedRow('sub_p1', '2026-09-08', 1), billedRow('sub_last_month', '2026-09-25', 0.3)],
};

function report(options: {
  summary?: BillingSummary;
  request?: UsageReportRange;
  billed?: typeof BILLED | null;
  attributions?: UsageActivityAttribution[];
  agentId?: string | null;
} = {}): UsageReport {
  const summary = options.summary ?? TEAM_PLAN;
  return buildUsageReport({
    summary,
    ...reportRanges(options.request ?? { period: 'this_billing_period' }, summary, NOW),
    billed: options.billed === undefined ? BILLED : options.billed,
    attributions: options.attributions ?? ACTIVITY,
    agentId: options.agentId ?? null,
    names: NAMES,
    now: NOW,
  });
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const rows = (list: UsageReport['models'] | null) => list?.map((row) => [row.key, row.name, row.amount.text, row.share]);

/**
 * Every list the page draws adds up to the total it shows. The chart leaves
 * out `unattributed`, usage Core lists no activity for, so a private
 * routine's days never show.
 */
function assertListsAddUp(shown: UsageReport, unattributed = 0): void {
  const total = shown.total.value;
  assert.equal(sum(shown.chart.series.flatMap((line) => line.values)), total - unattributed, 'the chart');
  assert.equal(sum(shown.models.map((row) => row.amount.value)), total, 'models');
  if (shown.people) assert.equal(sum(shown.people.map((row) => row.amount.value)), total, 'people');
  if (shown.agents) assert.equal(sum(shown.agents.map((row) => row.amount.value)), total, 'Agents');
}

test('billed usage: every run counts toward its Agent, person and model, and unmatched rows gather under Other', () => {
  const shown = report();
  // The private routine's $0.25 and the row naming no run, $0.15.
  assertListsAddUp(shown, usd(0.4));
  assert.equal(shown.measure, 'usage');
  assert.deepEqual(shown.total, { value: usd(5.85), text: '$5.85' }, 'a run credited back counts nothing; unmatched rows still count');
  assert.deepEqual(shown.agents?.map((agent) => [agent.key, agent.name, agent.amount.text, agent.share, agent.topPerson, agent.mainModel, agent.tasks]), [
    ['agent_a', 'Atlas', '$3.80', 65, 'Maya Chen', 'Claude Sonnet 5', null],
    ['agent_b', 'Birch', '$0.70', 12, 'Routines', 'Claude Sonnet 5', null],
    ['agent_c', 'Cedar', '$0.60', 10, 'Maya Chen', 'claude-haiku-5', null],
    ['agent_d', 'Dune', '$0.20', 3, 'Maya Chen', 'gpt-6-mini', null],
    ['agent_e', 'Elm', '$0.10', 2, 'Maya Chen', 'gpt-6-nano', null],
    [null, 'Other', '$0.45', 8, 'Maya Chen', 'Claude Sonnet 5', null],
  ]);
  assert.deepEqual(rows(shown.models), [
    ['anthropic/claude-sonnet-5', 'Claude Sonnet 5', '$3.55', 61],
    ['openai/gpt-6', 'gpt-6', '$1', 17],
    ['anthropic/claude-haiku-5', 'claude-haiku-5', '$0.60', 10],
    ['openai/gpt-6-mini', 'gpt-6-mini', '$0.20', 3],
    ['openai/gpt-6-nano', 'gpt-6-nano', '$0.10', 2],
    [null, 'Other', '$0.40', 7],
  ]);
  assert.deepEqual(rows(shown.people), [
    ['membership_maya', 'Maya Chen', '$3.75', 64],
    ['membership_li', 'Li Wei', '$1', 17],
    ['routines', 'Routines', '$0.70', 12],
    [null, 'Everyone else', '$0.40', 7],
  ]);
  assert.deepEqual(shown.chart.series.map((line) => [line.key, line.name, sum(line.values)]), [
    ['agent_a', 'Atlas', usd(3.8)], ['agent_b', 'Birch', usd(0.7)], ['agent_c', 'Cedar', usd(0.6)], ['agent_d', 'Dune', usd(0.2)],
    [null, 'Other', usd(0.15)],
  ], 'the four largest Agents, then one row gathering the rest, without usage Core can\'t attribute');
  assert.deepEqual(shown.chart.series[0]!.values.slice(0, 4), [0, usd(2.3), usd(0.5), usd(1)], 'each row on its own UTC day');
  assert.deepEqual([shown.chart.days[0], shown.chart.days.at(-1), shown.chart.days.length, shown.chart.elapsed], ['Oct 7', 'Nov 7', 32, 14]);
  assert.deepEqual(shown.agentChoices.map((choice) => choice.name), ['Atlas', 'Birch', 'Cedar', 'Dune', 'Elm']);
  assert.deepEqual(shown.range, { from: PERIOD.start.getTime(), to: NOW + 1, since: 'Oct 7', period: 'this_billing_period' });
  assert.deepEqual(shown.perDay, { value: Math.round(usd(5.85) / 14), text: '$0.41' });
  // Attributable usage on both sides: $5.45 this period so far against Sep 8's $1; Sep 25's $0.30 is later.
  assert.equal(shown.change, 445);
  // Sep 25's $0.30 matches no activity, so the dashed line leaves it out.
  assert.deepEqual([shown.chart.prior?.[1], shown.chart.prior?.[18], sum(shown.chart.prior ?? [])], [usd(1), 0, usd(1)]);
  assert.deepEqual(shown.pace, { percent: 80, by: 'Nov 7' });
  assert.deepEqual(shown.plan, { left: '$132', autoTopUp: null });
  assert.deepEqual([shown.share, shown.agent, shown.tasks, shown.providers, shown.billingPeriod], [null, null, null, [], true]);
});

test('with an Agent selected every number is that Agent\'s, and its share is of the workspace', () => {
  const shown = report({ agentId: 'agent_a' });
  assertListsAddUp(shown);
  assert.deepEqual(shown.total, { value: usd(3.8), text: '$3.80' });
  assert.deepEqual([shown.agent, shown.share, shown.agents, shown.pace], [{ id: 'agent_a', name: 'Atlas' }, 65, null, null]);
  assert.deepEqual(shown.chart.series.map((line) => line.key), ['agent_a']);
  assert.deepEqual(rows(shown.models), [
    ['anthropic/claude-sonnet-5', 'Claude Sonnet 5', '$2.80', 74],
    ['openai/gpt-6', 'gpt-6', '$1', 26],
  ]);
  assert.deepEqual(rows(shown.people), [['membership_maya', 'Maya Chen', '$2.80', 74], ['membership_li', 'Li Wei', '$1', 26]]);
  assert.equal(shown.change, 280, 'against its own $1 the same days last period');
  assert.deepEqual(shown.agentChoices.map((choice) => choice.id), ['agent_a', 'agent_b', 'agent_c', 'agent_d', 'agent_e']);
});

test('without billed usage the report counts activities, each once on the day it started', () => {
  const shown = report({ billed: null });
  assertListsAddUp(shown);
  assert.equal(shown.measure, 'activity');
  assert.deepEqual([shown.total, shown.perDay], [{ value: 8, text: '8' }, { value: 0.6, text: '0.6' }]);
  assert.deepEqual(shown.agents?.map((agent) => [agent.name, agent.amount.text, agent.share]), [
    ['Atlas', '2', 25], ['Birch', '2', 25], ['Cedar', '1', 13], ['Dune', '1', 13], ['Elm', '1', 13], ['Other', '1', 13],
  ]);
  assert.deepEqual(shown.chart.series.map((line) => [line.name, sum(line.values)]), [
    ['Atlas', 2], ['Birch', 2], ['Cedar', 1], ['Dune', 1], ['Other', 2],
  ]);
  assert.deepEqual([shown.change, shown.pace], [700, null]);
});

test('a gathered row that would hold one item shows that item instead', () => {
  const people = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  const names: UsageReportNames = { ...NAMES, people: new Map(people.map((id) => [id, id.toUpperCase()])) };
  const shownWith = (count: number) => buildUsageReport({
    summary: TEAM_PLAN,
    ...reportRanges({ period: 'this_billing_period' }, TEAM_PLAN, NOW),
    billed: null,
    attributions: people.slice(0, count).map((id, index) =>
      activity(id, 'agent_a', '2026-10-08T09:00:00Z', { requesterMembershipId: id, startedAt: Date.parse('2026-10-08T09:00:00Z') + index })),
    agentId: null,
    names,
    now: NOW,
  });
  assert.deepEqual(shownWith(6).people?.map((row) => row.name), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.deepEqual(shownWith(7).people?.map((row) => [row.name, row.amount.value]), [
    ['P1', 1], ['P2', 1], ['P3', 1], ['P4', 1], ['P5', 1], ['Everyone else', 2],
  ]);
});

test('on its own key a workspace sees Core\'s estimate, its providers, and the tasks the plan counted', () => {
  const shown = report({ summary: OWN_KEY_TEAM });
  assertListsAddUp(shown);
  assert.equal(shown.measure, 'estimate');
  assert.deepEqual(shown.total, { value: usd(3.35), text: '$3.35' });
  assert.deepEqual(shown.providers, ['anthropic', 'openai']);
  // a1 and b1 kept their task fee; the credited run did not.
  assert.deepEqual(shown.tasks, { used: '2', left: '440' });
  assert.deepEqual(shown.agents?.map((agent) => [agent.name, agent.amount.text, agent.tasks]), [
    ['Atlas', '$2', '1'], ['Birch', '$0.90', '1'], ['Cedar', '$0.30', '0'], ['Dune', '$0.10', '0'], ['Elm', '$0', '0'], ['Other', '$0.05', '0'],
  ]);
  assert.deepEqual([shown.pace, shown.plan], [null, { left: '$132', autoTopUp: null }]);

  assert.deepEqual(report({ summary: OWN_KEY_TEAM, agentId: 'agent_b' }).tasks, { used: '1', left: '440' });
  const unbilled = report({ summary: OWN_KEY_TEAM, billed: null });
  assert.deepEqual(unbilled.tasks, { used: '426', left: '440' }, 'this billing period, from the plan meter');
  assert.equal(unbilled.agents?.[0]?.tasks, null);
  assert.equal(report({ summary: OWN_KEY_TEAM, billed: null, request: { period: 'last_billing_period' } }).tasks, null);
  assert.equal(report({ summary: OWN_KEY_TEAM, billed: null, agentId: 'agent_a' }).tasks, null, 'the meter is not one Agent\'s');
  assert.equal(report({ summary: OWN_KEY_NO_PLAN }).plan, null);

  // A private routine's task, with no activity Core lists, still counts in the Agents table.
  const privateTask = report({
    summary: OWN_KEY_TEAM,
    attributions: ACTIVITY.filter((item) => item.agentId !== 'agent_gone'),
    billed: { ...BILLED, current: [...BILLED.current, billedRow('sub_private_task', '2026-10-16', 0, { feeMicros: usd(0.3), task: true })] },
  });
  assert.equal(privateTask.tasks?.used, '3');
  assert.deepEqual(privateTask.agents?.map((agent) => [agent.name, agent.tasks]).at(-1), ['Other', '1']);
  assert.equal(sum(privateTask.agents?.map((agent) => Number(agent.tasks)) ?? []), 3);
});

test('ranges: this and last billing period, a month clamped to its end, 30 days without a period, any range\'s prior', () => {
  const start = PERIOD.start.getTime();
  const lastStart = Date.UTC(2026, 8, 7, 17);
  assert.deepEqual(reportRanges({ period: 'this_billing_period' }, TEAM_PLAN, NOW), {
    range: { from: start, to: NOW + 1, period: 'this_billing_period' }, prior: { from: lastStart, to: start },
  });
  assert.deepEqual(reportRanges({ period: 'last_billing_period' }, TEAM_PLAN, NOW), {
    range: { from: lastStart, to: start, period: 'last_billing_period' }, prior: { from: Date.UTC(2026, 7, 7, 17), to: lastStart },
  });
  const march31: BillingSummary = { ...TEAM_PLAN, period: { start: new Date('2027-03-31T17:00:00Z'), end: new Date('2027-04-30T17:00:00Z') } };
  assert.deepEqual(reportRanges({ period: 'last_billing_period' }, march31, NOW), {
    range: { from: Date.UTC(2027, 1, 28, 17), to: Date.UTC(2027, 2, 31, 17), period: 'last_billing_period' },
    prior: { from: Date.UTC(2027, 0, 31, 17), to: Date.UTC(2027, 1, 28, 17) },
  });
  const days30 = { from: Date.UTC(2026, 8, 21), to: Date.UTC(2026, 9, 21) };
  for (const period of ['this_billing_period', 'last_billing_period'] as const) {
    assert.deepEqual(reportRanges({ period }, NO_PLAN, NOW), {
      range: { ...days30, period: null }, prior: { from: Date.UTC(2026, 7, 22), to: days30.from },
    });
  }
  const custom = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 11) };
  assert.deepEqual(reportRanges(custom, TEAM_PLAN, NOW).prior, { from: Date.UTC(2026, 8, 21), to: custom.from });

  const fallback = report({ summary: NO_PLAN, billed: null });
  assert.deepEqual(
    [fallback.billingPeriod, fallback.range.period, fallback.chart.days[0], fallback.chart.days.at(-1), fallback.chart.elapsed],
    [false, null, 'Sep 21', 'Oct 20', 30],
  );
});

test('each list\'s amounts read as cents that add up to the total as shown', () => {
  // Three Agents each drew a dollar and a third of a cent: rounded alone, each reads $1 and the list $3 of $3.01.
  const thirds = ['agent_a', 'agent_b', 'agent_c'].map((agentId, index) =>
    activity(`third_${index}`, agentId, '2026-10-08T09:00:00Z', { requesterMembershipId: index === 0 ? 'membership_li' : 'membership_maya' }));
  const billed = {
    current: thirds.map((_, index) => billedRow(`sub_third_${index}`, '2026-10-08', 1.003_4)),
    prior: [],
  };
  const result = report({ billed, attributions: thirds });
  const cents = (text: string) => text === '<$0.01' ? 0 : Math.round(Number(text.replace('$', '')) * 100);
  assert.equal(result.total.text, '$3.01');
  for (const list of [result.agents ?? [], result.models, result.people ?? []]) {
    assert.equal(sum(list.map((row) => cents(row.amount.text))), cents(result.total.text), JSON.stringify(rows(list)));
  }
});

test('the strip states auto top-up as the Plan page shows an Admin: on or off, never why it paused', () => {
  const topUp: NonNullable<BillingSummary['autoTopUp']> = {
    enabled: true, explicitlyOff: false, pack: { rule: 'plan', key: 'extra_usage_50' }, limit: { rule: 'plan', cents: 20_000 },
    usedCents: 0, resetsAt: PERIOD.end, pause: null, card: null,
  };
  const strip = (autoTopUp: NonNullable<BillingSummary['autoTopUp']>) => report({ summary: { ...TEAM_PLAN, autoTopUp } }).plan?.autoTopUp;
  assert.equal(strip(topUp), 'on');
  assert.equal(strip({ ...topUp, pause: { kind: 'declined', at: PERIOD.start } }), 'on', 'a failed charge is an Owner\'s to see');
  assert.equal(strip({ ...topUp, enabled: false, explicitlyOff: true }), 'off');
  assert.equal(report({ summary: TEAM_PLAN }).plan?.autoTopUp, null, 'a host that offers no auto top-up');
});

test('a viewer who sees no one\'s usage gets no people, and usage Core can\'t attribute counts only in a billing period', () => {
  const summary = TEAM_PLAN;
  const build = (request: UsageReportRange, people: UsageReportNames['people'], billed = BILLED) => buildUsageReport({
    summary, ...reportRanges(request, summary, NOW), billed, attributions: ACTIVITY, agentId: null,
    names: { ...NAMES, people }, now: NOW,
  });
  const admin = build({ period: 'this_billing_period' }, null);
  assert.equal(admin.people, null);
  assert.deepEqual(admin.agents?.map((agent) => agent.topPerson), [null, null, null, null, null, null]);
  assert.equal(admin.total.text, '$5.85', 'an Admin sees the same total');

  // The private routine's $0.25 on Oct 13 and the row naming no run, $0.15 on Oct 14.
  const days = (row: BilledUsageRow) => row.day === '2026-10-13' || row.day === '2026-10-14';
  const narrow = build({ from: Date.UTC(2026, 9, 13), to: Date.UTC(2026, 9, 15) }, NAMES.people, {
    current: BILLED.current.filter(days), prior: [],
  });
  assert.equal(narrow.total.value, usd(0.05), 'only the deleted Agent\'s attributed $0.05');
  assert.equal(narrow.agents?.find((agent) => agent.key === null)?.amount.text, '$0.05');
});

test('outside a billing period nobody is named, and the range starts no earlier than the activity Core keeps', () => {
  const at = (request: UsageReportRange) => buildUsageReport({
    summary: TEAM_PLAN, ...reportRanges(request, TEAM_PLAN, NOW), billed: BILLED, attributions: ACTIVITY, agentId: null,
    names: NAMES, now: NOW,
  });
  const rolling = at({ from: NOW - 7 * 86_400_000, to: NOW + 1 });
  assert.deepEqual([rolling.people, rolling.agents?.[0]?.topPerson], [null, null], 'an Owner sees people by billing period only');
  assert.ok(at({ period: 'this_billing_period' }).people, 'and does in one');

  const old = at({ from: NOW - 200 * 86_400_000, to: NOW - 100 * 86_400_000 });
  assert.equal(old.range.from, old.range.to, 'nothing Core still keeps');
  const ninety = at({ from: NOW - 90 * 86_400_000, to: NOW + 1 });
  assert.equal(ninety.range.from, NOW - 90 * 86_400_000);
  assert.deepEqual([ninety.change, ninety.chart.prior], [null, null], 'the 90 days before it are past retention');
});

test('the strip reads off for a plan that is ending, as the Plan page shows an Admin', () => {
  const autoTopUp: NonNullable<BillingSummary['autoTopUp']> = {
    enabled: true, explicitlyOff: false, pack: { rule: 'plan', key: 'extra_usage_50' }, limit: { rule: 'plan', cents: 20_000 },
    usedCents: 0, resetsAt: PERIOD.end, pause: null, card: null,
  };
  const ending: BillingSummary = { ...TEAM_PLAN, autoTopUp, pendingChange: { kind: 'ends', at: PERIOD.end } };
  assert.equal(report({ summary: ending }).plan?.autoTopUp, 'off');
});

test('last billing period compares with the one before it only while Core still keeps that one', () => {
  // Last billing period is Sep 7 to Oct 7; the one before it starts Aug 7.
  const attributions = [...ACTIVITY, activity('aug', 'agent_a', '2026-08-10T09:00:00Z')];
  const billed = { current: [billedRow('sub_p1', '2026-09-08', 2)], prior: [billedRow('sub_aug', '2026-08-10', 1)] };
  const on = (now: number) => buildUsageReport({
    summary: TEAM_PLAN, ...reportRanges({ period: 'last_billing_period' }, TEAM_PLAN, now),
    billed, attributions, agentId: null, names: NAMES, now,
  });
  assert.equal(on(NOW).change, 100, 'on Oct 20, Aug 7 is 74 days back: $2 against $1');
  assert.deepEqual([on(NOW + 20 * 86_400_000).change, on(NOW + 20 * 86_400_000).chart.prior], [null, null],
    'on Nov 9 it is 94 days back, past retention, so its deleted activity never reads as a change');
});

test('a test run counts toward the Agent it tested, and under "Practice runs" by person, as routines gather under "Routines"', () => {
  const shown = report({
    attributions: [
      activity('a1', 'agent_a', '2026-10-08T09:00:00Z'),
      activity('t1', 'agent_b', '2026-10-09T09:00:00Z', { operationKind: 'test_turn' }),
    ],
    billed: { current: [billedRow('sub_a1', '2026-10-08', 1), billedRow('sub_t1', '2026-10-09', 0.25)], prior: [] },
  });
  assert.deepEqual(rows(shown.people), [['membership_maya', 'Maya Chen', '$1', 80], ['test_runs', 'Practice runs', '$0.25', 20]]);
  assert.deepEqual(shown.agents?.map((agent) => [agent.key, agent.amount.text, agent.topPerson]),
    [['agent_a', '$1', 'Maya Chen'], ['agent_b', '$0.25', 'Practice runs']]);
});
