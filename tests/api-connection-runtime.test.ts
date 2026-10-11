import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveApiConnectionsForTurn } from '../src/agents/slack-thread.ts';
import { googleWorkspaceApiPolicy } from '../src/config/api-oauth-policy.ts';
import { boundApiCredentialRef } from '../src/config/connection-credential-binding.ts';
import { closeNodeStateStores, getConfigStore } from '../src/config/state-backend.ts';
import type { ApiConnectionConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];

function googleConnection(overrides: Partial<ApiConnectionConfig> = {}): ApiConnectionConfig {
  return {
    id: 'google-workspace',
    displayName: 'Google Workspace',
    ...googleWorkspaceApiPolicy(scopes),
    enabled: true,
    authMode: 'oauth',
    oauthProvider: 'google',
    oauthScopes: scopes,
    oauthAppType: 'workspace-internal',
    lifecycleStatus: 'ready',
    statusText: 'Connected',
    presetId: 'google-workspace',
    credentialRef: 'connection_11111111111111111111111111111111',
    ...overrides,
  };
}

test('turn-time API resolution injects Google OAuth only at the guarded connector boundary', async () => {
  const calls: unknown[] = [];
  const resolved = await resolveApiConnectionsForTurn(
    'agent_google',
    [googleConnection()],
    undefined,
    {
      resolveCredential: async () => {
        throw new Error('static credentials must not be read for OAuth');
      },
      resolveOAuthToken: async (input) => {
        calls.push(input);
        return 'live-google-access-token';
      },
    },
  );

  assert.deepEqual(calls, [{
    ref: boundApiCredentialRef('agent_google', googleConnection()),
    provider: 'google',
  }]);
  assert.equal(typeof resolved[0]?.connectors[0]?.authorize, 'function');
  assert.deepEqual(resolved.map(({ connectors, ...entry }) => ({
    ...entry,
    connectors: connectors.map(({ authorize: _authorize, ...connector }) => connector),
  })), [{
    displayName: 'Google Workspace',
    policy: googleConnection(),
    connectors: [{
      allowedHosts: ['gmail.googleapis.com'],
      pathPrefixes: ['/gmail/v1/users/me'],
      headerName: 'Authorization',
      headerValue: 'Bearer live-google-access-token',
      allowedMethods: ['GET', 'HEAD'],
    }],
  }]);
  assert.doesNotMatch(JSON.stringify(resolved[0]?.policy), /live-google-access-token/);
});

test('turn-time API resolution skips pending, widened, and unavailable OAuth connections', async () => {
  let tokenCalls = 0;
  const resolveOAuthToken = async () => {
    tokenCalls += 1;
    throw new Error('reauthorization required');
  };
  const resolved = await resolveApiConnectionsForTurn(
    'agent_google',
    [
      googleConnection({ id: 'pending', lifecycleStatus: 'pending' }),
      googleConnection({ id: 'widened', allowedHosts: ['evil.example.com'] }),
      googleConnection({ id: 'unavailable' }),
    ],
    undefined,
    { resolveCredential: async () => undefined, resolveOAuthToken },
  );
  assert.deepEqual(resolved, []);
  assert.equal(tokenCalls, 1);
});

test('mixed Google access keeps write methods scoped to the selected service', async () => {
  const mixedScopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/drive.readonly',
  ];
  const resolved = await resolveApiConnectionsForTurn(
    'agent_google',
    [googleConnection({
      ...googleWorkspaceApiPolicy(mixedScopes),
      oauthScopes: mixedScopes,
    })],
    undefined,
    {
      resolveCredential: async () => undefined,
      resolveOAuthToken: async () => 'live-google-access-token',
    },
  );

  assert.ok(resolved[0]?.connectors.every(({ authorize }) => typeof authorize === 'function'));
  assert.deepEqual(resolved[0]?.connectors.map(({ authorize: _authorize, ...connector }) => connector), [
    {
      allowedHosts: ['gmail.googleapis.com'],
      pathPrefixes: ['/gmail/v1/users/me'],
      headerName: 'Authorization',
      headerValue: 'Bearer live-google-access-token',
      allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    },
    {
      allowedHosts: ['www.googleapis.com'],
      pathPrefixes: ['/drive/v3'],
      headerName: 'Authorization',
      headerValue: 'Bearer live-google-access-token',
      allowedMethods: ['GET', 'HEAD'],
    },
  ]);
});

test('a resolved static connector refuses egress after disable or policy retarget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-api-binding-'));
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      const config = getConfigStore();
      const created = await config.createAgent({
        id: 'agent_api_binding',
        name: 'API binding',
        instructions: 'Use the reviewed API only.',
        enabled: true,
        skills: [],
        mcpServers: [],
        apiConnections: [{
          id: 'tasks-api',
          displayName: 'Tasks API',
          allowedHosts: ['api.example.com'],
          pathPrefixes: ['/v1/tasks'],
          headerName: 'Authorization',
          headerValuePrefix: 'Bearer ',
          allowedMethods: ['GET'],
          enabled: true,
          authMode: 'credential',
        }],
        repositories: [],
      });
      const frozen = created.apiConnections[0]!;
      const resolved = await resolveApiConnectionsForTurn(
        created.id,
        [frozen],
        undefined,
        { resolveCredential: async () => 'static-secret' },
      );
      const authorize = resolved[0]?.connectors[0]?.authorize;
      assert.ok(authorize);
      assert.equal(await authorize(), true);

      const disabled = await config.updateAgent(created.id, {
        apiConnections: [{ ...frozen, enabled: false }],
      }, created.revision);
      assert.equal(await authorize(), false, 'disabling a connection revokes an in-flight connector');

      const retargeted = await config.updateAgent(created.id, {
        apiConnections: [{
          ...disabled.apiConnections[0]!,
          enabled: true,
          allowedHosts: ['other.example.com'],
        }],
      }, disabled.revision);
      assert.notEqual(
        retargeted.apiConnections[0]?.credentialRef,
        frozen.credentialRef,
        'retargeting rotates the secret identity',
      );
      assert.equal(await authorize(), false, 'a frozen connector cannot use the old secret after retargeting');
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});
