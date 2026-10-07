import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { markSlackInstallationEnded } from '../src/channels/slack.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { activateInstallerOwner, claimInstallerOwner, type InstallerOwnerInput } from '../src/auth/installer-owner.ts';
import { signInSlackMember } from '../src/auth/member-sign-in.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  beginOnboardingJourney,
  completeOnboardingJourney,
  ONBOARDING_JOURNEY_KEY,
  onboardingJourneyStart,
  parseOnboardingJourney,
  readOnboardingJourney,
  selectOnboardingProvider,
  startOnboardingTry,
} from '../src/config/onboarding-state.ts';
import { configurePlatformBilling, type BillingFunding } from '../src/config/platform-billing.ts';
import { configurePlatformFunding, resetPlatformFundingForTests } from '../src/config/platform-funding.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { invalidateProviderModelCache } from '../src/config/provider-models.ts';
import { SettingsStoreLogic, SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore, type ConfigStore } from '../src/config/store.ts';
import { IdentityStoreLogic } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { REQUESTED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { promisify } from '../src/state/async-facade.ts';
import { DoSqlStateDb } from '../src/state/do-state-db.ts';
import { buildTagStateStores } from '../src/state/tag-state-stores.ts';
import type { UsageStore } from '../src/usage/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { withEnv } from './helpers/env.ts';
import { FAKE_PROVIDER_KEYS, FakeProvidersBackend } from './helpers/fake-providers.ts';
import { FakeObjectStorage, hostedInstallation } from './helpers/installation-objects.ts';

/**
 * Hosted guided onboarding: the person who signs up becomes the first Owner
 * and the journey starts with Slack already connected, at Choose provider.
 * Existing installations and Members never see it, Workers AI is never
 * offered, and finishing opens Admin as usual. Standalone is unchanged.
 */

const ORIGIN = 'https://hosted.example';
const TOKEN = 'hosted-onboarding-admin-token';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 7)).toString('base64url');
const INSTALLATION = `inst_${'0123456789abcdef'.repeat(2)}`;
const TEAM = 'TSIGNUP';
const APP = 'AHOSTED1';
const BOT = 'UHOSTEDBOT';
const INSTALLER = 'UINSTALLER';

const facade = <L extends object>(logic: L) => promisify(logic, { close() {} });

function principalFor(role: AuthPrincipal['role'], ids: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_signup', role,
    authenticatorKind: 'test_slack_session', credentialId: `session_${role}`, correlationId: `request_${role}`,
    machine: false, ...ids,
  };
}

/**
 * One hosted sign-up, its stores built as its state object builds them, and
 * provisioned as the host provisions it: the bot, the workspace record, then
 * (`claim()`) the person signing up as first Owner.
 */
async function signUp(t: TestContext, bindings: Record<string, unknown> = {}) {
  const tenant = hostedInstallation(INSTALLATION, bindings);
  const identity = facade(tenant.stores.identity) as unknown as IdentityStore;
  const config = facade(tenant.stores.config) as unknown as ConfigStore;
  const settings = facade(tenant.stores.settings) as unknown as SettingsStore;
  const usage = facade(tenant.stores.usage) as unknown as UsageStore;
  const credentials = { state: identity, keyring: generateCredentialKeyring() };
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-hosted-signup', botUserId: BOT, appId: APP, teamId: TEAM,
    grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES], validatedAt: Date.now(),
  });
  await syncHostedWorkspaceInstallation(tenant.env, { teamId: TEAM, appId: APP, botUserId: BOT }, config);
  const backend = new NodeBetterAuthBackend(':memory:');
  // Every landing decision here is read, never the fallback for a store that fails.
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    assert.notEqual(args[0], '[chickpea] Hosted onboarding state unavailable');
    warn(...args);
  };
  t.after(() => {
    console.warn = warn;
    backend.close();
    invalidateSlackInstallationCredentialCache();
    invalidateProviderKeyCache();
    invalidateProviderModelCache();
  });
  const owner: InstallerOwnerInput = {
    identity,
    environment: { backend, baseURL: ORIGIN, secret: SECRET },
    proof: { slackTeamId: TEAM, slackUserId: INSTALLER, displayName: 'Installer', eligibility: 'install_grant' },
    installGrant: { slackTeamId: TEAM, installerSlackUserId: INSTALLER },
    capability: 'hosted-sign-up-capability-0123456789abcdef',
  };
  /** The claimed Owner as Admin's principal, so the journey's Try step resolves them. */
  const ownerPrincipal = async (): Promise<AuthPrincipal> => {
    const claim = (await identity.getOwnerClaim())!;
    const membership = (await identity.getMembership(claim.membershipId!))!;
    return principalFor('owner', { userId: membership.userId, membershipId: membership.id, organizationId: membership.organizationId });
  };
  const admin = (principal: AuthPrincipal, stores: { config?: ConfigStore; settings?: SettingsStore } = {}) => {
    const app = createAdminRoutes({
      store: stores.config ?? config, settings: stores.settings ?? settings, usage, slackCredentials: credentials,
      ...testAdminAuthority(TOKEN, ORIGIN, identity, principal),
    });
    return (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, {
      ...init,
      headers: { ...testAdminHeaders(TOKEN, { origin: ORIGIN }), 'content-type': 'application/json', ...init.headers },
    }, tenant.env);
  };
  return {
    tenant, identity, config, settings, owner, ownerPrincipal, admin,
    claim: () => claimInstallerOwner(owner),
    journey: () => readOnboardingJourney(settings),
  };
}

/** Saving a hosted key validates it at the provider and encrypts it with the deployment keyring. */
async function withProviders(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-hosted-onboarding-'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = new FakeProvidersBackend().asFetch();
  try {
    await withEnv({
      CHICKPEA_TENANCY: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      ANTHROPIC_API_URL: 'https://anthropic.fake',
      CHICKPEA_CREDENTIAL_KEYRING_PATH: join(dir, 'deployment-keyring.json'),
    }, run);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `store` with `method` failing, as a store that cannot be read fails. */
function failing<S extends object>(store: S, method: string, fails: (...args: unknown[]) => boolean = () => true): S {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (property !== method) return value.bind(target);
      return async (...args: unknown[]) => {
        if (fails(...args)) throw new Error('store unavailable');
        return value.apply(target, args);
      };
    },
  });
}

/** Runs `request` with the console's warnings captured. */
async function warnings(request: () => Promise<void>): Promise<unknown[][]> {
  const captured: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { captured.push(args); };
  try {
    await request();
  } finally {
    console.warn = warn;
  }
  return captured;
}

async function json<T = Record<string, unknown>>(response: Response | Promise<Response>): Promise<T> {
  return await (await response).json() as T;
}

test('a new hosted sign-up starts guided onboarding as the person signing up becomes the first Owner, at Choose provider with Slack connected', async (t) => {
  const signup = await signUp(t);
  assert.equal(await signup.journey(), undefined, 'the host\'s bot and workspace record start nothing');
  await signup.claim();
  const started = (await signup.journey())!;
  assert.equal(started.journey.state, 'active');
  assert.equal(started.journey.selectedProviderId, undefined);
  // Signing the Owner in, then and on every later attempt, leaves it as it is.
  await activateInstallerOwner({ ...signup.owner, request: new Request(`${ORIGIN}/start/install/callback`) });
  await signup.claim();
  assert.equal((await signup.journey())!.revision, started.revision);

  const admin = signup.admin(await signup.ownerPrincipal());
  const onboarding = await json(admin('/admin/api/onboarding'));
  assert.equal(onboarding.stage, 'choose_provider', 'Slack is connected: the host owns the app and its signing secret');
  assert.deepEqual(onboarding.workspace, { id: TEAM, name: null });
  assert.equal(onboarding.slackAppId, APP);
  // Opening Admin lands the Owner in it.
  const landing = await admin('/admin');
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get('location'), '/admin/onboarding');
  assert.equal((await admin('/admin/onboarding')).status, 200);
  // A link with a purpose opens what it asks for.
  assert.equal((await admin('/admin?slack=updated')).status, 200);
});

test('a hosted Owner whose Slack connection ended before finishing opens Admin, never onboarding\'s Connect Slack step', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  const admin = signup.admin(await signup.ownerPrincipal());
  assert.equal((await admin('/admin')).status, 302);
  // Slack uninstalled the app, or revoked its token, as the host records it.
  await markSlackInstallationEnded(signup.config, TEAM, 'tokens_revoked');
  assert.equal((await json(admin('/admin/api/onboarding'))).stage, 'connect_slack', 'the journey waits on Slack');
  // Admin opens, where its Slack status leads the Owner back through the host.
  const opened = await admin('/admin');
  assert.equal(opened.status, 200);
  assert.match(await opened.text(), /<html/);
  // Onboarding itself opens Admin instead of standalone's own Slack setup.
  const page = await admin('/admin/onboarding');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/admin');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await signup.journey())?.journey.state, 'active', 'opening either changes nothing');
});

test('a personal token, even an Owner\'s, is refused Admin\'s page, never landed in onboarding', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  const machine = signup.admin({ ...await signup.ownerPrincipal(), machine: true, authenticatorKind: 'personal_token' });
  const opened = await machine('/admin');
  assert.equal(opened.status, 403);
  assert.equal(opened.headers.get('location'), null);
  assert.equal((await signup.journey())?.journey.state, 'active');
});

test('when the journey or Slack cannot be read, Admin and onboarding open as usual and the log says so', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  const owner = await signup.ownerPrincipal();
  const journeyUnread = signup.admin(owner, {
    settings: failing(signup.settings, 'getSetting', (key) => key === ONBOARDING_JOURNEY_KEY),
  });
  assert.deepEqual(await warnings(async () => {
    const opened = await journeyUnread('/admin');
    assert.equal(opened.status, 200);
    assert.match(await opened.text(), /<html/);
  }), [['[chickpea] Hosted onboarding state unavailable']]);
  const slackUnread = signup.admin(owner, { config: failing(signup.config, 'listWorkspaceInstallations') });
  assert.deepEqual(await warnings(async () => {
    assert.equal((await slackUnread('/admin')).status, 200);
    const page = await slackUnread('/admin/onboarding');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
  }), [['[chickpea] Hosted onboarding state unavailable'], ['[chickpea] Hosted onboarding state unavailable']]);
});

test('the hosted journey runs Choose provider, Choose model and Try; finishing opens Admin as usual', async (t) => {
  await withProviders(async () => {
    const signup = await signUp(t);
    await signup.claim();
    const admin = signup.admin(await signup.ownerPrincipal());
    const saved = await admin('/admin/api/providers/anthropic/key', {
      method: 'POST', body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.anthropic }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    // A key alone is not set up: Admin still lands in onboarding.
    assert.equal((await admin('/admin')).status, 302);
    const before = await json<{ revision: string }>(admin('/admin/api/onboarding'));
    const provider = await json<{ stage: string; revision: string; models: string[] }>(admin('/admin/api/onboarding/provider', {
      method: 'POST', body: JSON.stringify({ expectedRevision: before.revision, providerId: 'anthropic' }),
    }));
    assert.equal(provider.stage, 'choose_model');
    const model = provider.models.find((id) => id.startsWith('anthropic/'))!;
    assert.ok(model, 'the model step lists the provider\'s models');
    const workspaceDefault = (await signup.config.getWorkspaceModelDefault(TEAM))!;
    const trying = await admin('/admin/api/onboarding/try', {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: provider.revision, modelId: model, expectedDefaultRevision: workspaceDefault.revision }),
    });
    assert.equal(trying.status, 200, await trying.clone().text());
    const tryStage = await trying.json() as { stage: string; revision: string };
    assert.equal(tryStage.stage, 'try');
    assert.equal((await signup.config.getWorkspaceModelDefault(TEAM))?.modelId, model);
    // With a key and Chickpea answering on that model, Admin opens as usual.
    assert.equal((await admin('/admin')).status, 200);
    // Proceed to Dashboard finishes the journey without waiting for the reply.
    const finished = await json<{ stage: string; redirectTo: string }>(admin('/admin/api/onboarding/complete', {
      method: 'POST', body: JSON.stringify({ expectedRevision: tryStage.revision }),
    }));
    assert.equal(finished.stage, 'complete');
    assert.equal(finished.redirectTo, '/admin/agents');
    assert.equal((await admin('/admin')).status, 200);
  });
});

test('a finished or skipped journey opens Admin as usual', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  const admin = signup.admin(await signup.ownerPrincipal());
  assert.equal((await admin('/admin')).status, 302);
  // Proceed to Dashboard from Try, with or without Chickpea's reply.
  const begun = (await signup.journey())!;
  const provider = await selectOnboardingProvider(signup.settings, {
    expectedRevision: begun.revision, workspaceId: TEAM, providerId: 'anthropic',
  });
  const trying = await startOnboardingTry(signup.settings, {
    expectedRevision: provider.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: INSTALLER,
  });
  assert.equal((await admin('/admin')).status, 302, 'no key yet: not set up, and not finished');
  await completeOnboardingJourney(signup.settings, trying.revision);
  const opened = await admin('/admin');
  assert.equal(opened.status, 200);
  assert.match(await opened.text(), /<html/);
});

test('an installation that signed up before onboarding started at sign-up, or is already set up, opens Admin as today', async (t) => {
  await withProviders(async () => {
    // Its first Owner claimed before the journey began with the claim.
    const earlier = await signUp(t);
    await earlier.claim();
    await earlier.settings.applySettingsPatch({ delete: [ONBOARDING_JOURNEY_KEY] });
    await activateInstallerOwner({ ...earlier.owner, request: new Request(`${ORIGIN}/start/callback`) });
    await earlier.claim();
    assert.equal(await earlier.journey(), undefined, 'signing in again starts nothing');
    const admin = earlier.admin(await earlier.ownerPrincipal());
    assert.equal((await admin('/admin')).status, 200);
    assert.equal((await admin('/admin/api/onboarding')).status, 404, 'unchanged from before');
  });
  await withProviders(async () => {
    // A journey left open, on an installation with a key and an active Agent.
    const configured = await signUp(t);
    await configured.claim();
    const admin = configured.admin(await configured.ownerPrincipal());
    await configured.config.createAgent({
      id: 'agent_support', kind: 'user', name: 'Support', instructions: 'Help.', enabled: true, lifecycle: 'active',
      model: 'openrouter/openai/gpt-5.6-terra', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    assert.equal((await admin('/admin')).status, 302, 'an active Agent without a key is not set up');
    assert.equal((await admin('/admin/api/providers/openrouter/key', {
      method: 'POST', body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.openrouter }),
    })).status, 200);
    assert.equal((await admin('/admin')).status, 200);
    assert.equal((await configured.journey())?.journey.state, 'active', 'opening Admin changes nothing');
  });
});

test('Members never see onboarding: only the Owner lands in it, and only the first Owner\'s claim starts it', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  for (const role of ['member', 'admin'] as const) {
    const admin = signup.admin(principalFor(role));
    assert.equal((await admin('/admin')).status, 200, `${role} opens Admin`);
  }
  const member = signup.admin(principalFor('member'));
  const page = await member('/admin/onboarding');
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/admin');
  assert.equal((await member('/admin/api/onboarding')).status, 403);
  assert.equal((await member('/admin/api/onboarding/provider', {
    method: 'POST', body: JSON.stringify({ expectedRevision: (await signup.journey())!.revision, providerId: 'anthropic' }),
  })).status, 403);
  // A Member Slack provisions, and their sign-in, start nothing.
  await signup.settings.applySettingsPatch({ delete: [ONBOARDING_JOURNEY_KEY] });
  await signup.identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER', displayName: 'Member' });
  const signedIn = await signInSlackMember({
    identity: signup.identity, environment: signup.owner.environment,
    proof: { slackTeamId: TEAM, slackUserId: 'UMEMBER', displayName: 'Member' },
    capability: 'hosted-member-capability-0123456789abcdef', request: new Request(`${ORIGIN}/start/callback`),
  });
  assert.equal(signedIn.ok, true);
  assert.equal(await signup.journey(), undefined);
});

test('hosted onboarding never offers Workers AI, even with an AI binding', async (t) => {
  const signup = await signUp(t, { AI: { run: async () => ({}) } });
  await signup.claim();
  const admin = signup.admin(await signup.ownerPrincipal());
  const models = await json<{ providers: Array<{ id: string }> }>(admin('/admin/api/models'));
  assert.deepEqual(models.providers.map(({ id }) => id).sort(), ['anthropic', 'openai', 'openrouter']);
  const { revision } = await json<{ revision: string }>(admin('/admin/api/onboarding'));
  const refused = await admin('/admin/api/onboarding/provider', {
    method: 'POST', body: JSON.stringify({ expectedRevision: revision, providerId: 'cloudflare' }),
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'onboarding_provider_not_configured' });
  assert.equal((await signup.journey())!.revision, revision);
});

test('an installation on credits chooses a provider with no key; one on its own key still needs one', async (t) => {
  let funding: 'platform' | 'customer' = 'customer';
  configurePlatformFunding({
    funding: async () => funding,
    admit: async () => 'admitted',
    charge: async () => undefined,
    priceMultiplier: async () => 1.5,
  });
  t.after(() => resetPlatformFundingForTests());
  const signup = await signUp(t);
  await signup.claim();
  const admin = signup.admin(await signup.ownerPrincipal());
  const choose = async () => admin('/admin/api/onboarding/provider', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: (await signup.journey())!.revision, providerId: 'anthropic' }),
  });
  const refused = await choose();
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'onboarding_provider_not_configured' });
  funding = 'platform';
  const chosen = await json(choose());
  assert.equal(chosen.stage, 'choose_model');
  assert.equal(chosen.providerId, 'anthropic');
  assert.equal((await signup.journey())!.journey.selectedProviderId, 'anthropic');
});

test('the Owner\'s credits-or-own-key choice is the host\'s to record and the journey\'s to keep; after onboarding, the Plan and credits page switches', async (t) => {
  const chosen: BillingFunding[] = [];
  configurePlatformBilling({
    summary: async () => ({ funding: 'own_key' }),
    checkout: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }),
    portal: async () => ({ url: 'https://billing.stripe.com/p/session/test' }),
    chooseFunding: async (_installationId, funding) => { chosen.push(funding); },
  });
  t.after(() => configurePlatformBilling(undefined));
  const signup = await signUp(t);
  await signup.claim();
  const admin = signup.admin(await signup.ownerPrincipal());
  const choose = async (funding: BillingFunding, expectedRevision?: string, as = admin) => as('/admin/api/onboarding/funding', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: expectedRevision ?? (await signup.journey())!.revision, funding }),
  });
  assert.equal((await json(admin('/admin/api/onboarding'))).funding, undefined, 'nothing chosen yet');

  const ownKey = await json(choose('own_key'));
  assert.equal(ownKey.funding, 'own_key');
  assert.equal(ownKey.stage, 'choose_provider');
  assert.equal((await json(admin('/admin/api/onboarding'))).funding, 'own_key', 'a reload continues from the choice');
  assert.equal((await signup.journey())!.journey.selectedFunding, 'own_key');

  assert.equal((await choose('credits', ownKey.revision as string)).status, 200);
  assert.equal((await choose('own_key', ownKey.revision as string)).status, 409, 'a stale revision changes nothing');
  assert.equal((await choose('credits', undefined, signup.admin(principalFor('admin')))).status, 403);
  assert.equal((await choose('credits', undefined, signup.admin(principalFor('member')))).status, 403);
  assert.deepEqual(chosen, ['own_key', 'credits']);

  const credits = (await signup.journey())!;
  const provider = await selectOnboardingProvider(signup.settings, {
    expectedRevision: credits.revision, workspaceId: TEAM, providerId: 'anthropic',
  });
  assert.equal(provider.journey.selectedFunding, 'credits', 'choosing a provider keeps the choice');
  const trying = await startOnboardingTry(signup.settings, {
    expectedRevision: provider.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: INSTALLER,
  });
  await completeOnboardingJourney(signup.settings, trying.revision);
  const refused = await choose('own_key');
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'onboarding_complete' });
  assert.deepEqual(chosen, ['own_key', 'credits'], 'onboarding\'s own route is closed once it is complete');
  const switched = await admin('/admin/api/billing/funding', { method: 'POST', body: JSON.stringify({ funding: 'credits' }) });
  assert.equal(switched.status, 200, 'the Plan and credits page still switches after onboarding');
  assert.deepEqual(chosen, ['own_key', 'credits', 'credits']);

  configurePlatformBilling(undefined);
  await signup.settings.applySettingsPatch({ delete: [ONBOARDING_JOURNEY_KEY] });
  await beginOnboardingJourney(signup.settings);
  assert.equal((await choose('credits')).status, 404, 'no port, no choice');
});

test('a credits installation switches back to its own key only with a key for its default model\'s provider, and hears which Agents would stop', async (t) => {
  await withProviders(async () => {
    let funding: BillingFunding = 'credits';
    const chosen: BillingFunding[] = [];
    configurePlatformBilling({
      summary: async () => (funding === 'own_key' ? { funding } : {
        funding,
        balance: 900,
        plan: null,
        period: { start: new Date('2026-10-07T00:00:00Z'), end: new Date('2026-11-07T00:00:00Z') },
        use: { byAgent: [], byPerson: [] },
        offers: { plans: [], topUps: [] },
      }),
      checkout: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }),
      portal: async () => ({ url: 'https://billing.stripe.com/p/session/test' }),
      chooseFunding: async (_installationId, next) => { chosen.push(next); funding = next; },
    });
    t.after(() => configurePlatformBilling(undefined));
    const signup = await signUp(t);
    await signup.claim();
    const admin = signup.admin(await signup.ownerPrincipal());
    const current = (await signup.config.getWorkspaceModelDefault(TEAM))!;
    await signup.config.putWorkspaceModelDefault({
      workspaceId: TEAM, modelId: 'anthropic/claude-sonnet-5-5', provenance: 'admin_selected',
    }, current.revision);
    const agent = (id: string, model: string, enabled = true) => signup.config.createAgent({
      id, kind: 'user', name: id.replace('agent_', ''), instructions: 'Help.', enabled, lifecycle: 'active',
      model, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await agent('agent_Research', 'openai/gpt-5.6-terra');
    await agent('agent_Writer', 'openrouter/openai/gpt-5.6-terra');
    await agent('agent_Paused', 'openai/gpt-5.6-terra', false);
    const saveKey = async (provider: 'anthropic' | 'openrouter') => {
      const saved = await admin(`/admin/api/providers/${provider}/key`, {
        method: 'POST', body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS[provider] }),
      });
      assert.equal(saved.status, 200, await saved.clone().text());
    };
    const ownKey = async () => (await json(admin('/admin/api/billing'))).ownKey;
    const switchToOwnKey = () => admin('/admin/api/billing/funding', { method: 'POST', body: JSON.stringify({ funding: 'own_key' }) });

    assert.deepEqual(await ownKey(), { ready: false, provider: 'anthropic' });
    await saveKey('openrouter');
    assert.deepEqual(await ownKey(), { ready: false, provider: 'anthropic' }, 'a key for another provider is not enough');
    const refused = await switchToOwnKey();
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'own_key_missing', provider: 'anthropic' });
    assert.deepEqual(chosen, [], 'a workspace whose default model has no key stays on credits');

    await saveKey('anthropic');
    assert.deepEqual(await ownKey(), { ready: true, agentsWithoutKey: ['Research'] },
      'only an active, enabled Agent pinned to a provider with no key would stop');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await json(switchToOwnKey()), { funding: 'own_key', manage: true });
    }
    assert.deepEqual(chosen, ['own_key', 'own_key'], 'switching again asks the host for the same funding');
  });
});

test('the journey starts with the first Owner claim or not at all, and once', async (t) => {
  const db = new DoSqlStateDb(new FakeObjectStorage().asDurableObjectStorage());
  const settings = new SettingsStoreLogic(db);
  const started: number[] = [];
  let interrupted = true;
  const identity = facade(new IdentityStoreLogic(db, {
    ownerClaimed: (at) => {
      started.push(at);
      settings.applySettingsPatch(onboardingJourneyStart(at).patch);
      if (interrupted) throw new Error('interrupted after the journey started');
    },
  })) as unknown as IdentityStore;
  const backend = new NodeBetterAuthBackend(':memory:');
  t.after(() => backend.close());
  const claim = () => claimInstallerOwner({
    identity,
    environment: { backend, baseURL: ORIGIN, secret: SECRET },
    proof: { slackTeamId: TEAM, slackUserId: INSTALLER, displayName: 'Installer', eligibility: 'install_grant' },
    installGrant: { slackTeamId: TEAM, installerSlackUserId: INSTALLER },
    capability: 'atomic-claim-capability-0123456789abcdef',
  });
  await assert.rejects(claim(), /interrupted/);
  assert.equal((await identity.getOwnerClaim())?.status, 'reserved', 'the claim rolled back');
  assert.equal(settings.getSetting(ONBOARDING_JOURNEY_KEY), undefined, 'and the journey with it');
  interrupted = false;
  await claim();
  assert.equal((await identity.getOwnerClaim())?.status, 'active');
  assert.equal(parseOnboardingJourney(settings.getSetting(ONBOARDING_JOURNEY_KEY)!).state, 'active');
  await claim();
  assert.equal(started.length, 2, 'an Owner already claimed starts nothing');
  // A claim that lands once the Owner is active (an attempt racing the one
  // that won) resolves them again, and starts nothing on an installation that
  // signed up before the journey began with the claim.
  settings.applySettingsPatch({ delete: [ONBOARDING_JOURNEY_KEY] });
  const owner = (await identity.getOwnerClaim())!;
  const operation = (await identity.getAuthOperation(owner.operationId))!;
  const resolution = await identity.claimOwner({
    operationId: owner.operationId, organizationId: owner.organizationId!, slackTeamId: TEAM, slackUserId: INSTALLER,
    betterAuthUserId: operation.betterAuthUserId!, betterAuthMembershipId: operation.betterAuthMembershipId!,
  });
  assert.equal(resolution.membership.id, owner.membershipId);
  assert.equal(started.length, 2);
  assert.equal(settings.getSetting(ONBOARDING_JOURNEY_KEY), undefined);
});

test('standalone is unchanged: its state object starts nothing at an Owner claim, and Admin never lands in onboarding', async (t) => {
  const storage = new FakeObjectStorage();
  const stores = buildTagStateStores(new DoSqlStateDb(storage.asDurableObjectStorage()), {} as PlatformEnv, {
    gatewayLeaseOwner: 'test-standalone',
  });
  const identity = facade(stores.identity) as unknown as IdentityStore;
  const backend = new NodeBetterAuthBackend(':memory:');
  t.after(() => backend.close());
  await claimInstallerOwner({
    identity,
    environment: { backend, baseURL: ORIGIN, secret: SECRET },
    proof: { slackTeamId: TEAM, slackUserId: INSTALLER, displayName: 'Installer', eligibility: 'install_grant' },
    installGrant: { slackTeamId: TEAM, installerSlackUserId: INSTALLER },
    capability: 'standalone-claim-capability-0123456789abcdef',
  });
  assert.equal((await identity.getOwnerClaim())?.status, 'active');
  assert.equal(stores.settings.getSetting(ONBOARDING_JOURNEY_KEY), undefined);

  // Standalone's own setup lands its Owner in onboarding; plain Admin stays Admin.
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  await beginOnboardingJourney(settings);
  const app = createAdminRoutes({ store: config, settings, ...testAdminAuthority(TOKEN, ORIGIN) });
  const opened = await app.request(`${ORIGIN}/admin`, { headers: testAdminHeaders(TOKEN) });
  assert.equal(opened.status, 200);
  // Without Slack, its onboarding opens at its own Connect Slack step.
  const onboarding = await json(app.request(`${ORIGIN}/admin/api/onboarding`, { headers: testAdminHeaders(TOKEN) }));
  assert.equal(onboarding.stage, 'connect_slack');
  assert.equal((await app.request(`${ORIGIN}/admin/onboarding`, { headers: testAdminHeaders(TOKEN) })).status, 200);
});
