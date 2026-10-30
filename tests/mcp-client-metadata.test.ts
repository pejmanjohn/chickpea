import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { Hono } from 'hono';

import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { createBetterAuthPublicHandler, type BetterAuthPublicHandlerInput } from '../src/auth/better-auth-routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import type { ClientMetadataFetch } from '../src/auth/mcp-client-metadata.ts';
import { mountMcpOAuthBrowserRoutes, renderMcpConsentPage } from '../src/auth/mcp-oauth-routes.ts';
import { CLAUDE_DOCUMENTS, metadataDocumentServer } from './helpers/client-metadata-documents.ts';

const ORIGIN = 'https://chickpea.example.test';
const RESOURCE = `${ORIGIN}/mcp`;
const CLAUDE = CLAUDE_DOCUMENTS.claude.url;
const CLAUDE_CODE = CLAUDE_DOCUMENTS.claudeCode.url;
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RENEWABLE_SCOPE = 'chickpea:workspace offline_access';

/** A valid document at `url` that copies Claude's name and redirect. */
const lookalike = (url: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ ...JSON.parse(CLAUDE_DOCUMENTS.claude.body), client_id: url, client_uri: undefined, ...fields });

async function fixture(t: TestContext, options: {
  fetchClientMetadataResource?: ClientMetadataFetch;
  mcpRegistrationPolicy?: BetterAuthPublicHandlerInput['mcpRegistrationPolicy'];
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
    ...environment, ...(options.mcpRegistrationPolicy ? { mcpRegistrationPolicy: options.mcpRegistrationPolicy } : {}),
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
  function authorize(clientId: string, redirectUri: string, { signedIn = true } = {}) {
    const query = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      scope: 'chickpea:workspace', state: 'client-state', resource: RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    return handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, { headers: signedIn ? { cookie } : {} }));
  }
  async function approve(consentLocation: string) {
    const consent = await handler(new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
      body: JSON.stringify({ accept: true, oauth_query: new URL(consentLocation, ORIGIN).search.slice(1) }),
    }));
    assert.equal(consent.status, 200, await consent.clone().text());
    return new URL((await consent.json() as { url: string }).url);
  }
  function exchange(clientId: string, redirectUri: string, code: string, codeVerifier = verifier) {
    return handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId, code, code_verifier: codeVerifier,
        redirect_uri: redirectUri, resource: RESOURCE,
      }),
    }));
  }
  const clients = () => (backend.database.prepare(
    'SELECT clientId, clientDiscoveryId, userId, clientSecret, tokenEndpointAuthMethod, name FROM oauthClient ORDER BY createdAt, clientId',
  ).all() as Record<string, unknown>[]).map((row) => ({ ...row }));
  return { backend, handler, browser, cookie, authorize, approve, exchange, clients };
}

const claudeHost = () => metadataDocumentServer({
  [CLAUDE]: CLAUDE_DOCUMENTS.claude.body,
  [CLAUDE_CODE]: CLAUDE_DOCUMENTS.claudeCode.body,
});

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

test('a metadata document URL must be public HTTPS before anything is fetched', async (t) => {
  const host = metadataDocumentServer({});
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const clientId of [
    'http://claude.ai/oauth/mcp-oauth-client-metadata',
    'https://127.0.0.1/client', 'https://[::1]/client', 'https://localhost/client',
    'https://10.0.0.5/client', 'https://169.254.169.254/latest/meta-data',
  ]) {
    const response = await f.authorize(clientId, CLAUDE_CALLBACK, { signedIn: false });
    assert.ok(response.status === 400 || response.headers.get('location')?.startsWith(`${ORIGIN}/api/auth/error?`), clientId);
    assert.notEqual(new URL(response.headers.get('location') ?? '/', ORIGIN).pathname, '/auth/mcp/login', clientId);
  }
  assert.deepEqual(host.requests, []);
  assert.deepEqual(f.clients(), []);
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

test('consent names the domain only for a client known by its metadata document', () => {
  const html = renderMcpConsentPage({
    clientName: 'Claude', clientHost: 'evil.example', scope: 'chickpea:workspace', oauthQuery: 'sig=test',
  });
  assert.ok(html.includes('<dt>App</dt><dd>Claude <span class="note">(name provided by the app)</span></dd><dt>Domain</dt><dd>evil.example</dd>'),
    'a lookalike name sits beside the host that served it');
  const registered = renderMcpConsentPage({ clientName: 'Codex', scope: 'chickpea:workspace', oauthQuery: 'sig=test' });
  assert.ok(!registered.includes('<dt>Domain</dt>'));
});
