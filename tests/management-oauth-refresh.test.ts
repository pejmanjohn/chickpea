import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { StoredOAuthTokens } from '@modelcontextprotocol/client';
import {
  auth as specClientAuth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Hono } from 'hono';
import { build, resolveConfig } from 'vite';

import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { createBetterAuthPublicHandler, type BetterAuthPublicHandlerInput } from '../src/auth/better-auth-routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import {
  lookupMcpClientName,
  mcpAuthorizationChallenge,
  mountMcpOAuthBrowserRoutes,
  renderMcpConsentPage,
} from '../src/auth/mcp-oauth-routes.ts';
import type { SlackAdmissionService } from '../src/auth/slack-admission.ts';
import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { logout, type AuthDeps } from '../packages/cli/src/oauth.ts';
import { CredentialStore, withExpiry, type StoredDeployment } from '../packages/cli/src/store.ts';

const ORIGIN = 'https://chickpea.example.test';
const RESOURCE = `${ORIGIN}/mcp`;
const WORKSPACE_SCOPE = 'chickpea:workspace';
const RENEWABLE_SCOPE = `${WORKSPACE_SCOPE} offline_access`;
const REDIRECT = 'http://127.0.0.1:47321/callback';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface AuthModules {
  createBetterAuth: typeof createBetterAuth;
  createBetterAuthPublicHandler: typeof createBetterAuthPublicHandler;
}

async function fixture({
  modules = { createBetterAuth, createBetterAuthPublicHandler },
  mcpRegistrationPolicy,
}: {
  modules?: AuthModules;
  mcpRegistrationPolicy?: BetterAuthPublicHandlerInput['mcpRegistrationPolicy'];
} = {}) {
  const backend = new NodeBetterAuthBackend(':memory:');
  let admission: BetterAuthAdmissionOperation | null = null;
  const options = {
    backend, baseURL: ORIGIN, secret: randomBytes(32).toString('base64url'),
    privateSeam: { async resolveAdmissionOperation() { return admission; } },
  };
  const auth = modules.createBetterAuth(options);
  const handler = modules.createBetterAuthPublicHandler({
    ...options, ...(mcpRegistrationPolicy ? { mcpRegistrationPolicy } : {}),
  });
  const person = await auth.chickpea.reconcileSlackIdentity({
    slackTeamId: 'T12345678', slackUserId: 'U12345678', displayName: 'Fixture Owner',
    organization: { name: 'Fixture', slug: 'fixture' },
  });
  admission = {
    operationId: 'fixture', status: 'active', chickpeaRole: 'owner',
    slackTeamId: 'T12345678', slackUserId: 'U12345678',
    betterAuthUserId: person.userId, betterAuthOrganizationId: person.organizationId,
    betterAuthMembershipId: person.membershipId,
  };
  const session = await auth.chickpea.issueSession('fixture', new Request(`${ORIGIN}/oauth/finalize`, {
    method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
  }));
  const cookie = session.headers.get('set-cookie')!.split(';', 1)[0]!;
  function json(path: string, body: unknown) {
    return handler(new Request(`${ORIGIN}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
      body: JSON.stringify(body),
    }));
  }
  function form(route: string, body: Record<string, string>) {
    return handler(new Request(`${ORIGIN}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    }));
  }
  const token = (body: Record<string, string>) => form('/api/auth/oauth2/token', body);
  const revoke = (clientId: string, value: string, hint: 'access_token' | 'refresh_token') =>
    form('/api/auth/oauth2/revoke', { client_id: clientId, token: value, token_type_hint: hint });
  function register(metadata: Record<string, unknown> = {}, { signedIn = false } = {}) {
    const registration = {
      application_type: 'native', client_name: 'Refresh fixture',
      grant_types: ['authorization_code', 'refresh_token'], redirect_uris: [REDIRECT],
      response_types: ['code'], token_endpoint_auth_method: 'none', ...metadata,
    };
    if (signedIn) return json('/api/auth/oauth2/register', registration);
    return handler(new Request(`${ORIGIN}/api/auth/oauth2/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration),
    }));
  }
  async function beginAuthorize(clientId: string, scope: string, { signedIn = true } = {}) {
    const verifier = 'f'.repeat(64);
    const query = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
      scope, state: 'fixture-state', resource: RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const response = await handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, {
      headers: signedIn ? { cookie } : {},
    }));
    return { response, verifier };
  }
  async function approve(consentLocation: string) {
    const consentUrl = new URL(consentLocation, ORIGIN);
    assert.equal(consentUrl.pathname, '/auth/mcp/consent');
    const consent = await json('/api/auth/oauth2/consent', { accept: true, oauth_query: consentUrl.search.slice(1) });
    assert.equal(consent.status, 200);
    return new URL((await consent.json() as { url: string }).url);
  }
  async function authorize(clientId: string, scope: string) {
    const { response, verifier } = await beginAuthorize(clientId, scope);
    assert.equal(response.status, 302);
    const callback = await approve(response.headers.get('location')!);
    assert.equal(callback.searchParams.get('state'), 'fixture-state');
    assert.ok(callback.searchParams.get('code'));
    return token({
      grant_type: 'authorization_code', client_id: clientId,
      code: callback.searchParams.get('code')!, code_verifier: verifier,
      redirect_uri: REDIRECT, resource: RESOURCE,
    });
  }
  function recordWorkspaceOnlyConsent(clientId: string) {
    backend.database.prepare('UPDATE oauthConsent SET scopes = ? WHERE clientId = ?')
      .run(JSON.stringify([WORKSPACE_SCOPE]), clientId);
  }
  return {
    backend, options, cookie, handler, form, register, beginAuthorize, approve, authorize, token, revoke,
    recordWorkspaceOnlyConsent,
  };
}

async function workerBuildAuthModules(t: TestContext): Promise<AuthModules> {
  const resolved = await resolveConfig(
    { root: PROJECT_ROOT, configFile: path.join(PROJECT_ROOT, 'vite.config.ts') },
    'build',
  );
  const { minify, rolldownOptions } = resolved.environments.chickpea!.build;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'chickpea-worker-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = path.join(directory, 'auth-routes.ts');
  writeFileSync(entry, [
    `export { createBetterAuth } from ${JSON.stringify(path.join(PROJECT_ROOT, 'src/auth/better-auth.ts'))};`,
    `export { createBetterAuthPublicHandler } from ${JSON.stringify(path.join(PROJECT_ROOT, 'src/auth/better-auth-routes.ts'))};`,
  ].join('\n'));
  const outDir = path.join(directory, 'dist');
  await build({
    configFile: false,
    root: PROJECT_ROOT,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: { ssr: entry, outDir, minify, rolldownOptions: { output: rolldownOptions.output ?? {} } },
  });
  const [bundle] = readdirSync(outDir).filter((name) => name.startsWith('auth-routes.'));
  return await import(pathToFileURL(path.join(outDir, bundle!)).href) as AuthModules;
}

for (const variant of ['source', 'Worker build'] as const) {
  test(`revoking an expired, unknown or already revoked token answers 200; a request with no token answers 400 (${variant})`, async (t) => {
    const options = variant === 'source' ? {} : { modules: await workerBuildAuthModules(t) };
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = await fixture(options);
    t.after(() => f.backend.close());
    const client = await (await f.register({ scope: RENEWABLE_SCOPE })).json() as { client_id: string };
    const tokens = await (await f.authorize(client.client_id, RENEWABLE_SCOPE)).json() as Record<string, string>;
    const revoke = (body: Record<string, string>) => f.form('/api/auth/oauth2/revoke', { client_id: client.client_id, ...body });

    for (const hint of ['refresh_token', 'access_token', undefined]) {
      const unknown = await revoke({ token: 'never-issued', ...(hint ? { token_type_hint: hint } : {}) });
      assert.equal(unknown.status, 200, `RFC 7009 2.2: an unknown token is invalid, so revoking it succeeds (hint ${hint})`);
    }
    for (const missing of [{}, { token: '' }]) {
      const malformed = await revoke(missing);
      assert.equal(malformed.status, 400, JSON.stringify(missing));
      assert.equal((await malformed.json() as { error: string }).error, 'invalid_request');
    }

    t.mock.timers.tick(16 * 60_000);
    assert.equal((await f.revoke(client.client_id, tokens.refresh_token!, 'refresh_token')).status, 200);
    const again = await f.revoke(client.client_id, tokens.refresh_token!, 'refresh_token');
    assert.equal(again.status, 200, 'RFC 7009 2.2: an already revoked token is invalid, so revoking it succeeds');
    const expired = await f.revoke(client.client_id, tokens.access_token!, 'access_token');
    assert.equal(expired.status, 200, 'RFC 7009 2.2: an expired token is invalid, so revoking it succeeds');
  });
}

test('the CLI signs out against the revoke route, and again from a copy whose tokens are already revoked', async (t) => {
  const f = await fixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'chickpea-cli-logout-'));
  t.after(() => {
    f.backend.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const client = await (await f.register({ scope: RENEWABLE_SCOPE })).json() as { client_id: string };
  const tokens = await (await f.authorize(client.client_id, RENEWABLE_SCOPE)).json() as StoredOAuthTokens;
  const store = new CredentialStore(directory);
  const issuer = `${ORIGIN}/api/auth`;
  const entry: StoredDeployment = {
    origin: ORIGIN,
    client: { client_id: client.client_id, issuer },
    tokens: { ...withExpiry(tokens, Date.now()), issuer },
    updatedAt: new Date().toISOString(),
  };
  const deps: AuthDeps = {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => f.handler(new Request(input, init))) as typeof fetch,
    store,
    now: Date.now,
    openBrowser: async () => undefined,
    note: () => undefined,
  };

  store.write(entry);
  assert.deepEqual(await logout(ORIGIN, deps), { origin: ORIGIN, revoked: true });
  assert.equal(store.read(ORIGIN), undefined);
  const renewal = await f.token({
    grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token!, resource: RESOURCE,
  });
  assert.equal(renewal.status, 400, 'the refresh token is dead server-side');

  store.write(entry);
  await logout(ORIGIN, deps);
  assert.equal(store.read(ORIGIN), undefined, 'a stale copy signs out cleanly');
});

for (const explicitRegistrationScope of [true, false]) {
  test(`real public OAuth renews expired access and rotates refresh tokens (${explicitRegistrationScope ? 'explicit' : 'default'} registration scopes)`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = await fixture();
    t.after(() => f.backend.close());
    const registered = await f.register(explicitRegistrationScope ? { scope: RENEWABLE_SCOPE } : {});
    assert.equal(registered.status, 201);
    const client = await registered.json() as { client_id: string; scope: string };
    assert.equal(client.scope, RENEWABLE_SCOPE);
    const exchange = await f.authorize(client.client_id, RENEWABLE_SCOPE);
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json() as Record<string, string | number>;
    assert.equal(tokens.expires_in, 900);
    assert.equal(typeof tokens.refresh_token, 'string');
    assert.equal(tokens.scope, RENEWABLE_SCOPE);
    const jwks = await (await f.handler(new Request(`${ORIGIN}/api/auth/jwks`))).json() as JSONWebKeySet;
    const key = createLocalJWKSet(jwks);
    const verifyOptions = { issuer: `${ORIGIN}/api/auth`, audience: RESOURCE };
    await jwtVerify(String(tokens.access_token), key, verifyOptions);

    t.mock.timers.tick(16 * 60_000);
    await assert.rejects(jwtVerify(String(tokens.access_token), key, verifyOptions), { code: 'ERR_JWT_EXPIRED' });
    const wrongResource = await f.token({
      grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: String(tokens.refresh_token), resource: 'https://other.example/mcp',
    });
    assert.equal(wrongResource.status, 400, 'refresh cannot expand the resource grant');
    const other = await f.register({ scope: RENEWABLE_SCOPE });
    assert.equal(other.status, 201);
    const otherClient = await other.json() as { client_id: string };
    const wrongClient = await f.token({
      grant_type: 'refresh_token', client_id: otherClient.client_id,
      refresh_token: String(tokens.refresh_token), resource: RESOURCE,
    });
    assert.equal(wrongClient.status, 400, 'refresh remains bound to the client that received consent');
    const refreshed = await f.token({
      grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: String(tokens.refresh_token), resource: RESOURCE,
    });
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json() as Record<string, string>;
    assert.equal(typeof next.refresh_token, 'string');
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.notEqual(next.access_token, tokens.access_token);
    assert.equal(next.scope, RENEWABLE_SCOPE);
    await jwtVerify(next.access_token!, key, verifyOptions);

    // MCP allows a 30-second retry overlap; reuse outside it revokes the family.
    t.mock.timers.tick(31_000);
    const replay = await f.token({
      grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: String(tokens.refresh_token), resource: RESOURCE,
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as { error: string }).error, 'invalid_grant');
    const revokedFamily = await f.token({
      grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: next.refresh_token!, resource: RESOURCE,
    });
    assert.equal(revokedFamily.status, 400);
    assert.equal((await revokedFamily.json() as { error: string }).error, 'invalid_grant');
  });
}

test('a refresh token needs a registration that allows one, and registration rejects unrelated scopes', async (t) => {
  const f = await fixture();
  t.after(() => f.backend.close());
  const denied = await f.register({ scope: `${RENEWABLE_SCOPE} admin` });
  assert.equal(denied.status, 400);
  assert.deepEqual(await denied.json(), { error: 'invalid_scope' });
  assert.equal((await f.register({ scope: 'offline_access' })).status, 400, 'workspace permission is required');

  const single = await (await f.register({ grant_types: ['authorization_code'], scope: WORKSPACE_SCOPE }))
    .json() as { client_id: string };
  const exchange = await f.authorize(single.client_id, WORKSPACE_SCOPE);
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json() as Record<string, unknown>;
  assert.equal(typeof tokens.access_token, 'string');
  assert.equal(tokens.refresh_token, undefined, 'a client that did not register for the refresh grant gets no refresh token');
  assert.equal(tokens.scope, WORKSPACE_SCOPE);

  // DCR stores all server-allowed scopes. Recreate a client from before the
  // server supported offline_access, rather than registering a new one now.
  const old = await (await f.register({ scope: WORKSPACE_SCOPE })).json() as { client_id: string };
  f.backend.database.prepare('UPDATE oauthClient SET scopes = ? WHERE clientId = ?')
    .run(JSON.stringify([WORKSPACE_SCOPE]), old.client_id);
  const oldExchange = await (await f.authorize(old.client_id, WORKSPACE_SCOPE)).json() as Record<string, unknown>;
  assert.equal(oldExchange.scope, WORKSPACE_SCOPE, 'an old registration still signs in, without renewal');
  assert.equal(oldExchange.refresh_token, undefined);
  const upgrade = await f.beginAuthorize(old.client_id, RENEWABLE_SCOPE);
  assert.equal(upgrade.response.status, 302);
  assert.equal(new URL(upgrade.response.headers.get('location')!, ORIGIN).searchParams.get('error'), 'invalid_scope',
    'an old client registration needs replacing before it can request offline access');
});

test('a consent given before renewal asks the person again before a refresh token is issued', async (t) => {
  const f = await fixture();
  t.after(() => f.backend.close());
  const client = await (await f.register({ scope: RENEWABLE_SCOPE })).json() as { client_id: string };
  assert.equal((await f.authorize(client.client_id, RENEWABLE_SCOPE)).status, 200);
  f.recordWorkspaceOnlyConsent(client.client_id);
  const renewal = await f.beginAuthorize(client.client_id, WORKSPACE_SCOPE);
  assert.equal(new URL(renewal.response.headers.get('location')!, ORIGIN).pathname, '/auth/mcp/consent',
    'staying signed in needs the person\'s consent');
  const upgrade = await f.authorize(client.client_id, WORKSPACE_SCOPE);
  assert.equal(upgrade.status, 200);
  assert.equal(typeof (await upgrade.json() as { refresh_token: unknown }).refresh_token, 'string');
  const next = await f.beginAuthorize(client.client_id, WORKSPACE_SCOPE);
  assert.equal(new URL(next.response.headers.get('location')!).pathname, '/callback',
    'the renewed consent covers the next sign-in');
});

test('a client that requests only the scopes the resource advertises still renews', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture();
  t.after(() => f.backend.close());
  // MCP 2026-07-28 keeps offline_access out of the challenge and the resource metadata.
  const challenged = /scope="([^"]+)"/.exec(
    mcpAuthorizationChallenge(ORIGIN, false).headers.get('www-authenticate')!,
  )?.[1];
  const metadata = await (await f.handler(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)))
    .json() as { scopes_supported: string[] };
  assert.equal(challenged, WORKSPACE_SCOPE);
  assert.deepEqual(metadata.scopes_supported, [WORKSPACE_SCOPE]);

  const client = await (await f.register({ scope: WORKSPACE_SCOPE })).json() as { client_id: string };
  const signedOut = await f.beginAuthorize(client.client_id, WORKSPACE_SCOPE, { signedIn: false });
  const login = new URL(signedOut.response.headers.get('location')!, ORIGIN);
  assert.equal(login.pathname, '/auth/mcp/login');
  assert.equal(login.searchParams.get('scope'), RENEWABLE_SCOPE, 'Slack sign-in resumes the renewable request');
  const begun = await f.beginAuthorize(client.client_id, WORKSPACE_SCOPE);
  const consent = new URL(begun.response.headers.get('location')!, ORIGIN);
  assert.equal(consent.pathname, '/auth/mcp/consent');
  assert.match(renderMcpConsentPage({ scope: consent.searchParams.get('scope')!, oauthQuery: '' }),
    /Manage this Chickpea workspace and stay signed in/, 'the person sees that the agent stays signed in');
  const exchange = await f.authorize(client.client_id, WORKSPACE_SCOPE);
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json() as Record<string, string>;
  assert.equal(typeof tokens.refresh_token, 'string');
  assert.equal(tokens.scope, RENEWABLE_SCOPE);

  t.mock.timers.tick(16 * 60_000);
  const renewed = await f.token({
    grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token!, resource: RESOURCE,
  });
  assert.equal(renewed.status, 200, 'the expired access token renews without a new sign-in');
});

test('an MCP 2025-11-25 SDK client signs in from the challenge alone and receives a refresh token', async (t) => {
  const f = await fixture();
  t.after(() => f.backend.close());
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(input instanceof Request ? input.url : input).pathname === '/mcp'
      ? mcpAuthorizationChallenge(ORIGIN, false)
      : f.handler(new Request(input, init))) as typeof fetch;
  const challenge = await fetchFn(`${ORIGIN}/mcp`);
  const { scope, resourceMetadataUrl } = extractWWWAuthenticateParams(challenge);
  assert.ok(scope && resourceMetadataUrl);
  let client: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = '';
  let authorization: URL | undefined;
  const clientMetadata = {
    client_name: 'Spec client', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native',
  };
  const provider: OAuthClientProvider = {
    redirectUrl: REDIRECT,
    clientMetadata,
    clientInformation: () => client,
    saveClientInformation: (value) => { client = value; },
    tokens: () => tokens,
    saveTokens: (value) => { tokens = value; },
    redirectToAuthorization: (url) => { authorization = url; },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier,
  };
  const options = { serverUrl: `${ORIGIN}/mcp`, scope, resourceMetadataUrl, fetchFn };
  assert.equal(await specClientAuth(provider, options), 'REDIRECT');
  assert.equal(authorization?.searchParams.get('scope'), WORKSPACE_SCOPE, 'the client asks only for what the challenge names');
  const login = await f.handler(new Request(authorization, { headers: { cookie: f.cookie } }));
  const callback = await f.approve(login.headers.get('location')!);
  assert.equal(await specClientAuth(provider, { ...options, authorizationCode: callback.searchParams.get('code')! }), 'AUTHORIZED');
  assert.equal(typeof tokens?.refresh_token, 'string');
  assert.equal(tokens?.scope, RENEWABLE_SCOPE);
});

test('a registration flood cannot cancel a sign-in in progress, and registration recovers after the consent window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T00:00:00.000Z') });
  const f = await fixture({ mcpRegistrationPolicy: { maxPendingClients: 3 } });
  t.after(() => f.backend.close());
  const register = async (name: string) => {
    t.mock.timers.tick(1_000);
    return f.register({ client_name: name, scope: RENEWABLE_SCOPE });
  };
  const names = () => (f.backend.database.prepare('SELECT name FROM oauthClient ORDER BY createdAt').all() as { name: string }[])
    .map((row) => row.name);
  const quotaExceeded = async (name: string) => {
    const response = await register(name);
    assert.equal(response.status, 429, name);
    assert.deepEqual(await response.json(), { error: 'registration_quota_exceeded' });
  };
  const inUse = await (await register('In use')).json() as { client_id: string };
  const tokens = await (await f.authorize(inUse.client_id, RENEWABLE_SCOPE)).json() as Record<string, string>;

  const inProgress = await (await register('In progress')).json() as { client_id: string };
  assert.equal((await register('Flood 1')).status, 201);
  assert.equal((await register('Flood 2')).status, 201);
  await quotaExceeded('Flood refused');
  assert.equal((await f.authorize(inProgress.client_id, RENEWABLE_SCOPE)).status, 200,
    'a flood of fresh registrations cannot evict one registered seconds earlier');

  assert.equal((await register('Flood 3')).status, 201);
  await quotaExceeded('Flood refused again');
  t.mock.timers.tick(15 * 60_000);
  assert.equal((await register('After the window')).status, 201);
  assert.deepEqual(names(), ['In use', 'In progress', 'Flood 2', 'Flood 3', 'After the window'],
    'past its consent window the oldest registration makes room');

  // The refresh token itself lives 30 days, so renew it before the prune and again after.
  t.mock.timers.tick(29 * 24 * 60 * 60_000);
  const renewedOnce = await f.token({
    grant_type: 'refresh_token', client_id: inUse.client_id, refresh_token: tokens.refresh_token!, resource: RESOURCE,
  });
  assert.equal(renewedOnce.status, 200);
  t.mock.timers.tick(2 * 24 * 60 * 60_000);
  assert.equal((await register('30 days on')).status, 201);
  assert.deepEqual(names(), ['In use', 'In progress', '30 days on'], 'a registration without consent for 30 days is pruned');
  const renewed = await f.token({
    grant_type: 'refresh_token', client_id: inUse.client_id,
    refresh_token: (await renewedOnce.json() as Record<string, string>).refresh_token!, resource: RESOURCE,
  });
  assert.equal(renewed.status, 200, 'the client in use keeps renewing');
});

test('a registration that no one consents to is kept for 30 days, then pruned', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T00:00:00.000Z') });
  const f = await fixture();
  t.after(() => f.backend.close());
  const day = 24 * 60 * 60_000;
  const names = () => (f.backend.database.prepare('SELECT name FROM oauthClient ORDER BY createdAt').all() as { name: string }[])
    .map((row) => row.name);
  assert.equal((await f.register({ client_name: 'Abandoned', scope: RENEWABLE_SCOPE })).status, 201);

  t.mock.timers.tick(29 * day);
  assert.equal((await f.register({ client_name: 'Day 29', scope: RENEWABLE_SCOPE })).status, 201);
  assert.deepEqual(names(), ['Abandoned', 'Day 29'], 'a client that stayed away for weeks can still sign in');

  t.mock.timers.tick(2 * day);
  assert.equal((await f.register({ client_name: 'Day 31', scope: RENEWABLE_SCOPE })).status, 201);
  assert.deepEqual(names(), ['Day 29', 'Day 31'], 'past 30 days the abandoned registration is pruned');
});

test('MCP consent names the registered app instead of its client id', async (t) => {
  const f = await fixture();
  t.after(() => f.backend.close());
  const registered = await f.register({ scope: RENEWABLE_SCOPE });
  assert.equal(registered.status, 201);
  const client = await registered.json() as { client_id: string };
  const headers = new Headers({ cookie: f.cookie });
  const name = await lookupMcpClientName(f.options, client.client_id, headers);
  assert.equal(name, 'Refresh fixture');
  const html = renderMcpConsentPage({ clientName: name, scope: RENEWABLE_SCOPE, oauthQuery: 'sig=test' });
  assert.ok(html.includes('Refresh fixture'));
  assert.ok(!html.includes(client.client_id), 'the dynamically registered client id stays off the page');
  assert.equal(await lookupMcpClientName(f.options, 'unknown-client', headers), undefined);
  assert.equal(await lookupMcpClientName(f.options, '', headers), undefined);
});

test('a signed-out person who signs in with Slack lands on the MCP consent screen', async (t) => {
  const f = await fixture();
  t.after(() => f.backend.close());
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => identity.close());
  const browser = new Hono();
  mountMcpOAuthBrowserRoutes(browser, async () => f.options);
  const state = 'mcp-login-state-0123456789abcdefghijklmnop';
  let signInDestination = '';
  const admin = createAdminRoutes({
    identity,
    authSecret: randomBytes(32).toString('base64url'),
    slackAdmissionService: {
      async startLogin(input: { destination: string }) {
        signInDestination = input.destination;
        return {
          attemptId: 'slackoidc_mcp', state, nonce: 'mcp-login-nonce-0123456789abcdefghijklmnop',
          expiresAt: Date.now() + 900_000,
          authorizationUrl: `https://slack.com/openid/connect/authorize?state=${state}`,
        };
      },
      async callback() {
        return {
          destination: signInDestination,
          sessionResponse: new Response('{}', { headers: { 'set-cookie': `${f.cookie}; Path=/; HttpOnly; Secure` } }),
        };
      },
    } as unknown as SlackAdmissionService,
  });

  const client = await (await f.register({ scope: RENEWABLE_SCOPE })).json() as { client_id: string };
  const signedOut = await f.beginAuthorize(client.client_id, RENEWABLE_SCOPE, { signedIn: false });
  const login = new URL(signedOut.response.headers.get('location')!, ORIGIN);
  const signInUrl = (await browser.request(`${ORIGIN}${login.pathname}${login.search}`)).headers.get('location')!;
  const signInPage = await (await admin.request(new URL(signInUrl, ORIGIN).toString())).text();
  const destination = /name="destination" value="([^"]*)"/.exec(signInPage)?.[1] ?? '';
  const start = await admin.request(`${ORIGIN}/auth/slack/oidc/start`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ purpose: 'login', destination }),
  });
  assert.equal(start.status, 200);
  const callback = await admin.request(`${ORIGIN}/auth/slack/oidc/callback?state=${state}&code=oidc-code`, {
    headers: { cookie: start.headers.get('set-cookie')!.split(';', 1)[0]! },
  });
  const resume = callback.headers.get('location') ?? '';
  assert.match(resume, /^\/auth\/mcp\/resume\/[A-Za-z0-9_-]{43}$/, 'Slack sign-in returns to the MCP authorization');
  const authorization = (await browser.request(`${ORIGIN}${resume}`)).headers.get('location')!;
  const consent = await f.handler(new Request(`${ORIGIN}${authorization}`, { headers: { cookie: f.cookie } }));
  assert.equal(new URL(consent.headers.get('location')!, ORIGIN).pathname, '/auth/mcp/consent');
});
