import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIVE_MANIFEST,
  LIVE_MANIFEST_DIGEST,
  SuitePolicyError,
  resolveTargetSuiteVariants,
  validateTargetSuitePolicy,
} from '../qa/live/manifest.ts';
import { PHASE_ONE_SMOKE_VARIANTS, PHASE_ONE_TARGET_ALIASES } from '../qa/live/schema.ts';

const extraCase = 'LC02-V1-avatar-parity';

function policy(targetAlias: 'amber' | 'cobalt' | 'fern' = 'amber') {
  return {
    targetAlias,
    allowedSuites: ['case', 'smoke'] as const,
    allowedVariants: [...PHASE_ONE_SMOKE_VARIANTS, extraCase],
  };
}

test('the deterministic manifest owns the exact Phase 1 smoke denominator', () => {
  assert.match(LIVE_MANIFEST_DIGEST, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(LIVE_MANIFEST.requiredVariants.smoke, [...PHASE_ONE_SMOKE_VARIANTS]);
  assert.equal(Object.isFrozen(LIVE_MANIFEST), true);
  assert.equal(LIVE_MANIFEST.requiredVariants.case.includes(extraCase), true);
});

test('amber, cobalt, and fern allow case and smoke but always refuse deep', () => {
  for (const targetAlias of PHASE_ONE_TARGET_ALIASES) {
    const targetPolicy = validateTargetSuitePolicy(policy(targetAlias));
    assert.deepEqual(targetPolicy.allowedSuites, ['case', 'smoke']);
    assert.deepEqual(
      resolveTargetSuiteVariants(targetPolicy, 'smoke'),
      [...PHASE_ONE_SMOKE_VARIANTS],
    );
    assert.throws(
      () => resolveTargetSuiteVariants(targetPolicy, 'deep'),
      (error: unknown) => error instanceof SuitePolicyError && error.code === 'SUITE_NOT_ALLOWED',
    );
  }
});

test('smoke rejects missing and extra variants instead of accepting a near match', () => {
  const targetPolicy = validateTargetSuitePolicy(policy());
  const missing = PHASE_ONE_SMOKE_VARIANTS.slice(0, -1);
  const extra = [...PHASE_ONE_SMOKE_VARIANTS, extraCase];
  for (const selected of [missing, extra]) {
    assert.throws(
      () => resolveTargetSuiteVariants(targetPolicy, 'smoke', selected),
      (error: unknown) => error instanceof SuitePolicyError
        && error.code === 'SMOKE_INVENTORY_MISMATCH',
    );
  }
});

test('other contained variants run only through explicit case selection', () => {
  const targetPolicy = validateTargetSuitePolicy(policy());
  assert.throws(
    () => resolveTargetSuiteVariants(targetPolicy, 'case'),
    (error: unknown) => error instanceof SuitePolicyError
      && error.code === 'CASE_SELECTION_REQUIRED',
  );
  assert.deepEqual(resolveTargetSuiteVariants(targetPolicy, 'case', [extraCase]), [extraCase]);
  assert.throws(
    () => resolveTargetSuiteVariants(targetPolicy, 'case', ['LC99-V1-private']),
    (error: unknown) => error instanceof SuitePolicyError
      && error.code === 'VARIANT_NOT_ALLOWED',
  );
});

test('target policy rejects continuation roles, empty variants, and deep declarations', () => {
  for (const candidate of [
    { ...policy(), targetAlias: 'dedicated-qa' },
    { ...policy(), allowedVariants: [] },
    { ...policy(), allowedSuites: ['case', 'smoke', 'deep'] },
  ]) {
    assert.throws(() => validateTargetSuitePolicy(candidate));
  }
});
