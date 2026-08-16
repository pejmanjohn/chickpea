import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBetterAuthRuntimeRoutes } from '../src/auth/better-auth-runtime.ts';
import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { promoteSlackCredentialBundle, stageSlackCredentialBundle } from '../src/slack/identity-credentials.ts';
import { buildSlackAppManifest, slackManifestFingerprint } from '../src/slack/identity-manifest.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';

test('recovery-only health gate admits no normal session or Slack auth route', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const control = await identity.ensureAuthControl({ healthGate: 'recovery_only' });
    assert.equal(control.healthGate, 'recovery_only');
    const app = createBetterAuthRuntimeRoutes({ identity, authSecret: '0'.repeat(64) });
    for (const path of ['/api/auth/get-session', '/api/auth/sign-out', '/api/auth/slack/start']) {
      const response = await app.request(`https://app.example${path}`);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.has('set-cookie'), false);
    }
  } finally {
    identity.close();
  }
});

test('hidden recovery route mints only an operational repair session and keeps normal control-plane routes closed', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const credentials = { state: identity, keyring: generateCredentialKeyring('key_v1') };
  const token = 'a'.repeat(64);
  try {
    const manifest = buildSlackAppManifest({ kind: 'control_plane', origin: 'https://app.example' });
    const appRevision = await stageSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      identityClass: 'workspace_default', purpose: 'app_credentials', expectedActiveRevision: null,
      appId: 'A12345678', manifestFingerprint: slackManifestFingerprint(manifest),
      secrets: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
    });
    await promoteSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      candidateRevision: appRevision.revision, expectedActiveRevision: null,
    });
    const connected = await stageSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      identityClass: 'workspace_default', purpose: 'connected_credentials',
      expectedActiveRevision: appRevision.revision, appId: 'A12345678', teamId: 'TACME', botUserId: 'UBOT',
      grantedScopes: [...REQUIRED_SLACK_BOT_SCOPES], manifestFingerprint: slackManifestFingerprint(manifest),
      secrets: {
        clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret', botToken: 'xoxb-token',
      },
    });
    await promoteSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      candidateRevision: connected.revision, expectedActiveRevision: appRevision.revision,
    });
    const control = await identity.ensureAuthControl({ healthGate: 'recovery_only' });
    if (control.healthGate !== 'recovery_only') {
      await identity.updateAuthControl({ expectedRevision: control.revision, healthGate: 'recovery_only' });
    }
    const app = createAdminRoutes({
      identity, store: config, settings, slackCredentials: credentials, recoveryToken: token,
    });
    const entry = await app.request('https://app.example/admin/recovery');
    assert.equal(entry.status, 200);
    const entryHtml = await entry.text();
    assert.match(entryHtml, /repairs only the existing Slack app/i);
    assert.doesNotMatch(entryHtml, /owner email|cloudflare access|replace owner password/i);
    assert.equal((await app.request('https://app.example/admin')).status, 404);
    assert.equal((await app.request('https://app.example/api/auth/get-session')).status, 404);

    const invalid = await postRecovery(app, { action: 'begin', recoveryToken: 'b'.repeat(64) });
    assert.equal(invalid.status, 401);
    assert.doesNotMatch(await invalid.text(), /b{64}/);
    const begun = await postRecovery(app, { action: 'begin', recoveryToken: token });
    assert.equal(begun.status, 200);
    const html = await begun.text();
    assert.match(html, /A12345678/);
    assert.match(html, /TACME/);
    assert.doesNotMatch(html, new RegExp(token));
    const cookies = begun.headers.getSetCookie().join(';');
    assert.match(cookies, /__Secure-chickpea_slack_recovery=/);
    assert.match(cookies, /__Secure-chickpea_slack_recovery_browser=/);
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /SameSite=Lax/i);
  } finally {
    identity.close(); config.close(); settings.close();
  }
});

function postRecovery(app: ReturnType<typeof createAdminRoutes>, fields: Record<string, string>) {
  return app.request('https://app.example/admin/recovery', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://app.example',
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams(fields).toString(),
  });
}
