import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_800_200_000_000;
const CAPABILITY = 'c'.repeat(43);

test('a native connector welcome link stays on the dedicated setup surface until Continue', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: 'native-connector-landing' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');

  try {
    const agent = await config.createAgent({
      id: 'agent_project_guide',
      name: 'Project Guide',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'all_workspace_members',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Help the team plan and deliver projects.',
      enabled: true,
      slackPresence: {
        requestedHandle: 'project-guide',
        normalizedHandle: 'project-guide',
        desiredState: 'active',
        health: 'healthy',
        avatar: {
          kind: 'generated',
          revision: 1,
          seed: 'agent_project_guide',
          url: 'https://cdn.example.test/project-guide.png',
        },
      },
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
    const setupId = 'setup_welcome_linear';
    await management.putSetup({
      record: {
        setupOperationId: setupId,
        organizationId: owner.membership.organizationId,
        actorUserId: owner.user.id,
        actorMembershipId: owner.membership.id,
        origin: {
          kind: 'slack',
          workspaceId: owner.user.slackTeamId,
          channelId: 'D_NATIVE_CONNECTOR',
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
          connectionId: 'connection_native_linear',
          replacement: false,
          ownerKind: 'member',
          presetId: 'linear',
        },
        scopes: ['read', 'write'],
        tokenDigest: createHash('sha256').update(CAPABILITY).digest('base64url'),
        status: 'pending',
        expiresAt: NOW + 60_000,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const issuerPrincipal: AuthPrincipal = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      role: owner.membership.role,
      authenticatorKind: 'better_auth',
      credentialId: 'session_native_connector',
      correlationId: 'native_connector_owner',
      machine: false,
    };
    const completingPrincipal: AuthPrincipal = {
      ...issuerPrincipal,
      userId: 'user_native_connector_editor',
      membershipId: 'membership_native_connector_editor',
      role: 'member',
      credentialId: 'session_native_connector_editor',
      correlationId: 'native_connector_editor',
    };
    let principal = completingPrincipal;
    const starts: Array<{
      ref: { agentId: string; connectionId: string };
      serverUrl: string;
      callbackUrl: string;
      returnAgentId?: string;
      accountRevision?: number;
      oauthAttemptId?: string;
    }> = [];
    let completeCalls = 0;
    const app = createManagementSetupRoutes({
      identity,
      config,
      management,
      settings,
      now: () => NOW,
      authenticatePrincipal: async () => principal,
      startMcpOAuth: async (input) => {
        starts.push(input);
        return {
          authorizationUrl: new URL('https://linear.example/oauth/authorize'),
          state: 'linear-state',
        };
      },
      completeMcpOAuth: async () => {
        completeCalls += 1;
        const latest = starts.at(-1)!;
        return {
          ref: latest.ref,
          ...(latest.accountRevision !== undefined
            ? { accountRevision: latest.accountRevision }
            : {}),
          ...(latest.oauthAttemptId
            ? { oauthAttemptId: latest.oauthAttemptId }
            : {}),
          returnAgentId: agent.id,
        };
      },
      resolveMcpOAuthToken: async () => 'linear-access-token',
      discoverMcp: async (input) => {
        assert.equal(input.headers.Authorization, 'Bearer linear-access-token');
        return { tools: [{ name: 'search_issues' }, { name: 'create_issue' }] };
      },
      identifyMcp: async () => ({ workspaceName: 'Acme Linear', accountName: 'Pejman' }),
      deliverReceipt: async () => ({ deliveryRef: 'slack:D_NATIVE_CONNECTOR:receipt.1' }),
    });

    const exchanged = await exchange(app, setupId);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const cookie = exchanged.headers.get('set-cookie')!.split(';')[0]!;

    const setupPage = await app.request(`http://localhost/setup/${setupId}`, {
      headers: { cookie },
    });
    assert.equal(setupPage.status, 200);
    const setupHtml = await setupPage.text();
    assert.match(setupHtml, /Connect Linear to Project Guide/);
    assert.match(setupHtml, /data-connector-surface="connector-setup"/);
    assert.equal((await config.listConnectionAccounts(owner.user.slackTeamId)).length, 0);
    assert.equal((await config.listAgentConnectionBindings(agent.id)).length, 0);

    const started = await authorize(app, setupId, cookie, { ownerKind: 'member' });
    assert.equal(started.status, 200, await started.clone().text());
    assert.equal((await started.json()).authorizationUrl, 'https://linear.example/oauth/authorize');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.serverUrl, 'https://mcp.linear.app/mcp');
    assert.equal(starts[0]!.callbackUrl,
      `http://localhost/setup/${setupId}/oauth/mcp/callback`);
    assert.equal(starts[0]!.returnAgentId, agent.id);
    assert.ok(starts[0]!.accountRevision);
    assert.ok(starts[0]!.oauthAttemptId);

    const accounts = await config.listConnectionAccounts(owner.user.slackTeamId);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.providerId, 'linear');
    assert.equal(accounts[0]!.ownerKind, 'member');
    assert.equal(accounts[0]!.policy.kind, 'mcp');
    assert.equal(accounts[0]!.lifecycle, 'pending');
    assert.equal((await config.listAgentConnectionBindings(agent.id)).length, 1);

    const callback = await app.request(
      `http://localhost/setup/${setupId}/oauth/mcp/callback?state=linear-state&code=linear-code`,
      { headers: { cookie } },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(callback.headers.get('location'), `/setup/${setupId}`);
    const connected = (await config.listConnectionAccounts(owner.user.slackTeamId))[0]!;
    assert.equal(connected.lifecycle, 'ready');
    assert.equal(connected.ownerMembershipId, completingPrincipal.membershipId);
    assert.deepEqual(
      connected.policy.kind === 'mcp' ? connected.policy.allowedTools : [],
      ['search_issues', 'create_issue'],
    );
    assert.equal(connected.identity?.workspaceName, 'Acme Linear');
    const completedSetup = await management.getSetup(setupId);
    assert.equal(completedSetup?.status, 'completed');
    assert.equal(completedSetup?.completedByUserId, completingPrincipal.userId);
    assert.equal(completedSetup?.completedByMembershipId, completingPrincipal.membershipId);

    const success = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(success.status, 200);
    assert.match(await success.text(), /Linear is now connected to Project Guide/);

    principal = issuerPrincipal;
    const issuerSuccess = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(issuerSuccess.status, 200);
    assert.match(await issuerSuccess.text(), /Linear is now connected to Project Guide/);

    const privateAgent = await config.createAgent({
      id: 'agent_private_project_guide',
      name: 'Private Project Guide',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Help the owner manage private projects.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const privateSetupId = 'setup_welcome_private_linear';
    await management.putSetup({
      record: {
        setupOperationId: privateSetupId,
        organizationId: owner.membership.organizationId,
        actorUserId: owner.user.id,
        actorMembershipId: owner.membership.id,
        origin: {
          kind: 'slack',
          workspaceId: owner.user.slackTeamId,
          channelId: 'D_NATIVE_CONNECTOR',
          threadTs: '1800200000.000300',
          agentId: privateAgent.id,
        },
        action: 'catalog_connection',
        target: {
          kind: 'catalog_connection',
          provider: 'linear',
          targetId: `agent:${privateAgent.id}:catalog:linear`,
          targetLabel: 'Linear',
          expectedRevision: privateAgent.revision,
          agentId: privateAgent.id,
          agentName: privateAgent.name,
          connectionId: 'connection_private_native_linear',
          replacement: false,
          ownerKind: 'member',
          presetId: 'linear',
        },
        scopes: ['read', 'write'],
        tokenDigest: createHash('sha256').update(CAPABILITY).digest('base64url'),
        status: 'pending',
        expiresAt: NOW + 60_000,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    principal = issuerPrincipal;
    const privateExchange = await exchange(app, privateSetupId);
    assert.equal(privateExchange.status, 200);
    const privateCookie = privateExchange.headers.get('set-cookie')!.split(';')[0]!;
    const privateStart = await authorize(app, privateSetupId, privateCookie, {
      ownerKind: 'member',
    });
    assert.equal(privateStart.status, 200, await privateStart.clone().text());
    assert.equal(starts.length, 2);

    principal = completingPrincipal;
    const deniedCallback = await app.request(
      `http://localhost/setup/${privateSetupId}/oauth/mcp/callback?state=linear-state&code=linear-code`,
      { headers: { cookie: privateCookie } },
    );
    assert.equal(deniedCallback.status, 303);
    assert.equal(deniedCallback.headers.get('location'),
      `/setup/${privateSetupId}?status=failed`);
    assert.equal(completeCalls, 1);
    assert.equal((await management.getSetup(privateSetupId))?.status, 'failed');
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('the managed connector link is reusable and completes from the dedicated page', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: 'connector-landing' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const authorizeInputs: Array<{
    principalRef: string;
    allowedCapabilities: string[];
    returnUrl?: string;
  }> = [];
  let revokeCalls = 0;
  let writeReady = true;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability({ accessLane }) {
      return accessLane === 'write' && !writeReady
        ? { status: 'unavailable', missingConfiguration: ['auth_config_missing'] }
        : { status: 'ready', missingConfiguration: [] };
    },
    async authorize(input) {
      authorizeInputs.push({
        principalRef: input.principalRef,
        allowedCapabilities: [...input.allowedCapabilities],
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      });
      return {
        authorizationUrl: new URL(`https://backend.composio.dev/link/${authorizeInputs.length}`),
        authorizationRef: `authorization_hubspot_${authorizeInputs.length}`,
      };
    },
    async pollAuthorization(input) {
      return {
        status: 'active',
        accountRef: input.authorizationRef,
        toolkit: 'hubspot',
      };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() { revokeCalls += 1; },
  };

  try {
    const agent = await config.createAgent({
      id: 'agent_sprout',
      name: 'Sprout',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'all_workspace_members',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Help the team.',
      enabled: true,
      slackPresence: {
        requestedHandle: 'sprout',
        normalizedHandle: 'sprout',
        desiredState: 'active',
        health: 'healthy',
        avatar: {
          kind: 'generated',
          revision: 1,
          seed: 'agent_sprout',
          url: 'https://cdn.example.test/sprout.png',
        },
      },
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
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      now: () => NOW,
      randomId: () => 'connector_landing',
      randomCapability: () => CAPABILITY,
    });
    const prepared = await service.prepareConnectorSetup({
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: {
        kind: 'slack',
        workspaceId: owner.user.slackTeamId,
        channelId: 'D_CONNECTOR',
        threadTs: '1800200000.000100',
        agentId: agent.id,
      },
    }, {
      agentId: agent.id,
      connector: 'HubSpot',
      ownerKind: 'member',
    });
    const setupUrl = new URL(prepared.handoffUrl);
    const setupId = setupUrl.pathname.split('/').at(-1)!;
    const ownerPrincipal: AuthPrincipal = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      role: owner.membership.role,
      authenticatorKind: 'better_auth',
      credentialId: 'session_owner',
      correlationId: 'connector_owner',
      machine: false,
    };
    const memberPrincipal: AuthPrincipal = {
      ...ownerPrincipal,
      userId: 'user_second_member',
      membershipId: 'membership_second_member',
      role: 'member',
      credentialId: 'session_second_member',
      correlationId: 'connector_second_member',
    };
    let principal = ownerPrincipal;
    const deliveries: string[] = [];
    const app = createManagementSetupRoutes({
      identity,
      config,
      management,
      settings,
      now: () => NOW,
      managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
      authenticatePrincipal: async () => principal,
      deliverReceipt: async (record) => {
        deliveries.push(record.outboxId);
        return { deliveryRef: 'slack:D_CONNECTOR:receipt.1' };
      },
    });

    const initial = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(initial.status, 200);
    assert.match(await initial.text(), /Checking this secure setup link/);

    const ownerExchange = await exchange(app, setupId);
    assert.equal(ownerExchange.status, 200, await ownerExchange.clone().text());
    const ownerCookie = ownerExchange.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(ownerCookie, new RegExp(CAPABILITY));
    assert.equal((await management.getSetup(setupId))?.status, 'pending');
    assert.ok((await management.getSetup(setupId))?.tokenDigest);

    const setupPage = await app.request(`http://localhost/setup/${setupId}`, {
      headers: { cookie: ownerCookie },
    });
    const setupHtml = await setupPage.text();
    assert.equal(setupPage.status, 200);
    assert.match(setupHtml, /Connect HubSpot to Sprout/);
    assert.match(setupHtml, /<input[^>]+name="ownerKind"[^>]+value="member"/);
    assert.match(setupHtml, /<input[^>]+name="ownerKind"[^>]+value="team"/);
    assert.doesNotMatch(setupHtml, /<input[^>]+name="ownerKind"[^>]+checked/);
    assert.match(setupHtml, /<input[^>]+name="access"[^>]+value="write"/);
    assert.match(setupHtml, /--chickpea-wordmark-image:url\("data:image\/png;base64,/);
    assert.match(setupHtml, new RegExp(`src="http://localhost/assets/agents/${agent.id}/avatar/1"`));

    writeReady = false;
    const readOnlySetupPage = await app.request(`http://localhost/setup/${setupId}`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(readOnlySetupPage.status, 200);
    assert.match(
      await readOnlySetupPage.text(),
      /<input[^>]+name="access"[^>]+value="write"[^>]+disabled/,
    );
    writeReady = true;

    const ownerAuthorize = await authorize(app, setupId, ownerCookie, {
      ownerKind: 'team',
      access: 'write',
    });
    assert.equal(ownerAuthorize.status, 200, await ownerAuthorize.clone().text());
    assert.equal((await ownerAuthorize.json()).authorizationUrl,
      'https://backend.composio.dev/link/1');

    // A second authorized person can open the same capability and start their
    // own provider flow. The first browser did not claim or lock the link.
    principal = memberPrincipal;
    const memberExchange = await exchange(app, setupId);
    assert.equal(memberExchange.status, 200, await memberExchange.clone().text());
    const memberCookie = memberExchange.headers.get('set-cookie')!.split(';')[0]!;
    const memberAuthorize = await authorize(app, setupId, memberCookie, {
      ownerKind: 'team',
      access: 'read',
    });
    assert.equal(memberAuthorize.status, 200, await memberAuthorize.clone().text());
    assert.equal(authorizeInputs.length, 2);
    assert.equal(authorizeInputs[0]!.principalRef, authorizeInputs[1]!.principalRef);
    assert.match(authorizeInputs[0]!.principalRef, /^chickpea:organization:/);
    assert.match(authorizeInputs[0]!.returnUrl ?? '', new RegExp(`/setup/${setupId}\\?poll=1$`));

    principal = ownerPrincipal;
    const poll = await app.request(`http://localhost/setup/${setupId}/managed/poll`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(poll.status, 200, await poll.clone().text());
    assert.deepEqual(await poll.json(), { status: 'connected' });

    const completed = await management.getSetup(setupId);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.completedByUserId, ownerPrincipal.userId);
    assert.equal(completed?.completedByMembershipId, ownerPrincipal.membershipId);
    assert.ok(completed?.connectionAccountId);
    assert.equal(completed?.receipt && 'kind' in completed.receipt
      ? completed.receipt.ownerKind
      : undefined, 'team');
    assert.equal(completed?.receipt && 'kind' in completed.receipt
      ? completed.receipt.accessLane
      : undefined, 'write');
    assert.equal(deliveries.length, 1);
    assert.equal((await management.getOutboxForOperation(setupId))?.status, 'delivered');
    assert.equal((await config.listConnectionAccounts(owner.user.slackTeamId)).length, 1);

    principal = memberPrincipal;
    const memberReturn = await app.request(`http://localhost/setup/${setupId}?poll=1`, {
      headers: { cookie: memberCookie },
    });
    assert.equal(memberReturn.status, 200);
    const memberReturnHtml = await memberReturn.text();
    assert.match(memberReturnHtml, /Finishing your HubSpot connection/);
    assert.match(memberReturnHtml, new RegExp(`/setup/${setupId}/managed/poll`));
    assert.doesNotMatch(memberReturnHtml, /HubSpot is now connected to Sprout/);

    const staleAuthorize = await authorize(app, setupId, memberCookie, {
      ownerKind: 'member',
      access: 'read',
    });
    assert.equal(staleAuthorize.status, 409, await staleAuthorize.clone().text());
    const staleAuthorizeBody = await staleAuthorize.json() as { error: string };
    assert.equal(staleAuthorizeBody.error, 'managed_authorization_superseded');
    assert.equal(authorizeInputs.length, 2);

    const stalePlainForm = await app.request(`http://localhost/setup/${setupId}/authorize`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie: memberCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'ownerKind=not-a-real-owner&access=not-a-real-lane',
    });
    assert.equal(stalePlainForm.status, 303);
    assert.equal(stalePlainForm.headers.get('location'), `/setup/${setupId}`);
    assert.equal(authorizeInputs.length, 2);

    const superseded = await app.request(`http://localhost/setup/${setupId}/managed/poll`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie: memberCookie,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(superseded.status, 409);
    const supersededBody = await superseded.json() as { error: string; message: string };
    assert.equal(supersededBody.error, 'managed_authorization_superseded');
    assert.match(supersededBody.message, /Your sign-in was discarded/);
    assert.equal(revokeCalls, 1);

    const success = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(success.status, 200);
    const successHtml = await success.text();
    assert.match(successHtml, /HubSpot is now connected to Sprout/);
    assert.match(successHtml, /Your team, read and write connection is ready/);
    assert.match(successHtml, /You can close this tab now/);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

async function exchange(app: ReturnType<typeof createManagementSetupRoutes>, setupId: string) {
  return app.request(`http://localhost/setup/${setupId}/exchange`, {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ capability: CAPABILITY }),
  });
}

async function authorize(
  app: ReturnType<typeof createManagementSetupRoutes>,
  setupId: string,
  cookie: string,
  fields: Record<string, string>,
) {
  return app.request(`http://localhost/setup/${setupId}/authorize`, {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-requested-with': 'chickpea-setup',
    },
    body: new URLSearchParams(fields).toString(),
  });
}
