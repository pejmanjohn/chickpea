import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import {
  SlackCredentialRecoveryError,
  SlackCredentialRecoveryService,
  SLACK_RECOVERY_TTL_MS,
} from '../src/auth/recovery.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  promoteSlackCredentialBundle,
  resolveSlackInstallationCredentials,
  stageSlackCredentialBundle,
} from '../src/slack/installation-credentials.ts';
import { recordPendingSlackChallenge } from '../src/slack/installation-handshake.ts';
import { buildSlackAppManifest, slackManifestFingerprint } from '../src/slack/app-manifest.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';

const NOW = 1_786_000_000_000;
const ORIGIN = 'https://chickpea.example';
const REDIRECT = `${ORIGIN}/auth/slack/recovery/callback`;
const TOKEN = 'a'.repeat(64);
const BROWSER = 'recovery-browser-binding-0123456789abcdefghijklmnopqrstuvwxyz';

test('deployment token mints one hashed, browser-bound 15-minute repair session and cannot be reused', async () => {
  const fixture = await recoveryFixture();
  try {
    const begun = await fixture.service.begin({ recoveryToken: TOKEN, browserBinding: BROWSER });
    assert.equal(begun.expiresAt, NOW + SLACK_RECOVERY_TTL_MS);
    assert.equal(begun.expectedAppId, 'A12345678');
    assert.equal(begun.expectedTeamId, 'TACME');
    const stored = await fixture.identity.getSlackRecoverySession(begun.recoveryId);
    assert.ok(stored);
    assert.notEqual(stored.sessionHash, begun.sessionSecret);
    assert.notEqual(stored.browserHash, BROWSER);
    assert.deepEqual(stored.allowedActions, ['credential_repair', 'url_repair']);
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(TOKEN));
    assert.doesNotMatch(JSON.stringify(await fixture.identity.exportSummary()), /recovery-browser|a{64}/);

    await assert.rejects(
      () => fixture.service.begin({ recoveryToken: TOKEN, browserBinding: BROWSER }),
      (error: unknown) => error instanceof SlackCredentialRecoveryError && error.code === 'grant_reused',
    );
    await assert.rejects(
      () => fixture.service.inspect({
        recoveryId: begun.recoveryId,
        sessionSecret: begun.sessionSecret,
        browserBinding: `${BROWSER}-wrong`,
      }),
      (error: unknown) => error instanceof SlackCredentialRecoveryError && error.code === 'wrong_browser',
    );
  } finally { fixture.close(); }
});

test('repair stages only the unchanged app/team and promotes after confidential OAuth plus signed Events proof', async () => {
  const fixture = await recoveryFixture();
  try {
    const begun = await fixture.service.begin({ recoveryToken: TOKEN, browserBinding: BROWSER });
    const authority = { ...begun, browserBinding: BROWSER };
    await assert.rejects(
      () => fixture.service.stageAppCredentials({
        ...authority, appId: 'AOTHER', teamId: 'TACME', clientId: '123.456',
        clientSecret: 'replacement-client-secret', signingSecret: 'replacement-signing-secret',
        manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
      }),
      (error: unknown) => error instanceof SlackCredentialRecoveryError && error.code === 'app_mismatch',
    );
    const staged = await fixture.service.stageAppCredentials({
      ...authority, appId: 'A12345678', teamId: 'TACME', clientId: '123.456',
      clientSecret: 'replacement-client-secret', signingSecret: 'replacement-signing-secret',
      manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
    });
    const recoveryCandidate = await fixture.identity.getSlackRecoverySession(begun.recoveryId);
    assert.equal(recoveryCandidate?.status, 'credentials_staged');
    assert.equal(recoveryCandidate?.appCredentialRevision, staged.candidateRevision);
    assert.ok(recoveryCandidate?.appCredentialEnvelope?.ciphertext);
    assert.doesNotMatch(JSON.stringify(recoveryCandidate), /replacement-client-secret/);
    assert.equal(
      (await fixture.identity.getActiveSlackCredentialRevision(WORKSPACE_SLACK_INSTALLATION_ID))?.revision,
      fixture.activeRevision,
    );

    const started = await fixture.service.startBotOAuth({ ...authority, redirectUri: REDIRECT });
    const authorization = new URL(started.authorizationUrl);
    assert.equal(authorization.searchParams.get('scope'), REQUIRED_SLACK_BOT_SCOPES.join(','));
    assert.equal(authorization.searchParams.has('user_scope'), false);
    assert.equal(authorization.searchParams.has('code_challenge'), false);
    const waiting = await fixture.service.callback({
      ...authority, state: started.state, redirectUri: REDIRECT, code: 'one-time-code',
    });
    assert.equal(waiting.status, 'waiting_events');
    assert.equal(fixture.exchangeCalls, 1);
    assert.equal(fixture.exchangeForm?.get('client_secret'), 'replacement-client-secret');
    assert.equal(fixture.exchangeForm?.has('code_verifier'), false);
    assert.equal(
      (await fixture.identity.getActiveSlackCredentialRevision(WORKSPACE_SLACK_INSTALLATION_ID))?.revision,
      fixture.activeRevision,
    );

    await fixture.recordChallenge('replacement-signing-secret');
    const completed = await fixture.service.finalize(authority);
    assert.equal(completed.status, 'repaired');
    assert.equal((await fixture.identity.getSlackRecoverySession(begun.recoveryId))?.status, 'consumed');
    assert.deepEqual(
      await resolveSlackInstallationCredentials(
        WORKSPACE_SLACK_INSTALLATION_ID, undefined, fixture.credentials,
      ),
      {
        botToken: 'xoxb-replacement-token',
        signingSecret: 'replacement-signing-secret',
        botUserId: 'UBOT',
        connectionRevision: waiting.candidateRevision,
      },
    );
    await assert.rejects(
      () => fixture.service.finalize(authority),
      (error: unknown) => error instanceof SlackCredentialRecoveryError && error.code === 'session_consumed',
    );
  } finally { fixture.close(); }
});

test('lost encryption root stays recovery-only until same-app bot reauthorization and signed proof', async () => {
  const replacementKeyring = generateCredentialKeyring('key_v2');
  const fixture = await recoveryFixture({ serviceKeyring: replacementKeyring });
  try {
    const control = await fixture.identity.ensureAuthControl({ healthGate: 'recovery_only' });
    if (control.healthGate !== 'recovery_only') {
      await fixture.identity.updateAuthControl({
        expectedRevision: control.revision, healthGate: 'recovery_only',
      });
    }
    const begun = await fixture.service.begin({ recoveryToken: TOKEN, browserBinding: BROWSER });
    const authority = { ...begun, browserBinding: BROWSER };
    await fixture.service.stageAppCredentials({
      ...authority, appId: 'A12345678', teamId: 'TACME', clientId: '123.456',
      clientSecret: 'replacement-client-secret', signingSecret: 'replacement-signing-secret',
      manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
    });
    const started = await fixture.service.startBotOAuth({ ...authority, redirectUri: REDIRECT });
    const waiting = await fixture.service.callback({
      ...authority, state: started.state, redirectUri: REDIRECT, code: 'lost-root-code',
    });
    assert.equal((await fixture.identity.getAuthControl())?.healthGate, 'recovery_only');
    assert.equal(
      await fixture.identity.getActiveSlackCredentialRevision(WORKSPACE_SLACK_INSTALLATION_ID),
      undefined,
    );
    assert.equal(
      (await fixture.identity.getSlackCredentialRevision(
        WORKSPACE_SLACK_INSTALLATION_ID, waiting.candidateRevision,
      ))?.status,
      'candidate',
    );
    await fixture.recordChallenge('replacement-signing-secret');
    await fixture.service.finalize(authority);
    assert.equal((await fixture.identity.getAuthControl())?.healthGate, 'normal');
    assert.equal(
      (await fixture.identity.getActiveSlackCredentialRevision(WORKSPACE_SLACK_INSTALLATION_ID))?.revision,
      waiting.candidateRevision,
    );
  } finally { fixture.close(); }
});

test('URL repair accepts only the unchanged app contract and never persists its configuration token', async () => {
  const oldOrigin = 'https://old-chickpea.example';
  const fixture = await recoveryFixture({ initialOrigin: oldOrigin, manifestFlow: true });
  try {
    const begun = await fixture.service.begin({ recoveryToken: TOKEN, browserBinding: BROWSER });
    const authority = { ...begun, browserBinding: BROWSER };
    const expected = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });
    const broader = structuredClone(expected);
    broader.oauth_config.scopes.bot.push('commands');
    await assert.rejects(
      () => fixture.service.repairUrls({
        ...authority, configurationToken: 'xoxe.configuration-token-secret', expectedManifest: broader,
      }),
      (error: unknown) => error instanceof SlackCredentialRecoveryError && error.code === 'manifest_mismatch',
    );
    await fixture.service.repairUrls({
      ...authority, configurationToken: 'xoxe.configuration-token-secret', expectedManifest: expected,
    });
    assert.deepEqual(fixture.manifestCalls.map((call) => call.method), ['export', 'export', 'update', 'export']);
    assert.equal(fixture.manifestCalls.at(-1)?.authorization, 'Bearer xoxe.configuration-token-secret');
    assert.doesNotMatch(
      JSON.stringify(await fixture.identity.getSlackRecoverySession(begun.recoveryId)),
      /configuration-token-secret/,
    );
    assert.equal(
      (await fixture.identity.getSlackRecoverySession(begun.recoveryId))?.manifestFingerprint,
      slackManifestFingerprint(expected),
    );
    await fixture.service.stageAppCredentials({
      ...authority, appId: 'A12345678', teamId: 'TACME', clientId: '123.456',
      clientSecret: 'replacement-client-secret', signingSecret: 'replacement-signing-secret',
      manifest: expected,
    });
    const started = await fixture.service.startBotOAuth({ ...authority, redirectUri: REDIRECT });
    const waiting = await fixture.service.callback({
      ...authority, state: started.state, redirectUri: REDIRECT, code: 'url-repair-code',
    });
    await fixture.recordChallenge('replacement-signing-secret');
    assert.deepEqual(await fixture.service.finalize(authority), { status: 'repaired' });
    const active = await fixture.identity.getActiveSlackCredentialRevision(
      WORKSPACE_SLACK_INSTALLATION_ID,
    );
    assert.equal(active?.revision, waiting.candidateRevision);
    assert.equal(active?.manifestFingerprint, slackManifestFingerprint(expected));
    assert.equal(
      (await fixture.identity.getSlackRecoverySession(begun.recoveryId))?.status,
      'consumed',
    );
  } finally { fixture.close(); }
});

async function recoveryFixture(options: {
  serviceKeyring?: ReturnType<typeof generateCredentialKeyring>;
  initialOrigin?: string;
  manifestFlow?: boolean;
} = {}) {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = { state: identity, keyring: generateCredentialKeyring('key_v1') };
  const manifest = buildSlackAppManifest({
    kind: 'workspace_app', origin: options.initialOrigin ?? ORIGIN,
  });
  const app = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation', purpose: 'app_credentials', expectedActiveRevision: null,
    appId: 'A12345678', manifestFingerprint: slackManifestFingerprint(manifest),
    secrets: { clientId: '123.456', clientSecret: 'old-client-secret', signingSecret: 'old-signing-secret' },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    candidateRevision: app.revision, expectedActiveRevision: null,
  });
  const connected = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation', purpose: 'connected_credentials',
    expectedActiveRevision: app.revision, appId: 'A12345678', teamId: 'TACME', botUserId: 'UBOT',
    grantedScopes: [...REQUIRED_SLACK_BOT_SCOPES], validatedAt: NOW,
    manifestFingerprint: slackManifestFingerprint(manifest),
    secrets: {
      clientId: '123.456', clientSecret: 'old-client-secret', signingSecret: 'old-signing-secret',
      botToken: 'xoxb-old-token',
    },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    candidateRevision: connected.revision, expectedActiveRevision: app.revision,
  });
  let counter = 0;
  let exchangeCalls = 0;
  let exchangeForm: URLSearchParams | undefined;
  const manifestCalls: Array<{ method: string; authorization: string | null }> = [];
  let manifestUpdated = false;
  const serviceCredentials = {
    state: identity,
    keyring: options.serviceKeyring ?? credentials.keyring,
  };
  const service = new SlackCredentialRecoveryService({
    identity, credentials: serviceCredentials, config, settings, expectedRecoveryToken: TOKEN, now: () => NOW,
    randomBytes: (length) => new Uint8Array(length).fill(++counter),
    fetch: async (url, init) => {
      if (options.manifestFlow && String(url).endsWith('/apps.manifest.export')) {
        manifestCalls.push({ method: 'export', authorization: new Headers(init?.headers).get('authorization') });
        const exported = manifestUpdated
          ? buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN })
          : manifest;
        return Response.json({
          ok: true,
          manifest: {
            ...exported,
            oauth_config: { ...exported.oauth_config, pkce_enabled: false },
          },
        });
      }
      if (options.manifestFlow && String(url).endsWith('/apps.manifest.update')) {
        manifestCalls.push({ method: 'update', authorization: new Headers(init?.headers).get('authorization') });
        manifestUpdated = true;
        return Response.json({ ok: true, app_id: 'A12345678' });
      }
      exchangeCalls += 1;
      exchangeForm = new URLSearchParams(String(init?.body ?? ''));
      return Response.json({
        ok: true, access_token: 'xoxb-replacement-token', token_type: 'bot',
        scope: REQUIRED_SLACK_BOT_SCOPES.join(','), bot_user_id: 'UBOT', app_id: 'A12345678',
        team: { id: 'TACME' }, authed_user: { id: 'UINSTALLER' },
      });
    },
    verification: {
      now: () => NOW,
      authTest: async () => ({
        ok: true, error: undefined, teamId: 'TACME', teamName: 'Acme', appId: 'A12345678',
        botId: 'BBOT', botName: 'Chickpea', botUserId: 'UBOT',
        grantedScopes: [...REQUIRED_SLACK_BOT_SCOPES],
      }),
      botIdentityInfo: async () => ({
        ok: true, error: undefined, appId: 'A12345678', displayName: 'Chickpea', avatarUrl: undefined,
      }),
      usersList: async () => ({
        ok: true, error: undefined, users: [], nextCursor: undefined, retryAfterMs: undefined,
      }),
      conversationsList: async () => ({
        ok: true, error: undefined, channels: [], nextCursor: undefined,
      }),
    },
  });
  return {
    identity, config, settings, credentials: serviceCredentials, service, manifestCalls,
    activeRevision: connected.revision,
    get exchangeCalls() { return exchangeCalls; },
    get exchangeForm() { return exchangeForm; },
    async recordChallenge(signingSecret: string) {
      const rawBody = JSON.stringify({
        type: 'url_verification', challenge: 'recovery-proof', api_app_id: 'A12345678', team_id: 'TACME',
      });
      const timestamp = String(Math.floor(NOW / 1_000));
      await recordPendingSlackChallenge(settings, {
        rawBody, timestamp,
        signature: `v0=${createHmac('sha256', signingSecret)
          .update(`v0:${timestamp}:${rawBody}`).digest('hex')}`,
      }, { now: NOW });
    },
    close() { identity.close(); config.close(); settings.close(); },
  };
}
