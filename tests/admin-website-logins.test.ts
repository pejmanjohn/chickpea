import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  listWebsiteLogins,
  readWebsiteLoginSecrets,
  type WebsiteLoginDependencies,
} from '../src/browser/logins.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const PASSWORD = 'website-password-sentinel-91';
const TOTP = 'JBSWY3DPEHPK3PXP';

const owner: AuthPrincipal = {
  userId: 'user_test_owner', membershipId: 'membership_test_owner', organizationId: 'org_oss',
  role: 'owner', authenticatorKind: 'test_slack_session', credentialId: 'session_owner',
  correlationId: 'request_owner', machine: false,
};
const admin: AuthPrincipal = {
  ...owner, userId: 'user_admin', membershipId: 'membership_admin', role: 'admin',
  credentialId: 'session_admin', correlationId: 'request_admin',
};
const ana: AuthPrincipal = {
  ...owner, userId: 'user_ana', membershipId: 'membership_ana', role: 'member',
  credentialId: 'session_ana', correlationId: 'request_ana',
};
const bo: AuthPrincipal = {
  ...owner, userId: 'user_bo', membershipId: 'membership_bo', role: 'member',
  credentialId: 'session_bo', correlationId: 'request_bo',
};
const PRINCIPALS = { owner, admin, ana, bo } as const;
type Who = keyof typeof PRINCIPALS;

function fixture() {
  const store = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const deps: WebsiteLoginDependencies = {
    store: settings,
    keyring: generateCredentialKeyring('website_login_route_test'),
  };
  const snapshots = { listLiveRootsByAgent: async () => [] } as unknown as AgentSnapshotStore;
  const apps = Object.fromEntries(Object.entries(PRINCIPALS).map(([who, principal]) => {
    const app = new Hono();
    app.route('/', createAdminRoutes({
      store,
      settings,
      snapshots,
      websiteLogins: deps,
      knownProviders: new Set(['local-stub']),
      ...testAdminAuthority(`token-${who}`, undefined, undefined, principal),
    }));
    return [who, app];
  })) as Record<Who, Hono>;
  const call = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    apps[who].request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: testAdminHeaders(`token-${who}`, { 'content-type': 'application/json' }),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return {
    store,
    settings,
    deps,
    call,
    close: () => {
      store.close();
      settings.close();
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

async function createAgent(
  f: Fixture,
  id: string,
  editPolicy: 'creator_and_admins' | 'all_workspace_members' = 'all_workspace_members',
): Promise<void> {
  const response = await f.call('owner', '/admin/api/agents', {
    method: 'POST',
    body: {
      id,
      name: id.replace('agent_', 'Agent '),
      handle: id.replace('agent_', ''),
      editPolicy,
      instructions: 'Help.',
      enabled: true,
      model: 'local-stub/admin-agent',
    },
  });
  assert.equal(response.status, 201, await response.text());
}

async function createAgentWithLogins(
  f: Fixture,
  who: Who,
  id: string,
  websiteLogins: Array<{ loginId: string; level: 'check' | 'act'; enabled: boolean }>,
): Promise<Response> {
  return f.call(who, '/admin/api/agents', {
    method: 'POST',
    body: {
      id,
      name: id.replace('agent_', 'Agent '),
      handle: id.replace('agent_', ''),
      editPolicy: 'all_workspace_members',
      instructions: 'Help.',
      enabled: true,
      model: 'local-stub/admin-agent',
      websiteLogins,
    },
  });
}

async function addLogin(
  f: Fixture,
  who: Who,
  agentId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return f.call(who, `/admin/api/agents/${agentId}/website-logins`, { method: 'POST', body });
}

const teamLogin = {
  host: 'Billing.Example.com',
  label: 'Billing',
  ownerKind: 'team',
  method: 'credentials',
  username: 'ops@example.com',
  password: PASSWORD,
  totpSeed: TOTP,
};

test('an Admin adds a team login; secrets are encrypted and never returned', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const created = await addLogin(f, 'admin', 'agent_one', teamLogin);
    assert.equal(created.status, 201);
    const createdText = await created.text();
    assert.equal(createdText.includes(PASSWORD), false);
    assert.equal(createdText.includes(TOTP), false);
    const { login } = JSON.parse(createdText) as { login: Record<string, unknown> };
    assert.match(String(login.loginId), /^wl_[a-f0-9]{32}$/);
    assert.deepEqual({ ...login, loginId: 'x' }, {
      loginId: 'x',
      host: 'billing.example.com',
      label: 'Billing',
      ownerKind: 'team',
      method: 'credentials',
      username: 'ops@example.com',
      level: 'check',
      enabled: true,
    });
    const loginId = String(login.loginId);
    assert.equal((await readWebsiteLoginSecrets(f.deps, loginId))?.password, PASSWORD);

    const listed = await f.call('owner', '/admin/api/agents/agent_one/website-logins');
    assert.equal(listed.status, 200);
    const listedText = await listed.text();
    assert.equal(listedText.includes(PASSWORD), false);
    assert.equal(listedText.includes(TOTP), false);
    assert.equal(listedText.includes('totpSeed'), false);
    assert.equal(listedText.includes('password'), false);
    assert.deepEqual(JSON.parse(listedText), { logins: [login] });

    // The Agent projection counts the grant and names the tab; it carries only the grant.
    const agent = await f.call('owner', '/admin/api/agents/agent_one');
    const agentText = await agent.text();
    assert.equal(agentText.includes(PASSWORD), false);
    const projected = (JSON.parse(agentText) as { agent: Record<string, any> }).agent;
    assert.ok(projected.tabs.includes('websites'));
    assert.equal(projected.capabilityPreviews.websiteLogins, 1);
    assert.deepEqual(projected.websiteLogins, [{ loginId, level: 'check', enabled: true }]);
  } finally {
    f.close();
  }
});

test('a login without an owner kind is a team login for an Admin and personal for a member', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const { ownerKind: _omit, ...noOwner } = teamLogin;
    const byAdmin = await addLogin(f, 'owner', 'agent_one', noOwner);
    assert.equal(byAdmin.status, 201);
    assert.equal(((await byAdmin.json()) as { login: { ownerKind: string } }).login.ownerKind, 'team');
    const byMember = await addLogin(f, 'ana', 'agent_one', { ...noOwner, host: 'mail.example.com', label: 'Mail' });
    assert.equal(byMember.status, 201);
    const { login } = await byMember.json() as { login: Record<string, unknown> };
    assert.equal(login.ownerKind, 'member');
    assert.equal(login.ownerMembershipId, 'membership_ana');
  } finally {
    f.close();
  }
});

test('members create personal logins only; team logins need an Admin', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    assert.equal((await addLogin(f, 'ana', 'agent_one', teamLogin)).status, 403);
    const personal = await addLogin(f, 'ana', 'agent_one', {
      host: 'mail.example.com',
      label: 'My mail',
      ownerKind: 'member',
      method: 'handoff',
      level: 'act',
    });
    assert.equal(personal.status, 201);
    const { login } = await personal.json() as { login: Record<string, unknown> };
    assert.equal(login.ownerKind, 'member');
    assert.equal(login.ownerMembershipId, 'membership_ana');
    assert.equal(login.method, 'handoff');
    assert.equal(login.level, 'act');

    // Another member editing the same Agent does not see Ana's personal login;
    // Owners and Admins do.
    const boView = await (await f.call('bo', '/admin/api/agents/agent_one/website-logins')).json();
    assert.deepEqual(boView, { logins: [] });
    const ownerView = await (await f.call('owner', '/admin/api/agents/agent_one/website-logins')).json() as { logins: unknown[] };
    assert.equal(ownerView.logins.length, 1);

    // A member who cannot edit the Agent cannot read or add its logins.
    await createAgent(f, 'agent_private', 'creator_and_admins');
    assert.equal((await f.call('ana', '/admin/api/agents/agent_private/website-logins')).status, 403);
    assert.equal((await addLogin(f, 'ana', 'agent_private', {
      host: 'mail.example.com', label: 'x', ownerKind: 'member', method: 'handoff',
    })).status, 403);
  } finally {
    f.close();
  }
});

test('create validation: bad host is 422, missing password is 400, full list is 409', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const badHost = await addLogin(f, 'admin', 'agent_one', { ...teamLogin, host: 'https://x.example/login' });
    assert.equal(badHost.status, 422);
    assert.deepEqual(await badHost.json(), { error: 'invalid_website_login', field: 'invalid_host' });
    const { password: _password, ...withoutPassword } = teamLogin;
    assert.equal((await addLogin(f, 'admin', 'agent_one', withoutPassword)).status, 400);
    assert.equal((await addLogin(f, 'admin', 'agent_one', {
      ...teamLogin, method: 'handoff',
    })).status, 400);
    assert.deepEqual(await listWebsiteLogins(f.settings), []);

    const seeded = Array.from({ length: 100 }, (_, index) => ({
      id: `wl_${index.toString(16).padStart(32, '0')}`,
      host: `site${index}.example`,
      label: `Site ${index}`,
      ownerKind: 'team',
      createdByMembershipId: 'membership_admin',
      method: 'handoff',
      createdAt: 1,
    }));
    await f.settings.setSetting('browser.logins.v1', JSON.stringify(seeded));
    const full = await addLogin(f, 'admin', 'agent_one', teamLogin);
    assert.equal(full.status, 409);
    assert.equal((await f.store.getAgent('agent_one')).websiteLogins?.length, 0);
  } finally {
    f.close();
  }
});

test('DELETE removes the grant and deletes the login only when no other Agent uses it', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const created = await addLogin(f, 'admin', 'agent_one', teamLogin);
    const loginId = String(((await created.json()) as { login: { loginId: string } }).login.loginId);

    // Share the login with agent_two by creating it with the grant.
    const shared = await createAgentWithLogins(f, 'admin', 'agent_two', [{ loginId, level: 'act', enabled: true }]);
    assert.equal(shared.status, 201, await shared.clone().text());

    // A member editor may not remove a team login's grant.
    const memberDelete = await f.call('ana', `/admin/api/agents/agent_one/website-logins/${loginId}`, { method: 'DELETE' });
    assert.equal(memberDelete.status, 403);

    const first = await f.call('admin', `/admin/api/agents/agent_one/website-logins/${loginId}`, { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { removed: true, loginDeleted: false });
    assert.deepEqual((await f.store.getAgent('agent_one')).websiteLogins, []);
    assert.equal((await listWebsiteLogins(f.settings)).length, 1);
    assert.equal((await readWebsiteLoginSecrets(f.deps, loginId))?.password, PASSWORD);

    const second = await f.call('admin', `/admin/api/agents/agent_two/website-logins/${loginId}`, { method: 'DELETE' });
    assert.deepEqual(await second.json(), { removed: true, loginDeleted: true });
    assert.deepEqual(await listWebsiteLogins(f.settings), []);
    assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${loginId}`), undefined);

    const again = await f.call('admin', `/admin/api/agents/agent_two/website-logins/${loginId}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
  } finally {
    f.close();
  }
});

test('the owning member may delete a personal login grant; another member may not', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const created = await addLogin(f, 'ana', 'agent_one', {
      host: 'mail.example.com', label: 'Mail', ownerKind: 'member', method: 'credentials',
      username: 'ana', password: PASSWORD,
    });
    const loginId = String(((await created.json()) as { login: { loginId: string } }).login.loginId);
    assert.equal((await f.call('bo', `/admin/api/agents/agent_one/website-logins/${loginId}`, { method: 'DELETE' })).status, 403);
    const deleted = await f.call('ana', `/admin/api/agents/agent_one/website-logins/${loginId}`, { method: 'DELETE' });
    assert.deepEqual(await deleted.json(), { removed: true, loginDeleted: true });
  } finally {
    f.close();
  }
});

test('whole-Agent PATCH leaves grants alone, and creating an Agent cannot widen access to logins the creator cannot manage', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const created = await addLogin(f, 'ana', 'agent_one', {
      host: 'mail.example.com', label: 'Mail', ownerKind: 'member', method: 'handoff',
    });
    const loginId = String(((await created.json()) as { login: { loginId: string } }).login.loginId);
    const agent = await f.store.getAgent('agent_one');
    assert.deepEqual(agent.websiteLogins, [{ loginId, level: 'check', enabled: true }]);

    // Grants change only through the website-logins routes: a whole-Agent
    // PATCH carrying them saves its other fields and ignores the grants.
    const ignored = await f.call('bo', '/admin/api/agents/agent_one', {
      method: 'PATCH',
      body: {
        expectedRevision: agent.revision,
        instructions: 'Help more.',
        websiteLogins: [{ loginId, level: 'act', enabled: true }],
      },
    });
    assert.equal(ignored.status, 200, await ignored.clone().text());
    const afterPatch = await f.store.getAgent('agent_one');
    assert.equal(afterPatch.instructions, 'Help more.');
    assert.deepEqual(afterPatch.websiteLogins, agent.websiteLogins);

    // A disabled grant is not counted in the Agent's preview.
    const disabled = await f.store.updateAgent('agent_one', {
      websiteLogins: [{ loginId, level: 'check', enabled: false }],
    }, afterPatch.revision);
    assert.deepEqual(disabled.websiteLogins, [{ loginId, level: 'check', enabled: false }]);
    const projected = await (await f.call('owner', '/admin/api/agents/agent_one')).json() as { agent: Record<string, any> };
    assert.equal(projected.agent.capabilityPreviews.websiteLogins, 0);

    // Bo cannot grant Ana's personal login to a new Agent; unknown logins cannot be granted.
    assert.equal((await createAgentWithLogins(f, 'bo', 'agent_bo_plain', [])).status, 201);
    assert.equal((await createAgentWithLogins(f, 'bo', 'agent_bo', [{ loginId, level: 'check', enabled: true }])).status, 403);
    assert.equal((await createAgentWithLogins(f, 'owner', 'agent_unknown', [
      { loginId: `wl_${'e'.repeat(32)}`, level: 'check', enabled: true },
    ])).status, 403);
    // Duplicate grants are rejected by validation.
    assert.equal((await createAgentWithLogins(f, 'owner', 'agent_duplicate', [
      { loginId, level: 'act', enabled: true },
      { loginId, level: 'check', enabled: true },
    ])).status, 400);
    // Ana, who owns it, can.
    const anaCreate = await createAgentWithLogins(f, 'ana', 'agent_ana', [{ loginId, level: 'act', enabled: true }]);
    assert.equal(anaCreate.status, 201, await anaCreate.clone().text());
    assert.deepEqual((await f.store.getAgent('agent_ana')).websiteLogins, [{ loginId, level: 'act', enabled: true }]);
  } finally {
    f.close();
  }
});

test('PATCH one grant level: any editor lowers it, only a manager of the login raises it', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const team = await addLogin(f, 'admin', 'agent_one', teamLogin);
    const teamId = String(((await team.json()) as { login: { loginId: string } }).login.loginId);
    const personal = await addLogin(f, 'ana', 'agent_one', {
      host: 'mail.example.com', label: 'Mail', ownerKind: 'member', method: 'handoff', level: 'act',
    });
    const personalId = String(((await personal.json()) as { login: { loginId: string } }).login.loginId);
    const level = (who: Who, loginId: string, body: unknown) =>
      f.call(who, `/admin/api/agents/agent_one/website-logins/${loginId}`, { method: 'PATCH', body });
    const grants = async () => Object.fromEntries(((await f.store.getAgent('agent_one')).websiteLogins ?? [])
      .map((grant) => [grant.loginId, grant.level]));
    assert.deepEqual(await grants(), { [teamId]: 'check', [personalId]: 'act' });

    // A member cannot raise a team login; an Admin can, and the view comes back.
    assert.equal((await level('bo', teamId, { level: 'act' })).status, 403);
    const raised = await level('admin', teamId, { level: 'act' });
    assert.equal(raised.status, 200);
    const view = (await raised.json()) as { login: Record<string, unknown> };
    assert.equal(view.login.level, 'act');
    assert.equal(view.login.loginId, teamId);
    assert.doesNotMatch(JSON.stringify(view), new RegExp(PASSWORD));

    // Any editor may lower; only the owning member raises a personal login.
    assert.equal((await level('bo', personalId, { level: 'check' })).status, 200);
    assert.equal((await level('bo', personalId, { level: 'act' })).status, 403);
    assert.equal((await level('ana', personalId, { level: 'act' })).status, 200);
    assert.deepEqual(await grants(), { [teamId]: 'act', [personalId]: 'act' });
    // Setting the same level again is a no-op.
    const before = (await f.store.getAgent('agent_one')).revision;
    assert.equal((await level('owner', teamId, { level: 'act' })).status, 200);
    assert.equal((await f.store.getAgent('agent_one')).revision, before);

    // Validation and unknown grants.
    assert.equal((await level('owner', teamId, { level: 'admin' })).status, 400);
    assert.equal((await level('owner', teamId, { level: 'act', enabled: false })).status, 400);
    assert.equal((await level('owner', 'wl_nope', { level: 'act' })).status, 400);
    assert.equal((await level('owner', `wl_${'e'.repeat(32)}`, { level: 'act' })).status, 404);
  } finally {
    f.close();
  }
});

test('the website-login list uses the same visibility gate as the Agent Connections list', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_shared', 'all_workspace_members');
    await createAgent(f, 'agent_private', 'creator_and_admins');
    const created = await addLogin(f, 'admin', 'agent_shared', teamLogin);
    assert.equal(created.status, 201);
    for (const agentId of ['agent_shared', 'agent_private']) {
      for (const who of ['owner', 'admin', 'ana'] as const) {
        const logins = await f.call(who, `/admin/api/agents/${agentId}/website-logins`);
        const connections = await f.call(who, `/admin/api/agents/${agentId}/connections?workspaceId=T_TEST`);
        assert.equal(logins.status, connections.status, `${who} ${agentId}`);
      }
    }
    // A member who did not create the login and cannot manage it still sees
    // the team login on an Agent visible to them, without secrets.
    const listed = await f.call('ana', '/admin/api/agents/agent_shared/website-logins');
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.equal(text.includes(PASSWORD), false);
    const body = JSON.parse(text) as { logins: Array<Record<string, unknown>> };
    assert.equal(body.logins.length, 1);
    assert.equal(body.logins[0]!.host, 'billing.example.com');
    assert.equal(body.logins[0]!.ownerKind, 'team');
  } finally {
    f.close();
  }
});
