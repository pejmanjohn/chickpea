import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';

import {
  SLACK_OIDC_AUTHORIZE_URL,
  SLACK_OIDC_ISSUER,
  SLACK_OIDC_JWKS_URL,
  SLACK_OIDC_SCOPES,
  SLACK_OIDC_TOKEN_URL,
  SLACK_OIDC_USERINFO_URL,
  SlackOidcGateway,
} from '../src/auth/slack-oidc.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  promoteSlackCredentialBundle,
  stageSlackCredentialBundle,
} from '../src/slack/identity-credentials.ts';

test('Slack OIDC uses only the pinned confidential Sign in with Slack endpoints and scopes', () => {
  assert.equal(SLACK_OIDC_ISSUER, 'https://slack.com');
  assert.equal(SLACK_OIDC_AUTHORIZE_URL, 'https://slack.com/openid/connect/authorize');
  assert.equal(SLACK_OIDC_TOKEN_URL, 'https://slack.com/api/openid.connect.token');
  assert.equal(SLACK_OIDC_USERINFO_URL, 'https://slack.com/api/openid.connect.userInfo');
  assert.equal(SLACK_OIDC_JWKS_URL, 'https://slack.com/openid/connect/keys');
  assert.deepEqual(SLACK_OIDC_SCOPES, ['openid', 'profile']);
});

test('confidential Slack OIDC validates pinned JWT, userinfo, and active human membership', async () => {
  const now = 1_786_000_000_000;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const credentials = { state: identity, keyring: generateCredentialKeyring('key_v1') };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: 'slack-key-1', alg: 'RS256', use: 'sig' });
  try {
    const candidate = await stageSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      identityClass: 'workspace_default',
      purpose: 'connected_credentials',
      expectedActiveRevision: null,
      appId: 'A12345678',
      teamId: 'TACME',
      botUserId: 'UBOT',
      secrets: {
        clientId: '123.456', clientSecret: 'client-secret-value',
        signingSecret: 'signing-secret-value', botToken: 'xoxb-bot-token',
      },
    });
    const active = await promoteSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      candidateRevision: candidate.revision,
      expectedActiveRevision: null,
    });
    const accessToken = 'oidc-access-token-secret';
    const nonce = 'nonce-0123456789abcdefghijklmnopqrstuvwxyz';
    const idToken = await new SignJWT({
      nonce,
      at_hash: createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url'),
      'https://slack.com/team_id': 'TACME',
      'https://slack.com/user_id': 'UOWNER',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'slack-key-1' })
      .setIssuer('https://slack.com')
      .setAudience('123.456')
      .setSubject('UOWNER')
      .setIssuedAt(Math.floor(now / 1_000))
      .setExpirationTime(Math.floor(now / 1_000) + 300)
      .sign(privateKey);
    const requests: Request[] = [];
    let userInfoTeam = 'TACME';
    let deleted = false;
    const gateway = new SlackOidcGateway({
      credentials,
      now: () => now,
      jwks: createLocalJWKSet({ keys: [jwk] }),
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        if (request.url === SLACK_OIDC_TOKEN_URL) {
          return json({ ok: true, token_type: 'Bearer', access_token: accessToken, id_token: idToken });
        }
        if (request.url === SLACK_OIDC_USERINFO_URL) {
          return json({
            ok: true, sub: 'UOWNER', name: 'Acme Owner',
            'https://slack.com/team_id': userInfoTeam,
            'https://slack.com/user_id': 'UOWNER',
          });
        }
        if (request.url === 'https://slack.com/api/users.info') {
          return json({ ok: true, user: { id: 'UOWNER', team_id: 'TACME', deleted } });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    });
    const proof = await gateway.exchangeAndVerify({
      attempt: {
        id: 'oidc_attempt', purpose: 'first_owner', operationId: 'operation', invitationId: null,
        setupId: 'setup_default', setupRevision: 9,
        stateHash: 'a'.repeat(64), nonceHash: sha256(nonce), browserHash: 'b'.repeat(64),
        appId: 'A12345678', clientId: '123.456', credentialRevision: active.revision,
        redirectUri: 'https://chickpea.example/auth/slack/oidc/callback', destination: '/admin',
        expectedTeamId: 'TACME', expectedSlackUserId: 'UOWNER',
        admittedTeamId: null, admittedSlackUserId: null,
        status: 'processing', leaseGeneration: 1, leaseExpiresAt: now + 60_000,
        resultCode: null, expiresAt: now + 15 * 60_000, createdAt: now, updatedAt: now,
      },
      code: 'oidc-code-secret', nonce,
    });
    assert.deepEqual(proof, {
      slackTeamId: 'TACME', slackUserId: 'UOWNER', displayName: 'Acme Owner',
    });
    const tokenForm = new URLSearchParams(await requests[0]!.text());
    assert.deepEqual(Object.fromEntries(tokenForm), {
      client_id: '123.456', client_secret: 'client-secret-value',
      code: 'oidc-code-secret',
      redirect_uri: 'https://chickpea.example/auth/slack/oidc/callback',
    });
    assert.equal(tokenForm.has('code_verifier'), false);
    assert.equal(requests[1]!.headers.get('authorization'), `Bearer ${accessToken}`);
    assert.equal(requests[2]!.headers.get('authorization'), 'Bearer xoxb-bot-token');

    userInfoTeam = 'TOTHER';
    await assert.rejects(
      () => gateway.exchangeAndVerify({
        attempt: {
          id: 'oidc_attempt_2', purpose: 'login', operationId: null, invitationId: null,
          setupId: null, setupRevision: null,
          stateHash: 'c'.repeat(64), nonceHash: sha256(nonce), browserHash: 'd'.repeat(64),
          appId: 'A12345678', clientId: '123.456', credentialRevision: active.revision,
          redirectUri: 'https://chickpea.example/auth/slack/oidc/callback', destination: '/admin',
          expectedTeamId: 'TACME', expectedSlackUserId: null, admittedTeamId: null, admittedSlackUserId: null,
          status: 'processing', leaseGeneration: 1, leaseExpiresAt: now + 60_000,
          resultCode: null, expiresAt: now + 15 * 60_000, createdAt: now, updatedAt: now,
        },
        code: 'second-code', nonce,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_token',
    );
    userInfoTeam = 'TACME';
    deleted = true;
    await assert.rejects(
      () => gateway.exchangeAndVerify({
        attempt: {
          id: 'oidc_attempt_3', purpose: 'login', operationId: null, invitationId: null,
          setupId: null, setupRevision: null,
          stateHash: 'e'.repeat(64), nonceHash: sha256(nonce), browserHash: 'f'.repeat(64),
          appId: 'A12345678', clientId: '123.456', credentialRevision: active.revision,
          redirectUri: 'https://chickpea.example/auth/slack/oidc/callback', destination: '/admin',
          expectedTeamId: 'TACME', expectedSlackUserId: null, admittedTeamId: null, admittedSlackUserId: null,
          status: 'processing', leaseGeneration: 1, leaseExpiresAt: now + 60_000,
          resultCode: null, expiresAt: now + 15 * 60_000, createdAt: now, updatedAt: now,
        },
        code: 'third-code', nonce,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'inactive_user',
    );
  } finally {
    identity.close();
  }
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
