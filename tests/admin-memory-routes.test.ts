import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { decodeMemoryArchive, encodeMemoryArchive } from '../src/memory/archive.ts';
import { projectMemoryEntry, projectMemoryFiles } from '../src/memory/markdown.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const ADMIN_TOKEN = 'admin-memory-secret';
const NOW = Date.UTC(2026, 6, 25, 12);

async function harness() {
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const memory = new SqliteMemoryStateStore(':memory:', () => NOW);
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  const publicStore = await memory.ensurePublicStore('T_TEST');
  await memory.observeChannelScope({
    workspaceId: 'T_TEST', channelId: 'C_PRODUCT', privacy: 'public',
    displayName: 'product', observedAt: NOW,
  });
  const entry = await memory.createEntry({
    entryId: 'mem_product', storeId: publicStore.storeId, workspaceId: 'T_TEST',
    sourceChannelId: 'C_PRODUCT', slug: 'release-guidance', description: 'Use the checklist.',
    type: 'project', body: 'Run tests before release.', actorId: 'U_MEMBER', actorClass: 'member',
    idempotencyKey: 'memory:test:create',
  });
  const agentOwner = await memory.ensureOwner({ workspaceId: 'T_TEST', ownerKind: 'agent', ownerId: 'agent_default' });
  await config.createAgent({
    id: 'agent_other', name: 'Other Agent', instructions: 'Keep other memory separate.',
    enabled: true, lifecycle: 'active', skills: [], mcpServers: [], apiConnections: [],
    repositories: [],
  });
  await memory.ensureOwner({ workspaceId: 'T_TEST', ownerKind: 'agent', ownerId: 'agent_other' });
  const ownerEntry = await memory.createOwnerEntry({
    entryId: 'mem_owner_product', storeId: agentOwner.storeId, workspaceId: 'T_TEST',
    slug: 'launch-guidance', description: 'Agent launch guidance.', type: 'fact', body: 'Agent launch body.',
    actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'memory:test:owner-create',
  });
  await memory.createOwnerEntry({
    entryId: 'mem_agent_product', storeId: agentOwner.storeId, workspaceId: 'T_TEST',
    slug: 'agent-guidance', description: 'Only this agent.', type: 'fact', body: 'Agent owner body.',
    actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'memory:test:agent-create',
  });
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config, settings, memory, routines, ...testAdminAuthority(ADMIN_TOKEN),
    knownProviders: new Set(),
  }));
  return { app, config, settings, memory, routines, publicStore, entry, agentOwner, ownerEntry };
}

const auth = testAdminHeaders(ADMIN_TOKEN);

test('owner memory creation is authenticated, route-owned, validated, and idempotent', async () => {
  const h = await harness();
  const agentBase = '/admin/api/audit/memory/owners/agent/T_TEST/agent_default';
  const body = {
    slug: 'launch-notes',
    description: 'Launch details.',
    type: 'project',
    body: 'Ship after the final review.',
  };
  const headers = {
    ...auth,
    'content-type': 'application/json',
    'idempotency-key': 'owner-create-1',
  };
  try {
    assert.equal((await h.app.request(`${agentBase}/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'unauth' },
      body: JSON.stringify(body),
    })).status, 401);

    assert.equal((await h.app.request(`${agentBase}/entries`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'idempotency-key': 'owner-create-cross-origin',
      },
      body: JSON.stringify(body),
    })).status, 403);

    const created = await h.app.request(`${agentBase}/entries`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const createdBody = JSON.parse(createdText) as {
      owner: { ownerKind: string; ownerId: string };
      entry: { entryId: string; ownerKind: string; ownerId: string; writeOrigin: { kind: string } };
      projected: string;
    };
    assert.deepEqual(createdBody.owner, h.agentOwner);
    assert.equal(createdBody.entry.ownerKind, 'agent');
    assert.equal(createdBody.entry.ownerId, 'agent_default');
    assert.deepEqual(createdBody.entry.writeOrigin, { kind: 'admin' });
    assert.match(createdBody.projected, /Ship after the final review\./);

    const replay = await h.app.request(`${agentBase}/entries`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    assert.equal(replay.status, 201);
    assert.equal((await replay.json() as { entry: { entryId: string } }).entry.entryId,
      createdBody.entry.entryId);
    assert.equal((await h.memory.listOwnerEntries(h.agentOwner)).length, 3);

    const mismatch = await h.app.request(`${agentBase}/entries`, {
      method: 'POST', headers, body: JSON.stringify({ ...body, body: 'Different content.' }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json() as { error: string }).error, 'memory_idempotency_mismatch');

    const spoofedOwner = await h.app.request(`${agentBase}/entries`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'owner-create-spoof' },
      body: JSON.stringify({ ...body, ownerId: 'agent_default' }),
    });
    assert.equal(spoofedOwner.status, 400);

    assert.equal((await h.app.request(
      `/admin/api/audit/memory/owners/channel/T_TEST/C_PRODUCT/entries/${createdBody.entry.entryId}`,
      { headers: auth },
    )).status, 403);
  } finally {
    h.routines.close(); h.memory.close(); h.settings.close(); h.config.close();
  }
});

test('owner memory routes authenticate and derive exact owner from the route', async () => {
  const h = await harness();
  const base = '/admin/api/audit/memory/owners/agent/T_TEST/agent_default';
  try {
    for (const path of [
      '/admin/api/audit/memory/owners', `${base}/files`,
      `${base}/entries/${h.ownerEntry.entryId}`,
      `${base}/entries/${h.ownerEntry.entryId}/history`, `${base}/export`,
    ]) assert.equal((await h.app.request(path)).status, 401, path);
    assert.equal((await h.app.request(`${base}/entries/${h.ownerEntry.entryId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': 'unauth' },
      body: JSON.stringify({ expectedVersion: 1, description: 'x', type: 'fact', body: 'x' }),
    })).status, 401);
    assert.equal((await h.app.request(`${base}/entries/${h.ownerEntry.entryId}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json', 'idempotency-key': 'unauth' },
      body: JSON.stringify({ expectedVersion: 1, acknowledgeIrreversible: true }),
    })).status, 401);
    const files = await h.app.request(`${base}/files`, { headers: auth });
    assert.equal(files.status, 200);
    assert.equal(files.headers.get('cache-control'), 'no-store');
    assert.deepEqual(((await files.json()) as { files: Array<{ name: string }> }).files.map(({ name }) => name),
      ['MEMORY.md', 'agent-guidance.md', 'launch-guidance.md']);

    const wrongOwner = await h.app.request(
      `/admin/api/audit/memory/owners/agent/T_TEST/agent_other/entries/${h.ownerEntry.entryId}`,
      { headers: auth },
    );
    assert.equal(wrongOwner.status, 404);

    const update = await h.app.request(`${base}/entries/${h.ownerEntry.entryId}`, {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'owner-edit-1' },
      body: JSON.stringify({ expectedVersion: 1, description: 'Updated Agent guidance.', type: 'fact', body: 'New body.' }),
    });
    const updateText = await update.text();
    assert.equal(update.status, 200, updateText);
    assert.equal((JSON.parse(updateText) as { entry: { ownerKind: string; ownerId: string; version: number } }).entry.version, 2);
    assert.equal((await h.memory.getOwnerEntry('mem_agent_product'))?.version, 1);

    const history = await h.app.request(`${base}/entries/${h.ownerEntry.entryId}/history`, { headers: auth });
    assert.equal(history.status, 200);
    assert.equal(((await history.json()) as { revisions: unknown[] }).revisions.length, 2);

    const exported = await h.app.request(`${base}/export`, { headers: auth });
    assert.equal(exported.status, 200);
    const archive = decodeMemoryArchive(new Uint8Array(await exported.arrayBuffer()));
    assert.equal(JSON.stringify(archive).includes('Agent owner body.'), true);
    assert.deepEqual(archive.map(({ path }) => path), ['MEMORY.md', 'agent-guidance.md', 'launch-guidance.md', 'manifest.json']);
  } finally {
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});

test('memory admin scopes, files, entry detail, history, and audit events are authenticated', async () => {
  const h = await harness();
  try {
    assert.equal((await h.app.request('/admin/api/audit/memory/scopes')).status, 401);
    const scopes = await h.app.request('/admin/api/audit/memory/scopes', { headers: auth });
    assert.equal(scopes.status, 200);
    const scopesBody = await scopes.json() as { scopes: Array<Record<string, unknown>> };
    assert.deepEqual(scopesBody.scopes[0], {
      workspaceId: 'T_TEST', channelId: 'C_PRODUCT', displayName: 'product', privacy: 'public',
      lifecycle: 'active', storeId: h.publicStore.storeId, generation: null, entryCount: 1,
    });

    const files = await h.app.request(
      `/admin/api/audit/memory/stores/${h.publicStore.storeId}/files?sourceChannelId=C_PRODUCT`,
      { headers: auth },
    );
    assert.equal(files.status, 200);
    const filesBody = await files.json() as { files: Array<{ name: string; generated: boolean }> };
    assert.deepEqual(filesBody.files.map((file) => file.name), ['MEMORY.md', 'release-guidance.md']);
    assert.equal(filesBody.files[0]?.generated, true);

    const detail = await h.app.request('/admin/api/audit/memory/entries/mem_product', { headers: auth });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { entry: { version: number }; projected: string };
    assert.equal(detailBody.entry.version, 1);
    assert.match(detailBody.projected, /Run tests before release\./);

    const history = await h.app.request('/admin/api/audit/memory/entries/mem_product/history', { headers: auth });
    assert.equal(history.status, 200);
    assert.equal(((await history.json()) as { revisions: unknown[] }).revisions.length, 1);

    const events = await h.app.request('/admin/api/audit/memory/events', { headers: auth });
    assert.equal(events.status, 200);
    const eventTypes = ((await events.json()) as { events: Array<{ eventType: string }> }).events
      .map(({ eventType }) => eventType);
    assert.ok(eventTypes.includes('memory.created'));
    assert.equal((await h.app.request('/admin/api/audit/scheduled_work/events', { headers: auth })).status, 200);
  } finally {
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});

test('memory admin scope bootstrap uses body-free summaries', async () => {
  const h = await harness();
  const originalListEntries = h.memory.listEntries.bind(h.memory);
  try {
    h.memory.listEntries = async () => {
      throw new Error('scope bootstrap must not load memory bodies');
    };
    const scopes = await h.app.request('/admin/api/audit/memory/scopes', { headers: auth });
    assert.equal(scopes.status, 200);
    assert.equal(
      ((await scopes.json()) as { scopes: Array<{ entryCount: number }> }).scopes[0]?.entryCount,
      1,
    );
  } finally {
    h.memory.listEntries = originalListEntries;
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});

test('private memory file listing does not audit every entry before detail is opened', async () => {
  const h = await harness();
  try {
    await h.memory.observeChannelScope({
      workspaceId: 'T_TEST', channelId: 'C_SECRET', privacy: 'private',
      displayName: 'secret', observedAt: NOW,
    });
    const privateStore = await h.memory.ensurePrivateStore('T_TEST', 'C_SECRET', 1);
    await h.memory.createEntry({
      entryId: 'mem_secret', storeId: privateStore.storeId, workspaceId: 'T_TEST',
      sourceChannelId: 'C_SECRET', slug: 'private-guidance', description: 'Private.',
      type: 'fact', body: 'Keep this private.', actorId: 'U_MEMBER', actorClass: 'member',
      idempotencyKey: 'memory:test:create-private',
    });

    const files = await h.app.request(
      `/admin/api/audit/memory/stores/${privateStore.storeId}/files?sourceChannelId=C_SECRET`,
      { headers: auth },
    );
    assert.equal(files.status, 200);
    assert.equal((await h.memory.listAuditEvents({ eventType: 'memory.private_entry_viewed' })).length, 0);

    const detail = await h.app.request('/admin/api/audit/memory/entries/mem_secret', { headers: auth });
    assert.equal(detail.status, 200);
    assert.equal((await h.memory.listAuditEvents({ eventType: 'memory.private_entry_viewed' })).length, 1);
  } finally {
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});

test('memory admin edit is idempotent, versioned, validated, and same-origin for cookie auth', async () => {
  const h = await harness();
  try {
    const body = JSON.stringify({ expectedVersion: 1, description: 'Use the full checklist.', type: 'project', body: 'Run all tests.' });
    const updated = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-edit-1' }, body,
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as { entry: { version: number } }).entry.version, 2);
    const replay = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-edit-1' }, body,
    });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { entry: { version: number } }).entry.version, 2);

    const mismatchedReplay = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-edit-1' },
      body: JSON.stringify({ expectedVersion: 1, description: 'Different request.', type: 'project', body: 'Different body.' }),
    });
    assert.equal(mismatchedReplay.status, 409);
    assert.deepEqual(await mismatchedReplay.json(), { error: 'memory_idempotency_mismatch' });

    const conflict = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-edit-2' }, body,
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'memory_version_conflict', currentVersion: 2 });

    const crossOrigin = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'PUT', headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'idempotency-key': 'admin-edit-3',
      }, body,
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});

test('memory export is an attachment and import preview/apply round-trips create-only Markdown', async () => {
  const h = await harness();
  try {
    const exported = await h.app.request(`/admin/api/audit/memory/export?storeId=${h.publicStore.storeId}`, { headers: auth });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    assert.ok(decodeMemoryArchive(new Uint8Array(await exported.arrayBuffer())).some((file) => file.path === 'manifest.json'));
    assert.equal((await h.memory.listAuditEvents({ eventType: 'memory.exported' })).length, 1);

    const authored = {
      ...h.entry, entryId: 'unused', slug: 'new-guidance', description: 'New guidance.', body: 'Keep this memory.',
    };
    const archive = encodeMemoryArchive([{
      path: 'channel/C_PRODUCT/new-guidance.md', content: projectMemoryEntry(authored),
    }]);
    const archiveBase64 = Buffer.from(archive).toString('base64');
    const preview = await h.app.request('/admin/api/audit/memory/import/preview', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ storeId: h.publicStore.storeId, archiveBase64 }),
    });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { previewToken: string; preview: { summary: { creates: number } } };
    assert.equal(previewBody.preview.summary.creates, 1);

    const applied = await h.app.request('/admin/api/audit/memory/import/apply', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-import-1' },
      body: JSON.stringify({ storeId: h.publicStore.storeId, archiveBase64, previewToken: previewBody.previewToken }),
    });
    assert.equal(applied.status, 200);
    assert.equal(((await applied.json()) as { entries: unknown[] }).entries.length, 1);
    assert.ok((await h.memory.listEntries({ storeId: h.publicStore.storeId })).some((item) => item.slug === 'new-guidance'));

    const replay = await h.app.request('/admin/api/audit/memory/import/apply', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-import-1' },
      body: JSON.stringify({ storeId: h.publicStore.storeId, archiveBase64, previewToken: previewBody.previewToken }),
    });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { entries: unknown[] }).entries.length, 1);

    const otherArchive = encodeMemoryArchive([{
      path: 'channel/C_PRODUCT/other-guidance.md',
      content: projectMemoryEntry({ ...authored, slug: 'other-guidance', description: 'Other guidance.' }),
    }]);
    const otherArchiveBase64 = Buffer.from(otherArchive).toString('base64');
    const otherPreview = await h.app.request('/admin/api/audit/memory/import/preview', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ storeId: h.publicStore.storeId, archiveBase64: otherArchiveBase64 }),
    });
    assert.equal(otherPreview.status, 200);
    const otherPreviewToken = ((await otherPreview.json()) as { previewToken: string }).previewToken;
    const mismatchedReplay = await h.app.request('/admin/api/audit/memory/import/apply', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-import-1' },
      body: JSON.stringify({ storeId: h.publicStore.storeId, archiveBase64: otherArchiveBase64, previewToken: otherPreviewToken }),
    });
    assert.equal(mismatchedReplay.status, 409);
    assert.deepEqual(await mismatchedReplay.json(), { error: 'memory_idempotency_mismatch' });
  } finally {
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});

test('memory manifest import preserves the reviewed entry status', async () => {
  const h = await harness();
  try {
    const staleEntry = {
      ...h.entry,
      entryId: 'mem_stale_import',
      slug: 'stale-import',
      description: 'Imported stale guidance.',
      body: 'This needs review.',
      status: 'stale' as const,
    };
    const archiveBase64 = Buffer.from(encodeMemoryArchive(
      projectMemoryFiles({ store: h.publicStore, entries: [staleEntry] }),
    )).toString('base64');
    const preview = await h.app.request('/admin/api/audit/memory/import/preview', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ storeId: h.publicStore.storeId, archiveBase64 }),
    });
    assert.equal(preview.status, 200);
    const previewToken = ((await preview.json()) as { previewToken: string }).previewToken;

    const applied = await h.app.request('/admin/api/audit/memory/import/apply', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-import-status' },
      body: JSON.stringify({ storeId: h.publicStore.storeId, archiveBase64, previewToken }),
    });
    assert.equal(applied.status, 200, await applied.text());
    assert.equal((await h.memory.getEntry('mem_stale_import'))?.status, 'stale');
  } finally {
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});

test('memory import validation is typed while unknown failures stay sanitized', async () => {
  const h = await harness();
  const originalGetStore = h.memory.getStore.bind(h.memory);
  try {
    const invalidArchive = await h.app.request('/admin/api/audit/memory/import/preview', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        storeId: h.publicStore.storeId,
        archiveBase64: Buffer.alloc(512, 1).toString('base64'),
      }),
    });
    assert.equal(invalidArchive.status, 400);
    assert.deepEqual(await invalidArchive.json(), { error: 'memory_import_invalid' });

    h.memory.getStore = async () => {
      throw new Error('archive import conflict: internal database detail');
    };
    const unknown = await h.app.request('/admin/api/audit/memory/import/preview', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        storeId: h.publicStore.storeId,
        archiveBase64: Buffer.from(encodeMemoryArchive([])).toString('base64'),
      }),
    });
    assert.equal(unknown.status, 500);
    assert.deepEqual(await unknown.json(), { error: 'internal_error' });
  } finally {
    h.memory.getStore = originalGetStore;
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});

test('memory admin delete irreversibly scrubs content and review resolution is audited', async () => {
  const h = await harness();
  try {
    await h.memory.recordReview({
      entryId: h.entry.entryId, expectedVersion: 1, action: 'requested', reasonCode: 'stale',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'review-request',
    });
    await h.memory.recordReview({
      entryId: h.entry.entryId, expectedVersion: 1, action: 'requested', reasonCode: 'incorrect',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'review-request-newer',
    });
    const reviews = await h.memory.listAuditEvents({ subjectId: h.entry.entryId, eventType: 'memory.review_requested' });
    const reviewId = reviews[0]!.eventId;
    const staleReviewId = reviews[1]!.eventId;
    const stale = await h.app.request(`/admin/api/audit/memory/entries/mem_product/reviews/${staleReviewId}/resolve`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'review-stale' },
      body: JSON.stringify({ expectedVersion: 1, resolution: 'confirmed' }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'memory_review_not_current' });
    const resolved = await h.app.request(`/admin/api/audit/memory/entries/mem_product/reviews/${reviewId}/resolve`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'review-resolve' },
      body: JSON.stringify({ expectedVersion: 1, resolution: 'confirmed' }),
    });
    assert.equal(resolved.status, 200);
    const reviewReplay = await h.app.request(`/admin/api/audit/memory/entries/mem_product/reviews/${reviewId}/resolve`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'review-resolve' },
      body: JSON.stringify({ expectedVersion: 1, resolution: 'confirmed' }),
    });
    assert.equal(reviewReplay.status, 200);
    const reviewMismatch = await h.app.request(`/admin/api/audit/memory/entries/mem_product/reviews/${reviewId}/resolve`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'review-resolve' },
      body: JSON.stringify({ expectedVersion: 1, resolution: 'expired' }),
    });
    assert.equal(reviewMismatch.status, 409);
    assert.deepEqual(await reviewMismatch.json(), { error: 'memory_idempotency_mismatch' });

    const deleted = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'DELETE', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-delete-1' },
      body: JSON.stringify({ expectedVersion: 1, acknowledgeIrreversible: true }),
    });
    assert.equal(deleted.status, 200);
    const deleteReplay = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'DELETE', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-delete-1' },
      body: JSON.stringify({ expectedVersion: 1, acknowledgeIrreversible: true }),
    });
    assert.equal(deleteReplay.status, 200);
    const deleteMismatch = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'DELETE', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-delete-1' },
      body: JSON.stringify({ expectedVersion: 2, acknowledgeIrreversible: true }),
    });
    assert.equal(deleteMismatch.status, 409);
    assert.deepEqual(await deleteMismatch.json(), { error: 'memory_idempotency_mismatch' });
    const forgotten = await h.memory.getEntry('mem_product');
    assert.equal(forgotten?.status, 'forgotten');
    assert.equal(forgotten?.body, '');
    assert.ok((await h.memory.listRevisions('mem_product')).every((revision) => revision.body === null));
  } finally {
    h.config.close(); h.settings.close(); h.memory.close(); h.routines.close();
  }
});
