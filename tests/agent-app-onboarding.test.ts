import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { configureHostedGithub, configureHostedGithubConnect, resetHostedGithubForTests } from '../src/config/hosted-github.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { rotateInstallationModelCredential } from '../src/config/model-credential-refs.ts';
import {
  beginOnboardingJourney,
  ONBOARDING_JOURNEY_KEY,
  parseOnboardingJourney,
  readOnboardingJourney,
  selectOnboardingProvider,
  settleOnboardingGithubStep,
  settleOnboardingSlackAppsStep,
  startOnboardingTry,
} from '../src/config/onboarding-state.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { AGENT_SLACK_APPS_SETTING_KEY } from '../src/slack/agent-apps/setting.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * Hosted onboarding's optional Slack apps step: offered after the model and
 * before Connect GitHub, to the Owner only, where the host offers each Agent
 * its own Slack app.
 */

const TOKEN = 'agent-app-onboarding-token';
const TEAM = 'TONBOARD';
const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: `inst_${'0123456789abcdef'.repeat(2)}` });
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
  addUrl: (agentId) => `https://cloud.test/slack/agent-apps/add/${agentId}`,
};
const GITHUB_APP = { appId: '900100', appSlug: 'chickpea-test', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----', botUserId: 900_200 };

type Env = Record<string, unknown> | null;
type View = { stage: string; revision: string; slackFreePlan?: boolean; githubConnectPath?: string };

function principal(role: AuthPrincipal['role'], ids: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_test', role,
    authenticatorKind: 'test_slack_session', credentialId: `session_${role}`, correlationId: `request_${role}`, machine: false, ...ids,
  };
}

/** The host's ports: Agent apps unless `port` is false, and Connect GitHub when `github` is true. */
function host(t: TestContext, options: { port?: boolean; github?: boolean } = {}) {
  configureAgentSlackApps(options.port === false ? undefined : HOST);
  resetHostedGithubForTests();
  if (options.github) {
    configureHostedGithub({ app: () => GITHUB_APP, bindings: { list: async () => [], disconnect: async () => false, reportGone() {} } });
    configureHostedGithubConnect({ path: '/github/connect' });
  }
  t.after(() => {
    configureAgentSlackApps(undefined);
    configureHostedGithub(undefined);
    configureHostedGithubConnect(undefined);
  });
}

function admin(t: TestContext, as: { role?: AuthPrincipal['role']; agents?: CustomAgentConfig[]; identity?: SqliteIdentityStore; principal?: AuthPrincipal } = {}) {
  const store = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: as.agents ?? [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { store.close(); settings.close(); });
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store, settings, knownProviders: new Set(['local-stub']),
    ...testAdminAuthority(TOKEN, undefined, as.identity, as.principal ?? principal(as.role ?? 'owner')),
  }));
  // `null` is standalone: an omitted env is the hosted one.
  const request = (path: string, init: RequestInit = {}, env: Env = HOSTED) => app.request(path, {
    ...init, headers: { ...testAdminHeaders(TOKEN), 'content-type': 'application/json', ...init.headers },
  }, env ?? undefined);
  const read = async (env: Env = HOSTED) => await (await request('/admin/api/onboarding', {}, env)).json() as View;
  const settle = (expectedRevision: string, env: Env = HOSTED) =>
    request('/admin/api/onboarding/slack-apps', { method: 'POST', body: JSON.stringify({ expectedRevision }) }, env);
  return { store, settings, request, read, settle };
}

/** A journey whose Owner chose the model while the step was offered: Try has started, the step is still open. */
async function atSlackApps(t: TestContext, as: Parameters<typeof admin>[1] = {}) {
  const hosted = admin(t, as);
  await hosted.store.ensureWorkspaceInstallation({
    workspaceId: TEAM, teamId: TEAM, appId: 'AONBOARD', botUserId: 'UONBOARDBOT',
    gatewayBindingId: 'onboarding-gateway-binding', transportMode: 'gateway', runtimeContract: 'chickpea-v1',
  });
  const begun = await beginOnboardingJourney(hosted.settings, 100);
  const provider = await selectOnboardingProvider(hosted.settings, { expectedRevision: begun.revision, workspaceId: TEAM, providerId: 'anthropic' });
  await startOnboardingTry(hosted.settings, {
    expectedRevision: provider.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: 'UONBOARD', tryStartedAt: 300,
  });
  return hosted;
}

const journey = async (settings: SqliteSettingsStore) => (await readOnboardingJourney(settings))!.journey;
const turnOn = (settings: SqliteSettingsStore) =>
  settings.setSetting(AGENT_SLACK_APPS_SETTING_KEY, JSON.stringify({ mode: 'own_app', changedBy: 'UOWNER', changedAt: 200 }));

test('the Owner meets Slack apps after the model and before Connect GitHub; Skip for now records it, moves on and changes nothing else', async (t) => {
  host(t, { github: true });
  const { settings, read, settle } = await atSlackApps(t);
  const before = await read();
  assert.equal(before.stage, 'slack_apps');
  assert.equal('slackFreePlan' in before, false, 'nothing known about the plan, so no line');
  assert.equal((await settle('stale')).status, 409);
  const skipped = await settle(before.revision);
  assert.equal(skipped.status, 200);
  assert.equal((await skipped.json() as View).stage, 'connect_github');
  const stored = await journey(settings);
  assert.ok(stored.slackAppsStepAt, 'the skip is recorded');
  assert.equal(stored.githubStepAt, undefined, 'Connect GitHub is still to come');
  assert.equal(await settings.getSetting(AGENT_SLACK_APPS_SETTING_KEY), undefined, 'the setting stays off');
  assert.equal((await read()).stage, 'connect_github');
  const after = await read();
  assert.equal((await (await settle(after.revision)).json() as View).revision, after.revision, 'settling again changes nothing');
});

test('with no Connect GitHub to offer, the step leads to Try and settles GitHub as starting Try would have', async (t) => {
  host(t);
  const { settings, read, settle } = await atSlackApps(t);
  assert.equal(await journey(settings).then((stored) => stored.githubStepAt), undefined, 'waits for the open step');
  const skipped = await (await settle((await read()).revision)).json() as View;
  assert.equal(skipped.stage, 'try');
  const stored = await journey(settings);
  assert.equal(stored.githubStepAt, stored.slackAppsStepAt);
  // The host installs its connect path later: the journey stays at Try.
  host(t, { github: true });
  assert.equal((await read()).stage, 'try');
});

test('a workspace whose Owner already turned the setting on reads the step as done', async (t) => {
  host(t, { github: true });
  const { settings, read } = await atSlackApps(t);
  await turnOn(settings);
  assert.equal((await read()).stage, 'connect_github');
  assert.ok((await journey(settings)).slackAppsStepAt, 'recorded, so turning it off later never brings the step back');
  await settings.setSetting(AGENT_SLACK_APPS_SETTING_KEY, JSON.stringify({ mode: 'shared', changedBy: 'UOWNER', changedAt: 300 }));
  assert.equal((await read()).stage, 'connect_github');
});

test('the step is not offered, and cannot be settled, where the host offers no Agent apps, to anyone but the Owner, or standalone', async (t) => {
  host(t, { port: false, github: true });
  const unported = await atSlackApps(t);
  const plain = await unported.read();
  assert.equal(plain.stage, 'connect_github');
  assert.equal((await unported.settle(plain.revision)).status, 404);

  host(t, { github: true });
  for (const role of ['admin', 'member'] as const) {
    const other = await atSlackApps(t, { role });
    const view = await other.read();
    if (role === 'admin') assert.equal(view.stage, 'connect_github');
    const refused = await other.settle((await readOnboardingJourney(other.settings))!.revision);
    assert.equal(refused.status, 403, role);
    assert.equal((await journey(other.settings)).slackAppsStepAt, undefined, `${role}: nothing written`);
  }
  const owner = await atSlackApps(t, { principal: principal('owner', { machine: true, authenticatorKind: 'personal_token' }) });
  assert.equal((await owner.settle((await readOnboardingJourney(owner.settings))!.revision)).status, 403, "an Owner's personal token is not the Owner");

  const standalone = await atSlackApps(t);
  const view = await standalone.read(null);
  assert.equal(view.stage, 'try');
  assert.equal((await standalone.settle(view.revision, null)).status, 404);
});

test('settling the step before the model is a conflict, and writes nothing', async (t) => {
  host(t);
  const hosted = admin(t);
  const begun = await beginOnboardingJourney(hosted.settings, 100);
  const provider = await selectOnboardingProvider(hosted.settings, { expectedRevision: begun.revision, workspaceId: TEAM, providerId: 'anthropic' });
  const early = await hosted.settle(provider.revision);
  assert.equal(early.status, 409);
  assert.deepEqual(await early.json(), { error: 'onboarding_try_required' });
  assert.equal((await readOnboardingJourney(hosted.settings))?.revision, provider.revision);
});

function agent(id: string, presence: Partial<NonNullable<CustomAgentConfig['slackPresence']>>, lifecycle: CustomAgentConfig['lifecycle'] = 'active'): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name: id, instructions: 'Help.', enabled: true, lifecycle,
    editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: {
      requestedHandle: id, normalizedHandle: id, desiredState: 'active', health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: id }, ...presence,
    } as NonNullable<CustomAgentConfig['slackPresence']>,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

test("the free-plan line shows only where Chickpea already knows: Slack refused an Agent a handle for the workspace's plan", async (t) => {
  host(t);
  const refused = agent('support', { health: 'needs_attention', errorCode: 'paid_plan_required' });
  assert.equal((await (await atSlackApps(t, { agents: [refused] })).read()).slackFreePlan, true);
  for (const agents of [
    [],
    [agent('sales', { userGroupId: 'S1' })],
    [agent('policy', { health: 'needs_attention', errorCode: 'user_group_policy_denied' })],
    [agent('old', { health: 'needs_attention', errorCode: 'paid_plan_required' }, 'archived')],
  ]) {
    assert.equal('slackFreePlan' in await (await atSlackApps(t, { agents })).read(), false, JSON.stringify(agents.map((a) => a.id)));
  }
});

/** An Owner (or another role) at Choose model, signed in as a Slack user of the workspace, and the request that starts Try. */
async function atModel(t: TestContext, role: AuthPrincipal['role'], env: Env = HOSTED) {
  const identity = new SqliteIdentityStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => { identity.close(); usage.close(); invalidateProviderKeyCache(); });
  invalidateProviderKeyCache();
  const person = await createSlackOwner(identity, { teamId: TEAM, userId: 'UONBOARD', suffix: `slack-apps-${role}` });
  const hosted = admin(t, {
    identity,
    principal: principal(role, { userId: person.user.id, membershipId: person.membership.id, organizationId: person.membership.organizationId }),
  });
  await hosted.store.ensureWorkspaceInstallation({
    workspaceId: TEAM, teamId: TEAM, appId: 'AONBOARD', botUserId: 'UONBOARDBOT',
    gatewayBindingId: 'onboarding-gateway-binding', transportMode: 'gateway', runtimeContract: 'chickpea-v1',
  });
  await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: 'slack-apps-onboarding-test-key' }, { env: env ?? undefined, settings: hosted.settings, usage });
  const begun = await beginOnboardingJourney(hosted.settings, 100);
  const provider = await selectOnboardingProvider(hosted.settings, { expectedRevision: begun.revision, workspaceId: TEAM, providerId: 'anthropic' });
  const workspace = await (await hosted.request('/admin/api/workspace-model-default', {}, env)).json() as { workspaceDefault: { revision: number } };
  const tried = await hosted.request('/admin/api/onboarding/try', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: provider.revision, modelId: 'anthropic/claude-sonnet-5', expectedDefaultRevision: workspace.workspaceDefault.revision }),
  }, env);
  assert.equal(tried.status, 200, await tried.clone().text());
  return { stage: (await tried.json() as View).stage, journey: await journey(hosted.settings) };
}

test('choosing the model opens the step for the Owner; where it is not offered, its time is set as Try starts', async (t) => {
  useDeploymentKeyring(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network in this test'); });
  host(t);
  const owner = await atModel(t, 'owner');
  assert.equal(owner.stage, 'slack_apps');
  assert.equal(owner.journey.slackAppsStepAt, undefined);
  assert.equal(owner.journey.githubStepAt, undefined, 'GitHub, not offered, is settled with the open step');

  const other = await atModel(t, 'admin');
  assert.equal(other.stage, 'try');
  assert.equal(other.journey.slackAppsStepAt, other.journey.tryStartedAt);
  assert.equal(other.journey.githubStepAt, other.journey.tryStartedAt);

  host(t, { port: false });
  const unported = await atModel(t, 'owner');
  assert.equal(unported.stage, 'try');
  assert.equal(unported.journey.slackAppsStepAt, unported.journey.tryStartedAt);

  host(t);
  const standalone = await atModel(t, 'owner', null);
  assert.equal(standalone.stage, 'try');
  assert.equal(standalone.journey.slackAppsStepAt, undefined, 'standalone never records the step');
});

test('a journey stored before the step existed reads as this build expects', async (t) => {
  host(t, { github: true });
  // Stored by an older build: Try started and Connect GitHub settled.
  const past = await atSlackApps(t);
  const raw = JSON.parse((await readOnboardingJourney(past.settings))!.revision) as Record<string, unknown>;
  delete raw.slackAppsStepAt;
  raw.githubStepAt = 400;
  await past.settings.setSetting(ONBOARDING_JOURNEY_KEY, JSON.stringify(raw));
  assert.equal(parseOnboardingJourney(JSON.stringify(raw)).slackAppsStepAt, 400, 'past GitHub means past the step before it');
  assert.equal((await past.read()).stage, 'try', 'a journey that reached Try is never sent back');

  // Stored by an older build at Connect GitHub: the step before it is still open.
  const atGithub = await atSlackApps(t);
  assert.equal((await atGithub.read()).stage, 'slack_apps');

  // What an older build reads from this build's journey: the same fields, and one it does not know.
  const settled = await settleOnboardingSlackAppsStep(atGithub.settings, (await readOnboardingJourney(atGithub.settings))!.revision, { githubStepNotOffered: false, at: 500 });
  const stored = JSON.parse(settled.revision) as Record<string, unknown>;
  delete stored.slackAppsStepAt;
  const { slackAppsStepAt: _known, ...rest } = settled.journey;
  assert.deepEqual(parseOnboardingJourney(JSON.stringify(stored)), rest);
});

test('a journey an older build stored before the model, or finished, is where it was', async (t) => {
  host(t, { github: true });
  const stored = async (raw: Record<string, unknown>) => {
    const hosted = await atSlackApps(t);
    await hosted.settings.setSetting(ONBOARDING_JOURNEY_KEY, JSON.stringify(raw));
    return hosted;
  };
  const early = await stored({ version: 2, state: 'active', startedAt: 100, selectedWorkspaceId: TEAM, selectedProviderId: 'anthropic' });
  const atModel = await early.read();
  assert.equal(atModel.stage, 'choose_model');
  assert.equal((await early.settle(atModel.revision)).status, 409, 'the step waits for the model');
  assert.equal((await journey(early.settings)).slackAppsStepAt, undefined);

  const tried = { version: 2, state: 'complete', startedAt: 100, agentId: 'agent_chickpea', selectedWorkspaceId: TEAM, selectedProviderId: 'anthropic',
    selectedModelId: 'anthropic/claude-sonnet-5', trySlackUserId: 'UONBOARD', tryStartedAt: 300, completedAt: 500 };
  // Finished past Connect GitHub, and finished while still at it: neither is reopened, and settling writes nothing.
  for (const raw of [{ ...tried, githubStepAt: 400 }, tried]) {
    const done = await stored(raw);
    const view = await done.read();
    assert.equal(view.stage, 'complete');
    assert.equal(((await (await done.settle(view.revision)).json()) as View).stage, 'complete');
    assert.equal(await done.settings.getSetting(ONBOARDING_JOURNEY_KEY), JSON.stringify(raw), 'stored as the older build left it');
  }
});

test('the step is part of the journey: it follows the model, Connect GitHub settles it too, and choosing a provider again resets it', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const begun = await beginOnboardingJourney(settings, 100);
    await assert.rejects(settleOnboardingSlackAppsStep(settings, begun.revision, { githubStepNotOffered: false, at: 400 }), /before choosing a model/);
    const provider = await selectOnboardingProvider(settings, { expectedRevision: begun.revision, workspaceId: 'T1', providerId: 'anthropic' });
    const trying = await startOnboardingTry(settings, {
      expectedRevision: provider.revision, agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: 'U1', tryStartedAt: 300,
    });
    const settled = await settleOnboardingSlackAppsStep(settings, trying.revision, { githubStepNotOffered: false, at: 400 });
    assert.equal(settled.journey.slackAppsStepAt, 400);
    assert.equal((await settleOnboardingSlackAppsStep(settings, settled.revision, { githubStepNotOffered: true, at: 500 })).revision, settled.revision, 'once recorded it stays');
    const github = await settleOnboardingGithubStep(settings, settled.revision, 600);
    assert.equal(github.journey.slackAppsStepAt, 400);
    const reselected = await selectOnboardingProvider(settings, { expectedRevision: github.revision, workspaceId: 'T1', providerId: 'openai' });
    assert.equal(reselected.journey.slackAppsStepAt, undefined);
    // GitHub settled by someone the step was never offered to settles it as well.
    const again = await startOnboardingTry(settings, {
      expectedRevision: (await selectOnboardingProvider(settings, { expectedRevision: reselected.revision, workspaceId: 'T1', providerId: 'anthropic' })).revision,
      agentId: 'agent_chickpea', modelId: 'anthropic/claude-sonnet-5', slackUserId: 'U1', tryStartedAt: 700,
    });
    assert.equal((await settleOnboardingGithubStep(settings, again.revision, 800)).journey.slackAppsStepAt, 800);
    assert.throws(() => parseOnboardingJourney(JSON.stringify({ version: 2, state: 'active', startedAt: 100, slackAppsStepAt: 400 })), /invalid/);
  } finally {
    settings.close();
  }
});
