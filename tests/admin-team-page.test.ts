import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { renderAdminPage } from '../src/admin/page.ts';

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

type Listener = (event: {
  target: ReturnType<typeof actionTarget>;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  preventDefault?(): void;
}) => void;

function response(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

function actionTarget(attributes: Record<string, string> = {}, value?: string, classes: string[] = []) {
  return {
    value,
    selectionStart: value?.length ?? 0,
    closest(selector: string) {
      if (selector === '[data-action]') return attributes['data-action'] ? this : null;
      if (selector === '.team-action-menu') return classes.includes('team-action-menu') ? this : null;
      if (selector === '[data-action="team-actions-toggle"]') {
        return attributes['data-action'] === 'team-actions-toggle' ? this : null;
      }
      return null;
    },
    getAttribute(name: string) { return attributes[name] ?? null; },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function teamFixture(viewerRole: 'owner' | 'admin' = 'owner') {
  return {
    organization: { id: 'organization_1', displayName: 'Chickpea', slackTeamId: 'TACME' },
    viewer: {
      userId: viewerRole === 'owner' ? 'user_owner' : 'user_admin',
      membershipId: viewerRole === 'owner' ? 'membership_owner' : 'membership_admin',
      role: viewerRole,
    },
    members: [
      {
        id: 'membership_owner', userId: 'user_owner', displayName: 'Pejman Owner',
        slackTeamId: 'TACME', slackUserId: 'UOWNER', role: 'owner', status: 'active',
      },
      {
        id: 'membership_admin', userId: 'user_admin', displayName: 'Alex Admin',
        slackTeamId: 'TACME', slackUserId: 'UADMIN', role: 'admin', status: 'active',
      },
      {
        id: 'membership_member', userId: 'user_member', displayName: 'Maya Member',
        slackTeamId: 'TACME', slackUserId: 'UMEMBER', role: 'member', status: 'active',
      },
      {
        id: 'membership_other_owner', userId: 'user_other_owner', displayName: 'Olive Owner',
        slackTeamId: 'TACME', slackUserId: 'UOTHEROWNER', role: 'owner', status: 'active',
      },
      {
        id: 'membership_suspended', userId: 'user_suspended', displayName: 'Sam Suspended',
        slackTeamId: 'TACME', slackUserId: 'USUSPENDED', role: 'member', status: 'suspended',
      },
      {
        id: 'membership_removed', userId: 'user_removed', displayName: 'Rae Removed',
        slackTeamId: 'TACME', slackUserId: 'UREMOVED', role: 'member', status: 'removed',
      },
    ],
  };
}

async function createHarness(viewerRole: 'owner' | 'admin' = 'owner') {
  const team = teamFixture(viewerRole);
  let html = '';
  const app = {
    className: '',
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; },
  };
  const listeners: Record<string, Listener> = {};
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const location = { pathname: '/admin/team', search: '' };
  const applyPath = (path: string) => {
    const url = new URL(path, 'https://chickpea.example');
    location.pathname = url.pathname;
    location.search = url.search;
  };
  const document = {
    getElementById(id: string) { return id === 'app' ? app : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type: string, listener: Listener) { listeners[type] = listener; },
  };
  const fetch = async (path: string, init?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    if (path === '/admin/api/agents') return response({ agents: [] });
    if (path === '/admin/api/assignments') return response({ assignments: [] });
    if (path === '/admin/api/models') return response({ providers: [] });
    if (path === '/admin/api/slack-connection') return response(null);
    if (path === '/admin/api/slack-behavior') return response({});
    if (path === '/admin/api/audit/memory/scopes') return response({ scopes: [] });
    if (path === '/admin/api/team' && method === 'GET') return response(team);
    if (path.startsWith('/admin/api/team/memberships/') && method === 'PATCH') {
      const id = path.split('/').at(-1);
      const member = team.members.find((row) => row.id === id);
      if (member) Object.assign(member, body);
      return response({ membership: member });
    }
    return response({ error: 'not_found' }, 404);
  };
  const script = renderAdminPage().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    console, Date, document, fetch,
    history: {
      pushState(_state: unknown, _title: string, path: string) { applyPath(path); },
      replaceState(_state: unknown, _title: string, path: string) { applyPath(path); },
    },
    location, URL, URLSearchParams,
    navigator: {},
    window: { addEventListener() {} },
  }, { filename: 'admin-team-page-inline.js' });
  await flush();
  return { app, listeners, requests, team };
}

test('Team explains automatic provisioning and never loads invitation or Slack-directory UI', async () => {
  const harness = await createHarness();
  assert.match(harness.app.innerHTML, /join automatically the first time they interact with an Agent/i);
  assert.match(harness.app.innerHTML, /Guests and Slack Connect/i);
  assert.match(harness.app.innerHTML, /6 members/);
  assert.doesNotMatch(harness.app.innerHTML, /Invite from Slack|Invite administrator|Add a second Owner|Pending Slack invitations|Join links/i);
  assert.doesNotMatch(harness.app.innerHTML, /team-directory|team-invite|slack_directory_unavailable/i);
  assert.equal(harness.requests.some((request) =>
    request.path.includes('/team/directory') || request.path.includes('/team/invitations')), false);
});

test('Owner changes ordinary roles directly from one member row menu', async () => {
  const harness = await createHarness();
  const click = harness.listeners.click!;
  click({ target: actionTarget({
    'data-action': 'team-actions-toggle', 'data-membership': 'membership_member',
  }) });
  assert.match(harness.app.innerHTML, /role="menu" aria-label="Actions for Maya Member"/);
  assert.match(harness.app.innerHTML, /Make Admin/);
  assert.match(harness.app.innerHTML, /Make Owner/);
  assert.match(harness.app.innerHTML, /Suspend access/);
  assert.match(harness.app.innerHTML, /Remove from Chickpea/);

  click({ target: actionTarget({
    'data-action': 'team-role-action', 'data-membership': 'membership_member', 'data-role': 'admin',
  }, undefined, ['team-action-menu']) });
  await flush();
  assert.ok(harness.requests.some((request) =>
    request.path.endsWith('/membership_member') &&
    (request.body as { role?: string }).role === 'admin'));
  assert.equal(harness.team.members.find((row) => row.id === 'membership_member')?.role, 'admin');
});

test('Owner transitions and destructive access changes require confirmation', async () => {
  const harness = await createHarness();
  const click = harness.listeners.click!;

  click({ target: actionTarget({
    'data-action': 'team-actions-toggle', 'data-membership': 'membership_member',
  }) });
  click({ target: actionTarget({
    'data-action': 'team-role-action', 'data-membership': 'membership_member', 'data-role': 'owner',
  }, undefined, ['team-action-menu']) });
  assert.match(harness.app.innerHTML, /Make Maya Member an Owner\?/);
  assert.equal(harness.requests.some((request) => request.path.endsWith('/membership_member')), false);
  click({ target: actionTarget({ 'data-action': 'team-confirm-apply' }) });
  await flush();
  assert.ok(harness.requests.some((request) =>
    request.path.endsWith('/membership_member') &&
    (request.body as { role?: string }).role === 'owner'));

  click({ target: actionTarget({
    'data-action': 'team-actions-toggle', 'data-membership': 'membership_other_owner',
  }) });
  click({ target: actionTarget({
    'data-action': 'team-role-action', 'data-membership': 'membership_other_owner', 'data-role': 'admin',
  }, undefined, ['team-action-menu']) });
  assert.match(harness.app.innerHTML, /Make Olive Owner an Admin\?/);
  click({ target: actionTarget({ 'data-action': 'team-confirm-cancel' }) });

  click({ target: actionTarget({
    'data-action': 'team-actions-toggle', 'data-membership': 'membership_admin',
  }) });
  click({ target: actionTarget({
    'data-action': 'team-status-action', 'data-membership': 'membership_admin', 'data-status': 'suspended',
  }, undefined, ['team-action-menu']) });
  assert.match(harness.app.innerHTML, /Suspend access for Alex Admin\?/);
  click({ target: actionTarget({ 'data-action': 'team-confirm-apply' }) });
  await flush();
  assert.ok(harness.requests.some((request) =>
    request.path.endsWith('/membership_admin') &&
    (request.body as { status?: string }).status === 'suspended'));
});

test('restore is direct while removed, self, and non-Owner rows are read-only', async () => {
  const harness = await createHarness();
  const click = harness.listeners.click!;
  click({ target: actionTarget({
    'data-action': 'team-actions-toggle', 'data-membership': 'membership_suspended',
  }) });
  assert.match(harness.app.innerHTML, /Restore access/);
  assert.doesNotMatch(harness.app.innerHTML, /Make Admin|Make Owner|Suspend access/);
  click({ target: actionTarget({
    'data-action': 'team-status-action', 'data-membership': 'membership_suspended', 'data-status': 'active',
  }, undefined, ['team-action-menu']) });
  await flush();
  assert.ok(harness.requests.some((request) =>
    request.path.endsWith('/membership_suspended') &&
    (request.body as { status?: string }).status === 'active'));

  assert.doesNotMatch(harness.app.innerHTML, /data-membership="membership_removed"[^>]*aria-haspopup/);
  assert.doesNotMatch(harness.app.innerHTML, /data-membership="membership_owner"[^>]*aria-haspopup/);

  const adminHarness = await createHarness('admin');
  assert.match(adminHarness.app.innerHTML, /UOWNER/);
  assert.doesNotMatch(adminHarness.app.innerHTML, /data-action="team-actions-toggle"/);
});

test('row menu closes on outside click and Escape', async () => {
  const harness = await createHarness();
  const click = harness.listeners.click!;
  click({ target: actionTarget({
    'data-action': 'team-actions-toggle', 'data-membership': 'membership_member',
  }) });
  assert.match(harness.app.innerHTML, /role="menu"/);
  click({ target: actionTarget() });
  assert.doesNotMatch(harness.app.innerHTML, /role="menu"/);

  click({ target: actionTarget({
    'data-action': 'team-actions-toggle', 'data-membership': 'membership_member',
  }) });
  harness.listeners.keydown!({
    target: actionTarget(), key: 'Escape', preventDefault() {},
  });
  assert.doesNotMatch(harness.app.innerHTML, /role="menu"/);
});
