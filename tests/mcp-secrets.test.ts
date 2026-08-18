import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMcpRequestHeaders,
  deleteMcpSecrets,
  describeMcpSecretSources,
  finishMcpSecretCleanup,
  mcpBearerEnvVar,
  mcpBearerSettingKey,
  mcpHeaderEnvVar,
  mcpHeaderSettingKey,
  mcpSecretCleanupMarkerKey,
  resolveMcpHeaders,
  resolveMcpSecrets,
  saveMcpSecrets,
  stageMcpSecretCleanup,
} from '../src/config/mcp-secrets.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { withEnv } from './helpers/env.ts';

function newStore(): SqliteSettingsStore {
  return new SqliteSettingsStore(':memory:');
}

const TEST_REF = { agentId: 'agent_test', connectionId: 'test-srv' };

test('setting keys and collision-safe environment names include both scopes', () => {
  assert.equal(
    mcpBearerSettingKey({ agentId: 'agent_support', connectionId: 'linear-mcp' }),
    'mcp.agent_support.linear-mcp.bearer',
  );
  assert.equal(
    mcpHeaderSettingKey({ agentId: 'agent_support', connectionId: 'linear-mcp' }, 'X-Api-Key'),
    'mcp.agent_support.linear-mcp.header.X-Api-Key',
  );

  assert.equal(
    mcpBearerEnvVar({ agentId: 'agent_support', connectionId: 'linear-mcp' }),
    'MCP_AGENT_AGENT_5FSUPPORT_CONNECTION_LINEAR_2DMCP_BEARER',
  );
  assert.equal(
    mcpHeaderEnvVar({ agentId: 'agent_support', connectionId: 'linear-mcp' }, 'X-Api-Key'),
    'MCP_AGENT_AGENT_5FSUPPORT_CONNECTION_LINEAR_2DMCP_HEADER_X_2DAPI_2DKEY',
  );
  assert.notEqual(
    mcpBearerEnvVar({ agentId: 'agent-a', connectionId: 'linear' }),
    mcpBearerEnvVar({ agentId: 'agent_a', connectionId: 'linear' }),
    'valid ids that differ by hyphen/underscore must not share an env override',
  );
});

test('same connection id stays isolated across agents, including deletion', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets(
      { agentId: 'agent_alpha', connectionId: 'linear' },
      { bearerToken: 'alpha-token', headers: { 'X-Api-Key': 'alpha-key' } },
      undefined,
      store,
    );
    await saveMcpSecrets(
      { agentId: 'agent_beta', connectionId: 'linear' },
      { bearerToken: 'beta-token', headers: { 'X-Api-Key': 'beta-key' } },
      undefined,
      store,
    );

    assert.deepEqual(
      await resolveMcpSecrets(
        { agentId: 'agent_alpha', connectionId: 'linear' },
        ['X-Api-Key'],
        undefined,
        store,
      ),
      { bearer: 'alpha-token', headers: { 'X-Api-Key': 'alpha-key' } },
    );
    assert.deepEqual(
      await resolveMcpSecrets(
        { agentId: 'agent_beta', connectionId: 'linear' },
        ['X-Api-Key'],
        undefined,
        store,
      ),
      { bearer: 'beta-token', headers: { 'X-Api-Key': 'beta-key' } },
    );

    await deleteMcpSecrets(
      { agentId: 'agent_alpha', connectionId: 'linear' },
      ['X-Api-Key'],
      undefined,
      store,
    );

    assert.deepEqual(
      await resolveMcpSecrets(
        { agentId: 'agent_alpha', connectionId: 'linear' },
        ['X-Api-Key'],
        undefined,
        store,
      ),
      { headers: {} },
    );
    assert.deepEqual(
      await resolveMcpSecrets(
        { agentId: 'agent_beta', connectionId: 'linear' },
        ['X-Api-Key'],
        undefined,
        store,
      ),
      { bearer: 'beta-token', headers: { 'X-Api-Key': 'beta-key' } },
    );
  } finally {
    store.close();
  }
});

test('resolveMcpSecrets reads stored bearer and header values', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets(
      TEST_REF,
      { bearerToken: 'stored-bearer', headers: { 'X-Api-Key': 'stored-header' } },
      undefined,
      store,
    );

    const resolved = await resolveMcpSecrets(TEST_REF, ['X-Api-Key'], undefined, store);
    assert.equal(resolved.bearer, 'stored-bearer');
    assert.deepEqual(resolved.headers, { 'X-Api-Key': 'stored-header' });
  } finally {
    store.close();
  }
});

test('header-only resolution does not read an unused bearer setting', async () => {
  const reads: string[] = [];
  const values = new Map([
    [mcpBearerSettingKey(TEST_REF), 'unused-bearer'],
    [mcpHeaderSettingKey(TEST_REF, 'X-Api-Key'), 'header-value'],
  ]);
  const store = {
    async getSetting(key: string) {
      reads.push(key);
      return values.get(key);
    },
  } as SettingsStore;

  assert.deepEqual(
    await resolveMcpHeaders(TEST_REF, ['X-Api-Key'], undefined, store),
    { 'X-Api-Key': 'header-value' },
  );
  assert.deepEqual(reads, [mcpHeaderSettingKey(TEST_REF, 'X-Api-Key')]);
});

test('env bearer wins over stored bearer', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets(TEST_REF, { bearerToken: 'stored-bearer' }, undefined, store);

    await withEnv({ MCP_AGENT_AGENT_5FTEST_CONNECTION_TEST_2DSRV_BEARER: 'env-bearer' }, async () => {
      const resolved = await resolveMcpSecrets(TEST_REF, [], undefined, store);
      assert.equal(resolved.bearer, 'env-bearer');

      const sources = await describeMcpSecretSources(TEST_REF, [], undefined, store);
      assert.equal(sources.bearer, 'env');
    });
  } finally {
    store.close();
  }
});

test('env header wins over stored header', async () => {
  const store = newStore();
  try {
    await saveMcpSecrets(TEST_REF, { headers: { 'X-Api-Key': 'stored-header' } }, undefined, store);

    await withEnv({ MCP_AGENT_AGENT_5FTEST_CONNECTION_TEST_2DSRV_HEADER_X_2DAPI_2DKEY: 'env-header' }, async () => {
      const resolved = await resolveMcpSecrets(TEST_REF, ['X-Api-Key'], undefined, store);
      assert.equal(resolved.headers['X-Api-Key'], 'env-header');

      const sources = await describeMcpSecretSources(TEST_REF, ['X-Api-Key'], undefined, store);
      assert.equal(sources.headers['X-Api-Key'], 'env');
    });
  } finally {
    store.close();
  }
});

test('missing secrets resolve to undefined and report missing', async () => {
  const store = newStore();
  try {
    const absentRef = { agentId: 'agent_test', connectionId: 'absent-srv' };
    const resolved = await resolveMcpSecrets(absentRef, ['X-Api-Key'], undefined, store);
    assert.equal(resolved.bearer, undefined);
    assert.deepEqual(resolved.headers, {});

    const sources = await describeMcpSecretSources(absentRef, ['X-Api-Key'], undefined, store);
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
      TEST_REF,
      { bearerToken: 'stored-bearer', headers: { 'X-Api-Key': 'stored-header' } },
      undefined,
      store,
    );

    const sources = await describeMcpSecretSources(TEST_REF, ['X-Api-Key'], undefined, store);
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
      TEST_REF,
      { bearerToken: 'stored-bearer', headers: { 'X-Api-Key': 'stored-header' } },
      undefined,
      store,
    );
    // A save that omits the bearer must leave the stored bearer untouched.
    await saveMcpSecrets(TEST_REF, { headers: { 'X-Other': 'other-val' } }, undefined, store);

    const resolved = await resolveMcpSecrets(TEST_REF, ['X-Api-Key', 'X-Other'], undefined, store);
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
      TEST_REF,
      { bearerToken: 'stored-bearer', headers: { 'X-Api-Key': 'a', 'X-Other': 'b' } },
      undefined,
      store,
    );

    await deleteMcpSecrets(TEST_REF, ['X-Api-Key', 'X-Other'], undefined, store);

    assert.equal(await store.getSetting(mcpBearerSettingKey(TEST_REF)), undefined);
    assert.equal(await store.getSetting(mcpHeaderSettingKey(TEST_REF, 'X-Api-Key')), undefined);
    assert.equal(await store.getSetting(mcpHeaderSettingKey(TEST_REF, 'X-Other')), undefined);

    const sources = await describeMcpSecretSources(
      TEST_REF,
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

test('staged profile-secret cleanup survives a partial failure and completes on retry', async () => {
  const persisted = newStore();
  const bearerKey = mcpBearerSettingKey(TEST_REF);
  const headerKey = mcpHeaderSettingKey(TEST_REF, 'X-Api-Key');
  let failHeaderDelete = true;
  const flakyStore: SettingsStore = {
    getSetting: (key) => persisted.getSetting(key),
    getSettings: (keys) => persisted.getSettings(keys),
    setSetting: (key, value) => persisted.setSetting(key, value),
    applySettingsPatch: (patch) => persisted.applySettingsPatch(patch),
    mergeSettingStringSet: (key, values) => persisted.mergeSettingStringSet(key, values),
    deleteSetting: async (key) => {
      if (failHeaderDelete && key === headerKey) {
        throw new Error('settings deletion unavailable');
      }
      await persisted.deleteSetting(key);
    },
  };

  try {
    await persisted.setSetting(bearerKey, 'tok');
    await persisted.setSetting(headerKey, 'val');
    await stageMcpSecretCleanup(TEST_REF.agentId, [bearerKey, headerKey], flakyStore);

    await assert.rejects(
      () => finishMcpSecretCleanup(TEST_REF.agentId, flakyStore),
      /settings deletion unavailable/,
    );
    assert.equal(await persisted.getSetting(bearerKey), undefined);
    assert.equal(await persisted.getSetting(headerKey), 'val');
    assert.equal(
      await persisted.getSetting(mcpSecretCleanupMarkerKey(TEST_REF.agentId)),
      JSON.stringify([bearerKey, headerKey]),
    );

    failHeaderDelete = false;
    assert.equal(await finishMcpSecretCleanup(TEST_REF.agentId, flakyStore), true);
    assert.equal(await persisted.getSetting(headerKey), undefined);
    assert.equal(await persisted.getSetting(mcpSecretCleanupMarkerKey(TEST_REF.agentId)), undefined);
    assert.equal(await finishMcpSecretCleanup(TEST_REF.agentId, flakyStore), false);
  } finally {
    persisted.close();
  }
});

test('staging cleanup unions prior inventory instead of orphaning older keys', async () => {
  const store = newStore();
  const oldKey = 'mcp.agent_test.old-srv.bearer';
  const currentKey = mcpBearerSettingKey(TEST_REF);
  try {
    await store.setSetting(oldKey, 'old');
    await store.setSetting(currentKey, 'current');
    await stageMcpSecretCleanup(TEST_REF.agentId, [oldKey], store);
    await stageMcpSecretCleanup(TEST_REF.agentId, [currentKey], store);

    assert.equal(
      await store.getSetting(mcpSecretCleanupMarkerKey(TEST_REF.agentId)),
      JSON.stringify([oldKey, currentKey]),
    );
    assert.equal(await finishMcpSecretCleanup(TEST_REF.agentId, store), true);
    assert.equal(await store.getSetting(oldKey), undefined);
    assert.equal(await store.getSetting(currentKey), undefined);
  } finally {
    store.close();
  }
});

test('cleanup markers cannot delete settings outside their agent scope', async () => {
  const store = newStore();
  try {
    const markerKey = mcpSecretCleanupMarkerKey(TEST_REF.agentId);
    await store.setSetting('slack.botToken', 'keep-me');
    await store.setSetting(markerKey, JSON.stringify(['slack.botToken']));

    await assert.rejects(
      () => finishMcpSecretCleanup(TEST_REF.agentId, store),
      /Invalid MCP secret-cleanup key/,
    );
    assert.equal(await store.getSetting('slack.botToken'), 'keep-me');
    assert.equal(await store.getSetting(markerKey), JSON.stringify(['slack.botToken']));
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

test('buildMcpRequestHeaders: bearer removes every case variant of Authorization', () => {
  const headers = buildMcpRequestHeaders('oauth', {
    bearer: 'oauth-secret',
    headers: {
      authorization: 'legacy-lower',
      AUTHORIZATION: 'legacy-upper',
      'X-Tenant': 'tenant-1',
    },
  });

  assert.deepEqual(headers, {
    'X-Tenant': 'tenant-1',
    Authorization: 'Bearer oauth-secret',
  });
  assert.equal(new Headers(headers).get('authorization'), 'Bearer oauth-secret');
});

test('buildMcpRequestHeaders: bearer mode with no resolved bearer emits no Authorization', () => {
  const headers = buildMcpRequestHeaders('bearer', { headers: { 'X-Api-Key': 'k1' } });
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers['X-Api-Key'], 'k1');
});
