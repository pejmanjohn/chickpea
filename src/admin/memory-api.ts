import { createHash, randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import { decodeMemoryArchive, encodeMemoryArchive } from '../memory/archive.ts';
import {
  createImportPreview,
  signImportPreview,
  verifyImportPreview,
} from '../memory/import.ts';
import { projectMemoryEntry, projectMemoryFiles } from '../memory/markdown.ts';
import {
  MemoryStateError,
  MemoryVersionConflictError,
  type MemoryEntry,
  type MemoryStateStore,
  type MemoryStoreDescriptor,
} from '../memory/types.ts';
import { validateMemoryContent } from '../memory/validation.ts';

interface MemoryAdminApiOptions {
  store: (c: Context) => MemoryStateStore;
  adminSecret: () => string;
  now?: () => number;
  id?: () => string;
}

const opaqueId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,200}$/));
const updateSchema = v.object({
  expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  description: v.string(),
  type: v.picklist(['fact', 'decision', 'project', 'feedback', 'preference']),
  body: v.string(),
});
const deleteSchema = v.object({
  expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  acknowledgeIrreversible: v.literal(true),
});
const reviewSchema = v.object({
  expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  resolution: v.picklist(['confirmed', 'corrected', 'expired']),
});
const importPreviewSchema = v.object({ storeId: opaqueId, archiveBase64: v.string() });
const importApplySchema = v.object({
  storeId: opaqueId,
  archiveBase64: v.string(),
  previewToken: v.string(),
});

export function createMemoryAdminApi(options: MemoryAdminApiOptions): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;

  app.get('/audit/memory/scopes', async (c) => {
    try {
      const state = options.store(c);
      const workspaceId = c.req.query('workspaceId');
      const [stores, channelStates, entries] = await Promise.all([
        state.listStores(workspaceId),
        state.listChannelScopes(workspaceId),
        state.listEntries(workspaceId ? { workspaceId } : {}),
      ]);
      return c.json({ scopes: buildScopes(stores, channelStates, entries) });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get('/audit/memory/stores/:storeId/files', async (c) => {
    try {
      const storeId = parseId(c.req.param('storeId'));
      const sourceChannelId = c.req.query('sourceChannelId');
      if (!sourceChannelId || !isOpaqueId(sourceChannelId)) return invalid(c);
      const state = options.store(c);
      const store = await state.getStore(storeId);
      if (!store) return c.json({ error: 'memory_store_not_found' }, 404);
      const entries = await state.listEntries({ storeId, sourceChannelId, limit: 1_000 });
      if (store.visibility === 'private') {
        await Promise.all(entries.map((entry) => recordPrivateView(state, c, entry.entryId, now())));
      }
      const projected = projectMemoryFiles({ store, entries });
      const prefix = projectionPrefix(store, sourceChannelId);
      const files = projected
        .filter((file) => file.path === `${prefix}/MEMORY.md` || file.path.startsWith(`${prefix}/`) && file.path.endsWith('.md'))
        .map((file) => {
          const name = file.path.slice(prefix.length + 1);
          const entry = entries.find((candidate) => `${candidate.slug}.md` === name);
          return {
            name,
            path: file.path,
            generated: name === 'MEMORY.md',
            entryId: entry?.entryId ?? null,
            version: entry?.version ?? null,
            status: entry?.status ?? null,
            description: entry?.description ?? null,
            content: name === 'MEMORY.md' ? file.content : undefined,
          };
        })
        .sort((left, right) => left.generated ? -1 : right.generated ? 1 : compare(left.name, right.name));
      return c.json({ store, sourceChannelId, files });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get('/audit/memory/entries/:entryId', async (c) => {
    try {
      const entryId = parseId(c.req.param('entryId'));
      const state = options.store(c);
      const entry = await state.getEntry(entryId);
      if (!entry) return c.json({ error: 'memory_entry_not_found' }, 404);
      const store = await state.getStore(entry.storeId);
      if (!store) return c.json({ error: 'memory_store_not_found' }, 404);
      // A private body is serialized only after the durable audit succeeds.
      if (store.visibility === 'private') {
        await recordPrivateView(state, c, entryId, now());
      }
      const events = await state.listAuditEvents({ subjectId: entryId, limit: 100 });
      return c.json({
        entry,
        store,
        projected: entry.status === 'forgotten' ? null : projectMemoryEntry(entry),
        unresolvedReview: unresolvedReview(events),
      });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.put('/audit/memory/entries/:entryId', async (c) => {
    if (!safeMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(updateSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const content = validateMemoryContent(parsed.output);
      const entry = await options.store(c).updateEntry({
        entryId: parseId(c.req.param('entryId')),
        expectedVersion: parsed.output.expectedVersion,
        ...content,
        actorId: adminActor(c),
        actorClass: 'operator',
        idempotencyKey: `admin:update:${idempotencyKey}`,
      });
      return c.json({ entry, projected: projectMemoryEntry(entry) });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.delete('/audit/memory/entries/:entryId', async (c) => {
    if (!safeMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(deleteSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const entry = await options.store(c).forgetEntry({
        entryId: parseId(c.req.param('entryId')),
        expectedVersion: parsed.output.expectedVersion,
        actorId: adminActor(c),
        actorClass: 'operator',
        reasonCode: 'admin_delete',
        idempotencyKey: `admin:delete:${idempotencyKey}`,
      });
      return c.json({ entry, irreversible: true });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get('/audit/memory/entries/:entryId/history', async (c) => {
    try {
      const entryId = parseId(c.req.param('entryId'));
      const state = options.store(c);
      const entry = await state.getEntry(entryId);
      if (!entry) return c.json({ error: 'memory_entry_not_found' }, 404);
      const store = await state.getStore(entry.storeId);
      if (!store) return c.json({ error: 'memory_store_not_found' }, 404);
      if (store.visibility === 'private') await recordPrivateView(state, c, entryId, now());
      return c.json({ revisions: await state.listRevisions(entryId) });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.post('/audit/memory/entries/:entryId/reviews/:eventId/resolve', async (c) => {
    if (!safeMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(reviewSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const entryId = parseId(c.req.param('entryId'));
      const eventId = parseId(c.req.param('eventId'));
      const state = options.store(c);
      const request = (await state.listAuditEvents({ subjectId: entryId, eventType: 'memory.review_requested', limit: 100 }))
        .find((event) => event.eventId === eventId);
      if (!request) return c.json({ error: 'memory_review_not_found' }, 404);
      await state.recordReview({
        entryId,
        expectedVersion: parsed.output.expectedVersion,
        action: 'resolved',
        resolution: parsed.output.resolution,
        actorId: adminActor(c),
        actorClass: 'operator',
        idempotencyKey: `admin:review:${idempotencyKey}`,
      });
      return c.json({ ok: true });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get('/audit/memory/export', async (c) => {
    try {
      const storeId = c.req.query('storeId');
      if (!storeId || !isOpaqueId(storeId)) return invalid(c);
      const state = options.store(c);
      const store = await state.getStore(storeId);
      if (!store) return c.json({ error: 'memory_store_not_found' }, 404);
      const entries = await state.listEntries({ storeId, limit: 1_000 });
      const archive = encodeMemoryArchive(projectMemoryFiles({ store, entries }));
      await state.recordAdminEvent({
        eventType: 'memory.exported',
        storeId,
        actorId: adminActor(c),
        idempotencyKey: `admin:export:${adminActor(c)}:${storeId}:${Math.floor(now() / 3_600_000)}`,
      });
      c.header('content-type', 'application/x-tar');
      c.header('content-disposition', `attachment; filename="chickpea-memory-${storeId}.tar"`);
      c.header('cache-control', 'no-store');
      c.header('x-content-type-options', 'nosniff');
      const body = archive.buffer.slice(
        archive.byteOffset,
        archive.byteOffset + archive.byteLength,
      ) as ArrayBuffer;
      return c.body(body);
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.post('/audit/memory/import/preview', async (c) => {
    if (!safeMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const parsed = v.safeParse(importPreviewSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const archive = decodeBase64(parsed.output.archiveBase64);
      const state = options.store(c);
      const store = await state.getStore(parsed.output.storeId);
      if (!store) return c.json({ error: 'memory_store_not_found' }, 404);
      const [currentEntries, scopes] = await Promise.all([
        state.listEntries({ storeId: store.storeId, limit: 1_000 }),
        state.listChannelScopes(store.workspaceId),
      ]);
      const allowed = new Set(scopes.map((scope) => scope.channelId));
      for (const entry of currentEntries) allowed.add(entry.sourceChannelId);
      const preview = createImportPreview({
        archive,
        targetStore: store,
        currentEntries,
        allowedSourceChannelIds: [...allowed],
      });
      const previewToken = signImportPreview({
        sessionFingerprint: sessionFingerprint(c),
        storeId: store.storeId,
        archiveSha256: preview.archiveSha256,
        schemaVersion: 1,
      }, options.adminSecret(), now());
      return c.json({ preview, previewToken });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.post('/audit/memory/import/apply', async (c) => {
    if (!safeMutationRequest(c)) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(importApplySchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const archive = decodeBase64(parsed.output.archiveBase64);
      const state = options.store(c);
      const store = await state.getStore(parsed.output.storeId);
      if (!store) return c.json({ error: 'memory_store_not_found' }, 404);
      const [currentEntries, scopes] = await Promise.all([
        state.listEntries({ storeId: store.storeId, limit: 1_000 }),
        state.listChannelScopes(store.workspaceId),
      ]);
      const allowed = new Set(scopes.map((scope) => scope.channelId));
      for (const entry of currentEntries) allowed.add(entry.sourceChannelId);
      const preview = createImportPreview({
        archive, targetStore: store, currentEntries, allowedSourceChannelIds: [...allowed],
      });
      verifyImportPreview(parsed.output.previewToken, options.adminSecret(), {
        sessionFingerprint: sessionFingerprint(c),
        storeId: store.storeId,
        archiveSha256: preview.archiveSha256,
        schemaVersion: 1,
        now: now(),
      });
      if (preview.summary.conflicts > 0) {
        return c.json({ error: 'memory_import_conflict', preview }, 409);
      }
      for (const candidate of preview.candidates) {
        if (candidate.action === 'create' || candidate.action === 'update') validateMemoryContent(candidate);
      }
      const entries = await state.applyImport({
        storeId: store.storeId,
        workspaceId: store.workspaceId,
        actorId: adminActor(c),
        idempotencyKey: `admin:import:${idempotencyKey}`,
        operations: preview.candidates.flatMap((candidate) => {
          if (candidate.action !== 'create' && candidate.action !== 'update') return [];
          return [{
            action: candidate.action,
            entryId: candidate.entryId ?? `mem_${id()}`,
            ...(candidate.expectedVersion === null ? {} : { expectedVersion: candidate.expectedVersion }),
            sourceChannelId: candidate.sourceChannelId,
            slug: candidate.slug,
            description: candidate.description,
            type: candidate.type,
            body: candidate.body,
          }];
        }),
      });
      return c.json({ entries });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get('/audit/:domain/events', async (c) => {
    if (c.req.param('domain') !== 'memory') {
      return c.json({ error: 'domain_not_available' }, 404);
    }
    try {
      const state = options.store(c);
      const limitRaw = c.req.query('limit');
      const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Number(limitRaw), 500) : 100;
      const events = await state.listAuditEvents({
        domain: 'memory',
        ...(c.req.query('storeId') ? { storeId: c.req.query('storeId')! } : {}),
        ...(c.req.query('channelId') ? { channelId: c.req.query('channelId')! } : {}),
        limit,
      });
      return c.json({ events });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  return app;
}

function buildScopes(
  stores: readonly MemoryStoreDescriptor[],
  channelStates: Awaited<ReturnType<MemoryStateStore['listChannelScopes']>>,
  entries: readonly MemoryEntry[],
): Array<Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.status === 'forgotten') continue;
    const key = `${entry.storeId}\0${entry.sourceChannelId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const stateByChannel = new Map(channelStates.map((state) => [`${state.workspaceId}\0${state.channelId}`, state]));
  for (const state of channelStates) {
    const publicStore = stores.find((store) => store.workspaceId === state.workspaceId && store.visibility === 'public');
    if (publicStore && (state.privacy === 'public' || counts.has(`${publicStore.storeId}\0${state.channelId}`))) {
      addScope(result, publicStore, state.channelId, state.currentDisplayName, state.lifecycle, counts);
    }
  }
  for (const store of stores) {
    if (store.visibility !== 'private' || !store.channelId) continue;
    const state = stateByChannel.get(`${store.workspaceId}\0${store.channelId}`);
    addScope(result, store, store.channelId, state?.currentDisplayName ?? store.channelId, state?.lifecycle ?? 'retained', counts);
  }
  for (const entry of entries) {
    const store = stores.find((candidate) => candidate.storeId === entry.storeId);
    if (!store) continue;
    const key = `${entry.storeId}\0${entry.sourceChannelId}`;
    if (!result.has(key)) {
      const state = stateByChannel.get(`${entry.workspaceId}\0${entry.sourceChannelId}`);
      addScope(result, store, entry.sourceChannelId, state?.currentDisplayName ?? entry.sourceChannelId, state?.lifecycle ?? 'retained', counts);
    }
  }
  return [...result.values()].sort((left, right) =>
    compare(String(left.workspaceId), String(right.workspaceId)) ||
    compare(String(left.channelId), String(right.channelId)) ||
    compare(String(left.privacy), String(right.privacy)) ||
    Number(left.generation ?? 0) - Number(right.generation ?? 0),
  );
}

function addScope(
  target: Map<string, Record<string, unknown>>,
  store: MemoryStoreDescriptor,
  channelId: string,
  displayName: string,
  lifecycle: string,
  counts: Map<string, number>,
): void {
  target.set(`${store.storeId}\0${channelId}`, {
    workspaceId: store.workspaceId,
    channelId,
    displayName,
    privacy: store.visibility,
    lifecycle: store.lifecycle === 'active' ? lifecycle : store.lifecycle,
    storeId: store.storeId,
    generation: store.generation,
    entryCount: counts.get(`${store.storeId}\0${channelId}`) ?? 0,
  });
}

function unresolvedReview(events: Awaited<ReturnType<MemoryStateStore['listAuditEvents']>>): object | null {
  const requested = events.find((event) => event.eventType === 'memory.review_requested');
  const resolved = events.find((event) => event.eventType === 'memory.review_resolved');
  if (!requested || resolved && resolved.createdAt >= requested.createdAt) return null;
  return { eventId: requested.eventId, reasonCode: requested.reasonCode, createdAt: requested.createdAt };
}

function projectionPrefix(store: MemoryStoreDescriptor, channelId: string): string {
  return store.visibility === 'public'
    ? `channel/${channelId}`
    : `private/${store.channelId}/generation-${store.generation}`;
}

function parseId(value: string): string {
  if (!isOpaqueId(value)) throw new MemoryStateError('memory_invalid_id', 'Memory identifier is invalid.');
  return value;
}

function isOpaqueId(value: string): boolean {
  return v.safeParse(opaqueId, value).success;
}

function readIdempotencyKey(c: Context): string | undefined {
  const key = c.req.header('idempotency-key')?.trim();
  return key && key.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key) ? key : undefined;
}

function safeMutationRequest(c: Context): boolean {
  if (c.req.header('authorization')) return true;
  const origin = c.req.header('origin');
  return Boolean(origin && origin === new URL(c.req.url).origin);
}

function sessionFingerprint(c: Context): string {
  const credential = c.req.header('authorization') ?? c.req.header('cookie') ?? '';
  return createHash('sha256').update(`admin-session\0${credential}`).digest('hex');
}

function adminActor(c: Context): string {
  return `admin_${sessionFingerprint(c).slice(0, 20)}`;
}

async function recordPrivateView(
  state: MemoryStateStore,
  c: Context,
  entryId: string,
  at: number,
): Promise<void> {
  await state.recordAdminView({
    entryId,
    actorId: adminActor(c),
    idempotencyKey: `admin-private-view:${adminActor(c)}:${entryId}:${Math.floor(at / 3_600_000)}`,
  });
}

async function readJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { return undefined; }
}

function decodeBase64(raw: string): Uint8Array {
  if (!raw || raw.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw new MemoryStateError('memory_archive_invalid', 'Memory archive encoding is invalid.');
  }
  const bytes = Buffer.from(raw, 'base64');
  // Parsing performs the authoritative uncompressed-size and entry-count checks.
  decodeMemoryArchive(bytes);
  return bytes;
}

function invalid(c: Context): Response {
  return c.json({ error: 'invalid_request' }, 400);
}

function memoryError(c: Context, error: unknown): Response {
  if (error instanceof MemoryVersionConflictError) {
    return c.json({ error: error.code, currentVersion: error.currentVersion }, 409);
  }
  if (error instanceof MemoryStateError) {
    const status = error.code.includes('not_found') ? 404
      : error.code.includes('conflict') || error.code.includes('sealed') ? 409
        : error.code.includes('quota') || error.code.includes('too_large') ? 413 : 400;
    return c.json({ error: error.code }, status as 400 | 404 | 409 | 413);
  }
  if (error instanceof Error && /conflict|bound|expired|hash|manifest|archive|import|index|path|frontmatter|scope|store/i.test(error.message)) {
    return c.json({ error: 'memory_import_invalid', message: error.message }, 400);
  }
  console.error('[chickpea] memory admin API failure:', error instanceof Error ? error.message : String(error));
  return c.json({ error: 'internal_error' }, 500);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
