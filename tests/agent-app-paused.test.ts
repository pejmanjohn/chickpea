import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { hostedSignUpOnboardingSteps } from '../src/admin/onboarding-steps.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  AWAITING_OWN_APP,
  type AgentAppLifecycle,
  type AgentSlackPresence,
  type AttachedAgentApp,
  type CustomAgentConfig,
  agentAppIsLive,
  appRecordOf,
} from '../src/config/types.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import type { ManagementReceiptOutboxRecord } from '../src/management/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { createAgentSlackAppAdminRoutes } from '../src/slack/agent-apps/admin-routes.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps, withAgentSlackAppHandoff } from '../src/slack/agent-apps/host.ts';
import { agentAppPresenceHooks, armUnfinishedAgentAppMoves } from '../src/slack/agent-apps/live.ts';
import { createAgentSlackAppRoutes } from '../src/slack/agent-apps/routes.ts';
import { readAppSecrets, saveConfigurationToken, type SecretDeps, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { type AgentAppSwitchJob, AgentSlackApps } from '../src/slack/agent-apps/service.ts';
import { readAgentSlackAppsSetting, writeAgentSlackAppsSetting } from '../src/slack/agent-apps/setting.ts';
import { type AgentAppSlackApi, SlackRefused } from '../src/slack/agent-apps/slack-api.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { SlackTransportError, type SlackTransport, type SlackUserGroup } from '../src/slack/transport/types.ts';
import { refuseLikeSlack } from './helpers/slack-manifest-rules.ts';

/**
 * A host that keeps every Agent app working while it does not let Chickpea
 * create or change any (`mayCreateApps: false`): each refusal, each kept
 * action, new Agents, and Allow on an app Slack already made.
 */

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const OWNER = 'UOWNER';
const ORIGIN = 'https://core.test';
const AVATAR = { kind: 'generated' as const, revision: 1, seed: 'seed' };
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });
const AS_OWNER = withAgentSlackAppHandoff(ENV, { kind: 'owner', slackUserId: OWNER });
const API = '/admin/api/slack-apps';
const ADD = '/channels/slack/agent-apps/add';
const PASTED = 'xoxe-1-pasted-token-0000';

/** The host as the hosted layer installs it; `mayCreateApps` is the switch a test moves. */
function hostWith(mayCreateApps: boolean | undefined): AgentSlackAppsHost & { mayCreateApps?: boolean } {
  return {
    requestUrls: (installationId, appId) => ({
      events: `https://cloud.test/channels/slack/agent-apps/${installationId}/${appId}/tok/events`,
      interactions: `https://cloud.test/channels/slack/agent-apps/${installationId}/${appId}/tok/interactions`,
    }),
    redirectUri: 'https://cloud.test/slack/agent-apps/callback',
    allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
    addUrl: (agentId) => `https://cloud.test/slack/agent-apps/add/${agentId}`,
    ...(mayCreateApps === undefined ? {} : { mayCreateApps }),
  };
}

/** Slack's app API, recording every call by method and refusing what Slack refuses. */
class FakeSlack implements AgentAppSlackApi {
  calls: string[] = [];
  /** The apps that exist in Slack; one not here is refused as Slack refuses it. */
  apps = new Set(['A0APP1', 'A0APP2', 'A0APP3']);
  /** Slack will not let this token delete an app that exists. */
  refuseDelete = false;
  async rotate(refreshToken: string) {
    this.calls.push('tooling.tokens.rotate');
    const n = this.calls.length;
    return { accessToken: `xoxe.xoxp-1-access-${n}`, refreshToken: `${refreshToken}-r${n}`, teamId: TEAM, expiresAt: NOW + 12 * 3_600_000 };
  }
  async create(_token: string, manifest: Parameters<AgentAppSlackApi['create']>[1]) {
    this.calls.push('apps.manifest.create');
    refuseLikeSlack('apps.manifest.create', manifest);
    this.apps.add('A0NEW');
    return { appId: 'A0NEW', clientId: '7.client', clientSecret: 'client-secret-new', signingSecret: 'signing-secret-new' };
  }
  async definedBotScopes(_token: string, appId: string) {
    this.calls.push('apps.manifest.export');
    if (!this.apps.has(appId)) throw new SlackRefused('apps.manifest.export', 'app_not_found');
    return [...AGENT_APP_BOT_SCOPES];
  }
  async update(_token: string, _appId: string, manifest: Parameters<AgentAppSlackApi['update']>[2]) {
    this.calls.push('apps.manifest.update');
    refuseLikeSlack('apps.manifest.update', manifest);
  }
  async setIcon() { this.calls.push('apps.icon.set'); }
  async exchange(input: Parameters<AgentAppSlackApi['exchange']>[0]) {
    this.calls.push('oauth.v2.access');
    const appId = `A0APP${input.clientId.split('.')[0]}`;
    return { botToken: `xoxb-${appId}`, botUserId: `UBOT${appId}`, teamId: TEAM, appId, installerUserId: OWNER, scopes: [...AGENT_APP_BOT_SCOPES] };
  }
  async uninstall() { this.calls.push('apps.uninstall'); return 'removed' as const; }
  async delete(_token: string, appId: string) {
    this.calls.push('apps.manifest.delete');
    // Slack refuses a delete of an app that does not exist as it refuses one it will not let this token delete.
    if (!this.apps.has(appId) || this.refuseDelete) throw new SlackRefused('apps.manifest.delete', 'invalid_app_id');
    this.apps.delete(appId);
    return 'deleted' as const;
  }
  async botInstalled() { this.calls.push('auth.test'); return true; }
}

/** The calls that make, change, or check a token for an app; anything else Slack is asked is not one. */
const CREATES_OR_CHANGES = ['apps.manifest.create', 'apps.manifest.update', 'apps.icon.set', 'apps.manifest.export', 'tooling.tokens.rotate'];
const createdOrChanged = (slack: FakeSlack) => slack.calls.filter((call) => CREATES_OR_CHANGES.includes(call));

/** Chickpea's bot: user groups and DMs, refusing what Slack refuses. */
class Workspace implements Partial<SlackTransport> {
  readonly mode = 'direct' as const;
  groups: SlackUserGroup[] = [];
  created: string[] = [];
  disabled: string[] = [];
  posted: string[] = [];
  async listUserGroups() { return this.groups.map((group) => ({ ...group })); }
  async createUserGroup(input: { name: string; handle: string; description?: string }) {
    if (this.groups.some((group) => group.handle === input.handle)) throw new SlackTransportError('usergroups.create', 'name_already_exists');
    const group: SlackUserGroup = { id: `S${this.groups.length + 1}`, name: input.name, handle: input.handle, disabled: false };
    this.groups.push(group);
    this.created.push(input.handle);
    return { ...group };
  }
  async updateUserGroup(id: string, patch: Partial<SlackUserGroup>) {
    const group = this.required(id, 'usergroups.update');
    if (group.disabled) throw new SlackTransportError('usergroups.update', 'no_such_subteam');
    return { ...Object.assign(group, patch) };
  }
  async disableUserGroup(id: string) {
    this.disabled.push(id);
    return { ...Object.assign(this.required(id, 'usergroups.disable'), { disabled: true }) };
  }
  async enableUserGroup(id: string) { return { ...Object.assign(this.required(id, 'usergroups.enable'), { disabled: false }) }; }
  async lookupChannel(): Promise<never> { throw new SlackTransportError('conversations.info', 'channel_not_found'); }
  async joinPublicChannel(): Promise<never> { throw new SlackTransportError('conversations.join', 'channel_not_found'); }
  async channelHasMember(): Promise<never> { throw new SlackTransportError('conversations.members', 'channel_not_found'); }
  async openDirectConversation(user: string) { return { id: `D_${user}`, private: true, member: true, archived: false }; }
  async postMessage(input: { channelId: string; text: string }) { this.posted.push(input.text); return { channelId: input.channelId, ts: `${this.posted.length}.0` }; }
  private required(id: string, method: string): SlackUserGroup {
    const group = this.groups.find((candidate) => candidate.id === id);
    if (!group) throw new SlackTransportError(method, 'no_such_subteam');
    return group;
  }
}

function presence(handle: string, extra: Partial<AgentSlackPresence> = {}): AgentSlackPresence {
  return { requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy', avatar: AVATAR, ...extra } as AgentSlackPresence;
}

function agent(id: string, name: string, slackPresence: AgentSlackPresence): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, description: `${name} helps.`, instructions: `You are ${name}.`, enabled: true,
    lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1, slackPresence,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

const appRecord = (n: number) => ({ appId: `A0APP${n}`, clientId: `${n}.client` });
const waitingForAllow: AttachedAgentApp = {
  state: 'awaiting_consent', at: NOW, startedBy: OWNER, app: appRecord(1), icon: 'default_avatar', follows: { manifestFingerprint: 'made-earlier' },
};
const stoppedPartway: AttachedAgentApp = { state: 'needs_attention', at: NOW, startedBy: OWNER, reason: 'urls_refused', resume: 'created', app: appRecord(2) };
const live: AgentAppLifecycle = {
  state: 'active', at: NOW, app: appRecord(3), icon: 'default_avatar', botUserId: 'UBOTA0APP3', installedAt: NOW, installedBy: OWNER,
  switchProgress: 'done', follows: { manifestFingerprint: 'made-earlier', avatarRevision: 1 },
};

const OWNER_PRINCIPAL: AuthPrincipal = {
  userId: 'user_owner', membershipId: 'membership_owner', organizationId: 'org_test', role: 'owner',
  authenticatorKind: 'test_slack_session', credentialId: 'credential_owner', correlationId: 'request_owner', machine: false,
};

/**
 * A workspace whose setting is on, with an Agent of each kind: not in Slack
 * yet, in a user group, waiting for Allow, stopped partway, and live.
 */
async function fixture(t: TestContext, options: { mayCreateApps?: boolean; now?: () => number } = { mayCreateApps: false }) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const host = hostWith(options.mayCreateApps);
  configureAgentSlackApps(host);
  t.after(() => { config.close(); settings.close(); configureAgentSlackApps(undefined); });
  const groups = new Workspace();
  groups.groups.push(
    { id: 'S_SALES', name: 'Sales', handle: 'sales', disabled: false },
    { id: 'S_READY', name: 'Helpdesk', handle: 'helpdesk', disabled: false },
    { id: 'S_STUCK', name: 'Billing', handle: 'billing', disabled: false },
  );
  await config.createAgent(agent('agent_new', 'Scout', presence('scout', { health: 'unpublished', errorCode: AWAITING_OWN_APP })));
  await config.createAgent(agent('agent_sales', 'Sales', presence('sales', { userGroupId: 'S_SALES' })));
  await config.createAgent(agent('agent_ready', 'Helpdesk', presence('helpdesk', { userGroupId: 'S_READY', app: waitingForAllow })));
  await config.createAgent(agent('agent_stuck', 'Billing', presence('billing', { userGroupId: 'S_STUCK', app: stoppedPartway })));
  await config.createAgent(agent('agent_live', 'Support', { ...presence('support'), kind: 'agent_app', app: live } as AgentSlackPresence));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: 'agent_sales', runtimeContract: 'chickpea-v1' });
  await writeAgentSlackAppsSetting(settings, { mode: 'own_app', changedBy: OWNER, changedAt: NOW });
  const slack = new FakeSlack();
  const keyring = generateCredentialKeyring('k1');
  const secrets: SecretDeps = { credentials: settings, keyring, slack, now: () => NOW };
  assert.equal(await saveConfigurationToken(secrets, TEAM, PASTED, OWNER), 'saved');
  await writeAppSecrets(secrets, 'A0APP1', 'agent_ready', { clientSecret: 'cs1', signingSecret: 'ss1' }, null);
  await writeAppSecrets(secrets, 'A0APP2', 'agent_stuck', { clientSecret: 'cs2', signingSecret: 'ss2' }, null);
  await writeAppSecrets(secrets, 'A0APP3', 'agent_live', { clientSecret: 'cs3', signingSecret: 'ss3', botToken: 'xoxb-A0APP3' }, null);
  slack.calls = [];
  const jobs: AgentAppSwitchJob[] = [];
  const placed: string[] = [];
  const service = new AgentSlackApps({
    env: ENV, stores: { config, settings }, host, slack, keyring, now: options.now ?? (() => NOW),
    publicOrigin: async () => ORIGIN, armSwitch: async (job) => { jobs.push(job); },
    appBot: () => ({
      lookupChannel: async () => { throw new SlackTransportError('conversations.info', 'channel_not_found'); },
      joinPublicChannel: async () => { throw new SlackTransportError('conversations.join', 'channel_not_found'); },
    }),
    memberInSlack: async (id) => ({ membershipId: id, slackUserId: id, role: 'owner' }),
    placeInSlack: async (agentId) => { placed.push(agentId); },
    transport: groups as unknown as SlackTransport,
  });
  const routes = createAgentSlackAppRoutes({ service: async () => service, audit: async () => undefined });
  const admin = createAgentSlackAppAdminRoutes({
    actor: async () => ({ principal: OWNER_PRINCIPAL, slackUserId: OWNER, slackTeamId: TEAM }),
    placeInSlack: async (_c, agentIds) => { placed.push(...agentIds); },
    identity: () => ({ recordAuthAudit: async () => undefined }) as unknown as IdentityStore,
    service: async () => service,
  });
  const adminJson = (path: string, method: string, body?: unknown) => admin.request(path, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, ENV);
  const handOff = (agentId: string, method = 'GET') => routes.request(`${ADD}/${agentId}`, {
    method, headers: { 'sec-fetch-site': 'same-origin' },
  }, AS_OWNER);
  const agents = async () => Object.fromEntries((await config.listAgents()).map((each) => [each.id, each]));
  return { config, settings, host, groups, slack, secrets, service, routes, adminJson, handOff, jobs, placed, agents };
}

/** The words on a page, without its markup. */
function words(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Defects caught: a pause that still creates, moves, re-creates or updates an app, spends the configuration token to
// check a paste, or turns the setting on; a refusal that writes a record, messages the Owner, or answers a raw code.
test('while creating apps is paused, each action that would create or change an app is refused, says so, and asks Slack for nothing', async (t) => {
  const f = await fixture(t);
  const before = await f.agents();

  for (const agentId of ['agent_new', 'agent_sales', 'agent_stuck']) {
    const start = await f.adminJson(`${API}/agents/${agentId}/start`, 'POST', {});
    assert.equal(start.status, 409, agentId);
    const body = await start.json() as { error: string; agent: { id: string } };
    assert.equal(body.error, 'paused', `${agentId}: Admin's Start answers paused`);
    assert.equal(body.agent.id, agentId, 'with the row as it stands');
  }

  const paste = await f.adminJson(`${API}/token`, 'PUT', { refreshToken: 'xoxe-1-another-token-0000' });
  assert.equal(paste.status, 409);
  assert.deepEqual(await paste.json(), { error: 'paused' }, 'a paste is refused before Slack is asked to check it');

  await writeAgentSlackAppsSetting(f.settings, { mode: 'shared', changedBy: OWNER, changedAt: NOW });
  const turnOn = await f.adminJson(`${API}/mode`, 'PUT', { mode: 'own_app' });
  assert.equal(turnOn.status, 409);
  assert.deepEqual(await turnOn.json(), { error: 'paused' });
  assert.equal((await readAgentSlackAppsSetting(f.settings)).mode, 'shared', 'the setting stays off');
  await writeAgentSlackAppsSetting(f.settings, { mode: 'own_app', changedBy: OWNER, changedAt: NOW });

  for (const agentId of ['agent_new', 'agent_stuck']) {
    for (const method of ['GET', 'POST']) {
      const page = await f.handOff(agentId, method);
      assert.equal(page.status, 409, `${agentId} ${method}`);
      const html = await page.text();
      assert.match(words(html), /^.*Adding Slack apps is paused/, `${agentId} ${method}: the hand-off says so`);
      assert.doesNotMatch(html, /<form/, `${agentId} ${method}: and offers no press`);
      assert.doesNotMatch(html, /Create app|Allow in Slack/, `${agentId} ${method}: and no steps, as it has no place among them`);
    }
  }
  assert.match(words(await (await f.handOff('agent_new')).text()),
    /Scout keeps answering as it does now\. .*To give Scout an @handle people can mention now, an Owner can choose Stop creating Slack apps for new Agents in Chickpea Admin\./,
    'an Agent waiting for its own app is told how an Owner gives it a handle instead');
  assert.doesNotMatch(words(await (await f.handOff('agent_stuck')).text()), /Stop creating/, 'one already in a user group is not');

  assert.equal(await f.service.retry('agent_stuck', OWNER), 'paused', 'Finish setting up in Slack is refused');
  assert.equal(await f.service.pausedReply('agent_stuck'),
    "Adding Slack apps is paused, so Chickpea can't finish Billing's Slack app now. Billing keeps answering as it does now.");

  assert.deepEqual(f.slack.calls, [], 'Slack is asked for nothing, so no token is spent');
  assert.deepEqual([f.groups.disabled, f.groups.created, f.groups.posted], [[], [], []], "and nobody's group or messages change");
  assert.deepEqual(await f.agents(), before, 'every Agent is as it was');
});

// Defects caught: a pause that leaves an app made before it, still waiting for Allow, with no way to finish; a switch
// held by the pause, so the Agent's app is live while its group is off, or the reverse.
test("Allow on an app Slack already made still completes during a pause, and the switch after it runs: the Agent ends on its own bot", async (t) => {
  const f = await fixture(t);
  const homeButton = async () => JSON.stringify((await f.service.homeRows([await f.config.getAgent('agent_ready')], { role: 'owner' })).get('agent_ready'));
  assert.match(await homeButton(), /"text":"Allow in Slack"\},"action_id":"agent_app_add_link","url":"https:\/\/cloud\.test\/slack\/agent-apps\/add\/agent_ready"/,
    "the Owner's Home tab offers Allow through the hand-off page, as it does when nothing is paused");
  const opened = await f.routes.request('/channels/slack/agent-apps/allow/agent_ready', {}, AS_OWNER);
  assert.equal(opened.status, 303, "the Allow link still opens Slack's permission screen");
  const state = new URL(opened.headers.get('location')!).searchParams.get('state')!;

  const back = await f.routes.request(`/channels/slack/agent-apps/callback?code=c0de&state=${encodeURIComponent(state)}`, {}, AS_OWNER);
  assert.equal(back.status, 303, "Slack's answer is taken");
  const allowed = await f.config.getAgent('agent_ready');
  assert.ok(agentAppIsLive(allowed.slackPresence), 'the app is live');
  assert.equal((await readAppSecrets(f.secrets, 'A0APP1'))?.secrets.botToken, 'xoxb-A0APP1', 'with its own bot token');

  assert.equal(f.jobs.length, 1, 'the switch is armed');
  assert.equal(await f.service.continueSwitch('agent_ready'), 'paused', 'and runs; only bringing the app to match its Agent holds');
  const switched = (await f.config.getAgent('agent_ready')).slackPresence;
  assert.ok(agentAppIsLive(switched) && switched.app.switchProgress === 'done', 'the switch finished');
  assert.deepEqual(f.groups.disabled, ['S_READY'], "the group that held the handle is off: the Agent's own bot answers it");
  assert.equal(switched.released?.answers, false);
  assert.match(f.groups.posted.at(-1) ?? '', /Helpdesk is now its own Slack app/, 'the Owner is told');
  assert.deepEqual(createdOrChanged(f.slack), [], 'nothing was created or changed: Allow spends only the app’s own credentials');
});

// Defect caught: a door nobody closed (a new caller, a job, a retry) that runs a record's next step during a pause and
// frees a handle, creates an app, or changes one.
test('while paused, running a record forward performs no step that frees a handle, creates an app or changes one', async (t) => {
  const f = await fixture(t);
  f.groups.groups.push({ id: 'S_OLD', name: 'Older', handle: 'older', disabled: false });
  const partway: Array<[string, AgentSlackPresence]> = [
    ['agent_creating', presence('creating', { app: { state: 'creating', at: NOW, startedBy: OWNER, manifestFingerprint: 'made-now' } })],
    ['agent_created', presence('created', { app: { state: 'created', at: NOW, startedBy: OWNER, app: appRecord(6) } })],
    ['agent_urls', presence('urls', { app: { state: 'urls_set', at: NOW, startedBy: OWNER, app: appRecord(7) } })],
    ['agent_older', {
      ...presence('older'), kind: 'agent_app', released: { userGroupId: 'S_OLD', answers: true }, app: { state: 'releasing_handle', at: NOW, startedBy: OWNER },
    } as AgentSlackPresence],
  ];
  for (const [id, slackPresence] of partway) await f.config.createAgent(agent(id, id, slackPresence));
  await writeAppSecrets(f.secrets, 'A0APP6', 'agent_created', { clientSecret: 'cs6', signingSecret: 'ss6' }, null);
  await writeAppSecrets(f.secrets, 'A0APP7', 'agent_urls', { clientSecret: 'cs7', signingSecret: 'ss7' }, null);
  const before = await f.agents();

  for (const [id] of partway) await f.service.advance(id, { wroteCreating: true, handOff: true });
  assert.deepEqual(f.slack.calls, [], 'Slack is asked for nothing');
  assert.deepEqual(f.groups.disabled, [], 'no group is turned off for an app that cannot be made');
  assert.deepEqual(await f.agents(), before, 'and every record is where it stopped');

  f.host.mayCreateApps = true;
  await f.service.advance('agent_created', { handOff: true });
  assert.equal(appRecordOf((await f.config.getAgent('agent_created')).slackPresence)?.state, 'awaiting_consent', 'once allowed, the same run goes on to Allow');
});

// Defects caught: a held sync that tells the Owner something failed, records a refusal, or never resumes; a sweep that
// arms a job every pass for an app it may not touch.
test('the sync that brings a live app to match its Agent holds while paused, tells nobody, and resumes by itself', async (t) => {
  const f = await fixture(t);
  const before = await f.config.getAgent('agent_live');
  const armed: ManagementReceiptOutboxRecord[] = [];
  const management = { putOutbox: async (row: ManagementReceiptOutboxRecord) => { armed.push(row); return row; } };

  assert.equal(await f.service.continueSwitch('agent_live'), 'paused', 'a job already armed holds');
  await f.service.followAgent('agent_live');
  await armUnfinishedAgentAppMoves({ config: f.config, management }, NOW, ENV);
  assert.deepEqual([f.jobs, armed], [[], []], 'neither a save nor the sweep arms a job');
  assert.deepEqual(await f.config.getAgent('agent_live'), before, 'nothing is recorded');
  assert.deepEqual([f.slack.calls, f.groups.posted], [[], []], 'and Slack and the Owner hear nothing');

  f.host.mayCreateApps = true;
  await armUnfinishedAgentAppMoves({ config: f.config, management }, NOW, ENV);
  assert.deepEqual(armed.map((row) => row.receipt), [{ kind: 'agent_app_switch', agentId: 'agent_live' }], 'once allowed, the sweep arms it');
  assert.equal(await f.service.continueSwitch('agent_live'), 'done');
  assert.ok(f.slack.calls.includes('apps.manifest.update'), 'and the app is brought to match');
});

// Defects caught: a pause that strands what exists: a Cancel, the token's removal, turning the setting off, Slack's
// removal of an app, or an archive refused or held.
test('while paused, Cancel, removing the token, turning the setting off, Slack removing an app and an archive all still work', async (t) => {
  const f = await fixture(t);
  const read = await (await f.adminJson(API, 'GET')).json() as { paused: boolean; agents: Array<{ id: string; slack: { state: string } }> };
  assert.equal(read.paused, true, 'Admin reads the section, and that it is paused');
  assert.equal(read.agents.find((row) => row.id === 'agent_live')?.slack.state, 'own_app');

  const cancelled = await f.adminJson(`${API}/agents/agent_ready/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json() as { app: string }).app, 'deleted');
  assert.deepEqual(appRecordOf((await f.config.getAgent('agent_ready')).slackPresence), undefined, 'the Agent is back on its group alone');

  const off = await f.adminJson(`${API}/mode`, 'PUT', { mode: 'shared' });
  assert.equal(off.status, 200);
  assert.deepEqual(f.placed, ['agent_new'], 'an Agent waiting for its own app is given its group');

  const ended = await f.service.end('A0APP3', { event: { type: 'app_uninstalled' } });
  assert.equal(ended, 'ended', "Slack's removal of a live app is taken");
  assert.equal(appRecordOf((await f.config.getAgent('agent_live')).slackPresence)?.state, 'needs_attention');

  const archived = await f.service.retire(await f.config.getAgent('agent_stuck'));
  assert.equal(archived.outcome, 'removed', 'an archive retires an app left partway');
  assert.ok(f.slack.calls.includes('apps.manifest.delete'));

  const removed = await f.adminJson(`${API}/token`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as { removed: string }).removed, 'discarded', 'and the token is removed');
});

// Defect caught: a pause that also stops the configuration token's rotation, so an archive or a Cancel after its access
// token lapses leaves the app in Slack.
test('while paused, an archive and a Cancel still rotate a lapsed configuration token to delete their apps', async (t) => {
  const f = await fixture(t, { mayCreateApps: false, now: () => NOW + 13 * 3_600_000 });
  assert.equal((await f.service.retire(await f.config.getAgent('agent_stuck'))).outcome, 'removed');
  assert.deepEqual(f.slack.calls, ['tooling.tokens.rotate', 'apps.manifest.delete'], 'the archive rotates, then deletes');
  f.slack.calls = [];
  const cancelled = await f.service.cancel('agent_ready', OWNER);
  assert.deepEqual([cancelled.kind, cancelled.kind === 'cancelled' && cancelled.app], ['cancelled', 'deleted']);
  assert.deepEqual(f.slack.calls, ['tooling.tokens.rotate', 'apps.manifest.delete'], 'and so does the Cancel');
});

// Defects caught: a new Agent left out of Slack while nothing can add it; an Agent already waiting given a group the
// Owner never chose; a pause that outlives itself for new Agents.
test('while paused, a new Agent in a workspace with the setting on gets a user group, and one already waiting keeps waiting', async (t) => {
  const f = await fixture(t);
  const reconciler = () => new AgentPresenceReconciler({
    config: f.config, transport: f.groups as unknown as SlackTransport, announce: null, now: () => NOW,
    agentApps: agentAppPresenceHooks(ENV, f.settings)!,
  });
  const fresh = (id: string, name: string) => ({
    ...agent(id, name, presence(name.toLowerCase(), { desiredState: 'unpublished', health: 'unpublished' })), lifecycle: 'draft' as const,
  });

  await f.config.createAgent(fresh('agent_fresh', 'Fresh'));
  const placed = await reconciler().retry('agent_fresh');
  assert.equal(placed.slackPresence?.userGroupId, 'S4', 'the new Agent gets its group');
  assert.equal(placed.slackPresence?.errorCode, undefined);

  const waiting = await reconciler().retry('agent_new');
  assert.equal(waiting.slackPresence?.errorCode, AWAITING_OWN_APP, 'the waiting Agent stays waiting');
  assert.equal(waiting.slackPresence?.userGroupId, undefined);
  assert.deepEqual(f.groups.created, ['fresh'], 'and gets no group');

  f.host.mayCreateApps = true;
  await f.config.createAgent(fresh('agent_later', 'Later'));
  assert.equal((await reconciler().retry('agent_later')).slackPresence?.errorCode, AWAITING_OWN_APP, 'once allowed, a new Agent waits for its own app again');
});

test('while paused, onboarding leaves out the Slack apps step', async (t) => {
  configureAgentSlackApps(hostWith(false));
  t.after(() => configureAgentSlackApps(undefined));
  assert.equal((await hostedSignUpOnboardingSteps()).some((step) => step.id === 'slack_apps'), false);
  configureAgentSlackApps(hostWith(undefined));
  assert.equal((await hostedSignUpOnboardingSteps()).some((step) => step.id === 'slack_apps'), true);
});

// Defect caught: a host that says nothing, or says yes, treated as a pause, or as anything but what it was before.
test('a host that says nothing about creating apps, or allows it, makes exactly the calls it made before', async (t) => {
  const runs: string[][] = [];
  for (const mayCreateApps of [undefined, true]) {
    const f = await fixture(t, mayCreateApps === undefined ? {} : { mayCreateApps });
    assert.equal((await (await f.adminJson(API, 'GET')).json() as { paused: boolean }).paused, false);
    assert.match(JSON.stringify((await f.service.homeRows([await f.config.getAgent('agent_ready')], { role: 'owner' })).get('agent_ready')),
      /"url":"https:\/\/cloud\.test\/slack\/agent-apps\/add\/agent_ready"/, "the Home tab's Allow goes through the hand-off page");
    const pressed = await f.handOff('agent_new', 'POST');
    assert.equal(pressed.status, 303, "the press goes on to Slack's Allow");
    assert.equal((await f.adminJson(`${API}/token`, 'PUT', { refreshToken: 'xoxe-1-another-token-0000' })).status, 200);
    assert.equal(await f.service.continueSwitch('agent_live'), 'done');
    runs.push(f.slack.calls);
  }
  assert.ok(runs[0]!.includes('apps.manifest.create') && runs[0]!.includes('apps.manifest.update'));
  assert.deepEqual(runs[1], runs[0], 'call for call');
});

/** The records Slack made an app for that nobody has allowed, each with nothing but its app to remove. */
const MADE_BEFORE_ALLOW = {
  created: { state: 'created', at: NOW, startedBy: OWNER },
  urls_set: { state: 'urls_set', at: NOW, startedBy: OWNER },
  icon_set: { state: 'icon_set', at: NOW, startedBy: OWNER, icon: 'default_avatar' },
  urls_refused: { state: 'needs_attention', at: NOW, startedBy: OWNER, reason: 'urls_refused', resume: 'created' },
  token_needed: { state: 'needs_attention', at: NOW, startedBy: OWNER, reason: 'config_token_needed', resume: 'created' },
} as const;

/** An Agent being moved (it has its group) or added (it has none) whose record Slack made app `n` for. */
async function madeBeforeAllow(f: Awaited<ReturnType<typeof fixture>>, name: keyof typeof MADE_BEFORE_ALLOW, moving: boolean, n: number) {
  const id = `agent_${name}_${moving ? 'moved' : 'added'}`;
  const app = { ...MADE_BEFORE_ALLOW[name], app: appRecord(n) } as AttachedAgentApp;
  await f.config.createAgent(agent(id, `Agent ${n}`, presence(`h${n}`, moving ? { userGroupId: `S_${n}`, app } : { health: 'unpublished', app })));
  await writeAppSecrets(f.secrets, `A0APP${n}`, id, { clientSecret: `cs${n}`, signingSecret: `ss${n}` }, null);
  f.slack.apps.add(`A0APP${n}`);
  return { id, appId: `A0APP${n}`, group: moving ? `S_${n}` : undefined };
}

// Defects caught: an app Slack made before Allow that no Cancel can remove, so an Agent being added has nothing but
// archive while paused; Admin offering no Cancel on its row; a second Cancel that asks Slack for anything again.
test('with or without a pause, Cancel deletes the app Slack made for any record not yet allowed, and a second Cancel does nothing more', async (t) => {
  for (const mayCreateApps of [false, true]) {
    const f = await fixture(t, { mayCreateApps });
    const made = [];
    let n = 10;
    for (const name of Object.keys(MADE_BEFORE_ALLOW) as Array<keyof typeof MADE_BEFORE_ALLOW>) {
      for (const moving of [true, false]) made.push(await madeBeforeAllow(f, name, moving, (n += 1)));
    }
    const rows = (await (await f.adminJson(API, 'GET')).json() as { agents: Array<{ id: string; slack: { cancellable?: boolean } }> }).agents;
    for (const { id } of made) assert.equal(rows.find((row) => row.id === id)?.slack.cancellable, true, `${id}: Admin's row offers Cancel`);

    for (const { id, appId, group } of made) {
      f.slack.calls = [];
      const cancelled = await f.adminJson(`${API}/agents/${id}/cancel`, 'POST', {});
      assert.equal(cancelled.status, 200, id);
      assert.equal((await cancelled.json() as { app: string }).app, 'deleted', id);
      assert.deepEqual(f.slack.calls, ['apps.manifest.delete'], `${id}: the app is deleted, and nothing else is asked of Slack`);
      assert.equal(f.slack.apps.has(appId), false);
      const after = (await f.config.getAgent(id)).slackPresence;
      assert.equal(appRecordOf(after), undefined, `${id}: the record is gone`);
      assert.equal(after?.userGroupId, group, `${id}: a moved Agent answers through its group, an added one waits with none`);
      assert.equal(await readAppSecrets(f.secrets, appId), undefined, "and the app's own record is gone with it");

      const again = await f.adminJson(`${API}/agents/${id}/cancel`, 'POST', {});
      assert.equal(again.status, 409);
      assert.deepEqual(await again.json(), { error: 'not_waiting' });
      assert.deepEqual(f.slack.calls, ['apps.manifest.delete'], `${id}: a second Cancel asks Slack for nothing`);
    }
    assert.deepEqual(f.groups.disabled, [], 'no group was turned off');
  }
});

// Defect caught: an Agent being added whose app a paused Cancel removed, left out of Slack because turning the setting
// off placed only Agents with no record.
test('while paused, an added Agent whose app Cancel removed gets its group when the setting is turned off', async (t) => {
  const f = await fixture(t);
  const added = await madeBeforeAllow(f, 'urls_refused', false, 11);
  const moved = await madeBeforeAllow(f, 'created', true, 12);
  for (const { id } of [added, moved]) assert.equal((await f.adminJson(`${API}/agents/${id}/cancel`, 'POST', {})).status, 200);
  assert.deepEqual(f.placed, [], 'Cancel alone places nothing while the setting is on');

  assert.equal((await f.adminJson(`${API}/mode`, 'PUT', { mode: 'shared' })).status, 200);
  assert.deepEqual(f.placed.sort(), ['agent_new', added.id].sort(), 'the added Agent is given its group, and the moved one keeps its own');
});

// Defects caught: a Cancel before Allow that Slack refused, or whose app Slack cannot find, ending differently from the
// same Cancel of an app waiting for Allow: another answer, another message, or a record left behind.
test('a Cancel whose delete Slack refuses, or whose app Slack cannot find, ends as the same Cancel of an app waiting for Allow does', async (t) => {
  const f = await fixture(t);
  const ends: Array<{ app: string; message: string | undefined; record: unknown }> = [];
  const cancel = async (id: string) => {
    const answer = await (await f.adminJson(`${API}/agents/${id}/cancel`, 'POST', {})).json() as { app: string };
    ends.push({ app: answer.app, message: f.groups.posted.at(-1), record: appRecordOf((await f.config.getAgent(id)).slackPresence) });
  };

  f.slack.refuseDelete = true;
  await cancel('agent_ready');
  await cancel('agent_stuck');
  f.slack.refuseDelete = false;
  const waiting = await madeBeforeAllow(f, 'created', true, 11);
  await f.config.updateAgent(waiting.id, {
    slackPresence: { ...(await f.config.getAgent(waiting.id)).slackPresence!, app: { ...waitingForAllow, app: appRecord(11) } } as AgentSlackPresence,
  }, (await f.config.getAgent(waiting.id)).revision);
  const partway = await madeBeforeAllow(f, 'icon_set', true, 12);
  f.slack.apps.clear();
  await cancel(waiting.id);
  await cancel(partway.id);

  const refusedReady = "Chickpea couldn't delete the Slack app it made for Helpdesk, so delete Helpdesk in Your Apps in Slack. Helpdesk keeps answering as it did before.";
  assert.deepEqual(ends[0], { app: 'left_for_owner', message: refusedReady, record: undefined });
  assert.deepEqual(ends[1], { app: 'left_for_owner', message: refusedReady.replaceAll('Helpdesk', 'Billing'), record: undefined }, 'refused: the same answer and message');
  assert.equal(ends[2]!.app, 'not_found');
  assert.match(ends[2]!.message ?? '', /^Chickpea couldn't find the Slack app it made for Agent 11 to delete it\./);
  assert.deepEqual(ends[3], { ...ends[2], message: ends[2]!.message!.replaceAll('Agent 11', 'Agent 12') }, 'not found: the same answer and message');
});

// Defects caught: a pause that refuses Allow on an app that already exists, at any door, though that creates and changes
// nothing; a door that lets such a press through by creating or changing an app.
test('while paused, a press on an app Slack already made goes on to Allow from Admin, the hand-off page and Slack, and creates or changes nothing', async (t) => {
  const f = await fixture(t);
  const make = async (id: string, name: string, app: AttachedAgentApp, n: number) => {
    await f.config.createAgent(agent(id, name, presence(name.toLowerCase(), { userGroupId: `S_${n}`, app })));
    await writeAppSecrets(f.secrets, `A0APP${n}`, id, { clientSecret: `cs${n}`, signingSecret: `ss${n}` }, null);
  };
  const handingOver = (n: number): AttachedAgentApp => ({ state: 'icon_set', at: NOW, startedBy: OWNER, app: appRecord(n), icon: 'default_avatar' });
  const removed = (n: number): AttachedAgentApp => ({
    state: 'needs_attention', at: NOW, startedBy: OWNER, reason: 'app_removed', resume: 'icon_set', app: appRecord(n), icon: 'default_avatar',
  });
  await make('agent_handing', 'Payroll', handingOver(4), 4);
  await make('agent_removed', 'Ops', removed(5), 5);
  await make('agent_handing_slack', 'Legal', handingOver(6), 6);
  await make('agent_removed_slack', 'Finance', removed(7), 7);
  const state = async (id: string) => appRecordOf((await f.config.getAgent(id)).slackPresence)?.state;

  const start = await f.adminJson(`${API}/agents/agent_ready/start`, 'POST', {});
  assert.equal(start.status, 200, "Admin's Start on an app waiting for Allow");
  assert.equal(new URL((await start.json() as { authorizeUrl: string }).authorizeUrl).origin, 'https://slack.com', "opens Slack's permission screen");

  for (const id of ['agent_ready', 'agent_handing', 'agent_removed']) {
    const page = await f.handOff(id);
    assert.equal(page.status, 200, `${id}: the hand-off page is the ordinary one`);
    assert.match(words(await page.text()), /Slack's permission screen is opening\. Choose Allow there\./, id);
    const pressed = await f.handOff(id, 'POST');
    assert.equal(pressed.status, 303, `${id}: its press goes on`);
    assert.equal(new URL(pressed.headers.get('location')!).origin, 'https://slack.com', `${id}: to Slack's Allow`);
    assert.equal(await state(id), 'awaiting_consent', id);
  }

  for (const id of ['agent_handing_slack', 'agent_removed_slack']) {
    const retried = await f.service.retry(id, OWNER);
    assert.notEqual(retried, 'paused', `${id}: Slack's Finish setting up goes on`);
    assert.equal(await state(id), 'awaiting_consent', `${id}: to an app waiting for Allow`);
  }
  assert.match(f.groups.posted.join('\n'), /Legal/, 'whose Owner is asked to Allow it');

  assert.deepEqual(createdOrChanged(f.slack), [], 'nothing was created or changed, and no token was spent');
  assert.deepEqual([f.groups.disabled, f.groups.created], [[], []], "and no group's handle was freed");
});

// Defects caught: Admin hiding the Add and Cancel of an Agent waiting for Allow behind the paused sentence; the hint to
// turn the setting off shown for an Agent turning it off would not place.
test("while paused, Admin's row data says which Agents turning the setting off would give a group", async (t) => {
  const f = await fixture(t);
  await f.config.createAgent({ ...agent('agent_off', 'Quiet', presence('quiet', { health: 'unpublished', errorCode: AWAITING_OWN_APP })), enabled: false });
  const rows = (await (await f.adminJson(API, 'GET')).json() as { agents: Array<{ id: string; slack: { state: string }; waitsForOwnApp?: true }> }).agents;
  const row = (id: string) => rows.find((each) => each.id === id);
  assert.deepEqual([row('agent_new')?.slack.state, row('agent_new')?.waitsForOwnApp], ['not_in_slack', true]);
  assert.deepEqual([row('agent_off')?.slack.state, row('agent_off')?.waitsForOwnApp], ['not_in_slack', undefined], 'an Agent turned off is not placed');
  assert.equal(row('agent_ready')?.waitsForOwnApp, undefined);
});

// Defect caught: Try again on a live app whose update holds while paused, answered with nothing.
test('while paused, Try again on a live app whose update holds tells the Owner the update waits', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.service.retry('agent_live', OWNER), 'paused');
  assert.equal(await f.service.pausedReply('agent_live'), "Adding Slack apps is paused, so Chickpea can't update Support's Slack app now. Support keeps answering.");
  assert.deepEqual(f.slack.calls, []);
});
