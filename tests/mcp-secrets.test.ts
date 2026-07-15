import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMcpRequestHeaders,
  deleteMcpSecrets,
  describeMcpSecretSources,
  mcpBearerEnvVar,
  mcpBearerSettingKey,
  mcpHeaderEnvVar,
  mcpHeaderSettingKey,
  resolveMcpSecrets,
  saveMcpSecrets,
} from '../src/config/mcp-secrets.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { withEnv } from './helpers/env.ts';

function newStore(): SqliteSettingsStore {
  return new SqliteSettingsStore(':memory:');
}

test('setting-key and env-var naming follow the documented mangling', () => {
  assert.equal(mcpBearerSettingKey('linear-mcp'), 'mcp.linear-mcp.bearer');
  assert.equal(mcpHeaderSettingKey('linear-mcp', 'X-Api-Key'), 'mcp.linear-mcp.header.X-Api-Key');

  assert.equal(mcpBearerEnvVar('linear-mcp'), 'MCP_LINEAR_MCP_BEARER');
  assert.equal(mcpHeaderEnvVar('linear-mcp', 'X-Api-Key'), 'MCP_LINEAR_MCP_HEADER_X_API_KEY');
});

test('resolveMcpSecrets reads stored bearer and header values', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets(
      'test-srv',
      { bearerToken: 'stored-bearer', headers: { 'X-Api-Key': 'stored-header' } },
      undefined,
      store,
    );

    const resolved = await resolveMcpSecrets('test-srv', ['X-Api-Key'], undefined, store);
    assert.equal(resolved.bearer, 'stored-bearer');
    assert.deepEqual(resolved.headers, { 'X-Api-Key': 'stored-header' });
  } finally {
    store.close();
  }
});

test('env bearer wins over stored bearer', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets('test-srv', { bearerToken: 'stored-bearer' }, undefined, store);

    await withEnv({ MCP_TEST_SRV_BEARER: 'env-bearer' }, async () => {
      const resolved = await resolveMcpSecrets('test-srv', [], undefined, store);
      assert.equal(resolved.bearer, 'env-bearer');

      const sources = await describeMcpSecretSources('test-srv', [], undefined, store);
      assert.equal(sources.bearer, 'env');
    });
  } finally {
    store.close();
  }
});

test('env header wins over stored header', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets('test-srv', { headers: { 'X-Api-Key': 'stored-header' } }, undefined, store);

    await withEnv({ MCP_TEST_SRV_HEADER_X_API_KEY: 'env-header' }, async () => {
      const resolved = await resolveMcpSecrets('test-srv', ['X-Api-Key'], undefined, store);
      assert.equal(resolved.headers['X-Api-Key'], 'env-header');

      const sources = await describeMcpSecretSources('test-srv', ['X-Api-Key'], undefined, store);
      assert.equal(sources.headers['X-Api-Key'], 'env');
    });
  } finally {
    store.close();
  }
});

test('missing secrets resolve to undefined and report missing', async () => {
  const store = newStore();
  try {
    const resolved = await resolveMcpSecrets('absent-srv', ['X-Api-Key'], undefined, store);
    assert.equal(resolved.bearer, undefined);
    assert.deepEqual(resolved.headers, {});

    const sources = await describeMcpSecretSources('absent-srv', ['X-Api-Key'], undefined, store);
    assert.equal(sources.bearer, 'missing');
    assert.equal(sources.headers['X-Api-Key'], 'missing');
  } finally {
    store.close();
  }
});

test('saveMcpSecrets then describe reports stored sources', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets(
      'test-srv',
      { bearerToken: 'stored-bearer', headers: { 'X-Api-Key': 'stored-header' } },
      undefined,
      store,
    );

    const sources = await describeMcpSecretSources('test-srv', ['X-Api-Key'], undefined, store);
    assert.equal(sources.bearer, 'stored');
    assert.equal(sources.headers['X-Api-Key'], 'stored');
  } finally {
    store.close();
  }
});

test('saveMcpSecrets skips undefined fields and does not clobber existing values', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets(
      'test-srv',
      { bearerToken: 'stored-bearer', headers: { 'X-Api-Key': 'stored-header' } },
      undefined,
      store,
    );
    // A save that omits the bearer must leave the stored bearer untouched.
    await saveMcpSecrets('test-srv', { headers: { 'X-Other': 'other-val' } }, undefined, store);

    const resolved = await resolveMcpSecrets('test-srv', ['X-Api-Key', 'X-Other'], undefined, store);
    assert.equal(resolved.bearer, 'stored-bearer');
    assert.equal(resolved.headers['X-Api-Key'], 'stored-header');
    assert.equal(resolved.headers['X-Other'], 'other-val');
  } finally {
    store.close();
  }
});

test('deleteMcpSecrets removes the bearer and all header keys', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets(
      'test-srv',
      { bearerToken: 'stored-bearer', headers: { 'X-Api-Key': 'a', 'X-Other': 'b' } },
      undefined,
      store,
    );

    await deleteMcpSecrets('test-srv', ['X-Api-Key', 'X-Other'], undefined, store);

    assert.equal(await store.getSetting(mcpBearerSettingKey('test-srv')), undefined);
    assert.equal(await store.getSetting(mcpHeaderSettingKey('test-srv', 'X-Api-Key')), undefined);
    assert.equal(await store.getSetting(mcpHeaderSettingKey('test-srv', 'X-Other')), undefined);

    const sources = await describeMcpSecretSources(
      'test-srv',
      ['X-Api-Key', 'X-Other'],
      undefined,
      store,
    );
    assert.equal(sources.bearer, 'missing');
    assert.equal(sources.headers['X-Api-Key'], 'missing');
    assert.equal(sources.headers['X-Other'], 'missing');
  } finally {
    store.close();
  }
});

test('buildMcpRequestHeaders: bearer mode emits Authorization plus custom headers', () => {
  const headers = buildMcpRequestHeaders('bearer', {
    bearer: 'abc123',
    headers: { 'X-Api-Key': 'k1' },
  });
  assert.equal(headers.Authorization, 'Bearer abc123');
  assert.equal(headers['X-Api-Key'], 'k1');
});

test('buildMcpRequestHeaders: none mode omits Authorization even when a bearer is present', () => {
  const headers = buildMcpRequestHeaders('none', {
    bearer: 'abc123',
    headers: { 'X-Api-Key': 'k1' },
  });
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers['X-Api-Key'], 'k1');
});

test('buildMcpRequestHeaders: bearer wins over a user-supplied Authorization header', () => {
  const headers = buildMcpRequestHeaders('bearer', {
    bearer: 'real-bearer',
    headers: { Authorization: 'Bearer user-supplied' },
  });
  assert.equal(headers.Authorization, 'Bearer real-bearer');
});

test('buildMcpRequestHeaders: bearer mode with no resolved bearer emits no Authorization', () => {
  const headers = buildMcpRequestHeaders('bearer', { headers: { 'X-Api-Key': 'k1' } });
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers['X-Api-Key'], 'k1');
});
