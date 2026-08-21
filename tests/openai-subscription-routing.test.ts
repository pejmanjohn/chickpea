import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveRuntimeModel, canonicalRuntimeModel } from '../src/config/runtime-model.ts';
import {
  OPENAI_AUTH_METHOD_SETTING_KEY,
  saveOpenAiAuthMethod,
} from '../src/config/openai-auth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { resetModelCatalogActivationForTests } from '../src/model-catalog/catalog.ts';
import { acceptModelCatalogCandidate } from '../src/model-catalog/store.ts';
import { OpenAiSubscriptionError } from '../src/openai-subscription/errors.ts';

function profile(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_openai_route',
    revision: 1,
    name: 'OpenAI route',
    instructions: 'Use the selected OpenAI lane.',
    enabled: true,
    model: 'openai/gpt-5.4',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...overrides,
  };
}

test('a legacy Subscription selection is normalized to the Platform API-key route', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const applied: string[] = [];
  let subscriptionBinds = 0;
  try {
    const agent = await agents.createAgent(profile());
    await saveOpenAiAuthMethod(settings, 'subscription');
    const route = await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
      settings,
      applyProviderKey: async (id) => { applied.push(id); },
      bindSubscription: async () => { subscriptionBinds += 1; },
    });

    assert.deepEqual(route, {
      model: 'openai/gpt-5.4',
      providerAuthRoute: 'openai_api_key',
    });
    assert.equal(subscriptionBinds, 0);
    assert.deepEqual(applied, ['openai']);
    assert.equal(await settings.getSetting(OPENAI_AUTH_METHOD_SETTING_KEY), 'api_key');
  } finally {
    settings.close();
    agents.close();
  }
});

test('API-key routing preserves the canonical provider and never binds Subscription', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const applied: string[] = [];
  let subscriptionBinds = 0;
  try {
    const agent = await agents.createAgent(profile());
    const route = await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
      settings,
      applyProviderKey: async (id) => { applied.push(id); },
      bindSubscription: async () => { subscriptionBinds += 1; },
    });

    assert.deepEqual(route, {
      model: 'openai/gpt-5.4',
      providerAuthRoute: 'openai_api_key',
    });
    assert.deepEqual(applied, ['openai']);
    assert.equal(subscriptionBinds, 0);
  } finally {
    settings.close();
    agents.close();
  }
});

test('invalid legacy installation method state is normalized to the API-key lane', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const events: string[] = [];
  try {
    await settings.setSetting(OPENAI_AUTH_METHOD_SETTING_KEY, 'unexpected');
    assert.deepEqual(
      await resolveRuntimeModel('agent_openai_route', 'openai/gpt-5.4', {
        settings,
        applyProviderKey: async (id) => { events.push(`key:${id}`); },
        bindSubscription: async () => { events.push('subscription'); },
      }),
      { model: 'openai/gpt-5.4', providerAuthRoute: 'openai_api_key' },
    );
    assert.deepEqual(events, ['key:openai']);
    assert.equal(await settings.getSetting(OPENAI_AUTH_METHOD_SETTING_KEY), 'api_key');
  } finally {
    settings.close();
  }
});

test('a frozen OpenAI model stays on API-key routing after a legacy Subscription write', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const events: string[] = [];
  try {
    const agent = await agents.createAgent(profile());
    await saveOpenAiAuthMethod(settings, 'subscription');
    const route = await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
      settings,
      applyProviderKey: async (id) => { events.push(`key:${id}`); },
      bindSubscription: async () => { events.push('subscription'); },
    });

    assert.equal(route.providerAuthRoute, 'openai_api_key');
    assert.deepEqual(events, ['key:openai']);
  } finally {
    settings.close();
    agents.close();
  }
});

test('retired Subscription callbacks cannot intercept OpenAI API-key routing', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const applied: string[] = [];
  let binds = 0;
  try {
    const agent = await agents.createAgent(profile());
    await saveOpenAiAuthMethod(settings, 'subscription');
    assert.deepEqual(
      await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
        settings,
        applyProviderKey: async (id) => { applied.push(id); },
        bindSubscription: async () => {
          binds += 1;
          throw new OpenAiSubscriptionError('auth_reconnect_required');
        },
      }),
      { model: 'openai/gpt-5.4', providerAuthRoute: 'openai_api_key' },
    );
    await assert.rejects(
      () => resolveRuntimeModel(agent.id, 'openai/../not-allowlisted', {
        settings,
        applyProviderKey: async (id) => { applied.push(id); },
        bindSubscription: async () => { binds += 1; },
      }),
      /not supported by this Chickpea release/i,
    );

    assert.equal(binds, 0);
    assert.deepEqual(applied, ['openai']);
  } finally {
    settings.close();
    agents.close();
  }
});

test('non-OpenAI models bind only their selected key-backed provider', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const applied: string[] = [];
  try {
    const anthropic = profile({ model: 'anthropic/claude-sonnet-4-6' });
    const agent = await agents.createAgent(anthropic);
    assert.deepEqual(
      await resolveRuntimeModel(agent.id, 'anthropic/claude-sonnet-4-6', {
        settings,
        applyProviderKey: async (id) => { applied.push(id); },
        bindSubscription: async () => { throw new Error('must not bind'); },
      }),
      { model: 'anthropic/claude-sonnet-4-6' },
    );
    assert.deepEqual(applied, ['anthropic']);
    assert.equal(canonicalRuntimeModel('openai-subscription/gpt-5.4'), 'openai/gpt-5.4');
  } finally {
    settings.close();
    agents.close();
  }
});

test('profiles cannot address the internal subscription provider directly', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await assert.rejects(
    () => resolveRuntimeModel(
      'agent_openai_route',
      'openai-subscription/gpt-5.4',
      {
        settings,
        applyProviderKey: async () => { throw new Error('must not resolve a key'); },
        bindSubscription: async () => { throw new Error('must not bind'); },
      },
    ),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'unsupported_model',
  );
});

test('runtime admission rejects a persisted Subscription-only hosted route without fetching', async (t) => {
  resetModelCatalogActivationForTests();
  t.after(resetModelCatalogActivationForTests);
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision: 73,
    generatedAt: '2026-07-29T20:00:00Z',
    entries: [{
      canonical: 'openai/gpt-hosted-runtime',
      lanes: { subscription: 'openai-codex-responses-standard@1' },
    }],
  }));
  await acceptModelCatalogCandidate(settings, {
    bytes,
    checkedAt: 1,
    nextRefreshAt: 2,
  });
  await saveOpenAiAuthMethod(settings, 'subscription');

  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('runtime catalog admission must not fetch');
  };
  try {
    await assert.rejects(
      () => resolveRuntimeModel(
        'agent_openai_route',
        'openai/gpt-hosted-runtime',
        { settings, bindSubscription: async () => { throw new Error('must not bind'); } },
      ),
      /not supported by this Chickpea release/i,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
