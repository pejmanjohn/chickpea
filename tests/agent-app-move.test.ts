import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  type AgentSlackPresence,
  type CustomAgentConfig,
  agentAppIsLive,
  answeringUserGroupId,
  appRecordOf,
} from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { AgentSlackAppsHost } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, type AgentAppTransport } from '../src/slack/agent-apps/service.ts';
import { readAppSecrets, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import type { AgentAppBotTransport, AgentAppSwitchJob } from '../src/slack/agent-apps/service.ts';
import { type AgentAppSlackApi, SlackRefused } from '../src/slack/agent-apps/slack-api.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { SlackTransportError, type SlackChannel, type SlackTransport, type SlackUserGroup } from '../src/slack/transport/types.ts';
import { escapeMrkdwn } from '../src/slack/ui/text.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const OWNER = 'UOWNER';
const HOST: AgentSlackAppsHost = {
  requestUrls: (installationId, appId) => ({ events: `https://cloud.test/${installationId}/${appId}/e`, interactions: `https://cloud.test/${installationId}/${appId}/i` }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
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
  create() {
    return this.calls.through('create', async () => {
      const n = this.created.length + 1;
      this.created.push(`A0APP${n}`);
      return { appId: `A0APP${n}`, clientId: `${n}.client`, clientSecret: `client-secret-${n}`, signingSecret: `signing-secret-${n}` };
    });
  }
  update() { return this.calls.through('update', async () => undefined); }
  setIcon() { return this.calls.through('setIcon', async () => undefined); }
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

/** Chickpea's own bot. As in Slack, a user group is turned off or on only with the Owner's user-group permission. */
class FakeMainBot implements AgentAppTransport {
  groups = new Map<string, SlackUserGroup>([['S1', { id: 'S1', name: 'Support', handle: 'support', disabled: false }]]);
  ownerPermission = true;
  posted: Array<{ channelId: string; text: string; idempotencyKey: string | undefined }> = [];
  constructor(private readonly calls: Calls) {}
  disableUserGroup(id: string) {
    return this.calls.through('disableUserGroup', async () => this.toggle('usergroups.disable', id, true));
  }
  enableUserGroup(id: string) {
    return this.calls.through('enableUserGroup', async () => this.toggle('usergroups.enable', id, false));
  }
  async lookupUserGroup(id: string) { const group = this.groups.get(id); return group ? { ...group } : undefined; }
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

const CHANNELS = new Map([
  ['CSALES', { private: false }],
  ['CDEALS', { private: false }],
  ['GPRIV', { private: true }],
  ['COTHER', { private: false }],
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
  });
  const reconciler = new AgentPresenceReconciler({
    config, transport: main as unknown as SlackTransport, announce: null, now: () => clock.now,
    agentApps: { retire: async (current) => (await service.retire(current)).agent, bringBotIn: async () => undefined },
  });
  return { config, settings, secrets, slack, main, bot, calls, clock, armed, store, service, reconciler };
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
  assert.deepEqual(f.armed, [{ agentId: 'agent_support', appId: 'A0APP1', installedAt: NOW, teamId: TEAM, ownerSlackUserId: OWNER }]);
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
