import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { USAGE_PROVIDER_GUIDANCE } from '../../src/usage/provider-guidance.ts';

test('provider guidance covers every current route without introducing provider controls', () => {
  const matrix = JSON.parse(readFileSync(
    new URL('../fixtures/usage/provider-route-matrix.json', import.meta.url),
    'utf8',
  )) as { routes: Array<{ provider: string }> };
  const expected = [...new Set(matrix.routes.map((route) => route.provider))].sort();
  const actual = USAGE_PROVIDER_GUIDANCE.map((provider) => provider.providerId).sort();
  assert.deepEqual(actual, expected);
  for (const provider of USAGE_PROVIDER_GUIDANCE) {
    if (provider.providerId === 'custom') {
      assert.equal(provider.limitsUrl, null);
      assert.equal(provider.pricingUrl, null);
      assert.equal(provider.runtimeCoverage, 'operations_only');
    } else {
      assert.match(provider.limitsUrl ?? '', /^https:\/\//);
      assert.match(provider.pricingUrl ?? '', /^https:\/\//);
    }
    assert.ok(provider.scopeGuidance.length > 20);
    assert.ok(provider.accountBoundary.length > 20);
  }
  assert.equal(
    USAGE_PROVIDER_GUIDANCE.find((provider) => provider.providerId === 'openrouter')?.limitsUrl,
    'https://openrouter.ai/docs/api/api-reference/api-keys/create-keys',
  );
  const binding = USAGE_PROVIDER_GUIDANCE.find((provider) => provider.providerId === 'cloudflare');
  assert.equal(binding?.runtimeCoverage, 'mixed');
  assert.equal(binding?.priceCoverage, 'release_pinned');
  const serialized = JSON.stringify(USAGE_PROVIDER_GUIDANCE);
  assert.doesNotMatch(serialized, /clientSecret|adminKey|billingCredential|syncNow|setLimit|updateLimit/);
});
