import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildEgressNetworkConfig,
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
