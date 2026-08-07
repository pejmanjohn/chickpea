import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudflareLoginIdentityAllowed,
  cloudflareLoginSourceAllowed,
  cloudflarePasswordPrimitive,
  type CloudflareBetterAuthEnv,
} from '../src/auth/better-auth-cloudflare.ts';
import { DUMMY_PASSWORD_RECORD, nativePasswordPrimitive } from '../src/auth/password.ts';

test('Cloudflare KDF work shards dummy attempts by source and real verifiers by salt', async () => {
  const names: string[] = [];
  const env = fakeEnvironment(names);
  const firstSource = cloudflarePasswordPrimitive(env, 'source-a');
  const secondSource = cloudflarePasswordPrimitive(env, 'source-b');
  await firstSource.verify({ hash: DUMMY_PASSWORD_RECORD, password: 'wrong password' });
  await secondSource.verify({ hash: DUMMY_PASSWORD_RECORD, password: 'wrong password' });
  const realRecord = await nativePasswordPrimitive().hash('several unrelated words 5729');
  await firstSource.verify({ hash: realRecord, password: 'wrong password' });

  assert.equal(names.length, 3);
  assert.notEqual(names[0], names[1], 'unknown-account work must not funnel to one global DO');
  assert.notEqual(names[0], names[2], 'real verifier work must use its credential salt shard');
  assert.match(names[0] ?? '', /^kdf-verify:/);
});

test('Cloudflare source and existing-identity throttles use separate bounded shards', async () => {
  const names: string[] = [];
  const env = fakeEnvironment(names);
  assert.equal(await cloudflareLoginSourceAllowed(env, 'source-a'), true);
  assert.equal(await cloudflareLoginIdentityAllowed(env, 'owner@example.com'), true);
  assert.equal(names.length, 2);
  assert.match(names[0] ?? '', /^source-rate:/);
  assert.match(names[1] ?? '', /^identity-rate:/);
});

function fakeEnvironment(names: string[]): CloudflareBetterAuthEnv {
  return {
    AUTH_DB: {} as CloudflareBetterAuthEnv['AUTH_DB'],
    CHICKPEA_RECOVERY_TOKEN: '6a'.repeat(32),
    AUTH_GUARD: {
      getByName(name: string) {
        names.push(name);
        return {
          async hashPassword() { return DUMMY_PASSWORD_RECORD; },
          async verifyPassword() { return false; },
          async allow() { return true; },
        };
      },
    },
  };
}
