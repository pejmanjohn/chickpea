import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryScopeSlack, resolveMemoryScope } from '../src/memory/scope.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { loopbackListenSkipReason } from './helpers/listen.ts';
import { FakeSlackBackend, STUB_REPLY_MARKER } from './parity/fake-slack.ts';

const loopbackSkipReason = await loopbackListenSkipReason();

test('asFetch records Slack and provider calls and returns wire-shaped bodies', async () => {
  const backend = new FakeSlackBackend();
  const fetchImpl = backend.asFetch();

  const status = await fetchImpl('https://slack.com/api/assistant.threads.setStatus', {
    method: 'POST',
    body: JSON.stringify({ channel_id: 'C_EXEC', thread_ts: '1.1', status: 'is checking context' }),
  });
  assert.deepEqual(await status.json(), { ok: true });

  const provider = await fetchImpl(
    'https://workers-ai.fake/accounts/acct_test/ai/run/@cf/zai-org/glm-5.2',
    { method: 'POST', body: JSON.stringify({ messages: [], max_tokens: 512 }) },
  );
  assert.deepEqual(await provider.json(), {
    success: true,
    result: { response: STUB_REPLY_MARKER },
  });

  assert.equal(backend.statusCalls().length, 1);
  assert.equal(backend.providerCalls().length, 1);
});

test('listen serves the same core over HTTP', { skip: loopbackSkipReason }, async () => {
  const backend = new FakeSlackBackend();
  const server = await backend.listen();

  try {
    const response = await fetch(`${server.url}/api/chat.postMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'C_EXEC', thread_ts: '1.1', text: 'hi' }),
    });
    const body = (await response.json()) as { ok: boolean; ts?: string };
    assert.equal(body.ok, true);
    assert.equal(typeof body.ts, 'string');

    const providerResponse = await fetch(
      `${server.url}/accounts/acct_test/ai/run/@cf/zai-org/glm-5.2`,
      { method: 'POST', body: JSON.stringify({ messages: [] }) },
    );
    assert.equal(providerResponse.status, 200);

    assert.equal(backend.callsOfMethod('chat.postMessage').length, 1);
    assert.equal(backend.providerCalls().length, 1);
  } finally {
    await server.close();
  }
});

test('http_500 provider mode surfaces a 500 with the raw marker for leak checks', async () => {
  const backend = new FakeSlackBackend({ provider: { mode: 'http_500' } });
  const fetchImpl = backend.asFetch();

  const response = await fetchImpl('https://workers-ai.fake/accounts/acct/ai/run/model', {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 500);
});

test('fake Slack serves bounded membership and user-directory fixtures for memory parity', async () => {
  const backend = new FakeSlackBackend({
    slack: {
      channels: [{ id: 'C_MEMORY', name: 'memory', isMember: true }],
      channelMembers: { C_MEMORY: ['U_MEMBER', 'UBOT'] },
      workspaceUsers: [
        { id: 'U_MEMBER', teamId: 'T_MEMORY', timezone: 'America/Los_Angeles' },
        { id: 'UBOT', teamId: 'T_MEMORY', isBot: true, isAppUser: true },
      ],
    },
  });
  const fetchImpl = backend.asFetch();

  const members = await fetchImpl('https://slack.com/api/conversations.members', {
    method: 'POST',
    body: JSON.stringify({ channel: 'C_MEMORY' }),
  });
  const users = await fetchImpl('https://slack.com/api/users.list', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const actor = await fetchImpl('https://slack.com/api/users.info', {
    method: 'POST',
    body: JSON.stringify({ user: 'U_MEMBER' }),
  });

  assert.deepEqual(await members.json(), {
    ok: true,
    members: ['U_MEMBER', 'UBOT'],
    response_metadata: { next_cursor: '' },
  });
  const usersBody = await users.json() as { members: Array<Record<string, unknown>> };
  assert.equal(usersBody.members.length, 2);
  assert.equal(usersBody.members[1]?.is_bot, true);
  const actorBody = await actor.json() as { user: Record<string, unknown> };
  assert.equal(actorBody.user.team_id, 'T_MEMORY');
  assert.equal(actorBody.user.is_restricted, false);
  assert.equal(actorBody.user.tz, 'America/Los_Angeles');
});

test('fake Slack emits the raw scope flags used by memory privacy checks', async () => {
  const backend = new FakeSlackBackend({
    slack: {
      channels: [{
        id: 'C_SHARED', name: 'shared', isMember: true,
        isFrozen: true, isShared: true, isExternallyShared: true,
        isOrganizationShared: true, pendingShared: ['T_OTHER'], isMpim: true,
        teamId: 'T_HOME', contextTeamId: 'T_OTHER',
      }],
    },
  });
  const response = await backend.asFetch()('https://slack.com/api/conversations.info', {
    method: 'POST',
    body: JSON.stringify({ channel: 'C_SHARED' }),
  });
  const body = await response.json() as { channel: Record<string, unknown> };

  assert.deepEqual(body.channel, {
    id: 'C_SHARED', name: 'shared', is_private: false, is_member: true,
    is_archived: false, is_frozen: true, is_shared: true, is_ext_shared: true,
    is_org_shared: true, pending_shared: ['T_OTHER'], is_im: false, is_mpim: true,
    team_id: 'T_HOME', context_team_id: 'T_OTHER',
  });
});

test('memory Slack mapper preserves unsupported shared-channel flags from the fake backend', async () => {
  const backend = new FakeSlackBackend({
    slack: {
      channels: [{
        id: 'C_SHARED', name: 'shared', isMember: true,
        isFrozen: true, isShared: true, isExternallyShared: true,
        isOrganizationShared: true, pendingShared: ['T_OTHER'], isMpim: true,
        teamId: 'T_HOME', contextTeamId: 'T_OTHER',
      }],
    },
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = backend.asFetch();
    const result = await createMemoryScopeSlack('xoxb-test').conversation('C_SHARED');
    assert.equal(result.ok, true);
    assert.deepEqual(result.facts, {
      id: 'C_SHARED', name: 'shared', private: false, member: true,
      archived: false, frozen: true, shared: true, externallyShared: true,
      organizationShared: true, pendingShared: true, im: false, mpim: true,
      teamId: 'T_OTHER',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('raw Slack Connect context-team evidence fails closed before memory scope is admitted', async () => {
  const backend = new FakeSlackBackend({
    slack: {
      channels: [{
        id: 'C_CONNECT', name: 'connect', isMember: true,
        teamId: 'T_HOME', contextTeamId: 'T_FOREIGN',
      }],
      workspaceUsers: [{ id: 'U_MEMBER', teamId: 'T_HOME' }],
    },
  });
  const originalFetch = globalThis.fetch;
  const state = new SqliteMemoryStateStore(':memory:');
  try {
    globalThis.fetch = backend.asFetch();
    const decision = await resolveMemoryScope({
      workspaceId: 'T_HOME', channelId: 'C_CONNECT', actorId: 'U_MEMBER',
      botUserId: 'UBOT', observedAt: Date.now(),
    }, { slack: createMemoryScopeSlack('xoxb-test'), state });
    assert.deepEqual(decision, {
      enabled: false, reason: 'workspace_mismatch', workspaceRead: false, reads: [],
    });
  } finally {
    state.close();
    globalThis.fetch = originalFetch;
  }
});
