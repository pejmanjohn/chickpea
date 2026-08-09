import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { nativePasswordPrimitive } from '../src/auth/password.ts';
import { deriveBetterAuthSecret } from '../src/auth/recovery-secret.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const ORIGIN = 'https://chickpea.example';
const RECOVERY = '9d'.repeat(32);
const ROTATED_RECOVERY = '8c'.repeat(32);
const PASSWORD = 'several unrelated words 5729';
const NEXT_PASSWORD = 'another set of unrelated words 9182';

test('fresh password setup, login, self-change, logout, and owner recovery form one lifecycle', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = {
    backend,
    baseURL: ORIGIN,
    password: nativePasswordPrimitive(),
    recoveryToken: RECOVERY,
    secret: await deriveBetterAuthSecret(RECOVERY),
  };
  const app = createAdminRoutes({ identity, betterAuthEnvironment: environment, recoveryToken: RECOVERY });

  const passwordClient = await app.request(`${ORIGIN}/admin/password/client.js`);
  assert.equal(passwordClient.status, 200);
  assert.match(passwordClient.headers.get('content-type') ?? '', /^application\/javascript/);
  assert.match(await passwordClient.text(), /more character/);

  const entry = await app.request(`${ORIGIN}/admin`);
  assert.equal(entry.status, 303);
  assert.equal(entry.headers.get('location'), '/admin/setup');
  const setupPage = await app.request(`${ORIGIN}/admin/setup`);
  assert.equal(setupPage.status, 200);
  const setupHtml = await setupPage.text();
  assert.match(setupHtml, /Create your Chickpea workspace/);
  assert.match(setupHtml, /\/admin\/setup\/client\.js/);
  assert.match(setupHtml, /minlength="8"/);
  assert.match(setupHtml, /id="password-error"/);
  assert.doesNotMatch(setupHtml, /Your name|Deployment recovery secret/);
  const setupClient = await app.request(`${ORIGIN}/admin/setup/client.js`);
  assert.equal(setupClient.status, 200);
  assert.match(setupClient.headers.get('content-type') ?? '', /^application\/javascript/);
  assert.doesNotMatch(await setupClient.text(), new RegExp(RECOVERY));
  const shortSetup = await app.request(formRequest('/admin/setup', {
    organizationName: 'Acme',
    ownerEmail: 'owner@example.com',
    password: 'short',
    passwordConfirmation: 'short',
    recoveryToken: RECOVERY,
  }));
  assert.equal(shortSetup.status, 401);
  const shortSetupHtml = await shortSetup.text();
  assert.match(shortSetupHtml, /at least 8 characters/);
  assert.doesNotMatch(shortSetupHtml, /organizationName|Organization name/);
  assert.match(shortSetupHtml, /value="owner@example\.com"/);
  const setup = await app.request(formRequest('/admin/setup', {
    organizationName: 'Acme',
    ownerEmail: 'owner@example.com',
    password: PASSWORD,
    passwordConfirmation: PASSWORD,
    recoveryToken: RECOVERY,
  }));
  assert.equal(setup.status, 303, await setup.clone().text());
  assert.equal(setup.headers.get('location'), '/admin/onboarding');
  const setupCookie = cookieHeader(setup.headers.get('set-cookie'));
  assert.match(setupCookie, /better-auth\.session_token=/);
  assert.equal((await app.request(`${ORIGIN}/admin/account`, {
    headers: { cookie: setupCookie },
  })).status, 200);

  const loggedOut = await app.request(formRequest('/admin/logout', {}, { cookie: setupCookie }));
  assert.equal(loggedOut.status, 303);
  assert.equal((await app.request(`${ORIGIN}/admin/account`, {
    headers: { cookie: setupCookie },
  })).status, 401);

  const wrong = await app.request(formRequest('/admin/login', {
    email: 'owner@example.com', password: 'wrong but deliberately long password', returnTo: '/admin',
  }));
  assert.equal(wrong.status, 401);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /Email or password was not accepted/);
  assert.match(wrongHtml, /value="owner@example\.com"/);

  const login = await app.request(formRequest('/admin/login', {
    email: 'owner@example.com', password: PASSWORD, returnTo: '/admin/account',
  }));
  assert.equal(login.status, 303, await login.clone().text());
  assert.equal(login.headers.get('location'), '/admin/account');
  const loginCookie = cookieHeader(login.headers.get('set-cookie'));

  const changed = await app.request(formRequest('/admin/account/password', {
    currentPassword: PASSWORD,
    newPassword: NEXT_PASSWORD,
  }, { cookie: loginCookie }));
  assert.equal(changed.status, 303, await changed.clone().text());
  assert.equal(changed.headers.get('location'), '/admin/login');
  assert.equal((await app.request(`${ORIGIN}/admin/account`, {
    headers: { cookie: loginCookie },
  })).status, 401);

  backend.database.exec(`CREATE TRIGGER fail_recovery_password_update
    BEFORE UPDATE OF password ON account
    BEGIN SELECT RAISE(ABORT, 'simulated password update failure'); END`);
  const interruptedRecovery = await app.request(formRequest('/admin/recovery', {
    ownerEmail: 'owner@example.com',
    newPassword: PASSWORD,
    recoveryToken: RECOVERY,
  }));
  assert.equal(interruptedRecovery.status, 401);
  backend.database.exec('DROP TRIGGER fail_recovery_password_update');

  const replayedRecovery = await app.request(formRequest('/admin/recovery', {
    ownerEmail: 'owner@example.com',
    newPassword: PASSWORD,
    recoveryToken: RECOVERY,
  }));
  assert.equal(replayedRecovery.status, 401);

  const rotatedEnvironment = { ...environment, recoveryToken: ROTATED_RECOVERY };
  const rotatedApp = createAdminRoutes({
    identity,
    betterAuthEnvironment: rotatedEnvironment,
    recoveryToken: ROTATED_RECOVERY,
  });
  const recovered = await rotatedApp.request(formRequest('/admin/recovery', {
    ownerEmail: 'owner@example.com',
    newPassword: PASSWORD,
    recoveryToken: ROTATED_RECOVERY,
  }));
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.match(await recovered.text(), /Password recovered/);

  const replayedRotatedRecovery = await rotatedApp.request(formRequest('/admin/recovery', {
    ownerEmail: 'owner@example.com',
    newPassword: NEXT_PASSWORD,
    recoveryToken: ROTATED_RECOVERY,
  }));
  assert.equal(replayedRotatedRecovery.status, 401);

  const afterRecovery = await app.request(formRequest('/admin/login', {
    email: 'owner@example.com', password: PASSWORD, returnTo: '/admin/account',
  }));
  assert.equal(afterRecovery.status, 303);
  assert.match(cookieHeader(afterRecovery.headers.get('set-cookie')), /better-auth\.session_token=/);
  backend.close();
  identity.close();
});

test('local preview human auth forms accept the opaque Origin emitted by embedded browsers', async () => {
  const origin = 'http://127.0.0.1:5174';
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = {
    backend,
    baseURL: origin,
    password: nativePasswordPrimitive(),
    recoveryToken: RECOVERY,
    secret: await deriveBetterAuthSecret(RECOVERY),
  };
  const app = createAdminRoutes({ identity, betterAuthEnvironment: environment, recoveryToken: RECOVERY });
  const body = new URLSearchParams({
    organizationName: 'Local Preview',
    ownerEmail: 'owner@example.com',
    password: PASSWORD,
    passwordConfirmation: PASSWORD,
    recoveryToken: RECOVERY,
  }).toString();
  const response = await app.request(new Request(`${origin}/admin/setup`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new TextEncoder().encode(body).byteLength),
    },
    body,
  }));
  assert.equal(response.status, 303, await response.clone().text());
  assert.equal(response.headers.get('location'), '/admin/onboarding');
  const setupCookie = cookieHeader(response.headers.get('set-cookie'));

  const changeBody = new URLSearchParams({
    currentPassword: PASSWORD,
    newPassword: NEXT_PASSWORD,
  }).toString();
  const changed = await app.request(new Request(`${origin}/admin/account/password`, {
    method: 'POST',
    headers: {
      cookie: setupCookie,
      origin: 'null',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new TextEncoder().encode(changeBody).byteLength),
    },
    body: changeBody,
  }));
  assert.equal(changed.status, 303, await changed.clone().text());
  assert.equal(changed.headers.get('location'), '/admin/login');

  const loginBody = new URLSearchParams({
    email: 'owner@example.com',
    password: NEXT_PASSWORD,
    returnTo: '/admin/account',
  }).toString();
  const login = await app.request(new Request(`${origin}/admin/login`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new TextEncoder().encode(loginBody).byteLength),
    },
    body: loginBody,
  }));
  assert.equal(login.status, 303, await login.clone().text());
  const loginCookie = cookieHeader(login.headers.get('set-cookie'));

  const logoutBody = '';
  const loggedOut = await app.request(new Request(`${origin}/admin/logout`, {
    method: 'POST',
    headers: {
      cookie: loginCookie,
      origin: 'null',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new TextEncoder().encode(logoutBody).byteLength),
    },
    body: logoutBody,
  }));
  assert.equal(loggedOut.status, 303, await loggedOut.clone().text());
  assert.equal(loggedOut.headers.get('location'), '/admin/login');
  backend.close();
  identity.close();
});

test('hosted setup accepts an opaque Origin only with browser-authenticated same-origin metadata', async () => {
  const fixture = async () => {
    const identity = new SqliteIdentityStore(':memory:');
    const backend = new NodeBetterAuthBackend(':memory:');
    const environment = {
      backend,
      baseURL: ORIGIN,
      password: nativePasswordPrimitive(),
      recoveryToken: RECOVERY,
      secret: await deriveBetterAuthSecret(RECOVERY),
    };
    const app = createAdminRoutes({ identity, betterAuthEnvironment: environment, recoveryToken: RECOVERY });
    return { app, backend, identity };
  };
  const body = new URLSearchParams({
    organizationName: 'Embedded Browser',
    ownerEmail: 'embedded@example.com',
    password: PASSWORD,
    passwordConfirmation: PASSWORD,
    recoveryToken: RECOVERY,
  }).toString();
  const request = (fetchSite?: string) => new Request(`${ORIGIN}/admin/setup`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new TextEncoder().encode(body).byteLength),
      ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
    },
    body,
  });

  const deniedFixture = await fixture();
  for (const fetchSite of [undefined, 'same-site', 'cross-site']) {
    const denied = await deniedFixture.app.request(request(fetchSite));
    assert.equal(denied.status, 401, `expected ${fetchSite ?? 'missing'} Fetch Metadata to be denied`);
    assert.equal(await deniedFixture.identity.getOrganization(), undefined);
  }
  deniedFixture.backend.close();
  deniedFixture.identity.close();

  const acceptedFixture = await fixture();
  const accepted = await acceptedFixture.app.request(request('same-origin'));
  assert.equal(accepted.status, 303, await accepted.clone().text());
  assert.equal(accepted.headers.get('location'), '/admin/onboarding');
  assert.match(cookieHeader(accepted.headers.get('set-cookie')), /better-auth\.session_token=/);

  acceptedFixture.backend.close();
  acceptedFixture.identity.close();
});

test('password setup rejects a malicious return destination and machine credentials on human routes', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = {
    backend,
    baseURL: ORIGIN,
    password: nativePasswordPrimitive(),
    recoveryToken: RECOVERY,
    secret: await deriveBetterAuthSecret(RECOVERY),
  };
  const app = createAdminRoutes({ identity, betterAuthEnvironment: environment, recoveryToken: RECOVERY });
  await app.request(formRequest('/admin/setup', {
    organizationName: 'Acme', ownerEmail: 'owner@example.com',
    password: PASSWORD, passwordConfirmation: PASSWORD, recoveryToken: RECOVERY,
  }));
  const login = await app.request(formRequest('/admin/login', {
    email: 'owner@example.com', password: PASSWORD, returnTo: 'https://evil.example/steal',
  }));
  assert.equal(login.headers.get('location'), '/admin');
  const patAttempt = await app.request(formRequest('/admin/account/password', {
    currentPassword: PASSWORD, newPassword: NEXT_PASSWORD,
  }, { authorization: 'Bearer not-a-browser-session' }));
  assert.notEqual(patAttempt.status, 200);
  backend.close();
  identity.close();
});

test('fresh password setup cannot replace an existing legacy organization', async () => {
  for (const authMode of ['access_pending', 'token_active'] as const) {
    const identity = new SqliteIdentityStore(':memory:');
    const backend = new NodeBetterAuthBackend(':memory:');
    const organization = await identity.ensureOrganization({ displayName: 'Existing Chickpea' });
    await identity.updateOrganizationAuth({
      organizationId: organization.id,
      authMode,
      canonicalAdminOrigin: ORIGIN,
    });
    const environment = {
      backend,
      baseURL: ORIGIN,
      password: nativePasswordPrimitive(),
      recoveryToken: RECOVERY,
      secret: await deriveBetterAuthSecret(RECOVERY),
    };
    const app = createAdminRoutes({ identity, betterAuthEnvironment: environment, recoveryToken: RECOVERY });
    const denied = await app.request(formRequest('/admin/setup', {
      organizationName: 'Replacement',
      ownerEmail: 'attacker@example.com',
      password: PASSWORD,
      passwordConfirmation: PASSWORD,
      recoveryToken: RECOVERY,
    }));
    assert.equal(denied.status, 401);
    assert.equal((await identity.getOrganization())?.authMode, authMode);
    assert.equal(await identity.getAuthControl(), undefined);
    assert.equal(await backend.findUserByEmail('attacker@example.com'), null);
    backend.close();
    identity.close();
  }
});

function formRequest(
  path: string,
  values: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Request {
  const body = new URLSearchParams(values).toString();
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': '203.0.113.12',
      ...extraHeaders,
    },
    body,
  });
}

function cookieHeader(setCookie: string | null): string {
  return (setCookie ?? '').split(';', 1)[0] ?? '';
}
