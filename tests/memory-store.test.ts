import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MemoryStoreLogic, SqliteMemoryStateStore } from '../src/memory/store.ts';
import { MemoryVersionConflictError } from '../src/memory/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { StateDb } from '../src/state/state-db.ts';

const createdAt = Date.UTC(2026, 6, 25, 12);

function createInput(idempotencyKey = 'memory:slack:T_TEST:E1:0') {
  return {
    entryId: 'mem_01',
    storeId: 'store_public_T_TEST',
    workspaceId: 'T_TEST',
    sourceChannelId: 'C_SOURCE',
    slug: 'release-convention',
    description: 'How releases are prepared.',
    type: 'project' as const,
    body: 'Use the release checklist before merging.',
    actorId: 'U_MEMBER',
    actorClass: 'member' as const,
    sourceEventId: 'E1',
    sourceThreadTs: '1753444800.000001',
    sourceMessageTs: '1753444800.000001',
    idempotencyKey,
  };
}

test('memory state initializes beside existing tables and creates a public store', async () => {
  const db = openStateDb(':memory:');
  db.exec('CREATE TABLE existing_fixture (id TEXT PRIMARY KEY)');
  db.run('INSERT INTO existing_fixture (id) VALUES (?)', 'preserved');
  const logic = new MemoryStoreLogic(db, () => createdAt);

  const store = logic.ensurePublicStore('T_TEST');
  assert.deepEqual(store, {
    storeId: 'store_public_T_TEST',
    workspaceId: 'T_TEST',
    visibility: 'public',
    channelId: null,
    generation: null,
    lifecycle: 'active',
    createdAt,
    sealedAt: null,
    sealedReason: null,
    schemaVersion: 1,
  });
  assert.equal(db.get('SELECT id FROM existing_fixture')?.id, 'preserved');
  db.close();
});

test('target-neutral memory schema initialization does not depend on SQLite pragmas', () => {
  const sqlite = openStateDb(':memory:');
  const portableDb: StateDb = {
    run: (sql, ...params) => sqlite.run(sql, ...params),
    get: (sql, ...params) => sqlite.get(sql, ...params),
    all: (sql, ...params) => sqlite.all(sql, ...params),
    exec: (sql) => {
      if (/^\s*PRAGMA\b/i.test(sql)) {
        throw new Error('Cloudflare-compatible StateDb does not expose PRAGMA');
      }
      sqlite.exec(sql);
    },
    transaction: (fn) => sqlite.transaction(fn),
  };

  assert.doesNotThrow(() => new MemoryStoreLogic(portableDb, () => createdAt));
  sqlite.close();
});

test('create is atomic, idempotent, audited, and does not double-count rate windows', async () => {
  const store = new SqliteMemoryStateStore(':memory:', () => createdAt);
  try {
    await store.ensurePublicStore('T_TEST');
    const first = await store.createEntry(createInput());
    const replay = await store.createEntry(createInput());

    assert.deepEqual(replay, first);
    assert.equal(first.version, 1);
    assert.equal((await store.listRevisions(first.entryId)).length, 1);
    assert.equal((await store.listAuditEvents({ subjectId: first.entryId })).length, 1);
    assert.deepEqual(await store.getMutationCounts('T_TEST', 'C_SOURCE', 'U_MEMBER'), {
      actor: 1,
      channel: 1,
      windowStartedAt: createdAt,
    });
  } finally {
    store.close();
  }
});

test('entry listing pages over the stable scope and slug ordering', async () => {
  const store = new SqliteMemoryStateStore(':memory:', () => createdAt);
  try {
    await store.ensurePublicStore('T_TEST');
    for (const slug of ['charlie', 'alpha', 'bravo']) {
      await store.createEntry({
        ...createInput(`create-${slug}`),
        entryId: `mem_${slug}`,
        slug,
        actorClass: 'operator',
      });
    }
    const first = await store.listEntries({ storeId: 'store_public_T_TEST', limit: 2 });
    const second = await store.listEntries({ storeId: 'store_public_T_TEST', limit: 2, offset: 2 });
    assert.deepEqual(first.map((entry) => entry.slug), ['alpha', 'bravo']);
    assert.deepEqual(second.map((entry) => entry.slug), ['charlie']);
  } finally {
    store.close();
  }
});

test('audit failure rolls back the entry, revision, and rate-window writes', () => {
  const db = openStateDb(':memory:');
  const logic = new MemoryStoreLogic(db, () => createdAt);
  logic.ensurePublicStore('T_TEST');
  db.exec(
    `CREATE TRIGGER reject_memory_audit BEFORE INSERT ON audit_events
     WHEN NEW.domain = 'memory'
     BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
  );

  assert.throws(() => logic.createEntry(createInput()), /audit unavailable/);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM memory_entries')?.count, 0);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM memory_revisions')?.count, 0);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM memory_mutation_windows')?.count, 0);
  db.close();
});

test('updates require the expected version and forgetting scrubs all recoverable content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-memory-store-'));
  const path = join(dir, 'state.db');
  const store = new SqliteMemoryStateStore(path, () => createdAt);
  try {
    await store.ensurePublicStore('T_TEST');
    const created = await store.createEntry(createInput());
    await assert.rejects(
      () =>
        store.updateEntry({
          entryId: created.entryId,
          expectedVersion: 9,
          description: 'Changed.',
          body: 'Changed body.',
          type: 'project',
          actorId: 'U_MEMBER',
          actorClass: 'member',
          idempotencyKey: 'memory:slack:T_TEST:E2:0',
        }),
      MemoryVersionConflictError,
    );

    const updated = await store.updateEntry({
      entryId: created.entryId,
      expectedVersion: 1,
      description: 'Updated release guidance.',
      body: 'Run the release checklist and smoke tests.',
      type: 'project',
      actorId: 'U_MEMBER',
      actorClass: 'member',
      idempotencyKey: 'memory:slack:T_TEST:E3:0',
    });
    assert.equal(updated.version, 2);

    const forgotten = await store.forgetEntry({
      entryId: created.entryId,
      expectedVersion: 2,
      actorId: 'U_MEMBER',
      actorClass: 'member',
      idempotencyKey: 'memory:slack:T_TEST:E4:0',
    });
    assert.equal(forgotten.status, 'forgotten');
    assert.equal(forgotten.description, '');
    assert.equal(forgotten.body, '');
    assert.equal(forgotten.contentHash, null);

    const db = openStateDb(path);
    const revisionRows = db.all(
      'SELECT description, body, before_hash, after_hash FROM memory_revisions WHERE entry_id = ?',
      created.entryId,
    );
    assert.ok(revisionRows.length >= 3);
    assert.ok(
      revisionRows.every(
        (row) =>
          row.description === null &&
          row.body === null &&
          row.before_hash === null &&
          row.after_hash === null,
      ),
    );
    db.close();

    const raw = readFileSync(path).toString('latin1');
    for (const secret of [
      'Use the release checklist before merging.',
      'Run the release checklist and smoke tests.',
      createHash('sha256')
        .update('How releases are prepared.\n\u0000Use the release checklist before merging.')
        .digest('hex'),
      createHash('sha256')
        .update('Updated release guidance.\n\u0000Run the release checklist and smoke tests.')
        .digest('hex'),
    ]) {
      assert.equal(raw.includes(secret), false);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conversation contexts rotate monotonically only when the selection contract changes', async () => {
  const store = new SqliteMemoryStateStore(':memory:', () => createdAt);
  try {
    const first = await store.resolveConversationContext({
      baseConversationKey: 'T_TEST:C_SOURCE:THREAD',
      scopeSignature: 'public:source-only',
      selectionFingerprint: 'mem_01:1',
      selected: [{ entryId: 'mem_01', version: 1 }],
      expiresAt: createdAt + 100_000,
    });
    const unchanged = await store.resolveConversationContext({
      baseConversationKey: 'T_TEST:C_SOURCE:THREAD',
      scopeSignature: 'public:source-only',
      selectionFingerprint: 'mem_01:1',
      selected: [{ entryId: 'mem_01', version: 1 }],
      expiresAt: createdAt + 100_000,
    });
    const rotated = await store.resolveConversationContext({
      baseConversationKey: 'T_TEST:C_SOURCE:THREAD',
      scopeSignature: 'public:workspace',
      selectionFingerprint: 'mem_02:1',
      selected: [{ entryId: 'mem_02', version: 1 }],
      expiresAt: createdAt + 100_000,
    });

    assert.equal(first.epoch, 1);
    assert.equal(unchanged.epoch, 1);
    assert.equal(rotated.epoch, 2);
  } finally {
    store.close();
  }
});
