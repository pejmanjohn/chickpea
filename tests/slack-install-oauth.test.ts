import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Hono } from 'hono';

import { mintSetupCapability } from '../src/auth/setup-capability.mjs';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { SlackAppCreationService, openSlackSetupTransaction } from '../src/slack/app-creation.ts';
import { generateCredentialKeyring, loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import type { SlackCredentialDependencies } from '../src/slack/identity-credentials.ts';
import { recordPendingSlackChallenge } from '../src/slack/identity-handshake.ts';
import { buildSlackAppManifest } from '../src/slack/identity-manifest.ts';
import {
  SLACK_INSTALL_ATTEMPT_TTL_MS,
  SLACK_INSTALL_PROCESSING_LEASE_MS,
  SlackInstallOAuthError,
  SlackInstallOAuthService,
} from '../src/slack/install-oauth.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { withEnv } from './helpers/env.ts';

const NOW = 1_786_000_000_000;
const ORIGIN = 'https://chickpea.example';
const REDIRECT_URI = `${ORIGIN}/auth/slack/install/callback`;
const BROWSER_BINDING = 'browser-binding-0123456789abcdefghijklmnopqrstuvwxyz';

test('bot OAuth start stores only hashed short state bound to the browser and exact app revision', async () => {
  const fixture = await installFixture();
  try {
    const started = await fixture.service.start({
      setupId: fixture.setup.id,
      expectedSetupRevision: fixture.setup.revision,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      destination: '/admin/channels',
    });
    const url = new URL(started.authorizationUrl);
    assert.equal(url.origin, 'https://slack.com');
    assert.equal(url.pathname, '/oauth/v2/authorize');
    assert.equal(url.searchParams.get('client_id'), '123.456');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(url.searchParams.get('scope'), REQUIRED_SLACK_BOT_SCOPES.join(','));
    assert.equal(url.searchParams.has('user_scope'), false);
    assert.equal(url.searchParams.has('code_challenge'), false);
    assert.equal(url.searchParams.get('state'), started.state);
    assert.equal(started.expiresAt, NOW + SLACK_INSTALL_ATTEMPT_TTL_MS);

    const attempt = await fixture.identity.getSlackOAuthAttempt(started.attemptId);
    assert.ok(attempt);
    assert.equal(attempt.kind, 'slack_bot_install');
    assert.equal(attempt.purpose, 'setup_bot_install');
    assert.equal(attempt.stateHash, sha256(started.state));
    assert.equal(attempt.browserHash, sha256(BROWSER_BINDING));
    assert.equal(attempt.setupId, fixture.setup.id);
    assert.equal(attempt.setupRevision, fixture.setup.revision);
    assert.equal(attempt.appId, 'A12345678');
    assert.equal(attempt.clientId, '123.456');
    assert.equal(attempt.credentialRevision, fixture.setup.credentialRevision);
    assert.equal(attempt.baseRevision, fixture.setup.credentialRevision);
    assert.equal(attempt.redirectUri, REDIRECT_URI);
    assert.equal(attempt.destination, '/admin/channels');
    assert.doesNotMatch(JSON.stringify(attempt), new RegExp(started.state));
    assert.doesNotMatch(JSON.stringify(await fixture.identity.exportSummary()), /stateHash|browserHash|browser-binding/);
  } finally {
    fixture.close();
  }
});

test('confidential callback validates the issued bot capabilities and waits for exact signed Events proof', async () => {
  const fixture = await installFixture();
  try {
    const started = await fixture.start();
    const completed = await fixture.service.callback({
      state: started.state,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      code: 'oauth-code-secret',
    });
    assert.equal(completed.status, 'waiting_events');
    assert.equal(completed.teamId, 'TACME');
    assert.equal(completed.installerUserId, 'UINSTALLER');
    const waitingSetup = await fixture.identity.getSlackSetupTransaction(fixture.setup.id);
    assert.equal(waitingSetup?.state, 'bot_install_pending');
    const inactiveCandidate = await fixture.identity.getSlackCredentialRevision(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      waitingSetup!.botCredentialRevision!,
    );
    assert.equal(inactiveCandidate?.status, 'candidate');
    assert.equal(inactiveCandidate?.purpose, 'connected_credentials');
    assert.ok(inactiveCandidate?.envelope?.ciphertext);
    assert.doesNotMatch(JSON.stringify(inactiveCandidate), /xoxb-bot-token-secret/);
    assert.equal(
      (await fixture.identity.getActiveSlackCredentialRevision(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID))?.purpose,
      'app_credentials',
    );
    assert.equal(fixture.exchangeCalls, 1);
    assert.equal(fixture.exchangeRequest?.headers.get('authorization'), null);
    const exchangeForm = new URLSearchParams(await fixture.exchangeRequest!.clone().text());
    assert.deepEqual(Object.fromEntries(exchangeForm), {
      client_id: '123.456',
      client_secret: 'client-secret-value',
      code: 'oauth-code-secret',
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(exchangeForm.has('code_verifier'), false);

    await fixture.recordChallenge();
    const installed = await fixture.service.finalizeWaitingInstallation(fixture.setup.id);
    assert.equal(installed.status, 'bot_installed');
    assert.equal(installed.teamId, 'TACME');
    assert.equal(installed.installerUserId, 'UINSTALLER');
    const active = await fixture.identity.getActiveSlackCredentialRevision(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
    assert.equal(active?.purpose, 'connected_credentials');
    assert.equal(active?.teamId, 'TACME');
    assert.equal(active?.botUserId, 'UBOT');
    assert.ok(await fixture.identity.getSlackEventsProof(active!.revision));
    assert.equal((await fixture.identity.getSlackSetupTransaction(fixture.setup.id))?.state, 'bot_installed');

    const replay = await fixture.service.finalizeWaitingInstallation(fixture.setup.id);
    assert.equal(replay.status, 'bot_installed');
  } finally {
    fixture.close();
  }
});

test('the canonical signed Events URL automatically promotes its pending encrypted bot revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-install-events-'));
  const databasePath = join(directory, 'state.db');
  const keyringPath = join(directory, 'credential-keyring.json');
  const now = Date.now();
  try {
    await withEnv({
      TAG_DB_PATH: databasePath,
      SLACK_STATE_DB_PATH: databasePath,
      CHICKPEA_CREDENTIAL_KEYRING_PATH: keyringPath,
      SLACK_BOT_TOKEN: undefined,
      SLACK_SIGNING_SECRET: undefined,
    }, async () => {
      const fixture = await installFixture({
        now: () => now,
        databasePath,
        keyring: loadCredentialKeyring(),
      });
      try {
        const started = await fixture.start();
        const waiting = await fixture.service.callback({
          state: started.state,
          browserBinding: BROWSER_BINDING,
          redirectUri: REDIRECT_URI,
          code: 'oauth-code-secret',
        });
        assert.equal(waiting.status, 'waiting_events');

        const body = JSON.stringify({
          type: 'url_verification',
          challenge: 'challenge-install-ingress',
          api_app_id: 'A12345678',
          team_id: 'TACME',
        });
        const timestamp = String(Math.floor(now / 1_000));
        const signature = `v0=${createHmac('sha256', 'signing-secret-value')
          .update(`v0:${timestamp}:${body}`).digest('hex')}`;
        const { channel } = await import('../src/channels/slack.ts');
        const app = new Hono();
        app.route('/channels/slack', channel.route());
        const response = await app.request(
          '/channels/slack/events',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-slack-request-timestamp': timestamp,
              'x-slack-signature': signature,
            },
            body,
          },
        );
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(await response.json(), { challenge: 'challenge-install-ingress' });
        assert.equal(
          (await fixture.identity.getSlackSetupTransaction(fixture.setup.id))?.state,
          'bot_installed',
        );
        assert.equal(
          (await fixture.identity.getActiveSlackCredentialRevision(
            WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
          ))?.purpose,
          'connected_credentials',
        );
        assert.equal(
          (await fixture.config.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID)).lifecycle,
          'connected',
        );
      } finally {
        fixture.close();
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a retry after proof persistence reuses the original verified time before CAS promotion', async () => {
  const fixture = await installFixture();
  try {
    const started = await fixture.start();
    assert.equal((await fixture.service.callback({
      state: started.state,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      code: 'proof-retry-code',
    })).status, 'waiting_events');
    const waiting = (await fixture.identity.getSlackSetupTransaction(fixture.setup.id))!;
    const proofInput = {
      setupId: waiting.id,
      candidateRevision: waiting.botCredentialRevision!,
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      appId: waiting.appId!,
      teamId: waiting.slackTeamId!,
      baseRevision: waiting.credentialRevision!,
      verifiedAt: NOW,
    };
    const first = await fixture.identity.recordSlackEventsProof(proofInput);
    const replay = await fixture.identity.recordSlackEventsProof({
      ...proofInput,
      verifiedAt: NOW + 5_000,
    });
    assert.equal(replay.verifiedAt, first.verifiedAt);
    assert.equal((await fixture.service.finalizeWaitingInstallation(waiting.id)).status, 'bot_installed');
  } finally {
    fixture.close();
  }
});

test('approval interruption destroys OAuth state and resume issues a fresh attempt without extending setup', async () => {
  const fixture = await installFixture();
  try {
    const first = await fixture.start();
    const interrupted = await fixture.service.callback({
      state: first.state,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      error: 'app_approval_required',
    });
    assert.equal(interrupted.status, 'approval_pending');
    const pending = await fixture.identity.getSlackSetupTransaction(fixture.setup.id);
    assert.equal(pending?.state, 'approval_pending');
    assert.equal(pending?.expiresAt, fixture.setup.expiresAt);
    await assert.rejects(
      () => fixture.service.callback({
        state: first.state,
        browserBinding: BROWSER_BINDING,
        redirectUri: REDIRECT_URI,
        code: 'replayed-code',
      }),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'invalid_state',
    );

    const resumed = await fixture.service.resume({
      setupId: fixture.setup.id,
      expectedSetupRevision: pending!.revision,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      destination: '/admin/channels',
    });
    assert.notEqual(resumed.state, first.state);
    assert.equal(resumed.expiresAt, NOW + SLACK_INSTALL_ATTEMPT_TTL_MS);
    assert.equal((await fixture.identity.getSlackSetupTransaction(fixture.setup.id))?.expiresAt, fixture.setup.expiresAt);
  } finally {
    fixture.close();
  }
});

test('missing required token scopes fail closed while extra scopes are accepted', async () => {
  const missing = await installFixture({ tokenScopes: REQUIRED_SLACK_BOT_SCOPES.slice(1) });
  try {
    const started = await missing.start();
    await assert.rejects(
      () => missing.service.callback({
        state: started.state,
        browserBinding: BROWSER_BINDING,
        redirectUri: REDIRECT_URI,
        code: 'missing-scopes',
      }),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'missing_scopes',
    );
    assert.equal((await missing.identity.getSlackOAuthAttempt(started.attemptId))?.status, 'failed');
    const exchanges = missing.exchangeCalls;
    await assert.rejects(
      () => missing.service.callback({
        state: started.state,
        browserBinding: BROWSER_BINDING,
        redirectUri: REDIRECT_URI,
        code: 'missing-scopes-replay',
      }),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'invalid_state',
    );
    assert.equal(missing.exchangeCalls, exchanges);
  } finally {
    missing.close();
  }

  const extra = await installFixture({ tokenScopes: [...REQUIRED_SLACK_BOT_SCOPES, 'commands'] });
  try {
    const started = await extra.start();
    assert.equal((await extra.service.callback({
      state: started.state,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      code: 'extra-scope',
    })).status, 'waiting_events');
    const pending = await extra.identity.getSlackSetupTransaction(extra.setup.id);
    const candidate = await extra.identity.getSlackCredentialRevision(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      pending!.botCredentialRevision!,
    );
    assert.ok(candidate?.grantedScopes.includes('commands'));
  } finally {
    extra.close();
  }
});

test('OAuth processing lease rejects concurrent replay and only the same browser can reclaim it after expiry', async () => {
  let now = NOW;
  const fixture = await installFixture({ now: () => now });
  try {
    const started = await fixture.start();
    const first = await fixture.identity.acquireSlackOAuthAttempt({
      stateHash: sha256(started.state), browserHash: sha256(BROWSER_BINDING),
      kind: 'slack_bot_install', purpose: 'setup_bot_install', redirectUri: REDIRECT_URI,
      leaseExpiresAt: now + SLACK_INSTALL_PROCESSING_LEASE_MS,
    });
    assert.equal(first.status, 'processing');
    await assert.rejects(
      () => fixture.identity.acquireSlackOAuthAttempt({
        stateHash: sha256(started.state), browserHash: sha256(BROWSER_BINDING),
        kind: 'slack_bot_install', purpose: 'setup_bot_install', redirectUri: REDIRECT_URI,
        leaseExpiresAt: now + SLACK_INSTALL_PROCESSING_LEASE_MS,
      }),
      /processing lease/i,
    );
    now += SLACK_INSTALL_PROCESSING_LEASE_MS + 1;
    await assert.rejects(
      () => fixture.identity.acquireSlackOAuthAttempt({
        stateHash: sha256(started.state), browserHash: sha256('different-browser-binding-value'),
        kind: 'slack_bot_install', purpose: 'setup_bot_install', redirectUri: REDIRECT_URI,
        leaseExpiresAt: now + SLACK_INSTALL_PROCESSING_LEASE_MS,
      }),
      /browser/i,
    );
    const reclaimed = await fixture.identity.acquireSlackOAuthAttempt({
      stateHash: sha256(started.state), browserHash: sha256(BROWSER_BINDING),
      kind: 'slack_bot_install', purpose: 'setup_bot_install', redirectUri: REDIRECT_URI,
      leaseExpiresAt: now + SLACK_INSTALL_PROCESSING_LEASE_MS,
    });
    assert.equal(reclaimed.leaseGeneration, 2);
  } finally {
    fixture.close();
  }
});

test('retention deletes expired OAuth authority without blocking a later signed Events proof', async () => {
  let now = NOW;
  const fixture = await installFixture({ now: () => now });
  try {
    const started = await fixture.start();
    assert.equal((await fixture.service.callback({
      state: started.state,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      code: 'retention-code',
    })).status, 'waiting_events');
    now += SLACK_INSTALL_ATTEMPT_TTL_MS + 1;
    const swept = await fixture.identity.sweepSlackIdentityRetention(now, 24 * 60 * 60_000);
    assert.equal(swept.deletedSlackOAuthAttempts, 1);
    assert.equal(swept.deletedOrphanedSlackEventsProofs, 0);
    assert.equal(await fixture.identity.getSlackOAuthAttempt(started.attemptId), undefined);

    await fixture.recordChallenge();
    assert.equal(
      (await fixture.service.finalizeWaitingInstallation(fixture.setup.id)).status,
      'bot_installed',
    );
    const active = await fixture.identity.getActiveSlackCredentialRevision(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    );
    assert.ok(active);
    assert.ok(await fixture.identity.getSlackEventsProof(active.revision));
  } finally {
    fixture.close();
  }
});

test('a callback near attempt expiry uses a truncated lease and the attempt still expires at 15 minutes', async () => {
  let now = NOW;
  const nearExpiry = await installFixture({ now: () => now });
  try {
    const started = await nearExpiry.start();
    now += SLACK_INSTALL_ATTEMPT_TTL_MS - 60_000;
    const result = await nearExpiry.service.callback({
      state: started.state,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      code: 'near-expiry-code',
    });
    assert.equal(result.status, 'waiting_events');
    assert.equal((await nearExpiry.identity.getSlackOAuthAttempt(started.attemptId))?.status, 'validated');
  } finally {
    nearExpiry.close();
  }

  now = NOW;
  const expired = await installFixture({ now: () => now });
  try {
    const started = await expired.start();
    now += SLACK_INSTALL_ATTEMPT_TTL_MS;
    await assert.rejects(
      () => expired.service.callback({
        state: started.state,
        browserBinding: BROWSER_BINDING,
        redirectUri: REDIRECT_URI,
        code: 'too-late-code',
      }),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'expired_state',
    );
    assert.equal((await expired.identity.getSlackOAuthAttempt(started.attemptId))?.status, 'expired');
    assert.equal(expired.exchangeCalls, 0);
  } finally {
    expired.close();
  }
});

test('callback rejects wrong browser, callback, and OAuth purpose before code exchange', async () => {
  const fixture = await installFixture();
  try {
    const started = await fixture.start();
    await assert.rejects(
      () => fixture.service.callback({
        state: started.state,
        browserBinding: 'wrong-browser-binding-0123456789abcdefghijklmnop',
        redirectUri: REDIRECT_URI,
        code: 'unused-code',
      }),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'wrong_browser',
    );
    await assert.rejects(
      () => fixture.service.callback({
        state: started.state,
        browserBinding: BROWSER_BINDING,
        redirectUri: `${ORIGIN}/auth/slack/oidc/callback`,
        code: 'unused-code',
      }),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'wrong_callback',
    );
    await assert.rejects(
      () => fixture.identity.acquireSlackOAuthAttempt({
        stateHash: sha256(started.state), browserHash: sha256(BROWSER_BINDING),
        kind: 'slack_bot_install', purpose: 'slack_oidc' as never, redirectUri: REDIRECT_URI,
        leaseExpiresAt: NOW + SLACK_INSTALL_PROCESSING_LEASE_MS,
      }),
      /purpose/i,
    );
    assert.equal(fixture.exchangeCalls, 0);
  } finally {
    fixture.close();
  }
});

test('token response rejects wrong app, workspace, bot token type, and installer', async () => {
  const cases: Array<{
    name: string;
    options: FixtureOptions;
    expected: SlackInstallOAuthError['code'];
    start?: Partial<Parameters<SlackInstallOAuthService['start']>[0]>;
  }> = [
    { name: 'app', options: { responseAppId: 'AOTHER' }, expected: 'app_mismatch' },
    {
      name: 'workspace', options: { responseTeamId: 'TOTHER' }, expected: 'workspace_mismatch',
      start: { expectedTeamId: 'TACME' },
    },
    { name: 'token type', options: { tokenType: 'user' }, expected: 'wrong_token_type' },
    {
      name: 'installer', options: { installerUserId: 'UOTHER' }, expected: 'installer_mismatch',
      start: { expectedInstallerSlackUserId: 'UINSTALLER' },
    },
  ];
  for (const entry of cases) {
    const fixture = await installFixture(entry.options);
    try {
      const started = await fixture.service.start({
        setupId: fixture.setup.id,
        expectedSetupRevision: fixture.setup.revision,
        browserBinding: BROWSER_BINDING,
        redirectUri: REDIRECT_URI,
        destination: '/admin/channels',
        ...entry.start,
      });
      await assert.rejects(
        () => fixture.service.callback({
          state: started.state,
          browserBinding: BROWSER_BINDING,
          redirectUri: REDIRECT_URI,
          code: `wrong-${entry.name}`,
        }),
        (error: unknown) => error instanceof SlackInstallOAuthError && error.code === entry.expected,
        entry.name,
      );
      assert.equal((await fixture.identity.getSlackOAuthAttempt(started.attemptId))?.status, 'failed');
      const exchanges = fixture.exchangeCalls;
      await assert.rejects(
        () => fixture.service.callback({
          state: started.state,
          browserBinding: BROWSER_BINDING,
          redirectUri: REDIRECT_URI,
          code: `replay-${entry.name}`,
        }),
        (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'invalid_state',
      );
      assert.equal(fixture.exchangeCalls, exchanges);
    } finally {
      fixture.close();
    }
  }
});

test('auth.test, directory, and channel capability mismatches fail before candidate staging', async () => {
  const cases: Array<{ name: string; options: FixtureOptions; expected: SlackInstallOAuthError['code'] }> = [
    { name: 'auth app mismatch', options: { authAppId: 'AOTHER' }, expected: 'app_mismatch' },
    { name: 'auth team mismatch', options: { authTeamId: 'TOTHER' }, expected: 'workspace_mismatch' },
    { name: 'auth bot mismatch', options: { authBotUserId: 'UOTHER' }, expected: 'bot_mismatch' },
    { name: 'directory unavailable', options: { directoryError: 'not_allowed' }, expected: 'directory_unavailable' },
    { name: 'channel unavailable', options: { channelError: 'not_allowed' }, expected: 'channel_unavailable' },
  ];
  for (const entry of cases) {
    const fixture = await installFixture(entry.options);
    try {
      const started = await fixture.start();
      await assert.rejects(
        () => fixture.service.callback({
          state: started.state,
          browserBinding: BROWSER_BINDING,
          redirectUri: REDIRECT_URI,
          code: `capability-${entry.name}`,
        }),
        (error: unknown) => error instanceof SlackInstallOAuthError && error.code === entry.expected,
        entry.name,
      );
      assert.equal((await fixture.identity.getSlackSetupTransaction(fixture.setup.id))?.state, 'app_created');
      assert.equal((await fixture.identity.getSlackOAuthAttempt(started.attemptId))?.status, 'failed');
      const exchanges = fixture.exchangeCalls;
      await assert.rejects(
        () => fixture.service.callback({
          state: started.state,
          browserBinding: BROWSER_BINDING,
          redirectUri: REDIRECT_URI,
          code: `replay-${entry.name}`,
        }),
        (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'invalid_state',
      );
      assert.equal(fixture.exchangeCalls, exchanges);
    } finally {
      fixture.close();
    }
  }
});

test('invalid Slack token responses settle the attempt while transport ambiguity retains only its lease', async () => {
  const invalidBodies: Array<{ name: string; options: FixtureOptions }> = [
    {
      name: 'non-boolean ok',
      options: { tokenResponseOverride: { ok: 'true' } },
    },
    {
      name: 'fatal utf8',
      options: { rawTokenResponse: new Uint8Array([0xc3, 0x28]) },
    },
    {
      name: 'oversized body',
      options: { rawTokenResponse: new TextEncoder().encode('x'.repeat(64 * 1_024 + 1)) },
    },
    {
      name: 'http failure',
      options: { tokenHttpStatus: 500, tokenResponseOverride: { ok: true } },
    },
  ];
  for (const entry of invalidBodies) {
    const fixture = await installFixture(entry.options);
    try {
      const started = await fixture.start();
      await assert.rejects(
        () => fixture.service.callback({
          state: started.state,
          browserBinding: BROWSER_BINDING,
          redirectUri: REDIRECT_URI,
          code: `invalid-${entry.name}`,
        }),
        (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'invalid_response',
        entry.name,
      );
      assert.equal((await fixture.identity.getSlackOAuthAttempt(started.attemptId))?.status, 'failed');
      const exchanges = fixture.exchangeCalls;
      await assert.rejects(
        () => fixture.service.callback({
          state: started.state,
          browserBinding: BROWSER_BINDING,
          redirectUri: REDIRECT_URI,
          code: `replay-${entry.name}`,
        }),
        (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'invalid_state',
      );
      assert.equal(fixture.exchangeCalls, exchanges);
    } finally {
      fixture.close();
    }
  }

  const ambiguous = await installFixture({ transportError: true });
  try {
    const started = await ambiguous.start();
    await assert.rejects(
      () => ambiguous.service.callback({
        state: started.state,
        browserBinding: BROWSER_BINDING,
        redirectUri: REDIRECT_URI,
        code: 'transport-ambiguous',
      }),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'slack_unreachable',
    );
    assert.equal((await ambiguous.identity.getSlackOAuthAttempt(started.attemptId))?.status, 'processing');
    await assert.rejects(
      () => ambiguous.service.callback({
        state: started.state,
        browserBinding: BROWSER_BINDING,
        redirectUri: REDIRECT_URI,
        code: 'transport-replay',
      }),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'processing',
    );
    assert.equal(ambiguous.exchangeCalls, 1);
  } finally {
    ambiguous.close();
  }
});

test('a late signed challenge cannot promote a candidate after its app credential revision was revoked', async () => {
  const fixture = await installFixture();
  try {
    const started = await fixture.start();
    const waiting = await fixture.service.callback({
      state: started.state,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      code: 'oauth-code',
    });
    assert.equal(waiting.status, 'waiting_events');
    const control = await fixture.identity.getSlackCredentialControl();
    await fixture.identity.tombstoneSlackCredentialRevision({
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      revision: fixture.setup.credentialRevision!,
      expectedRotationEpoch: control!.rotationEpoch,
    });
    await fixture.recordChallenge();
    await assert.rejects(
      () => fixture.service.finalizeWaitingInstallation(fixture.setup.id),
      (error: unknown) => error instanceof SlackInstallOAuthError && error.code === 'stale_revision',
    );
    const setup = await fixture.identity.getSlackSetupTransaction(fixture.setup.id);
    const candidate = await fixture.identity.getSlackCredentialRevision(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      setup!.botCredentialRevision!,
    );
    assert.equal(candidate?.status, 'tombstoned');
    assert.equal((await fixture.identity.getSlackSetupTransaction(fixture.setup.id))?.state, 'install_failed');

    const restartedAuthority = await mintSetupCapability({ now: () => NOW + 1 });
    const restarted = await openSlackSetupTransaction(fixture.identity, {
      capability: restartedAuthority.capability,
      authority: restartedAuthority,
      canonicalAdminOrigin: ORIGIN,
      destination: '/admin/channels',
      now: () => NOW + 1,
    });
    assert.equal(restarted.state, 'app_created');
    assert.equal(restarted.botCredentialRevision, null);
    assert.equal(restarted.slackTeamId, null);
    assert.equal(restarted.installerSlackUserId, null);
    assert.equal(restarted.botUserId, null);
    assert.equal(restarted.lastErrorCode, null);
  } finally {
    fixture.close();
  }
});

type FixtureOptions = {
  now?: () => number;
  databasePath?: string;
  keyring?: ReturnType<typeof generateCredentialKeyring>;
  tokenScopes?: readonly string[];
  tokenType?: string;
  responseAppId?: string;
  responseTeamId?: string;
  responseBotUserId?: string;
  installerUserId?: string;
  authAppId?: string;
  authTeamId?: string;
  authBotUserId?: string;
  directoryError?: string;
  channelError?: string;
  tokenResponseOverride?: unknown;
  rawTokenResponse?: Uint8Array;
  tokenHttpStatus?: number;
  transportError?: boolean;
};

async function installFixture(options: FixtureOptions = {}) {
  const now = options.now ?? (() => NOW);
  const databasePath = options.databasePath ?? ':memory:';
  const identity = new SqliteIdentityStore(databasePath, { now });
  const config = new SqliteConfigStore(databasePath);
  const settings = new SqliteSettingsStore(databasePath);
  const workspaceIdentity = await config.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
  await config.updateSlackIdentity(workspaceIdentity.id, workspaceIdentity.connectionRevision, {
    lifecycle: 'setup_incomplete',
    credentialProvenance: 'none',
    health: 'unknown',
  });
  const credentials: SlackCredentialDependencies = {
    state: identity,
    keyring: options.keyring ?? generateCredentialKeyring('key_v1'),
  };
  const minted = await mintSetupCapability({ now });
  const initial = await openSlackSetupTransaction(identity, {
    capability: minted.capability,
    authority: minted,
    canonicalAdminOrigin: ORIGIN,
    destination: '/admin/channels',
    now,
  });
  const setup = await new SlackAppCreationService({
    identity,
    credentials,
    now,
    fetch: (async () => jsonResponse({
      ok: true,
      app_id: 'A12345678',
      credentials: {
        client_id: '123.456',
        client_secret: 'client-secret-value',
        signing_secret: 'signing-secret-value',
      },
    })) as typeof fetch,
  }).create({
    setupId: initial.id,
    expectedRevision: initial.revision,
    configurationToken: 'xoxe.xoxp-install-fixture-token',
    manifest: buildSlackAppManifest({ kind: 'control_plane', origin: ORIGIN }),
  });
  let exchangeCalls = 0;
  let exchangeRequest: Request | undefined;
  let randomCounter = 0;
  const tokenScopes = options.tokenScopes ?? REQUIRED_SLACK_BOT_SCOPES;
  const service = new SlackInstallOAuthService({
    identity,
    credentials,
    config,
    settings,
    now,
    randomBytes: (length) => new Uint8Array(length).fill(++randomCounter),
    fetch: (async (input, init) => {
      exchangeCalls += 1;
      exchangeRequest = new Request(input, init);
      if (options.transportError) throw new Error('synthetic transport ambiguity');
      if (options.rawTokenResponse) {
        return new Response(options.rawTokenResponse as unknown as BodyInit, {
          status: options.tokenHttpStatus ?? 200,
        });
      }
      if (options.tokenResponseOverride !== undefined) {
        return new Response(JSON.stringify(options.tokenResponseOverride), {
          status: options.tokenHttpStatus ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return jsonResponse({
        ok: true,
        access_token: 'xoxb-bot-token-secret',
        token_type: options.tokenType ?? 'bot',
        scope: tokenScopes.join(','),
        bot_user_id: options.responseBotUserId ?? 'UBOT',
        app_id: options.responseAppId ?? 'A12345678',
        team: { id: options.responseTeamId ?? 'TACME', name: 'Acme' },
        authed_user: { id: options.installerUserId ?? 'UINSTALLER' },
      });
    }) as typeof fetch,
    bootstrap: {
      now,
      authTest: async () => ({
        ok: true, error: undefined, appId: options.authAppId ?? 'A12345678',
        teamId: options.authTeamId ?? 'TACME', teamName: 'Acme', botName: 'Chickpea',
        botUserId: options.authBotUserId ?? 'UBOT', botId: 'BBOT',
        grantedScopes: [...tokenScopes],
      }),
      botIdentityInfo: async () => ({
        ok: true, error: undefined, displayName: 'Chickpea', avatarUrl: undefined,
        appId: 'A12345678',
      }),
      usersList: async () => ({
        ok: options.directoryError === undefined, error: options.directoryError,
        users: [], nextCursor: undefined, retryAfterMs: undefined,
      }),
      conversationsList: async () => ({
        ok: options.channelError === undefined, error: options.channelError,
        channels: [], nextCursor: undefined,
      }),
    },
  });
  return {
    identity,
    config,
    settings,
    credentials,
    setup,
    service,
    minted,
    get exchangeCalls() { return exchangeCalls; },
    get exchangeRequest() { return exchangeRequest; },
    start: () => service.start({
      setupId: setup.id,
      expectedSetupRevision: setup.revision,
      browserBinding: BROWSER_BINDING,
      redirectUri: REDIRECT_URI,
      destination: '/admin/channels',
    }),
    async recordChallenge() {
      const slackIdentity = await config.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
      assert.equal(slackIdentity.lifecycle, 'credentials_pending');
      const body = JSON.stringify({
        type: 'url_verification', challenge: 'challenge-install',
        api_app_id: 'A12345678', team_id: 'TACME',
      });
      const timestamp = String(Math.floor(now() / 1_000));
      const signature = `v0=${createHmac('sha256', 'signing-secret-value')
        .update(`v0:${timestamp}:${body}`).digest('hex')}`;
      const recorded = await recordPendingSlackChallenge(settings, slackIdentity, {
        rawBody: body, signature, timestamp,
      }, { now: now() });
      assert.equal(recorded.accepted, true);
    },
    close() {
      identity.close();
      config.close();
      settings.close();
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
