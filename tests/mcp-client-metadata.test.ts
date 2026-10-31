import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { makeSignature } from 'better-auth/crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { Hono } from 'hono';

import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { createBetterAuthPublicHandler, type BetterAuthPublicHandlerInput } from '../src/auth/better-auth-routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import type { ClientMetadataFetch } from '../src/auth/mcp-client-metadata.ts';
import { mountMcpOAuthBrowserRoutes, renderMcpConsentPage } from '../src/auth/mcp-oauth-routes.ts';
import {
  CHATGPT_DOCUMENT, CLAUDE_DOCUMENTS, CODEX_DOCUMENT, CURSOR_DOCUMENT, PUBLIC_CLIENT_DOCUMENTS, metadataDocumentServer, type ServedDocument,
} from './helpers/client-metadata-documents.ts';

const ORIGIN = 'https://chickpea.example.test';
const RESOURCE = `${ORIGIN}/mcp`;
const CLAUDE = CLAUDE_DOCUMENTS.claude.url;
const CLAUDE_CODE = CLAUDE_DOCUMENTS.claudeCode.url;
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RENEWABLE_SCOPE = 'chickpea:workspace offline_access';
/** An app no list names, on a host of its own. */
const STRANGER = 'https://apps.example.org/oauth/client.json';
const STRANGER_CALLBACK = 'https://apps.example.org/callback';

/** A valid document at `url` that copies Claude's name and redirect. */
const lookalike = (url: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ ...JSON.parse(CLAUDE_DOCUMENTS.claude.body), client_id: url, client_uri: undefined, ...fields });

const strangerDocument = JSON.stringify({
  client_id: STRANGER, client_name: 'Example App', redirect_uris: [STRANGER_CALLBACK],
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
});

/** A public client's document at `url`, redirecting to `/callback` on its own host. */
const documentAt = (url: string, fields: Record<string, unknown> = {}) => JSON.stringify({
  ...JSON.parse(strangerDocument), client_id: url, redirect_uris: [`${new URL(url).origin}/callback`], ...fields,
});

const OWN_HOST_REDIRECTS_ONLY = {
  error: 'invalid_client',
  error_description: 'metadata document redirect_uris must be on the client ID\'s host or a subdomain of it, or on a loopback host',
};

/** Every public client's document this suite serves, each with a redirect its app signs in on. */
const PUBLIC_CLIENTS: ReadonlyArray<{ url: string; served: string | { body: string; headers: Record<string, string> }; redirect: string }> = [
  { url: CLAUDE, served: CLAUDE_DOCUMENTS.claude.body, redirect: CLAUDE_CALLBACK },
  { url: CLAUDE_CODE, served: CLAUDE_DOCUMENTS.claudeCode.body, redirect: 'http://localhost:53682/callback' },
  // As Codex CLI 0.160.1 asks: a port of its own on a redirect its document lists without one.
  { url: CODEX_DOCUMENT.url, served: CODEX_DOCUMENT.body, redirect: 'http://127.0.0.1:52247/callback' },
  ...Object.values(PUBLIC_CLIENT_DOCUMENTS),
  { url: STRANGER, served: strangerDocument, redirect: STRANGER_CALLBACK },
];

/** A document client's row as another deployment, or an earlier build of this one, stored it. */
const storeDocumentClient = (backend: NodeBetterAuthBackend, clientId: string) => backend.database.prepare(
  `INSERT INTO oauthClient (id, clientId, clientDiscoveryId, redirectUris, tokenEndpointAuthMethod, name, createdAt, updatedAt)
   VALUES (?, ?, 'cimd', ?, 'none', 'Claude', ?, ?)`,
).run(randomBytes(8).toString('hex'), clientId, JSON.stringify([CLAUDE_CALLBACK]), Date.now(), Date.now());

const NATIVE_APPS_LOOPBACK_ONLY = {
  error: 'invalid_request',
  error_description: 'a native app signs in only through an HTTP redirect_uri on a loopback host (127.0.0.1, localhost or [::1], any port), not a web page that relays the code',
};

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
  /** Another member of the fixture's workspace, signed in; returns their session cookie. */
  async function signInMember(slackUserId: string) {
    const member = await auth.chickpea.reconcileSlackIdentity({
      slackTeamId: 'T12345678', slackUserId, displayName: slackUserId, organization: { name: 'Fixture', slug: 'fixture' },
    });
    admission = {
      operationId: slackUserId, status: 'active', chickpeaRole: 'member', slackTeamId: 'T12345678', slackUserId,
      betterAuthUserId: member.userId, betterAuthOrganizationId: member.organizationId, betterAuthMembershipId: member.membershipId,
    };
    const issued = await auth.chickpea.issueSession(slackUserId, new Request(`${ORIGIN}/oauth/finalize`, {
      method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    }));
    return issued.headers.get('set-cookie')!.split(';', 1)[0]!;
  }

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
  async function approve(consentLocation: string, as = cookie) {
    const consent = await handler(new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: as, origin: ORIGIN },
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
  return {
    backend, handler, browser, cookie, secret: environment.secret, userId: person.userId,
    signInMember, authorize, approve, token, exchange, refresh, clients,
  };
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

test('without hosted shared auth no metadata document signs a client in: each document URL is an unknown client, never fetched', async (t) => {
  const host = metadataDocumentServer(Object.fromEntries(PUBLIC_CLIENTS.map(({ url, served }) => [url, served])));
  const f = await fixture(t, { clientMetadataDocuments: false, fetchClientMetadataResource: host.fetch });
  storeDocumentClient(f.backend, CLAUDE);
  for (const path of ['/.well-known/oauth-authorization-server/api/auth', '/api/auth/.well-known/oauth-authorization-server']) {
    const metadata = await (await f.handler(new Request(`${ORIGIN}${path}`))).json() as Record<string, unknown>;
    assert.equal(metadata.client_id_metadata_document_supported, undefined, path);
  }
  for (const { url, redirect } of PUBLIC_CLIENTS) {
    for (const signedIn of [false, true]) {
      const response = await f.authorize(url, redirect, { signedIn });
      const location = new URL(response.headers.get('location') ?? '/', ORIGIN);
      assert.equal(location.searchParams.get('error'), 'invalid_client', `${url} signed ${signedIn ? 'in' : 'out'}`);
    }
  }
  assert.deepEqual(host.requests, []);
  assert.deepEqual(f.clients().map((client) => client.clientId), [CLAUDE], 'a stored document client stays unknown');
});

test('a client ID that is not a public HTTPS document URL is an unknown client, never throttled, fetched or stored', async (t) => {
  const refused = [
    'http://apps.example.org/oauth/client.json',
    'https://localhost/client',
    'https://127.0.0.1/client',
    'https://[::1]/client',
    'https://10.0.0.5/client',
    'https://169.254.169.254/latest/meta-data',
    // A public address names no one the person could recognize on the consent page.
    'https://8.8.8.8/client',
    'https://[2606:4700:4700::1111]/client',
    'https://app:secret@apps.example.org/oauth/client.json',
    'https://apps.example.org/oauth/client.json#app',
    'https://apps.example.org',
    'https://apps.example.org?client=app',
    'https://apps.example.org/oauth/../client.json',
    'https://chickpea.internal/client',
    'https://printer.local/client',
    'https://intranet/client',
    // Chickpea's own origin, which would fetch itself.
    `${ORIGIN}/api/auth/oauth2/authorize?client_id=x`,
    // One document, one client ID: only the form URL parsing writes.
    'https://APPS.example.org/oauth/client.json',
    'https://apps.example.org:443/oauth/client.json',
    'https://apps.example.org/oauth/client\n.json',
    'https://apps.example.org./oauth/client.json',
  ];
  const host = metadataDocumentServer({
    [STRANGER]: strangerDocument,
    ...Object.fromEntries(refused.map((url) => [url, lookalike(url)])),
  });
  let throttled = 0;
  const f = await fixture(t, {
    fetchClientMetadataResource: host.fetch,
    async throttleRegistration() { throttled += 1; return undefined; },
  });
  const prune = t.mock.method(f.backend, 'prunePendingMcpOAuthClients');
  const stored = 'https://10.0.0.9/stored-client';
  storeDocumentClient(f.backend, stored);
  for (const clientId of [...refused, stored]) {
    for (const signedIn of [false, true]) {
      const response = await f.authorize(clientId, CLAUDE_CALLBACK, { signedIn });
      const location = new URL(response.headers.get('location') ?? '/', ORIGIN);
      assert.equal(location.searchParams.get('error'), 'invalid_client', `${clientId} signed ${signedIn ? 'in' : 'out'}`);
    }
  }
  assert.deepEqual(host.requests, []);
  assert.equal(throttled, 0, 'a refused client ID spends none of its source\'s registration limit');
  assert.equal(prune.mock.callCount(), 0, 'or a pending-client write');
  assert.deepEqual(f.clients().map((client) => client.clientId), [stored]);

  assert.equal((await f.authorize(STRANGER, STRANGER_CALLBACK, { signedIn: false })).status, 302);
  assert.deepEqual(host.requests, [STRANGER]);
  assert.equal(throttled, 1);
});

test('a client ID refused unfetched spends none of the fetch budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const host = claudeHost();
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const refreshToken = await claudeRefreshToken(f);
  t.mock.timers.tick(6 * 60_000);
  // The plugin allows 120 fetches a minute per isolate and 30 per origin.
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await f.authorize(`https://10.0.0.${1 + attempt % 4}/client-${attempt}`, CLAUDE_CALLBACK, { signedIn: false });
    assert.equal(new URL(response.headers.get('location') ?? '/', ORIGIN).searchParams.get('error'), 'invalid_client');
  }
  const fetched = host.requests.length;
  assert.equal((await f.refresh(CLAUDE, refreshToken)).status, 200);
  assert.equal((await f.authorize(CLAUDE_CODE, 'http://localhost:53682/callback', { signedIn: false })).status, 302);
  assert.deepEqual(host.requests.slice(fetched), [CLAUDE, CLAUDE_CODE], 'each fetches its document: the budget is untouched');
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

test('any public client signs in by its own metadata document: consent naming its host every time, PKCE, renewal', async (t) => {
  const host = metadataDocumentServer(Object.fromEntries(PUBLIC_CLIENTS.map(({ url, served }) => [url, served])));
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const { url, served, redirect } of PUBLIC_CLIENTS) {
    const { client_name: name } = JSON.parse(typeof served === 'string' ? served : served.body) as { client_name: string };
    const consentFor = async () => {
      const authorization = await f.authorize(url, redirect);
      assert.equal(authorization.status, 302, `${url}: ${await authorization.clone().text()}`);
      const consent = new URL(authorization.headers.get('location')!, ORIGIN);
      assert.equal(consent.pathname, '/auth/mcp/consent', `${url}: ${consent}`);
      return consent;
    };
    const consent = await consentFor();
    assert.equal(consent.searchParams.get('scope'), RENEWABLE_SCOPE, url);
    const page = await (await f.browser.request(`${ORIGIN}${consent.pathname}${consent.search}`, {
      headers: { cookie: f.cookie },
    })).text();
    assert.ok(page.includes(
      `<dt>App</dt><dd>${name} <span class="note">(name provided by the app)</span></dd><dt>Domain</dt><dd>${new URL(url).host}</dd>`,
    ), url);
    const callback = await f.approve(consent.toString());
    assert.equal(`${callback.origin}${callback.pathname}`, `${new URL(redirect).origin}${new URL(redirect).pathname}`, url);
    const exchanged = await f.exchange(url, redirect, callback.searchParams.get('code')!);
    assert.equal(exchanged.status, 200, `${url}: ${await exchanged.clone().text()}`);
    const tokens = await exchanged.json() as { refresh_token: string; scope: string };
    assert.equal(tokens.scope, RENEWABLE_SCOPE, url);
    assert.equal((await f.refresh(url, tokens.refresh_token)).status, 200, url);
    await consentFor();
  }
  const byClientId = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a.clientId).localeCompare(String(b.clientId));
  assert.deepEqual(
    f.clients().map(({ name: _, ...client }) => client).sort(byClientId),
    PUBLIC_CLIENTS.map(({ url }) => ({ clientId: url, clientDiscoveryId: 'cimd', userId: null, clientSecret: null, tokenEndpointAuthMethod: 'none' }))
      .sort(byClientId),
    'one ownerless, secretless row per app',
  );
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

test('a metadata-document client asks for consent at every sign-in, whatever its redirect', async (t) => {
  const vscode = PUBLIC_CLIENT_DOCUMENTS.vscode;
  const host = metadataDocumentServer({
    [CLAUDE]: CLAUDE_DOCUMENTS.claude.body,
    [CLAUDE_CODE]: CLAUDE_DOCUMENTS.claudeCode.body,
    [vscode.url]: vscode.served,
  });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const [clientId, redirect] of [
    [CLAUDE, CLAUDE_CALLBACK],
    [vscode.url, vscode.redirect],
    [CLAUDE_CODE, 'http://localhost:53682/callback'],
  ] as const) {
    const first = await f.authorize(clientId, redirect);
    assert.ok((await f.approve(first.headers.get('location')!)).searchParams.get('code'));
    const again = new URL((await f.authorize(clientId, redirect)).headers.get('location')!, ORIGIN);
    assert.equal(`${again.origin}${again.pathname}`, `${ORIGIN}/auth/mcp/consent`, `${redirect} is asked again after an approval`);
    const silent = new URL((await f.authorize(clientId, redirect, { prompt: 'none' })).headers.get('location') ?? '/', ORIGIN);
    assert.ok(silent.searchParams.get('error'), `${redirect} gets an error for prompt=none`);
    assert.equal(silent.searchParams.get('code'), null, `${redirect} gets no code for prompt=none`);
  }

  // RFC 8252 8.6: any local app can claim Claude Code's published client ID and a port of its own.
  const otherPort = await f.authorize(CLAUDE_CODE, 'http://localhost:4444/callback');
  assert.equal(otherPort.status, 302);
  const consent = new URL(otherPort.headers.get('location')!, ORIGIN);
  assert.equal(consent.pathname, '/auth/mcp/consent');
  const callback = await f.approve(consent.toString());
  assert.equal(`${callback.origin}${callback.pathname}`, 'http://localhost:4444/callback');
  assert.ok(callback.searchParams.get('code'));
  const posted = await f.authorize(CLAUDE_CODE, 'http://localhost:4444/callback', { post: true, headers: { origin: ORIGIN } });
  assert.equal(posted.status, 404, `authorize by POST skips the consent rule: ${posted.headers.get('location')}`);
});

test('a native app signs in by its document only on loopback: VS Code\'s port works, its vscode.dev relay is refused', async (t) => {
  const { vscode, vscodeInsiders } = PUBLIC_CLIENT_DOCUMENTS;
  const host = metadataDocumentServer({ [vscode.url]: vscode.served, [vscodeInsiders.url]: vscodeInsiders.served });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const [document, relay] of [
    [vscode, 'https://vscode.dev/redirect'],
    [vscodeInsiders, 'https://insiders.vscode.dev/redirect'],
  ] as const) {
    // Signed out, the first lookup stores the client; signed in, the stored client answers.
    for (const signedIn of [false, true]) {
      const refused = await f.authorize(document.url, relay, { signedIn });
      assert.equal(refused.status, 400, `${relay} signed ${signedIn ? 'in' : 'out'}`);
      assert.equal(refused.headers.get('location'), null, 'the relay never receives the browser');
      assert.deepEqual(await refused.json(), NATIVE_APPS_LOOPBACK_ONLY, relay);
    }
    // The port VS Code asks for first, and a port of its own when that one is taken.
    for (const loopback of [document.redirect, 'http://127.0.0.1:50116/']) {
      const consent = new URL((await f.authorize(document.url, loopback)).headers.get('location')!, ORIGIN);
      assert.equal(consent.pathname, '/auth/mcp/consent', loopback);
      const callback = await f.approve(consent.toString());
      assert.equal(`${callback.origin}${callback.pathname}`, loopback);
      const exchanged = await f.exchange(document.url, loopback, callback.searchParams.get('code')!);
      assert.equal(exchanged.status, 200, `${loopback}: ${await exchanged.clone().text()}`);
    }
  }
  assert.deepEqual(f.clients().map((client) => client.clientId).sort(), [vscodeInsiders.url, vscode.url].sort(),
    'a refused redirect leaves the document\'s client in place');
});

/** `signed`, a consent page's query, with `changes` applied and signed again as Better Auth signs it. */
async function resigned(signed: URLSearchParams, changes: Record<string, string>, secret: string): Promise<string> {
  const params = new URLSearchParams(signed);
  params.delete('sig');
  for (const [name, value] of Object.entries(changes)) params.set(name, value);
  const canonical = new URLSearchParams([...params.entries()].sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  params.set('sig', await makeSignature(canonical.toString(), secret));
  return params.toString();
}

test('a signed query that names a native app\'s relay gets no code at consent or continue', async (t) => {
  const { vscode } = PUBLIC_CLIENT_DOCUMENTS;
  const f = await fixture(t, { fetchClientMetadataResource: metadataDocumentServer({ [vscode.url]: vscode.served }).fetch });
  const consent = new URL((await f.authorize(vscode.url, vscode.redirect)).headers.get('location')!, ORIGIN);
  const relay = await resigned(consent.searchParams, { redirect_uri: 'https://vscode.dev/redirect' }, f.secret);
  for (const [path, body] of [
    ['/api/auth/oauth2/consent', { accept: true, oauth_query: relay }],
    ['/api/auth/oauth2/continue', { postLogin: true, oauth_query: relay }],
  ] as const) {
    const response = await f.handler(new Request(`${ORIGIN}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: f.cookie, origin: ORIGIN }, body: JSON.stringify(body),
    }));
    const text = await response.text();
    assert.equal(response.status, 400, `${path}: ${text}`);
    assert.deepEqual(JSON.parse(text), NATIVE_APPS_LOOPBACK_ONLY, path);
  }
  const loopback = await resigned(consent.searchParams, { redirect_uri: 'http://127.0.0.1:50117/' }, f.secret);
  const callback = await f.approve(`/auth/mcp/consent?${loopback}`);
  assert.equal(`${callback.origin}${callback.pathname}`, 'http://127.0.0.1:50117/', 'the same signing on loopback gets a code');
  assert.ok(callback.searchParams.get('code'));
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

test('ChatGPT\'s published document, and any confidential stranger, is refused and leaves no client behind', async (t) => {
  const keys = signingKeys();
  const chatgptKeys = 'https://chatgpt.com/oauth/jwks.json';
  const confidential = 'https://apps.example.org/oauth/confidential.json';
  const host = metadataDocumentServer({
    [CHATGPT_DOCUMENT.url]: CHATGPT_DOCUMENT.body,
    [chatgptKeys]: JSON.stringify(keys),
    [confidential]: JSON.stringify({
      ...JSON.parse(strangerDocument), client_id: confidential, token_endpoint_auth_method: 'private_key_jwt', jwks: keys,
    }),
  });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const [clientId, redirect] of [
    [CHATGPT_DOCUMENT.url, 'https://chatgpt.com/connector_platform_oauth_redirect'],
    [confidential, STRANGER_CALLBACK],
  ] as const) {
    for (const signedIn of [false, true]) {
      const response = await f.authorize(clientId, redirect, { signedIn });
      assert.equal(response.status, 400, `${clientId} signed ${signedIn ? 'in' : 'out'}`);
      assert.deepEqual(await response.json(), PUBLIC_CLIENTS_ONLY, clientId);
    }
  }
  assert.ok(!host.requests.includes(chatgptKeys), 'no key is fetched for a client Chickpea refuses');
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

test('a metadata document may redirect only to its own host, a subdomain of it, or loopback', async (t) => {
  const elsewhere = 'https://apps.example.org/oauth/elsewhere.json';
  const parent = 'https://apps.example.org/oauth/parent.json';
  const subdomain = 'https://apps.example.org/oauth/subdomain.json';
  const host = metadataDocumentServer({
    [CURSOR_DOCUMENT.url]: CURSOR_DOCUMENT.body,
    [elsewhere]: documentAt(elsewhere, { redirect_uris: ['https://elsewhere.example.net/callback'] }),
    [parent]: documentAt(parent, { redirect_uris: ['https://example.org/callback'] }),
    [subdomain]: documentAt(subdomain, { redirect_uris: ['https://login.apps.example.org/callback', 'http://127.0.0.1/callback'] }),
  });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  for (const [clientId, redirect] of [
    // Cursor lists a redirect on grok.com beside its own.
    [CURSOR_DOCUMENT.url, 'https://www.cursor.com/agents/mcp/oauth/callback'],
    [elsewhere, 'https://elsewhere.example.net/callback'],
    [parent, 'https://example.org/callback'],
  ] as const) {
    for (const signedIn of [false, true]) {
      const response = await f.authorize(clientId, redirect, { signedIn });
      assert.equal(response.status, 400, `${clientId} signed ${signedIn ? 'in' : 'out'}`);
      assert.deepEqual(await response.json(), OWN_HOST_REDIRECTS_ONLY, clientId);
    }
  }
  assert.deepEqual(f.clients(), [], 'a refused document leaves no client behind');

  for (const redirect of ['https://login.apps.example.org/callback', 'http://127.0.0.1:50115/callback']) {
    const consent = new URL((await f.authorize(subdomain, redirect)).headers.get('location')!, ORIGIN);
    assert.equal(consent.pathname, '/auth/mcp/consent', redirect);
    const callback = await f.approve(consent.toString());
    assert.equal(`${callback.origin}${callback.pathname}`, redirect);
  }
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

/** Signs in by each URL in turn, signed out, until the plugin's fetch budget refuses one. */
async function spendFetchBudget(f: Awaited<ReturnType<typeof fixture>>, urls: readonly string[]) {
  // 120 fetches a minute per isolate and 30 per origin.
  for (let attempt = 0; attempt <= 120; attempt++) {
    const url = urls[attempt % urls.length]!;
    const response = await f.authorize(url, `${new URL(url).origin}/callback`, { signedIn: false });
    if (response.status === 429) return;
    assert.equal(response.status, 302, url);
  }
  assert.fail('the budget was not spent');
}

/** Four origins whose documents no one consented to, served uncached so each sign-in fetches again. */
const UNCACHED_STRANGERS = [0, 1, 2, 3].map((n) => `https://s${n}.example.org/oauth/client.json`);
const uncachedStrangers = () => Object.fromEntries(UNCACHED_STRANGERS.map((url) =>
  [url, { body: documentAt(url), headers: { 'cache-control': 'no-store' } }]));
const BUSY = { error: 'temporarily_unavailable', error_description: 'global metadata fetch rate limit exceeded' };

test('while strangers keep the fetch budget spent, a consented client stands in for an hour after its document last answered', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const host = metadataDocumentServer({ [CLAUDE]: CLAUDE_DOCUMENTS.claude.body, ...uncachedStrangers() });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  let refreshToken = await claudeRefreshToken(f);
  const renew = async () => {
    const response = await f.refresh(CLAUDE, refreshToken);
    if (response.ok) refreshToken = (await response.clone().json() as { refresh_token: string }).refresh_token;
    return response;
  };

  t.mock.timers.tick(59 * 60_000);
  await spendFetchBudget(f, UNCACHED_STRANGERS);
  const fetched = host.requests.length;
  assert.equal((await renew()).status, 200, 'at 59 minutes the stored client stands in for its document');
  assert.equal(host.requests.length, fetched);

  t.mock.timers.tick(2 * 60_000);
  await spendFetchBudget(f, UNCACHED_STRANGERS);
  const late = await renew();
  assert.equal(late.status, 429, 'at 61 minutes it is refused');
  assert.deepEqual(await late.json(), BUSY);
});

test('on a spent fetch budget a stored client stands in only for a person who consented to it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const host = metadataDocumentServer({ [CLAUDE]: CLAUDE_DOCUMENTS.claude.body, ...uncachedStrangers() });
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  let refreshToken = await claudeRefreshToken(f);
  const renew = async () => {
    const response = await f.refresh(CLAUDE, refreshToken);
    if (response.ok) refreshToken = (await response.clone().json() as { refresh_token: string }).refresh_token;
    return response;
  };
  const consenting = await f.signInMember('U22222222');
  await f.approve((await f.authorize(CLAUDE, CLAUDE_CALLBACK, { signedIn: false, headers: { cookie: consenting } })).headers.get('location')!, consenting);
  const newcomer = await f.signInMember('U33333333');
  const signIn = (cookie: string) => f.authorize(CLAUDE, CLAUDE_CALLBACK, { signedIn: false, headers: { cookie } });

  t.mock.timers.tick(6 * 60_000);
  await spendFetchBudget(f, UNCACHED_STRANGERS);
  const consent = await signIn(consenting);
  assert.equal(consent.status, 302, 'a signed-in person who consented gets the stored client');
  const callback = await f.approve(consent.headers.get('location')!, consenting);
  const exchanged = await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!);
  assert.equal(exchanged.status, 200, 'and so does the code they were given');
  const refused = await signIn(newcomer);
  assert.equal(refused.status, 429, 'one who never consented does not, though others have');
  assert.deepEqual(await refused.json(), BUSY);
  const signedOut = await f.authorize(CLAUDE, CLAUDE_CALLBACK, { signedIn: false });
  assert.equal(signedOut.status, 429, 'nor does a request for no known person');

  assert.equal((await renew()).status, 200, 'the refresh token\'s owner consented');
  f.backend.database.prepare('DELETE FROM oauthConsent WHERE userId = ?').run(f.userId);
  const orphaned = await renew();
  assert.equal(orphaned.status, 429, 'without the owner\'s own consent, another person\'s does not count');
  assert.deepEqual(await orphaned.json(), BUSY);
});

test('a client its document last refused never stands in, on a spent budget or an unreachable host', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const served: Record<string, ServedDocument> = { [CLAUDE]: CLAUDE_DOCUMENTS.claude.body, ...uncachedStrangers() };
  const f = await fixture(t, { fetchClientMetadataResource: metadataDocumentServer(served).fetch });
  let refreshToken = await claudeRefreshToken(f);
  const renew = async () => {
    const response = await f.refresh(CLAUDE, refreshToken);
    if (response.ok) refreshToken = (await response.clone().json() as { refresh_token: string }).refresh_token;
    return response;
  };

  served[CLAUDE] = { body: 'Not Found', status: 404, headers: { 'content-type': 'text/plain' } };
  t.mock.timers.tick(6 * 60_000);
  assert.equal((await renew()).status, 400, 'the document refuses the client');
  t.mock.timers.tick(2_000);
  await spendFetchBudget(f, UNCACHED_STRANGERS);
  const spent = await renew();
  assert.equal(spent.status, 429, 'a spent budget does not bring it back for a person who consented');
  assert.deepEqual(await spent.json(), BUSY);

  t.mock.timers.tick(61_000);
  served[CLAUDE] = { body: 'Service Unavailable', status: 503, headers: { 'content-type': 'text/plain' } };
  const dark = await renew();
  assert.equal(dark.status, 400, 'nor does its host going dark');
  assert.deepEqual(await dark.json(), { error: 'invalid_client', error_description: 'Metadata document fetch returned HTTP 503' });

  t.mock.timers.tick(2_000);
  served[CLAUDE] = CLAUDE_DOCUMENTS.claude.body;
  assert.equal((await renew()).status, 200, 'a document that answers again restores it');
});

test('a lookup that fails for a reason Chickpea cannot read lets nothing stand in until a fetch succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const f = await fixture(t, { fetchClientMetadataResource: claudeHost().fetch });
  let refreshToken = await claudeRefreshToken(f);
  const renew = async () => {
    const response = await f.refresh(CLAUDE, refreshToken);
    if (response.ok) refreshToken = (await response.clone().json() as { refresh_token: string }).refresh_token;
    return response;
  };

  t.mock.timers.tick(6 * 60_000);
  f.backend.database.exec("CREATE TRIGGER storage_fails BEFORE UPDATE ON oauthClient BEGIN SELECT RAISE(ABORT, 'storage failed'); END;");
  assert.notEqual((await renew()).status, 200, 'storing the fetched document fails');
  f.backend.database.exec('DROP TRIGGER storage_fails');
  t.mock.timers.tick(100);
  const paused = await renew();
  assert.equal(paused.status, 429, 'the plugin\'s pause that follows does not stand in for a person who consented');
  t.mock.timers.tick(2_000);
  assert.equal((await renew()).status, 200, 'a fetch that succeeds restores it');
});

test('a spent fetch budget refuses a client no one consented to unless its last fetch could not reach its document', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const served: Record<string, ServedDocument> = { [STRANGER]: strangerDocument, ...uncachedStrangers() };
  const host = metadataDocumentServer(served);
  const f = await fixture(t, { fetchClientMetadataResource: host.fetch });
  const signIn = () => f.authorize(STRANGER, STRANGER_CALLBACK, { signedIn: false });
  assert.equal((await signIn()).status, 302);

  t.mock.timers.tick(6 * 60_000);
  await spendFetchBudget(f, UNCACHED_STRANGERS);
  const declined = await signIn();
  assert.equal(declined.status, 429, 'nothing known against the document, but nothing fetched either');
  assert.deepEqual(await declined.json(), BUSY);
  const signedIn = await f.authorize(STRANGER, STRANGER_CALLBACK);
  assert.equal(signedIn.status, 429, 'signed in too: no one has consented to it');
  assert.deepEqual(await signedIn.json(), BUSY);

  t.mock.timers.tick(61_000);
  served[STRANGER] = { body: 'Service Unavailable', status: 503, headers: { 'content-type': 'text/plain' } };
  assert.equal((await signIn()).status, 302);
  t.mock.timers.tick(1_000);
  await spendFetchBudget(f, UNCACHED_STRANGERS);
  const fetched = host.requests.length;
  assert.equal((await signIn()).status, 302, 'after a fetch that could not reach the document, a spent budget stands in for it');
  assert.equal(host.requests.length, fetched);

  t.mock.timers.tick(24 * 60 * 60_000);
  await spendFetchBudget(f, UNCACHED_STRANGERS);
  const stale = await signIn();
  assert.equal(stale.status, 429, 'but only for a day after the last good fetch');
  assert.deepEqual(await stale.json(), BUSY);
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

test('a document client passes the registration throttle until someone consents to it, and never after', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00.000Z') });
  const host = metadataDocumentServer({ [CLAUDE]: CLAUDE_DOCUMENTS.claude.body, [STRANGER]: strangerDocument });
  const sources: Array<string | null> = [];
  let refuse = true;
  const f = await fixture(t, {
    fetchClientMetadataResource: host.fetch,
    async throttleRegistration(request) {
      sources.push(request.headers.get('cf-connecting-ip'));
      return refuse
        ? Response.json({ error: 'registration_rate_limited' }, { status: 429, headers: { 'retry-after': '120' } })
        : undefined;
    },
  });
  const fromHere = { 'cf-connecting-ip': '203.0.113.9' };
  const assertThrottled = async (response: Response, message: string) => {
    assert.equal(response.status, 429, message);
    assert.equal(response.headers.get('retry-after'), '120');
    assert.deepEqual(await response.json(), {
      error: 'temporarily_unavailable', error_description: 'Too many new apps are signing in from here. Try again later.',
    });
  };

  const prune = t.mock.method(f.backend, 'prunePendingMcpOAuthClients');
  for (const signedIn of [false, true]) {
    t.mock.timers.tick(1_000);
    await assertThrottled(await f.authorize(STRANGER, STRANGER_CALLBACK, { signedIn, headers: fromHere }), 'a first sign-in');
  }
  assert.deepEqual(sources, ['203.0.113.9', '203.0.113.9'], 'asked with the source of the request that would store the client');
  assert.equal(prune.mock.callCount(), 0, 'a throttled sign-in writes nothing');
  assert.ok(!host.requests.includes(STRANGER), 'and fetches nothing');

  refuse = false;
  assert.equal((await f.authorize(STRANGER, STRANGER_CALLBACK, { signedIn: false, headers: fromHere })).status, 302);
  refuse = true;
  t.mock.timers.tick(6 * 60_000);
  const fetched = host.requests.length;
  await assertThrottled(await f.authorize(STRANGER, STRANGER_CALLBACK, { signedIn: false, headers: fromHere }),
    'a stored client no one consented to');
  assert.equal(host.requests.length, fetched, 'is asked before its document is fetched again');

  refuse = false;
  const first = await f.authorize(CLAUDE, CLAUDE_CALLBACK);
  const callback = await f.approve(first.headers.get('location')!);
  const exchanged = await f.exchange(CLAUDE, CLAUDE_CALLBACK, callback.searchParams.get('code')!);
  const { refresh_token: refreshToken } = await exchanged.json() as { refresh_token: string };
  refuse = true;
  const asked = sources.length;
  t.mock.timers.tick(6 * 60_000);
  assert.equal((await f.refresh(CLAUDE, refreshToken)).status, 200);
  assert.equal((await f.authorize(CLAUDE, CLAUDE_CALLBACK)).status, 302);
  assert.equal(sources.length, asked, 'a client someone consented to is never throttled');

  const registration = await f.handler(new Request(`${ORIGIN}/api/auth/oauth2/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...fromHere },
    body: JSON.stringify({
      application_type: 'native', client_name: 'Registered', grant_types: ['authorization_code'],
      redirect_uris: ['http://127.0.0.1:47321/callback'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  }));
  assert.equal(registration.status, 429, 'dynamic registration passes the same throttle');
  assert.deepEqual(await registration.json(), { error: 'registration_rate_limited' });
});

test('consent names the port of a document served on a non-default one', async (t) => {
  const url = 'https://apps.example.org:8443/client';
  const f = await fixture(t, { fetchClientMetadataResource: metadataDocumentServer({ [url]: documentAt(url, { client_name: 'Claude' }) }).fetch });
  const consent = new URL((await f.authorize(url, 'https://apps.example.org:8443/callback')).headers.get('location')!, ORIGIN);
  assert.equal(consent.pathname, '/auth/mcp/consent');
  const page = await (await f.browser.request(`${ORIGIN}${consent.pathname}${consent.search}`, {
    headers: { cookie: f.cookie },
  })).text();
  assert.ok(page.includes('<dt>App</dt><dd>Claude <span class="note">(name provided by the app)</span></dd><dt>Domain</dt><dd>apps.example.org:8443</dd>'));
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
