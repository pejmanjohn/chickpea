import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SettingsStoreLogic, SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import type { SlackManagementSignal } from '../src/management/slack-tools.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { PrivateAgentPlacementFacts } from '../src/slack/agent-access.ts';
import { configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { resolveAgentRoute } from '../src/slack/agent-routing.ts';
import { slackConversationFacts } from '../src/slack/reading/authority.ts';
import { admitGroupDmPeople } from '../src/slack/group-dm/admission.ts';
import { GroupDmReceipts, SLACK_GROUP_DM_RECEIPT_PREFIX } from '../src/slack/group-dm/receipts.ts';
import {
  routeGroupDmRepliesToAgent,
  SlackGroupDmRefusal,
  SlackGroupDmService,
  type SlackGroupDmServiceOptions,
} from '../src/slack/group-dm/service.ts';
import { assertGroupDmStanding } from '../src/slack/group-dm/runtime.ts';
import { TURN_JOB_TTL_MS, TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const WORKSPACE = 'T0WORK';
const REQUESTER = 'U0REQ';
const GROUP_DM = 'C0GROUP';
const POSTED_TS = '1800000000.000200';
const ASKED = 'loop in <@U0SAM> and <@U0PRIYA|priya> on this in a group DM and summarize where we landed';

function person(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, team_id: WORKSPACE, name: id.toLowerCase(), profile: { real_name: id }, ...extra };
}

function platformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: code },
  });
}

function fakeSlack(input: {
  directory?: Record<string, Record<string, unknown>>;
  current?: Record<string, unknown>;
  infoError?: Error;
  openError?: Error;
  postError?: Error;
} = {}) {
  const directory = input.directory ?? { U0SAM: person('U0SAM'), U0PRIYA: person('U0PRIYA') };
  const calls = { info: [] as string[], users: [] as string[], open: [] as string[], post: [] as Record<string, unknown>[] };
  const client = {
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        calls.info.push(channel);
        if (input.infoError) throw input.infoError;
        return { ok: true, channel: input.current ?? { id: channel, team_id: WORKSPACE, is_channel: true, is_member: true } };
      },
      open: async ({ users }: { users: string }) => {
        calls.open.push(users);
        if (input.openError) throw input.openError;
        return { ok: true, channel: { id: GROUP_DM } };
      },
    },
    users: {
      info: async ({ user }: { user: string }) => {
        calls.users.push(user);
        const found = directory[user];
        if (!found) throw platformError('user_not_found');
        return { ok: true, user: found };
      },
    },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.post.push(args);
        if (input.postError) throw input.postError;
        return { ok: true, channel: args.channel, ts: POSTED_TS };
      },
    },
  };
  return { client: client as unknown as SlackGroupDmServiceOptions['chickpeaBot'], calls };
}

function conversationIn(channelId: string, client: SlackGroupDmServiceOptions['chickpeaBot']) {
  const current = { channelId, threadTs: '1800000000.000001', messageTs: '1800000000.000001' };
  return { current, conversation: slackConversationFacts(client, current) };
}

function groupDms(t: { after(fn: () => void): void }, slack = fakeSlack(), overrides: Partial<SlackGroupDmServiceOptions> = {}) {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const routed: [string, string, string][] = [];
  const service = (more: Partial<SlackGroupDmServiceOptions> = {}) => new SlackGroupDmService({
    workspaceId: WORKSPACE,
    requesterSlackUserId: REQUESTER,
    requestText: ASKED,
    currentConversation: conversationIn('C0PROJECT', slack.client),
    chickpeaBot: slack.client,
    persona: { username: 'Scout', icon_url: 'https://chickpea.example/avatars/scout.png' },
    assertStanding: async () => {},
    receipts: new GroupDmReceipts(settings, 'turn-one'),
    routeRepliesToAgent: async (...args) => { routed.push(args); },
    ...overrides,
    ...more,
  });
  return { service, calls: slack.calls, routed, settings };
}

test('the requester is always in the group DM, first, with only the people they @-mentioned', () => {
  assert.deepEqual(
    admitGroupDmPeople({ requesterSlackUserId: REQUESTER, requestText: ASKED, people: ['<@U0SAM>', 'U0PRIYA', REQUESTER, 'U0SAM'] }),
    { ok: true, people: [REQUESTER, 'U0SAM', 'U0PRIYA'] },
  );
});

test('someone the requester named without an @-mention, or who appears only elsewhere, is not added', () => {
  const admission = admitGroupDmPeople({
    requesterSlackUserId: REQUESTER,
    requestText: 'loop in Sam and <@U0PRIYA> on this',
    people: ['U0SAM', 'U0PRIYA', 'U0LEE'],
  });
  assert.deepEqual(admission, { ok: false, code: 'not_named', people: ['U0SAM', 'U0LEE'] });
});

test('a request no person typed names nobody: an ask from another Agent, a click, a routine', () => {
  assert.deepEqual(
    admitGroupDmPeople({ requesterSlackUserId: REQUESTER, requestText: undefined, people: ['U0SAM'] }),
    { ok: false, code: 'requester_required' },
  );
});

test('a group DM holds one to seven people besides the requester', () => {
  const ids = Array.from({ length: 8 }, (_, index) => `U0P${index}`);
  const text = ids.map((id) => `<@${id}>`).join(' ');
  const admit = (people: string[]) => admitGroupDmPeople({ requesterSlackUserId: REQUESTER, requestText: text, people });
  assert.deepEqual(admit([REQUESTER]), { ok: false, code: 'too_few' });
  assert.deepEqual(admit(ids.slice(0, 7)), { ok: true, people: [REQUESTER, ...ids.slice(0, 7)] });
  assert.deepEqual(admit(ids), { ok: false, code: 'too_many' });
});

test('posting opens the group DM with the requester and the named people, posts as the Agent, and keeps the thread', async (t) => {
  const { service, calls, routed } = groupDms(t);
  const result = await service().start(['U0SAM', 'U0PRIYA'], 'Sam, Priya: Dana asked me to share where we landed.');

  assert.deepEqual(calls.open, [`${REQUESTER},U0SAM,U0PRIYA`]);
  assert.equal(calls.post.length, 1);
  const post = calls.post[0]!;
  assert.equal(post.channel, GROUP_DM);
  assert.equal(post.username, 'Scout');
  assert.equal(post.icon_url, 'https://chickpea.example/avatars/scout.png');
  assert.deepEqual(post.blocks, [{ type: 'markdown', text: 'Sam, Priya: Dana asked me to share where we landed.' }]);
  assert.deepEqual(result, {
    status: 'posted',
    groupDm: {
      channelId: GROUP_DM,
      people: [REQUESTER, 'U0SAM', 'U0PRIYA'],
      messageTs: POSTED_TS,
      link: 'https://slack.com/archives/C0GROUP/p1800000000000200',
    },
    replies: 'Replies in the thread under this message reach you.',
  });
  assert.deepEqual(routed, [[GROUP_DM, POSTED_TS, 'Sam, Priya: Dana asked me to share where we landed.']]);
});

test('apps, bots, deactivated accounts and people from other organizations are refused, and nothing is opened', async (t) => {
  const ids = ['U0BOT', 'U0APP', 'U0GONE', 'U0STRANGER', 'U0CONNECT', 'U0MISSING'];
  const slack = fakeSlack({
    directory: {
      U0BOT: person('U0BOT', { is_bot: true }),
      U0APP: person('U0APP', { is_app_user: true }),
      U0GONE: person('U0GONE', { deleted: true }),
      U0STRANGER: person('U0STRANGER', { is_stranger: true, team_id: 'T0PARTNER' }),
      U0CONNECT: person('U0CONNECT', { team_id: 'T0PARTNER' }),
    },
  });
  const { service, calls } = groupDms(t, slack, { requestText: ids.map((id) => `<@${id}>`).join(' ') });
  const result = await service().start(ids, 'Hello');

  assert.equal(result.code, 'person_not_eligible');
  assert.deepEqual(result.people, [
    { id: 'U0BOT', reason: 'bot' },
    { id: 'U0APP', reason: 'bot' },
    { id: 'U0GONE', reason: 'deactivated' },
    { id: 'U0STRANGER', reason: 'outside_workspace' },
    { id: 'U0CONNECT', reason: 'outside_workspace' },
    { id: 'U0MISSING', reason: 'not_found' },
  ]);
  assert.deepEqual(calls.open, []);
  assert.deepEqual(calls.post, []);
});

test('a guest of this workspace can be added; an Enterprise Grid user of another workspace, or with no team, cannot', async (t) => {
  const slack = fakeSlack({
    directory: {
      U0GUEST: person('U0GUEST', { is_restricted: true }),
      U0OTHERORG: person('U0OTHERORG', { team_id: 'T0PARTNER', enterprise_user: { enterprise_id: 'E0PARTNER' } }),
      U0SISTER: person('U0SISTER', { team_id: 'T0SISTER', enterprise_user: { enterprise_id: 'E0ORG' } }),
      U0NOTEAM: person('U0NOTEAM', { team_id: undefined }),
    },
  });
  const { service } = groupDms(t, slack, { requestText: '<@U0GUEST> <@U0OTHERORG> <@U0SISTER> <@U0NOTEAM>' });
  const refused = await service().start(['U0GUEST', 'U0OTHERORG', 'U0SISTER', 'U0NOTEAM'], 'Hello');
  assert.deepEqual(refused.people, [
    { id: 'U0OTHERORG', reason: 'outside_workspace' },
    { id: 'U0SISTER', reason: 'outside_workspace' },
    { id: 'U0NOTEAM', reason: 'outside_workspace' },
  ]);
  assert.equal((await service({ requestText: '<@U0GUEST>' }).start(['U0GUEST'], 'Hello')).status, 'posted');
});

test('without mpim:write, the result says a workspace Owner must update Chickpea\'s Slack permissions, and nothing is posted', async (t) => {
  for (const hosted of [true, false]) {
    const slack = fakeSlack({ openError: platformError('missing_scope') });
    const { service, calls } = groupDms(t, slack, { hosted });
    const result = await service().start(['U0SAM'], 'Hello');
    assert.equal(result.status, 'refused');
    assert.equal(result.code, 'missing_scope');
    assert.match(String(result.message), hosted
      ? /A workspace Owner needs to update Chickpea's Slack permissions in Chickpea Admin/
      : /needs the permission to start group DMs \(mpim:write\)/);
    assert.deepEqual(calls.post, []);
  }
});

test('a missing permission or a post Slack refused leaves the request free to try again', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const receipts = new GroupDmReceipts(settings, 'turn-one');
  const missing = groupDms(t, fakeSlack({ openError: platformError('missing_scope') }), { receipts });
  assert.equal((await missing.service().start(['U0SAM'], 'Hello')).code, 'missing_scope');
  const refused = groupDms(t, fakeSlack({ postError: platformError('restricted_action') }), { receipts });
  assert.equal((await refused.service().start(['U0SAM'], 'Hello')).code, 'unavailable');
  const healthy = groupDms(t, fakeSlack(), { receipts });
  assert.equal((await healthy.service().start(['U0SAM'], 'Hello')).status, 'posted');
});

test('one group DM per request: a second call, even from a later render, points to the first and posts nothing', async (t) => {
  const { service, calls } = groupDms(t);
  const first = await service().start(['U0SAM', 'U0PRIYA'], 'Hello');
  const again = await service().start(['U0SAM'], 'Hello again');
  assert.equal(again.status, 'already_started');
  assert.deepEqual(again.groupDm, first.groupDm);
  assert.equal(calls.post.length, 1);
});

test('a post Slack did not confirm blocks every later call in the request', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const receipts = new GroupDmReceipts(settings, 'turn-one');
  const lost = groupDms(t, fakeSlack({ postError: new Error('socket hang up') }), { receipts });
  const first = await lost.service().start(['U0SAM'], 'Hello');
  assert.equal(first.status, 'unverified');
  const healthy = groupDms(t, fakeSlack(), { receipts });
  const second = await healthy.service().start(['U0SAM'], 'Hello');
  assert.equal(second.status, 'unverified');
  assert.deepEqual(healthy.calls.post, [], 'the retry posted nothing');
});

test('from a conversation shared with another organization, no one is looked up and nothing is opened', async (t) => {
  const slack = fakeSlack({ current: { id: 'C0PROJECT', team_id: WORKSPACE, is_ext_shared: true, is_member: true } });
  const { service, calls } = groupDms(t, slack);
  const result = await service().start(['U0SAM'], 'Hello');
  assert.equal(result.code, 'shared_conversation');
  assert.deepEqual(calls.users, []);
  assert.deepEqual(calls.open, []);
});

test('from the requester\'s DM, a DM shared with another organization is refused, and one Slack will not describe without im:read counts as the app\'s own', async (t) => {
  const connect = fakeSlack({ current: { id: 'D0DANA', is_im: true, is_ext_shared: true } });
  const shared = groupDms(t, connect, { currentConversation: conversationIn('D0DANA', connect.client) });
  assert.equal((await shared.service().start(['U0SAM'], 'Hello')).code, 'shared_conversation');
  assert.deepEqual(connect.calls.open, []);

  const noImRead = fakeSlack({ infoError: platformError('missing_scope') });
  const own = groupDms(t, noImRead, { currentConversation: conversationIn('D0DANA', noImRead.client) });
  assert.equal((await own.service().start(['U0SAM'], 'Hello')).status, 'posted');
});

test('a standing refusal comes back as the result before Slack is asked anything', async (t) => {
  const { service, calls } = groupDms(t, fakeSlack(), {
    assertStanding: async () => { throw new SlackGroupDmRefusal('not_in_group_dms'); },
  });
  const result = await service().start(['U0SAM'], 'Hello');
  assert.equal(result.code, 'not_in_group_dms');
  assert.match(String(result.message), /Only Agents everyone in this workspace can use work in group DMs/);
  assert.deepEqual(calls, { info: [], users: [], open: [], post: [] });
});

async function standingFixture(suffix: string) {
  const f = await createManagementAdapterFixture(suffix);
  const agent = await f.config.createAgent({
    id: 'agent_scout', name: 'Scout', instructions: 'Help', enabled: true, kind: 'user',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const signal: SlackManagementSignal = {
    agentId: agent.id, workspaceId: f.admin.binding.slackTeamId, channelId: 'C0PROJECT',
    threadTs: '1800000000.000001', messageTs: '1800000000.000001', eventId: 'E0GDM', turnJobId: 'turn_gdm',
    slackUserId: f.admin.binding.slackUserId, conversationKind: 'channel',
  };
  const grant = (channelId: string) => f.config.putAgentChannelGrant({
    workspaceId: signal.workspaceId, channelId, agentId: agent.id, status: 'active',
    createdByMembershipId: f.admin.membership.id, channelLabel: channelId,
  }, 0);
  const channels = (facts: Record<string, { private: boolean } | Error>): PrivateAgentPlacementFacts => ({
    lookupChannel: async (id) => {
      const fact = facts[id];
      if (!fact) throw new Error('channel_not_found');
      if (fact instanceof Error) throw fact;
      return { id, private: fact.private, member: true, archived: false };
    },
    listMemberChannels: async () => new Set(),
  });
  const standing = (overrides: Partial<Parameters<typeof assertGroupDmStanding>[0]> = {}) => assertGroupDmStanding({
    plan: { agentId: agent.id, actorMembershipId: f.admin.membership.id },
    signal, agent, config: f.config, identity: f.identity,
    placementFacts: channels({ C0PROJECT: { private: false } }),
    ...overrides,
  });
  return { f, agent, signal, grant, channels, standing };
}

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SlackGroupDmRefusal, String(error));
    return error.code;
  }
  return 'allowed';
}

test('only an Agent everyone in the workspace can use starts a group DM, as only such an Agent answers in one', async () => {
  const { f, grant, channels, standing } = await standingFixture('gdm-audience');
  try {
    await grant('C0PROJECT');
    assert.equal(await refusalCode(standing()), 'allowed', 'placed in a public Channel');
    assert.equal(await refusalCode(standing({ placementFacts: channels({ C0PROJECT: { private: true } }) })), 'not_in_group_dms');
    assert.equal(await refusalCode(standing({ placementFacts: channels({ C0PROJECT: new Error('ratelimited') }) })), 'unavailable');
  } finally { f.close(); }
});

test('an Agent that answers as its own Slack app is refused while the host serves Agent apps', async () => {
  const { f, agent, grant, standing } = await standingFixture('gdm-agent-app');
  try {
    await grant('C0PROJECT');
    const appAgent = { ...agent, slackPresence: { kind: 'agent_app' } } as unknown as CustomAgentConfig;
    assert.equal(await refusalCode(standing({ agent: appAgent })), 'allowed', 'no host: it posts as Chickpea\'s bot');
    configureAgentSlackApps({ requestUrls: () => ({ events: '', interactions: '' }), redirectUri: '', allowUrl: () => '' });
    try {
      assert.equal(await refusalCode(standing({ agent: appAgent })), 'agent_app');
    } finally { configureAgentSlackApps(undefined); }
  } finally { f.close(); }
});

test('in a Channel the Agent must still be added there', async () => {
  const { f, grant, standing } = await standingFixture('gdm-channel-grant');
  try {
    await grant('C0ELSEWHERE');
    assert.equal(await refusalCode(standing({
      placementFacts: { lookupChannel: async (id) => ({ id, private: false, member: true, archived: false }), listMemberChannels: async () => new Set() },
    })), 'agent_unavailable');
  } finally { f.close(); }
});

test('asked from a group DM, a workspace-wide Agent needs no Channel grant there; a requester who lost access is refused', async () => {
  const { f, signal, grant, standing } = await standingFixture('gdm-from-group');
  try {
    await grant('C0PROJECT');
    const fromGroupDm = { ...signal, channelId: 'C0OTHERGROUP', conversationKind: 'mpim' as const };
    assert.equal(await refusalCode(standing({ signal: fromGroupDm })), 'allowed');
    await f.identity.setMembershipAccessOverlay({
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      accessStatus: 'suspended',
    });
    assert.equal(await refusalCode(standing({ signal: fromGroupDm })), 'requester_unavailable');
  } finally { f.close(); }
});

test('a reply in the opening message\'s thread reaches the Agent that started the group DM', async () => {
  const store = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  try {
    const agent: CustomAgentConfig = await store.createAgent({
      id: 'agent_scout', name: 'Scout', instructions: 'Help', enabled: true, lifecycle: 'active', kind: 'user',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const chickpea = await store.materializeChickpeaAgent();
    await store.ensureWorkspaceInstallation({
      workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: chickpea.id, runtimeContract: 'chickpea-v1',
    });
    await routeGroupDmRepliesToAgent(store, { workspaceId: WORKSPACE, channelId: GROUP_DM, messageTs: POSTED_TS, text: 'Where we landed', agent });

    const routed = await resolveAgentRoute({
      turn: {
        workspaceId: WORKSPACE, channelId: GROUP_DM, eventId: 'Ev0REPLY', text: 'thanks, one question',
        userId: 'U0SAM', messageTs: '1800000000.000300', threadTs: POSTED_TS,
        source: 'implicit_thread_reply', channelType: 'mpim', contextMode: 'thread',
      },
      surface: 'direct',
      actor: { channelMember: false, fullMember: true },
      config: store,
      authorizeUserAgent: async () => ({ status: 'allowed', audience: 'workspace_members' }),
    });
    assert.equal(routed.kind, 'routed');
    if (routed.kind !== 'routed') return;
    assert.equal(routed.assignment.agentId, agent.id);
    assert.equal(routed.source, 'thread_owner');
    const record = await store.listSlackPublicContext(WORKSPACE, GROUP_DM, POSTED_TS);
    assert.deepEqual(record.map(({ role, agentId, text }) => ({ role, agentId, text })),
      [{ role: 'agent', agentId: agent.id, text: 'Where we landed' }]);
  } finally {
    store.close();
  }
});

test('turn retention purges a finished turn\'s group DM receipt and keeps an unfinished one', () => {
  const db = openStateDb(':memory:');
  let clock = 1_800_000_000_000;
  try {
    const jobs = new TurnJobStoreLogic(db, () => clock);
    const settings = new SettingsStoreLogic(db, () => clock);
    const enqueue = (id: string) => jobs.enqueue({
      id, evtKey: `evt:${id}`, msgKey: `msg:${id}`,
      turn: {
        workspaceId: WORKSPACE, channelId: 'D0DANA', eventId: `Ev${id}`, text: 'Synthetic request', userId: REQUESTER,
        messageTs: '1800000000.000100', threadTs: '1800000000.000100', source: 'dm_message', contextMode: 'dm_history', channelType: 'im',
      },
      assignment: {
        workspaceId: WORKSPACE, channelId: 'D0DANA', agentId: 'agent_test',
        agent: { id: 'agent_test', kind: 'user', revision: 1, name: 'Test', instructions: 'Help.', enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [] },
      },
      runId: `run_${id}`,
    });
    for (const id of ['finished', 'unresolved']) {
      enqueue(id);
      settings.setSetting(`${SLACK_GROUP_DM_RECEIPT_PREFIX}${id}`, '{"status":"pending"}');
    }
    jobs.markDelivered('finished');
    clock += TURN_JOB_TTL_MS + 1;
    enqueue('trigger');
    assert.equal(settings.getSetting(`${SLACK_GROUP_DM_RECEIPT_PREFIX}finished`), undefined);
    assert.equal(settings.getSetting(`${SLACK_GROUP_DM_RECEIPT_PREFIX}unresolved`), '{"status":"pending"}');
  } finally { db.close(); }
});
