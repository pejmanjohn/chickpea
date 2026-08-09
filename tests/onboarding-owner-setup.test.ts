import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderPasswordOwnerSetupPage } from '../src/admin/page.ts';
import { createAdminRoutes } from '../src/admin/routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { nativePasswordPrimitive } from '../src/auth/password.ts';
import { deriveBetterAuthSecret } from '../src/auth/recovery-secret.ts';
import {
  mintSetupCapability,
  SETUP_CAPABILITY_DIGEST_BINDING,
  SETUP_CAPABILITY_ISSUED_AT_BINDING,
  SETUP_CAPABILITY_TTL_MS,
} from '../src/auth/setup-capability.mjs';
import { passwordOwnerSetupClientScript } from '../src/auth/setup-handoff.ts';
import { PasswordOwnerSetupService } from '../src/auth/setup.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

const ORIGIN = 'https://chickpea.example';
const AUTHORITY = '7b'.repeat(32);
const PASSWORD = 'several unrelated words 5729';

test('fresh owner setup asks only for email, password, and password confirmation', () => {
  const page = renderPasswordOwnerSetupPage();

  assert.match(page, /name="ownerEmail"/);
  assert.match(page, /name="password"/);
  assert.match(page, /name="passwordConfirmation"/);
  assert.match(page, /name="recoveryToken" type="hidden"/);
  assert.doesNotMatch(page, /organizationName|Organization name/);
  assert.doesNotMatch(page, /Setup code|manual-capability/);
});

test('owner setup client has no manual capability entry fallback', () => {
  const client = passwordOwnerSetupClientScript();

  assert.doesNotMatch(client, /owner-setup-manual/);
  assert.match(client, /private setup link/i);
  assert.match(client, /password-confirmation/);
});

test('deploy capability creates one fixed-name owner workspace and expires from deploy time', async () => {
  const issuedAt = Date.now();
  const minted = await mintSetupCapability({ now: () => issuedAt });
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = {
    backend,
    baseURL: ORIGIN,
    password: nativePasswordPrimitive(),
    recoveryToken: AUTHORITY,
    secret: await deriveBetterAuthSecret(AUTHORITY),
  };
  const setup = new PasswordOwnerSetupService(
    identity,
    environment,
    () => issuedAt + 1_000,
    { digest: minted.digest, issuedAt: minted.issuedAt },
  );

  await assert.rejects(() => setup.complete({
    canonicalOrigin: ORIGIN,
    email: 'owner@example.com',
    password: PASSWORD,
    recoveryToken: 'wrong'.repeat(11),
  }));
  const result = await setup.complete({
    canonicalOrigin: ORIGIN,
    email: 'owner@example.com',
    password: PASSWORD,
    recoveryToken: minted.capability,
  });
  assert.equal((await backend.getOrganization(result.organizationId))?.name, 'Chickpea');
  await assert.rejects(() => setup.complete({
    canonicalOrigin: ORIGIN,
    email: 'owner@example.com',
    password: PASSWORD,
    recoveryToken: minted.capability,
  }));
  backend.close();
  identity.close();

  const expiredIdentity = new SqliteIdentityStore(':memory:');
  const expiredBackend = new NodeBetterAuthBackend(':memory:');
  const expired = new PasswordOwnerSetupService(
    expiredIdentity,
    { ...environment, backend: expiredBackend },
    () => issuedAt + SETUP_CAPABILITY_TTL_MS,
    { digest: minted.digest, issuedAt: minted.issuedAt },
  );
  await assert.rejects(() => expired.complete({
    canonicalOrigin: ORIGIN,
    email: 'owner@example.com',
    password: PASSWORD,
    recoveryToken: minted.capability,
  }));
  expiredBackend.close();
  expiredIdentity.close();
});

test('fresh Worker setup needs no recovery token and rejects mismatched confirmation', async () => {
  const issuedAt = Date.now();
  const minted = await mintSetupCapability({ now: () => issuedAt });
  const identity = new SqliteIdentityStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = {
    backend,
    baseURL: ORIGIN,
    password: nativePasswordPrimitive(),
    recoveryToken: AUTHORITY,
    secret: await deriveBetterAuthSecret(AUTHORITY),
  };
  const app = createAdminRoutes({
    identity,
    settings,
    betterAuthEnvironment: environment,
    authSecret: AUTHORITY,
  });
  const bindings = {
    CHICKPEA_AUTH_SECRET: AUTHORITY,
    [SETUP_CAPABILITY_DIGEST_BINDING]: minted.digest,
    [SETUP_CAPABILITY_ISSUED_AT_BINDING]: String(minted.issuedAt),
  };
  const entry = await app.request(`${ORIGIN}/admin`, {}, bindings);
  assert.equal(entry.status, 303);
  assert.equal(entry.headers.get('location'), '/admin/setup');

  const submit = (passwordConfirmation: string) => {
    const body = new URLSearchParams({
      ownerEmail: 'owner@example.com',
      password: PASSWORD,
      passwordConfirmation,
      recoveryToken: minted.capability,
    }).toString();
    return app.request(`${ORIGIN}/admin/setup`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    }, bindings);
  };
  assert.equal((await submit('different password')).status, 401);
  const setup = await submit(PASSWORD);
  assert.equal(setup.status, 303, await setup.clone().text());
  assert.equal(setup.headers.get('location'), '/admin/onboarding');
  assert.equal((await settings.getSetting('onboarding.journey.v1')) !== undefined, true);
  backend.close();
  settings.close();
  identity.close();
});
