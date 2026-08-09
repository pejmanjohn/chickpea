import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { createBetterAuth } from '../src/auth/better-auth.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { nativePasswordPrimitive } from '../src/auth/password.ts';
import { deriveBetterAuthSecret } from '../src/auth/recovery-secret.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const ORIGIN = 'https://chickpea.example';
const RECOVERY = '6c'.repeat(32);
const OWNER_PASSWORD = 'several unrelated words 5729';
const MEMBER_PASSWORD = 'different unrelated words 4821';
const RESET_PASSWORD = 'fresh unrelated words 9053';

test('password-mode invitation, enrollment, suspension, and administrative reset form one lifecycle', async () => {
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
  try {
    const setup = await app.request(formRequest('/admin/setup', {
      organizationName: 'Acme',
      ownerEmail: 'owner@example.com',
      password: OWNER_PASSWORD,
      passwordConfirmation: OWNER_PASSWORD,
      recoveryToken: RECOVERY,
    }));
    assert.equal(setup.status, 303, await setup.clone().text());
    const ownerCookie = cookieHeader(setup.headers.get('set-cookie'));

    const raced = await Promise.all([
      app.request(jsonRequest('/admin/api/team/invitations', 'POST', {
        email: 'Joiner@Example.com',
      }, ownerCookie)),
      app.request(jsonRequest('/admin/api/team/invitations', 'POST', {
        email: 'joiner@example.com',
      }, ownerCookie)),
    ]);
    assert.deepEqual(raced.map((response) => response.status).sort(), [200, 201]);
    const racedInvitations = await Promise.all(raced.map(async (response) => response.json() as Promise<{
      invitation: { id: string; email: string; status: string };
      inviteLink: string;
    }>));
    assert.equal(racedInvitations[0]?.inviteLink, racedInvitations[1]?.inviteLink);
    const invitation = racedInvitations[0]!;
    assert.equal(invitation.invitation.email, 'joiner@example.com');
    assert.equal(invitation.invitation.status, 'pending');
    assert.match(invitation.inviteLink, /^https:\/\/chickpea\.example\/join#invite=auth_operation_/);
    assert.equal(invitation.inviteLink.includes('?'), false);
    const originalCredential = new URL(invitation.inviteLink).hash.slice('#invite='.length);
    const [operationId, token] = originalCredential.split('.');
    assert.ok(operationId && token);

    const team = await app.request(`${ORIGIN}/admin/api/team`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(team.status, 200, await team.clone().text());
    const pending = (await team.json() as {
      invitations: Array<{ email: string; status: string; inviteLink?: string }>;
    }).invitations;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.email, 'joiner@example.com');
    assert.equal(pending[0]?.status, 'pending');
    assert.equal(pending[0]?.inviteLink, invitation.inviteLink);

    const duplicate = await app.request(jsonRequest('/admin/api/team/invitations', 'POST', {
      email: 'joiner@example.com',
    }, ownerCookie));
    assert.equal(duplicate.status, 200, await duplicate.clone().text());
    assert.equal((await duplicate.json() as { inviteLink: string }).inviteLink, invitation.inviteLink);
    assert.equal((await identity.listAuthOperations('invitation_enrollment')).length, 1);

    const obsoleteResend = await app.request(jsonRequest(
      `/admin/api/team/invitations/${invitation.invitation.id}/resend`,
      'POST',
      {},
      ownerCookie,
    ));
    assert.equal(obsoleteResend.status, 404);

    const joinPage = await app.request(`${ORIGIN}/admin/join`);
    assert.equal(joinPage.status, 200);
    assert.match(await joinPage.text(), /Create account and join/);
    const inspected = await app.request(jsonRequest('/admin/join/inspect', 'POST', {
      operationId, token,
    }));
    assert.equal(inspected.status, 200, await inspected.clone().text());
    assert.deepEqual((await inspected.json() as { email: string; accountState: string }), {
      email: 'joiner@example.com',
      accountState: 'new',
      expiresAt: (await identity.getAuthOperation(operationId))!.expiresAt,
    });

    const enrolled = await app.request(jsonRequest('/admin/join', 'POST', {
      operationId,
      token,
      displayName: 'Joiner Person',
      password: MEMBER_PASSWORD,
    }));
    assert.equal(enrolled.status, 200, await enrolled.clone().text());
    const memberCookie = cookieHeader(enrolled.headers.get('set-cookie'));
    assert.match(memberCookie, /better-auth\.session_token=/);
    assert.equal((await identity.getAuthOperation(operationId))?.status, 'consumed');

    const joiner = await backend.findUserByEmail('joiner@example.com');
    assert.ok(joiner);
    const control = await identity.getAuthControl();
    const member = await backend.getMembershipForUser(joiner.id, control!.betterAuthOrganizationId!);
    assert.ok(member);
    assert.equal(member.role, 'admin');
    assert.equal((await app.request(`${ORIGIN}/admin/account`, {
      headers: { cookie: memberCookie },
    })).status, 200);
    assert.equal((await app.request(`${ORIGIN}/admin/api/team`, {
      headers: { cookie: memberCookie },
    })).status, 200);
    const ownerMembership = (await backend.listMemberships(control!.betterAuthOrganizationId!))
      .find((entry) => entry.role === 'owner')!;
    const resetOwnerByAdmin = await app.request(jsonRequest(
      `/admin/api/team/memberships/${ownerMembership.id}/reset`,
      'POST',
      {},
      memberCookie,
    ));
    assert.equal(resetOwnerByAdmin.status, 403);
    const lastOwner = await app.request(jsonRequest(
      `/admin/api/team/memberships/${ownerMembership.id}`,
      'PATCH',
      { status: 'suspended' },
      ownerCookie,
    ));
    assert.equal(lastOwner.status, 409);

    const replay = await app.request(jsonRequest('/admin/join', 'POST', {
      operationId, token, displayName: 'Replay', password: MEMBER_PASSWORD,
    }));
    assert.equal(replay.status, 401);

    const suspended = await app.request(jsonRequest(
      `/admin/api/team/memberships/${member.id}`,
      'PATCH',
      { status: 'suspended' },
      ownerCookie,
    ));
    assert.equal(suspended.status, 200, await suspended.clone().text());
    assert.equal((await app.request(`${ORIGIN}/admin/account`, {
      headers: { cookie: memberCookie },
    })).status, 401);
    const suspendedLogin = await app.request(formRequest('/admin/login', {
      email: 'joiner@example.com', password: MEMBER_PASSWORD, returnTo: '/admin/account',
    }));
    assert.equal(suspendedLogin.status, 401, await suspendedLogin.clone().text());
    const suspendedLoginHtml = await suspendedLogin.text();
    assert.match(suspendedLoginHtml, /Email or password was not accepted/);
    assert.match(suspendedLoginHtml, /value="joiner@example\.com"/);
    const restored = await app.request(jsonRequest(
      `/admin/api/team/memberships/${member.id}`,
      'PATCH',
      { status: 'active' },
      ownerCookie,
    ));
    assert.equal(restored.status, 200, await restored.clone().text());

    const reset = await app.request(jsonRequest(
      `/admin/api/team/memberships/${member.id}/reset`,
      'POST',
      {},
      ownerCookie,
    ));
    assert.equal(reset.status, 201, await reset.clone().text());
    const resetLink = (await reset.json() as { resetLink: string }).resetLink;
    assert.match(resetLink, /^https:\/\/chickpea\.example\/reset#reset=auth_operation_/);
    const resetCredential = new URL(resetLink).hash.slice('#reset='.length);
    const [resetOperationId, resetToken] = resetCredential.split('.');
    assert.ok(resetOperationId && resetToken);
    const resetInspection = await app.request(jsonRequest('/admin/reset', 'POST', {
      operationId: resetOperationId, token: resetToken, inspect: true,
    }));
    assert.equal(resetInspection.status, 200, await resetInspection.clone().text());
    assert.equal((await resetInspection.json() as { email: string }).email, 'joiner@example.com');
    const completedReset = await app.request(jsonRequest('/admin/reset', 'POST', {
      operationId: resetOperationId, token: resetToken, newPassword: RESET_PASSWORD,
    }));
    assert.equal(completedReset.status, 200, await completedReset.clone().text());
    assert.equal((await identity.getAuthOperation(resetOperationId))?.status, 'consumed');
    assert.equal((await app.request(jsonRequest('/admin/login', 'POST', {
      email: 'joiner@example.com', password: MEMBER_PASSWORD, returnTo: '/admin/account',
    }))).status, 401);
    const relogin = await app.request(formRequest('/admin/login', {
      email: 'joiner@example.com', password: RESET_PASSWORD, returnTo: '/admin/account',
    }));
    assert.equal(relogin.status, 303, await relogin.clone().text());
    const resetReplay = await app.request(jsonRequest('/admin/reset', 'POST', {
      operationId: resetOperationId, token: resetToken, newPassword: MEMBER_PASSWORD,
    }));
    assert.equal(resetReplay.status, 401);
  } finally {
    backend.close();
    identity.close();
  }
});

test('concurrent owner demotion or removal retains one active owner', async () => {
  for (const mutation of [{ role: 'admin' }, { status: 'removed' }] as const) {
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
    try {
      const setup = await app.request(formRequest('/admin/setup', {
        organizationName: 'Acme', ownerEmail: 'owner@example.com',
        password: OWNER_PASSWORD, passwordConfirmation: OWNER_PASSWORD, recoveryToken: RECOVERY,
      }));
      const firstCookie = cookieHeader(setup.headers.get('set-cookie'));
      const invitationResponse = await app.request(jsonRequest('/admin/api/team/invitations', 'POST', {
        email: 'second-owner@example.com', role: 'admin',
      }, firstCookie));
      assert.equal(invitationResponse.status, 201, await invitationResponse.clone().text());
      const invitationLink = (await invitationResponse.json() as { inviteLink: string }).inviteLink;
      const [operationId, token] = new URL(invitationLink).hash.slice('#invite='.length).split('.');
      const enrolled = await app.request(jsonRequest('/admin/join', 'POST', {
        operationId,
        token,
        displayName: 'Owner Two',
        password: MEMBER_PASSWORD,
      }));
      assert.equal(enrolled.status, 200, await enrolled.clone().text());
      const secondCookie = cookieHeader(enrolled.headers.get('set-cookie'));
      const control = await identity.getAuthControl();
      const memberships = await backend.listMemberships(control!.betterAuthOrganizationId!);
      const firstOwner = memberships.find((membership) => membership.role === 'owner')!;
      const secondAdmin = memberships.find((membership) => membership.id !== firstOwner.id)!;
      const promoted = await app.request(jsonRequest(
        `/admin/api/team/memberships/${secondAdmin.id}`,
        'PATCH',
        { role: 'owner' },
        firstCookie,
      ));
      assert.equal(promoted.status, 200, await promoted.clone().text());

      const results = await Promise.all([
        app.request(jsonRequest(
          `/admin/api/team/memberships/${firstOwner.id}`,
          'PATCH',
          mutation,
          secondCookie,
        )),
        app.request(jsonRequest(
          `/admin/api/team/memberships/${secondAdmin.id}`,
          'PATCH',
          mutation,
          firstCookie,
        )),
      ]);
      const statuses = results.map((response) => response.status);
      assert.equal(statuses.filter((status) => status === 200).length, 1);
      assert.equal(statuses.every((status) => [200, 401, 409].includes(status)), true);
      const remainingOwners = (await backend.listMemberships(control!.betterAuthOrganizationId!))
        .filter((membership) => membership.role === 'owner');
      assert.equal(remainingOwners.length, 1);
      const overlay = await identity.getMembershipAccessOverlay(remainingOwners[0]!.id);
      assert.notEqual(overlay?.accessStatus, 'suspended');
    } finally {
      backend.close();
      identity.close();
    }
  }
});

test('an existing credentialed invitee signs in normally and resumes the exact same-tab invitation', async () => {
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
  try {
    const setup = await app.request(formRequest('/admin/setup', {
      organizationName: 'Acme', ownerEmail: 'owner@example.com',
      password: OWNER_PASSWORD, passwordConfirmation: OWNER_PASSWORD, recoveryToken: RECOVERY,
    }));
    const ownerCookie = cookieHeader(setup.headers.get('set-cookie'));
    const privateAuth = createBetterAuth({ ...environment, allowSignUp: true, autoSignInAfterSignUp: false });
    await privateAuth.api.signUpEmail({
      body: { email: 'existing@example.com', name: 'Existing User', password: MEMBER_PASSWORD },
    });

    const created = await app.request(jsonRequest('/admin/api/team/invitations', 'POST', {
      email: 'existing@example.com',
    }, ownerCookie));
    assert.equal(created.status, 201, await created.clone().text());
    const link = (await created.json() as { inviteLink: string }).inviteLink;
    const [operationId, token] = new URL(link).hash.slice('#invite='.length).split('.');
    assert.ok(operationId && token);
    const inspected = await app.request(jsonRequest('/admin/join/inspect', 'POST', {
      operationId, token,
    }));
    assert.equal(inspected.status, 200);
    assert.equal((await inspected.json() as { accountState: string }).accountState, 'existing');

    const loginPage = await app.request(`${ORIGIN}/admin/login?returnTo=%2Fadmin%2Fjoin`);
    assert.equal(loginPage.status, 401);
    assert.match(await loginPage.text(), /name="returnTo"[^>]+value="\/admin\/join"/);
    const login = await app.request(formRequest('/admin/login', {
      email: 'existing@example.com', password: MEMBER_PASSWORD, returnTo: '/admin/join',
    }));
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/admin/join');
    const existingCookie = cookieHeader(login.headers.get('set-cookie'));
    const accepted = await app.request(jsonRequest('/admin/join', 'POST', {
      operationId, token,
    }, existingCookie));
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal((await identity.getAuthOperation(operationId))?.status, 'consumed');
    const existing = await backend.findUserByEmail('existing@example.com');
    const control = await identity.getAuthControl();
    assert.ok(existing && await backend.getMembershipForUser(
      existing.id,
      control!.betterAuthOrganizationId!,
    ));
  } finally {
    backend.close();
    identity.close();
  }
});

function formRequest(path: string, values: Record<string, string>): Request {
  const body = new URLSearchParams(values).toString();
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': '203.0.113.17',
    },
    body,
  });
}

function jsonRequest(
  path: string,
  method: string,
  value: Record<string, unknown>,
  cookie?: string,
): Request {
  const body = JSON.stringify(value);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': '203.0.113.18',
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
}

function cookieHeader(setCookie: string | null): string {
  return (setCookie ?? '').split(';', 1)[0] ?? '';
}
