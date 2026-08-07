import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { nativePasswordPrimitive } from '../src/auth/password.ts';
import { deriveBetterAuthSecret } from '../src/auth/recovery-secret.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const ORIGIN = 'https://chickpea.example';
const RECOVERY = '9d'.repeat(32);
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

  const entry = await app.request(`${ORIGIN}/admin`);
  assert.equal(entry.status, 303);
  assert.equal(entry.headers.get('location'), '/admin/setup');
  const setupPage = await app.request(`${ORIGIN}/admin/setup`);
  assert.equal(setupPage.status, 200);
  assert.match(await setupPage.text(), /Create your Chickpea workspace/);
  const setup = await app.request(formRequest('/admin/setup', {
    organizationName: 'Acme',
    displayName: 'Owner Person',
    ownerEmail: 'owner@example.com',
    password: PASSWORD,
    recoveryToken: RECOVERY,
  }));
  assert.equal(setup.status, 303, await setup.clone().text());
  assert.equal(setup.headers.get('location'), '/admin/ready');
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
  assert.match(await wrong.text(), /Email or password was not accepted/);

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

  const recovered = await app.request(formRequest('/admin/recovery', {
    ownerEmail: 'owner@example.com',
    newPassword: PASSWORD,
    recoveryToken: RECOVERY,
  }));
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.match(await recovered.text(), /Password recovered/);

  const afterRecovery = await app.request(formRequest('/admin/login', {
    email: 'owner@example.com', password: PASSWORD, returnTo: '/admin/account',
  }));
  assert.equal(afterRecovery.status, 303);
  assert.match(cookieHeader(afterRecovery.headers.get('set-cookie')), /better-auth\.session_token=/);
  backend.close();
  identity.close();
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
    organizationName: 'Acme', displayName: 'Owner', ownerEmail: 'owner@example.com',
    password: PASSWORD, recoveryToken: RECOVERY,
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
      displayName: 'Attacker',
      ownerEmail: 'attacker@example.com',
      password: PASSWORD,
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
