import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { makeSignature } from 'better-auth/crypto';

import {
  MCP_WORKSPACE_SCOPE,
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
  createMcpAuthenticatedRequestHandler,
  verifySignedOAuthQuery,
} from '../src/auth/mcp-oauth-routes.ts';

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

    const authorization = await handler(new Request(
      `${origin}/.well-known/oauth-authorization-server/api/auth`,
    ));
    assert.equal(authorization.status, 200);
    const metadata = await authorization.json() as Record<string, unknown>;
    assert.equal(metadata.issuer, `${origin}/api/auth`);
    assert.equal(metadata.authorization_endpoint, `${origin}/api/auth/oauth2/authorize`);
    assert.equal(metadata.token_endpoint, `${origin}/api/auth/oauth2/token`);
    assert.equal(metadata.registration_endpoint, `${origin}/api/auth/oauth2/register`);
    assert.equal(metadata.revocation_endpoint, `${origin}/api/auth/oauth2/revoke`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(metadata.scopes_supported, [MCP_WORKSPACE_SCOPE]);

    const registration = {
      application_type: 'native',
      client_name: 'Codex',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: ['http://127.0.0.1:47321/callback'],
      response_types: ['code'],
      scope: MCP_WORKSPACE_SCOPE,
      token_endpoint_auth_method: 'none',
    };
    const registered = await handler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`,
      registration,
    ));
    assert.equal(registered.status, 201, await registered.clone().text());
    const client = await registered.json() as Record<string, unknown>;
    assert.equal(typeof client.client_id, 'string');
    assert.equal(client.client_secret, undefined);
    assert.deepEqual(client.resources, [`${origin}/mcp`]);

    const confidential = await handler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`,
      { ...registration, token_endpoint_auth_method: 'client_secret_post' },
    ));
    assert.equal(confidential.status, 400);
    assert.deepEqual(await confidential.json(), { error: 'public_clients_only' });
  } finally {
    backend.close();
  }
});

test('public MCP registration accepts only bounded public PKCE clients', () => {
  const accepted = validatePublicMcpClientRegistration({
    application_type: 'native',
    client_name: 'Codex',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: ['http://127.0.0.1:47321/callback'],
    response_types: ['code'],
    scope: MCP_WORKSPACE_SCOPE,
    token_endpoint_auth_method: 'none',
  });
  assert.equal(accepted.ok, true);

  for (const [name, input] of Object.entries({
    confidential: {
      application_type: 'web',
      client_name: 'Secret client',
      grant_types: ['authorization_code'],
      redirect_uris: ['https://client.example/callback'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    },
    wildcard: {
      application_type: 'web',
      client_name: 'Wildcard client',
      grant_types: ['authorization_code'],
      redirect_uris: ['https://*.example/callback'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    insecureRemote: {
      application_type: 'web',
      client_name: 'Remote HTTP client',
      grant_types: ['authorization_code'],
      redirect_uris: ['http://client.example/callback'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    implicit: {
      application_type: 'web',
      client_name: 'Implicit client',
      grant_types: ['implicit'],
      redirect_uris: ['https://client.example/callback'],
      response_types: ['token'],
      token_endpoint_auth_method: 'none',
    },
  })) {
    const result = validatePublicMcpClientRegistration(input);
    assert.equal(result.ok, false, name);
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

test('public MCP registration enforces rate, quota, and unused-client retention', async () => {
  const origin = 'https://chickpea.example';
  const registration = {
    application_type: 'native',
    client_name: 'Codex',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: ['http://127.0.0.1:47321/callback'],
    response_types: ['code'],
    scope: MCP_WORKSPACE_SCOPE,
    token_endpoint_auth_method: 'none',
  };

  const rateBackend = new NodeBetterAuthBackend(':memory:');
  try {
    const rateHandler = createBetterAuthPublicHandler({
      backend: rateBackend,
      baseURL: origin,
      secret: Buffer.alloc(32, 41).toString('base64url'),
      mcpRegistrationPolicy: { maxRegistrationsPerWindow: 1 },
    });
    assert.equal((await rateHandler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`, registration,
    ))).status, 201);
    const limited = await rateHandler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`, { ...registration, client_name: 'Claude' },
    ));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'registration_rate_limited' });
    assert.equal(limited.headers.get('retry-after'), '600');
  } finally {
    rateBackend.close();
  }

  const quotaBackend = new NodeBetterAuthBackend(':memory:');
  try {
    const quotaHandler = createBetterAuthPublicHandler({
      backend: quotaBackend,
      baseURL: origin,
      secret: Buffer.alloc(32, 43).toString('base64url'),
      mcpRegistrationPolicy: { maxClients: 1 },
    });
    assert.equal((await quotaHandler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`, registration,
    ))).status, 201);
    const full = await quotaHandler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`, { ...registration, client_name: 'Claude' },
    ));
    assert.equal(full.status, 429);
    assert.deepEqual(await full.json(), { error: 'registration_quota_exceeded' });

    quotaBackend.database.prepare(
      'UPDATE oauthClient SET createdAt = ? WHERE tokenEndpointAuthMethod = ?',
    ).run('2000-01-01T00:00:00.000Z', 'none');
    const afterRetention = await quotaHandler(jsonProtocolRequest(
      `${origin}/api/auth/oauth2/register`, { ...registration, client_name: 'Cursor' },
    ));
    assert.equal(afterRetention.status, 201, await afterRetention.clone().text());
    assert.equal(await quotaBackend.countMcpOAuthClients(), 1);
  } finally {
    quotaBackend.close();
  }
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
}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ scope: input.scope })
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
