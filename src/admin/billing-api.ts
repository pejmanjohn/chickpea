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
  type UsageRow,
} from '../config/platform-billing.ts';
import { isProviderKeyId, type ProviderKeyId } from '../config/provider-keys.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { formatPriceCents, formatUsageDollars, usagePercent, type UsageMicros } from '../usage/usage-display.ts';
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
  planName: string | null;
  /** Null without a plan period, which a plan can lack until its next subscription event. */
  meter: { used: string; included: string; percent: number; onPacePercent: number | null; resets: string } | null;
  /** Null when nothing carried over. */
  rollover: string | null;
  extraUsage: { remaining: string; frozen: boolean; until: string } | null;
  trial: { remaining: string; until: string } | null;
  /** Own key with no plan: the price of the lowest plan an own key needs. */
  ownKeyWithoutPlan: { minimumPrice: string } | null;
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
    if (!isOwner(c)) return billingView(summary, null);
    const [agentNames, personNames, ownKey] = await Promise.all([
      options.agentNames(c), options.personNames(c), options.ownKeyFacts(c),
    ]);
    return billingView(summary, { agentNames, personNames, ownKey });
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

function billingView(summary: BillingSummary, owner: OwnerFacts | null): BillingView {
  const minimum = ownKeyMinimumPlan(summary);
  const status = billingStatus(summary, minimum);
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

function billingStatus(summary: BillingSummary, minimum: PlanOffer): BillingStatus {
  const { planUsage, period, rollover, extraUsage, trial } = summary;
  return {
    funding: summary.funding,
    planName: summary.plan?.name ?? null,
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
      ? { minimumPrice: formatPriceCents(minimum.priceCents) }
      : null,
  };
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

async function noStore(c: Context, next: () => Promise<void>): Promise<void> {
  c.header('Cache-Control', 'no-store');
  await next();
}
