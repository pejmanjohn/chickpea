import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  completeComposioReconciliation,
  ComposioConfigurationMutationError,
  composioConfigurationIsMutable,
  configureComposioPlatformSettings,
  disableStoredComposioConfiguration,
  recordComposioPreparationResult,
  resolveComposioConfiguration,
  saveStoredComposioProjectKey,
  type ComposioSettingsStore,
} from '../src/config/composio-settings.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore, type SettingsPatch } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import {
  ComposioPlatformConfigurationError,
  ComposioPlatformReconciliationRequiredError,
  ComposioSetupInProgressError,
  prepareComposioPlatform,
  prepareResolvedComposioManagedAuthConfigs,
} from '../src/connections/composio-setup.ts';
import type {
  ComposioAuthConfigLike,
  ComposioClientLike,
} from '../src/connections/providers/composio.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const PLATFORM_KEY = 'ak_hosted_platform_project_key';
const HOSTED = {
  CHICKPEA_TENANCY: 'installation',
  COMPOSIO_API_KEY: PLATFORM_KEY,
  CHICKPEA_COMPOSIO_ENVIRONMENT: 'staging',
} as const;
const PREPARATION = 'managed.composio.environment_preparation';
const LEASE = 'managed.composio.setup_lease';
const TOOLKITS = MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => toolkit);
const ADMIN_TOKEN = 'hosted-managed-connections-token';

function hostedEnv(installationId: string, overrides: Record<string, unknown> = {}) {
  return scopeInstallationEnv({ ...HOSTED, ...overrides }, { installationId });
}

/** The platform store a host serves from its registry database. */
class PlatformSettings implements ComposioSettingsStore {
  readonly values = new Map<string, string>();
  writes = 0;
  reads = 0;

  async getSetting(key: string): Promise<string | undefined> {
    this.reads += 1;
    return this.values.get(key);
  }

  async applySettingsPatch(patch: SettingsPatch): Promise<boolean> {
    const fences = [...(patch.expected ? [patch.expected] : []), ...(patch.expectedAll ?? [])];
    if (fences.some(({ key, value }) => (this.values.get(key) ?? null) !== value)) return false;
    this.writes += 1;
    for (const { key, value } of patch.set ?? []) this.values.set(key, value);
    for (const key of patch.delete ?? []) this.values.delete(key);
    return true;
  }
}

/** One shared Composio project's auth configs. */
class FakeComposioProject {
  readonly configs = new Map<string, ComposioAuthConfigLike[]>();
  creates = 0;
  clients = 0;
  listDelay: Promise<void> | undefined;

  client(): ComposioClientLike {
    this.clients += 1;
    return {
      authConfigs: {
        list: async (query) => {
          // Only preparation lists by toolkit; key validation lists unfiltered.
          if (query?.toolkit) await this.listDelay;
          const items = query?.toolkit ? [...(this.configs.get(query.toolkit) ?? [])] : [];
          return { items, nextCursor: null, totalPages: 1 };
        },
        create: async (toolkit) => {
          this.creates += 1;
          const id = `ac_${toolkit}_platform`;
          this.configs.set(toolkit, [...(this.configs.get(toolkit) ?? []), compatible(toolkit, id)]);
          return { id, authScheme: 'OAUTH2', isComposioManaged: true, toolkit };
        },
        get: async (id) => {
          const value = [...this.configs.values()].flat().find((item) => item.id === id);
          if (!value) throw new Error('missing auth config');
          return value;
        },
      },
      sessions: {
        async create() { throw new Error('sessions are unused here'); },
      },
    };
  }

}

function compatible(toolkit: string, id: string): ComposioAuthConfigLike {
  return {
    id,
    name: `Chickpea default — ${toolkit} v1`,
    toolkit: { slug: toolkit },
    status: 'ENABLED',
    credentials: {},
    restrictToFollowingTools: [],
    isComposioManaged: true,
    createdAt: '2026-10-02T00:00:00.000Z',
    toolAccessConfig: { toolsAvailableForExecution: [], toolsForConnectedAccountCreation: [] },
  };
}

async function withPlatform(
  run: (input: { platform: PlatformSettings; project: FakeComposioProject }) => Promise<void>,
): Promise<void> {
  const platform = new PlatformSettings();
  const project = new FakeComposioProject();
  configureComposioPlatformSettings(() => platform);
  try {
    await run({ platform, project });
  } finally {
    configureComposioPlatformSettings(undefined);
  }
}

async function prepare(platform: PlatformSettings, project: FakeComposioProject) {
  return prepareComposioPlatform({
    env: HOSTED,
    settings: platform,
    createClient: async () => project.client(),
  });
}

async function managedSettingKeys(settings: SqliteSettingsStore): Promise<string[]> {
  const keys = [PREPARATION, LEASE, 'managed.composio.configuration'];
  const values = await settings.getSettings(keys);
  return keys.filter((_, index) => values[index] !== undefined);
}

test('installations read one platform preparation and never write it or their own copy', async () => {
  await withPlatform(async ({ platform, project }) => {
    const prepared = await prepare(platform, project);
    assert.equal(prepared.status, 'ready');
    assert.equal(project.creates, TOOLKITS.length);
    const writes = platform.writes;
    const a = { env: hostedEnv('inst_a'), settings: new SqliteSettingsStore(':memory:') };
    const b = { env: hostedEnv('inst_b'), settings: new SqliteSettingsStore(':memory:') };
    try {
      const [resolvedA, resolvedB] = await Promise.all([
        resolveComposioConfiguration(a),
        resolveComposioConfiguration(b),
      ]);
      for (const resolved of [resolvedA, resolvedB]) {
        assert.equal(resolved.source, 'env');
        assert.equal(resolved.readOnly, true);
        assert.equal(resolved.apiKey, PLATFORM_KEY);
        assert.equal(resolved.generation, prepared.generation);
        assert.deepEqual(resolved.authConfigIds.gmail, {
          read: 'ac_gmail_platform', write: 'ac_gmail_platform',
        });
      }
      assert.equal(platform.writes, writes);
      assert.deepEqual(await managedSettingKeys(a.settings), []);
      assert.deepEqual(await managedSettingKeys(b.settings), []);
    } finally {
      a.settings.close();
      b.settings.close();
    }
  });
});

test('a tenant setting never supplies or overrides the deployment key', async () => {
  await withPlatform(async ({ platform, project }) => {
    await prepare(platform, project);
    const settings = new SqliteSettingsStore(':memory:');
    const keyring = generateCredentialKeyring('hosted_override_test');
    const dependencies = { settings, credentials: { store: settings, keyring } };
    try {
      // An installation store that already holds a project key of its own.
      await saveStoredComposioProjectKey('ak_tenant_owned_project_key', dependencies);
      const env = hostedEnv('inst_a');
      const withDeploymentKey = await resolveComposioConfiguration({ env, ...dependencies });
      assert.equal(withDeploymentKey.apiKey, PLATFORM_KEY);
      assert.equal(withDeploymentKey.source, 'env');

      const withoutDeploymentKey = await resolveComposioConfiguration({
        env: hostedEnv('inst_a', { COMPOSIO_API_KEY: '' }), ...dependencies,
      });
      assert.equal(withoutDeploymentKey.source, 'missing');
      assert.equal(withoutDeploymentKey.readOnly, true);
      assert.equal(withoutDeploymentKey.apiKey, undefined);

      for (const candidate of [env, hostedEnv('inst_a', { COMPOSIO_API_KEY: '' })]) {
        assert.equal(composioConfigurationIsMutable({ env: candidate }), false);
        await assert.rejects(
          saveStoredComposioProjectKey('ak_replacement', { env: candidate, ...dependencies }),
          ComposioConfigurationMutationError,
        );
        await assert.rejects(
          disableStoredComposioConfiguration({ env: candidate, ...dependencies }),
          ComposioConfigurationMutationError,
        );
      }
    } finally {
      settings.close();
    }
  });
});

test('without a platform store or environment name connections stay unavailable', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const unconfigured = await resolveComposioConfiguration({ env: hostedEnv('inst_a'), settings });
    assert.equal(unconfigured.source, 'missing');
    assert.equal(unconfigured.readOnly, true);
    await withPlatform(async () => {
      const unnamed = await resolveComposioConfiguration({
        env: hostedEnv('inst_a', { CHICKPEA_COMPOSIO_ENVIRONMENT: '' }), settings,
      });
      assert.equal(unnamed.source, 'missing');
      assert.equal(unnamed.readOnly, true);
    });
    assert.deepEqual(await managedSettingKeys(settings), []);
  } finally {
    settings.close();
  }
});

test('only the operator prepares or reconciles the shared project', async () => {
  await withPlatform(async ({ platform, project }) => {
    const settings = new SqliteSettingsStore(':memory:');
    const env = hostedEnv('inst_a');
    try {
      for (const options of [{ env, settings }, { env }]) {
        await assert.rejects(prepareResolvedComposioManagedAuthConfigs({
          ...options, createClient: async () => project.client(),
        }), ComposioConfigurationMutationError);
        await assert.rejects(
          completeComposioReconciliation(1, options),
          ComposioConfigurationMutationError,
        );
        await assert.rejects(recordComposioPreparationResult({
          expectedGeneration: 1, authConfigIds: {}, status: 'ready',
        }, options), ComposioConfigurationMutationError);
      }
      assert.equal(project.clients, 0);
      assert.equal(platform.writes, 0);
      assert.deepEqual(await managedSettingKeys(settings), []);

      await assert.rejects(prepareComposioPlatform({
        env: { COMPOSIO_API_KEY: PLATFORM_KEY }, settings: platform,
        createClient: async () => project.client(),
      }), ComposioPlatformConfigurationError);
      await assert.rejects(prepareComposioPlatform({
        env: { ...HOSTED, CHICKPEA_COMPOSIO_ENVIRONMENT: '' }, settings: platform,
        createClient: async () => project.client(),
      }), ComposioPlatformConfigurationError);
      await assert.rejects(prepareComposioPlatform({
        env: { ...HOSTED, COMPOSIO_API_KEY: '' }, settings: platform,
        createClient: async () => project.client(),
      }), ComposioPlatformConfigurationError);
      assert.equal(platform.writes, 0);
    } finally {
      settings.close();
    }
  });
});

test('concurrent operator runs share the platform lease and create each default once', async () => {
  await withPlatform(async ({ platform, project }) => {
    let release!: () => void;
    project.listDelay = new Promise((resolve) => { release = resolve; });
    const first = prepare(platform, project);
    await waitFor(() => platform.values.has(LEASE));
    const second = await prepare(platform, project).catch((error: unknown) => error);
    release();
    assert.equal((await first).status, 'ready');
    assert.ok(second instanceof ComposioSetupInProgressError);
    assert.equal(project.creates, TOOLKITS.length);
    assert.equal(platform.values.has(LEASE), false);

    const rerun = await prepare(platform, project);
    assert.equal(rerun.status, 'ready');
    assert.equal(rerun.reconciled, false);
    assert.equal(project.creates, TOOLKITS.length);
  });
});

test('a changed deployment key waits for an explicit operator reconcile', async () => {
  await withPlatform(async ({ platform, project }) => {
    const first = await prepare(platform, project);
    assert.equal(first.generation, 1);
    const rotated = { ...HOSTED, COMPOSIO_API_KEY: 'ak_rotated_platform_key' };
    const recorded = platform.values.get(PREPARATION);

    await assert.rejects(prepareComposioPlatform({
      env: rotated, settings: platform, createClient: async () => project.client(),
    }), (error: unknown) => error instanceof ComposioPlatformReconciliationRequiredError &&
      error.generation === 2);
    assert.equal(platform.values.get(PREPARATION), recorded);
    const pending = await resolveComposioConfiguration({
      env: scopeInstallationEnv(rotated, { installationId: 'inst_a' }),
    });
    assert.equal(pending.reconciliationPending, true);
    assert.deepEqual(pending.authConfigIds, {});

    const accepted = await prepareComposioPlatform({
      env: rotated, settings: platform, reconcile: true, createClient: async () => project.client(),
    });
    assert.equal(accepted.reconciled, true);
    assert.equal(accepted.generation, 2);
    assert.equal(accepted.status, 'ready');
    const resolved = await resolveComposioConfiguration({
      env: scopeInstallationEnv(rotated, { installationId: 'inst_a' }),
    });
    assert.equal(resolved.reconciliationPending, false);
    assert.equal(resolved.generation, 2);
    assert.equal(resolved.authConfigIds.gmail?.read, 'ac_gmail_platform');
  });
});

function hostedAdmin(installationId: string, overrides: Parameters<typeof createAdminRoutes>[0] = {}) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    knownProviders: new Set(['local-stub']),
    ...testAdminAuthority(ADMIN_TOKEN),
    ...overrides,
  }));
  const env = hostedEnv(installationId);
  return {
    config,
    settings,
    request: (path: string, init: RequestInit = {}) => app.request(path, {
      ...init,
      headers: { ...testAdminHeaders(ADMIN_TOKEN), 'content-type': 'application/json', ...init.headers },
    }, env),
    close: () => { config.close(); settings.close(); },
  };
}

test('hosted Admin never asks for a Composio key and refuses project-wide setup', async () => {
  await withPlatform(async ({ platform, project }) => {
    await prepare(platform, project);
    const clients = project.clients;
    const writes = platform.writes;
    const admin = hostedAdmin('inst_admin', { composioCreateClient: async () => project.client() });
    try {
      const status = await admin.request('/admin/api/settings/connectors/composio');
      assert.equal(status.status, 200, await status.clone().text());
      const body = await status.json() as {
        provider: { source: string; readOnly: boolean; configured: boolean; connectors: Array<{ status: string }> };
        recovery?: unknown;
      };
      assert.equal(body.provider.source, 'env');
      assert.equal(body.provider.readOnly, true);
      assert.equal(body.provider.configured, true);
      assert.ok(body.provider.connectors.every(({ status: value }) => value === 'ready'));
      assert.equal(body.recovery, undefined);
      assert.equal('lastSetupResult' in body.provider, false);

      for (const [path, payload] of [
        ['/admin/api/settings/connectors/composio/setup', { projectKey: 'ak_customer_key' }],
        ['/admin/api/settings/connectors/composio/retry', {}],
        ['/admin/api/settings/connectors/composio/disable', {}],
      ] as const) {
        const response = await admin.request(path, { method: 'POST', body: JSON.stringify(payload) });
        assert.equal(response.status, 409, `${path}: ${await response.clone().text()}`);
        assert.equal(
          (await response.json() as { error: string }).error,
          'composio_configuration_deployment_managed',
        );
      }
      assert.equal(project.clients, clients);
      assert.equal(platform.writes, writes);
      assert.deepEqual(await managedSettingKeys(admin.settings), []);
      assert.equal(await admin.settings.getEncryptedCredentialRevision('composio_project'), undefined);

      // A damaged platform record still never turns into a key form.
      platform.values.set(PREPARATION, '{not json');
      const damaged = await admin.request('/admin/api/settings/connectors/composio');
      assert.equal(damaged.status, 200, await damaged.clone().text());
      const damagedBody = await damaged.json() as { provider: { readOnly: boolean; reconciliationPending: boolean } };
      assert.equal(damagedBody.provider.readOnly, true);
      assert.equal(damagedBody.provider.reconciliationPending, true);
    } finally {
      admin.close();
    }
  });
});

test('standalone ignores a configured platform store and keeps its own preparation', async () => {
  const untouchable: ComposioSettingsStore = {
    async getSetting() { throw new Error('standalone read the platform store'); },
    async applySettingsPatch() { throw new Error('standalone wrote the platform store'); },
  };
  configureComposioPlatformSettings(() => untouchable);
  const settings = new SqliteSettingsStore(':memory:');
  const project = new FakeComposioProject();
  try {
    const env = { COMPOSIO_API_KEY: 'ak_standalone_project_key' };
    const prepared = await prepareResolvedComposioManagedAuthConfigs({
      env, settings, createClient: async () => project.client(),
    });
    assert.equal(prepared.status, 'ready');
    const resolved = await resolveComposioConfiguration({ env, settings });
    assert.equal(resolved.authConfigIds.gmail?.read, 'ac_gmail_platform');
    assert.deepEqual(await managedSettingKeys(settings), [PREPARATION]);
    assert.equal(composioConfigurationIsMutable({ env: {} }), true);
  } finally {
    configureComposioPlatformSettings(undefined);
    settings.close();
  }
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(condition(), 'condition never held');
}
