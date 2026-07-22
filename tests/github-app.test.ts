import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  type KeyObject,
  verify as verifySignature,
  webcrypto,
} from 'node:crypto';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  createInstallationToken,
  getCachedInstallationToken,
  GITHUB_API_BASE,
  mintAppJwt,
  normalizePrivateKeyPem,
  type GithubConnection,
} from '../src/config/github-app.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const ADMIN_TOKEN = 'github-admin-token';

function rsaKeys(): {
  pkcs1: string;
  pkcs8: string;
  publicKey: KeyObject;
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    pkcs1: String(privateKey.export({ type: 'pkcs1', format: 'pem' })),
    pkcs8: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publicKey,
  };
}

function pemDer(pem: string): ArrayBuffer {
  const bytes = Buffer.from(pem.replace(/-----[^-]+-----|\s+/g, ''), 'base64');
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function decodeJwtPart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

function auth(): HeadersInit {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

function jsonHeaders(): HeadersInit {
  return { ...auth(), 'content-type': 'application/json' };
}

function adminApp(store: SqliteConfigStore, settings: SqliteSettingsStore): Hono {
  const app = new Hono();
  app.route(
    '/',
    createAdminRoutes({
      store,
      settings,
      adminToken: ADMIN_TOKEN,
      knownProviders: new Set(['local-stub']),
    }),
  );
  return app;
}

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent-github',
    name: 'GitHub profile',
    instructions: 'Use only granted repositories.',
    enabled: true,
    model: 'local-stub/github',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...overrides,
  };
}

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test('normalizePrivateKeyPem converts PKCS#1 to importable PKCS#8 and rejects garbage', async () => {
  const { pkcs1, publicKey } = rsaKeys();

  const normalized = normalizePrivateKeyPem(pkcs1);
  assert.match(normalized, /^-----BEGIN PRIVATE KEY-----/);
  const imported = await webcrypto.subtle.importKey(
    'pkcs8',
    pemDer(normalized),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = Buffer.from('pkcs1 conversion proof');
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', imported, message);
  assert.equal(verifySignature('RSA-SHA256', message, publicKey, Buffer.from(signature)), true);
  assert.throws(() => normalizePrivateKeyPem('not a pem'), /private key/i);
});

test('normalizePrivateKeyPem passes PKCS#8 through unchanged', () => {
  const { pkcs8 } = rsaKeys();
  assert.equal(normalizePrivateKeyPem(pkcs8), pkcs8);
});

test('mintAppJwt creates the expected claims and a verifiable RS256 signature', async () => {
  const { pkcs1, publicKey } = rsaKeys();
  const nowSec = 1_800_000_000;

  const jwt = await mintAppJwt({ appId: 12345, privateKeyPem: pkcs1, nowSec });
  const [headerPart, payloadPart, signaturePart] = jwt.split('.');
  assert.ok(headerPart && payloadPart && signaturePart);
  assert.deepEqual(decodeJwtPart(headerPart), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decodeJwtPart(payloadPart), {
    iat: nowSec - 60,
    exp: nowSec + 540,
    iss: '12345',
  });
  assert.equal(
    verifySignature(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      Buffer.from(signaturePart, 'base64url'),
    ),
    true,
  );
});

test('createInstallationToken down-scopes repositories and permissions', async () => {
  const { pkcs8 } = rsaKeys();
  const conn: GithubConnection = {
    mode: 'app',
    appId: '12345',
    appSlug: 'chickpea-test',
    privateKeyPem: pkcs8,
  };
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    request = { url: String(input), ...(init ? { init } : {}) };
    return new Response(
      JSON.stringify({ token: 'installation-token', expires_at: '2026-07-21T20:00:00Z' }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };

  const result = await createInstallationToken(
    conn,
    42,
    {
      repositories: ['magoosh/chickpea', 'magoosh/api'],
      permissions: { contents: 'write', pull_requests: 'write' },
    },
    fetchImpl,
  );

  assert.equal(request?.url, `${GITHUB_API_BASE}/app/installations/42/access_tokens`);
  assert.equal(request?.init?.method, 'POST');
  assert.ok(request?.init?.signal, 'installation token mint must have a timeout signal');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    repositories: ['magoosh/chickpea', 'magoosh/api'],
    permissions: { contents: 'write', pull_requests: 'write' },
  });
  assert.match(new Headers(request?.init?.headers).get('authorization') ?? '', /^Bearer /);
  assert.deepEqual(result, {
    token: 'installation-token',
    expiresAt: '2026-07-21T20:00:00Z',
  });
});

test('getCachedInstallationToken caches by installation and sorted repository names', async () => {
  const { pkcs8 } = rsaKeys();
  const conn: GithubConnection = {
    mode: 'app',
    appId: 'cache-app',
    privateKeyPem: pkcs8,
  };
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests += 1;
    return Response.json({
      token: `cached-token-${requests}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
  };

  const first = await getCachedInstallationToken(
    conn,
    9_001,
    { repositories: ['zeta', 'alpha'] },
    fetchImpl,
  );
  const reordered = await getCachedInstallationToken(
    conn,
    9_001,
    { repositories: ['alpha', 'zeta'] },
    fetchImpl,
  );
  const narrower = await getCachedInstallationToken(
    conn,
    9_001,
    { repositories: ['alpha'] },
    fetchImpl,
  );
  const otherInstallation = await getCachedInstallationToken(
    conn,
    9_002,
    { repositories: ['alpha', 'zeta'] },
    fetchImpl,
  );

  assert.equal(requests, 3);
  assert.equal(reordered.token, first.token);
  assert.notEqual(narrower.token, first.token);
  assert.notEqual(otherInstallation.token, first.token);
});

test('direct token mints do not populate the runtime repository-token cache', async () => {
  const { pkcs8 } = rsaKeys();
  const conn: GithubConnection = {
    mode: 'app',
    appId: 'cache-isolation-app',
    privateKeyPem: pkcs8,
  };
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests += 1;
    return Response.json({
      token: `isolated-token-${requests}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
  };

  const adminToken = await createInstallationToken(conn, 9_004, {}, fetchImpl);
  const runtimeToken = await getCachedInstallationToken(conn, 9_004, {}, fetchImpl);

  assert.equal(requests, 2);
  assert.notEqual(runtimeToken.token, adminToken.token);
});

test('getCachedInstallationToken refreshes inside the five-minute early-expiry window', async () => {
  const { pkcs8 } = rsaKeys();
  const conn: GithubConnection = {
    mode: 'app',
    appId: 'early-expiry-app',
    privateKeyPem: pkcs8,
  };
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests += 1;
    return Response.json({
      token: `short-token-${requests}`,
      expires_at: new Date(Date.now() + 4 * 60 * 1_000).toISOString(),
    });
  };

  const first = await getCachedInstallationToken(
    conn,
    9_003,
    { repositories: ['alpha'] },
    fetchImpl,
  );
  const second = await getCachedInstallationToken(
    conn,
    9_003,
    { repositories: ['alpha'] },
    fetchImpl,
  );

  assert.equal(requests, 2);
  assert.notEqual(second.token, first.token);
});

test('GitHub manifest route uses the resolved request origin and requested organization', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv({ SLACK_TAG_PUBLIC_URL: undefined }, async () => {
      const response = await adminApp(store, settings).request(
        'http://internal.test/admin/api/github/manifest',
        {
          method: 'POST',
          headers: {
            ...jsonHeaders(),
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'chickpea.example.com',
          },
          body: JSON.stringify({ org: 'magoosh' }),
        },
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        target: string;
        manifest: Record<string, unknown> & {
          name: string;
          redirect_url: string;
          hook_attributes: { active: boolean; url: string };
          default_permissions: Record<string, string>;
        };
      };
      const targetUrl = new URL(body.target);
      assert.equal(
        `${targetUrl.origin}${targetUrl.pathname}`,
        'https://github.com/organizations/magoosh/settings/apps/new',
      );
      const setupState = targetUrl.searchParams.get('state') ?? '';
      assert.match(setupState, /^[a-f0-9]{32}$/);
      assert.match(
        (await settings.getSetting('github.setup_state')) ?? '',
        new RegExp(`^${setupState}:\\d+$`),
      );
      assert.match(body.manifest.name, /^chickpea-[a-z0-9]{6}$/);
      assert.equal(body.manifest.url, 'https://chickpea.example.com');
      assert.equal(
        body.manifest.redirect_url,
        'https://chickpea.example.com/admin/api/github/setup/callback',
      );
      assert.deepEqual(body.manifest.hook_attributes, {
        active: false,
        url: 'https://chickpea.example.com/github/webhook',
      });
      assert.deepEqual(body.manifest.default_permissions, {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        metadata: 'read',
        actions: 'write',
      });
    });
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub manifest callback stores a normalized private key and redirects to Settings', async () => {
  const { pkcs1 } = rsaKeys();
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${GITHUB_API_BASE}/app-manifests/setup-code/conversions`);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return new Response(
      JSON.stringify({
        id: 12345,
        slug: 'chickpea-test',
        pem: pkcs1,
        webhook_secret: 'webhook-secret',
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    await settings.setSetting('github.setup_state', `valid-state:${Date.now()}`);
    await withFetch(fetchImpl, async () => {
      const response = await adminApp(store, settings).request(
        '/admin/api/github/setup/callback?code=setup-code&state=valid-state',
        { headers: auth(), redirect: 'manual' },
      );
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/admin/settings');
    });
    assert.equal(await settings.getSetting('github.app.id'), '12345');
    assert.equal(await settings.getSetting('github.app.slug'), 'chickpea-test');
    assert.match(
      (await settings.getSetting('github.app.private_key')) ?? '',
      /^-----BEGIN PRIVATE KEY-----/,
    );
    assert.equal(await settings.getSetting('github.app.webhook_secret'), 'webhook-secret');
    assert.equal(await settings.getSetting('github.setup_state'), undefined);
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub status isolates one failing installation instead of failing the endpoint', async () => {
  const { pkcs8 } = rsaKeys();
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  await settings.setSetting('github.app.id', '12345');
  await settings.setSetting('github.app.private_key', pkcs8);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/app/installations?')) {
      return Response.json([
        { id: 41, account: { login: 'healthy', type: 'Organization' } },
        { id: 42, account: { login: 'suspended', type: 'Organization' } },
      ]);
    }
    if (url.includes('/app/installations/41/')) {
      return Response.json({ token: 't-41', expires_at: '2026-07-22T20:00:00Z' });
    }
    if (url.includes('/app/installations/42/')) {
      return new Response('suspended', { status: 403 });
    }
    if (url.includes('/installation/repositories')) {
      return Response.json({ total_count: 1, repositories: [
        { full_name: 'healthy/repo', private: false, default_branch: 'main' },
      ] });
    }
    return new Response('unexpected request', { status: 500 });
  };
  try {
    await withEnv(
      { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_PAT: undefined },
      () =>
        withFetch(fetchImpl, async () => {
          const response = await adminApp(store, settings).request('/admin/api/github/status', {
            headers: auth(),
          });
          assert.equal(response.status, 200);
          const body = (await response.json()) as {
            installations: Array<{ id: number; repoCount: number | null }>;
          };
          assert.deepEqual(
            body.installations.map(({ id, repoCount }) => ({ id, repoCount })),
            [
              { id: 41, repoCount: 1 },
              { id: 42, repoCount: null },
            ],
          );
        }),
    );
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub status stays recoverable when the stored App key is malformed', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  await settings.setSetting('github.app.id', '12345');
  await settings.setSetting('github.app.slug', 'chickpea-test');
  await settings.setSetting('github.app.private_key', 'not a pem at all');
  const fetchImpl: typeof fetch = async () => new Response('unreachable', { status: 500 });
  try {
    await withEnv(
      { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_PAT: undefined },
      () =>
        withFetch(fetchImpl, async () => {
          const response = await adminApp(store, settings).request('/admin/api/github/status', {
            headers: auth(),
          });
          // A garbage key must not 500 the status route: the operator needs
          // the disconnect/replace controls to recover.
          assert.equal(response.status, 200);
          const body = (await response.json()) as { mode: string; installationsUnavailable?: boolean };
          assert.equal(body.mode, 'app');
          assert.equal(body.installationsUnavailable, true);
        }),
    );
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub status stays recoverable when the App key is rejected outright', async () => {
  const { pkcs8 } = rsaKeys();
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  await settings.setSetting('github.app.id', '12345');
  await settings.setSetting('github.app.slug', 'chickpea-test');
  await settings.setSetting('github.app.private_key', pkcs8);
  const fetchImpl: typeof fetch = async () => new Response('bad credentials', { status: 401 });
  try {
    await withEnv(
      { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_PAT: undefined },
      () =>
        withFetch(fetchImpl, async () => {
          const response = await adminApp(store, settings).request('/admin/api/github/status', {
            headers: auth(),
          });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            mode: 'app',
            appSlug: 'chickpea-test',
            installations: [],
            installationsUnavailable: true,
            referencingProfiles: [],
          });
        }),
    );
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub manifest callback refuses missing, mismatched, stale, and replayed state', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let exchanges = 0;
  const fetchImpl: typeof fetch = async () => {
    exchanges += 1;
    return Response.json(
      { id: 1, slug: 'x', pem: 'irrelevant', webhook_secret: 'irrelevant' },
      { status: 201 },
    );
  };
  const request = (query: string) =>
    adminApp(store, settings).request(`/admin/api/github/setup/callback?${query}`, {
      headers: auth(),
      redirect: 'manual',
    });
  try {
    await withFetch(fetchImpl, async () => {
      // No state ever minted.
      assert.equal((await request('code=c1&state=whatever')).status, 403);
      // Mismatched state.
      await settings.setSetting('github.setup_state', `expected:${Date.now()}`);
      assert.equal((await request('code=c2&state=wrong')).status, 403);
      // The mismatch consumed the stored state — a replay with the right value fails too.
      assert.equal((await request('code=c3&state=expected')).status, 403);
      // Stale state (minted 16 minutes ago).
      await settings.setSetting(
        'github.setup_state',
        `stale-state:${Date.now() - 16 * 60 * 1_000}`,
      );
      assert.equal((await request('code=c4&state=stale-state')).status, 403);
    });
    assert.equal(exchanges, 0, 'no rejected callback may reach the code exchange');
    assert.equal(await settings.getSetting('github.app.id'), undefined);
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub status enumerates App installations and live repository counts', async () => {
  const { pkcs8 } = rsaKeys();
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  await settings.setSetting('github.app.id', '12345');
  await settings.setSetting('github.app.slug', 'chickpea-test');
  await settings.setSetting('github.app.private_key', pkcs8);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${GITHUB_API_BASE}/app/installations?per_page=100&page=1`) {
      return Response.json([
        { id: 42, account: { login: 'magoosh', type: 'Organization' } },
      ]);
    }
    if (url === `${GITHUB_API_BASE}/app/installations/42/access_tokens`) {
      return Response.json({ token: 'installation-token', expires_at: '2026-07-21T20:00:00Z' });
    }
    if (url === `${GITHUB_API_BASE}/installation/repositories?per_page=100&page=1`) {
      return Response.json({
        total_count: 2,
        repositories: [
          { full_name: 'magoosh/chickpea', private: false, default_branch: 'main' },
          { full_name: 'magoosh/api', private: true, default_branch: 'main' },
        ],
      });
    }
    return new Response('unexpected request', { status: 500 });
  };
  try {
    await withEnv(
      { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_PAT: undefined },
      () =>
        withFetch(fetchImpl, async () => {
          const response = await adminApp(store, settings).request('/admin/api/github/status', {
            headers: auth(),
          });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            mode: 'app',
            appSlug: 'chickpea-test',
            installations: [
              { id: 42, accountLogin: 'magoosh', accountType: 'Organization', repoCount: 2 },
            ],
            referencingProfiles: [],
          });
        }),
    );
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub PAT repo proxy maps fields, filters by q, and never echoes the token', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const app = adminApp(store, settings);
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(
      String(input),
      `${GITHUB_API_BASE}/user/repos?per_page=100&page=2&affiliation=owner%2Ccollaborator%2Corganization_member`,
    );
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer github-pat-secret');
    return Response.json([
      { full_name: 'Acme/Alpha', private: true, default_branch: 'trunk' },
      { full_name: 'Acme/Beta', private: false, default_branch: 'main' },
    ]);
  };
  try {
    const put = await app.request('/admin/api/github/pat', {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ token: 'github-pat-secret' }),
    });
    assert.equal(put.status, 200);
    assert.doesNotMatch(await put.text(), /github-pat-secret/);

    await withEnv({ GITHUB_PAT: undefined }, () =>
      withFetch(fetchImpl, async () => {
        const response = await app.request(
          '/admin/api/github/installations/pat/repos?q=alpha&page=2',
          { headers: auth() },
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          repos: [{ fullName: 'Acme/Alpha', private: true, defaultBranch: 'trunk' }],
          totalCount: 2,
          truncated: false,
        });
      }),
    );
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub status, PAT, and disconnect routes are admin-auth gated', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const app = adminApp(store, settings);
  try {
    const responses = await Promise.all([
      app.request('/admin/api/github/status'),
      app.request('/admin/api/github/pat', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'must-not-store' }),
      }),
      app.request('/admin/api/github', { method: 'DELETE' }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [401, 401, 401],
    );
    assert.equal(await settings.getSetting('github.pat'), undefined);
  } finally {
    store.close();
    settings.close();
  }
});

test('GitHub disconnect clears credentials and reports profiles with repository grants', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  await settings.setSetting('github.pat', 'github-pat-secret');
  await store.createAgent(
    agent({
      repositories: [
        {
          id: 'repo-alpha',
          installationId: null,
          accountLogin: 'Acme',
          fullName: 'Acme/Alpha',
          enabled: true,
        },
      ],
    }),
  );
  try {
    const response = await adminApp(store, settings).request('/admin/api/github', {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      referencingProfiles: [{ id: 'agent-github', name: 'GitHub profile' }],
    });
    assert.equal(await settings.getSetting('github.pat'), undefined);
  } finally {
    store.close();
    settings.close();
  }
});

test('agent PATCH validates and persists repository grants', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  await store.createAgent(agent());
  const app = adminApp(store, settings);
  const repositories = [
    {
      id: 'repo-alpha',
      installationId: 42,
      accountLogin: 'Acme',
      fullName: 'Acme/Alpha',
      enabled: true,
    },
  ];
  try {
    const response = await app.request('/admin/api/agents/agent-github', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ repositories }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await store.getAgent('agent-github')).repositories, repositories);

    const invalid = await app.request('/admin/api/agents/agent-github', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ repositories: [{ ...repositories[0], enabled: 'yes' }] }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    store.close();
    settings.close();
  }
});
