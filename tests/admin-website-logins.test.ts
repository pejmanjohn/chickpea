import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  listWebsiteLogins,
  readWebsiteLoginSecrets,
  recordWebsiteLoginContext,
  type WebsiteLoginDependencies,
} from '../src/browser/logins.ts';
import { PENDING_CONTEXT_DELETIONS_SETTING } from '../src/browser/context-deletions.ts';
import { agentCredentialConfigurationBinding } from '../src/config/connection-credential-binding.ts';
import { configureHostedBrowser, resetHostedBrowserForTests } from '../src/config/hosted-browser.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { AgentRevisionConflictError } from '../src/config/errors.ts';
import { mcpSecretCleanupMarkerKey } from '../src/config/mcp-secrets.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { storeAsPersonalLogin } from './helpers/website-logins.ts';

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
  const store = new SqliteConfigStore(':memory:', agentRoutineDeletion);
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
  const call = (who: Who, path: string, init: { method?: string; body?: unknown; env?: Record<string, unknown> } = {}) =>
    apps[who].request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: testAdminHeaders(`token-${who}`, { 'content-type': 'application/json' }),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }, init.env);
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

test('only Owners and Admins add a website login; a member editor is told who can', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    for (const who of ['owner', 'admin'] as const) {
      const added = await addLogin(f, who, 'agent_one', { ...teamLogin, host: `${who}.example.com` });
      assert.equal(added.status, 201, await added.clone().text());
      assert.equal(((await added.json()) as { login: { ownerKind: string } }).login.ownerKind, 'team');
    }

    for (const body of [teamLogin, { ...teamLogin, method: 'handoff', password: undefined, totpSeed: undefined }]) {
      const refused = await addLogin(f, 'ana', 'agent_one', { ...body, host: 'mail.example.com' });
      assert.equal(refused.status, 403);
      assert.deepEqual(await refused.json(), {
        error: 'forbidden',
        message: 'Only Owners and Admins can add website logins.',
      });
    }
    // An owner kind is no longer part of the request, from anyone.
    for (const [who, ownerKind] of [['ana', 'member'], ['admin', 'member'], ['admin', 'team']] as const) {
      assert.equal((await addLogin(f, who, 'agent_one', { ...teamLogin, host: 'mail.example.com', ownerKind })).status, 400);
    }
    const stored = await listWebsiteLogins(f.settings);
    assert.deepEqual(stored.map(({ host, ownerKind }) => [host, ownerKind]),
      [['owner.example.com', 'team'], ['admin.example.com', 'team']]);
    assert.equal((await f.store.getAgent('agent_one')).websiteLogins?.length, 2);

    // A member who cannot edit the Agent cannot read or add its logins.
    await createAgent(f, 'agent_private', 'creator_and_admins');
    assert.equal((await f.call('ana', '/admin/api/agents/agent_private/website-logins')).status, 403);
    const hidden = await addLogin(f, 'ana', 'agent_private', { ...teamLogin, host: 'mail.example.com' });
    assert.equal(hidden.status, 403);
    assert.deepEqual(await hidden.json(), { error: 'forbidden' });
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

async function deleteAgent(f: Fixture, agentId: string, who: Who = 'admin'): Promise<Response> {
  const agent = await f.store.getAgent(agentId);
  return f.call(who, `/admin/api/agents/${agentId}`, {
    method: 'DELETE',
    body: {
      expectedRevision: agent.revision,
      credentialConfigurationBinding: agentCredentialConfigurationBinding(agent.credentialIncarnation),
    },
  });
}

async function loginIdOf(response: Response): Promise<string> {
  assert.equal(response.status, 201);
  return String(((await response.json()) as { login: { loginId: string } }).login.loginId);
}

test('deleting an Agent deletes the logins no other Agent holds and queues their contexts', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const own = await loginIdOf(await addLogin(f, 'admin', 'agent_one', teamLogin));
    const shared = await loginIdOf(await addLogin(f, 'admin', 'agent_one', { ...teamLogin, host: 'shared.example.com' }));
    assert.equal((await createAgentWithLogins(f, 'admin', 'agent_two', [{ loginId: shared, level: 'check', enabled: true }])).status, 201);
    await recordWebsiteLoginContext(f.settings, own, 'ctx_own');

    assert.equal((await deleteAgent(f, 'agent_one')).status, 204);
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), [shared]);
    assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${own}`), undefined);
    assert.equal((await readWebsiteLoginSecrets(f.deps, shared))?.password, PASSWORD);
    assert.deepEqual(JSON.parse((await f.settings.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!)
      .map(({ contextId }: { contextId: string }) => contextId), ['ctx_own']);
  } finally {
    f.close();
  }
});

const bosMail = {
  host: 'mail.example.com', label: 'Mail', method: 'credentials',
  username: 'bo', password: PASSWORD, totpSeed: TOTP,
};

/** A login an Admin adds, then stored as releases before team-only logins stored a member's personal one. */
async function addPersonalLogin(
  f: Fixture,
  agentId: string,
  owner: Who,
  body: Record<string, unknown> = bosMail,
): Promise<string> {
  const loginId = await loginIdOf(await addLogin(f, 'admin', agentId, body));
  await storeAsPersonalLogin(f.settings, loginId, PRINCIPALS[owner].membershipId);
  return loginId;
}

const NOT_REMOVABLE = {
  error: 'website_login_not_removable',
  message: 'This Agent uses a website login you can\'t remove. Ask an Owner or Admin to remove it first.',
};

test('a member cannot delete an Agent that would take a website login with it; an Admin can', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const personal = await addPersonalLogin(f, 'agent_one', 'bo');
    const team = await loginIdOf(await addLogin(f, 'admin', 'agent_one', { ...teamLogin, host: 'team.example.com' }));
    await recordWebsiteLoginContext(f.settings, personal, 'ctx_bo');

    for (const who of ['ana', 'bo'] as const) {
      const refused = await deleteAgent(f, 'agent_one', who);
      assert.equal(refused.status, 409, who);
      assert.deepEqual(await refused.json(), NOT_REMOVABLE);
    }
    assert.equal((await f.store.getAgent('agent_one')).websiteLogins?.length, 2, 'the Agent is kept');
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id).sort(), [personal, team].sort());
    assert.equal((await readWebsiteLoginSecrets(f.deps, personal))?.totpSeed, TOTP);
    assert.equal((await readWebsiteLoginSecrets(f.deps, team))?.password, PASSWORD);
    assert.equal(await f.settings.getSetting(PENDING_CONTEXT_DELETIONS_SETTING), undefined);
    const binding = agentCredentialConfigurationBinding((await f.store.getAgent('agent_one')).credentialIncarnation);
    assert.equal(await f.settings.getSetting(mcpSecretCleanupMarkerKey('agent_one', binding)), undefined, 'no cleanup was staged');

    assert.equal((await deleteAgent(f, 'agent_one', 'admin')).status, 204);
    assert.deepEqual(await listWebsiteLogins(f.settings), []);
    assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${personal}`), undefined);
  } finally {
    f.close();
  }
});

test('a member deleting their own Agent with their former personal login waits for an Admin to remove it', async () => {
  const f = fixture();
  try {
    const created = await f.call('bo', '/admin/api/agents', {
      method: 'POST',
      body: {
        id: 'agent_bo', name: 'Agent bo', handle: 'bo', editPolicy: 'creator_and_admins',
        instructions: 'Help.', enabled: true, model: 'local-stub/admin-agent',
      },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const personal = await addPersonalLogin(f, 'agent_bo', 'bo');

    const refused = await deleteAgent(f, 'agent_bo', 'bo');
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), NOT_REMOVABLE);
    assert.equal((await f.call('bo', `/admin/api/agents/agent_bo/website-logins/${personal}`, { method: 'DELETE' })).status, 403);
    assert.deepEqual((await f.store.getAgent('agent_bo')).websiteLogins?.map(({ loginId }) => loginId), [personal]);
    assert.equal((await readWebsiteLoginSecrets(f.deps, personal))?.password, PASSWORD);

    const removed = await f.call('admin', `/admin/api/agents/agent_bo/website-logins/${personal}`, { method: 'DELETE' });
    assert.deepEqual(await removed.json(), { removed: true, loginDeleted: true });
    assert.equal((await deleteAgent(f, 'agent_bo', 'bo')).status, 204);
    await assert.rejects(f.store.getAgent('agent_bo'));
    assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${personal}`), undefined);
  } finally {
    f.close();
  }
});

test('a login another Agent still holds never blocks a member\'s Agent deletion', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const personal = await addPersonalLogin(f, 'agent_one', 'bo');
    assert.equal((await createAgentWithLogins(f, 'admin', 'agent_two', [{ loginId: personal, level: 'check', enabled: true }])).status, 201);
    await f.store.archiveAgent('agent_two', { expectedRevision: (await f.store.getAgent('agent_two')).revision });

    assert.equal((await deleteAgent(f, 'agent_one', 'ana')).status, 204);
    await assert.rejects(f.store.getAgent('agent_one'));
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), [personal]);
    assert.equal((await readWebsiteLoginSecrets(f.deps, personal))?.password, PASSWORD);
  } finally {
    f.close();
  }
});

async function deleteAgentBody(f: Fixture, agentId: string) {
  const agent = await f.store.getAgent(agentId);
  return {
    expectedRevision: agent.revision,
    credentialConfigurationBinding: agentCredentialConfigurationBinding(agent.credentialIncarnation),
  };
}

test('a login cleanup that fails fails the deletion\'s response, and the retry finishes it without logging content', async (t) => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const own = await loginIdOf(await addLogin(f, 'admin', 'agent_one', teamLogin));
    await recordWebsiteLoginContext(f.settings, own, 'ctx_own');
    const body = await deleteAgentBody(f, 'agent_one');
    const deleteRevision = f.settings.deleteEncryptedCredentialRevision.bind(f.settings);
    f.settings.deleteEncryptedCredentialRevision = async () => { throw new Error('realm unavailable'); };
    const error = t.mock.method(console, 'error', () => undefined);
    const warn = t.mock.method(console, 'warn', () => undefined);

    const failed = await f.call('admin', '/admin/api/agents/agent_one', { method: 'DELETE', body });
    assert.equal(failed.status, 500);
    await assert.rejects(f.store.getAgent('agent_one'));
    assert.deepEqual(await listWebsiteLogins(f.settings), [], 'the login went before its secret failed');
    assert.ok(await f.settings.getEncryptedCredentialRevision(`website_login.${own}`));

    f.settings.deleteEncryptedCredentialRevision = deleteRevision;
    const retried = await f.call('admin', '/admin/api/agents/agent_one', { method: 'DELETE', body });
    assert.equal(retried.status, 204);
    assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${own}`), undefined);
    assert.deepEqual(JSON.parse((await f.settings.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!)
      .map(({ contextId }: { contextId: string }) => contextId), ['ctx_own']);
    assert.equal((await f.call('admin', '/admin/api/agents/agent_one', { method: 'DELETE', body })).status, 404,
      'the finished cleanup leaves no marker');
    const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls].map((call) => call.arguments));
    assert.doesNotMatch(logged, new RegExp(`${own}|ctx_own|ops@example|billing`, 'i'));
  } finally {
    f.close();
  }
});

test('a crash between the Agent\'s deletion and its login cleanup is finished by the retry', async (t) => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const own = await loginIdOf(await addLogin(f, 'admin', 'agent_one', teamLogin));
    const body = await deleteAgentBody(f, 'agent_one');
    let crashing = false;
    const deleteAgentWithMemory = f.store.deleteAgentWithMemory.bind(f.store);
    f.store.deleteAgentWithMemory = async (...args: Parameters<typeof deleteAgentWithMemory>) => {
      const deleted = await deleteAgentWithMemory(...args);
      crashing = true;
      return deleted;
    };
    const listAgents = f.store.listAgents.bind(f.store);
    f.store.listAgents = async () => {
      if (crashing) throw new Error('state unavailable');
      return listAgents();
    };
    t.mock.method(console, 'error', () => undefined);

    assert.equal((await f.call('admin', '/admin/api/agents/agent_one', { method: 'DELETE', body })).status, 500);
    await assert.rejects(f.store.getAgent('agent_one'));
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), [own], 'nothing was removed yet');

    crashing = false;
    assert.equal((await f.call('admin', '/admin/api/agents/agent_one', { method: 'DELETE', body })).status, 204);
    assert.deepEqual(await listWebsiteLogins(f.settings), []);
    assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${own}`), undefined);
  } finally {
    f.close();
  }
});

test('the retry leaves a login an Agent was granted after the deletion began', async (t) => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const own = await loginIdOf(await addLogin(f, 'admin', 'agent_one', teamLogin));
    const body = await deleteAgentBody(f, 'agent_one');
    const listAgents = f.store.listAgents.bind(f.store);
    let calls = 0;
    f.store.listAgents = async () => {
      calls += 1;
      if (calls === 2) throw new Error('state unavailable');
      return listAgents();
    };
    t.mock.method(console, 'error', () => undefined);
    assert.equal((await f.call('admin', '/admin/api/agents/agent_one', { method: 'DELETE', body })).status, 500);

    assert.equal((await createAgentWithLogins(f, 'admin', 'agent_two', [{ loginId: own, level: 'check', enabled: true }])).status, 201);
    assert.equal((await f.call('admin', '/admin/api/agents/agent_one', { method: 'DELETE', body })).status, 204);
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), [own]);
    assert.equal((await readWebsiteLoginSecrets(f.deps, own))?.password, PASSWORD);
  } finally {
    f.close();
  }
});

function loginCleanupMarker(agentId: string, scope: string): string {
  return `website-login-cleanup.${agentId}.${scope.slice(3)}`;
}

test('a delete that leaves the Agent in place leaves no login cleanup behind', async (t) => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const own = await loginIdOf(await addLogin(f, 'admin', 'agent_one', teamLogin));
    const body = await deleteAgentBody(f, 'agent_one');
    f.store.deleteAgentWithMemory = async () => {
      throw new AgentRevisionConflictError('agent_one', body.expectedRevision, body.expectedRevision + 1);
    };
    t.mock.method(console, 'error', () => undefined);

    assert.equal((await f.call('admin', '/admin/api/agents/agent_one', { method: 'DELETE', body })).status, 409);
    assert.ok(await f.store.getAgent('agent_one'));
    assert.equal(await f.settings.getSetting(loginCleanupMarker('agent_one', body.credentialConfigurationBinding)), undefined);
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), [own]);
  } finally {
    f.close();
  }
});

test('a stale login cleanup deletes only what both its stager and whoever finishes it could remove', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const bos = await addPersonalLogin(f, 'agent_one', 'bo');
    const team = await loginIdOf(await addLogin(f, 'admin', 'agent_one', { ...teamLogin, host: 'team.example.com' }));
    await createAgent(f, 'agent_gone');
    const { credentialConfigurationBinding: scope, expectedRevision } = await deleteAgentBody(f, 'agent_gone');
    const gone = await f.store.getAgent('agent_gone');
    await f.store.deleteAgent('agent_gone', expectedRevision, gone.credentialIncarnation!);
    await f.store.updateAgent('agent_one', { websiteLogins: [] }, (await f.store.getAgent('agent_one')).revision);
    const body = { expectedRevision, credentialConfigurationBinding: scope };

    // Staged under Ana, finished by the Owner: Ana could never remove Bo's login.
    await f.settings.setSetting(loginCleanupMarker('agent_gone', scope), JSON.stringify({
      by: { role: 'member', membershipId: 'membership_ana' }, loginIds: [bos],
    }));
    assert.equal((await f.call('owner', '/admin/api/agents/agent_gone', { method: 'DELETE', body })).status, 204);
    assert.equal(await f.settings.getSetting(loginCleanupMarker('agent_gone', scope)), undefined);

    // Staged under an Admin, finished by Ana: Ana could never remove a team login.
    await f.settings.setSetting(loginCleanupMarker('agent_gone', scope), JSON.stringify({
      by: { role: 'admin', membershipId: 'membership_admin' }, loginIds: [team],
    }));
    assert.equal((await f.call('ana', '/admin/api/agents/agent_gone', { method: 'DELETE', body })).status, 204);
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id).sort(), [bos, team].sort());
    assert.equal((await readWebsiteLoginSecrets(f.deps, bos))?.password, PASSWORD);
    assert.equal((await readWebsiteLoginSecrets(f.deps, team))?.password, PASSWORD);
    // Ana's retry must not use up the cleanup: the team login waits for someone who can remove it.
    const kept = await f.settings.getSetting(loginCleanupMarker('agent_gone', scope));
    assert.deepEqual((JSON.parse(kept!) as { loginIds: string[] }).loginIds, [team]);
    assert.equal((await f.call('admin', '/admin/api/agents/agent_gone', { method: 'DELETE', body })).status, 204);
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), [bos]);
    assert.equal(await f.settings.getSetting(loginCleanupMarker('agent_gone', scope)), undefined);

    // Both could: the Admin who staged it, and Bo, who owns it.
    await f.settings.setSetting(loginCleanupMarker('agent_gone', scope), JSON.stringify({
      by: { role: 'admin', membershipId: 'membership_admin' }, loginIds: [bos],
    }));
    assert.equal((await f.call('bo', '/admin/api/agents/agent_gone', { method: 'DELETE', body })).status, 204);
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), []);
  } finally {
    f.close();
  }
});

test('a member\'s Agent deletion staged before logins became team-only still deletes their personal login and its secret', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_gone');
    const bos = await addPersonalLogin(f, 'agent_gone', 'bo');
    await recordWebsiteLoginContext(f.settings, bos, 'ctx_bo');
    const body = await deleteAgentBody(f, 'agent_gone');
    const scope = body.credentialConfigurationBinding;
    // What an earlier release left when Bo's delete stopped after the Agent went.
    await f.settings.setSetting(loginCleanupMarker('agent_gone', scope), JSON.stringify({
      by: { role: 'member', membershipId: 'membership_bo' }, loginIds: [bos],
    }));
    const gone = await f.store.getAgent('agent_gone');
    await f.store.deleteAgent('agent_gone', body.expectedRevision, gone.credentialIncarnation!);

    assert.equal((await f.call('bo', '/admin/api/agents/agent_gone', { method: 'DELETE', body })).status, 204);
    assert.deepEqual(await listWebsiteLogins(f.settings), []);
    assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${bos}`), undefined);
    assert.equal(await f.settings.getSetting(loginCleanupMarker('agent_gone', scope)), undefined);
    assert.deepEqual(JSON.parse((await f.settings.getSetting(PENDING_CONTEXT_DELETIONS_SETTING))!)
      .map(({ contextId }: { contextId: string }) => contextId), ['ctx_bo']);
  } finally {
    f.close();
  }
});

test('a DELETE of the system Agent is refused and finishes no login cleanup', async () => {
  const f = fixture();
  try {
    const system = await f.store.materializeChickpeaAgent();
    await createAgent(f, 'agent_one');
    const team = await loginIdOf(await addLogin(f, 'admin', 'agent_one', teamLogin));
    await f.store.updateAgent('agent_one', { websiteLogins: [] }, (await f.store.getAgent('agent_one')).revision);
    const scope = agentCredentialConfigurationBinding(system.credentialIncarnation);
    await f.settings.setSetting(loginCleanupMarker(system.id, scope), JSON.stringify({
      by: { role: 'owner', membershipId: 'membership_test_owner' }, loginIds: [team],
    }));

    const refused = await f.call('owner', `/admin/api/agents/${system.id}`, {
      method: 'DELETE',
      body: { expectedRevision: system.revision, credentialConfigurationBinding: scope },
    });
    assert.equal(refused.status, 404);
    assert.ok(await f.store.getAgent(system.id));
    assert.ok(await f.settings.getSetting(loginCleanupMarker(system.id, scope)));
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id }) => id), [team]);
  } finally {
    f.close();
  }
});

test('a former personal login is a team login: everyone who may edit the Agent sees it, and only Owners and Admins manage it', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const loginId = await addPersonalLogin(f, 'agent_one', 'ana', {
      host: 'mail.example.com', label: 'Mail', method: 'credentials', username: 'ana', password: PASSWORD,
    });
    const stored = (await listWebsiteLogins(f.settings))[0]!;
    assert.deepEqual([stored.ownerKind, stored.ownerMembershipId], ['member', 'membership_ana'], 'the record keeps its owner');

    const view = {
      loginId, host: 'mail.example.com', label: 'Mail', ownerKind: 'team', method: 'credentials',
      username: 'ana', level: 'check', enabled: true,
    };
    for (const who of ['owner', 'admin', 'ana', 'bo'] as const) {
      const listed = await f.call(who, '/admin/api/agents/agent_one/website-logins');
      assert.deepEqual(await listed.json(), { logins: [view] }, who);
    }

    // Ana, who added it, can no longer allow actions, remove it, or grant it to another Agent.
    const path = `/admin/api/agents/agent_one/website-logins/${loginId}`;
    for (const who of ['ana', 'bo'] as const) {
      assert.equal((await f.call(who, path, { method: 'PATCH', body: { level: 'act' } })).status, 403, who);
      assert.equal((await f.call(who, path, { method: 'DELETE' })).status, 403, who);
      assert.equal((await createAgentWithLogins(f, who, `agent_${who}`, [{ loginId, level: 'check', enabled: true }])).status, 403, who);
    }
    assert.deepEqual((await f.store.getAgent('agent_one')).websiteLogins, [{ loginId, level: 'check', enabled: true }]);

    // An Admin raises it, any editor may lower it again, and an Admin removes it.
    const raised = await f.call('admin', path, { method: 'PATCH', body: { level: 'act' } });
    assert.deepEqual(await raised.json(), { login: { ...view, level: 'act' } });
    assert.equal((await f.call('ana', path, { method: 'PATCH', body: { level: 'check' } })).status, 200);
    const removed = await f.call('admin', path, { method: 'DELETE' });
    assert.deepEqual(await removed.json(), { removed: true, loginDeleted: true });
    assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${loginId}`), undefined);
  } finally {
    f.close();
  }
});

test('a stored personal login keeps its record byte for byte while other logins are added and removed', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const personal = await loginIdOf(await addLogin(f, 'admin', 'agent_one', bosMail));
    const record = await storeAsPersonalLogin(f.settings, personal, 'membership_bo');
    const catalog = async () => (await f.settings.getSetting('browser.logins.v1'))!;
    assert.ok((await catalog()).includes(record));

    const other = await loginIdOf(await addLogin(f, 'admin', 'agent_one', { ...teamLogin, host: 'other.example.com' }));
    assert.ok((await catalog()).includes(record), 'adding a login rewrote it');
    const removed = await f.call('admin', `/admin/api/agents/agent_one/website-logins/${other}`, { method: 'DELETE' });
    assert.deepEqual(await removed.json(), { removed: true, loginDeleted: true });
    assert.ok((await catalog()).includes(record), 'deleting a login rewrote it');
    assert.deepEqual((await listWebsiteLogins(f.settings)).map(({ id, ownerKind }) => [id, ownerKind]), [[personal, 'member']]);
  } finally {
    f.close();
  }
});

test('whole-Agent PATCH leaves grants alone, and creating an Agent cannot widen access to logins the creator cannot manage', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const loginId = await addPersonalLogin(f, 'agent_one', 'ana', { host: 'mail.example.com', label: 'Mail', method: 'handoff' });
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

    // A member cannot grant a login to a new Agent; unknown logins cannot be granted.
    assert.equal((await createAgentWithLogins(f, 'bo', 'agent_bo_plain', [])).status, 201);
    assert.equal((await createAgentWithLogins(f, 'bo', 'agent_bo', [{ loginId, level: 'check', enabled: true }])).status, 403);
    // Nor a disabled grant, which would keep the login alive after an Admin removes it elsewhere.
    assert.equal((await createAgentWithLogins(f, 'bo', 'agent_bo_disabled', [{ loginId, level: 'check', enabled: false }])).status, 403);
    assert.equal((await createAgentWithLogins(f, 'owner', 'agent_unknown', [
      { loginId: `wl_${'e'.repeat(32)}`, level: 'check', enabled: true },
    ])).status, 403);
    // Duplicate grants are rejected by validation.
    assert.equal((await createAgentWithLogins(f, 'owner', 'agent_duplicate', [
      { loginId, level: 'act', enabled: true },
      { loginId, level: 'check', enabled: true },
    ])).status, 400);
    // Nor can Ana, whose personal login it was. An Owner can.
    assert.equal((await createAgentWithLogins(f, 'ana', 'agent_ana', [{ loginId, level: 'check', enabled: true }])).status, 403);
    const ownerCreate = await createAgentWithLogins(f, 'owner', 'agent_owner', [{ loginId, level: 'act', enabled: true }]);
    assert.equal(ownerCreate.status, 201, await ownerCreate.clone().text());
    assert.deepEqual((await f.store.getAgent('agent_owner')).websiteLogins, [{ loginId, level: 'act', enabled: true }]);
  } finally {
    f.close();
  }
});

test('PATCH one grant level: any editor lowers it, only an Owner or Admin raises it', async () => {
  const f = fixture();
  try {
    await createAgent(f, 'agent_one');
    const team = await addLogin(f, 'admin', 'agent_one', teamLogin);
    const teamId = String(((await team.json()) as { login: { loginId: string } }).login.loginId);
    const personalId = await addPersonalLogin(f, 'agent_one', 'ana', {
      host: 'mail.example.com', label: 'Mail', method: 'handoff', level: 'act',
    });
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

    // Any editor may lower a former personal login; its owner can no longer raise it.
    assert.equal((await level('bo', personalId, { level: 'check' })).status, 200);
    assert.equal((await level('bo', personalId, { level: 'act' })).status, 403);
    assert.equal((await level('ana', personalId, { level: 'act' })).status, 403);
    assert.equal((await level('admin', personalId, { level: 'act' })).status, 200);
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

test('with the host\'s browser off, a hosted installation lists and removes a saved login, and cannot add one or change its level', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  await createAgent(f, 'agent_one');
  const loginId = await loginIdOf(await addLogin(f, 'admin', 'agent_one', teamLogin));
  resetHostedBrowserForTests();
  t.after(resetHostedBrowserForTests);
  configureHostedBrowser({
    policy: () => ({ enabled: false, monthlyBrowserHours: 10, maxRunningBrowsers: 2, sessionsPerMinute: 6 }),
    access: () => ({ apiKey: 'bb_live_platform', projectId: 'proj' }),
  });
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_logins_off' });
  const path = '/admin/api/agents/agent_one/website-logins';

  const added = await f.call('admin', path, { method: 'POST', body: { ...teamLogin, host: 'other.example.com' }, env });
  assert.equal(added.status, 404);
  const raised = await f.call('admin', `${path}/${loginId}`, { method: 'PATCH', body: { level: 'act' }, env });
  assert.equal(raised.status, 404);
  const listed = await f.call('admin', path, { env });
  assert.equal(listed.status, 200);
  assert.deepEqual(((await listed.json()) as { logins: Array<{ loginId: string; level: string }> }).logins
    .map(({ loginId: id, level }) => [id, level]), [[loginId, 'check']]);

  const removed = await f.call('admin', `${path}/${loginId}`, { method: 'DELETE', env });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: true, loginDeleted: true });
  assert.deepEqual(await listWebsiteLogins(f.settings), []);
  assert.equal(await f.settings.getEncryptedCredentialRevision(`website_login.${loginId}`), undefined, 'the password is gone');
});
