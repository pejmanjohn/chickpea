import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';

const ORIGIN = 'https://chickpea.example.test';
const RESOURCE = `${ORIGIN}/mcp`;
const WORKSPACE_SCOPE = 'chickpea:workspace';
const RENEWABLE_SCOPE = `${WORKSPACE_SCOPE} offline_access`;
const REDIRECT = 'http://127.0.0.1:47321/callback';

async function fixture() {
  const backend = new NodeBetterAuthBackend(':memory:');
  let admission: BetterAuthAdmissionOperation | null = null;
  const options = {
    backend, baseURL: ORIGIN, secret: randomBytes(32).toString('base64url'),
    privateSeam: { async resolveAdmissionOperation() { return admission; } },
  };
  const auth = createBetterAuth(options);
  const handler = createBetterAuthPublicHandler(options);
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
  function token(body: Record<string, string>) {
    return handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    }));
  }
  async function register(scope?: string) {
    const response = await json('/api/auth/oauth2/register', {
      application_type: 'native', client_name: 'Refresh fixture',
      grant_types: ['authorization_code', 'refresh_token'], redirect_uris: [REDIRECT],
      response_types: ['code'], token_endpoint_auth_method: 'none',
      ...(scope === undefined ? {} : { scope }),
    });
    return response;
  }
  async function authorize(clientId: string, scope: string) {
    const verifier = 'f'.repeat(64);
    const query = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
      scope, state: 'fixture-state', resource: RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', prompt: 'consent',
    });
    const response = await handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie },
    }));
    assert.equal(response.status, 302);
    const consentQuery = new URL(response.headers.get('location')!, ORIGIN).search.slice(1);
    const consent = await json('/api/auth/oauth2/consent', { accept: true, oauth_query: consentQuery });
    assert.equal(consent.status, 200);
    const { url } = await consent.json() as { url: string };
    const callback = new URL(url);
    assert.equal(callback.searchParams.get('state'), 'fixture-state');
    assert.ok(callback.searchParams.get('code'));
    return token({
      grant_type: 'authorization_code', client_id: clientId,
      code: callback.searchParams.get('code')!, code_verifier: verifier,
      redirect_uri: REDIRECT, resource: RESOURCE,
    });
  }
  return { backend, handler, register, authorize, token };
}

for (const explicitRegistrationScope of [true, false]) {
  test(`real public OAuth renews expired access and rotates refresh tokens (${explicitRegistrationScope ? 'explicit' : 'default'} registration scopes)`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = await fixture();
    t.after(() => f.backend.close());
    const registered = await f.register(explicitRegistrationScope ? RENEWABLE_SCOPE : undefined);
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
    const other = await f.register(RENEWABLE_SCOPE);
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
  });
}

test('offline access is optional and registration still rejects unrelated scopes', async (t) => {
  const f = await fixture();
  t.after(() => f.backend.close());
  const denied = await f.register(`${RENEWABLE_SCOPE} admin`);
  assert.equal(denied.status, 400);
  assert.deepEqual(await denied.json(), { error: 'invalid_scope' });
  const registered = await f.register(WORKSPACE_SCOPE);
  assert.equal(registered.status, 201);
  const client = await registered.json() as { client_id: string };
  const exchange = await f.authorize(client.client_id, WORKSPACE_SCOPE);
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json() as Record<string, unknown>;
  assert.equal(typeof tokens.access_token, 'string');
  assert.equal(tokens.refresh_token, undefined, 'do not silently grant unrequested offline access');
});
