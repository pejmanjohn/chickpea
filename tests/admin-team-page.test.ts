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
    inviteLink: 'https://chickpea.example.com/join#invite=invitation_pending.stable-secret',
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
    invitations: [
      invitation,
      {
        ...invitation,
        id: 'invitation_unavailable',
        email: 'unavailable@example.com',
        inviteLink: undefined,
      },
      { ...invitation, id: 'invitation_accepted', email: 'accepted@example.com', status: 'accepted' },
      { ...invitation, id: 'invitation_revoked', email: 'revoked@example.com', status: 'revoked' },
      { ...invitation, id: 'invitation_expired', email: 'expired@example.com', status: 'expired' },
    ],
  };
  return { team, invitation };
}

async function createHarness(
  viewerRole: 'owner' | 'admin' = 'owner',
  harnessOptions: {
    failInviteRequest?: boolean;
    clipboardFailures?: number;
    clipboardAbsent?: boolean;
    deferClipboard?: boolean;
  } = {},
) {
  const fixture = teamFixture(viewerRole);
  let html = '';
  const app = {
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; },
  };
  const listeners: Record<string, Listener> = {};
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const clipboard: string[] = [];
  const pendingClipboardWrites: Array<{
    value: string;
    resolve(): void;
    reject(error: Error): void;
  }> = [];
  let clipboardFailures = harnessOptions.clipboardFailures ?? 0;
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
      if (harnessOptions.failInviteRequest) throw new TypeError('Failed to fetch');
      const created = {
        ...fixture.invitation,
        id: 'invitation_created',
        email: String((body as { email: string }).email).toLowerCase(),
        role: 'admin',
        inviteLink: 'https://chickpea.example.com/join#invite=invitation_created.stable-secret',
      };
      fixture.team.invitations.unshift(created);
      return response({
        invitation: created,
        inviteLink: created.inviteLink,
      }, 201);
    }
    if (path.startsWith('/admin/api/team/invitations/') && method === 'DELETE') {
      const invitationId = path.split('/').at(-1);
      const index = fixture.team.invitations.findIndex((invitation) => invitation.id === invitationId);
      const [revoked] = index >= 0 ? fixture.team.invitations.splice(index, 1) : [];
      return revoked
        ? response({ invitation: { ...revoked, status: 'revoked' } })
        : response({ error: 'not_found' }, 404);
    }
    if (path === '/admin/api/team/memberships/membership_member' && method === 'PATCH') {
      Object.assign(fixture.team.members[1]!, body);
      return response({ membership: fixture.team.members[1] });
    }
    return response({ error: 'not_found' }, 404);
  };
  const script = renderAdminPage().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const navigator = harnessOptions.clipboardAbsent ? {} : {
    clipboard: {
      writeText(value: string) {
        if (clipboardFailures > 0) {
          clipboardFailures -= 1;
          return Promise.reject(new Error('Clipboard permission denied'));
        }
        if (harnessOptions.deferClipboard) {
          return new Promise<void>((resolve, reject) => {
            pendingClipboardWrites.push({ value, resolve, reject });
          });
        }
        clipboard.push(value);
        return Promise.resolve();
      },
    },
  };
  vm.runInNewContext(script, {
    console,
    Date,
    document,
    fetch,
    history,
    location,
    URL,
    URLSearchParams,
    navigator,
    window: { addEventListener() {} },
  }, { filename: 'admin-team-page-inline.js' });
  await flush();
  return { app, clipboard, fixture, listeners, location, pendingClipboardWrites, requests };
}

test('Team page keeps invitations and membership status inside Chickpea', async () => {
  const harness = await createHarness();
  assert.equal(harness.location.pathname, '/admin/team');
  assert.match(harness.app.innerHTML, /data-action="open-team"[^>]*aria-current="page"/);
  assert.match(harness.app.innerHTML, /Waiting to join/);
  assert.match(harness.app.innerHTML, /joiner@example\.com/);
  assert.match(harness.app.innerHTML, /unavailable@example\.com/);
  assert.match(harness.app.innerHTML, /older deployment credentials/);
  assert.doesNotMatch(harness.app.innerHTML, /data-link="undefined"/);
  assert.doesNotMatch(harness.app.innerHTML, /accepted@example\.com|revoked@example\.com|expired@example\.com/);
  assert.doesNotMatch(harness.app.innerHTML, /What happens next|team-grid/);
  assert.match(harness.app.innerHTML, /name="email"/);
  assert.match(harness.app.innerHTML, /team-status-control/);
  assert.match(harness.app.innerHTML, />Owner</);
  assert.match(harness.app.innerHTML, /data-action="team-remove-open"/);
  assert.doesNotMatch(harness.app.innerHTML, /<option value="removed"/);
  assert.match(harness.app.innerHTML, /<span class="chan-name">Members<\/span><span class="chan-meta">2 members<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /active records|Identity bound|Identity not bound|This same link works until/);
  assert.doesNotMatch(harness.app.innerHTML, /team-invite-role|team-member-role/);
  assert.doesNotMatch(harness.app.innerHTML, /Cloudflare|Zero Trust|policy|Open Access|Access action/i);
});

test('Team join links stay stable, copyable, and membership status stays manageable', async () => {
  const harness = await createHarness();
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  const submit = harness.listeners.submit;
  const click = harness.listeners.click;
  assert.ok(input && change && submit && click);

  input({ target: actionTarget({ 'data-action': 'team-invite-email' }, 'New@Example.com') });
  submit({
    target: actionTarget({ 'data-action': 'team-invite-form' }),
    preventDefault() {},
  });
  await flush();
  const create = harness.requests.find((request) =>
    request.path === '/admin/api/team/invitations' && request.method === 'POST');
  assert.deepEqual(create?.body, { email: 'New@Example.com' });
  assert.match(harness.app.innerHTML, /Join link ready for/);
  assert.match(harness.app.innerHTML, /new@example\.com/);
  assert.doesNotMatch(harness.app.innerHTML, /id="team-invite-link"|>Done<|show this secret again|Resend link|rotates the private link/);

  click({ target: actionTarget({ 'data-action': 'team-copy-link' }) });
  await flush();
  assert.deepEqual(harness.clipboard, [
    'https://chickpea.example.com/join#invite=invitation_created.stable-secret',
  ]);
  assert.match(harness.app.innerHTML, />Copied<\/button>/);

  const copyControl = harness.app.innerHTML.match(
    /<button[^>]*data-action="team-copy-invitation"[^>]*data-link="[^"]+"[^>]*>/,
  )?.[0];
  assert.ok(copyControl);
  const renderedLink = copyControl.match(/data-link="([^"]+)"/)?.[1];
  assert.ok(renderedLink);
  click({ target: actionTarget({ 'data-action': 'team-copy-invitation', 'data-link': renderedLink }) });
  await flush();
  assert.deepEqual(harness.clipboard, [
    'https://chickpea.example.com/join#invite=invitation_created.stable-secret',
    renderedLink,
  ]);

  const revokeControl = harness.app.innerHTML.match(
    /<button[^>]*data-action="team-revoke"[^>]*data-invitation="invitation_created"[^>]*>/,
  )?.[0];
  assert.ok(revokeControl);
  click({ target: actionTarget({
    'data-action': 'team-revoke',
    'data-invitation': revokeControl.match(/data-invitation="([^"]+)"/)?.[1] ?? '',
  }) });
  await flush();
  assert.doesNotMatch(harness.app.innerHTML, /Join link ready/);
  assert.ok(harness.requests.some((request) =>
    request.path === '/admin/api/team/invitations/invitation_created' && request.method === 'DELETE'));

  change({
    target: actionTarget({ 'data-action': 'team-member-status', 'data-membership': 'membership_member' }, 'suspended'),
  });
  await flush();
  const patch = harness.requests.find((request) =>
    request.path === '/admin/api/team/memberships/membership_member' && request.method === 'PATCH');
  assert.deepEqual(patch?.body, { status: 'suspended' });

  click({ target: actionTarget({
    'data-action': 'team-remove-open',
    'data-membership': 'membership_member',
  }) });
  assert.match(harness.app.innerHTML, /aria-label="Remove teammate"/);
  assert.match(harness.app.innerHTML, /Remove Member\?/);
  assert.match(harness.app.innerHTML, /cannot be restored from this screen/);
  assert.equal(harness.requests.filter((request) => request.body &&
    (request.body as { status?: string }).status === 'removed').length, 0);

  click({ target: actionTarget({ 'data-action': 'team-remove-confirm' }) });
  await flush();
  const removePatch = harness.requests.find((request) =>
    request.path === '/admin/api/team/memberships/membership_member' &&
    request.method === 'PATCH' &&
    (request.body as { status?: string }).status === 'removed');
  assert.deepEqual(removePatch?.body, { status: 'removed' });
});

test('Team join links become selectable when clipboard access is denied', async () => {
  const harness = await createHarness('owner', { clipboardFailures: 1 });
  const input = harness.listeners.input;
  const submit = harness.listeners.submit;
  const click = harness.listeners.click;
  assert.ok(input && submit && click);

  input({ target: actionTarget({ 'data-action': 'team-invite-email' }, 'manual-copy@example.com') });
  submit({
    target: actionTarget({ 'data-action': 'team-invite-form' }),
    preventDefault() {},
  });
  await flush();
  click({ target: actionTarget({ 'data-action': 'team-copy-link' }) });
  await flush();

  assert.match(harness.app.innerHTML, /Copy failed\. Select the join link below and copy it manually\./);
  assert.match(harness.app.innerHTML, /id="team-invite-link"[^>]*readonly/);
  assert.match(
    harness.app.innerHTML,
    /value="https:\/\/chickpea\.example\.com\/join#invite=invitation_created\.stable-secret"/,
  );

  click({ target: actionTarget({ 'data-action': 'team-copy-link' }) });
  await flush();
  assert.deepEqual(harness.clipboard, [
    'https://chickpea.example.com/join#invite=invitation_created.stable-secret',
  ]);
  assert.doesNotMatch(harness.app.innerHTML, /Copy failed|id="team-invite-link"/);
  assert.match(harness.app.innerHTML, />Copied<\/button>/);
});

test('Team join links stay selectable when the Clipboard API is unavailable', async () => {
  const harness = await createHarness('owner', { clipboardAbsent: true });
  const input = harness.listeners.input;
  const submit = harness.listeners.submit;
  const click = harness.listeners.click;
  assert.ok(input && submit && click);

  input({ target: actionTarget({ 'data-action': 'team-invite-email' }, 'manual-copy@example.com') });
  submit({
    target: actionTarget({ 'data-action': 'team-invite-form' }),
    preventDefault() {},
  });
  await flush();
  click({ target: actionTarget({ 'data-action': 'team-copy-link' }) });

  assert.match(harness.app.innerHTML, /Copy failed\. Select the join link below and copy it manually\./);
  assert.match(harness.app.innerHTML, /id="team-invite-link"[^>]*readonly/);
});

test('Team ignores a stale clipboard failure after its invitation is revoked', async () => {
  const harness = await createHarness('owner', { deferClipboard: true });
  const input = harness.listeners.input;
  const submit = harness.listeners.submit;
  const click = harness.listeners.click;
  assert.ok(input && submit && click);

  input({ target: actionTarget({ 'data-action': 'team-invite-email' }, 'stale-copy@example.com') });
  submit({
    target: actionTarget({ 'data-action': 'team-invite-form' }),
    preventDefault() {},
  });
  await flush();
  click({ target: actionTarget({ 'data-action': 'team-copy-link' }) });
  assert.equal(harness.pendingClipboardWrites.length, 1);

  click({ target: actionTarget({
    'data-action': 'team-revoke',
    'data-invitation': 'invitation_created',
  }) });
  await flush();
  harness.pendingClipboardWrites[0]!.reject(new Error('Clipboard permission denied'));
  await flush();

  assert.doesNotMatch(harness.app.innerHTML, /Copy failed|id="team-invite-link"/);
  assert.doesNotMatch(harness.app.innerHTML, /Join link ready for/);
});

test('Team invitation replaces raw network failures with safe recovery guidance', async () => {
  const harness = await createHarness('owner', { failInviteRequest: true });
  const input = harness.listeners.input;
  const submit = harness.listeners.submit;
  assert.ok(input && submit);

  input({ target: actionTarget({ 'data-action': 'team-invite-email' }, 'teammate@example.com') });
  submit({
    target: actionTarget({ 'data-action': 'team-invite-form' }),
    preventDefault() {},
  });
  await flush();

  assert.doesNotMatch(harness.app.innerHTML, /Failed to fetch/);
  assert.match(harness.app.innerHTML, /Reload this page to check whether the change succeeded/);
});

test('Admin Team UI marks the owner without exposing role controls', async () => {
  const harness = await createHarness('admin');
  const ownerRow = harness.app.innerHTML.match(/<article class="team-row">[\s\S]*?owner@example\.com[\s\S]*?<\/article>/)?.[0] ?? '';
  assert.match(ownerRow, />Owner</);
  assert.doesNotMatch(ownerRow, /team-member-status|team-remove-open/);
  assert.doesNotMatch(harness.app.innerHTML, /team-member-role|team-invite-role/);
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
      return Promise.resolve(response({ redirect: '/admin/channels' }));
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
  assert.equal(destination, '/admin/channels');
  assert.equal(stored.size, 0);

  const account = renderMemberAccountPage({
    organizationName: 'Chickpea', displayName: 'Joiner', email: 'joiner@example.com',
    role: 'member', status: 'active',
  });
  assert.match(account, /Open Slack/);
  assert.match(account, /Your Chickpea account is active/);
  assert.doesNotMatch(account, />member</i);
  assert.doesNotMatch(account, /Cloudflare|Access|Zero Trust/i);
  assert.doesNotMatch(account, /Settings|Profiles|Team/);
});
