import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { MCP_CLIENT_IDS, mcpClientsPayload } from '../src/management/mcp-client-config.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const ADMIN_TOKEN = 'mcp-clients-admin-token';
const ADMIN_ORIGIN = 'http://localhost';

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

const member: AuthPrincipal = {
  ...owner,
  userId: 'user_member',
  membershipId: 'membership_member',
  role: 'member',
  credentialId: 'session_member',
  correlationId: 'request_member',
};

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
    app,
    close: () => {
      config.close();
      settings.close();
      usage.close();
    },
  };
}

async function mcpClients(principal: AuthPrincipal, headers?: Record<string, string>) {
  const fixture = harness(principal);
  try {
    const response = await fixture.app.request(`${ADMIN_ORIGIN}/admin/api/mcp-clients`, {
      headers: headers ?? testAdminHeaders(ADMIN_TOKEN),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } finally {
    fixture.close();
  }
}

// `requestOrigin` honors an operator pin over the request host, so a pin left
// in the environment by another suite would decide the URLs under test.
function withoutOriginPin<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SLACK_TAG_PUBLIC_URL;
  delete process.env.SLACK_TAG_PUBLIC_URL;
  return run().finally(() => {
    if (previous === undefined) delete process.env.SLACK_TAG_PUBLIC_URL;
    else process.env.SLACK_TAG_PUBLIC_URL = previous;
  });
}

test('a member reads the coding-agent client table for this deployment', async () => {
  await withoutOriginPin(async () => {
    const response = await mcpClients(member);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = JSON.parse(response.text) as ReturnType<typeof mcpClientsPayload>;
    assert.equal(body.url, `${ADMIN_ORIGIN}/mcp`);
    assert.equal(body.guideUrl, `${ADMIN_ORIGIN}/connect.md`);
    assert.equal(body.connectUrl, `${ADMIN_ORIGIN}/connect`);
    assert.match(body.prompt, /Connect my coding agent to my Chickpea using http:\/\/localhost\/connect\.md/);
    assert.deepEqual(body.clients.map((client) => client.id), [...MCP_CLIENT_IDS]);
    assert.deepEqual(body, mcpClientsPayload(ADMIN_ORIGIN));
  });
});

test('an owner reads exactly the same table as a member', async () => {
  await withoutOriginPin(async () => {
    const asOwner = await mcpClients(owner);
    const asMember = await mcpClients(member);
    assert.equal(asOwner.status, 200, asOwner.text);
    assert.equal(asOwner.text, asMember.text);
  });
});

test('an unauthenticated request never receives the client table', async () => {
  await withoutOriginPin(async () => {
    const response = await mcpClients(owner, { origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin' });
    assert.notEqual(response.status, 200, response.text);
    assert.ok(!response.text.includes('claude mcp add'), response.text);
    assert.ok(!response.text.includes('/mcp"'), response.text);
  });
});
