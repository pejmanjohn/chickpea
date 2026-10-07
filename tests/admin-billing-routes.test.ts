import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformBilling,
  type BillingSummary,
  type CheckoutRequest,
  type PlatformBillingPort,
} from '../src/config/platform-billing.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'billing-admin-token';
const INSTALLATION = 'inst_billing';
const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>, { installationId: INSTALLATION });

const CREDITS: BillingSummary = {
  funding: 'credits',
  balance: 48_210,
  plan: { key: 'starter', name: 'Starter' },
  period: { start: new Date('2026-10-07T17:00:00Z'), end: new Date('2026-11-07T17:00:00Z') },
  use: {
    byAgent: [{ id: 'agent_gone', credits: 5 }, { id: 'agent_chickpea', credits: 30 }, { id: null, credits: 2 }],
    byPerson: [{ id: 'membership_maya', credits: 31 }, { id: 'membership_unknown', credits: 6 }],
  },
  offers: {
    plans: [{ key: 'starter', name: 'Starter', priceCents: 5_000, credits: 50_000 }],
    topUps: [{ key: 'top_up_10', priceCents: 1_000, credits: 10_000, validMonths: 12 }],
  },
};

function principal(role: AuthPrincipal['role'], machine = false): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_billing', role,
    authenticatorKind: machine ? 'personal_token' : 'test_slack_session', credentialId: `credential_${role}`,
    correlationId: `request_${role}`, machine,
  };
}

function fakePort(summary: BillingSummary, overrides: Partial<PlatformBillingPort> = {}) {
  const calls: unknown[][] = [];
  const port: PlatformBillingPort = {
    async summary(installationId) { calls.push(['summary', installationId]); return summary; },
    async checkout(installationId, request: CheckoutRequest, returnPath) {
      calls.push(['checkout', installationId, request, returnPath]);
      return { url: 'https://checkout.stripe.com/c/pay/cs_test_billing' };
    },
    async portal(installationId, returnPath) {
      calls.push(['portal', installationId, returnPath]);
      return { url: 'https://billing.stripe.com/p/session/test_billing' };
    },
    async chooseFunding(installationId, funding) { calls.push(['chooseFunding', installationId, funding]); },
    ...overrides,
  };
  return { port, calls };
}

const people = {
  listMemberships: async () => [{ id: 'membership_maya', userId: 'user_maya' }],
  getUser: async (id: string) => (id === 'user_maya' ? { id, displayName: 'Maya Chen' } : undefined),
  recordAuthAudit: async () => undefined,
} as unknown as IdentityStore;

function admin(t: TestContext, options: { role?: AuthPrincipal['role']; machine?: boolean; env?: Record<string, unknown>; port?: PlatformBillingPort }) {
  configurePlatformBilling(options.port);
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => { configurePlatformBilling(undefined); config.close(); settings.close(); usage.close(); });
  const app = createAdminRoutes({
    store: config, settings, usage,
    ...testAdminAuthority(TOKEN, undefined, people, principal(options.role ?? 'owner', options.machine)),
  });
  return (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { ...testAdminHeaders(TOKEN), 'content-type': 'application/json', ...init.headers },
  }, options.env ?? HOSTED);
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

test('standalone has no billing: the API is not found and the page offers nothing, even with a port installed', async (t) => {
  const { port, calls } = fakePort(CREDITS);
  const request = admin(t, { port, env: {} });
  assert.equal((await request('/admin/api/billing')).status, 404);
  assert.equal((await request('/admin/api/billing/checkout', post({ kind: 'top_up', key: 'top_up_10' }))).status, 404);
  assert.match(await (await request('/admin')).text(), /"billingOffered":false/);
  assert.deepEqual(calls, []);
});

test('a hosted installation whose host installed no port has no billing', async (t) => {
  const request = admin(t, {});
  assert.equal((await request('/admin/api/billing')).status, 404);
  assert.equal((await request('/admin/api/billing/portal', post({}))).status, 404);
  assert.match(await (await request('/admin')).text(), /"billingOffered":false/);
});

test('an installation on its own key reads only that it is on its own key', async (t) => {
  const { port } = fakePort({ funding: 'own_key' });
  const request = admin(t, { port });
  assert.deepEqual(await (await request('/admin/api/billing')).json(), { funding: 'own_key' });
  assert.match(await (await request('/admin')).text(), /"billingOffered":true/);
});

test('an Owner reads the balance, plan, period and named use; unnamed use folds into one last row', async (t) => {
  const { port, calls } = fakePort(CREDITS);
  const response = await admin(t, { port })('/admin/api/billing');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    funding: 'credits',
    manage: true,
    balance: 48_210,
    plan: { key: 'starter', name: 'Starter' },
    period: { start: '2026-10-07T17:00:00.000Z', end: '2026-11-07T17:00:00.000Z' },
    use: {
      byAgent: [{ name: 'Chickpea', credits: 30 }, { name: null, credits: 7 }],
      byPerson: [{ name: 'Maya Chen', credits: 31 }, { name: null, credits: 6 }],
    },
    offers: CREDITS.offers,
  });
  assert.deepEqual(calls, [['summary', INSTALLATION]]);
});

test('Top up, Change plan and Manage billing each call the port and return its Stripe URL', async (t) => {
  const { port, calls } = fakePort(CREDITS);
  const request = admin(t, { port });
  assert.deepEqual(await (await request('/admin/api/billing/checkout', post({ kind: 'top_up', key: 'top_up_10' }))).json(),
    { url: 'https://checkout.stripe.com/c/pay/cs_test_billing' });
  assert.deepEqual(await (await request('/admin/api/billing/checkout', post({ kind: 'plan', key: 'team' }))).json(),
    { url: 'https://checkout.stripe.com/c/pay/cs_test_billing' });
  assert.deepEqual(await (await request('/admin/api/billing/portal', post({}))).json(),
    { url: 'https://billing.stripe.com/p/session/test_billing' });
  assert.deepEqual(calls, [
    ['checkout', INSTALLATION, { kind: 'top_up', key: 'top_up_10' }, '/admin/plan'],
    ['checkout', INSTALLATION, { kind: 'plan', key: 'team' }, '/admin/plan'],
    ['portal', INSTALLATION, '/admin/plan'],
  ]);
});

test('a malformed purchase is refused before the port is asked', async (t) => {
  const { port, calls } = fakePort(CREDITS);
  const request = admin(t, { port });
  for (const body of [{ kind: 'gift', key: 'top_up_10' }, { kind: 'plan', key: 'Team!' }, { kind: 'plan' }, { kind: 'plan', key: 'team', price: 1 }]) {
    assert.equal((await request('/admin/api/billing/checkout', post(body))).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test('a port that fails, or answers with a URL that is not HTTPS, is unavailable', async (t) => {
  const failing = admin(t, { port: fakePort(CREDITS, { summary: async () => { throw new Error('ledger down'); } }).port });
  assert.equal((await failing('/admin/api/billing')).status, 503);
  const plainHttp = admin(t, { port: fakePort(CREDITS, { portal: async () => ({ url: 'http://billing.example/p' }) }).port });
  const refused = await plainHttp('/admin/api/billing/portal', post({}));
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: 'billing_unavailable' });
  const script = admin(t, { port: fakePort(CREDITS, { checkout: async () => ({ url: 'javascript:alert(1)' }) }).port });
  assert.equal((await script('/admin/api/billing/checkout', post({ kind: 'top_up', key: 'top_up_10' }))).status, 503);
});

for (const role of ['member', 'admin'] as const) {
  test(`a${role === 'admin' ? 'n Admin' : ' Member'} sees the balance alone and cannot buy`, async (t) => {
    const { port, calls } = fakePort(CREDITS);
    const request = admin(t, { role, port });
    assert.deepEqual(await (await request('/admin/api/billing')).json(), { funding: 'credits', manage: false, balance: 48_210 });
    assert.equal((await request('/admin/plan')).status, 200);
    assert.equal((await request('/admin/api/billing/checkout', post({ kind: 'top_up', key: 'top_up_10' }))).status, 403);
    assert.equal((await request('/admin/api/billing/portal', post({}))).status, 403);
    assert.deepEqual(calls.filter(([name]) => name !== 'summary'), []);
  });
}

test('an Owner\'s personal token is not an Owner\'s own session: no use, no purchases', async (t) => {
  const { port, calls } = fakePort(CREDITS);
  const request = admin(t, { port, machine: true });
  assert.deepEqual(await (await request('/admin/api/billing')).json(), { funding: 'credits', manage: false, balance: 48_210 });
  assert.equal((await request('/admin/api/billing/portal', post({}))).status, 403);
  assert.deepEqual(calls.filter(([name]) => name !== 'summary'), []);
});
