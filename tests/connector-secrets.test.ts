import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearConnectorCredential,
  connectorCredentialEnvVar,
  connectorCredentialSettingKey,
  connectorSecretCleanupMarkerKey,
  describeConnectorCredentialSource,
  finishConnectorSecretCleanup,
  resolveConnectorCredential,
  saveConnectorCredential,
  stageConnectorSecretCleanup,
} from '../src/config/connector-secrets.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { withEnv } from './helpers/env.ts';

function newStore(): SqliteSettingsStore {
  return new SqliteSettingsStore(':memory:');
}

const TEST_AGENT_ID = 'agent_test';
const TEST_CONNECTION_ID = 'linear-api';

test('connector credential keys and collision-safe environment names include both scopes', () => {
  assert.equal(
    connectorCredentialSettingKey('agent_support', 'linear-api'),
    'connector.agent_support.linear-api.credential',
  );
  assert.equal(
    connectorCredentialEnvVar('agent_support', 'linear-api'),
    'CONNECTOR_AGENT_AGENT_5FSUPPORT_CONNECTION_LINEAR_2DAPI_CREDENTIAL',
  );
  assert.notEqual(
    connectorCredentialEnvVar('agent-a', 'linear'),
    connectorCredentialEnvVar('agent_a', 'linear'),
    'valid ids that differ by hyphen/underscore must not share an env override',
  );
});

test('saveConnectorCredential resolves the raw stored credential', async () => {
  const store = newStore();
  try {
    await saveConnectorCredential(
      TEST_AGENT_ID,
      TEST_CONNECTION_ID,
      'stored-credential',
      undefined,
      store,
    );

    assert.equal(
      await resolveConnectorCredential(
        { agentId: TEST_AGENT_ID, connectionId: TEST_CONNECTION_ID },
        undefined,
        store,
      ),
      'stored-credential',
    );
    assert.equal(
      await store.getSetting(
        connectorCredentialSettingKey(TEST_AGENT_ID, TEST_CONNECTION_ID),
      ),
      'stored-credential',
    );
  } finally {
    store.close();
  }
});

test('environment credential overrides the stored credential', async () => {
  const store = newStore();
  const envVar = connectorCredentialEnvVar(TEST_AGENT_ID, TEST_CONNECTION_ID);
  try {
    await saveConnectorCredential(
      TEST_AGENT_ID,
      TEST_CONNECTION_ID,
      'stored-credential',
      undefined,
      store,
    );

    await withEnv({ [envVar]: 'environment-credential' }, async () => {
      assert.equal(
        await resolveConnectorCredential(
          { agentId: TEST_AGENT_ID, connectionId: TEST_CONNECTION_ID },
          undefined,
          store,
        ),
        'environment-credential',
      );
    });
  } finally {
    store.close();
  }
});

test('clearConnectorCredential removes the stored credential', async () => {
  const store = newStore();
  try {
    await saveConnectorCredential(
      TEST_AGENT_ID,
      TEST_CONNECTION_ID,
      'stored-credential',
      undefined,
      store,
    );
    await clearConnectorCredential(TEST_AGENT_ID, TEST_CONNECTION_ID, undefined, store);

    assert.equal(
      await resolveConnectorCredential(
        { agentId: TEST_AGENT_ID, connectionId: TEST_CONNECTION_ID },
        undefined,
        store,
      ),
      undefined,
    );
  } finally {
    store.close();
  }
});

test('describeConnectorCredentialSource reports only env, stored, or missing', async () => {
  const store = newStore();
  const envVar = connectorCredentialEnvVar(TEST_AGENT_ID, TEST_CONNECTION_ID);
  try {
    assert.equal(
      await describeConnectorCredentialSource(
        TEST_AGENT_ID,
        TEST_CONNECTION_ID,
        undefined,
        store,
      ),
      'missing',
    );

    await saveConnectorCredential(
      TEST_AGENT_ID,
      TEST_CONNECTION_ID,
      'stored-secret-value',
      undefined,
      store,
    );
    const storedSource = await describeConnectorCredentialSource(
      TEST_AGENT_ID,
      TEST_CONNECTION_ID,
      undefined,
      store,
    );
    assert.equal(storedSource, 'stored');
    assert.doesNotMatch(JSON.stringify(storedSource), /stored-secret-value/);

    await withEnv({ [envVar]: 'environment-secret-value' }, async () => {
      const envSource = await describeConnectorCredentialSource(
        TEST_AGENT_ID,
        TEST_CONNECTION_ID,
        undefined,
        store,
      );
      assert.equal(envSource, 'env');
      assert.doesNotMatch(JSON.stringify(envSource), /environment-secret-value/);
    });
  } finally {
    store.close();
  }
});

test('staged connector cleanup survives partial failure and finishes on retry', async () => {
  const persisted = newStore();
  const linearKey = connectorCredentialSettingKey(TEST_AGENT_ID, 'linear-api');
  const githubKey = connectorCredentialSettingKey(TEST_AGENT_ID, 'github-api');
  let failGithubDelete = true;
  const flakyStore: SettingsStore = {
    getSetting: (key) => persisted.getSetting(key),
    setSetting: (key, value) => persisted.setSetting(key, value),
    mergeSettingStringSet: (key, values) => persisted.mergeSettingStringSet(key, values),
    deleteSetting: async (key) => {
      if (failGithubDelete && key === githubKey) {
        throw new Error('settings deletion unavailable');
      }
      await persisted.deleteSetting(key);
    },
  };

  try {
    await persisted.setSetting(linearKey, 'linear-secret');
    await persisted.setSetting(githubKey, 'github-secret');
    await stageConnectorSecretCleanup(
      TEST_AGENT_ID,
      ['linear-api', 'github-api'],
      undefined,
      flakyStore,
    );

    await assert.rejects(
      () => finishConnectorSecretCleanup(TEST_AGENT_ID, undefined, flakyStore),
      /settings deletion unavailable/,
    );
    assert.equal(await persisted.getSetting(linearKey), undefined);
    assert.equal(await persisted.getSetting(githubKey), 'github-secret');
    assert.equal(
      await persisted.getSetting(connectorSecretCleanupMarkerKey(TEST_AGENT_ID)),
      JSON.stringify([linearKey, githubKey]),
    );

    failGithubDelete = false;
    assert.equal(
      await finishConnectorSecretCleanup(TEST_AGENT_ID, undefined, flakyStore),
      true,
    );
    assert.equal(await persisted.getSetting(githubKey), undefined);
    assert.equal(
      await persisted.getSetting(connectorSecretCleanupMarkerKey(TEST_AGENT_ID)),
      undefined,
    );
    assert.equal(
      await finishConnectorSecretCleanup(TEST_AGENT_ID, undefined, flakyStore),
      false,
    );
  } finally {
    persisted.close();
  }
});
