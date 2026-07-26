import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeMemoryArchive } from '../src/memory/archive.ts';
import { createImportPreview, signImportPreview, verifyImportPreview } from '../src/memory/import.ts';
import { projectMemoryFiles } from '../src/memory/markdown.ts';
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

