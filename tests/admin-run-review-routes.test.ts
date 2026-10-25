import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { HELP_IMPROVE_TEXT_VERSION } from '../src/admin/run-review-api.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { IdentityStore, RecordIdentityAuthAuditInput } from '../src/identity/types.ts';
import { configureRunReview, type RunReviewPort } from '../src/review/port.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'run-review-admin-token';
const INSTALLATION = 'inst_run_review';
const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>, { installationId: INSTALLATION });
const PRIVACY_URL = 'https://chickpea.example/privacy#help-improve-chickpea';
const PATH = '/admin/api/settings/help-improve';

function principal(role: AuthPrincipal['role'], machine = false): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_run_review', role,
    authenticatorKind: machine ? 'personal_token' : 'test_slack_session', credentialId: `credential_${role}`,
    correlationId: `request_${role}`, machine,
  };
}

function fakePort(overrides: Partial<RunReviewPort> = {}) {
  const calls: unknown[][] = [];
  let state = true;
  const port: RunReviewPort = {
    async enabled(installationId) { calls.push(['enabled', installationId]); return state; },
    async setEnabled(installationId, change) { calls.push(['setEnabled', installationId, change]); state = change.enabled; return state; },
    async capturing() { return state; },
    async record() {},
    privacyUrl: PRIVACY_URL,
    ...overrides,
  };
  return { port, calls };
}

function admin(t: TestContext, options: {
  role?: AuthPrincipal['role']; machine?: boolean; env?: Record<string, unknown>; port?: RunReviewPort;
}) {
  configureRunReview(options.port);
  const audits: RecordIdentityAuthAuditInput[] = [];
  const people = {
    getUser: async (id: string) => ({ id, slackTeamId: 'T_TEST', slackUserId: `U_${id.toUpperCase()}`, displayName: null }),
    recordAuthAudit: async (input: RecordIdentityAuthAuditInput) => { audits.push(input); },
  } as unknown as IdentityStore;
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => { configureRunReview(undefined); config.close(); settings.close(); usage.close(); });
  const app = createAdminRoutes({
    store: config, settings, usage,
    ...testAdminAuthority(TOKEN, undefined, people, principal(options.role ?? 'owner', options.machine)),
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { ...testAdminHeaders(TOKEN), 'content-type': 'application/json', ...init.headers },
  }, options.env ?? HOSTED);
  const runReviewAudits = () => audits.filter((audit) => audit.action.startsWith('run_review.'));
  return { request, runReviewAudits };
}

const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });

test('standalone has no setting: both routes are not found and the page offers nothing, even with a port', async (t) => {
  const { port, calls } = fakePort();
  const { request } = admin(t, { port, env: {} });
  assert.equal((await request(PATH)).status, 404);
  assert.equal((await request(PATH, put({ enabled: false }))).status, 404);
  const page = await (await request('/admin')).text();
  assert.match(page, /"helpImproveOffered":false/);
  assert.ok(!page.includes(PRIVACY_URL));
  assert.deepEqual(calls, []);
});

test('a hosted installation whose host installed no port has no setting', async (t) => {
  const { request } = admin(t, {});
  assert.equal((await request(PATH)).status, 404);
  assert.equal((await request(PATH, put({ enabled: false }))).status, 404);
  assert.match(await (await request('/admin')).text(), /"helpImproveOffered":false/);
});

test('a hosted request that names no installation has no setting', async (t) => {
  const { port, calls } = fakePort();
  const { request } = admin(t, { port, env: { CHICKPEA_TENANCY: 'installation' } });
  assert.equal((await request(PATH)).status, 404);
  assert.equal((await request(PATH, put({ enabled: false }))).status, 404);
  assert.deepEqual(calls, []);
});

test('an Owner reads the host\'s state, and the page offers the setting with its privacy link', async (t) => {
  const { port, calls } = fakePort();
  const { request } = admin(t, { port });
  const response = await request(PATH);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { enabled: true });
  assert.deepEqual(calls, [['enabled', INSTALLATION]]);
  const page = await (await request('/admin')).text();
  assert.match(page, /"helpImproveOffered":true/);
  assert.ok(page.includes(`"helpImprovePrivacyUrl":"${PRIVACY_URL}"`));
  assert.equal((await request('/admin/settings/help-improve')).status, 200);
});

for (const role of ['owner', 'admin'] as const) {
  test(`an${role === 'owner' ? ' Owner' : ' Admin'} changes it as a person, audited, and the answer is the state alone`, async (t) => {
    const { port, calls } = fakePort();
    const { request, runReviewAudits } = admin(t, { role, port });
    for (const enabled of [false, true]) {
      const response = await request(PATH, put({ enabled }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { enabled });
    }
    assert.deepEqual(calls, [false, true].map((enabled) => ['setEnabled', INSTALLATION, {
      enabled,
      actor: { slackUserId: `U_USER_${role.toUpperCase()}`, membershipId: `membership_${role}` },
      textVersion: HELP_IMPROVE_TEXT_VERSION,
    }]));
    assert.deepEqual(runReviewAudits().map((audit) => [audit.action, audit.outcome, audit.userId, audit.membershipId]), [
      ['run_review.disabled', 'success', `user_${role}`, `membership_${role}`],
      ['run_review.enabled', 'success', `user_${role}`, `membership_${role}`],
    ]);
  });
}

test('a Member cannot read or change it, and a personal token cannot change it', async (t) => {
  const member = fakePort();
  const asMember = admin(t, { role: 'member', port: member.port });
  assert.equal((await asMember.request(PATH)).status, 403);
  assert.equal((await asMember.request(PATH, put({ enabled: false }))).status, 403);
  assert.deepEqual(member.calls, []);

  const token = fakePort();
  const asToken = admin(t, { machine: true, port: token.port });
  assert.equal((await asToken.request(PATH, put({ enabled: false }))).status, 403);
  assert.deepEqual(token.calls.filter(([name]) => name === 'setEnabled'), []);
  assert.deepEqual(asToken.runReviewAudits(), []);
});

test('a malformed change is refused before the host is asked', async (t) => {
  const { port, calls } = fakePort();
  const { request } = admin(t, { port });
  for (const body of [{}, { enabled: 'false' }, { enabled: false, actor: 'U1' }]) {
    assert.equal((await request(PATH, put(body))).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test('a host that cannot answer is unavailable, and says nothing more', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warnings.push(line); });
  const failing = async () => { throw new Error('registry unavailable for inst_run_review'); };
  const { request } = admin(t, { port: fakePort({ enabled: failing, setEnabled: failing }).port });
  for (const response of [await request(PATH), await request(PATH, put({ enabled: false }))]) {
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'run_review_unavailable' });
  }
  assert.ok(warnings.every((line) => !line.includes('inst_run_review')));
});
