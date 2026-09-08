import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  MODEL_CATALOG_SETTING_KEYS,
  readModelCatalogLkg,
} from '../src/model-catalog/store.ts';
import {
  MODEL_CATALOG_PRODUCTION_URL,
  refreshModelCatalog,
} from '../src/model-catalog/refresh.ts';
import {
  MODEL_CATALOG_MAX_BYTES,
  parseModelCatalogBytes,
} from '../src/model-catalog/schema.ts';
import {
  activeModelCatalogSnapshot,
  resetModelCatalogActivationForTests,
} from '../src/model-catalog/catalog.ts';

const NOW = Date.parse('2026-07-29T20:00:00Z');

function document(revision = 2): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision,
    generatedAt: '2026-07-29T19:55:00Z',
    entries: [{
      canonical: 'openai/gpt-hosted-example',
      displayName: 'GPT Hosted Example',
      lanes: {
        subscription: 'openai-codex-responses-standard@1',
        apiKey: 'openai-platform-responses-terra-tier@1',
      },
      contextWindow: 200_000,
      maxTokens: 32_000,
    }],
  };
}

async function seedLkg(
  settings: SqliteSettingsStore,
  revision = 2,
): Promise<string> {
  const result = await refreshModelCatalog({
    settings,
    now: () => NOW,
    random: () => 0.5,
    ownerId: `seed-${revision}`,
    fetch: async () => new Response(JSON.stringify(document(revision)), {
      status: 200,
      headers: { etag: `"revision-${revision}"` },
    }),
  });
  assert.equal(result.status, 'activated');
  const raw = await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg);
  assert.ok(raw);
  return raw;
}

test('the external schema is exact, bounded, provider-aware, and shrink-only', () => {
  const parsed = parseModelCatalogBytes(new TextEncoder().encode(JSON.stringify(document())));
  assert.equal(parsed.revision, 2);
  assert.equal(parsed.entries[0]?.canonical, 'openai/gpt-hosted-example');

  for (const candidate of [
    { ...document(), unexpected: true },
    { ...document(), entries: [{ ...(document().entries as Record<string, unknown>[])[0], baseUrl: 'https://evil.example' }] },
    { ...document(), entries: [{ ...(document().entries as Record<string, unknown>[])[0], lanes: { ...((document().entries as Record<string, unknown>[])[0]?.lanes as Record<string, unknown>), unexpected: 'openai-platform-responses-terra-tier@1' } }] },
    { ...document(), entries: [{ ...(document().entries as Record<string, unknown>[])[0], canonical: 'google/gemini-hosted' }] },
    { ...document(), entries: [{ ...(document().entries as Record<string, unknown>[])[0], canonical: 'anthropic/claude-hosted', lanes: { subscription: 'openai-codex-responses-standard@1' } }] },
    { ...document(), entries: [{ ...(document().entries as Record<string, unknown>[])[0], lanes: { apiKey: 'anthropic-messages-sonnet-tier@1' } }] },
    { ...document(), entries: [{ ...(document().entries as Record<string, unknown>[])[0], lanes: { apiKey: 'openai-platform-responses-future@9' } }] },
    { ...document(), entries: [{ ...(document().entries as Record<string, unknown>[])[0], contextWindow: 300_000 }] },
    { ...document(), entries: [{ ...(document().entries as Record<string, unknown>[])[0], maxTokens: 200_000 }] },
  ]) {
    assert.throws(
      () => parseModelCatalogBytes(new TextEncoder().encode(JSON.stringify(candidate))),
      /catalog/i,
    );
  }

  const tooMany = { ...document(), entries: Array.from({ length: 65 }, (_, index) => ({
    canonical: `openai/gpt-hosted-${index}`,
    lanes: { apiKey: 'openai-platform-responses-terra-tier@1' },
  })) };
  assert.throws(
    () => parseModelCatalogBytes(new TextEncoder().encode(JSON.stringify(tooMany))),
    /64/,
  );
});

test('refresh performs one bounded fixed-origin fetch and persists exact-byte LKG metadata', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const bytes = new TextEncoder().encode(JSON.stringify(document()));
  const requests: Request[] = [];

  const result = await refreshModelCatalog({
    settings,
    now: () => NOW,
    random: () => 0.5,
    ownerId: 'refresh-owner',
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(bytes, {
        status: 200,
        headers: {
          etag: '"revision-2"',
          'last-modified': 'Wed, 29 Jul 2026 19:55:00 GMT',
        },
      });
    },
  });

  assert.equal(result.status, 'activated');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, MODEL_CATALOG_PRODUCTION_URL);
  assert.equal(requests[0]?.redirect, 'manual');
  assert.equal(requests[0]?.cache, 'no-store');
  const lkg = await readModelCatalogLkg(settings);
  assert.equal(lkg?.document.revision, 2);
  assert.match(lkg?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(lkg?.etag, '"revision-2"');
  assert.equal(lkg?.checkedAt, NOW);
  assert.equal(lkg?.nextRefreshAt, NOW + 6 * 60 * 60 * 1000);
  assert.equal(await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.refreshLease), undefined);
});

test('conditional 304 refreshes freshness while every transport failure retains LKG', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const first = await refreshModelCatalog({
    settings,
    now: () => NOW,
    random: () => 0.5,
    ownerId: 'first',
    fetch: async () => new Response(JSON.stringify(document()), {
      status: 200,
      headers: { etag: '"revision-2"' },
    }),
  });
  assert.equal(first.status, 'activated');
  const before = await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg);

  let conditional: string | null = null;
  const checked = await refreshModelCatalog({
    settings,
    force: true,
    now: () => NOW + 1_000,
    random: () => 0.5,
    ownerId: 'second',
    fetch: async (input, init) => {
      conditional = new Request(input, init).headers.get('if-none-match');
      return new Response(null, { status: 304 });
    },
  });
  assert.equal(checked.status, 'not_modified');
  assert.equal(conditional, '"revision-2"');
  const after304 = await readModelCatalogLkg(settings);
  assert.equal(after304?.checkedAt, NOW + 1_000);

  const failed = await refreshModelCatalog({
    settings,
    force: true,
    now: () => NOW + 2_000,
    ownerId: 'third',
    fetch: async () => new Response('redirect', {
      status: 302,
      headers: { location: 'https://evil.example/catalog.json' },
    }),
  });
  assert.equal(failed.status, 'failed');
  assert.equal((await readModelCatalogLkg(settings))?.document.revision, 2);
  assert.notEqual(await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg), undefined);
  assert.notEqual(before, undefined);
});

test('oversized and fatally invalid UTF-8 bodies are rejected without replacing LKG', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await refreshModelCatalog({
    settings,
    now: () => NOW,
    ownerId: 'seed',
    fetch: async () => new Response(JSON.stringify(document()), { status: 200 }),
  });

  for (const body of [
    new Uint8Array(129 * 1024),
    new Uint8Array([0xc3, 0x28]),
  ]) {
    const result = await refreshModelCatalog({
      settings,
      force: true,
      now: () => NOW + 5_000,
      ownerId: `bad-${body.length}`,
      fetch: async () => new Response(body, { status: 200 }),
    });
    assert.equal(result.status, 'failed');
    assert.equal((await readModelCatalogLkg(settings))?.document.revision, 2);
  }
});

test('bundled-only mode ignores persisted hosted state without fetching', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const persisted = await seedLkg(settings);
  await settings.setSetting(MODEL_CATALOG_SETTING_KEYS.mode, 'bundled');
  resetModelCatalogActivationForTests();
  let fetches = 0;

  const result = await refreshModelCatalog({
    settings,
    force: true,
    now: () => NOW + 1_000,
    ownerId: 'bundled-only',
    fetch: async () => {
      fetches += 1;
      throw new Error('bundled-only mode must not fetch');
    },
  });

  assert.deepEqual(result, { status: 'bundled', revision: 0 });
  assert.equal(fetches, 0);
  assert.equal(await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg), persisted);
  assert.equal(activeModelCatalogSnapshot().source, 'bundled');
});

test('an outage with no LKG retains and activates the bundled catalog', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());

  const result = await refreshModelCatalog({
    settings,
    now: () => NOW,
    ownerId: 'cold-outage',
    fetch: async () => { throw new Error('source unavailable'); },
  });

  assert.deepEqual(result, { status: 'failed', revision: 0, code: 'unavailable' });
  assert.equal(await readModelCatalogLkg(settings), undefined);
  assert.equal(activeModelCatalogSnapshot().source, 'bundled');
  assert.equal(activeModelCatalogSnapshot().revision, 0);
});

test('a fresh LKG and a live competing lease each prevent another fetch', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await seedLkg(settings);
  let fetches = 0;
  const noFetch = async (): Promise<Response> => {
    fetches += 1;
    throw new Error('refresh must be deduplicated');
  };

  const fresh = await refreshModelCatalog({
    settings,
    now: () => NOW + 1_000,
    ownerId: 'fresh-reader',
    fetch: noFetch,
  });
  assert.deepEqual(fresh, { status: 'fresh', revision: 2 });
  assert.equal(fetches, 0);

  await settings.setSetting(MODEL_CATALOG_SETTING_KEYS.refreshLease, JSON.stringify({
    schemaVersion: 1,
    ownerId: 'other-winner',
    expiresAt: NOW + 20_000,
  }));
  const leaseHeld = await refreshModelCatalog({
    settings,
    force: true,
    now: () => NOW + 2_000,
    ownerId: 'lease-loser',
    fetch: noFetch,
  });
  assert.deepEqual(leaseHeld, { status: 'lease_held', revision: 2 });
  assert.equal(fetches, 0);
});

test('header timeout is safe and retains the last-known-good catalog', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const before = await seedLkg(settings);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => { fetchStarted = resolve; });

  const pending = refreshModelCatalog({
    settings,
    force: true,
    now: () => NOW + 1_000,
    ownerId: 'header-timeout',
    fetch: async (_input, init) => {
      fetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  await started;
  t.mock.timers.tick(5_001);

  assert.deepEqual(await pending, { status: 'failed', revision: 2, code: 'timeout' });
  assert.equal(await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg), before);
});

test('body timeout is safe and retains the last-known-good catalog', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const before = await seedLkg(settings);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });

  const pending = refreshModelCatalog({
    settings,
    force: true,
    now: () => NOW + 1_000,
    ownerId: 'body-timeout',
    fetch: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodyStarted();
        init?.signal?.addEventListener('abort', () => {
          controller.error(init.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      },
    }), { status: 200 }),
  });
  await started;
  t.mock.timers.tick(5_001);

  assert.deepEqual(await pending, { status: 'failed', revision: 2, code: 'timeout' });
  assert.equal(await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg), before);
});

test('oversized response metadata and invalid statuses retain LKG', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const before = await seedLkg(settings);

  const cases: Array<{ name: string; response: () => Response; code: string }> = [
    {
      name: 'content-length',
      response: () => new Response('{}', {
        status: 200,
        headers: { 'content-length': String(MODEL_CATALOG_MAX_BYTES) },
      }),
      code: 'response_oversized',
    },
    {
      name: 'headers',
      response: () => new Response('{}', {
        status: 200,
        headers: { 'x-padding': 'x'.repeat(MODEL_CATALOG_MAX_BYTES) },
      }),
      code: 'response_oversized',
    },
    {
      name: 'status',
      response: () => new Response('unavailable', { status: 503 }),
      code: 'http_503',
    },
  ];
  for (const candidate of cases) {
    const result = await refreshModelCatalog({
      settings,
      force: true,
      now: () => NOW + 1_000,
      ownerId: `invalid-${candidate.name}`,
      fetch: async () => candidate.response(),
    });
    assert.deepEqual(result, { status: 'failed', revision: 2, code: candidate.code });
    assert.equal(await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg), before);
  }
});

test('equal-revision equivocation and lower revisions never replace LKG', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const before = await seedLkg(settings);
  const equivocal = document(2);
  (equivocal.entries as Record<string, unknown>[])[0] = {
    ...((equivocal.entries as Record<string, unknown>[])[0] as Record<string, unknown>),
    displayName: 'Different bytes at the same revision',
  };

  const equivocation = await refreshModelCatalog({
    settings,
    force: true,
    now: () => NOW + 1_000,
    ownerId: 'equivocation',
    fetch: async () => new Response(JSON.stringify(equivocal), { status: 200 }),
  });
  assert.deepEqual(equivocation, { status: 'failed', revision: 2, code: 'equivocation' });
  assert.equal(await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg), before);

  const stale = await refreshModelCatalog({
    settings,
    force: true,
    now: () => NOW + 2_000,
    ownerId: 'stale',
    fetch: async () => new Response(JSON.stringify(document(1)), { status: 200 }),
  });
  assert.deepEqual(stale, { status: 'stale', revision: 2 });
  assert.equal(await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg), before);
});
