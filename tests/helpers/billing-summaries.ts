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
};

export const PERIOD = { start: new Date('2026-10-07T17:00:00Z'), end: new Date('2026-11-07T17:00:00Z') };

/** Chickpea's models, no plan, no trial, nothing left. */
export const NO_PLAN: BillingSummary = {
  funding: 'platform',
  plan: null,
  period: null,
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
