import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { Hono } from 'hono';

import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { createBetterAuthPublicHandler, type BetterAuthPublicHandlerInput } from '../src/auth/better-auth-routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import type { ClientMetadataFetch } from '../src/auth/mcp-client-metadata.ts';
import { mountMcpOAuthBrowserRoutes, renderMcpConsentPage } from '../src/auth/mcp-oauth-routes.ts';
import { CLAUDE_DOCUMENTS, metadataDocumentServer, type ServedDocument } from './helpers/client-metadata-documents.ts';

const ORIGIN = 'https://chickpea.example.test';
const RESOURCE = `${ORIGIN}/mcp`;
const CLAUDE = CLAUDE_DOCUMENTS.claude.url;
const CLAUDE_CODE = CLAUDE_DOCUMENTS.claudeCode.url;
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RENEWABLE_SCOPE = 'chickpea:workspace offline_access';

/** A valid document at `url` that copies Claude's name and redirect. */
const lookalike = (url: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ ...JSON.parse(CLAUDE_DOCUMENTS.claude.body), client_id: url, client_uri: undefined, ...fields });

/** A document client's row as another deployment, or an earlier build of this one, stored it. */
const storeDocumentClient = (backend: NodeBetterAuthBackend, clientId: string) => backend.database.prepare(
  `INSERT INTO oauthClient (id, clientId, clientDiscoveryId, redirectUris, tokenEndpointAuthMethod, name, createdAt, updatedAt)
   VALUES (?, ?, 'cimd', ?, 'none', 'Claude', ?, ?)`,
).run(randomBytes(8).toString('hex'), clientId, JSON.stringify([CLAUDE_CALLBACK]), Date.now(), Date.now());

const PUBLIC_CLIENTS_ONLY = {
  error: 'invalid_client',
  error_description: 'metadata document must describe a public client: token_endpoint_auth_method "none", no jwks or jwks_uri',
};

const signingKeys = () => {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  return { keys: [{ ...jwk, alg: 'EdDSA', use: 'sig', kid: 'k1' }] };
};

const forgedClientAssertion = (clientId: string, jti: string) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {
    iss: clientId, sub: clientId, aud: `${ORIGIN}/api/auth/oauth2/token`, exp: Math.floor(Date.now() / 1_000) + 60, jti,
  };
  return `${part({ alg: 'EdDSA', kid: 'unknown' })}.${part(claims)}.AAAA`;
};

/** Hosted shared auth by default, the one place a metadata document signs a client in. */
async function fixture(t: TestContext, options: {
  clientMetadataDocuments?: boolean;
  fetchClientMetadataResource?: ClientMetadataFetch;
  mcpRegistrationPolicy?: BetterAuthPublicHandlerInput['mcpRegistrationPolicy'];
  throttleRegistration?: BetterAuthPublicHandlerInput['throttleRegistration'];
} = {}) {
  const backend = new NodeBetterAuthBackend(':memory:');
  t.after(() => backend.close());
  let admission: BetterAuthAdmissionOperation | null = null;
  const environment = {
    backend, baseURL: ORIGIN, secret: randomBytes(32).toString('base64url'),
    clientMetadataDocuments: options.clientMetadataDocuments ?? true,
    ...(options.fetchClientMetadataResource ? { fetchClientMetadataResource: options.fetchClientMetadataResource } : {}),
  };
  const auth = createBetterAuth({ ...environment, privateSeam: { async resolveAdmissionOperation() { return admission; } } });
  const handler = createBetterAuthPublicHandler({
    ...environment,
    ...(options.mcpRegistrationPolicy ? { mcpRegistrationPolicy: options.mcpRegistrationPolicy } : {}),
    ...(options.throttleRegistration ? { throttleRegistration: options.throttleRegistration } : {}),
  });
  const browser = new Hono();
  mountMcpOAuthBrowserRoutes(browser, async () => environment);
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

  const verifier = randomBytes(32).toString('base64url');
  function authorize(clientId: string, redirectUri: string, {
    signedIn = true, headers = {} as Record<string, string>, prompt = undefined as string | undefined, post = false,
  } = {}) {
    const query = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      scope: 'chickpea:workspace', state: 'client-state', resource: RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(prompt ? { prompt } : {}),
    });
    const sent = { ...headers, ...(signedIn ? { cookie } : {}) };
    return handler(post
      ? new Request(`${ORIGIN}/api/auth/oauth2/authorize`, {
        method: 'POST', headers: { ...sent, 'content-type': 'application/x-www-form-urlencoded' }, body: query,
      })
      : new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, { headers: sent }));
  }
  async function approve(consentLocation: string) {
    const consent = await handler(new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
      body: JSON.stringify({ accept: true, oauth_query: new URL(consentLocation, ORIGIN).search.slice(1) }),
    }));
    assert.equal(consent.status, 200, await consent.clone().text());
    return new URL((await consent.json() as { url: string }).url);
  }
  const token = (body: Record<string, string>) => handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, resource: RESOURCE }),
  }));
  const exchange = (clientId: string, redirectUri: string, code: string, codeVerifier = verifier) => token({
    grant_type: 'authorization_code', client_id: clientId, code, code_verifier: codeVerifier, redirect_uri: redirectUri,
  });
  const refresh = (clientId: string, refreshToken: string) =>
    token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken });
  const clients = () => (backend.database.prepare(
    'SELECT clientId, clientDiscoveryId, userId, clientSecret, tokenEndpointAuthMethod, name FROM oauthClient ORDER BY createdAt, clientId',
  ).all() as Record<string, unknown>[]).map((row) => ({ ...row }));
  return { backend, handler, browser, cookie, authorize, approve, token, exchange, refresh, clients };
}

const claudeHost = () => metadataDocumentServer({
  [CLAUDE]: CLAUDE_DOCUMENTS.claude.body,
  [CLAUDE_CODE]: CLAUDE_DOCUMENTS.claudeCode.body,
});

async function claudeRefreshToken(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const authorization = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  const callback = await f.approve(authorization.headers.get('location')!);
  const exchanged = await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  return (await exchanged.json() as { refresh_token: string }).refresh_token;
}

test('the authorization server advertises client ID metadata documents to public clients', async (t) => {
  const f = await fixture(t);
  for (const path of ['/.well-known/oauth-authorization-server/api/auth', '/api/auth/.well-known/oauth-authorization-server']) {
    const response = await f.handler(new Request(`${ORIGIN}${path}`));
    assert.equal(response.status, 200, path);
    const metadata = await response.json() as Record<string, unknown>;
    assert.equal(metadata.client_id_metadata_document_supported, true, path);
    assert.ok((metadata.token_endpoint_auth_methods_supported as string[]).includes('none'), path);
  }
});

test('without hosted shared auth no metadata document signs a client in: Claude\'s URL is an unknown client, never fetched', async (t) => {
  const host = claudeHost();
  const f = await fixture(t, { clientMetadataDocuments: false, fetchClientMetadataResource: host.fetch });
  storeDocumentClient(f.backend, CLAUDE);
  for (const path of ['/.well-known/oauth-authorization-server/api/auth', '/api/auth/.well-known/oauth-authorization-server']) {
    const metadata = await (await f.handler(new Request(`${ORIGIN}${path}`))).json() as Record<string, unknown>;
    assert.equal(metadata.client_id_metadata_document_supported, undefined, path);
  }
  for (const [clientId, redirect] of [[CLAUDE, CLAUDE_CALLBACK], [CLAUDE_CODE, 'http://localhost:53682/callback']] as const) {
    for (const signedIn of [false, true]) {
      const response = await f.authorize(clientId, redirect, { signedIn });
      const location = new URL(response.headers.get('location') ?? '/', ORIGIN);
      assert.equal(location.searchParams.get('error'), 'invalid_client', `${clientId} signed ${signedIn ? 'in' : 'out'}`);
    }
  }
  assert.deepEqual(host.requests, []);
  assert.deepEqual(f.clients().map((client) => client.clientId), [CLAUDE], 'a stored document client stays unknown');
});

test('only Claude\'s two published documents sign a client in; any other URL is an unknown client, never fetched, throttled or stored', async (t) => {
  const others = [
    'https://evil.example/client',
    'https://claude.ai/oauth/other-client-metadata',
    `${CLAUDE}/`,
    `${CLAUDE}?client=claude`,
    'https://claude.ai:443/oauth/mcp-oauth-client-metadata',
    'https://CLAUDE.AI/oauth/mcp-oauth-client-metadata',
    'http://claude.ai/oauth/mcp-oauth-client-metadata',
    'https://127.0.0.1/client',
    'https://169.254.169.254/latest/meta-data',
  ];
  const host = metadataDocumentServer({
    [CLAUDE_CODE]: CLAUDE_DOCUMENTS.claudeCode.body,
    ...Object.fromEntries(others.map((url) => [url, lookalike(url)])),
  });
  let throttled = 0;
  const f = await fixture(t, {
    fetchClientMetadataResource: host.fetch,
    async throttleRegistration() { throttled += 1; return undefined; },
  });
  const prune = t.mock.method(f.backend, 'prunePendingMcpOAuthClients');
  const stored = 'https://evil.example/stored-client';
  storeDocumentClient(f.backend, stored);
  for (const clientId of [...others, stored]) {
    for (const signedIn of [false, true]) {
      const response = await f.authorize(clientId, CLAUDE_CALLBACK, { signedIn });
      const location = new URL(response.headers.get('location') ?? '/', ORIGIN);
      assert.equal(location.searchParams.get('error'), 'invalid_client', `${clientId} signed ${signedIn ? 'in' : 'out'}`);
    }
  }
  assert.deepEqual(host.requests, []);
  assert.equal(throttled, 0, 'an unknown client spends none of its source\'s registration limit');
  assert.equal(prune.mock.callCount(), 0, 'or a pending-client write');
  assert.deepEqual(f.clients().map((client) => client.clientId), [stored]);

  assert.equal((await f.authorize(CLAUDE_CODE, 'http://localhost:53682/callback', { signedIn: false })).status, 302);
  assert.deepEqual(host.requests, [CLAUDE_CODE]);
  assert.equal(throttled, 1);
});

test('Claude signs in with its published metadata document: Slack sign-in, consent naming its domain, PKCE without a secret', async (t) => {
  const host = claudeHost();
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });

  const signedOut = await f.authorize(CLAUDE, CLAUDE_CALLBACK, { signedIn: false });
  assert.equal(signedOut.status, 302);
  const login = new URL(signedOut.headers.get('location')!, ORIGIN);
  assert.equal(login.pathname, '/auth/mcp/login');
  assert.equal(login.searchParams.get('client_id'), CLAUDE);
  const continuation = await f.browser.request(`${ORIGIN}${login.pathname}${login.search}`);
  const resume = new URL(continuation.headers.get('location')!, ORIGIN).searchParams.get('destination')!;
  const resumed = await f.browser.request(`${ORIGIN}${resume}`);
  const authorization = await f.handler(new Request(`${ORIGIN}${resumed.headers.get('location')}`, {
    headers: { cookie: f.cookie },
  }));
  assert.equal(authorization.status, 302);
  const consent = new URL(authorization.headers.get('location')!, ORIGIN);
  assert.equal(consent.pathname, '/auth/mcp/consent');
  assert.equal(consent.searchParams.get('scope'), RENEWABLE_SCOPE, 'Claude registers for renewal, so its sign-in renews');

  const page = await (await f.browser.request(`${ORIGIN}${consent.pathname}${consent.search}`, {
    headers: { cookie: f.cookie },
  })).text();
  assert.ok(page.includes(
    '<dt>App</dt><dd>Claude <span class="note">(name provided by the app)</span></dd><dt>Domain</dt><dd>claude.ai</dd>',
  ));

  const callback = await f.approve(consent.toString());
  assert.equal(`${callback.origin}${callback.pathname}`, CLAUDE_CALLBACK);
  assert.equal(callback.searchParams.get('state'), 'client-state');
  const exchanged = await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens = await exchanged.json() as Record<string, unknown>;
  assert.equal(tokens.scope, RENEWABLE_SCOPE);
  assert.equal(typeof tokens.refresh_token, 'string');
  const jwks = await (await f.handler(new Request(`${ORIGIN}/api/auth/jwks`))).json() as JSONWebKeySet;
  const { payload } = await jwtVerify(String(tokens.access_token), createLocalJWKSet(jwks), {
    issuer: `${ORIGIN}/api/auth`, audience: RESOURCE,
  });
  assert.equal(payload.azp, CLAUDE);

  assert.deepEqual(f.clients(), [{
    clientId: CLAUDE, clientDiscoveryId: 'cimd', userId: null, clientSecret: null,
    tokenEndpointAuthMethod: 'none', name: 'Claude',
  }], 'one shared, ownerless row for every Claude user; no secret');
  assert.deepEqual(host.requests, [CLAUDE], 'the document is fetched once and then served from cache');
});

test('a code from a metadata-document sign-in needs its PKCE verifier', async (t) => {
  const f = await fixture(t, { fetchClientMetadataResource: claudeHost().fetch });
  const authorization = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  const callback = await f.approve(authorization.headers.get('location')!);
  const wrong = await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!, 'x'.repeat(43));
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json() as { error: string }).error, 'invalid_grant');
});

test('Claude Code signs in on a loopback port its document lists without one, and renews from its first sign-in', async (t) => {
  const f = await fixture(t, { fetchClientMetadataResource: claudeHost().fetch });
  const redirect = 'http://localhost:53682/callback';
  const authorization = await f.authorize(CLAUDE_CODE, redirect);
  assert.equal(authorization.status, 302);
  const consent = new URL(authorization.headers.get('location')!, ORIGIN);
  assert.equal(consent.pathname, '/auth/mcp/consent');
  assert.equal(consent.searchParams.get('scope'), RENEWABLE_SCOPE,
    'a signed-in first sign-in stores the client before deciding renewal');
  const callback = await f.approve(consent.toString());
  assert.equal(`${callback.origin}${callback.pathname}`, 'http://localhost:53682/callback');
  const exchanged = await f.exchange(CLAUDE_CODE, redirect, callback.searchParams.get('code')!);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  assert.equal(typeof (await exchanged.json() as Record<string, unknown>).refresh_token, 'string');
});

test('a metadata-document client on a loopback redirect asks for consent every time; one on HTTPS asks once', async (t) => {
  const f = await fixture(t, { fetchClientMetadataResource: claudeHost().fetch });
  const first = await f.authorize(CLAUDE_CODE, 'http://localhost:53682/callback');
  await f.approve(first.headers.get('location')!);

  // RFC 8252 8.6: any local app can claim Claude Code's published client ID and a port of its own.
  const otherPort = await f.authorize(CLAUDE_CODE, 'http://localhost:4444/callback');
  assert.equal(otherPort.status, 302);
  const consent = new URL(otherPort.headers.get('location')!, ORIGIN);
  assert.equal(consent.pathname, '/auth/mcp/consent');
  const callback = await f.approve(consent.toString());
  assert.equal(`${callback.origin}${callback.pathname}`, 'http://localhost:4444/callback');
  assert.ok(callback.searchParams.get('code'));
  const samePort = await f.authorize(CLAUDE_CODE, 'http://localhost:4444/callback');
  assert.equal(new URL(samePort.headers.get('location')!, ORIGIN).pathname, '/auth/mcp/consent', 'every time, on any port');
  const silent = await f.authorize(CLAUDE_CODE, 'http://localhost:4444/callback', { prompt: 'none' });
  assert.equal(new URL(silent.headers.get('location') ?? '/', ORIGIN).searchParams.get('code'), null, 'prompt=none gets no code');
  const posted = await f.authorize(CLAUDE_CODE, 'http://localhost:4444/callback', { post: true, headers: { origin: ORIGIN } });
  assert.equal(posted.status, 404, `authorize by POST skips the consent rule: ${posted.headers.get('location')}`);

  const claude = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  await f.approve(claude.headers.get('location')!);
  const again = new URL((await f.authorize(CLAUDE, CLAUDE_CALLBACK)).headers.get('location')!, ORIGIN);
  assert.equal(`${again.origin}${again.pathname}`, CLAUDE_CALLBACK, 'a client on its own HTTPS redirect is not asked twice');
  assert.ok(again.searchParams.get('code'));
});

test('a metadata document is refused unless it names its own URL, lists the redirect, and comes back small JSON at once', async (t) => {
  const served: Record<string, ServedDocument> = {};
  const host = metadataDocumentServer(served);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const refusals: Array<[ServedDocument, RegExp]> = [
    [CLAUDE_DOCUMENTS.claudeCode.body, /does not match the metadata document URL/],
    [lookalike(CLAUDE, { padding: 'x'.repeat(6_000) }), /exceeds 5KB/],
    [{ body: '<!doctype html><title>Claude</title>', headers: { 'content-type': 'text/html' } }, /must be JSON/],
    ['{"client_id":', /not valid JSON/],
    [{ body: '', status: 302, headers: { location: CLAUDE_CODE } }, /HTTP 302/],
  ];
  for (const [document, reason] of refusals) {
    served[CLAUDE] = document;
    for (const signedIn of [false, true]) {
      t.mock.timers.tick(1_000);
      const response = await f.authorize(CLAUDE, CLAUDE_CALLBACK, { signedIn });
      assert.equal(response.status, 400, `${reason} signed ${signedIn ? 'in' : 'out'}`);
      const body = await response.json() as { error: string; error_description: string };
      assert.equal(body.error, 'invalid_client', String(reason));
      assert.match(body.error_description, reason);
    }
  }
  assert.deepEqual(host.requests, refusals.flatMap(() => [CLAUDE, CLAUDE]),
    'one request per attempt; the redirect is not followed');

  served[CLAUDE] = CLAUDE_DOCUMENTS.claude.body;
  t.mock.timers.tick(1_000);
  const unlisted = await f.authorize(CLAUDE, 'https://evil.example/callback');
  const location = new URL(unlisted.headers.get('location') ?? '', ORIGIN);
  assert.equal(location.origin, ORIGIN, 'a redirect the document does not list never receives the browser');
  assert.equal(location.searchParams.get('error'), 'invalid_redirect');
  assert.equal(location.searchParams.get('code'), null);
  assert.deepEqual(f.clients().map((client) => client.clientId), [CLAUDE], 'no refused document stores a client');
});

test('a metadata document must describe a public client, as dynamic registration requires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const keys = signingKeys();
  const jwksUri = 'https://claude.ai/oauth/jwks';
  const served: Record<string, ServedDocument> = { [jwksUri]: JSON.stringify(keys) };
  const host = metadataDocumentServer(served);
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const fields of [
    { token_endpoint_auth_method: 'private_key_jwt', jwks: keys },
    { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: jwksUri },
    { jwks: keys },
  ]) {
    served[CLAUDE] = lookalike(CLAUDE, fields);
    // Better Auth keeps a document it fetched for its max-age, even one Chickpea refused.
    t.mock.timers.tick(6 * 60_000);
    for (const signedIn of [false, true]) {
      const response = await f.authorize(CLAUDE, CLAUDE_CALLBACK, { signedIn });
      assert.equal(response.status, 400, `${JSON.stringify(fields)} signed ${signedIn ? 'in' : 'out'}`);
      assert.deepEqual(await response.json(), PUBLIC_CLIENTS_ONLY);
    }
  }
  assert.deepEqual(host.requests, [CLAUDE, CLAUDE, CLAUDE], 'each document is fetched');
  assert.deepEqual(f.clients(), [], 'a refused document leaves no client behind');
});

test('a metadata document may list only the redirects dynamic registration accepts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const served: Record<string, ServedDocument> = {};
  const host = metadataDocumentServer(served);
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const redirect of ['com.example.app:/callback', 'myapp://callback/done', 'https://evil.example/callback/*']) {
    served[CLAUDE] = lookalike(CLAUDE, { redirect_uris: [redirect, CLAUDE_CALLBACK] });
    t.mock.timers.tick(6 * 60_000);
    for (const signedIn of [false, true]) {
      const response = await f.authorize(CLAUDE, redirect, { signedIn });
      assert.equal(response.status, 400, `${redirect} signed ${signedIn ? 'in' : 'out'}`);
      assert.deepEqual(await response.json(), {
        error: 'invalid_client',
        error_description: 'metadata document redirect_uris must be HTTPS, or HTTP on a loopback host, with no wildcard, credentials or fragment',
      }, redirect);
    }
  }
  assert.deepEqual(host.requests, [CLAUDE, CLAUDE, CLAUDE], 'each document is fetched');
  assert.deepEqual(f.clients(), [], 'a refused document leaves no client behind');
});

test('a stored client whose document turns to key authentication is refused before any key is fetched, even standing in', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const jwksUri = 'https://claude.ai/oauth/jwks';
  const served: Record<string, ServedDocument> = { [CLAUDE]: CLAUDE_DOCUMENTS.claude.body, [jwksUri]: JSON.stringify(signingKeys()) };
  const host = metadataDocumentServer(served);
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const authorization = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  const callback = await f.approve(authorization.headers.get('location')!);
  const exchanged = await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!);
  const { refresh_token: refreshToken } = await exchanged.json() as { refresh_token: string };
  const assertKey = (jti: string) => f.token({
    grant_type: 'authorization_code', code: 'unused', code_verifier: 'v'.repeat(43), redirect_uri: CLAUDE_CALLBACK,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: forgedClientAssertion(CLAUDE, jti),
  });

  served[CLAUDE] = lookalike(CLAUDE, { client_uri: 'https://claude.ai', token_endpoint_auth_method: 'private_key_jwt', jwks_uri: jwksUri });
  t.mock.timers.tick(6 * 60_000);
  const renewed = await f.refresh(CLAUDE, refreshToken);
  assert.equal(renewed.status, 400);
  assert.deepEqual(await renewed.json(), PUBLIC_CLIENTS_ONLY);
  for (let attempt = 0; attempt < 3; attempt++) {
    const asserted = await assertKey(`attempt-${attempt}`);
    assert.equal(asserted.status, 400);
    assert.deepEqual(await asserted.json(), PUBLIC_CLIENTS_ONLY);
  }

  served[CLAUDE] = { body: 'Service Unavailable', status: 503, headers: { 'content-type': 'text/plain' } };
  t.mock.timers.tick(6 * 60_000);
  const fetched = host.requests.length;
  const standingIn = await assertKey('standing-in');
  assert.deepEqual(host.requests.slice(fetched), [CLAUDE], 'the document did not answer, so the stored key-method row stands in');
  assert.equal(standingIn.status, 400);
  assert.deepEqual(await standingIn.json(), PUBLIC_CLIENTS_ONLY);
  assert.ok(!host.requests.includes(jwksUri), 'no key is fetched for a client Chickpea refuses');
});

test('a stored client keeps renewing while its document cannot be reached; a document that answers still replaces or refuses it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const served: Record<string, ServedDocument> = { [CLAUDE]: CLAUDE_DOCUMENTS.claude.body };
  const host = metadataDocumentServer(served);
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const authorization = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  const callback = await f.approve(authorization.headers.get('location')!);
  let refreshToken = (await (await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!)).json() as
    { refresh_token: string }).refresh_token;
  const renew = async () => {
    const response = await f.refresh(CLAUDE, refreshToken);
    if (response.ok) refreshToken = (await response.clone().json() as { refresh_token: string }).refresh_token;
    return response;
  };
  const staleCache = () => t.mock.timers.tick(6 * 60_000);

  const outages: Array<[string, ServedDocument]> = [
    ['a failed connection', () => { throw new TypeError('fetch failed'); }],
    ['a 503', { body: 'Service Unavailable', status: 503, headers: { 'content-type': 'text/plain' } }],
  ];
  for (const [outage, answer] of outages) {
    served[CLAUDE] = answer;
    staleCache();
    assert.equal((await renew()).status, 200, `${outage}: the stored client renews`);
    t.mock.timers.tick(100);
    assert.equal((await renew()).status, 200, `${outage}: again inside the plugin's one-second pause`);
  }

  served[CLAUDE] = lookalike(CLAUDE, { client_name: 'Claude (renamed)', client_uri: 'https://claude.ai' });
  staleCache();
  assert.equal((await renew()).status, 200);
  assert.equal(f.clients()[0]?.name, 'Claude (renamed)', 'a document that answers replaces the stored client');

  for (const [refusal, answer] of [
    ['a document gone', { body: 'Not Found', status: 404, headers: { 'content-type': 'text/plain' } }],
    ['a document naming another URL', lookalike('https://claude.ai/oauth/another')],
  ] as Array<[string, ServedDocument]>) {
    served[CLAUDE] = answer;
    staleCache();
    const refused = await renew();
    assert.equal(refused.status, 400, refusal);
    assert.equal((await refused.json() as { error: string }).error, 'invalid_client', refusal);
    t.mock.timers.tick(100);
    assert.notEqual((await renew()).status, 200, `${refusal}: the one-second pause does not bring the stored client back`);
  }
});

test('a stored client stands in for an unreachable document for a day after its last good fetch, and no longer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const served: Record<string, ServedDocument> = { [CLAUDE]: CLAUDE_DOCUMENTS.claude.body };
  const f = await fixture(t, { fetchClientMetadataResource: metadataDocumentServer(served).fetch });
  let refreshToken = await claudeRefreshToken(f);
  const renew = async () => {
    const response = await f.refresh(CLAUDE, refreshToken);
    if (response.ok) refreshToken = (await response.clone().json() as { refresh_token: string }).refresh_token;
    return response;
  };

  served[CLAUDE] = { body: 'Too Many Requests', status: 429, headers: { 'content-type': 'text/plain' } };
  t.mock.timers.tick(6 * 60_000);
  assert.equal((await renew()).status, 200, 'a 429 from the document host is a failure to reach it');
  served[CLAUDE] = { body: 'Service Unavailable', status: 503, headers: { 'content-type': 'text/plain' } };
  t.mock.timers.tick(24 * 60 * 60_000 - 7 * 60_000);
  assert.equal((await renew()).status, 200, 'a minute short of a day after the last good fetch');
  t.mock.timers.tick(2 * 60_000);
  const refused = await renew();
  assert.equal(refused.status, 400, 'a minute past it');
  assert.deepEqual(await refused.json(), { error: 'invalid_client', error_description: 'Metadata document fetch returned HTTP 503' });

  served[CLAUDE] = CLAUDE_DOCUMENTS.claude.body;
  t.mock.timers.tick(2_000);
  assert.equal((await renew()).status, 200, 'a document that answers again restarts the day');
  served[CLAUDE] = () => { throw new TypeError('fetch failed'); };
  t.mock.timers.tick(24 * 60 * 60_000 - 60_000);
  assert.equal((await renew()).status, 200);
});

test('a spent fetch budget refuses a stored client unless its last fetch could not reach the document', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const served: Record<string, ServedDocument> = {
    [CLAUDE]: CLAUDE_DOCUMENTS.claude.body,
    [CLAUDE_CODE]: { body: CLAUDE_DOCUMENTS.claudeCode.body, headers: { 'cache-control': 'no-store' } },
  };
  const host = metadataDocumentServer(served);
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  let refreshToken = await claudeRefreshToken(f);
  const renew = async () => {
    const response = await f.refresh(CLAUDE, refreshToken);
    if (response.ok) refreshToken = (await response.clone().json() as { refresh_token: string }).refresh_token;
    return response;
  };
  const spendFetchBudget = async () => {
    // 30 fetches a minute per origin; served uncached, Claude Code's document is fetched on every sign-in.
    for (let attempt = 0; attempt <= 30; attempt++) {
      const response = await f.authorize(CLAUDE_CODE, 'http://localhost:53682/callback', { signedIn: false });
      if (response.status === 429) return;
      assert.equal(response.status, 302);
    }
    assert.fail('the budget was not spent');
  };
  const busy = { error: 'temporarily_unavailable', error_description: 'metadata fetch rate limit exceeded for client origin' };

  t.mock.timers.tick(6 * 60_000);
  await spendFetchBudget();
  const declined = await renew();
  assert.equal(declined.status, 429, 'nothing known against the document, but nothing fetched either');
  assert.deepEqual(await declined.json(), busy);

  t.mock.timers.tick(61_000);
  served[CLAUDE] = { body: 'Service Unavailable', status: 503, headers: { 'content-type': 'text/plain' } };
  assert.equal((await renew()).status, 200);
  t.mock.timers.tick(1_000);
  await spendFetchBudget();
  const fetched = host.requests.length;
  assert.equal((await renew()).status, 200, 'after a fetch that could not reach the document, a spent budget stands in for it');
  assert.equal(host.requests.length, fetched);

  t.mock.timers.tick(24 * 60 * 60_000);
  await spendFetchBudget();
  const stale = await renew();
  assert.equal(stale.status, 429, 'but only for a day after the last good fetch');
  assert.deepEqual(await stale.json(), busy);
});

test('first sign-ins by metadata document share the pending-client bound with dynamic registration', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const f = await fixture(t, { fetchClientMetadataResource: claudeHost().fetch, mcpRegistrationPolicy: { maxPendingClients: 1 } });
  const register = () => f.handler(new Request(`${ORIGIN}/api/auth/oauth2/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      application_type: 'native', client_name: 'Registered', grant_types: ['authorization_code'],
      redirect_uris: ['http://127.0.0.1:47321/callback'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  }));
  const claudeCode = () => f.authorize(CLAUDE_CODE, 'http://localhost:53682/callback', { signedIn: false });

  const claude = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  await f.approve(claude.headers.get('location')!);
  assert.ok((await register()).ok);
  const refused = await claudeCode();
  assert.equal(refused.status, 429, 'a registration fills the bound for a document');
  assert.deepEqual(await refused.json(), {
    error: 'temporarily_unavailable', error_description: 'Too many apps are waiting for sign-in approval. Try again later.',
  });

  t.mock.timers.tick(15 * 60_000 + 1_000);
  assert.equal((await claudeCode()).status, 302, 'past the consent window the oldest pending client makes room');
  const registration = await register();
  assert.equal(registration.status, 429, 'and a document fills it for a registration');
  assert.deepEqual(await registration.json(), { error: 'registration_quota_exceeded' });
  assert.equal((await f.authorize(CLAUDE, CLAUDE_CALLBACK)).status, 302, 'a client someone consented to is not pending');
  assert.deepEqual(f.clients().map((client) => client.clientId), [CLAUDE, CLAUDE_CODE]);
});

test('a first sign-in by metadata document passes the registration throttle; a stored client never does', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const host = claudeHost();
  const sources: Array<string | null> = [];
  let refuse = false;
  const f = await fixture(t, {
    fetchClientMetadataResource: host.fetch,
    async throttleRegistration(request) {
      sources.push(request.headers.get('cf-connecting-ip'));
      return refuse
        ? Response.json({ error: 'registration_rate_limited' }, { status: 429, headers: { 'retry-after': '120' } })
        : undefined;
    },
  });
  const first = await f.authorize(CLAUDE, CLAUDE_CALLBACK, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  const callback = await f.approve(first.headers.get('location')!);
  const exchanged = await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!);
  const { refresh_token: refreshToken } = await exchanged.json() as { refresh_token: string };
  assert.deepEqual(sources, ['203.0.113.7'], 'one throttle check, for the request that stores the client');

  refuse = true;
  const prune = t.mock.method(f.backend, 'prunePendingMcpOAuthClients');
  for (const signedIn of [false, true]) {
    t.mock.timers.tick(1_000);
    const refused = await f.authorize(CLAUDE_CODE, 'http://localhost:53682/callback', {
      signedIn, headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '120');
    assert.deepEqual(await refused.json(), {
      error: 'temporarily_unavailable', error_description: 'Too many new apps are signing in from here. Try again later.',
    });
  }
  assert.deepEqual(sources, ['203.0.113.7', '203.0.113.9', '203.0.113.9']);
  assert.equal(prune.mock.callCount(), 0, 'a throttled sign-in writes nothing');
  assert.ok(!host.requests.includes(CLAUDE_CODE), 'and fetches nothing');

  assert.equal((await f.authorize(CLAUDE, CLAUDE_CALLBACK)).status, 302);
  t.mock.timers.tick(6 * 60_000);
  assert.equal((await f.refresh(CLAUDE, refreshToken)).status, 200);
  assert.equal(sources.length, 3, 'a stored client is never throttled');
  assert.deepEqual(f.clients().map((client) => client.clientId), [CLAUDE]);

  const registration = await f.handler(new Request(`${ORIGIN}/api/auth/oauth2/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({
      application_type: 'native', client_name: 'Registered', grant_types: ['authorization_code'],
      redirect_uris: ['http://127.0.0.1:47321/callback'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  }));
  assert.equal(registration.status, 429, 'dynamic registration passes the same throttle');
  assert.deepEqual(await registration.json(), { error: 'registration_rate_limited' });
});

test('consent names the domain only for a client known by its metadata document', () => {
  const html = renderMcpConsentPage({
    clientName: 'Claude', clientHost: 'evil.example', scope: 'chickpea:workspace', oauthQuery: 'sig=test',
  });
  assert.ok(html.includes('<dt>App</dt><dd>Claude <span class="note">(name provided by the app)</span></dd><dt>Domain</dt><dd>evil.example</dd>'),
    'a lookalike name sits beside the host that served it');
  const registered = renderMcpConsentPage({ clientName: 'Codex', scope: 'chickpea:workspace', oauthQuery: 'sig=test' });
  assert.ok(!registered.includes('<dt>Domain</dt>'));
});
