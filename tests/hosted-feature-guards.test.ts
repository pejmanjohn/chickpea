import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectionAccountSecretEnvVar,
  connectorCredentialEnvVar,
  describeConnectorCredentialSource,
  resolveConnectionAccountSecret,
  resolveConnectorCredential,
  saveConnectionAccountSecret,
  saveConnectorCredential,
} from '../src/config/connector-secrets.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  describeMcpSecretSources,
  mcpBearerEnvVar,
  mcpHeaderEnvVar,
  resolveMcpSecrets,
  saveMcpSecrets,
} from '../src/config/mcp-secrets.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { withEnv } from './helpers/env.ts';

/**
 * Features a deployment serving many installations must not share across
 * them: a deployment variable never answers for one installation's
 * connection credentials.
 */

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const ENV_A = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_guard_a' });
const ENV_B = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_guard_b' });
// Agent and connection IDs are local to an installation, so both have the same ones.
const ACCOUNT = { secretRefId: 'secret_shared' };
const CONNECTOR = { agentId: 'agent_shared', connectionId: 'crm' };
const MCP = { agentId: 'agent_shared', connectionId: 'docs' };
const DEPLOYMENT_VARIABLES = {
  CHICKPEA_TENANCY: undefined,
  [connectionAccountSecretEnvVar(ACCOUNT.secretRefId)]: 'deployment-account-secret',
  [connectorCredentialEnvVar(CONNECTOR.agentId, CONNECTOR.connectionId)]: 'deployment-connector-secret',
  [mcpBearerEnvVar(MCP)]: 'deployment-mcp-bearer',
  [mcpHeaderEnvVar(MCP, 'X-Team')]: 'deployment-mcp-header',
};

test('under tenancy a deployment variable never answers for an installation\'s connection credentials', async (t) => {
  const settingsA = new SqliteSettingsStore(':memory:');
  const settingsB = new SqliteSettingsStore(':memory:');
  t.after(() => { settingsA.close(); settingsB.close(); });
  await saveConnectionAccountSecret(ACCOUNT.secretRefId, 'a-account-secret', ENV_A, settingsA);
  await saveConnectorCredential(CONNECTOR.agentId, CONNECTOR.connectionId, 'a-connector-secret', ENV_A, settingsA);
  await saveMcpSecrets(MCP, { bearerToken: 'a-mcp-bearer', headers: { 'X-Team': 'a-mcp-header' } }, ENV_A, settingsA);

  await withEnv(DEPLOYMENT_VARIABLES, async () => {
    // A's own settings answer; B, with none, gets nothing rather than the deployment's.
    assert.equal(await resolveConnectionAccountSecret(ACCOUNT, ENV_A, settingsA), 'a-account-secret');
    assert.equal(await resolveConnectionAccountSecret(ACCOUNT, ENV_B, settingsB), undefined);
    assert.equal(await resolveConnectorCredential(CONNECTOR, ENV_A, settingsA), 'a-connector-secret');
    assert.equal(await resolveConnectorCredential(CONNECTOR, ENV_B, settingsB), undefined);
    assert.equal(await describeConnectorCredentialSource(CONNECTOR.agentId, CONNECTOR.connectionId, ENV_A, settingsA), 'stored');
    assert.equal(await describeConnectorCredentialSource(CONNECTOR.agentId, CONNECTOR.connectionId, ENV_B, settingsB), 'missing');
    assert.deepEqual(await resolveMcpSecrets(MCP, ['X-Team'], ENV_A, settingsA),
      { bearer: 'a-mcp-bearer', headers: { 'X-Team': 'a-mcp-header' } });
    assert.deepEqual(await resolveMcpSecrets(MCP, ['X-Team'], ENV_B, settingsB), { headers: {} });
    assert.deepEqual(await describeMcpSecretSources(MCP, ['X-Team'], ENV_B, settingsB),
      { bearer: 'missing', headers: { 'X-Team': 'missing' } });

    // A caller that passes no env still gets the deployment's own tenancy.
    await withEnv({ CHICKPEA_TENANCY: 'installation' }, async () => {
      assert.equal(await resolveConnectionAccountSecret(ACCOUNT, undefined, settingsB), undefined);
      assert.deepEqual(await resolveMcpSecrets(MCP, ['X-Team'], undefined, settingsB), { headers: {} });
    });
  });
});

test('standalone still reads the deployment variable first, as before', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await saveConnectionAccountSecret(ACCOUNT.secretRefId, 'stored-account-secret', undefined, settings);
  await saveConnectorCredential(CONNECTOR.agentId, CONNECTOR.connectionId, 'stored-connector-secret', undefined, settings);
  await saveMcpSecrets(MCP, { bearerToken: 'stored-mcp-bearer' }, undefined, settings);
  await withEnv(DEPLOYMENT_VARIABLES, async () => {
    assert.equal(await resolveConnectionAccountSecret(ACCOUNT, undefined, settings), 'deployment-account-secret');
    assert.equal(await resolveConnectorCredential(CONNECTOR, undefined, settings), 'deployment-connector-secret');
    assert.equal(await describeConnectorCredentialSource(CONNECTOR.agentId, CONNECTOR.connectionId, undefined, settings), 'env');
    assert.deepEqual(await resolveMcpSecrets(MCP, ['X-Team'], undefined, settings),
      { bearer: 'deployment-mcp-bearer', headers: { 'X-Team': 'deployment-mcp-header' } });
    assert.deepEqual(await describeMcpSecretSources(MCP, ['X-Team'], undefined, settings),
      { bearer: 'env', headers: { 'X-Team': 'env' } });
  });
});
