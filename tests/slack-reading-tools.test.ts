import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import { encodeBase64Url } from '../src/security/base64url.ts';
import { clearSlackContextNameCache } from '../src/slack/context-names.ts';
import type { SlackReadGate } from '../src/slack/read-budget.ts';
import {
  authorizeSlackRead,
  slackReadAuthorityPorts,
  slackReadConversationFacts,
  type SlackReadAuthorityPorts,
  type SlackReadConversationFacts,
} from '../src/slack/reading/authority.ts';
import { SlackReadError } from '../src/slack/reading/errors.ts';
import { parseSlackLink, resolveSlackReadTarget } from '../src/slack/reading/links.ts';
import {
  MAX_SLACK_READ_RESULT_BYTES,
  MAX_SLACK_READS_PER_REQUEST,
  MAX_SLACK_USER_LOOKUPS_PER_REQUEST,
  SlackReadingService,
  slackReadFailure,
} from '../src/slack/reading/service.ts';

const WORKSPACE = 'T0WORK';
const CURRENT = { channelId: 'C0CURRENT', threadTs: '1000.000100', messageTs: '1010.000100' };
const REQUESTER = 'U0DANA';

function facts(overrides: Partial<SlackReadConversationFacts> & { id: string }): SlackReadConversationFacts {
  return { teamId: WORKSPACE, im: false, mpim: false, private: false, member: true, shared: false, ...overrides };
}

function ports(overrides: Partial<SlackReadAuthorityPorts> & {
  conversations?: Record<string, SlackReadConversationFacts | undefined>;
  members?: Record<string, string[]>;
  grants?: string[];
} = {}): SlackReadAuthorityPorts & { memberChecks: string[]; grantChecks: string[] } {
  const conversations = overrides.conversations ?? {
    [CURRENT.channelId]: facts({ id: CURRENT.channelId, name: 'incidents' }),
    C0OTHER: facts({ id: 'C0OTHER', name: 'deploys' }),
  };
  const members = overrides.members ?? { C0OTHER: [REQUESTER] };
  const grants = overrides.grants ?? ['C0OTHER'];
  const memberChecks: string[] = [];
  const grantChecks: string[] = [];
  return {
    workspaceId: WORKSPACE,
    managementAgent: false,
    requesterSlackUserId: REQUESTER,
    current: CURRENT,
    assertActive: async () => {},
    conversation: async (id) => conversations[id],
    isMember: async (id, user) => { memberChecks.push(id); return (members[id] ?? []).includes(user); },
    hasActiveGrant: async (id) => { grantChecks.push(id); return grants.includes(id); },
    memberChecks,
    grantChecks,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SlackReadError, String(error));
    return error.code;
  }
  assert.fail('expected a refusal');
}

test('permalinks, channel links, and web client links parse; other hosts do not', () => {
  assert.deepEqual(parseSlackLink('https://acme.slack.com/archives/C0OTHER/p1700000000123456'),
    { channelId: 'C0OTHER', ts: '1700000000.123456' });
  assert.deepEqual(parseSlackLink('<https://acme.slack.com/archives/C0OTHER/p1700000001000200?thread_ts=1700000000.123456&cid=C0OTHER|see this>'),
    { channelId: 'C0OTHER', ts: '1700000001.000200', threadTs: '1700000000.123456' });
  assert.deepEqual(parseSlackLink('https://acme.enterprise.slack.com/archives/G0PRIV'), { channelId: 'G0PRIV' });
  assert.deepEqual(parseSlackLink('https://app.slack.com/client/T0WORK/C0OTHER/thread/C0OTHER-1700000000.123456'),
    { channelId: 'C0OTHER', ts: '1700000000.123456', threadTs: '1700000000.123456' });
  for (const bad of [
    'http://acme.slack.com/archives/C0OTHER',
    'https://slack.com.evil.example/archives/C0OTHER',
    'https://acme.slack.com/archives/not-an-id',
    'https://acme.slack.com/archives/C0OTHER/p123',
    'https://acme.slack.com/lists/T0WORK/F0LIST',
    'https://user:pw@acme.slack.com/archives/C0OTHER',
    'https://acme.slack.com:8443/archives/C0OTHER',
    'https://app.slack.com/client/T0WORK/C0OTHER/thread/C0ELSE-1700000000.123456',
  ]) {
    assert.throws(() => parseSlackLink(bad), (error: unknown) => error instanceof SlackReadError && error.code === 'invalid_link', bad);
  }
  assert.deepEqual(resolveSlackReadTarget({ channel: '<#C0OTHER|deploys>', ts: '1700000000.123456' }),
    { channelId: 'C0OTHER', ts: '1700000000.123456' });
  assert.throws(() => resolveSlackReadTarget({ link: 'https://acme.slack.com/archives/C0OTHER', channel: 'C0OTHER' }));
});

test('the current conversation is readable, including a DM or a shared channel', async () => {
  for (const current of [
    facts({ id: CURRENT.channelId }),
    facts({ id: CURRENT.channelId, shared: true }),
    facts({ id: CURRENT.channelId, im: true }),
  ]) {
    const conversation = await authorizeSlackRead(ports({ conversations: { [CURRENT.channelId]: current } }), CURRENT.channelId);
    assert.equal(conversation.current, true);
  }
});

test('another granted channel the requester and the bot are in is readable', async () => {
  const conversation = await authorizeSlackRead(ports(), 'C0OTHER');
  assert.deepEqual(conversation, { id: 'C0OTHER', name: 'deploys', kind: 'channel', current: false });
});

test('a refusal never reveals a channel the requester is not in', async () => {
  // Not a member: the grant and bot checks are never consulted, so a private
  // channel's existence and setup cannot be probed.
  const noMember = ports({ members: {} });
  assert.equal(await refusal(authorizeSlackRead(noMember, 'C0OTHER')), 'not_available');
  assert.deepEqual(noMember.grantChecks, []);
  assert.equal(await refusal(authorizeSlackRead(ports(), 'C0MISSING')), 'not_available');
  assert.equal(await refusal(authorizeSlackRead(ports({ conversations: {
    [CURRENT.channelId]: facts({ id: CURRENT.channelId }),
    C0OTHER: facts({ id: 'C0OTHER', teamId: 'T0ELSEWHERE' }),
  } }), 'C0OTHER')), 'not_available');
});

test('DMs other than this one and group DMs are not readable', async () => {
  for (const target of [facts({ id: 'D0SOMEONE', im: true }), facts({ id: 'G0GROUPDM', mpim: true })]) {
    const code = await refusal(authorizeSlackRead(ports({
      conversations: { [CURRENT.channelId]: facts({ id: CURRENT.channelId }), [target.id]: target },
      members: { [target.id]: [REQUESTER] },
      grants: [target.id],
    }), target.id));
    assert.equal(code, 'not_available');
  }
});

test('a member learns what is missing: the Agent\'s access, or the app invite', async () => {
  assert.equal(await refusal(authorizeSlackRead(ports({ grants: [] }), 'C0OTHER')), 'needs_agent_access');
  assert.equal(await refusal(authorizeSlackRead(ports({ conversations: {
    [CURRENT.channelId]: facts({ id: CURRENT.channelId }),
    C0OTHER: facts({ id: 'C0OTHER', member: false }),
  } }), 'C0OTHER')), 'needs_bot_invite');
});

test('@Chickpea and Slack Connect conversations read only the current conversation', async () => {
  assert.equal(await refusal(authorizeSlackRead(ports({ managementAgent: true }), 'C0OTHER')), 'current_conversation_only');
  assert.equal(await refusal(authorizeSlackRead(ports({ conversations: {
    [CURRENT.channelId]: facts({ id: CURRENT.channelId, shared: true }),
    C0OTHER: facts({ id: 'C0OTHER' }),
  } }), 'C0OTHER')), 'shared_conversation_only');
});

test('an inactive requester or disabled Agent is refused before any Slack lookup', async () => {
  let looked = false;
  const code = await refusal(authorizeSlackRead(ports({
    assertActive: async () => { throw new SlackReadError('requester_unavailable', 'gone'); },
    conversation: async () => { looked = true; return undefined; },
  }), CURRENT.channelId));
  assert.equal(code, 'requester_unavailable');
  assert.equal(looked, false);
});

test('shared-channel facts cover every Slack sharing flag', () => {
  for (const flag of ['is_shared', 'is_ext_shared', 'is_org_shared', 'is_pending_ext_shared']) {
    assert.equal(slackReadConversationFacts({ id: 'C1', [flag]: true })?.shared, true, flag);
  }
  assert.equal(slackReadConversationFacts({ id: 'C1', pending_shared: ['T2'] })?.shared, true);
  assert.equal(slackReadConversationFacts({ id: 'C1', context_team_id: 'T9', team_id: 'T1' })?.teamId, 'T9');
});

test('membership is cached for one render only, and a missing channel is not a member', async () => {
  let pages = 0;
  const client = {
    conversations: {
      async members({ channel }: { channel: string }) {
        pages += 1;
        if (channel === 'C0GONE') throw Object.assign(new Error('x'), { data: { error: 'channel_not_found' } });
        return { ok: true, members: [REQUESTER] };
      },
      async info() { return { ok: true, channel: { id: 'C0OTHER' } }; },
    },
  };
  const render = () => slackReadAuthorityPorts({
    workspaceId: WORKSPACE, agentId: 'agent_oncall', requesterSlackUserId: REQUESTER, current: CURRENT,
    client: client as never, assertActive: async () => {}, hasActiveGrant: async () => true,
  });
  const live = render();
  assert.equal(await live.isMember('C0OTHER', REQUESTER), true);
  assert.equal(await live.isMember('C0OTHER', REQUESTER), true);
  assert.equal(pages, 1);
  assert.equal(await live.isMember('C0GONE', REQUESTER), false);
  // The next turn builds new ports and asks Slack again, so a requester who
  // left the channel cannot read it on the next request.
  const pagesBefore = pages;
  assert.equal(await render().isMember('C0OTHER', REQUESTER), true);
  assert.equal(pages, pagesBefore + 1);
});

function gate(grants = Infinity, gated = true): SlackReadGate & { limited: number[] } {
  let left = grants;
  const limited: number[] = [];
  return {
    gated,
    limited,
    async reserve() {
      if (left <= 0) return { ok: false, retryAt: 1_900_000_000_000 };
      left -= 1;
      return { ok: true };
    },
    async rateLimited(_method, ms) { limited.push(ms ?? -1); },
  };
}

function slackClient(options: {
  replies?: (args: Record<string, unknown>) => unknown;
  history?: (args: Record<string, unknown>) => unknown;
} = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const lookups: string[] = [];
  return {
    calls,
    lookups,
    conversations: {
      async replies(args: Record<string, unknown>) { calls.push(['replies', args]); return options.replies?.(args) ?? { ok: true, messages: [] }; },
      async history(args: Record<string, unknown>) { calls.push(['history', args]); return options.history?.(args) ?? { ok: true, messages: [] }; },
    },
    users: {
      async info({ user }: { user: string }) {
        lookups.push(user);
        if (user === 'U0EXTERNAL') return { ok: true, user: { id: user, team_id: 'T0PARTNER', profile: { display_name: 'Partner', email: 'p@x.example' } } };
        if (user === 'U0GUEST') return { ok: true, user: { id: user, team_id: WORKSPACE, is_restricted: true, profile: { display_name: 'Guest' } } };
        if (user === 'U0GRID') return { ok: true, user: { id: user, team_id: 'T0SIBLING', enterprise_user: { id: 'W0GRID', enterprise_id: 'E0ORG' }, profile: { display_name: 'Grid Colleague', title: 'PM' } } };
        if (user === 'U0STRANGER') return { ok: true, user: { id: user, team_id: WORKSPACE, is_stranger: true, profile: { display_name: 'Stranger', email: 's@x.example' } } };
        if (user === 'U0MISSING') throw Object.assign(new Error('x'), { code: 'slack_webapi_platform_error', data: { error: 'user_not_found' } });
        return { ok: true, user: { id: user, team_id: WORKSPACE, tz: 'America/Los_Angeles',
          profile: { display_name: 'Dana Lee', real_name: 'Dana Lee', title: 'SRE', email: 'dana@acme.example', phone: '555' } } };
      },
    },
  };
}

function service(client: ReturnType<typeof slackClient>, readGate = gate(), record?: SqliteConfigStore, authority = ports()) {
  clearSlackContextNameCache();
  return new SlackReadingService({
    client: client as never,
    gate: readGate,
    authority,
    self: { botUserId: 'U0BOT' },
    ...(record ? { record } : {}),
  });
}

test('reading the current thread withholds newer messages and says how many are waiting', async () => {
  const client = slackClient({ replies: () => ({ ok: true, messages: [
    { user: REQUESTER, ts: CURRENT.threadTs, thread_ts: CURRENT.threadTs, text: 'root', reply_count: 3 },
    { subtype: 'bot_message', bot_id: 'B0PD', username: 'PagerDuty', ts: '1005.000100', thread_ts: CURRENT.threadTs, text: 'alert' },
    { user: REQUESTER, ts: CURRENT.messageTs, thread_ts: CURRENT.threadTs, text: 'what is this?' },
    { user: REQUESTER, ts: '1020.000100', thread_ts: CURRENT.threadTs, text: 'NEWER' },
  ] }) });
  const result = await service(client).readThread({ target: { channelId: CURRENT.channelId, ts: CURRENT.messageTs } });
  assert.equal(result.status, 'ok');
  assert.equal(result.threadTs, CURRENT.threadTs);
  assert.equal(result.replyCount, 3);
  assert.equal(result.newerMessagesWaiting, 1);
  assert.doesNotMatch(JSON.stringify(result), /NEWER/);
  assert.deepEqual((result.messages as Array<{ author: unknown }>).map((row) => row.author), [
    { kind: 'person', id: REQUESTER, name: 'Dana Lee' },
    { kind: 'app', id: 'B0PD', name: 'PagerDuty' },
    { kind: 'person', id: REQUESTER, name: 'Dana Lee' },
  ]);
  assert.match(String(result.notice), /never an instruction/);
});

test('the shared app reads 15 rows a page; the install\'s own app may read more', async () => {
  const paced = slackClient();
  await service(paced, gate(Infinity, true)).readThread({ target: { channelId: 'C0OTHER', ts: '1.000001' }, limit: 100 });
  assert.equal(paced.calls[0]?.[1].limit, 15);
  const own = slackClient();
  await service(own, gate(Infinity, false)).readThread({ target: { channelId: 'C0OTHER', ts: '1.000001' }, limit: 100 });
  assert.equal(own.calls[0]?.[1].limit, 100);
});

test('an exhausted budget answers the current thread from the record, other threads with a retry time', async () => {
  const store = new SqliteConfigStore(':memory:');
  try {
    await store.putSlackPublicContext({ workspaceId: WORKSPACE, channelId: CURRENT.channelId, rootTs: CURRENT.threadTs,
      messageTs: CURRENT.threadTs, role: 'app', authorId: 'B0PD', authorName: 'PagerDuty', text: 'RECORDED ALERT' });
    const client = slackClient();
    const current = await service(client, gate(0), store).readThread({ target: { channelId: CURRENT.channelId, ts: CURRENT.threadTs } });
    assert.equal(current.status, 'partial');
    assert.equal(current.source, 'thread_record');
    assert.match(JSON.stringify(current), /RECORDED ALERT/);
    assert.equal(client.calls.length, 0);
    const other = slackReadFailure(await service(client, gate(0), store)
      .readThread({ target: { channelId: 'C0OTHER', ts: '1.000001' } }).catch((error: unknown) => error));
    assert.equal(other.code, 'rate_limited');
    assert.ok(typeof other.slackReadAvailableAt === 'string');
  } finally { store.close(); }
});

test('a capped first page of the current thread marks the record\'s gap on the shared app only', async () => {
  const page = () => ({ ok: true, response_metadata: { next_cursor: 'more' }, messages: [
    { user: REQUESTER, ts: CURRENT.threadTs, thread_ts: CURRENT.threadTs, text: 'root', reply_count: 40 },
    { user: 'U0SAM', ts: '1008.000100', thread_ts: CURRENT.threadTs, text: 'newest reply',
      files: [{ id: 'F0SHOT0001', name: 'shot.png', mimetype: 'image/png' }] },
    { user: REQUESTER, ts: CURRENT.messageTs, thread_ts: CURRENT.threadTs, text: 'what is this?' },
  ] });
  for (const gated of [true, false]) {
    const store = new SqliteConfigStore(':memory:');
    try {
      await service(slackClient({ replies: page }), gate(Infinity, gated), store)
        .readThread({ target: { channelId: CURRENT.channelId, ts: CURRENT.threadTs } });
      const rows = await store.listSlackPublicContext(WORKSPACE, CURRENT.channelId, CURRENT.threadTs);
      assert.deepEqual(rows.map((row) => row.messageTs), [CURRENT.threadTs, '1008.000100']);
      assert.equal(rows[0]?.gapBeforeTs, gated ? '1008.000100' : undefined);
      assert.deepEqual(rows[1]?.images?.map((image) => image.id), ['F0SHOT0001']);
    } finally { store.close(); }
  }
});

test('a Slack 429 becomes the workspace cooldown and a plain rate-limited answer', async () => {
  const readGate = gate();
  const client = slackClient({ history: () => { throw Object.assign(new Error('429'), { code: 'slack_webapi_rate_limited_error', retryAfter: 42 }); } });
  const failure = slackReadFailure(await service(client, readGate).readChannel({ target: { channelId: 'C0OTHER' } }).catch((error: unknown) => error));
  assert.equal(failure.code, 'rate_limited');
  assert.deepEqual(readGate.limited, [42_000]);
});

test('one request makes at most the capped number of Slack reads', async () => {
  const client = slackClient();
  const reader = service(client);
  for (let index = 0; index < MAX_SLACK_READS_PER_REQUEST; index += 1) {
    await reader.readChannel({ target: { channelId: 'C0OTHER' } });
  }
  const failure = slackReadFailure(await reader.readChannel({ target: { channelId: 'C0OTHER' } }).catch((error: unknown) => error));
  assert.equal(failure.code, 'read_limit');
  assert.equal(client.calls.length, MAX_SLACK_READS_PER_REQUEST);
});

test('a cursor pages only the conversation it came from', async () => {
  const client = slackClient({ history: () => ({ ok: true, messages: [], response_metadata: { next_cursor: 'slack-next' } }) });
  const reader = service(client);
  const first = await reader.readChannel({ target: { channelId: 'C0OTHER' } });
  assert.equal(typeof first.nextCursor, 'string');
  await reader.readChannel({ target: { channelId: 'C0OTHER' }, cursor: String(first.nextCursor) });
  assert.equal(client.calls[1]?.[1].cursor, 'slack-next');
  const failure = slackReadFailure(await reader.readChannel({ target: { channelId: CURRENT.channelId }, cursor: String(first.nextCursor) })
    .catch((error: unknown) => error));
  assert.equal(failure.code, 'invalid_cursor');
});

test('reading this channel never returns messages after the current request', async () => {
  const client = slackClient({ history: () => ({ ok: true, messages: [
    { user: REQUESTER, ts: '1003.000100', text: 'second' },
    { user: REQUESTER, ts: '1001.000100', text: 'first' },
  ] }) });
  const result = await service(client).readChannel({ target: { channelId: CURRENT.channelId }, latest: '2026-12-31' });
  assert.equal(client.calls[0]?.[1].latest, CURRENT.messageTs);
  assert.deepEqual((result.messages as Array<{ text: string }>).map((row) => row.text), ['first', 'second']);
});

test('a user lookup returns work details only, and nothing about another organization\'s people', async () => {
  const reader = service(slackClient());
  const dana = await reader.lookupUser({ user: '<@U0DANA>' });
  assert.deepEqual(dana.user, { id: 'U0DANA', kind: 'person', name: 'Dana Lee', realName: 'Dana Lee', title: 'SRE', timezone: 'America/Los_Angeles' });
  assert.doesNotMatch(JSON.stringify(dana), /dana@acme|555/);
  assert.deepEqual((await reader.lookupUser({ user: 'U0EXTERNAL' })).user, { id: 'U0EXTERNAL', kind: 'external' });
  assert.equal(((await reader.lookupUser({ user: 'U0GUEST' })).user as { kind: string }).kind, 'guest');
  // Enterprise Grid: a colleague from a sibling workspace of this org stays a person.
  assert.equal(((await reader.lookupUser({ user: 'U0GRID' })).user as { kind: string }).kind, 'person');
  // is_stranger wins even when Slack reports this workspace's team id.
  assert.deepEqual((await reader.lookupUser({ user: 'U0STRANGER' })).user, { id: 'U0STRANGER', kind: 'external' });
  assert.equal(slackReadFailure(await reader.lookupUser({ user: 'U0MISSING' }).catch((error: unknown) => error)).code, 'not_found');
  assert.equal(slackReadFailure(await reader.lookupUser({ user: 'not-a-user' }).catch((error: unknown) => error)).code, 'invalid_target');
});

test('one request looks up at most the capped number of people', async () => {
  const client = slackClient();
  const reader = service(client);
  for (let index = 0; index < MAX_SLACK_USER_LOOKUPS_PER_REQUEST; index += 1) {
    await reader.lookupUser({ user: `U0PERSON${index}` });
  }
  const failure = slackReadFailure(await reader.lookupUser({ user: 'U0ONEMORE' }).catch((error: unknown) => error));
  assert.equal(failure.code, 'lookup_limit');
  assert.match(String(failure.message), /Answer from what you have/);
  assert.equal(client.lookups.length, MAX_SLACK_USER_LOOKUPS_PER_REQUEST);
});

test('from a Slack Connect or org-shared conversation, people are not looked up', async () => {
  const client = slackClient();
  const shared = ports({ conversations: { [CURRENT.channelId]: facts({ id: CURRENT.channelId, shared: true }) } });
  const failure = slackReadFailure(await service(client, gate(), undefined, shared)
    .lookupUser({ user: 'U0DANA' }).catch((error: unknown) => error));
  assert.equal(failure.code, 'shared_conversation_only');
  assert.doesNotMatch(JSON.stringify(failure), /SRE|America/);
  assert.deepEqual(client.lookups, []);
  // Fails closed when Slack does not show the current conversation.
  const hidden = ports({ conversations: {} });
  assert.equal(slackReadFailure(await service(client, gate(), undefined, hidden)
    .lookupUser({ user: 'U0DANA' }).catch((error: unknown) => error)).code, 'unavailable');
  assert.deepEqual(client.lookups, []);
  // The app's DM with the requester needs no conversations.info (no im:read).
  const dm = ports({
    current: { ...CURRENT, channelId: 'D0DANA' },
    conversation: async () => { throw new SlackReadError('unavailable'); },
  });
  assert.equal((await service(client, gate(), undefined, dm).lookupUser({ user: 'U0DANA' })).status, 'ok');
});

test('each call honors its own abort signal, not an earlier call\'s', async () => {
  const client = slackClient();
  const reader = service(client, gate(2));
  await reader.readChannel({ target: { channelId: 'C0OTHER' }, signal: new AbortController().signal });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(reader.readChannel({ target: { channelId: 'C0OTHER' }, signal: aborted.signal }));
  await assert.rejects(reader.lookupUser({ user: 'U0DANA', signal: aborted.signal }));
  assert.deepEqual(client.lookups, []);
  // The aborted call spent no budget: the next live call still reads Slack.
  await reader.readChannel({ target: { channelId: 'C0OTHER' }, signal: new AbortController().signal });
  assert.equal(client.calls.length, 2);
  assert.equal((await reader.lookupUser({ user: 'U0DANA' })).status, 'ok');
});

test('the record fallback serves only the current thread, never another thread in this channel', async () => {
  const store = new SqliteConfigStore(':memory:');
  try {
    await store.putSlackPublicContext({ workspaceId: WORKSPACE, channelId: CURRENT.channelId, rootTs: CURRENT.threadTs,
      messageTs: CURRENT.threadTs, role: 'human', authorId: REQUESTER, text: 'RECORDED ROOT' });
    // A reply the record holds under another thread of this channel.
    await store.putSlackPublicContext({ workspaceId: WORKSPACE, channelId: CURRENT.channelId, rootTs: '900.000100',
      messageTs: '905.000100', role: 'human', authorId: REQUESTER, text: 'OTHER THREAD' });
    const client = slackClient();
    for (const target of [
      { channelId: CURRENT.channelId, ts: '900.000100' },
      { channelId: CURRENT.channelId, ts: '905.000100' },
      { channelId: CURRENT.channelId, ts: '905.000100', threadTs: '900.000100' },
      // A link into another thread, even naming a ts the record holds here.
      { channelId: CURRENT.channelId, ts: CURRENT.threadTs, threadTs: '900.000100' },
    ]) {
      const failure = slackReadFailure(await service(client, gate(0), store)
        .readThread({ target }).catch((error: unknown) => error));
      assert.equal(failure.code, 'rate_limited', JSON.stringify(target));
      assert.doesNotMatch(JSON.stringify(failure), /RECORDED ROOT|OTHER THREAD/);
    }
    assert.equal(client.calls.length, 0);
  } finally { store.close(); }
});

test('the record fallback answers a reply link or reply ts in the current thread', async () => {
  const store = new SqliteConfigStore(':memory:');
  try {
    await store.putSlackPublicContext({ workspaceId: WORKSPACE, channelId: CURRENT.channelId, rootTs: CURRENT.threadTs,
      messageTs: CURRENT.threadTs, role: 'human', authorId: REQUESTER, text: 'RECORDED ROOT' });
    await store.putSlackPublicContext({ workspaceId: WORKSPACE, channelId: CURRENT.channelId, rootTs: CURRENT.threadTs,
      messageTs: '1005.000100', role: 'app', authorId: 'B0PD', authorName: 'PagerDuty', text: 'RECORDED REPLY' });
    const client = slackClient();
    for (const target of [
      // Channel plus a reply ts the record holds under the current root.
      { channelId: CURRENT.channelId, ts: '1005.000100' },
      // A reply permalink with thread_ts, even for a reply the record lacks.
      { channelId: CURRENT.channelId, ts: '1007.000100', threadTs: CURRENT.threadTs },
    ]) {
      const result = await service(client, gate(0), store).readThread({ target });
      assert.equal(result.status, 'partial', JSON.stringify(target));
      assert.equal(result.source, 'thread_record');
      assert.equal(result.threadTs, CURRENT.threadTs);
      assert.match(JSON.stringify(result), /RECORDED ROOT/);
      assert.match(JSON.stringify(result), /RECORDED REPLY/);
    }
    // A reply ts the record does not hold, without thread_ts, is not known to
    // be in this thread.
    const unknown = slackReadFailure(await service(client, gate(0), store)
      .readThread({ target: { channelId: CURRENT.channelId, ts: '1007.000100' } }).catch((error: unknown) => error));
    assert.equal(unknown.code, 'rate_limited');
    assert.equal(client.calls.length, 0);
  } finally { store.close(); }
});

test('a cursor that is not ours is refused without reaching Slack', async () => {
  const client = slackClient();
  const reader = service(client);
  const encode = (value: string) => encodeBase64Url(new TextEncoder().encode(value));
  for (const cursor of [
    'not base64 json',
    '!!!',
    encode('null'),
    encode('{"k":"channel"}'),
    // A thread cursor offered to a channel read.
    encode('{"k":"thread","c":"C0OTHER","t":"1.000001","s":"slack-next"}'),
    // Bytes that are not UTF-8.
    encodeBase64Url(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])),
  ]) {
    const failure = slackReadFailure(await reader.readChannel({ target: { channelId: 'C0OTHER' }, cursor }).catch((error: unknown) => error));
    assert.equal(failure.code, 'invalid_cursor', cursor);
  }
  assert.equal(client.calls.length, 0);
});

test('Slack answers a thread that is gone as not found, and a hidden channel as not available', async () => {
  const platform = (code: string) => Object.assign(new Error(code), { code: 'slack_webapi_platform_error', data: { error: code } });
  const gone = slackClient({ replies: () => { throw platform('thread_not_found'); } });
  assert.equal(slackReadFailure(await service(gone).readThread({ target: { channelId: 'C0OTHER', ts: '1.000001' } }).catch((error: unknown) => error)).code, 'not_found');
  const hidden = slackClient({ history: () => { throw platform('not_in_channel'); } });
  assert.equal(slackReadFailure(await service(hidden).readChannel({ target: { channelId: 'C0OTHER' } }).catch((error: unknown) => error)).code, 'not_available');
});

test('conversation facts: a hidden channel is absent, a transient failure is retried next call', async () => {
  let infoCalls = 0;
  let failing = true;
  const client = {
    conversations: {
      async info({ channel }: { channel: string }) {
        infoCalls += 1;
        if (channel === 'C0HIDDEN') throw Object.assign(new Error('x'), { data: { error: 'channel_not_found' } });
        if (failing) throw new Error('socket hang up');
        return { ok: true, channel: { id: channel, name: 'deploys', is_member: true } };
      },
      async members() { return { ok: true, members: [] }; },
    },
  };
  const live = slackReadAuthorityPorts({
    workspaceId: WORKSPACE, agentId: 'agent_oncall', requesterSlackUserId: REQUESTER, current: CURRENT,
    client: client as never, assertActive: async () => {}, hasActiveGrant: async () => true,
  });
  assert.equal(await live.conversation('C0HIDDEN'), undefined);
  assert.equal(await refusal(live.conversation('C0OTHER')), 'unavailable');
  failing = false;
  assert.equal((await live.conversation('C0OTHER'))?.name, 'deploys');
  assert.equal((await live.conversation('C0OTHER'))?.member, true);
  assert.equal(infoCalls, 3);
});

test('concurrent membership checks for one channel page Slack once', async () => {
  let pages = 0;
  const client = {
    conversations: {
      async members() { pages += 1; return { ok: true, members: ['U0OTHER'], response_metadata: { next_cursor: pages < 3 ? 'more' : '' } }; },
      async info() { return { ok: true }; },
    },
  };
  const live = slackReadAuthorityPorts({
    workspaceId: WORKSPACE, agentId: 'agent_oncall', requesterSlackUserId: REQUESTER, current: CURRENT,
    client: client as never, assertActive: async () => {}, hasActiveGrant: async () => true,
  });
  const [first, second] = await Promise.all([live.isMember('C0BIG', REQUESTER), live.isMember('C0BIG', REQUESTER)]);
  assert.deepEqual([first, second], [false, false]);
  assert.equal(pages, 3);
});

test('a large read is shortened row by row to fit the tool limit, never silently dropped', async () => {
  const client = slackClient({ history: () => ({ ok: true, messages: Array.from({ length: 50 }, (_, index) => (
    { user: REQUESTER, ts: `${1001 + index}.000100`, text: 'x'.repeat(5_000) })) }) });
  const result = await service(client, gate(Infinity, false)).readChannel({ target: { channelId: 'C0OTHER' }, limit: 50 });
  const messages = result.messages as Array<{ truncated?: boolean }>;
  assert.equal(messages.length, 50);
  assert.ok(messages.every((row) => row.truncated));
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_SLACK_READ_RESULT_BYTES);
});

test('a thread page Slack returns newest first reads oldest first', async () => {
  const client = slackClient({ replies: () => ({ ok: true, messages: [
    { user: REQUESTER, ts: '1.000001', thread_ts: '1.000001', text: 'root' },
    { user: REQUESTER, ts: '9.000001', thread_ts: '1.000001', text: 'newest' },
    { user: REQUESTER, ts: '8.000001', thread_ts: '1.000001', text: 'older' },
  ], response_metadata: { next_cursor: 'older-page' } }) });
  const result = await service(client).readThread({ target: { channelId: 'C0OTHER', ts: '1.000001' } });
  assert.deepEqual((result.messages as Array<{ text: string }>).map((row) => row.text), ['root', 'older', 'newest']);
  assert.equal(result.threadTs, '1.000001');
  assert.equal(typeof result.nextCursor, 'string');
});

test('the reading instruction says Slack cannot be searched and asks for a link instead of browsing', async () => {
  const { SLACK_READING_INSTRUCTION } = await import('../src/slack/reading/tools.ts');
  assert.match(SLACK_READING_INSTRUCTION, /You cannot search Slack/);
  assert.match(SLACK_READING_INSTRUCTION, /do not browse channels page by page/);
  assert.match(SLACK_READING_INSTRUCTION, /ask the requester for a link/);
});
