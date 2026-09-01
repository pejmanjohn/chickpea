import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { renderSlackAuthorizationHandoffPage } from '../src/admin/page.ts';
import { SlackAdmissionService } from '../src/auth/slack-admission.ts';
import { AuthRateLimiter } from '../src/auth/rate-limit.ts';
import { SlackOidcError } from '../src/auth/slack-oidc.ts';
import { mintSetupCapability } from '../src/auth/setup-capability.mjs';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { recordPendingSlackChallenge } from '../src/slack/installation-handshake.ts';
import { buildSlackAppManifest } from '../src/slack/app-manifest.ts';
import { SLACK_SETUP_TTL_MS } from '../src/slack/app-creation.ts';
import { SLACK_INSTALL_PROCESSING_LEASE_MS } from '../src/slack/install-oauth.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';

const NOW = 1_786_000_000_000;
const ORIGIN = 'https://chickpea.example';
const CONFIG_TOKEN = 'xoxe.xoxp-route-configuration-token';

test('capability-gated Admin setup creates an app without reflecting or retaining submitted secrets', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const authority = await mintSetupCapability({ now: () => NOW });
  let calls = 0;
  try {
    const app = createAdminRoutes({
      identity,
      slackCredentials: { state: identity, keyring: generateCredentialKeyring('key_v1') },
      slackAppCreationNow: () => NOW,
      slackAppCreationFetch: (async (_input, init) => {
        calls += 1;
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${CONFIG_TOKEN}`);
        assert.doesNotMatch(String(init?.body), /route-configuration-token/);
        return new Response(JSON.stringify({
          ok: true,
          app_id: 'A12345678',
          credentials: {
            client_id: '123.456',
            client_secret: 'route-client-secret',
            signing_secret: 'route-signing-secret',
          },
        }), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const env = setupEnv(authority);
    const page = await app.request(`${ORIGIN}/admin/setup?destination=/admin/channels`, {}, env);
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), new RegExp(authority.capability));
    const client = await app.request(`${ORIGIN}/admin/setup/client.js`, {}, env);
    assert.equal(client.headers.get('content-type'), 'application/javascript; charset=UTF-8');

    const opened = await postSetup(app, env, {
      action: 'open', capability: authority.capability, destination: '/admin/channels',
    });
    assert.equal(opened.status, 200);
    const openedHtml = await opened.text();
    assert.match(openedHtml, /Add Chickpea to Slack/);
    assert.match(openedHtml, /data-primary-action="gateway-install"/);
    assert.match(openedHtml, /Use your own Slack app instead/);

    const created = await postSetup(app, env, {
      action: 'create', capability: authority.capability,
      destination: '/admin/channels', configurationToken: CONFIG_TOKEN,
    });
    assert.equal(created.status, 200);
    const html = await created.text();
    assert.match(html, /Continue to Slack/);
    assert.doesNotMatch(html, /Continue to Admin/);
    assert.doesNotMatch(html, /route-configuration-token|route-client-secret|route-signing-secret/);
    assert.equal(calls, 1);
    const exported = await identity.exportSummary();
    assert.equal('locatorHash' in exported.slackSetupTransactions[0]!, false);
    assert.doesNotMatch(JSON.stringify(exported), /route-client-secret|route-signing-secret/);
  } finally {
    identity.close();
  }
});

test('manual setup is a separate capability-gated journey that adopts into shared installation', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const authority = await mintSetupCapability({ now: () => NOW });
  try {
    const app = createAdminRoutes({
      identity,
      slackCredentials: { state: identity, keyring: generateCredentialKeyring('key_v1') },
      slackAppCreationNow: () => NOW,
    });
    const env = setupEnv(authority);
    const page = await app.request(`${ORIGIN}/admin/setup/manual`, {}, env);
    assert.equal(page.status, 200);
    const initialHtml = await page.text();
    assert.match(initialHtml, /data-slack-manual-setup-state="capability_required"/);
    assert.doesNotMatch(initialHtml, new RegExp(authority.capability));

    const client = await app.request(`${ORIGIN}/admin/setup/manual/client.js`, {}, env);
    assert.equal(client.status, 200);
    assert.equal(client.headers.get('content-type'), 'application/javascript; charset=UTF-8');

    const opened = await postManualSetup(app, env, {
      action: 'open', capability: authority.capability,
    });
    assert.equal(opened.status, 200);
    assert.match(await opened.text(), /Create Chickpea/);

    const expectedManifest = buildExpectedManifest();
    const invalid = await postManualSetup(app, env, {
      action: 'adopt', capability: authority.capability,
      appId: 'A12345678', clientId: '123.456',
      clientSecret: 'route-client-secret-value', signingSecret: 'route-signing-secret-value',
      observedManifest: JSON.stringify({ ...expectedManifest, display_information: { name: 'Wrong' } }),
    });
    assert.equal(invalid.status, 400);
    const invalidHtml = await invalid.text();
    assert.match(invalidHtml, /Add app credentials/);
    assert.match(invalidHtml, /role="alert"/);
    assert.doesNotMatch(invalidHtml, /route-client-secret-value|route-signing-secret-value/);

    const adopted = await postManualSetup(app, env, {
      action: 'adopt', capability: authority.capability,
      appId: 'A12345678', clientId: '123.456',
      clientSecret: 'route-client-secret-value', signingSecret: 'route-signing-secret-value',
      observedManifest: JSON.stringify(expectedManifest),
    });
    assert.equal(adopted.status, 303);
    assert.equal(adopted.headers.get('location'), '/admin/setup');
    const setup = await identity.getSlackSetupTransaction('setup_default');
    assert.equal(setup?.state, 'app_created');
    assert.equal(setup?.destination, '/admin/onboarding');
    assert.doesNotMatch(JSON.stringify(await identity.exportSummary()), /route-client-secret-value|route-signing-secret-value/);
  } finally {
    identity.close();
  }
});

test('manual setup is absent without this deployment capability authority', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  try {
    const app = createAdminRoutes({ identity });
    assert.equal((await app.request(`${ORIGIN}/admin/setup/manual`)).status, 404);
    assert.equal((await app.request(`${ORIGIN}/admin/setup/manual`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        action: 'open', capability: 'not-a-real-capability',
      }),
    })).status, 404);
  } finally {
    identity.close();
  }
});

test('manual setup screenshots are public before the first Owner exists', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  try {
    const app = createAdminRoutes({ identity });
    const response = await app.request(`${ORIGIN}/admin/assets/onboarding/create-workspace.webp`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
    assert.ok(bytes.byteLength > 10_000);
    assert.equal((await app.request(`${ORIGIN}/admin/assets/onboarding/not-real.webp`)).status, 404);
  } finally {
    identity.close();
  }
});

test('ambiguous Admin setup never retries Slack until an explicit restart', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const authority = await mintSetupCapability({ now: () => NOW });
  let calls = 0;
  try {
    const app = createAdminRoutes({
      identity,
      slackCredentials: { state: identity, keyring: generateCredentialKeyring('key_v1') },
      slackAppCreationNow: () => NOW,
      slackAppCreationFetch: (async () => {
        calls += 1;
        throw new Error(`synthetic network failure ${CONFIG_TOKEN}`);
      }) as typeof fetch,
    });
    const env = setupEnv(authority);
    await postSetup(app, env, { action: 'open', capability: authority.capability });
    const ambiguous = await postSetup(app, env, {
      action: 'create', capability: authority.capability, configurationToken: CONFIG_TOKEN,
    });
    assert.equal(ambiguous.status, 409);
    const firstHtml = await ambiguous.text();
    assert.match(firstHtml, /Inspect Slack/);
    assert.doesNotMatch(firstHtml, /route-configuration-token/);

    const noRetry = await postSetup(app, env, {
      action: 'create', capability: authority.capability, configurationToken: CONFIG_TOKEN,
    });
    assert.equal(noRetry.status, 409);
    assert.equal(calls, 1);

    const restarted = await postSetup(app, env, {
      action: 'restart', capability: authority.capability,
    });
    assert.equal(restarted.status, 200);
    assert.equal((await identity.getSlackSetupTransaction('setup_default'))?.state, 'awaiting_app_creation');
  } finally {
    identity.close();
  }
});

test('Admin setup rejects a chunk-sized oversized form before parsing or calling Slack', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const authority = await mintSetupCapability({ now: () => NOW });
  let calls = 0;
  try {
    const app = createAdminRoutes({
      identity,
      slackCredentials: { state: identity, keyring: generateCredentialKeyring('key_v1') },
      slackAppCreationNow: () => NOW,
      slackAppCreationFetch: (async () => { calls += 1; return new Response('{}'); }) as typeof fetch,
    });
    const response = await app.request(`${ORIGIN}/admin/setup`, {
      method: 'POST',
      headers: formHeaders(),
      body: new URLSearchParams({
        action: 'create', capability: authority.capability,
        configurationToken: `${CONFIG_TOKEN}${'x'.repeat(9_000)}`,
      }),
    }, setupEnv(authority));
    assert.equal(response.status, 413);

    const falseLength = await app.request(`${ORIGIN}/admin/setup`, {
      method: 'POST',
      headers: { ...formHeaders(), 'content-length': '1' },
      body: new URLSearchParams({
        action: 'create', capability: authority.capability,
        configurationToken: `${CONFIG_TOKEN}${'x'.repeat(9_000)}`,
      }),
    }, setupEnv(authority));
    assert.equal(falseLength.status, 413);
    assert.equal(calls, 0);
  } finally {
    identity.close();
  }
});

test('public bot-install routes use an independent narrow browser cookie and never require it to be the setup capability', async () => {
  let routeNow = NOW;
  const identity = new SqliteIdentityStore(':memory:', { now: () => routeNow });
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const authority = await mintSetupCapability({ now: () => NOW });
  const slackCredentials = { state: identity, keyring: generateCredentialKeyring('key_v1') };
  let exchangeCalls = 0;
  let exchangeMode: 'transport' | 'approval' | 'success' = 'transport';
  let oauthRandom = 0;
  try {
    const app = createAdminRoutes({
      identity, store: config, settings, slackCredentials,
      slackAppCreationNow: () => NOW,
      slackAppCreationFetch: (async () => new Response(JSON.stringify({
        ok: true,
        app_id: 'A12345678',
        credentials: {
          client_id: '123.456',
          client_secret: 'route-client-secret',
          signing_secret: 'route-signing-secret',
        },
      }), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
      slackInstallNow: () => routeNow,
      slackInstallRandomBytes: (length) => new Uint8Array(length).fill(++oauthRandom),
      slackInstallFetch: (async (_input, init) => {
        exchangeCalls += 1;
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('client_secret'), 'route-client-secret');
        assert.equal(form.has('code_verifier'), false);
        assert.equal(new Headers(init?.headers).has('authorization'), false);
        if (exchangeMode === 'transport') throw new Error('synthetic ambiguous transport');
        return new Response(JSON.stringify(exchangeMode === 'approval' ? {
          ok: false,
          error: 'app_approval_required',
        } : {
          ok: true,
          access_token: 'xoxb-route-bot-token',
          token_type: 'bot',
          scope: REQUIRED_SLACK_BOT_SCOPES.join(','),
          bot_user_id: 'UBOT',
          app_id: 'A12345678',
          team: { id: 'TACME', name: 'Acme' },
          authed_user: { id: 'UINSTALLER' },
        }), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
      slackInstallationVerification: {
        now: () => routeNow,
        authTest: async () => ({
          ok: true, error: undefined, appId: 'A12345678', teamId: 'TACME',
          teamName: 'Acme', botName: 'Chickpea', botUserId: 'UBOT', botId: 'BBOT',
          grantedScopes: [...REQUIRED_SLACK_BOT_SCOPES],
        }),
        botIdentityInfo: async () => ({
          ok: true, error: undefined, displayName: 'Chickpea', avatarUrl: undefined,
          appId: 'A12345678',
        }),
        usersList: async () => ({
          ok: true, error: undefined, users: [], nextCursor: undefined, retryAfterMs: undefined,
        }),
        conversationsList: async () => ({
          ok: true, error: undefined, channels: [], nextCursor: undefined,
        }),
      },
    });
    const env = setupEnv(authority);
    await postSetup(app, env, {
      action: 'open', capability: authority.capability, destination: '/admin/channels',
    });
    await postSetup(app, env, {
      action: 'create', capability: authority.capability, destination: '/admin/channels',
      configurationToken: CONFIG_TOKEN,
    });

    const start = await app.request(`${ORIGIN}/auth/slack/install/start`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        capability: authority.capability, destination: '/admin/channels',
      }),
    }, env);
    assert.equal(start.status, 200, await start.clone().text());
    assert.equal(start.headers.get('location'), null);
    const handoffHtml = await start.clone().text();
    assert.match(handoffHtml, /Opening Slack/);
    assert.match(handoffHtml, /data-slack-authorization-link/);
    assert.match(handoffHtml, /https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
    assert.match(handoffHtml, /src="\/auth\/slack\/continue\.js"/);
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /__Secure-chickpea_slack_install=/);
    assert.match(cookie, /Path=\/auth\/slack\/install/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, new RegExp(authority.capability));

    assert.match(cookie, /Max-Age=900/i);
    const firstCookie = cookie.split(';', 1)[0]!;
    const authorizationState = slackAuthorizationUrlFromHandoff(handoffHtml).searchParams.get('state');
    assert.ok(authorizationState);
    const approvalUrl = new URL(`${ORIGIN}/auth/slack/install/callback`);
    approvalUrl.searchParams.set('state', authorizationState);
    approvalUrl.searchParams.set('code', 'transport-ambiguous-code');
    const transport = await app.request(approvalUrl, { headers: { cookie: firstCookie } }, env);
    assert.equal(transport.status, 503);
    assert.equal(transport.headers.get('set-cookie'), null);
    assert.equal(exchangeCalls, 1);
    const processing = await app.request(approvalUrl, { headers: { cookie: firstCookie } }, env);
    assert.equal(processing.status, 409);
    assert.equal(processing.headers.get('set-cookie'), null);
    assert.equal(exchangeCalls, 1);

    routeNow += SLACK_INSTALL_PROCESSING_LEASE_MS + 1;
    exchangeMode = 'approval';
    approvalUrl.searchParams.set('code', 'approval-required-code');
    const approval = await app.request(approvalUrl, { headers: { cookie: firstCookie } }, env);
    assert.equal(approval.status, 303, await approval.clone().text());
    assert.equal(
      approval.headers.get('location'),
      '/admin/setup?slack_install=approval_pending&destination=%2Fadmin%2Fchannels',
    );
    assert.match(approval.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    assert.equal(exchangeCalls, 2);

    const setupAfterApproval = await identity.getSlackSetupTransaction('setup_default');
    assert.equal(setupAfterApproval?.state, 'approval_pending');
    assert.equal(setupAfterApproval?.expiresAt, NOW + SLACK_SETUP_TTL_MS);
    exchangeMode = 'success';
    const resume = await app.request(`${ORIGIN}/auth/slack/install/resume`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        capability: authority.capability, destination: '/admin/channels',
      }),
    }, env);
    assert.equal(resume.status, 200, await resume.clone().text());
    const resumedHandoffHtml = await resume.clone().text();
    const resumedAuthorizationState = slackAuthorizationUrlFromHandoff(resumedHandoffHtml)
      .searchParams.get('state');
    assert.ok(resumedAuthorizationState);
    assert.notEqual(resumedAuthorizationState, authorizationState);
    const resumedCookieHeader = resume.headers.get('set-cookie')!;
    assert.notEqual(resumedCookieHeader.split(';', 1)[0], firstCookie);
    assert.match(resumedCookieHeader, /Max-Age=900/i);

    const resumedCookie = resumedCookieHeader.split(';', 1)[0]!;
    const callbackUrl = new URL(`${ORIGIN}/auth/slack/install/callback`);
    callbackUrl.searchParams.set('state', resumedAuthorizationState);
    callbackUrl.searchParams.set('code', 'route-code-secret');
    const callback = await app.request(callbackUrl, { headers: { cookie: resumedCookie } }, env);
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      '/admin/setup?slack_install=waiting_events&destination=%2Fadmin%2Fchannels',
    );
    assert.match(callback.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    assert.equal(exchangeCalls, 3);

    const eventBody = JSON.stringify({
      type: 'url_verification', challenge: 'route-events-proof',
      api_app_id: 'A12345678', team_id: 'TACME',
    });
    const timestamp = String(Math.floor(routeNow / 1_000));
    const signature = `v0=${createHmac('sha256', 'route-signing-secret')
      .update(`v0:${timestamp}:${eventBody}`).digest('hex')}`;
    assert.equal((await recordPendingSlackChallenge(settings, {
      rawBody: eventBody, signature, timestamp,
    }, { now: routeNow })).accepted, true);
    const finalized = await app.request(`${ORIGIN}/auth/slack/install/finalize`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        capability: authority.capability, destination: '/admin/channels',
      }),
    }, env);
    assert.equal(finalized.status, 303, await finalized.clone().text());
    assert.equal(
      finalized.headers.get('location'),
      '/admin/setup?slack_install=bot_installed&destination=%2Fadmin%2Fchannels',
    );
    assert.equal((await identity.getSlackSetupTransaction('setup_default'))?.state, 'bot_installed');

    const replay = await app.request(callbackUrl, { headers: { cookie: resumedCookie } }, env);
    assert.equal(replay.status, 400);
    assert.match(replay.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    assert.equal(exchangeCalls, 3);
    const noCookie = await app.request(callbackUrl, {}, env);
    assert.equal(noCookie.status, 400);
    assert.match(noCookie.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    assert.equal((await app.request(`${ORIGIN}/auth/slack/oidc/callback`, {}, env)).status, 404);

    const oversized = await app.request(`${ORIGIN}/auth/slack/install/resume`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        capability: authority.capability, padding: 'x'.repeat(9_000),
      }),
    }, env);
    assert.equal(oversized.status, 413);
  } finally {
    identity.close();
    config.close();
    settings.close();
  }
});

test('public Slack callback is rate limited without exchanging an unrecognized state', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const authority = await mintSetupCapability({ now: () => NOW });
  let exchangeCalls = 0;
  try {
    const app = createAdminRoutes({
      identity,
      store: config,
      settings,
      slackCredentials: { state: identity, keyring: generateCredentialKeyring('key_v1') },
      authRateLimiter: new AuthRateLimiter(identity, {
        pepper: authority.digest,
        now: () => NOW,
        perKeyLimit: 1,
        globalLimit: 10,
      }),
      slackInstallFetch: (async () => {
        exchangeCalls += 1;
        return new Response('{}');
      }) as typeof fetch,
    });
    const env = setupEnv(authority);
    const url = `${ORIGIN}/auth/slack/install/callback?state=${'s'.repeat(32)}&code=unused`;
    const headers = { cookie: `__Secure-chickpea_slack_install=${'b'.repeat(32)}` };
    const first = await app.request(url, { headers }, env);
    assert.equal(first.status, 400);
    assert.match(first.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    const limited = await app.request(url, { headers }, env);
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(exchangeCalls, 0);
  } finally {
    identity.close();
    config.close();
    settings.close();
  }
});

test('Slack authorization handoff script only navigates to exact Slack OAuth endpoints', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  try {
    const app = createAdminRoutes({ identity });
    const response = await app.request(`${ORIGIN}/auth/slack/continue.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/javascript; charset=UTF-8');
    const script = await response.text();
    assert.match(script, /https:\/\/slack\.com/);
    assert.match(script, /\/oauth\/v2\/authorize/);
    assert.match(script, /\/openid\/connect\/authorize/);
    assert.match(script, /location\.replace/);
    assert.doesNotMatch(script, /innerHTML|eval\(/);
  } finally {
    identity.close();
  }
});

test('Slack authorization handoff renderer rejects non-Slack and non-OAuth destinations', () => {
  assert.throws(
    () => renderSlackAuthorizationHandoffPage('https://attacker.example/oauth/v2/authorize'),
    /invalid/i,
  );
  assert.throws(
    () => renderSlackAuthorizationHandoffPage('https://slack.com/api/oauth.v2.access'),
    /invalid/i,
  );
  assert.doesNotThrow(() => renderSlackAuthorizationHandoffPage(
    'https://slack.com/openid/connect/authorize?state=safe-state',
  ));
});

test('Slack-only sign-in uses a narrow nonce cookie and restores the safe Admin destination', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  let startInput: Record<string, unknown> | undefined;
  let callbackInput: Record<string, unknown> | undefined;
  const state = 'state-0123456789abcdefghijklmnopqrstuvwxyz';
  const nonce = 'nonce-0123456789abcdefghijklmnopqrstuvwxyz';
  const service = {
    async startLogin(input: Record<string, unknown>) {
      startInput = input;
      return {
        attemptId: 'slackoidc_route', state, nonce, expiresAt: Date.now() + 900_000,
        authorizationUrl: `https://slack.com/openid/connect/authorize?state=${state}`,
      };
    },
    async callback(input: Record<string, unknown>) {
      callbackInput = input;
      return {
        destination: '/admin/channels',
        sessionResponse: new Response('{}', {
          headers: { 'set-cookie': 'better-auth.session_token=session-secret; Path=/; HttpOnly; Secure' },
        }),
      };
    },
  } as unknown as SlackAdmissionService;
  try {
    const app = createAdminRoutes({
      identity,
      slackAdmissionService: service,
      authSecret: Buffer.alloc(32, 5).toString('base64url'),
    });
    const page = await app.request(`${ORIGIN}/auth/slack/sign-in?destination=/admin/channels`);
    assert.equal(page.status, 401);
    const html = await page.text();
    assert.match(html, /Continue with Slack/);
    assert.doesNotMatch(html, /password|email/i);

    const start = await app.request(`${ORIGIN}/auth/slack/oidc/start`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        purpose: 'login', destination: '/admin/channels',
      }),
    });
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('location'), null);
    const handoffHtml = await start.clone().text();
    assert.match(handoffHtml, /Opening Slack/);
    assert.match(handoffHtml, new RegExp(`https://slack\\.com/openid/connect/authorize\\?state=${state}`));
    assert.match(handoffHtml, /src="\/auth\/slack\/continue\.js"/);
    assert.equal('userId' in (startInput ?? {}), false, 'normal login cannot select a Slack subject');
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /__Secure-chickpea_slack_oidc=login\./);
    assert.match(cookie, /Path=\/auth\/slack\/oidc/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, new RegExp(state));
    const callback = await app.request(
      `${ORIGIN}/auth/slack/oidc/callback?state=${state}&code=oidc-code`,
      { headers: { cookie: cookie.split(';', 1)[0]! } },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(callback.headers.get('location'), '/admin/channels');
    assert.match(callback.headers.get('set-cookie') ?? '', /better-auth\.session_token=session-secret/);
    assert.equal(callbackInput?.nonce, nonce);
    assert.equal(callbackInput?.purpose, 'login');
  } finally {
    identity.close();
  }
});

test('wrong-account login clears callback authority and returns a non-disclosing Slack retry page', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  await identity.ensureOrganization({ displayName: 'Acme', slackTeamId: 'TACME' });
  const state = 'wrong-account-state-0123456789abcdefghijklmnop';
  const nonce = 'wrong-account-nonce-0123456789abcdefghijklmnop';
  let startInput: Record<string, unknown> | undefined;
  const service = {
    async startLogin(input: Record<string, unknown>) {
      startInput = input;
      return {
        attemptId: 'slackoidc_wrong_account', state, nonce, expiresAt: Date.now() + 900_000,
        authorizationUrl: `https://slack.com/openid/connect/authorize?state=${state}`,
      };
    },
    async callback() { throw new SlackOidcError('user_mismatch'); },
  } as unknown as SlackAdmissionService;
  try {
    const app = createAdminRoutes({
      identity, slackAdmissionService: service,
      authSecret: Buffer.alloc(32, 9).toString('base64url'),
    });
    const signIn = await app.request(
      `${ORIGIN}/auth/slack/sign-in?destination=https%3A%2F%2Fattacker.example%2Fadmin`,
    );
    assert.equal(signIn.status, 401);
    assert.equal(signIn.headers.get('cache-control'), 'no-store');
    assert.equal(signIn.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(signIn.headers.get('x-frame-options'), 'DENY');
    assert.match(signIn.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.doesNotMatch(await signIn.text(), /fonts\.googleapis|password|sign up/i);

    const start = await app.request(`${ORIGIN}/auth/slack/oidc/start`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        purpose: 'login', destination: 'https://attacker.example/admin',
      }),
    });
    assert.equal(start.status, 200);
    assert.equal(startInput?.destination, '/admin');
    const cookie = start.headers.get('set-cookie')!;
    assert.doesNotMatch(cookie, /attacker/i);
    const callback = await app.request(
      `${ORIGIN}/auth/slack/oidc/callback?state=${state}&code=wrong-account-code`,
      { headers: { cookie: cookie.split(';', 1)[0]! } },
    );
    assert.equal(callback.status, 403, await callback.clone().text());
    assert.match(callback.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    const html = await callback.text();
    assert.match(html, /Try another Slack account/);
    assert.match(html, /connected Slack workspace \(TACME\)/);
    assert.match(html, /name="destination" value="\/admin"/);
    assert.match(html, /First interact with a Chickpea Agent/);
    assert.match(html, /ask an Owner to restore it/);
    assert.doesNotMatch(html, /expected user|invited user|email|password|attacker/i);
  } finally {
    identity.close();
  }
});

test('Slack invitation handoff keeps the locator in the fragment/session tab and binds OIDC to invitation purpose', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const organization = await identity.ensureOrganization({ displayName: 'Chickpea', slackTeamId: 'TACME' });
  let startInput: Record<string, unknown> | undefined;
  let callbackInput: Record<string, unknown> | undefined;
  const state = 'invite-state-0123456789abcdefghijklmnopqrstuvwxyz';
  const nonce = 'invite-nonce-0123456789abcdefghijklmnopqrstuvwxyz';
  const locator = 'invite-locator-0123456789abcdefghijklmnopqrstuvwxyz';
  const service = {
    async startInvitation(input: Record<string, unknown>) {
      startInput = input;
      return {
        attemptId: 'slackoidc_invite', state, nonce, expiresAt: Date.now() + 900_000,
        authorizationUrl: `https://slack.com/openid/connect/authorize?state=${state}`,
      };
    },
    async callback(input: Record<string, unknown>) {
      callbackInput = input;
      return {
        destination: '/admin/team',
        sessionResponse: new Response('{}', {
          headers: { 'set-cookie': 'better-auth.session_token=invite-session; Path=/; HttpOnly; Secure' },
        }),
      };
    },
  } as unknown as SlackAdmissionService;
  try {
    assert.equal(organization.slackTeamId, 'TACME');
    const app = createAdminRoutes({
      identity,
      slackAdmissionService: service,
      authSecret: Buffer.alloc(32, 7).toString('base64url'),
    });
    const page = await app.request(`${ORIGIN}/auth/slack/invite`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /connected Slack workspace \(TACME\)/);
    assert.match(html, /name="invitation"/);
    assert.doesNotMatch(html, new RegExp(locator));
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const client = await app.request(`${ORIGIN}/auth/slack/invite/client.js`);
    const script = await client.text();
    assert.match(script, /sessionStorage\.setItem/);
    assert.match(script, /history\.replaceState/);
    assert.match(script, /sessionStorage\.removeItem/);
    assert.doesNotMatch(script, new RegExp(locator));

    const start = await app.request(`${ORIGIN}/auth/slack/oidc/start`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        purpose: 'invitation', invitation: locator,
      }),
    });
    assert.equal(start.status, 200, await start.clone().text());
    assert.equal(startInput?.locator, locator);
    assert.equal(startInput?.destination, '/admin/team');
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /__Secure-chickpea_slack_oidc=invitation\./);
    assert.doesNotMatch(cookie, new RegExp(locator));

    const callback = await app.request(
      `${ORIGIN}/auth/slack/oidc/callback?state=${state}&code=invite-code`,
      { headers: { cookie: cookie.split(';', 1)[0]! } },
    );
    assert.equal(callback.status, 200, await callback.clone().text());
    assert.match(await callback.text(), /data-invitation-state="complete"/);
    assert.match(callback.headers.get('set-cookie') ?? '', /better-auth\.session_token=invite-session/);
    assert.equal(callbackInput?.purpose, 'invitation');
    assert.equal(callbackInput?.nonce, nonce);
  } finally {
    identity.close();
  }
});

test('revoked or expired invitation callback is terminal, non-disclosing, and clears browser authority', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  await identity.ensureOrganization({ displayName: 'Chickpea', slackTeamId: 'TACME' });
  const state = 'terminal-state-0123456789abcdefghijklmnopqrstuvwxyz';
  const nonce = 'terminal-nonce-0123456789abcdefghijklmnopqrstuvwxyz';
  const locator = 'terminal-locator-0123456789abcdefghijklmnopqrstuvwxyz';
  const service = {
    async startInvitation() {
      return {
        attemptId: 'slackoidc_terminal', state, nonce, expiresAt: Date.now() + 900_000,
        authorizationUrl: `https://slack.com/openid/connect/authorize?state=${state}`,
      };
    },
    async callback() { throw new SlackOidcError('invitation_unavailable'); },
  } as unknown as SlackAdmissionService;
  try {
    const app = createAdminRoutes({
      identity, slackAdmissionService: service,
      authSecret: Buffer.alloc(32, 8).toString('base64url'),
    });
    const start = await app.request(`${ORIGIN}/auth/slack/oidc/start`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        purpose: 'invitation', invitation: locator,
      }),
    });
    const cookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const callback = await app.request(
      `${ORIGIN}/auth/slack/oidc/callback?state=${state}&code=terminal-code`,
      { headers: { cookie } },
    );
    assert.equal(callback.status, 410);
    assert.match(callback.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    const html = await callback.text();
    assert.match(html, /data-invitation-state="unavailable"/);
    assert.match(html, /use a Chickpea Agent in Slack/i);
    assert.doesNotMatch(html, /create a fresh invitation/i);
    assert.doesNotMatch(html, /terminal-locator|UREVOKED|Invited Admin/i);
    const client = await app.request(`${ORIGIN}/auth/slack/invite/client.js`);
    assert.match(await client.text(), /state === "unavailable"[\s\S]*sessionStorage\.removeItem/);
  } finally {
    identity.close();
  }
});

test('revoked or expired invitation is terminal before Slack OIDC starts', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  await identity.ensureOrganization({ displayName: 'Chickpea', slackTeamId: 'TACME' });
  let callbackCalls = 0;
  const service = {
    async startInvitation() { throw new SlackOidcError('invalid_state'); },
    async callback() { callbackCalls += 1; throw new Error('must not run'); },
  } as unknown as SlackAdmissionService;
  try {
    const app = createAdminRoutes({
      identity, slackAdmissionService: service,
      authSecret: Buffer.alloc(32, 9).toString('base64url'),
    });
    const response = await app.request(`${ORIGIN}/auth/slack/oidc/start`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        purpose: 'invitation', invitation: 'expired-locator-0123456789abcdefghijklmnopqrstuvwxyz',
      }),
    });
    assert.equal(response.status, 410);
    assert.match(await response.text(), /data-invitation-state="unavailable"/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(callbackCalls, 0);
  } finally {
    identity.close();
  }
});

function setupEnv(authority: { digest: string; issuedAt: number }) {
  return {
    CHICKPEA_SETUP_CAPABILITY_DIGEST: authority.digest,
    CHICKPEA_SETUP_CAPABILITY_ISSUED_AT: String(authority.issuedAt),
  };
}

function postSetup(
  app: ReturnType<typeof createAdminRoutes>,
  env: ReturnType<typeof setupEnv>,
  fields: Record<string, string>,
  path = '/admin/setup',
) {
  return app.request(`${ORIGIN}${path}`, {
    method: 'POST', headers: formHeaders(), body: new URLSearchParams(fields),
  }, env);
}

function postManualSetup(
  app: ReturnType<typeof createAdminRoutes>,
  env: ReturnType<typeof setupEnv>,
  fields: Record<string, string>,
) {
  return postSetup(app, env, fields, '/admin/setup/manual');
}

function buildExpectedManifest() {
  return buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });
}

function formHeaders(): Record<string, string> {
  return {
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded',
  };
}

function slackAuthorizationUrlFromHandoff(html: string): URL {
  const encoded = /data-slack-authorization-link href="([^"]+)"/.exec(html)?.[1];
  assert.ok(encoded, 'Slack handoff must expose a fallback authorization link');
  return new URL(encoded.replaceAll('&amp;', '&'));
}
