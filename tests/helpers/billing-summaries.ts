import type { BillingSummary, UsageMicros } from '../../src/config/platform-billing.ts';

export const usd = (dollars: number) => Math.round(dollars * 1_000_000) as UsageMicros;

export const OFFERS: BillingSummary['offers'] = {
  plans: [
    { key: 'solo', name: 'Solo', priceCents: 2_500, includedMicros: usd(30), ownKeyEligible: false },
    { key: 'starter', name: 'Starter', priceCents: 5_000, includedMicros: usd(60), ownKeyEligible: false },
    { key: 'plus', name: 'Plus', priceCents: 10_000, includedMicros: usd(120), ownKeyEligible: true },
    { key: 'team', name: 'Team', priceCents: 20_000, includedMicros: usd(240), ownKeyEligible: true },
    { key: 'growth', name: 'Growth', priceCents: 30_000, includedMicros: usd(360), ownKeyEligible: true },
    { key: 'business', name: 'Business', priceCents: 50_000, includedMicros: usd(600), ownKeyEligible: true },
  ],
  extraUsage: [25, 50, 100].map((dollars) => ({
    key: `extra_usage_${dollars}`, priceCents: dollars * 100, usageMicros: usd(dollars), validMonths: 12,
  })),
  ownKeyMinimumPlanKey: 'plus',
  taskFeeMicros: usd(0.3),
  chatReplyFeeMicros: usd(0),
  typicalTaskMicros: usd(0.15),
  rolloverMonths: 1,
};

/** The trial a workspace on models included starts with, part-used. */
export const TRIAL_GRANT = { remainingMicros: usd(32.5), grantedMicros: usd(50), expiresAt: new Date('2026-11-06T17:00:00Z') };

export const PERIOD = { start: new Date('2026-10-07T17:00:00Z'), end: new Date('2026-11-07T17:00:00Z') };

/** Chickpea's models, no plan, no trial, nothing left. */
export const NO_PLAN: BillingSummary = {
  funding: 'platform',
  plan: null,
  period: null,
  pendingChange: null,
  planUsage: null,
  rollover: null,
  extraUsage: null,
  trial: null,
  debtMicros: usd(0),
  autoUpgrade: null,
  use: { byAgent: [], byPerson: [] },
  offers: OFFERS,
};

export const OWN_KEY_NO_PLAN: BillingSummary = { ...NO_PLAN, funding: 'own_key' };

/** The Team plan part-way through its period, with usage carried over and extra usage on hand. */
export const TEAM_PLAN: BillingSummary = {
  ...NO_PLAN,
  plan: { key: 'team', name: 'Team', priceCents: 20_000 },
  period: PERIOD,
  planUsage: { usedMicros: usd(128), includedMicros: usd(240), onPacePercent: 80 },
  rollover: { remainingMicros: usd(20), expiresAt: PERIOD.end },
  extraUsage: { remainingMicros: usd(40), frozen: false, expiresAt: new Date('2027-09-14T17:00:00Z') },
  autoUpgrade: { enabled: true, usedThisPeriod: false },
  use: {
    byAgent: [{ id: 'agent_gone', usageMicros: usd(5) }, { id: 'agent_chickpea', usageMicros: usd(30.25) }, { id: null, usageMicros: usd(2) }],
    byPerson: [{ id: 'membership_maya', usageMicros: usd(31.5) }, { id: 'membership_unknown', usageMicros: usd(6) }],
  },
};

/** The Team plan, cancelled in Stripe's portal, ending with its period. */
export const TEAM_ENDING: BillingSummary = { ...TEAM_PLAN, pendingChange: { kind: 'ends', at: PERIOD.end } };

/** The Team plan, downgraded in Stripe's portal, changing to the $50 plan with its period. */
export const TEAM_DOWNGRADING: BillingSummary = {
  ...TEAM_PLAN,
  pendingChange: { kind: 'plan', plan: { name: 'Chickpea $50 plan' }, at: PERIOD.end },
};

/** The Team plan before its next subscription event records a period, so there is no meter. */
export const PLAN_NO_PERIOD: BillingSummary = { ...TEAM_PLAN, period: null, planUsage: null, rollover: null };

/** Below the lowest plan for an own key. */
export const STARTER_PLAN: BillingSummary = {
  ...NO_PLAN,
  plan: { key: 'starter', name: 'Starter', priceCents: 5_000 },
  period: PERIOD,
  planUsage: { usedMicros: usd(21.37), includedMicros: usd(60), onPacePercent: null },
};

/** The rate card's plans with the pack auto top-up buys on each: the largest at or below the plan's price. */
export const TOP_UP_OFFERS: BillingSummary['offers'] = {
  ...OFFERS,
  plans: OFFERS.plans.map((plan) => ({
    ...plan, autoTopUpPackKey: `extra_usage_${Math.min(100, plan.priceCents / 100)}`,
  })),
};

/** Auto top-up on by default for the $50 plan: $50 packs up to $50 a month, nothing added yet. */
export const TOP_UP_ON: NonNullable<BillingSummary['autoTopUp']> = {
  enabled: true,
  explicitlyOff: false,
  pack: { rule: 'plan', key: 'extra_usage_50' },
  limit: { rule: 'plan', cents: 5_000 },
  usedCents: 0,
  resetsAt: PERIOD.end,
  pause: null,
  card: { brand: 'visa', last4: '4242' },
};

/** Oct 26 on the $50 plan: $23.40 of its $60 left, auto top-up on. */
export const STARTER_TOP_UP: BillingSummary = {
  ...STARTER_PLAN,
  planUsage: { usedMicros: usd(36.6), includedMicros: usd(60), onPacePercent: 96 },
  autoTopUp: TOP_UP_ON,
  offers: TOP_UP_OFFERS,
};

/** Oct 30: the plan's $60 and this month's $50 of top-ups are used up, so the Agents are paused. */
export const STARTER_AT_LIMIT: BillingSummary = {
  ...STARTER_TOP_UP,
  planUsage: { usedMicros: usd(60), includedMicros: usd(60), onPacePercent: null },
  autoTopUp: { ...TOP_UP_ON, usedCents: 5_000 },
};

/** Oct 29: the plan's usage is used up and auto top-up added its $50, of which $42.10 is left. */
export const STARTER_TOPPED: BillingSummary = {
  ...STARTER_AT_LIMIT,
  extraUsage: { remainingMicros: usd(42.1), frozen: false, expiresAt: new Date('2027-10-28T17:00:00Z'), totalMicros: usd(50) },
};
