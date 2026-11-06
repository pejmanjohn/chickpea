import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { connectionAccountOAuthRef } from '../src/config/api-oauth.ts';
import {
  completeMcpOAuthAuthorization,
  mcpOAuthSettingKeys,
  startMcpOAuthAuthorization,
  type McpOAuthDependencies,
  type StartMcpOAuthInput,
} from '../src/config/mcp-oauth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { FAKE_AUTH_SERVER, fakeMcpOAuthProvider } from './helpers/fake-mcp-oauth-provider.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const ORIGIN = 'https://chickpea.example.test';
const SHARED_CALLBACK = `${ORIGIN}/oauth/callback`;
const METADATA_URL = `${ORIGIN}/.well-known/oauth-client-metadata.json`;
const CAPABILITY = 'c'.repeat(43);

async function harness(t: { after: (fn: () => void) => void }, registration: 'cimd' | 'dcr') {
  const now = Date.now();
  const identity = new SqliteIdentityStore(':memory:');
  const owner = await createSlackOwner(identity, { now, suffix: `shared-callback-${registration}` });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    identity.close();
    config.close();
    management.close();
    settings.close();
  });
  const agent = await config.createAgent({
    id: 'agent_project_guide',
    name: 'Project Guide',
    creatorMembershipId: owner.membership.id,
    editPolicy: 'all_workspace_members',
    instructions: 'Help the team plan projects.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await config.ensureWorkspaceInstallation({
    workspaceId: owner.user.slackTeamId,
    transportMode: 'direct',
    defaultAgentId: agent.id,
  });
  const principal: AuthPrincipal = {
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    role: owner.membership.role,
    authenticatorKind: 'better_auth',
    credentialId: 'session_shared_callback',
    correlationId: 'shared_callback',
    machine: false,
  };
  const provider = fakeMcpOAuthProvider(registration);
  const starts: Array<{ input: StartMcpOAuthInput; dependencies: McpOAuthDependencies }> = [];
  const discoveredWith: string[] = [];
  // The setup router's next read of this key fails once, as a storage outage would.
  let failingRead: string | undefined;
  const app = createManagementSetupRoutes({
    identity,
    config,
    management,
    settings: new Proxy(settings, {
      get(target, property, receiver) {
        if (property !== 'getSetting') return Reflect.get(target, property, receiver);
        return async (key: string) => {
          if (key !== failingRead) return target.getSetting(key);
          failingRead = undefined;
          throw new Error('settings store unavailable');
        };
      },
    }),
    authenticatePrincipal: async () => principal,
    startMcpOAuth: (input, dependencies) => {
      starts.push({ input, dependencies });
      return startMcpOAuthAuthorization(input, { ...dependencies, fetchFn: provider.fetchFn });
    },
    completeMcpOAuth: (input, dependencies) =>
      completeMcpOAuthAuthorization(input, { ...dependencies, fetchFn: provider.fetchFn }),
    discoverMcp: async (input) => {
      discoveredWith.push(input.headers.Authorization ?? '');
      return { tools: [{ name: 'search_issues' }] };
    },
    identifyMcp: async () => ({ workspaceName: 'Acme Linear' }),
    deliverReceipt: async () => ({ deliveryRef: 'slack:D_SETUP:receipt.1' }),
  });

  async function catalogSetup(name: string) {
    const setupId = `setup_${name}`;
    await management.putSetup({
      record: {
        setupOperationId: setupId,
        organizationId: owner.membership.organizationId,
        actorUserId: owner.user.id,
        actorMembershipId: owner.membership.id,
        origin: {
          kind: 'slack',
          workspaceId: owner.user.slackTeamId,
          channelId: 'D_SETUP',
          threadTs: '1800200000.000200',
          agentId: agent.id,
        },
        action: 'catalog_connection',
        target: {
          kind: 'catalog_connection',
          provider: 'linear',
          targetId: `agent:${agent.id}:catalog:linear`,
          targetLabel: 'Linear',
          expectedRevision: agent.revision,
          agentId: agent.id,
          agentName: agent.name,
          connectionId: `connection_${name}`,
          replacement: false,
          ownerKind: 'member',
          presetId: 'linear',
        },
        scopes: [],
        tokenDigest: createHash('sha256').update(CAPABILITY).digest('base64url'),
        status: 'pending',
        expiresAt: now + 60 * 60_000,
        createdAt: now,
        updatedAt: now,
      },
    });
    const exchanged = await app.request(`${ORIGIN}/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: CAPABILITY }),
    });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    return { setupId, cookie: exchanged.headers.get('set-cookie')!.split(';')[0]! };
  }

  async function continueToProvider(setup: { setupId: string; cookie: string }) {
    const started = await app.request(`${ORIGIN}/setup/${setup.setupId}/authorize`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: setup.cookie,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'x-requested-with': 'chickpea-setup',
      },
      body: 'ownerKind=member',
    });
    assert.equal(started.status, 200, await started.clone().text());
    return new URL((await started.json() as { authorizationUrl: string }).authorizationUrl);
  }

  async function pendingAccounts() {
    return (await config.listConnectionAccounts(owner.user.slackTeamId))
      .filter(({ lifecycle }) => lifecycle === 'pending');
  }

  return {
    app, config, management, settings, identity, owner, provider, starts, discoveredWith,
    catalogSetup, continueToProvider, pendingAccounts,
    failNextRead: (key: string) => { failingRead = key; },
  };
}

/** The setup router, then Admin's routes, in src/app.ts order. Admin's /oauth/callback checks no setup cookie. */
function withAdmin(h: Awaited<ReturnType<typeof harness>>): Hono {
  const app = new Hono();
  app.route('/', h.app);
  app.route('/', createAdminRoutes({
    store: h.config,
    settings: h.settings,
    management: h.management,
    identity: h.identity,
    oauthFetch: h.provider.fetchFn,
    discoverMcp: async () => ({ tools: [{ name: 'search_issues' }] }),
    identifyMcp: async () => undefined,
  }));
  return app;
}

function pendingKeyFor(accountId: string): string {
  return mcpOAuthSettingKeys(connectionAccountOAuthRef(accountId))[1];
}

for (const registration of ['cimd', 'dcr'] as const) {
  test(`a ${registration === 'cimd' ? 'CIMD-only' : 'registration-only'} server finishes a catalog setup link through /oauth/callback`, async (t) => {
    const h = await harness(t, registration);
    const setup = await h.catalogSetup(`linear_${registration}`);

    const authorizationUrl = await h.continueToProvider(setup);
    assert.equal(authorizationUrl.origin, FAKE_AUTH_SERVER);
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), SHARED_CALLBACK);
    assert.equal(h.starts[0]!.input.setupOperationId, setup.setupId);
    if (registration === 'cimd') {
      assert.equal(authorizationUrl.searchParams.get('client_id'), METADATA_URL);
      assert.deepEqual(h.provider.registeredRedirects, []);
    } else {
      assert.equal(authorizationUrl.searchParams.get('client_id'), 'registered-client');
      assert.deepEqual(h.provider.registeredRedirects, [[SHARED_CALLBACK]]);
    }

    const state = authorizationUrl.searchParams.get('state')!;
    const callback = await h.app.request(
      `${SHARED_CALLBACK}?state=${encodeURIComponent(state)}&code=provider-code`,
      { headers: { cookie: setup.cookie } },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(callback.headers.get('location'), `/setup/${setup.setupId}`);
    assert.deepEqual(h.provider.exchanges, [{
      clientId: registration === 'cimd' ? METADATA_URL : 'registered-client',
      redirectUri: SHARED_CALLBACK,
    }]);
    assert.deepEqual(h.discoveredWith, ['Bearer linear-access']);
    const [account] = await h.config.listConnectionAccounts(h.owner.user.slackTeamId);
    assert.equal(account?.lifecycle, 'ready');
    assert.equal((await h.management.getSetup(setup.setupId))?.status, 'completed');

    const landing = await h.app.request(`${ORIGIN}/setup/${setup.setupId}`);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Linear is now connected to Project Guide/);
  });
}

test('a provider access_denied on /oauth/callback returns to the setup page to try again', async (t) => {
  const h = await harness(t, 'cimd');
  const setup = await h.catalogSetup('linear_denied');
  const authorizationUrl = await h.continueToProvider(setup);
  const [pending] = await h.pendingAccounts();
  assert.ok(pending);

  const callback = await h.app.request(
    `${SHARED_CALLBACK}?state=${encodeURIComponent(authorizationUrl.searchParams.get('state')!)}&error=access_denied`,
    { headers: { cookie: setup.cookie } },
  );
  assert.equal(callback.status, 303, await callback.clone().text());
  assert.equal(callback.headers.get('location'), `/setup/${setup.setupId}?status=cancelled`);
  assert.equal(await h.settings.getSetting(pendingKeyFor(pending.id)), undefined);
  assert.deepEqual(h.provider.exchanges, []);
  const failed = await h.management.getSetup(setup.setupId);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.failureCode, 'authorization_cancelled');

  const page = await h.app.request(`${ORIGIN}/setup/${setup.setupId}?status=cancelled`, {
    headers: { cookie: setup.cookie },
  });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Connection setup did not complete\. Try again\./);
  assert.match(html, /Continue to Linear/);
});

test('an attempt started with the per-setup callback before upgrade still completes there', async (t) => {
  const h = await harness(t, 'dcr');
  const setup = await h.catalogSetup('linear_in_flight');
  await h.continueToProvider(setup);
  const perSetupCallback = `${ORIGIN}/setup/${setup.setupId}/oauth/mcp/callback`;
  // The earlier release started the same attempt with its own callback and no setup continuation.
  const { input, dependencies } = h.starts[0]!;
  const { setupOperationId: _setupOperationId, ...earlierInput } = input;
  const earlier = await startMcpOAuthAuthorization(
    { ...earlierInput, callbackUrl: perSetupCallback },
    { ...dependencies, fetchFn: h.provider.fetchFn },
  );
  assert.equal(earlier.authorizationUrl.searchParams.get('redirect_uri'), perSetupCallback);
  const [pending] = await h.pendingAccounts();
  assert.ok(pending);

  const shared = await h.app.request(
    `${SHARED_CALLBACK}?state=${encodeURIComponent(earlier.state)}&code=provider-code`,
    { headers: { cookie: setup.cookie } },
  );
  assert.equal(shared.status, 403);
  assert.ok(await h.settings.getSetting(pendingKeyFor(pending.id)));

  const callback = await h.app.request(
    `${perSetupCallback}?state=${encodeURIComponent(earlier.state)}&code=provider-code`,
    { headers: { cookie: setup.cookie } },
  );
  assert.equal(callback.status, 303, await callback.clone().text());
  assert.equal(callback.headers.get('location'), `/setup/${setup.setupId}`);
  assert.deepEqual(h.provider.exchanges, [{ clientId: 'registered-client', redirectUri: perSetupCallback }]);
  assert.equal((await h.management.getSetup(setup.setupId))?.status, 'completed');
});

test('a setup state completes only its own setup, and an Admin state completes no setup', async (t) => {
  const h = await harness(t, 'cimd');
  const first = await h.catalogSetup('linear_first');
  const firstState = (await h.continueToProvider(first)).searchParams.get('state')!;
  const [firstAccount] = await h.pendingAccounts();
  assert.ok(firstAccount);
  const second = await h.catalogSetup('linear_second');
  await h.continueToProvider(second);
  const secondAccount = (await h.pendingAccounts()).find(({ id }) => id !== firstAccount.id);
  assert.ok(secondAccount);

  for (const url of [
    `${SHARED_CALLBACK}?state=${encodeURIComponent(firstState)}&code=provider-code`,
    `${ORIGIN}/setup/${second.setupId}/oauth/mcp/callback?state=${encodeURIComponent(firstState)}&code=provider-code`,
  ]) {
    const denied = await h.app.request(url, { headers: { cookie: second.cookie } });
    assert.equal(denied.status, 403, url);
  }
  assert.ok(await h.settings.getSetting(pendingKeyFor(firstAccount.id)));
  assert.deepEqual(h.provider.exchanges, []);
  assert.equal((await h.management.getSetup(second.setupId))?.status, 'authorizing');

  // Admin starts its own attempt on the same callback, with no setup continuation.
  const { input, dependencies } = h.starts[1]!;
  const { setupOperationId: _setupOperationId, ...adminInput } = input;
  const admin = await startMcpOAuthAuthorization(
    { ...adminInput, callbackUrl: SHARED_CALLBACK },
    { ...dependencies, fetchFn: h.provider.fetchFn },
  );
  const toAdmin = await h.app.request(
    `${SHARED_CALLBACK}?state=${encodeURIComponent(admin.state)}&code=provider-code`,
    { headers: { cookie: second.cookie } },
  );
  assert.equal(toAdmin.status, 404);
  const perSetup = await h.app.request(
    `${ORIGIN}/setup/${second.setupId}/oauth/mcp/callback?state=${encodeURIComponent(admin.state)}&code=provider-code`,
    { headers: { cookie: second.cookie } },
  );
  assert.equal(perSetup.status, 403);
  assert.ok(await h.settings.getSetting(pendingKeyFor(secondAccount.id)));
  assert.deepEqual(h.provider.exchanges, []);

  const own = await h.app.request(
    `${SHARED_CALLBACK}?state=${encodeURIComponent(firstState)}&code=provider-code`,
    { headers: { cookie: first.cookie } },
  );
  assert.equal(own.status, 303, await own.clone().text());
  assert.equal(own.headers.get('location'), `/setup/${first.setupId}`);
  assert.equal((await h.management.getSetup(first.setupId))?.status, 'completed');
  assert.equal((await h.management.getSetup(second.setupId))?.status, 'authorizing');
});

test('/oauth/callback refuses an earlier setup attempt registered at its own callback, so Admin never completes it', async (t) => {
  const h = await harness(t, 'dcr');
  const app = withAdmin(h);
  const setup = await h.catalogSetup('linear_registered_elsewhere');
  await h.continueToProvider(setup);
  const { input, dependencies } = h.starts[0]!;
  const { setupOperationId: _setupOperationId, ...earlierInput } = input;
  const earlier = await startMcpOAuthAuthorization(
    { ...earlierInput, callbackUrl: `${ORIGIN}/setup/${setup.setupId}/oauth/mcp/callback` },
    { ...dependencies, fetchFn: h.provider.fetchFn },
  );
  const [pending] = await h.pendingAccounts();
  assert.ok(pending);

  // A browser that never opened the setup link sends the state where it was not registered.
  const refused = await app.request(
    `${SHARED_CALLBACK}?state=${encodeURIComponent(earlier.state)}&code=provider-code`,
  );
  assert.equal(refused.status, 403);
  assert.ok(await h.settings.getSetting(pendingKeyFor(pending.id)));
  assert.deepEqual(h.provider.exchanges, []);
  assert.deepEqual((await h.pendingAccounts()).map(({ id }) => id), [pending.id]);
});

test('a setup state whose read fails on /oauth/callback fails closed instead of reaching Admin', async (t) => {
  const h = await harness(t, 'cimd');
  const app = withAdmin(h);
  const setup = await h.catalogSetup('linear_failed_read');
  const state = (await h.continueToProvider(setup)).searchParams.get('state')!;
  const [pending] = await h.pendingAccounts();
  assert.ok(pending);
  const callback = `${SHARED_CALLBACK}?state=${encodeURIComponent(state)}&code=provider-code`;

  h.failNextRead(pendingKeyFor(pending.id));
  const failed = await app.request(callback);
  assert.equal(failed.status, 500);
  assert.ok(await h.settings.getSetting(pendingKeyFor(pending.id)));
  assert.deepEqual(h.provider.exchanges, []);
  assert.deepEqual((await h.pendingAccounts()).map(({ id }) => id), [pending.id]);

  // The attempt survives: without the setup's cookie it is refused, with it it completes.
  assert.equal((await app.request(callback)).status, 403);
  const completed = await app.request(callback, { headers: { cookie: setup.cookie } });
  assert.equal(completed.status, 303, await completed.clone().text());
  assert.equal(completed.headers.get('location'), `/setup/${setup.setupId}`);
  assert.equal((await h.management.getSetup(setup.setupId))?.status, 'completed');
});
