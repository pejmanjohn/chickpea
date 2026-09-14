import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  configuredMcpOAuthClientDescriptor,
  ConfiguredMcpOAuthClientError,
  getConfiguredMcpOAuthClient,
  META_ADS_MCP_SERVER_URL,
  META_ADS_OAUTH_ISSUER,
  removeConfiguredMcpOAuthClient,
  saveConfiguredMcpOAuthClient,
} from '../src/config/mcp-oauth-clients.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

const GENERATION_A = '11111111-1111-4111-8111-111111111111';
const GENERATION_B = '22222222-2222-4222-8222-222222222222';
const GENERATION_C = '33333333-3333-4333-8333-333333333333';
const GENERATION_D = '44444444-4444-4444-8444-444444444444';

test('configured public OAuth descriptors require the reviewed canonical server', () => {
  assert.deepEqual(configuredMcpOAuthClientDescriptor(META_ADS_MCP_SERVER_URL), {
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    settingKey: 'mcp.oauth-client.meta-ads',
  });
  assert.equal(configuredMcpOAuthClientDescriptor(`${META_ADS_MCP_SERVER_URL}/`), undefined);
  assert.equal(configuredMcpOAuthClientDescriptor(`${META_ADS_MCP_SERVER_URL}?mode=other`), undefined);
  assert.deepEqual(
    configuredMcpOAuthClientDescriptor('https://MCP.FACEBOOK.COM:443/ads'),
    configuredMcpOAuthClientDescriptor(META_ADS_MCP_SERVER_URL),
  );
  assert.equal(configuredMcpOAuthClientDescriptor('https://example.test/mcp'), undefined);
});

test('configured client saves are CAS-backed and identical saves preserve generation', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const generations = [GENERATION_A, GENERATION_B];
  try {
    const first = await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => generations.shift()! },
    );
    const unchanged = await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => { throw new Error('same value must not allocate a generation'); } },
    );
    const replacement = await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '9876543210' },
      settings,
      { randomId: () => generations.shift()! },
    );

    assert.equal(first.generation, GENERATION_A);
    assert.equal(unchanged.generation, GENERATION_A);
    assert.equal(replacement.generation, GENERATION_B);
    assert.deepEqual(
      await getConfiguredMcpOAuthClient(META_ADS_MCP_SERVER_URL, settings),
      replacement,
    );
  } finally {
    settings.close();
  }
});

test('remove and re-add of the same client cannot recreate its generation', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const initial = await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => GENERATION_A },
    );
    const removed = await removeConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      settings,
      { randomId: () => GENERATION_B },
    );
    assert.deepEqual(removed, { removed: true, generation: GENERATION_B });
    assert.equal(await getConfiguredMcpOAuthClient(META_ADS_MCP_SERVER_URL, settings), undefined);

    const repeatedRemoval = await removeConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      settings,
      { randomId: () => { throw new Error('existing tombstone must be retained'); } },
    );
    assert.deepEqual(repeatedRemoval, { removed: false, generation: GENERATION_B });

    const restored = await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => GENERATION_C },
    );
    assert.notEqual(restored.generation, initial.generation);
    assert.equal(restored.generation, GENERATION_C);
  } finally {
    settings.close();
  }
});

test('competing configured-client writes retry against the winning value', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const results = await Promise.all([
      saveConfiguredMcpOAuthClient(
        META_ADS_MCP_SERVER_URL,
        { clientId: '111111' },
        settings,
        { randomId: () => GENERATION_A },
      ),
      saveConfiguredMcpOAuthClient(
        META_ADS_MCP_SERVER_URL,
        { clientId: '222222' },
        settings,
        { randomId: (() => {
          const values = [GENERATION_B, GENERATION_C, GENERATION_D];
          return () => values.shift()!;
        })() },
      ),
    ]);
    const current = await getConfiguredMcpOAuthClient(META_ADS_MCP_SERVER_URL, settings);
    assert.ok(current);
    assert.ok(results.some(({ clientId, generation }) =>
      clientId === current.clientId && generation === current.generation));
  } finally {
    settings.close();
  }
});

test('configured client rejects malformed IDs and stored records', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await assert.rejects(
      saveConfiguredMcpOAuthClient(
        META_ADS_MCP_SERVER_URL,
        { clientId: 'not-a-meta-app-id' },
        settings,
      ),
      (error: unknown) =>
        error instanceof ConfiguredMcpOAuthClientError && error.code === 'invalid_client_id',
    );
    const descriptor = configuredMcpOAuthClientDescriptor(META_ADS_MCP_SERVER_URL)!;
    await settings.setSetting(descriptor.settingKey, JSON.stringify({
      version: 1,
      serverUrl: META_ADS_MCP_SERVER_URL,
      authorizationServerUrl: 'https://attacker.example.test',
      clientId: '1234567890',
      generation: GENERATION_A,
    }));
    await assert.rejects(
      getConfiguredMcpOAuthClient(META_ADS_MCP_SERVER_URL, settings),
      (error: unknown) =>
        error instanceof ConfiguredMcpOAuthClientError && error.code === 'invalid_storage',
    );
  } finally {
    settings.close();
  }
});
