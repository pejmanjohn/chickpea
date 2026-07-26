import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeMemoryArchive } from '../src/memory/archive.ts';
import { createImportPreview, signImportPreview, verifyImportPreview } from '../src/memory/import.ts';
import { projectMemoryFiles } from '../src/memory/markdown.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import type { MemoryEntry, MemoryStoreDescriptor } from '../src/memory/types.ts';

const now = Date.UTC(2026, 6, 25, 12);
const store: MemoryStoreDescriptor = {
  storeId: 'store_public_T_TEST', workspaceId: 'T_TEST', visibility: 'public', channelId: null,
  generation: null, lifecycle: 'active', createdAt: now, sealedAt: null, sealedReason: null,
  schemaVersion: 1,
};
const entry: MemoryEntry = {
  entryId: 'mem_1', storeId: store.storeId, workspaceId: 'T_TEST', sourceChannelId: 'C1',
  slug: 'guidance', description: 'Original.', type: 'fact', body: 'Body.', status: 'active',
  version: 1, creatorActorId: 'U1', lastEditorActorId: 'U1', actorClass: 'member',
  sourceEventId: null, sourceThreadTs: null, sourceMessageTs: null, createdAt: now,
  modifiedAt: now, expiresAt: null, contentHash: null, supersedingEntryId: null,
};

test('manifest import previews updates and unchanged entries without mutating state', () => {
  const archive = encodeMemoryArchive(projectMemoryFiles({ store, entries: [entry] }));
  const unchanged = createImportPreview({ archive, targetStore: store, currentEntries: [entry] });
  assert.deepEqual(unchanged.summary, { creates: 0, updates: 0, unchanged: 1, conflicts: 0 });
  assert.equal(unchanged.candidates[0]?.action, 'unchanged');

  const files = projectMemoryFiles({ store, entries: [{ ...entry, description: 'Updated.' }] });
  const changed = createImportPreview({
    archive: encodeMemoryArchive(files), targetStore: store, currentEntries: [entry],
  });
  assert.equal(changed.candidates[0]?.action, 'update');
  assert.equal(changed.candidates[0]?.description, 'Updated.');
});

test('import rejects authored generated indexes and human archives cannot update', () => {
  const files = projectMemoryFiles({ store, entries: [entry] });
  const index = files.find((file) => file.path === 'channel/C1/MEMORY.md');
  assert.ok(index);
  index.content += '\nEdited\n';
  assert.throws(
    () => createImportPreview({ archive: encodeMemoryArchive(files), targetStore: store, currentEntries: [entry] }),
    /index|hash/i,
  );

  const human = encodeMemoryArchive([{ path: 'channel/C1/guidance.md', content: files[2]!.content }]);
  assert.throws(
    () => createImportPreview({ archive: human, targetStore: store, currentEntries: [entry] }),
    /create-only|already exists/i,
  );
});

test('preview tokens bind session, store, archive hash, schema, and expiry', () => {
  const claims = {
    sessionFingerprint: 'session-a', storeId: store.storeId, archiveSha256: 'a'.repeat(64),
    schemaVersion: 1, expiresAt: now + 600_000,
  };
  const token = signImportPreview(claims, 'admin-secret');
  assert.deepEqual(verifyImportPreview(token, 'admin-secret', { ...claims, now }), claims);
  assert.throws(() => verifyImportPreview(token, 'admin-secret', { ...claims, sessionFingerprint: 'other', now }), /bound|session/i);
  assert.throws(() => verifyImportPreview(token, 'admin-secret', { ...claims, now: claims.expiresAt + 1 }), /expired/i);
});

test('import apply is atomic when a later operation conflicts', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    await state.ensurePublicStore('T_TEST');
    await state.createEntry({
      entryId: entry.entryId, storeId: store.storeId, workspaceId: store.workspaceId,
      sourceChannelId: entry.sourceChannelId, slug: entry.slug, description: entry.description,
      type: entry.type, body: entry.body, actorId: 'U1', actorClass: 'member',
      idempotencyKey: 'seed',
    });
    await assert.rejects(
      () => state.applyImport({
        storeId: store.storeId,
        workspaceId: store.workspaceId,
        actorId: 'admin',
        archiveSha256: 'a'.repeat(64),
        idempotencyKey: 'batch',
        operations: [
          {
            action: 'create', entryId: 'mem_new', sourceChannelId: 'C1', slug: 'new',
            description: 'New.', type: 'fact', body: 'New body.',
          },
          {
            action: 'update', entryId: entry.entryId, expectedVersion: 99,
            sourceChannelId: 'C1', slug: entry.slug, description: 'Changed.',
            type: 'fact', body: 'Changed body.',
          },
        ],
      }),
      /changed before this update/i,
    );
    assert.equal(await state.getEntry('mem_new'), undefined);
    assert.equal((await state.getEntry(entry.entryId))?.version, 1);
    assert.equal((await state.listAuditEvents({ eventType: 'memory.imported' })).length, 0);
  } finally {
    state.close();
  }
});

test('import apply replays only the exact archive bound to its idempotency key', async () => {
  const state = new SqliteMemoryStateStore(':memory:', () => now);
  try {
    await state.ensurePublicStore('T_TEST');
    const request = {
      storeId: store.storeId,
      workspaceId: store.workspaceId,
      actorId: 'admin',
      archiveSha256: 'b'.repeat(64),
      idempotencyKey: 'batch-replay',
      operations: [{
        action: 'create' as const,
        entryId: 'mem_imported',
        sourceChannelId: 'C1',
        slug: 'imported',
        description: 'Imported.',
        type: 'fact' as const,
        body: 'Imported body.',
      }],
    };
    const created = await state.applyImport(request);
    const replay = await state.applyImport(request);
    assert.deepEqual(replay, created);
    assert.equal((await state.listAuditEvents({ eventType: 'memory.imported' })).length, 1);

    await assert.rejects(
      () => state.applyImport({ ...request, archiveSha256: 'c'.repeat(64) }),
      /different import request/i,
    );
  } finally {
    state.close();
  }
});
