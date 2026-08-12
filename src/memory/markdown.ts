import { createHash } from 'node:crypto';

import type {
  MemoryEntry, MemoryOwnerDescriptor, MemoryStoreDescriptor, OwnerMemoryEntry,
} from './types.ts';

export const MEMORY_EXPORT_SCHEMA_VERSION = 1;

export interface MemoryProjectionFile {
  path: string;
  content: string;
}

export interface MemoryExportManifestEntry {
  entryId: string;
  version: number;
  path: string;
  sha256: string;
  sourceChannelId: string;
  slug: string;
  status: MemoryEntry['status'];
  provenance: {
    creatorActorId: string | null;
    lastEditorActorId: string | null;
    sourceEventId: string | null;
    sourceThreadTs: string | null;
    sourceMessageTs: string | null;
  };
}

export interface MemoryExportManifest {
  schemaVersion: number;
  store: Pick<
    MemoryStoreDescriptor,
    'storeId' | 'workspaceId' | 'visibility' | 'channelId' | 'generation' | 'lifecycle'
  >;
  files: Array<{ path: string; sha256: string; generated: boolean }>;
  entries: MemoryExportManifestEntry[];
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function projectMemoryEntry(entry: MemoryEntry): string {
  return projectEntryBody(entry);
}

export function projectOwnerMemoryEntry(entry: OwnerMemoryEntry): string {
  return projectEntryBody(entry);
}

function projectEntryBody(entry: Pick<MemoryEntry, 'slug' | 'description' | 'type' | 'body' | 'modifiedAt'>): string {
  const body = normalizeLf(entry.body).replace(/^\n+/, '').replace(/\n*$/, '');
  return [
    '---',
    `name: ${JSON.stringify(entry.slug)}`,
    `description: ${JSON.stringify(entry.description)}`,
    'metadata:',
    `  type: ${JSON.stringify(entry.type)}`,
    `  modified: ${JSON.stringify(new Date(entry.modifiedAt).toISOString())}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export interface OwnerMemoryExportManifest {
  schemaVersion: 2;
  owner: Pick<MemoryOwnerDescriptor,
    'storeId' | 'workspaceId' | 'ownerKind' | 'ownerId' | 'lifecycle' | 'resetEpoch'>;
  files: Array<{ path: string; sha256: string; generated: boolean }>;
  entries: Array<Omit<MemoryExportManifestEntry, 'sourceChannelId'>>;
}

export function projectOwnerMemoryFiles(input: {
  owner: MemoryOwnerDescriptor;
  entries: readonly OwnerMemoryEntry[];
}): MemoryProjectionFile[] {
  const entries = input.entries.filter((entry) =>
    entry.storeId === input.owner.storeId && entry.status !== 'forgotten')
    .sort((left, right) => compareStable(left.slug, right.slug) || compareStable(left.entryId, right.entryId));
  for (const entry of entries) {
    if (entry.ownerKind !== input.owner.ownerKind || entry.ownerId !== input.owner.ownerId ||
        entry.workspaceId !== input.owner.workspaceId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(entry.slug)) {
      throw new Error('Memory projection crossed or contained an unsafe owner scope.');
    }
  }
  const files: MemoryProjectionFile[] = [{
    path: 'MEMORY.md',
    content: renderOwnerIndex(input.owner, entries),
  }];
  const manifestEntries: OwnerMemoryExportManifest['entries'] = [];
  for (const entry of entries) {
    const path = `${entry.slug}.md`;
    const content = projectOwnerMemoryEntry(entry);
    files.push({ path, content });
    manifestEntries.push({
      entryId: entry.entryId, version: entry.version, path, sha256: sha256Hex(content),
      slug: entry.slug, status: entry.status,
      provenance: {
        creatorActorId: entry.creatorActorId, lastEditorActorId: entry.lastEditorActorId,
        sourceEventId: entry.sourceEventId, sourceThreadTs: entry.sourceThreadTs,
        sourceMessageTs: entry.sourceMessageTs,
      },
    });
  }
  files.sort((left, right) => compareStable(left.path, right.path));
  const manifest: OwnerMemoryExportManifest = {
    schemaVersion: 2,
    owner: {
      storeId: input.owner.storeId, workspaceId: input.owner.workspaceId,
      ownerKind: input.owner.ownerKind, ownerId: input.owner.ownerId,
      lifecycle: input.owner.lifecycle, resetEpoch: input.owner.resetEpoch,
    },
    files: files.map((file) => ({
      path: file.path, sha256: sha256Hex(file.content), generated: file.path === 'MEMORY.md',
    })),
    entries: manifestEntries,
  };
  files.push({ path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  return files;
}

function renderOwnerIndex(owner: MemoryOwnerDescriptor, entries: readonly OwnerMemoryEntry[]): string {
  const heading = owner.ownerKind === 'agent' ? '# Agent Memory' : '# Channel Memory';
  const links = entries.map((entry) =>
    `- [${entry.slug}](${entry.slug}.md) — ${singleLine(entry.description)}`);
  return `${heading}\n${links.length > 0 ? `\n${links.join('\n')}\n` : '\n'}`;
}

export function projectMemoryFiles(input: {
  store: MemoryStoreDescriptor;
  entries: readonly MemoryEntry[];
}): MemoryProjectionFile[] {
  const entries = [...input.entries]
    .filter((entry) => entry.storeId === input.store.storeId && entry.status !== 'forgotten')
    .sort(compareEntries);
  for (const entry of entries) assertProjectionIdentity(input.store, entry);

  const files: MemoryProjectionFile[] = [];
  const grouped = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.sourceChannelId) ?? [];
    current.push(entry);
    grouped.set(entry.sourceChannelId, current);
  }

  const partitions = [...grouped.entries()].sort(([left], [right]) => compareStable(left, right));
  files.push({ path: 'MEMORY.md', content: renderRootIndex(input.store, partitions) });
  const manifestEntries: MemoryExportManifestEntry[] = [];
  for (const [channelId, channelEntries] of partitions) {
    const prefix = partitionPrefix(input.store, channelId);
    files.push({ path: `${prefix}/MEMORY.md`, content: renderChannelIndex(channelEntries) });
    for (const entry of channelEntries) {
      const path = `${prefix}/${entry.slug}.md`;
      const content = projectMemoryEntry(entry);
      files.push({ path, content });
      manifestEntries.push({
        entryId: entry.entryId,
        version: entry.version,
        path,
        sha256: sha256Hex(content),
        sourceChannelId: entry.sourceChannelId,
        slug: entry.slug,
        status: entry.status,
        provenance: {
          creatorActorId: entry.creatorActorId,
          lastEditorActorId: entry.lastEditorActorId,
          sourceEventId: entry.sourceEventId,
          sourceThreadTs: entry.sourceThreadTs,
          sourceMessageTs: entry.sourceMessageTs,
        },
      });
    }
  }

  files.sort((left, right) => compareStable(left.path, right.path));
  const manifest: MemoryExportManifest = {
    schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
    store: {
      storeId: input.store.storeId,
      workspaceId: input.store.workspaceId,
      visibility: input.store.visibility,
      channelId: input.store.channelId,
      generation: input.store.generation,
      lifecycle: input.store.lifecycle,
    },
    files: files.map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.content),
      generated: file.path === 'MEMORY.md' || file.path.endsWith('/MEMORY.md'),
    })),
    entries: manifestEntries,
  };
  files.push({ path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  return files;
}

function renderRootIndex(
  store: MemoryStoreDescriptor,
  partitions: Array<[string, MemoryEntry[]]>,
): string {
  const heading = store.visibility === 'public' ? '# Workspace Memory Index' : '# Private Memory Index';
  const links = partitions.map(([channelId]) => {
    const prefix = partitionPrefix(store, channelId);
    return `- [${channelId}](${prefix}/MEMORY.md)`;
  });
  return `${heading}\n${links.length > 0 ? `\n${links.join('\n')}\n` : '\n'}`;
}

function renderChannelIndex(entries: readonly MemoryEntry[]): string {
  const links = [...entries]
    .sort(compareEntries)
    .map((entry) => `- [${entry.slug}](${entry.slug}.md) — ${singleLine(entry.description)}`);
  return `# Channel Memory Index\n${links.length > 0 ? `\n${links.join('\n')}\n` : '\n'}`;
}

function partitionPrefix(store: MemoryStoreDescriptor, sourceChannelId: string): string {
  if (store.visibility === 'public') return `channel/${sourceChannelId}`;
  return `private/${store.channelId}/generation-${store.generation}`;
}

function assertProjectionIdentity(store: MemoryStoreDescriptor, entry: MemoryEntry): void {
  const safe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
  if (!safe.test(entry.sourceChannelId) || !safe.test(entry.slug)) {
    throw new Error('Memory projection contains an unsafe channel ID or slug.');
  }
  if (store.visibility === 'private' && entry.sourceChannelId !== store.channelId) {
    throw new Error('Private memory projection cannot cross channel scope.');
  }
}

function compareEntries(left: MemoryEntry, right: MemoryEntry): number {
  return compareStable(left.sourceChannelId, right.sourceChannelId) ||
    compareStable(left.slug, right.slug) || compareStable(left.entryId, right.entryId);
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeLf(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function singleLine(value: string): string {
  return normalizeLf(value).replace(/\s+/g, ' ').trim();
}
