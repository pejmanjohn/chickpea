import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activateModelCatalog,
  resetModelCatalogActivationForTests,
  resolveActiveCatalogRoute,
} from '../src/model-catalog/catalog.ts';
import {
  isRevisionedAlias,
  revisionedAlias,
} from '../src/model-catalog/provider-alias.ts';
import { parseModelCatalogBytes } from '../src/model-catalog/schema.ts';
import {
  isOpenAiSubscriptionProviderId,
  openAiSubscriptionModelSpecifier,
} from '../src/openai-subscription/provider.ts';
import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
  revisionedCompatibilityAliases,
} from '../src/model-compat/provider.ts';

const SHA = `${'a'.repeat(53)}bcdef012345`;

function hosted(revision: number, entries: unknown[], sha256: string) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision,
    generatedAt: '2026-08-17T20:00:00Z',
    entries,
  }));
  return { document: parseModelCatalogBytes(bytes), sha256 };
}

test('revisioned aliases keep their published id shape for every family', () => {
  assert.deepEqual(revisionedAlias('openaiPlatform', 42, SHA), {
    providerId: 'chickpea-openai-platform-r42-aaaaaaaaaaaa',
    api: 'chickpea-openai-platform-responses-r42-aaaaaaaaaaaa',
  });
  assert.deepEqual(revisionedAlias('anthropic', 42, SHA), {
    providerId: 'chickpea-anthropic-api-r42-aaaaaaaaaaaa',
    api: 'chickpea-anthropic-messages-r42-aaaaaaaaaaaa',
  });
  assert.deepEqual(revisionedAlias('openaiSubscription', 42, SHA), {
    providerId: 'chickpea-openai-subscription-r42-aaaaaaaaaaaa',
    api: 'chickpea-openai-subscription-responses-r42-aaaaaaaaaaaa',
  });
  assert.deepEqual(
    revisionedCompatibilityAliases('openai', 42, SHA),
    revisionedAlias('openaiPlatform', 42, SHA),
  );
  assert.deepEqual(
    revisionedCompatibilityAliases('anthropic', 42, SHA),
    revisionedAlias('anthropic', 42, SHA),
  );
});

test('an alias identity that no catalog boundary could produce is rejected', () => {
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => revisionedAlias('openaiSubscription', revision, SHA),
      /Invalid model catalog alias identity/,
    );
  }
  for (const sha of ['', 'abc', 'A'.repeat(64), 'z'.repeat(64), 'a'.repeat(63)]) {
    assert.throws(
      () => revisionedAlias('openaiPlatform', 7, sha),
      /Invalid model catalog alias identity/,
    );
  }
});

test('the recognizer accepts only its own family and never a bundled id', () => {
  assert.equal(isRevisionedAlias('openaiPlatform', 'chickpea-openai-platform-r7-abcdef012345'), true);
  assert.equal(isRevisionedAlias('anthropic', 'chickpea-anthropic-api-r7-abcdef012345'), true);
  assert.equal(
    isRevisionedAlias('openaiSubscription', 'chickpea-openai-subscription-r7-abcdef012345'),
    true,
  );

  assert.equal(isRevisionedAlias('openaiPlatform', OPENAI_PLATFORM_COMPAT_PROVIDER_ID), false);
  assert.equal(isRevisionedAlias('anthropic', ANTHROPIC_COMPAT_PROVIDER_ID), false);
  assert.equal(isRevisionedAlias('openaiSubscription', 'openai-subscription'), false);
  assert.equal(
    isRevisionedAlias('openaiPlatform', 'chickpea-anthropic-api-r7-abcdef012345'),
    false,
  );
  // A zero revision, a short digest, and an uppercase digest are all rejected.
  assert.equal(isRevisionedAlias('openaiPlatform', 'chickpea-openai-platform-r0-abcdef012345'), false);
  assert.equal(isRevisionedAlias('openaiPlatform', 'chickpea-openai-platform-r7-abcdef01234'), false);
  assert.equal(isRevisionedAlias('openaiPlatform', 'chickpea-openai-platform-r7-ABCDEF012345'), false);

  assert.equal(isOpenAiSubscriptionProviderId('chickpea-openai-subscription-r7-abcdef012345'), true);
  assert.equal(isOpenAiSubscriptionProviderId('openai-subscription'), true);
  assert.equal(isOpenAiSubscriptionProviderId('chickpea-openai-platform-r7-abcdef012345'), false);
});

test('hosted subscription routing and registration agree on one alias id', () => {
  resetModelCatalogActivationForTests();
  const canonical = 'openai/gpt-subscription-alias-pin';
  const activation = activateModelCatalog(hosted(30, [{
    canonical,
    lanes: { subscription: 'openai-codex-responses-standard@1' },
  }], SHA));
  assert.equal(activation.status, 'activated');

  const route = resolveActiveCatalogRoute(canonical, 'openai_subscription');
  assert.ok(route);
  assert.equal(
    route.modelSpecifier,
    'chickpea-openai-subscription-r30-aaaaaaaaaaaa/gpt-subscription-alias-pin',
  );
  assert.equal(
    openAiSubscriptionModelSpecifier('gpt-subscription-alias-pin', route),
    'chickpea-openai-subscription-r30-aaaaaaaaaaaa/gpt-subscription-alias-pin',
  );
  assert.equal(
    isOpenAiSubscriptionProviderId('chickpea-openai-subscription-r30-aaaaaaaaaaaa'),
    true,
  );
  resetModelCatalogActivationForTests();
});
