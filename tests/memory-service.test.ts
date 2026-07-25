import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryService } from '../src/memory/service.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import type { EnabledMemoryScope } from '../src/memory/scope.ts';

const scope: EnabledMemoryScope = {
  enabled: true,
  reason: 'eligible',
  privacy: 'public',
  workspaceRead: false,
  reads: [{ storeId: 'store_public_T_TEST', sourceChannelId: 'C_SOURCE' }],
  writeStoreId: 'store_public_T_TEST',
  sourceChannelId: 'C_SOURCE',
  displayName: 'product',
  audienceMemberIds: ['U_MEMBER'],
  visibilityBarrierAt: null,
  transitionVersion: 1,
};

function service(state: SqliteMemoryStateStore): MemoryService {
  let id = 0;
  return new MemoryService(state, {
    now: () => 1_000,
    id: (prefix) => `${prefix}_${++id}`,
    token: () => 'confirm-token',
  });
}

test('remember, show, update, list, and exact replay preserve provenance and versions', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    await state.ensurePublicStore('T_TEST');
    const memory = service(state);
    const created = await memory.remember({
      scope,
      workspaceId: 'T_TEST',
      actorId: 'U_MEMBER',
      eventId: 'E1',
      messageTs: '1000.1',
      name: 'Release Convention',
      description: 'How the product channel prepares releases.',
      type: 'project',
      body: 'Run the release checklist and smoke tests.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    const replay = await memory.remember({
      scope,
      workspaceId: 'T_TEST',
      actorId: 'U_MEMBER',
      eventId: 'E1',
      messageTs: '1000.1',
      name: 'Release Convention',
      description: 'How the product channel prepares releases.',
      type: 'project',
      body: 'Run the release checklist and smoke tests.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    assert.deepEqual(replay, created);
    assert.equal(created.entry.slug, 'release-convention');
    assert.equal(created.entry.version, 1);

    const updated = await memory.update({
      scope,
      actorId: 'U_MEMBER',
      eventId: 'E2',
      target: 'release-convention',
      expectedVersion: 1,
      description: 'Updated release preparation.',
      type: 'project',
      body: 'Run the checklist, unit tests, and production smoke tests.',
      idempotencyKey: 'memory:slack:T_TEST:E2:0',
    });
    assert.equal(updated.entry.version, 2);
    assert.equal((await memory.show({ scope, target: 'release-convention' })).body, updated.entry.body);
    assert.equal((await memory.list({ scope })).length, 1);
    const lateReplay = await memory.remember({
      scope,
      workspaceId: 'T_TEST',
      actorId: 'U_MEMBER',
      eventId: 'E1',
      messageTs: '1000.1',
      name: 'Release Convention',
      description: 'How the product channel prepares releases.',
      type: 'project',
      body: 'Run the release checklist and smoke tests.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    assert.deepEqual(lateReplay, created);
  } finally {
    state.close();
  }
});

test('same slug is allowed in two source partitions but a tombstone reserves its original path', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    await state.ensurePublicStore('T_TEST');
    const memory = service(state);
    const one = await memory.remember({
      scope,
      workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
      name: 'Shared fact', description: 'First channel.', type: 'fact', body: 'Alpha.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    const otherScope = { ...scope, sourceChannelId: 'C_OTHER', reads: [{ storeId: scope.writeStoreId, sourceChannelId: 'C_OTHER' }] };
    const two = await memory.remember({
      scope: otherScope,
      workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E2', messageTs: '2',
      name: 'Shared fact', description: 'Other channel.', type: 'fact', body: 'Beta.',
      idempotencyKey: 'memory:slack:T_TEST:E2:0',
    });
    assert.equal(one.entry.slug, 'shared-fact');
    assert.equal(two.entry.slug, 'shared-fact');

    const challenge = await memory.requestForget({
      scope,
      actorId: 'U_MEMBER',
      target: 'shared-fact',
      expectedVersion: 1,
    });
    await memory.forget({
      scope,
      actorId: 'U_MEMBER',
      eventId: 'E3',
      target: 'shared-fact',
      expectedVersion: 1,
      confirmationToken: challenge.token,
      idempotencyKey: 'memory:slack:T_TEST:E3:0',
    });
    const replacement = await memory.remember({
      scope,
      workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E4', messageTs: '4',
      name: 'Shared fact', description: 'Replacement.', type: 'fact', body: 'Gamma.',
      idempotencyKey: 'memory:slack:T_TEST:E4:0',
    });
    assert.equal(replacement.entry.slug, 'shared-fact-2');
  } finally {
    state.close();
  }
});

test('forget confirmation is actor, entry, version, expiry, and replay bound', async () => {
  let now = 1_000;
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    await state.ensurePublicStore('T_TEST');
    let token = 0;
    const memory = new MemoryService(state, {
      now: () => now,
      id: (prefix) => `${prefix}_1`,
      token: () => `token-${++token}`,
    });
    const created = await memory.remember({
      scope,
      workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
      name: 'Temporary', description: 'Temporary guidance.', type: 'fact', body: 'Remove me.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    const challenge = await memory.requestForget({
      scope, actorId: 'U_MEMBER', target: created.entry.slug, expectedVersion: 1,
    });
    await assert.rejects(
      () => memory.forget({
        scope, actorId: 'U_OTHER', eventId: 'E2', target: created.entry.slug,
        expectedVersion: 1, confirmationToken: challenge.token,
        idempotencyKey: 'memory:slack:T_TEST:E2:0',
      }),
      /confirmation/i,
    );
    now = challenge.expiresAt + 1;
    await assert.rejects(
      () => memory.forget({
        scope, actorId: 'U_MEMBER', eventId: 'E3', target: created.entry.slug,
        expectedVersion: 1, confirmationToken: challenge.token,
        idempotencyKey: 'memory:slack:T_TEST:E3:0',
      }),
      /expired/i,
    );
  } finally {
    state.close();
  }
});

test('idempotency replays reject different content and do not spend another rate slot', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    await state.ensurePublicStore('T_TEST');
    const memory = service(state);
    await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
      name: 'Stable replay', description: 'Original description.', type: 'fact', body: 'Original body.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    await assert.rejects(
      () => memory.remember({
        scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
        name: 'Stable replay', description: 'Original description.', type: 'fact', body: 'Different body.',
        idempotencyKey: 'memory:slack:T_TEST:E1:0',
      }),
      /different memory content/i,
    );
    await assert.rejects(
      () => memory.remember({
        scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
        name: 'Different name', description: 'Original description.', type: 'fact', body: 'Original body.',
        idempotencyKey: 'memory:slack:T_TEST:E1:0',
      }),
      /different memory content/i,
    );
    assert.equal((await state.getMutationCounts('T_TEST', 'C_SOURCE', 'U_MEMBER')).actor, 1);

    const symbols = await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E2', messageTs: '2',
      name: '重要', description: 'Stable symbol fallback.', type: 'fact', body: 'Same body.',
      idempotencyKey: 'memory:slack:T_TEST:E2:0',
    });
    const symbolReplay = await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E2', messageTs: '2',
      name: '重要', description: 'Stable symbol fallback.', type: 'fact', body: 'Same body.',
      idempotencyKey: 'memory:slack:T_TEST:E2:0',
    });
    assert.equal(symbolReplay.entry.entryId, symbols.entry.entryId);
    assert.equal(symbolReplay.entry.slug, symbols.entry.slug);
  } finally {
    state.close();
  }
});

test('merge is atomic on a stale source version and supersedes sources on success', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    await state.ensurePublicStore('T_TEST');
    const memory = service(state);
    const first = await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
      name: 'First fact', description: 'First.', type: 'fact', body: 'Alpha.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    const second = await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E2', messageTs: '2',
      name: 'Second fact', description: 'Second.', type: 'fact', body: 'Beta.',
      idempotencyKey: 'memory:slack:T_TEST:E2:0',
    });
    await assert.rejects(
      () => memory.merge({
        scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E3',
        targets: [
          { target: first.entry.slug, expectedVersion: 1 },
          { target: second.entry.slug, expectedVersion: 99 },
        ],
        name: 'Combined fact', description: 'Combined.', type: 'fact', body: 'Alpha and beta.',
        idempotencyKey: 'memory:slack:T_TEST:E3:0',
      }),
      /changed before this update/i,
    );
    assert.deepEqual(
      (await memory.list({ scope })).map((entry) => entry.slug),
      ['first-fact', 'second-fact'],
    );

    const merged = await memory.merge({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E4',
      targets: [
        { target: first.entry.slug, expectedVersion: 1 },
        { target: second.entry.slug, expectedVersion: 1 },
      ],
      name: 'Combined fact', description: 'Combined.', type: 'fact', body: 'Alpha and beta.',
      idempotencyKey: 'memory:slack:T_TEST:E4:0',
    });
    assert.equal(merged.entry.slug, 'combined-fact');
    assert.deepEqual((await memory.list({ scope })).map((entry) => entry.slug), ['combined-fact']);
    assert.equal((await state.getEntry(first.entry.entryId))?.supersedingEntryId, merged.entry.entryId);
    const replay = await memory.merge({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E4',
      targets: [{ target: first.entry.slug }, { target: second.entry.slug }],
      name: 'Combined fact', description: 'Combined.', type: 'fact', body: 'Alpha and beta.',
      idempotencyKey: 'memory:slack:T_TEST:E4:0',
    });
    assert.equal(replay.entry.entryId, merged.entry.entryId);
  } finally {
    state.close();
  }
});

test('expiry, restore, and review actions preserve bodies and emit typed audit events', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    await state.ensurePublicStore('T_TEST');
    const memory = service(state);
    const created = await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
      name: 'Review me', description: 'Reviewable.', type: 'decision', body: 'Keep this decision.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    await memory.requestReview({
      scope, target: created.entry.slug, expectedVersion: 1, actorId: 'U_MEMBER',
      idempotencyKey: 'memory:review:1',
    });
    const expired = await memory.expire({
      scope, target: created.entry.slug, expectedVersion: 1, actorId: 'U_MEMBER', eventId: 'E2',
      idempotencyKey: 'memory:slack:T_TEST:E2:0',
    });
    assert.equal(expired.entry.status, 'expired');
    assert.equal(expired.entry.body, 'Keep this decision.');
    assert.equal((await memory.list({ scope })).length, 0);
    const restored = await memory.restore({
      scope, target: created.entry.slug, expectedVersion: 2, actorId: 'U_MEMBER', eventId: 'E3',
      idempotencyKey: 'memory:slack:T_TEST:E3:0',
    });
    assert.equal(restored.entry.status, 'active');
    await memory.resolveReview({
      scope, target: created.entry.slug, expectedVersion: 3, resolution: 'confirmed',
      actorId: 'U_MEMBER', idempotencyKey: 'memory:review:2',
    });
    assert.deepEqual(
      (await state.listAuditEvents({ domain: 'memory' }))
        .map((event) => event.eventType)
        .sort(),
      ['memory.created', 'memory.expired', 'memory.restored', 'memory.review_requested', 'memory.review_resolved'],
    );
  } finally {
    state.close();
  }
});

test('a private scope can forget but cannot update its source channel retained public memory', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    await state.ensurePublicStore('T_TEST');
    await state.ensurePrivateStore('T_TEST', 'C_SOURCE', 1);
    const memory = service(state);
    const created = await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
      name: 'Formerly public', description: 'Was public.', type: 'fact', body: 'Public history.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    const privateScope: EnabledMemoryScope = {
      ...scope,
      privacy: 'private',
      reads: [
        { storeId: 'store_private_T_TEST_C_SOURCE_1', sourceChannelId: null },
        { storeId: 'store_public_T_TEST', sourceChannelId: 'C_SOURCE' },
      ],
      writeStoreId: 'store_private_T_TEST_C_SOURCE_1',
    };
    await assert.rejects(
      () => memory.update({
        scope: privateScope, actorId: 'U_MEMBER', eventId: 'E2',
        target: created.entry.slug, expectedVersion: 1, description: 'Changed.',
        type: 'fact', body: 'Changed.', idempotencyKey: 'memory:slack:T_TEST:E2:0',
      }),
      /not found/i,
    );
    const challenge = await memory.requestForget({
      scope: privateScope, actorId: 'U_MEMBER', target: created.entry.slug, expectedVersion: 1,
    });
    const forgotten = await memory.forget({
      scope: privateScope, actorId: 'U_MEMBER', eventId: 'E3', target: created.entry.slug,
      expectedVersion: 1, confirmationToken: challenge.token,
      idempotencyKey: 'memory:slack:T_TEST:E3:0',
    });
    assert.equal(forgotten.entry.status, 'forgotten');
  } finally {
    state.close();
  }
});

test('forget-confirm replay survives a consumed challenge and retained public reads', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    await state.ensurePublicStore('T_TEST');
    await state.ensurePrivateStore('T_TEST', 'C_SOURCE', 1);
    const memory = service(state);
    const created = await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
      name: 'Retained public', description: 'Before conversion.', type: 'fact', body: 'Public body.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    const privateScope: EnabledMemoryScope = {
      ...scope,
      privacy: 'private',
      workspaceRead: true,
      reads: [
        { storeId: 'store_private_T_TEST_C_SOURCE_1', sourceChannelId: null },
        { storeId: 'store_public_T_TEST', sourceChannelId: null },
      ],
      writeStoreId: 'store_private_T_TEST_C_SOURCE_1',
    };
    const challenge = await memory.requestForget({
      scope: privateScope,
      actorId: 'U_MEMBER',
      target: `public/${created.entry.slug}`,
      expectedVersion: 1,
    });
    const input = {
      scope: privateScope,
      actorId: 'U_MEMBER',
      eventId: 'E2',
      confirmationToken: challenge.token,
      idempotencyKey: 'memory:slack:T_TEST:E2:0',
    };
    const first = await memory.confirmForget(input);
    const replay = await memory.confirmForget(input);
    assert.equal(first.entry.status, 'forgotten');
    assert.equal(replay.entry.entryId, first.entry.entryId);
    assert.equal(replay.entry.version, first.entry.version);
  } finally {
    state.close();
  }
});

test('private writable entries win unqualified slug collisions with retained public memory', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => 1_000);
  try {
    await state.ensurePublicStore('T_TEST');
    await state.ensurePrivateStore('T_TEST', 'C_SOURCE', 1);
    const memory = service(state);
    const publicEntry = await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E1', messageTs: '1',
      name: 'Same name', description: 'Public.', type: 'fact', body: 'Public body.',
      idempotencyKey: 'memory:slack:T_TEST:E1:0',
    });
    const privateScope: EnabledMemoryScope = {
      ...scope,
      privacy: 'private',
      reads: [
        { storeId: 'store_private_T_TEST_C_SOURCE_1', sourceChannelId: null },
        { storeId: 'store_public_T_TEST', sourceChannelId: 'C_SOURCE' },
      ],
      writeStoreId: 'store_private_T_TEST_C_SOURCE_1',
    };
    const privateEntry = await memory.remember({
      scope: privateScope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E2', messageTs: '2',
      name: 'Same name', description: 'Private.', type: 'fact', body: 'Private body.',
      idempotencyKey: 'memory:slack:T_TEST:E2:0',
    });
    const updated = await memory.update({
      scope: privateScope, actorId: 'U_MEMBER', eventId: 'E3', target: 'same-name',
      expectedVersion: 1, description: 'Private updated.', type: 'fact', body: 'Private updated.',
      idempotencyKey: 'memory:slack:T_TEST:E3:0',
    });
    assert.equal(updated.entry.entryId, privateEntry.entry.entryId);
    assert.equal((await state.getEntry(publicEntry.entry.entryId))?.version, 1);
  } finally {
    state.close();
  }
});

test('member mutation rate limits roll back the denied command and reset at the next window', async () => {
  let now = 1_000;
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    await state.ensurePublicStore('T_TEST');
    let id = 0;
    const memory = new MemoryService(state, {
      now: () => now,
      id: (prefix) => `${prefix}_${++id}`,
    });
    for (let index = 0; index < 30; index += 1) {
      await memory.remember({
        scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: `E${index}`,
        name: `Rate ${index}`, description: `Rate entry ${index}.`, type: 'fact', body: `Body ${index}.`,
        idempotencyKey: `memory:slack:T_TEST:E${index}:0`,
      });
    }
    await assert.rejects(
      () => memory.remember({
        scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E31',
        name: 'Rate denied', description: 'Denied.', type: 'fact', body: 'Must roll back.',
        idempotencyKey: 'memory:slack:T_TEST:E31:0',
      }),
      /too many memory changes/i,
    );
    assert.equal((await memory.list({ scope })).length, 30);
    assert.equal((await state.getMutationCounts('T_TEST', 'C_SOURCE', 'U_MEMBER')).actor, 30);

    now = 3_600_001;
    await memory.remember({
      scope, workspaceId: 'T_TEST', actorId: 'U_MEMBER', eventId: 'E32',
      name: 'Rate reset', description: 'Allowed after reset.', type: 'fact', body: 'New window.',
      idempotencyKey: 'memory:slack:T_TEST:E32:0',
    });
    assert.equal((await state.getMutationCounts('T_TEST', 'C_SOURCE', 'U_MEMBER')).actor, 1);
  } finally {
    state.close();
  }
});
