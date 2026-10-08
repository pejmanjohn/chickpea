import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { requestPrincipal } from '../auth/service.ts';
import { requireInstallationScope } from '../config/installation-scope.ts';
import {
  platformBilling,
  type BillingFunding,
  type BillingSummary,
  type PlanOffer,
  type PlatformBillingPort,
  type UsageMicros,
  type UsageRow,
} from '../config/platform-billing.ts';
import { isProviderKeyId, type ProviderKeyId } from '../config/provider-keys.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { invalidRequest, readJson } from './api-support.ts';

export const PLAN_PATH = '/admin/plan';

const MAX_BILLING_BODY_BYTES = 512;
const rateCardKey = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/));
const checkoutSchema = v.strictObject({ kind: v.picklist(['plan', 'extra_usage']), key: rateCardKey });
const fundingSchema = v.strictObject({ funding: v.picklist(['platform', 'own_key']) });

interface BillingAdminApiOptions {
  agentNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
  /** Display names keyed by Chickpea membership ID. */
  personNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
  ownKeyFacts: (c: Context) => Promise<OwnKeyFacts>;
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
}

/** One row of use; a null name gathers use with no Agent or person, or one with no name. */
interface NamedUse {
  name: string | null;
  used: string;
}

/** What everyone sees. Amounts are formatted dollars; dates are formatted UTC days, "Nov 7" or "Oct 7, 2027". */
interface BillingStatus {
  funding: BillingFunding;
  /** Null without a plan period. */
  meter: { used: string; included: string; percent: number; onPacePercent: number | null; resets: string } | null;
  /** Null when nothing carried over. */
  rollover: string | null;
  extraUsage: { remaining: string; frozen: boolean; until: string } | null;
  trial: { remaining: string; until: string } | null;
  /** Own key with no plan: when Chickpea charges begin, and the lowest plan price for an own key. */
  ownKeyWithoutPlan:
    | { charges: 'not_yet'; minimumPrice: string } // no grace date set
    | { charges: 'from'; from: string; minimumPrice: string } // grace date in the future, long format
    | { charges: 'due'; minimumPrice: string } // grace date passed
    | null;
}

/** Whether an Owner can switch funding from the page, and what is missing when not. */
export type FundingSwitch =
  | { to: 'platform' }
  | { to: 'own_key'; ready: true; agentsWithoutKey: string[] }
  | { to: 'own_key'; ready: false; needs: 'plan'; minimumPlan: { key: string; price: string } }
  | { to: 'own_key'; ready: false; needs: 'key'; provider: ProviderKeyId | null };

/**
 * What the Plan page shows. Only an Owner can buy, change the plan, or switch
 * funding, so everyone else sees the status alone.
 */
export type BillingView =
  | ({ manage: false } & BillingStatus)
  | ({ manage: true } & BillingStatus & {
    plan: { key: string; name: string; price: string; included: string | null } | null;
    period: { start: string; end: string } | null;
    use: { byAgent: NamedUse[]; byPerson: NamedUse[] };
    offers: {
      plans: { key: string; name: string; price: string; included: string; ownKeyMinimum: boolean; ownKeyEligible: boolean }[];
      extraUsage: { key: string; price: string; usage: string; validMonths: number }[];
    };
    switchFunding: FundingSwitch;
  });

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
    if (!isOwner(c)) return billingView(summary, null, new Date());
    const [agentNames, personNames, ownKey] = await Promise.all([
      options.agentNames(c), options.personNames(c), options.ownKeyFacts(c),
    ]);
    return billingView(summary, { agentNames, personNames, ownKey }, new Date());
  };

  app.get('/billing', (c) => withBilling(c, async (port, installationId) =>
    c.json(await view(c, port, installationId))));

  app.post('/billing/funding', (c) => withOwnerBilling(c, async (port, installationId) => {
    const parsed = v.safeParse(fundingSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    if (parsed.output.funding === 'own_key') {
      const [summary, ownKey] = await Promise.all([port.summary(installationId), options.ownKeyFacts(c)]);
      const next = fundingSwitch(summary, ownKeyMinimumPlan(summary), ownKey);
      if (next.to === 'own_key' && !next.ready) {
        return next.needs === 'plan'
          ? c.json({ error: 'own_key_plan_required' }, 409)
          : c.json({ error: 'own_key_missing', provider: next.provider }, 409);
      }
    }
    await port.chooseFunding(installationId, parsed.output.funding);
    return c.json(await view(c, port, installationId));
  }));

  app.post('/billing/checkout', (c) => withOwnerBilling(c, async (port, installationId) => {
    const parsed = v.safeParse(checkoutSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    return redirect(c, await port.checkout(installationId, parsed.output, PLAN_PATH));
  }));

  app.post('/billing/portal', (c) => withOwnerBilling(c, async (port, installationId) =>
    redirect(c, await port.portal(installationId, PLAN_PATH))));

  return app;
}

function billingView(summary: BillingSummary, owner: OwnerFacts | null, now: Date): BillingView {
  const minimum = ownKeyMinimumPlan(summary);
  const status = billingStatus(summary, minimum, now);
  if (!owner) return { manage: false, ...status };
  const planOffer = summary.plan && summary.offers.plans.find((offer) => offer.key === summary.plan?.key);
  return {
    manage: true,
    ...status,
    plan: summary.plan && {
      key: summary.plan.key,
      name: summary.plan.name,
      price: formatPriceCents(summary.plan.priceCents),
      included: planOffer ? formatUsageDollars(planOffer.includedMicros) : null,
    },
    period: summary.period && { start: SHORT_DATE.format(summary.period.start), end: SHORT_DATE.format(summary.period.end) },
    use: {
      byAgent: namedUse(summary.use.byAgent, owner.agentNames),
      byPerson: namedUse(summary.use.byPerson, owner.personNames),
    },
    offers: {
      plans: summary.offers.plans.map((offer) => ({
        key: offer.key,
        name: offer.name,
        price: formatPriceCents(offer.priceCents),
        included: formatUsageDollars(offer.includedMicros),
        ownKeyMinimum: offer.key === minimum.key,
        ownKeyEligible: offer.ownKeyEligible,
      })),
      extraUsage: summary.offers.extraUsage.map((offer) => ({
        key: offer.key,
        price: formatPriceCents(offer.priceCents),
        usage: formatUsageDollars(offer.usageMicros),
        validMonths: offer.validMonths,
      })),
    },
    switchFunding: fundingSwitch(summary, minimum, owner.ownKey),
  };
}

function billingStatus(summary: BillingSummary, minimum: PlanOffer, now: Date): BillingStatus {
  const { planUsage, period, rollover, extraUsage, trial } = summary;
  return {
    funding: summary.funding,
    meter: planUsage && period && {
      used: formatUsageDollars(planUsage.usedMicros, 'down'),
      included: formatUsageDollars(planUsage.includedMicros),
      percent: usagePercent(planUsage.usedMicros, planUsage.includedMicros),
      onPacePercent: planUsage.onPacePercent,
      resets: SHORT_DATE.format(period.end),
    },
    rollover: rollover && rollover.remainingMicros > 0 ? formatUsageDollars(rollover.remainingMicros) : null,
    extraUsage: extraUsage && extraUsage.remainingMicros > 0
      ? { remaining: formatUsageDollars(extraUsage.remainingMicros), frozen: extraUsage.frozen, until: LONG_DATE.format(extraUsage.expiresAt) }
      : null,
    trial: trial && { remaining: formatUsageDollars(trial.remainingMicros), until: SHORT_DATE.format(trial.expiresAt) },
    ownKeyWithoutPlan: summary.funding === 'own_key' && summary.plan === null
      ? ownKeyCharges(summary.ownKeyGraceUntil, formatPriceCents(minimum.priceCents), now)
      : null,
  };
}

function ownKeyCharges(graceUntil: Date | null, minimumPrice: string, now: Date): NonNullable<BillingStatus['ownKeyWithoutPlan']> {
  if (!graceUntil) return { charges: 'not_yet', minimumPrice };
  return graceUntil > now ? { charges: 'from', from: LONG_DATE.format(graceUntil), minimumPrice } : { charges: 'due', minimumPrice };
}

/** The port answered inconsistent data when the lowest plan for an own key is not on sale; `withBilling` makes that a 503. */
function ownKeyMinimumPlan(summary: BillingSummary): PlanOffer {
  const minimum = summary.offers.plans.find((offer) => offer.key === summary.offers.ownKeyMinimumPlanKey);
  if (!minimum) throw new Error('The billing summary names an own-key minimum plan it does not offer.');
  return minimum;
}

/** An own key needs a plan at or above the minimum first, then a key for the default model's provider. */
function fundingSwitch(summary: BillingSummary, minimum: PlanOffer, ownKey: OwnKeyFacts): FundingSwitch {
  if (summary.funding === 'own_key') return { to: 'platform' };
  if (!summary.plan || summary.plan.priceCents < minimum.priceCents) {
    return { to: 'own_key', ready: false, needs: 'plan', minimumPlan: { key: minimum.key, price: formatPriceCents(minimum.priceCents) } };
  }
  return ownKeyReadiness(ownKey);
}

/**
 * Not ready without a key for the default model's provider, which `provider`
 * names (null when no default model is chosen and no key is saved). Agents
 * pinned to a provider with no saved key would stop replying.
 */
function ownKeyReadiness(facts: OwnKeyFacts): FundingSwitch {
  const provider = keyProvider(facts.defaultModel);
  const keyed = provider ? facts.savedKeys.has(provider) : facts.savedKeys.size > 0;
  if (!keyed) return { to: 'own_key', ready: false, needs: 'key', provider: provider ?? null };
  return {
    to: 'own_key',
    ready: true,
    agentsWithoutKey: facts.agents.flatMap((agent) => {
      const pinned = keyProvider(agent.model);
      return pinned && !facts.savedKeys.has(pinned) ? [agent.name] : [];
    }),
  };
}

/** The key provider serving a `provider/model` value; undefined for one that takes no key. */
function keyProvider(model: string | undefined): ProviderKeyId | undefined {
  const provider = model ? /^([^/]+)\//.exec(model)?.[1] : undefined;
  return provider && isProviderKeyId(provider) ? provider : undefined;
}

/** Whether the request is an Owner's own session: only Owners buy. */
function isOwner(c: Context): boolean {
  const principal = requestPrincipal(c.req.raw);
  return Boolean(principal && !principal.machine && principal.role === 'owner');
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
  } catch {
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

/** The browser follows this URL, so only HTTPS gets through. */
function redirect(c: Context, target: { url: string }): Response {
  if (!URL.canParse(target.url) || new URL(target.url).protocol !== 'https:') {
    throw new Error('The billing port returned a URL that is not HTTPS.');
  }
  return c.json({ url: target.url });
}

function namedUse(use: readonly UsageRow[], names: ReadonlyMap<string, string>): NamedUse[] {
  const named: { name: string; micros: number }[] = [];
  let unnamed = 0;
  for (const row of use) {
    const name = row.id === null ? undefined : names.get(row.id);
    if (name === undefined) unnamed += row.usageMicros;
    else named.push({ name, micros: row.usageMicros });
  }
  named.sort((left, right) => right.micros - left.micros);
  const rows = unnamed > 0 ? [...named, { name: null, micros: unnamed }] : named;
  return rows.map((row) => ({ name: row.name, used: formatUsageDollars(row.micros as UsageMicros) }));
}

// UTC, so a date reads the same here as in Chickpea's Slack messages about the plan.
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const LONG_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

// Same signatures as src/usage/usage-display.ts, which replaces these once it is on main.
const MICROS_PER_CENT = 10_000;
const WHOLE_DOLLARS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `down` is for an amount used beside a percent, so the two never disagree at the plan's edge. */
function formatUsageDollars(micros: UsageMicros, rounding: 'half_up' | 'down' = 'half_up'): string {
  const half = rounding === 'half_up' ? MICROS_PER_CENT / 2 : 0;
  const cents = Math.floor((Math.abs(micros) + half) / MICROS_PER_CENT);
  return formatPriceCents(micros < 0 ? -cents : cents);
}

function formatPriceCents(cents: number): string {
  const magnitude = Math.abs(cents);
  const dollars = WHOLE_DOLLARS.format(Math.floor(magnitude / 100));
  const remainder = magnitude % 100;
  const amount = remainder === 0 ? `$${dollars}` : `$${dollars}.${String(remainder).padStart(2, '0')}`;
  return cents < 0 ? `-${amount}` : amount;
}

function usagePercent(used: UsageMicros, included: UsageMicros): number {
  return included > 0 ? Math.floor(used * 100 / included) : 0;
}

async function noStore(c: Context, next: () => Promise<void>): Promise<void> {
  c.header('Cache-Control', 'no-store');
  await next();
}
