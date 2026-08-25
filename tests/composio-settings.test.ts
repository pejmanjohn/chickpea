import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  completeComposioReconciliation,
  ComposioConfigurationMutationError,
  ComposioConfigurationStateError,
  describeComposioConfiguration,
  disableStoredComposioConfiguration,
  recordComposioPreparationResult,
  resolveComposioConfiguration,
  saveStoredComposioProjectKey,
  type ComposioConfigurationDependencies,
} from '../src/config/composio-settings.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import { resolveDefaultManagedConnectionProviderRegistry } from '../src/connections/managed.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';

async function withDependencies(
  run: (input: {
    dbPath: string;
    dependencies: ComposioConfigurationDependencies;
    settings: SqliteSettingsStore;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'chickpea-composio-settings-'));
  const dbPath = path.join(directory, 'state.db');
  const settings = new SqliteSettingsStore(dbPath);
  const dependencies = {
    settings,
    credentials: { store: settings, keyring: generateCredentialKeyring('composio_test_key') },
  };
  try {
    await run({ dbPath, dependencies, settings });
  } finally {
    settings.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('deployment Composio configuration wins without exposing its key', async () => {
  const sentinel = 'ak_composio_environment_sentinel_123456789';
  const env = { COMPOSIO_API_KEY: sentinel };
  const resolved = await resolveComposioConfiguration({ env });
  const status = await describeComposioConfiguration({ env });

  assert.equal(resolved.source, 'env');
  assert.equal(resolved.apiKey, sentinel);
  assert.equal(resolved.readOnly, true);
  assert.deepEqual(status, {
    source: 'env',
    configured: true,
    readOnly: true,
    desiredState: 'enabled',
    generation: 1,
    reconciliationPending: false,
    connectors: MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => ({
      toolkit,
      status: 'setup_required',
    })),
  });
  assert.equal(JSON.stringify(status).includes(sentinel), false);
});

test('explicit deployment ownership remains read-only when its secret is missing', async () => {
  await withDependencies(async ({ dependencies }) => {
    const env = { CHICKPEA_COMPOSIO_CONFIGURATION_MODE: 'deployment' };
    const resolved = await resolveComposioConfiguration({ env, ...dependencies });
    assert.equal(resolved.source, 'missing');
    assert.equal(resolved.readOnly, true);
    await assert.rejects(
      saveStoredComposioProjectKey('ak_cannot_fall_through', { env, ...dependencies }),
      ComposioConfigurationMutationError,
    );
    await assert.rejects(
      disableStoredComposioConfiguration({ env, ...dependencies }),
      ComposioConfigurationMutationError,
    );
  });
});

test('stored Composio keys use the credential keyring and never enter ordinary settings or SQLite plaintext', async () => {
  await withDependencies(async ({ dbPath, dependencies, settings }) => {
    const sentinel = 'ak_composio_stored_sentinel_123456789';
    await saveStoredComposioProjectKey(sentinel, dependencies);

    const resolved = await resolveComposioConfiguration(dependencies);
    const status = await describeComposioConfiguration(dependencies);
    assert.equal(resolved.source, 'stored');
    assert.equal(resolved.apiKey, sentinel);
    assert.equal(resolved.generation, 1);
    assert.equal(status.source, 'stored');
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes(sentinel), false);

    const metadata = await settings.getSetting('managed.composio.configuration');
    assert.ok(metadata);
    assert.equal(metadata.includes(sentinel), false);
    const encrypted = await settings.getEncryptedCredentialRevision('composio_project');
    assert.ok(encrypted);
    assert.equal(JSON.stringify(encrypted).includes(sentinel), false);
    assert.equal(readFileSync(dbPath).includes(Buffer.from(sentinel)), false);

    const registry = await resolveDefaultManagedConnectionProviderRegistry(undefined, dependencies);
    assert.ok(registry.get('composio'));

    await recordComposioPreparationResult({
      expectedGeneration: resolved.generation,
      authConfigIds: { gmail: { read: 'ac_gmail_default' } },
      status: 'partial',
      issueCodes: ['remaining_connectors'],
      completedAt: 123,
    }, dependencies);
    const prepared = await describeComposioConfiguration(dependencies);
    assert.equal(
      prepared.connectors.find(({ toolkit }) => toolkit === 'gmail')?.status,
      'ready',
    );

    await disableStoredComposioConfiguration(dependencies);
    const disabled = await resolveComposioConfiguration(dependencies);
    assert.equal(disabled.source, 'missing');
    assert.equal(disabled.generation, 2);
    assert.equal(disabled.reconciliationPending, true);
    assert.equal(disabled.lastKeyFingerprint, resolved.keyFingerprint);
    const disabledRegistry = await resolveDefaultManagedConnectionProviderRegistry(
      undefined,
      dependencies,
    );
    assert.equal(disabledRegistry.get('composio'), undefined);
  });
});

test('an unconfigured installation resolves without requiring a credential keyring', async () => {
  await withDependencies(async ({ settings }) => {
    const resolved = await resolveComposioConfiguration({ settings });
    assert.equal(resolved.source, 'missing');
    assert.equal(resolved.apiKey, undefined);
    const registry = await resolveDefaultManagedConnectionProviderRegistry(undefined, { settings });
    assert.equal(registry.get('composio'), undefined);
  });
});

test('environment preparation metadata never replaces stored-project metadata', async () => {
  await withDependencies(async ({ dependencies }) => {
    const storedKey = 'ak_stored_project_survives_environment_override';
    await saveStoredComposioProjectKey(storedKey, dependencies);
    const storedBefore = await resolveComposioConfiguration(dependencies);
    await recordComposioPreparationResult({
      expectedGeneration: 1,
      authConfigIds: { gmail: { read: 'ac_environment_gmail' } },
      status: 'ready',
      completedAt: 456,
    }, {
      ...dependencies,
      env: { COMPOSIO_API_KEY: 'ak_temporary_environment_project' },
    });

    const environment = await resolveComposioConfiguration({
      ...dependencies,
      env: { COMPOSIO_API_KEY: 'ak_temporary_environment_project' },
    });
    assert.equal(environment.authConfigIds.gmail?.read, 'ac_environment_gmail');
    const storedAfter = await resolveComposioConfiguration(dependencies);
    assert.equal(storedAfter.apiKey, storedKey);
    assert.equal(storedAfter.keyFingerprint, storedBefore.keyFingerprint);
  });
});

test('retired or malformed auth-config entries do not disable the stored provider', async () => {
  await withDependencies(async ({ dependencies, settings }) => {
    await saveStoredComposioProjectKey('ak_catalog_compatibility', dependencies);
    const raw = JSON.parse((await settings.getSetting('managed.composio.configuration'))!) as {
      generation: number;
      [key: string]: unknown;
    };
    await settings.setSetting('managed.composio.configuration', JSON.stringify({
      ...raw,
      authConfigGeneration: raw.generation,
      authConfigIds: {
        retiredtoolkit: { read: 'ac_retired_toolkit' },
        gmail: {
          read: 'ac_gmail_current',
          retired_lane: 'ac_unknown_lane',
        },
        googlecalendar: { read: 'not_an_auth_config_id' },
      },
    }));

    const resolved = await resolveComposioConfiguration(dependencies);
    assert.equal(resolved.apiKey, 'ak_catalog_compatibility');
    assert.deepEqual(resolved.authConfigIds, {
      gmail: { read: 'ac_gmail_current' },
      googlecalendar: {},
    });
    const registry = await resolveDefaultManagedConnectionProviderRegistry(undefined, dependencies);
    assert.ok(registry.get('composio'));
  });
});

test('an admin can replace or disable a malformed stored configuration', async (t) => {
  await withDependencies(async ({ dependencies, settings }) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (value?: unknown) => { warnings.push(String(value)); });
    await saveStoredComposioProjectKey('ak_original_before_metadata_damage', dependencies);
    await settings.setSetting('managed.composio.configuration', '{bad metadata');
    await assert.rejects(resolveComposioConfiguration(dependencies), ComposioConfigurationStateError);
    const unavailableRegistry = await resolveDefaultManagedConnectionProviderRegistry(
      undefined,
      dependencies,
    );
    assert.equal(unavailableRegistry.get('composio'), undefined);
    assert.deepEqual(warnings.map((warning) => JSON.parse(warning)), [{
      event: 'chickpea.managed_connection.configuration_unavailable',
      adapterId: 'composio',
      errorName: 'ComposioConfigurationStateError',
    }]);
    assert.equal(warnings.some((warning) => warning.includes('ak_original_before_metadata_damage')), false);

    const repaired = await saveStoredComposioProjectKey('ak_repaired_after_metadata_damage', dependencies);
    assert.equal(repaired.apiKey, 'ak_repaired_after_metadata_damage');
    assert.equal(repaired.reconciliationPending, true);

    await settings.setSetting('managed.composio.configuration', '{bad again');
    await disableStoredComposioConfiguration(dependencies);
    const disabled = await resolveComposioConfiguration(dependencies);
    assert.equal(disabled.desiredState, 'disabled');
  });
});

test('a metadata conflict restores the previous encrypted Composio key revision', async () => {
  await withDependencies(async ({ dependencies, settings }) => {
    const original = 'ak_composio_original_project';
    await saveStoredComposioProjectKey(original, dependencies);
    const before = await settings.getEncryptedCredentialRevision('composio_project');
    assert.ok(before);

    const conflictingSettings = new Proxy(settings, {
      get(target, property, receiver) {
        if (property === 'applySettingsPatch') return async () => false;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      saveStoredComposioProjectKey('ak_composio_rejected_replacement', {
        settings: conflictingSettings,
        credentials: dependencies.credentials,
      }),
      /Stored Composio configuration is unavailable/,
    );

    const after = await settings.getEncryptedCredentialRevision('composio_project');
    assert.equal(after?.revision, before.revision);
    assert.deepEqual(after?.envelope, before.envelope);
    assert.equal((await resolveComposioConfiguration(dependencies)).apiKey, original);
  });
});

test('legacy auth config IDs are validated lane-locally against the active project', async () => {
  const compatible = await resolveComposioConfiguration({
    env: {
      COMPOSIO_API_KEY: 'ak_project_a',
      COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID: 'ac_gmail_read',
    },
    inspectAuthConfig: async ({ authConfigId }) => ({
      id: authConfigId,
      toolkit: 'gmail',
      enabled: true,
      managed: true,
      unrestricted: true,
    }),
    verifyLegacyAuthConfigIds: true,
  });
  assert.equal(compatible.authConfigIds.gmail?.read, 'ac_gmail_read');
  assert.equal(compatible.authConfigGeneration, compatible.generation);

  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (value?: unknown) => { warnings.push(String(value)); };
  try {
    const partial = await resolveComposioConfiguration({
      env: {
        COMPOSIO_API_KEY: 'ak_project_b',
        COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID: 'ac_project_a_gmail',
        COMPOSIO_CALENDAR_READ_AUTH_CONFIG_ID: 'ac_project_b_calendar',
      },
      inspectAuthConfig: async ({ authConfigId }) => ({
        id: authConfigId,
      toolkit: authConfigId === 'ac_project_b_calendar' ? 'GoogleCalendar' : 'not_the_expected_toolkit',
        enabled: true,
        managed: true,
        unrestricted: true,
      }),
      verifyLegacyAuthConfigIds: true,
    });
    assert.equal(partial.authConfigIds.gmail, undefined);
    assert.equal(partial.authConfigIds.googlecalendar?.read, 'ac_project_b_calendar');
  } finally {
    console.warn = previousWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID/);
  assert.match(warnings[0] ?? '', /"reason":"incompatible"/);
  assert.equal(warnings.join('\n').includes('ak_project_b'), false);
  assert.equal(warnings.join('\n').includes('ac_project_a_gmail'), false);
});

test('deployment preparation replaces corrupt or future-version metadata', async () => {
  await withDependencies(async ({ dependencies, settings }) => {
    const options = {
      ...dependencies,
      env: { COMPOSIO_API_KEY: 'ak_environment_preparation_recovery' },
    };
    await settings.setSetting('managed.composio.environment_preparation', JSON.stringify({
      version: 2,
      desiredState: 'enabled',
      generation: 1,
      reconciliationPending: false,
    }));

    await recordComposioPreparationResult({
      expectedGeneration: 1,
      authConfigIds: { gmail: { read: 'ac_recovered_gmail' } },
      status: 'ready',
      completedAt: 600,
    }, options);

    const resolved = await resolveComposioConfiguration(options);
    assert.equal(resolved.authConfigIds.gmail?.read, 'ac_recovered_gmail');
    assert.equal(resolved.lastSetupResult?.status, 'ready');
  });
});

test('deployment key rotation increments lineage generation and requires reconciliation', async () => {
  await withDependencies(async ({ dependencies }) => {
    const firstOptions = {
      ...dependencies,
      env: { COMPOSIO_API_KEY: 'ak_environment_rotation_first' },
    };
    await recordComposioPreparationResult({
      expectedGeneration: 1,
      authConfigIds: { gmail: { read: 'ac_environment_rotation_first' } },
      status: 'ready',
      completedAt: 700,
    }, firstOptions);
    const first = await resolveComposioConfiguration(firstOptions);
    assert.equal(first.generation, 1);
    assert.equal(first.reconciliationPending, false);
    assert.equal(first.authConfigIds.gmail?.read, 'ac_environment_rotation_first');

    const rotatedOptions = {
      ...dependencies,
      env: { COMPOSIO_API_KEY: 'ak_environment_rotation_second' },
    };
    const rotated = await resolveComposioConfiguration(rotatedOptions);
    assert.equal(rotated.generation, 2);
    assert.equal(rotated.reconciliationPending, true);
    assert.notEqual(rotated.keyFingerprint, first.keyFingerprint);
    assert.deepEqual(rotated.authConfigIds, {});
    assert.equal(
      (await resolveDefaultManagedConnectionProviderRegistry(undefined, rotatedOptions))
        .get('composio'),
      undefined,
    );

    await completeComposioReconciliation(rotated.generation, rotatedOptions);
    const reconciled = await resolveComposioConfiguration(rotatedOptions);
    assert.equal(reconciled.generation, 2);
    assert.equal(reconciled.reconciliationPending, false);
    assert.deepEqual(reconciled.authConfigIds, {});

    await recordComposioPreparationResult({
      expectedGeneration: reconciled.generation,
      authConfigIds: { gmail: { read: 'ac_environment_rotation_second' } },
      status: 'ready',
      completedAt: 701,
    }, rotatedOptions);
    const prepared = await resolveComposioConfiguration(rotatedOptions);
    assert.equal(prepared.authConfigIds.gmail?.read, 'ac_environment_rotation_second');
    assert.ok(
      (await resolveDefaultManagedConnectionProviderRegistry(undefined, rotatedOptions))
        .get('composio'),
    );
  });
});

test('deployment key rotation is detected before the first preparation completes', async () => {
  await withDependencies(async ({ dependencies, settings }) => {
    const firstOptions = {
      ...dependencies,
      env: { COMPOSIO_API_KEY: 'ak_environment_unprepared_rotation_first' },
    };
    const first = await resolveComposioConfiguration(firstOptions);
    assert.equal(first.generation, 1);
    assert.equal(first.reconciliationPending, false);
    const seeded = await settings.getSetting('managed.composio.environment_preparation');
    assert.ok(seeded);
    assert.equal(seeded.includes('ak_environment_unprepared_rotation_first'), false);

    const rotatedOptions = {
      ...dependencies,
      env: { COMPOSIO_API_KEY: 'ak_environment_unprepared_rotation_second' },
    };
    const rotated = await resolveComposioConfiguration(rotatedOptions);
    assert.equal(rotated.generation, 2);
    assert.equal(rotated.reconciliationPending, true);
    assert.notEqual(rotated.keyFingerprint, first.keyFingerprint);
    assert.equal(
      (await resolveDefaultManagedConnectionProviderRegistry(undefined, rotatedOptions))
        .get('composio'),
      undefined,
    );
  });
});

test('runtime resolution uses persisted deployment preparation without remote legacy inspection', async () => {
  await withDependencies(async ({ dependencies }) => {
    const env = {
      COMPOSIO_API_KEY: 'ak_runtime_does_not_inspect_legacy_ids',
      COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID: 'ac_runtime_legacy_gmail',
    };
    let inspections = 0;
    const options = {
      ...dependencies,
      env,
      inspectAuthConfig: async () => {
        inspections += 1;
        throw new Error('runtime must not inspect');
      },
    };
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (value?: unknown) => { warnings.push(String(value)); };

    try {
      const unprepared = await resolveComposioConfiguration(options);
      assert.deepEqual(unprepared.authConfigIds, {});
      assert.equal(inspections, 0);

      await recordComposioPreparationResult({
        expectedGeneration: 1,
        authConfigIds: { gmail: { read: 'ac_prepared_gmail' } },
        status: 'ready',
        completedAt: 500,
      }, options);
      const prepared = await resolveComposioConfiguration(options);
      assert.equal(prepared.authConfigIds.gmail?.read, 'ac_prepared_gmail');
      assert.equal(inspections, 0);
    } finally {
      console.warn = previousWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /deployment_preparation_required/);
    assert.match(warnings[0] ?? '', /COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID/);
    assert.equal(warnings.join('\n').includes('ak_runtime_does_not_inspect_legacy_ids'), false);
    assert.equal(warnings.join('\n').includes('ac_runtime_legacy_gmail'), false);
  });
});

test('a cold legacy auth config inspection outage preserves the provider and is briefly cached', async () => {
  await withDependencies(async ({ dependencies }) => {
    const env = {
      COMPOSIO_API_KEY: 'ak_project_transient_cold',
      COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID: 'ac_gmail_transient_cold',
    };
    let inspections = 0;
    const inspectAuthConfig = async () => {
      inspections += 1;
      throw new Error('temporary provider failure');
    };
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (value?: unknown) => { warnings.push(String(value)); };
    try {
      const first = await resolveComposioConfiguration({
        ...dependencies, env, inspectAuthConfig, verifyLegacyAuthConfigIds: true,
      });
      const second = await resolveComposioConfiguration({
        ...dependencies, env, inspectAuthConfig, verifyLegacyAuthConfigIds: true,
      });
      assert.deepEqual(first.authConfigIds, {});
      assert.deepEqual(second.authConfigIds, {});
      const registry = await resolveDefaultManagedConnectionProviderRegistry(env, {
        ...dependencies, inspectAuthConfig,
      });
      assert.ok(registry.get('composio'));
    } finally {
      console.warn = previousWarn;
    }
    assert.equal(inspections, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID/);
    assert.match(warnings[0] ?? '', /"reason":"inspection_unavailable"/);
    assert.equal(warnings.join('\n').includes('ak_project_transient_cold'), false);
    assert.equal(warnings.join('\n').includes('ac_gmail_transient_cold'), false);
  });
});

test('legacy auth config validation is cached and retains the last good result on a transient failure', async () => {
  let now = 1_000;
  let inspections = 0;
  let unavailable = false;
  const options = {
    env: {
      COMPOSIO_API_KEY: 'ak_project_cache_test',
      COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID: 'ac_gmail_cache_test',
    },
    now: () => now,
    inspectAuthConfig: async ({ authConfigId }: { apiKey: string; authConfigId: string }) => {
      inspections += 1;
      if (unavailable) throw new Error('temporary provider failure');
      return {
        id: authConfigId,
        toolkit: 'gmail',
        enabled: true,
        managed: true,
        unrestricted: true,
      };
    },
    verifyLegacyAuthConfigIds: true,
  };

  assert.equal((await resolveComposioConfiguration(options)).authConfigIds.gmail?.read,
    'ac_gmail_cache_test');
  assert.equal((await resolveComposioConfiguration(options)).authConfigIds.gmail?.read,
    'ac_gmail_cache_test');
  assert.equal(inspections, 1);

  now += 10 * 60_000;
  unavailable = true;
  assert.equal((await resolveComposioConfiguration(options)).authConfigIds.gmail?.read,
    'ac_gmail_cache_test');
  assert.equal(inspections, 2);
});
