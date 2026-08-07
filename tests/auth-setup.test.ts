import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthDeniedError } from '../src/auth/service.ts';
import { AuthSetupService } from '../src/auth/setup.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const NOW = 1_786_200_000_000;
const RECOVERY = 'recovery-token-with-more-than-thirty-two-characters';

test('setup requires recovery proof and persists Access pending state without an owner', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const setup = new AuthSetupService(identity, { recoveryToken: RECOVERY, now: () => NOW });
  await assert.rejects(
    () => setup.beginAccessSetup({ recoveryToken: 'wrong', ownerEmail: 'owner@example.com' }),
    AuthDeniedError,
  );
  assert.equal(await identity.getOrganization(), undefined);

  const pending = await setup.beginAccessSetup({ recoveryToken: RECOVERY, ownerEmail: 'owner@example.com' });
  assert.equal(pending.organization.authMode, 'access_pending');
  assert.equal((await identity.listMemberships()).length, 0);
  await setup.configureAccess({
    recoveryToken: RECOVERY,
    issuer: 'https://paperplanelabs.cloudflareaccess.com',
    audience: 'a'.repeat(64),
    canonicalAdminOrigin: 'https://chickpea.example.com',
  });
  const config = await identity.getAuthProviderConfig('cloudflare_access');
  assert.equal(config?.state, 'pending');
  assert.equal(config?.issuer, 'https://paperplanelabs.cloudflareaccess.com');
  identity.close();
});

test('matching verified owner identity atomically activates Access exactly once', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const setup = new AuthSetupService(identity, { recoveryToken: RECOVERY, now: () => NOW });
  await setup.beginAccessSetup({ recoveryToken: RECOVERY, ownerEmail: 'owner@example.com' });
  await setup.configureAccess({
    recoveryToken: RECOVERY, issuer: 'https://paperplanelabs.cloudflareaccess.com',
    audience: 'a'.repeat(64), canonicalAdminOrigin: 'https://chickpea.example.com',
  });
  const external = {
    kind: 'external_identity' as const, provider: 'cloudflare_access',
    issuer: 'https://paperplanelabs.cloudflareaccess.com', subject: 'owner-subject',
    verifiedEmail: 'owner@example.com', credentialId: 'access_assertion',
  };
  const first = await setup.activateAccess(external);
  const replay = await setup.activateAccess(external);
  assert.deepEqual(replay, first);
  assert.equal((await identity.getOrganization())?.authMode, 'access_active');
  assert.equal((await identity.getAuthProviderConfig('cloudflare_access'))?.state, 'active');
  assert.equal(first.membership.role, 'owner');
  identity.close();
});
