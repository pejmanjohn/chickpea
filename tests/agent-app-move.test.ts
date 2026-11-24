import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  AWAITING_OWN_APP,
  type AgentSlackPresence,
  type CustomAgentConfig,
  agentAppIsLive,
  answeringUserGroupId,
  appRecordOf,
} from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { AgentSlackAppsHost } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, type AgentAppTransport } from '../src/slack/agent-apps/service.ts';
import { agentAppMoveJob } from '../src/slack/agent-apps/lifecycle.ts';
import { discardConfigurationToken, readAppSecrets, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import type { AgentAppBotTransport, AgentAppSwitchJob } from '../src/slack/agent-apps/service.ts';
import { type AgentAppSlackApi, SlackRefused } from '../src/slack/agent-apps/slack-api.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { SlackTransportError, type SlackChannel, type SlackTransport, type SlackUserGroup } from '../src/slack/transport/types.ts';
import { speakerFor } from '../src/slack/speaker.ts';
import { escapeMrkdwn } from '../src/slack/ui/text.ts';
import { captureSlackRefusals } from './helpers/agent-app-refusals.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const OWNER = 'UOWNER';
const HOST: AgentSlackAppsHost = {
  requestUrls: (installationId, appId) => ({ events: `https://cloud.test/${installationId}/${appId}/e`, interactions: `https://cloud.test/${installationId}/${appId}/i` }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
  addUrl: (agentId) => `https://cloud.test/slack/agent-apps/add/${agentId}`,
};
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });
const OPENING = escapeMrkdwn('Support is now its own Slack app. People keep using @support.');
const THROUGH_CHICKPEA = escapeMrkdwn('it keeps answering through Chickpea until someone there adds it.');
const TWICE = escapeMrkdwn("Slack didn't let Chickpea turn off the @support user group, so people may see @support twice when they mention it. Both reach Support.");

class Crash extends Error {
  readonly name = 'Crash';
}

/** Every external call, in order; crashes right after the k-th one completes. */
class Calls {
  log: string[] = [];
  crashAfter: number | undefined;
  async through<T>(name: string, call: () => Promise<T>): Promise<T> {
    const result = await call();
    this.log.push(name);
    if (this.crashAfter !== undefined && this.log.length === this.crashAfter) throw new Crash(`after ${name}`);
    return result;
  }
}

/** Slack's app APIs for the configuration token and one app's OAuth; an OAuth code works once, as in Slack. */
class FakeSlack implements AgentAppSlackApi {
  created: string[] = [];
  deleted: string[] = [];
  uninstalled: string[] = [];
  exchanged: string[] = [];
  constructor(private readonly calls: Calls) {}
  async rotate() {
    return { accessToken: 'xoxe.xoxp-1-access', refreshToken: 'xoxe-1-refresh', teamId: TEAM, expiresAt: NOW + 365 * 86_400_000 };
  }
  /** Slack's answer to the next create, as an `ok: false` code. */
  createRefusal: string | undefined;
  create() {
    return this.calls.through('create', async () => {
      if (this.createRefusal) throw new SlackRefused('apps.manifest.create', this.createRefusal);
      const n = this.created.length + 1;
      this.created.push(`A0APP${n}`);
      return { appId: `A0APP${n}`, clientId: `${n}.client`, clientSecret: `client-secret-${n}`, signingSecret: `signing-secret-${n}` };
    });
  }
  definedBotScopes() { return this.calls.through('export', async () => [...AGENT_APP_BOT_SCOPES]); }
  update() { return this.calls.through('update', async () => undefined); }
  setIcon() { return this.calls.through('setIcon', async () => undefined); }
  async botInstalled(): Promise<never> { throw new Error('not in this unit'); }
  exchange(input: { clientId: string; code: string }) {
    return this.calls.through('exchange', async () => {
      if (this.exchanged.includes(input.code)) throw new SlackRefused('oauth.v2.access', 'invalid_code');
      this.exchanged.push(input.code);
      const n = input.clientId.split('.')[0];
      return {
        botToken: `xoxb-agent-${n}`, botUserId: `UBOT${n}`, teamId: TEAM, appId: `A0APP${n}`, installerUserId: OWNER,
        scopes: [...AGENT_APP_BOT_SCOPES],
      };
    });
  }
  uninstall(input: { botToken: string }) {
    return this.calls.through('uninstall', async () => { this.uninstalled.push(input.botToken); return 'removed' as const; });
  }
  delete(_token: string, appId: string) {
    return this.calls.through('delete', async () => { this.deleted.push(appId); return 'deleted' as const; });
  }
}

/**
 * Chickpea's own bot. As in Slack, a user group is turned off, on or renamed only with the Owner's user-group
 * permission, and a handle another group or a member of the workspace has is refused.
 */
class FakeMainBot implements AgentAppTransport {
  groups = new Map<string, SlackUserGroup>([['S1', { id: 'S1', name: 'Support', handle: 'support', description: 'Support Agent', disabled: false }]]);
  /** Handles Slack holds outside these groups, as a person's. */
  readonly handlesTaken = new Set<string>();
  ownerPermission = true;
  posted: Array<{ channelId: string; text: string; idempotencyKey: string | undefined }> = [];
  /** Channels Chickpea's bot is in; as for any bot, a private one it is not in is not found. */
  readonly in = new Set<string>();
  joined: string[] = [];
  constructor(private readonly calls: Calls) {}
  lookupChannel(channelId: string) {
    return this.calls.through(`main-lookup:${channelId}`, async (): Promise<SlackChannel> => {
      const channel = CHANNELS.get(channelId);
      if (!channel || (channel.private && !this.in.has(channelId))) throw new SlackTransportError('conversations.info', 'channel_not_found');
      return { id: channelId, private: channel.private, member: this.in.has(channelId), archived: channel.archived ?? false };
    });
  }
  /** People who left a Channel, as `channel:user`; everyone else is in each Channel. */
  readonly left = new Set<string>();
  /** Channels whose members Slack refuses to list, as it does for one it will not show this bot. */
  readonly membersRefused = new Set<string>();
  async channelHasMember(channelId: string, userId: string) {
    const channel = CHANNELS.get(channelId);
    if (this.membersRefused.has(channelId)) throw new SlackTransportError('conversations.members', 'fetch_members_failed');
    if (!channel || (channel.private && !this.in.has(channelId))) throw new SlackTransportError('conversations.members', 'channel_not_found');
    return !this.left.has(`${channelId}:${userId}`);
  }
  joinPublicChannel(channelId: string) {
    return this.calls.through(`main-join:${channelId}`, async (): Promise<SlackChannel> => {
      const channel = CHANNELS.get(channelId);
      if (!channel) throw new SlackTransportError('conversations.join', 'channel_not_found');
      if (channel.private) throw new SlackTransportError('conversations.join', 'method_not_supported_for_channel_type');
      if (channel.archived) throw new SlackTransportError('conversations.join', 'is_archived');
      this.in.add(channelId);
      this.joined.push(channelId);
      return { id: channelId, private: false, member: true, archived: false };
    });
  }
  disableUserGroup(id: string) {
    return this.calls.through('disableUserGroup', async () => this.toggle('usergroups.disable', id, true));
  }
  enableUserGroup(id: string) {
    return this.calls.through('enableUserGroup', async () => this.toggle('usergroups.enable', id, false));
  }
  async lookupUserGroup(id: string) { const group = this.groups.get(id); return group ? { ...group } : undefined; }
  async listUserGroups() { return [...this.groups.values()].map((group) => ({ ...group })); }
  updateUserGroup(id: string, patch: { name?: string; handle?: string; description?: string }) {
    return this.calls.through('updateUserGroup', async () => {
      const group = this.groups.get(id);
      if (!group) throw new SlackTransportError('usergroups.update', 'no_such_subteam');
      if (!this.ownerPermission) throw new SlackTransportError('usergroups.update', 'permission_denied');
      const others = [...this.groups.values()].filter((other) => other.id !== id);
      if (patch.handle && (this.handlesTaken.has(patch.handle) || others.some((other) => other.handle === patch.handle))) {
        throw new SlackTransportError('usergroups.update', 'handle_already_exists');
      }
      if (patch.name && others.some((other) => other.name.toLowerCase() === patch.name!.toLowerCase())) {
        throw new SlackTransportError('usergroups.update', 'name_already_exists');
      }
      Object.assign(group, patch);
      return { ...group };
    });
  }
  openDirectConversation(userId: string) {
    return this.calls.through('openDirectConversation', async () => ({ id: `D_${userId}`, private: true, member: true, archived: false }));
  }
  postMessage(input: { channelId: string; text: string; idempotencyKey?: string }) {
    return this.calls.through('postMessage', async () => {
      // Slack drops a second post with the same client_msg_id.
      const earlier = this.posted.findIndex((message) => input.idempotencyKey !== undefined && message.idempotencyKey === input.idempotencyKey);
      if (earlier < 0) this.posted.push({ channelId: input.channelId, text: input.text, idempotencyKey: input.idempotencyKey });
      return { channelId: input.channelId, ts: `${earlier < 0 ? this.posted.length : earlier + 1}.0` };
    });
  }
  private toggle(operation: string, id: string, disabled: boolean): SlackUserGroup {
    const group = this.groups.get(id);
    if (!group) throw new SlackTransportError(operation, 'no_such_subteam');
    if (!this.ownerPermission) throw new SlackTransportError(operation, 'permission_denied');
    if (group.disabled === disabled) throw new SlackTransportError(operation, disabled ? 'already_disabled' : 'already_enabled');
    group.disabled = disabled;
    return { ...group };
  }
}

/**
 * An Agent app's own bot, refusing as Slack refuses an app token: a private Channel it is not in is
 * `channel_not_found`, joining a private Channel is refused, and a DM cannot be read without `im:read`.
 */
class FakeAppBot implements AgentAppBotTransport {
  joined: string[] = [];
  tokens: string[] = [];
  readonly in = new Set<string>();
  constructor(
    private readonly calls: Calls,
    private readonly channels: ReadonlyMap<string, { private: boolean; archived?: boolean }>,
  ) {}
  forToken(botToken: string): AgentAppBotTransport {
    this.tokens.push(botToken);
    return this;
  }
  lookupChannel(channelId: string) {
    return this.calls.through(`lookup:${channelId}`, async (): Promise<SlackChannel> => {
      if (channelId.startsWith('D')) throw new SlackTransportError('conversations.info', 'missing_scope');
      const channel = this.channels.get(channelId);
      if (!channel || (channel.private && !this.in.has(channelId))) throw new SlackTransportError('conversations.info', 'channel_not_found');
      return { id: channelId, private: channel.private, member: this.in.has(channelId), archived: channel.archived ?? false };
    });
  }
  joinPublicChannel(channelId: string) {
    return this.calls.through(`join:${channelId}`, async (): Promise<SlackChannel> => {
      const channel = this.channels.get(channelId);
      if (!channel) throw new SlackTransportError('conversations.join', 'channel_not_found');
      if (channel.private) throw new SlackTransportError('conversations.join', 'method_not_supported_for_channel_type');
      this.in.add(channelId);
      this.joined.push(channelId);
      return { id: channelId, private: false, member: true, archived: false };
    });
  }
}

const CHANNELS = new Map<string, { private: boolean; archived?: boolean }>([
  ['CSALES', { private: false }],
  ['CDEALS', { private: false }],
  ['GPRIV', { private: true }],
  ['COTHER', { private: false }],
  ['COLD', { private: false, archived: true }],
]);

async function fixture(
  t: TestContext,
  options: { userGroupId?: string | undefined; grants?: readonly string[] } = {},
) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  const userGroupId = 'userGroupId' in options ? options.userGroupId : 'S1';
  await config.createAgent({
    id: 'agent_support', kind: 'user', revision: 1, name: 'Support', instructions: 'You are Support.', enabled: true,
    lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', avatar: { kind: 'generated', revision: 1, seed: 'x' },
      ...(userGroupId ? { userGroupId, desiredState: 'active', health: 'healthy' } : { desiredState: 'unpublished', health: 'unpublished' }),
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  } satisfies CustomAgentConfig);
  await config.createAgent({
    id: 'agent_default', kind: 'user', revision: 1, name: 'Default', instructions: 'You are Default.', enabled: true,
    lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: { requestedHandle: 'default', normalizedHandle: 'default', desiredState: 'unpublished', health: 'unpublished', avatar: { kind: 'generated', revision: 1, seed: 'd' } },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  } satisfies CustomAgentConfig);
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: 'agent_default', runtimeContract: 'chickpea-v1' });
  for (const channelId of options.grants ?? ['CSALES', 'CDEALS', 'GPRIV']) {
    await config.putChannel({ workspaceId: TEAM, channelId, lifecycle: 'active' }, 0);
    await config.putAgentChannelGrant({
      workspaceId: TEAM, channelId, agentId: 'agent_support', status: 'active', createdByMembershipId: 'm_owner',
      channelIsPrivate: CHANNELS.get(channelId)?.private ?? false,
    }, 0);
  }
  const calls = new Calls();
  const slack = new FakeSlack(calls);
  const main = new FakeMainBot(calls);
  if (!userGroupId) main.groups.clear();
  const bot = new FakeAppBot(calls, CHANNELS);
  const keyring = generateCredentialKeyring('k1');
  const secrets = { credentials: settings, keyring, slack };
  assert.equal(await saveConfigurationToken(secrets, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  const clock = { now: NOW };
  const armed: AgentAppSwitchJob[] = [];
  const store = { config, crashOnSwitch: false };
  const permission = { missing: false };
  const service = new AgentSlackApps({
    env: ENV,
    stores: {
      // `crashOnSwitch` loses the one write that makes the app live, as a Worker stopping between two stores would.
      config: Object.assign(Object.create(config) as SqliteConfigStore, {
        updateAgent: async (...args: Parameters<SqliteConfigStore['updateAgent']>) => {
          if (store.crashOnSwitch && args[1].slackPresence?.kind === 'agent_app') {
            store.crashOnSwitch = false;
            throw new Crash('before the switch was stored');
          }
          return config.updateAgent(...args);
        },
      }),
      settings,
    },
    host: HOST, transport: main, slack, keyring, now: () => clock.now,
    appBot: (botToken) => bot.forToken(botToken),
    armSwitch: async (job) => { armed.push(job); },
    userGroupPermissionMissing: async () => permission.missing,
    publicOrigin: async () => 'https://chickpea.test',
    // Each membership's Slack user, as an Admin, except one no longer active.
    memberInSlack: async (membershipId) => membershipId === 'm_gone' ? undefined : { membershipId, slackUserId: `U_${membershipId}`, role: 'admin' },
  });
  const reconciler = new AgentPresenceReconciler({
    config, transport: main as unknown as SlackTransport, announce: null, now: () => clock.now,
    agentApps: { retire: async (current) => (await service.retire(current)).agent, bringBotIn: async () => undefined, ownAppMode: async () => false, follow: async () => undefined },
  });
  return { config, settings, secrets, slack, main, bot, calls, clock, armed, store, permission, service, reconciler };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function progressOf(presence: CustomAgentConfig['slackPresence']) {
  const app = appRecordOf(presence);
  return app?.state === 'active' ? app.switchProgress : undefined;
}

async function presenceOf(f: Fixture) {
  return (await f.config.getAgent('agent_support')).slackPresence;
}

/** An Owner's Allow, from the button to Slack's callback with a fresh code. */
let codes = 0;
async function allow(f: Fixture, owner = OWNER): Promise<Response> {
  const opened = await f.service.allow('agent_support', owner);
  assert.equal(opened.status, 303, 'Allow sends the Owner to Slack');
  const state = new URL(opened.headers.get('location')!).searchParams.get('state')!;
  codes += 1;
  return f.service.completeConsent(new URLSearchParams({ code: `code-${codes}`, state }), owner);
}

/** The text of every message the Owner got after the Allow message. */
function ownerMessages(f: Fixture): string[] {
  return f.main.posted.slice(1).map((message) => message.text);
}

// Defects caught: the start turning the group off or writing an `agent_app` presence, so mentions go unanswered
// until Allow; a Home row that offers Start again while an app waits.
test('from the press to Allow the Agent is a user-group Agent: its group answers, no reader sees an app that speaks, and the Home row waits', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.start('agent_support', OWNER)).kind, 'started');
  const presence = await presenceOf(f);
  assert.equal(presence?.kind, undefined);
  assert.equal(answeringUserGroupId(presence), 'S1', 'a mention of @support routes to Support');
  assert.equal(agentAppIsLive(presence), false, 'nothing answers as the app');
  assert.equal(f.main.groups.get('S1')?.disabled, false);
  assert.deepEqual(await f.config.listAgentAppBots(), [], 'no app bot is listed');
  assert.equal(appRecordOf(presence)?.state, 'awaiting_consent');
  const rows = await f.service.homeRows([await f.config.getAgent('agent_support')], { role: 'owner' });
  assert.match(JSON.stringify(rows.get('agent_support')), /ready to add/, 'the Owner sees the app waiting, not the Start offer');
  assert.doesNotMatch(JSON.stringify(rows.get('agent_support')), /agent_app_start/);

  // Slack holding the install for an admin's approval sends the Owner back without a grant; nothing moves, for days.
  const opened = await f.service.allow('agent_support', OWNER);
  const state = new URL(opened.headers.get('location')!).searchParams.get('state')!;
  assert.equal((await f.service.completeConsent(new URLSearchParams({ error: 'access_denied', state }), OWNER)).status, 200);
  f.clock.now = NOW + 7 * 86_400_000;
  await f.service.advance('agent_support');
  await f.service.retry('agent_support', OWNER);
  assert.equal(appRecordOf(await presenceOf(f))?.state, 'awaiting_consent', 'still waiting for Allow');
  assert.equal(answeringUserGroupId(await presenceOf(f)), 'S1', 'and the group still answers');
  assert.equal(f.main.groups.get('S1')?.disabled, false);
  assert.deepEqual(f.armed, []);
});

// Defects caught: the switch running inside Slack's callback, or turning the group off at Allow before the job.
test('Allow makes the app live beside its still-answering group and arms the switch; nothing else happens in the callback', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  f.calls.log.length = 0;
  const response = await allow(f);
  assert.equal(response.status, 303);
  assert.deepEqual(f.calls.log, ['exchange'], 'the callback exchanges the code and nothing more');
  const presence = await presenceOf(f);
  assert.equal(presence?.kind, 'agent_app');
  assert.deepEqual(presence?.kind === 'agent_app' && presence.released, {
    userGroupId: 'S1', desiredState: 'active', health: 'healthy', answers: true,
  });
  assert.equal(answeringUserGroupId(presence), 'S1', 'a mention of the group still reaches Support');
  assert.equal(agentAppIsLive(presence), true, 'and a mention of its bot does too');
  assert.equal(progressOf(presence), 'group_pending');
  assert.equal((await readAppSecrets(f.secrets, 'A0APP1'))?.secrets.botToken, 'xoxb-agent-1');
  assert.deepEqual(f.armed, [{ agentId: 'agent_support', appId: 'A0APP1', teamId: TEAM, ownerSlackUserId: OWNER }]);
  assert.deepEqual(ownerMessages(f), []);
});

// Defects caught: the bot left out of the Agent's Channels after a move; a private Channel joined or listed as joined;
// the group left on; the Owner told nothing, or told twice.
test('the switch turns the group off, brings the bot into each public granted Channel, and tells the Owner both lists once', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
  assert.equal(f.main.groups.get('S1')?.disabled, true);
  const presence = await presenceOf(f);
  assert.equal(answeringUserGroupId(presence), undefined, 'only the bot answers now');
  assert.equal(presence?.kind === 'agent_app' && presence.released?.userGroupId, 'S1');
  assert.equal(progressOf(presence), 'done');
  assert.deepEqual(f.bot.joined.sort(), ['CDEALS', 'CSALES'], 'each public granted Channel, never a private one or one not granted');
  assert.deepEqual([...new Set(f.bot.tokens)], ['xoxb-agent-1'], "the joins use the app's own token");
  assert.deepEqual(ownerMessages(f), [`${OPENING} ${escapeMrkdwn('It joined')} <#CDEALS> and <#CSALES>. In <#GPRIV> ${THROUGH_CHICKPEA}`]);
  assert.equal(f.main.posted[1]?.channelId, `D_${OWNER}`);

  f.bot.in.delete('CSALES');
  f.calls.log.length = 0;
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
  assert.deepEqual(f.calls.log, [], 'a finished switch does nothing again: a Channel the bot was removed from is not rejoined');
  const rows = await f.service.homeRows([await f.config.getAgent('agent_support')], { role: 'owner' });
  assert.match(JSON.stringify(rows.get('agent_support')), /has its own Slack app/);
});

test("the Owner's message leaves out a list that is empty", async (t) => {
  const onlyPublic = await fixture(t, { grants: ['CSALES'] });
  await onlyPublic.service.start('agent_support', OWNER);
  await allow(onlyPublic);
  await onlyPublic.service.continueSwitch('agent_support');
  assert.deepEqual(ownerMessages(onlyPublic), [`${OPENING} ${escapeMrkdwn('It joined')} <#CSALES>.`]);

  const onlyPrivate = await fixture(t, { grants: ['GPRIV'] });
  await onlyPrivate.service.start('agent_support', OWNER);
  await allow(onlyPrivate);
  await onlyPrivate.service.continueSwitch('agent_support');
  assert.deepEqual(onlyPrivate.bot.joined, []);
  assert.deepEqual(ownerMessages(onlyPrivate), [`${OPENING} In <#GPRIV> ${THROUGH_CHICKPEA}`]);

  const none = await fixture(t, { grants: [] });
  await none.service.start('agent_support', OWNER);
  await allow(none);
  await none.service.continueSwitch('agent_support');
  assert.deepEqual(ownerMessages(none), [OPENING]);
});

// Defects caught: a switch cut off between steps that repeats an effect (a second disable, join or message) or
// never finishes without a person.
test('a switch cut off after any Slack call is finished by the next run of its job, with every effect once', async (t) => {
  const clean = await fixture(t);
  await clean.service.start('agent_support', OWNER);
  await allow(clean);
  clean.calls.log.length = 0;
  await clean.service.continueSwitch('agent_support');
  const total = clean.calls.log.length;
  assert.ok(total >= 6, `the switch makes ${total} calls`);
  for (let k = 1; k <= total; k += 1) {
    const f = await fixture(t);
    await f.service.start('agent_support', OWNER);
    await allow(f);
    f.calls.log.length = 0;
    f.calls.crashAfter = k;
    await assert.rejects(() => f.service.continueSwitch('agent_support'), Crash, `cut after call ${k}`);
    f.calls.crashAfter = undefined;
    assert.equal(await f.service.continueSwitch('agent_support'), 'done', `finished after a cut at call ${k}`);
    assert.equal(f.calls.log.filter((name) => name === 'disableUserGroup').length, 1, `one disable after a cut at call ${k}`);
    assert.deepEqual(f.bot.joined.sort(), ['CDEALS', 'CSALES'], `each join once after a cut at call ${k}`);
    assert.deepEqual(ownerMessages(f), ownerMessages(clean), `one message after a cut at call ${k}`);
    const presence = await presenceOf(f);
    assert.equal(progressOf(presence), 'done');
  }
});

// Defects caught: a refused disable retried forever, the Owner told on every try, or the group's mention dropped.
test('a disable Slack refuses leaves both mentions working, tells the Owner once, and is not retried', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  f.main.ownerPermission = false;
  const refusals: unknown[] = [];
  t.mock.method(console, 'warn', (line: { event?: string }) => { refusals.push(line); });
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
  const presence = await presenceOf(f);
  assert.equal(answeringUserGroupId(presence), 'S1', 'the group still reaches Support');
  assert.equal(agentAppIsLive(presence), true, 'and so does the bot');
  assert.equal(f.main.groups.get('S1')?.disabled, false);
  assert.deepEqual(ownerMessages(f), [`${OPENING} ${escapeMrkdwn('It joined')} <#CDEALS> and <#CSALES>. In <#GPRIV> ${THROUGH_CHICKPEA} ${TWICE}`]);
  assert.deepEqual(refusals.map((line) => (line as { code?: string }).code), ['permission_denied']);
  f.calls.log.length = 0;
  await f.service.continueSwitch('agent_support');
  await f.service.retry('agent_support', OWNER);
  assert.deepEqual(f.calls.log, [], 'nothing loops');
  assert.equal(f.armed.length, 1, 'a finished switch arms nothing again');
});

// Defects caught: a crash between storing the token and marking the app live stranding an installed app that never
// goes live; a repeated Allow making a second app or a second switch.
test("a crash between storing the token and marking the app live is repaired by the Owner's next Allow, with one app and one switch", async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  f.store.crashOnSwitch = true;
  await assert.rejects(() => allow(f), Crash);
  assert.equal((await readAppSecrets(f.secrets, 'A0APP1'))?.secrets.botToken, 'xoxb-agent-1', 'the token is stored');
  assert.equal(appRecordOf(await presenceOf(f))?.state, 'awaiting_consent', 'the app reads as not live');
  assert.equal(answeringUserGroupId(await presenceOf(f)), 'S1', 'while the group answers');
  assert.deepEqual(f.armed, []);

  assert.equal((await allow(f)).status, 303);
  assert.equal(agentAppIsLive(await presenceOf(f)), true);
  assert.equal((await f.service.allow('agent_support', OWNER)).status, 409, 'Allow once more says the app is already added');
  assert.deepEqual(f.slack.created, ['A0APP1'], 'one app');
  assert.equal(f.armed.length, 1, 'one switch');
});

test('two callbacks of one Allow make one switch', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  const opened = await f.service.allow('agent_support', OWNER);
  const state = new URL(opened.headers.get('location')!).searchParams.get('state')!;
  const statuses = await Promise.all(['code-a', 'code-b'].map((code) =>
    f.service.completeConsent(new URLSearchParams({ code, state }), OWNER).then((response) => response.status)));
  assert.deepEqual(statuses.sort(), [303, 409], 'one callback completes; the other says the app is already added');
  assert.equal(f.armed.length, 1);
  assert.deepEqual(f.slack.created, ['A0APP1']);
});

test('an Agent with no user group moves the same way, with no group to turn off', async (t) => {
  const f = await fixture(t, { userGroupId: undefined });
  assert.equal((await f.service.start('agent_support', OWNER)).kind, 'started');
  assert.equal((await presenceOf(f))?.kind, undefined);
  assert.equal(appRecordOf(await presenceOf(f))?.state, 'awaiting_consent');
  await allow(f);
  const presence = await presenceOf(f);
  assert.equal(presence?.kind === 'agent_app' && presence.released, undefined);
  await f.service.continueSwitch('agent_support');
  assert.equal(f.calls.log.includes('disableUserGroup'), false);
  assert.deepEqual(f.bot.joined.sort(), ['CDEALS', 'CSALES']);
  assert.equal(ownerMessages(f).length, 1);
});

// Defects caught: an archive mid-move leaving the created app behind, or leaving the Agent's group answering.
test('archiving at each point of the move leaves no app behind and the group off', async (t) => {
  const points: Array<[string, (f: Fixture) => Promise<void>]> = [
    ['waiting for Allow', async (f) => { await f.service.start('agent_support', OWNER); }],
    ['created, before its URLs', async (f) => {
      await f.service.start('agent_support', OWNER);
      const agent = await f.config.getAgent('agent_support');
      const presence = agent.slackPresence!;
      await f.config.updateAgent(agent.id, {
        slackPresence: { ...presence, app: { state: 'created', at: NOW, startedBy: OWNER, app: { appId: 'A0APP1', clientId: '1.client' } } },
      } as never, agent.revision);
    }],
    ['live, before the group is off', async (f) => { await f.service.start('agent_support', OWNER); await allow(f); }],
    ['live, group off, bot not yet in', async (f) => {
      await f.service.start('agent_support', OWNER);
      await allow(f);
      f.calls.crashAfter = f.calls.log.length + 1;
      await assert.rejects(() => f.service.continueSwitch('agent_support'), Crash);
      f.calls.crashAfter = undefined;
    }],
    ['done', async (f) => { await f.service.start('agent_support', OWNER); await allow(f); await f.service.continueSwitch('agent_support'); }],
  ];
  for (const [point, reach] of points) {
    const f = await fixture(t);
    await reach(f);
    const archived = await f.reconciler.archive('agent_support');
    assert.equal(archived.lifecycle, 'archived', point);
    assert.deepEqual(f.slack.deleted, ['A0APP1'], `${point}: the app is deleted`);
    assert.equal(await readAppSecrets(f.secrets, 'A0APP1'), undefined, `${point}: its record is gone`);
    const presence = archived.slackPresence;
    assert.deepEqual(presence && [presence.kind, presence.userGroupId, presence.desiredState, appRecordOf(presence)],
      [undefined, 'S1', 'disabled', undefined], `${point}: the Agent is back on its group, off`);
    assert.equal(f.main.groups.get('S1')?.disabled, true, `${point}: the group is off in Slack`);
  }
});

// Defects caught: a start written by the order before this one, with the group already off, stranded or its app lost.
test('a record written by the order before this one still reaches a live app, keeping the app it has', async (t) => {
  const stored: Array<[string, string]> = [
    ['releasing_handle', '{"state":"releasing_handle","at":1800000000000,"startedBy":"UOWNER"}'],
    ['creating', '{"state":"creating","at":1800000000000,"startedBy":"UOWNER","manifestFingerprint":"f1"}'],
    ['created', '{"state":"created","at":1800000000000,"startedBy":"UOWNER","app":{"appId":"A0APP1","clientId":"1.client"}}'],
    ['urls_set', '{"state":"urls_set","at":1800000000000,"startedBy":"UOWNER","app":{"appId":"A0APP1","clientId":"1.client"}}'],
    ['icon_set', '{"state":"icon_set","at":1800000000000,"startedBy":"UOWNER","app":{"appId":"A0APP1","clientId":"1.client"},"icon":"agent_avatar"}'],
    ['awaiting_consent', '{"state":"awaiting_consent","at":1800000000000,"startedBy":"UOWNER","app":{"appId":"A0APP1","clientId":"1.client"},"icon":"agent_avatar","allowDm":{"channelId":"D_UOWNER","ts":"1.0"},"consent":{"nonceDigest":"d","owner":"UOWNER","expiresAt":1800000900000}}'],
  ];
  for (const [state, json] of stored) {
    const f = await fixture(t);
    const hasApp = json.includes('"app"');
    if (hasApp) {
      // The app the older start created, with its record, as that build stored them.
      f.slack.created.push('A0APP1');
      await writeAppSecrets(f.secrets, 'A0APP1', 'agent_support', { clientSecret: 'client-secret-1', signingSecret: 'signing-secret-1' }, null);
    }
    f.main.groups.get('S1')!.disabled = state !== 'releasing_handle';
    const agent = await f.config.getAgent('agent_support');
    const presence = JSON.parse(`{"kind":"agent_app","requestedHandle":"support","normalizedHandle":"support","desiredState":"active","health":"pending",` +
      `"avatar":{"kind":"generated","revision":1,"seed":"x"},"released":{"userGroupId":"S1"},"app":${json}}`) as AgentSlackPresence;
    await f.config.updateAgent(agent.id, { slackPresence: presence }, agent.revision);

    if (state === 'creating') {
      // A create the older build started and never heard back about: Try again after the settle window.
      f.clock.now = NOW + 60_000;
      await f.service.advance('agent_support');
      assert.equal(appRecordOf(await presenceOf(f))?.state, 'needs_attention', state);
      await f.service.retry('agent_support', OWNER);
    } else {
      await f.service.advance('agent_support');
    }
    assert.equal(appRecordOf(await presenceOf(f))?.state, 'awaiting_consent', `${state}: reaches Allow`);
    assert.equal(await allow(f).then((response) => response.status), 303, `${state}: Allow completes`);
    assert.equal(await f.service.continueSwitch('agent_support'), 'done', state);
    const live = await presenceOf(f);
    assert.equal(agentAppIsLive(live), true, state);
    assert.equal((appRecordOf(live) as { app?: { appId: string } } | undefined)?.app?.appId, 'A0APP1', `${state}: the app it has, or the one Try again made, goes live`);
    assert.deepEqual(f.slack.created, ['A0APP1'], `${state}: no second app`);
    assert.equal(f.main.groups.get('S1')?.disabled, true, `${state}: the group is off`);
    assert.deepEqual(f.bot.joined.sort(), ['CDEALS', 'CSALES'], `${state}: the bot is brought in`);
    assert.equal(f.main.posted.at(-1)?.text.startsWith(OPENING), true, `${state}: the Owner is told`);
  }
});

// Defects caught: a rate-limited disable or join taken as Slack's refusal, so the group stays on or the bot stays
// out for good instead of the job retrying.
test('a Slack call that may succeed later makes the job retry instead of settling', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  const disable = f.main.disableUserGroup.bind(f.main);
  let limited = 1;
  f.main.disableUserGroup = async (id) => {
    if (limited-- > 0) throw new SlackTransportError('usergroups.disable', 'ratelimited');
    return disable(id);
  };
  const join = f.bot.joinPublicChannel.bind(f.bot);
  let down = 1;
  f.bot.joinPublicChannel = async (id) => {
    if (down-- > 0) throw new SlackTransportError('conversations.join', 'service_unavailable');
    return join(id);
  };
  await assert.rejects(() => f.service.continueSwitch('agent_support'), SlackTransportError);
  assert.equal(progressOf(await presenceOf(f)), 'group_pending');
  await assert.rejects(() => f.service.continueSwitch('agent_support'), SlackTransportError);
  assert.equal(progressOf(await presenceOf(f)), 'bring_in_pending');
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
  assert.equal(f.main.groups.get('S1')?.disabled, true);
  assert.deepEqual(f.bot.joined.sort(), ['CDEALS', 'CSALES']);
  assert.equal(ownerMessages(f).some((text) => text.includes('twice')), false);
});

// Defects caught: a run that finishes a step another run already recorded moving the switch back, so it runs again.
test('a run that finishes a step after another run finished the switch moves nothing back and repeats nothing', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  const disable = f.main.disableUserGroup.bind(f.main);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  f.main.disableUserGroup = async (id) => {
    if (first) { first = false; await held; }
    return disable(id);
  };
  const slow = f.service.continueSwitch('agent_support');
  assert.equal(await f.service.continueSwitch('agent_support'), 'done', 'the other run finishes the switch');
  const before = f.calls.log.length;
  release();
  assert.equal(await slow, 'done');
  assert.deepEqual(f.calls.log.slice(before), [], 'the slow run, whose disable Slack answered already_disabled, does nothing more');
  assert.equal(ownerMessages(f).length, 1);
  assert.equal(progressOf(await presenceOf(f)), 'done');
});

// Defects caught: a switch whose job could not be armed left stuck with no way on; a Home row that reads a
// half-done switch as finished.
test('a switch whose job was not armed shows Finish setting up, which arms it again', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  const lines: unknown[] = [];
  t.mock.method(console, 'warn', (line: unknown) => { lines.push(line); });
  const arm = f.service['deps'].armSwitch;
  f.service['deps'].armSwitch = async () => { throw new Error('outbox down'); };
  assert.equal((await allow(f)).status, 303, 'the Owner still reaches Slack');
  assert.deepEqual(lines, [{ event: 'chickpea.agent_app.switch_not_armed', agentId: 'agent_support', appId: 'A0APP1', error: 'Error' }]);
  f.service['deps'].armSwitch = arm;
  const row = async () => JSON.stringify((await f.service.homeRows([await f.config.getAgent('agent_support')], { role: 'owner' })).get('agent_support'));
  assert.match(await row(), /Setting up/);
  f.clock.now = NOW + 2 * 60_000;
  assert.match(await row(), /agent_app_finish/, 'a switch that has not moved offers Finish setting up');
  await f.service.retry('agent_support', OWNER);
  assert.equal(f.armed.length, 1, 'Finish setting up arms the switch');
  await f.service.continueSwitch('agent_support');
  assert.match(await row(), /has its own Slack app/);
});

// Defects caught: an app retired mid-switch storing its still-enabled group as off.
test('an app retired before the switch turned its group off hands back the group as it stood', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  const retired = await f.service.retire(await f.config.getAgent('agent_support'));
  assert.equal(retired.outcome, 'removed');
  const presence = retired.agent.slackPresence;
  assert.deepEqual(presence && [presence.kind, presence.userGroupId, presence.desiredState, presence.health, appRecordOf(presence)],
    [undefined, 'S1', 'active', 'healthy', undefined]);
  assert.equal(f.main.groups.get('S1')?.disabled, false);
});

const UNINSTALLED = { event: { type: 'app_uninstalled' } };
const REMOVED_BACK = escapeMrkdwn("Support's Slack app was removed from this workspace. People can still mention @support, and Support answers through Chickpea. Choose Add Support to Slack to add the app back.");
const REMOVED_UNREACHABLE = escapeMrkdwn("Support's Slack app was removed from this workspace, so people can't mention @support for now. Support still answers through Chickpea in its threads and in messages with Chickpea.");

/** A move through Allow and the whole switch: the app live and holding the handle, the group off. */
async function switched(f: Fixture): Promise<void> {
  await f.service.start('agent_support', OWNER);
  await allow(f);
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
}

/** Hold the main bot's next disable at `point` (before Slack acts, or after it confirmed) until released. */
function holdDisable(f: Fixture, point: 'before_slack' | 'after_slack') {
  const disable = f.main.disableUserGroup.bind(f.main);
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const atHold = new Promise<void>((resolve) => { reached = resolve; });
  let first = true;
  f.main.disableUserGroup = async (id) => {
    if (!first) return disable(id);
    first = false;
    if (point === 'before_slack') { reached(); await held; return disable(id); }
    const done = await disable(id);
    reached();
    await held;
    return done;
  };
  return { release, atHold };
}

function releasedOf(presence: AgentSlackPresence | undefined) {
  return presence?.kind === 'agent_app' ? presence.released : undefined;
}

// Defect caught: a disable Slack confirmed while the app was being removed dropped from the record, which then says
// the group answers when Slack has turned it off.
test('a disable Slack confirmed while Remove App landed is recorded as off, whatever the app did meanwhile', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  const hold = holdDisable(f, 'after_slack');
  const enable = f.main.enableUserGroup.bind(f.main);
  f.main.enableUserGroup = async () => { throw new SlackTransportError('usergroups.enable', 'ratelimited'); };
  const run = f.service.continueSwitch('agent_support');
  await hold.atHold;
  assert.equal(await f.service.end('A0APP1', UNINSTALLED), 'ended');
  assert.equal(releasedOf(await presenceOf(f))?.answers, true, 'Remove App landed before the disable was recorded');
  hold.release();
  await assert.rejects(run, SlackTransportError, 'the restore that follows waits for Slack');
  assert.equal(f.main.groups.get('S1')?.disabled, true);
  assert.equal(releasedOf(await presenceOf(f))?.answers, false, 'the record says what Slack did: the group is off');
  assert.equal(answeringUserGroupId(await presenceOf(f)), undefined);

  f.main.enableUserGroup = enable;
  await f.service.continueSwitch('agent_support');
  assert.equal(f.main.groups.get('S1')?.disabled, false);
  assert.equal(answeringUserGroupId(await presenceOf(f)), 'S1');
});

// Defect caught: a disable that reaches Slack after a restore turned the group back on, leaving Slack's group off while
// the record says it answers.
test('a disable that reaches Slack after the restore turned the group back on is undone, and the Owner is told once', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  const hold = holdDisable(f, 'before_slack');
  const run = f.service.continueSwitch('agent_support');
  await hold.atHold;
  await f.service.end('A0APP1', UNINSTALLED);
  await f.service.continueSwitch('agent_support');
  assert.equal(answeringUserGroupId(await presenceOf(f)), 'S1', 'the restore finished first');
  hold.release();
  await run;
  assert.equal(f.main.groups.get('S1')?.disabled, false, 'Slack has the group on');
  const presence = await presenceOf(f);
  assert.deepEqual(presence && [presence.kind, answeringUserGroupId(presence), appRecordOf(presence)?.state], [undefined, 'S1', 'needs_attention']);
  assert.deepEqual(ownerMessages(f), [REMOVED_BACK]);
});

// Defects caught: Remove App leaving the Agent with its group off and no working mention; the presence returned to
// its group before Slack confirmed it is on; the removed app's record lost, so Allow cannot add it back.
test('Remove App turns the released group back on, then hands the handle back to it with the removed app attached', async (t) => {
  const f = await fixture(t);
  await switched(f);
  f.armed.length = 0;
  f.calls.log.length = 0;
  assert.equal(await f.service.end('A0APP1', UNINSTALLED), 'ended');
  assert.deepEqual(f.calls.log, [], 'the lifecycle event does nothing in Slack itself');
  assert.deepEqual(f.armed, [{ agentId: 'agent_support', appId: 'A0APP1', teamId: TEAM, ownerSlackUserId: OWNER }], 'it arms the move job');
  assert.equal(releasedOf(await presenceOf(f))?.userGroupId, 'S1', 'until Slack confirms, the app holds the handle');

  assert.equal(await f.service.continueSwitch('agent_support'), 'not_live');
  assert.equal(f.main.groups.get('S1')?.disabled, false);
  const presence = await presenceOf(f);
  assert.equal(presence?.kind, undefined, 'a user-group presence again');
  assert.equal(answeringUserGroupId(presence), 'S1', 'a mention of @support routes to Support');
  assert.deepEqual(presence && [presence.desiredState, presence.health], ['active', 'healthy']);
  const app = appRecordOf(presence);
  assert.deepEqual(app?.state === 'needs_attention' && [app.reason, app.app?.appId], ['app_removed', 'A0APP1'], 'the removed app stays attached');
  assert.deepEqual(ownerMessages(f).slice(1), [REMOVED_BACK], 'the Owner is told once');
  assert.equal(f.calls.log.some((call: string) => call === 'updateUserGroup'), false, "a group that has the Agent's name and handle is not renamed");
  assert.equal(speakerFor(presence, { kind: 'chickpea_dm' }).kind, 'chickpea_as_agent');

  f.calls.log.length = 0;
  await f.service.continueSwitch('agent_support');
  assert.deepEqual(f.calls.log, [], 'a finished restore does nothing again');
  assert.equal(agentAppMoveJob('agent_support', presence, TEAM), undefined, 'and leaves nothing for the sweep');

  // Allow adds the same app back, and the switch turns the group off again.
  assert.equal((await allow(f)).status, 303);
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
  assert.equal(agentAppIsLive(await presenceOf(f)), true);
  assert.deepEqual(f.slack.created, ['A0APP1'], 'no second app');
  assert.equal(f.main.groups.get('S1')?.disabled, true);
});

/** A rename saved while the app holds the handle: the Agent's name and handle change, and its app follows them. */
async function rename(f: Fixture, name: string, handle: string): Promise<void> {
  const agent = await f.config.getAgent('agent_support');
  const presence = agent.slackPresence!;
  await f.config.updateAgent(agent.id, { name, slackPresence: { ...presence, requestedHandle: handle, normalizedHandle: handle } }, agent.revision);
}

// Defects caught: a group turned back on under the handle and name it had before a rename made while the app held the
// handle, so the handle the Owner is told people can mention finds nothing in Slack; the rename sent after the Owner
// is told, or after the group already answers under the old handle.
test('a removed app whose Agent was renamed meanwhile gets its group back under the new handle and name before the Owner is told', async (t) => {
  const f = await fixture(t);
  await switched(f);
  await rename(f, 'Helpdesk', 'helpdesk');
  await f.service.end('A0APP1', UNINSTALLED);
  f.calls.log.length = 0;
  assert.equal(await f.service.continueSwitch('agent_support'), 'not_live');
  assert.deepEqual(f.main.groups.get('S1'), { id: 'S1', name: 'Helpdesk', handle: 'helpdesk', description: 'Helpdesk Agent', disabled: false });
  assert.deepEqual(f.calls.log.filter((call) => ['updateUserGroup', 'enableUserGroup', 'postMessage'].includes(call)),
    ['updateUserGroup', 'enableUserGroup', 'postMessage']);
  assert.equal(ownerMessages(f).at(-1), escapeMrkdwn(
    "Helpdesk's Slack app was removed from this workspace. People can still mention @helpdesk, and Helpdesk answers through Chickpea. Choose Add Helpdesk to Slack to add the app back.",
  ));
  const presence = await presenceOf(f);
  assert.deepEqual(presence && [presence.kind, presence.normalizedHandle, answeringUserGroupId(presence)], [undefined, 'helpdesk', 'S1']);
});

const HANDLE_KEPT = escapeMrkdwn(
  "Helpdesk's Slack app was removed from this workspace. Its user group couldn't take the handle @helpdesk, so people can mention @support instead, and Helpdesk answers through Chickpea. Give Helpdesk another handle in Chickpea Admin, or choose Add Helpdesk to Slack to add the app back.",
);

// Defects caught: a handle Slack refused named to the Owner as one people can mention; the Agent's stored handle
// silently changed to the group's; the refusal stopping the restore, so the group stays off; the Agent shown as
// healthy under a handle nothing in Slack answers to, with no way offered to fix it.
test("a handle Slack refuses the restored group leaves it the handle it has, which the Owner is told, and the Agent keeps its own and needs another", async (t) => {
  const f = await fixture(t);
  await switched(f);
  await rename(f, 'Helpdesk', 'helpdesk');
  await f.service.end('A0APP1', UNINSTALLED);
  f.main.handlesTaken.add('helpdesk');
  const refusals = captureSlackRefusals(t);
  assert.equal(await f.service.continueSwitch('agent_support'), 'not_live');
  assert.deepEqual(f.main.groups.get('S1'), { id: 'S1', name: 'Support', handle: 'support', description: 'Support Agent', disabled: false });
  assert.deepEqual(refusals.map(({ step, code }) => [step, code]), [['restore_handle', 'handle_already_exists']]);
  assert.equal(ownerMessages(f).at(-1), HANDLE_KEPT);
  assert.equal(ownerMessages(f).length, 2, 'the switch result, then this one, once');
  const presence = await presenceOf(f);
  assert.deepEqual(presence && [presence.kind, presence.requestedHandle, presence.normalizedHandle, answeringUserGroupId(presence)],
    [undefined, 'helpdesk', 'helpdesk', 'S1'], 'the group answers, and the Agent keeps the handle it stores');
  assert.deepEqual([presence?.desiredState, presence?.health, presence?.errorCode, presence?.handleSuggestions],
    ['active', 'needs_attention', 'handle_collision', ['helpdesk-team', 'helpdesk-2', 'helpdesk-3']]);
  assert.deepEqual(appRecordOf(presence)?.state, 'needs_attention', 'the removed app stays attached, for Add to Slack');

  // The job is safe to repeat: nothing is renamed, turned on or told again, and the group is never turned off.
  f.calls.log.length = 0;
  assert.equal(await f.service.continueSwitch('agent_support'), 'not_live');
  assert.deepEqual(f.calls.log, []);
  assert.equal(f.main.groups.get('S1')?.disabled, false);
});

// Defects caught: Admin's Retry for the taken handle turning the answering group off; another handle chosen in Admin
// not reaching the group, or leaving the Agent needing attention.
test('an Agent whose restored group kept its handle is fixed in Admin: Retry leaves the group answering, and another handle renames it', async (t) => {
  const f = await fixture(t);
  await switched(f);
  await rename(f, 'Helpdesk', 'helpdesk');
  await f.service.end('A0APP1', UNINSTALLED);
  f.main.handlesTaken.add('helpdesk');
  captureSlackRefusals(t);
  assert.equal(await f.service.continueSwitch('agent_support'), 'not_live');

  await assert.rejects(f.reconciler.retry('agent_support'), { code: 'handle_collision' });
  assert.deepEqual(f.main.groups.get('S1'), { id: 'S1', name: 'Support', handle: 'support', description: 'Support Agent', disabled: false });
  assert.equal(answeringUserGroupId(await presenceOf(f)), 'S1');

  await rename(f, 'Helpdesk', 'helpdesk-2');
  const fixed = await f.reconciler.retry('agent_support');
  assert.deepEqual(f.main.groups.get('S1'), { id: 'S1', name: 'Helpdesk', handle: 'helpdesk-2', description: 'Helpdesk Agent', disabled: false });
  const presence = fixed.slackPresence;
  assert.deepEqual([fixed.lifecycle, presence?.health, presence?.errorCode, presence?.handleSuggestions, answeringUserGroupId(presence)],
    ['active', 'healthy', undefined, undefined, 'S1']);
  assert.equal(appRecordOf(presence)?.state, 'needs_attention', 'the removed app stays attached, for Add to Slack');
});

// Defect caught: the restored group renamed onto a handle another Agent in Slack holds, which Slack allows when that
// Agent is its own app, so two Agents answer to one handle.
test('a restored group never takes a handle another Agent in Slack holds, though Slack would allow it', async (t) => {
  const f = await fixture(t);
  await switched(f);
  await rename(f, 'Helpdesk', 'helpdesk');
  const other = await f.config.getAgent('agent_default');
  await f.config.updateAgent(other.id, {
    slackPresence: {
      requestedHandle: 'helpdesk', normalizedHandle: 'helpdesk', avatar: other.slackPresence!.avatar, userGroupId: 'S9', desiredState: 'active', health: 'healthy',
    },
  }, other.revision);
  await f.service.end('A0APP1', UNINSTALLED);
  f.calls.log.length = 0;
  assert.equal(await f.service.continueSwitch('agent_support'), 'not_live');
  assert.equal(f.calls.log.includes('updateUserGroup'), false, 'Slack is not asked');
  assert.deepEqual(f.main.groups.get('S1'), { id: 'S1', name: 'Support', handle: 'support', description: 'Support Agent', disabled: false });
  assert.equal(ownerMessages(f).at(-1), HANDLE_KEPT);
  const presence = await presenceOf(f);
  assert.deepEqual([presence?.normalizedHandle, presence?.health, presence?.errorCode], ['helpdesk', 'needs_attention', 'handle_collision']);
});

// Defects caught: a refused re-enable retried forever or told on every try; the Owner left without the button or the
// pointer that fixes it; the Agent not answering through Chickpea meanwhile.
test('a re-enable Slack refuses leaves the Agent answering through Chickpea, tells the Owner once with Allow and Update in Slack, and waits for an Owner', async (t) => {
  const f = await fixture(t);
  await switched(f);
  await f.service.end('A0APP1', UNINSTALLED);
  f.main.ownerPermission = false;
  f.permission.missing = true;
  t.mock.method(console, 'warn', () => undefined);
  assert.equal(await f.service.continueSwitch('agent_support'), 'not_live');
  const presence = await presenceOf(f);
  assert.equal(presence?.kind, 'agent_app', 'the group is not handed the handle while Slack has it off');
  assert.deepEqual(releasedOf(presence), { userGroupId: 'S1', desiredState: 'active', health: 'healthy', answers: false, enableRefused: true });
  assert.equal(speakerFor(presence, { kind: 'chickpea_dm' }).kind, 'chickpea_as_agent', "it answers in Chickpea's DM");
  assert.equal(speakerFor(presence, { kind: 'channel', appBotIsMember: true, chickpeaBotIsMember: true }).kind, 'chickpea_as_agent', 'and in threads where Chickpea is');
  const told = f.main.posted.slice(-1)[0]!;
  assert.match(told.text, new RegExp(escapeRegExp(REMOVED_UNREACHABLE)));
  assert.match(told.text, /Update in Slack/);
  assert.equal(ownerMessages(f).length, 2, 'the switch result, then this one');
  assert.equal(agentAppMoveJob('agent_support', presence, TEAM), undefined, 'the sweep arms nothing for it');
  f.calls.log.length = 0;
  await f.service.continueSwitch('agent_support');
  assert.deepEqual(f.calls.log, [], 'nothing loops');

  // The Owner adds the permission, then chooses Try again.
  f.main.ownerPermission = true;
  f.permission.missing = false;
  f.armed.length = 0;
  await f.service.retry('agent_support', OWNER);
  assert.equal(f.armed.length, 1, 'Try again arms the restore');
  await f.service.continueSwitch('agent_support');
  assert.equal(f.main.groups.get('S1')?.disabled, false);
  assert.equal(answeringUserGroupId(await presenceOf(f)), 'S1');
  assert.equal(ownerMessages(f).at(-1), REMOVED_BACK);
});

// Defect caught: the mark of a refused restore kept on the app an Owner then allowed again, so that app's next removal
// armed no job, turned no group on and told no one.
test('a restore Slack refused does not stop the next one: Allow adds the app back, and its next removal is restored and told', async (t) => {
  const f = await fixture(t);
  await switched(f);
  await f.service.end('A0APP1', UNINSTALLED);
  f.main.ownerPermission = false;
  f.permission.missing = true;
  t.mock.method(console, 'warn', () => undefined);
  await f.service.continueSwitch('agent_support');
  assert.equal(releasedOf(await presenceOf(f))?.enableRefused, true);

  assert.equal((await allow(f)).status, 303);
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
  assert.equal(releasedOf(await presenceOf(f))?.enableRefused, undefined, 'the refusal went with the removal it followed');

  f.main.ownerPermission = true;
  f.permission.missing = false;
  f.clock.now += 60_000;
  f.armed.length = 0;
  assert.equal(await f.service.end('A0APP1', UNINSTALLED), 'ended');
  assert.equal(f.armed.length, 1, 'the second removal arms its restore');
  await f.service.continueSwitch('agent_support');
  assert.equal(f.main.groups.get('S1')?.disabled, false);
  assert.equal(answeringUserGroupId(await presenceOf(f)), 'S1');
  assert.equal(ownerMessages(f).at(-1), REMOVED_BACK);
});

// Defect caught: a refused re-enable recorded as a group that no longer answers when Slack never turned it off (its
// disable was refused the same way), so mentions of a group people still see stop routing and the Owner is told
// they can't mention it.
test('a refused re-enable of a group Slack never turned off leaves it answering, and the Owner is told people can still mention it', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  f.main.ownerPermission = false;
  f.permission.missing = true;
  t.mock.method(console, 'warn', () => undefined);
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
  assert.equal(answeringUserGroupId(await presenceOf(f)), 'S1', 'the refused disable left the group answering');

  await f.service.end('A0APP1', UNINSTALLED);
  assert.equal(await f.service.continueSwitch('agent_support'), 'not_live');
  assert.equal(f.main.groups.get('S1')?.disabled, false, 'Slack still has the group on');
  const presence = await presenceOf(f);
  assert.equal(presence?.kind, 'agent_app', 'Slack confirmed nothing, so the handle is not handed back');
  assert.equal(answeringUserGroupId(presence), 'S1', 'and a mention of @support still routes to Support');
  assert.equal(ownerMessages(f).at(-1), REMOVED_BACK);
  assert.equal(agentAppMoveJob('agent_support', presence, TEAM), undefined, 'the sweep arms nothing for it');
});

test('the Owner message for a refused re-enable carries Add to Slack, Open Chickpea and Try again', async (t) => {
  const f = await fixture(t);
  await switched(f);
  await f.service.end('A0APP1', UNINSTALLED);
  f.main.ownerPermission = false;
  f.permission.missing = true;
  t.mock.method(console, 'warn', () => undefined);
  const posts: unknown[] = [];
  const post = f.main.postMessage.bind(f.main);
  f.main.postMessage = async (input) => { posts.push(input); return post(input); };
  await f.service.continueSwitch('agent_support');
  const actions = (posts[0] as { blocks: Array<{ type: string; elements?: Array<{ text: { text: string }; url?: string; action_id: string }> }> })
    .blocks.find((block) => block.type === 'actions');
  assert.deepEqual(actions?.elements?.map((button) => button.text.text), ['Add Support to Slack', 'Open Chickpea', 'Try again']);
  assert.equal(actions?.elements?.[0]?.url, 'https://cloud.test/slack/agent-apps/add/agent_support', 'adding the app back is the hand-off link');
  assert.equal(actions?.elements?.[1]?.url, 'https://chickpea.test/admin');
  assert.equal(actions?.elements?.[2]?.action_id, 'agent_app_try_again', 'turning the group back on stays an action');
});

test('Remove App of an Agent that never had a user group gives back its handle-less presence, with the app attached', async (t) => {
  const f = await fixture(t, { userGroupId: undefined });
  await switched(f);
  await f.service.end('A0APP1', UNINSTALLED);
  f.calls.log.length = 0;
  await f.service.continueSwitch('agent_support');
  assert.equal(f.calls.log.some((name) => name.endsWith('UserGroup')), false, 'no group to turn on');
  const presence = await presenceOf(f);
  assert.deepEqual(presence && [presence.kind, presence.userGroupId, presence.desiredState, appRecordOf(presence)?.state],
    [undefined, undefined, 'unpublished', 'needs_attention']);
  assert.equal(ownerMessages(f).at(-1), `${REMOVED_UNREACHABLE} ${escapeMrkdwn('Choose Add Support to Slack to add the app back.')}`);
});

// Defects caught: a Remove App whose restore was never armed, or spent its tries, left for a person; a restore armed
// again by the sweep after Slack refused it, so it loops and tells the Owner again.
test('the move job a presence still owes: a switch with steps left, or a removed app whose group is not back', async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  assert.equal(agentAppMoveJob('agent_support', await presenceOf(f), TEAM), undefined, 'waiting for Allow owes nothing');
  await allow(f);
  const job = { agentId: 'agent_support', appId: 'A0APP1', teamId: TEAM, ownerSlackUserId: OWNER };
  assert.deepEqual(agentAppMoveJob('agent_support', await presenceOf(f), TEAM), job, 'a switch with steps left');
  await f.service.continueSwitch('agent_support');
  assert.equal(agentAppMoveJob('agent_support', await presenceOf(f), TEAM), undefined, 'a finished switch');
  await f.service.end('A0APP1', UNINSTALLED);
  assert.deepEqual(agentAppMoveJob('agent_support', await presenceOf(f), TEAM), job, 'a removed app whose group is not back');
});

// Defects caught: the Owner's result message, refused by Slack, retried until the job fails, so the switch stops one
// step short for good; and the Home row then hiding what the message would have said.
test("a result message Slack refuses is given up with one operator line, the switch finishes, and the Owner's Home row says what it would have", async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  f.main.openDirectConversation = async () => { throw new SlackTransportError('conversations.open', 'user_not_found'); };
  const lines: unknown[] = [];
  t.mock.method(console, 'warn', (line: unknown) => { lines.push(line); });
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');
  const presence = await presenceOf(f);
  assert.equal(progressOf(presence), 'done');
  assert.equal(f.main.groups.get('S1')?.disabled, true);
  assert.deepEqual(f.bot.joined.sort(), ['CDEALS', 'CSALES']);
  assert.deepEqual(lines, [{ event: 'chickpea.agent_app.switch_owner_not_told', agentId: 'agent_support', appId: 'A0APP1', error: 'user_not_found' }]);
  const row = JSON.stringify((await f.service.homeRows([await f.config.getAgent('agent_support')], { role: 'owner' })).get('agent_support'));
  assert.ok(row.includes(JSON.stringify(`${OPENING} In <#GPRIV> ${THROUGH_CHICKPEA}`).slice(1, -1)), row);
  assert.doesNotMatch(row, /agent_app_finish/);
});

test("a result message that keeps failing is retried by the job, and given up on its last try so the switch still finishes", async (t) => {
  const f = await fixture(t);
  await f.service.start('agent_support', OWNER);
  await allow(f);
  f.main.postMessage = async () => { throw new SlackTransportError('chat.postMessage', 'ratelimited'); };
  await assert.rejects(() => f.service.continueSwitch('agent_support'), SlackTransportError);
  assert.equal(progressOf(await presenceOf(f)), 'owner_told');
  t.mock.method(console, 'warn', () => undefined);
  assert.equal(await f.service.continueSwitch('agent_support', { finalAttempt: true }), 'done');
  assert.equal(progressOf(await presenceOf(f)), 'done');
  const row = JSON.stringify((await f.service.homeRows([await f.config.getAgent('agent_support')], { role: 'owner' })).get('agent_support'));
  assert.match(row, /is now its own Slack app/);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// Defects caught: a Channel an Agent not in Slack yet was added to staying pending after Allow, so the new app never
// answers there; only the creator's adds completed, so a Channel an Owner or editor added later was lost; a Channel
// made active for someone who has since left it, or left the workspace.
test('an Agent born as its own app gets every Channel it was added to while waiting once Allow switches it', async (t) => {
  const f = await fixture(t, { userGroupId: undefined, grants: [] });
  const created = await f.config.getAgent('agent_support');
  await f.config.updateAgent(created.id, {
    creatorMembershipId: 'm_creator',
    slackPresence: { ...created.slackPresence!, desiredState: 'active', errorCode: AWAITING_OWN_APP },
  }, created.revision);
  for (const [channelId, by] of [['CSALES', 'm_creator'], ['CDEALS', 'm_other'], ['COTHER', 'm_left'], ['GPRIV', 'm_gone']] as const) {
    await f.config.putChannel({ workspaceId: TEAM, channelId, lifecycle: 'active' }, 0);
    await f.config.putAgentChannelGrant({
      workspaceId: TEAM, channelId, agentId: 'agent_support', status: 'pending', createdByMembershipId: by, channelIsPrivate: false,
    }, 0);
  }

  f.main.left.add('COTHER:U_m_left');
  f.main.in.add('GPRIV');

  assert.equal((await f.service.start('agent_support', OWNER)).kind, 'started');
  assert.equal((await presenceOf(f))?.errorCode, AWAITING_OWN_APP, 'not in Slack until Allow');
  await allow(f);
  await f.service.continueSwitch('agent_support');

  const grants = Object.fromEntries((await f.config.listAgentChannelGrants()).map((grant) => [grant.channelId, grant.status]));
  assert.deepEqual(grants, { CDEALS: 'active', COTHER: 'pending', CSALES: 'active', GPRIV: 'pending' },
    'each ends as its writer\'s add, checked again: one who left the Channel, or is no longer a member, leaves it waiting');
  assert.deepEqual(f.bot.joined.sort(), ['CDEALS', 'CSALES'], 'the bot joins each');
  assert.match(ownerMessages(f).join('\n'), /It joined <#CSALES> and <#CDEALS>\.|It joined <#CDEALS> and <#CSALES>\./);
  assert.equal((await presenceOf(f))?.errorCode, undefined, 'in Slack now');
  await f.service.continueSwitch('agent_support');
  assert.deepEqual(f.bot.joined.sort(), ['CDEALS', 'CSALES'], 'a rerun repeats nothing');
});

// Defects caught: Slack refusing to say who is in one waiting Channel stopping the whole switch on every run, so the
// new app joins no Channel and its Owner is never told.
test('a waiting Channel whose members Slack refuses to list stays waiting, and the switch still finishes', async (t) => {
  const f = await fixture(t, { userGroupId: undefined, grants: [] });
  const created = await f.config.getAgent('agent_support');
  await f.config.updateAgent(created.id, {
    creatorMembershipId: 'm_creator',
    slackPresence: { ...created.slackPresence!, desiredState: 'active', errorCode: AWAITING_OWN_APP },
  }, created.revision);
  for (const channelId of ['CSALES', 'CDEALS']) {
    await f.config.putChannel({ workspaceId: TEAM, channelId, lifecycle: 'active' }, 0);
    await f.config.putAgentChannelGrant({
      workspaceId: TEAM, channelId, agentId: 'agent_support', status: 'pending', createdByMembershipId: 'm_creator', channelIsPrivate: false,
    }, 0);
  }
  f.main.membersRefused.add('CDEALS');

  assert.equal((await f.service.start('agent_support', OWNER)).kind, 'started');
  await allow(f);
  assert.equal(await f.service.continueSwitch('agent_support'), 'done');

  const grants = Object.fromEntries((await f.config.listAgentChannelGrants()).map((grant) => [grant.channelId, grant.status]));
  assert.deepEqual(grants, { CDEALS: 'pending', CSALES: 'active' });
  assert.deepEqual(f.bot.joined, ['CSALES']);
  assert.match(ownerMessages(f).join('\n'), /It joined <#CSALES>\./);
});

// Defects caught: an app-limit refusal shown as a broken app that needs attention, or the Agent left with a record.
test("Slack's app limit leaves the Agent as it was, with the message that says why", async (t) => {
  for (const code of ['managed_app_limit_reached', 'service_limits_exceeded']) {
    const f = await fixture(t, { userGroupId: undefined, grants: [] });
    f.slack.createRefusal = code;

    assert.deepEqual(await f.service.start('agent_support', OWNER), { kind: 'app_limit' });

    assert.equal(appRecordOf(await presenceOf(f)), undefined, 'no app record is left');
    assert.deepEqual(f.slack.created, []);
    assert.deepEqual(f.main.posted.map((message) => [message.channelId, message.text]), [[`D_${OWNER}`, escapeMrkdwn(
      "Slack wouldn't create another app for this workspace, which may have reached Slack's limit on apps. Deleting an app you no longer need in Slack and adding Support again may help.",
    )]]);
    f.slack.createRefusal = undefined;
    assert.equal((await f.service.start('agent_support', OWNER)).kind, 'started', 'a later press starts afresh');
  }
});

// Defects caught: a Slack press with no token doing nothing, so the Owner never learns what to do.
test("an Owner's press from Slack with no token shows the way to add one and starts nothing", async (t) => {
  const f = await fixture(t, { userGroupId: undefined, grants: [] });
  await discardConfigurationToken(f.secrets, TEAM);
  const before = f.main.posted.length;

  const { response, pressed } = await f.service.addPress('agent_support', OWNER);

  assert.equal(pressed, 'token_needed');
  assert.equal(response.status, 409);
  const html = await response.text();
  assert.match(html, /Slack needs one token first/);
  assert.match(html, /href="[^"]*\/admin\/destinations\/slack\/connection\/token">Add the token</);
  assert.equal(appRecordOf(await presenceOf(f)), undefined);
  assert.equal(f.main.posted.length, before, 'the page says it; no message is sent');
});
