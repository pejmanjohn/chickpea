import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { isOwnerSession } from '../auth/permissions.ts';
import { requestPrincipal } from '../auth/service.ts';
import { requireInstallationScope } from '../config/installation-scope.ts';
import {
  BillingRefusal,
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
import { invalidRequest, noStore, readJson } from './api-support.ts';
import { formatTasks } from './billing-tasks.ts';

export const PLAN_PATH = '/admin/plan';

const MAX_BILLING_BODY_BYTES = 512;
const MICROS_PER_CENT = 10_000;
const rateCardKey = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/));
const checkoutSchema = v.strictObject({ kind: v.picklist(['plan', 'extra_usage']), key: rateCardKey });
const fundingSchema = v.strictObject({ funding: v.picklist(['platform', 'own_key']) });

interface BillingAdminApiOptions {
  agentNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
  /** Display names keyed by Chickpea membership ID. */
  personNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
  ownKeyFacts: (c: Context) => Promise<OwnKeyFacts>;
  /** After an Owner switches to Chickpea's models, sets what onboarding sets with them. */
  choseChickpeaModels: (c: Context) => Promise<void>;
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
  /** `included` and `tasks` are null for a plan no longer on sale. */
  plan: { key: string; name: string; price: string; included: string | null; tasks: string | null } | null;
  /** Null when the plan renews unchanged, or there is no plan. */
  pendingChange: { kind: 'ends'; on: string } | { kind: 'plan'; planName: string; on: string } | null;
  /** Null without a plan period, which a plan can lack until its next subscription event. Task counts are for an own key only. */
  meter: {
    used: string; included: string; percent: number; onPacePercent: number | null; resets: string;
    tasksUsed: string | null; tasksIncluded: string | null;
  } | null;
  /** Null when nothing carried over. */
  rollover: { remaining: string; until: string } | null;
  extraUsage: { remaining: string; frozen: boolean; until: string } | null;
  trial: { remaining: string; granted: string; used: string; percent: number; until: string } | null;
  ownKeyWithoutPlan: { minimumPrice: string; minimumTasks: string } | null;
  /** What the workspace can spend now, and the tasks it covers; null for an own key without a plan. */
  balance: { left: string; tasksLeft: string; exhausted: boolean } | null;
  /** The flat usage a task draws, "30¢". */
  taskFee: string;
}

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
        /** Tasks the plan covers each month; `ownKey` is null for a plan an own key cannot choose. */
        tasks: { platform: string; ownKey: string | null };
      }[];
      extraUsage: { key: string; price: string; usage: string; validMonths: number }[];
      /** How much more usage than its price every plan includes, in percent. */
      bonusPercent: number;
      /** The flat usage a chat reply draws: "$0" for none, or "30¢". */
      chatReplyFee: string;
      rolloverMonths: number;
    };
    ownKey: OwnKeySetup;
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

  return app;
}

function billingView(summary: BillingSummary, owner: OwnerFacts | null): BillingView {
  const minimum = ownKeyMinimumPlan(summary);
  const status = billingStatus(summary, minimum);
  if (!owner) return { manage: false, ...status };
  const { offers } = summary;
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
  };
}

function billingStatus(summary: BillingSummary, minimum: PlanOffer): BillingStatus {
  const { funding, offers, planUsage, period, rollover, extraUsage, trial } = summary;
  const planOffer = summary.plan && offers.plans.find((offer) => offer.key === summary.plan?.key);
  const pending = summary.plan && summary.pendingChange;
  const ownKeyTasks = (micros: UsageMicros) => funding === 'own_key' ? formatTasks(micros, 'own_key', offers) : null;
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
      ? { remaining: formatUsageDollars(extraUsage.remainingMicros), frozen: extraUsage.frozen, until: LONG_DATE.format(extraUsage.expiresAt) }
      : null,
    trial: trial && {
      remaining: formatUsageDollars(trial.remainingMicros),
      granted: formatUsageDollars(trial.grantedMicros),
      used: formatUsageDollars(Math.max(0, trial.grantedMicros - trial.remainingMicros) as UsageMicros, 'down'),
      percent: usagePercent(Math.max(0, trial.grantedMicros - trial.remainingMicros) as UsageMicros, trial.grantedMicros),
      until: SHORT_DATE.format(trial.expiresAt),
    },
    ownKeyWithoutPlan: funding === 'own_key' && summary.plan === null
      ? { minimumPrice: formatPriceCents(minimum.priceCents), minimumTasks: formatTasks(minimum.includedMicros, 'own_key', offers) }
      : null,
    balance: funding === 'own_key' && summary.plan === null ? null : balance(summary, planOffer),
    taskFee: formatFee(offers.taskFeeMicros),
  };
}

/**
 * What the workspace can spend now, as the host counts it: what is left of
 * the plan's usage, what carried over, extra usage a plan unfreezes, and any
 * trial usage, less what the workspace owes. A plan with no meter yet counts
 * its whole usage.
 */
function balance(summary: BillingSummary, planOffer: PlanOffer | null | undefined): NonNullable<BillingStatus['balance']> {
  const { planUsage, rollover, extraUsage, trial } = summary;
  const plan = !summary.plan ? 0
    : planUsage ? Math.max(0, planUsage.includedMicros - planUsage.usedMicros)
    : planOffer?.includedMicros ?? 0;
  const spendable = plan + (rollover?.remainingMicros ?? 0) + (extraUsage && !extraUsage.frozen ? extraUsage.remainingMicros : 0) +
    (trial?.remainingMicros ?? 0) - summary.debtMicros;
  const left = Math.max(0, spendable) as UsageMicros;
  return { left: formatUsageDollars(left, 'down'), tasksLeft: formatTasks(left, summary.funding, summary.offers), exhausted: left === 0 };
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

/** The browser follows this URL, so only HTTPS gets through. */
function redirect(c: Context, target: { url: string }): Response {
  if (!URL.canParse(target.url) || new URL(target.url).protocol !== 'https:') {
    throw new Error('The billing port returned a URL that is not HTTPS.');
  }
  return c.json({ url: target.url });
}

/** Named rows, largest first, then one row gathering the rest; each bar is its share of the largest row. */
function namedUse(use: readonly UsageRow[], names: ReadonlyMap<string, string>): (NamedUse & { id: string | null })[] {
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
