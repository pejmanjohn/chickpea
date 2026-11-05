import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SettingsStoreLogic, SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import type { SlackManagementSignal } from '../src/management/slack-tools.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { PrivateAgentPlacementFacts } from '../src/slack/agent-access.ts';
import { AGENT_CHANNEL_ADD_ACTION } from '../src/slack/agent-channel-offer.ts';
import { configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { resolveAgentRoute } from '../src/slack/agent-routing.ts';
import { assertChannelCreateStanding, offerChannelAgentAccess } from '../src/slack/channel-creation/runtime.ts';
import {
  CHANNEL_CREATE_RECEIPT_CODEC,
  SLACK_CHANNEL_CREATE_RECEIPT_PREFIX,
  SlackChannelCreateRefusal,
  SlackChannelCreateService,
  slackChannelName,
  type ChannelCreateReceipt,
  type ChannelRequest,
  type SlackChannelCreateServiceOptions,
} from '../src/slack/channel-creation/service.ts';
import { slackConversationFacts } from '../src/slack/reading/authority.ts';
import { RequestReceipt } from '../src/slack/requested-conversations/receipts.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { routeRepliesToAgent } from '../src/slack/requested-conversations/replies.ts';
import { TURN_JOB_TTL_MS, TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const WORKSPACE = 'T0WORK';
const REQUESTER = 'U0REQ';
const CREATED = 'C0ACME';
const POSTED_TS = '1800000000.000200';
const ALREADY_IN = 'already_in_channel';
const ASKED = 'spin up a private channel for the Acme renewal with <@U0SAM> and <@U0PRIYA|priya> and post a kickoff summary';

function person(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, team_id: WORKSPACE, name: id.toLowerCase(), profile: { real_name: id }, ...extra };
}

function platformError(code: string, data: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: code, ...data },
  });
}

function fakeSlack(input: {
  directory?: Record<string, Record<string, unknown>>;
  current?: Record<string, unknown>;
  createError?: Error;
  createdName?: string;
  inviteErrors?: Error[];
  members?: string[] | Error;
  purposeError?: Error;
  postError?: Error;
} = {}) {
  const directory = input.directory ?? { U0SAM: person('U0SAM'), U0PRIYA: person('U0PRIYA') };
  const inviteErrors = [...input.inviteErrors ?? []];
  const calls = {
    info: [] as string[], users: [] as string[], create: [] as Record<string, unknown>[], invite: [] as string[],
    members: [] as string[], purpose: [] as string[], post: [] as Record<string, unknown>[],
  };
  const client = {
    users: {
      info: async ({ user }: { user: string }) => {
        calls.users.push(user);
        const found = directory[user];
        if (!found) throw platformError('user_not_found');
        return { ok: true, user: found };
      },
    },
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        calls.info.push(channel);
        return { ok: true, channel: input.current ?? { id: channel, team_id: WORKSPACE, is_channel: true, is_member: true } };
      },
      create: async (args: Record<string, unknown>) => {
        calls.create.push(args);
        if (input.createError) throw input.createError;
        return { ok: true, channel: { id: CREATED, name: input.createdName ?? args.name, is_private: args.is_private } };
      },
      invite: async ({ users }: { users: string }) => {
        calls.invite.push(users);
        const error = inviteErrors.shift();
        if (error) throw error;
        return { ok: true, channel: { id: CREATED } };
      },
      members: async ({ channel }: { channel: string }) => {
        calls.members.push(channel);
        if (input.members instanceof Error) throw input.members;
        return { ok: true, members: input.members ?? [] };
      },
      setPurpose: async ({ purpose }: { purpose: string }) => {
        calls.purpose.push(purpose);
        if (input.purposeError) throw input.purposeError;
        return { ok: true };
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
  return { client: client as unknown as SlackChannelCreateServiceOptions['chickpeaBot'], calls };
}

function conversationIn(channelId: string, client: SlackChannelCreateServiceOptions['chickpeaBot']) {
  const current = { channelId, threadTs: '1800000000.000001', messageTs: '1800000000.000001' };
  return { current, conversation: slackConversationFacts(client as never, current) };
}

function channelReceipt(settings: SqliteSettingsStore, turn = 'turn-one') {
  return new RequestReceipt<ChannelCreateReceipt>(settings, `${SLACK_CHANNEL_CREATE_RECEIPT_PREFIX}${turn}`, CHANNEL_CREATE_RECEIPT_CODEC);
}

function channels(t: { after(fn: () => void): void }, slack = fakeSlack(), overrides: Partial<SlackChannelCreateServiceOptions> = {}) {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const routed: [string, string, string][] = [];
  const service = (more: Partial<SlackChannelCreateServiceOptions> = {}) => new SlackChannelCreateService({
    workspaceId: WORKSPACE,
    requesterSlackUserId: REQUESTER,
    requesterText: ASKED,
    requesterTextSource: undefined,
    currentConversation: conversationIn('C0PROJECT', slack.client),
    chickpeaBot: slack.client,
    persona: { username: 'Scout', icon_url: 'https://chickpea.example/avatars/scout.png' },
    assertStanding: async () => {},
    receipt: channelReceipt(settings),
    routeRepliesToAgent: async (...args) => { routed.push(args); },
    agentAccess: async () => ({ status: 'not_needed' }),
    ...overrides,
    ...more,
  });
  return { service, calls: slack.calls, routed, settings };
}

const request = (more: Partial<ChannelRequest> = {}): ChannelRequest => ({
  name: 'acme-renewal',
  visibility: 'private',
  people: ['U0SAM', 'U0PRIYA'],
  message: 'Kickoff: Dana asked me to set this up for the Acme renewal.',
  ...more,
});

test('a proposed name becomes a valid Slack name: lowercase, no spaces or periods, at most 80 characters', () => {
  assert.equal(slackChannelName('Acme Renewal Q3.2026'), 'acme-renewal-q3-2026');
  assert.equal(slackChannelName('  #Incident -- API outage!! '), 'incident-api-outage');
  assert.equal(slackChannelName('café_ops'), 'café_ops');
  assert.equal(slackChannelName('a'.repeat(79) + ' bcd'), 'a'.repeat(79), 'a cut never leaves a trailing hyphen');
  assert.equal(slackChannelName('x'.repeat(120)), 'x'.repeat(80));
  assert.equal(slackChannelName('...'), undefined);
});

test('a name with nothing usable is refused before Slack is asked anything', async (t) => {
  const { service, calls } = channels(t);
  const result = await service().create(request({ name: '!!!' }));
  assert.equal(result.code, 'invalid_name');
  assert.deepEqual(calls.users, []);
  assert.deepEqual(calls.create, []);
});

test('creating makes the private channel, invites the requester first and the named people, sets the purpose, and posts as the Agent', async (t) => {
  const { service, calls, routed } = channels(t);
  const result = await service().create(request({ name: 'Acme Renewal', purpose: 'Acme renewal, Q3' }));

  assert.deepEqual(calls.create, [{ name: 'acme-renewal', is_private: true }]);
  assert.deepEqual(calls.invite, [`${REQUESTER},U0SAM,U0PRIYA`]);
  assert.deepEqual(calls.purpose, ['Acme renewal, Q3']);
  const post = calls.post[0]!;
  assert.equal(post.channel, CREATED);
  assert.equal(post.username, 'Scout');
  assert.equal(post.icon_url, 'https://chickpea.example/avatars/scout.png');
  assert.deepEqual(post.blocks, [{ type: 'markdown', text: 'Kickoff: Dana asked me to set this up for the Acme renewal.' }]);
  assert.deepEqual(result, {
    status: 'created',
    channel: { id: CREATED, name: 'acme-renewal', visibility: 'private', link: 'https://slack.com/archives/C0ACME' },
    invited: [REQUESTER, 'U0SAM', 'U0PRIYA'],
    opening: { messageTs: POSTED_TS, link: 'https://slack.com/archives/C0ACME/p1800000000000200' },
    replies: 'Replies in the thread under your opening message reach you.',
  });
  assert.deepEqual(routed, [[CREATED, POSTED_TS, 'Kickoff: Dana asked me to set this up for the Acme renewal.']]);
});

test('a public channel is created public only when asked; with nobody named, only the requester is invited', async (t) => {
  const { service, calls } = channels(t);
  const result = await service().create(request({ visibility: 'public', people: [] }));
  assert.deepEqual(calls.create, [{ name: 'acme-renewal', is_private: false }]);
  assert.deepEqual(calls.invite, [REQUESTER]);
  assert.equal((result.channel as { visibility: string }).visibility, 'public');
});

test('once web content entered the conversation, a public channel is refused and a private one is still created', async (t) => {
  const { service, calls } = channels(t, fakeSlack(), { webContentRead: true });
  const refused = await service().create(request({ visibility: 'public' }));
  assert.deepEqual([refused.status, refused.code], ['refused', 'public_after_web_content']);
  assert.deepEqual(calls.create, []);
  assert.equal((await service().create(request())).status, 'created');
  assert.deepEqual(calls.create, [{ name: 'acme-renewal', is_private: true }]);
});

test('only people the requester @-mentioned in their own words are invited, and at most 30 of them', async (t) => {
  const { service, calls } = channels(t);
  const unnamed = await service({ requesterText: 'make a channel with Sam and <@U0PRIYA>' }).create(request({ people: ['U0SAM', 'U0PRIYA'] }));
  assert.deepEqual([unnamed.code, unnamed.people], ['not_named', [{ id: 'U0SAM', reason: 'not_named' }]]);
  for (const [requesterText, requesterTextSource] of [
    [undefined, undefined],
    ['Chose: channel with <@U0SAM>', 'click'],
    ['Setup finished. <@U0SAM>', 'setup'],
  ] as const) {
    const result = await service({ requesterText, requesterTextSource }).create(request({ people: [] }));
    assert.equal(result.code, 'requester_required', requesterTextSource ?? 'no requester text');
  }
  const ids = Array.from({ length: 31 }, (_, index) => `U0P${index}`);
  const crowd = await service({ requesterText: ids.map((id) => `<@${id}>`).join(' ') }).create(request({ people: ids }));
  assert.equal(crowd.code, 'too_many');
  assert.deepEqual(calls.create, []);
});

test('guests, bots, deactivated accounts and people from other organizations are refused, and nothing is created', async (t) => {
  const ids = ['U0GUEST', 'U0SINGLE', 'U0BOT', 'U0GONE', 'U0CONNECT', 'U0MISSING'];
  const slack = fakeSlack({
    directory: {
      U0GUEST: person('U0GUEST', { is_restricted: true }),
      U0SINGLE: person('U0SINGLE', { is_ultra_restricted: true }),
      U0BOT: person('U0BOT', { is_bot: true }),
      U0GONE: person('U0GONE', { deleted: true }),
      U0CONNECT: person('U0CONNECT', { team_id: 'T0PARTNER', enterprise_user: { enterprise_id: 'E0PARTNER' } }),
    },
  });
  const { service, calls } = channels(t, slack, { requesterText: ids.map((id) => `<@${id}>`).join(' ') });
  const result = await service().create(request({ people: ids }));
  assert.equal(result.code, 'person_not_eligible');
  assert.deepEqual(result.people, [
    { id: 'U0GUEST', reason: 'guest' },
    { id: 'U0SINGLE', reason: 'guest' },
    { id: 'U0BOT', reason: 'bot' },
    { id: 'U0GONE', reason: 'deactivated' },
    { id: 'U0CONNECT', reason: 'outside_workspace' },
    { id: 'U0MISSING', reason: 'not_found' },
  ]);
  assert.deepEqual(calls.create, []);
});

test('from a conversation shared with another organization, no one is looked up and nothing is created', async (t) => {
  const slack = fakeSlack({ current: { id: 'C0PROJECT', team_id: WORKSPACE, is_ext_shared: true, is_member: true } });
  const { service, calls } = channels(t, slack);
  const result = await service().create(request());
  assert.equal(result.code, 'shared_conversation');
  assert.deepEqual(calls.users, []);
  assert.deepEqual(calls.create, []);
});

test('a standing refusal comes back before Slack is asked anything, with the visibility asked for', async (t) => {
  let asked: string | undefined;
  const { service, calls } = channels(t, fakeSlack(), {
    assertStanding: async (visibility) => {
      asked = visibility;
      throw new SlackChannelCreateRefusal('not_workspace_wide');
    },
  });
  const result = await service().create(request({ visibility: 'public' }));
  assert.equal(asked, 'public');
  assert.equal(result.code, 'not_workspace_wide');
  assert.match(String(result.message), /Only Agents everyone in this workspace can use create public channels/);
  assert.deepEqual(calls, { info: [], users: [], create: [], invite: [], members: [], purpose: [], post: [] });
});

test('each Slack refusal at creation comes back as its own refusal, and nothing is invited or posted', async (t) => {
  for (const [error, code, message] of [
    [platformError('name_taken'), 'name_taken', /already exists, or did and was archived/],
    [platformError('invalid_name_specials'), 'invalid_name', /does not accept that channel name/],
    [platformError('restricted_action'), 'restricted_action', /do not let Chickpea create private channels/],
    [platformError('cannot_create_channel'), 'unavailable', /could not create the channel/],
    [Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error' }), 'rate_limited', /rate-limited/],
  ] as const) {
    const { service, calls } = channels(t, fakeSlack({ createError: error }));
    const result = await service().create(request());
    assert.deepEqual([result.status, result.code], ['refused', code], code);
    assert.match(String(result.message), message, code);
    assert.deepEqual([calls.invite, calls.post], [[], []], code);
  }
});

test('without the scope, the result says who must update Chickpea\'s Slack permissions, naming the right one when self-hosted', async (t) => {
  for (const [hosted, visibility, message] of [
    [true, 'private', /A workspace Owner needs to update Chickpea's Slack permissions in Chickpea Admin/],
    [false, 'private', /create private channels \(groups:write\)/],
    [false, 'public', /create public channels \(channels:manage\)/],
  ] as const) {
    const { service, calls } = channels(t, fakeSlack({ createError: platformError('missing_scope', { needed: 'groups:write' }) }), { hosted });
    const result = await service().create(request({ visibility }));
    assert.deepEqual([result.status, result.code], ['refused', 'missing_scope']);
    assert.match(String(result.message), message);
    assert.deepEqual(calls.invite, []);
  }
});

test('a name Slack refused leaves the request free to try another name', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const receipt = channelReceipt(settings);
  const taken = channels(t, fakeSlack({ createError: platformError('name_taken') }), { receipt });
  assert.equal((await taken.service().create(request())).code, 'name_taken');
  const free = channels(t, fakeSlack(), { receipt });
  assert.equal((await free.service().create(request({ name: 'acme-renewal-2' }))).status, 'created');
});

test('after three failed attempts in one request, a fourth is refused without asking Slack', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const receipt = channelReceipt(settings);
  const failing = channels(t, fakeSlack({ createError: platformError('name_taken') }), { receipt });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await failing.service().create(request({ name: `acme-${attempt}` }))).code, 'name_taken');
  }
  const fourth = await failing.service().create(request({ name: 'acme-3' }));
  assert.deepEqual([fourth.status, fourth.code], ['refused', 'too_many_attempts']);
  assert.equal(failing.calls.create.length, 3);
});

test('one channel per request: a second call points to the first and creates nothing', async (t) => {
  const { service, calls } = channels(t);
  await service().create(request());
  const again = await service().create(request({ name: 'acme-renewal-again' }));
  assert.equal(again.status, 'already_created');
  assert.deepEqual(again.channel, { id: CREATED, visibility: 'private', link: 'https://slack.com/archives/C0ACME' });
  assert.equal(calls.create.length, 1);
  assert.equal(calls.post.length, 1, 'the opening message is never posted twice');
});

test('a retry after the invites were lost puts the requester into the private channel it already created', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const receipt = channelReceipt(settings);
  const lost = channels(t, fakeSlack({ inviteErrors: [platformError('internal_error')], members: new Error('timeout') }), { receipt });
  assert.deepEqual((await lost.service().create(request())).invited, []);

  const alreadyIn = platformError(ALREADY_IN, { errors: [{ user: 'U0SAM', ok: false, error: ALREADY_IN }] });
  const offered: boolean[] = [];
  const retry = channels(t, fakeSlack({ inviteErrors: [alreadyIn] }), {
    receipt,
    agentAccess: async ({ requesterInvited }) => { offered.push(requesterInvited); return { status: 'add_offered' }; },
  });
  const healed = await retry.service().create(request());
  assert.equal(healed.status, 'already_created');
  assert.deepEqual(healed.invited, [REQUESTER, 'U0SAM', 'U0PRIYA']);
  assert.deepEqual(retry.calls.invite, [`${REQUESTER},U0SAM,U0PRIYA`, `${REQUESTER},U0PRIYA`]);
  assert.deepEqual([retry.calls.create, retry.calls.post], [[], []]);
  assert.deepEqual(offered, [true], 'the requester, now in the channel, gets the Add button');
  assert.equal((healed.agentAccess as { status: string }).status, 'add_offered');

  const everyoneIn = platformError(ALREADY_IN, {
    errors: [REQUESTER, 'U0SAM', 'U0PRIYA'].map((user) => ({ user, ok: false, error: ALREADY_IN })),
  });
  const duplicate = channels(t, fakeSlack({ inviteErrors: [everyoneIn] }), {
    receipt,
    agentAccess: async () => { offered.push(true); return { status: 'add_offered' }; },
  });
  const again = await duplicate.service().create(request());
  assert.deepEqual(again.invited, [REQUESTER, 'U0SAM', 'U0PRIYA']);
  assert.equal(again.agentAccess, undefined);
  assert.deepEqual(offered, [true], 'a plain repeat posts no second button');

  const bare = channels(t, fakeSlack({ inviteErrors: [platformError(ALREADY_IN)], members: ['U0BOTSELF', REQUESTER, 'U0SAM', 'U0PRIYA'] }), {
    receipt,
    agentAccess: async () => { offered.push(true); return { status: 'add_offered' }; },
  });
  const bareAgain = await bare.service().create(request());
  assert.deepEqual(bareAgain.invited, [REQUESTER, 'U0SAM', 'U0PRIYA']);
  assert.deepEqual(offered, [true], 'nor does a repeat Slack answers without a per-person list');
});

test('one person Slack will not invite keeps their reason, and one already there counts as invited', async (t) => {
  const refused = channels(t, fakeSlack({ inviteErrors: [platformError('ura_max_channels')] }));
  const alone = await refused.service().create(request({ people: [] }));
  assert.deepEqual([alone.invited, alone.notInvited], [[], [{ id: REQUESTER, reason: 'guest' }]]);
  assert.deepEqual(refused.calls.members, [], 'no readback is needed to know why');

  const present = channels(t, fakeSlack({ inviteErrors: [platformError(ALREADY_IN)] }));
  const joined = await present.service().create(request({ people: [] }));
  assert.deepEqual([joined.invited, joined.notInvited], [[REQUESTER], undefined]);

  const archived = channels(t, fakeSlack({ inviteErrors: [platformError('is_archived')], members: [] }));
  const channelLevel = await archived.service().create(request({ people: [] }));
  assert.deepEqual(channelLevel.notInvited, [{ id: REQUESTER, reason: 'failed' }], 'a channel-level code goes to the readback');
  assert.deepEqual(archived.calls.members, [CREATED]);
});

test('when the retry without a refused person also fails, the channel\'s members decide, and the refusal keeps its reason', async (t) => {
  const { service, calls } = channels(t, fakeSlack({
    inviteErrors: [
      platformError('ura_max_channels', { errors: [{ user: 'U0SAM', ok: false, error: 'ura_max_channels' }] }),
      platformError('internal_error'),
    ],
    members: [REQUESTER],
  }));
  const result = await service().create(request());
  assert.deepEqual(calls.invite, [`${REQUESTER},U0SAM,U0PRIYA`, `${REQUESTER},U0PRIYA`]);
  assert.deepEqual(result.invited, [REQUESTER]);
  assert.deepEqual(result.notInvited, [{ id: 'U0SAM', reason: 'guest' }, { id: 'U0PRIYA', reason: 'failed' }]);
});

test('a creation Slack did not confirm blocks every later call in the request, and nobody is invited', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const receipt = channelReceipt(settings);
  for (const error of [platformError('internal_error'), new Error('socket hang up')]) {
    const lost = channels(t, fakeSlack({ createError: error }), { receipt: channelReceipt(settings, String(error.message)) });
    const first = await lost.service().create(request());
    assert.deepEqual([first.status, first.code], ['unverified', 'create_unconfirmed']);
    assert.deepEqual(lost.calls.invite, []);
  }
  const lost = channels(t, fakeSlack({ createError: new Error('socket hang up') }), { receipt });
  await lost.service().create(request());
  const healthy = channels(t, fakeSlack(), { receipt });
  const second = await healthy.service().create(request({ name: 'acme-other' }));
  assert.deepEqual([second.status, second.code], ['unverified', 'already_attempted']);
  assert.match(String(second.message), /already creating a channel, or Slack did not confirm an earlier attempt/,
    'a call racing the first is not told that nobody was invited');
  assert.deepEqual(healthy.calls.create, [], 'the retry created nothing');
});

test('Slack\'s own refusal relayed by a gateway is definite: refused, and the request stays free to try another name', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const receipt = channelReceipt(settings);
  for (const code of ['name_taken', 'invalid_name_specials', 'restricted_action', 'missing_scope', 'ratelimited', 'token_revoked']) {
    const relayed = channels(t, fakeSlack({ createError: new SlackTransportError('conversations.create', code) }), { receipt });
    assert.equal((await relayed.service().create(request({ name: `acme-${code}` }))).status, 'refused', code);
  }
  const free = channels(t, fakeSlack(), { receipt: channelReceipt(settings, 'turn-two') });
  assert.equal((await free.service().create(request())).status, 'created');

  const uncertain = channels(t, fakeSlack({ createError: new SlackTransportError('conversations.create', 'internal_error') }), {
    receipt: channelReceipt(settings, 'turn-three'),
  });
  assert.deepEqual((await uncertain.service().create(request())).code, 'create_unconfirmed', 'an uncertain gateway answer is still unconfirmed');
});

test('the result names the channel as Slack named it', async (t) => {
  const { service } = channels(t, fakeSlack({ createdName: 'acme-renewal-1' }));
  const result = await service().create(request());
  assert.equal((result.channel as { name: string }).name, 'acme-renewal-1');
});

test('a failing Agent-access step never turns a created channel into a refusal', async (t) => {
  const { service } = channels(t, fakeSlack(), { agentAccess: async () => { throw new Error('identity store down'); } });
  const result = await service().create(request());
  assert.equal(result.status, 'created');
  assert.equal((result.agentAccess as { status: string }).status, 'add_in_admin');
});

test('a person Slack will not invite is left out of one retry, and reported with why', async (t) => {
  const slack = fakeSlack({
    inviteErrors: [platformError('ura_max_channels', { errors: [{ user: 'U0SAM', ok: false, error: 'ura_max_channels' }] })],
  });
  const { service, calls } = channels(t, slack);
  const result = await service().create(request());
  assert.deepEqual(calls.invite, [`${REQUESTER},U0SAM,U0PRIYA`, `${REQUESTER},U0PRIYA`]);
  assert.deepEqual(result.invited, [REQUESTER, 'U0PRIYA']);
  assert.deepEqual(result.notInvited, [{ id: 'U0SAM', reason: 'guest' }]);
  assert.equal(result.status, 'created');
});

test('when an invite fails without a per-person answer, the channel\'s members say who is in', async (t) => {
  const readback = channels(t, fakeSlack({ inviteErrors: [platformError('internal_error')], members: ['U0BOTSELF', REQUESTER] }));
  const known = await readback.service().create(request());
  assert.deepEqual(known.invited, [REQUESTER]);
  assert.deepEqual(known.notInvited, [{ id: 'U0SAM', reason: 'failed' }, { id: 'U0PRIYA', reason: 'failed' }], 'a failure Slack gave no reason for is not called a refusal');

  const unknown = channels(t, fakeSlack({ inviteErrors: [platformError('internal_error')], members: new Error('timeout') }));
  const unread = await unknown.service().create(request());
  assert.deepEqual(unread.invited, []);
  assert.deepEqual((unread.notInvited as { reason: string }[]).map(({ reason }) => reason), ['unconfirmed', 'unconfirmed', 'unconfirmed']);
});

test('a purpose or opening message Slack refused is reported inside the created result, never as a second channel', async (t) => {
  const purpose = channels(t, fakeSlack({ purposeError: platformError('user_is_restricted') }));
  const noPurpose = await purpose.service().create(request({ purpose: 'Renewal' }));
  assert.deepEqual([noPurpose.status, noPurpose.purpose], ['created', 'not_set']);

  for (const [error, status] of [[platformError('not_in_channel'), 'not_posted'], [new Error('socket hang up'), 'unconfirmed']] as const) {
    const { service, routed } = channels(t, fakeSlack({ postError: error }));
    const result = await service().create(request());
    assert.equal(result.status, 'created');
    assert.equal((result.opening as { status: string }).status, status);
    assert.equal(result.replies, undefined);
    assert.deepEqual(routed, []);
  }
});

test('a user Agent is offered, not granted: the result reports its access and never claims replies reach it', async (t) => {
  const offered: { id: string; requesterInvited: boolean }[] = [];
  const { service } = channels(t, fakeSlack(), {
    agentAccess: async (channel) => {
      offered.push(channel);
      return { status: 'add_offered' };
    },
  });
  const result = await service().create(request());
  assert.deepEqual(offered, [{ id: CREATED, requesterInvited: true }]);
  assert.equal(result.replies, undefined);
  assert.equal((result.agentAccess as { status: string }).status, 'add_offered');
  assert.match(String((result.agentAccess as { message: string }).message), /The requester has a button there to add you/);
});

function offerFixture(input: { role?: 'owner' | 'admin' | 'member'; handle?: boolean; ephemeralError?: Error; kind?: 'user' | 'system' } = {}) {
  const ephemerals: Record<string, unknown>[] = [];
  const agent = {
    id: 'agent_scout', name: 'Scout', kind: input.kind ?? 'user', enabled: true, lifecycle: 'active', revision: 1,
    creatorMembershipId: 'm_creator', editPolicy: 'creator_and_admins',
    ...(input.handle === false ? {} : { slackPresence: { normalizedHandle: 'scout', userGroupId: 'S0SCOUT' } }),
  } as unknown as CustomAgentConfig;
  const offer = (channel: { id: string; requesterInvited: boolean }) => offerChannelAgentAccess({
    signal: { workspaceId: WORKSPACE, slackUserId: REQUESTER },
    agent,
    channel,
    identity: {
      resolveSlackIdentity: async () => ({ membership: { id: 'm_requester', role: input.role ?? 'member' } }),
      listMemberships: async () => [],
      listExternalIdentities: async () => [],
    } as never,
    transport: { lookupChannel: async (id: string) => ({ id, name: 'acme-renewal', private: true, member: true, archived: false }) },
    client: {
      chat: {
        postEphemeral: async (args: Record<string, unknown>) => {
          ephemerals.push(args);
          if (input.ephemeralError) throw input.ephemeralError;
          return { ok: true };
        },
      },
    } as never,
    adminUrl: 'https://chickpea.example/admin/agents',
  });
  return { offer, ephemerals };
}

test('Chickpea itself needs no offer: replies reach it in any channel its bot is in', async () => {
  const { offer, ephemerals } = offerFixture({ kind: 'system', role: 'member' });
  assert.deepEqual(await offer({ id: CREATED, requesterInvited: true }), { status: 'not_needed' });
  assert.deepEqual(ephemerals, []);
});

test('a requester who may add the Agent gets Core\'s Add button in the new channel, privately', async () => {
  const { offer, ephemerals } = offerFixture({ role: 'admin' });
  assert.deepEqual(await offer({ id: CREATED, requesterInvited: true }), { status: 'add_offered' });
  assert.equal(ephemerals.length, 1);
  const [ephemeral] = ephemerals;
  assert.equal(ephemeral!.channel, CREATED);
  assert.equal(ephemeral!.user, REQUESTER);
  const actions = (ephemeral!.blocks as { type: string; elements?: { action_id: string; value: string }[] }[])
    .find((block) => block.type === 'actions');
  assert.deepEqual(actions?.elements?.map(({ action_id, value }) => [action_id, value]), [[AGENT_CHANNEL_ADD_ACTION, 'agent_scout']]);
});

test('a requester who may not add the Agent is told an Owner or Admin can, and gets no button', async () => {
  const { offer, ephemerals } = offerFixture({ role: 'member' });
  assert.deepEqual(await offer({ id: CREATED, requesterInvited: true }), { status: 'ask_owner' });
  assert.equal(ephemerals[0]?.blocks, undefined);
  assert.match(String(ephemerals[0]?.text), /Ask a workspace Owner or Admin/);
});

test('when the button could not work or reach the requester, they are pointed to Chickpea Admin instead', async () => {
  const noHandle = offerFixture({ role: 'owner', handle: false });
  assert.deepEqual(await noHandle.offer({ id: CREATED, requesterInvited: true }),
    { status: 'add_in_admin', adminUrl: 'https://chickpea.example/admin/agents' });
  assert.deepEqual(noHandle.ephemerals, [], 'no dead button');

  const notInvited = offerFixture({ role: 'owner' });
  assert.equal((await notInvited.offer({ id: CREATED, requesterInvited: false })).status, 'add_in_admin');
  assert.deepEqual(notInvited.ephemerals, []);

  const failed = offerFixture({ role: 'owner', ephemeralError: platformError('user_not_in_channel') });
  assert.equal((await failed.offer({ id: CREATED, requesterInvited: true })).status, 'add_in_admin');
});

async function standingFixture(suffix: string) {
  const f = await createManagementAdapterFixture(suffix);
  const agent = await f.config.createAgent({
    id: 'agent_scout', name: 'Scout', instructions: 'Help', enabled: true, kind: 'user',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const signal: SlackManagementSignal = {
    agentId: agent.id, workspaceId: f.admin.binding.slackTeamId, channelId: 'C0PROJECT',
    threadTs: '1800000000.000001', messageTs: '1800000000.000001', eventId: 'E0CHAN', turnJobId: 'turn_chan',
    slackUserId: f.admin.binding.slackUserId, conversationKind: 'channel',
  };
  const grant = (channelId: string) => f.config.putAgentChannelGrant({
    workspaceId: signal.workspaceId, channelId, agentId: agent.id, status: 'active',
    createdByMembershipId: f.admin.membership.id, channelLabel: channelId,
  }, 0);
  const placements = (facts: Record<string, { private: boolean } | Error>): PrivateAgentPlacementFacts => ({
    lookupChannel: async (id) => {
      const fact = facts[id];
      if (!fact) throw new Error('channel_not_found');
      if (fact instanceof Error) throw fact;
      return { id, private: fact.private, member: true, archived: false };
    },
    listMemberChannels: async () => new Set(),
  });
  const standing = (overrides: Partial<Parameters<typeof assertChannelCreateStanding>[0]> = {}) => assertChannelCreateStanding({
    plan: { agentId: agent.id, actorMembershipId: f.admin.membership.id },
    signal, agent, visibility: 'private', config: f.config, identity: f.identity,
    placementFacts: placements({ C0PROJECT: { private: true } }),
    ...overrides,
  });
  return { f, agent, signal, grant, placements, standing };
}

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SlackChannelCreateRefusal, String(error));
    return error.code;
  }
  return 'allowed';
}

test('a user Agent makes a public channel only when everyone in the workspace may already use it; private needs no such reach', async () => {
  const { f, grant, placements, standing } = await standingFixture('chan-audience');
  try {
    await grant('C0PROJECT');
    assert.equal(await refusalCode(standing()), 'allowed', 'private');
    assert.equal(await refusalCode(standing({ visibility: 'public' })), 'not_workspace_wide', 'placed only in a private Channel');
    assert.equal(await refusalCode(standing({ visibility: 'public', placementFacts: placements({ C0PROJECT: { private: false } }) })), 'allowed');
    assert.equal(await refusalCode(standing({ visibility: 'public', placementFacts: placements({ C0PROJECT: new Error('ratelimited') }) })), 'unavailable');
  } finally { f.close(); }
});

test('Chickpea itself makes a public channel without any Channel grant', async () => {
  const { f, standing } = await standingFixture('chan-system');
  try {
    const chickpea = await f.config.materializeChickpeaAgent();
    assert.equal(await refusalCode(standing({ agent: chickpea, visibility: 'public' })), 'allowed');
  } finally { f.close(); }
});

test('the requester must keep access, the Agent must still be added where it was asked, and an own-app Agent is refused', async () => {
  const { f, agent, signal, grant, standing } = await standingFixture('chan-standing');
  try {
    await grant('C0ELSEWHERE');
    assert.equal(await refusalCode(standing()), 'agent_unavailable', 'not added to the Channel it was asked in');
    assert.equal(await refusalCode(standing({ signal: { ...signal, channelId: 'D0DANA', conversationKind: 'im' } })), 'allowed', 'a DM needs no grant');
    configureAgentSlackApps({ requestUrls: () => ({ events: '', interactions: '' }), redirectUri: '', allowUrl: () => '' });
    try {
      const appAgent = { ...agent, slackPresence: { kind: 'agent_app' } } as unknown as CustomAgentConfig;
      assert.equal(await refusalCode(standing({ agent: appAgent, signal: { ...signal, conversationKind: 'im' } })), 'agent_app');
    } finally { configureAgentSlackApps(undefined); }
    await f.identity.setMembershipAccessOverlay({
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      accessStatus: 'suspended',
    });
    assert.equal(await refusalCode(standing({ signal: { ...signal, conversationKind: 'im' } })), 'requester_unavailable');
  } finally { f.close(); }
});

test('replies in the opening thread reach Chickpea at once, and a user Agent only once it is added to the channel', async () => {
  const store = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  try {
    const scout: CustomAgentConfig = await store.createAgent({
      id: 'agent_scout', name: 'Scout', instructions: 'Help', enabled: true, lifecycle: 'active', kind: 'user',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const chickpea = await store.materializeChickpeaAgent();
    await store.ensureWorkspaceInstallation({
      workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: chickpea.id, runtimeContract: 'chickpea-v1',
    });
    const reply = (channelId: string, threadTs: string) => resolveAgentRoute({
      turn: {
        workspaceId: WORKSPACE, channelId, eventId: `Ev${channelId}`, text: 'thanks, one question',
        userId: 'U0SAM', messageTs: '1800000000.000300', threadTs,
        source: 'implicit_thread_reply', channelType: 'channel', contextMode: 'thread',
      },
      surface: 'channel',
      actor: { channelMember: true, fullMember: true },
      config: store,
    });

    await routeRepliesToAgent(store, { workspaceId: WORKSPACE, channelId: 'C0SYSTEM', messageTs: POSTED_TS, text: 'Kickoff', agent: chickpea });
    const toChickpea = await reply('C0SYSTEM', POSTED_TS);
    assert.equal(toChickpea.kind === 'routed' && toChickpea.assignment.agentId, chickpea.id);

    await routeRepliesToAgent(store, { workspaceId: WORKSPACE, channelId: CREATED, messageTs: POSTED_TS, text: 'Kickoff', agent: scout });
    assert.deepEqual(await store.listAgentChannelGrants(WORKSPACE, CREATED), [], 'creating grants nothing');
    assert.notEqual((await reply(CREATED, POSTED_TS)).kind, 'routed');
    await store.putAgentChannelGrant({
      workspaceId: WORKSPACE, channelId: CREATED, agentId: scout.id, status: 'active', createdByMembershipId: 'm_requester',
    }, 0);
    const added = await reply(CREATED, POSTED_TS);
    assert.equal(added.kind === 'routed' && added.assignment.agentId, scout.id, 'after the Add click');
  } finally {
    store.close();
  }
});

test('turn retention purges a finished turn\'s channel receipt and keeps an unfinished one', () => {
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
      settings.setSetting(`${SLACK_CHANNEL_CREATE_RECEIPT_PREFIX}${id}`, '{"status":"pending"}');
    }
    jobs.markDelivered('finished');
    clock += TURN_JOB_TTL_MS + 1;
    enqueue('trigger');
    assert.equal(settings.getSetting(`${SLACK_CHANNEL_CREATE_RECEIPT_PREFIX}finished`), undefined);
    assert.equal(settings.getSetting(`${SLACK_CHANNEL_CREATE_RECEIPT_PREFIX}unresolved`), '{"status":"pending"}');
  } finally { db.close(); }
});
