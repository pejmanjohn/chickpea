import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { mintSetupCapability } from '../src/auth/setup-capability.mjs';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

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
    assert.match(html, /Bot installation and Owner sign-in are separate journeys/);
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
