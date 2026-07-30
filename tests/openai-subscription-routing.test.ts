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
import type { BindOpenAiSubscriptionProviderOptions } from '../src/openai-subscription/provider.ts';

function profile(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_openai_route',
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

test('subscription routing maps to the isolated provider without resolving the Platform key', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const applied: string[] = [];
  let subscriptionBinds = 0;
  try {
    const agent = await agents.createAgent(profile());
    await saveOpenAiAuthMethod(settings, 'subscription');
    const route = await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
      settings,
      applyProviderKey: async (id) => { applied.push(id); },
      requireSubscriptionEnabled: () => {},
      bindSubscription: async () => { subscriptionBinds += 1; },
    });

    assert.deepEqual(route, {
      model: 'openai-subscription/gpt-5.4',
      providerAuthRoute: 'openai_subscription',
    });
    assert.equal(subscriptionBinds, 1);
    assert.deepEqual(applied, []);
  } finally {
    settings.close();
    agents.close();
  }
});

test('API-key routing preserves the canonical provider and never binds Subscription', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
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

test('invalid installation method state fails before either credential lane', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const events: string[] = [];
  try {
    await settings.setSetting(OPENAI_AUTH_METHOD_SETTING_KEY, 'unexpected');
    await assert.rejects(
      () => resolveRuntimeModel('agent_openai_route', 'openai/gpt-5.4', {
        settings,
        applyProviderKey: async (id) => { events.push(`key:${id}`); },
        bindSubscription: async () => { events.push('subscription'); },
      }),
      /Stored OpenAI authentication method is invalid/,
    );
    assert.deepEqual(events, []);
  } finally {
    settings.close();
  }
});

test('a frozen OpenAI model follows the installation method on the next Agent construction', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const events: string[] = [];
  try {
    const agent = await agents.createAgent(profile());
    await saveOpenAiAuthMethod(settings, 'subscription');
    const route = await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
      settings,
      applyProviderKey: async (id) => { events.push(`key:${id}`); },
      requireSubscriptionEnabled: () => {},
      bindSubscription: async () => { events.push('subscription'); },
    });

    assert.equal(route.providerAuthRoute, 'openai_subscription');
    assert.deepEqual(events, ['subscription']);
  } finally {
    settings.close();
    agents.close();
  }
});

test('subscription failures and unsupported models fail closed without crossing credential lanes', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const applied: string[] = [];
  let binds = 0;
  try {
    const agent = await agents.createAgent(profile());
    await saveOpenAiAuthMethod(settings, 'subscription');
    await assert.rejects(
      () => resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
        settings,
        applyProviderKey: async (id) => { applied.push(id); },
        requireSubscriptionEnabled: () => {},
        bindSubscription: async () => {
          binds += 1;
          throw new OpenAiSubscriptionError('auth_reconnect_required');
        },
      }),
      (error: unknown) =>
        error instanceof OpenAiSubscriptionError && error.code === 'auth_reconnect_required',
    );
    await assert.rejects(
      () => resolveRuntimeModel(agent.id, 'openai/../not-allowlisted', {
        settings,
        applyProviderKey: async (id) => { applied.push(id); },
        requireSubscriptionEnabled: () => {},
        bindSubscription: async () => { binds += 1; },
      }),
      (error: unknown) =>
        error instanceof OpenAiSubscriptionError && error.code === 'unsupported_model',
    );

    assert.equal(binds, 1, 'the invalid model must fail before credential binding');
    assert.deepEqual(applied, [], 'neither failure may resolve the Platform API key');
  } finally {
    settings.close();
    agents.close();
  }
});

test('the default-off preview gate blocks Subscription before either credential lane', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const events: string[] = [];
  try {
    const agent = await agents.createAgent(profile());
    await saveOpenAiAuthMethod(settings, 'subscription');
    await assert.rejects(
      () => resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
        settings,
        applyProviderKey: async (id) => { events.push(`key:${id}`); },
        requireSubscriptionEnabled: () => {
          events.push('gate');
          throw new OpenAiSubscriptionError('preview_disabled');
        },
        bindSubscription: async () => { events.push('subscription'); },
      }),
      (error: unknown) =>
        error instanceof OpenAiSubscriptionError && error.code === 'preview_disabled',
    );
    assert.deepEqual(events, ['gate']);
  } finally {
    settings.close();
    agents.close();
  }
});

test('non-OpenAI models bind only their selected key-backed provider', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
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

test('runtime admission loads a persisted hosted route without any catalog fetch', async (t) => {
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
  let captured: BindOpenAiSubscriptionProviderOptions | undefined;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('runtime catalog admission must not fetch');
  };
  try {
    const resolved = await resolveRuntimeModel(
      'agent_openai_route',
      'openai/gpt-hosted-runtime',
      {
        settings,
        requireSubscriptionEnabled: () => {},
        bindSubscription: async (options) => { captured = options; },
      },
    );
    assert.match(
      resolved.model,
      /^chickpea-openai-subscription-r73-[a-f0-9]{12}\/gpt-hosted-runtime$/,
    );
    assert.equal(canonicalRuntimeModel(resolved.model), 'openai/gpt-hosted-runtime');
    assert.equal(captured?.route?.snapshot.source, 'hosted');
    assert.equal(captured?.route?.snapshot.revision, 73);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
