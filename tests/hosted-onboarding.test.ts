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
import { currentImagePrice } from '../src/images/request-record.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
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
import type { SlackStateStore } from '../src/slack/claim-store.ts';
import { opaqueId } from '../src/work/admission.ts';
import type { WorkStore } from '../src/work/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { NO_PLAN, TEAM_PLAN } from './helpers/billing-summaries.ts';
import { withDirectSlackInstall } from './helpers/direct-slack-install.ts';
import { withEnv } from './helpers/env.ts';
import { FAKE_PROVIDER_KEYS, FakeProvidersBackend } from './helpers/fake-providers.ts';
import { FakeObjectStorage, hostedInstallation } from './helpers/installation-objects.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';
import { onboardingRunFixture } from './helpers/onboarding-runs.ts';

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
const WORKSPACE_NAME = 'Violet';

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
  // Slack answers auth.test for the bot with its workspace's name, or refuses when `teamName` is unset.
  const slack: { teamId: string; teamName: string | undefined; calls: string[] } = { teamId: TEAM, teamName: WORKSPACE_NAME, calls: [] };
  const previousFetch = globalThis.fetch;
  const slackFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).pathname !== '/api/auth.test') return previousFetch(input, init);
    slack.calls.push(request.headers.get('authorization') ?? '');
    return Response.json(slack.teamName === undefined
      ? { ok: false, error: 'invalid_auth' }
      : { ok: true, team_id: slack.teamId, team: slack.teamName, user_id: BOT, app_id: APP });
  }) as typeof fetch;
  globalThis.fetch = slackFetch;
  const backend = new NodeBetterAuthBackend(':memory:');
  // Every landing decision here is read, never the fallback for a store that fails.
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    assert.notEqual(args[0], '[chickpea] Hosted onboarding state unavailable');
    warn(...args);
  };
  t.after(() => {
    console.warn = warn;
    // A test that wraps this in withProviders has already put its own fetch back.
    if (globalThis.fetch === slackFetch) globalThis.fetch = previousFetch;
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
  const admin = (
    principal: AuthPrincipal,
    stores: { config?: ConfigStore; settings?: SettingsStore; work?: WorkStore; slackState?: SlackStateStore } = {},
  ) => {
    const app = createAdminRoutes({
      store: stores.config ?? config, settings: stores.settings ?? settings, usage, slackCredentials: credentials,
      work: stores.work, slackState: stores.slackState,
      ...testAdminAuthority(TOKEN, ORIGIN, identity, principal),
    });
    return (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, {
      ...init,
      headers: { ...testAdminHeaders(TOKEN, { origin: ORIGIN }), 'content-type': 'application/json', ...init.headers },
    }, tenant.env);
  };
  return {
    tenant, identity, config, settings, owner, ownerPrincipal, admin, slack,
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

interface OnboardingPageEntry {
  initial: Record<string, unknown> | null;
  githubConnectPath: string | null;
  steps: Array<{ id: string; label: string }>;
}

async function adminPageEntry(response: Response | Promise<Response>): Promise<{ html: string; onboarding: OnboardingPageEntry | undefined }> {
  const html = await (await response).text();
  const config = html.match(/<script id="chickpea-admin-config" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(config, 'the page carries its config island');
  return { html, onboarding: (JSON.parse(config) as { onboarding?: OnboardingPageEntry }).onboarding };
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
  assert.deepEqual(onboarding.workspace, { id: TEAM, name: WORKSPACE_NAME });
  assert.equal(onboarding.slackAppId, APP);
  // Opening Admin lands the Owner in it.
  const landing = await admin('/admin');
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get('location'), '/admin/onboarding');
  assert.equal((await admin('/admin/onboarding')).status, 200);
  // A link with a purpose opens what it asks for.
  assert.equal((await admin('/admin?slack=updated')).status, 200);
});

test('a fresh install names its workspace on the first onboarding read, asking Slack once with its own bot', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  assert.equal(await signup.settings.getSetting(SLACK_SETTING_KEYS.teamName), undefined, 'a fresh install has stored no name');
  const admin = signup.admin(await signup.ownerPrincipal());

  const page = await adminPageEntry(admin('/admin/onboarding'));
  assert.deepEqual(page.onboarding?.initial?.workspace, { id: TEAM, name: WORKSPACE_NAME }, 'the first paint names it');
  const onboarding = await json(admin('/admin/api/onboarding'));
  assert.deepEqual(onboarding.workspace, { id: TEAM, name: WORKSPACE_NAME });
  assert.deepEqual(signup.slack.calls, ['Bearer xoxb-hosted-signup'], 'later reads use the stored name');
  assert.equal(await signup.settings.getSetting(SLACK_SETTING_KEYS.teamName), WORKSPACE_NAME);
});

test('when Slack cannot name the workspace, onboarding still reads, unnamed, and asks again next time', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  signup.slack.teamName = undefined;
  const admin = signup.admin(await signup.ownerPrincipal());
  const unnamed = await json(admin('/admin/api/onboarding'));
  assert.equal(unnamed.stage, 'choose_provider');
  assert.deepEqual(unnamed.workspace, { id: TEAM, name: null });
  signup.slack.teamName = 'Another workspace';
  signup.slack.teamId = 'TANOTHER';
  assert.deepEqual((await json(admin('/admin/api/onboarding'))).workspace, { id: TEAM, name: null }, 'only its own workspace names it');

  signup.slack.teamName = WORKSPACE_NAME;
  signup.slack.teamId = TEAM;
  assert.deepEqual((await json(admin('/admin/api/onboarding'))).workspace, { id: TEAM, name: WORKSPACE_NAME });
  assert.equal(signup.slack.calls.length, 3);
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
    const page = await adminPageEntry(slackUnread('/admin/onboarding'));
    assert.match(page.html, /<html/);
    assert.deepEqual(page.onboarding?.initial, null, 'the page serves without the journey, which it then asks for');
  }), [['[chickpea] Hosted onboarding state unavailable'], ['[chickpea] Onboarding state unavailable']]);
  assert.deepEqual(await warnings(async () => {
    const page = await adminPageEntry(journeyUnread('/admin/onboarding'));
    assert.deepEqual(page.onboarding?.initial, null);
    assert.deepEqual(page.onboarding?.steps.map(({ label }) => label), ['Add to Slack', 'Choose provider', 'Choose model', 'Try Chickpea']);
  }), [['[chickpea] Onboarding state unavailable']]);
});

test('the onboarding page arrives with the journey and its steps, painted as onboarding with nothing loading', async (t) => {
  const host = hostPorts(t);
  const signup = await signUp(t);
  await signup.claim();
  for (const principal of [await signup.ownerPrincipal(), principalFor('admin')]) {
    const admin = signup.admin(principal);
    const page = await adminPageEntry(admin('/admin/onboarding'));
    assert.deepEqual(page.onboarding?.initial, await json(admin('/admin/api/onboarding')), `${principal.role} gets the journey the API returns`);
    assert.equal(page.onboarding?.githubConnectPath, null);
    assert.match(page.html, /<div id="app" class="frame onboarding-frame" aria-busy="true"><main class="onboarding-shell"><aside class="onboarding-scene [^"]+" data-scene="(setting-up|own-model)">[\s\S]*?<\/aside><div class="onboarding-shell-inner"><div class="onboarding-brand-row"><div class="onboarding-brand"><span class="avatar">/);
    assert.doesNotMatch(page.html, /Loading|cloudflare · workers|local · node|aria-label="Admin navigation"|class="topbar"/);
  }
  const owner = await adminPageEntry(signup.admin(await signup.ownerPrincipal())('/admin/onboarding'));
  assert.deepEqual(owner.onboarding?.steps, [{ id: 'slack', label: 'Add to Slack', note: 'Your workspace' }, { id: 'try', label: 'Try Chickpea', note: 'Say hi' }],
    'an Owner where the host sells Chickpea\'s models');
  const firstPaint = owner.html.slice(0, owner.html.indexOf('<script'));
  assert.ok(firstPaint.includes('</div><ol class="onboarding-orientation" role="list" aria-label="Onboarding progress">' +
    '<li class="active" aria-current="step"><span class="onboarding-step-label">Add to Slack</span><span class="onboarding-step-note">Your workspace</span></li>' +
    '<li class=""><span class="onboarding-step-label">Try Chickpea</span><span class="onboarding-step-note">Say hi</span></li></ol></div></main>'),
    'the step bar is in the server\'s first paint, before the script runs');
  assert.match(firstPaint, /<main class="onboarding-shell"><aside class="onboarding-scene onboarding-tone-apricot" data-scene="setting-up">[\s\S]*<p class="onboarding-caption">Moving in…<\/p><\/aside>/,
    'so is Chickpea moving in');
  const admin = await adminPageEntry(signup.admin(principalFor('admin'))('/admin/onboarding'));
  assert.deepEqual(admin.onboarding?.steps.map(({ id }) => id), ['slack', 'provider', 'model', 'try'], 'an Admin chooses no funding');
  assert.deepEqual(host.chosen, [], 'opening the page sets nothing up');

  const plain = await adminPageEntry(signup.admin(await signup.ownerPrincipal())('/admin?slack=updated'));
  assert.equal(plain.onboarding, undefined, 'only the onboarding page carries the journey');
  assert.match(plain.html, /<div id="app" class="frame primary-admin-shell" aria-busy="true">[\s\S]*Loading Chickpea&hellip;/);
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
    assert.equal(await signup.config.getWorkspaceModelRole(TEAM, 'image'), undefined, 'on its own key, onboarding chooses no image model');
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

test('Try finishes as soon as Chickpea\'s answer shows in the Owner\'s DM, before its run settles', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  const begun = (await signup.journey())!;
  const provider = await selectOnboardingProvider(signup.settings, { expectedRevision: begun.revision, workspaceId: TEAM, providerId: 'anthropic' });
  await startOnboardingTry(signup.settings, {
    expectedRevision: provider.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: INSTALLER, tryStartedAt: 100,
  });
  const streaming = onboardingRunFixture({
    run: {
      actorRef: opaqueId('actor', `slack:${TEAM}:${INSTALLER}`), status: 'executing', terminalDisposition: null,
      deliveryStatus: 'pending', deliveryRef: null, settledAt: null,
    },
    binding: { externalAccountId: opaqueId('account', `slack:${TEAM}`) },
  });
  const work = { listRuns: async () => ({ items: [streaming], nextCursor: null }) } as unknown as WorkStore;
  let acknowledgedByteLength = 0;
  const slackState = {
    getRunPresentation: async (runId: string) => runId === streaming.run.id
      ? { root: { channelId: 'DOWNER' }, stream: { acknowledgedByteLength } }
      : undefined,
  } as unknown as SlackStateStore;
  const admin = signup.admin(await signup.ownerPrincipal(), { work, slackState });
  assert.equal((await json(admin('/admin/api/onboarding'))).stage, 'try', 'a stream showing only its plan is not a reply yet');
  acknowledgedByteLength = 24;
  assert.equal((await json(admin('/admin/api/onboarding'))).stage, 'complete');
  assert.equal((await signup.journey())?.journey.state, 'complete');
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

test('an installation on Chickpea\'s models chooses a provider with no key; one on its own key still needs one', async (t) => {
  let funding: 'platform' | 'customer' = 'customer';
  configurePlatformFunding({
    funding: async () => funding,
    admit: async () => 'admitted',
    charge: async () => undefined,
    ...NO_RUN_FEES,
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

function hostPorts(t: TestContext) {
  const host = { funding: 'own_key' as BillingFunding, chosen: [] as BillingFunding[], down: false };
  configurePlatformBilling({
    summary: async () => ({ ...NO_PLAN, funding: host.funding }),
    checkout: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }),
    portal: async () => ({ url: 'https://billing.stripe.com/p/session/test' }),
    chooseFunding: async (_installationId, funding) => {
      host.chosen.push(funding);
      if (host.down) throw new Error('The host is down.');
      host.funding = funding;
    },
  });
  configurePlatformFunding({
    funding: async () => host.funding === 'platform' ? 'platform' : 'customer',
    admit: async () => 'admitted',
    charge: async () => undefined,
    ...NO_RUN_FEES,
  });
  t.after(() => {
    configurePlatformBilling(undefined);
    resetPlatformFundingForTests();
  });
  return host;
}

const startOnPlatform = (as: ReturnType<Awaited<ReturnType<typeof signUp>>['admin']>) =>
  as('/admin/api/onboarding/platform', { method: 'POST' });

test('where the host sells Chickpea\'s models, onboarding chooses them, Opus 5.5 and the default image model once, and goes straight to Try', async (t) => {
  const host = hostPorts(t);
  const signup = await signUp(t);
  await signup.claim();
  const owner = await signup.ownerPrincipal();
  const admin = signup.admin(owner);
  const started = await startOnPlatform(admin);
  assert.equal(started.status, 200, await started.clone().text());
  const body = await started.json() as { stage: string; providerId: string; modelId: string; revision: string };
  assert.equal(body.stage, 'try');
  assert.equal(body.providerId, 'anthropic');
  assert.equal(body.modelId, 'anthropic/claude-opus-5-5');
  assert.deepEqual(host.chosen, ['platform']);
  const workspaceDefault = (await signup.config.getWorkspaceModelDefault(TEAM))!;
  assert.equal(workspaceDefault.modelId, 'anthropic/claude-opus-5-5');
  const { journey, revision } = (await signup.journey())!;
  assert.equal(journey.agentId, 'agent_chickpea');
  assert.equal(journey.selectedModelId, 'anthropic/claude-opus-5-5');
  assert.equal(body.revision, revision);
  const imageRole = await signup.config.getWorkspaceModelRole(TEAM, 'image');
  assert.ok(imageRole, 'the default image model is chosen');
  assert.equal(imageRole.modelId, 'openai/gpt-image-2.5-flare');
  assert.equal(imageRole.lastChangedByMembershipId, owner.membershipId);

  const anotherOwner = signup.admin(principalFor('owner', { userId: 'user_second_owner', membershipId: 'membership_second_owner' }));
  for (const as of [admin, anotherOwner]) {
    const again = await json<{ stage: string; revision: string }>(startOnPlatform(as));
    assert.equal(again.stage, 'try');
    assert.equal(again.revision, revision);
  }
  assert.deepEqual(host.chosen, ['platform'], 'the host is asked once');
  assert.equal((await signup.journey())!.revision, revision);
  assert.equal((await signup.config.getWorkspaceModelDefault(TEAM))!.revision, workspaceDefault.revision);
  assert.equal((await signup.config.getWorkspaceModelRole(TEAM, 'image'))!.revision, imageRole.revision);
});

for (const [kept, modelId] of [
  ['an image role set to Not set', undefined],
  ['another image model', 'openai/gpt-image-2.5-sunburst'],
] as const) {
  test(`setting up on Chickpea's models keeps ${kept}`, async (t) => {
    hostPorts(t);
    const signup = await signUp(t);
    await signup.claim();
    const chosen = await signup.config.putWorkspaceModelRole({
      workspaceId: TEAM, role: 'image', ...(modelId ? { modelId } : {}),
    }, 0);
    const started = await json<{ stage: string }>(startOnPlatform(signup.admin(await signup.ownerPrincipal())));
    assert.equal(started.stage, 'try');
    assert.deepEqual(await signup.config.getWorkspaceModelRole(TEAM, 'image'), chosen);
  });
}

test('setting up on Chickpea\'s models chooses no image model that Chickpea\'s models cannot serve, and still chooses the chat model', async (t) => {
  const claimedAt = Date.UTC(2026, 9, 7, 12);
  const imagePrice = currentImagePrice('openai', 'gpt-image-2.5-flare', claimedAt);
  assert.ok(imagePrice, 'the default image model is priced at the claim');
  t.mock.timers.enable({ apis: ['Date'], now: claimedAt });
  hostPorts(t);
  const signup = await signUp(t);
  await signup.claim();
  const admin = signup.admin(await signup.ownerPrincipal());
  t.mock.timers.setTime(imagePrice.version.staleAfter);
  const started = await startOnPlatform(admin);
  assert.equal(started.status, 200, await started.clone().text());
  assert.equal((await started.json() as { stage: string }).stage, 'try');
  assert.equal((await signup.config.getWorkspaceModelDefault(TEAM))?.modelId, 'anthropic/claude-opus-5-5');
  assert.equal(await signup.config.getWorkspaceModelRole(TEAM, 'image'), undefined);
});

test('when the host cannot record Chickpea\'s models, onboarding changes nothing, and trying again finishes', async (t) => {
  const host = hostPorts(t);
  const signup = await signUp(t);
  await signup.claim();
  const admin = signup.admin(await signup.ownerPrincipal());
  const before = (await signup.journey())!.revision;
  const defaultBefore = await signup.config.getWorkspaceModelDefault(TEAM);
  host.down = true;
  const failed = await startOnPlatform(admin);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'internal_error' });
  assert.equal((await signup.journey())!.revision, before);
  assert.deepEqual(await signup.config.getWorkspaceModelDefault(TEAM), defaultBefore);
  host.down = false;
  assert.equal((await json(startOnPlatform(admin))).stage, 'try');
  assert.deepEqual(host.chosen, ['platform', 'platform']);
  assert.equal((await signup.config.getWorkspaceModelDefault(TEAM))?.modelId, 'anthropic/claude-opus-5-5');
});

test('a Member, an Admin, a finished journey, or a host with no billing port changes nothing; the Plan page still switches after onboarding', async (t) => {
  const host = hostPorts(t);
  const signup = await signUp(t);
  await signup.claim();
  const admin = signup.admin(await signup.ownerPrincipal());
  for (const role of ['admin', 'member'] as const) {
    assert.equal((await startOnPlatform(signup.admin(principalFor(role)))).status, 403, role);
  }
  const begun = (await signup.journey())!;
  const provider = await selectOnboardingProvider(signup.settings, {
    expectedRevision: begun.revision, workspaceId: TEAM, providerId: 'anthropic',
  });
  const trying = await startOnboardingTry(signup.settings, {
    expectedRevision: provider.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: INSTALLER,
  });
  const complete = await completeOnboardingJourney(signup.settings, trying.revision);
  assert.equal((await json(startOnPlatform(admin))).stage, 'complete');
  assert.equal((await signup.journey())!.revision, complete.revision);
  assert.deepEqual(host.chosen, [], 'nothing is asked of the host');
  assert.equal(await signup.config.getWorkspaceModelRole(TEAM, 'image'), undefined, 'nor is an image model chosen');
  const switched = await admin('/admin/api/billing/funding', { method: 'POST', body: JSON.stringify({ funding: 'platform' }) });
  assert.equal(switched.status, 200, 'the Plan page still switches after onboarding');
  assert.deepEqual(host.chosen, ['platform']);
  const image = await signup.config.getWorkspaceModelRole(TEAM, 'image');
  assert.equal(image?.modelId, 'openai/gpt-image-2.5-flare', 'the switch chooses the image model onboarding would have');

  configurePlatformBilling(undefined);
  await signup.settings.applySettingsPatch({ delete: [ONBOARDING_JOURNEY_KEY] });
  await beginOnboardingJourney(signup.settings);
  assert.equal((await startOnPlatform(admin)).status, 404, 'no port, nothing to choose');
  assert.deepEqual(await signup.config.getWorkspaceModelRole(TEAM, 'image'), image, 'no port, no change to the image model');
});

test('an installation on Chickpea\'s models switches back to its own key only with a key for its default model\'s provider, and hears which Agents would stop', async (t) => {
  await withProviders(async () => {
    let funding: BillingFunding = 'platform';
    const chosen: BillingFunding[] = [];
    configurePlatformBilling({
      summary: async () => ({ ...TEAM_PLAN, funding }),
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
    const ownKey = async () => (await json(admin('/admin/api/billing'))).switchFunding;
    const switchToOwnKey = () => admin('/admin/api/billing/funding', { method: 'POST', body: JSON.stringify({ funding: 'own_key' }) });

    assert.deepEqual(await ownKey(), { to: 'own_key', ready: false, needs: 'key', provider: 'anthropic' });
    await saveKey('openrouter');
    assert.deepEqual(await ownKey(), { to: 'own_key', ready: false, needs: 'key', provider: 'anthropic' }, 'a key for another provider is not enough');
    const refused = await switchToOwnKey();
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'own_key_missing', provider: 'anthropic' });
    assert.deepEqual(chosen, [], 'a workspace whose default model has no key stays on Chickpea\'s models');

    await saveKey('anthropic');
    assert.deepEqual(await ownKey(), { to: 'own_key', ready: true, agentsWithoutKey: ['Research'] },
      'only an active, enabled Agent pinned to a provider with no key would stop');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const switched = await json(switchToOwnKey());
      assert.equal(switched.funding, 'own_key');
      assert.deepEqual(switched.switchFunding, { to: 'platform' });
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
    ownerClaimed: ({ at }) => {
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

function receiptOutbox(db: { all(sql: string): Record<string, unknown>[] }) {
  return db.all('SELECT status, destination_json, receipt_json FROM management_receipt_outbox').map((row) => ({
    status: row.status,
    destination: JSON.parse(String(row.destination_json)),
    receipt: JSON.parse(String(row.receipt_json)),
  }));
}

test('the first Owner claim queues Chickpea\'s introduction to the Owner\'s DM, once', async (t) => {
  const signup = await signUp(t);
  assert.deepEqual(receiptOutbox(signup.tenant.db), []);
  await signup.claim();
  await activateInstallerOwner({ ...signup.owner, request: new Request(`${ORIGIN}/start/install/callback`) });
  await signup.claim();
  const owner = (await signup.identity.getOwnerClaim())!;
  const operation = (await signup.identity.getAuthOperation(owner.operationId))!;
  await signup.identity.claimOwner({
    operationId: owner.operationId, organizationId: owner.organizationId!, slackTeamId: TEAM, slackUserId: INSTALLER,
    betterAuthUserId: operation.betterAuthUserId!, betterAuthMembershipId: operation.betterAuthMembershipId!,
  });
  await signup.identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER', displayName: 'Member' });
  assert.deepEqual(receiptOutbox(signup.tenant.db), [{
    status: 'pending',
    destination: { kind: 'slack_dm', workspaceId: TEAM, slackUserId: INSTALLER },
    receipt: { kind: 'chickpea_introduction', trigger: 'first_owner' },
  }]);
});

test('standalone is unchanged: its state object starts nothing at an Owner claim, and Admin never lands in onboarding', async (t) => {
  const storage = new FakeObjectStorage();
  const db = new DoSqlStateDb(storage.asDurableObjectStorage());
  const stores = buildTagStateStores(db, {} as PlatformEnv, {
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
  assert.deepEqual(receiptOutbox(db), [], 'standalone introduces its Owner from first-Owner activation instead');

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
  const page = await adminPageEntry(app.request(`${ORIGIN}/admin/onboarding`, { headers: testAdminHeaders(TOKEN) }));
  assert.deepEqual(page.onboarding?.initial, onboarding);
  assert.equal(page.onboarding?.githubConnectPath, null);
  assert.deepEqual(page.onboarding?.steps.map(({ label }) => label), ['Connect Slack', 'Choose provider', 'Choose model', 'Try Chickpea']);
  assert.match(page.html, /<span class="onboarding-environment">local · node<\/span>/, 'standalone keeps its label');
});

test('a fresh standalone install names its workspace on the first onboarding read', async () => {
  await withDirectSlackInstall({
    answer: (method) => method === 'auth.test'
      ? { ok: true, team_id: 'T1', team: WORKSPACE_NAME, user_id: 'UBOT', app_id: 'A1' }
      : undefined,
  }, async ({ stores, calls }) => {
    assert.equal(await stores.settings.getSetting(SLACK_SETTING_KEYS.teamName), undefined);
    await beginOnboardingJourney(stores.settings);
    const app = createAdminRoutes({ ...testAdminAuthority(TOKEN, ORIGIN) });
    const read = () => json(app.request(`${ORIGIN}/admin/api/onboarding`, { headers: testAdminHeaders(TOKEN) }));
    const onboarding = await read();
    assert.equal(onboarding.stage, 'choose_provider');
    assert.deepEqual(onboarding.workspace, { id: 'T1', name: WORKSPACE_NAME });
    assert.deepEqual((await read()).workspace, { id: 'T1', name: WORKSPACE_NAME });
    assert.deepEqual(calls.map(({ method }) => method), ['auth.test'], 'asked once, then stored');
  });
});

test('Admin\'s shell gives Owners and Admins the welcome\'s first name and prompt, and Slack status names the app to open', async (t) => {
  const signup = await signUp(t);
  await signup.claim();
  const firstRun = async (principal: AuthPrincipal) => {
    const html = await (await signup.admin(principal)('/admin/agents')).text();
    const config = html.match(/<script id="chickpea-admin-config" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(config);
    return (JSON.parse(config) as { firstRun?: unknown }).firstRun;
  };
  const owner = await signup.ownerPrincipal();
  assert.deepEqual(await firstRun(owner), {
    firstName: 'Installer',
    prompt: `Connect my coding agent to my Chickpea using ${ORIGIN}/connect.md, then help me create my first Chickpea Agent.`,
  });
  assert.equal(await firstRun(principalFor('member')), undefined, 'Members have no welcome');
  const slack = await json(signup.admin(owner)('/admin/api/slack-connection'));
  assert.equal(slack.appId, APP);
});
