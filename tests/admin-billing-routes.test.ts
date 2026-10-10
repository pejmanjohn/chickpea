import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { OPENAI_API_IMAGE_DEFAULT_MODEL_ID } from '../src/config/initial-image-default.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { rotateInstallationModelCredential } from '../src/config/model-credential-refs.ts';
import {
  BillingRefusal,
  configurePlatformBilling,
  type BillingSummary,
  type CheckoutRequest,
  type PlatformBillingPort,
} from '../src/config/platform-billing.ts';
import { configurePlatformFunding, resetPlatformFundingForTests } from '../src/config/platform-funding.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';
import { NO_PLAN, OWN_KEY_NO_PLAN, PERIOD, PLAN_NO_PERIOD, STARTER_PLAN, TEAM_DOWNGRADING, TEAM_ENDING, TEAM_PLAN, usd } from './helpers/billing-summaries.ts';

const TOKEN = 'billing-admin-token';
const INSTALLATION = 'inst_billing';
const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>, { installationId: INSTALLATION });

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

function admin(t: TestContext, options: {
  role?: AuthPrincipal['role']; machine?: boolean; env?: Record<string, unknown>; port?: PlatformBillingPort;
  anthropicKeySaved?: boolean; openaiKeySaved?: boolean; config?: SqliteConfigStore;
}) {
  configurePlatformBilling(options.port);
  const config = options.config ?? new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => { configurePlatformBilling(undefined); config.close(); settings.close(); usage.close(); });
  const app = createAdminRoutes({
    store: config, settings, usage,
    ...testAdminAuthority(TOKEN, undefined, people, principal(options.role ?? 'owner', options.machine)),
  });
  const keyring = options.anthropicKeySaved || options.openaiKeySaved ? useDeploymentKeyring(t) : undefined;
  const save = (provider: 'anthropic' | 'openai', apiKey: string) => rotateInstallationModelCredential(
    provider, { kind: 'save', apiKey }, { env: options.env ?? HOSTED, settings, usage, keyring: keyring! });
  const keySaved = Promise.all([
    options.anthropicKeySaved ? save('anthropic', 'sk-ant-billing-own-key') : undefined,
    options.openaiKeySaved ? save('openai', 'sk-openai-billing-own-key') : undefined,
  ]);
  return async (path: string, init: RequestInit = {}) => {
    await keySaved;
    return app.request(path, {
      ...init,
      headers: { ...testAdminHeaders(TOKEN), 'content-type': 'application/json', ...init.headers },
    }, options.env ?? HOSTED);
  };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

const TEAM_STATUS = {
  funding: 'platform',
  planName: 'Team',
  meter: { used: '$128', included: '$240', percent: 53, onPacePercent: 80, resets: 'Nov 7' },
  rollover: '$20',
  extraUsage: { remaining: '$40', frozen: false, until: 'Sep 14, 2027' },
  trial: null,
  ownKeyWithoutPlan: null,
};

test('standalone has no billing: the API is not found and the page offers nothing, even with a port installed', async (t) => {
  const { port, calls } = fakePort(TEAM_PLAN);
  const request = admin(t, { port, env: {} });
  assert.equal((await request('/admin/api/billing')).status, 404);
  assert.equal((await request('/admin/api/billing/checkout', post({ kind: 'extra_usage', key: 'extra_usage_25' }))).status, 404);
  assert.equal((await request('/admin/api/billing/funding', post({ funding: 'platform' }))).status, 404);
  assert.match(await (await request('/admin')).text(), /"billingOffered":false/);
  assert.deepEqual(calls, []);
});

test('a hosted installation whose host installed no port has no billing', async (t) => {
  const request = admin(t, {});
  assert.equal((await request('/admin/api/billing')).status, 404);
  assert.equal((await request('/admin/api/billing/portal', post({}))).status, 404);
  assert.match(await (await request('/admin')).text(), /"billingOffered":false/);
});

test('an Owner reads the plan\'s usage in dollars, the offers, and named use; unnamed use folds into one last row', async (t) => {
  const { port, calls } = fakePort(TEAM_PLAN);
  const response = await admin(t, { port })('/admin/api/billing');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    manage: true,
    ...TEAM_STATUS,
    plan: { key: 'team', name: 'Team', price: '$200', included: '$240' },
    period: { start: 'Oct 7', end: 'Nov 7' },
    pendingChange: null,
    use: {
      byAgent: [{ name: 'Chickpea', used: '$30.25' }, { name: null, used: '$7' }],
      byPerson: [{ name: 'Maya Chen', used: '$31.50' }, { name: null, used: '$6' }],
    },
    offers: {
      plans: [
        { key: 'solo', name: 'Solo', price: '$25', included: '$30', ownKeyMinimum: false, ownKeyEligible: false },
        { key: 'starter', name: 'Starter', price: '$50', included: '$60', ownKeyMinimum: false, ownKeyEligible: false },
        { key: 'plus', name: 'Plus', price: '$100', included: '$120', ownKeyMinimum: true, ownKeyEligible: true },
        { key: 'team', name: 'Team', price: '$200', included: '$240', ownKeyMinimum: false, ownKeyEligible: true },
        { key: 'growth', name: 'Growth', price: '$300', included: '$360', ownKeyMinimum: false, ownKeyEligible: true },
        { key: 'business', name: 'Business', price: '$500', included: '$600', ownKeyMinimum: false, ownKeyEligible: true },
      ],
      extraUsage: [
        { key: 'extra_usage_25', price: '$25', usage: '$25', validMonths: 12 },
        { key: 'extra_usage_50', price: '$50', usage: '$50', validMonths: 12 },
        { key: 'extra_usage_100', price: '$100', usage: '$100', validMonths: 12 },
      ],
    },
    switchFunding: { to: 'own_key', ready: false, needs: 'key', provider: null },
  });
  assert.deepEqual(calls, [['summary', INSTALLATION]]);
});

test('an Owner reads when a plan ends or which plan it changes to; a plan that renews, or no plan, reads none, and a Member never reads it', async (t) => {
  const view = async (summary: BillingSummary, role: AuthPrincipal['role'] = 'owner') =>
    await (await admin(t, { port: fakePort(summary).port, role })('/admin/api/billing')).json() as Record<string, unknown>;
  assert.deepEqual((await view(TEAM_ENDING)).pendingChange, { kind: 'ends', on: 'Nov 7' });
  assert.deepEqual((await view(TEAM_DOWNGRADING)).pendingChange, { kind: 'plan', planName: 'Chickpea $50 plan', on: 'Nov 7' });
  assert.equal((await view({ ...TEAM_PLAN, pendingChange: null })).pendingChange, null);
  assert.equal((await view({ ...NO_PLAN, pendingChange: TEAM_ENDING.pendingChange! })).pendingChange, null);
  assert.deepEqual(await view(TEAM_ENDING, 'member'), { manage: false, ...TEAM_STATUS });
  assert.deepEqual(await view(TEAM_DOWNGRADING, 'member'), { manage: false, ...TEAM_STATUS });
});

test('the status leaves out what is empty: no zero rollover or extra usage', async (t) => {
  const status = async (summary: BillingSummary) => {
    const response = await admin(t, { port: fakePort(summary).port, role: 'member' })('/admin/api/billing');
    return await response.json() as Record<string, unknown>;
  };
  const drained = await status({
    ...TEAM_PLAN,
    rollover: { remainingMicros: usd(0), expiresAt: PERIOD.end },
    extraUsage: { remainingMicros: usd(0), frozen: false, expiresAt: PERIOD.end },
  });
  assert.equal(drained.rollover, null);
  assert.equal(drained.extraUsage, null);
  const trial = await status({ ...NO_PLAN, trial: { remainingMicros: usd(32.5), expiresAt: new Date('2026-11-06T17:00:00Z') } });
  assert.deepEqual(trial.trial, { remaining: '$32.50', until: 'Nov 6' });
  assert.equal(trial.meter, null, 'no meter without a plan period');
});

test('only an own key with no plan reads the price of the lowest plan an own key needs', async (t) => {
  const ownKeyWithoutPlan = async (summary: BillingSummary) =>
    (await (await admin(t, { port: fakePort(summary).port, role: 'member' })('/admin/api/billing')).json() as Record<string, unknown>).ownKeyWithoutPlan;
  assert.deepEqual(await ownKeyWithoutPlan(OWN_KEY_NO_PLAN), { minimumPrice: '$100' });
  assert.deepEqual(await ownKeyWithoutPlan({ ...OWN_KEY_NO_PLAN, offers: { ...OWN_KEY_NO_PLAN.offers, ownKeyMinimumPlanKey: 'team' } }),
    { minimumPrice: '$200' }, 'the price is the lowest own-key plan\'s, not a fixed one');
  assert.equal(await ownKeyWithoutPlan({ ...TEAM_PLAN, funding: 'own_key' }), null, 'a plan already meets it');
  assert.equal(await ownKeyWithoutPlan(NO_PLAN), null, 'Chickpea\'s models need no own-key plan');
});

test('a Member reads the plan\'s name when the plan has no recorded period, and no meter', async (t) => {
  const status = await (await admin(t, { port: fakePort(PLAN_NO_PERIOD).port, role: 'member' })('/admin/api/billing')).json() as Record<string, unknown>;
  assert.equal(status.planName, 'Team');
  assert.equal(status.meter, null);
});

test('an Owner of an own-key workspace with no plan reads no plan, the lowest plan for an own key, and the switch to Chickpea\'s models', async (t) => {
  const { port } = fakePort(OWN_KEY_NO_PLAN);
  const view = await (await admin(t, { port })('/admin/api/billing')).json() as Record<string, unknown>;
  assert.deepEqual(
    { funding: view.funding, meter: view.meter, plan: view.plan, period: view.period, ownKeyWithoutPlan: view.ownKeyWithoutPlan, switchFunding: view.switchFunding },
    { funding: 'own_key', meter: null, plan: null, period: null, ownKeyWithoutPlan: { minimumPrice: '$100' }, switchFunding: { to: 'platform' } },
  );
});

test('an Owner switches an own-key installation to Chickpea\'s models, and switching again changes nothing', async (t) => {
  let summary: BillingSummary = { ...TEAM_PLAN, funding: 'own_key' };
  const { port, calls } = fakePort(summary, {
    summary: async () => summary,
    chooseFunding: async (installationId, next) => { calls.push(['chooseFunding', installationId, next]); summary = { ...summary, funding: next }; },
  });
  const request = admin(t, { port });
  assert.deepEqual((await (await request('/admin/api/billing')).json() as Record<string, unknown>).switchFunding, { to: 'platform' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const switched = await request('/admin/api/billing/funding', post({ funding: 'platform' }));
    assert.equal(switched.status, 200);
    assert.equal(switched.headers.get('cache-control'), 'no-store');
    const view = await switched.json() as Record<string, unknown>;
    assert.equal(view.funding, 'platform');
    assert.equal(view.manage, true);
    assert.deepEqual(view.meter, TEAM_STATUS.meter);
  }
  assert.deepEqual(calls, [['chooseFunding', INSTALLATION, 'platform'], ['chooseFunding', INSTALLATION, 'platform']]);
});

/** A host whose funding follows the Plan page's switch, for a workspace with an image role as given. */
async function switchingHost(
  t: TestContext,
  funding: BillingSummary['funding'],
  image?: { modelId?: string },
  keys: { openaiKeySaved?: boolean } = {},
) {
  let summary: BillingSummary = { ...TEAM_PLAN, funding };
  const { port } = fakePort(summary, {
    summary: async () => summary,
    chooseFunding: async (_installationId, next) => { summary = { ...summary, funding: next }; },
  });
  configurePlatformFunding({
    funding: async () => summary.funding === 'platform' ? 'platform' : 'customer',
    admit: async () => 'admitted',
    charge: async () => undefined,
    ...NO_RUN_FEES,
  });
  t.after(() => resetPlatformFundingForTests());
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  await config.ensureWorkspaceInstallation({ workspaceId: 'T_BILLING', transportMode: 'direct', teamId: 'T_BILLING' });
  const chosen = image ? await config.putWorkspaceModelRole({ workspaceId: 'T_BILLING', role: 'image', ...image }, 0) : undefined;
  return { request: admin(t, { port, config, anthropicKeySaved: true, ...keys }), config, chosen };
}

test('switching to Chickpea\'s models from the Plan page chooses the image model onboarding chooses, when none is chosen', async (t) => {
  const { request, config } = await switchingHost(t, 'own_key');
  assert.equal((await request('/admin/api/billing/funding', post({ funding: 'platform' }))).status, 200);
  const image = await config.getWorkspaceModelRole('T_BILLING', 'image');
  assert.equal(image?.modelId, OPENAI_API_IMAGE_DEFAULT_MODEL_ID);
  assert.equal(image?.lastChangedByMembershipId, 'membership_owner');
});

for (const [kept, image] of [
  ['another image model', { modelId: 'openai/gpt-image-2.5-sunburst' }],
  ['an image role set to Not set', {}],
] as const) {
  test(`switching to Chickpea's models from the Plan page keeps ${kept}`, async (t) => {
    const { request, config, chosen } = await switchingHost(t, 'own_key', image);
    assert.equal((await request('/admin/api/billing/funding', post({ funding: 'platform' }))).status, 200);
    assert.deepEqual(await config.getWorkspaceModelRole('T_BILLING', 'image'), chosen);
  });
}

test('switching to your own key from the Plan page chooses no image model, even with an OpenAI key that could serve one', async (t) => {
  const { request, config } = await switchingHost(t, 'platform', undefined, { openaiKeySaved: true });
  assert.equal((await request('/admin/api/billing/funding', post({ funding: 'own_key' }))).status, 200);
  assert.equal(await config.getWorkspaceModelRole('T_BILLING', 'image'), undefined);
});

test('switching to your own key below the lowest plan for it, or with no plan, is refused before the port is asked', async (t) => {
  for (const summary of [STARTER_PLAN, NO_PLAN]) {
    const { port, calls } = fakePort(summary);
    const request = admin(t, { port });
    assert.deepEqual((await (await request('/admin/api/billing')).json() as Record<string, unknown>).switchFunding,
      { to: 'own_key', ready: false, needs: 'plan', minimumPlan: { key: 'plus', price: '$100' } });
    const refused = await request('/admin/api/billing/funding', post({ funding: 'own_key' }));
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'own_key_plan_required' });
    assert.deepEqual(calls.filter(([name]) => name === 'chooseFunding'), [], summary.plan?.name ?? 'no plan');
  }
});

test('switching to your own key on the plan but with no key saved, or a malformed switch, is refused before the port is asked', async (t) => {
  const { port, calls } = fakePort(TEAM_PLAN);
  const request = admin(t, { port });
  const keyless = await request('/admin/api/billing/funding', post({ funding: 'own_key' }));
  assert.equal(keyless.status, 409);
  assert.deepEqual(await keyless.json(), { error: 'own_key_missing', provider: null });
  for (const body of [{}, { funding: 'byok' }, { funding: 'credits' }, { funding: 'platform', installationId: 'inst_other' }]) {
    assert.equal((await request('/admin/api/billing/funding', post(body))).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls.filter(([name]) => name === 'chooseFunding'), []);
});

test('Add extra usage, Change plan and Manage billing each call the port and return its Stripe URL', async (t) => {
  const { port, calls } = fakePort(TEAM_PLAN);
  const request = admin(t, { port });
  assert.deepEqual(await (await request('/admin/api/billing/checkout', post({ kind: 'extra_usage', key: 'extra_usage_25' }))).json(),
    { url: 'https://checkout.stripe.com/c/pay/cs_test_billing' });
  assert.deepEqual(await (await request('/admin/api/billing/checkout', post({ kind: 'plan', key: 'business' }))).json(),
    { url: 'https://checkout.stripe.com/c/pay/cs_test_billing' });
  assert.deepEqual(await (await request('/admin/api/billing/portal', post({}))).json(),
    { url: 'https://billing.stripe.com/p/session/test_billing' });
  assert.deepEqual(calls, [
    ['checkout', INSTALLATION, { kind: 'extra_usage', key: 'extra_usage_25' }, '/admin/plan'],
    ['checkout', INSTALLATION, { kind: 'plan', key: 'business' }, '/admin/plan'],
    ['portal', INSTALLATION, '/admin/plan'],
  ]);
});

test('a purchase the host refuses for a reason the Owner can fix answers 409 with that reason', async (t) => {
  const refusals = [
    ['plan_required', { kind: 'extra_usage', key: 'extra_usage_25' }],
    ['own_key_plan_required', { kind: 'plan', key: 'starter' }],
  ] as const;
  for (const [reason, purchase] of refusals) {
    const { port, calls } = fakePort(TEAM_PLAN, {
      checkout: async (installationId, request, returnPath) => { calls.push(['checkout', installationId, request, returnPath]); throw new BillingRefusal(reason); },
    });
    const refused = await admin(t, { port })('/admin/api/billing/checkout', post(purchase));
    assert.equal(refused.status, 409, reason);
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await refused.json(), { error: reason });
    assert.deepEqual(calls, [['checkout', INSTALLATION, purchase, '/admin/plan']]);
  }
});

test('a switch to your own key that passes Admin\'s own check but the host refuses below the lowest plan for it answers as that check does', async (t) => {
  const { port, calls } = fakePort(TEAM_PLAN, {
    chooseFunding: async (installationId, funding) => { calls.push(['chooseFunding', installationId, funding]); throw new BillingRefusal('own_key_plan_required'); },
  });
  const request = admin(t, { port, anthropicKeySaved: true });
  assert.deepEqual((await (await request('/admin/api/billing')).json() as Record<string, unknown>).switchFunding,
    { to: 'own_key', ready: true, agentsWithoutKey: [] }, 'Admin\'s own check passes');
  const refused = await request('/admin/api/billing/funding', post({ funding: 'own_key' }));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'own_key_plan_required' });
  assert.deepEqual(calls.filter(([name]) => name === 'chooseFunding'), [['chooseFunding', INSTALLATION, 'own_key']]);
});

test('a malformed purchase, or a top-up by its retired name, is refused before the port is asked', async (t) => {
  const { port, calls } = fakePort(TEAM_PLAN);
  const request = admin(t, { port });
  for (const body of [
    { kind: 'top_up', key: 'extra_usage_25' }, { kind: 'gift', key: 'extra_usage_25' }, { kind: 'plan', key: 'Team!' },
    { kind: 'plan' }, { kind: 'plan', key: 'team', price: 1 },
  ]) {
    assert.equal((await request('/admin/api/billing/checkout', post(body))).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test('a port that fails, answers with a URL that is not HTTPS, or names a lowest own-key plan it does not sell, is unavailable', async (t) => {
  const failing = admin(t, { port: fakePort(TEAM_PLAN, { summary: async () => { throw new Error('ledger down'); } }).port });
  assert.equal((await failing('/admin/api/billing')).status, 503);
  const plainHttp = admin(t, { port: fakePort(TEAM_PLAN, { portal: async () => ({ url: 'http://billing.example/p' }) }).port });
  const refused = await plainHttp('/admin/api/billing/portal', post({}));
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: 'billing_unavailable' });
  const script = admin(t, { port: fakePort(TEAM_PLAN, { checkout: async () => ({ url: 'javascript:alert(1)' }) }).port });
  assert.equal((await script('/admin/api/billing/checkout', post({ kind: 'extra_usage', key: 'extra_usage_25' }))).status, 503);
  const plainCheckout = admin(t, { port: fakePort(TEAM_PLAN, { checkout: async () => { throw new Error('Extra usage needs a plan.'); } }).port });
  const outage = await plainCheckout('/admin/api/billing/checkout', post({ kind: 'extra_usage', key: 'extra_usage_25' }));
  assert.equal(outage.status, 503, 'a plain error is an outage, whatever it says');
  assert.deepEqual(await outage.json(), { error: 'billing_unavailable' });
  const plainSwitch = admin(t, { anthropicKeySaved: true, port: fakePort(TEAM_PLAN, { chooseFunding: async () => { throw new Error('Your own key needs the Plus plan.'); } }).port });
  const switchOutage = await plainSwitch('/admin/api/billing/funding', post({ funding: 'own_key' }));
  assert.equal(switchOutage.status, 503);
  assert.deepEqual(await switchOutage.json(), { error: 'billing_unavailable' });

  const { port, calls } = fakePort({ ...TEAM_PLAN, offers: { ...TEAM_PLAN.offers, ownKeyMinimumPlanKey: 'retired_pro' } });
  const inconsistent = admin(t, { port });
  const unavailable = await inconsistent('/admin/api/billing');
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'billing_unavailable' });
  assert.equal((await inconsistent('/admin/api/billing/funding', post({ funding: 'own_key' }))).status, 503);
  assert.deepEqual(calls.filter(([name]) => name === 'chooseFunding'), []);
});

for (const role of ['member', 'admin'] as const) {
  test(`a${role === 'admin' ? 'n Admin' : ' Member'} sees the status alone and cannot buy`, async (t) => {
    const { port, calls } = fakePort(TEAM_PLAN);
    const request = admin(t, { role, port });
    assert.deepEqual(await (await request('/admin/api/billing')).json(), { manage: false, ...TEAM_STATUS });
    assert.equal((await request('/admin/plan')).status, 200);
    assert.equal((await request('/admin/api/billing/checkout', post({ kind: 'extra_usage', key: 'extra_usage_25' }))).status, 403);
    assert.equal((await request('/admin/api/billing/portal', post({}))).status, 403);
    assert.equal((await request('/admin/api/billing/funding', post({ funding: 'platform' }))).status, 403);
    assert.equal((await request('/admin/api/billing/funding', post({ funding: 'own_key' }))).status, 403);
    assert.deepEqual(calls.filter(([name]) => name !== 'summary'), []);
  });
}

test('every Owner-only route reads an Owner\'s own session alike: an Owner, never an Admin, a Member, an Owner\'s personal token, or no one', async (t) => {
  const answers = async (request: ReturnType<typeof admin>) => ({
    plan: (await (await request('/admin/api/billing')).json() as { manage?: boolean }).manage === true,
    page: /"installationOwner":true/.test(await (await request('/admin')).text()),
    onboardingPlatform: (await request('/admin/api/onboarding/platform', post({}))).status === 404,
    installation: (await request('/admin/api/installation')).status === 200,
  });
  const all = (owner: boolean) => ({ plan: owner, page: owner, onboardingPlatform: owner, installation: owner });
  for (const [label, role, machine, owner] of [
    ['an Owner', 'owner', false, true],
    ['an Admin', 'admin', false, false],
    ['a Member', 'member', false, false],
    ['an Owner\'s personal token', 'owner', true, false],
  ] as const) {
    assert.deepEqual(await answers(admin(t, { role, machine, port: fakePort(TEAM_PLAN).port })), all(owner), label);
  }
  const owners = admin(t, { port: fakePort(TEAM_PLAN).port });
  const signedOut = (path: string, init: RequestInit = {}) =>
    owners(path, { ...init, headers: { authorization: 'Bearer signed-out' } });
  assert.deepEqual(await answers(signedOut), all(false), 'no one');
});

test('an Owner\'s personal token is not an Owner\'s own session: no use, no purchases', async (t) => {
  const { port, calls } = fakePort(TEAM_PLAN);
  const request = admin(t, { port, machine: true });
  assert.deepEqual(await (await request('/admin/api/billing')).json(), { manage: false, ...TEAM_STATUS });
  assert.equal((await request('/admin/api/billing/portal', post({}))).status, 403);
  assert.equal((await request('/admin/api/billing/funding', post({ funding: 'platform' }))).status, 403);
  assert.equal((await request('/admin/api/billing/funding', post({ funding: 'own_key' }))).status, 403);
  assert.deepEqual(calls.filter(([name]) => name !== 'summary'), []);
});
