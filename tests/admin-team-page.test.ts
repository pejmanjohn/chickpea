import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
  renderAdminPage,
  renderMemberAccountPage,
} from '../src/admin/page.ts';
import {
  invitationJoinClientScript,
  JOIN_STORAGE_KEY,
  renderInvitationJoinPage,
} from '../src/join/page.ts';

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

type Listener = (event: {
  target: {
    closest?(selector: string): unknown;
    getAttribute(name: string): string | null;
    value?: string;
  };
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
    ...(value === undefined ? {} : { value }),
    closest(selector: string) { return selector === '[data-action]' ? this : null; },
    getAttribute(name: string) { return attributes[name] ?? null; },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function teamFixture(viewerRole: 'owner' | 'admin' = 'owner') {
  const invitation = {
    id: 'invitation_pending',
    email: 'joiner@example.com',
    role: 'member',
    status: 'pending',
    expiresAt: 1_786_704_800_000,
    createdAt: 1_786_100_000_000,
    updatedAt: 1_786_100_000_000,
  };
  const team = {
    organization: { id: 'organization_1', displayName: 'Chickpea' },
    viewer: { userId: 'user_owner', membershipId: 'membership_owner', role: viewerRole },
    members: [
      {
        id: 'membership_owner', userId: 'user_owner', email: 'owner@example.com',
        displayName: 'Owner', role: 'owner', status: 'active',
        externalIdentity: { provider: 'cloudflare_access', bound: true },
      },
      {
        id: 'membership_member', userId: 'user_member', email: 'member@example.com',
        displayName: 'Member', role: 'member', status: 'active',
        externalIdentity: { provider: 'cloudflare_access', bound: true },
      },
    ],
    invitations: [invitation],
  };
  return { team, invitation };
}

async function createHarness(viewerRole: 'owner' | 'admin' = 'owner') {
  const fixture = teamFixture(viewerRole);
  let html = '';
  const app = {
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; },
  };
  const listeners: Record<string, Listener> = {};
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const clipboard: string[] = [];
  const location = { pathname: '/admin/team', search: '' };
  const applyPath = (path: string) => {
    const url = new URL(path, 'https://chickpea.example.com');
    location.pathname = url.pathname;
    location.search = url.search;
  };
  const history = {
    pushState(_state: unknown, _title: string, path: string) { applyPath(path); },
    replaceState(_state: unknown, _title: string, path: string) { applyPath(path); },
  };
  const document = {
    getElementById(id: string) { return id === 'app' ? app : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type: string, listener: Listener) { listeners[type] = listener; },
  };
  const fetch = async (path: string, options?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method, body });
    if (path === '/admin/api/agents') return response({ agents: [] });
    if (path === '/admin/api/assignments') return response({ assignments: [] });
    if (path === '/admin/api/models') return response({ providers: [] });
    if (path === '/admin/api/slack-connection') return response(null);
    if (path === '/admin/api/slack-behavior') return response({});
    if (path === '/admin/api/audit/memory/scopes') return response({ scopes: [] });
    if (path === '/admin/api/team' && method === 'GET') return response(fixture.team);
    if (path === '/admin/api/team/invitations' && method === 'POST') {
      const created = {
        ...fixture.invitation,
        id: 'invitation_created',
        email: String((body as { email: string }).email).toLowerCase(),
        role: (body as { role: string }).role,
      };
      fixture.team.invitations.unshift(created);
      return response({
        invitation: created,
        inviteLink: 'https://chickpea.example.com/join#invite=invitation_created.show-once-secret',
      }, 201);
    }
    if (path === '/admin/api/team/memberships/membership_member' && method === 'PATCH') {
      Object.assign(fixture.team.members[1]!, body);
      return response({ membership: fixture.team.members[1] });
    }
    return response({ error: 'not_found' }, 404);
  };
  const script = renderAdminPage().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    console,
    Date,
    document,
    fetch,
    history,
    location,
    URL,
    URLSearchParams,
    navigator: {
      clipboard: {
        writeText(value: string) { clipboard.push(value); return Promise.resolve(); },
      },
    },
    window: { addEventListener() {} },
  }, { filename: 'admin-team-page-inline.js' });
  await flush();
  return { app, clipboard, fixture, listeners, location, requests };
}

test('Team page keeps invitations and roles inside Chickpea', async () => {
  const harness = await createHarness();
  assert.equal(harness.location.pathname, '/admin/team');
  assert.match(harness.app.innerHTML, /data-action="open-team"[^>]*aria-current="page"/);
  assert.match(harness.app.innerHTML, /Chickpea invite pending/);
  assert.match(
    harness.app.innerHTML,
    /The invitation stays pending until the teammate uses the private link and accepts it/,
  );
  assert.doesNotMatch(harness.app.innerHTML, /Cloudflare|Zero Trust|policy|Open Access|Access action/i);
});

test('Team invitation is show-once, copyable, and role changes use the membership API', async () => {
  const harness = await createHarness();
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  const submit = harness.listeners.submit;
  const click = harness.listeners.click;
  assert.ok(input && change && submit && click);

  input({ target: actionTarget({ 'data-action': 'team-invite-email' }, 'New@Example.com') });
  change({ target: actionTarget({ 'data-action': 'team-invite-role' }, 'admin') });
  submit({
    target: actionTarget({ 'data-action': 'team-invite-form' }),
    preventDefault() {},
  });
  await flush();
  const create = harness.requests.find((request) =>
    request.path === '/admin/api/team/invitations' && request.method === 'POST');
  assert.deepEqual(create?.body, { email: 'New@Example.com', role: 'admin' });
  assert.match(harness.app.innerHTML, /Copy this invitation link now/);
  assert.match(harness.app.innerHTML, /show-once-secret/);

  click({ target: actionTarget({ 'data-action': 'team-copy-link' }) });
  await flush();
  assert.deepEqual(harness.clipboard, [
    'https://chickpea.example.com/join#invite=invitation_created.show-once-secret',
  ]);

  change({
    target: actionTarget({ 'data-action': 'team-member-role', 'data-membership': 'membership_member' }, 'admin'),
  });
  await flush();
  const patch = harness.requests.find((request) =>
    request.path === '/admin/api/team/memberships/membership_member' && request.method === 'PATCH');
  assert.deepEqual(patch?.body, { role: 'admin' });
});

test('Admin Team UI does not offer owner grants or controls for owner memberships', async () => {
  const harness = await createHarness('admin');
  const memberRow = harness.app.innerHTML.match(/<article class="team-row">[\s\S]*?member@example\.com[\s\S]*?<\/article>/)?.[0] ?? '';
  assert.doesNotMatch(memberRow, /<option value="owner"/);
  const ownerRow = harness.app.innerHTML.match(/<article class="team-row">[\s\S]*?owner@example\.com[\s\S]*?<\/article>/)?.[0] ?? '';
  assert.match(ownerRow, /data-action="team-member-role"[^>]* disabled/);
});

test('protected join and member pages keep provider details out of the normal flow', async () => {
  const join = renderInvitationJoinPage({ email: 'joiner@example.com' });
  assert.match(join, /<script src="\/admin\/join\/client\.js" defer><\/script>/);
  assert.doesNotMatch(join, /sessionStorage|location\.hash|show-once-secret/);
  assert.match(join, /<meta name="referrer" content="no-referrer">/);

  const credential = 'invitation_join.secret-value';
  const stored = new Map([[JOIN_STORAGE_KEY, credential]]);
  const requests: Array<{ path: string; body: string }> = [];
  let destination = '';
  const status = { textContent: '', className: '' };
  vm.runInNewContext(invitationJoinClientScript(), {
    document: { getElementById() { return status; } },
    fetch(path: string, options: { body: string }) {
      requests.push({ path, body: options.body });
      assert.equal(stored.has(JOIN_STORAGE_KEY), false);
      return Promise.resolve(response({ redirect: '/admin/account' }));
    },
    location: { replace(path: string) { destination = path; } },
    sessionStorage: {
      getItem(key: string) { return stored.get(key) ?? null; },
      removeItem(key: string) { stored.delete(key); },
    },
  });
  await flush();
  assert.deepEqual(requests, [{
    path: '/admin/join',
    body: JSON.stringify({ invitationId: 'invitation_join', token: 'secret-value' }),
  }]);
  assert.equal(destination, '/admin/account');
  assert.equal(stored.size, 0);

  const account = renderMemberAccountPage({
    organizationName: 'Chickpea', displayName: 'Joiner', email: 'joiner@example.com',
    role: 'member', status: 'active',
  });
  assert.match(account, /Open Slack/);
  assert.match(account, /role controls what you can do in Chickpea/);
  assert.doesNotMatch(account, /Cloudflare|Access|Zero Trust/i);
  assert.doesNotMatch(account, /Settings|Profiles|Team/);
});
