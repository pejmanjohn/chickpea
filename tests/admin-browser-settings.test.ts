import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { verifyBrowserbaseApiKey, type BrowserbaseKeyVerification } from '../src/browser/browserbase.ts';
import { recordBrowserSessionUsage } from '../src/browser/settings.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { withEnv } from './helpers/env.ts';

const ADMIN_TOKEN = 'browser-admin-token';
const GOOD_KEY = 'bb_live_abcdefghijklmnop1234';

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return testAdminHeaders(ADMIN_TOKEN, extra);
}

function appWithBrowserAdmin(verifier?: (apiKey: string) => Promise<BrowserbaseKeyVerification>) {
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const verifierCalls: string[] = [];
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    browserKeyVerifier: async (apiKey) => {
      verifierCalls.push(apiKey);
      return verifier ? verifier(apiKey) : { ok: true };
    },
  }));
  return {
    app,
    settings,
    verifierCalls,
    close: () => {
      config.close();
      settings.close();
    },
  };
}

const noBrowserEnv = { BROWSERBASE_API_KEY: undefined, BROWSERBASE_PROJECT_ID: undefined };

function putKey(app: Hono, body: unknown) {
  return app.request('/admin/api/browser/key', {
    method: 'PUT',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

test('GET /admin/api/browser/status reports not connected with zero usage and no key material', async () => {
  await withEnv(noBrowserEnv, async () => {
    const { app, close } = appWithBrowserAdmin();
    try {
      const response = await app.request('/admin/api/browser/status', { headers: headers() });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.provider, 'browserbase');
      assert.equal(body.connected, false);
      assert.equal(body.source, 'missing');
      assert.equal(body.keyHint, undefined);
      assert.deepEqual(Object.keys(body.usage as object).sort(), ['month', 'seconds', 'sessions']);
      assert.equal((body.usage as { sessions: number }).sessions, 0);
    } finally {
      close();
    }
  });
});

test('browser status requires an authenticated Admin', async () => {
  const { app, close } = appWithBrowserAdmin();
  try {
    const response = await app.request('/admin/api/browser/status');
    assert.notEqual(response.status, 200);
  } finally {
    close();
  }
});

test('PUT /admin/api/browser/key verifies, stores the single project, and returns only a key hint', async () => {
  await withEnv(noBrowserEnv, async () => {
    const { app, settings, verifierCalls, close } = appWithBrowserAdmin(async () => ({ ok: true, projectId: 'proj_one' }));
    try {
      await recordBrowserSessionUsage({ store: settings, sessionId: 's1', seconds: 3_720 });
      const response = await putKey(app, { apiKey: `  ${GOOD_KEY} ` });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, new RegExp(GOOD_KEY));
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(body.connected, true);
      assert.equal(body.source, 'stored');
      assert.equal(body.keyHint, '1234');
      assert.equal(body.projectId, 'proj_one');
      assert.equal((body.usage as { sessions: number; seconds: number }).sessions, 1);
      assert.equal((body.usage as { sessions: number; seconds: number }).seconds, 3_720);
      assert.deepEqual(verifierCalls, [GOOD_KEY]);

      const explicit = await putKey(app, { apiKey: GOOD_KEY, projectId: 'proj_chosen' });
      assert.equal(((await explicit.json()) as { projectId?: string }).projectId, 'proj_chosen');

      const status = await app.request('/admin/api/browser/status', { headers: headers() });
      const statusBody = await status.json() as Record<string, unknown>;
      assert.equal(statusBody.connected, true);
      assert.equal(statusBody.projectId, 'proj_chosen');
    } finally {
      close();
    }
  });
});

test('PUT /admin/api/browser/key maps malformed, rejected, and unreachable keys without storing them', async () => {
  await withEnv(noBrowserEnv, async () => {
    let next: BrowserbaseKeyVerification = { ok: false, reason: 'invalid_key', status: 401 };
    const { app, verifierCalls, close } = appWithBrowserAdmin(async () => next);
    try {
      const malformed = await putKey(app, { apiKey: 'sk-not-browserbase' });
      assert.equal(malformed.status, 422);
      assert.deepEqual(await malformed.json(), { error: 'invalid_key' });
      assert.equal(verifierCalls.length, 0, 'an obviously wrong paste never reaches the network');

      const rejected = await putKey(app, { apiKey: GOOD_KEY });
      assert.equal(rejected.status, 422);
      assert.deepEqual(await rejected.json(), { error: 'invalid_key' });

      next = { ok: false, reason: 'unreachable', status: 503 };
      const unreachable = await putKey(app, { apiKey: GOOD_KEY });
      assert.equal(unreachable.status, 502);
      assert.deepEqual(await unreachable.json(), { error: 'provider_unreachable' });

      const invalidBody = await putKey(app, { key: GOOD_KEY });
      assert.equal(invalidBody.status, 400);

      const status = await app.request('/admin/api/browser/status', { headers: headers() });
      assert.equal(((await status.json()) as { connected: boolean }).connected, false);
    } finally {
      close();
    }
  });
});

test('DELETE /admin/api/browser/key clears the stored key', async () => {
  await withEnv(noBrowserEnv, async () => {
    const { app, close } = appWithBrowserAdmin(async () => ({ ok: true }));
    try {
      assert.equal((await putKey(app, { apiKey: GOOD_KEY, projectId: 'proj_x' })).status, 200);
      const response = await app.request('/admin/api/browser/key', { method: 'DELETE', headers: headers() });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.connected, false);
      assert.equal(body.source, 'missing');
      assert.equal(body.projectId, undefined);
    } finally {
      close();
    }
  });
});

test('an environment key makes the browser key read-only for PUT and DELETE', async () => {
  await withEnv({ BROWSERBASE_API_KEY: 'bb_live_fromenvironment9876', BROWSERBASE_PROJECT_ID: 'proj_env' }, async () => {
    const { app, verifierCalls, close } = appWithBrowserAdmin();
    try {
      const status = await app.request('/admin/api/browser/status', { headers: headers() });
      const statusText = await status.text();
      assert.doesNotMatch(statusText, /fromenvironment/);
      const statusBody = JSON.parse(statusText) as Record<string, unknown>;
      assert.equal(statusBody.connected, true);
      assert.equal(statusBody.source, 'env');
      assert.equal(statusBody.envVar, 'BROWSERBASE_API_KEY');
      assert.equal(statusBody.keyHint, '9876');
      assert.equal(statusBody.projectId, 'proj_env');

      const put = await putKey(app, { apiKey: GOOD_KEY });
      assert.equal(put.status, 409);
      assert.deepEqual(await put.json(), { error: 'browser_key_read_only', envVar: 'BROWSERBASE_API_KEY' });
      assert.equal(verifierCalls.length, 0);

      const del = await app.request('/admin/api/browser/key', { method: 'DELETE', headers: headers() });
      assert.equal(del.status, 409);
      assert.equal(((await del.json()) as { error: string }).error, 'browser_key_read_only');
    } finally {
      close();
    }
  });
});

function fakeFetch(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

test('verifyBrowserbaseApiKey calls GET /v1/projects with the key header and returns a single project', async () => {
  const { impl, calls } = fakeFetch(() => new Response(JSON.stringify([{ id: 'proj_only', name: 'Only' }]), { status: 200 }));
  const result = await verifyBrowserbaseApiKey({ apiKey: GOOD_KEY, fetch: impl, baseUrl: 'https://bb.test/' });
  assert.deepEqual(result, { ok: true, projectId: 'proj_only' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://bb.test/v1/projects');
  assert.equal(calls[0]!.init?.method, 'GET');
  assert.equal((calls[0]!.init?.headers as Record<string, string>)['X-BB-API-Key'], GOOD_KEY);
});

test('verifyBrowserbaseApiKey returns ok without a project when several are visible', async () => {
  const { impl } = fakeFetch(() => new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }]), { status: 200 }));
  assert.deepEqual(await verifyBrowserbaseApiKey({ apiKey: GOOD_KEY, fetch: impl }), { ok: true });
  const { impl: notJson } = fakeFetch(() => new Response('ok', { status: 200 }));
  assert.deepEqual(await verifyBrowserbaseApiKey({ apiKey: GOOD_KEY, fetch: notJson }), { ok: true });
});

test('verifyBrowserbaseApiKey maps 401/403 to invalid_key and other failures to unreachable without echoing the key', async () => {
  for (const status of [401, 403]) {
    const { impl } = fakeFetch(() => new Response(`bad key ${GOOD_KEY}`, { status }));
    assert.deepEqual(await verifyBrowserbaseApiKey({ apiKey: GOOD_KEY, fetch: impl }), { ok: false, reason: 'invalid_key', status });
  }
  const { impl: serverError } = fakeFetch(() => new Response('oops', { status: 500 }));
  assert.deepEqual(await verifyBrowserbaseApiKey({ apiKey: GOOD_KEY, fetch: serverError }), { ok: false, reason: 'unreachable', status: 500 });
  const { impl: throwing } = fakeFetch(() => { throw new Error(`socket closed for ${GOOD_KEY}`); });
  const result = await verifyBrowserbaseApiKey({ apiKey: GOOD_KEY, fetch: throwing });
  assert.deepEqual(result, { ok: false, reason: 'unreachable' });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(GOOD_KEY));
});
