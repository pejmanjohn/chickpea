import { createHash, randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import * as v from 'valibot';

import type { AuditEvent } from '../audit/types.ts';
import {
  adminActor,
  invalidRequest as invalid,
  readIdempotencyKey,
  readJson,
  safeMutationRequest,
  sessionFingerprint,
} from './api-support.ts';
import { decodeMemoryArchive, encodeMemoryArchive } from '../memory/archive.ts';
import {
  createImportPreview,
  signImportPreview,
  verifyImportPreview,
} from '../memory/import.ts';
import {
  projectMemoryEntry, projectMemoryFiles, projectOwnerMemoryEntry,
  projectOwnerMemoryFiles, sha256Hex,
} from '../memory/markdown.ts';
import { ownerMemoryStoreId } from '../memory/ids.ts';
import {
  MemoryStateError,
  MemoryVersionConflictError,
  type MemoryEntry,
  type MemoryEntryFilter,
  type MemoryEntryScopeSummary,
  type MemoryOwnerDescriptor,
  type MemoryOwnerKind,
  type MemoryOwnerRef,
  type MemoryRevision,
  type MemoryStateStore,
  type MemoryStoreDescriptor,
  type OwnerMemoryEntry,
} from '../memory/types.ts';
import { validateMemoryContent } from '../memory/validation.ts';

interface MemoryAdminApiOptions {
  store: (c: Context) => MemoryStateStore;
  adminSecret: () => string;
  now?: () => number;
  id?: () => string;
}

const opaqueId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,200}$/));
const createOwnerEntrySchema = v.strictObject({
  slug: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)),
  description: v.string(),
  type: v.picklist(['fact', 'decision', 'project', 'feedback', 'preference']),
  body: v.string(),
});
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

class MemoryImportValidationError extends Error {
  override readonly name = 'MemoryImportValidationError';
}

export function createMemoryAdminApi(options: MemoryAdminApiOptions): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;

  app.get('/audit/memory/owners', async (c) => {
    try {
      return c.json({ owners: await options.store(c).listOwners(c.req.query('workspaceId')) });
    } catch (error) { return memoryError(c, error); }
  });

  app.get('/audit/memory/owners/:ownerKind/:workspaceId/:ownerId/files', async (c) => {
    try {
      const owner = await routeOwner(c, options.store(c));
      const entries = await options.store(c).listOwnerEntries(owner);
      const projected = projectOwnerMemoryFiles({ owner, entries });
      const bySlug = new Map(entries.map((entry) => [`${entry.slug}.md`, entry]));
      return c.json({ owner, files: projected.filter(({ path }) => path.endsWith('.md')).map((file) => {
        const entry = bySlug.get(file.path);
        return {
          name: file.path, path: file.path, generated: file.path === 'MEMORY.md',
          entryId: entry?.entryId ?? null, version: entry?.version ?? null,
          status: entry?.status ?? null, description: entry?.description ?? null,
          content: file.path === 'MEMORY.md' ? file.content : undefined,
        };
      }) });
    } catch (error) { return memoryError(c, error); }
  });

  app.post('/audit/memory/owners/:ownerKind/:workspaceId/:ownerId/entries', async (c) => {
    if (!safeMutationRequest(c, { principalAware: false })) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(createOwnerEntrySchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const state = options.store(c);
      const owner = await routeOwner(c, state);
      const content = validateMemoryContent(parsed.output);
      const actorId = adminActor(c);
      const ownerScope = createHash('sha256').update(owner.storeId).digest('hex').slice(0, 24);
      const namespacedKey = `admin:owner:create:${ownerScope}:${idempotencyKey}`;
      const entryId = `mem_${createHash('sha256').update(namespacedKey).digest('hex').slice(0, 32)}`;
      const entry = await state.createOwnerEntry({
        entryId,
        storeId: owner.storeId,
        workspaceId: owner.workspaceId,
        slug: parsed.output.slug,
        slugSeed: parsed.output.slug,
        ...content,
        actorId,
        actorClass: 'operator',
        writeOrigin: { kind: 'admin' },
        idempotencyKey: namespacedKey,
      });
      assertOwnerCreateReceipt(
        await state.listOwnerRevisions(entry.entryId),
        namespacedKey,
        entry.entryId,
        actorId,
        parsed.output.slug,
        content,
      );
      if (
        entry.storeId !== owner.storeId ||
        entry.workspaceId !== owner.workspaceId ||
        entry.ownerKind !== owner.ownerKind ||
        entry.ownerId !== owner.ownerId
      ) {
        throw new MemoryStateError(
          'memory_idempotency_mismatch',
          'The idempotency key belongs to a different memory owner.',
        );
      }
      return c.json({ owner, entry, projected: projectOwnerMemoryEntry(entry) }, 201);
    } catch (error) { return memoryError(c, error); }
  });

  app.get('/audit/memory/owners/:ownerKind/:workspaceId/:ownerId/entries/:entryId', async (c) => {
    try {
      const state = options.store(c);
      const owner = await routeOwner(c, state);
      const entry = await routeOwnerEntry(c, state, owner);
      const events = await state.listAuditEvents({ subjectId: entry.entryId, limit: 100 });
      return c.json({ entry, owner, projected: entry.status === 'forgotten' ? null : projectOwnerMemoryEntry(entry),
        unresolvedReview: unresolvedReview(events) });
    } catch (error) { return memoryError(c, error); }
  });

  app.put('/audit/memory/owners/:ownerKind/:workspaceId/:ownerId/entries/:entryId', async (c) => {
    if (!safeMutationRequest(c, { principalAware: false })) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(updateSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const state = options.store(c);
      const owner = await routeOwner(c, state);
      const current = await routeOwnerEntry(c, state, owner);
      const content = validateMemoryContent(parsed.output);
      const entry = await state.updateOwnerEntry({
        entryId: current.entryId, expectedVersion: parsed.output.expectedVersion, ...content,
        actorId: adminActor(c), actorClass: 'operator', idempotencyKey: `admin:owner:update:${idempotencyKey}`,
      });
      return c.json({ entry, projected: projectOwnerMemoryEntry(entry) });
    } catch (error) { return memoryError(c, error); }
  });

  app.delete('/audit/memory/owners/:ownerKind/:workspaceId/:ownerId/entries/:entryId', async (c) => {
    if (!safeMutationRequest(c, { principalAware: false })) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(deleteSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const state = options.store(c);
      const owner = await routeOwner(c, state);
      const current = await routeOwnerEntry(c, state, owner);
      const entry = await state.forgetOwnerEntry({
        entryId: current.entryId, expectedVersion: parsed.output.expectedVersion,
        actorId: adminActor(c), actorClass: 'operator', reasonCode: 'admin_delete',
        idempotencyKey: `admin:owner:delete:${idempotencyKey}`,
      });
      return c.json({ entry, irreversible: true });
    } catch (error) { return memoryError(c, error); }
  });

  app.get('/audit/memory/owners/:ownerKind/:workspaceId/:ownerId/entries/:entryId/history', async (c) => {
    try {
      const state = options.store(c);
      const owner = await routeOwner(c, state);
      const entry = await routeOwnerEntry(c, state, owner);
      return c.json({ revisions: await state.listOwnerRevisions(entry.entryId) });
    } catch (error) { return memoryError(c, error); }
  });

  app.get('/audit/memory/owners/:ownerKind/:workspaceId/:ownerId/export', async (c) => {
    try {
      const state = options.store(c);
      const owner = await routeOwner(c, state);
      const archive = encodeMemoryArchive(projectOwnerMemoryFiles({
        owner, entries: await state.listOwnerEntries(owner),
      }));
      await state.recordAdminEvent({
        eventType: 'memory.exported', storeId: owner.storeId, actorId: adminActor(c),
        idempotencyKey: `admin:owner:export:${adminActor(c)}:${owner.storeId}:${Math.floor(now() / 3_600_000)}`,
      });
      c.header('content-type', 'application/x-tar');
      c.header('content-disposition', `attachment; filename="chickpea-${owner.ownerKind}-memory-${owner.ownerId}.tar"`);
      c.header('cache-control', 'no-store'); c.header('x-content-type-options', 'nosniff');
      return c.body(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer);
    } catch (error) { return memoryError(c, error); }
  });

  app.get('/audit/memory/scopes', async (c) => {
    try {
      const state = options.store(c);
      const workspaceId = c.req.query('workspaceId');
      const [stores, channelStates, summaries] = await Promise.all([
        state.listStores(workspaceId),
        state.listChannelScopes(workspaceId),
        state.listEntryScopeSummaries(workspaceId),
      ]);
      return c.json({ scopes: buildScopes(stores, channelStates, summaries) });
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
      const entries = await listAllEntries(state, { storeId, sourceChannelId });
      const projected = projectMemoryFiles({ store, entries });
      const prefix = projectionPrefix(store, sourceChannelId);
      const entriesByFilename = new Map(entries.map((entry) => [`${entry.slug}.md`, entry]));
      const channelIndex = projected.find((file) => file.path === `${prefix}/MEMORY.md`) ?? {
        path: `${prefix}/MEMORY.md`,
        content: '# Channel Memory Index\n\n',
      };
      const files = [channelIndex, ...projected.filter((file) => file.path !== channelIndex.path)]
        .filter((file) => file.path === `${prefix}/MEMORY.md` || file.path.startsWith(`${prefix}/`) && file.path.endsWith('.md'))
        .map((file) => {
          const name = file.path.slice(prefix.length + 1);
          const entry = entriesByFilename.get(name);
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
    if (!safeMutationRequest(c, { principalAware: false })) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(updateSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const content = validateMemoryContent(parsed.output);
      const entryId = parseId(c.req.param('entryId'));
      const actorId = adminActor(c);
      const state = options.store(c);
      const namespacedKey = `admin:update:${idempotencyKey}`;
      const entry = await state.updateEntry({
        entryId,
        expectedVersion: parsed.output.expectedVersion,
        ...content,
        actorId,
        actorClass: 'operator',
        idempotencyKey: namespacedKey,
      });
      assertUpdateReceipt(
        await state.listRevisions(entryId),
        namespacedKey,
        entryId,
        parsed.output.expectedVersion,
        actorId,
        content,
      );
      return c.json({ entry, projected: projectMemoryEntry(entry) });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.delete('/audit/memory/entries/:entryId', async (c) => {
    if (!safeMutationRequest(c, { principalAware: false })) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(deleteSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const entryId = parseId(c.req.param('entryId'));
      const actorId = adminActor(c);
      const state = options.store(c);
      const namespacedKey = `admin:delete:${idempotencyKey}`;
      const entry = await state.forgetEntry({
        entryId,
        expectedVersion: parsed.output.expectedVersion,
        actorId,
        actorClass: 'operator',
        reasonCode: 'admin_delete',
        idempotencyKey: namespacedKey,
      });
      assertDeleteReceipt(
        await state.listRevisions(entryId),
        namespacedKey,
        entryId,
        parsed.output.expectedVersion,
        actorId,
      );
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
    if (!safeMutationRequest(c, { principalAware: false })) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(reviewSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const entryId = parseId(c.req.param('entryId'));
      const eventId = parseId(c.req.param('eventId'));
      const state = options.store(c);
      const actorId = adminActor(c);
      const namespacedKey = `admin:review:${idempotencyKey}`;
      const receipt = (await state.listAuditEvents({ idempotencyKey: namespacedKey, limit: 1 }))[0];
      if (receipt) {
        assertReviewReceipt(receipt, entryId, eventId, parsed.output.expectedVersion, actorId, parsed.output.resolution);
        return c.json({ ok: true });
      }
      const events = await state.listAuditEvents({ subjectId: entryId, limit: 100 });
      const current = unresolvedReview(events);
      const requested = events.some((event) =>
        event.eventType === 'memory.review_requested' && event.eventId === eventId
      );
      if (!requested) return c.json({ error: 'memory_review_not_found' }, 404);
      if (!current || current.eventId !== eventId) {
        return c.json({ error: 'memory_review_not_current' }, 409);
      }
      await state.recordReview({
        entryId,
        expectedVersion: parsed.output.expectedVersion,
        action: 'resolved',
        resolution: parsed.output.resolution,
        reviewRequestEventId: eventId,
        actorId,
        actorClass: 'operator',
        idempotencyKey: namespacedKey,
      });
      const resolved = (await state.listAuditEvents({ idempotencyKey: namespacedKey, limit: 1 }))[0];
      if (!resolved) {
        throw new MemoryStateError('memory_idempotency_incomplete', 'Memory review receipt is unavailable.');
      }
      assertReviewReceipt(resolved, entryId, eventId, parsed.output.expectedVersion, actorId, parsed.output.resolution);
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
      const entries = await listAllEntries(state, { storeId }, 1_000);
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
    if (!safeMutationRequest(c, { principalAware: false })) return c.json({ error: 'cross_origin_denied' }, 403);
    const parsed = v.safeParse(importPreviewSchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const archive = decodeImportArchive(parsed.output.archiveBase64);
      const state = options.store(c);
      const store = await state.getStore(parsed.output.storeId);
      if (!store) return c.json({ error: 'memory_store_not_found' }, 404);
      const [currentEntries, scopes] = await Promise.all([
        listAllEntries(state, { storeId: store.storeId }, 1_000),
        state.listChannelScopes(store.workspaceId),
      ]);
      const allowed = new Set(scopes.map((scope) => scope.channelId));
      for (const entry of currentEntries) allowed.add(entry.sourceChannelId);
      const preview = createValidatedImportPreview({
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
      return memoryImportError(c, error);
    }
  });

  app.post('/audit/memory/import/apply', async (c) => {
    if (!safeMutationRequest(c, { principalAware: false })) return c.json({ error: 'cross_origin_denied' }, 403);
    const idempotencyKey = readIdempotencyKey(c);
    if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);
    const parsed = v.safeParse(importApplySchema, await readJson(c));
    if (!parsed.success) return invalid(c);
    try {
      const archive = decodeImportArchive(parsed.output.archiveBase64);
      const state = options.store(c);
      const store = await state.getStore(parsed.output.storeId);
      if (!store) return c.json({ error: 'memory_store_not_found' }, 404);
      const actorId = adminActor(c);
      const namespacedKey = `admin:import:${idempotencyKey}`;
      const archiveSha256 = sha256Hex(archive);
      verifyValidatedImportPreview(parsed.output.previewToken, options.adminSecret(), {
        sessionFingerprint: sessionFingerprint(c),
        storeId: store.storeId,
        archiveSha256,
        schemaVersion: 1,
        now: now(),
      });
      const replay = await state.replayImport({
        storeId: store.storeId,
        workspaceId: store.workspaceId,
        actorId,
        archiveSha256,
        idempotencyKey: namespacedKey,
      });
      if (replay) return c.json({ entries: replay });
      const [currentEntries, scopes] = await Promise.all([
        listAllEntries(state, { storeId: store.storeId }, 1_000),
        state.listChannelScopes(store.workspaceId),
      ]);
      const allowed = new Set(scopes.map((scope) => scope.channelId));
      for (const entry of currentEntries) allowed.add(entry.sourceChannelId);
      const preview = createValidatedImportPreview({
        archive, targetStore: store, currentEntries, allowedSourceChannelIds: [...allowed],
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
        actorId,
        archiveSha256: preview.archiveSha256,
        idempotencyKey: namespacedKey,
        operations: preview.candidates.flatMap((candidate) => {
          if (candidate.action !== 'create' && candidate.action !== 'update') return [];
          return [{
            action: candidate.action,
            entryId: candidate.entryId ?? `mem_${id()}`,
            ...(candidate.action === 'update' && candidate.expectedVersion !== null
              ? { expectedVersion: candidate.expectedVersion }
              : {}),
            sourceChannelId: candidate.sourceChannelId,
            slug: candidate.slug,
            description: candidate.description,
            type: candidate.type,
            body: candidate.body,
            status: candidate.status,
          }];
        }),
      });
      return c.json({ entries });
    } catch (error) {
      return memoryImportError(c, error);
    }
  });

  app.get('/audit/memory/events', async (c) => {
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

async function listAllEntries(
  state: MemoryStateStore,
  filter: Omit<MemoryEntryFilter, 'limit' | 'offset'>,
  maximum = Number.POSITIVE_INFINITY,
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  const pageSize = 250;
  for (let offset = 0; ; offset += pageSize) {
    const page = await state.listEntries({ ...filter, limit: pageSize, offset });
    entries.push(...page);
    if (entries.length > maximum) {
      throw new MemoryStateError(
        'memory_export_too_large',
        'Memory store exceeds portable export limits.',
      );
    }
    if (page.length < pageSize) return entries;
  }
}

async function routeOwner(c: Context, state: MemoryStateStore): Promise<MemoryOwnerDescriptor> {
  const ownerKind = c.req.param('ownerKind');
  if (ownerKind !== 'agent' && ownerKind !== 'channel') {
    throw new MemoryStateError('memory_owner_invalid', 'Memory owner is invalid.');
  }
  const ownerRef: MemoryOwnerRef = {
    ownerKind: ownerKind as MemoryOwnerKind,
    workspaceId: parseId(requiredRouteParam(c, 'workspaceId')),
    ownerId: parseId(requiredRouteParam(c, 'ownerId')),
  };
  const owner = await state.getOwner(ownerMemoryStoreId(ownerRef));
  if (!owner || owner.workspaceId !== ownerRef.workspaceId || owner.ownerKind !== ownerRef.ownerKind ||
      owner.ownerId !== ownerRef.ownerId) {
    throw new MemoryStateError('memory_owner_not_found', 'Memory owner was not found.');
  }
  return owner;
}

async function routeOwnerEntry(
  c: Context, state: MemoryStateStore, owner: MemoryOwnerDescriptor,
): Promise<OwnerMemoryEntry> {
  const entry = await state.getOwnerEntry(parseId(requiredRouteParam(c, 'entryId')));
  if (!entry || entry.storeId !== owner.storeId || entry.workspaceId !== owner.workspaceId ||
      entry.ownerKind !== owner.ownerKind || entry.ownerId !== owner.ownerId) {
    throw new MemoryStateError('memory_entry_not_found', 'Memory entry was not found.');
  }
  return entry;
}

function assertUpdateReceipt(
  revisions: readonly MemoryRevision[],
  idempotencyKey: string,
  entryId: string,
  expectedVersion: number,
  actorId: string,
  content: Pick<MemoryEntry, 'description' | 'type' | 'body'>,
): void {
  const receipt = revisions.find((revision) => revision.idempotencyKey === idempotencyKey);
  if (
    !receipt ||
    receipt.entryId !== entryId ||
    receipt.version !== expectedVersion + 1 ||
    receipt.operation !== 'update' ||
    receipt.actorId !== actorId ||
    receipt.actorClass !== 'operator' ||
    receipt.description !== content.description ||
    receipt.type !== content.type ||
    receipt.body !== content.body
  ) {
    throw new MemoryStateError(
      'memory_idempotency_mismatch',
      'The idempotency key belongs to a different memory update.',
    );
  }
}

function assertOwnerCreateReceipt(
  revisions: readonly MemoryRevision[],
  idempotencyKey: string,
  entryId: string,
  actorId: string,
  slug: string,
  content: Pick<OwnerMemoryEntry, 'description' | 'type' | 'body'>,
): void {
  const receipt = revisions.find((revision) => revision.idempotencyKey === idempotencyKey);
  if (
    !receipt ||
    receipt.entryId !== entryId ||
    receipt.version !== 1 ||
    receipt.operation !== 'create' ||
    receipt.actorId !== actorId ||
    receipt.actorClass !== 'operator' ||
    receipt.description !== content.description ||
    receipt.type !== content.type ||
    receipt.body !== content.body ||
    receipt.reasonCode !== `slug_seed:${slug}`
  ) {
    throw new MemoryStateError(
      'memory_idempotency_mismatch',
      'The idempotency key belongs to a different memory creation.',
    );
  }
}

function assertDeleteReceipt(
  revisions: readonly MemoryRevision[],
  idempotencyKey: string,
  entryId: string,
  expectedVersion: number,
  actorId: string,
): void {
  const receipt = revisions.find((revision) => revision.idempotencyKey === idempotencyKey);
  if (
    !receipt ||
    receipt.entryId !== entryId ||
    receipt.version !== expectedVersion + 1 ||
    receipt.operation !== 'forget' ||
    receipt.actorId !== actorId ||
    receipt.actorClass !== 'operator' ||
    receipt.reasonCode !== 'admin_delete'
  ) {
    throw new MemoryStateError(
      'memory_idempotency_mismatch',
      'The idempotency key belongs to a different memory deletion.',
    );
  }
}

function assertReviewReceipt(
  receipt: AuditEvent,
  entryId: string,
  requestEventId: string,
  expectedVersion: number,
  actorId: string,
  resolution: 'confirmed' | 'corrected' | 'expired',
): void {
  const metadata = reviewMetadata(receipt.metadataJson);
  if (
    receipt.domain !== 'memory' ||
    receipt.eventType !== 'memory.review_resolved' ||
    receipt.subjectId !== entryId ||
    receipt.subjectVersion !== expectedVersion ||
    receipt.actorId !== actorId ||
    receipt.actorClass !== 'operator' ||
    metadata.resolution !== resolution ||
    metadata.reviewRequestEventId !== requestEventId
  ) {
    throw new MemoryStateError(
      'memory_idempotency_mismatch',
      'The idempotency key belongs to a different memory review.',
    );
  }
}

function reviewMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function buildScopes(
  stores: readonly MemoryStoreDescriptor[],
  channelStates: Awaited<ReturnType<MemoryStateStore['listChannelScopes']>>,
  summaries: readonly MemoryEntryScopeSummary[],
): Array<Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const counts = new Map<string, number>();
  const storeById = new Map(stores.map((store) => [store.storeId, store]));
  const publicStoreByWorkspace = new Map(
    stores
      .filter((store) => store.visibility === 'public')
      .map((store) => [store.workspaceId, store]),
  );
  for (const summary of summaries) {
    counts.set(`${summary.storeId}\0${summary.sourceChannelId}`, summary.entryCount);
  }
  const stateByChannel = new Map(channelStates.map((state) => [`${state.workspaceId}\0${state.channelId}`, state]));
  for (const state of channelStates) {
    const publicStore = publicStoreByWorkspace.get(state.workspaceId);
    if (publicStore && (state.privacy === 'public' || counts.has(`${publicStore.storeId}\0${state.channelId}`))) {
      addScope(result, publicStore, state.channelId, state.currentDisplayName, state.lifecycle, counts);
    }
  }
  for (const store of stores) {
    if (store.visibility !== 'private' || !store.channelId) continue;
    const state = stateByChannel.get(`${store.workspaceId}\0${store.channelId}`);
    addScope(result, store, store.channelId, state?.currentDisplayName ?? store.channelId, state?.lifecycle ?? 'retained', counts);
  }
  for (const summary of summaries) {
    const store = storeById.get(summary.storeId);
    if (!store) continue;
    const key = `${summary.storeId}\0${summary.sourceChannelId}`;
    if (!result.has(key)) {
      const state = stateByChannel.get(`${store.workspaceId}\0${summary.sourceChannelId}`);
      addScope(
        result,
        store,
        summary.sourceChannelId,
        state?.currentDisplayName ?? summary.sourceChannelId,
        state?.lifecycle ?? 'retained',
        counts,
      );
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

function unresolvedReview(
  events: Awaited<ReturnType<MemoryStateStore['listAuditEvents']>>,
): { eventId: string; reasonCode: string | null; createdAt: number } | null {
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

function requiredRouteParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new MemoryStateError('memory_invalid_id', 'Memory identifier is invalid.');
  return value;
}

function isOpaqueId(value: string): boolean {
  return v.safeParse(opaqueId, value).success;
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

function decodeImportArchive(raw: string): Uint8Array {
  try {
    if (!raw || raw.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
      throw new MemoryImportValidationError();
    }
    const bytes = Buffer.from(raw, 'base64');
    // Parsing performs the authoritative uncompressed-size and entry-count checks.
    decodeMemoryArchive(bytes);
    return bytes;
  } catch (error) {
    if (error instanceof MemoryImportValidationError) throw error;
    throw new MemoryImportValidationError();
  }
}

function createValidatedImportPreview(
  input: Parameters<typeof createImportPreview>[0],
): ReturnType<typeof createImportPreview> {
  try {
    return createImportPreview(input);
  } catch (error) {
    if (error instanceof MemoryStateError) throw error;
    throw new MemoryImportValidationError();
  }
}

function verifyValidatedImportPreview(
  token: string,
  secret: string,
  expected: Parameters<typeof verifyImportPreview>[2],
): void {
  try {
    verifyImportPreview(token, secret, expected);
  } catch (error) {
    if (error instanceof MemoryStateError) throw error;
    throw new MemoryImportValidationError();
  }
}

function memoryError(c: Context, error: unknown): Response {
  if (error instanceof MemoryVersionConflictError) {
    return c.json({ error: error.code, currentVersion: error.currentVersion }, 409);
  }
  if (error instanceof MemoryStateError) {
    const status = error.code.includes('not_found') ? 404
      : error.code.includes('conflict') || error.code.includes('sealed') || error.code.includes('idempotency') ? 409
        : error.code.includes('quota') || error.code.includes('too_large') ? 413 : 400;
    return c.json({ error: error.code }, status as 400 | 404 | 409 | 413);
  }
  console.error('[chickpea] memory admin API failure:', error instanceof Error ? error.message : String(error));
  return c.json({ error: 'internal_error' }, 500);
}

function memoryImportError(c: Context, error: unknown): Response {
  if (error instanceof MemoryImportValidationError) {
    return c.json({ error: 'memory_import_invalid' }, 400);
  }
  return memoryError(c, error);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
