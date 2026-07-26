import { createHmac, timingSafeEqual } from 'node:crypto';

import { decodeMemoryArchive } from './archive.ts';
import {
  MEMORY_EXPORT_SCHEMA_VERSION,
  sha256Hex,
  type MemoryExportManifest,
} from './markdown.ts';
import type { MemoryEntry, MemoryEntryType, MemoryStoreDescriptor } from './types.ts';

const IMPORT_PREVIEW_TTL_MS = 10 * 60 * 1_000;
const ENTRY_PATH = /^(?:channel\/([A-Za-z0-9_-]+)|private\/([A-Za-z0-9_-]+)\/generation-([1-9][0-9]*))\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.md$/;
const TYPES = new Set<MemoryEntryType>(['fact', 'decision', 'project', 'feedback', 'preference']);

export interface MemoryImportCandidate {
  action: 'create' | 'update' | 'unchanged' | 'conflict';
  entryId: string | null;
  expectedVersion: number | null;
  sourceChannelId: string;
  slug: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  path: string;
  reason?: string;
}

export interface MemoryImportPreview {
  archiveSha256: string;
  mode: 'manifest' | 'create-only';
  candidates: MemoryImportCandidate[];
  summary: { creates: number; updates: number; unchanged: number; conflicts: number };
  quotaImpact: { entries: number; utf8Bytes: number };
  scopeImpact: { storeId: string; sourceChannelIds: string[] };
}

export interface MemoryImportPreviewClaims {
  sessionFingerprint: string;
  storeId: string;
  archiveSha256: string;
  schemaVersion: number;
  expiresAt: number;
}

export function createImportPreview(input: {
  archive: Uint8Array;
  targetStore: MemoryStoreDescriptor;
  currentEntries: readonly MemoryEntry[];
  allowedSourceChannelIds?: readonly string[];
}): MemoryImportPreview {
  const files = decodeMemoryArchive(input.archive);
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const manifestText = byPath.get('manifest.json');
  const currentById = new Map(input.currentEntries.map((entry) => [entry.entryId, entry]));
  const currentByPartitionSlug = new Map(
    input.currentEntries.map((entry) => [`${entry.sourceChannelId}\0${entry.slug}`, entry]),
  );
  const allowed = input.allowedSourceChannelIds ? new Set(input.allowedSourceChannelIds) : null;
  const candidates: MemoryImportCandidate[] = [];

  if (manifestText) {
    const manifest = parseManifest(manifestText);
    assertManifestScope(manifest, input.targetStore);
    const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));
    if (manifestFiles.size !== manifest.files.length) throw new Error('Manifest contains duplicate paths.');
    for (const file of manifest.files) {
      const content = byPath.get(file.path);
      if (content === undefined) throw new Error(`Manifest file is missing: ${file.path}`);
      if (sha256Hex(content) !== file.sha256) {
        throw new Error(file.generated ? 'Generated MEMORY.md index was edited.' : `Hash mismatch: ${file.path}`);
      }
    }
    for (const file of files) {
      if (file.path !== 'manifest.json' && !manifestFiles.has(file.path)) {
        throw new Error(`Archive file is not declared by the manifest: ${file.path}`);
      }
    }
    for (const item of manifest.entries) {
      const content = byPath.get(item.path);
      if (content === undefined || sha256Hex(content) !== item.sha256) {
        throw new Error(`Memory entry hash mismatch: ${item.path}`);
      }
      const parsed = parseEntryFile(item.path, content, input.targetStore);
      if (parsed.slug !== item.slug || parsed.sourceChannelId !== item.sourceChannelId) {
        throw new Error(`Memory entry scope does not match manifest: ${item.path}`);
      }
      assertAllowedChannel(parsed.sourceChannelId, allowed);
      const current = currentById.get(item.entryId);
      const collision = currentByPartitionSlug.get(`${parsed.sourceChannelId}\0${parsed.slug}`);
      let action: MemoryImportCandidate['action'];
      let reason: string | undefined;
      if (!current) {
        action = collision ? 'conflict' : 'create';
        reason = collision ? 'A different memory already uses this channel and name.' : undefined;
      } else if (current.version !== item.version) {
        action = 'conflict';
        reason = 'The memory version changed after this archive was exported.';
      } else {
        action = sameContent(current, parsed) ? 'unchanged' : 'update';
      }
      candidates.push({
        action,
        entryId: item.entryId,
        expectedVersion: item.version,
        ...parsed,
        path: item.path,
        ...(reason ? { reason } : {}),
      });
    }
  } else {
    for (const file of files) {
      if (file.path.endsWith('/MEMORY.md') || file.path === 'MEMORY.md') {
        throw new Error('Generated MEMORY.md indexes cannot be imported without a manifest.');
      }
      const parsed = parseEntryFile(file.path, file.content, input.targetStore);
      assertAllowedChannel(parsed.sourceChannelId, allowed);
      if (currentByPartitionSlug.has(`${parsed.sourceChannelId}\0${parsed.slug}`)) {
        throw new Error('Human-authored imports are create-only and this memory already exists.');
      }
      candidates.push({
        action: 'create', entryId: null, expectedVersion: null, ...parsed, path: file.path,
      });
    }
  }

  candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const count = (action: MemoryImportCandidate['action']) =>
    candidates.filter((candidate) => candidate.action === action).length;
  return {
    archiveSha256: sha256Hex(input.archive),
    mode: manifestText ? 'manifest' : 'create-only',
    candidates,
    summary: { creates: count('create'), updates: count('update'), unchanged: count('unchanged'), conflicts: count('conflict') },
    quotaImpact: {
      entries: count('create'),
      utf8Bytes: candidates
        .filter((candidate) => candidate.action === 'create' || candidate.action === 'update')
        .reduce((sum, candidate) => sum + new TextEncoder().encode(candidate.description + candidate.body).byteLength, 0),
    },
    scopeImpact: {
      storeId: input.targetStore.storeId,
      sourceChannelIds: [...new Set(candidates.map((candidate) => candidate.sourceChannelId))].sort(),
    },
  };
}

export function signImportPreview(
  claims: Omit<MemoryImportPreviewClaims, 'expiresAt'> & { expiresAt?: number },
  secret: string,
  now = Date.now(),
): string {
  const payload: MemoryImportPreviewClaims = {
    ...claims,
    expiresAt: claims.expiresAt ?? now + IMPORT_PREVIEW_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${previewSignature(encoded, secret)}`;
}

export function verifyImportPreview(
  token: string,
  secret: string,
  expected: Omit<MemoryImportPreviewClaims, 'expiresAt'> & { now?: number },
): MemoryImportPreviewClaims {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new Error('Import preview token is invalid.');
  const actual = Buffer.from(signature, 'base64url');
  const wanted = Buffer.from(previewSignature(encoded, secret), 'base64url');
  if (actual.byteLength !== wanted.byteLength || !timingSafeEqual(actual, wanted)) {
    throw new Error('Import preview token is invalid.');
  }
  let claims: MemoryImportPreviewClaims;
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as MemoryImportPreviewClaims;
  } catch {
    throw new Error('Import preview token is invalid.');
  }
  if (
    claims.sessionFingerprint !== expected.sessionFingerprint ||
    claims.storeId !== expected.storeId ||
    claims.archiveSha256 !== expected.archiveSha256 ||
    claims.schemaVersion !== expected.schemaVersion
  ) {
    throw new Error('Import preview token is bound to a different session, store, or archive.');
  }
  if (!Number.isFinite(claims.expiresAt) || claims.expiresAt < (expected.now ?? Date.now())) {
    throw new Error('Import preview token expired.');
  }
  return claims;
}

function parseManifest(text: string): MemoryExportManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Memory manifest is invalid JSON.'); }
  if (!value || typeof value !== 'object') throw new Error('Memory manifest is invalid.');
  const manifest = value as MemoryExportManifest;
  if (
    manifest.schemaVersion !== MEMORY_EXPORT_SCHEMA_VERSION ||
    !manifest.store || !Array.isArray(manifest.files) || !Array.isArray(manifest.entries)
  ) throw new Error('Memory manifest schema is unsupported.');
  return manifest;
}

function assertManifestScope(manifest: MemoryExportManifest, store: MemoryStoreDescriptor): void {
  if (
    manifest.store.storeId !== store.storeId || manifest.store.workspaceId !== store.workspaceId ||
    manifest.store.visibility !== store.visibility || manifest.store.channelId !== store.channelId ||
    manifest.store.generation !== store.generation
  ) throw new Error('Memory manifest belongs to a different store scope.');
}

function parseEntryFile(path: string, content: string, store: MemoryStoreDescriptor): {
  sourceChannelId: string; slug: string; description: string; type: MemoryEntryType; body: string;
} {
  const match = ENTRY_PATH.exec(path);
  if (!match || path.endsWith('/MEMORY.md')) throw new Error(`Memory file path is invalid: ${path}`);
  const [, publicChannel, privateChannel, generation, pathSlug] = match;
  const sourceChannelId = publicChannel ?? privateChannel!;
  if (store.visibility === 'public') {
    if (!publicChannel) throw new Error('Private memory cannot be imported into a public store.');
  } else if (privateChannel !== store.channelId || Number(generation) !== store.generation) {
    throw new Error('Private memory file belongs to a different channel generation.');
  }
  const normalized = content.replace(/\r\n?/g, '\n');
  const header = /^---\nname: (.+)\ndescription: (.+)\nmetadata:\n  type: (.+)\n  modified: (.+)\n---\n\n([\s\S]*?)\n?$/.exec(normalized);
  if (!header) throw new Error(`Memory file frontmatter is invalid: ${path}`);
  const [, rawName, rawDescription, rawType, rawModified, rawBody] = header;
  const name = parseJsonString(rawName!, 'name');
  const description = parseJsonString(rawDescription!, 'description');
  const type = parseJsonString(rawType!, 'type') as MemoryEntryType;
  const modified = parseJsonString(rawModified!, 'modified');
  if (name !== pathSlug || !TYPES.has(type) || !Number.isFinite(Date.parse(modified))) {
    throw new Error(`Memory file frontmatter does not match its path: ${path}`);
  }
  return { sourceChannelId, slug: name, description, type, body: rawBody!.replace(/\n+$/, '') };
}

function parseJsonString(value: string, field: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return parsed;
  } catch { /* handled below */ }
  throw new Error(`Memory ${field} must be a quoted string.`);
}

function assertAllowedChannel(sourceChannelId: string, allowed: Set<string> | null): void {
  if (allowed && !allowed.has(sourceChannelId)) throw new Error('Memory source channel is foreign or has never been observed.');
}

function sameContent(
  current: MemoryEntry,
  candidate: Pick<MemoryImportCandidate, 'description' | 'type' | 'body'>,
): boolean {
  return current.description === candidate.description && current.type === candidate.type && current.body === candidate.body;
}

function previewSignature(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update('chickpea-memory-import-preview-v1\0').update(encoded).digest('base64url');
}

