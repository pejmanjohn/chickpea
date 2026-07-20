import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bash, InMemoryFs, type SecureFetch } from 'just-bash';

import {
  buildEgressPlan,
  buildEgressNetworkConfig,
  createMethodEnforcingFetch,
  DEFAULT_EGRESS_POLICY,
  parseEgressPolicy,
  type ResolvedApiConnection,
} from '../src/config/egress.ts';

const LINEAR_CONNECTION: ResolvedApiConnection = {
  allowedHosts: ['api.linear.app'],
  pathPrefixes: ['/v1'],
  headerName: 'Authorization',
  headerValue: 'Bearer TOK',
  allowedMethods: ['GET', 'POST'],
};

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

test('buildEgressPlan derives per-prefix methods and sorts longest prefixes first', () => {
  const { methodMap } = buildEgressPlan(
    {
      mode: 'allowlist',
      domains: ['api.linear.app'],
    },
    { cloudflare: false },
    [
      {
        ...LINEAR_CONNECTION,
        pathPrefixes: ['/v1/issues'],
        allowedMethods: ['GET', 'DELETE'],
      },
    ],
  );

  assert.deepEqual(
    methodMap.map(({ prefix, methods }) => ({ prefix, methods: [...methods] })),
    [
      {
        prefix: 'https://api.linear.app/v1/issues',
        methods: ['GET', 'DELETE'],
      },
      {
        prefix: 'https://api.linear.app',
        methods: ['GET', 'HEAD'],
      },
    ],
  );
});

test('createMethodEnforcingFetch rejects disallowed methods before delegating', async () => {
  const calls: Array<{ url: string; options: Parameters<SecureFetch>[1] }> = [];
  const delegate: SecureFetch = async (url, options) => {
    calls.push({ url, options });
    return fetchResult(url);
  };
  const enforcingFetch = createMethodEnforcingFetch(delegate, [
    { prefix: 'https://api.linear.app/v1', methods: new Set(['GET', 'POST']) },
  ]);

  await assert.rejects(
    enforcingFetch('https://api.linear.app/v1/issues/123', { method: 'DELETE' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'MethodNotAllowedError');
      assert.equal(
        error.message,
        "HTTP method 'DELETE' not allowed. Allowed methods: GET, POST",
      );
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('createMethodEnforcingFetch delegates allowed methods and returns the result', async () => {
  const calls: Array<{ url: string; options: Parameters<SecureFetch>[1] }> = [];
  const expected = fetchResult('https://api.linear.app/v1/issues');
  const delegate: SecureFetch = async (url, options) => {
    calls.push({ url, options });
    return expected;
  };
  const enforcingFetch = createMethodEnforcingFetch(delegate, [
    { prefix: 'https://api.linear.app/v1', methods: new Set(['GET']) },
  ]);

  const options = { method: 'get' };
  assert.equal(await enforcingFetch(expected.url, options), expected);
  assert.deepEqual(calls, [{ url: expected.url, options }]);
});

test('createMethodEnforcingFetch delegates URLs that match no prefix', async () => {
  const calls: Array<{ url: string; options: Parameters<SecureFetch>[1] }> = [];
  const expected = fetchResult('https://not-allowlisted.example/resource');
  const delegate: SecureFetch = async (url, options) => {
    calls.push({ url, options });
    return expected;
  };
  const enforcingFetch = createMethodEnforcingFetch(delegate, [
    { prefix: 'https://api.linear.app/v1', methods: new Set(['GET']) },
  ]);

  const options = { method: 'DELETE' };
  assert.equal(await enforcingFetch(expected.url, options), expected);
  assert.deepEqual(calls, [{ url: expected.url, options }]);
});

test('createMethodEnforcingFetch matches prefixes on path-segment boundaries, not raw string prefix', async () => {
  const calls: string[] = [];
  const delegate: SecureFetch = async (url, options) => {
    calls.push((options?.method ?? 'GET') + ' ' + url);
    return fetchResult(url);
  };
  // A connector governs /v1 (GET, DELETE); the whole host is also allowlisted
  // read-only (GET, HEAD) — longest-prefix-first so /v1 is checked before the host.
  const enforcingFetch = createMethodEnforcingFetch(delegate, [
    { prefix: 'https://api.example.com/v1', methods: new Set(['GET', 'DELETE']) },
    { prefix: 'https://api.example.com', methods: new Set(['GET', 'HEAD']) },
  ]);

  // Under the connector prefix: DELETE is allowed and reaches the delegate.
  await enforcingFetch('https://api.example.com/v1/tasks', { method: 'DELETE' });
  assert.deepEqual(calls, ['DELETE https://api.example.com/v1/tasks']);

  // Sibling path /v10 is NOT under /v1 (segment boundary) — it falls to the
  // read-only host entry, so DELETE must be blocked, not leaked from /v1.
  await assert.rejects(
    enforcingFetch('https://api.example.com/v10/x', { method: 'DELETE' }),
    (err: Error) => err.name === 'MethodNotAllowedError',
  );
  // A GET on the same sibling path is fine (host allows GET/HEAD).
  await enforcingFetch('https://api.example.com/v10/x', { method: 'GET' });
  assert.deepEqual(calls.length, 2);
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
