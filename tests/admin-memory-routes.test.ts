import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { decodeMemoryArchive, encodeMemoryArchive } from '../src/memory/archive.ts';
import { projectMemoryEntry } from '../src/memory/markdown.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';

const ADMIN_TOKEN = 'admin-memory-secret';
const NOW = Date.UTC(2026, 6, 25, 12);

async function harness() {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const memory = new SqliteMemoryStateStore(':memory:', () => NOW);
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
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config, settings, memory, adminToken: ADMIN_TOKEN, knownProviders: new Set(),
  }));
  return { app, config, settings, memory, publicStore, entry };
}

const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

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
    assert.equal(((await events.json()) as { events: unknown[] }).events.length, 1);
    assert.equal((await h.app.request('/admin/api/audit/scheduled_work/events', { headers: auth })).status, 404);
  } finally {
    h.config.close(); h.settings.close(); h.memory.close();
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

    const conflict = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-edit-2' }, body,
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'memory_version_conflict', currentVersion: 2 });

    const login = await h.app.request('/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN_TOKEN }).toString(), redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const crossOrigin = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'PUT', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json', 'idempotency-key': 'admin-edit-3' }, body,
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    h.config.close(); h.settings.close(); h.memory.close();
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
  } finally {
    h.config.close(); h.settings.close(); h.memory.close();
  }
});

test('memory admin delete irreversibly scrubs content and review resolution is audited', async () => {
  const h = await harness();
  try {
    await h.memory.recordReview({
      entryId: h.entry.entryId, expectedVersion: 1, action: 'requested', reasonCode: 'stale',
      actorId: 'U_MEMBER', actorClass: 'member', idempotencyKey: 'review-request',
    });
    const reviews = await h.memory.listAuditEvents({ subjectId: h.entry.entryId, eventType: 'memory.review_requested' });
    const reviewId = reviews[0]!.eventId;
    const resolved = await h.app.request(`/admin/api/audit/memory/entries/mem_product/reviews/${reviewId}/resolve`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'review-resolve' },
      body: JSON.stringify({ expectedVersion: 1, resolution: 'confirmed' }),
    });
    assert.equal(resolved.status, 200);

    const deleted = await h.app.request('/admin/api/audit/memory/entries/mem_product', {
      method: 'DELETE', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'admin-delete-1' },
      body: JSON.stringify({ expectedVersion: 1, acknowledgeIrreversible: true }),
    });
    assert.equal(deleted.status, 200);
    const forgotten = await h.memory.getEntry('mem_product');
    assert.equal(forgotten?.status, 'forgotten');
    assert.equal(forgotten?.body, '');
    assert.ok((await h.memory.listRevisions('mem_product')).every((revision) => revision.body === null));
  } finally {
    h.config.close(); h.settings.close(); h.memory.close();
  }
});
