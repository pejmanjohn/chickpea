import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BetterAuthMcpOAuthClient, BetterAuthMcpOAuthClients } from '../src/auth/better-auth-backend.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { completeMcpOAuthAuthorization, startMcpOAuthAuthorization } from '../src/config/mcp-oauth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import { managedPrincipalRef } from '../src/connections/managed-principal.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import { getSetupStatus } from '../src/management/mcp-v5/reads.ts';
import type { SetupWakeRequest } from '../src/management/receipts.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type { ManagementActorContext, ManagementReceiptOutboxRecord } from '../src/management/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { fakeMcpOAuthProvider } from './helpers/fake-mcp-oauth-provider.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const ORIGIN = 'https://chickpea.example.test';
const CLAUDE_CODE_CLIENT = 'client_claude_code';
const CHATGPT_CLIENT = 'https://chatgpt.com/oauth/client.json';
/** What a browser sends when the provider redirects it back. */
const BROWSER = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const WAIT_FOR_PERSON = 'Give the person this link. Test the connection only after they finish it: get_operation with this setupOperationId reports status completed.';

type Person = Pick<IdentityResolution, 'user' | 'membership'>;

async function harness(t: { after: (fn: () => void) => void }, suffix: string) {
  const identity = new SqliteIdentityStore(':memory:');
  const owner = await createSlackOwner(identity, { suffix });
  // A colleague who may edit the Agent too: only the link's person decides who uses an MCP link.
  const colleague = (await identity.provisionSlackMember({
    slackTeamId: owner.user.slackTeamId,
    slackUserId: 'U_COLLEAGUE',
    displayName: 'Colleague',
  })).resolution;
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
    lifecycle: 'active',
    configurationGeneration: 1,
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
  const service = new WorkspaceManagementService({ identity, config, management, setupBaseUrl: ORIGIN });

  const managedAuthorizations: string[][] = [];
  const composio: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async authorize(input) {
      managedAuthorizations.push([...input.allowedCapabilities]);
      return {
        authorizationUrl: new URL(`https://backend.composio.dev/link/${managedAuthorizations.length}`),
        authorizationRef: `authorization_hubspot_${managedAuthorizations.length}`,
      };
    },
    async pollAuthorization(input) {
      return { status: 'active', accountRef: input.authorizationRef, toolkit: 'hubspot' };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const oauthProvider = fakeMcpOAuthProvider('cimd');
  const clients = new Map<string, BetterAuthMcpOAuthClient[]>();
  let clientLookups = 0;
  let clientLookupFails = false;
  const mcpOAuthClients: BetterAuthMcpOAuthClients = {
    async listOAuthClientsForUser(userId) {
      clientLookups += 1;
      if (clientLookupFails) throw new Error('Better Auth unavailable');
      return clients.get(userId) ?? [];
    },
    async revokeOAuthClientForUser() {
      throw new Error('not used');
    },
  };
  const woken: SetupWakeRequest[] = [];
  const posted: ManagementReceiptOutboxRecord[] = [];
  let principal: AuthPrincipal = principalOf(owner);
  const app = createManagementSetupRoutes({
    identity,
    config,
    management,
    settings,
    authenticatePrincipal: async () => principal,
    managedConnectionProviders: createManagedConnectionProviderRegistry([composio]),
    startMcpOAuth: (input, dependencies) =>
      startMcpOAuthAuthorization(input, { ...dependencies, fetchFn: oauthProvider.fetchFn }),
    completeMcpOAuth: (input, dependencies) =>
      completeMcpOAuthAuthorization(input, { ...dependencies, fetchFn: oauthProvider.fetchFn }),
    discoverMcp: async () => ({ tools: [{ name: 'search_issues' }] }),
    identifyMcp: async () => ({ workspaceName: 'Acme Linear' }),
    mcpOAuthClients: async () => mcpOAuthClients,
    wakeAgent: async (request) => {
      woken.push(request);
      return 'queued';
    },
    deliverReceipt: async (record) => {
      posted.push(record);
      return { deliveryRef: 'slack:D_OWNER:receipt.1' };
    },
  });

  function mcp(person: Person, clientId = CLAUDE_CODE_CLIENT): ManagementActorContext {
    return {
      userId: person.user.id,
      membershipId: person.membership.id,
      organizationId: person.membership.organizationId,
      origin: { kind: 'mcp', clientId },
    };
  }

  function as(person: Person) {
    principal = principalOf(person);
  }

  async function exchange(handoffUrl: string) {
    const url = new URL(handoffUrl);
    return app.request(`${ORIGIN}${url.pathname}/exchange`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: url.hash.slice('#setup='.length) }),
    });
  }

  async function post(setupId: string, path: 'authorize' | 'managed/poll', cookie: string, fields?: Record<string, string>) {
    return app.request(`${ORIGIN}/setup/${setupId}/${path}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie,
        ...(fields
          ? {
              'content-type': 'application/x-www-form-urlencoded',
              accept: 'application/json',
              'x-requested-with': 'chickpea-setup',
            }
          : { 'content-type': 'application/json' }),
      },
      body: fields ? new URLSearchParams(fields).toString() : '{}',
    });
  }

  async function page(setupId: string, cookie?: string) {
    const response = await app.request(`${ORIGIN}/setup/${setupId}`, cookie ? { headers: { cookie } } : {});
    return { status: response.status, html: await response.text() };
  }

  /** What get_setup_status tells the app that asked for the link. */
  async function setupStatus(setupId: string, context: ManagementActorContext) {
    return (await getSetupStatus({ service, context: async () => context }, { setupToken: setupId })).status;
  }

  return {
    identity, config, management, owner, colleague, agent, service, app, clients, posted, woken,
    managedAuthorizations, mcp, as, exchange, post, page, setupStatus,
    clientLookups: () => clientLookups,
    failClientLookup: () => { clientLookupFails = true; },
  };
}

function principalOf(person: Person): AuthPrincipal {
  return {
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    role: person.membership.role,
    authenticatorKind: 'better_auth',
    credentialId: `session_${person.membership.id}`,
    correlationId: `browser_${person.membership.id}`,
    machine: false,
  };
}

function cookieOf(response: Response): string {
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

test('an MCP caller gets the one-connection setup page for a new managed or catalog connection', async (t) => {
  const h = await harness(t, 'mcp-new-links');
  for (const [connector, action] of [['HubSpot', 'managed_connection'], ['Linear', 'catalog_connection']] as const) {
    const prepared = await h.service.prepareConnectorSetup(h.mcp(h.owner), {
      agentId: h.agent.id,
      connector,
      ownerKind: 'member',
    });
    const url = new URL(prepared.handoffUrl);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.pathname, `/setup/${prepared.setupOperationId}`, `${connector} gets the setup page, not Admin`);
    assert.match(url.hash, /^#setup=[A-Za-z0-9_-]{43}$/);
    assert.equal(prepared.reconnect, undefined);
    assert.equal(prepared.instruction, WAIT_FOR_PERSON, 'no Agent continues in a Slack thread, so the app waits');
    const record = await h.management.getSetup(prepared.setupOperationId!);
    assert.equal(record?.action, action);
    assert.deepEqual(record?.origin, { kind: 'mcp', clientId: CLAUDE_CODE_CLIENT });
    assert.equal(record?.actorUserId, h.owner.user.id);
    assert.equal(record?.actorMembershipId, h.owner.membership.id);
    assert.equal(record?.target.agentId, h.agent.id);
    assert.equal(record?.target.replacement, false);
    assert.equal(record!.expiresAt - record!.createdAt, 24 * 60 * 60_000, 'the link expires as a Slack one does');
  }
});

test('the Admin page stays the fallback for a connector the setup page cannot serve', async (t) => {
  const h = await harness(t, 'mcp-admin-fallback');
  const prepared = await h.service.prepareConnectorSetup(h.mcp(h.owner), {
    agentId: h.agent.id,
    connector: 'Sentry',
    ownerKind: 'member',
  });
  assert.equal(prepared.handoffUrl, `${ORIGIN}/admin/agents/${h.agent.id}/connections/new/sentry/member`);
  assert.equal(prepared.setupOperationId, undefined);
  assert.equal(prepared.instruction, undefined);
});

test('an MCP catalog link finishes through /oauth/callback for its person only, and wakes no Agent', async (t) => {
  const h = await harness(t, 'mcp-catalog-link');
  h.clients.set(h.owner.binding.betterAuthUserId!, [
    { clientId: CLAUDE_CODE_CLIENT, name: 'Claude Code', connectedAt: new Date(), lastTokenAt: null },
  ]);
  const context = h.mcp(h.owner);
  const prepared = await h.service.prepareConnectorSetup(context, {
    agentId: h.agent.id,
    connector: 'Linear',
    ownerKind: 'member',
  });
  const setupId = prepared.setupOperationId!;
  assert.equal(await h.setupStatus(setupId, context), 'waiting');

  h.as(h.colleague);
  const colleagueClaim = await h.exchange(prepared.handoffUrl);
  assert.equal(colleagueClaim.status, 403, 'a colleague who can edit the Agent still cannot claim the link');
  assert.equal((await h.page(setupId)).status, 410);
  assert.equal((await h.management.getSetup(setupId))?.status, 'pending', 'the refused claim used nothing up');

  h.as(h.owner);
  const claimed = await h.exchange(prepared.handoffUrl);
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const cookie = cookieOf(claimed);
  const setupPage = await h.page(setupId, cookie);
  assert.equal(setupPage.status, 200);
  assert.match(setupPage.html, /Connect Linear to Project Guide/);

  h.as(h.colleague);
  const borrowed = await h.post(setupId, 'authorize', cookie, { ownerKind: 'member' });
  assert.equal(borrowed.status, 403, 'the person\'s own browser session does not carry the link to a colleague');
  assert.deepEqual(await h.config.listConnectionAccounts(h.owner.user.slackTeamId), []);

  h.as(h.owner);
  const started = await h.post(setupId, 'authorize', cookie, { ownerKind: 'member' });
  assert.equal(started.status, 200, await started.clone().text());
  const authorizationUrl = new URL((await started.json() as { authorizationUrl: string }).authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), `${ORIGIN}/oauth/callback`);
  const callback = await h.app.request(
    `${ORIGIN}/oauth/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get('state')!)}&code=provider-code`,
    { headers: { ...BROWSER, cookie } },
  );
  assert.equal(callback.status, 303, await callback.clone().text());
  assert.equal(callback.headers.get('location'), `/setup/${setupId}`);

  const [account] = await h.config.listConnectionAccounts(h.owner.user.slackTeamId);
  assert.equal(account?.lifecycle, 'ready');
  assert.equal(account?.ownerMembershipId, h.owner.membership.id);
  const completed = await h.management.getSetup(setupId);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.completedByUserId, h.owner.user.id);
  assert.deepEqual(h.woken, [], 'an MCP link has no Slack thread to wake an Agent in');
  assert.deepEqual(h.posted.map(({ destination }) => destination), [{
    kind: 'initiator_dm',
    organizationId: h.owner.membership.organizationId,
    userId: h.owner.user.id,
  }]);
  assert.equal((await h.service.getOperation(context, setupId))?.status, 'completed');
  assert.equal(await h.setupStatus(setupId, context), 'done');

  const success = await h.page(setupId);
  assert.equal(success.status, 200);
  assert.match(success.html, /Linear is now connected to Project Guide/);
  assert.match(success.html, /Your personal connection is ready\./);
  assert.match(success.html, /You can close this tab and go back to Claude Code\./);
  assert.doesNotMatch(success.html, /Slack/);

  h.as(h.colleague);
  assert.equal((await h.page(setupId)).status, 410, 'the colleague does not see the finished link either');
});

test('an MCP managed link opens only for its person and sends them back to ChatGPT by name', async (t) => {
  const h = await harness(t, 'mcp-managed-link');
  const context = h.mcp(h.owner, CHATGPT_CLIENT);
  const prepared = await h.service.prepareConnectorSetup(context, {
    agentId: h.agent.id,
    connector: 'HubSpot',
    ownerKind: 'member',
  });
  const setupId = prepared.setupOperationId!;

  h.as(h.colleague);
  assert.equal((await h.exchange(prepared.handoffUrl)).status, 403);
  const refused = await h.page(setupId);
  assert.equal(refused.status, 410);
  assert.match(refused.html, /This link is no longer valid/);
  assert.match(refused.html, /Ask the app that gave you this link for a new one\./);
  assert.doesNotMatch(refused.html, /Slack/);

  h.as(h.owner);
  const claimed = await h.exchange(prepared.handoffUrl);
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const cookie = cookieOf(claimed);
  const setupPage = await h.page(setupId, cookie);
  assert.equal(setupPage.status, 200);
  assert.match(setupPage.html, /Connect HubSpot to Project Guide/);

  h.as(h.colleague);
  assert.equal((await h.post(setupId, 'authorize', cookie, { ownerKind: 'member', access: 'read' })).status, 403);
  assert.equal((await h.post(setupId, 'managed/poll', cookie)).status, 403);
  assert.deepEqual(h.managedAuthorizations, [], 'the colleague never reached HubSpot');

  h.as(h.owner);
  const started = await h.post(setupId, 'authorize', cookie, { ownerKind: 'member', access: 'read' });
  assert.equal(started.status, 200, await started.clone().text());
  assert.equal((await started.json() as { authorizationUrl: string }).authorizationUrl, 'https://backend.composio.dev/link/1');
  const polled = await h.post(setupId, 'managed/poll', cookie);
  assert.equal(polled.status, 200, await polled.clone().text());
  assert.deepEqual(await polled.json(), { status: 'connected' });

  const [account] = await h.config.listConnectionAccounts(h.owner.user.slackTeamId);
  assert.equal(account?.lifecycle, 'ready');
  assert.equal(account?.workspaceId, h.owner.user.slackTeamId);
  assert.deepEqual(h.woken, []);
  assert.equal(h.posted[0]?.destination.kind, 'initiator_dm');
  assert.equal(await h.setupStatus(setupId, context), 'done');

  const success = await h.page(setupId);
  assert.match(success.html, /HubSpot is now connected to Project Guide/);
  assert.match(success.html, /You can close this tab and go back to ChatGPT\./);
  assert.equal(h.clientLookups(), 0, 'Chickpea names ChatGPT itself; no registration is read');
});

test('an MCP reconnect signs the same managed account in again, and an unknown app is "your app"', async (t) => {
  const h = await harness(t, 'mcp-managed-reconnect');
  const capabilities = ['hubspot.contacts.search'];
  const account = await h.config.putConnectionAccount({
    id: 'connection_hubspot_team',
    workspaceId: h.owner.user.slackTeamId,
    ownerKind: 'team',
    createdByMembershipId: h.owner.membership.id,
    providerId: 'hubspot',
    label: 'HubSpot · Team',
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit: 'hubspot',
      principalRef: managedPrincipalRef(principalOf(h.owner), 'team', undefined)!,
      accountRef: 'account_hubspot_before',
      allowedCapabilities: capabilities,
    },
    secretRefId: 'secret_hubspot_team',
    lifecycle: 'needs_attention',
  });
  await h.config.putAgentConnectionBinding({
    agentId: h.agent.id,
    connectionAccountId: account.id,
    providerId: account.providerId,
    allowedCapabilities: capabilities,
    enabled: true,
  });
  const context = h.mcp(h.owner);
  const prepared = await h.service.prepareConnectorSetup(context, {
    agentId: h.agent.id,
    connector: 'HubSpot',
    ownerKind: 'team',
  });
  assert.deepEqual(prepared.reconnect, { connectionId: account.id, label: 'HubSpot · Team' });
  const setupId = prepared.setupOperationId!;
  assert.equal(new URL(prepared.handoffUrl).pathname, `/setup/${setupId}`);

  const cookie = cookieOf(await h.exchange(prepared.handoffUrl));
  const setupPage = await h.page(setupId, cookie);
  assert.match(setupPage.html, /<input[^>]+name="ownerKind"[^>]+value="team"[^>]+checked disabled/,
    'the page locks the account\'s owner, as a Slack reconnect does');
  const started = await h.post(setupId, 'authorize', cookie, { ownerKind: 'team', access: 'read' });
  assert.equal(started.status, 200, await started.clone().text());
  assert.deepEqual(h.managedAuthorizations, [capabilities], 'the reconnect keeps the account\'s capabilities');
  assert.equal((await h.post(setupId, 'managed/poll', cookie)).status, 200);

  assert.deepEqual(
    (await h.config.listConnectionAccounts(h.owner.user.slackTeamId)).map(({ id, lifecycle }) => ({ id, lifecycle })),
    [{ id: account.id, lifecycle: 'ready' }],
    'the same account is ready again; none was minted',
  );
  assert.deepEqual(h.woken, []);

  h.failClientLookup();
  const success = await h.page(setupId);
  assert.match(success.html, /HubSpot is now connected to Project Guide/);
  assert.match(success.html, /You can close this tab and go back to your app\./);
});
