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
const REPLACEMENT_PASSWORD = 'different unrelated words 4821';

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
  assert.equal((await backend.getUser(result.userId))?.name, 'Owner');
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
      email: 'owner@example.com',
      organizationName: 'Acme',
      password: PASSWORD,
      recoveryToken: RECOVERY,
    };

    await assert.rejects(() => new PasswordOwnerSetupService(flakyIdentity, environment).complete(input));
    assert.equal((await identity.getAuthControl())?.authMode, 'unconfigured');
    const result = await new PasswordOwnerSetupService(identity, environment).complete({
      ...input,
      password: failedStep === 1 ? REPLACEMENT_PASSWORD : PASSWORD,
    });
    assert.equal((await identity.getAuthOperation(result.operationId))?.status, 'consumed');
    assert.equal((await backend.listMembershipsForUser(result.userId)).length, 1);
    const auth = createBetterAuth({ ...environment, allowSignUp: false });
    assert.equal(Boolean(await auth.api.signInEmail({
      body: {
        email: input.email,
        password: failedStep === 1 ? REPLACEMENT_PASSWORD : PASSWORD,
      },
    })), true);
    backend.close();
    identity.close();
  }
});

test('orphan repair resumes only its pending operation after each durable checkpoint', async () => {
  for (const failedBoundary of ['operation', 'user', 'organization'] as const) {
    const identity = new SqliteIdentityStore(':memory:');
    const backend = new NodeBetterAuthBackend(':memory:');
    const environment = {
      backend,
      baseURL: ORIGIN,
      password: nativePasswordPrimitive(),
      recoveryToken: RECOVERY,
      secret: await deriveBetterAuthSecret(RECOVERY),
    };
    const original = await new PasswordOwnerSetupService(identity, environment).complete({
      canonicalOrigin: ORIGIN,
      email: 'original@example.com',
      password: PASSWORD,
      recoveryToken: RECOVERY,
    });
    const orphanedControl = await identity.getAuthControl();
    assert.equal(orphanedControl?.betterAuthOrganizationId, original.organizationId);
    clearBetterAuthAuthority(backend);

    let shouldFail = true;
    const flakyIdentity = new Proxy(identity, {
      get(target, property, receiver) {
        if (property === 'createAuthOperation' && failedBoundary === 'operation') {
          return async (input: Parameters<IdentityStore['createAuthOperation']>[0]) => {
            const operation = await target.createAuthOperation(input);
            if (shouldFail) {
              shouldFail = false;
              throw new Error('injected after recovery operation checkpoint');
            }
            return operation;
          };
        }
        if (property === 'advanceAuthOperation' && failedBoundary !== 'operation') {
          return async (input: Parameters<IdentityStore['advanceAuthOperation']>[0]) => {
            const operation = await target.advanceAuthOperation(input);
            const boundaryStep = failedBoundary === 'user' ? 1 : 2;
            if (shouldFail && input.step === boundaryStep) {
              shouldFail = false;
              throw new Error(`injected after recovery ${failedBoundary} checkpoint`);
            }
            return operation;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as IdentityStore;
    const repairInput = {
      canonicalOrigin: ORIGIN,
      email: 'replacement@example.com',
      password: REPLACEMENT_PASSWORD,
      recoveryToken: RECOVERY,
    };

    await assert.rejects(
      () => new PasswordOwnerSetupService(flakyIdentity, environment).complete(repairInput),
      /injected after recovery/,
    );
    assert.deepEqual(await identity.getAuthControl(), orphanedControl);
    const pending = (await identity.listAuthOperations('owner_setup'))
      .find((operation) => operation.status === 'pending');
    assert.ok(pending);
    assert.equal(pending.organizationId, orphanedControl?.betterAuthOrganizationId);
    assert.equal(pending.targetCredentialVersion, orphanedControl?.revision);
    assert.equal(
      pending.step,
      failedBoundary === 'organization' ? 2 : failedBoundary === 'user' ? 1 : 0,
    );

    const repaired = await new PasswordOwnerSetupService(identity, environment)
      .complete(repairInput);
    assert.equal((await identity.getAuthOperation(repaired.operationId))?.status, 'consumed');
    assert.equal((await backend.listMembershipsForUser(repaired.userId)).length, 1);
    assert.notEqual(repaired.organizationId, original.organizationId);
    assert.equal(
      (await identity.getAuthControl())?.betterAuthOrganizationId,
      repaired.organizationId,
    );
    backend.close();
    identity.close();
  }
});

test('orphan repair resumes Better Auth writes that precede their operation checkpoint', async () => {
  for (const failedWrite of ['user', 'organization'] as const) {
    const identity = new SqliteIdentityStore(':memory:');
    const backend = new NodeBetterAuthBackend(':memory:');
    const environment = {
      backend,
      baseURL: ORIGIN,
      password: nativePasswordPrimitive(),
      recoveryToken: RECOVERY,
      secret: await deriveBetterAuthSecret(RECOVERY),
    };
    await new PasswordOwnerSetupService(identity, environment).complete({
      canonicalOrigin: ORIGIN,
      email: 'original@example.com',
      password: PASSWORD,
      recoveryToken: RECOVERY,
    });
    const orphanedControl = await identity.getAuthControl();
    assert.ok(orphanedControl);
    clearBetterAuthAuthority(backend);

    let shouldFail = true;
    const flakyIdentity = new Proxy(identity, {
      get(target, property, receiver) {
        if (property === 'advanceAuthOperation') {
          return async (input: Parameters<IdentityStore['advanceAuthOperation']>[0]) => {
            const boundaryStep = failedWrite === 'user' ? 1 : 2;
            if (shouldFail && input.step === boundaryStep) {
              shouldFail = false;
              throw new Error(`injected before recovery ${failedWrite} checkpoint`);
            }
            return target.advanceAuthOperation(input);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as IdentityStore;
    const repairInput = {
      canonicalOrigin: ORIGIN,
      email: 'replacement@example.com',
      password: REPLACEMENT_PASSWORD,
      recoveryToken: RECOVERY,
    };

    await assert.rejects(
      () => new PasswordOwnerSetupService(flakyIdentity, environment).complete(repairInput),
      /injected before recovery/,
    );
    assert.deepEqual(await identity.getAuthControl(), orphanedControl);
    const pending = (await identity.listAuthOperations('owner_setup'))
      .find((operation) => operation.status === 'pending');
    assert.ok(pending);
    assert.equal(pending.step, failedWrite === 'user' ? 0 : 1);
    const stagedUser = await backend.findUserByEmail(repairInput.email);
    assert.ok(stagedUser);
    assert.equal(
      (await backend.listMembershipsForUser(stagedUser.id)).length,
      failedWrite === 'organization' ? 1 : 0,
    );

    const repaired = await new PasswordOwnerSetupService(identity, environment)
      .complete(repairInput);
    assert.equal((await identity.getAuthOperation(repaired.operationId))?.status, 'consumed');
    assert.equal((await backend.listMembershipsForUser(repaired.userId)).length, 1);
    assert.equal(
      (await identity.getAuthControl())?.betterAuthOrganizationId,
      repaired.organizationId,
    );
    backend.close();
    identity.close();
  }
});

test('a pending step-zero orphan repair does not adopt arbitrary Better Auth authority', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const environment = {
    backend,
    baseURL: ORIGIN,
    password: nativePasswordPrimitive(),
    recoveryToken: RECOVERY,
    secret: await deriveBetterAuthSecret(RECOVERY),
  };
  await new PasswordOwnerSetupService(identity, environment).complete({
    canonicalOrigin: ORIGIN,
    email: 'original@example.com',
    password: PASSWORD,
    recoveryToken: RECOVERY,
  });
  const orphanedControl = await identity.getAuthControl();
  assert.ok(orphanedControl);
  clearBetterAuthAuthority(backend);

  let interrupted = false;
  const interruptedIdentity = new Proxy(identity, {
    get(target, property, receiver) {
      if (property === 'createAuthOperation') {
        return async (input: Parameters<IdentityStore['createAuthOperation']>[0]) => {
          const operation = await target.createAuthOperation(input);
          if (!interrupted) {
            interrupted = true;
            throw new Error('injected after recovery operation checkpoint');
          }
          return operation;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as IdentityStore;
  const repairInput = {
    canonicalOrigin: ORIGIN,
    email: 'replacement@example.com',
    password: REPLACEMENT_PASSWORD,
    recoveryToken: RECOVERY,
  };
  await assert.rejects(
    () => new PasswordOwnerSetupService(interruptedIdentity, environment).complete(repairInput),
    /injected after recovery operation checkpoint/,
  );

  const arbitraryAuth = createBetterAuth({
    ...environment,
    allowSignUp: true,
    autoSignInAfterSignUp: false,
  });
  await arbitraryAuth.api.signUpEmail({
    body: {
      email: 'unrelated@example.com',
      name: 'Unrelated',
      password: PASSWORD,
    },
  });

  await assert.rejects(
    () => new PasswordOwnerSetupService(identity, environment).complete(repairInput),
  );
  assert.deepEqual(await identity.getAuthControl(), orphanedControl);
  assert.equal((await backend.findUserByEmail('unrelated@example.com'))?.email, 'unrelated@example.com');
  assert.equal(await backend.findUserByEmail(repairInput.email), null);

  clearBetterAuthAuthority(backend);
  const changedControl = await identity.updateAuthControl({
    expectedRevision: orphanedControl.revision,
  });
  await assert.rejects(
    () => new PasswordOwnerSetupService(identity, environment).complete(repairInput),
  );
  assert.deepEqual(await identity.getAuthControl(), changedControl);
  assert.equal(await backend.findUserByEmail(repairInput.email), null);
  backend.close();
  identity.close();
});

test('owner setup keeps authority unconfigured until the initial session exists', async () => {
  const identity = new SqliteIdentityStore(':memory:');
  const backend = new NodeBetterAuthBackend(':memory:');
  const nativePassword = nativePasswordPrimitive();
  let rejectFirstVerification = true;
  const environment = {
    backend,
    baseURL: ORIGIN,
    password: {
      hash: nativePassword.hash,
      async verify(input: { hash: string; password: string }) {
        if (rejectFirstVerification) {
          rejectFirstVerification = false;
          throw new Error('injected first-session failure');
        }
        return nativePassword.verify(input);
      },
    },
    recoveryToken: RECOVERY,
    secret: await deriveBetterAuthSecret(RECOVERY),
  };
  const input = {
    canonicalOrigin: ORIGIN,
    email: 'owner@example.com',
    organizationName: 'Acme',
    password: PASSWORD,
    recoveryToken: RECOVERY,
  };

  await assert.rejects(
    () => new PasswordOwnerSetupService(identity, environment).complete(input),
    /injected first-session failure/,
  );
  assert.equal((await identity.getAuthControl())?.authMode, 'unconfigured');

  const result = await new PasswordOwnerSetupService(identity, environment).complete(input);
  assert.equal((await identity.getAuthControl())?.authMode, 'password_active');
  assert.match(result.headers.get('set-cookie') ?? '', /better-auth\.session_token=/);
  assert.equal((await backend.listMembershipsForUser(result.userId)).length, 1);
  backend.close();
  identity.close();
});

function cookieHeader(setCookie: string | null): string {
  return (setCookie ?? '').split(';', 1)[0] ?? '';
}

function clearBetterAuthAuthority(backend: NodeBetterAuthBackend): void {
  backend.database.exec(`
    DELETE FROM session;
    DELETE FROM invitation;
    DELETE FROM member;
    DELETE FROM organization;
    DELETE FROM verification;
    DELETE FROM account;
    DELETE FROM "user";
  `);
}
