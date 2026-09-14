import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

import { applicationIdentity } from '../src/release/identity.ts';
import {
  cancelMcpOAuthAuthorization,
  completeMcpOAuthAuthorization,
  createMcpOAuthClientMetadata,
  createMcpOAuthClientMetadataDocument,
  invalidateConfiguredMcpOAuthAuthorization,
  McpOAuthError,
  mcpOAuthSettingKeys,
  readMcpOAuthSetupContinuation,
  resolveMcpOAuthAccessToken,
  startMcpOAuthAuthorization,
} from '../src/config/mcp-oauth.ts';
import {
  configuredMcpOAuthClientDescriptor,
  META_ADS_MCP_SERVER_URL,
  META_ADS_OAUTH_DEFAULT_SCOPE,
  META_ADS_OAUTH_ISSUER,
  removeConfiguredMcpOAuthClient,
  saveConfiguredMcpOAuthClient,
} from '../src/config/mcp-oauth-clients.ts';
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
  authorizationServerUrl?: string;
  clientSecret?: string;
  clientSecretExpiresAt?: number;
  cimd?: boolean;
  codeChallengeMethods?: string[];
  exchangeError?: string;
  initialExpiresIn?: number;
  issuer?: string;
  expectedClientId?: string;
  onExchange?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  omitInitialRefreshToken?: boolean;
  omitRefreshTokenOnRefresh?: boolean;
  registrationAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none';
  registrationDelayMs?: number;
  requireUserAgent?: string;
  refreshError?: string;
  serverUrl?: string;
  tokenAuthMethods?: Array<'client_secret_basic' | 'client_secret_post' | 'none'>;
}

function fakeOAuthServer(options: FakeOAuthServerOptions = {}) {
  const serverUrl = options.serverUrl ?? SERVER_URL;
  const parsedServerUrl = new URL(serverUrl);
  const authorizationServerUrl = options.authorizationServerUrl ?? 'https://auth.example.test';
  const parsedAuthorizationServerUrl = new URL(authorizationServerUrl);
  const authorizationMetadataUrl =
    `${parsedAuthorizationServerUrl.origin}/.well-known/oauth-authorization-server` +
    `${parsedAuthorizationServerUrl.pathname === '/' ? '' : parsedAuthorizationServerUrl.pathname}`;
  const authorizationEndpoint = new URL(
    `${parsedAuthorizationServerUrl.pathname.replace(/\/$/, '')}/authorize`,
    parsedAuthorizationServerUrl.origin,
  ).href;
  const tokenEndpoint = new URL(
    `${parsedAuthorizationServerUrl.pathname.replace(/\/$/, '')}/token`,
    parsedAuthorizationServerUrl.origin,
  ).href;
  const registrationEndpoint = new URL(
    `${parsedAuthorizationServerUrl.pathname.replace(/\/$/, '')}/register`,
    parsedAuthorizationServerUrl.origin,
  ).href;
  const protectedResourceMetadataUrl =
    `${parsedServerUrl.origin}/.well-known/oauth-protected-resource${parsedServerUrl.pathname}`;
  const unsupportedBrowserUrl = new URL('/unsupportedbrowser', authorizationServerUrl).href;
  const calls: Array<{ url: string; body?: URLSearchParams; userAgent?: string }> = [];
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
    const userAgent = request.headers.get('user-agent') ?? undefined;
    calls.push({ url, ...(body ? { body } : {}), ...(userAgent ? { userAgent } : {}) });

    if (
      url ===
      protectedResourceMetadataUrl
    ) {
      return Response.json({
        resource: serverUrl,
        authorization_servers: [authorizationServerUrl],
        scopes_supported: ['read', 'write'],
      });
    }
    if (
      url ===
      authorizationMetadataUrl
    ) {
      if (options.requireUserAgent && userAgent !== options.requireUserAgent) {
        return new Response(null, {
          status: 302,
          headers: { Location: unsupportedBrowserUrl },
        });
      }
      return Response.json({
        issuer: options.issuer ?? authorizationServerUrl,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: tokenEndpoint,
        registration_endpoint: registrationEndpoint,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: options.codeChallengeMethods ?? ['S256'],
        token_endpoint_auth_methods_supported: options.tokenAuthMethods ?? ['none'],
        client_id_metadata_document_supported: options.cimd ?? false,
      });
    }
    if (url === unsupportedBrowserUrl) {
      return new Response('<!doctype html><title>Unsupported browser</title>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url === registrationEndpoint) {
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
    if (url === tokenEndpoint) {
      if (options.requireUserAgent) {
        assert.equal(userAgent, options.requireUserAgent);
      }
      if (options.expectedClientId) {
        assert.equal(body?.get('client_id'), options.expectedClientId);
        assert.equal(body?.get('client_secret'), null);
        assert.equal(request.headers.get('authorization'), null);
      }
      if (options.clientSecret) {
        assert.equal(body?.get('client_id'), 'registered-client');
        assert.equal(body?.get('client_secret'), options.clientSecret);
        assert.equal(request.headers.get('authorization'), null);
      }
      const grantType = body?.get('grant_type');
      if (grantType === 'authorization_code') {
        exchanges += 1;
        await options.onExchange?.();
        assert.equal(body?.get('code'), 'provider-code');
        assert.equal(body?.get('redirect_uri'), CALLBACK_URL);
        assert.ok(body?.get('code_verifier'));
        assert.equal(body?.get('resource'), serverUrl);
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
        await options.onRefresh?.();
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
        assert.equal(body?.get('resource'), serverUrl);
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

test('Meta requires local configuration before any provider discovery', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
  });
  try {
    await assert.rejects(
      startMcpOAuthAuthorization({
        ref: REF,
        serverUrl: META_ADS_MCP_SERVER_URL,
        callbackUrl: CALLBACK_URL,
      }, { settings, fetchFn: oauth.fetchFn }),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_configuration_required',
    );
    assert.deepEqual(oauth.calls, []);
  } finally {
    settings.close();
  }
});

test('Meta origin variants cannot bypass configured-client mode through DCR', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let providerCalls = 0;
  const dependencies = {
    settings,
    fetchFn: async () => {
      providerCalls += 1;
      throw new Error('provider must not be reached');
    },
  };
  try {
    for (const serverUrl of [
      `${META_ADS_MCP_SERVER_URL}/`,
      `${META_ADS_MCP_SERVER_URL}?mode=other`,
      'https://mcp.facebook.com/other',
    ]) {
      await assert.rejects(
        startMcpOAuthAuthorization({ ref: REF, serverUrl, callbackUrl: CALLBACK_URL }, dependencies),
        (error: unknown) =>
          error instanceof McpOAuthError && error.code === 'oauth_discovery_failed',
      );
    }
    assert.equal(providerCalls, 0);
  } finally {
    settings.close();
  }
});

test('Meta defaults existing scope-less starts to read-only MCP access with its public PKCE client', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
  });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: (() => {
      let nonce = 0;
      return () => `meta-state-${++nonce}`;
    })(),
    validateConnection: () => true,
  };
  try {
    const configuration = await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    const first = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
    }, dependencies);
    const current = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
      setupOperationId: 'setup_current',
    }, dependencies);

    assert.equal(oauth.counts.registrations, 0);
    assert.equal(first.authorizationUrl.searchParams.get('scope'), META_ADS_OAUTH_DEFAULT_SCOPE);
    assert.equal(current.authorizationUrl.searchParams.get('scope'), META_ADS_OAUTH_DEFAULT_SCOPE);
    assert.equal(current.authorizationUrl.searchParams.get('client_id'), '1234567890');
    assert.equal(current.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(current.authorizationUrl.searchParams.get('code_challenge'));
    await assert.rejects(
      readMcpOAuthSetupContinuation(first.state, dependencies),
      (error: unknown) => error instanceof McpOAuthError && error.code === 'invalid_state',
    );
    assert.equal(await readMcpOAuthSetupContinuation(current.state, dependencies), 'setup_current');
    assert.equal(await readMcpOAuthSetupContinuation(current.state, dependencies), 'setup_current');

    const pending = JSON.parse(
      (await settings.getSetting(mcpOAuthSettingKeys(REF)[1]))!,
    ) as Record<string, unknown>;
    const client = JSON.parse(
      (await settings.getSetting(mcpOAuthSettingKeys(REF)[0]))!,
    ) as Record<string, unknown>;
    assert.equal(pending.configurationGeneration, configuration.generation);
    assert.equal(client.configurationGeneration, configuration.generation);
    assert.equal(client.scope, META_ADS_OAUTH_DEFAULT_SCOPE);
    assert.equal(JSON.stringify(client).includes('client_secret'), false);

    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: current.state },
      dependencies,
    );
    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: META_ADS_MCP_SERVER_URL },
        dependencies,
      ),
      'access-initial',
    );
    const token = JSON.parse(
      (await settings.getSetting(mcpOAuthSettingKeys(REF)[2]))!,
    ) as Record<string, unknown>;
    assert.equal(token.configurationGeneration, configuration.generation);
  } finally {
    settings.close();
  }
});

test('Meta preserves an explicit OAuth scope without broadening it', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
  });
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    const started = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
      scope: 'ads_mcp_management',
    }, {
      settings,
      fetchFn: oauth.fetchFn,
      randomId: () => 'meta-state',
      validateConnection: () => true,
    });

    assert.equal(started.authorizationUrl.searchParams.get('scope'), 'ads_mcp_management');
    const client = JSON.parse(
      (await settings.getSetting(mcpOAuthSettingKeys(REF)[0]))!,
    ) as Record<string, unknown>;
    assert.equal(client.scope, 'ads_mcp_management');
  } finally {
    settings.close();
  }
});

test('OAuth identifies Chickpea during metadata discovery, exchange, and refresh', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const expectedUserAgent = `Chickpea/${applicationIdentity.version}`;
  let now = 1_000_000;
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
    initialExpiresIn: 1,
    requireUserAgent: expectedUserAgent,
  });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'meta-state',
    validateConnection: () => true,
  };
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    const started = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
    }, dependencies);
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;
    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: META_ADS_MCP_SERVER_URL },
        dependencies,
      ),
      'access-refreshed',
    );
    assert.deepEqual(
      oauth.calls.map(({ url, userAgent }) => ({ url, userAgent })),
      [
        {
          url: 'https://mcp.facebook.com/.well-known/oauth-protected-resource/ads',
          userAgent: expectedUserAgent,
        },
        {
          url: 'https://www.facebook.com/.well-known/oauth-authorization-server/ads',
          userAgent: expectedUserAgent,
        },
        { url: 'https://www.facebook.com/ads/token', userAgent: expectedUserAgent },
        { url: 'https://www.facebook.com/ads/token', userAgent: expectedUserAgent },
      ],
    );
  } finally {
    settings.close();
  }
});

test('Meta rejects an authorization server outside its reviewed descriptor', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({ serverUrl: META_ADS_MCP_SERVER_URL });
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    await assert.rejects(
      startMcpOAuthAuthorization({
        ref: REF,
        serverUrl: META_ADS_MCP_SERVER_URL,
        callbackUrl: CALLBACK_URL,
      }, { settings, fetchFn: oauth.fetchFn, validateConnection: () => true }),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_discovery_failed',
    );
    assert.equal(oauth.calls.length, 1);
    assert.equal(oauth.counts.registrations, 0);
  } finally {
    settings.close();
  }
});

test('expired setup continuation is rejected without consuming newer state', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  let now = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'continuation-state',
  };
  try {
    const started = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: SERVER_URL,
      callbackUrl: CALLBACK_URL,
      setupOperationId: 'setup_expiring',
    }, dependencies);
    now += 20 * 60_000;
    await assert.rejects(
      readMcpOAuthSetupContinuation(started.state, dependencies),
      (error: unknown) => error instanceof McpOAuthError && error.code === 'invalid_state',
    );
    assert.ok(await settings.getSetting(mcpOAuthSettingKeys(REF)[1]));
  } finally {
    settings.close();
  }
});

test('Meta callback rejects removal and same-ID re-add before exchange', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
  });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => 'meta-state',
    validateConnection: () => true,
  };
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    const started = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
    }, dependencies);
    await removeConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      settings,
      { randomId: () => '22222222-2222-4222-8222-222222222222' },
    );
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '33333333-3333-4333-8333-333333333333' },
    );

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'reauthorization_required',
    );
    assert.equal(oauth.counts.exchanges, 0);
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[2]), undefined);
  } finally {
    settings.close();
  }
});

test('Meta start removes its configured client record when configuration changes before pending publish', async () => {
  const backing = new SqliteSettingsStore(':memory:');
  const configurationKey = configuredMcpOAuthClientDescriptor(
    META_ADS_MCP_SERVER_URL,
  )!.settingKey;
  let configurationReads = 0;
  const settings: SettingsStore = {
    getSetting: async (key) => {
      if (key === configurationKey && ++configurationReads === 4) {
        await saveConfiguredMcpOAuthClient(
          META_ADS_MCP_SERVER_URL,
          { clientId: '9876543210' },
          backing,
          { randomId: () => '22222222-2222-4222-8222-222222222222' },
        );
      }
      return backing.getSetting(key);
    },
    getSettings: (keys) => backing.getSettings(keys),
    setSetting: (key, value) => backing.setSetting(key, value),
    deleteSetting: (key) => backing.deleteSetting(key),
    mergeSettingStringSet: (key, values) => backing.mergeSettingStringSet(key, values),
    applySettingsPatch: (patch) => backing.applySettingsPatch(patch),
  };
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
  });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => 'meta-state',
    validateConnection: () => true,
  };
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );

    await assert.rejects(
      startMcpOAuthAuthorization({
        ref: REF,
        serverUrl: META_ADS_MCP_SERVER_URL,
        callbackUrl: CALLBACK_URL,
      }, dependencies),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'reauthorization_required',
    );
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[0]), undefined);
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[1]), undefined);
  } finally {
    backing.close();
  }
});

test('Meta callback cannot persist tokens when configuration changes during exchange', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
    onExchange: () => saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '9876543210' },
      settings,
      { randomId: () => '22222222-2222-4222-8222-222222222222' },
    ).then(() => undefined),
  });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => 'meta-state',
    validateConnection: () => true,
  };
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    const started = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
    }, dependencies);

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'reauthorization_required',
    );
    assert.equal(oauth.counts.exchanges, 1);
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[2]), undefined);
  } finally {
    settings.close();
  }
});

test('Meta refresh cannot persist or return a token after client replacement', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let now = 1_000_000;
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
    initialExpiresIn: 1,
    onRefresh: () => saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '9876543210' },
      settings,
      { randomId: () => '22222222-2222-4222-8222-222222222222' },
    ).then(() => undefined),
  });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'meta-state',
    validateConnection: () => true,
  };
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    const started = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
    }, dependencies);
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;

    await assert.rejects(
      resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: META_ADS_MCP_SERVER_URL },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'reauthorization_required',
    );
    assert.equal(oauth.counts.refreshes, 1);
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[2]), undefined);
  } finally {
    settings.close();
  }
});

test('Meta fast token resolution clears credentials after configuration removal', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
  });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => 'meta-state',
    validateConnection: () => true,
  };
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    const started = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
    }, dependencies);
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    await removeConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      settings,
      { randomId: () => '22222222-2222-4222-8222-222222222222' },
    );

    await assert.rejects(
      resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: META_ADS_MCP_SERVER_URL },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'oauth_configuration_required',
    );
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[2]), undefined);
  } finally {
    settings.close();
  }
});

test('stale Meta refresh preserves credentials published by a replacement callback', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let now = 1_000_000;
  const tokenKey = mcpOAuthSettingKeys(REF)[2];
  const replacementGeneration = '22222222-2222-4222-8222-222222222222';
  const oauth = fakeOAuthServer({
    serverUrl: META_ADS_MCP_SERVER_URL,
    authorizationServerUrl: META_ADS_OAUTH_ISSUER,
    expectedClientId: '1234567890',
    initialExpiresIn: 1,
    onRefresh: async () => {
      await removeConfiguredMcpOAuthClient(
        META_ADS_MCP_SERVER_URL,
        settings,
        { randomId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      );
      await saveConfiguredMcpOAuthClient(
        META_ADS_MCP_SERVER_URL,
        { clientId: '1234567890' },
        settings,
        { randomId: () => replacementGeneration },
      );
      const winner = JSON.parse((await settings.getSetting(tokenKey))!) as {
        configurationGeneration: string;
        tokens: Record<string, unknown>;
        obtainedAt: number;
      };
      winner.configurationGeneration = replacementGeneration;
      winner.tokens = {
        access_token: 'access-from-replacement-callback',
        refresh_token: 'refresh-from-replacement-callback',
        token_type: 'Bearer',
        expires_in: 3600,
      };
      winner.obtainedAt = now;
      await settings.setSetting(tokenKey, JSON.stringify(winner));
    },
  });
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    now: () => now,
    randomId: () => 'meta-state',
    validateConnection: () => true,
  };
  try {
    await saveConfiguredMcpOAuthClient(
      META_ADS_MCP_SERVER_URL,
      { clientId: '1234567890' },
      settings,
      { randomId: () => '11111111-1111-4111-8111-111111111111' },
    );
    const started = await startMcpOAuthAuthorization({
      ref: REF,
      serverUrl: META_ADS_MCP_SERVER_URL,
      callbackUrl: CALLBACK_URL,
    }, dependencies);
    await completeMcpOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;

    await assert.rejects(
      resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: META_ADS_MCP_SERVER_URL },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'reauthorization_required',
    );
    assert.match(
      (await settings.getSetting(tokenKey)) ?? '',
      /access-from-replacement-callback/,
    );
    assert.equal(
      await resolveMcpOAuthAccessToken(
        { ref: REF, serverUrl: META_ADS_MCP_SERVER_URL },
        dependencies,
      ),
      'access-from-replacement-callback',
    );
  } finally {
    settings.close();
  }
});

test('configured-client eager cleanup preserves a concurrent newer reconnect', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const keys = mcpOAuthSettingKeys(REF);
  const oldGeneration = '11111111-1111-4111-8111-111111111111';
  const newGeneration = '22222222-2222-4222-8222-222222222222';
  try {
    const common = {
      authorizationServerUrl: META_ADS_OAUTH_ISSUER,
      callbackUrl: CALLBACK_URL,
      clientInformation: { client_id: '9876543210' },
      configurationGeneration: newGeneration,
    };
    const pending = {
      ...common,
      state: 'state',
      expiresAt: Date.now() + 60_000,
      serverUrl: META_ADS_MCP_SERVER_URL,
      metadata: {
        issuer: META_ADS_OAUTH_ISSUER,
        authorization_endpoint: `${META_ADS_OAUTH_ISSUER}/authorize`,
        token_endpoint: `${META_ADS_OAUTH_ISSUER}/token`,
        response_types_supported: ['code'],
      },
      resource: META_ADS_MCP_SERVER_URL,
      codeVerifier: 'verifier',
    };
    const token = {
      ...common,
      serverUrl: META_ADS_MCP_SERVER_URL,
      metadata: pending.metadata,
      resource: META_ADS_MCP_SERVER_URL,
      tokens: { access_token: 'new-token', token_type: 'Bearer' },
      obtainedAt: Date.now(),
    };
    await settings.setSetting(keys[0], JSON.stringify(common));
    await settings.setSetting(keys[1], JSON.stringify(pending));
    await settings.setSetting(keys[2], JSON.stringify(token));

    await invalidateConfiguredMcpOAuthAuthorization(REF, settings, oldGeneration);
    assert.deepEqual(await settings.getSettings(keys.slice(0, 3)), [
      JSON.stringify(common),
      JSON.stringify(pending),
      JSON.stringify(token),
    ]);

    await invalidateConfiguredMcpOAuthAuthorization(REF, settings, newGeneration);
    assert.deepEqual(await settings.getSettings(keys.slice(0, 3)), [
      undefined,
      undefined,
      undefined,
    ]);
  } finally {
    settings.close();
  }
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

test('MCP callback rejects stale initiating authority before provider exchange', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  let authorityActive = true;
  const authority = {
    organizationId: 'org_test',
    workspaceId: 'T_TEST',
    membershipId: 'membership_editor',
    agentId: REF.agentId,
    ownerKind: 'legacy_agent',
  } as const;
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    randomId: () => 'nonce',
    validateConnection: () => true,
    validateAuthorization: () => authorityActive,
  };
  try {
    const started = await startMcpOAuthAuthorization(
      {
        ref: REF,
        serverUrl: SERVER_URL,
        callbackUrl: CALLBACK_URL,
        authorizationAuthority: authority,
      } as Parameters<typeof startMcpOAuthAuthorization>[0],
      dependencies,
    );
    assert.deepEqual(
      (JSON.parse((await settings.getSetting(mcpOAuthSettingKeys(REF)[1]))!) as {
        authorizationAuthority?: unknown;
      }).authorizationAuthority,
      authority,
    );
    authorityActive = false;

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'authorization_expired',
    );
    assert.equal(oauth.counts.exchanges, 0);
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[2]), undefined);
  } finally {
    settings.close();
  }
});

test('MCP callback fails closed for pending state minted before authority binding', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  try {
    const started = await startMcpOAuthAuthorization({
      ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL,
    }, {
      settings, fetchFn: oauth.fetchFn, randomId: () => 'legacy-nonce',
      validateConnection: () => true,
    });

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        {
          settings, fetchFn: oauth.fetchFn, validateConnection: () => true,
          validateAuthorization: () => true,
        },
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'authorization_expired',
    );
    assert.equal(oauth.counts.exchanges, 0);
  } finally {
    settings.close();
  }
});

test('MCP callback rechecks authority after exchange before storing minted tokens', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  let authorityActive = true;
  const authority = {
    organizationId: 'org_test', workspaceId: 'T_TEST', membershipId: 'membership_editor',
    agentId: REF.agentId, ownerKind: 'legacy_agent',
  } as const;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const response = await oauth.fetchFn(input, init);
    if (url === 'https://auth.example.test/token') authorityActive = false;
    return response;
  };
  const dependencies = {
    settings, fetchFn, randomId: () => 'nonce', validateConnection: () => true,
    validateAuthorization: () => authorityActive,
  };
  try {
    const started = await startMcpOAuthAuthorization({
      ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL,
      authorizationAuthority: authority,
    }, dependencies);

    await assert.rejects(
      completeMcpOAuthAuthorization(
        { code: 'provider-code', state: started.state }, dependencies,
      ),
      (error: unknown) =>
        error instanceof McpOAuthError && error.code === 'authorization_expired',
    );
    assert.equal(oauth.counts.exchanges, 1);
    assert.equal(await settings.getSetting(mcpOAuthSettingKeys(REF)[2]), undefined);
  } finally {
    settings.close();
  }
});

test('Sentry organization/project OAuth keeps the exact scoped resource URL', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const serverUrl = 'https://mcp.sentry.dev/mcp/acme/web-app';
  const oauth = fakeOAuthServer({ serverUrl });
  try {
    const started = await startMcpOAuthAuthorization({
      ref: { agentId: 'agent_test', connectionId: 'sentry' },
      serverUrl,
      callbackUrl: CALLBACK_URL,
    }, {
      settings,
      fetchFn: oauth.fetchFn,
      randomId: () => 'sentry-scope-state',
      validateConnection: () => true,
    });

    assert.equal(started.authorizationUrl.searchParams.get('resource'), serverUrl);
    assert.equal(
      oauth.calls[0]?.url,
      'https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp/acme/web-app',
    );
    const pending = JSON.parse(
      (await settings.getSetting(mcpOAuthSettingKeys({
        agentId: 'agent_test', connectionId: 'sentry',
      })[1]))!,
    ) as { resource: string };
    assert.equal(pending.resource, serverUrl);
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

test('MCP OAuth cancellation validates the exact actor and account attempt before recovery', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const oauth = fakeOAuthServer();
  const firstAttemptId = '11111111-1111-4111-8111-111111111111';
  const secondAttemptId = '22222222-2222-4222-8222-222222222222';
  const authority = {
    organizationId: 'org_test', workspaceId: 'T_TEST', membershipId: 'membership_owner',
    agentId: REF.agentId, ownerKind: 'team' as const,
  };
  let currentRevision = 4;
  let currentAttemptId = firstAttemptId;
  let actorCurrent = true;
  const cancelled: Array<{
    revision: number | undefined;
    attemptId: string | undefined;
  }> = [];
  const dependencies = {
    settings,
    fetchFn: oauth.fetchFn,
    validateAuthorization: () => actorCurrent,
    validateConnection: (
      _ref: typeof REF,
      _serverUrl: string,
      revision?: number,
      attemptId?: string,
    ) => {
      if (revision !== currentRevision || attemptId !== currentAttemptId) {
        throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
      }
      return true;
    },
    onAuthorizationCancelled: (
      _ref: typeof REF,
      _serverUrl: string,
      revision?: number,
      attemptId?: string,
    ) => { cancelled.push({ revision, attemptId }); },
  };
  try {
    const first = await startMcpOAuthAuthorization({
      ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL,
      returnAgentId: 'agent_return', accountRevision: currentRevision,
      oauthAttemptId: currentAttemptId, authorizationAuthority: authority,
    }, dependencies);
    const result = await cancelMcpOAuthAuthorization(first.state, dependencies);
    assert.equal(result.accountRevision, 4);
    assert.equal(result.oauthAttemptId, firstAttemptId);
    assert.equal(result.authorizationAuthority?.membershipId, 'membership_owner');
    assert.deepEqual(cancelled, [{ revision: 4, attemptId: firstAttemptId }]);

    currentRevision = 5;
    currentAttemptId = secondAttemptId;
    const staleAttempt = await startMcpOAuthAuthorization({
      ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL,
      accountRevision: currentRevision, oauthAttemptId: currentAttemptId,
      authorizationAuthority: authority,
    }, dependencies);
    currentRevision = 6;
    await assert.rejects(
      cancelMcpOAuthAuthorization(staleAttempt.state, dependencies),
      (error: unknown) => error instanceof McpOAuthError &&
        error.code === 'oauth_attempt_superseded',
    );
    assert.equal(cancelled.length, 1);

    currentRevision = 7;
    currentAttemptId = firstAttemptId;
    const staleActor = await startMcpOAuthAuthorization({
      ref: REF, serverUrl: SERVER_URL, callbackUrl: CALLBACK_URL,
      accountRevision: currentRevision, oauthAttemptId: currentAttemptId,
      authorizationAuthority: authority,
    }, dependencies);
    actorCurrent = false;
    await assert.rejects(
      cancelMcpOAuthAuthorization(staleActor.state, dependencies),
      (error: unknown) => error instanceof McpOAuthError &&
        error.code === 'authorization_expired',
    );
    assert.equal(cancelled.length, 1);
  } finally {
    settings.close();
  }
});

test('a superseded Agent-owned MCP OAuth attempt cannot exchange or replace newer state', async () => {
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

test('a slower Agent-owned MCP OAuth callback cannot overwrite newer credentials', async () => {
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
