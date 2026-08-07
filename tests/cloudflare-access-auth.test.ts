import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  CloudflareAccessAuthenticator,
  verifyCloudflareAccessRecoveryAssertion,
} from '../src/auth/cloudflare-access.ts';
import { AuthDeniedError } from '../src/auth/service.ts';

const ISSUER = 'https://example.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  const sign = async (claims: Record<string, unknown> = {}, options: { issuer?: string; audience?: string } = {}) =>
    new SignJWT({ email: 'owner@example.com', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setSubject('access-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  return { jwks: { keys: [jwk] }, sign };
}

test('Access authenticator verifies signature, issuer, audience, subject, and email', async () => {
  const { jwks, sign } = await fixture();
  const authenticator = new CloudflareAccessAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks });
  const assertion = await sign();
  const identity = await authenticator.authenticate(new Request('https://app.example/admin', {
    headers: { 'Cf-Access-Jwt-Assertion': assertion },
  }));
  assert.equal(identity?.provider, 'cloudflare_access');
  assert.equal(identity?.issuer, ISSUER);
  assert.equal(identity?.subject, 'access-subject');
  assert.equal(identity?.verifiedEmail, 'owner@example.com');
});

test('Access failures are uniform and invalid issuers never construct a remote verifier', async () => {
  const { jwks, sign } = await fixture();
  for (const assertion of [
    undefined,
    'not-a-jwt',
    await sign({}, { audience: 'wrong-audience' }),
    await sign({}, { issuer: 'https://other.cloudflareaccess.com' }),
    await sign({ email: undefined }),
  ]) {
    const authenticator = new CloudflareAccessAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks });
    await assert.rejects(
      () => authenticator.authenticate(new Request('https://app.example/admin', {
        ...(assertion ? { headers: { 'Cf-Access-Jwt-Assertion': assertion } } : {}),
      })),
      (error: unknown) => error instanceof AuthDeniedError && error.message === 'Authentication unavailable.',
    );
  }

  for (const issuer of [
    'http://team.cloudflareaccess.com',
    'https://cloudflareaccess.com',
    'https://team.cloudflareaccess.com/path',
    'https://user:pass@team.cloudflareaccess.com',
    'https://team.cloudflareaccess.com?query=1',
  ]) {
    assert.throws(
      () => new CloudflareAccessAuthenticator({ issuer, audience: AUDIENCE, jwks }),
      /issuer/i,
    );
  }
});

test('recovery verifier accepts configured-issuer proof while deliberately ignoring audience', async () => {
  const { jwks, sign } = await fixture();
  const assertion = await sign({}, { audience: 'replacement-audience' });
  const identity = await verifyCloudflareAccessRecoveryAssertion(assertion, { issuer: ISSUER, jwks });
  assert.equal(identity.subject, 'access-subject');
  assert.equal(identity.verifiedEmail, 'owner@example.com');
});
