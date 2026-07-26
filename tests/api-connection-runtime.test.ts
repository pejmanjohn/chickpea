import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveApiConnectionsForTurn } from '../src/agents/slack-thread.ts';
import { googleWorkspaceApiPolicy } from '../src/config/api-oauth-policy.ts';
import type { ApiConnectionConfig } from '../src/config/types.ts';

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
    ref: { agentId: 'agent_google', connectionId: 'google-workspace' },
    provider: 'google',
  }]);
  assert.deepEqual(resolved, [{
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

  assert.deepEqual(resolved[0]?.connectors, [
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
