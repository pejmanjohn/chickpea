import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveMemoryScope,
  verifyMemoryMutationMembership,
  type MemoryScopeSlack,
} from '../src/memory/scope.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';

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
      return { ok: true, ids: ['U_MEMBER', 'U_OTHER', 'U_BOT'] };
    },
    async users() {
      return {
        ok: true,
        users: [fullMember, { ...fullMember, id: 'U_OTHER' }, { ...fullMember, id: 'U_BOT', bot: true }],
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
        botUserId: 'U_BOT',
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
          botUserId: 'U_BOT',
          observedAt: 100,
        },
        {
          state,
          slack: slack({
            async members() {
              return { ok: true, ids: ['U_MEMBER', 'U_OTHER', 'U_BOT'] };
            },
            async users() {
              return {
                ok: true,
                users: [fullMember, unsupported, { ...fullMember, id: 'U_BOT', bot: true }],
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
        botUserId: 'U_BOT',
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
        botUserId: 'U_BOT',
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
        botUserId: 'U_BOT',
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
