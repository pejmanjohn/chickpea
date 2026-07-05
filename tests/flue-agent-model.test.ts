import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { registerProvider } from '@flue/runtime';
// `resolveModel` is not re-exported from the root `@flue/runtime` entry point,
// but it is a documented public subpath export (see the `"./internal"` entry
// in @flue/runtime's package.json `exports` map) — not a reach into an
// unlisted dist file. It is the only way to drive Flue's real model
// resolution from a test.
import { resolveModel } from '@flue/runtime/internal';

import { SqliteConfigStore } from '../src/config/store.ts';
import slackThreadAgent, { resolveAgentModel } from '../src/agents/slack-thread.ts';
import { seededAgents } from '../src/config/seed.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const THREAD_KEY = 'T_DEMO:C_EXEC:1782770400.000100';

function modelAgent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_model',
    name: 'Model Agent',
    description: 'Exercises model policy',
    instructions: 'Model policy instructions.',
    enabled: true,
    defaultModels: {
      claude: 'claude-sonnet-model',
      'workers-ai': '@cf/workers/model',
    },
    allowedTools: [],
    ...overrides,
  };
}

test('Flue resolves the model specifier produced by the slack-thread agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-flue-model-seed-'));
  const dbPath = join(dir, 'state.db');
  const store = new SqliteConfigStore(dbPath, {
    agents: seededAgents,
    assignments: [
      {
        workspaceId: 'T_DEMO',
        channelId: 'C_EXEC',
        agentId: 'agent_exec_brief',
        enabled: true,
      },
      { workspaceId: '*', channelId: '*', agentId: 'agent_exec_brief', enabled: true },
    ],
  });
  store.close();

  // The `cloudflare-workers-ai` provider id is in Flue's model catalog, but
  // the specific seeded model id is not — so it must be registered before
  // resolution will admit it. An empty registration is enough for a catalog
  // provider id to hydrate from the catalog and admit arbitrary model-id
  // suffixes under it.
  registerProvider('cloudflare-workers-ai', {});

  try {
    const config = await withEnv(
      {
        SLACK_STATE_DB_PATH: dbPath,
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: 'cf-token',
        CLOUDFLARE_ACCOUNT_ID: 'cf-account',
        SLACK_FLUE_MODEL: undefined,
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

test('model policy prefers an explicit per-agent model over provider credentials and fallback', () => {
  assert.equal(
    resolveAgentModel(
      modelAgent({ model: 'local-stub/agent-pinned' }),
      {
        ANTHROPIC_API_KEY: 'anthropic-key',
        CLOUDFLARE_API_TOKEN: 'cf-token',
        CLOUDFLARE_ACCOUNT_ID: 'cf-account',
        SLACK_FLUE_MODEL: 'local-stub/fallback',
      },
    ),
    'local-stub/agent-pinned',
  );
});

test('model policy uses the agent Anthropic default when Anthropic credentials exist', () => {
  assert.equal(
    resolveAgentModel(modelAgent(), {
      ANTHROPIC_API_KEY: 'anthropic-key',
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      SLACK_FLUE_MODEL: 'local-stub/fallback',
    }),
    'anthropic/claude-sonnet-model',
  );
});

test('model policy uses the Workers AI default when only Cloudflare credentials exist', () => {
  assert.equal(
    resolveAgentModel(modelAgent(), {
      ANTHROPIC_API_KEY: undefined,
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      SLACK_FLUE_MODEL: 'local-stub/fallback',
    }),
    'cloudflare-workers-ai/@cf/workers/model',
  );
});

test('model policy falls back to SLACK_FLUE_MODEL when provider credentials are absent', () => {
  assert.equal(
    resolveAgentModel(modelAgent(), {
      ANTHROPIC_API_KEY: undefined,
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_ACCOUNT_ID: undefined,
      SLACK_FLUE_MODEL: 'local-stub/offline-fallback',
    }),
    'local-stub/offline-fallback',
  );
});

test('model policy fails with actionable env names when no model can be selected', () => {
  assert.throws(
    () =>
      resolveAgentModel(modelAgent(), {
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        SLACK_FLUE_MODEL: undefined,
      }),
    /agent\.model.*ANTHROPIC_API_KEY.*CLOUDFLARE_API_TOKEN.*CLOUDFLARE_ACCOUNT_ID.*SLACK_FLUE_MODEL/s,
  );
});

test('slack-thread initializes from the SQLite config store for the current state DB path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-flue-agent-config-'));
  const dbPath = join(dir, 'state.db');
  const store = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
  store.createAgent({
    id: 'agent_runtime',
    name: 'Runtime Agent',
    description: 'Configured at runtime',
    instructions: 'Runtime configured instructions.',
    enabled: true,
    defaultModels: {
      claude: 'anthropic/runtime-claude',
      'workers-ai': '@cf/runtime/model',
    },
    allowedTools: [],
  });
  store.putAssignment({
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
        SLACK_FLUE_MODEL: 'local-stub/runtime-fallback',
        // Scrub ambient provider creds: they outrank the fallback model and
        // would flip the resolved model on a developer/CI machine.
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
      },
      () => slackThreadAgent.initialize({ id: 'T_RUNTIME:C_RUNTIME:1782770400.000100', env: {} }),
    );

    assert.equal(config.model, 'local-stub/runtime-fallback');
    assert.match(String(config.instructions), /Runtime configured instructions\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
