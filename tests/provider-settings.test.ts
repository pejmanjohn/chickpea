import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  invalidateProviderKeyCache,
  PROVIDER_KEY_SETTING_KEYS,
  resolveProviderApiKey,
} from '../src/config/provider-keys.ts';
import {
  invalidateProviderModelCache,
  listProviderModels,
  ProviderUnreachableError,
  WORKERS_AI_DEFAULT_FAVORITES,
} from '../src/config/provider-models.ts';
import { forgetRegisteredProvider } from '../src/config/providers.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { FAKE_PROVIDER_KEYS, FakeProvidersBackend } from './helpers/fake-providers.ts';
import { withEnv } from './helpers/env.ts';

const ADMIN_TOKEN = 'provider-admin-token';

function auth(): HeadersInit {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

function appWithProviderAdmin(): {
  app: Hono;
  config: SqliteConfigStore;
  settings: SqliteSettingsStore;
  close: () => void;
} {
  // The model cache is module-level (per-isolate in production); a fresh test
  // app must start cold or tests become order-dependent — a list cached by an
  // earlier test would mask this app's own credential/availability behavior.
  invalidateProviderModelCache();
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  app.route(
    '/',
    createAdminRoutes({
      store: config,
      settings,
      adminToken: ADMIN_TOKEN,
      knownProviders: new Set(['anthropic', 'openai', 'openrouter', 'workers-ai']),
    }),
  );
  return {
    app,
    config,
    settings,
    close: () => {
      config.close();
      settings.close();
    },
  };
}

function providerSettingsAgent(id: string, model: string) {
  return {
    id,
    name: id,
    description: 'Provider settings matrix fixture.',
    instructions: 'Exercise provider settings endpoints.',
    enabled: true,
    model,
    skills: [],
    mcpServers: [],
  };
}

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

async function assertProviderDeadline(
  run: () => Promise<unknown>,
  provider: 'openrouter' | 'workers-ai',
  timeoutMs: number,
): Promise<void> {
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    guardTimer = setTimeout(() => reject(new Error('provider deadline did not settle')), 100);
  });

  try {
    await assert.rejects(
      () => Promise.race([run(), guard]),
      (err: unknown) =>
        err instanceof ProviderUnreachableError &&
        err.provider === provider &&
        err.message === `Provider ${provider} request timed out after ${timeoutMs}ms`,
    );
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
  }
}

test('provider key resolution prefers environment keys over stored settings', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    invalidateProviderKeyCache();
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.anthropic, 'stored-anthropic-key');

    await withEnv({ ANTHROPIC_API_KEY: 'env-anthropic-key' }, async () => {
      const resolved = await resolveProviderApiKey('anthropic', undefined, settings);

      assert.deepEqual(resolved, {
        apiKey: 'env-anthropic-key',
        source: 'env',
      });
    });
  } finally {
    settings.close();
    invalidateProviderKeyCache();
  }
});

test('provider key POST validates, stores, primes model cache, and rejects bad keys', async () => {
  const fake = new FakeProvidersBackend();
  const { app, settings, close } = appWithProviderAdmin();
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_URL: 'https://anthropic.fake',
      },
      async () =>
        withFetch(fake.asFetch(), async () => {
          const saved = await app.request('/admin/api/providers/anthropic/key', {
            method: 'POST',
            headers: { ...auth(), 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.anthropic }),
          });

          assert.equal(saved.status, 200);
          assert.deepEqual(await saved.json(), {
            ok: true,
            provider: { id: 'anthropic', status: 'stored', modelCount: 2 },
            models: [
              { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
              { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
            ],
          });
          assert.equal(
            await settings.getSetting(PROVIDER_KEY_SETTING_KEYS.anthropic),
            FAKE_PROVIDER_KEYS.anthropic,
          );

          const rejected = await app.request('/admin/api/providers/anthropic/key', {
            method: 'POST',
            headers: { ...auth(), 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: 'bad-key' }),
          });

          assert.equal(rejected.status, 422);
          assert.deepEqual(await rejected.json(), {
            error: 'provider_key_rejected',
            provider: 'anthropic',
            status: 401,
            detail: 'authentication_error: invalid x-api-key',
          });
          assert.equal(
            await settings.getSetting(PROVIDER_KEY_SETTING_KEYS.anthropic),
            FAKE_PROVIDER_KEYS.anthropic,
          );
        }),
    );
  } finally {
    close();
  }
});

test('provider key POST returns 502 and stores nothing when validation is unreachable', async () => {
  const fake = new FakeProvidersBackend();
  fake.unreachableHosts.add('openai.fake');
  const { app, settings, close } = appWithProviderAdmin();
  try {
    await withEnv(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_API_URL: 'https://openai.fake/v1',
      },
      async () =>
        withFetch(fake.asFetch(), async () => {
          const response = await app.request('/admin/api/providers/openai/key', {
            method: 'POST',
            headers: { ...auth(), 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: FAKE_PROVIDER_KEYS.openai }),
          });

          assert.equal(response.status, 502);
          assert.deepEqual(await response.json(), {
            error: 'provider_unreachable',
            provider: 'openai',
          });
          assert.equal(await settings.getSetting(PROVIDER_KEY_SETTING_KEYS.openai), undefined);
        }),
    );
  } finally {
    close();
  }
});

test('provider settings endpoint matrix reports sources, enforces env read-only keys, counts pinned profiles, and validates favorites bodies', async () => {
  const { app, config, settings, close } = appWithProviderAdmin();
  try {
    invalidateProviderKeyCache();
    invalidateProviderModelCache();
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openai, FAKE_PROVIDER_KEYS.openai);
    await config.createAgent(providerSettingsAgent('agent_openai_pinned', 'openai/gpt-4.1'));

    await withEnv(
      {
        ANTHROPIC_API_KEY: FAKE_PROVIDER_KEYS.anthropic,
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
      },
      async () => {
        const summary = await app.request('/admin/api/providers', { headers: auth() });
        assert.equal(summary.status, 200);
        const body = (await summary.json()) as {
          providers: Array<{ id: string; status: string; modelCount: number | null }>;
        };
        const byId = Object.fromEntries(body.providers.map((provider) => [provider.id, provider]));
        assert.equal(byId.anthropic?.status, 'env');
        assert.equal(byId.openai?.status, 'stored');
        assert.equal(byId.openrouter?.status, 'missing');
        assert.equal(byId['workers-ai']?.status, 'missing');

        const readOnly = await app.request('/admin/api/providers/anthropic/key', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ key: FAKE_PROVIDER_KEYS.anthropic }),
        });
        assert.equal(readOnly.status, 409);
        assert.deepEqual(await readOnly.json(), {
          error: 'provider_key_read_only',
          provider: 'anthropic',
        });
        assert.equal(await settings.getSetting(PROVIDER_KEY_SETTING_KEYS.anthropic), undefined);

        const removed = await app.request('/admin/api/providers/openai/key', {
          method: 'DELETE',
          headers: auth(),
        });
        assert.equal(removed.status, 200);
        assert.deepEqual(await removed.json(), {
          ok: true,
          provider: { id: 'openai', status: 'missing', modelCount: null },
          pinnedProfileCount: 1,
        });
        assert.equal(await settings.getSetting(PROVIDER_KEY_SETTING_KEYS.openai), undefined);

        const invalidFavorites = await app.request('/admin/api/providers/openrouter/favorites', {
          method: 'PUT',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ favorites: ['anthropic/claude-sonnet-4', 42] }),
        });
        assert.equal(invalidFavorites.status, 400);
        assert.deepEqual(await invalidFavorites.json(), { error: 'invalid_request' });

        const unsupportedFavorites = await app.request('/admin/api/providers/anthropic/favorites', {
          headers: auth(),
        });
        assert.equal(unsupportedFavorites.status, 404);
        assert.deepEqual(await unsupportedFavorites.json(), { error: 'unknown_provider' });
      },
    );
  } finally {
    close();
    invalidateProviderKeyCache();
    invalidateProviderModelCache();
  }
});

test('provider models proxy caches OpenAI chat models and refresh bypasses the cache', async () => {
  const fake = new FakeProvidersBackend();
  const { app, close } = appWithProviderAdmin();
  try {
    await withEnv(
      {
        OPENAI_API_KEY: FAKE_PROVIDER_KEYS.openai,
        OPENAI_API_URL: 'https://openai.fake/v1',
      },
      async () =>
        withFetch(fake.asFetch(), async () => {
          const first = await app.request('/admin/api/providers/openai/models', {
            headers: auth(),
          });
          assert.equal(first.status, 200);
          assert.deepEqual(await first.json(), {
            provider: 'openai',
            models: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }],
            cached: false,
          });
          assert.equal(fake.callsFor('/v1/models').length, 1);

          fake.setOpenAiModels([{ id: 'gpt-5.5' }, { id: 'text-embedding-4-large' }]);
          const cached = await app.request('/admin/api/providers/openai/models', {
            headers: auth(),
          });
          assert.equal(cached.status, 200);
          assert.deepEqual(await cached.json(), {
            provider: 'openai',
            models: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }],
            cached: true,
          });
          assert.equal(fake.callsFor('/v1/models').length, 1);

          const refreshed = await app.request('/admin/api/providers/openai/models?refresh=1', {
            headers: auth(),
          });
          assert.equal(refreshed.status, 200);
          assert.deepEqual(await refreshed.json(), {
            provider: 'openai',
            models: [{ id: 'gpt-5.5' }],
            cached: false,
          });
          assert.equal(fake.callsFor('/v1/models').length, 2);
        }),
    );
  } finally {
    close();
  }
});

test('provider model requests abort when the upstream never responds', async () => {
  invalidateProviderModelCache('openrouter');
  const hangingFetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    assert.ok(init?.signal, 'provider request must carry an abort signal');
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  }) as typeof fetch;

  await withFetch(hangingFetch, async () => {
    await assert.rejects(
      () => listProviderModels('openrouter', { refresh: true, timeoutMs: 10 }),
      (err: unknown) =>
        err instanceof ProviderUnreachableError &&
        err.message === 'Provider openrouter request timed out after 10ms',
    );
  });
});

test('provider model deadline includes response body consumption', async () => {
  invalidateProviderModelCache('openrouter');
  let releaseBody = () => {};
  const stalledBodyFetch = (async (): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['));
        releaseBody = () => controller.error(new Error('test cleanup'));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await withFetch(stalledBodyFetch, () =>
      assertProviderDeadline(
        () => listProviderModels('openrouter', { refresh: true, timeoutMs: 10 }),
        'openrouter',
        10,
      ),
    );
  } finally {
    releaseBody();
  }
});

test('Workers AI binding model listing respects the provider deadline', async () => {
  invalidateProviderModelCache('workers-ai');
  await assertProviderDeadline(
    () =>
      listProviderModels('workers-ai', {
        env: {
          AI: {
            models: async () => new Promise<never>(() => {}),
          },
        } as PlatformEnv,
        refresh: true,
        timeoutMs: 10,
      }),
    'workers-ai',
    10,
  );
});

test('Workers AI model listing uses model names from binding and REST search results', async () => {
  invalidateProviderModelCache('workers-ai');
  const bindingResult = await listProviderModels('workers-ai', {
    env: {
      AI: {
        models: async () => [
          { id: '11111111-1111-4111-8111-111111111111', name: '@cf/moonshotai/kimi-k2.6' },
          { id: '22222222-2222-4222-8222-222222222222', name: '@cf/zai-org/glm-5.2' },
        ],
      },
    } as PlatformEnv,
    refresh: true,
  });
  assert.deepEqual(bindingResult.models, [
    { id: '@cf/moonshotai/kimi-k2.6' },
    { id: '@cf/zai-org/glm-5.2' },
  ]);

  invalidateProviderModelCache('workers-ai');
  const fake = new FakeProvidersBackend();
  await withEnv(
    {
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      CLOUDFLARE_API_URL: 'https://cloudflare.fake/client/v4',
    },
    async () =>
      withFetch(fake.asFetch(), async () => {
        const restResult = await listProviderModels('workers-ai', { refresh: true });
        assert.deepEqual(restResult.models, [
          { id: '@cf/moonshotai/kimi-k2.6' },
          { id: '@cf/zai-org/glm-5.2' },
        ]);
      }),
  );
});

test('provider favorites seed Workers AI defaults and round-trip curated arrays', async () => {
  const { app, settings, close } = appWithProviderAdmin();
  try {
    const seeded = await app.request('/admin/api/providers/workers-ai/favorites', {
      headers: auth(),
    });
    assert.equal(seeded.status, 200);
    assert.deepEqual(await seeded.json(), {
      provider: 'workers-ai',
      favorites: WORKERS_AI_DEFAULT_FAVORITES,
    });
    assert.equal(
      await settings.getSetting('provider.workers-ai.favorites'),
      JSON.stringify(WORKERS_AI_DEFAULT_FAVORITES),
    );

    const saved = await app.request('/admin/api/providers/openrouter/favorites', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ favorites: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1'] }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      provider: 'openrouter',
      favorites: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1'],
    });

    const roundTrip = await app.request('/admin/api/providers/openrouter/favorites', {
      headers: auth(),
    });
    assert.equal(roundTrip.status, 200);
    assert.deepEqual(await roundTrip.json(), {
      provider: 'openrouter',
      favorites: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1'],
    });
  } finally {
    close();
  }
});

test('models endpoint applies stored provider keys before composing provider groups', async () => {
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  app.route('/', createAdminRoutes({ store: config, settings, adminToken: ADMIN_TOKEN }));
  try {
    invalidateProviderKeyCache();
    forgetRegisteredProvider('anthropic');
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.anthropic, FAKE_PROVIDER_KEYS.anthropic);

    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        const response = await app.request('/admin/api/models', { headers: auth() });
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          providers: Array<{ id: string; configured: boolean; source: string }>;
        };
        const anthropic = body.providers.find((provider) => provider.id === 'anthropic');
        assert.ok(anthropic);
        assert.equal(anthropic.configured, true);
        assert.equal(anthropic.source, 'registered in src/app.ts');
      },
    );
  } finally {
    forgetRegisteredProvider('anthropic');
    invalidateProviderKeyCache();
    config.close();
    settings.close();
  }
});

test('models endpoint folds OpenRouter favorites into the picker suggestions (no Automatic)', async () => {
  const { app, close } = appWithProviderAdmin();
  try {
    await app.request('/admin/api/providers/openrouter/favorites', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ favorites: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1'] }),
    });

    const response = await app.request('/admin/api/models', { headers: auth() });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      automatic?: unknown;
      providers: Array<{ id: string; configured: boolean; suggestions: string[] }>;
    };
    // The explicit-only ruling removed the Automatic entry entirely.
    assert.equal(body.automatic, undefined);
    assert.equal(Object.hasOwn(body, 'defaultModels'), false);
    // The OpenRouter picker group is EXACTLY the starred favorites, prefixed with
    // the provider id — the raw 343-model list stays behind the Settings search.
    const openrouter = body.providers.find((provider) => provider.id === 'openrouter');
    assert.ok(openrouter);
    assert.deepEqual(openrouter.suggestions, [
      'openrouter/anthropic/claude-sonnet-4',
      'openrouter/openai/gpt-4.1',
    ]);
    // Anthropic keeps its small dynamic catalog (favorites folding is scoped).
    const anthropic = body.providers.find((provider) => provider.id === 'anthropic');
    assert.ok(anthropic);
    assert.ok(anthropic.suggestions.includes('anthropic/claude-sonnet-4-6'));
  } finally {
    close();
  }
});

test('Workers AI models return 409 on node when REST credentials are absent', async () => {
  const { app, close } = appWithProviderAdmin();
  try {
    await withEnv(
      {
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
      },
      async () => {
        const response = await app.request('/admin/api/providers/workers-ai/models', {
          headers: auth(),
        });

        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: 'workers_ai_credentials_required',
          provider: 'workers-ai',
        });
      },
    );
  } finally {
    close();
  }
});
