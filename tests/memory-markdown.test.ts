import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectMemoryFiles } from '../src/memory/markdown.ts';
import type { MemoryEntry, MemoryStoreDescriptor } from '../src/memory/types.ts';

const store: MemoryStoreDescriptor = {
  storeId: 'store_public_T_TEST',
  workspaceId: 'T_TEST',
  visibility: 'public',
  channelId: null,
  generation: null,
  lifecycle: 'active',
  createdAt: Date.UTC(2026, 6, 25),
  sealedAt: null,
  sealedReason: null,
  schemaVersion: 1,
};

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    entryId: 'mem_01',
    storeId: store.storeId,
    workspaceId: store.workspaceId,
    sourceChannelId: 'C_PRODUCT',
    slug: 'release-guidance',
    description: 'Run the release checklist.',
    type: 'project',
    body: 'Use LF lines.\r\n\r\nSee [[cost-restraint]].',
    status: 'active',
    version: 2,
    creatorActorId: 'U_ONE',
    lastEditorActorId: 'U_TWO',
    actorClass: 'member',
    sourceEventId: 'Ev1',
    sourceThreadTs: '1.1',
    sourceMessageTs: '1.2',
    createdAt: Date.UTC(2026, 6, 24),
    modifiedAt: Date.UTC(2026, 6, 25, 1, 2, 3, 4),
    expiresAt: null,
    contentHash: 'ignored-by-projector',
    supersedingEntryId: null,
    ...overrides,
  };
}

test('projects deterministic channel files, generated indexes, and an authoritative manifest', () => {
  const entries = [
    entry({ entryId: 'mem_02', slug: 'cost-restraint', description: 'Be concise.' }),
    entry({}),
  ];
  const first = projectMemoryFiles({ store, entries });
  const second = projectMemoryFiles({ store, entries: [...entries].reverse() });

  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map((file) => file.path),
    [
      'MEMORY.md',
      'channel/C_PRODUCT/MEMORY.md',
      'channel/C_PRODUCT/cost-restraint.md',
      'channel/C_PRODUCT/release-guidance.md',
      'manifest.json',
    ],
  );
  const projected = first.find((file) => file.path.endsWith('/release-guidance.md'))?.content;
  assert.equal(
    projected,
    '---\nname: "release-guidance"\ndescription: "Run the release checklist."\nmetadata:\n  type: "project"\n  modified: "2026-07-25T01:02:03.004Z"\n---\n\nUse LF lines.\n\nSee [[cost-restraint]].\n',
  );
  assert.match(
    first.find((file) => file.path === 'channel/C_PRODUCT/MEMORY.md')?.content ?? '',
    /\[cost-restraint\]\(cost-restraint\.md\) — Be concise\.\n.*\[release-guidance\]/s,
  );

  const manifest = JSON.parse(first.at(-1)?.content ?? '{}');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.store.storeId, store.storeId);
  assert.deepEqual(manifest.entries.map((item: { entryId: string }) => item.entryId), [
    'mem_02',
    'mem_01',
  ]);
  assert.ok(manifest.entries.every((item: { sha256: string }) => /^[a-f0-9]{64}$/.test(item.sha256)));
});

test('private projection stays in its generation namespace', () => {
  const privateStore: MemoryStoreDescriptor = {
    ...store,
    storeId: 'store_private_T_TEST_C_PRIVATE_3',
    visibility: 'private',
    channelId: 'C_PRIVATE',
    generation: 3,
  };
  const files = projectMemoryFiles({
    store: privateStore,
    entries: [entry({ storeId: privateStore.storeId, sourceChannelId: 'C_PRIVATE' })],
  });
  assert.ok(files.some((file) => file.path === 'private/C_PRIVATE/generation-3/release-guidance.md'));
  assert.ok(files.every((file) => !file.path.startsWith('channel/')));
});
