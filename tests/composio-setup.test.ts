import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  describeComposioConfiguration,
  resolveComposioConfiguration,
  saveStoredComposioProjectKey,
  type ComposioConfigurationDependencies,
} from '../src/config/composio-settings.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import {
  ComposioProjectKeyValidationError,
  ComposioSetupInProgressError,
  prepareResolvedComposioManagedAuthConfigs,
  validateComposioProjectKey,
} from '../src/connections/composio-setup.ts';
import type {
  ComposioAuthConfigLike,
  ComposioClientLike,
} from '../src/connections/providers/composio.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';

async function withDependencies(
  run: (input: {
    dependencies: ComposioConfigurationDependencies;
    settings: SqliteSettingsStore;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'chickpea-composio-setup-'));
  const settings = new SqliteSettingsStore(path.join(directory, 'state.db'));
  const dependencies = {
    settings,
    credentials: { store: settings, keyring: generateCredentialKeyring('setup_test_key') },
  };
  try {
    await run({ dependencies, settings });
  } finally {
    settings.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('project-key validation returns a stable redacted failure', async () => {
  const sentinel = 'ak_secret_that_must_not_escape_123456789';
  await assert.rejects(
    validateComposioProjectKey(sentinel, {
      createClient: async () => {
        throw new Error(`upstream rejected ${sentinel}`);
      },
    }),
    (error: unknown) => error instanceof ComposioProjectKeyValidationError &&
      !error.message.includes(sentinel),
  );
});

test('setup reuses only strict Chickpea defaults and chooses oldest then id', async () => {
  await withDependencies(async ({ dependencies }) => {
    await saveStoredComposioProjectKey('ak_valid_setup_key', dependencies);
    const configs = new Map<string, ComposioAuthConfigLike[]>();
    for (const { toolkit } of MANAGED_CONNECTOR_CATALOG.list()) {
      configs.set(toolkit, [compatible(toolkit, `ac_${toolkit}_default`)]);
    }
    configs.set('youtube', [{
      ...compatible('youtube', 'ac_youtube_normalized_name'),
      name: '  Chickpea   default - youtube v1  ',
    }]);
    configs.set('gmail', [
      compatible('gmail', 'ac_gmail_newer', '2026-08-24T12:00:00.000Z'),
      { ...compatible('gmail', 'ac_gmail_restricted'), restrictToFollowingTools: ['GMAIL_GET_PROFILE'] },
      { ...compatible('gmail', 'ac_gmail_custom'), credentials: { scopes: ['gmail.readonly'] } },
      { ...compatible('gmail', 'ac_gmail_wrong_name'), name: 'Another application' },
      compatible('gmail', 'ac_gmail_older_b', '2026-08-23T12:00:00.000Z'),
      compatible('gmail', 'ac_gmail_older_a', '2026-08-23T12:00:00.000Z'),
    ]);
    let creates = 0;
    const result = await prepareResolvedComposioManagedAuthConfigs({
      ...dependencies,
      createClient: async () => setupClient(configs, () => { creates += 1; }),
    });

    assert.equal(result.status, 'ready');
    assert.equal(creates, 0);
    assert.deepEqual(result.authConfigIds.youtube, {
      read: 'ac_youtube_normalized_name',
      write: 'ac_youtube_normalized_name',
    });
    assert.deepEqual(result.authConfigIds.gmail, {
      read: 'ac_gmail_older_a',
      write: 'ac_gmail_older_a',
    });
    assert.equal((await describeComposioConfiguration(dependencies)).connectors.every(
      ({ status }) => status === 'ready',
    ), true);
  });
});

test('deployment-key setup persists safe prepared IDs for later provider resolution', async () => {
  await withDependencies(async ({ dependencies }) => {
    const env = { COMPOSIO_API_KEY: 'ak_deployment_setup_key' };
    const configs = new Map<string, ComposioAuthConfigLike[]>();
    for (const { toolkit } of MANAGED_CONNECTOR_CATALOG.list()) {
      configs.set(toolkit, [compatible(toolkit, `ac_${toolkit}_deployment`)]);
    }

    const prepared = await prepareResolvedComposioManagedAuthConfigs({
      env,
      ...dependencies,
      createClient: async () => setupClient(configs),
    });
    const resolved = await resolveComposioConfiguration({ env, ...dependencies });

    assert.equal(prepared.status, 'ready');
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.readOnly, true);
    assert.deepEqual(resolved.authConfigIds.gmail, {
      read: 'ac_gmail_deployment',
      write: 'ac_gmail_deployment',
    });
  });
});

test('setup creates missing defaults, retains partial successes, and persists safe issues', async () => {
  await withDependencies(async ({ dependencies }) => {
    await saveStoredComposioProjectKey('ak_partial_setup_key', dependencies);
    const configs = new Map<string, ComposioAuthConfigLike[]>();
    const created: Array<{ toolkit: string; options: Record<string, unknown> }> = [];
    const client = setupClient(configs, (toolkit, options) => {
      created.push({ toolkit, options });
      if (toolkit === 'gong') throw new Error('sentinel secret from upstream');
    });
    const result = await prepareResolvedComposioManagedAuthConfigs({
      ...dependencies,
      createClient: async () => client,
    });

    assert.equal(result.status, 'partial');
    assert.deepEqual(result.issueCodes, ['auth_config_prepare_failed.gong']);
    assert.equal(result.connectors.find(({ toolkit }) => toolkit === 'gong')?.status, 'failed');
    assert.ok(result.authConfigIds.gmail?.read);
    assert.deepEqual(created[0]?.options, {
      type: 'use_composio_managed_auth',
      name: `Chickpea default — ${created[0]?.toolkit} v1`,
    });
    assert.deepEqual(created.find(({ toolkit }) => toolkit === 'googleads'), {
      toolkit: 'googleads',
      options: {
        type: 'use_composio_managed_auth',
        name: 'Chickpea default — googleads v1',
      },
    });
    const status = await describeComposioConfiguration(dependencies);
    assert.deepEqual(status.lastSetupResult?.issueCodes, ['auth_config_prepare_failed.gong']);
    assert.equal(JSON.stringify(status).includes('sentinel'), false);
  });
});

test('a partial retry preserves the last verified ID for the failed toolkit', async () => {
  await withDependencies(async ({ dependencies }) => {
    await saveStoredComposioProjectKey('ak_preserve_partial_retry', dependencies);
    const configs = new Map<string, ComposioAuthConfigLike[]>();
    for (const { toolkit } of MANAGED_CONNECTOR_CATALOG.list()) {
      configs.set(toolkit, [compatible(toolkit, `ac_${toolkit}_verified`)]);
    }
    await prepareResolvedComposioManagedAuthConfigs({
      ...dependencies,
      createClient: async () => setupClient(configs),
    });

    const healthyClient = setupClient(configs);
    const healthyList = healthyClient.authConfigs!.list;
    healthyClient.authConfigs!.list = async (query, requestOptions) => {
      if (query?.toolkit === 'gmail') throw new Error('temporary list outage');
      return healthyList(query, requestOptions);
    };
    const partial = await prepareResolvedComposioManagedAuthConfigs({
      ...dependencies,
      createClient: async () => healthyClient,
    });

    assert.equal(partial.status, 'partial');
    assert.deepEqual(partial.authConfigIds.gmail, {
      read: 'ac_gmail_verified',
      write: 'ac_gmail_verified',
    });
    assert.equal((await describeComposioConfiguration(dependencies)).connectors.find(
      ({ toolkit }) => toolkit === 'gmail',
    )?.status, 'ready');
  });
});

test('the create response survives a stale list and prevents duplicate defaults on retry', async () => {
  await withDependencies(async ({ dependencies }) => {
    await saveStoredComposioProjectKey('ak_eventual_consistency_setup', dependencies);
    const created = new Map<string, ComposioAuthConfigLike>();
    let createCalls = 0;
    const client: ComposioClientLike = {
      authConfigs: {
        async list() { return { items: [], nextCursor: null, totalPages: 1 }; },
        async create(toolkit, options) {
          createCalls += 1;
          const value = compatible(toolkit, `ac_${toolkit}_created_from_response`);
          created.set(value.id, { ...value, name: options.name });
          return {
            id: value.id,
            authScheme: 'OAUTH2',
            isComposioManaged: true,
            toolkit,
          };
        },
        async get(id) {
          const value = created.get(id);
          if (!value) throw Object.assign(new Error('not found'), { status: 404 });
          return value;
        },
      },
      sessions: { async create() { throw new Error('sessions are unused during setup'); } },
    };

    const first = await prepareResolvedComposioManagedAuthConfigs({
      ...dependencies,
      createClient: async () => client,
    });
    const second = await prepareResolvedComposioManagedAuthConfigs({
      ...dependencies,
      createClient: async () => client,
    });

    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'ready');
    assert.equal(createCalls, MANAGED_CONNECTOR_CATALOG.list().length);
    assert.equal(second.authConfigIds.gmail?.read, 'ac_gmail_created_from_response');
  });
});

test('a durable setup lease rejects a concurrent preparation request', async () => {
  await withDependencies(async ({ dependencies }) => {
    await saveStoredComposioProjectKey('ak_concurrent_setup_key', dependencies);
    const configs = new Map<string, ComposioAuthConfigLike[]>();
    for (const { toolkit } of MANAGED_CONNECTOR_CATALOG.list()) {
      configs.set(toolkit, [compatible(toolkit, `ac_${toolkit}_default`)]);
    }
    let createClients = 0;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clientStarted = new Promise<void>((resolve) => { started = resolve; });
    const createClient = async () => {
      createClients += 1;
      started();
      await gate;
      return setupClient(configs);
    };
    const first = prepareResolvedComposioManagedAuthConfigs({ ...dependencies, createClient });
    await clientStarted;
    const second = prepareResolvedComposioManagedAuthConfigs({ ...dependencies, createClient });
    await assert.rejects(second, ComposioSetupInProgressError);
    release();
    const result = await first;

    assert.equal(createClients, 1);
    assert.equal(result.status, 'ready');
  });
});

test('an expired setup lease relists before it creates', async () => {
  await withDependencies(async ({ dependencies, settings }) => {
    await saveStoredComposioProjectKey('ak_expired_lease_key', dependencies);
    await settings.setSetting('managed.composio.setup_lease', JSON.stringify({
      version: 1,
      attemptId: 'expiredleaseattempt0001',
      generation: 1,
      expiresAt: 99,
    }));
    const configs = new Map<string, ComposioAuthConfigLike[]>();
    for (const { toolkit } of MANAGED_CONNECTOR_CATALOG.list()) {
      configs.set(toolkit, toolkit === 'gmail'
        ? []
        : [compatible(toolkit, `ac_${toolkit}_default`)]);
    }
    const calls: string[] = [];
    const client = setupClient(configs, (toolkit) => { calls.push(`create:${toolkit}`); });
    const list = client.authConfigs!.list;
    client.authConfigs!.list = async (query, requestOptions) => {
      calls.push(`list:${query?.toolkit}`);
      return list(query, requestOptions);
    };
    await prepareResolvedComposioManagedAuthConfigs({
      ...dependencies,
      createClient: async () => client,
      now: () => 100,
      createAttemptId: () => 'replacementleaseattempt01',
    });

    assert.deepEqual(calls.slice(0, 2), ['list:gmail', 'create:gmail']);
    assert.equal(calls.filter((call) => call === 'list:gmail').length, 1);
  });
});

test('setup reasserts lease ownership immediately before creating remote auth configs', async () => {
  await withDependencies(async ({ dependencies, settings }) => {
    await saveStoredComposioProjectKey('ak_setup_lease_reassertion', dependencies);
    let createCalls = 0;
    const client: ComposioClientLike = {
      authConfigs: {
        async list(query) {
          if (query?.toolkit === 'gmail') {
            await settings.setSetting('managed.composio.setup_lease', JSON.stringify({
              version: 1,
              attemptId: 'competingleaseattempt01',
              generation: 1,
              expiresAt: Date.now() + 60_000,
            }));
            return { items: [], nextCursor: null, totalPages: 1 };
          }
          return {
            items: [compatible(query?.toolkit ?? 'gmail', `ac_${query?.toolkit}_default`)],
            nextCursor: null,
            totalPages: 1,
          };
        },
        async create(toolkit) {
          createCalls += 1;
          return { id: `ac_${toolkit}_default`, authScheme: 'OAUTH2', isComposioManaged: true, toolkit };
        },
      },
      sessions: {
        async create() { throw new Error('sessions are unused during setup'); },
      },
    };

    await assert.rejects(
      prepareResolvedComposioManagedAuthConfigs({
        ...dependencies,
        createClient: async () => client,
      }),
      ComposioSetupInProgressError,
    );
    assert.equal(createCalls, 0);
  });
});

function compatible(
  toolkit: string,
  id: string,
  createdAt = '2026-08-24T00:00:00.000Z',
): ComposioAuthConfigLike {
  return {
    id,
    name: `Chickpea default — ${toolkit} v1`,
    toolkit: { slug: toolkit },
    status: 'ENABLED',
    credentials: {},
    restrictToFollowingTools: [],
    isComposioManaged: true,
    createdAt,
    toolAccessConfig: {
      toolsAvailableForExecution: [],
      toolsForConnectedAccountCreation: [],
    },
  };
}

function setupClient(
  configs: Map<string, ComposioAuthConfigLike[]>,
  beforeCreate: (
    toolkit: string,
    options: Record<string, unknown>,
  ) => void = () => undefined,
): ComposioClientLike {
  return {
    authConfigs: {
      async list(query) {
        const items = [...(configs.get(query?.toolkit ?? '') ?? [])];
        return { items, nextCursor: null, totalPages: 1 };
      },
      async create(toolkit, options) {
        beforeCreate(toolkit, options);
        const id = `ac_${toolkit}_created`;
        configs.set(toolkit, [...(configs.get(toolkit) ?? []), compatible(toolkit, id)]);
        return { id, authScheme: 'OAUTH2', isComposioManaged: true, toolkit };
      },
      async get(id) {
        const value = [...configs.values()].flat().find((item) => item.id === id);
        if (!value) throw new Error('missing auth config');
        return value;
      },
    },
    connectedAccounts: {
      async link() { return { id: 'ca_unused' }; },
      async get() {
        return {
          id: 'ca_unused',
          status: 'ACTIVE',
          isDisabled: false,
          toolkit: { slug: 'gmail' },
        };
      },
    },
    sessions: {
      async create() {
        return { async execute() { return { data: {} }; } };
      },
    },
  };
}
