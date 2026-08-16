import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SlackAdmissionService } from '../src/auth/slack-admission.ts';
import { AuthRateLimiter } from '../src/auth/rate-limit.ts';
import { mintSetupCapability } from '../src/auth/setup-capability.mjs';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { recordPendingSlackChallenge } from '../src/slack/identity-handshake.ts';
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
    assert.match(await opened.text(), /Create programmatically/);

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
    assert.match(firstHtml, /Inspect your Slack apps/);
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
      slackIdentityBootstrap: {
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
    assert.equal(start.status, 302, await start.clone().text());
    const authorization = new URL(start.headers.get('location')!);
    assert.equal(authorization.origin, 'https://slack.com');
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /__Secure-chickpea_slack_install=/);
    assert.match(cookie, /Path=\/auth\/slack\/install/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, new RegExp(authority.capability));

    assert.match(cookie, /Max-Age=900/i);
    const firstCookie = cookie.split(';', 1)[0]!;
    const approvalUrl = new URL(`${ORIGIN}/auth/slack/install/callback`);
    approvalUrl.searchParams.set('state', authorization.searchParams.get('state')!);
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
    assert.equal(setupAfterApproval?.expiresAt, NOW + (7 * 24 * 60 * 60_000));
    exchangeMode = 'success';
    const resume = await app.request(`${ORIGIN}/auth/slack/install/resume`, {
      method: 'POST', headers: formHeaders(), body: new URLSearchParams({
        capability: authority.capability, destination: '/admin/channels',
      }),
    }, env);
    assert.equal(resume.status, 302, await resume.clone().text());
    const resumedAuthorization = new URL(resume.headers.get('location')!);
    assert.notEqual(resumedAuthorization.searchParams.get('state'), authorization.searchParams.get('state'));
    const resumedCookieHeader = resume.headers.get('set-cookie')!;
    assert.notEqual(resumedCookieHeader.split(';', 1)[0], firstCookie);
    assert.match(resumedCookieHeader, /Max-Age=900/i);

    const resumedCookie = resumedCookieHeader.split(';', 1)[0]!;
    const callbackUrl = new URL(`${ORIGIN}/auth/slack/install/callback`);
    callbackUrl.searchParams.set('state', resumedAuthorization.searchParams.get('state')!);
    callbackUrl.searchParams.set('code', 'route-code-secret');
    const callback = await app.request(callbackUrl, { headers: { cookie: resumedCookie } }, env);
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(
      callback.headers.get('location'),
      '/admin/setup?slack_install=waiting_events&destination=%2Fadmin%2Fchannels',
    );
    assert.match(callback.headers.get('set-cookie') ?? '', /Max-Age=0/i);
    assert.equal(exchangeCalls, 3);

    const slackIdentity = await config.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
    assert.equal(slackIdentity.lifecycle, 'credentials_pending');
    const eventBody = JSON.stringify({
      type: 'url_verification', challenge: 'route-events-proof',
      api_app_id: 'A12345678', team_id: 'TACME',
    });
    const timestamp = String(Math.floor(routeNow / 1_000));
    const signature = `v0=${createHmac('sha256', 'route-signing-secret')
      .update(`v0:${timestamp}:${eventBody}`).digest('hex')}`;
    assert.equal((await recordPendingSlackChallenge(settings, slackIdentity, {
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
    assert.equal(start.status, 302);
    assert.equal(start.headers.get('location'), `https://slack.com/openid/connect/authorize?state=${state}`);
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
) {
  return app.request(`${ORIGIN}/admin/setup`, {
    method: 'POST', headers: formHeaders(), body: new URLSearchParams(fields),
  }, env);
}

function formHeaders(): Record<string, string> {
  return {
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded',
  };
}
