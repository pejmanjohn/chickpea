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

function actionTarget(attributes: Record<string, string>, value?: string) {
  return {
    value,
    selectionStart: value?.length ?? 0,
    closest(selector: string) { return selector === '[data-action]' ? this : null; },
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
    viewer: { userId: 'user_owner', membershipId: 'membership_owner', role: viewerRole },
    soleOwnerWarning: true,
    members: [
      {
        id: 'membership_owner', userId: 'user_owner', displayName: 'Owner',
        slackTeamId: 'TACME', slackUserId: 'UOWNER', role: 'owner', status: 'active',
      },
      {
        id: 'membership_admin', userId: 'user_admin', displayName: 'Alex Admin',
        slackTeamId: 'TACME', slackUserId: 'UADMIN', role: 'admin', status: 'active',
      },
    ],
    invitations: [{
      id: 'invitation_pending', slackTeamId: 'TACME', slackUserId: 'UPENDING',
      displayName: 'Pending Person', role: 'admin', status: 'pending',
      expiresAt: 4_102_444_800_000, createdAt: 1_786_100_000_000, updatedAt: 1_786_100_000_000,
    }],
  };
}

const directoryMembers = [
  {
    slackUserId: 'UALEX1', displayName: 'Alex', realName: 'Alex One', handle: 'alex.one',
    avatarUrl: 'https://avatars.slack-edge.com/alex-one.png',
  },
  {
    slackUserId: 'UALEX2', displayName: 'Alex', realName: 'Alex Two', handle: 'alex.two',
    avatarUrl: null,
  },
];

async function createHarness(
  viewerRole: 'owner' | 'admin' = 'owner',
  options: { directoryFailure?: boolean; clipboardFailure?: boolean } = {},
) {
  const team = teamFixture(viewerRole);
  let html = '';
  const app = {
    className: '',
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; },
  };
  const listeners: Record<string, Listener> = {};
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const clipboard: string[] = [];
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
    if (path === '/admin/api/team/directory' && method === 'GET') {
      if (options.directoryFailure) throw new TypeError('Failed to fetch');
      return response({ members: directoryMembers, nextCursor: 'cursor-next' });
    }
    if (path === '/admin/api/team/directory?cursor=cursor-next' && method === 'GET') {
      return response({ members: [], nextCursor: null });
    }
    if (path === '/admin/api/team/directory/UMANUAL' && method === 'GET') {
      return response({ member: {
        slackUserId: 'UMANUAL', displayName: 'Manual Member', realName: 'Manual Member',
        handle: 'manual.member', avatarUrl: null,
      } });
    }
    if (path === '/admin/api/team/invitations' && method === 'POST') {
      const slackUserId = String((body as { slackUserId: string }).slackUserId);
      const invitation = {
        id: 'invitation_created', slackTeamId: 'TACME', slackUserId,
        displayName: 'Alex', role: 'admin', status: 'pending',
        expiresAt: 4_102_444_800_000, createdAt: Date.now(), updatedAt: Date.now(),
      };
      team.invitations.unshift(invitation);
      return response({
        invitation,
        inviteLink: 'https://chickpea.example/auth/slack/invite#invite=private-slack-locator',
      }, 201);
    }
    if (path.startsWith('/admin/api/team/invitations/') && method === 'DELETE') {
      team.invitations = team.invitations.filter((row) => !path.endsWith(row.id));
      return response({ invitation: { id: path.split('/').at(-1), status: 'revoked' } });
    }
    if (path.startsWith('/admin/api/team/memberships/') && method === 'PATCH') {
      const id = path.split('/').at(-1);
      const member = team.members.find((row) => row.id === id);
      if (member) Object.assign(member, body);
      if ((body as { role?: string }).role === 'owner') team.soleOwnerWarning = false;
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
    navigator: {
      clipboard: {
        async writeText(value: string) {
          if (options.clipboardFailure) throw new Error('clipboard denied');
          clipboard.push(value);
        },
      },
    },
    window: { addEventListener() {} },
  }, { filename: 'admin-team-page-inline.js' });
  await flush();
  return { app, clipboard, listeners, requests, team };
}

test('Team page is Slack-native, disambiguates duplicate names, and warns the sole Owner', async () => {
  const harness = await createHarness();
  assert.match(harness.app.innerHTML, /Invite from Slack/);
  assert.match(harness.app.innerHTML, /Add a second Owner/);
  assert.match(harness.app.innerHTML, /alex\.one · UALEX1/);
  assert.match(harness.app.innerHTML, /alex\.two · UALEX2/);
  assert.match(harness.app.innerHTML, /paste a Slack member ID/i);
  assert.match(harness.app.innerHTML, /UPENDING · Expires/);
  assert.match(harness.app.innerHTML, /Promote to Owner/);
  assert.match(harness.app.innerHTML, /data-action="team-suspend-open"/);
  assert.doesNotMatch(harness.app.innerHTML, /email|password|Cloudflare Access/i);
});

test('Owner selects one exact Slack tuple and receives a fragment-only invitation link', async () => {
  const harness = await createHarness();
  const click = harness.listeners.click!;
  const submit = harness.listeners.submit!;
  click({ target: actionTarget({ 'data-action': 'team-member-select', 'data-slack-user': 'UALEX2' }) });
  submit({ target: actionTarget({ 'data-action': 'team-invite-form' }), preventDefault() {} });
  await flush();
  const create = harness.requests.find((request) =>
    request.path === '/admin/api/team/invitations' && request.method === 'POST');
  assert.deepEqual(create?.body, { slackUserId: 'UALEX2' });
  assert.match(harness.app.innerHTML, /Slack invitation ready/);
  click({ target: actionTarget({ 'data-action': 'team-copy-link' }) });
  await flush();
  assert.deepEqual(harness.clipboard, [
    'https://chickpea.example/auth/slack/invite#invite=private-slack-locator',
  ]);
});

test('member-ID fallback verifies before selection and directory failures stay retryable', async () => {
  const failed = await createHarness('owner', { directoryFailure: true });
  assert.match(failed.app.innerHTML, /could not be reached/i);
  assert.match(failed.app.innerHTML, /data-action="team-directory-retry"/);

  const harness = await createHarness();
  harness.listeners.input!({ target: actionTarget({ 'data-action': 'team-member-id' }, 'umanual') });
  harness.listeners.click!({ target: actionTarget({ 'data-action': 'team-member-verify' }) });
  await flush();
  assert.ok(harness.requests.some((request) => request.path === '/admin/api/team/directory/UMANUAL'));
  assert.match(harness.app.innerHTML, /Manual Member/);
  assert.match(harness.app.innerHTML, /Selected Manual Member · @manual\.member · UMANUAL/);
});

test('suspend, revoke, restore, and promotion use explicit Slack-member lifecycle actions', async () => {
  const harness = await createHarness();
  const click = harness.listeners.click!;
  click({ target: actionTarget({ 'data-action': 'team-suspend-open', 'data-membership': 'membership_admin' }) });
  assert.match(harness.app.innerHTML, /An Owner can restore this membership later/);
  click({ target: actionTarget({ 'data-action': 'team-remove-confirm' }) });
  await flush();
  assert.ok(harness.requests.some((request) =>
    request.path.endsWith('/membership_admin') && (request.body as { status?: string }).status === 'suspended'));
  assert.match(harness.app.innerHTML, /data-action="team-restore"/);

  click({ target: actionTarget({ 'data-action': 'team-restore', 'data-membership': 'membership_admin' }) });
  await flush();
  click({ target: actionTarget({ 'data-action': 'team-promote', 'data-membership': 'membership_admin' }) });
  await flush();
  assert.equal(harness.team.soleOwnerWarning, false);
  assert.doesNotMatch(harness.app.innerHTML, /Add a second Owner/);

  click({ target: actionTarget({
    'data-action': 'team-revoke-open', 'data-invitation': 'invitation_pending',
    'data-slack-user': 'UPENDING',
  }) });
  assert.match(harness.app.innerHTML, /private link will stop working immediately/);
  click({ target: actionTarget({ 'data-action': 'team-remove-confirm' }) });
  await flush();
  assert.ok(harness.requests.some((request) =>
    request.path.endsWith('/invitation_pending') && request.method === 'DELETE'));
});

test('Admin can view exact members but receives no Owner controls', async () => {
  const harness = await createHarness('admin');
  assert.match(harness.app.innerHTML, /UOWNER/);
  assert.doesNotMatch(harness.app.innerHTML, /Invite from Slack|Promote to Owner|team-suspend-open|team-remove-open/);
  assert.equal(harness.requests.some((request) => request.path.includes('/team/directory')), false);
});

test('clipboard failure exposes the invitation link for manual selection', async () => {
  const harness = await createHarness('owner', { clipboardFailure: true });
  harness.listeners.click!({ target: actionTarget({
    'data-action': 'team-member-select', 'data-slack-user': 'UALEX1',
  }) });
  harness.listeners.submit!({
    target: actionTarget({ 'data-action': 'team-invite-form' }), preventDefault() {},
  });
  await flush();
  harness.listeners.click!({ target: actionTarget({ 'data-action': 'team-copy-link' }) });
  await flush();
  assert.match(harness.app.innerHTML, /Copy this teammate join link manually/);
  assert.match(harness.app.innerHTML, /id="team-invite-link"/);
});
