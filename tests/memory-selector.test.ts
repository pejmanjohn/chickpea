import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectMemoryEntries } from '../src/memory/selector.ts';
import type { MemoryEntry } from '../src/memory/types.ts';

const now = Date.UTC(2026, 6, 25);

function entry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'entryId' | 'slug' | 'sourceChannelId'>): MemoryEntry {
  return {
    entryId: overrides.entryId,
    storeId: 'store_public_T',
    workspaceId: 'T',
    sourceChannelId: overrides.sourceChannelId,
    slug: overrides.slug,
    description: overrides.description ?? 'General guidance',
    type: overrides.type ?? 'fact',
    body: overrides.body ?? 'Use this guidance.',
    status: overrides.status ?? 'active',
    version: overrides.version ?? 1,
    creatorActorId: 'U', lastEditorActorId: 'U', actorClass: 'member',
    sourceEventId: null, sourceThreadTs: null, sourceMessageTs: null,
    createdAt: overrides.createdAt ?? now,
    modifiedAt: overrides.modifiedAt ?? now,
    expiresAt: overrides.expiresAt ?? null,
    contentHash: null, supersedingEntryId: null,
  };
}

test('selector reserves current-channel memory and ranks explicit qualified references', () => {
  const selection = selectMemoryEntries({
    entries: [
      entry({ entryId: '1', slug: 'tone', sourceChannelId: 'C_CURRENT', body: 'Be concise.' }),
      entry({ entryId: '2', slug: 'release', sourceChannelId: 'C_OTHER', body: 'Deploy Friday.' }),
      entry({ entryId: '3', slug: 'unrelated', sourceChannelId: 'C_OTHER' }),
    ],
    query: 'What does C_OTHER/release say?',
    sourceChannelId: 'C_CURRENT',
    now,
  });
  assert.deepEqual(selection.entries.map(({ entry: item }) => item.entryId), ['2', '1']);
});

test('selector excludes expired and forgotten entries, penalizes stale, and is tie-stable', () => {
  const selection = selectMemoryEntries({
    entries: [
      entry({ entryId: 'b', slug: 'project-beta', sourceChannelId: 'C_CURRENT', modifiedAt: now - 91 * 86_400_000 }),
      entry({ entryId: 'a', slug: 'project-alpha', sourceChannelId: 'C_CURRENT' }),
      entry({ entryId: 'x', slug: 'expired', sourceChannelId: 'C_CURRENT', expiresAt: now - 1 }),
      entry({ entryId: 'z', slug: 'forgotten', sourceChannelId: 'C_CURRENT', status: 'forgotten' }),
    ],
    query: 'project', sourceChannelId: 'C_CURRENT', now,
  });
  assert.deepEqual(selection.entries.map(({ entry: item }) => item.entryId), ['a', 'b']);
  assert.equal(selection.entries[1]?.stale, true);
});

test('selector truncates UTF-8 bodies without splitting a surrogate pair and obeys byte caps', () => {
  const selection = selectMemoryEntries({
    entries: [entry({ entryId: '1', slug: 'emoji', sourceChannelId: 'C', body: '😀'.repeat(1_000) })],
    query: 'emoji', sourceChannelId: 'C', now, maxBytes: 3_000,
  });
  const body = selection.entries[0]?.bodyExcerpt ?? '';
  assert.ok(new TextEncoder().encode(body).byteLength <= 2_048);
  assert.equal(body.endsWith('\uFFFD'), false);
  assert.equal(selection.truncated, true);
});
