import assert from 'node:assert/strict';
import { test } from 'node:test';

import { safeRuntimeModelRouteEvidence } from '../src/config/runtime-model.ts';
import { activateBundledModelCatalog } from '../src/model-catalog/index.ts';

test('safe route evidence freezes canonical catalog, lane, profile, and credential facts', () => {
  activateBundledModelCatalog();
  const platform = safeRuntimeModelRouteEvidence(
    'openai/gpt-5.6-sol',
    'openai_api_key',
    {
      credentialRefId: 'cred_openai_fixture',
      version: 7,
      providerId: 'openai',
      sourceKind: 'stored',
      label: 'Stored OpenAI credential',
      scopeLabel: null,
      unknownRotation: false,
    },
  );
  assert.deepEqual(platform, {
    providerAuthRoute: 'openai_api_key',
    catalogSource: 'bundled',
    catalogRevision: '0',
    catalogDigest: '7e72e7440fbdedfc3b6fb181aa69aee1c0055f74af991d33f4f7e6074918591d',
    compiledProfile: 'openai-platform-responses-sol-tier@1',
    modelCredentialRef: 'cred_openai_fixture',
    modelCredentialVersion: 7,
  });

  const subscription = safeRuntimeModelRouteEvidence(
    'openai/gpt-5.4',
    'openai_subscription',
  );
  assert.equal(subscription.providerAuthRoute, 'openai_subscription');
  assert.equal(subscription.compiledProfile, 'openai-codex-responses-standard@1');
  assert.doesNotMatch(
    JSON.stringify(subscription),
    /chickpea-openai-subscription|transport|accessToken|apiKey/,
  );
});
