import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bindAuthorizedMemoryScope,
  createMemoryScopeSlack,
  invalidateMemoryScopeUsersCache,
  resolveMemoryScope,
  validateMemoryScopeLease,
  verifyMemoryMutationMembership,
  type MemoryScopeSlack,
} from '../src/memory/scope.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { slackConversationsInfo } from '../src/slack/credentials.ts';

const fullMember = {
  id: 'U_MEMBER',
  teamId: 'T_TEST',
  deleted: false,
  bot: false,
  appUser: false,
  restricted: false,
  ultraRestricted: false,
  stranger: false,
};

test('trusted owner binding permits exactly one Agent memory on every surface', () => {
  const agent = {
    storeId: 'memory_owner_agent_T_TEST_agent_default', workspaceId: 'T_TEST',
    ownerKind: 'agent' as const, ownerId: 'agent_default', lifecycle: 'active' as const,
    resetEpoch: 3, createdAt: 1, sealedAt: null, sealedReason: null, schemaVersion: 2 as const,
  };
  const channelScope = bindAuthorizedMemoryScope({
    surface: 'channel', workspaceId: 'T_TEST', agentOwner: agent, writeOwner: agent,
  });
  assert.deepEqual(channelScope.readOwners.map(({ ownerKind }) => ownerKind), ['agent']);
  assert.equal(channelScope.writeOwner?.ownerKind, 'agent');
  const dmScope = bindAuthorizedMemoryScope({
    surface: 'dm', workspaceId: 'T_TEST', agentOwner: agent, writeOwner: agent,
  });
  assert.deepEqual(dmScope.readOwners.map(({ ownerKind }) => ownerKind), ['agent']);
  assert.equal(dmScope.writeOwner?.ownerKind, 'agent');
  assert.throws(() => bindAuthorizedMemoryScope({
    surface: 'channel', workspaceId: 'T_TEST', agentOwner: agent,
    channelOwner: { ...agent, ownerKind: 'channel' as const, ownerId: 'C_OTHER' },
  }), /Agent memory/i);
});

function slack(overrides: Partial<MemoryScopeSlack> = {}): MemoryScopeSlack {
  return {
    async conversation() {
      return {
        ok: true,
        facts: {
          id: 'C_SOURCE',
          name: 'product',
          private: false,
          archived: false,
          frozen: false,
          shared: false,
          externallyShared: false,
          organizationShared: false,
          pendingShared: false,
          member: true,
          teamId: 'T_TEST',
        },
      };
    },
    async user() {
      return { ok: true, user: fullMember };
    },
    async members() {
      return { ok: true, ids: ['U_MEMBER', 'U_OTHER', 'UBOT'] };
    },
    async users() {
      return {
        ok: true,
        users: [fullMember, { ...fullMember, id: 'U_OTHER' }, { ...fullMember, id: 'UBOT', bot: true }],
      };
    },
    ...overrides,
  };
}

test('eligible public scope expands workspace reads only after a complete audience census', async () => {
  const state = new SqliteMemoryStateStore(':memory:');
  try {
    const decision = await resolveMemoryScope(
      {
        workspaceId: 'T_TEST',
        channelId: 'C_SOURCE',
        actorId: 'U_MEMBER',
        botUserId: 'UBOT',
        observedAt: 100,
      },
      { slack: slack(), state },
    );
    assert.equal(decision.enabled, true);
    assert.equal(decision.workspaceRead, true);
    assert.deepEqual(decision.reads, [
      { storeId: 'store_public_T_TEST', sourceChannelId: null },
    ]);
    assert.equal(decision.writeStoreId, 'store_public_T_TEST');
  } finally {
    state.close();
  }
});

test('guest, foreign, missing, and third-party bot audience members degrade to source-only', async () => {
  for (const unsupported of [
    { ...fullMember, id: 'U_OTHER', restricted: true },
    { ...fullMember, id: 'U_OTHER', teamId: 'T_FOREIGN' },
    { ...fullMember, id: 'U_OTHER', bot: true },
  ]) {
    const state = new SqliteMemoryStateStore(':memory:');
    try {
      const decision = await resolveMemoryScope(
        {
          workspaceId: 'T_TEST',
          channelId: 'C_SOURCE',
          actorId: 'U_MEMBER',
          botUserId: 'UBOT',
          observedAt: 100,
        },
        {
          state,
          slack: slack({
            async members() {
              return { ok: true, ids: ['U_MEMBER', 'U_OTHER', 'UBOT'] };
            },
            async users() {
              return {
                ok: true,
                users: [fullMember, unsupported, { ...fullMember, id: 'UBOT', bot: true }],
              };
            },
          }),
        },
      );
      assert.equal(decision.enabled, true);
      assert.equal(decision.workspaceRead, false);
      assert.deepEqual(decision.reads, [
        { storeId: 'store_public_T_TEST', sourceChannelId: 'C_SOURCE' },
      ]);
    } finally {
      state.close();
    }
  }
});

test('private scope writes only to its generation and never returns it as a public query', async () => {
  const state = new SqliteMemoryStateStore(':memory:');
  try {
    const decision = await resolveMemoryScope(
      {
        workspaceId: 'T_TEST',
        channelId: 'C_PRIVATE',
        actorId: 'U_MEMBER',
        botUserId: 'UBOT',
        observedAt: 100,
      },
      {
        state,
        slack: slack({
          async conversation() {
            return {
              ok: true,
              facts: {
                id: 'C_PRIVATE',
                name: 'leadership',
                private: true,
                archived: false,
                frozen: false,
                shared: false,
                externallyShared: false,
                organizationShared: false,
                pendingShared: false,
                member: true,
                teamId: 'T_TEST',
              },
            };
          },
        }),
      },
    );
    assert.equal(decision.enabled, true);
    assert.match(decision.writeStoreId ?? '', /^store_private_/);
    assert.equal(decision.reads.some((read) => read.storeId === decision.writeStoreId), true);
    assert.equal(
      decision.reads.some(
        (read) => read.storeId === 'store_public_T_TEST' && read.sourceChannelId === null,
      ),
      true,
    );
  } finally {
    state.close();
  }
});

test('unsupported sharing and ineligible actors disable memory without blocking the ordinary turn', async () => {
  const state = new SqliteMemoryStateStore(':memory:');
  try {
    const shared = await resolveMemoryScope(
      {
        workspaceId: 'T_TEST',
        channelId: 'C_SOURCE',
        actorId: 'U_MEMBER',
        botUserId: 'UBOT',
        observedAt: 100,
      },
      {
        state,
        slack: slack({
          async conversation() {
            const base = await slack().conversation('C_SOURCE');
            assert.ok(base.facts);
            return { ...base, facts: { ...base.facts, externallyShared: true } };
          },
        }),
      },
    );
    assert.deepEqual(shared, {
      enabled: false,
      reason: 'unsupported_channel_scope',
      workspaceRead: false,
      reads: [],
    });

    const guestActor = await resolveMemoryScope(
      {
        workspaceId: 'T_TEST',
        channelId: 'C_SOURCE',
        actorId: 'U_MEMBER',
        botUserId: 'UBOT',
        observedAt: 100,
      },
      {
        state,
        slack: slack({
          async user() {
            return { ok: true, user: { ...fullMember, restricted: true } };
          },
        }),
      },
    );
    assert.equal(guestActor.enabled, false);
    assert.equal(guestActor.reason, 'ineligible_actor');

    const absentActor = await resolveMemoryScope(
      {
        workspaceId: 'T_TEST', channelId: 'C_SOURCE', actorId: 'U_MEMBER',
        botUserId: 'UBOT', observedAt: 100,
      },
      {
        state,
        slack: slack({
          async members() {
            return { ok: true, ids: ['U_OTHER', 'UBOT'] };
          },
        }),
      },
    );
    assert.equal(absentActor.enabled, false);
    assert.equal(absentActor.reason, 'ineligible_actor');

    const groupDm = await resolveMemoryScope(
      {
        workspaceId: 'T_TEST', channelId: 'C_SOURCE', actorId: 'U_MEMBER',
        botUserId: 'UBOT', observedAt: 100,
      },
      {
        state,
        slack: slack({
          async conversation() {
            const base = await slack().conversation('C_SOURCE');
            assert.ok(base.facts);
            return { ...base, facts: { ...base.facts, mpim: true } };
          },
        }),
      },
    );
    assert.equal(groupDm.enabled, false);
    assert.equal(groupDm.reason, 'unsupported_channel_scope');
  } finally {
    state.close();
  }
});

test('delivery lease rechecks current channel and actor membership without rejecting unrelated roster churn', async () => {
  const state = new SqliteMemoryStateStore(':memory:');
  try {
    let directoryCalls = 0;
    let membershipCalls = 0;
    const liveSlack = slack({
      async members() {
        membershipCalls += 1;
        return membershipCalls === 1
          ? { ok: true, ids: ['U_MEMBER', 'U_OTHER', 'UBOT'] }
          : { ok: true, ids: ['U_MEMBER', 'U_NEW', 'UBOT'] };
      },
      async users() {
        directoryCalls += 1;
        return {
          ok: true,
          users: [fullMember, { ...fullMember, id: 'U_OTHER' }, { ...fullMember, id: 'UBOT', bot: true }],
        };
      },
    });
    const input = {
      workspaceId: 'T_TEST', channelId: 'C_SOURCE', actorId: 'U_MEMBER',
      botUserId: 'UBOT', observedAt: 100,
    };
    const decision = await resolveMemoryScope(input, { slack: liveSlack, state });
    assert.equal(decision.enabled, true);
    if (!decision.enabled) return;
    assert.equal(directoryCalls, 1);
    assert.equal(await validateMemoryScopeLease(input, decision, liveSlack), true);
    assert.equal(directoryCalls, 1);
    assert.equal(
      await validateMemoryScopeLease(
        input,
        decision,
        slack({
          async conversation() {
            const current = await slack().conversation('C_SOURCE');
            assert.ok(current.facts);
            return { ...current, facts: { ...current.facts, private: true } };
          },
        }),
      ),
      false,
      'a live privacy change must fail closed',
    );
  } finally {
    state.close();
  }
});

test('delivery lease revalidates destination audience only for selected cross-source public memory', async () => {
  const state = new SqliteMemoryStateStore(':memory:');
  try {
    let directoryCalls = 0;
    let guestJoined = false;
    const liveSlack = slack({
      async members() {
        return {
          ok: true,
          ids: guestJoined
            ? ['U_MEMBER', 'U_GUEST', 'UBOT']
            : ['U_MEMBER', 'U_OTHER', 'UBOT'],
        };
      },
      async users() {
        directoryCalls += 1;
        return {
          ok: true,
          users: guestJoined
            ? [fullMember, { ...fullMember, id: 'U_GUEST', restricted: true }, { ...fullMember, id: 'UBOT', bot: true }]
            : [fullMember, { ...fullMember, id: 'U_OTHER' }, { ...fullMember, id: 'UBOT', bot: true }],
        };
      },
    });
    const input = {
      workspaceId: 'T_TEST', channelId: 'C_SOURCE', actorId: 'U_MEMBER',
      botUserId: 'UBOT', observedAt: 100,
    };
    const decision = await resolveMemoryScope(input, { slack: liveSlack, state });
    assert.equal(decision.enabled, true);
    if (!decision.enabled) return;

    assert.equal(await validateMemoryScopeLease(input, decision, liveSlack, true), true);
    guestJoined = true;
    assert.equal(await validateMemoryScopeLease(input, decision, liveSlack, true), false);
    assert.equal(directoryCalls, 3);
  } finally {
    state.close();
  }
});

test('workspace directory is single-flight cached by workspace and token and can be invalidated', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    invalidateMemoryScopeUsersCache();
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      assert.ok(url.pathname.endsWith('/users.list'));
      calls += 1;
      return Response.json({
        ok: true,
        members: [fullMember],
        response_metadata: { next_cursor: '' },
      });
    };
    const first = createMemoryScopeSlack('xoxb-cache', 'T_CACHE');
    const second = createMemoryScopeSlack('xoxb-cache', 'T_CACHE');
    await Promise.all([first.users(), second.users()]);
    await first.users();
    assert.equal(calls, 1);

    await createMemoryScopeSlack('xoxb-cache', 'T_OTHER').users();
    assert.equal(calls, 2);
    invalidateMemoryScopeUsersCache('T_CACHE', 'xoxb-cache');
    await first.users();
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateMemoryScopeUsersCache();
  }
});

test('one-page and five-page memory turns stay within their Slack API call budgets', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [pages, expectedCalls] of [[1, 7], [5, 19]] as const) {
      invalidateMemoryScopeUsersCache();
      let calls = 0;
      globalThis.fetch = async (input, init) => {
        calls += 1;
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        const method = url.pathname.split('/').pop();
        const params = new URLSearchParams(typeof init?.body === 'string' ? init.body : undefined);
        const page = Number(params.get('cursor') ?? '0');
        const nextCursor = page + 1 < pages ? String(page + 1) : '';
        if (method === 'conversations.info') {
          return Response.json({
            ok: true,
            channel: { id: 'C_BUDGET', name: 'budget', is_member: true, team_id: 'T_BUDGET' },
          });
        }
        if (method === 'users.info') {
          return Response.json({ ok: true, user: { ...fullMember, team_id: 'T_BUDGET' } });
        }
        if (method === 'conversations.members') {
          return Response.json({
            ok: true,
            members: ['U_MEMBER', 'UBOT'],
            response_metadata: { next_cursor: nextCursor },
          });
        }
        assert.equal(method, 'users.list');
        return Response.json({
          ok: true,
          members: [
            { ...fullMember, team_id: 'T_BUDGET' },
            { ...fullMember, id: 'UBOT', team_id: 'T_BUDGET', is_bot: true },
          ],
          response_metadata: { next_cursor: nextCursor },
        });
      };

      const state = new SqliteMemoryStateStore(':memory:');
      try {
        const liveSlack = createMemoryScopeSlack('xoxb-budget', 'T_BUDGET');
        const input = {
          workspaceId: 'T_BUDGET', channelId: 'C_BUDGET', actorId: 'U_MEMBER',
          botUserId: 'UBOT', observedAt: 100,
        };
        const decision = await resolveMemoryScope(input, { slack: liveSlack, state });
        assert.equal(decision.enabled, true);
        if (!decision.enabled) continue;
        assert.equal(await validateMemoryScopeLease(input, decision, liveSlack, true), true);
        assert.equal(calls, expectedCalls, `${pages}-page turn exceeded its API call budget`);
      } finally {
        state.close();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    invalidateMemoryScopeUsersCache();
  }
});

test('raw Slack truth fetches return typed degradation for deadlines, non-JSON, network, and 429 responses', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => new Promise<Response>(() => {});
    const startedAt = Date.now();
    const timedOut = await slackConversationsInfo('xoxb-timeout', 'C_TIMEOUT', {
      timeoutMs: 20,
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error, 'slack_request_timeout');
    assert.ok(Date.now() - startedAt < 250, 'deadline should bound a fetch that never settles');

    globalThis.fetch = async () => new Response('upstream HTML', { status: 502 });
    const nonJson = await slackConversationsInfo('xoxb-non-json', 'C_BAD');
    assert.equal(nonJson.ok, false);
    assert.equal(nonJson.error, 'slack_non_json_response');

    globalThis.fetch = async () => { throw new TypeError('offline'); };
    const network = await slackConversationsInfo('xoxb-offline', 'C_BAD');
    assert.equal(network.ok, false);
    assert.equal(network.error, 'slack_network_error');

    globalThis.fetch = async () => Response.json(
      { ok: false, error: 'ratelimited' },
      { status: 429, headers: { 'retry-after': '3' } },
    );
    const rateLimited = await slackConversationsInfo('xoxb-rate', 'C_RATE');
    assert.equal(rateLimited.ok, false);
    assert.equal(rateLimited.error, 'ratelimited');
    assert.equal(rateLimited.retryAfterMs, 3_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('archived and deleted Slack truth retain channel state while transient failures do not', async () => {
  for (const scenario of [
    { name: 'archived', reason: 'archived', conversation: async () => {
      const current = await slack().conversation('C_SOURCE');
      assert.ok(current.facts);
      return { ...current, facts: { ...current.facts, private: true, archived: true } };
    } },
    { name: 'deleted', reason: 'deleted', conversation: async () => ({
      ok: false, error: 'channel_not_found',
    }) },
  ] as const) {
    const state = new SqliteMemoryStateStore(':memory:');
    try {
      const active = await state.observeChannelScope({
        workspaceId: 'T_TEST', channelId: 'C_SOURCE', privacy: 'private',
        displayName: 'private-source', observedAt: 50,
      });
      assert.ok(active.privateStoreId);
      const decision = await resolveMemoryScope(
        {
          workspaceId: 'T_TEST', channelId: 'C_SOURCE', actorId: 'U_MEMBER',
          botUserId: 'UBOT', observedAt: 100,
        },
        { slack: slack({ conversation: scenario.conversation }), state },
      );
      assert.equal(decision.enabled, false, scenario.name);
      const retained = await state.getChannelScope('T_TEST', 'C_SOURCE');
      assert.equal(retained?.lifecycle, 'retained');
      assert.equal((await state.listChannelScopes('T_TEST'))[0]?.lifecycle, 'retained');
      assert.equal((await state.getStore(active.privateStoreId))?.lifecycle, 'sealed');
      assert.equal(
        (await state.getStore(active.privateStoreId))?.sealedReason,
        `channel_${scenario.reason}`,
      );
    } finally {
      state.close();
    }
  }

  const state = new SqliteMemoryStateStore(':memory:');
  try {
    const active = await state.observeChannelScope({
      workspaceId: 'T_TEST', channelId: 'C_SOURCE', privacy: 'private',
      displayName: 'private-source', observedAt: 50,
    });
    await resolveMemoryScope(
      {
        workspaceId: 'T_TEST', channelId: 'C_SOURCE', actorId: 'U_MEMBER',
        botUserId: 'UBOT', observedAt: 100,
      },
      { slack: slack({ async conversation() { return { ok: false, error: 'ratelimited' }; } }), state },
    );
    assert.equal((await state.getChannelScope('T_TEST', 'C_SOURCE'))?.lifecycle, 'active');
    assert.equal((await state.getStore(active.privateStoreId!))?.lifecycle, 'active');
  } finally {
    state.close();
  }
});

test('mutation membership is re-proven and page-bound failures deny the write', async () => {
  assert.equal(
    await verifyMemoryMutationMembership('C_SOURCE', 'U_MEMBER', slack()),
    true,
  );
  assert.equal(
    await verifyMemoryMutationMembership(
      'C_SOURCE',
      'U_MEMBER',
      slack({
        async members() {
          return { ok: true, ids: ['U_MEMBER'], incomplete: true };
        },
      }),
    ),
    true,
  );
  assert.equal(
    await verifyMemoryMutationMembership(
      'C_SOURCE',
      'U_GONE',
      slack({
        async members() {
          return { ok: true, ids: ['U_MEMBER'], incomplete: true };
        },
      }),
    ),
    false,
  );
});
