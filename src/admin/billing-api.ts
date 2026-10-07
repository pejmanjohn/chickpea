import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { requestPrincipal } from '../auth/service.ts';
import { requireInstallationScope } from '../config/installation-scope.ts';
import {
  platformBilling,
  type CreditsBillingSummary,
  type CreditUse,
  type PlatformBillingPort,
} from '../config/platform-billing.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { invalidRequest, readJson } from './api-support.ts';

export const PLAN_AND_CREDITS_PATH = '/admin/plan';

const MAX_BILLING_BODY_BYTES = 512;
const rateCardKey = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/));
const checkoutSchema = v.strictObject({ kind: v.picklist(['plan', 'top_up']), key: rateCardKey });

interface BillingAdminApiOptions {
  agentNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
  /** Display names keyed by Chickpea membership ID. */
  personNames: (c: Context) => Promise<ReadonlyMap<string, string>>;
}

/** One row of credit use; a null name gathers use with no Agent or person, or one with no name. */
interface NamedCreditUse {
  name: string | null;
  credits: number;
}

/**
 * What the Plan and credits page shows. Only an Owner can buy credits or
 * change the plan, so everyone else sees the balance alone.
 */
export type BillingView =
  | { funding: 'own_key' }
  | { funding: 'credits'; manage: false; balance: number }
  | {
    funding: 'credits';
    manage: true;
    balance: number;
    plan: CreditsBillingSummary['plan'];
    period: { start: string; end: string };
    use: { byAgent: NamedCreditUse[]; byPerson: NamedCreditUse[] };
    offers: CreditsBillingSummary['offers'];
  };

/**
 * The Plan and credits page's API. It exists only where the host installed a
 * billing port for this installation; elsewhere every route is not found.
 */
export function createBillingAdminApi(options: BillingAdminApiOptions): Hono {
  const app = new Hono();

  app.use('/billing', noStore);
  app.use('/billing/*', noStore);

  app.get('/billing', (c) => withBilling(c, async (port, installationId) => {
    const summary = await port.summary(installationId);
    if (summary.funding === 'own_key') return c.json({ funding: 'own_key' } satisfies BillingView);
    if (!isOwner(c)) return c.json({ funding: 'credits', manage: false, balance: summary.balance } satisfies BillingView);
    const [agentNames, personNames] = await Promise.all([options.agentNames(c), options.personNames(c)]);
    return c.json({
      funding: 'credits',
      manage: true,
      balance: summary.balance,
      plan: summary.plan,
      period: { start: summary.period.start.toISOString(), end: summary.period.end.toISOString() },
      use: {
        byAgent: namedUse(summary.use.byAgent, agentNames),
        byPerson: namedUse(summary.use.byPerson, personNames),
      },
      offers: summary.offers,
    } satisfies BillingView);
  }));

  app.post('/billing/checkout', (c) => withOwnerBilling(c, async (port, installationId) => {
    const parsed = v.safeParse(checkoutSchema, await readJson(c, MAX_BILLING_BODY_BYTES));
    if (!parsed.success) return invalidRequest(c);
    return redirect(c, await port.checkout(installationId, parsed.output, PLAN_AND_CREDITS_PATH));
  }));

  app.post('/billing/portal', (c) => withOwnerBilling(c, async (port, installationId) =>
    redirect(c, await port.portal(installationId, PLAN_AND_CREDITS_PATH))));

  return app;
}

/** Whether the request is an Owner's own session: only Owners buy credits. */
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

function namedUse(use: readonly CreditUse[], names: ReadonlyMap<string, string>): NamedCreditUse[] {
  const named: NamedCreditUse[] = [];
  let unnamed = 0;
  for (const row of use) {
    const name = row.id === null ? undefined : names.get(row.id);
    if (name === undefined) unnamed += row.credits;
    else named.push({ name, credits: row.credits });
  }
  named.sort((left, right) => right.credits - left.credits);
  return unnamed > 0 ? [...named, { name: null, credits: unnamed }] : named;
}

async function noStore(c: Context, next: () => Promise<void>): Promise<void> {
  c.header('Cache-Control', 'no-store');
  await next();
}
