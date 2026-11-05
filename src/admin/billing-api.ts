import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { isOwnerSession } from '../auth/permissions.ts';
import { requestPrincipal } from '../auth/service.ts';
import { requireInstallationScope } from '../config/installation-scope.ts';
import {
  AUTO_TOP_UP_CONSENT_VERSION,
  BillingRefusal,
  platformBilling,
  type AutoTopUpChange,
  type BillingActor,
  type BillingFunding,
  type BillingSummary,
  type ExtraUsageOffer,
  type PlanOffer,
  type PlatformBillingPort,
  type SavedCardResult,
  type UsageRow,
} from '../config/platform-billing.ts';
import { isProviderKeyId, type ProviderKeyId } from '../config/provider-keys.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { formatCard, formatPriceCents, formatUsageDollars, usagePercent, type UsageMicros } from '../usage/usage-display.ts';
import { invalidRequest, noStore, readJson } from './api-support.ts';
import { balance, type BillingBalance } from './billing-balance.ts';
import { formatTasks } from './billing-tasks.ts';

export const PLAN_PATH = '/admin/plan';

const MAX_BILLING_BODY_BYTES = 512;
const MICROS_PER_CENT = 10_000;
/** The highest monthly auto top-up limit an Owner can set, $10,000, so a typo can't authorize more. */
const MAX_TOP_UP_LIMIT_CENTS = 1_000_000;
const rateCardKey = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/));
const consentVersion = v.optional(v.pipe(v.string(), v.maxLength(64)));
const checkoutSchema = v.strictObject({ kind: v.picklist(['plan', 'extra_usage']), key: rateCardKey });
const fundingSchema = v.strictObject({ funding: v.picklist(['platform', 'own_key']) });
const autoTopUpSchema = v.variant('change', [
  v.strictObject({ change: v.picklist(['off', 'retry']) }),
  v.strictObject({
    change: v.literal('on'),
    pack: v.union([v.literal('plan'), rateCardKey]),
    limit: v.union([v.literal('plan'), v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(MAX_TOP_UP_LIMIT_CENTS))]),
    consentVersion,
  }),
]);
const planChangeSchema = v.strictObject({ key: rateCardKey, consentVersion });
const extraUsageSchema = v.strictObject({ key: rateCardKey });

interface BillingAdminApiOptions {
  agentNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
  /** Display names keyed by Chickpea membership ID. */
  personNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
  ownKeyFacts: (c: Context) => Promise<OwnKeyFacts>;
  /** After an Owner switches to Chickpea's models, sets what onboarding sets with them. */
  choseChickpeaModels: (c: Context) => Promise<void>;
  /** The Owner making a billing change, for the host's consent records. */
  actor: (c: Context) => Promise<BillingActor>;
}

/** What paying with the installation's own key would rely on. */
interface OwnKeyFacts {
  readonly savedKeys: ReadonlySet<ProviderKeyId>;
  /** The workspace default chat model, while one is chosen. */
  readonly defaultModel: string | undefined;
  /** Active, enabled Agents, each with the model it pins, if any. */
  readonly agents: readonly { readonly name: string; readonly model?: string }[];
}

/** Read only for an Owner's own session. */
interface OwnerFacts {
  readonly agentNames: ReadonlyMap<string, string>;
  readonly personNames: ReadonlyMap<string, string>;
  readonly ownKey: OwnKeyFacts;
  readonly inApp: { readonly planChange: boolean; readonly extraUsage: boolean };
}

/** One row of use; a null name gathers use with no Agent or person, or one with no name. */
interface NamedUse {
  name: string | null;
  used: string;
  /** The row's share of the largest row, 0 to 100, for its bar. */
  bar: number;
}

/** Use by one Agent, with its ID for its avatar; null for the gathered row. */
interface AgentUse extends NamedUse {
  id: string | null;
}

/**
 * What everyone sees. Amounts are formatted dollars; dates are formatted UTC
 * days, "Nov 7" or "Oct 7, 2027"; task counts read "400" when exact and
 * "about 250" when they assume a typical task.
 */
interface BillingStatus {
  funding: BillingFunding;
  /** `included` is null for a plan no longer on sale; `tasks` also when a task draws nothing. */
  plan: { key: string; name: string; price: string; included: string | null; tasks: string | null } | null;
  /** Null when the plan renews unchanged, or there is no plan. */
  pendingChange: { kind: 'ends'; on: string } | { kind: 'plan'; planName: string; on: string } | null;
  /** Null without a plan period, which a plan can lack until its next subscription event. Task counts are for an own key only, and null when a task draws nothing. */
  meter: {
    used: string; included: string; percent: number; onPacePercent: number | null; resets: string;
    tasksUsed: string | null; tasksIncluded: string | null;
  } | null;
  /** Null when nothing carried over. */
  rollover: { remaining: string; until: string } | null;
  /** Null when none is left. `bar` is what the packs that still have usage left held, and how much of it is used; null when the host doesn't say. */
  extraUsage: {
    remaining: string; frozen: boolean; until: string;
    bar: { used: string; total: string; percent: number } | null;
  } | null;
  trial: { remaining: string; granted: string; used: string; percent: number; until: string } | null;
  ownKeyWithoutPlan: { minimumPrice: string; minimumTasks: string | null } | null;
  /** What the big number counts, in the order usage is spent; null for an own key without a plan. */
  balance: BillingBalance | null;
  /** Null where the host offers no auto top-up. Everyone sees whether it is on and whether it reached its limit; only an Owner sees more. */
  autoTopUp: { kind: 'no_plan' } | { kind: 'plan'; on: boolean; limitReached: boolean } | null;
  /** The flat usage a task draws, "30¢". */
  taskFee: string;
}

/**
 * Auto top-up as an Owner manages it. Amounts are formatted dollars, with
 * cents beside the ones the editor compares; `limitReached` means the next
 * pack would not fit under the limit this period.
 */
interface OwnerAutoTopUp {
  enabled: boolean;
  /** The plan ends at renewal, so auto top-up is off until a new plan. */
  ending: boolean;
  pack: { rule: 'plan' | 'fixed'; key: string; price: string; cents: number };
  limit: { rule: 'plan' | 'fixed'; amount: string; cents: number };
  used: string;
  percent: number;
  resets: string | null;
  limitReached: boolean;
  pause:
    | { kind: 'declined'; on: string }
    | { kind: 'needs_confirmation'; amount: string; url: string | null }
    | { kind: 'billing_details' }
    | { kind: 'past_due' }
    | null;
  /** "Visa ending 4242"; null without a card. */
  card: string | null;
  /** The plan's price, which a "same as your plan" limit follows. */
  plan: { price: string; cents: number };
  /** Each pack an Owner can choose, with the tasks it covers. */
  packs: { key: string; price: string; cents: number; tasks: string | null }[];
  /** The next plan up, with the usage it includes, and what this month's plan and top-ups covered. Null on the largest plan. */
  upgrade: { key: string; price: string; included: string; covered: string } | null;
  consentVersion: string;
}

/** What the Owner's latest purchase did, for the banner when they come back from Stripe. */
type PurchaseView =
  | { kind: 'extra_usage'; granted: boolean; usage: string }
  | { kind: 'plan'; granted: boolean; first: boolean; added: string };

/**
 * What paying with the installation's own key needs, whatever the funding is
 * now: a plan at or above the lowest one for it, then a key for the default
 * model's provider. `provider` names that provider, null when no default model
 * is chosen. Agents pinned to a provider with no saved key would stop replying.
 */
export interface OwnKeySetup {
  planReady: boolean;
  minimumPlan: { key: string; price: string };
  key:
    | { ready: true; provider: ProviderKeyId | null; agentsWithoutKey: string[] }
    | { ready: false; provider: ProviderKeyId | null };
}

/**
 * What the Plan page shows. Only an Owner can buy, change the plan, or switch
 * funding, so everyone else sees the status alone.
 */
export type BillingView =
  | ({ manage: false } & BillingStatus)
  | ({ manage: true } & BillingStatus & {
    period: { start: string; end: string } | null;
    use: { byAgent: AgentUse[]; byPerson: NamedUse[] };
    offers: {
      plans: {
        key: string; name: string; price: string; included: string; ownKeyMinimum: boolean; ownKeyEligible: boolean;
        /** What auto top-up adds each time on this plan, for the first plan's disclosure; null when the host doesn't say. */
        topUpPack: string | null;
        /** Tasks the plan covers each month; `ownKey` is null for a plan an own key cannot choose, both when a task draws nothing. */
        tasks: { platform: string | null; ownKey: string | null };
      }[];
      extraUsage: { key: string; price: string; usage: string; validMonths: number }[];
      /** How much more usage than its price every plan includes, in percent. */
      bonusPercent: number;
      /** The flat usage a chat reply draws: "$0" for none, or "30¢". */
      chatReplyFee: string;
      rolloverMonths: number;
    };
    ownKey: OwnKeySetup;
    /** Null without a plan, or where the host offers no auto top-up. */
    topUp: OwnerAutoTopUp | null;
    /** Purchases the host makes on the saved card, in the page, instead of Stripe Checkout. */
    inApp: { planChange: boolean; extraUsage: boolean };
    purchase: PurchaseView | null;
  });

/** An in-app plan change, before the Owner confirms it. */
type PlanChangeView =
  | {
    kind: 'upgrade'; key: string; price: string; included: string; today: string; added: string; from: string | null;
    /** Set while auto top-up's limit is "same as your plan": the limit it rises to. */
    limitRaise: string | null; card: string | null; consentVersion: string;
  }
  | { kind: 'downgrade'; key: string; price: string; at: string };

/**
 * The Plan page's API. It exists only where the host installed a billing
 * port for this installation; elsewhere every route is not found.
 */
export function createBillingAdminApi(options: BillingAdminApiOptions): Hono {
  const app = new Hono();

  app.use('/billing', noStore);
  app.use('/billing/*', noStore);

  const view = async (c: Context, port: PlatformBillingPort, installationId: string): Promise<BillingView> => {
    const summary = await port.summary(installationId);
    if (!isOwner(c)) return billingView(summary, null);
    const [agentNames, personNames, ownKey] = await Promise.all([
      options.agentNames(c), options.personNames(c), options.ownKeyFacts(c),
    ]);
    const inApp = { planChange: !!(port.previewPlanChange && port.changePlan), extraUsage: !!port.buyExtraUsage };
    return billingView(summary, { agentNames, personNames, ownKey, inApp });
  };

  /** A purchase on the saved card answers the fresh view, or the Stripe page that finishes it. */
  const purchased = async (c: Context, port: PlatformBillingPort, installationId: string, result: SavedCardResult) =>
    result.kind === 'redirect' ? redirect(c, result) : c.json({ billing: await view(c, port, installationId) });

  app.get('/billing', (c) => withBilling(c, async (port, installationId) =>
    c.json(await view(c, port, installationId))));

  app.post('/billing/funding', (c) => withOwnerBilling(c, async (port, installationId) => {
    const parsed = v.safeParse(fundingSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    if (parsed.output.funding === 'own_key') {
      const [summary, ownKey] = await Promise.all([port.summary(installationId), options.ownKeyFacts(c)]);
      const setup = ownKeySetup(summary, ownKeyMinimumPlan(summary), ownKey);
      if (summary.funding === 'platform' && !setup.planReady) return c.json({ error: 'own_key_plan_required' }, 409);
      if (summary.funding === 'platform' && !setup.key.ready) return c.json({ error: 'own_key_missing', provider: setup.key.provider }, 409);
    }
    await port.chooseFunding(installationId, parsed.output.funding);
    if (parsed.output.funding === 'platform') await options.choseChickpeaModels(c);
    return c.json(await view(c, port, installationId));
  }));

  app.post('/billing/checkout', (c) => withOwnerBilling(c, async (port, installationId) => {
    const parsed = v.safeParse(checkoutSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    return redirect(c, await port.checkout(installationId, parsed.output, PLAN_PATH));
  }));

  app.post('/billing/portal', (c) => withOwnerBilling(c, async (port, installationId) =>
    redirect(c, await port.portal(installationId, PLAN_PATH))));

  app.post('/billing/auto-top-up', (c) => withOwnerBilling(c, async (port, installationId) => {
    if (!port.updateAutoTopUp) return c.json({ error: 'not_found' }, 404);
    const parsed = v.safeParse(autoTopUpSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    const body = parsed.output;
    const summary = await port.summary(installationId);
    const current = summary.autoTopUp;
    if (!current || !summary.plan) return c.json({ error: 'plan_required' }, 409);
    let change: AutoTopUpChange = { kind: 'off' };
    let raises = false;
    if (body.change === 'on') {
      if (summary.pendingChange?.kind === 'ends') return c.json({ error: 'plan_required' }, 409);
      // Admin knows the pack "same as your plan" stands for only while it is the rule now.
      if (body.pack === 'plan' && current.pack.rule !== 'plan') return invalidRequest(c);
      const pack = extraUsageOffer(summary, body.pack === 'plan' ? current.pack.key : body.pack);
      const limitCents = body.limit === 'plan' ? summary.plan.priceCents : body.limit;
      if (!pack || pack.priceCents > limitCents) return invalidRequest(c);
      const before = extraUsageOffer(summary, current.pack.key);
      raises = !current.enabled || pack.priceCents > (before?.priceCents ?? 0) || limitCents > current.limit.cents;
      if (raises && body.consentVersion !== AUTO_TOP_UP_CONSENT_VERSION) return c.json({ error: 'consent_outdated' }, 409);
      change = {
        kind: 'on',
        pack: body.pack === 'plan' ? { rule: 'plan' } : { rule: 'fixed', key: body.pack },
        limit: body.limit === 'plan' ? { rule: 'plan' } : { rule: 'fixed', cents: body.limit },
      };
    } else {
      change = { kind: body.change };
    }
    await port.updateAutoTopUp(installationId, {
      change, by: await options.actor(c), consentVersion: raises ? AUTO_TOP_UP_CONSENT_VERSION : null,
    });
    return c.json(await view(c, port, installationId));
  }));

  app.post('/billing/plan-change/preview', (c) => withOwnerBilling(c, async (port, installationId) => {
    if (!port.previewPlanChange || !port.changePlan) return c.json({ error: 'not_found' }, 404);
    const parsed = v.safeParse(planChangeSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    const summary = await port.summary(installationId);
    const target = planChangeTarget(summary, parsed.output.key);
    if (!target) return invalidRequest(c);
    return c.json(planChangeView(summary, target, await port.previewPlanChange(installationId, target.key)));
  }));

  app.post('/billing/plan-change', (c) => withOwnerBilling(c, async (port, installationId) => {
    if (!port.previewPlanChange || !port.changePlan) return c.json({ error: 'not_found' }, 404);
    const parsed = v.safeParse(planChangeSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    const summary = await port.summary(installationId);
    const target = planChangeTarget(summary, parsed.output.key);
    if (!target) return invalidRequest(c);
    const raises = limitRaise(summary, target) !== null;
    if (raises && parsed.output.consentVersion !== AUTO_TOP_UP_CONSENT_VERSION) return c.json({ error: 'consent_outdated' }, 409);
    const result = await port.changePlan(installationId, {
      planKey: target.key, by: await options.actor(c), consentVersion: raises ? AUTO_TOP_UP_CONSENT_VERSION : null,
    });
    return purchased(c, port, installationId, result);
  }));

  app.post('/billing/extra-usage', (c) => withOwnerBilling(c, async (port, installationId) => {
    if (!port.buyExtraUsage) return c.json({ error: 'not_found' }, 404);
    const parsed = v.safeParse(extraUsageSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    const result = await port.buyExtraUsage(installationId, { key: parsed.output.key, by: await options.actor(c) });
    return purchased(c, port, installationId, result);
  }));

  return app;
}

function topUpPackPrice(summary: BillingSummary, plan: PlanOffer): string | null {
  const pack = plan.autoTopUpPackKey === undefined ? undefined : extraUsageOffer(summary, plan.autoTopUpPackKey);
  return pack ? formatPriceCents(pack.priceCents) : null;
}

function extraUsageOffer(summary: BillingSummary, key: string): ExtraUsageOffer | undefined {
  return summary.offers.extraUsage.find((offer) => offer.key === key);
}

/** The plans this installation's funding can move to, cheapest first. */
function fundingPlans(summary: BillingSummary): PlanOffer[] {
  return summary.offers.plans
    .filter((offer) => summary.funding === 'platform' || offer.ownKeyEligible)
    .toSorted((left, right) => left.priceCents - right.priceCents);
}

/** Another plan on sale for the same funding; an in-app change never switches funding. */
function planChangeTarget(summary: BillingSummary, key: string): PlanOffer | undefined {
  if (!summary.plan || summary.plan.key === key) return undefined;
  return fundingPlans(summary).find((offer) => offer.key === key);
}

/** The auto top-up limit an upgrade raises while the limit is "same as your plan"; null when it raises none. */
function limitRaise(summary: BillingSummary, target: PlanOffer): number | null {
  const topUp = summary.autoTopUp;
  const raises = topUp?.enabled && topUp.limit.rule === 'plan' && summary.plan && target.priceCents > summary.plan.priceCents;
  return raises ? target.priceCents : null;
}

function planChangeView(
  summary: BillingSummary,
  target: PlanOffer,
  preview: Awaited<ReturnType<NonNullable<PlatformBillingPort['previewPlanChange']>>>,
): PlanChangeView {
  const price = formatPriceCents(target.priceCents);
  if (preview.kind === 'downgrade') return { kind: 'downgrade', key: target.key, price, at: SHORT_DATE.format(preview.at) };
  const raise = limitRaise(summary, target);
  return {
    kind: 'upgrade',
    key: target.key,
    price,
    included: formatUsageDollars(target.includedMicros),
    today: formatPriceCents(preview.todayCents),
    added: formatUsageDollars(preview.addedMicros, 'down'),
    from: summary.period ? SHORT_DATE.format(summary.period.end) : null,
    limitRaise: raise === null ? null : formatPriceCents(raise),
    card: cardLabel(summary),
    consentVersion: AUTO_TOP_UP_CONSENT_VERSION,
  };
}

/** The saved card, from the auto top-up view; only digits pass, since the label lands in the page and Slack. */
function cardLabel(summary: BillingSummary): string | null {
  const card = summary.autoTopUp?.card;
  return card && /^\d{4}$/.test(card.last4) ? formatCard(card) : null;
}

/** The next pack would not fit under the limit this period. */
function topUpLimitReached(summary: BillingSummary): boolean {
  const topUp = summary.autoTopUp;
  const pack = topUp && extraUsageOffer(summary, topUp.pack.key);
  return !!topUp && !!pack && topUp.usedCents + pack.priceCents > topUp.limit.cents;
}

function autoTopUpStatus(summary: BillingSummary): BillingStatus['autoTopUp'] {
  const topUp = summary.autoTopUp;
  if (topUp === undefined) return null;
  if (!summary.plan) return { kind: 'no_plan' };
  if (topUp === null) return null;
  const on = topUp.enabled && summary.pendingChange?.kind !== 'ends';
  return { kind: 'plan', on, limitReached: on && topUpLimitReached(summary) };
}

function ownerAutoTopUp(summary: BillingSummary, planOffer: PlanOffer | undefined): OwnerAutoTopUp | null {
  const topUp = summary.autoTopUp;
  const pack = topUp && extraUsageOffer(summary, topUp.pack.key);
  if (!topUp || !summary.plan || !pack) return null;
  const ending = summary.pendingChange?.kind === 'ends';
  const next = fundingPlans(summary).find((offer) => offer.priceCents > (summary.plan?.priceCents ?? 0));
  const pause = topUp.pause;
  return {
    enabled: topUp.enabled && !ending,
    ending,
    pack: { rule: topUp.pack.rule, key: pack.key, price: formatPriceCents(pack.priceCents), cents: pack.priceCents },
    limit: { rule: topUp.limit.rule, amount: formatPriceCents(topUp.limit.cents), cents: topUp.limit.cents },
    used: formatPriceCents(topUp.usedCents),
    percent: topUp.limit.cents > 0 ? Math.min(100, Math.floor(topUp.usedCents * 100 / topUp.limit.cents)) : 0,
    resets: topUp.resetsAt && SHORT_DATE.format(topUp.resetsAt),
    limitReached: topUpLimitReached(summary),
    pause: !pause ? null
      : pause.kind === 'declined' ? { kind: 'declined', on: SHORT_DATE.format(pause.at) }
      : pause.kind === 'needs_confirmation'
        ? { kind: 'needs_confirmation', amount: formatPriceCents(pause.amountCents), url: isHttps(pause.url) ? pause.url : null }
      : { kind: pause.kind },
    card: cardLabel(summary),
    plan: { price: formatPriceCents(summary.plan.priceCents), cents: summary.plan.priceCents },
    packs: summary.offers.extraUsage.map((offer) => ({
      key: offer.key, price: formatPriceCents(offer.priceCents), cents: offer.priceCents,
      tasks: formatTasks(offer.usageMicros, summary.funding, summary.offers),
    })),
    upgrade: next ? {
      key: next.key,
      price: formatPriceCents(next.priceCents),
      included: formatUsageDollars(next.includedMicros),
      covered: formatUsageDollars(((planOffer?.includedMicros ?? 0) + topUp.usedCents * MICROS_PER_CENT) as UsageMicros),
    } : null,
    consentVersion: AUTO_TOP_UP_CONSENT_VERSION,
  };
}

function purchaseView(summary: BillingSummary): PurchaseView | null {
  const purchase = summary.lastPurchase;
  if (!purchase) return null;
  return purchase.kind === 'extra_usage'
    ? { kind: 'extra_usage', granted: purchase.granted, usage: formatUsageDollars(purchase.usageMicros) }
    : { kind: 'plan', granted: purchase.granted, first: purchase.first, added: formatUsageDollars(purchase.addedMicros, 'down') };
}

function billingView(summary: BillingSummary, owner: OwnerFacts | null): BillingView {
  const minimum = ownKeyMinimumPlan(summary);
  const status = billingStatus(summary, minimum);
  if (!owner) return { manage: false, ...status };
  const { offers } = summary;
  const planOffer = summary.plan ? offers.plans.find((offer) => offer.key === summary.plan?.key) : undefined;
  return {
    manage: true,
    ...status,
    period: summary.period && { start: SHORT_DATE.format(summary.period.start), end: SHORT_DATE.format(summary.period.end) },
    use: {
      byAgent: namedUse(summary.use.byAgent, owner.agentNames),
      byPerson: namedUse(summary.use.byPerson, owner.personNames).map(({ id: _id, ...row }) => row),
    },
    offers: {
      plans: offers.plans.map((offer) => ({
        key: offer.key,
        name: offer.name,
        price: formatPriceCents(offer.priceCents),
        included: formatUsageDollars(offer.includedMicros),
        ownKeyMinimum: offer.key === minimum.key,
        ownKeyEligible: offer.ownKeyEligible,
        topUpPack: topUpPackPrice(summary, offer),
        tasks: {
          platform: formatTasks(offer.includedMicros, 'platform', offers),
          ownKey: offer.ownKeyEligible ? formatTasks(offer.includedMicros, 'own_key', offers) : null,
        },
      })),
      extraUsage: offers.extraUsage.map((offer) => ({
        key: offer.key,
        price: formatPriceCents(offer.priceCents),
        usage: formatUsageDollars(offer.usageMicros),
        validMonths: offer.validMonths,
      })),
      bonusPercent: bonusPercent(offers.plans),
      chatReplyFee: formatFee(offers.chatReplyFeeMicros),
      rolloverMonths: offers.rolloverMonths,
    },
    ownKey: ownKeySetup(summary, minimum, owner.ownKey),
    topUp: ownerAutoTopUp(summary, planOffer),
    inApp: owner.inApp,
    purchase: purchaseView(summary),
  };
}

function billingStatus(summary: BillingSummary, minimum: PlanOffer): BillingStatus {
  const { funding, offers, planUsage, period, rollover, extraUsage, trial } = summary;
  const planOffer = summary.plan && offers.plans.find((offer) => offer.key === summary.plan?.key);
  const pending = summary.plan && summary.pendingChange;
  const ownKeyTasks = (micros: UsageMicros) => funding === 'own_key' ? formatTasks(micros, 'own_key', offers) : null;
  const trialUsed = Math.max(0, (trial?.grantedMicros ?? 0) - (trial?.remainingMicros ?? 0)) as UsageMicros;
  return {
    funding,
    plan: summary.plan && {
      key: summary.plan.key,
      name: summary.plan.name,
      price: formatPriceCents(summary.plan.priceCents),
      included: planOffer ? formatUsageDollars(planOffer.includedMicros) : null,
      tasks: planOffer ? formatTasks(planOffer.includedMicros, funding, offers) : null,
    },
    pendingChange: pending?.kind === 'ends' ? { kind: 'ends', on: SHORT_DATE.format(pending.at) }
      : pending?.kind === 'plan' ? { kind: 'plan', planName: pending.plan.name, on: SHORT_DATE.format(pending.at) }
      : null,
    meter: planUsage && period && {
      used: formatUsageDollars(planUsage.usedMicros, 'down'),
      included: formatUsageDollars(planUsage.includedMicros),
      percent: usagePercent(planUsage.usedMicros, planUsage.includedMicros),
      onPacePercent: planUsage.onPacePercent,
      resets: SHORT_DATE.format(period.end),
      tasksUsed: ownKeyTasks(planUsage.usedMicros),
      tasksIncluded: ownKeyTasks(planUsage.includedMicros),
    },
    rollover: rollover && rollover.remainingMicros > 0
      ? { remaining: formatUsageDollars(rollover.remainingMicros), until: SHORT_DATE.format(rollover.expiresAt) }
      : null,
    extraUsage: extraUsage && extraUsage.remainingMicros > 0
      ? {
        remaining: formatUsageDollars(extraUsage.remainingMicros),
        frozen: extraUsage.frozen,
        until: LONG_DATE.format(extraUsage.expiresAt),
        bar: extraUsageBar(extraUsage),
      }
      : null,
    trial: trial && {
      remaining: formatUsageDollars(trial.remainingMicros),
      granted: formatUsageDollars(trial.grantedMicros),
      used: formatUsageDollars(trialUsed, 'down'),
      percent: usagePercent(trialUsed, trial.grantedMicros),
      until: SHORT_DATE.format(trial.expiresAt),
    },
    ownKeyWithoutPlan: funding === 'own_key' && summary.plan === null
      ? { minimumPrice: formatPriceCents(minimum.priceCents), minimumTasks: formatTasks(minimum.includedMicros, 'own_key', offers) }
      : null,
    balance: funding === 'own_key' && summary.plan === null ? null : balance(summary, planOffer),
    autoTopUp: autoTopUpStatus(summary),
    taskFee: formatFee(offers.taskFeeMicros),
  };
}

/** The packs that still have usage left, and how much of them is used; the total is never below what remains. */
function extraUsageBar(extraUsage: NonNullable<BillingSummary['extraUsage']>): NonNullable<BillingStatus['extraUsage']>['bar'] {
  if (extraUsage.totalMicros === undefined) return null;
  const total = Math.max(extraUsage.totalMicros, extraUsage.remainingMicros) as UsageMicros;
  const used = (total - extraUsage.remainingMicros) as UsageMicros;
  return { used: formatUsageDollars(used, 'down'), total: formatUsageDollars(total), percent: usagePercent(used, total) };
}

/** The bonus every plan includes over its price, in whole percent; the smallest, so no plan promises more than it gives. */
function bonusPercent(plans: readonly PlanOffer[]): number {
  const bonuses = plans.map((offer) => Math.floor(offer.includedMicros * 100 / (offer.priceCents * MICROS_PER_CENT)) - 100);
  return Math.max(0, Math.min(...bonuses));
}

/** A fee under a dollar in cents, "30¢"; none as "$0". */
function formatFee(micros: UsageMicros): string {
  return micros > 0 && micros < 100 * MICROS_PER_CENT ? `${Math.round(micros / MICROS_PER_CENT)}¢` : formatUsageDollars(micros);
}

/** The port answered inconsistent data when the lowest plan for an own key is not on sale; `withBilling` makes that a 503. */
function ownKeyMinimumPlan(summary: BillingSummary): PlanOffer {
  const minimum = summary.offers.plans.find((offer) => offer.key === summary.offers.ownKeyMinimumPlanKey);
  if (!minimum) throw new Error('The billing summary names an own-key minimum plan it does not offer.');
  return minimum;
}

/** An own key needs a plan at or above the minimum, and a key for the default model's provider. */
function ownKeySetup(summary: BillingSummary, minimum: PlanOffer, facts: OwnKeyFacts): OwnKeySetup {
  const provider = keyProvider(facts.defaultModel) ?? null;
  const keyed = provider ? facts.savedKeys.has(provider) : facts.savedKeys.size > 0;
  return {
    planReady: summary.plan !== null && summary.plan.priceCents >= minimum.priceCents,
    minimumPlan: { key: minimum.key, price: formatPriceCents(minimum.priceCents) },
    key: keyed
      ? {
        ready: true,
        provider,
        agentsWithoutKey: facts.agents.flatMap((agent) => {
          const pinned = keyProvider(agent.model);
          return pinned && !facts.savedKeys.has(pinned) ? [agent.name] : [];
        }),
      }
      : { ready: false, provider },
  };
}

/** The key provider serving a `provider/model` value; undefined for one that takes no key. */
function keyProvider(model: string | undefined): ProviderKeyId | undefined {
  const provider = model ? /^([^/]+)\//.exec(model)?.[1] : undefined;
  return provider && isProviderKeyId(provider) ? provider : undefined;
}

/** Only an Owner's own session buys. */
function isOwner(c: Context): boolean {
  return isOwnerSession(requestPrincipal(c.req.raw));
}

async function withBilling(
  c: Context,
  handle: (port: PlatformBillingPort, installationId: string) => Promise<Response>,
): Promise<Response> {
  const port = platformBilling();
  if (!port) return c.json({ error: 'not_found' }, 404);
  try {
    const installationId = requireInstallationScope(c.env as PlatformEnv | undefined)?.installationId;
    if (!installationId) return c.json({ error: 'not_found' }, 404);
    return await handle(port, installationId);
  } catch (error) {
    if (error instanceof BillingRefusal) return c.json({ error: error.reason }, 409);
    console.warn(JSON.stringify({ component: 'platform_billing', event: 'billing_unavailable', path: c.req.path }));
    return c.json({ error: 'billing_unavailable' }, 503);
  }
}

function withOwnerBilling(
  c: Context,
  handle: (port: PlatformBillingPort, installationId: string) => Promise<Response>,
): Promise<Response> {
  return withBilling(c, async (port, installationId) =>
    isOwner(c) ? handle(port, installationId) : c.json({ error: 'forbidden' }, 403));
}

function isHttps(url: string): boolean {
  return URL.canParse(url) && new URL(url).protocol === 'https:';
}

/** The browser follows this URL, so only HTTPS gets through. */
function redirect(c: Context, target: { url: string }): Response {
  if (!isHttps(target.url)) {
    throw new Error('The billing port returned a URL that is not HTTPS.');
  }
  return c.json({ url: target.url });
}

/** Named rows, largest first, then one row gathering the rest; each bar is its share of the largest row. */
function namedUse(use: readonly UsageRow[], names: ReadonlyMap<string, string>): AgentUse[] {
  const named: { id: string | null; name: string | null; micros: number }[] = [];
  let unnamed = 0;
  for (const row of use) {
    const name = row.id === null ? undefined : names.get(row.id);
    if (name === undefined) unnamed += row.usageMicros;
    else named.push({ id: row.id, name, micros: row.usageMicros });
  }
  named.sort((left, right) => right.micros - left.micros);
  const rows = unnamed > 0 ? [...named, { id: null, name: null, micros: unnamed }] : named;
  const largest = Math.max(0, ...rows.map((row) => row.micros));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    used: formatUsageDollars(row.micros as UsageMicros),
    bar: largest > 0 ? Math.round(row.micros * 100 / largest) : 0,
  }));
}

// UTC, so a date reads the same here as in Chickpea's Slack messages about the plan.
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const LONG_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
