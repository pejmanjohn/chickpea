import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { resetModelsForTests, resolveModel } from '@flue/runtime/internal';
import {
  invalidateProviderKeyCache,
  PROVIDER_KEY_SETTING_KEYS,
  rebindBuiltinProvider,
} from '../src/config/provider-keys.ts';
import { invalidateProviderModelCache } from '../src/config/provider-models.ts';
import { setWorkersAiRestPiProvider } from '../src/config/pi-provider.ts';
import { resolveRuntimeModel, RuntimeModelReadinessError } from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetModelsForTests();
  invalidateProviderKeyCache();
  invalidateProviderModelCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetModelsForTests();
  invalidateProviderKeyCache();
  invalidateProviderModelCache();
});

test('the app supplements the compatible Pi catalog with current Workers AI metadata', () => {
  setWorkersAiRestPiProvider({
    baseUrl: 'https://workers-ai.example.invalid/v1',
    contextWindowFloor: 32_768,
    maxTokens: 2_048,
  });
  const model = resolveModel('cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash');

  assert.equal(model.name, 'GLM 5.3 Flash');
  assert.equal(model.contextWindow, 32_768);
  assert.equal(model.maxTokens, 2_048);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.deepEqual(model.cost, {
    input: 0.15,
    output: 0.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  });
});

test('an OpenRouter model discovered live is registered before runtime resolution', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openrouter, 'openrouter-test-key');
    globalThis.fetch = async () => Response.json({
      data: [{
        id: 'acme/fresh-live-model',
        name: 'Acme Fresh Live Model',
        context_length: 196_608,
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['reasoning', 'tools'],
        top_provider: { max_completion_tokens: 32_768 },
        pricing: {
          prompt: '0.000002',
          completion: '0.000006',
          input_cache_read: '0.0000002',
          input_cache_write: '0.0000025',
        },
      }, {
        id: 'acme/untrusted-limits',
        name: 'Acme Untrusted Limits',
        context_length: 100_000_000,
        supported_parameters: [],
        top_provider: { max_completion_tokens: 10_000_000 },
        pricing: {
          prompt: '-1',
          completion: 'not-a-price',
        },
      }],
    });

    const route = await resolveRuntimeModel('agent_openrouter', 'openrouter/acme/fresh-live-model', {
      settings,
      loadCatalog: async () => ({ status: 'bundled', revision: 0 }),
    });
    const model = resolveModel(route.model);

    assert.equal(route.model, 'openrouter/acme/fresh-live-model');
    assert.equal(model.name, 'Acme Fresh Live Model');
    assert.equal(model.contextWindow, 196_608);
    assert.equal(model.maxTokens, 32_768);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.equal(model.cost.input, 2);
    assert.equal(model.cost.output, 6);
    assert.ok(Math.abs(model.cost.cacheRead - 0.2) < Number.EPSILON);
    assert.equal(model.cost.cacheWrite, 2.5);

    rebindBuiltinProvider('openrouter', 'rotated-key');
    assert.equal(
      resolveModel('openrouter/acme/fresh-live-model').name,
      'Acme Fresh Live Model',
    );

    const boundedRoute = await resolveRuntimeModel(
      'agent_openrouter',
      'openrouter/acme/untrusted-limits',
      {
        settings,
        loadCatalog: async () => ({ status: 'bundled', revision: 0 }),
      },
    );
    const bounded = resolveModel(boundedRoute.model);
    assert.equal(bounded.contextWindow, 2_000_000);
    assert.equal(bounded.maxTokens, 128_000);
    assert.equal(bounded.cost.input, -1_000_000);
    assert.equal(bounded.cost.output, -1_000_000);
  } finally {
    settings.close();
  }
});

test('an already-projected OpenRouter model survives a temporary catalog outage', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openrouter, 'openrouter-test-key');
    globalThis.fetch = async () => Response.json({
      data: [{ id: 'acme/warm-model', context_length: 64_000 }],
    });
    await resolveRuntimeModel('agent_openrouter', 'openrouter/acme/warm-model', {
      settings,
      loadCatalog: async () => ({ status: 'bundled', revision: 0 }),
    });

    invalidateProviderModelCache('openrouter');
    globalThis.fetch = async () => new Response('unavailable', { status: 502 });
    const route = await resolveRuntimeModel('agent_openrouter', 'openrouter/acme/warm-model', {
      settings,
      loadCatalog: async () => ({ status: 'bundled', revision: 0 }),
    });

    assert.equal(route.model, 'openrouter/acme/warm-model');
    assert.equal(resolveModel(route.model).contextWindow, 64_000);
  } finally {
    settings.close();
  }
});

test('a cold OpenRouter catalog outage reports a repairable readiness error', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openrouter, 'openrouter-test-key');
    globalThis.fetch = async () => new Response('unavailable', { status: 502 });

    await assert.rejects(
      () => resolveRuntimeModel('agent_openrouter', 'openrouter/acme/cold-model', {
        settings,
        loadCatalog: async () => ({ status: 'bundled', revision: 0 }),
      }),
      (error: unknown) =>
        error instanceof RuntimeModelReadinessError &&
        error.status === 'provider_setup_required' &&
        error.providerId === 'openrouter',
    );
  } finally {
    settings.close();
  }
});

test('an OpenRouter favorite removed from the live catalog fails before execution', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openrouter, 'openrouter-test-key');
    globalThis.fetch = async () => Response.json({ data: [] });

    await assert.rejects(
      () => resolveRuntimeModel('agent_openrouter', 'openrouter/acme/retired-model', {
        settings,
        loadCatalog: async () => ({ status: 'bundled', revision: 0 }),
      }),
      (error: unknown) =>
        error instanceof RuntimeModelReadinessError &&
        error.status === 'unsupported' &&
        error.providerId === 'openrouter',
    );
  } finally {
    settings.close();
  }
});
