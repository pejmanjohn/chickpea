import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveRuntimeModel, canonicalRuntimeModel } from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { OpenAiSubscriptionError } from '../src/openai-subscription/errors.ts';

function profile(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_openai_route',
    name: 'OpenAI route',
    instructions: 'Use the selected OpenAI lane.',
    enabled: true,
    model: 'openai/gpt-5.4',
    openaiAuthMethod: 'subscription',
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
    const route = await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
      agents,
      settings,
      applyProviderKey: async (id) => { applied.push(id); },
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
    const agent = await agents.createAgent(profile({ openaiAuthMethod: 'api_key' }));
    const route = await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
      agents,
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

test('a frozen OpenAI model follows the live profile method on the next Agent construction', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const events: string[] = [];
  try {
    const agent = await agents.createAgent(profile({ openaiAuthMethod: 'api_key' }));
    await agents.updateAgent(agent.id, { openaiAuthMethod: 'subscription' });
    const route = await resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
      agents,
      settings,
      applyProviderKey: async (id) => { events.push(`key:${id}`); },
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
    await assert.rejects(
      () => resolveRuntimeModel(agent.id, 'openai/gpt-5.4', {
        agents,
        settings,
        applyProviderKey: async (id) => { applied.push(id); },
        bindSubscription: async () => {
          binds += 1;
          throw new OpenAiSubscriptionError('auth_reconnect_required');
        },
      }),
      (error: unknown) =>
        error instanceof OpenAiSubscriptionError && error.code === 'auth_reconnect_required',
    );
    await assert.rejects(
      () => resolveRuntimeModel(agent.id, 'openai/not-allowlisted', {
        agents,
        settings,
        applyProviderKey: async (id) => { applied.push(id); },
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

test('non-OpenAI models bind only their selected key-backed provider', async () => {
  const agents = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const applied: string[] = [];
  try {
    const anthropic = profile({ model: 'anthropic/claude-sonnet-4-6' });
    delete anthropic.openaiAuthMethod;
    const agent = await agents.createAgent(anthropic);
    assert.deepEqual(
      await resolveRuntimeModel(agent.id, 'anthropic/claude-sonnet-4-6', {
        agents,
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
