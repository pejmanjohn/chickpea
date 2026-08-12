import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveModelCredentialAttribution,
  storedCredentialMetadata,
} from '../src/config/model-credential-refs.ts';
import {
  deleteProviderApiKey,
  invalidateProviderKeyCache,
  saveProviderApiKey,
} from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import type { UsageStore } from '../src/usage/types.ts';

test('stored provider-key replacement advances an opaque epoch without changing its ref', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  try {
    await saveProviderApiKey('openai', 'sk-first-secret-value', undefined, settings, usage);
    const first = await resolveModelCredentialAttribution(
      'openai/gpt-4.1-mini',
      undefined,
      settings,
      usage,
    );
    await usage.admitOperation({
      operationId: 'op_historical_epoch',
      operationKind: 'interactive_turn',
      sourceId: 'op_historical_epoch',
      startedAt: 1,
      installationId: 'installation',
      workspaceId: null,
      agentId: null,
      agentLabel: null,
      channelId: null,
      channelLabel: null,
      conversationKind: 'unknown',
      requestedProvider: 'openai',
      requestedModel: 'gpt-4.1-mini',
      credentialRefId: first?.credentialRefId ?? null,
      credentialVersion: first?.version ?? null,
    });

    await saveProviderApiKey('openai', 'sk-second-secret-value', undefined, settings, usage);
    const second = await resolveModelCredentialAttribution(
      'openai/gpt-4.1-mini',
      undefined,
      settings,
      usage,
    );

    assert.ok(first);
    assert.equal(second?.credentialRefId, first?.credentialRefId);
    assert.equal(second?.version, 2);
    assert.equal((await usage.getOperation('op_historical_epoch'))?.operation.credentialVersion, 1);

    const serialized = JSON.stringify({ first, second, rows: await usage.listCredentials() });
    assert.doesNotMatch(serialized, /first-secret|second-secret|sk-/);
    assert.doesNotMatch(serialized, /[a-f0-9]{32,}/i, 'no key-derived digest is serialized');
  } finally {
    invalidateProviderKeyCache();
    settings.close();
    usage.close();
  }
});

test('stored credential deletion retires the epoch and advances metadata for a later key', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  try {
    await saveProviderApiKey('anthropic', 'stored-secret-one', undefined, settings, usage);
    const first = await storedCredentialMetadata('anthropic', settings);
    await deleteProviderApiKey('anthropic', undefined, settings, usage);
    const deleted = await storedCredentialMetadata('anthropic', settings);
    assert.equal(deleted?.version, 2);
    assert.equal(deleted?.active, false);

    await saveProviderApiKey('anthropic', 'stored-secret-two', undefined, settings, usage);
    const restored = await storedCredentialMetadata('anthropic', settings);
    assert.equal(restored?.credentialRefId, first?.credentialRefId);
    assert.equal(restored?.version, 3);
    assert.equal(restored?.active, true);

    const rows = await usage.listCredentials();
    assert.equal(rows.find((row) => row.version === 1)?.retiredAt !== null, true);
    assert.equal(rows.find((row) => row.version === 3)?.retiredAt, null);
  } finally {
    invalidateProviderKeyCache();
    settings.close();
    usage.close();
  }
});

test('environment, Workers binding, and custom refs are deterministic with honest rotation state', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  try {
    const environment = await resolveModelCredentialAttribution(
      'openai/gpt-4.1-mini',
      undefined,
      settings,
      usage,
      {
        processEnv: {
          OPENAI_API_KEY: 'environment-secret',
          OPENAI_CREDENTIAL_ALIAS: 'chickpea-production',
          OPENAI_CREDENTIAL_EPOCH: '7',
        },
      },
    );
    const unknownRotation = await resolveModelCredentialAttribution(
      'anthropic/claude-haiku-4-5',
      undefined,
      settings,
      usage,
      { processEnv: { ANTHROPIC_API_KEY: 'environment-secret' } },
    );
    const binding = await resolveModelCredentialAttribution(
      'cloudflare/@cf/zai-org/glm-5.2',
      { AI: { run() {} } },
      settings,
      usage,
      { processEnv: { CHICKPEA_DEPLOYMENT_EPOCH: '4' } },
    );
    const custom = await resolveModelCredentialAttribution(
      'local-stub/model',
      undefined,
      settings,
      usage,
      { processEnv: {} },
    );

    assert.deepEqual(
      {
        ref: environment?.credentialRefId,
        version: environment?.version,
        label: environment?.label,
        unknownRotation: environment?.unknownRotation,
      },
      {
        ref: 'cred_openai_environment',
        version: 7,
        label: 'chickpea-production',
        unknownRotation: false,
      },
    );
    assert.equal(unknownRotation?.credentialRefId, 'cred_anthropic_environment');
    assert.equal(unknownRotation?.unknownRotation, true);
    assert.equal(binding?.credentialRefId, 'cred_cloudflare_binding');
    assert.equal(binding?.version, 4);
    assert.equal(custom?.credentialRefId, 'cred_local-stub_custom');
    assert.equal(custom?.unknownRotation, true);
    assert.doesNotMatch(JSON.stringify(await usage.listCredentials()), /environment-secret/);
  } finally {
    settings.close();
    usage.close();
  }
});

test('credential attribution remains available when the reporting store is unavailable', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const usage = {
    putCredential: async () => { throw new Error('unavailable'); },
  } as unknown as UsageStore;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const attribution = await resolveModelCredentialAttribution(
      'openai/gpt-4.1-mini',
      undefined,
      settings,
      usage,
      { processEnv: { OPENAI_API_KEY: 'test-secret' } },
    );
    assert.equal(attribution?.credentialRefId, 'cred_openai_environment');
    assert.equal(attribution?.unknownRotation, true);
  } finally {
    console.warn = originalWarn;
    settings.close();
  }
});
