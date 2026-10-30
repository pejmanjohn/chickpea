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

const PUBLIC_CLIENTS_ONLY = {
  error: 'invalid_client',
  error_description: 'metadata document must describe a public client: token_endpoint_auth_method "none", no jwks or jwks_uri',
};

const signingKeys = () => {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  return { keys: [{ ...jwk, alg: 'EdDSA', use: 'sig', kid: 'k1' }] };
};

/** A client assertion naming `clientId`, signed by no key it publishes. */
const clientAssertion = (clientId: string, jti: string) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {
    iss: clientId, sub: clientId, aud: `${ORIGIN}/api/auth/oauth2/token`, exp: Math.floor(Date.now() / 1_000) + 60, jti,
  };
  return `${part({ alg: 'EdDSA', kid: 'unknown' })}.${part(claims)}.AAAA`;
};

async function fixture(t: TestContext, options: {
  fetchClientMetadataResource?: ClientMetadataFetch;
  mcpRegistrationPolicy?: BetterAuthPublicHandlerInput['mcpRegistrationPolicy'];
  throttleRegistration?: BetterAuthPublicHandlerInput['throttleRegistration'];
} = {}) {
  const backend = new NodeBetterAuthBackend(':memory:');
  t.after(() => backend.close());
  let admission: BetterAuthAdmissionOperation | null = null;
  const environment = {
    backend, baseURL: ORIGIN, secret: randomBytes(32).toString('base64url'),
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
  function authorize(clientId: string, redirectUri: string, { signedIn = true, headers = {} as Record<string, string> } = {}) {
    const query = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      scope: 'chickpea:workspace', state: 'client-state', resource: RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    return handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, {
      headers: { ...headers, ...(signedIn ? { cookie } : {}) },
    }));
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

/** Claude's refresh token after a signed-in sign-in and consent. */
async function claudeSignIn(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
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

test('a metadata document is refused unless it names its own URL, lists the redirect, and comes back small JSON at once', async (t) => {
  const host = metadataDocumentServer({
    [CLAUDE]: CLAUDE_DOCUMENTS.claude.body,
    'https://evil.example/claims-claude': CLAUDE_DOCUMENTS.claude.body,
    'https://evil.example/oversize': lookalike('https://evil.example/oversize', { padding: 'x'.repeat(6_000) }),
    'https://evil.example/html': { body: '<!doctype html><title>Claude</title>', headers: { 'content-type': 'text/html' } },
    'https://evil.example/not-json': '{"client_id":',
    'https://evil.example/moved': { body: '', status: 302, headers: { location: CLAUDE } },
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const refusals: Array<[string, RegExp]> = [
    ['https://evil.example/claims-claude', /does not match the metadata document URL/],
    ['https://evil.example/oversize', /exceeds 5KB/],
    ['https://evil.example/html', /must be JSON/],
    ['https://evil.example/not-json', /not valid JSON/],
    ['https://evil.example/moved', /HTTP 302/],
  ];
  for (const [clientId, reason] of refusals) {
    for (const signedIn of [false, true]) {
      t.mock.timers.tick(1_000);
      const response = await f.authorize(clientId, CLAUDE_CALLBACK, { signedIn });
      assert.equal(response.status, 400, `${clientId} signed ${signedIn ? 'in' : 'out'}`);
      const body = await response.json() as { error: string; error_description: string };
      assert.equal(body.error, 'invalid_client', clientId);
      assert.match(body.error_description, reason, clientId);
    }
  }
  assert.deepEqual(host.requests, refusals.flatMap(([clientId]) => [clientId, clientId]),
    'one request per attempt; the redirect is not followed');

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
  const documents: Record<string, Record<string, unknown>> = {
    'https://evil.example/signed': { token_endpoint_auth_method: 'private_key_jwt', jwks: keys },
    'https://evil.example/signed-by-uri': { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://evil.example/jwks' },
    'https://evil.example/public-with-keys': { jwks: keys },
  };
  const host = metadataDocumentServer({
    ...Object.fromEntries(Object.entries(documents).map(([url, fields]) => [url, lookalike(url, fields)])),
    'https://evil.example/jwks': JSON.stringify(keys),
  });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const clientId of Object.keys(documents)) {
    for (const signedIn of [false, true]) {
      t.mock.timers.tick(1_000);
      const response = await f.authorize(clientId, CLAUDE_CALLBACK, { signedIn });
      assert.equal(response.status, 400, `${clientId} signed ${signedIn ? 'in' : 'out'}`);
      assert.deepEqual(await response.json(), PUBLIC_CLIENTS_ONLY, clientId);
    }
  }
  assert.deepEqual(f.clients(), [], 'a refused document leaves no client behind');
  assert.ok(!host.requests.includes('https://evil.example/jwks'));
});

test('a stored client whose document turns to key authentication is refused before any key is fetched', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const jwksUri = 'https://claude.ai/oauth/jwks';
  const served: Record<string, ServedDocument> = { [CLAUDE]: CLAUDE_DOCUMENTS.claude.body, [jwksUri]: JSON.stringify(signingKeys()) };
  const host = metadataDocumentServer(served);
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const authorization = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  const callback = await f.approve(authorization.headers.get('location')!);
  const exchanged = await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!);
  const { refresh_token: refreshToken } = await exchanged.json() as { refresh_token: string };

  served[CLAUDE] = lookalike(CLAUDE, { client_uri: 'https://claude.ai', token_endpoint_auth_method: 'private_key_jwt', jwks_uri: jwksUri });
  t.mock.timers.tick(6 * 60_000);
  const renewed = await f.refresh(CLAUDE, refreshToken);
  assert.equal(renewed.status, 400);
  assert.deepEqual(await renewed.json(), PUBLIC_CLIENTS_ONLY);
  for (let attempt = 0; attempt < 3; attempt++) {
    const asserted = await f.token({
      grant_type: 'authorization_code', code: 'unused', code_verifier: 'v'.repeat(43), redirect_uri: CLAUDE_CALLBACK,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion(CLAUDE, `attempt-${attempt}`),
    });
    assert.equal(asserted.status, 400);
    assert.deepEqual(await asserted.json(), PUBLIC_CLIENTS_ONLY);
  }
  assert.ok(!host.requests.includes(jwksUri), 'no key is fetched for a client Chickpea refuses');
});

test('a metadata document URL must be public HTTPS before anything is fetched or pruned', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const host = metadataDocumentServer({});
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const prune = t.mock.method(f.backend, 'prunePendingMcpOAuthClients');
  for (const clientId of [
    'http://claude.ai/oauth/mcp-oauth-client-metadata',
    'https://127.0.0.1/client', 'https://[::1]/client', 'https://localhost/client',
    'https://10.0.0.5/client', 'https://169.254.169.254/latest/meta-data',
    'https://claude.ai', 'https://claude.ai/oauth/../client',
  ]) {
    for (const signedIn of [false, true]) {
      t.mock.timers.tick(1_000);
      const response = await f.authorize(clientId, CLAUDE_CALLBACK, { signedIn });
      assert.ok(response.status === 400 || response.headers.get('location')?.startsWith(`${ORIGIN}/api/auth/error?`), clientId);
      assert.ok(!['/auth/mcp/login', '/auth/mcp/consent'].includes(new URL(response.headers.get('location') ?? '/', ORIGIN).pathname), clientId);
    }
  }
  assert.deepEqual(host.requests, []);
  assert.equal(prune.mock.callCount(), 0, 'a URL refused unfetched costs no pending-client write');
  assert.deepEqual(f.clients(), []);
});

test('a client ID refused unfetched spends none of the fetch budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const host = claudeHost();
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const refreshToken = await claudeSignIn(f);
  t.mock.timers.tick(6 * 60_000);
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await f.authorize(`https://10.0.0.${1 + attempt % 4}/client-${attempt}`, CLAUDE_CALLBACK, { signedIn: false });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'invalid_client', error_description: 'client_id URL must not target a private or reserved address',
    });
  }
  const fetched = host.requests.length;
  assert.equal((await f.refresh(CLAUDE, refreshToken)).status, 200);
  assert.equal((await f.authorize(CLAUDE_CODE, 'http://localhost:53682/callback', { signedIn: false })).status, 302);
  assert.deepEqual(host.requests.slice(fetched), [CLAUDE, CLAUDE_CODE], 'each fetches its document: the budget is untouched');
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
  let refreshToken = await claudeSignIn(f);
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
  const served: Record<string, ServedDocument> = { [CLAUDE]: CLAUDE_DOCUMENTS.claude.body };
  const host = metadataDocumentServer(served);
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  let refreshToken = await claudeSignIn(f);
  const renew = async () => {
    const response = await f.refresh(CLAUDE, refreshToken);
    if (response.ok) refreshToken = (await response.clone().json() as { refresh_token: string }).refresh_token;
    return response;
  };
  let strangers = 0;
  const spendFetchBudget = async () => {
    // 120 fetches a minute per isolate and 30 per origin, so four origins of unknown documents.
    for (let attempt = 0; attempt <= 120; attempt++, strangers++) {
      const response = await f.authorize(`https://s${strangers % 4}.evil.example/client-${strangers}`, CLAUDE_CALLBACK, { signedIn: false });
      if (response.status === 429) return;
      assert.equal(response.status, 400);
    }
    assert.fail('the budget was not spent');
  };
  const busy = { error: 'temporarily_unavailable', error_description: 'global metadata fetch rate limit exceeded' };

  t.mock.timers.tick(6 * 60_000);
  await spendFetchBudget();
  const declined = await renew();
  assert.equal(declined.status, 429, 'nothing known against the document, but nothing fetched either');
  assert.deepEqual(await declined.json(), busy);

  t.mock.timers.tick(61_000);
  served[CLAUDE] = { body: 'Service Unavailable', status: 503, headers: { 'content-type': 'text/plain' } };
  assert.equal((await renew()).status, 200);
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

test('the default transport is the MCP egress guard: an internal host is refused without a request', async (t) => {
  const internal = 'https://chickpea.internal/client';
  const platformFetch = t.mock.method(globalThis, 'fetch', async () =>
    new Response(lookalike(internal), { headers: { 'content-type': 'application/json' } }));
  const f = await fixture(t);
  const response = await f.authorize(internal, CLAUDE_CALLBACK, { signedIn: false });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error_description: string }).error_description, /Failed to fetch metadata document/);
  assert.equal(platformFetch.mock.callCount(), 0, 'Better Auth alone would have fetched this host');
  assert.deepEqual(f.clients(), []);
});

test('first sign-ins by metadata document share the pending-client bound with dynamic registration', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const strangers = ['a', 'b', 'c'].map((name) => `https://evil.example/${name}`);
  const host = metadataDocumentServer({
    [CLAUDE]: CLAUDE_DOCUMENTS.claude.body,
    ...Object.fromEntries(strangers.map((url) => [url, lookalike(url)])),
  });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch, mcpRegistrationPolicy: { maxPendingClients: 2 } });

  const claude = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  await f.approve(claude.headers.get('location')!);
  for (const url of strangers.slice(0, 2)) {
    t.mock.timers.tick(1_000);
    assert.equal((await f.authorize(url, CLAUDE_CALLBACK, { signedIn: false })).status, 302, url);
  }
  const refused = await f.authorize(strangers[2]!, CLAUDE_CALLBACK, { signedIn: false });
  assert.equal(refused.status, 429);
  assert.equal((await refused.json() as { error: string }).error, 'temporarily_unavailable');
  const registration = await f.handler(new Request(`${ORIGIN}/api/auth/oauth2/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      application_type: 'native', client_name: 'Registered', grant_types: ['authorization_code'],
      redirect_uris: ['http://127.0.0.1:47321/callback'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  }));
  assert.equal(registration.status, 429, 'both doors fill one bound');
  assert.equal((await f.authorize(CLAUDE, CLAUDE_CALLBACK)).status, 302, 'a client someone consented to is not pending');

  t.mock.timers.tick(15 * 60_000);
  assert.equal((await f.authorize(strangers[2]!, CLAUDE_CALLBACK, { signedIn: false })).status, 302,
    'past the consent window the oldest pending client makes room');
  assert.deepEqual(f.clients().map((client) => client.clientId), [CLAUDE, strangers[1], strangers[2]]);
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
