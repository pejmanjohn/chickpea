import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthRecoveryService } from '../src/auth/recovery.ts';
import { AuthDeniedError } from '../src/auth/service.ts';
import { AuthSetupService } from '../src/auth/setup.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const NOW = 1_786_200_000_000;
const RECOVERY = 'recovery-token-with-more-than-thirty-two-characters';
const ISSUER = 'https://paperplanelabs.cloudflareaccess.com';

async function activeStore() {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const setup = new AuthSetupService(identity, { recoveryToken: RECOVERY, now: () => NOW });
  await setup.beginAccessSetup({ recoveryToken: RECOVERY, ownerEmail: 'owner@example.com' });
  await setup.configureAccess({
    recoveryToken: RECOVERY, issuer: ISSUER, audience: 'a'.repeat(64),
    canonicalAdminOrigin: 'https://chickpea.example.com',
  });
  await setup.activateAccess({
    kind: 'external_identity', provider: 'cloudflare_access', issuer: ISSUER,
    subject: 'owner-subject', verifiedEmail: 'owner@example.com', credentialId: 'assertion',
  });
  return identity;
}

test('recovery repairs only audience with valid configured-issuer owner proof', async () => {
  const identity = await activeStore();
  const recovery = new AuthRecoveryService(identity, { recoveryToken: RECOVERY });
  const updated = await recovery.repairAudience({
    recoveryToken: RECOVERY,
    identity: {
      kind: 'external_identity', provider: 'cloudflare_access', issuer: ISSUER,
      subject: 'owner-subject', verifiedEmail: 'owner@example.com', credentialId: 'recovery_assertion',
    },
    audience: 'b'.repeat(64),
  });
  assert.equal(updated.audience, 'b'.repeat(64));
  await assert.rejects(() => recovery.repairAudience({
    recoveryToken: RECOVERY,
    identity: {
      kind: 'external_identity', provider: 'cloudflare_access',
      issuer: 'https://other.cloudflareaccess.com', subject: 'owner-subject',
      verifiedEmail: 'owner@example.com', credentialId: 'bad',
    },
    audience: 'c'.repeat(64),
  }));
  assert.equal((await identity.getAuthProviderConfig('cloudflare_access'))?.audience, 'b'.repeat(64));
  identity.close();
});

test('recovery replaces exactly one owner binding only for the same verified email', async () => {
  const identity = await activeStore();
  const owner = {
    kind: 'external_identity' as const,
    provider: 'cloudflare_access',
    issuer: ISSUER,
    subject: 'owner-subject',
    verifiedEmail: 'owner@example.com',
    credentialId: 'replacement_assertion',
  };
  const recovery = new AuthRecoveryService(identity, { recoveryToken: RECOVERY });

  await assert.rejects(
    () => recovery.replaceOwnerBinding({
      recoveryToken: RECOVERY,
      identity: { ...owner, subject: 'replacement', verifiedEmail: 'attacker@example.com' },
    }),
    AuthDeniedError,
  );

  const replacement = await recovery.replaceOwnerBinding({
    recoveryToken: RECOVERY,
    identity: { ...owner, subject: 'replacement' },
  });
  assert.equal(replacement.membership.role, 'owner');
  assert.equal(replacement.binding.subject, 'replacement');
  assert.equal(
    await identity.resolveExternalIdentity(owner.provider, owner.issuer, owner.subject),
    undefined,
  );
  assert.equal((await identity.listMemberships()).length, 1);
  identity.close();
});
