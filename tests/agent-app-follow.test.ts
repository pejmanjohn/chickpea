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
import { armUnfinishedAgentAppMoves } from '../src/slack/agent-apps/live.ts';
import { discardConfigurationToken, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { AgentSlackApps, type AgentAppSwitchJob, type AgentAppTransport, agentAppFollow } from '../src/slack/agent-apps/service.ts';
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
  assert.deepEqual(agentSlackState(agent.slackPresence!), { state: 'needs_attention', reason: 'config_token_needed' });
  assert.equal(appRecordOf(agent.slackPresence)?.state, 'active', 'the app still answers');
  assert.equal(f.main.posted.length, 1);
  assert.match(f.main.posted[0]!.text, /needs a new Slack refresh token/);

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
  assert.deepEqual(agentSlackState((await support(f)).slackPresence!), { state: 'needs_attention', reason: 'config_token_needed' });
  assert.equal(f.main.posted.length, 1);
  assert.deepEqual(f.slack.log, []);
});

// Defects caught: a refused update retried in a loop, or reported as a token problem; a later rename never retried.
test('an update Slack refuses needs attention with its own reason, is told once, and a later save tries again', async (t) => {
  const f = await fixture(t);
  f.slack.refuseUpdate = new SlackRefused('apps.manifest.update', 'invalid_manifest', [{ pointer: '/display_information/name' }]);
  await save(f, { name: 'Helpdesk' });
  await run(f);
  assert.deepEqual(agentSlackState((await support(f)).slackPresence!), { state: 'needs_attention', reason: 'update_refused' });
  assert.equal(f.main.posted.length, 1);
  assert.match(f.main.posted[0]!.text, /Slack didn.t accept the changes to Helpdesk/);
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
test('Slack not answering throws for the job to retry, records nothing and tells no one', async (t) => {
  const f = await fixture(t);
  const before = await followsOf(f);
  await save(f, { name: 'Helpdesk' });
  f.slack.unanswered = true;
  await assert.rejects(run(f), SlackUnavailable);
  assert.deepEqual(await followsOf(f), before);
  assert.deepEqual(f.main.posted, []);
  f.slack.unanswered = false;
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
