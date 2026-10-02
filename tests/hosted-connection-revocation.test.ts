import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { connectionAccountSecretSettingKey } from '../src/config/connector-secrets.ts';
import { InstallationContextError, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { mcpOAuthSettingKeys } from '../src/config/mcp-oauth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ConnectionAccountInput } from '../src/config/types.ts';
import { revokeInstallationConnections } from '../src/connections/hosted-revocation.ts';
import { createManagedConnectionProviderRegistry, type ManagedConnectionProvider } from '../src/connections/managed.ts';

/**
 * Before an installation's data is erased, its host revokes every connection
 * on its own authority, exactly as each owner's revoke does: remote managed
 * accounts deleted, local secrets and OAuth settings removed, dependents
 * paused. Nothing of a neighbouring installation changes.
 */

const TEAM = 'T_REVOKE';

function provider(deleted: string[], fail = false): ManagedConnectionProvider {
  return {
    id: 'composio',
    validate: async () => undefined,
    execute: async () => { throw new Error('unused'); },
    revoke: async ({ policy }) => {
      if (fail) throw new Error('Composio is unreachable');
      deleted.push(policy.accountRef);
    },
  };
}

async function installation(t: TestContext, installationId: string) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  await config.createAgent({
    id: 'agent_revoke', name: 'Revoke', instructions: 'Help.', enabled: true,
    creatorMembershipId: 'membership_owner', editPolicy: 'creator_and_admins',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, transportMode: 'direct', defaultAgentId: 'agent_revoke' });
  const base = {
    workspaceId: TEAM, createdByMembershipId: 'membership_owner', lifecycle: 'ready' as const,
  };
  const accounts: ConnectionAccountInput[] = [
    {
      ...base, id: 'connection_api', ownerKind: 'team', providerId: 'api', label: 'Status API',
      secretRefId: 'secret_api',
      policy: {
        kind: 'api', allowedHosts: ['status.example'], pathPrefixes: ['/'], headerName: 'authorization',
        allowedMethods: ['GET'], authMode: 'credential',
      },
    },
    {
      ...base, id: 'connection_mcp', ownerKind: 'member', ownerMembershipId: 'membership_member',
      providerId: 'docs', label: 'Docs', secretRefId: 'secret_mcp',
      policy: {
        kind: 'mcp', url: 'https://docs.example/mcp', transport: 'streamable-http', authMode: 'oauth',
        headerNames: [], discoveredTools: [], allowedTools: [],
      },
    },
    {
      ...base, id: 'connection_managed', ownerKind: 'team', providerId: 'google', label: 'Team Gmail',
      secretRefId: 'secret_managed',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
        principalRef: `chickpea:staging:installation:${installationId}:organization:org`,
        accountRef: `ca_${installationId}`, allowedCapabilities: ['gmail.messages.search'],
      },
    },
    {
      ...base, id: 'connection_gone', ownerKind: 'member', ownerMembershipId: 'membership_member',
      providerId: 'api', label: 'Old API', secretRefId: 'secret_gone', lifecycle: 'revoked',
      policy: {
        kind: 'api', allowedHosts: ['old.example'], pathPrefixes: ['/'], headerName: 'authorization',
        allowedMethods: ['GET'], authMode: 'credential',
      },
    },
  ];
  for (const account of accounts) await config.putConnectionAccount(account, 0);
  await config.putAgentConnectionBinding({
    agentId: 'agent_revoke', connectionAccountId: 'connection_managed', providerId: 'google',
    allowedCapabilities: ['gmail.messages.search'], enabled: true,
  });
  await config.putAgentScheduleReference({
    scheduleId: 'schedule_revoke', agentId: 'agent_revoke', workspaceId: TEAM, channelId: 'C_REVOKE',
    createdByMembershipId: 'membership_owner', runsAsMembershipId: 'membership_owner',
    authorityReceiptId: 'authority_revoke', requiredConnectionAccountIds: ['connection_managed'], state: 'active',
  });
  await settings.setSetting(connectionAccountSecretSettingKey('secret_api'), `api-secret-${installationId}`);
  const mcpOAuth = mcpOAuthSettingKeys({ agentId: 'connection_mcp', connectionId: 'account' });
  await settings.setSetting(mcpOAuth[0], '{"client_id":"docs"}');
  await settings.setSetting(mcpOAuth[2], `{"access_token":"mcp-token-${installationId}"}`);
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as PlatformEnv, { installationId });
  const state = async () => ({
    accounts: Object.fromEntries((await config.listConnectionAccounts(TEAM)).map((account) => [account.id, account.lifecycle])),
    secrets: await settings.getSettings([connectionAccountSecretSettingKey('secret_api'), mcpOAuth[0], mcpOAuth[2]]),
    schedule: (await config.listAgentScheduleReferences('agent_revoke'))[0]!.state,
  });
  return { env, config, settings, state };
}

test('every connection of one installation is revoked, managed accounts first, and its neighbour keeps its own', async (t) => {
  const a = await installation(t, 'inst_revoke_a');
  const b = await installation(t, 'inst_revoke_b');
  const neighbour = await b.state();
  const deleted: string[] = [];
  const providers = createManagedConnectionProviderRegistry([provider(deleted)]);

  const revocation = await revokeInstallationConnections(a.env, { config: a.config, settings: a.settings, providers });
  assert.deepEqual(revocation.accounts.map(({ connectionAccountId, kind, outcome }) => [connectionAccountId, kind, outcome]), [
    ['connection_managed', 'managed', 'revoked'],
    ['connection_mcp', 'mcp', 'revoked'],
    ['connection_api', 'api', 'revoked'],
    ['connection_gone', 'api', 'already_revoked'],
  ]);
  assert.deepEqual({ revoked: revocation.revoked, alreadyRevoked: revocation.alreadyRevoked, failed: revocation.failed, done: revocation.done },
    { revoked: 3, alreadyRevoked: 1, failed: 0, done: true });
  assert.equal(revocation.accounts[0]!.adapterId, 'composio');
  assert.deepEqual(deleted, ['ca_inst_revoke_a'], 'only this installation\'s remote account is deleted');
  assert.deepEqual(await a.state(), {
    accounts: { connection_api: 'revoked', connection_gone: 'revoked', connection_managed: 'revoked', connection_mcp: 'revoked' },
    secrets: [undefined, undefined, undefined],
    schedule: 'needs_attention',
  });
  assert.deepEqual(await b.state(), neighbour);

  // A repeat changes nothing and deletes nothing remotely that was not already gone.
  const repeat = await revokeInstallationConnections(a.env, { config: a.config, settings: a.settings, providers });
  assert.deepEqual({ revoked: repeat.revoked, alreadyRevoked: repeat.alreadyRevoked, done: repeat.done },
    { revoked: 0, alreadyRevoked: 4, done: true });
  assert.deepEqual(deleted, ['ca_inst_revoke_a']);
});

test('a managed account whose provider fails stays fail-closed and is revoked on the next call', async (t) => {
  const a = await installation(t, 'inst_revoke_retry');
  const deleted: string[] = [];
  const failing = await revokeInstallationConnections(a.env, {
    config: a.config, settings: a.settings, providers: createManagedConnectionProviderRegistry([provider(deleted, true)]),
  });
  assert.equal(failing.done, false);
  assert.deepEqual(failing.accounts.filter(({ outcome }) => outcome === 'failed').map(({ connectionAccountId, error }) => [connectionAccountId, error]),
    [['connection_managed', 'Error']]);
  // Paused and unusable, never quietly ready while its remote account lives.
  assert.equal((await a.state()).accounts.connection_managed, 'needs_attention');
  assert.equal((await a.state()).schedule, 'needs_attention');
  const unavailable = await revokeInstallationConnections(a.env, {
    config: a.config, settings: a.settings, providers: createManagedConnectionProviderRegistry([]),
  });
  assert.deepEqual(unavailable.accounts.filter(({ outcome }) => outcome === 'failed').map(({ error }) => error),
    ['ManagedConnectionProviderUnavailableError']);

  const retried = await revokeInstallationConnections(a.env, {
    config: a.config, settings: a.settings, providers: createManagedConnectionProviderRegistry([provider(deleted)]),
  });
  assert.equal(retried.done, true);
  assert.deepEqual(deleted, ['ca_inst_revoke_retry']);
  assert.equal((await a.state()).accounts.connection_managed, 'revoked');
});

test('a host may revoke only one member\'s connections, or the listed ones, and standalone is refused', async (t) => {
  const a = await installation(t, 'inst_revoke_scoped');
  const deleted: string[] = [];
  const providers = createManagedConnectionProviderRegistry([provider(deleted)]);
  const member = await revokeInstallationConnections(a.env, {
    config: a.config, settings: a.settings, providers, ownerMembershipId: 'membership_member',
  });
  assert.deepEqual(member.accounts.map(({ connectionAccountId }) => connectionAccountId), ['connection_mcp', 'connection_gone']);
  assert.deepEqual((await a.state()).accounts, {
    connection_api: 'ready', connection_gone: 'revoked', connection_managed: 'ready', connection_mcp: 'revoked',
  });
  const listed = await revokeInstallationConnections(a.env, {
    config: a.config, settings: a.settings, providers, connectionAccountIds: ['connection_api'],
  });
  assert.deepEqual(listed.accounts.map(({ connectionAccountId }) => connectionAccountId), ['connection_api']);
  assert.deepEqual(deleted, []);
  await assert.rejects(revokeInstallationConnections({} as PlatformEnv, { config: a.config, settings: a.settings, providers }),
    InstallationContextError);
});
