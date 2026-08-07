import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBetterAuth } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { PasswordOwnerSetupService } from '../src/auth/setup.ts';
import { nativePasswordPrimitive } from '../src/auth/password.ts';
import { deriveBetterAuthSecret } from '../src/auth/recovery-secret.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';

const ORIGIN = 'https://chickpea.example';
const RECOVERY = '7b'.repeat(32);
const PASSWORD = 'several unrelated words 5729';

test('recovery-gated owner setup commits authority last and returns a usable Better Auth session', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const password = nativePasswordPrimitive();
  const environment = {
    backend,
    baseURL: ORIGIN,
    password,
    recoveryToken: RECOVERY,
    secret: await deriveBetterAuthSecret(RECOVERY),
  };
  const setup = new PasswordOwnerSetupService(identity, environment);

  const result = await setup.complete({
    canonicalOrigin: ORIGIN,
    displayName: 'Pejman Owner',
    email: 'Owner@Example.com',
    organizationName: 'Acme',
    password: PASSWORD,
    recoveryToken: RECOVERY,
  });

  const control = await identity.getAuthControl();
  assert.equal(control?.authMode, 'password_active');
  assert.equal(control?.canonicalAdminOrigin, ORIGIN);
  assert.equal(control?.betterAuthOrganizationId, result.organizationId);
  assert.match(result.headers.get('set-cookie') ?? '', /better-auth\.session_token=/);
  assert.equal((await backend.getUser(result.userId))?.email, 'owner@example.com');
  assert.equal((await backend.getMembership(result.membershipId))?.role, 'owner');
  const operation = await identity.getAuthOperation(result.operationId);
  assert.equal(operation?.status, 'consumed');

  const publicAuth = createBetterAuth({
    backend,
    baseURL: ORIGIN,
    password,
    secret: environment.secret,
  });
  const session = await publicAuth.api.getSession({
    headers: { cookie: cookieHeader(result.headers.get('set-cookie')) },
  });
  assert.equal(session?.user.email, 'owner@example.com');

  await assert.rejects(() => setup.complete({
    canonicalOrigin: ORIGIN,
    displayName: 'Pejman Owner',
    email: 'owner@example.com',
    organizationName: 'Acme',
    password: PASSWORD,
    recoveryToken: RECOVERY,
  }));
  backend.close();
  identity.close();
});

test('wrong recovery proof creates no Better Auth user or Chickpea authority', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = {
    backend,
    baseURL: ORIGIN,
    password: nativePasswordPrimitive(),
    recoveryToken: RECOVERY,
    secret: await deriveBetterAuthSecret(RECOVERY),
  };
  const setup = new PasswordOwnerSetupService(identity, environment);

  await assert.rejects(() => setup.complete({
    canonicalOrigin: ORIGIN,
    displayName: 'Owner',
    email: 'owner@example.com',
    organizationName: 'Acme',
    password: PASSWORD,
    recoveryToken: '2a'.repeat(32),
  }));

  assert.equal(await backend.findUserByEmail('owner@example.com'), null);
  assert.notEqual((await identity.getAuthControl())?.authMode, 'password_active');
  identity.close();
  backend.close();
});

test('owner setup resumes after either Better Auth/control-store boundary without duplicates', async () => {
  for (const failedStep of [1, 2]) {
    const identity = new SqliteIdentityStore(':memory:');
    const backend = new NodeBetterAuthBackend(':memory:');
    const environment = {
      backend,
      baseURL: ORIGIN,
      password: nativePasswordPrimitive(),
      recoveryToken: RECOVERY,
      secret: await deriveBetterAuthSecret(RECOVERY),
    };
    let shouldFail = true;
    const flakyIdentity = new Proxy(identity, {
      get(target, property, receiver) {
        if (property === 'advanceAuthOperation') {
          return async (input: { step: number }) => {
            if (shouldFail && input.step === failedStep) {
              shouldFail = false;
              throw new Error(`injected after Better Auth step ${failedStep}`);
            }
            return target.advanceAuthOperation(input as Parameters<IdentityStore['advanceAuthOperation']>[0]);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as IdentityStore;
    const input = {
      canonicalOrigin: ORIGIN,
      displayName: 'Owner',
      email: 'owner@example.com',
      organizationName: 'Acme',
      password: PASSWORD,
      recoveryToken: RECOVERY,
    };

    await assert.rejects(() => new PasswordOwnerSetupService(flakyIdentity, environment).complete(input));
    assert.equal((await identity.getAuthControl())?.authMode, 'unconfigured');
    const result = await new PasswordOwnerSetupService(identity, environment).complete(input);
    assert.equal((await identity.getAuthOperation(result.operationId))?.status, 'consumed');
    assert.equal((await backend.listMembershipsForUser(result.userId)).length, 1);
    backend.close();
    identity.close();
  }
});

function cookieHeader(setCookie: string | null): string {
  return (setCookie ?? '').split(';', 1)[0] ?? '';
}
