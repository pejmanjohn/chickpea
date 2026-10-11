import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  clearConnectorCredential,
  connectionAccountSecretEnvVar,
  connectionAccountSecretSettingKey,
  connectorCredentialEnvVar,
  connectorCredentialBindingEnvVar,
  connectorCredentialSettingKey,
  connectorSecretCleanupMarkerKey,
  describeConnectorCredentialSource,
  finishConnectorSecretCleanup,
  resolveConnectionAccountSecret,
  resolveConnectorCredential,
  saveConnectorCredential,
  saveConnectionAccountSecret,
  stageConnectorSecretCleanup,
} from '../src/config/connector-secrets.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { withEnv } from './helpers/env.ts';

function newStore(): SqliteSettingsStore {
  return new SqliteSettingsStore(':memory:');
}

const TEST_AGENT_ID = 'agent_test';
const TEST_CONNECTION_ID = 'linear-api';

function testRef(agentId: string, connectionId: string) {
  const digest = createHash('sha256').update(`${agentId}\0${connectionId}`).digest('hex');
  return {
    agentId,
    connectionId,
    credentialRef: `connection_${digest.slice(0, 32)}`,
    credentialBinding: `test:${digest}`,
  };
}

const TEST_REF = testRef(TEST_AGENT_ID, TEST_CONNECTION_ID);

test('connection-account credentials are reusable and independent from Agent ids', async () => {
  const store = newStore();
  try {
    await saveConnectionAccountSecret('secret_shared', 'shared-value', undefined, store);
    assert.equal(
      connectionAccountSecretSettingKey('secret_shared'),
      'connection-account.secret_shared.credential',
    );
    assert.equal(
      connectionAccountSecretEnvVar('secret_shared'),
      'CONNECTION_ACCOUNT_SECRET_5FSHARED_CREDENTIAL',
    );
    assert.equal(
      await resolveConnectionAccountSecret({ secretRefId: 'secret_shared' }, undefined, store),
      'shared-value',
    );
  } finally {
    store.close();
  }
});

test('connector credential keys and collision-safe environment names include both scopes', () => {
  assert.equal(
    connectorCredentialSettingKey(testRef('agent_support', 'linear-api')),
    `connector.agent_support.credential.${testRef('agent_support', 'linear-api').credentialRef}.credential`,
  );
  assert.equal(
    connectorCredentialEnvVar(testRef('agent_support', 'linear-api')),
    'CONNECTOR_AGENT_AGENT_5FSUPPORT_CONNECTION_LINEAR_2DAPI_CREDENTIAL',
  );
  assert.notEqual(
    connectorCredentialEnvVar(testRef('agent-a', 'linear')),
    connectorCredentialEnvVar(testRef('agent_a', 'linear')),
    'valid ids that differ by hyphen/underscore must not share an env override',
  );
});

test('saveConnectorCredential resolves the raw stored credential', async () => {
  const store = newStore();
  try {
    await saveConnectorCredential(
      TEST_REF,
      'stored-credential',
      undefined,
      store,
    );

    assert.equal(
      await resolveConnectorCredential(
        TEST_REF,
        undefined,
        store,
      ),
      'stored-credential',
    );
    assert.equal(
      await store.getSetting(
        connectorCredentialSettingKey(TEST_REF),
      ),
      'stored-credential',
    );
  } finally {
    store.close();
  }
});

test('environment credential overrides the stored credential', async () => {
  const store = newStore();
  const envVar = connectorCredentialEnvVar(TEST_REF);
  try {
    await saveConnectorCredential(
      TEST_REF,
      'stored-credential',
      undefined,
      store,
    );

    await withEnv({
      [envVar]: 'environment-credential',
      [connectorCredentialBindingEnvVar(TEST_REF)]: TEST_REF.credentialBinding,
    }, async () => {
      assert.equal(
        await resolveConnectorCredential(
          TEST_REF,
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

test('an unbound or differently bound environment credential is ignored', async () => {
  const store = newStore();
  const envVar = connectorCredentialEnvVar(TEST_REF);
  const bindingVar = connectorCredentialBindingEnvVar(TEST_REF);
  try {
    await saveConnectorCredential(TEST_REF, 'stored-credential', undefined, store);
    await withEnv({ [envVar]: 'unbound-environment-credential' }, async () => {
      assert.equal(
        await resolveConnectorCredential(TEST_REF, undefined, store),
        'stored-credential',
      );
    });
    await withEnv({
      [envVar]: 'wrongly-bound-environment-credential',
      [bindingVar]: 'v1:another-policy',
    }, async () => {
      assert.equal(
        await resolveConnectorCredential(TEST_REF, undefined, store),
        'stored-credential',
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
      TEST_REF,
      'stored-credential',
      undefined,
      store,
    );
    await clearConnectorCredential(TEST_REF, undefined, store);

    assert.equal(
      await resolveConnectorCredential(
        TEST_REF,
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
  const envVar = connectorCredentialEnvVar(TEST_REF);
  try {
    assert.equal(
      await describeConnectorCredentialSource(
        TEST_REF,
        undefined,
        store,
      ),
      'missing',
    );

    await saveConnectorCredential(
      TEST_REF,
      'stored-secret-value',
      undefined,
      store,
    );
    const storedSource = await describeConnectorCredentialSource(
      TEST_REF,
      undefined,
      store,
    );
    assert.equal(storedSource, 'stored');
    assert.doesNotMatch(JSON.stringify(storedSource), /stored-secret-value/);

    await withEnv({
      [envVar]: 'environment-secret-value',
      [connectorCredentialBindingEnvVar(TEST_REF)]: TEST_REF.credentialBinding,
    }, async () => {
      const envSource = await describeConnectorCredentialSource(
        TEST_REF,
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
  const linearRef = testRef(TEST_AGENT_ID, 'linear-api');
  const githubRef = testRef(TEST_AGENT_ID, 'github-api');
  const linearKey = connectorCredentialSettingKey(linearRef);
  const githubKey = connectorCredentialSettingKey(githubRef);
  let failGithubDelete = true;
  const flakyStore: SettingsStore = {
    getSetting: (key) => persisted.getSetting(key),
    getSettings: (keys) => persisted.getSettings(keys),
    setSetting: (key, value) => persisted.setSetting(key, value),
    applySettingsPatch: (patch) => persisted.applySettingsPatch(patch),
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
      [linearRef, githubRef],
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

test('an old Agent cleanup scope cannot absorb a replacement Agent connector secret', async () => {
  const store = newStore();
  const oldScope = `v1:${'b'.repeat(43)}`;
  const oldRef = testRef(TEST_AGENT_ID, 'old-api');
  const replacementRef = testRef(TEST_AGENT_ID, 'replacement-api');
  const oldKey = connectorCredentialSettingKey(oldRef);
  const replacementKey = connectorCredentialSettingKey(replacementRef);
  try {
    await saveConnectorCredential(oldRef, 'old-secret', undefined, store);
    await stageConnectorSecretCleanup(TEST_AGENT_ID, [oldRef], undefined, store, oldScope);
    await saveConnectorCredential(replacementRef, 'replacement-secret', undefined, store);
    await stageConnectorSecretCleanup(TEST_AGENT_ID, [replacementRef], undefined, store);

    assert.equal(
      await finishConnectorSecretCleanup(TEST_AGENT_ID, undefined, store, oldScope),
      true,
    );
    assert.equal(await store.getSetting(oldKey), undefined);
    assert.equal(await store.getSetting(replacementKey), 'replacement-secret');
    assert.equal(
      await store.getSetting(connectorSecretCleanupMarkerKey(TEST_AGENT_ID)),
      JSON.stringify([replacementKey]),
    );
  } finally {
    store.close();
  }
});
