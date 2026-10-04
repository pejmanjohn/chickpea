import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

// Reloading or deep-linking an Admin page asks the server for it directly. A
// page someone reaches inside the app must load the same way, and one they may
// not open must land on a page they may, never on a JSON error.

const ADMIN_TOKEN = 'admin-page-access-token';
const ADMIN_ORIGIN = 'http://localhost';
const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_page_access' });

const owner: AuthPrincipal = {
  userId: 'user_owner',
  membershipId: 'membership_owner',
  organizationId: 'org_oss',
  role: 'owner',
  authenticatorKind: 'test_slack_session',
  credentialId: 'session_owner',
  correlationId: 'request_owner',
  machine: false,
};
const admin: AuthPrincipal = { ...owner, userId: 'user_admin', membershipId: 'membership_admin', role: 'admin' };
const member: AuthPrincipal = { ...owner, userId: 'user_member', membershipId: 'membership_member', role: 'member' };

// Every page the app routes, with the pages a Member reaches in the app.
const MEMBER_PAGES = [
  '/admin',
  '/admin/agents',
  '/admin/agents/new',
  '/admin/agents/agent_support',
  '/admin/settings/agents-clients',
];
const SETTINGS_PAGES = [
  '/admin/settings',
  '/admin/settings/providers',
  '/admin/settings/connectors',
  '/admin/settings/github',
  '/admin/settings/outbound',
  '/admin/settings/slack',
  '/admin/settings/coding-agents',
];
const WORKSPACE_PAGES = [
  '/admin/team',
  '/admin/usage',
  '/admin/onboarding',
  '/admin/channels',
  '/admin/channels/T_TEST/C_SUPPORT',
  '/admin/destinations/slack',
  '/admin/destinations/slack/channels',
  '/admin/audit-logs/scheduled-work',
];

const TENANCIES = [
  { name: 'standalone', env: undefined },
  { name: 'hosted', env: HOSTED },
] as const;

function harness(principal: AuthPrincipal) {
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    usage,
    ...testAdminAuthority(ADMIN_TOKEN, ADMIN_ORIGIN, undefined, principal),
    knownProviders: new Set(['local-stub']),
  }));
  return {
    async get(path: string, env?: Record<string, unknown>) {
      const response = await app.request(`${ADMIN_ORIGIN}${path}`, {
        headers: testAdminHeaders(ADMIN_TOKEN),
        redirect: 'manual',
      }, env);
      return {
        status: response.status,
        location: response.headers.get('location'),
        contentType: response.headers.get('content-type') ?? '',
        text: await response.text(),
      };
    },
    close() {
      config.close();
      settings.close();
      usage.close();
    },
  };
}

for (const { name, env } of TENANCIES) {
  test(`${name}: Owners and Admins reload every Admin page`, async () => {
    for (const principal of [owner, admin]) {
      const fixture = harness(principal);
      try {
        for (const path of [...MEMBER_PAGES, ...SETTINGS_PAGES, ...WORKSPACE_PAGES]) {
          const page = await fixture.get(path, env);
          assert.equal(page.status, 200, `${principal.role} ${path}`);
          assert.match(page.contentType, /^text\/html/, `${principal.role} ${path}`);
          assert.match(page.text, /"workspaceAdminUi":true/, `${principal.role} ${path}`);
        }
      } finally {
        fixture.close();
      }
    }
  });

  test(`${name}: a Member reloads the pages they reach in the app, including Settings → MCP`, async () => {
    const fixture = harness(member);
    try {
      for (const path of MEMBER_PAGES) {
        const page = await fixture.get(path, env);
        assert.equal(page.status, 200, path);
        assert.match(page.contentType, /^text\/html/, path);
        assert.match(page.text, /"workspaceAdminUi":false/, path);
      }
      // The page's only data API answers the same person.
      const clients = await fixture.get('/admin/api/mcp-clients', env);
      assert.equal(clients.status, 200, clients.text);
    } finally {
      fixture.close();
    }
  });

  test(`${name}: a Member's other Settings pages land on Settings → MCP`, async () => {
    const fixture = harness(member);
    try {
      for (const path of SETTINGS_PAGES) {
        const page = await fixture.get(path, env);
        assert.equal(page.status, 303, path);
        assert.equal(page.location, '/admin/settings/agents-clients', path);
        assert.equal(page.text, '', path);
      }
    } finally {
      fixture.close();
    }
  });

  test(`${name}: a Member's workspace pages land on Admin home, and their APIs stay refused`, async () => {
    const fixture = harness(member);
    try {
      for (const path of WORKSPACE_PAGES) {
        const page = await fixture.get(path, env);
        assert.equal(page.status, 303, path);
        assert.equal(page.location, '/admin', path);
        assert.equal(page.text, '', path);
      }
      for (const path of ['/admin/api/team', '/admin/api/providers', '/admin/api/usage', '/admin/api/channels']) {
        const api = await fixture.get(path, env);
        assert.equal(api.status, 403, path);
        assert.deepEqual(JSON.parse(api.text), { error: 'forbidden' }, path);
      }
    } finally {
      fixture.close();
    }
  });
}

test('a machine credential asking for an Admin page is refused, not redirected', async () => {
  const fixture = harness({ ...owner, machine: true, authenticatorKind: 'test_machine' });
  try {
    for (const path of ['/admin', '/admin/settings/providers']) {
      const page = await fixture.get(path);
      assert.equal(page.status, 403, path);
      assert.equal(page.location, null, path);
    }
  } finally {
    fixture.close();
  }
});
