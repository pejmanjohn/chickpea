import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { type AgentAppFollows, type AgentSlackPresence, type CustomAgentConfig, appRecordOf } from '../src/config/types.ts';
import type { ManagementReceiptOutboxRecord } from '../src/management/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { agentAppFollowStep, agentSlackState } from '../src/slack/agent-apps/lifecycle.ts';
import { agentAppSwitchRow, armAgentAppSwitch, armUnfinishedAgentAppMoves } from '../src/slack/agent-apps/live.ts';
import { discardConfigurationToken, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { AgentSlackApps, type AgentAppSwitchJob, type AgentAppTransport, OLDER_APPS_LACK, agentAppFollow } from '../src/slack/agent-apps/service.ts';
import { type AgentAppSlackApi, SlackRefused, SlackUnavailable } from '../src/slack/agent-apps/slack-api.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import { AGENT_APP_BOT_EVENTS, type SlackAppManifest } from '../src/slack/app-manifest.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import type { SlackTransport } from '../src/slack/transport/types.ts';
import { refuseLikeSlack } from './helpers/slack-manifest-rules.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const OWNER = 'UOWNER';
const APP = 'A0APP1';
const APP2 = 'A0APP2';
const HOST: AgentSlackAppsHost = {
  requestUrls: (installationId, appId) => ({ events: `https://cloud.test/${installationId}/${appId}/e`, interactions: `https://cloud.test/${installationId}/${appId}/i` }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
  addUrl: (agentId) => `https://cloud.test/slack/agent-apps/add/${agentId}`,
};
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });

class Crash extends Error {
  readonly name = 'Crash';
}

/**
 * Slack's app APIs for the configuration token, keeping each app's definition and picture. As in Slack, a manifest
 * update replaces the whole definition, including its permissions, which an installed app only gets after an Owner's
 * Allow; an unknown app is `app_not_found`; a spent refresh token is refused.
 */
class FakeSlack implements AgentAppSlackApi {
  readonly definitions = new Map<string, SlackAppManifest>();
  readonly icons = new Map<string, number>();
  log: string[] = [];
  crashAfter: string | undefined;
  refuseUpdate: SlackRefused | undefined;
  /** Runs while Slack is answering an update, as a change elsewhere would land then. */
  duringUpdate: (() => Promise<void>) | undefined;
  unanswered = false;
  refuseRotation = false;
  rotations = 0;
  async rotate(refreshToken: string) {
    if (this.refuseRotation) throw new SlackRefused('tooling.tokens.rotate', 'invalid_refresh_token');
    assert.match(refreshToken, /^xoxe-1-/);
    this.rotations += 1;
    return { accessToken: `xoxe.xoxp-1-access-${this.rotations}`, refreshToken: `xoxe-1-refresh-${this.rotations}`, teamId: TEAM, expiresAt: NOW + 12 * 3_600_000 };
  }
  async create(): Promise<never> { throw new Error('a follow never creates an app'); }
  async definedBotScopes(_token: string, appId: string) {
    this.log.push('export');
    if (this.unanswered) throw new SlackUnavailable('apps.manifest.export', 'network_error');
    const definition = this.definitions.get(appId);
    if (!definition) throw new SlackRefused('apps.manifest.export', 'app_not_found');
    return [...definition.oauth_config.scopes.bot];
  }
  async update(_token: string, appId: string, manifest: SlackAppManifest) {
    this.log.push('update');
    await this.duringUpdate?.();
    if (!this.definitions.has(appId)) throw new SlackRefused('apps.manifest.update', 'app_not_found');
    refuseLikeSlack('apps.manifest.update', manifest);
    if (this.refuseUpdate) throw this.refuseUpdate;
    this.definitions.set(appId, structuredClone(manifest));
    if (this.crashAfter === 'update') throw new Crash('after the update');
  }
  async setIcon(_token: string, appId: string, png: Uint8Array) {
    this.log.push('setIcon');
    if (!this.definitions.has(appId)) throw new SlackRefused('apps.icon.set', 'app_not_found');
    this.icons.set(appId, new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16));
  }
  async exchange(): Promise<never> { throw new Error('a follow never installs an app'); }
  async uninstall(): Promise<never> { throw new Error('a follow never uninstalls an app'); }
  async delete(): Promise<never> { throw new Error('a follow never deletes an app'); }
}

/** Chickpea's own bot, for the Owner's DMs; Slack drops a second post with the same client_msg_id. */
class FakeMainBot implements AgentAppTransport {
  posted: Array<{ text: string; idempotencyKey: string | undefined }> = [];
  async disableUserGroup(): Promise<never> { throw new Error('a follow never touches a user group'); }
  async enableUserGroup(): Promise<never> { throw new Error('a follow never touches a user group'); }
  async lookupChannel(): Promise<never> { throw new Error('not in this unit'); }
  async joinPublicChannel(): Promise<never> { throw new Error('not in this unit'); }
  async openDirectConversation(userId: string) { return { id: `D_${userId}`, private: true, member: true, archived: false }; }
  async postMessage(input: { channelId: string; text: string; idempotencyKey?: string }) {
    if (!this.posted.some((message) => input.idempotencyKey !== undefined && message.idempotencyKey === input.idempotencyKey)) {
      this.posted.push({ text: input.text, idempotencyKey: input.idempotencyKey });
    }
    return { channelId: input.channelId, ts: `${this.posted.length}.0` };
  }
}

function userAgent(id: string, name: string, handle: string): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, instructions: `You are ${name}.`, enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: {
      requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy', userGroupId: `S${handle.toUpperCase()}`,
      avatar: { kind: 'generated', revision: 1, seed: id },
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

/**
 * Support's app is live and, by default, matches Support as this build made it: Slack holds the definition Chickpea
 * would make today. `follows` overrides what its record says it was brought to match.
 */
async function fixture(t: TestContext, options: { follows?: AgentAppFollows | null; grantedScopes?: readonly string[] } = {}) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  const support = await config.createAgent(userAgent('agent_support', 'Support', 'support'));
  await config.createAgent(userAgent('agent_other', 'Other', 'other'));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: 'agent_other', runtimeContract: 'chickpea-v1' });
  const made = agentAppFollow(support, APP, HOST, 'inst_a');
  const follows = options.follows === null ? undefined : options.follows ?? made.target;
  await config.updateAgent(support.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: support.slackPresence!.avatar,
      app: {
        state: 'active', at: NOW, app: { appId: APP, clientId: '1.client' }, icon: 'default_avatar', botUserId: 'UBOT1',
        installedAt: NOW, installedBy: OWNER, switchProgress: 'done', ...(follows ? { follows } : {}),
      },
      released: { userGroupId: 'SSUPPORT' },
    },
  }, support.revision);
  const slack = new FakeSlack();
  const definition = structuredClone(made.manifest);
  if (options.grantedScopes) definition.oauth_config.scopes.bot = [...options.grantedScopes];
  slack.definitions.set(APP, definition);
  const keyring = generateCredentialKeyring('k1');
  const secrets = { credentials: settings, keyring, slack };
  await writeAppSecrets(secrets, APP, support.id, { clientSecret: 'cs', signingSecret: 'ss', botToken: 'xoxb-app' }, null);
  assert.equal(await saveConfigurationToken(secrets, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  const main = new FakeMainBot();
  const clock = { now: NOW };
  const armed: AgentAppSwitchJob[] = [];
  const service = new AgentSlackApps({
    env: ENV, stores: { config, settings }, host: HOST, transport: main, slack, keyring, now: () => clock.now,
    armSwitch: async (job) => { armed.push(job); },
    publicOrigin: async () => 'https://chickpea.test',
  });
  const reconciler = new AgentPresenceReconciler({
    config, transport: {} as SlackTransport, announce: null,
    agentApps: {
      retire: async () => { throw new Error('not in this unit'); },
      bringBotIn: async () => undefined,
      ownAppMode: async () => false,
      follow: (agent) => service.followAgent(agent.id),
    },
  });
  slack.log.length = 0;
  return { config, settings, secrets, slack, main, clock, armed, service, reconciler };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function support(f: Fixture): Promise<CustomAgentConfig> {
  return f.config.getAgent('agent_support');
}

async function followsOf(f: Fixture): Promise<AgentAppFollows | undefined> {
  const app = appRecordOf((await support(f)).slackPresence);
  return app?.state === 'active' ? app.follows : undefined;
}

/** What Chickpea would make Support's app today. */
async function today(f: Fixture) {
  return agentAppFollow(await support(f), APP, HOST, 'inst_a');
}

/** A save in Admin, over the management MCP, or by Chickpea in Slack: the Agent row changes, then its presence is reconciled. */
async function save(f: Fixture, patch: { name?: string; handle?: string; avatarRevision?: number }): Promise<void> {
  const agent = await support(f);
  const presence = agent.slackPresence!;
  const slackPresence: AgentSlackPresence = {
    ...presence,
    ...(patch.handle ? { requestedHandle: patch.handle, normalizedHandle: patch.handle } : {}),
    ...(patch.avatarRevision ? { avatar: { kind: 'uploaded', revision: patch.avatarRevision } } : {}),
  } as AgentSlackPresence;
  await f.config.updateAgent(agent.id, { ...(patch.name ? { name: patch.name } : {}), slackPresence }, agent.revision);
  await f.reconciler.retry(agent.id);
}

function run(f: Fixture): Promise<'done' | 'not_live'> {
  return f.service.continueSwitch('agent_support');
}

// Defects caught: a rename, a new handle or a new picture that never reaches the Agent's own app; a save that calls
// Slack itself; a job that sends a stale or partial definition; a second run that sends again.
test('a saved name, handle and avatar arm one job, which brings the app to them and then sends nothing', async (t) => {
  const f = await fixture(t);
  await save(f, { name: 'Helpdesk', handle: 'helpdesk', avatarRevision: 2 });
  assert.deepEqual(f.armed, [{ agentId: 'agent_support', appId: APP, teamId: TEAM, ownerSlackUserId: OWNER }], 'one job');
  assert.deepEqual(f.slack.log, [], 'the save asks nothing of Slack');

  assert.equal(await run(f), 'done');
  assert.deepEqual(f.slack.log, ['export', 'update', 'setIcon']);
  const definition = f.slack.definitions.get(APP)!;
  assert.equal(definition.display_information.name, 'Helpdesk');
  assert.equal(definition.features.bot_user?.display_name, 'helpdesk');
  assert.deepEqual(definition, (await today(f)).manifest, "Slack holds today's definition");
  assert.equal(f.slack.icons.get(APP), 512, 'the picture is set: the default one, as no upload is stored');
  assert.deepEqual(await followsOf(f), (await today(f)).target);
  assert.deepEqual(agentSlackState((await support(f)).slackPresence!), { state: 'own_app' });
  assert.deepEqual(f.main.posted, [], 'nothing to tell when it works');

  f.slack.log.length = 0;
  assert.equal(await run(f), 'done');
  await f.service.followAgent('agent_support');
  assert.deepEqual(f.slack.log, [], 'a second run sends nothing');
  assert.equal(f.armed.length, 1, 'and an app that matches is not armed again');
});

// Defects caught: a picture-only change that resends the definition; a definition change that resets the picture.
test('a new avatar alone sets the picture only, and a rename alone sends the definition only', async (t) => {
  const f = await fixture(t);
  await save(f, { avatarRevision: 2 });
  await run(f);
  assert.deepEqual(f.slack.log, ['setIcon']);
  f.slack.log.length = 0;
  await save(f, { name: 'Helpdesk' });
  await run(f);
  assert.deepEqual(f.slack.log, ['export', 'update']);
});

// Defect caught: a save of an Agent without a live app arming a job or calling Slack.
test('an Agent with no app, and a user-group Agent, arm nothing and make no Slack call', async (t) => {
  const f = await fixture(t);
  await f.service.followAgent('agent_other');
  const other = await f.config.getAgent('agent_other');
  const { userGroupId: _group, ...notInSlack } = other.slackPresence as Extract<AgentSlackPresence, { kind?: 'user_group' }>;
  await f.config.updateAgent(other.id, { slackPresence: { ...notInSlack, desiredState: 'unpublished', health: 'unpublished' } }, other.revision);
  await f.service.followAgent('agent_other');
  assert.deepEqual(f.armed, []);
  assert.deepEqual(f.slack.log, []);
});

// Defect caught: apps made before Chickpea's definition changed (here, before they heard Slack's Stop button) keeping
// the old one forever, because nothing compares them with today's.
test("the sweep arms the job for an app made before an added event, and the job sends it with that event", async (t) => {
  const f = await fixture(t);
  const agent = await support(f);
  const older = structuredClone((await today(f)).manifest);
  older.settings.event_subscriptions.bot_events = older.settings.event_subscriptions.bot_events.filter((event) => event !== 'agent_session_stopped');
  const { slackManifestFingerprint } = await import('../src/slack/app-manifest.ts');
  const presence = agent.slackPresence!;
  assert.equal(presence.kind, 'agent_app');
  if (presence.kind !== 'agent_app' || presence.app.state !== 'active') return;
  await f.config.updateAgent(agent.id, {
    slackPresence: { ...presence, app: { ...presence.app, follows: { manifestFingerprint: slackManifestFingerprint(older), avatarRevision: 1 } } },
  }, agent.revision);
  f.slack.definitions.set(APP, older);

  configureAgentSlackApps(HOST);
  t.after(() => configureAgentSlackApps(undefined));
  const rows: ManagementReceiptOutboxRecord[] = [];
  const management = { putOutbox: async (row: ManagementReceiptOutboxRecord) => { rows.push(row); return row; } };
  await armUnfinishedAgentAppMoves({ config: f.config, management }, NOW, ENV);
  assert.deepEqual(rows.map((row) => row.outboxId), [`agent_app_switch:agent_support:${APP}`], 'Support only; Other has no app');

  await run(f);
  assert.deepEqual(f.slack.definitions.get(APP)?.settings.event_subscriptions.bot_events, [...AGENT_APP_BOT_EVENTS]);
  assert.ok(AGENT_APP_BOT_EVENTS.includes('agent_session_stopped'));
  assert.equal((await followsOf(f))?.manifestFingerprint, (await today(f)).target.manifestFingerprint, "the record is today's");
  rows.length = 0;
  await armUnfinishedAgentAppMoves({ config: f.config, management }, NOW, ENV);
  assert.deepEqual(rows, [], 'and the sweep arms it no more');
});

// Defect caught: the follow quietly asking for a permission the installed app was never granted, which Slack holds
// for an Owner's Allow, or dropping the name change along with it.
test("a definition asking for a permission the app was not granted leaves the app's permissions as granted and still renames it", async (t) => {
  const granted = AGENT_APP_BOT_SCOPES.filter((scope) => scope !== 'channels:join');
  assert.notEqual(granted.length, AGENT_APP_BOT_SCOPES.length, "today's definition asks for one more");
  const f = await fixture(t, { grantedScopes: granted });
  await save(f, { name: 'Helpdesk' });
  await run(f);
  const definition = f.slack.definitions.get(APP)!;
  assert.deepEqual(definition.oauth_config.scopes.bot, granted, 'the permissions are as granted');
  assert.equal(definition.display_information.name, 'Helpdesk');
  assert.deepEqual(await followsOf(f), (await today(f)).target, 'and the app counts as matching, so it is not sent again');
});

// Defects caught: a missing token retried in a loop, or the Owner told on every run; the Agent stopping in Slack;
// a pasted token that never resumes the follow.
test('with no token stored the app stays as it is, needs attention, the Owner is told once, and a pasted token finishes it', async (t) => {
  const f = await fixture(t);
  assert.equal(await discardConfigurationToken(f.secrets, TEAM), 'discarded');
  await save(f, { name: 'Helpdesk' });
  assert.equal(await run(f), 'done');
  assert.deepEqual(f.slack.log, []);
  assert.equal(f.slack.definitions.get(APP)?.display_information.name, 'Support', 'the app keeps its old name');
  const agent = await support(f);
  assert.deepEqual(agentSlackState(agent.slackPresence!), { state: 'own_app', attention: 'config_token_needed' }, 'a live app, still');
  assert.equal(appRecordOf(agent.slackPresence)?.state, 'active', 'the app still answers');
  assert.equal(f.main.posted.length, 1);
  assert.equal(f.main.posted[0]!.text,
    "Chickpea needs a Slack token to update your Agents' Slack apps with their latest names, handles and pictures. They keep answering as before. Paste a new token, and Chickpea updates them.");

  await run(f);
  await f.service.followAgent('agent_support');
  assert.equal(f.main.posted.length, 1, 'told once');
  assert.equal(f.armed.length, 1, 'only the save armed it');

  assert.equal(await f.service.pasteConfigurationToken('xoxe-1-new-token-0000', OWNER), 'saved');
  assert.equal(f.armed.length, 2, 'the paste arms it again');
  await run(f);
  assert.equal(f.slack.definitions.get(APP)?.display_information.name, 'Helpdesk');
  assert.deepEqual(agentSlackState((await support(f)).slackPresence!), { state: 'own_app' });
});

// Defect caught: a token Slack refuses at rotation treated as Slack being down, so the job retries it forever.
test('a token Slack refuses needs attention once, like no token', async (t) => {
  const f = await fixture(t);
  f.clock.now = NOW + 13 * 3_600_000;
  f.slack.refuseRotation = true;
  await save(f, { name: 'Helpdesk' });
  assert.equal(await run(f), 'done');
  assert.deepEqual(agentSlackState((await support(f)).slackPresence!), { state: 'own_app', attention: 'config_token_needed' });
  assert.equal(f.main.posted.length, 1);
  assert.deepEqual(f.slack.log, []);
});

// Defects caught: a refused update retried in a loop, or reported as a token problem; a later rename never retried.
test('an update Slack refuses needs attention with its own reason, is told once, and a later save tries again', async (t) => {
  const f = await fixture(t);
  f.slack.refuseUpdate = new SlackRefused('apps.manifest.update', 'invalid_manifest', [{ pointer: '/display_information/name' }]);
  await save(f, { name: 'Helpdesk' });
  await run(f);
  assert.deepEqual(agentSlackState((await support(f)).slackPresence!), { state: 'own_app', attention: 'update_refused' });
  assert.equal(f.main.posted.length, 1);
  assert.match(f.main.posted[0]!.text, /Slack didn.t accept the changes to Helpdesk, so its Slack app still shows its earlier name, handle or description/);
  f.slack.log.length = 0;
  await run(f);
  await f.service.followAgent('agent_support');
  assert.deepEqual(f.slack.log, [], 'no loop');
  assert.equal(f.main.posted.length, 1, 'told once');

  f.slack.refuseUpdate = undefined;
  await save(f, { name: 'Help desk' });
  assert.equal(f.armed.length, 2);
  await run(f);
  assert.equal(f.slack.definitions.get(APP)?.display_information.name, 'Help desk');
  assert.deepEqual(agentSlackState((await support(f)).slackPresence!), { state: 'own_app' });
});

// Defect caught: Slack not answering recorded as done or as a refusal, so the app never catches up.
test('Slack not answering, or asking to wait, throws for the job to retry, records nothing and tells no one', async (t) => {
  const f = await fixture(t);
  const before = await followsOf(f);
  await save(f, { name: 'Helpdesk' });
  f.slack.unanswered = true;
  await assert.rejects(run(f), SlackUnavailable);
  assert.deepEqual(await followsOf(f), before);
  f.slack.unanswered = false;
  f.slack.refuseUpdate = new SlackRefused('apps.manifest.update', 'ratelimited');
  await assert.rejects(run(f), SlackRefused, 'Slack asking to wait is retried too');
  assert.deepEqual(await followsOf(f), before);
  assert.deepEqual(f.main.posted, []);
  f.slack.refuseUpdate = undefined;
  await run(f);
  assert.equal(f.slack.definitions.get(APP)?.display_information.name, 'Helpdesk');
});

// Defect caught (I5): a configuration token changing an app whose record is missing, unreadable, or another Agent's.
for (const [what, spoil] of [
  ['missing', async (f: Fixture) => { await f.settings.deleteEncryptedCredentialRevision('agent-slack-app.a0app1', (await f.settings.getEncryptedCredentialRevision('agent-slack-app.a0app1'))!.revision); }],
  ['unreadable', async (f: Fixture) => {
    const stored = await f.settings.getEncryptedCredentialRevision('agent-slack-app.a0app1');
    await writeAppSecrets({ ...f.secrets, keyring: generateCredentialKeyring('other') }, APP, 'agent_support', { clientSecret: 'cs', signingSecret: 'ss' }, stored!.revision);
  }],
  ['another Agent\'s', async (f: Fixture) => {
    const stored = await f.settings.getEncryptedCredentialRevision('agent-slack-app.a0app1');
    await writeAppSecrets(f.secrets, APP, 'agent_other', { clientSecret: 'cs', signingSecret: 'ss' }, stored!.revision);
  }],
] as const) {
  test(`an app whose own record is ${what} gets no update and no picture, and is not tried in a loop`, async (t) => {
    const f = await fixture(t);
    t.mock.method(console, 'warn', () => undefined);
    await spoil(f);
    await save(f, { name: 'Helpdesk', avatarRevision: 2 });
    assert.equal(await run(f), 'done');
    assert.deepEqual(f.slack.log, []);
    assert.equal(f.slack.icons.size, 0);
    assert.equal((await followsOf(f))?.refused?.reason, 'record_refused');
    f.armed.length = 0;
    await f.service.followAgent('agent_support');
    assert.deepEqual(f.armed, []);
  });
}

// Defect caught: a crash between the definition and the picture leaving the picture unset for good.
test('a crash after the definition and before the picture is finished by the next run', async (t) => {
  const f = await fixture(t);
  await save(f, { name: 'Helpdesk', avatarRevision: 2 });
  f.slack.crashAfter = 'update';
  await assert.rejects(run(f), Crash);
  assert.equal(f.slack.icons.size, 0);
  f.slack.crashAfter = undefined;
  await run(f);
  assert.equal(f.slack.icons.get(APP), 512);
  assert.deepEqual(await followsOf(f), (await today(f)).target);
  assert.equal(agentAppFollowStep(appRecordOf((await support(f)).slackPresence) as never, (await today(f)).target), undefined);
});

// Defect caught: the state store's sweep reading more for a workspace without the feature, or without an Agent app.
test('the sweep reads nothing with the feature off, and with it on reads only what it read before', async (t) => {
  const f = await fixture(t, { follows: null });
  const reads: string[] = [];
  const config = {
    listWorkspaceInstallations: async () => { reads.push('installations'); return f.config.listWorkspaceInstallations(); },
    listAgents: async () => { reads.push('agents'); return f.config.listAgents(); },
  };
  const rows: string[] = [];
  const management = { putOutbox: async (row: ManagementReceiptOutboxRecord) => { rows.push(row.outboxId); return row; } };
  await armUnfinishedAgentAppMoves({ config, management }, NOW, ENV);
  assert.deepEqual([reads, rows], [[], []], 'off: nothing read');

  configureAgentSlackApps(HOST);
  t.after(() => configureAgentSlackApps(undefined));
  await armUnfinishedAgentAppMoves({ config, management }, NOW, ENV);
  assert.deepEqual(reads, ['installations', 'agents'], 'on: the same two reads, whatever the apps');
  assert.deepEqual(rows, [`agent_app_switch:agent_support:${APP}`], 'an app recorded before follows were kept is brought to match once');
});

/** Other becomes a live app too, recorded before follows were kept, so it is due. */
async function otherIsLive(f: Fixture): Promise<void> {
  const other = await f.config.getAgent('agent_other');
  await f.config.updateAgent(other.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'other', normalizedHandle: 'other', desiredState: 'active', health: 'healthy',
      avatar: other.slackPresence!.avatar,
      app: {
        state: 'active', at: NOW, app: { appId: APP2, clientId: '2.client' }, icon: 'default_avatar', botUserId: 'UBOT2',
        installedAt: NOW, installedBy: OWNER, switchProgress: 'done',
      },
      released: { userGroupId: 'SOTHER' },
    },
  }, other.revision);
  f.slack.definitions.set(APP2, structuredClone(agentAppFollow(other, APP2, HOST, 'inst_a').manifest));
  await writeAppSecrets(f.secrets, APP2, other.id, { clientSecret: 'cs2', signingSecret: 'ss2', botToken: 'xoxb-app2' }, null);
}

async function stateOf(f: Fixture, agentId = 'agent_support') {
  return agentSlackState((await f.config.getAgent(agentId)).slackPresence!);
}

// Defects caught: the Owner told once per saved edit while no token is stored; Try again that never tells again.
test('with no token, three saves tell the Owner once, and Try again clears it so the next failure is told once more', async (t) => {
  const f = await fixture(t);
  assert.equal(await discardConfigurationToken(f.secrets, TEAM), 'discarded');
  for (const name of ['Helpdesk', 'Help desk', 'Helper']) {
    await save(f, { name });
    await run(f);
  }
  assert.equal(f.main.posted.length, 1, 'told once');
  assert.equal(f.armed.length, 1, 'a missing token holds whatever the Agent becomes, so the later saves arm nothing');
  assert.deepEqual(await stateOf(f), { state: 'own_app', attention: 'config_token_needed' });

  await f.service.retry('agent_support', OWNER);
  assert.deepEqual(await stateOf(f), { state: 'own_app' }, 'Try again clears it');
  assert.equal(f.armed.length, 2);
  await run(f);
  assert.equal(f.main.posted.length, 2, 'and the next failure is told again');
});

// Defects caught: one message per live app when the workspace has no token; a message that names one Agent as the
// cause of what every app waits for.
test('two live apps due with no token are one message naming neither, and a paste brings both to match', async (t) => {
  const f = await fixture(t);
  await otherIsLive(f);
  assert.equal(await discardConfigurationToken(f.secrets, TEAM), 'discarded');
  await save(f, { name: 'Helpdesk' });
  await run(f);
  assert.equal(await f.service.continueSwitch('agent_other'), 'done');
  assert.equal(f.main.posted.length, 1, 'one message');
  assert.doesNotMatch(f.main.posted[0]!.text, /Helpdesk|Support|Other/);
  assert.deepEqual([await stateOf(f), await stateOf(f, 'agent_other')], [
    { state: 'own_app', attention: 'config_token_needed' }, { state: 'own_app', attention: 'config_token_needed' },
  ]);

  await f.service.retry('agent_support', OWNER);
  assert.deepEqual(await stateOf(f, 'agent_other'), { state: 'own_app' }, "Try again on one app asks again for every app the token holds up");
  await run(f);
  await f.service.continueSwitch('agent_other');
  assert.equal(f.main.posted.length, 2, 'and the next failure is one more message');

  f.armed.length = 0;
  assert.equal(await f.service.pasteConfigurationToken('xoxe-1-new-token-0000', OWNER), 'saved');
  assert.deepEqual(f.armed.map((job) => job.agentId).sort(), ['agent_other', 'agent_support']);
  await run(f);
  await f.service.continueSwitch('agent_other');
  assert.deepEqual([await stateOf(f), await stateOf(f, 'agent_other')], [{ state: 'own_app' }, { state: 'own_app' }]);
  assert.equal(f.slack.definitions.get(APP)?.display_information.name, 'Helpdesk');
  assert.equal(f.main.posted.length, 2);
});

// Defects caught: a definition Slack keeps refusing told again on every later save; Try again that never tells again.
test('a refusal that stands through later saves is told once, and Try again clears it so a new refusal is told', async (t) => {
  const f = await fixture(t);
  f.slack.refuseUpdate = new SlackRefused('apps.manifest.update', 'invalid_manifest', [{ pointer: '/display_information/name' }]);
  await save(f, { name: 'Helpdesk' });
  await run(f);
  f.slack.log.length = 0;
  await save(f, { name: 'Help desk' });
  await run(f);
  assert.deepEqual(f.slack.log, ['export', 'update'], 'the later save is tried');
  assert.equal(f.main.posted.length, 1, 'and tells no one');
  await f.service.retry('agent_support', OWNER);
  await run(f);
  assert.equal(f.main.posted.length, 2);
});

// Defects caught: an app deleted at Slack told to rename its Agent; a refusal that is not about the definition told to
// change the Agent.
test('an app gone at Slack tells no one and is not tried again; any other refusal says the update did not go through', async (t) => {
  const gone = await fixture(t);
  t.mock.method(console, 'warn', () => undefined);
  gone.slack.definitions.delete(APP);
  await save(gone, { name: 'Helpdesk' });
  assert.equal(await run(gone), 'done');
  assert.deepEqual(gone.main.posted, []);
  assert.equal((await followsOf(gone))?.refused?.reason, 'app_not_found');
  assert.deepEqual(await stateOf(gone), { state: 'own_app' }, 'nothing for an Owner to press: its removal is handled elsewhere');
  gone.slack.log.length = 0;
  await run(gone);
  assert.deepEqual(gone.slack.log, []);

  const other = await fixture(t);
  other.slack.refuseUpdate = new SlackRefused('apps.manifest.update', 'restricted_action');
  await save(other, { name: 'Helpdesk' });
  await run(other);
  assert.deepEqual(await stateOf(other), { state: 'own_app', attention: 'update_failed' });
  assert.equal(other.main.posted[0]?.text,
    "Chickpea couldn't update Helpdesk's Slack app with its latest name, handle or picture. Helpdesk keeps answering as before. Choose Try again.");
});

// Defect caught: an Owner told about an app that was replaced, removed or archived while Slack answered.
test('an app replaced while Slack answered records nothing and tells no one', async (t) => {
  const f = await fixture(t);
  f.slack.refuseUpdate = new SlackRefused('apps.manifest.update', 'invalid_manifest');
  await save(f, { name: 'Helpdesk' });
  f.slack.duringUpdate = async () => {
    const agent = await support(f);
    const presence = agent.slackPresence!;
    if (presence.kind !== 'agent_app' || presence.app.state !== 'active') return;
    const app = { ...presence.app, app: { appId: 'A0APP9', clientId: '9.client' } };
    await f.config.updateAgent(agent.id, { slackPresence: { ...presence, app } }, agent.revision);
  };
  t.mock.method(console, 'warn', () => undefined);
  await run(f);
  assert.deepEqual(f.main.posted, []);
  const app = appRecordOf((await support(f)).slackPresence);
  assert.equal(app?.state === 'active' && app.follows?.refused?.reason, 'record_refused',
    "the refusal is not the new app's; the run goes on to it, which has no record here");
});

// Defects caught: Slack not answering re-armed every few minutes for good, each time a new row and nobody told.
test("Slack not answering on the job's last try is held and told once, and only a change arms it again", async (t) => {
  const f = await fixture(t);
  configureAgentSlackApps(HOST);
  t.after(() => configureAgentSlackApps(undefined));
  await save(f, { name: 'Helpdesk' });
  f.slack.unanswered = true;
  assert.equal(await f.service.continueSwitch('agent_support', { finalAttempt: true, row: 2 }), 'done');
  assert.deepEqual(await stateOf(f), { state: 'own_app', attention: 'update_failed' });
  assert.equal(f.main.posted.length, 1);
  assert.equal((await followsOf(f))?.row, 2, 'the row that ran it is recorded');

  const rows: string[] = [];
  const management = { putOutbox: async (row: ManagementReceiptOutboxRecord) => { rows.push(row.outboxId); return row; } };
  await armUnfinishedAgentAppMoves({ config: f.config, management }, NOW, ENV);
  await f.service.followAgent('agent_support');
  assert.deepEqual([rows, f.armed.length], [[], 1], 'the sweep and later reads arm nothing');

  assert.equal(await f.service.pasteConfigurationToken('xoxe-1-new-token-0000', OWNER), 'saved');
  assert.equal(f.armed.length, 2, 'a pasted token arms it');
  await f.service.continueSwitch('agent_support', { finalAttempt: true, row: 3 });
  assert.equal(f.main.posted.length, 2, 'and its next failure is told again');

  await save(f, { name: 'Help desk' });
  assert.equal(f.armed.length, 3, 'a change arms it');
  assert.equal(f.armed[2]?.firstRow, 3, 'from the row that last ran it');
  f.slack.unanswered = false;
  await run(f);
  assert.deepEqual(await stateOf(f), { state: 'own_app' });
  assert.equal(f.slack.definitions.get(APP)?.display_information.name, 'Help desk');
});

// Defect caught: every arm walking one store call per settled row this app's follow ever left.
test('arming starts at the row that last ran the follow', async () => {
  const calls: string[] = [];
  const base = `agent_app_switch:agent_support:${APP}`;
  const management = {
    putOutbox: async (row: ManagementReceiptOutboxRecord) => {
      calls.push(row.outboxId);
      return { ...row, status: row.outboxId === `${base}:2` ? 'delivered' as const : 'pending' as const };
    },
  };
  await armAgentAppSwitch(management, { agentId: 'agent_support', appId: APP, teamId: TEAM, ownerSlackUserId: OWNER, firstRow: 2 }, NOW);
  assert.deepEqual(calls, [`${base}:2`, `${base}:3`]);
  assert.deepEqual([base, `${base}:1`, `${base}:12`].map(agentAppSwitchRow), [0, 1, 12]);
});

// Defect caught: one failed read of the avatar replacing a custom picture with the default, recorded as done.
test('an avatar that cannot be read fails the picture step for a retry, and never sets the default picture', async (t) => {
  const f = await fixture(t);
  await save(f, { avatarRevision: 2 });
  const read = f.settings.getSetting.bind(f.settings);
  const failing = t.mock.method(f.settings, 'getSetting', async (key: string) => {
    if (key.includes('avatar')) throw Object.assign(new Error('store busy'), { name: 'StoreBusy' });
    return read(key);
  });
  await assert.rejects(run(f), /store busy/);
  assert.deepEqual(f.slack.log, []);
  assert.equal(f.slack.icons.size, 0);
  assert.equal((await followsOf(f))?.avatarRevision, 1);
  failing.mock.restore();
  await run(f);
  assert.equal(f.slack.icons.get(APP), 512);
  assert.equal((await followsOf(f))?.avatarRevision, 2);
});

// Defect caught: a rate-limited rotation during a follow deleting the token and asking the Owner for a new one.
test('a rotation Slack rate-limits during a follow keeps the token, tells no one, and the job retries', async (t) => {
  const f = await fixture(t);
  f.clock.now = NOW + 13 * 3_600_000;
  const rotate = f.slack.rotate.bind(f.slack);
  f.slack.rotate = async () => { throw new SlackRefused('tooling.tokens.rotate', 'ratelimited'); };
  await save(f, { name: 'Helpdesk' });
  t.mock.method(console, 'warn', () => undefined);
  await assert.rejects(run(f), SlackUnavailable);
  assert.deepEqual(f.main.posted, []);
  assert.equal((await followsOf(f))?.refused, undefined);
  f.slack.rotate = rotate;
  f.clock.now += 60_000;
  await run(f);
  assert.equal(f.slack.definitions.get(APP)?.display_information.name, 'Helpdesk');
});

/**
 * The bot scopes Slack lists for each event an Agent app subscribes to; Slack delivers the event when the app holds
 * any one of them, and an empty list needs none.
 */
const EVENT_SCOPES: Readonly<Record<string, readonly string[]>> = {
  agent_session_stopped: ['chat:write'],
  app_mention: ['app_mentions:read'],
  member_joined_channel: ['channels:read', 'groups:read'],
  'message.im': ['im:history'],
  app_uninstalled: [],
  tokens_revoked: [],
};

// Defect caught: a release adding an event whose permission apps made earlier lack, so Slack refuses the follow's
// definition for every one of them and each Owner is told to change an Agent that is not the problem.
test('every event an Agent app hears needs only permissions an app made by an earlier release holds', () => {
  const older = AGENT_APP_BOT_SCOPES.filter((scope) => scope !== OLDER_APPS_LACK);
  for (const event of AGENT_APP_BOT_EVENTS) {
    const needs = EVENT_SCOPES[event];
    assert.ok(needs, `${event} is new: add it to EVENT_SCOPES with the bot scopes Slack lists for it.`);
    assert.ok(needs.length === 0 || needs.some((scope) => older.includes(scope)),
      `${event} needs ${needs.join(' or ')}, which an Agent app made by an earlier release may not hold, so Slack would ` +
      'refuse the definition the follow sends to it. Before adding the event, make the follow leave it out for an app ' +
      'whose exported scopes do not cover it, until an Owner allows the new permission.');
  }
});

// Defect caught: one Agent whose definition cannot be worked out ending the sweep for every Agent after it.
test("a live app whose definition cannot be worked out never stops the sweep for the others", async (t) => {
  const f = await fixture(t);
  await otherIsLive(f);
  t.mock.method(console, 'warn', () => undefined);
  configureAgentSlackApps({ ...HOST, requestUrls: (installationId, appId) => {
    if (appId === APP) throw new Error('no address for this app');
    return HOST.requestUrls(installationId, appId);
  } });
  t.after(() => configureAgentSlackApps(undefined));
  const rows: string[] = [];
  const management = { putOutbox: async (row: ManagementReceiptOutboxRecord) => { rows.push(row.outboxId); return row; } };
  await armUnfinishedAgentAppMoves({ config: f.config, management }, NOW, ENV);
  assert.deepEqual(rows, [`agent_app_switch:agent_other:${APP2}`]);
});

// Defect caught: a long name cut inside an emoji, sending Slack half a character as the app's name.
test("an app's name is cut by character, never inside an emoji", () => {
  const name = `${'a'.repeat(34)}🙂 and more`;
  const { manifest } = agentAppFollow({ ...userAgent('agent_long', name, 'long'), description: name.repeat(5) }, APP, HOST, 'inst_a');
  assert.equal(manifest.display_information.name, 'a'.repeat(34), 'the emoji does not fit whole, so it is left out');
  assert.equal(manifest.display_information.description?.length, 140);
});
