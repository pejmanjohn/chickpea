import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';
import { resolveModel } from '@flue/runtime/internal';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  invalidateProviderKeyCache,
  PROVIDER_KEY_SETTING_KEYS,
  rebindBuiltinProvider,
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
import { SqliteUsageStore } from '../src/usage/store.ts';
import { FAKE_PROVIDER_KEYS, FakeProvidersBackend } from './helpers/fake-providers.ts';
import { withEnv } from './helpers/env.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const ADMIN_TOKEN = 'provider-admin-token';

function auth(): HeadersInit {
  return testAdminHeaders(ADMIN_TOKEN);
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  app.route(
    '/',
    createAdminRoutes({
      store: config,
      settings,
      usage,
      ...testAdminAuthority(ADMIN_TOKEN),
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
      usage.close();
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
    apiConnections: [],
    repositories: [],
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

test('Workspace default reads expose live inheritance health and exclude drafts from the count', async () => {
  const { app, config, close } = appWithProviderAdmin();
  try {
    const base = await config.createAgent({
      id: 'agent_base', name: 'Base', instructions: 'Start.', enabled: true,
      lifecycle: 'active', model: 'openai/gpt-5.6-sol', skills: [], mcpServers: [],
      apiConnections: [], repositories: [],
    });
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST',
      transportMode: 'direct',
      defaultAgentId: base.id,
    });
    await config.putWorkspaceModelDefault({
      workspaceId: installation.workspaceId,
      modelId: 'openai/gpt-5.6-sol',
      provenance: 'admin_selected',
      lastChangedByMembershipId: 'membership_test_owner',
    }, 1);
    await config.updateWorkspaceInstallation(
      installation.workspaceId,
      { runtimeContract: 'chickpea-v1' },
      installation.revision,
    );
    await config.updateAgent(base.id, { model: null }, base.revision);
    await config.createAgent({
      id: 'agent_inheriting', name: 'Inheriting', instructions: 'Inherit.', enabled: true,
      lifecycle: 'active', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.createAgent({
      id: 'agent_draft', name: 'Draft', instructions: 'Wait.', enabled: false,
      lifecycle: 'draft', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });

    const response = await app.request('/admin/api/workspace-model-default', { headers: auth() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      workspaceDefault: {
        workspaceId: 'T_TEST',
        modelId: 'openai/gpt-5.6-sol',
        revision: 2,
        provenance: 'admin_selected',
        runtimeContract: 'chickpea-v1',
        live: true,
        inheritingAgentCount: 2,
        health: { status: 'ready', providerId: 'openai' },
      },
    });
  } finally {
    close();
  }
});

test('Workspace default updates are optimistic and return the current value on conflict', async () => {
  const { app, config, close } = appWithProviderAdmin();
  try {
    const base = await config.createAgent({
      id: 'agent_base', name: 'Base', instructions: 'Start.', enabled: true,
      lifecycle: 'active', model: 'openai/gpt-5.6-sol', skills: [], mcpServers: [],
      apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: base.id,
    });
    const saved = await app.request('/admin/api/workspace-model-default', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'openai/gpt-5.6-sol', expectedRevision: 1 }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as {
      workspaceDefault: { revision: number; modelId: string; live: boolean };
    }).workspaceDefault.revision, 2);

    const stale = await app.request('/admin/api/workspace-model-default', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'anthropic/claude-haiku-4-5', expectedRevision: 1 }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: 'workspace_model_default_revision_conflict',
      expectedRevision: 1,
      actualRevision: 2,
      workspaceDefault: {
        workspaceId: 'T_TEST',
        modelId: 'openai/gpt-5.6-sol',
        revision: 2,
        provenance: 'admin_selected',
        runtimeContract: 'legacy',
        live: false,
        inheritingAgentCount: 0,
        health: { status: 'ready', providerId: 'openai' },
      },
    });
  } finally {
    close();
  }
});

test('a workspace member cannot write the Workspace default through Admin', async () => {
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  const member: AuthPrincipal = {
    userId: 'user_member', membershipId: 'membership_member', organizationId: 'org_oss',
    role: 'member', authenticatorKind: 'test_slack_session', credentialId: 'member_session',
    correlationId: 'member_request', machine: false,
  };
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    usage,
    ...testAdminAuthority(ADMIN_TOKEN, undefined, undefined, member),
    knownProviders: new Set(['openai']),
  }));
  try {
    const response = await app.request('/admin/api/workspace-model-default', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'openai/gpt-5.6-sol', expectedRevision: 1 }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden' });
    const preflight = await app.request('/admin/api/chickpea-cutover/preflight', {
      headers: auth(),
    });
    assert.equal(preflight.status, 403);
    const activation = await app.request('/admin/api/chickpea-cutover/activate', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: 'activate-chickpea-v1',
        compatibilityTrafficConfirmed: true,
        expectedInstallationRevision: 1,
        expectedDefaultRevision: 1,
      }),
    });
    assert.equal(activation.status, 403);
  } finally {
    config.close();
    settings.close();
    usage.close();
  }
});

test('cutover operator APIs require explicit confirmation and preserve rollback evidence', async () => {
  const { app, config, close } = appWithProviderAdmin();
  try {
    const base = await config.createAgent({
      id: 'agent_base', name: 'Base', instructions: 'Start.', enabled: true,
      lifecycle: 'active', model: 'openai/gpt-5.6-sol', skills: [], mcpServers: [],
      apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: base.id,
    });
    await config.putAgentThreadRoute({
      workspaceId: 'T_TEST', channelId: 'D_EXISTING', threadTs: '100.1',
      agentId: base.id, agentGeneration: 1,
    });

    const preflight = await app.request('/admin/api/chickpea-cutover/preflight', {
      headers: auth(),
    });
    assert.equal(preflight.status, 200);
    const preflightBody = await preflight.json() as {
      cutover: {
        readyForActivation: boolean;
        routeCount: number;
        installationRevision: number;
        defaultRevision: number;
        defaultHealth: { status: string; providerId: string };
      };
    };
    assert.equal(preflightBody.cutover.readyForActivation, true);
    assert.equal(preflightBody.cutover.routeCount, 1);
    assert.deepEqual(preflightBody.cutover.defaultHealth, {
      status: 'ready', providerId: 'openai',
    });

    const unconfirmed = await app.request('/admin/api/chickpea-cutover/activate', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: 'activate-chickpea-v1',
        compatibilityTrafficConfirmed: false,
        expectedInstallationRevision: 1,
        expectedDefaultRevision: 1,
      }),
    });
    assert.equal(unconfirmed.status, 400);
    assert.equal((await config.getWorkspaceInstallation('T_TEST'))?.runtimeContract, 'legacy');

    const staleInstallation = await app.request('/admin/api/chickpea-cutover/activate', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: 'activate-chickpea-v1',
        compatibilityTrafficConfirmed: true,
        expectedInstallationRevision: preflightBody.cutover.installationRevision + 1,
        expectedDefaultRevision: preflightBody.cutover.defaultRevision,
      }),
    });
    assert.equal(staleInstallation.status, 409);
    assert.deepEqual(await staleInstallation.json(), {
      error: 'chickpea_cutover_revision_conflict',
      expectedRevision: preflightBody.cutover.installationRevision + 1,
      actualRevision: preflightBody.cutover.installationRevision,
    });

    const staleDefault = await app.request('/admin/api/chickpea-cutover/activate', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: 'activate-chickpea-v1',
        compatibilityTrafficConfirmed: true,
        expectedInstallationRevision: preflightBody.cutover.installationRevision,
        expectedDefaultRevision: preflightBody.cutover.defaultRevision + 1,
      }),
    });
    assert.equal(staleDefault.status, 409);
    assert.deepEqual(await staleDefault.json(), {
      error: 'workspace_model_default_revision_conflict',
      expectedRevision: preflightBody.cutover.defaultRevision + 1,
      actualRevision: preflightBody.cutover.defaultRevision,
    });

    const activated = await app.request('/admin/api/chickpea-cutover/activate', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: 'activate-chickpea-v1',
        compatibilityTrafficConfirmed: true,
        expectedInstallationRevision: preflightBody.cutover.installationRevision,
        expectedDefaultRevision: preflightBody.cutover.defaultRevision,
      }),
    });
    assert.equal(activated.status, 200);
    const activation = (await activated.json() as {
      activation: { runtimeContract: string; installationRevision: number; routeCount: number };
    }).activation;
    assert.equal(activation.runtimeContract, 'chickpea-v1');
    assert.equal(activation.installationRevision, 2);
    assert.equal(activation.routeCount, 1);
    assert.equal((await config.getAgentThreadRoute(
      'T_TEST', 'D_EXISTING', '100.1',
    ))?.agentId, base.id);

    const rolledBack = await app.request('/admin/api/chickpea-cutover/rollback', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: 'rollback-to-legacy',
        expectedInstallationRevision: activation.installationRevision,
      }),
    });
    assert.equal(rolledBack.status, 200);
    assert.equal((await rolledBack.json() as {
      cutover: { runtimeContract: string; state: string; systemPrincipalCount: number };
    }).cutover.runtimeContract, 'legacy');
    assert.equal((await config.preflightChickpeaCutover('T_TEST')).state, 'rolled_back');
    assert.equal((await config.preflightChickpeaCutover('T_TEST')).systemPrincipalCount, 1);
  } finally {
    close();
  }
});

test('cutover activation fails closed when the selected provider is unavailable', async () => {
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    usage,
    ...testAdminAuthority(ADMIN_TOKEN),
    knownProviders: new Set(['openai']),
  }));
  try {
    const base = await config.createAgent({
      id: 'agent_base', name: 'Base', instructions: 'Start.', enabled: true,
      lifecycle: 'active', model: 'anthropic/claude-sonnet-5', skills: [], mcpServers: [],
      apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: base.id,
    });
    await config.putWorkspaceModelDefault({
      workspaceId: 'T_TEST',
      modelId: 'anthropic/claude-sonnet-5',
      provenance: 'admin_selected',
      lastChangedByMembershipId: 'membership_test_owner',
    }, 1);

    const preflight = await app.request('/admin/api/chickpea-cutover/preflight', {
      headers: auth(),
    });
    assert.equal(preflight.status, 200);
    const cutover = (await preflight.json() as {
      cutover: {
        readyForActivation: boolean;
        installationRevision: number;
        defaultRevision: number;
        defaultHealth: { status: string; code: string; providerId: string };
      };
    }).cutover;
    assert.equal(cutover.readyForActivation, false);
    assert.deepEqual(cutover.defaultHealth, {
      status: 'repair_required',
      providerId: 'anthropic',
      code: 'provider_unavailable',
      repairPath: '/admin/settings/providers',
    });

    const activation = await app.request('/admin/api/chickpea-cutover/activate', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: 'activate-chickpea-v1',
        compatibilityTrafficConfirmed: true,
        expectedInstallationRevision: cutover.installationRevision,
        expectedDefaultRevision: cutover.defaultRevision,
      }),
    });
    assert.equal(activation.status, 409);
    assert.deepEqual(await activation.json(), {
      error: 'chickpea_cutover_preflight_failed',
      blockers: [],
      defaultHealth: cutover.defaultHealth,
    });
    assert.equal((await config.getWorkspaceInstallation('T_TEST'))?.runtimeContract, 'legacy');
    assert.equal((await config.listAgents()).some(({ kind }) => kind === 'system'), false);
  } finally {
    config.close();
    settings.close();
    usage.close();
  }
});

test('built-in provider runtime overrides honor explicit OpenAI-compatible base URLs', async () => {
  try {
    await withEnv(
      {
        OPENAI_API_KEY: 'openai-fixture-key',
        OPENAI_BASE_URL: 'http://127.0.0.1:40101/openai/v1',
        OPENROUTER_API_KEY: 'openrouter-fixture-key',
        OPENROUTER_BASE_URL: 'http://127.0.0.1:40101/openrouter/v1',
      },
      () => {
        invalidateProviderKeyCache();
        rebindBuiltinProvider('openai', process.env.OPENAI_API_KEY);
        rebindBuiltinProvider('openrouter', process.env.OPENROUTER_API_KEY);

        assert.equal(
          resolveModel('openai/gpt-4.1-mini').baseUrl,
          'http://127.0.0.1:40101/openai/v1',
        );
        assert.equal(
          resolveModel('openrouter/openai/gpt-4.1').baseUrl,
          'http://127.0.0.1:40101/openrouter/v1',
        );
      },
    );
  } finally {
    await withEnv(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
        OPENROUTER_API_KEY: undefined,
        OPENROUTER_BASE_URL: undefined,
      },
      () => {
        invalidateProviderKeyCache();
        rebindBuiltinProvider('openai', undefined);
        rebindBuiltinProvider('openrouter', undefined);
      },
    );
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
            provider: { id: 'anthropic', status: 'stored', modelCount: 4 },
            models: [
              { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
              { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
              {
                id: 'claude-opus-5',
                display_name: 'Claude Opus 5',
                context_length: 1_000_000,
              },
              {
                id: 'claude-sonnet-5',
                display_name: 'Claude Sonnet 5',
                context_length: 1_000_000,
              },
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
          pinnedAgentCount: 1,
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
            models: [
              { id: 'gpt-4.1' },
              { id: 'gpt-4.1-mini' },
              {
                id: 'gpt-5.6-sol',
                display_name: 'GPT-5.6 Sol',
                context_length: 272_000,
              },
              {
                id: 'gpt-5.6-terra',
                display_name: 'GPT-5.6 Terra',
                context_length: 272_000,
              },
              {
                id: 'gpt-5.6-luna',
                display_name: 'GPT-5.6 Luna',
                context_length: 272_000,
              },
            ],
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
            models: [
              { id: 'gpt-4.1' },
              { id: 'gpt-4.1-mini' },
              {
                id: 'gpt-5.6-sol',
                display_name: 'GPT-5.6 Sol',
                context_length: 272_000,
              },
              {
                id: 'gpt-5.6-terra',
                display_name: 'GPT-5.6 Terra',
                context_length: 272_000,
              },
              {
                id: 'gpt-5.6-luna',
                display_name: 'GPT-5.6 Luna',
                context_length: 272_000,
              },
            ],
            cached: true,
          });
          assert.equal(fake.callsFor('/v1/models').length, 1);

          const refreshed = await app.request('/admin/api/providers/openai/models?refresh=1', {
            headers: auth(),
          });
          assert.equal(refreshed.status, 200);
          assert.deepEqual(await refreshed.json(), {
            provider: 'openai',
            models: [
              { id: 'gpt-5.5' },
              {
                id: 'gpt-5.6-sol',
                display_name: 'GPT-5.6 Sol',
                context_length: 272_000,
              },
              {
                id: 'gpt-5.6-terra',
                display_name: 'GPT-5.6 Terra',
                context_length: 272_000,
              },
              {
                id: 'gpt-5.6-luna',
                display_name: 'GPT-5.6 Luna',
                context_length: 272_000,
              },
            ],
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

test('Workers AI can be disabled without deleting its selected models', async () => {
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
    knownProviders: new Set(['cloudflare']),
  }));
  try {
    const initialProviders = await app.request('/admin/api/providers', { headers: auth() });
    assert.equal(initialProviders.status, 200);
    const initialBody = (await initialProviders.json()) as {
      providers: Array<{ id: string; enabled?: boolean }>;
    };
    assert.equal(initialBody.providers.find((provider) => provider.id === 'workers-ai')?.enabled, true);

    const initialModels = await app.request('/admin/api/models', { headers: auth() });
    assert.equal(initialModels.status, 200);
    const initialModelBody = (await initialModels.json()) as {
      providers: Array<{ id: string; suggestions: string[] }>;
    };
    assert.deepEqual(
      initialModelBody.providers.find((provider) => provider.id === 'cloudflare')?.suggestions,
      WORKERS_AI_DEFAULT_FAVORITES.map((model) => `cloudflare/${model}`),
    );

    const disabled = await app.request('/admin/api/providers/workers-ai/enabled', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    assert.deepEqual(await disabled.json(), {
      provider: 'workers-ai',
      enabled: false,
    });
    const disabledModels = await app.request('/admin/api/models', { headers: auth() });
    assert.equal(disabledModels.status, 200);
    const disabledModelBody = (await disabledModels.json()) as {
      providers: Array<{ id: string }>;
    };
    assert.equal(disabledModelBody.providers.some((provider) => provider.id === 'cloudflare'), false);

    const favorites = await app.request('/admin/api/providers/workers-ai/favorites', {
      headers: auth(),
    });
    assert.deepEqual(await favorites.json(), {
      provider: 'workers-ai',
      favorites: WORKERS_AI_DEFAULT_FAVORITES,
    });

    const invalid = await app.request('/admin/api/providers/workers-ai/enabled', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'false' }),
    });
    assert.equal(invalid.status, 400);
    const providersAfterInvalid = await app.request('/admin/api/providers', { headers: auth() });
    const providersAfterInvalidBody = (await providersAfterInvalid.json()) as {
      providers: Array<{ id: string; enabled?: boolean }>;
    };
    assert.equal(
      providersAfterInvalidBody.providers.find((provider) => provider.id === 'workers-ai')?.enabled,
      false,
    );

    const enabled = await app.request('/admin/api/providers/workers-ai/enabled', {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), {
      provider: 'workers-ai',
      enabled: true,
    });
    const reenabledModels = await app.request('/admin/api/models', { headers: auth() });
    assert.equal(reenabledModels.status, 200);
    const reenabledModelBody = (await reenabledModels.json()) as {
      providers: Array<{ id: string; suggestions: string[] }>;
    };
    assert.deepEqual(
      reenabledModelBody.providers.find((provider) => provider.id === 'cloudflare')?.suggestions,
      WORKERS_AI_DEFAULT_FAVORITES.map((model) => `cloudflare/${model}`),
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('models endpoint applies stored provider keys before composing provider groups', async () => {
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    ...testAdminAuthority(ADMIN_TOKEN),
  }));
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
    // Anthropic keeps its current release suggestions (favorites folding is scoped).
    const anthropic = body.providers.find((provider) => provider.id === 'anthropic');
    assert.ok(anthropic);
    assert.ok(anthropic.suggestions.includes('anthropic/claude-fable-5'));
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
