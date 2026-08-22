import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

import {
  completeMcpOAuthAuthorization,
  createMcpOAuthClientMetadata,
  createMcpOAuthClientMetadataDocument,
  McpOAuthError,
  mcpOAuthSettingKeys,
  resolveMcpOAuthAccessToken,
  startMcpOAuthAuthorization,
} from '../src/config/mcp-oauth.ts';
import {
  SqliteSettingsStore,
  type SettingsPatch,
  type SettingsStore,
} from '../src/config/settings-store.ts';

const REF = { agentId: 'agent_test', connectionId: 'notion-mcp' };
const SERVER_URL = 'https://mcp.example.test/mcp';
const CALLBACK_URL = 'https://chickpea.example.test/oauth/callback';
const METADATA_URL =
  'https://chickpea.example.test/.well-known/oauth-client-metadata.json';

interface FakeOAuthServerOptions {
  clientSecret?: string;
  clientSecretExpiresAt?: number;
  cimd?: boolean;
  codeChallengeMethods?: string[];
  exchangeError?: string;
  initialExpiresIn?: number;
  issuer?: string;
  omitInitialRefreshToken?: boolean;
  omitRefreshTokenOnRefresh?: boolean;
  registrationAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none';
  registrationDelayMs?: number;
  refreshError?: string;
  tokenAuthMethods?: Array<'client_secret_basic' | 'client_secret_post' | 'none'>;
}

function fakeOAuthServer(options: FakeOAuthServerOptions = {}) {
  const calls: Array<{ url: string; body?: URLSearchParams }> = [];
  let registrations = 0;
  let exchanges = 0;
  let refreshes = 0;

  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = request.url;
    const rawBody =
      request.method === 'GET' || request.method === 'HEAD'
        ? ''
        : await request.clone().text();
    const body =
      request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
        ? new URLSearchParams(rawBody)
        : undefined;
    calls.push({ url, ...(body ? { body } : {}) });

    if (
      url ===
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp'
    ) {
      return Response.json({
        resource: SERVER_URL,
        authorization_servers: ['https://auth.example.test'],
        scopes_supported: ['read', 'write'],
      });
    }
    if (
      url ===
      'https://auth.example.test/.well-known/oauth-authorization-server'
    ) {
      return Response.json({
        issuer: options.issuer ?? 'https://auth.example.test',
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://auth.example.test/token',
        registration_endpoint: 'https://auth.example.test/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: options.codeChallengeMethods ?? ['S256'],
        token_endpoint_auth_methods_supported: options.tokenAuthMethods ?? ['none'],
        client_id_metadata_document_supported: options.cimd ?? false,
      });
    }
    if (url === 'https://auth.example.test/register') {
      registrations += 1;
      await new Promise((resolve) =>
        setTimeout(resolve, options.registrationDelayMs ?? 10),
      );
      const metadata = JSON.parse(rawBody) as OAuthClientMetadata;
      assert.deepEqual(metadata.redirect_uris, [CALLBACK_URL]);
      return Response.json({
        ...metadata,
        client_id: 'registered-client',
        ...(options.clientSecret
          ? { client_secret: options.clientSecret }
          : {}),
        ...(options.clientSecretExpiresAt !== undefined
          ? { client_secret_expires_at: options.clientSecretExpiresAt }
          : {}),
        ...(options.registrationAuthMethod
          ? { token_endpoint_auth_method: options.registrationAuthMethod }
          : {}),
      });
    }
    if (url === 'https://auth.example.test/token') {
      if (options.clientSecret) {
        assert.equal(body?.get('client_id'), 'registered-client');
        assert.equal(body?.get('client_secret'), options.clientSecret);
        assert.equal(request.headers.get('authorization'), null);
      }
      const grantType = body?.get('grant_type');
      if (grantType === 'authorization_code') {
        exchanges += 1;
        assert.equal(body?.get('code'), 'provider-code');
        assert.equal(body?.get('redirect_uri'), CALLBACK_URL);
        assert.ok(body?.get('code_verifier'));
        assert.equal(body?.get('resource'), SERVER_URL);
        if (options.exchangeError) {
          return Response.json(
            { error: options.exchangeError, error_description: 'exchange rejected' },
            { status: 400 },
          );
        }
        return Response.json({
          access_token: 'access-initial',
          token_type: 'Bearer',
          ...(options.omitInitialRefreshToken
            ? {}
            : { refresh_token: 'refresh-initial' }),
          expires_in: options.initialExpiresIn ?? 3600,
          scope: 'read',
        });
      }
      if (grantType === 'refresh_token') {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (options.refreshError) {
          return Response.json(
            {
              error: options.refreshError,
              error_description: 'refresh rejected',
            },
            { status: 400 },
          );
        }
        assert.equal(body?.get('refresh_token'), 'refresh-initial');
        assert.equal(body?.get('resource'), SERVER_URL);
        return Response.json({
          access_token: 'access-refreshed',
          token_type: 'Bearer',
          ...(options.omitRefreshTokenOnRefresh
            ? {}
            : { refresh_token: 'refresh-rotated' }),
          expires_in: 3600,
        });
      }
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };

  return {
    fetchFn,
    calls,
    counts: {
      get registrations() {
        return registrations;
      },
      get exchanges() {
        return exchanges;
      },
      get refreshes() {
        return refreshes;
      },
    },
  };
}

test('client metadata is a public-client CIMD document without secrets', () => {
  const metadata = createMcpOAuthClientMetadata(CALLBACK_URL);

  assert.deepEqual(metadata, {
    redirect_uris: [CALLBACK_URL],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Chickpea',
  });
  assert.equal(JSON.stringify(metadata).includes('secret'), false);
});

test('CIMD document binds client_id to its exact HTTPS document URL', () => {
  const document = createMcpOAuthClientMetadataDocument(METADATA_URL);

  assert.equal(document.client_id, METADATA_URL);
  assert.deepEqual(document.redirect_uris, [CALLBACK_URL]);
  assert.equal(JSON.stringify(document).includes('secret'), false);
  assert.throws(
    () =>
      createMcpOAuthClientMetadataDocument(
        'https://chickpea.example.test/not-the-well-known-path',
      ),
    (error: unknown) =>
      error instanceof McpOAuthError &&
      error.code === 'oauth_discovery_failed',
  );
});

test('DCR is registered once, pending state is single-use, and callback stores tokens', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  let nonce = 0;
  let validationChecks = 0;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => `nonce-${++nonce}`,
    validateConnection: () => {
      validationChecks += 1;
      return true;
    },
  };

  try {
    const [first, second] = await Promise.all([
      startMcpOAuthAuthorization(
        {
          ref: REF,
          serverUrl: SERVER_URL,
          callbackUrl: CALLBACK_URL,
          scope: 'read write',
          returnAgentId: 'agent_return',
        },
        dependencies,
      ),
      startMcpOAuthAuthorization(
        {
          ref: REF,
          serverUrl: SERVER_URL,
          callbackUrl: CALLBACK_URL,
          scope: 'read write',
          returnAgentId: 'agent_return',
        },
        dependencies,
      ),
    ]);

    assert.equal(oauth.counts.registrations, 1);
    assert.equal(first.authorizationUrl.searchParams.get('client_id'), 'registered-client');
    assert.equal(second.authorizationUrl.searchParams.get('client_id'), 'registered-client');
    assert.equal(second.authorizationUrl.searchParams.get('resource'), SERVER_URL);
    assert.equal(first.authorizationUrl.searchParams.get('scope'), 'read write');
    assert.equal(second.authorizationUrl.searchParams.get('scope'), 'read write');
    assert.equal(second.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.notEqual(first.state, second.state);

    const pendingRaw = await settings.getSetting(mcpOAuthSettingKeys(REF)[1]);
    const currentState = (JSON.parse(pendingRaw!) as { state: string }).state;
    const supersededState =
      currentState === first.state ? second.state : first.state;
    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: supersededState },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'invalid_state',
    );

    const result = await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: currentState },
      dependencies,
    );
    assert.deepEqual(result, { ref: REF, returnAgentId: 'agent_return' });
    assert.equal(oauth.counts.exchanges, 1);

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: currentState },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'invalid_state',
    );

    validationChecks = 0;
    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      'access-initial',
    );
    assert.equal(validationChecks, 1);
    const rawSettings = await settings.getSettings(mcpOAuthSettingKeys(REF));
    assert.equal(rawSettings.some((value) => value?.includes('access-initial')), true);
    assert.equal(rawSettings.some((value) => value?.includes('refresh-initial')), true);
  } finally {
    settings.close();
  }
});

test('failed MCP exchange retains the initiating Agent callback context', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ exchangeError: 'invalid_grant' });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => 'nonce',
  };
  try {
    const started = await startMcpOAuthAuthorization(
      {
        ref: REF,
        serverUrl: SERVER_URL,
        callbackUrl: CALLBACK_URL,
        returnAgentId: 'agent_return',
      },
      dependencies,
    );

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError &&
        error.code === 'oauth_unavailable' &&
        error.callbackContext?.ref.agentId === REF.agentId &&
        error.callbackContext.returnAgentId === 'agent_return',
    );
  } finally {
    settings.close();
  }
});

test('a superseded reusable MCP OAuth attempt cannot exchange or replace newer state', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  let currentRevision = 1;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => 'nonce',
    validateConnection: (
      _ref: typeof REF,
      _serverUrl: string,
      accountRevision?: number,
    ) => {
      if (accountRevision !== currentRevision) {
        throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
      }
      return true;
    },
  };
  try {
    const started = await startMcpOAuthAuthorization(
      {
        ref: REF,
        serverUrl: SERVER_URL,
        callbackUrl: CALLBACK_URL,
        accountRevision: 1,
      },
      dependencies,
    );
    currentRevision = 2;

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_attempt_superseded',
    );
    assert.equal(oauth.counts.exchanges, 0);
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[2]), undefined);
  } finally {
    settings.close();
  }
});

test('an older MCP OAuth start cannot replace a newer pending authorization', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  const olderAttemptId = '11111111-1111-4111-8111-111111111111';
  const newerAttemptId = '22222222-2222-4222-8222-222222222222';
  try {
    await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: SERVER_URL,
      callbackUrl: CALLBACK_URL,
      accountRevision: 2,
      oauthAttemptId: newerAttemptId,
    }, {
      settings,
      fetchFn: oauth.fetchFn,
      randomId: () => 'newer-nonce',
      validateConnection: () => true,
    });
    const pendingKey = mcpOAuthSettingKeys(REF)[1];
    const newerPending = await settings.getSetting(pendingKey);

    await assert.rejects(
      startMcpOAuthAuthorization({
        ref: REF,
        serverUrl: SERVER_URL,
        callbackUrl: CALLBACK_URL,
        accountRevision: 1,
        oauthAttemptId: olderAttemptId,
      }, {
        settings,
        fetchFn: oauth.fetchFn,
        randomId: () => 'older-nonce',
        validateConnection: () => true,
      }),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_attempt_superseded',
    );
    assert.equal(await settings.getSetting(pendingKey), newerPending);
  } finally {
    settings.close();
  }
});

test('a slower reusable MCP OAuth callback cannot overwrite newer credentials', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  const olderAttemptId = '11111111-1111-4111-8111-111111111111';
  const newerAttemptId = '22222222-2222-4222-8222-222222222222';
  try {
    const older = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: SERVER_URL,
      callbackUrl: CALLBACK_URL,
      accountRevision: 1,
      oauthAttemptId: olderAttemptId,
    }, {
      settings,
      fetchFn: oauth.fetchFn,
      randomId: () => 'older-nonce',
      validateConnection: () => true,
    });
    const keys = mcpOAuthSettingKeys(REF);
    const pending = JSON.parse((await settings.getSetting(keys[1]))!) as Record<string, unknown>;
    const newerRaw = JSON.stringify({
      serverUrl: pending.serverUrl,
      authorizationServerUrl: pending.authorizationServerUrl,
      metadata: pending.metadata,
      resource: pending.resource,
      clientInformation: pending.clientInformation,
      tokens: {
        access_token: 'access-winner',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      obtainedAt: Date.now(),
      accountRevision: 2,
      oauthAttemptId: newerAttemptId,
    });
    await settings.setSetting(keys[2], newerRaw);

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: older.state },
        { settings, fetchFn: oauth.fetchFn, validateConnection: () => true },
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_attempt_superseded',
    );
    assert.equal(oauth.counts.exchanges, 1);
    assert.equal(await settings.getSetting(keys[2]), newerRaw);
    assert.equal(await resolveMcpOAuthAccessToken(
      { ref: REF, serverUrl: SERVER_URL },
      {
        settings,
        validateConnection: (_ref, _serverUrl, _revision, attemptId) =>
          attemptId === undefined || attemptId === newerAttemptId,
      },
    ), 'access-winner');
  } finally {
    settings.close();
  }
});

test('concurrent starts wait for a slow DCR registration and still reuse one client', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ registrationDelayMs: 600 });
  let nonce = 0;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => `nonce-${++nonce}`,
  };
  try {
    const results = await Promise.all([
      startMcpOAuthAuthorization(
        { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
        dependencies,
      ),
      startMcpOAuthAuthorization(
        { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
        dependencies,
      ),
    ]);

    assert.equal(results.length, 2);
    assert.equal(oauth.counts.registrations, 1);
  } finally {
    settings.close();
  }
});

test('an expired confidential DCR client is registered again', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    clientSecret: 'registered-secret',
    clientSecretExpiresAt: 2_000,
  });
  let currentTime = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => currentTime,
    randomId: () => `nonce-${currentTime}`,
  };
  try {
    await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    assert.equal(oauth.counts.registrations, 1);

    currentTime = 2_000_000;
    await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    assert.equal(oauth.counts.registrations, 2);
  } finally {
    settings.close();
  }
});

test('DCR client secrets stay in settings and never enter the authorization result', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ clientSecret: 'registered-secret' });
  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      { settings, fetchFn: oauth.fetchFn, randomId: () => 'nonce' },
    );

    assert.equal(JSON.stringify(started).includes('registered-secret'), false);
    assert.match(
      (await settings.getSetting(mcpOAuthSettingKeys(REF)[0])) ?? '',
      /registered-secret/,
    );
  } finally {
    settings.close();
  }
});

test('confidential DCR clients authenticate code exchange and refresh without exposing their secret', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    clientSecret: 'registered-secret',
    initialExpiresIn: 1,
    registrationAuthMethod: 'client_secret_post',
    tokenAuthMethods: ['client_secret_post'],
  });
  let currentTime = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => currentTime,
    randomId: () => 'nonce',
  };

  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    assert.equal(JSON.stringify(started).includes('registered-secret'), false);

    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    currentTime += 2_000;

    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      'access-refreshed',
    );
    assert.equal(oauth.counts.exchanges, 1);
    assert.equal(oauth.counts.refreshes, 1);
    assert.match(
      (await settings.getSetting(mcpOAuthSettingKeys(REF)[0])) ?? '',
      /registered-secret/,
    );
  } finally {
    settings.close();
  }
});

test('authorization start removes its writes when the connection disappears in flight', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  let validations = 0;
  try {
    await assert.rejects(
      startMcpOAuthAuthorization(
        { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
        {
          settings,
          fetchFn: oauth.fetchFn,
          randomId: () => 'nonce',
          validateConnection: () => {
            validations += 1;
            return validations === 1;
          },
        },
      ),
      (error: unknown) =>
        error instanceof McpOAuthError &&
        error.code === 'connection_missing',
    );
    assert.deepEqual(
      await settings.getSettings(mcpOAuthSettingKeys(REF)),
      [undefined, undefined, undefined, undefined, undefined],
    );
  } finally {
    settings.close();
  }
});

test('authorization start preserves OAuth settings on a transient connection-store error', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  let checks = 0;
  try {
    await assert.rejects(
      startMcpOAuthAuthorization(
        { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
        {
          settings,
          fetchFn: oauth.fetchFn,
          randomId: () => 'nonce',
          validateConnection: () => {
            checks += 1;
            if (checks === 1) return true;
            throw new Error('temporary config-store failure');
          },
        },
      ),
      /temporary config-store failure/,
    );
    const [client, pending] = await settings.getSettings(mcpOAuthSettingKeys(REF));
    assert.match(client ?? '', /registered-client/);
    assert.match(pending ?? '', /codeVerifier/);
  } finally {
    settings.close();
  }
});

test('expired OAuth state is consumed without attempting code exchange', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  let now = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'nonce',
  };
  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    now += 20 * 60_000;

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'invalid_state',
    );
    assert.equal(oauth.counts.exchanges, 0);
    assert.equal(
      await settings.getSetting(mcpOAuthSettingKeys(REF)[1]),
      undefined,
    );
  } finally {
    settings.close();
  }
});

test('CIMD is used only when advertised and the client metadata URL is HTTPS', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ cimd: true });
  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      { settings, fetchFn: oauth.fetchFn, randomId: () => 'nonce' },
    );

    assert.equal(oauth.counts.registrations, 0);
    assert.equal(started.authorizationUrl.searchParams.get('client_id'), METADATA_URL);
  } finally {
    settings.close();
  }
});

test('OAuth discovery rejects a private authorization server before fetching it', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (
      url ===
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp'
    ) {
      return Response.json({
        resource: SERVER_URL,
        authorization_servers: ['https://127.0.0.1/oauth'],
      });
    }
    throw new Error(`private authorization server was fetched: ${url}`);
  };
  try {
    await assert.rejects(
      startMcpOAuthAuthorization(
        { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
        { settings, fetchFn, randomId: () => 'nonce' },
      ),
      (error: unknown) =>
        error instanceof McpOAuthError &&
        error.code === 'oauth_discovery_failed',
    );
    assert.deepEqual(calls, [
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    ]);
  } finally {
    settings.close();
  }
});

test('OAuth discovery rejects authorization metadata with a mismatched issuer', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ issuer: 'https://other.example.test' });
  try {
    await assert.rejects(
      startMcpOAuthAuthorization(
        { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
        { settings, fetchFn: oauth.fetchFn, randomId: () => 'nonce' },
      ),
      (error: unknown) =>
        error instanceof McpOAuthError &&
        error.code === 'oauth_discovery_failed',
    );
    assert.equal(oauth.counts.registrations, 0);
  } finally {
    settings.close();
  }
});

test('OAuth discovery rejects metadata that explicitly lacks PKCE S256', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ codeChallengeMethods: ['plain'] });
  try {
    await assert.rejects(
      startMcpOAuthAuthorization(
        { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
        { settings, fetchFn: oauth.fetchFn, randomId: () => 'nonce' },
      ),
      (error: unknown) =>
        error instanceof McpOAuthError &&
        error.code === 'oauth_discovery_failed',
    );
    assert.equal(oauth.counts.registrations, 0);
    assert.deepEqual(
      await settings.getSettings(mcpOAuthSettingKeys(REF)),
      [undefined, undefined, undefined, undefined, undefined],
    );
  } finally {
    settings.close();
  }
});

test('expired tokens refresh once across concurrent callers and preserve rotation', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ initialExpiresIn: 1 });
  let now = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: (() => {
      let nonce = 0;
      return () => `nonce-${++nonce}`;
    })(),
  };

  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;

    const tokens = await Promise.all([
      resolveMcpOAuthAccessToken({ ref: REF, serverUrl: SERVER_URL }, dependencies),
      resolveMcpOAuthAccessToken({ ref: REF, serverUrl: SERVER_URL }, dependencies),
    ]);

    assert.deepEqual(tokens, ['access-refreshed', 'access-refreshed']);
    assert.equal(oauth.counts.refreshes, 1);
    const stored = (await settings.getSettings(mcpOAuthSettingKeys(REF))).join('\n');
    assert.match(stored, /refresh-rotated/);
    assert.doesNotMatch(stored, /"refresh_token":"refresh-initial"/);
  } finally {
    settings.close();
  }
});

test('an expired MCP OAuth lease can be recovered without timing out first', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ initialExpiresIn: 1 });
  let now = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'new-owner',
    sleep: async (milliseconds: number) => { now += milliseconds; },
  };
  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;
    await settings.setSetting(
      mcpOAuthSettingKeys(REF)[4],
      JSON.stringify({ owner: 'stalled-owner', expiresAt: now + 20_000 }),
    );

    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      'access-refreshed',
    );
    assert.equal(oauth.counts.refreshes, 1);
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[4]), undefined);
  } finally {
    settings.close();
  }
});

test('refresh preserves the prior refresh token and scope when the server omits both', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    initialExpiresIn: 1,
    omitRefreshTokenOnRefresh: true,
  });
  let now = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'nonce',
  };

  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;

    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      'access-refreshed',
    );
    const stored = await settings.getSetting(mcpOAuthSettingKeys(REF)[2]);
    assert.match(stored ?? '', /"refresh_token":"refresh-initial"/);
    assert.match(stored ?? '', /"scope":"read"/);
  } finally {
    settings.close();
  }
});

test('a non-refreshable token remains usable until its hard expiry', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    initialExpiresIn: 30,
    omitInitialRefreshToken: true,
  });
  let currentTime = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => currentTime,
    randomId: () => 'nonce',
  };
  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );

    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      'access-initial',
    );
    currentTime += 30_000;
    await assert.rejects(
      resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError &&
        error.code === 'reauthorization_required',
    );
    assert.equal(oauth.counts.refreshes, 0);
  } finally {
    settings.close();
  }
});

test('a refresh CAS loser never returns a token stored for another resource', async () => {
  const backing = new SqliteSettingsStore(':memory:');
  const tokenKey = mcpOAuthSettingKeys(REF)[2];
  let replaceTokenWrite = false;
  const settings: SettingsStore = {
    getSetting: (key) => backing.getSetting(key),
    getSettings: (keys) => backing.getSettings(keys),
    setSetting: (key, value) => backing.setSetting(key, value),
    deleteSetting: (key) => backing.deleteSetting(key),
    mergeSettingStringSet: (key, values) => backing.mergeSettingStringSet(key, values),
    applySettingsPatch: async (patch: SettingsPatch) => {
      const tokenWrite = patch.set?.find((write) => write.key === tokenKey);
      if (replaceTokenWrite && tokenWrite) {
        replaceTokenWrite = false;
        const winner = JSON.parse(tokenWrite.value) as Record<string, unknown>;
        winner.serverUrl = 'https://other.example.test/mcp';
        winner.resource = 'https://other.example.test/mcp';
        await backing.setSetting(tokenKey, JSON.stringify(winner));
        return false;
      }
      return backing.applySettingsPatch(patch);
    },
  };
  const oauth = fakeOAuthServer({ initialExpiresIn: 1 });
  let currentTime = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => currentTime,
    randomId: () => 'nonce',
    validateConnection: () => true,
  };
  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    currentTime += 2_000;
    replaceTokenWrite = true;

    await assert.rejects(
      resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError &&
        error.code === 'reauthorization_required',
    );
    assert.match(
      (await backing.getSetting(tokenKey)) ?? '',
      /https:\/\/other\.example\.test\/mcp/,
    );
  } finally {
    backing.close();
  }
});

test('stored OAuth records reject malformed nested SDK values', async () => {
  const makeDependencies = (settings: SqliteSettingsStore) => ({
    settings,
    fetchFn: fakeOAuthServer().fetchFn,
    randomId: () => 'nonce',
  });

  const pendingSettings = new SqliteSettingsStore(':memory:');
  try {
    const dependencies = makeDependencies(pendingSettings);
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    const pendingKey = mcpOAuthSettingKeys(REF)[1];
    const pending = JSON.parse((await pendingSettings.getSetting(pendingKey))!) as {
      metadata: Record<string, unknown>;
    };
    pending.metadata.token_endpoint = 42;
    await pendingSettings.setSetting(pendingKey, JSON.stringify(pending));
    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_storage_invalid',
    );
  } finally {
    pendingSettings.close();
  }

  const clientSettings = new SqliteSettingsStore(':memory:');
  try {
    const dependencies = makeDependencies(clientSettings);
    await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    const clientKey = mcpOAuthSettingKeys(REF)[0];
    const client = JSON.parse((await clientSettings.getSetting(clientKey))!) as {
      clientInformation: Record<string, unknown>;
    };
    client.clientInformation.client_id = 42;
    await clientSettings.setSetting(clientKey, JSON.stringify(client));
    await assert.rejects(
      startMcpOAuthAuthorization(
        { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_storage_invalid',
    );
  } finally {
    clientSettings.close();
  }

  const tokenSettings = new SqliteSettingsStore(':memory:');
  try {
    const dependencies = makeDependencies(tokenSettings);
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    const storedTokenKey = mcpOAuthSettingKeys(REF)[2];
    const bundle = JSON.parse((await tokenSettings.getSetting(storedTokenKey))!) as {
      tokens: Record<string, unknown>;
    };
    bundle.tokens.refresh_token = 42;
    await tokenSettings.setSetting(storedTokenKey, JSON.stringify(bundle));
    await assert.rejects(
      resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_storage_invalid',
    );
  } finally {
    tokenSettings.close();
  }
});

test('refresh removes every OAuth write when the connection disappears in flight', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ initialExpiresIn: 1 });
  let now = 1_000_000;
  let refreshChecks: number | undefined;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'nonce',
    validateConnection: () =>
      refreshChecks === undefined || refreshChecks++ < 2,
  };

  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;
    refreshChecks = 0;

    await assert.rejects(
      resolveMcpOAuthAccessToken({ ref: REF, serverUrl: SERVER_URL }, dependencies),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'connection_missing',
    );
    assert.deepEqual(
      await settings.getSettings(mcpOAuthSettingKeys(REF)),
      [undefined, undefined, undefined, undefined, undefined],
    );
  } finally {
    settings.close();
  }
});

test('invalid_grant clears the unusable token bundle and requires reconnection', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    initialExpiresIn: 1,
    refreshError: 'invalid_grant',
  });
  let now = 1_000_000;
  const reauthorizationRequired: Array<{ ref: typeof REF; serverUrl: string }> = [];
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'nonce',
    onReauthorizationRequired: (ref: typeof REF, serverUrl: string) => {
      reauthorizationRequired.push({ ref, serverUrl });
    },
  };

  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;

    await assert.rejects(
      resolveMcpOAuthAccessToken({ ref: REF, serverUrl: SERVER_URL }, dependencies),
      (error: unknown) =>
        error instanceof McpOAuthError &&
        error.code === 'reauthorization_required',
    );
    assert.equal(
      await settings.getSetting(mcpOAuthSettingKeys(REF)[2]!),
      undefined,
    );
    assert.deepEqual(reauthorizationRequired, [{ ref: REF, serverUrl: SERVER_URL }]);
  } finally {
    settings.close();
  }
});

test('an invalid-grant refresh loser returns the token stored by the winning refresher', async () => {
  const backing = new SqliteSettingsStore(':memory:');
  const tokenKey = mcpOAuthSettingKeys(REF)[2];
  let replaceOnDelete = false;
  let currentTime = 1_000_000;
  const settings: SettingsStore = {
    getSetting: (key) => backing.getSetting(key),
    getSettings: (keys) => backing.getSettings(keys),
    setSetting: (key, value) => backing.setSetting(key, value),
    deleteSetting: (key) => backing.deleteSetting(key),
    mergeSettingStringSet: (key, values) => backing.mergeSettingStringSet(key, values),
    applySettingsPatch: async (patch: SettingsPatch) => {
      if (replaceOnDelete && patch.delete?.includes(tokenKey)) {
        replaceOnDelete = false;
        const winner = JSON.parse((await backing.getSetting(tokenKey))!) as {
          tokens: Record<string, unknown>;
          obtainedAt: number;
        };
        winner.tokens.access_token = 'access-from-winner';
        winner.tokens.expires_in = 3600;
        winner.obtainedAt = currentTime;
        await backing.setSetting(tokenKey, JSON.stringify(winner));
        return false;
      }
      return backing.applySettingsPatch(patch);
    },
  };
  const oauth = fakeOAuthServer({ initialExpiresIn: 1, refreshError: 'invalid_grant' });
  let reauthorizationRequired = 0;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => currentTime,
    randomId: () => 'nonce',
    validateConnection: () => true,
    onReauthorizationRequired: () => {
      reauthorizationRequired += 1;
    },
  };
  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    currentTime += 2_000;
    replaceOnDelete = true;

    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: SERVER_URL },
        dependencies,
      ),
      'access-from-winner',
    );
    assert.equal(oauth.counts.refreshes, 1);
    assert.equal(reauthorizationRequired, 0);
  } finally {
    backing.close();
  }
});

test('transient refresh failure preserves the existing token bundle for retry', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    initialExpiresIn: 1,
    refreshError: 'temporarily_unavailable',
  });
  let now = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'nonce',
  };

  try {
    const started = await startMcpOAuthAuthorization(
      { ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL },
      dependencies,
    );
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;
    const tokenKey = mcpOAuthSettingKeys(REF)[2];
    const before = await settings.getSetting(tokenKey);

    await assert.rejects(
      resolveMcpOAuthAccessToken({ ref: REF, serverUrl: SERVER_URL }, dependencies),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_unavailable',
    );
    assert.equal(await settings.getSetting(tokenKey), before);
  } finally {
    settings.close();
  }
});
