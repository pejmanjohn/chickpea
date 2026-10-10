import assert from 'node:assert/strict';
import { createHash, createSecretKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { test } from 'node:test';

import { createLocalJWKSet, exportJWK, SignJWT, type JWK } from 'jose';

import {
  hostedSlackOidcCredentials,
  SLACK_OIDC_TOKEN_URL,
  SLACK_OIDC_USERINFO_URL,
  SlackOidcGateway,
  standaloneSlackOidcCredentials,
  type SlackOidcAttemptBinding,
  type SlackOidcCredentials,
} from '../src/auth/slack-oidc.ts';
import { HOSTED_SLACK_INSTALLATION_ID, WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  promoteSlackCredentialBundle,
  stageSlackCredentialBundle,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';

const NOW = 1_786_000_000_000;
const NONCE = 'nonce-0123456789abcdefghijklmnopqrstuvwxyz';
const ACCESS_TOKEN = 'oidc-access-token-secret';
const CLIENT_ID = '123.456';
const APP_ID = 'A12345678';
const REDIRECT_URI = 'https://chickpea.example/auth/slack/oidc/callback';
const HOST_APP = {
  appId: APP_ID,
  clientId: CLIENT_ID,
  clientSecret: 'hosted-client-secret',
  connectionRevision: 'hosted_app_rev_1',
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function store() {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  return { identity, credentials: { state: identity, keyring: generateCredentialKeyring('key_v1') } };
}

async function standaloneInstallation(credentials: ReturnType<typeof store>['credentials']): Promise<string> {
  const candidate = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation',
    purpose: 'connected_credentials',
    expectedActiveRevision: null,
    appId: APP_ID,
    teamId: 'TACME',
    botUserId: 'UBOT',
    secrets: {
      clientId: CLIENT_ID, clientSecret: 'client-secret-value',
      signingSecret: 'signing-secret-value', botToken: 'xoxb-standalone',
    },
  });
  return (await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    candidateRevision: candidate.revision,
    expectedActiveRevision: null,
  })).revision;
}

function attempt(overrides: Partial<SlackOidcAttemptBinding> & { credentialRevision: string }): SlackOidcAttemptBinding {
  return {
    appId: APP_ID,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    nonceHash: createHash('sha256').update(NONCE).digest('hex'),
    expectedTeamId: 'TACME',
    expectedSlackUserId: null,
    ...overrides,
  };
}

interface TokenShape {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  issuer?: string;
  audience?: string | string[];
  key?: KeyObject;
  subject?: string;
  issuedAt?: number;
  expiresAt?: number;
}

async function idToken(shape: TokenShape = {}): Promise<string> {
  return new SignJWT({
    nonce: NONCE,
    at_hash: createHash('sha256').update(ACCESS_TOKEN).digest().subarray(0, 16).toString('base64url'),
    'https://slack.com/team_id': 'TACME',
    'https://slack.com/user_id': 'UOWNER',
    ...shape.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'slack-key-1', ...shape.header } as never)
    .setIssuer(shape.issuer ?? 'https://slack.com')
    .setAudience(shape.audience ?? CLIENT_ID)
    .setSubject(shape.subject ?? String(shape.claims?.['https://slack.com/user_id'] ?? 'UOWNER'))
    .setIssuedAt(shape.issuedAt ?? Math.floor(NOW / 1_000))
    .setExpirationTime(shape.expiresAt ?? Math.floor(NOW / 1_000) + 300)
    .sign(shape.key ?? privateKey);
}

async function gatewayFor(credentials: SlackOidcCredentials, token: string, team = 'TACME', userInfo: Record<string, unknown> = {}) {
  const jwk: JWK = await exportJWK(publicKey);
  Object.assign(jwk, { kid: 'slack-key-1', alg: 'RS256', use: 'sig' });
  const requests: Request[] = [];
  const gateway = new SlackOidcGateway({
    credentials,
    now: () => NOW,
    jwks: createLocalJWKSet({ keys: [jwk] }),
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.url === SLACK_OIDC_TOKEN_URL) {
        return json({ ok: true, token_type: 'Bearer', access_token: ACCESS_TOKEN, id_token: token });
      }
      if (request.url === SLACK_OIDC_USERINFO_URL) {
        return json({
          ok: true, sub: 'UOWNER', name: 'Acme Owner',
          'https://slack.com/team_id': team, 'https://slack.com/user_id': 'UOWNER',
          ...userInfo,
        });
      }
      if (request.url === 'https://slack.com/api/users.info') {
        return json({ ok: true, user: { id: 'UOWNER', team_id: team } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  });
  return { gateway, requests };
}

function rejectsWith(code: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
}

test('the ID token must carry the nonce, access-token hash, issuer, audience and signing key Slack uses', async () => {
  const { identity, credentials } = store();
  try {
    const revision = await standaloneInstallation(credentials);
    const port = standaloneSlackOidcCredentials(credentials);
    const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged: TokenShape[] = [
      { claims: { nonce: 'another-nonce-0123456789abcdefghijkl' } },
      { claims: { at_hash: undefined } },
      { claims: { at_hash: 'AAAAAAAAAAAAAAAAAAAAAA' } },
      { claims: { azp: 'someone-else' }, audience: [CLIENT_ID, 'someone-else'] },
      { issuer: 'https://evil.example' },
      { audience: 'another-client' },
      { header: { jku: 'https://evil.example/keys' } },
      { header: { x5u: 'https://evil.example/cert' } },
      { header: { kid: undefined } },
      { header: { alg: 'HS256' }, key: createSecretKey(Buffer.alloc(32, 7)) },
      { key: otherKey },
      { subject: 'USOMEONE' },
      { issuedAt: Math.floor(NOW / 1_000) + 600, expiresAt: Math.floor(NOW / 1_000) + 900 },
      { issuedAt: Math.floor(NOW / 1_000) - 900, expiresAt: Math.floor(NOW / 1_000) - 300 },
    ];
    for (const shape of forged) {
      const { gateway, requests } = await gatewayFor(port, await idToken(shape));
      await assert.rejects(
        gateway.exchangeAndVerify({ attempt: attempt({ credentialRevision: revision }), code: 'code', nonce: NONCE }),
        rejectsWith('invalid_token'),
        JSON.stringify(shape),
      );
      assert.equal(requests.length, 1, 'the token exchange happened, so the token itself was refused');
    }
    const { gateway: named } = await gatewayFor(port, await idToken());
    await assert.rejects(
      named.exchangeAndVerify({
        attempt: attempt({ credentialRevision: revision, expectedSlackUserId: 'UEXPECTED' }), code: 'code', nonce: NONCE,
      }),
      rejectsWith('user_mismatch'),
    );
    const { gateway } = await gatewayFor(port, await idToken({ claims: { 'https://slack.com/team_id': 'TOTHER' } }), 'TOTHER');
    await assert.rejects(
      gateway.exchangeAndVerify({ attempt: attempt({ credentialRevision: revision }), code: 'code', nonce: NONCE }),
      rejectsWith('workspace_mismatch'),
    );
  } finally {
    identity.close();
  }
});

test('the proof carries the workspace name Slack sends, trimmed and bounded, and none when Slack sends none', async () => {
  const { identity, credentials } = store();
  try {
    const port = standaloneSlackOidcCredentials(credentials);
    const binding = attempt({ credentialRevision: await standaloneInstallation(credentials) });
    const verify = async (teamName: unknown) => {
      const { gateway } = await gatewayFor(port, await idToken(), 'TACME', { 'https://slack.com/team_name': teamName });
      return gateway.exchangeAndVerify({ attempt: binding, code: 'code', nonce: NONCE });
    };
    assert.deepEqual(await verify('  Chickpea Amber  '), {
      slackTeamId: 'TACME', slackUserId: 'UOWNER', displayName: 'Acme Owner', teamName: 'Chickpea Amber',
    });
    assert.equal((await verify('W'.repeat(500))).teamName, 'W'.repeat(120));
    for (const none of [undefined, '', '   ', 42, null, ['Chickpea Amber']]) {
      assert.equal('teamName' in await verify(none), false, JSON.stringify(none));
    }
  } finally {
    identity.close();
  }
});

test('a discovery sign-in names no workspace and learns it from the verified token', async () => {
  const { identity, credentials } = store();
  try {
    // The host's registry maps a verified team to the store serving it.
    const port = hostedSlackOidcCredentials({
      app: async () => HOST_APP,
      installation: async (teamId) => (teamId === 'TACME' ? credentials : undefined),
    });
    const { gateway, requests } = await gatewayFor(port, await idToken());
    const url = new URL(gateway.authorizationUrl({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state: 's'.repeat(40), nonce: NONCE,
    }));
    assert.equal(url.searchParams.has('team'), false);
    assert.equal(new URL(gateway.authorizationUrl({
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state: 's'.repeat(40), nonce: NONCE, teamId: 'TACME',
    })).searchParams.get('team'), 'TACME');

    const discovery = attempt({ credentialRevision: HOST_APP.connectionRevision, expectedTeamId: null });
    // Not installed there yet: only an install grant may admit the person.
    await assert.rejects(
      gateway.exchangeAndVerify({ attempt: discovery, code: 'code', nonce: NONCE }),
      rejectsWith('inactive_user'),
    );
    const pending = await gateway.exchangeAndVerify({
      attempt: discovery, code: 'code', nonce: NONCE, eligibility: 'install_grant',
    });
    assert.deepEqual(pending, {
      slackTeamId: 'TACME', slackUserId: 'UOWNER', displayName: 'Acme Owner', eligibility: 'install_grant',
    });
    assert.equal(requests.some((request) => request.url.endsWith('/users.info')), false);
    assert.equal(new URLSearchParams(await requests[0]!.text()).get('client_secret'), 'hosted-client-secret');

    // Installed: the installation's own bot confirms an eligible human.
    await writeHostedSlackBotCredentials(credentials, null, {
      botToken: 'xoxb-tenant-bot', botUserId: 'UBOT', appId: APP_ID, teamId: 'TACME',
      grantedScopes: ['users:read'], validatedAt: NOW,
    });
    requests.length = 0;
    const proof = await gateway.exchangeAndVerify({ attempt: discovery, code: 'code', nonce: NONCE });
    assert.deepEqual(proof, { slackTeamId: 'TACME', slackUserId: 'UOWNER', displayName: 'Acme Owner' });
    assert.equal(requests.at(-1)!.headers.get('authorization'), 'Bearer xoxb-tenant-bot');

    // A bot granted in another workspace never vouches for this one.
    const elsewhere = await gatewayFor(port, await idToken({ claims: { 'https://slack.com/team_id': 'TOTHER' } }), 'TOTHER');
    await assert.rejects(
      elsewhere.gateway.exchangeAndVerify({ attempt: discovery, code: 'code', nonce: NONCE }),
      rejectsWith('inactive_user'),
    );
    // A team the host knows but has not installed may still sign its installer in.
    const teamBound = attempt({ credentialRevision: HOST_APP.connectionRevision, expectedTeamId: 'TACME' });
    const beforeInstall = await gatewayFor(hostedSlackOidcCredentials({
      app: async () => HOST_APP, installation: async () => undefined,
    }), await idToken());
    await assert.rejects(
      beforeInstall.gateway.exchangeAndVerify({ attempt: teamBound, code: 'code', nonce: NONCE }),
      rejectsWith('stale_revision'),
    );
    assert.equal((await beforeInstall.gateway.exchangeAndVerify({
      attempt: teamBound, code: 'code', nonce: NONCE, eligibility: 'install_grant',
    })).eligibility, 'install_grant');
    const wrongWorkspace = await gatewayFor(hostedSlackOidcCredentials({
      app: async () => HOST_APP, installation: async () => undefined,
    }), await idToken({ claims: { 'https://slack.com/team_id': 'TOTHER' } }), 'TOTHER');
    await assert.rejects(
      wrongWorkspace.gateway.exchangeAndVerify({ attempt: teamBound, code: 'code', nonce: NONCE, eligibility: 'install_grant' }),
      rejectsWith('workspace_mismatch'),
    );
    // A registry lookup that fails after the exchange refuses rather than guessing.
    const broken = await gatewayFor(hostedSlackOidcCredentials({
      app: async () => HOST_APP, installation: async () => { throw new Error('registry unavailable'); },
    }), await idToken());
    await assert.rejects(
      broken.gateway.exchangeAndVerify({ attempt: discovery, code: 'code', nonce: NONCE, eligibility: 'install_grant' }),
      rejectsWith('stale_revision'),
    );
    // A stale app revision is refused before any code is exchanged.
    const stale = await gatewayFor(port, await idToken());
    await assert.rejects(
      stale.gateway.exchangeAndVerify({
        attempt: attempt({ credentialRevision: 'hosted_app_rev_0', expectedTeamId: null }), code: 'code', nonce: NONCE,
      }),
      rejectsWith('stale_revision'),
    );
    assert.equal(stale.requests.length, 0);
  } finally {
    identity.close();
  }
});

test('a hosted installation bundle holds only its bot token, and a standalone one still needs its signing secret', async () => {
  const { identity, credentials } = store();
  try {
    const base = {
      identityClass: 'workspace_installation' as const,
      purpose: 'connected_credentials' as const,
      expectedActiveRevision: null,
      appId: APP_ID,
      teamId: 'TACME',
      botUserId: 'UBOT',
    };
    await assert.rejects(
      stageSlackCredentialBundle(credentials, {
        ...base, identityId: HOSTED_SLACK_INSTALLATION_ID,
        secrets: { botToken: 'xoxb-tenant-bot', signingSecret: 'host-owned-secret' },
      }),
      /holds only its bot token/,
    );
    await assert.rejects(
      stageSlackCredentialBundle(credentials, {
        ...base, identityId: WORKSPACE_SLACK_INSTALLATION_ID, secrets: { botToken: 'xoxb-bot' },
      }),
      /incomplete/,
    );
  } finally {
    identity.close();
  }
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test("an installation's bot must belong to the signing-in app and confirm an eligible human", async () => {
  const { identity, credentials } = store();
  try {
    await writeHostedSlackBotCredentials(credentials, null, {
      botToken: 'xoxb-other-app', botUserId: 'UBOT', appId: 'AOTHERAPP', teamId: 'TACME',
      grantedScopes: [], validatedAt: NOW,
    });
    const port = hostedSlackOidcCredentials({ app: async () => HOST_APP, installation: async () => credentials });
    const discovery = attempt({ credentialRevision: HOST_APP.connectionRevision, expectedTeamId: null });
    const { gateway, requests } = await gatewayFor(port, await idToken());
    await assert.rejects(gateway.exchangeAndVerify({ attempt: discovery, code: 'code', nonce: NONCE }),
      rejectsWith('inactive_user'));
    assert.equal(requests.some((request) => request.url.endsWith('/users.info')), false,
      "another app's bot never speaks for this one");
  } finally {
    identity.close();
  }
});
