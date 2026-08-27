import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEPLOYMENT_ACTIVATION_CLOCK_SKEW_MS,
  DEPLOYMENT_ACTIVATION_TTL_MS,
  digestDeploymentActivation,
  mintDeploymentActivation,
  verifyDeploymentActivation,
} from '../src/auth/deployment-activation.mjs';

test('deployment activation is short-lived and verifies only its exact bearer', async () => {
  const now = 1_788_000_000_000;
  const minted = await mintDeploymentActivation({ now: () => now });
  assert.match(minted.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.digest, await digestDeploymentActivation(minted.capability));
  assert.equal(await verifyDeploymentActivation({ ...minted, now: () => now }), true);
  assert.equal(await verifyDeploymentActivation({
    ...minted,
    now: () => now + DEPLOYMENT_ACTIVATION_TTL_MS,
  }), false);
  assert.equal(await verifyDeploymentActivation({
    ...minted,
    now: () => now - DEPLOYMENT_ACTIVATION_CLOCK_SKEW_MS - 1,
  }), false);
  assert.equal(await verifyDeploymentActivation({
    ...minted,
    capability: `${minted.capability.startsWith('A') ? 'B' : 'A'}${minted.capability.slice(1)}`,
    now: () => now,
  }), false);
});
