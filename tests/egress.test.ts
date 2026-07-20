import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildEgressNetworkConfig,
  DEFAULT_EGRESS_POLICY,
  parseEgressPolicy,
} from '../src/config/egress.ts';

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
