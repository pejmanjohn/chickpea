import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  digestSetupCapability,
  mintSetupCapability,
  SETUP_CAPABILITY_CLOCK_SKEW_MS,
  SETUP_CAPABILITY_TTL_MS,
  setupCapabilityUrl,
  verifySetupCapability,
} from '../src/auth/setup-capability.mjs';
import { resolveBetterAuthBootstrapEnvironment } from '../src/auth/better-auth-environment.ts';
import { withEnv } from './helpers/env.ts';

const AUTH_SECRET = 'A'.repeat(43);
const LEGACY_RECOVERY = '6a'.repeat(32);

test('setup capability has one digest contract across mint and verification', async () => {
  const now = 1_786_147_200_000;
  const minted = await mintSetupCapability({ now: () => now });
  assert.match(minted.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.digest, await digestSetupCapability(minted.capability));
  assert.equal(await verifySetupCapability({ ...minted, now: () => now }), true);
  assert.equal(await verifySetupCapability({
    ...minted,
    now: () => now + SETUP_CAPABILITY_TTL_MS,
  }), false);
  assert.equal(await verifySetupCapability({
    ...minted,
    now: () => now - SETUP_CAPABILITY_CLOCK_SKEW_MS,
  }), true);
  assert.equal(await verifySetupCapability({
    ...minted,
    now: () => now - SETUP_CAPABILITY_CLOCK_SKEW_MS - 1,
  }), false);
  assert.equal(await verifySetupCapability({
    ...minted,
    capability: `${minted.capability.startsWith('A') ? 'B' : 'A'}${minted.capability.slice(1)}`,
    now: () => now,
  }), false);
});

test('setup capability digest keeps the deploy and Worker golden vector stable', async () => {
  assert.equal(
    await digestSetupCapability('A'.repeat(43)),
    'DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo',
  );
});

test('setup capability URL keeps the proof in the fragment', async () => {
  const minted = await mintSetupCapability();
  const url = setupCapabilityUrl('https://chickpea.example.com/ignored?old=1', minted.capability);
  assert.equal(url, `https://chickpea.example.com/admin/setup#setup=${minted.capability}`);
});

test('Node helper emits config values and one final fragment link', () => {
  const result = spawnSync(process.execPath, [
    new URL('../scripts/create-setup-link.mjs', import.meta.url).pathname,
    'https://chickpea.example.com',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.match(lines[0] ?? '', /^CHICKPEA_SETUP_CAPABILITY_DIGEST=[A-Za-z0-9_-]{43}$/);
  assert.match(lines[1] ?? '', /^CHICKPEA_SETUP_CAPABILITY_ISSUED_AT=\d{13}$/);
  assert.equal(lines[2], '');
  assert.match(lines[3] ?? '', /^https:\/\/chickpea\.example\.com\/admin\/setup#setup=[A-Za-z0-9_-]{43}$/);
  assert.equal(lines.length, 4);
});

test('Better Auth requires its independent stable auth secret', async () => {
  await withEnv({ CHICKPEA_AUTH_DB_PATH: ':memory:' }, async () => {
    const stable = await resolveBetterAuthBootstrapEnvironment({
      canonicalOrigin: 'http://127.0.0.1:8787',
      authSecret: AUTH_SECRET,
      recoveryToken: LEGACY_RECOVERY,
    });
    const recoveryOnly = await resolveBetterAuthBootstrapEnvironment({
      canonicalOrigin: 'http://127.0.0.1:8787',
      recoveryToken: LEGACY_RECOVERY,
    });
    assert.equal(stable?.secret, AUTH_SECRET);
    assert.equal(recoveryOnly, undefined);
  });
});
