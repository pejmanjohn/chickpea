import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { makeSignature } from 'better-auth/crypto';

import { CONNECT_FONTS, fontFaceCss } from '../src/assets/fonts.ts';

import {
  MCP_WORKSPACE_SCOPE,
  MCP_OAUTH_SCOPES,
  mcpResourceForOrigin,
  validatePublicMcpClientRegistration,
} from '../src/auth/mcp-oauth.ts';
import {
  BetterAuthMcpOAuthContinuationStore,
  InMemoryMcpOAuthContinuationStore,
} from '../src/auth/mcp-oauth-continuation.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import {
  createMcpConsentRedirectResponse,
  createMcpAuthenticatedRequestHandler,
  verifySignedOAuthQuery,
  renderMcpConsentPage,
  displayMcpClientName,
} from '../src/auth/mcp-oauth-routes.ts';
import { validateBrowserMutationProvenance } from '../src/auth/request-provenance.ts';
import { REAL_MCP_CLIENT_REGISTRATIONS } from './helpers/mcp-client-registrations.ts';

test('MCP OAuth binds one workspace scope to the canonical protected resource', () => {
  assert.equal(MCP_WORKSPACE_SCOPE, 'chickpea:workspace');
  assert.equal(
    mcpResourceForOrigin('https://chickpea.example'),
    'https://chickpea.example/mcp',
  );
  assert.equal(
    mcpResourceForOrigin('http://127.0.0.1:8787/'),
    'http://127.0.0.1:8787/mcp',
  );
  assert.throws(() => mcpResourceForOrigin('http://chickpea.example'), /HTTPS/);
  assert.throws(() => mcpResourceForOrigin('https://user@chickpea.example'), /credentials/);
});

test('Better Auth publishes MCP discovery and registers only public clients', async () => {
  const origin = 'https://chickpea.example';
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const handler = createBetterAuthPublicHandler({
      backend,
      baseURL: origin,
      secret: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 31))
        .toString('base64url'),
    });
    const resource = await handler(new Request(`${origin}/.well-known/oauth-protected-resource`));
    assert.equal(resource.status, 200);
    assert.deepEqual(await resource.json(), {
      resource: `${origin}/mcp`,
      authorization_servers: [`${origin}/api/auth`],
      bearer_methods_supported: ['header'],
      dpop_signing_alg_values_supported: ['EdDSA', 'ES256', 'ES512', 'PS256', 'RS256'],
      scopes_supported: [MCP_WORKSPACE_SCOPE],
    });

    for (const path of [
      '/.well-known/oauth-authorization-server/api/auth',
      '/api/auth/.well-known/oauth-authorization-server',
    ]) {
      const authorization = await handler(new Request(`${origin}${path}`));
      assert.equal(authorization.status, 200, path);
      const metadata = await authorization.json() as Record<string, unknown>;
      assert.equal(metadata.issuer, `${origin}/api/auth`);
      assert.equal(metadata.authorization_endpoint, `${origin}/api/auth/oauth2/authorize`);
      assert.equal(metadata.token_endpoint, `${origin}/api/auth/oauth2/token`);
      assert.equal(metadata.registration_endpoint, `${origin}/api/auth/oauth2/register`);
      assert.equal(metadata.revocation_endpoint, `${origin}/api/auth/oauth2/revoke`);
      assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(metadata.scopes_supported, MCP_OAUTH_SCOPES);
      assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none'], path);
    }
    assert.equal(
      (await handler(new Request(`${origin}/api/auth/.well-known/openid-configuration`))).status,
      404,
      'Chickpea serves no OpenID metadata to advertise other methods',
    );

    const registered = await handler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`,
      REAL_MCP_CLIENT_REGISTRATIONS['Codex CLI'],
    ));
    assert.equal(registered.status, 201, await registered.clone().text());
    const client = await registered.json() as Record<string, unknown>;
    assert.equal(typeof client.client_id, 'string');
    assert.equal(client.client_secret, undefined);
    assert.deepEqual(client.resources, [`${origin}/mcp`]);

    const confidential = await handler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`,
      { ...REAL_MCP_CLIENT_REGISTRATIONS['claude.ai'], token_endpoint_auth_method: 'client_secret_post' },
    ));
    assert.equal(confidential.status, 400);
    assert.deepEqual(await confidential.json(), { error: 'public_clients_only' });
  } finally {
    backend.close();
  }
});

test('real MCP clients register and reach Chickpea sign-in', async () => {
  const origin = 'https://chickpea.example';
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const handler = createBetterAuthPublicHandler({
      backend,
      baseURL: origin,
      secret: Buffer.alloc(32, 29).toString('base64url'),
    });
    const expectedApplicationType: Record<string, 'native' | 'web'> = {
      'Claude Code': 'native',
      'Codex CLI': 'native',
      'MCP Inspector': 'native',
      'claude.ai': 'web',
    };
    for (const [name, registration] of Object.entries(REAL_MCP_CLIENT_REGISTRATIONS)) {
      const registered = await handler(jsonProtocolRequest(`${origin}/api/auth/oauth2/register`, registration));
      assert.equal(registered.status, 201, `${name}: ${await registered.clone().text()}`);
      const client = await registered.json() as { client_id: string; application_type?: string };
      assert.equal(client.application_type, expectedApplicationType[name], name);

      const authorize = await handler(new Request(`${origin}/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: registration.redirect_uris[0],
        scope: MCP_WORKSPACE_SCOPE,
        state: 'client-state',
        resource: `${origin}/mcp`,
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      })}`));
      assert.equal(authorize.status, 302, `${name}: ${await authorize.clone().text()}`);
      assert.equal(new URL(authorize.headers.get('location')!, origin).pathname, '/auth/mcp/login', name);
    }
  } finally {
    backend.close();
  }
});

test('a refused MCP registration reports why in its metric', async (t) => {
  const origin = 'https://chickpea.example';
  const backend = new NodeBetterAuthBackend(':memory:');
  const metrics: unknown[] = [];
  t.mock.method(console, 'info', (record: unknown) => metrics.push(record));
  try {
    const handler = createBetterAuthPublicHandler({
      backend,
      baseURL: origin,
      secret: Buffer.alloc(32, 31).toString('base64url'),
    });
    const refused = await handler(jsonProtocolRequest(`${origin}/api/auth/oauth2/register`, {
      ...REAL_MCP_CLIENT_REGISTRATIONS['claude.ai'],
      application_type: 'browser',
    }));
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'unsupported_application_type' });
    assert.deepEqual(metrics, [{
      component: 'management',
      event: 'oauth.dcr',
      stage: 'validation',
      outcome: 'denied',
      reason: 'unsupported_application_type',
    }]);
  } finally {
    backend.close();
  }
});

test('public MCP registration accepts only bounded public PKCE clients', () => {
  for (const [name, registration] of Object.entries(REAL_MCP_CLIENT_REGISTRATIONS)) {
    assert.equal(validatePublicMcpClientRegistration(registration).ok, true, name);
  }

  const denials: Record<string, { input: Record<string, unknown>; code: string }> = {
    unknownApplicationType: {
      input: { ...REAL_MCP_CLIENT_REGISTRATIONS['claude.ai'], application_type: 'browser' },
      code: 'unsupported_application_type',
    },
    confidential: {
      input: {
        application_type: 'web',
        client_name: 'Secret client',
        grant_types: ['authorization_code'],
        redirect_uris: ['https://client.example/callback'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
      code: 'public_clients_only',
    },
    wildcard: {
      input: {
        application_type: 'web',
        client_name: 'Wildcard client',
        grant_types: ['authorization_code'],
        redirect_uris: ['https://*.example/callback'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      code: 'invalid_redirect_uri',
    },
    insecureRemote: {
      input: {
        application_type: 'web',
        client_name: 'Remote HTTP client',
        grant_types: ['authorization_code'],
        redirect_uris: ['http://client.example/callback'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      code: 'invalid_redirect_uri',
    },
    implicit: {
      input: {
        application_type: 'web',
        client_name: 'Implicit client',
        grant_types: ['implicit'],
        redirect_uris: ['https://client.example/callback'],
        response_types: ['token'],
        token_endpoint_auth_method: 'none',
      },
      code: 'unsupported_grant_type',
    },
  };
  for (const [name, { input, code }] of Object.entries(denials)) {
    assert.deepEqual(validatePublicMcpClientRegistration(input), { ok: false, code }, name);
  }
});

test('browser handoff accepts only Better Auth signed, unexpired OAuth queries', async () => {
  const secret = Buffer.alloc(32, 47).toString('base64url');
  const now = 1_786_000_000_000;
  const query = new URLSearchParams({
    client_id: 'client_123',
    exp: String(Math.floor(now / 1_000) + 600),
    ba_iat: String(now),
    redirect_uri: 'http://127.0.0.1:47321/callback',
  });
  for (const name of [...query.keys(), 'ba_param'].sort()) query.append('ba_param', name);
  const canonical = new URLSearchParams([...query.entries()].sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    if (valueA < valueB) return -1;
    if (valueA > valueB) return 1;
    return 0;
  }));
  query.set('sig', await makeSignature(canonical.toString(), secret));

  assert.equal(await verifySignedOAuthQuery(query, secret, now), true);
  const tampered = new URLSearchParams(query);
  tampered.set('client_id', 'attacker');
  assert.equal(await verifySignedOAuthQuery(tampered, secret, now), false);
  assert.equal(await verifySignedOAuthQuery(query, secret, now + 600_001), false);
  query.append('sig', query.get('sig') ?? '');
  assert.equal(await verifySignedOAuthQuery(query, secret, now), false);
});

test('MCP consent can opt into opaque-origin same-origin form navigation', () => {
  const origin = 'https://chickpea.example';
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: 'null',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
  };
  const options = {
    canonicalOrigin: origin,
    maxBodyBytes: 16 * 1024,
    requireJson: false,
    allowOpaqueOriginFormNavigation: true,
  };

  assert.deepEqual(validateBrowserMutationProvenance(new Request(
    `${origin}/auth/mcp/consent`, { method: 'POST', headers, body: 'decision=allow' },
  ), options), { ok: true });
  assert.deepEqual(validateBrowserMutationProvenance(new Request(
    `${origin}/auth/mcp/consent`, {
      method: 'POST',
      headers: { ...headers, 'sec-fetch-site': 'cross-site' },
      body: 'decision=allow',
    },
  ), options), { ok: false, code: 'cross_origin_denied' });
  assert.deepEqual(validateBrowserMutationProvenance(new Request(
    'https://attacker.example/auth/mcp/consent', {
      method: 'POST', headers, body: 'decision=allow',
    },
  ), options), { ok: false, code: 'cross_origin_denied' });
  assert.deepEqual(validateBrowserMutationProvenance(new Request(
    `${origin}/auth/mcp/consent`, { method: 'POST', headers, body: 'decision=allow' },
  ), { ...options, allowOpaqueOriginFormNavigation: false }), {
    ok: false,
    code: 'cross_origin_denied',
  });
});

test('MCP consent explains renewable access without changing the signed request', () => {
  const oauthQuery = 'scope=chickpea%3Aworkspace+offline_access&sig=test';
  const html = renderMcpConsentPage({
    clientName: 'Test client', scope: 'chickpea:workspace offline_access', oauthQuery,
  });
  assert.ok(html.includes('<dd>Manage this Chickpea workspace and stay signed in</dd>'));
  assert.ok(html.includes(`value="${oauthQuery.replaceAll('&', '&amp;')}"`));
  const temporary = renderMcpConsentPage({ clientName: 'Test client', scope: MCP_WORKSPACE_SCOPE, oauthQuery });
  assert.ok(temporary.includes('<dd>Manage this Chickpea workspace</dd>'));
  assert.ok(!temporary.includes('stay signed in'));
});

test('MCP consent shows the app-provided name, labelled as self-asserted', () => {
  const html = renderMcpConsentPage({ clientName: 'Claude Code', scope: MCP_WORKSPACE_SCOPE, oauthQuery: 'sig=test' });
  assert.ok(html.includes('<dt>App</dt><dd>Claude Code <span class="note">(name provided by the app)</span></dd>'));
  assert.ok(!html.includes('<dt>Client</dt>'));
});

test('MCP consent falls back to a generic label when the app gave no name', () => {
  for (const clientName of [undefined, '', '   ', '\u202e\u200b']) {
    const html = renderMcpConsentPage({ clientName, scope: MCP_WORKSPACE_SCOPE, oauthQuery: 'sig=test' });
    assert.ok(html.includes('<dt>App</dt><dd>An unnamed app</dd>'), JSON.stringify(clientName));
    assert.ok(!html.includes('name provided by the app'));
  }
});

test('MCP consent escapes, cleans, and bounds a hostile app name', () => {
  const hostile = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
  const html = renderMcpConsentPage({ clientName: hostile, scope: MCP_WORKSPACE_SCOPE, oauthQuery: 'sig=test' });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

  assert.equal(displayMcpClientName('Evil\u202eedoC edualC'), 'EviledoC edualC', 'bidi overrides are stripped');
  assert.equal(displayMcpClientName('Line\none\ttwo\u0000three'), 'Line one two three');
  const long = displayMcpClientName('A'.repeat(120))!;
  assert.equal([...long].length, 60);
  assert.ok(long.endsWith('…'));
  const longHtml = renderMcpConsentPage({ clientName: 'B'.repeat(120), scope: MCP_WORKSPACE_SCOPE, oauthQuery: 'sig=test' });
  assert.ok(!longHtml.includes('B'.repeat(60)));
  assert.equal(displayMcpClientName('Chickpea CLI'), 'Chickpea CLI');
});

test('MCP consent finishes its form POST before returning to a client callback', async () => {
  for (const callback of [
    'http://127.0.0.1:47321/callback?code=code_123&state=state_123',
    'http://localhost:47321/callback?error=access_denied&state=state_123',
    'http://[::1]:47321/callback?code=code_123&state=state_123',
    'https://client.example/callback?code=code_123&state=state_123',
  ]) {
    const response = createMcpConsentRedirectResponse(callback);
    assert.equal(response.status, 200, 'a 3xx would remain subject to form-action self');
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('content-security-policy'),
      "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const html = await response.text();
    const escapedCallback = callback.replaceAll('&', '&amp;');
    assert.ok(html.includes(`http-equiv="refresh" content="0;url=${escapedCallback}"`));
    assert.ok(html.includes(`<a href="${escapedCallback}">Continue</a>`));
    assert.ok(!html.includes('<script'), 'callback navigation does not require JavaScript');
  }
});

test('the MCP sign-in pages load the fonts their style names, from this origin', async () => {
  const response = createMcpConsentRedirectResponse('https://client.example/callback?code=code_123&state=state_123');
  assert.match(response.headers.get('content-security-policy') ?? '', /(?:^|; )font-src 'self'(?:;|$)/);
  assert.ok((await response.text()).includes(`<style>${fontFaceCss(CONNECT_FONTS)}\n`), 'the faces open the page style');
});

test('MCP consent callback document rejects unsafe destinations and escapes attributes', async () => {
  for (const callback of [
    'javascript:alert(1)', '//attacker.example/callback', 'http://client.example/callback',
    'https://user:password@client.example/callback', 'https://client.example/callback#token',
  ]) {
    const response = createMcpConsentRedirectResponse(callback);
    assert.equal(response.status, 400, callback);
    assert.ok(!(await response.text()).includes('http-equiv="refresh"'));
  }
  const response = createMcpConsentRedirectResponse('https://client.example/callback?state="><script>alert(1)</script>');
  const html = await response.text();
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
});

test('Slack login resumes an opaque, expiring MCP continuation once', () => {
  let now = 1_786_000_000_000;
  const store = new InMemoryMcpOAuthContinuationStore({
    now: () => now,
    randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 1),
  });
  const continuation = store.issue({
    authorizationPath: '/api/auth/oauth2/authorize?client_id=client_123&state=opaque',
  });

  assert.match(continuation.id, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(continuation.expiresAt, now + 10 * 60_000);
  assert.deepEqual(store.consume(continuation.id), {
    authorizationPath: '/api/auth/oauth2/authorize?client_id=client_123&state=opaque',
  });
  assert.equal(store.consume(continuation.id), undefined);

  const expired = store.issue({ authorizationPath: '/api/auth/oauth2/authorize?client_id=next' });
  now += 10 * 60_000 + 1;
  assert.equal(store.consume(expired.id), undefined);
  assert.throws(
    () => store.issue({ authorizationPath: 'https://attacker.example/callback' }),
    /authorization path/,
  );
});

test('durable MCP continuations store only a digest and consume atomically', async () => {
  let now = 1_786_000_000_000;
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const store = new BetterAuthMcpOAuthContinuationStore({
      backend,
      now: () => now,
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => 255 - index),
    });
    const issued = await store.issue({
      authorizationPath: '/api/auth/oauth2/authorize?client_id=client_456&state=opaque',
    });
    const stored = backend.database.prepare(
      'SELECT id_hash, authorization_path FROM chickpea_mcp_oauth_continuation',
    ).get() as { id_hash: string; authorization_path: string };
    assert.notEqual(stored.id_hash, issued.id);
    assert.match(stored.id_hash, /^[a-f0-9]{64}$/);
    assert.equal(stored.authorization_path.includes('client_456'), true);

    assert.deepEqual(await store.consume(issued.id), {
      authorizationPath: '/api/auth/oauth2/authorize?client_id=client_456&state=opaque',
    });
    assert.equal(await store.consume(issued.id), undefined);

    const expired = await store.issue({
      authorizationPath: '/api/auth/oauth2/authorize?client_id=expired&state=opaque',
    });
    now += 10 * 60_000 + 1;
    assert.equal(await store.consume(expired.id), undefined);
  } finally {
    backend.close();
  }
});

test('the MCP server factory runs only after audience, scope, and live membership checks', async () => {
  const origin = 'https://chickpea.example';
  const resource = `${origin}/mcp`;
  const issuer = `${origin}/api/auth`;
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { alg: 'EdDSA', kid: 'test-key', use: 'sig' });
  let active = true;
  let resolutions = 0;
  let factories = 0;
  const handler = createMcpAuthenticatedRequestHandler({
    baseURL: origin,
    getJwks: async () => ({ keys: [publicJwk] }),
    resolvePrincipal: async (betterAuthUserId) => {
      resolutions += 1;
      if (!active || betterAuthUserId !== 'better_user') return undefined;
      return {
        betterAuthUserId,
        userId: 'user_1',
        membershipId: 'membership_1',
        organizationId: 'org_1',
        role: 'admin',
      };
    },
    createServer: async (principal) => {
      factories += 1;
      return async () => Response.json({ principal });
    },
  });

  const missing = await handler(new Request(resource, { method: 'POST' }));
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate') ?? '', /resource_metadata=/);
  assert.equal(resolutions, 0);
  assert.equal(factories, 0);

  const wrongAudience = await bearerRequest(resource, await signedAccessToken({
    privateKey,
    issuer,
    audience: `${origin}/another-resource`,
    scope: MCP_WORKSPACE_SCOPE,
  }));
  assert.equal((await handler(wrongAudience)).status, 401);
  assert.equal(resolutions, 0);
  assert.equal(factories, 0);

  const insufficient = await bearerRequest(resource, await signedAccessToken({
    privateKey,
    issuer,
    audience: resource,
    scope: 'read:only',
  }));
  const insufficientResponse = await handler(insufficient);
  assert.equal(insufficientResponse.status, 403);
  assert.match(insufficientResponse.headers.get('www-authenticate') ?? '', /insufficient_scope/);
  assert.equal(resolutions, 0);
  assert.equal(factories, 0);

  const missingClient = await bearerRequest(resource, await signedAccessToken({
    privateKey,
    issuer,
    audience: resource,
    scope: MCP_WORKSPACE_SCOPE,
    clientId: null,
  }));
  assert.equal((await handler(missingClient)).status, 401);
  assert.equal(resolutions, 0);
  assert.equal(factories, 0);

  const token = await signedAccessToken({
    privateKey,
    issuer,
    audience: resource,
    scope: MCP_WORKSPACE_SCOPE,
  });
  const accepted = await handler(await bearerRequest(resource, token));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    principal: {
      betterAuthUserId: 'better_user',
      userId: 'user_1',
      membershipId: 'membership_1',
      organizationId: 'org_1',
      role: 'admin',
      clientId: 'client_test',
    },
  });
  assert.equal(resolutions, 1);
  assert.equal(factories, 1);

  active = false;
  const demoted = await handler(await bearerRequest(resource, token));
  assert.equal(demoted.status, 403);
  assert.equal(resolutions, 2);
  assert.equal(factories, 1);
});

async function signedAccessToken(input: {
  privateKey: CryptoKey;
  issuer: string;
  audience: string;
  scope: string;
  clientId?: string | null;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    scope: input.scope,
    ...(input.clientId === null ? {} : { azp: input.clientId ?? 'client_test' }),
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject('better_user')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(input.privateKey);
}

async function bearerRequest(resource: string, token: string): Promise<Request> {
  return new Request(resource, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

function jsonProtocolRequest(url: string, body: Record<string, unknown>): Request {
  const encoded = JSON.stringify(body);
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(encoded)),
    },
    body: encoded,
  });
}
