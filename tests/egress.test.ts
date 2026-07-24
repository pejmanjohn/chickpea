import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Bash, InMemoryFs, type SecureFetch } from 'just-bash';

import {
  mergeRepositoryAndApiConnectors,
  resolveRepositoryAccess,
} from '../src/agents/slack-thread.ts';
import {
  buildEgressPlan,
  buildEgressNetworkConfig,
  createScopedFetch,
  DEFAULT_EGRESS_POLICY,
  parseEgressPolicy,
  type ResolvedApiConnection,
} from '../src/config/egress.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { RepositoryGrant } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const LINEAR_CONNECTION: ResolvedApiConnection = {
  allowedHosts: ['api.linear.app'],
  pathPrefixes: ['/v1'],
  headerName: 'Authorization',
  headerValue: 'Bearer TOK',
  allowedMethods: ['GET', 'POST'],
};

const APP_PRIVATE_KEY = String(
  generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }),
);

function repositoryGrant(overrides: Partial<RepositoryGrant> = {}): RepositoryGrant {
  return {
    id: 'repo-alpha',
    installationId: 50_001,
    accountLogin: 'Acme',
    fullName: 'Acme/Alpha',
    enabled: true,
    ...overrides,
  };
}

async function withGithubSettings<T>(
  values: Partial<Record<(typeof GITHUB_SETTING_KEYS)[keyof typeof GITHUB_SETTING_KEYS], string>>,
  run: () => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-repository-runtime-'));
  const dbPath = join(dir, 'state.db');
  const settings = new SqliteSettingsStore(dbPath);
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) await settings.setSetting(key, value);
    }
    return await withEnv(
      {
        SLACK_STATE_DB_PATH: dbPath,
        GITHUB_APP_ID: undefined,
        GITHUB_APP_PRIVATE_KEY: undefined,
      },
      run,
    );
  } finally {
    settings.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function connectorUrl(url: string) {
  return {
    url,
    transform: [{ headers: { Authorization: 'Bearer TOK' } }],
  };
}

test('DEFAULT_EGRESS_POLICY denies egress until domains are allowlisted', () => {
  assert.deepEqual(DEFAULT_EGRESS_POLICY, { mode: 'allowlist', domains: [] });
});

test('parseEgressPolicy returns the default for missing or invalid settings', () => {
  assert.deepEqual(parseEgressPolicy(undefined), DEFAULT_EGRESS_POLICY);
  assert.deepEqual(parseEgressPolicy('{not json'), DEFAULT_EGRESS_POLICY);
  assert.deepEqual(
    parseEgressPolicy(JSON.stringify({ mode: 'invalid', domains: [] })),
    DEFAULT_EGRESS_POLICY,
  );
  assert.deepEqual(
    parseEgressPolicy(JSON.stringify({ mode: 'open', domains: 'api.github.com' })),
    DEFAULT_EGRESS_POLICY,
  );
});

test('parseEgressPolicy accepts valid settings and normalizes domains', () => {
  assert.deepEqual(parseEgressPolicy('{"mode":"open","domains":[]}'), {
    mode: 'open',
    domains: [],
  });
  assert.deepEqual(
    parseEgressPolicy(
      JSON.stringify({
        mode: 'allowlist',
        domains: [' api.github.com ', 'api.github.com', ''],
      }),
    ),
    { mode: 'allowlist', domains: ['api.github.com'] },
  );
});

test('buildEgressNetworkConfig builds a Node allowlist without a DNS override', () => {
  const network = buildEgressNetworkConfig(
    {
      mode: 'allowlist',
      domains: ['api.github.com', 'https://example.com'],
    },
    { cloudflare: false },
  );

  assert.deepEqual(network.allowedUrlPrefixes, [
    'https://api.github.com',
    'https://example.com',
  ]);
  assert.equal(network.denyPrivateRanges, true);
  assert.deepEqual(network.allowedMethods, ['GET', 'HEAD', 'POST']);
  assert.equal('_dnsResolve' in network, false);
});

test('buildEgressNetworkConfig attaches the DoH resolver on Cloudflare', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'allowlist', domains: [] },
    { cloudflare: true },
  );

  assert.equal(typeof network._dnsResolve, 'function');
});

test('buildEgressNetworkConfig blocks all egress in off mode', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'off', domains: ['api.github.com'] },
    { cloudflare: false },
  );

  assert.deepEqual(network.allowedUrlPrefixes, []);
});

test('buildEgressNetworkConfig keeps private-range protection in open mode', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'open', domains: [] },
    { cloudflare: false },
  );

  assert.equal(network.dangerouslyAllowFullInternetAccess, true);
  assert.equal(network.denyPrivateRanges, true);
  assert.equal('allowedUrlPrefixes' in network, false);
});

test('buildEgressNetworkConfig appends connector transforms in allowlist mode', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'allowlist', domains: ['api.github.com'] },
    { cloudflare: false },
    [LINEAR_CONNECTION],
  );

  assert.deepEqual(network.allowedUrlPrefixes, [
    'https://api.github.com',
    connectorUrl('https://api.linear.app/v1'),
  ]);
  assert.deepEqual(network.allowedMethods, ['GET', 'HEAD', 'POST']);
});

test('buildEgressNetworkConfig allows only connector transforms in off mode', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'off', domains: ['api.github.com'] },
    { cloudflare: false },
    [LINEAR_CONNECTION],
  );

  assert.deepEqual(network.allowedUrlPrefixes, [connectorUrl('https://api.linear.app/v1')]);
});

test('buildEgressNetworkConfig appends connector transforms in open mode', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'open', domains: [] },
    { cloudflare: false },
    [LINEAR_CONNECTION],
  );

  assert.equal(network.dangerouslyAllowFullInternetAccess, true);
  assert.deepEqual(network.allowedUrlPrefixes, [connectorUrl('https://api.linear.app/v1')]);
});

test('buildEgressNetworkConfig builds the connector host and path cartesian product', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'off', domains: [] },
    { cloudflare: false },
    [
      {
        ...LINEAR_CONNECTION,
        allowedHosts: ['api.linear.app', 'uploads.linear.app'],
        pathPrefixes: ['/v1', '/v2'],
      },
    ],
  );

  assert.deepEqual(network.allowedUrlPrefixes, [
    connectorUrl('https://api.linear.app/v1'),
    connectorUrl('https://api.linear.app/v2'),
    connectorUrl('https://uploads.linear.app/v1'),
    connectorUrl('https://uploads.linear.app/v2'),
  ]);
});

test('buildEgressNetworkConfig uses each connector host when path prefixes are empty', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'off', domains: [] },
    { cloudflare: false },
    [
      {
        ...LINEAR_CONNECTION,
        allowedHosts: ['api.linear.app', 'uploads.linear.app'],
        pathPrefixes: [],
      },
    ],
  );

  assert.deepEqual(network.allowedUrlPrefixes, [
    connectorUrl('https://api.linear.app'),
    connectorUrl('https://uploads.linear.app'),
  ]);
});

test('buildEgressNetworkConfig widens the global method union for connectors', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'off', domains: [] },
    { cloudflare: false },
    [{ ...LINEAR_CONNECTION, allowedMethods: ['GET', 'DELETE'] }],
  );

  assert.deepEqual(network.allowedMethods, ['GET', 'HEAD', 'POST', 'DELETE']);
});

test('buildEgressNetworkConfig skips connector entries with empty credentials', () => {
  const network = buildEgressNetworkConfig(
    { mode: 'off', domains: [] },
    { cloudflare: false },
    [{ ...LINEAR_CONNECTION, headerValue: '', allowedMethods: ['DELETE'] }],
  );

  assert.deepEqual(network.allowedUrlPrefixes, []);
  assert.deepEqual(network.allowedMethods, ['GET', 'HEAD', 'POST', 'DELETE']);
});

test('buildEgressPlan builds an isolated per-connector scope', () => {
  const { scopes, baseNetwork, baseMethods } = buildEgressPlan(
    { mode: 'allowlist', domains: ['api.linear.app'] },
    { cloudflare: false },
    [{ ...LINEAR_CONNECTION, pathPrefixes: ['/v1/issues'], allowedMethods: ['GET', 'DELETE'] }],
  );

  // One scope for the connector: its prefixes, its methods, and a network whose
  // allow-list is ONLY the connector's own host (with the credential transform) —
  // no domains, no full internet — so a redirect cannot escape to another host.
  assert.equal(scopes.length, 1);
  const [scope] = scopes;
  assert.ok(scope);
  assert.deepEqual(scope.prefixes, ['https://api.linear.app/v1/issues']);
  assert.deepEqual([...scope.methods].sort(), ['DELETE', 'GET']);
  assert.deepEqual(scope.network.allowedUrlPrefixes, [
    connectorUrl('https://api.linear.app/v1/issues'),
  ]);
  assert.deepEqual(scope.network.allowedMethods, ['GET', 'DELETE']);
  assert.equal(scope.network.dangerouslyAllowFullInternetAccess, undefined);
  assert.equal(scope.network.denyPrivateRanges, true);

  // The operator domain rides the base network at the GET/HEAD baseline, with no
  // credential transform attached.
  assert.deepEqual([...baseMethods].sort(), ['GET', 'HEAD']);
  assert.deepEqual(baseNetwork.allowedUrlPrefixes, ['https://api.linear.app']);
  assert.deepEqual(baseNetwork.allowedMethods, ['GET', 'HEAD']);
});

test('buildEgressPlan normalizes trailing-slash prefixes so routing and enforcement agree', () => {
  const { scopes } = buildEgressPlan(
    { mode: 'off', domains: [] },
    { cloudflare: false },
    [{ ...LINEAR_CONNECTION, pathPrefixes: ['/v1/'], allowedMethods: ['GET', 'DELETE'] }],
  );

  assert.equal(scopes.length, 1);
  const [scope] = scopes;
  assert.ok(scope);
  // The route prefix and the network allow-list entry must be the SAME
  // normalized string, or a request to /v1/... would route into a scope whose
  // just-bash network then rejects it.
  assert.deepEqual(scope.prefixes, ['https://api.linear.app/v1']);
  assert.deepEqual(scope.network.allowedUrlPrefixes, [
    connectorUrl('https://api.linear.app/v1'),
  ]);
});

test('buildEgressPlan keeps connector scopes off the open internet and fails closed on fallback', () => {
  const { scopes, baseNetwork, baseMethods, fallbackNetwork } = buildEgressPlan(
    { mode: 'open', domains: [] },
    { cloudflare: false },
    [{ ...LINEAR_CONNECTION, allowedMethods: ['GET', 'DELETE'] }],
  );

  // Open mode: the base network reaches the whole internet at the create/read
  // baseline (GET/HEAD/POST).
  assert.equal(baseNetwork.dangerouslyAllowFullInternetAccess, true);
  assert.deepEqual([...baseMethods].sort(), ['GET', 'HEAD', 'POST']);

  // The connector scope is NOT open-internet — only its own host, its methods.
  assert.equal(scopes.length, 1);
  const [scope] = scopes;
  assert.ok(scope);
  assert.equal(scope.network.dangerouslyAllowFullInternetAccess, undefined);
  assert.deepEqual(scope.network.allowedMethods, ['GET', 'DELETE']);

  // Fallback (only if just-bash stops exposing secureFetch): every prefix but
  // capped at the baseline methods, so connector writes are never global.
  assert.deepEqual(fallbackNetwork.allowedMethods, ['GET', 'HEAD', 'POST']);
  assert.equal(fallbackNetwork.dangerouslyAllowFullInternetAccess, true);
});

test('createScopedFetch rejects a method the matched scope does not allow', async () => {
  const calls: Array<{ url: string; options: Parameters<SecureFetch>[1] }> = [];
  const delegate: SecureFetch = async (url, options) => {
    calls.push({ url, options });
    return fetchResult(url);
  };
  const scopedFetch = createScopedFetch({
    scopes: [
      { prefixes: ['https://api.linear.app/v1'], methods: new Set(['GET', 'POST']), delegate },
    ],
    baseDelegate: delegate,
    baseMethods: new Set(['GET', 'HEAD']),
  });

  await assert.rejects(
    scopedFetch('https://api.linear.app/v1/issues/123', { method: 'DELETE' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'MethodNotAllowedError');
      assert.equal(error.message, "HTTP method 'DELETE' not allowed. Allowed methods: GET, POST");
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('createScopedFetch delegates an allowed method and returns the result', async () => {
  const calls: Array<{ url: string; options: Parameters<SecureFetch>[1] }> = [];
  const expected = fetchResult('https://api.linear.app/v1/issues');
  const delegate: SecureFetch = async (url, options) => {
    calls.push({ url, options });
    return expected;
  };
  const scopedFetch = createScopedFetch({
    scopes: [{ prefixes: ['https://api.linear.app/v1'], methods: new Set(['GET']), delegate }],
    baseDelegate: delegate,
    baseMethods: new Set(['GET', 'HEAD']),
  });

  const options = { method: 'get' };
  assert.equal(await scopedFetch(expected.url, options), expected);
  assert.deepEqual(calls, [{ url: expected.url, options }]);
});

test('createScopedFetch routes each host to its own scope delegate', async () => {
  // The isolation that closes the redirect method-bypass: a request to one
  // connector's host is handled ONLY by that connector's delegate (whose network
  // allow-lists just its own hosts), never another scope's or the base delegate's.
  const hitAsana: string[] = [];
  const hitGithub: string[] = [];
  const hitBase: string[] = [];
  const record = (into: string[]): SecureFetch => async (url, options) => {
    into.push((options?.method ?? 'GET') + ' ' + url);
    return fetchResult(url);
  };
  const scopedFetch = createScopedFetch({
    scopes: [
      { prefixes: ['https://api.asana.com'], methods: new Set(['GET', 'DELETE']), delegate: record(hitAsana) },
      { prefixes: ['https://api.github.com'], methods: new Set(['GET']), delegate: record(hitGithub) },
    ],
    baseDelegate: record(hitBase),
    baseMethods: new Set(['GET', 'HEAD']),
  });

  await scopedFetch('https://api.asana.com/tasks', { method: 'DELETE' });
  await scopedFetch('https://api.github.com/repos', { method: 'GET' });
  await scopedFetch('https://example.com/x', { method: 'GET' });

  assert.deepEqual(hitAsana, ['DELETE https://api.asana.com/tasks']);
  assert.deepEqual(hitGithub, ['GET https://api.github.com/repos']);
  assert.deepEqual(hitBase, ['GET https://example.com/x']);
});

test('createScopedFetch matches prefixes on path-segment boundaries, longest first', async () => {
  const calls: string[] = [];
  const delegate: SecureFetch = async (url, options) => {
    calls.push((options?.method ?? 'GET') + ' ' + url);
    return fetchResult(url);
  };
  const scopedFetch = createScopedFetch({
    scopes: [
      { prefixes: ['https://api.example.com/v1'], methods: new Set(['GET', 'DELETE']), delegate },
      { prefixes: ['https://api.example.com'], methods: new Set(['GET', 'HEAD']), delegate },
    ],
    baseDelegate: delegate,
    baseMethods: new Set(['GET', 'HEAD']),
  });

  // Under /v1: DELETE allowed. Sibling /v10 is NOT under /v1 (segment boundary),
  // so it falls to the read-only host scope and DELETE is blocked, not leaked.
  await scopedFetch('https://api.example.com/v1/tasks', { method: 'DELETE' });
  await assert.rejects(
    scopedFetch('https://api.example.com/v10/x', { method: 'DELETE' }),
    (err: Error) => err.name === 'MethodNotAllowedError',
  );
  await scopedFetch('https://api.example.com/v10/x', { method: 'GET' });
  assert.deepEqual(calls, [
    'DELETE https://api.example.com/v1/tasks',
    'GET https://api.example.com/v10/x',
  ]);
});

test('createScopedFetch fails closed when a scope guard rejects a matching URL', async () => {
  const scopeCalls: string[] = [];
  const baseCalls: string[] = [];
  const scopeDelegate: SecureFetch = async (url) => {
    scopeCalls.push(String(url));
    return fetchResult(url);
  };
  const baseDelegate: SecureFetch = async (url) => {
    baseCalls.push(String(url));
    return fetchResult(url);
  };
  const scopedFetch = createScopedFetch({
    scopes: [
      {
        prefixes: ['https://api.github.com/repos/Acme/Alpha'],
        methods: new Set(['GET', 'POST']),
        delegate: scopeDelegate,
        matchesRequest: (url) => !url.includes('/dispatches'),
      },
    ],
    baseDelegate,
    baseMethods: new Set(['GET', 'HEAD', 'POST']),
  });

  await scopedFetch('https://api.github.com/repos/Acme/Alpha/pulls', { method: 'POST' });
  // A guard rejection is a policy denial: it must throw, never retry the same
  // URL through the base delegate (where operator Domains could admit it).
  await assert.rejects(
    scopedFetch('https://api.github.com/repos/Acme/Alpha/dispatches', { method: 'POST' }),
    (err: Error) => err.name === 'BlockedUrlError',
  );
  assert.deepEqual(scopeCalls, ['https://api.github.com/repos/Acme/Alpha/pulls']);
  assert.deepEqual(baseCalls, []);
});

test('guarded scopes are excluded from the fallback network allow-list', async () => {
  await withGithubSettings(
    {
      [GITHUB_SETTING_KEYS.appId]: 'fallback-exclusion-app',
      [GITHUB_SETTING_KEYS.privateKey]: APP_PRIVATE_KEY,
    },
    async () => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        Response.json({
          token: 'fallback-exclusion-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        });
      try {
        const access = await resolveRepositoryAccess([repositoryGrant()]);
        const plan = buildEgressPlan(
          { mode: 'off', domains: [] },
          { cloudflare: false },
          access.connectors,
        );
        const fallbackUrls = (plan.fallbackNetwork.allowedUrlPrefixes ?? []).map((entry) =>
          typeof entry === 'string' ? entry : entry.url,
        );
        // The guarded scopes (/repos and /search/code carry URL predicates) must
        // not contribute prefix+transform entries a flat allow-list cannot guard.
        assert.ok(!fallbackUrls.some((url) => url.includes('/repos/')), String(fallbackUrls));
        assert.ok(!fallbackUrls.some((url) => url.includes('/search/code')), String(fallbackUrls));
        // The unguarded github.com git scope stays available in fallback mode.
        assert.ok(fallbackUrls.includes('https://github.com/Acme/Alpha'), String(fallbackUrls));
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  );
});

test('createScopedFetch holds unmatched (open-mode) hosts to the base method set', async () => {
  const calls: string[] = [];
  const delegate: SecureFetch = async (url, options) => {
    calls.push((options?.method ?? 'GET') + ' ' + url);
    return fetchResult(url);
  };
  const scopedFetch = createScopedFetch({
    scopes: [
      { prefixes: ['https://api.asana.com'], methods: new Set(['GET', 'DELETE']), delegate },
    ],
    baseDelegate: delegate,
    baseMethods: new Set(['GET', 'HEAD', 'POST']),
  });

  // Connector host keeps its DELETE; an arbitrary open-mode host does not inherit
  // it and is held to the base set (POST allowed, DELETE not).
  await scopedFetch('https://api.asana.com/tasks', { method: 'DELETE' });
  await assert.rejects(
    scopedFetch('https://evil.example.com/wipe', { method: 'DELETE' }),
    (err: Error) => err.name === 'MethodNotAllowedError',
  );
  await scopedFetch('https://evil.example.com/x', { method: 'POST' });
  assert.deepEqual(calls, [
    'DELETE https://api.asana.com/tasks',
    'POST https://evil.example.com/x',
  ]);
});

test('repository access fails closed without a GitHub App and rejects malformed legacy grants', async () => {
  await withGithubSettings({}, async () => {
    const disconnected = await resolveRepositoryAccess([repositoryGrant()]);
    assert.deepEqual(disconnected, { grants: [], connectors: [], governsGithubHosts: true });

    // A malformed persisted name (dot segment) must never become a URL
    // prefix — `Acme/..` would normalize into a match for EVERY repository.
    // The grant is dropped at runtime, but grants still govern the hosts.
    const malformed = await resolveRepositoryAccess([
      repositoryGrant({ id: 'dotdot', installationId: null, fullName: 'Acme/..' }),
    ]);
    assert.deepEqual(malformed, { grants: [], connectors: [], governsGithubHosts: true });

    const absent = await resolveRepositoryAccess([]);
    assert.deepEqual(absent, { grants: [], connectors: [], governsGithubHosts: false });
    // Snapshots persisted before repository grants existed rehydrate without
    // the field at all — the resolver must treat that exactly like [].
    const legacy = await resolveRepositoryAccess(undefined);
    assert.deepEqual(legacy, { grants: [], connectors: [], governsGithubHosts: false });
    assert.equal(
      buildEgressPlan({ mode: 'off', domains: [] }, { cloudflare: false }, absent.connectors)
        .scopes.length,
      0,
    );
  });
});

test('App repository access groups grants, uses short sorted names, and caps permissions', async () => {
  await withGithubSettings(
    {
      [GITHUB_SETTING_KEYS.appId]: 'runtime-app',
      [GITHUB_SETTING_KEYS.privateKey]: APP_PRIVATE_KEY,
    },
    async () => {
      const previousFetch = globalThis.fetch;
      const requests: Array<{ installationId: number; body: Record<string, unknown> }> = [];
      globalThis.fetch = async (input, init) => {
        const match = String(input).match(/\/app\/installations\/(\d+)\/access_tokens$/);
        assert.ok(match?.[1], String(input));
        const installationId = Number(match[1]);
        requests.push({
          installationId,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          token: `installation-token-${installationId}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        });
      };
      try {
        const grants = [
          repositoryGrant({ id: 'zeta', fullName: 'Acme/Zeta' }),
          repositoryGrant({ id: 'alpha', fullName: 'Acme/Alpha' }),
          repositoryGrant({
            id: 'all-example',
            installationId: 50_002,
            accountLogin: 'ExampleOrg',
            fullName: '',
            allRepos: true,
          }),
          repositoryGrant({
            id: 'explicit-ignored-by-all',
            installationId: 50_002,
            accountLogin: 'ExampleOrg',
            fullName: 'ExampleOrg/One',
          }),
        ];

        const access = await resolveRepositoryAccess(grants);

        assert.deepEqual(access.grants, grants);
        assert.deepEqual(
          requests.sort((left, right) => left.installationId - right.installationId),
          [
            {
              installationId: 50_001,
              body: {
                repositories: ['Alpha', 'Zeta'],
                permissions: {
                  contents: 'write',
                  pull_requests: 'write',
                  issues: 'write',
                  metadata: 'read',
                  actions: 'write',
                },
              },
            },
            {
              installationId: 50_002,
              body: {
                permissions: {
                  contents: 'write',
                  pull_requests: 'write',
                  issues: 'write',
                  metadata: 'read',
                  actions: 'write',
                },
              },
            },
          ],
        );
        assert.equal(access.connectors.length, 6);
        assert.deepEqual(
          access.connectors.map((connector) => connector.allowedHosts),
          [
            ['api.github.com'],
            ['github.com'],
            ['api.github.com'],
            ['api.github.com'],
            ['github.com'],
            ['api.github.com'],
          ],
        );

        const plan = buildEgressPlan(
          { mode: 'off', domains: [] },
          { cloudflare: false },
          access.connectors,
        );
        const routed: string[] = [];
        const scopedFetch = createScopedFetch({
          scopes: plan.scopes.map((scope, index) => ({
            prefixes: scope.prefixes,
            methods: scope.methods,
            ...(scope.matchesRequest ? { matchesRequest: scope.matchesRequest } : {}),
            delegate: (async (url) => {
              routed.push(`${access.connectors[index]?.headerValue}|${url}`);
              return fetchResult(url);
            }) as SecureFetch,
          })),
          baseDelegate: (async (url) => {
            routed.push(`base|${url}`);
            return fetchResult(url);
          }) as SecureFetch,
          baseMethods: new Set(['GET']),
        });

        await scopedFetch('https://api.github.com/repos/Acme/Alpha/contents/README.md');
        await scopedFetch('https://github.com/Acme/Zeta.git/info/refs');
        await scopedFetch(
          'https://api.github.com/search/code?q=runtime%20repo%3AExampleOrg%2FOne',
        );
        await scopedFetch('https://api.github.com/repos/ExampleOrg/Two/pulls');
        // A search outside every grant is a policy denial: it must be blocked
        // outright, never retried through the base delegate (fail closed).
        await assert.rejects(
          scopedFetch('https://api.github.com/search/code?q=repo%3AUnlisted%2FRepo'),
          (err: Error) => err.name === 'BlockedUrlError',
        );

        assert.deepEqual(routed, [
          'Bearer installation-token-50001|https://api.github.com/repos/Acme/Alpha/contents/README.md',
          'Bearer installation-token-50001|https://github.com/Acme/Zeta.git/info/refs',
          'Bearer installation-token-50002|https://api.github.com/search/code?q=runtime%20repo%3AExampleOrg%2FOne',
          'Bearer installation-token-50002|https://api.github.com/repos/ExampleOrg/Two/pulls',
        ]);
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  );
});

test('an App token mint failure logs and omits only that installation for the turn', async () => {
  await withGithubSettings(
    {
      [GITHUB_SETTING_KEYS.appId]: 'degrade-app',
      [GITHUB_SETTING_KEYS.privateKey]: APP_PRIVATE_KEY,
    },
    async () => {
      const previousFetch = globalThis.fetch;
      const previousWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
      globalThis.fetch = async (input) =>
        String(input).includes('/50004/')
          ? new Response('failed', { status: 500 })
          : Response.json({
              token: 'successful-installation-token',
              expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
            });
      try {
        const kept = repositoryGrant({
          id: 'kept',
          installationId: 50_003,
          fullName: 'Acme/Kept',
        });
        const skipped = repositoryGrant({
          id: 'skipped',
          installationId: 50_004,
          fullName: 'Acme/Skipped',
        });
        const access = await resolveRepositoryAccess([kept, skipped]);

        assert.deepEqual(access.grants, [kept]);
        assert.equal(access.connectors.length, 3);
        assert.equal(access.governsGithubHosts, true);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0] ?? '', /installation 50004 skipped/i);
        assert.doesNotMatch(warnings[0] ?? '', /successful-installation-token/);

        // Even a full mint wipe-out keeps repository routing authoritative so
        // the merge step still strips GitHub hosts from legacy connectors.
        // Fresh installation ids avoid the warm token cache from above.
        globalThis.fetch = async () => new Response('failed', { status: 500 });
        const wipedOut = await resolveRepositoryAccess([
          repositoryGrant({ id: 'cold-a', installationId: 60_001, fullName: 'Acme/ColdA' }),
          repositoryGrant({ id: 'cold-b', installationId: 60_002, fullName: 'Acme/ColdB' }),
        ]);
        assert.deepEqual(wipedOut.grants, []);
        assert.deepEqual(wipedOut.connectors, []);
        assert.equal(wipedOut.governsGithubHosts, true);
      } finally {
        console.warn = previousWarn;
        globalThis.fetch = previousFetch;
      }
    },
  );
});

test('a stale grant is isolated per-repo instead of disabling its installation', async () => {
  await withGithubSettings(
    {
      [GITHUB_SETTING_KEYS.appId]: 'salvage-app',
      [GITHUB_SETTING_KEYS.privateKey]: APP_PRIVATE_KEY,
    },
    async () => {
      const previousFetch = globalThis.fetch;
      const previousWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
      // GitHub 422s any mint whose repository list names the deleted repo.
      globalThis.fetch = async (_input, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const repos: string[] = body.repositories ?? [];
        if (repos.includes('Deleted')) {
          return new Response('{"message":"Validation Failed"}', { status: 422 });
        }
        return Response.json({
          token: `salvaged-${repos.join('+')}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        });
      };
      try {
        const healthy = repositoryGrant({
          id: 'healthy',
          installationId: 70_001,
          fullName: 'Acme/Healthy',
        });
        const stale = repositoryGrant({
          id: 'stale',
          installationId: 70_001,
          fullName: 'Acme/Deleted',
        });
        const access = await resolveRepositoryAccess([healthy, stale]);

        assert.deepEqual(access.grants, [healthy]);
        assert.equal(access.governsGithubHosts, true);
        const prefixes = access.connectors.flatMap((connector) => connector.pathPrefixes);
        assert.ok(prefixes.includes('/repos/Acme/Healthy'), String(prefixes));
        assert.ok(!prefixes.includes('/repos/Acme/Deleted'), String(prefixes));
        assert.ok(
          warnings.some((line) => /Acme\/Deleted skipped/.test(line)),
          warnings.join('\n'),
        );

        // Salvage is for validation rejections only: an outage (5xx) must not
        // amplify into one request per grant.
        let outageMints = 0;
        globalThis.fetch = async () => {
          outageMints += 1;
          return new Response('unavailable', { status: 503 });
        };
        const outage = await resolveRepositoryAccess([
          repositoryGrant({ id: 'o-a', installationId: 71_001, fullName: 'Acme/OutA' }),
          repositoryGrant({ id: 'o-b', installationId: 71_001, fullName: 'Acme/OutB' }),
        ]);
        assert.deepEqual(outage.grants, []);
        assert.equal(outage.governsGithubHosts, true);
        assert.equal(outageMints, 1, 'a 503 must trigger exactly one grouped mint');
      } finally {
        console.warn = previousWarn;
        globalThis.fetch = previousFetch;
      }
    },
  );
});

test('the GitHub App integration always reserves GitHub hosts from custom connectors', () => {
  const repositoryConnector: ResolvedApiConnection = {
    allowedHosts: ['api.github.com'],
    pathPrefixes: ['/repos/Acme/Alpha'],
    headerName: 'Authorization',
    headerValue: 'Bearer installation-token',
    allowedMethods: ['GET'],
  };
  const legacyConnector: ResolvedApiConnection = {
    allowedHosts: ['API.GITHUB.COM', 'github.com', 'api.example.com'],
    pathPrefixes: ['/repos'],
    headerName: 'Authorization',
    headerValue: 'Bearer broad-token',
    allowedMethods: ['GET', 'POST'],
  };

  assert.deepEqual(
    mergeRepositoryAndApiConnectors([repositoryConnector], [legacyConnector]),
    [repositoryConnector, { ...legacyConnector, allowedHosts: ['api.example.com'] }],
  );
  const withoutGrants = mergeRepositoryAndApiConnectors([], [legacyConnector]);
  assert.deepEqual(withoutGrants, [
    { ...legacyConnector, allowedHosts: ['api.example.com'] },
  ]);

  // An already-saved GitHub-only custom connector with zero grants contributes
  // no credential-bearing egress scope or transform.
  const githubOnly = { ...legacyConnector, allowedHosts: ['api.github.com'] };
  const plan = buildEgressPlan(
    { mode: 'off', domains: [] },
    { cloudflare: false },
    mergeRepositoryAndApiConnectors([], [githubOnly]),
  );
  assert.deepEqual(plan.scopes, []);
  assert.deepEqual(plan.baseNetwork.allowedUrlPrefixes, []);
});

test('the repos scope refuses denied Actions endpoints while keeping rerun and cancel', async () => {
  await withGithubSettings({
    [GITHUB_SETTING_KEYS.appId]: 'endpoint-guard-app',
    [GITHUB_SETTING_KEYS.privateKey]: APP_PRIVATE_KEY,
  }, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        token: 'endpoint-guard-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      });
    try {
    const access = await resolveRepositoryAccess([repositoryGrant()]);
    const reposScope = access.connectors.find((connector) =>
      connector.pathPrefixes.some((prefix) => prefix.startsWith('/repos/')),
    );
    assert.ok(reposScope?.matchesRequest, 'repos scope must carry an endpoint guard');
    const guard = reposScope.matchesRequest;
    const base = 'https://api.github.com/repos/Acme/Alpha';
    for (const denied of [
      `${base}/dispatches`, // repository_dispatch
      `${base}/actions/workflows/ci.yml/dispatches`,
      `${base}/actions/workflows/ci.yml/enable`,
      `${base}/actions/workflows/ci.yml/disable`,
      `${base}/actions/runs/7/approve`,
      `${base}/actions/runs/7/pending_deployments`,
      `${base}/actions/runs/7/pending_deployments/`, // trailing slash must not bypass
      `${base}/actions/runs/7/deployment_protection_rule`, // custom protection-rule approvals
      'not a url',
    ]) {
      assert.equal(guard(denied), false, denied);
    }
    for (const allowed of [
      `${base}/actions/runs`,
      `${base}/actions/runs/7/rerun`,
      `${base}/actions/runs/7/rerun-failed-jobs`,
      `${base}/actions/runs/7/cancel`,
      `${base}/actions/runs/7/jobs`,
      `${base}/contents/README.md`,
      `${base}/pulls`,
      `${base}/git/refs`,
    ]) {
      assert.equal(guard(allowed), true, allowed);
    }

    const searchScope = access.connectors.find((connector) =>
      connector.pathPrefixes.includes('/search/code'),
    );
    assert.ok(searchScope?.matchesRequest, 'search scope must carry a query guard');
    const searchGuard = searchScope.matchesRequest;
    const granted = 'https://api.github.com/search/code?q=secret+repo%3AAcme%2FAlpha';
    assert.equal(searchGuard(granted), true);
    // Duplicate q params must be rejected outright: the guard validates one
    // value while GitHub may evaluate another.
    assert.equal(
      searchGuard(`${granted}&q=secret+repo%3AAcme%2FPrivate`),
      false,
      'duplicate q must not pass the code-search guard',
    );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('just-bash exposes its generated secure fetch on Bash instances', () => {
  const instance = new Bash({
    fs: new InMemoryFs(),
    network: { allowedUrlPrefixes: [] },
  }) as unknown as { secureFetch?: SecureFetch };

  assert.equal(typeof instance.secureFetch, 'function');
});

function fetchResult(url: string) {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    body: new Uint8Array(),
    url,
  };
}
