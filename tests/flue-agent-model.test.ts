import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

// `resolveModel` is not re-exported from the root `@flue/runtime` entry point,
// but it is a documented public subpath export (see the `"./internal"` entry
// in @flue/runtime's package.json `exports` map) — not a reach into an
// unlisted dist file. It is the only way to drive Flue's real model
// resolution from a test.
import { resolveModel } from '@flue/runtime/internal';

import { WORKERS_AI_CONTEXT_WINDOW_FLOOR } from '../src/app.ts';
import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  bindModelCompatibilityProvider,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
} from '../src/model-compat/provider.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  legacySlackThreadAgent as slackThreadAgent,
  resolveAgentModel,
  thinkingLevelForModel,
} from '../src/agents/slack-thread.ts';
import { demoExecChannelAssignment, seededAgents } from '../src/config/seed.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const THREAD_KEY = 'T_DEMO:C_EXEC:1782770400.000100';

function modelAgent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_model',
    name: 'Model Agent',
    instructions: 'Model policy instructions.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...overrides,
  };
}

test('the REST Workers AI registration supplies the context-window floor used for compaction', () => {
  const resolved = resolveModel('cloudflare-workers-ai/@cf/zai-org/glm-5.2');

  assert.equal(resolved.provider, 'cloudflare-workers-ai');
  assert.equal(resolved.contextWindow, WORKERS_AI_CONTEXT_WINDOW_FLOOR);
  assert.ok(resolved.contextWindow > 0);
});

test('Pi-native suggestions bypass Chickpea compatibility providers', () => {
  const expected = [
    ['anthropic/claude-fable-5', 'anthropic-messages', 1_000_000, 128_000],
    ['anthropic/claude-haiku-4-5', 'anthropic-messages', 200_000, 64_000],
    ['openai/gpt-5.5', 'openai-responses', 272_000, 128_000],
    ['openai/gpt-5.4', 'openai-responses', 272_000, 128_000],
    ['openai/gpt-5.4-mini', 'openai-responses', 400_000, 128_000],
    ['openai/gpt-5.3-codex-spark', 'openai-responses', 128_000, 32_000],
  ] as const;

  for (const [specifier, api, contextWindow, maxTokens] of expected) {
    const model = resolveModel(specifier);
    assert.equal(model.api, api, specifier);
    assert.equal(model.contextWindow, contextWindow, specifier);
    assert.equal(model.maxTokens, maxTokens, specifier);
    assert.equal(model.input.includes('image'), true, specifier);
  }
});

test('reviewed Pi gaps resolve through bounded internal compatibility providers', () => {
  bindModelCompatibilityProvider('openai', 'test-openai-key');
  bindModelCompatibilityProvider('anthropic', 'test-anthropic-key');
  const expected = [
    [`${ANTHROPIC_COMPAT_PROVIDER_ID}/claude-opus-5`, 'chickpea-anthropic-messages-bundled-v1', 1_000_000, 128_000],
    [`${ANTHROPIC_COMPAT_PROVIDER_ID}/claude-sonnet-5`, 'chickpea-anthropic-messages-bundled-v1', 1_000_000, 128_000],
    [`${OPENAI_PLATFORM_COMPAT_PROVIDER_ID}/gpt-5.6-sol`, 'chickpea-openai-platform-responses-bundled-v1', 272_000, 128_000],
    [`${OPENAI_PLATFORM_COMPAT_PROVIDER_ID}/gpt-5.6-terra`, 'chickpea-openai-platform-responses-bundled-v1', 272_000, 128_000],
    [`${OPENAI_PLATFORM_COMPAT_PROVIDER_ID}/gpt-5.6-luna`, 'chickpea-openai-platform-responses-bundled-v1', 272_000, 128_000],
  ] as const;

  for (const [specifier, api, contextWindow, maxTokens] of expected) {
    const model = resolveModel(specifier);
    assert.equal(model.api, api, specifier);
    assert.equal(model.contextWindow, contextWindow, specifier);
    assert.equal(model.maxTokens, maxTokens, specifier);
  }
});

test('Flue resolves the model specifier produced by the slack-thread agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-model-seed-'));
  const dbPath = join(dir, 'state.db');
  const pinnedSeedAgents = seededAgents.map((agent) => ({
    ...agent,
    model: 'cloudflare-workers-ai/@cf/zai-org/glm-5.2',
  }));
  const store = new SqliteConfigStore(dbPath, {
    agents: pinnedSeedAgents,
    assignments: [
      demoExecChannelAssignment,
      { workspaceId: '*', channelId: '*', agentId: 'agent_default', enabled: true },
    ],
  });
  store.close();

  // The `cloudflare-workers-ai` provider id is in Flue's model catalog, but
  // the specific seeded model id is not — so it must be registered before
  // resolution will admit it. An empty registration is enough for a catalog
  // provider id to hydrate from the catalog and admit arbitrary model-id
  // suffixes under it.
  try {
    const config = await withEnv(
      {
        SLACK_STATE_DB_PATH: dbPath,
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: 'cf-token',
        CLOUDFLARE_ACCOUNT_ID: 'cf-account',
        SLACK_TAG_MODEL: undefined,
      },
      () => slackThreadAgent.initialize({ id: THREAD_KEY, env: {} }),
    );

    assert.equal(typeof config.model, 'string');

    const resolved = resolveModel(config.model as string);

    assert.ok(resolved, 'resolveModel should return a resolved model, not throw or return nothing');
    assert.equal(resolved.provider, 'cloudflare-workers-ai');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model policy prefers an explicit per-agent model over provider credentials and SLACK_TAG_MODEL', () => {
  assert.equal(
    resolveAgentModel(
      modelAgent({ model: 'local-stub/agent-pinned' }),
      {
        ANTHROPIC_API_KEY: 'anthropic-key',
        CLOUDFLARE_API_TOKEN: 'cf-token',
        CLOUDFLARE_ACCOUNT_ID: 'cf-account',
        SLACK_TAG_MODEL: 'local-stub/fallback',
      },
    ),
    'local-stub/agent-pinned',
  );
});

test('model policy ignores provider credentials for unpinned agents and uses SLACK_TAG_MODEL', () => {
  assert.equal(
    resolveAgentModel(modelAgent(), {
      ANTHROPIC_API_KEY: 'anthropic-key',
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      SLACK_TAG_MODEL: 'local-stub/offline-fallback',
    }),
    'local-stub/offline-fallback',
  );
});

test('model policy fails with the /admin fix when an unpinned agent has no fallback', () => {
  assert.throws(
    () =>
      resolveAgentModel(modelAgent(), {
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        SLACK_TAG_MODEL: undefined,
      }),
    /No model pinned for agent agent_model.*Pin a model in \/admin.*SLACK_TAG_MODEL/s,
  );
});

test('model policy warns once per unbounded Workers AI binding model', () => {
  const model = 'cloudflare/@cf/test/unbounded-warning';
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    assert.equal(resolveAgentModel(modelAgent({ model })), model);
    assert.equal(resolveAgentModel(modelAgent({ model })), model);
    assert.equal(
      resolveAgentModel(
        modelAgent({ model: 'cloudflare-workers-ai/@cf/test/bounded-rest-provider' }),
      ),
      'cloudflare-workers-ai/@cf/test/bounded-rest-provider',
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /contextWindow 0.*auto-compaction is disabled.*grow unbounded/);
});

test('the keyless GLM default disables extra reasoning without changing other models', () => {
  assert.equal(thinkingLevelForModel('cloudflare/@cf/zai-org/glm-5.2'), 'off');
  assert.equal(
    thinkingLevelForModel('cloudflare-workers-ai/@cf/zai-org/glm-5.2'),
    undefined,
  );
  assert.equal(thinkingLevelForModel('cloudflare/@cf/openai/gpt-oss-120b'), undefined);
  assert.equal(thinkingLevelForModel('anthropic/claude-sonnet-4-6'), undefined);
});

test('slack-thread wires the GLM binding override only into the exact model config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-thinking-policy-'));
  const dbPath = join(dir, 'state.db');
  const store = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
  for (const [id, model, channelId] of [
    ['agent_binding', 'cloudflare/@cf/zai-org/glm-5.2', 'C_BINDING'],
    ['agent_rest', 'cloudflare-workers-ai/@cf/zai-org/glm-5.2', 'C_REST'],
  ] as const) {
    await store.createAgent(modelAgent({ id, model }));
    await store.putAssignment({ workspaceId: 'T_POLICY', channelId, agentId: id, enabled: true });
  }
  store.close();

  try {
    const [bindingConfig, restConfig] = await withEnv(
      { SLACK_STATE_DB_PATH: dbPath, SLACK_TAG_MODEL: undefined },
      () =>
        Promise.all([
          slackThreadAgent.initialize({ id: 'T_POLICY:C_BINDING:1782770400.000100', env: {} }),
          slackThreadAgent.initialize({ id: 'T_POLICY:C_REST:1782770400.000100', env: {} }),
        ]),
    );

    assert.equal(bindingConfig.thinkingLevel, 'off');
    assert.equal(restConfig.thinkingLevel, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slack-thread initializes from the SQLite config store for the current state DB path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-agent-config-'));
  const dbPath = join(dir, 'state.db');
  const store = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
  await store.createAgent({
    id: 'agent_runtime',
    name: 'Runtime Agent',
    instructions: 'Runtime configured instructions.',
    enabled: true,
    model: 'local-stub/runtime-pinned',
    skills: [
      {
        name: 'runtime-skill',
        description: 'A skill materialized end-to-end through the factory.',
        instructions: '# Runtime Skill\n\nDo the runtime thing.',
        enabled: true,
      },
      // Disabled skill must NOT be materialized.
      {
        name: 'disabled-skill',
        description: 'Should not appear.',
        instructions: '# Disabled',
        enabled: false,
      },
    ],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await store.putAssignment({
    workspaceId: 'T_RUNTIME',
    channelId: 'C_RUNTIME',
    agentId: 'agent_runtime',
    enabled: true,
  });
  store.close();

  try {
    const config = await withEnv(
      {
        SLACK_STATE_DB_PATH: dbPath,
        SLACK_TAG_MODEL: 'local-stub/runtime-fallback',
        // Scrub ambient provider creds so this test stays independent of
        // developer/CI provider state even though model policy ignores them.
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
      },
      async () => {
        return slackThreadAgent.initialize({
          id: 'T_RUNTIME:C_RUNTIME:1782770400.000100',
          env: {},
        });
      },
    );

    assert.equal(config.model, 'local-stub/runtime-pinned');
    assert.match(String(config.instructions), /Runtime configured instructions\./);
    // The enabled skill is materialized into AgentRuntimeConfig.skills through
    // the real factory + snapshot path; the disabled one is excluded.
    assert.deepEqual(
      (config.skills ?? []).map((skill) => skill.name),
      ['runtime-skill'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
