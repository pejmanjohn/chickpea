import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  connectionAccountSecretSettingKey,
  resolveConnectionAccountSecret,
} from '../src/config/connector-secrets.ts';
import type { OAuthAuthorizationAuthority } from '../src/config/oauth-authorization.ts';
import {
  META_ADS_OAUTH_DEFAULT_SCOPE,
  META_ADS_OAUTH_MANAGEMENT_SCOPE,
} from '../src/config/mcp-oauth-clients.ts';
import type { ConnectionAccount } from '../src/config/types.ts';
import { McpOAuthError, type StartMcpOAuthInput } from '../src/config/mcp-oauth.ts';
import { SqliteConfigStore, type ConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import { managedPrincipalRef } from '../src/connections/managed-authorization-flow.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import { signInMixRefusal, signInOtherKindNotice } from '../src/connections/sign-in-mix.ts';
import { escapeHtml } from '../src/security/html-escape.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { createManagementSetupRoutes, replaceCatalogConnection } from '../src/management/setup-routes.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type { ProductTelemetryEventInput } from '../src/telemetry/events.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_800_200_000_000;
const CAPABILITY = 'c'.repeat(43);

function mcpOAuthState(
  ref: { agentId: string; connectionId: string },
  nonce: string,
): string {
  return Buffer.from(JSON.stringify({ a: ref.agentId, c: ref.connectionId, n: nonce }))
    .toString('base64url');
}

test('a native connector welcome link stays on the dedicated setup surface until Continue', async (t) => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: 'native-connector-landing' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');

  try {
    const editorLocatorHash = createHash('sha256').update('native-connector-editor').digest('hex');
    const editorInvitation = await identity.createInvitation({
      organizationId: owner.membership.organizationId,
      slackTeamId: owner.user.slackTeamId,
      slackUserId: 'U_NATIVE_CONNECTOR_EDITOR',
      displayName: 'Connector Editor',
      role: 'admin',
      locatorHash: editorLocatorHash,
      inviterMembershipId: owner.membership.id,
    });
    const editor = await identity.consumeInvitation({
      invitationId: editorInvitation.id,
      locatorHash: editorLocatorHash,
      slackTeamId: owner.user.slackTeamId,
      slackUserId: editorInvitation.slackUserId,
      displayName: 'Connector Editor',
      betterAuthUserId: 'ba_user_native_connector_editor',
      betterAuthMembershipId: 'ba_member_native_connector_editor',
    });
    await identity.updateMembershipAuthority({
      membershipId: editor.membership.id,
      role: 'member',
      actorMembershipId: owner.membership.id,
      authenticationSurface: 'better_auth',
      correlationId: 'native_connector_editor_initial_member',
      reasonCode: 'connector_editor_member',
    });
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
        scopes: [],
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
      userId: editor.user.id,
      membershipId: editor.membership.id,
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
      authorizationAuthority?: OAuthAuthorizationAuthority;
    }> = [];
    const states: string[] = [];
    let completeCalls = 0;
    let authorizationChecks = 0;
    let tokenCalls = 0;
    let discoverCalls = 0;
    let identifyCalls = 0;
    let settingWrites = 0;
    const productEvents: ProductTelemetryEventInput[] = [];
    let duringDiscovery: (() => Promise<void>) | undefined;
    const routeSettings = new Proxy(settings, {
      get(target, property, receiver) {
        if (property === 'setSetting') {
          return async (...args: Parameters<SqliteSettingsStore['setSetting']>) => {
            settingWrites += 1;
            return settings.setSetting(...args);
          };
        }
        if (property === 'deleteSetting') {
          return async (...args: Parameters<SqliteSettingsStore['deleteSetting']>) => {
            settingWrites += 1;
            return settings.deleteSetting(...args);
          };
        }
        if (property === 'applySettingsPatch') {
          return async (...args: Parameters<SqliteSettingsStore['applySettingsPatch']>) => {
            settingWrites += 1;
            return settings.applySettingsPatch(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = createManagementSetupRoutes({
      identity,
      config,
      management,
      settings: routeSettings,
      productTelemetry: () => ({ capture: (event) => productEvents.push(event) }),
      now: () => NOW,
      authenticatePrincipal: async () => principal,
      startMcpOAuth: async (input) => {
        starts.push(input);
        const state = mcpOAuthState(input.ref, `nonce_${starts.length}`);
        states.push(state);
        return {
          authorizationUrl: new URL('https://linear.example/oauth/authorize'),
          state,
        };
      },
      completeMcpOAuth: async (_input, oauthDependencies) => {
        const latest = starts.at(-1)!;
        authorizationChecks += 1;
        if (oauthDependencies.validateAuthorization &&
            !(await oauthDependencies.validateAuthorization(
              latest.authorizationAuthority,
              latest.ref,
            ))) {
          throw new McpOAuthError(
            'authorization_expired',
            'OAuth initiating authority is no longer current',
          );
        }
        completeCalls += 1;
        return {
          ref: latest.ref,
          ...(latest.accountRevision !== undefined
            ? { accountRevision: latest.accountRevision }
            : {}),
          ...(latest.oauthAttemptId
            ? { oauthAttemptId: latest.oauthAttemptId }
            : {}),
          ...(latest.authorizationAuthority
            ? { authorizationAuthority: latest.authorizationAuthority }
            : {}),
          returnAgentId: agent.id,
        };
      },
      resolveMcpOAuthToken: async () => {
        tokenCalls += 1;
        return 'linear-access-token';
      },
      discoverMcp: async (input) => {
        discoverCalls += 1;
        await duringDiscovery?.();
        assert.equal(input.headers.Authorization, 'Bearer linear-access-token');
        return { tools: [{ name: 'search_issues' }, { name: 'create_issue' }] };
      },
      identifyMcp: async () => {
        identifyCalls += 1;
        return { workspaceName: 'Acme Linear', accountName: 'Pejman' };
      },
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
    assert.match(setupHtml, /<input[^>]+type="radio"[^>]+name="ownerKind"[^>]+value="member"/);
    assert.match(setupHtml, /<input[^>]+type="radio"[^>]+name="ownerKind"[^>]+value="team"/);
    assert.doesNotMatch(setupHtml, /<input[^>]+name="ownerKind"[^>]+checked/);
    assert.doesNotMatch(setupHtml, /<select|select-control/);
    assert.match(
      setupHtml,
      /<button[^>]+value="authorize" disabled>Continue to Linear<\/button>/,
    );
    assert.match(setupHtml, /button\.disabled=!selectedOwner\(\)/);
    assert.match(setupHtml, /Choose Personal or Team to continue\./);
    assert.equal((await config.listConnectionAccounts(owner.user.slackTeamId)).length, 0);
    assert.equal((await config.listAgentConnectionBindings(agent.id)).length, 0);

    const missingOwner = await authorize(app, setupId, cookie, {});
    assert.equal(missingOwner.status, 422, await missingOwner.clone().text());
    assert.equal((await config.listConnectionAccounts(owner.user.slackTeamId)).length, 0);
    assert.equal((await config.listAgentConnectionBindings(agent.id)).length, 0);

    await config.updateAgent(agent.id, {
      instructions: 'Help the team plan, deliver, and report on projects.',
    }, agent.revision);

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
      `http://localhost/setup/${setupId}/oauth/mcp/callback?state=${states[0]}&code=linear-code`,
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
    assert.equal(completedSetup?.receipt && 'kind' in completedSetup.receipt
      ? completedSetup.receipt.accessLane
      : undefined, 'write');
    assert.deepEqual(productEvents, [{
      event: 'connection_ready',
      workspaceId: owner.user.slackTeamId,
      agentId: agent.id,
      connectionKind: 'mcp',
      ownerKind: 'member',
      surface: 'slack',
    }]);

    const success = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(success.status, 200);
    const successHtml = await success.text();
    assert.match(successHtml, /Linear is now connected to Project Guide/);
    assert.match(successHtml, /personal connection is ready/);

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

    principal = completingPrincipal;
    const deniedComplete = await app.request(
      `http://localhost/setup/${privateSetupId}/complete`,
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          cookie: privateCookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'ownerKind=member',
      },
    );
    assert.equal(deniedComplete.status, 403);
    assert.equal((await management.getSetup(privateSetupId))?.status, 'claimed');

    principal = issuerPrincipal;
    const privateStart = await authorize(app, privateSetupId, privateCookie, {
      ownerKind: 'member',
    });
    assert.equal(privateStart.status, 200, await privateStart.clone().text());
    assert.equal(starts.length, 2);

    principal = completingPrincipal;
    const deniedCallback = await app.request(
      `http://localhost/setup/${privateSetupId}/oauth/mcp/callback?state=${states[1]}&code=linear-code`,
      { headers: { cookie: privateCookie } },
    );
    assert.equal(deniedCallback.status, 403);
    assert.equal(completeCalls, 1);
    assert.equal((await management.getSetup(privateSetupId))?.status, 'authorizing');

    await identity.updateMembershipAuthority({
      membershipId: editor.membership.id,
      role: 'admin',
      actorMembershipId: owner.membership.id,
      authenticationSurface: 'better_auth',
      correlationId: 'native_connector_editor_promoted',
      reasonCode: 'connector_editor_admin',
    });
    principal = { ...completingPrincipal, role: 'admin' };
    const switchedOwner = await authorize(app, privateSetupId, privateCookie, {
      ownerKind: 'team',
    });
    assert.equal(switchedOwner.status, 200, await switchedOwner.clone().text());
    assert.equal(starts.length, 3);
    assert.deepEqual(starts[2]!.authorizationAuthority, {
      organizationId: owner.membership.organizationId,
      workspaceId: owner.user.slackTeamId,
      membershipId: editor.membership.id,
      agentId: privateAgent.id,
      ownerKind: 'team',
    });
    const switchedAccounts = (await config.listConnectionAccounts(owner.user.slackTeamId))
      .filter(({ providerId }) => providerId === 'linear');
    assert.equal(switchedAccounts.filter(({ lifecycle }) => lifecycle === 'revoked').length, 0);
    assert.equal(switchedAccounts.filter(({ ownerKind, ownerMembershipId, lifecycle }) =>
      ownerKind === 'member' && ownerMembershipId === issuerPrincipal.membershipId &&
        lifecycle === 'pending'
    ).length, 1);
    assert.equal(switchedAccounts.filter(({ ownerKind, lifecycle }) =>
      ownerKind === 'team' && lifecycle === 'pending'
    ).length, 1);

    await t.test('a demoted Team catalog OAuth initiator cannot finish the callback', async () => {
      const teamPending = switchedAccounts.find(({ ownerKind, lifecycle }) =>
        ownerKind === 'team' && lifecycle === 'pending'
      )!;
      const before = {
        completeCalls,
        authorizationChecks,
        tokenCalls,
        discoverCalls,
        identifyCalls,
        settingWrites,
      };
      await identity.updateMembershipAuthority({
        membershipId: editor.membership.id,
        role: 'member',
        actorMembershipId: owner.membership.id,
        authenticationSurface: 'better_auth',
        correlationId: 'native_connector_editor_demoted',
        reasonCode: 'connector_editor_member',
      });
      // Keep the request principal stale to prove the durable OAuth authority
      // check observes the live membership role before provider exchange.
      const denied = await app.request(
        `http://localhost/setup/${privateSetupId}/oauth/mcp/callback?state=${states[2]}&code=linear-code`,
        { headers: { cookie: privateCookie } },
      );
      assert.equal(denied.status, 403, await denied.clone().text());
      assert.deepEqual(await denied.json(), { error: 'setup_unavailable' });
      assert.equal(completeCalls, before.completeCalls);
      assert.equal(authorizationChecks, before.authorizationChecks + 1);
      assert.equal(tokenCalls, before.tokenCalls);
      assert.equal(discoverCalls, before.discoverCalls);
      assert.equal(identifyCalls, before.identifyCalls);
      assert.equal(settingWrites, before.settingWrites);
      const after = (await config.listConnectionAccounts(owner.user.slackTeamId))
        .find(({ id }) => id === teamPending.id)!;
      assert.equal(after.lifecycle, 'pending');
      assert.equal(after.revision, teamPending.revision);
      assert.deepEqual(after.policy, teamPending.policy);
      assert.equal((await management.getSetup(privateSetupId))?.status, 'authorizing');
    });

    await t.test('Team catalog OAuth rechecks authority immediately before ready commit', async () => {
      await identity.updateMembershipAuthority({
        membershipId: editor.membership.id,
        role: 'admin',
        actorMembershipId: owner.membership.id,
        authenticationSurface: 'better_auth',
        correlationId: 'native_connector_editor_repromoted',
        reasonCode: 'connector_editor_admin',
      });
      const restarted = await authorize(app, privateSetupId, privateCookie, {
        ownerKind: 'team',
      });
      assert.equal(restarted.status, 200, await restarted.clone().text());
      assert.equal(starts.length, 4);
      const pendingBeforeCallback = (await config.listConnectionAccounts(owner.user.slackTeamId))
        .find(({ ownerKind, providerId, lifecycle }) =>
          ownerKind === 'team' && providerId === 'linear' && lifecycle === 'pending'
        )!;
      duringDiscovery = async () => {
        duringDiscovery = undefined;
        await identity.updateMembershipAuthority({
          membershipId: editor.membership.id,
          role: 'member',
          actorMembershipId: owner.membership.id,
          authenticationSurface: 'better_auth',
          correlationId: 'native_connector_editor_demoted_during_discovery',
          reasonCode: 'connector_editor_member',
        });
      };
      const settingWritesBeforeCallback = settingWrites;
      const denied = await app.request(
        `http://localhost/setup/${privateSetupId}/oauth/mcp/callback?state=${states[3]}&code=linear-code`,
        { headers: { cookie: privateCookie } },
      );
      assert.equal(denied.status, 403, await denied.clone().text());
      const pendingAfterCallback = (await config.listConnectionAccounts(owner.user.slackTeamId))
        .find(({ id }) => id === pendingBeforeCallback.id)!;
      assert.equal(pendingAfterCallback.lifecycle, 'pending');
      assert.equal(pendingAfterCallback.revision, pendingBeforeCallback.revision);
      assert.equal(settingWrites, settingWritesBeforeCallback + 1);
    });
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('catalog replacement requires management authority and rolls back failed writes', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: 'catalog-replacement' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');

  try {
    const agent = await config.createAgent({
      id: 'agent_catalog_replacement',
      name: 'Billing Guide',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'all_workspace_members',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Help the team manage billing.',
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
    const accountId = 'connection_existing_stripe';
    const secretRefId = 'secret_existing_stripe';
    await config.createAgentOwnedConnection({
      account: {
        id: accountId,
        workspaceId: owner.user.slackTeamId,
        ownerKind: 'team',
        createdByMembershipId: owner.membership.id,
        providerId: 'stripe',
        label: 'Stripe',
        identity: { workspaceName: 'Original Stripe', accountName: 'original@example.test' },
        policy: {
          kind: 'mcp',
          url: 'https://mcp.stripe.com/',
          transport: 'streamable-http',
          authMode: 'bearer',
          headerNames: [],
          discoveredTools: [{ name: 'original_tool' }],
          allowedTools: ['original_tool'],
          presetId: 'stripe',
        },
        secretRefId,
        lifecycle: 'ready',
      },
      binding: {
        agentId: agent.id,
        connectionAccountId: accountId,
        providerId: 'stripe',
        allowedCapabilities: ['original_tool'],
        enabled: true,
      },
    });
    await settings.setSetting(connectionAccountSecretSettingKey(secretRefId), 'original-token');

    const ownerPrincipal: AuthPrincipal = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      role: 'member',
      authenticatorKind: 'better_auth',
      credentialId: 'session_catalog_owner',
      correlationId: 'catalog_owner',
      machine: false,
    };
    const ownerAdminPrincipal: AuthPrincipal = {
      ...ownerPrincipal,
      role: 'admin',
    };
    const secondEditor: AuthPrincipal = {
      ...ownerPrincipal,
      userId: 'user_catalog_second_editor',
      membershipId: 'membership_catalog_second_editor',
      credentialId: 'session_catalog_second_editor',
      correlationId: 'catalog_second_editor',
    };
    let setupSequence = 0;
    let discoverCalls = 0;
    let identifyCalls = 0;
    const createSetup = async (label: string) => {
      const setupId = `setup_catalog_replace_${label}_${++setupSequence}`;
      await management.putSetup({
        record: {
          setupOperationId: setupId,
          organizationId: owner.membership.organizationId,
          actorUserId: owner.user.id,
          actorMembershipId: owner.membership.id,
          origin: {
            kind: 'slack',
            workspaceId: owner.user.slackTeamId,
            channelId: 'D_CATALOG_REPLACEMENT',
            threadTs: `1800200000.0004${setupSequence}`,
            agentId: agent.id,
          },
          action: 'catalog_connection',
          target: {
            kind: 'catalog_connection',
            provider: 'stripe',
            targetId: `agent:${agent.id}:catalog:stripe`,
            targetLabel: 'Stripe',
            expectedRevision: agent.revision,
            agentId: agent.id,
            agentName: agent.name,
            connectionId: accountId,
            replacement: true,
            ownerKind: 'team',
            presetId: 'stripe',
          },
          scopes: ['read', 'write'],
          tokenDigest: createHash('sha256').update(CAPABILITY).digest('base64url'),
          status: 'pending',
          expiresAt: NOW + 60_000,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      return setupId;
    };
    const createApp = (
      routeConfig: ConfigStore,
      principal: AuthPrincipal,
      routeSettings = settings,
    ) =>
      createManagementSetupRoutes({
        identity,
        config: routeConfig,
        management,
        settings: routeSettings,
        now: () => NOW,
        authenticatePrincipal: async () => principal,
        discoverMcp: async () => {
          discoverCalls += 1;
          return { tools: [{ name: 'replacement_tool' }] };
        },
        identifyMcp: async () => {
          identifyCalls += 1;
          return {
            workspaceName: 'Replacement Stripe',
            accountName: 'replacement@example.test',
          };
        },
        deliverReceipt: async () => ({
          deliveryRef: 'slack:D_CATALOG_REPLACEMENT:receipt.1',
        }),
      });
    const assertOriginalState = async () => {
      const account = (await config.listConnectionAccounts(owner.user.slackTeamId))
        .find(({ id }) => id === accountId)!;
      assert.equal(account.identity?.workspaceName, 'Original Stripe');
      assert.equal(account.identity?.accountName, 'original@example.test');
      assert.equal(account.policy.kind, 'mcp');
      assert.deepEqual(account.policy.kind === 'mcp' ? account.policy.allowedTools : [], [
        'original_tool',
      ]);
      assert.equal(account.lifecycle, 'ready');
      const binding = await config.getAgentConnectionBindingForAccount(accountId);
      assert.deepEqual(binding?.allowedCapabilities, ['original_tool']);
      assert.equal(binding?.enabled, true);
      assert.equal(
        await resolveConnectionAccountSecret({ secretRefId }, undefined, settings),
        'original-token',
      );
    };

    let deniedInventoryCalls = 0;
    let deniedAccountWrites = 0;
    let deniedBindingWrites = 0;
    let deniedSettingWrites = 0;
    const deniedConfig = new Proxy<ConfigStore>(config, {
      get(target, property, receiver) {
        if (property === 'listConnectionAccounts') {
          return async (...args: Parameters<ConfigStore['listConnectionAccounts']>) => {
            deniedInventoryCalls += 1;
            return config.listConnectionAccounts(...args);
          };
        }
        if (property === 'putConnectionAccount') {
          return async (...args: Parameters<ConfigStore['putConnectionAccount']>) => {
            deniedAccountWrites += 1;
            return config.putConnectionAccount(...args);
          };
        }
        if (property === 'putAgentConnectionBinding') {
          return async (...args: Parameters<ConfigStore['putAgentConnectionBinding']>) => {
            deniedBindingWrites += 1;
            return config.putAgentConnectionBinding(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const deniedSettings = new Proxy(settings, {
      get(target, property, receiver) {
        if (property === 'setSetting') {
          return async (...args: Parameters<SqliteSettingsStore['setSetting']>) => {
            deniedSettingWrites += 1;
            return settings.setSetting(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const unauthorizedSetupId = await createSetup('unauthorized');
    const unauthorizedApp = createApp(deniedConfig, secondEditor, deniedSettings);
    const unauthorizedExchange = await exchange(unauthorizedApp, unauthorizedSetupId);
    const unauthorizedCookie = unauthorizedExchange.headers.get('set-cookie')!.split(';')[0]!;
    const unauthorized = await authorize(
      unauthorizedApp,
      unauthorizedSetupId,
      unauthorizedCookie,
      { ownerKind: 'team', credential: 'unauthorized-token' },
    );
    assert.equal(unauthorized.status, 403, await unauthorized.clone().text());
    assert.deepEqual(await unauthorized.json(), { error: 'setup_unavailable' });
    assert.equal((await management.getSetup(unauthorizedSetupId))?.status, 'claimed');
    assert.equal(discoverCalls, 0);
    assert.equal(identifyCalls, 0);
    assert.equal(deniedInventoryCalls, 0);
    assert.equal(deniedAccountWrites, 0);
    assert.equal(deniedBindingWrites, 0);
    assert.equal(deniedSettingWrites, 0);
    await assertOriginalState();

    const demotedCreatorSetupId = await createSetup('demoted-creator');
    const demotedCreatorApp = createApp(deniedConfig, ownerPrincipal, deniedSettings);
    const demotedCreatorExchange = await exchange(demotedCreatorApp, demotedCreatorSetupId);
    const demotedCreatorCookie = demotedCreatorExchange.headers.get('set-cookie')!.split(';')[0]!;
    const demotedCreator = await authorize(
      demotedCreatorApp,
      demotedCreatorSetupId,
      demotedCreatorCookie,
      { ownerKind: 'team', credential: 'demoted-creator-token' },
    );
    assert.equal(demotedCreator.status, 403, await demotedCreator.clone().text());
    assert.deepEqual(await demotedCreator.json(), { error: 'setup_unavailable' });
    assert.equal((await management.getSetup(demotedCreatorSetupId))?.status, 'claimed');
    assert.equal(discoverCalls, 0);
    assert.equal(identifyCalls, 0);
    assert.equal(deniedInventoryCalls, 0);
    assert.equal(deniedAccountWrites, 0);
    assert.equal(deniedBindingWrites, 0);
    assert.equal(deniedSettingWrites, 0);
    await assertOriginalState();

    const personalSetupId = await createSetup('personal');
    const personalApp = createApp(config, secondEditor);
    const personalExchange = await exchange(personalApp, personalSetupId);
    const personalCookie = personalExchange.headers.get('set-cookie')!.split(';')[0]!;
    const personal = await authorize(personalApp, personalSetupId, personalCookie, {
      ownerKind: 'member',
      credential: 'personal-token',
    });
    // A reconnect link keeps its account's owner, so naming the other owner is refused.
    assert.equal(personal.status, 422, await personal.clone().text());
    assert.equal((await personal.json()).error, 'target_changed');
    assert.equal(discoverCalls, 0);
    await assertOriginalState();
    assert.deepEqual(
      (await config.listConnectionAccounts(owner.user.slackTeamId)).map(({ id }) => id),
      [accountId],
      'no personal account was minted',
    );

    for (const failurePoint of ['account', 'binding'] as const) {
      let failed = false;
      const failingConfig = new Proxy<ConfigStore>(config, {
        get(target, property, receiver) {
          if (property === 'putConnectionAccount') {
            return async (...args: Parameters<ConfigStore['putConnectionAccount']>) => {
              if (failurePoint === 'account' && !failed) {
                failed = true;
                throw new Error('injected_account_write_failure');
              }
              return config.putConnectionAccount(...args);
            };
          }
          if (property === 'putAgentConnectionBinding') {
            return async (...args: Parameters<ConfigStore['putAgentConnectionBinding']>) => {
              if (failurePoint === 'binding' && !failed) {
                failed = true;
                throw new Error('injected_binding_write_failure');
              }
              return config.putAgentConnectionBinding(...args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const setupId = await createSetup(failurePoint);
      const app = createApp(failingConfig, ownerAdminPrincipal);
      const exchanged = await exchange(app, setupId);
      const cookie = exchanged.headers.get('set-cookie')!.split(';')[0]!;
      const response = await authorize(app, setupId, cookie, {
        ownerKind: 'team',
        credential: `replacement-token-${failurePoint}`,
      });
      assert.equal(response.status, 422, await response.clone().text());
      assert.equal(failed, true);
      await assertOriginalState();
    }
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('a failed catalog replacement restores only the binding it wrote, so a later change stays', async () => {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent({
      id: 'agent_billing', name: 'Billing Guide', creatorMembershipId: 'membership_owner',
      editPolicy: 'all_workspace_members', lifecycle: 'active', configurationGeneration: 1,
      instructions: 'Help the team manage billing.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_REPLACE', transportMode: 'direct', defaultAgentId: 'agent_billing',
    });
    const policy = {
      kind: 'mcp' as const, url: 'https://mcp.stripe.com/', transport: 'streamable-http' as const,
      authMode: 'bearer' as const, headerNames: [], discoveredTools: [{ name: 'original_tool' }],
      allowedTools: ['original_tool'], presetId: 'stripe',
    };
    const { account, binding } = await config.createAgentOwnedConnection({
      account: {
        id: 'connection_stripe', workspaceId: 'T_REPLACE', ownerKind: 'team',
        createdByMembershipId: 'membership_owner', providerId: 'stripe', label: 'Stripe', policy,
        secretRefId: 'secret_stripe', lifecycle: 'ready',
      },
      binding: {
        agentId: 'agent_billing', connectionAccountId: 'connection_stripe', providerId: 'stripe',
        allowedCapabilities: ['original_tool'], enabled: true,
      },
    });
    let failed = false;
    const failingSettings = new Proxy(settings, {
      get(target, property, receiver) {
        if (property === 'setSetting' && !failed) {
          return async () => {
            failed = true;
            // Someone turns the connection off for the Agent after the replacement wrote its binding.
            const written = (await config.getAgentConnectionBindingForAccount(account.id))!;
            await config.putAgentConnectionBinding({ ...written, enabled: false });
            throw new Error('injected_secret_write_failure');
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(replaceCatalogConnection({
      config, settings: failingSettings, account, binding,
      prepared: {
        policy: { ...policy, discoveredTools: [{ name: 'replacement_tool' }], allowedTools: ['replacement_tool'] },
        credential: 'replacement-token',
        allowedCapabilities: ['replacement_tool'],
      },
    }), (error: unknown) => error instanceof AggregateError &&
      (error.errors[0] as Error).message === 'injected_secret_write_failure');
    const restored = (await config.listConnectionAccounts('T_REPLACE'))[0];
    assert.deepEqual(restored?.policy.kind === 'mcp' && restored.policy.allowedTools, ['original_tool']);
    assert.equal((await config.getAgentConnectionBindingForAccount(account.id))?.enabled, false,
      'the change made after the replacement wrote is not undone');
  } finally {
    config.close();
    settings.close();
  }
});

/** A team connection that needs attention on an Agent, and the reconnect links Slack gives for it. */
async function catalogReconnectHarness(input: {
  suffix: string;
  providerId: string;
  label: string;
  policy: ConnectionAccount['policy'];
  role: AuthPrincipal['role'];
}) {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: input.suffix });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const workspaceId = owner.user.slackTeamId;
  const agent = await config.createAgent({
    id: 'agent_reconnect',
    name: 'Billing Guide',
    creatorMembershipId: owner.membership.id,
    editPolicy: 'all_workspace_members',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Help the team manage billing.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await config.ensureWorkspaceInstallation({ workspaceId, transportMode: 'direct', defaultAgentId: agent.id });
  const accountId = `connection_reconnect_${input.providerId}`;
  const secretRefId = `secret_reconnect_${input.providerId}`;
  await config.createAgentOwnedConnection({
    account: {
      id: accountId,
      workspaceId,
      ownerKind: 'team',
      createdByMembershipId: owner.membership.id,
      providerId: input.providerId,
      label: input.label,
      policy: input.policy,
      secretRefId,
      lifecycle: 'needs_attention',
    },
    binding: {
      agentId: agent.id,
      connectionAccountId: accountId,
      providerId: input.providerId,
      allowedCapabilities: [],
      enabled: true,
    },
  });
  await settings.setSetting(connectionAccountSecretSettingKey(secretRefId), 'original-token');
  const principal: AuthPrincipal = {
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    role: input.role,
    authenticatorKind: 'better_auth',
    credentialId: 'session_reconnect',
    correlationId: 'catalog_reconnect',
    machine: false,
  };
  let discoverCalls = 0;
  const app = createManagementSetupRoutes({
    identity,
    config,
    management,
    settings,
    now: () => NOW,
    authenticatePrincipal: async () => principal,
    discoverMcp: async () => {
      discoverCalls += 1;
      return { tools: [{ name: 'replacement_tool' }] };
    },
    identifyMcp: async () => ({ workspaceName: 'Replacement', accountName: 'replacement@example.test' }),
    deliverReceipt: async () => ({ deliveryRef: 'slack:D_RECONNECT:receipt.1' }),
  });
  let sequence = 0;
  /** A reconnect link for the account, opened in a signed-in browser. */
  const openLink = async () => {
    const setupId = `setup_catalog_reconnect_${++sequence}`;
    await management.putSetup({
      record: {
        setupOperationId: setupId,
        organizationId: owner.membership.organizationId,
        actorUserId: owner.user.id,
        actorMembershipId: owner.membership.id,
        origin: {
          kind: 'slack',
          workspaceId,
          channelId: 'D_RECONNECT',
          threadTs: `1800200000.0006${sequence}`,
          agentId: agent.id,
        },
        action: 'catalog_connection',
        target: {
          kind: 'catalog_connection',
          provider: input.providerId,
          targetId: `agent:${agent.id}:catalog:${input.providerId}`,
          targetLabel: input.label,
          expectedRevision: agent.revision,
          agentId: agent.id,
          agentName: agent.name,
          connectionId: accountId,
          replacement: true,
          ownerKind: 'team',
          presetId: input.providerId,
        },
        scopes: ['read', 'write'],
        tokenDigest: createHash('sha256').update(CAPABILITY).digest('base64url'),
        status: 'pending',
        expiresAt: NOW + 60_000,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const cookie = (await exchange(app, setupId)).headers.get('set-cookie')!.split(';')[0]!;
    return { setupId, cookie };
  };
  return {
    identity, config, management, settings, workspaceId, accountId, secretRefId, app, openLink,
    discoverCalls: () => discoverCalls,
    close() {
      identity.close();
      config.close();
      management.close();
      settings.close();
    },
  };
}

test('a catalog reconnect link keeps its account\'s owner: the other owner is refused and nothing is disconnected', async () => {
  const h = await catalogReconnectHarness({
    suffix: 'catalog-reconnect-owner',
    providerId: 'stripe',
    label: 'Stripe',
    role: 'admin',
    policy: {
      kind: 'mcp',
      url: 'https://mcp.stripe.com/',
      transport: 'streamable-http',
      authMode: 'bearer',
      headerNames: [],
      discoveredTools: [{ name: 'original_tool' }],
      allowedTools: ['original_tool'],
      presetId: 'stripe',
    },
  });
  try {
    const refusedLink = await h.openLink();
    const refused = await authorize(h.app, refusedLink.setupId, refusedLink.cookie, {
      ownerKind: 'member',
      credential: 'personal-token',
    });
    assert.equal(refused.status, 422, await refused.clone().text());
    assert.equal((await refused.json()).error, 'target_changed');
    const accounts = await h.config.listConnectionAccounts(h.workspaceId);
    assert.deepEqual(accounts.map(({ id, lifecycle, ownerKind }) => ({ id, lifecycle, ownerKind })),
      [{ id: h.accountId, lifecycle: 'needs_attention', ownerKind: 'team' }],
      'the team account is untouched and no account was minted');
    assert.equal(await resolveConnectionAccountSecret({ secretRefId: h.secretRefId }, undefined, h.settings),
      'original-token');
    assert.equal((await h.config.getAgentConnectionBindingForAccount(h.accountId))?.enabled, true);
    assert.equal(h.discoverCalls(), 0, 'nothing was prepared for the refused owner');

    // The account's own owner still reconnects it in place.
    const link = await h.openLink();
    const reconnected = await authorize(h.app, link.setupId, link.cookie, {
      ownerKind: 'team',
      credential: 'replacement-token',
    });
    assert.equal(reconnected.status, 200, await reconnected.clone().text());
    assert.deepEqual(await reconnected.json(), { completed: true });
    const after = await h.config.listConnectionAccounts(h.workspaceId);
    assert.deepEqual(after.map(({ id, lifecycle }) => ({ id, lifecycle })),
      [{ id: h.accountId, lifecycle: 'ready' }], 'the same account is ready again; none was minted');
    assert.equal(await resolveConnectionAccountSecret({ secretRefId: h.secretRefId }, undefined, h.settings),
      'replacement-token');
  } finally {
    h.close();
  }
});

test('a Meta Ads reconnect link shows the access the account already has, locked', async () => {
  for (const [oauthScope, access] of [
    [META_ADS_OAUTH_MANAGEMENT_SCOPE, 'editing'],
    [META_ADS_OAUTH_DEFAULT_SCOPE, 'reporting'],
  ] as const) {
    const h = await catalogReconnectHarness({
      suffix: `meta-reconnect-${access}`,
      providerId: 'meta-ads',
      label: 'Meta Ads',
      role: 'admin',
      policy: {
        kind: 'mcp',
        url: 'https://mcp.facebook.com/ads',
        transport: 'streamable-http',
        authMode: 'oauth',
        headerNames: [],
        discoveredTools: [],
        allowedTools: [],
        toolAccessMode: 'review',
        oauthScope,
        presetId: 'meta-ads',
      },
    });
    try {
      const link = await h.openLink();
      const page = await h.app.request(`http://localhost/setup/${link.setupId}`, {
        headers: { cookie: link.cookie },
      });
      assert.equal(page.status, 200);
      const inputs = formInputs(await page.text());
      assert.deepEqual(inputs.filter(({ name }) => name === 'access'), [
        { type: 'radio', name: 'access', value: 'reporting', checked: access === 'reporting', disabled: true },
        { type: 'radio', name: 'access', value: 'editing', checked: access === 'editing', disabled: true },
        { type: 'hidden', name: 'access', value: access, checked: false, disabled: false },
      ], `${access}: the account's access, locked`);
      assert.deepEqual(inputs.filter(({ name }) => name === 'ownerKind').map(({ value, checked, disabled }) =>
        ({ value, checked, disabled })), [
        { value: 'member', checked: false, disabled: true },
        { value: 'team', checked: true, disabled: true },
        { value: 'team', checked: false, disabled: false },
      ]);
    } finally {
      h.close();
    }
  }
});

test('the managed connector link is reusable and completes from the dedicated page', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: 'connector-landing' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
    assert.match(setupHtml, /<input[^>]+type="hidden"[^>]+name="access"[^>]+value="write"/);
    assert.doesNotMatch(setupHtml, /<input[^>]+type="radio"[^>]+name="access"/);
    assert.match(setupHtml, /--chickpea-wordmark-image:url\("\/chickpea-wordmark-512\.png\?v=[a-f0-9]{12}"\)/);
    assert.match(setupHtml, new RegExp(`src="http://localhost/assets/agents/${agent.id}/avatar/1"`));

    writeReady = false;
    const readOnlySetupPage = await app.request(`http://localhost/setup/${setupId}`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(readOnlySetupPage.status, 200);
    assert.match(
      await readOnlySetupPage.text(),
      /<input[^>]+type="hidden"[^>]+name="access"[^>]+value="read"/,
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
      ownerKind: 'member',
      access: 'read',
    });
    assert.equal(memberAuthorize.status, 200, await memberAuthorize.clone().text());
    assert.equal(authorizeInputs.length, 2);
    assert.match(authorizeInputs[0]!.principalRef, /^chickpea:organization:/);
    assert.match(authorizeInputs[1]!.principalRef, /^chickpea:membership:/);
    assert.notEqual(authorizeInputs[0]!.principalRef, authorizeInputs[1]!.principalRef);
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
    assert.match(successHtml, /Your team connection is ready/);
    assert.match(successHtml, /You can close this tab now/);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

async function managedReconnectHarness(
  suffix: string,
  allowedCapabilities: string[],
  connection: { toolkit: string; connector: string; lifecycle: 'ready' | 'needs_attention' } =
    { toolkit: 'hubspot', connector: 'HubSpot', lifecycle: 'needs_attention' },
) {
  const { toolkit, connector } = connection;
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const authorized: string[][] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async authorize(input) {
      authorized.push([...input.allowedCapabilities]);
      return {
        authorizationUrl: new URL('https://backend.composio.dev/link/reconnect'),
        authorizationRef: `authorization_${toolkit}_reconnect`,
      };
    },
    async pollAuthorization(input) {
      return { status: 'active', accountRef: input.authorizationRef, toolkit };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const principal: AuthPrincipal = {
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    role: owner.membership.role,
    authenticatorKind: 'better_auth',
    credentialId: 'session_owner',
    correlationId: 'managed_reconnect',
    machine: false,
  };
  const agent = await config.createAgent({
    id: 'agent_sales', name: 'Sales', creatorMembershipId: owner.membership.id,
    editPolicy: 'creator_and_admins', lifecycle: 'active', configurationGeneration: 1,
    instructions: 'Help sales.', enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  await config.ensureWorkspaceInstallation({
    workspaceId: owner.user.slackTeamId, transportMode: 'direct', defaultAgentId: agent.id,
  });
  const account = await config.putConnectionAccount({
    id: `connection_${toolkit}_team`,
    workspaceId: owner.user.slackTeamId,
    ownerKind: 'team',
    createdByMembershipId: owner.membership.id,
    providerId: toolkit,
    label: `${connector} · Team`,
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit,
      principalRef: managedPrincipalRef(principal, 'team', undefined)!,
      accountRef: `account_${toolkit}_before`,
      allowedCapabilities,
    },
    secretRefId: `secret_${toolkit}_team`,
    lifecycle: connection.lifecycle,
  });
  const binding = await config.putAgentConnectionBinding({
    agentId: agent.id,
    connectionAccountId: account.id,
    providerId: account.providerId,
    allowedCapabilities,
    enabled: true,
  });
  const service = new WorkspaceManagementService({
    identity, config, management, setupBaseUrl: 'http://localhost', now: () => NOW,
    randomId: () => 'managed_reconnect', randomCapability: () => CAPABILITY,
  });
  const prepared = await service.prepareConnectorSetup({
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    origin: {
      kind: 'slack', workspaceId: owner.user.slackTeamId, channelId: 'D_SALES',
      threadTs: '1800200000.000200', agentId: agent.id,
    },
  }, { agentId: agent.id, connector, ownerKind: 'team' });
  const setupId = new URL(prepared.handoffUrl).pathname.split('/').at(-1)!;
  const app = createManagementSetupRoutes({
    identity, config, management, settings, now: () => NOW,
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
    authenticatePrincipal: async () => principal,
    deliverReceipt: async () => ({ deliveryRef: 'slack:D_SALES:receipt.1' }),
  });
  return {
    identity, config, management, settings, owner, agent, account, binding, authorized, app, setupId,
    close() {
      identity.close();
      config.close();
      management.close();
      settings.close();
    },
  };
}

test('a Slack reconnect link re-authorizes a managed connection that needs attention in place', async () => {
  const h = await managedReconnectHarness('managed-reconnect', ['hubspot.contacts.search']);
  try {
    const cookie = (await exchange(h.app, h.setupId)).headers.get('set-cookie')!.split(';')[0]!;
    const started = await authorize(h.app, h.setupId, cookie, { ownerKind: 'team', access: 'read' });
    assert.equal(started.status, 200, await started.clone().text());
    assert.deepEqual(h.authorized, [['hubspot.contacts.search']], 'the reconnect keeps the account\'s capabilities');
    const poll = await h.app.request(`http://localhost/setup/${h.setupId}/managed/poll`, {
      method: 'POST',
      headers: { origin: 'http://localhost', cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(poll.status, 200, await poll.clone().text());

    const accounts = await h.config.listConnectionAccounts(h.owner.user.slackTeamId);
    assert.deepEqual(accounts.map(({ id, lifecycle }) => ({ id, lifecycle })),
      [{ id: h.account.id, lifecycle: 'ready' }], 'the same account is ready again; none was minted');
    assert.equal(accounts[0]!.policy.kind === 'managed' ? accounts[0]!.policy.accountRef : undefined,
      'authorization_hubspot_reconnect');
    assert.deepEqual(await h.config.listAgentConnectionBindings(h.agent.id), [h.binding], 'the Agent binding is unchanged');
    assert.equal((await h.management.getSetup(h.setupId))?.connectionAccountId, h.account.id);
  } finally {
    h.close();
  }
});

test('a Slack link for a ready Notion connection changes its pages on the same connection', async () => {
  const h = await managedReconnectHarness('notion-pages', ['notion.content.search'],
    { toolkit: 'notion', connector: 'Notion', lifecycle: 'ready' });
  try {
    const cookie = (await exchange(h.app, h.setupId)).headers.get('set-cookie')!.split(';')[0]!;
    const page = await h.app.request(`http://localhost/setup/${h.setupId}`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<h1 id="flow-title">Change which Notion pages Sales can use<\/h1>/);
    assert.match(html,
      /Notion shows the pages Sales can use now\. Check pages to add them or uncheck pages to remove them\./);

    const started = await authorize(h.app, h.setupId, cookie, { ownerKind: 'team', access: 'read' });
    assert.equal(started.status, 200, await started.clone().text());
    const poll = await h.app.request(`http://localhost/setup/${h.setupId}/managed/poll`, {
      method: 'POST',
      headers: { origin: 'http://localhost', cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(poll.status, 200, await poll.clone().text());

    const accounts = await h.config.listConnectionAccounts(h.owner.user.slackTeamId);
    assert.deepEqual(accounts.map(({ id, lifecycle }) => ({ id, lifecycle })),
      [{ id: h.account.id, lifecycle: 'ready' }], 'the same connection, and no new one');
    assert.equal(accounts[0]!.policy.kind === 'managed' ? accounts[0]!.policy.accountRef : undefined,
      'authorization_notion_reconnect');
    assert.deepEqual(await h.config.listAgentConnectionBindings(h.agent.id), [h.binding]);
  } finally {
    h.close();
  }
});

test('a managed reconnect link shows its account\'s owner and access, locked', async () => {
  for (const [capabilities, access] of [
    [['hubspot.contacts.search'], 'read'],
    [['hubspot.contacts.create'], 'write'],
  ] as const) {
    const h = await managedReconnectHarness(`managed-reconnect-lock-${access}`, [...capabilities]);
    try {
      const cookie = (await exchange(h.app, h.setupId)).headers.get('set-cookie')!.split(';')[0]!;
      const page = await h.app.request(`http://localhost/setup/${h.setupId}`, { headers: { cookie } });
      assert.equal(page.status, 200);
      const inputs = formInputs(await page.text());
      assert.deepEqual(inputs.filter(({ name }) => name === 'ownerKind'), [
        { type: 'radio', name: 'ownerKind', value: 'member', checked: false, disabled: true },
        { type: 'radio', name: 'ownerKind', value: 'team', checked: true, disabled: true },
        { type: 'hidden', name: 'ownerKind', value: 'team', checked: false, disabled: false },
      ], `${access}: the owner is the account's and cannot be changed`);
      assert.deepEqual(inputs.filter(({ name }) => name === 'access'), [
        { type: 'hidden', name: 'access', value: access, checked: false, disabled: false },
      ], `${access}: the access is the account's`);
    } finally {
      h.close();
    }
  }
});

test('a managed reconnect link refuses a post that names another owner or access', async () => {
  for (const [capabilities, access, other] of [
    [['hubspot.contacts.search'], 'read', 'write'],
    [['hubspot.contacts.create'], 'write', 'read'],
  ] as const) {
    const h = await managedReconnectHarness(`managed-reconnect-refuse-${access}`, [...capabilities]);
    try {
      const cookie = (await exchange(h.app, h.setupId)).headers.get('set-cookie')!.split(';')[0]!;
      for (const fields of [{ ownerKind: 'member', access }, { ownerKind: 'team', access: other }]) {
        const refused = await authorize(h.app, h.setupId, cookie, fields);
        assert.equal(refused.status, 422, `${access}: ${JSON.stringify(fields)} ${await refused.clone().text()}`);
      }
      assert.deepEqual(h.authorized, [], `${access}: no sign-in started for a mismatched post`);
      assert.equal((await h.config.listConnectionAccounts(h.owner.user.slackTeamId))[0]?.lifecycle, 'needs_attention');

      const accepted = await authorize(h.app, h.setupId, cookie, { ownerKind: 'team', access });
      assert.equal(accepted.status, 200, `${access}: ${await accepted.clone().text()}`);
      assert.deepEqual(h.authorized, [[...capabilities]], `${access}: the link still works for the account's own values`);
    } finally {
      h.close();
    }
  }
});

/**
 * A Slack setup link for a new Notion connection on one Agent, while a team
 * Notion connection on another Agent was created by `teamCreator` for
 * `teamPerson`. Every sign-in names `signInPerson`.
 */
async function notionMixSetupHarness(suffix: string, input: {
  teamCreator: 'owner' | 'teammate';
  teamPerson: string;
  signInPerson: string;
}) {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const authorized: string[] = [];
  const cleaned: string[] = [];
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async authorize() {
      authorized.push(`ca_notion_${authorized.length + 1}`);
      return {
        authorizationUrl: new URL(`https://backend.composio.dev/link/${authorized.length}`),
        authorizationRef: authorized.at(-1)!,
      };
    },
    async pollAuthorization(poll) {
      return { status: 'active', accountRef: poll.authorizationRef, toolkit: 'notion' };
    },
    async validate() { return { person: input.signInPerson }; },
    async execute() { return { data: {} }; },
    async revoke() {},
    async cleanupRemoteAccount({ accountRef }) { cleaned.push(accountRef); },
  };
  const principal: AuthPrincipal = {
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    role: owner.membership.role,
    authenticatorKind: 'better_auth',
    credentialId: 'session_owner',
    correlationId: 'notion_mix',
    machine: false,
  };
  const agent = (id: string, name: string) => config.createAgent({
    id, name, creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
    lifecycle: 'active', configurationGeneration: 1, instructions: 'Use Notion.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const target = await agent('agent_notes', 'Notes');
  const other = await agent('agent_wiki', 'Wiki');
  await config.ensureWorkspaceInstallation({
    workspaceId: owner.user.slackTeamId, transportMode: 'direct', defaultAgentId: target.id,
  });
  await config.createAgentOwnedConnection({
    account: {
      id: 'connection_notion_team', workspaceId: owner.user.slackTeamId, ownerKind: 'team',
      createdByMembershipId: input.teamCreator === 'owner' ? owner.membership.id : 'membership_teammate',
      providerId: 'notion', label: 'Notion · Team', secretRefId: 'secret_notion_team', lifecycle: 'ready',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'notion',
        principalRef: managedPrincipalRef(principal, 'team', undefined)!, accountRef: 'ca_notion_team',
        allowedCapabilities: ['notion.content.search'],
        signIn: { person: input.teamPerson, accessLane: 'read' },
      },
    },
    binding: {
      agentId: other.id, connectionAccountId: 'connection_notion_team', providerId: 'notion',
      allowedCapabilities: ['notion.content.search'], enabled: true,
    },
  });
  const service = new WorkspaceManagementService({
    identity, config, management, setupBaseUrl: 'http://localhost', now: () => NOW,
    randomId: () => 'notion_mix', randomCapability: () => CAPABILITY,
  });
  const prepared = await service.prepareConnectorSetup({
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    origin: {
      kind: 'slack', workspaceId: owner.user.slackTeamId, channelId: 'D_NOTES',
      threadTs: '1800200000.000300', agentId: target.id,
    },
  }, { agentId: target.id, connector: 'Notion', ownerKind: 'member' });
  const setupId = new URL(prepared.handoffUrl).pathname.split('/').at(-1)!;
  const app = createManagementSetupRoutes({
    identity, config, management, settings, now: () => NOW,
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
    authenticatePrincipal: async () => principal,
    deliverReceipt: async () => ({ deliveryRef: 'slack:D_NOTES:receipt.1' }),
  });
  const cookie = (await exchange(app, setupId)).headers.get('set-cookie')!.split(';')[0]!;
  /** Requests a page's script sends, with the browser's own cookie and origin, and what came back. */
  const responses: Array<{ path: string; status: number; body: unknown }> = [];
  const browserFetch = async (path: string, init: RequestInit = {}) => {
    const response = await app.request(`http://localhost${path}`, {
      ...init,
      headers: { ...init.headers as Record<string, string>, origin: 'http://localhost', cookie },
    });
    responses.push({ path, status: response.status, body: await response.clone().json().catch(() => undefined) });
    return response;
  };
  return {
    app, config, management, owner, setupId, cookie, authorized, cleaned, responses,
    /** Open the setup page and run its script on controls built from the page's own markup. */
    async setupPage() {
      const html = await (await app.request(`http://localhost/setup/${setupId}`, { headers: { cookie } })).text();
      const inputs = formInputs(html).map((control) => ({
        ...control,
        listeners: [] as Array<() => void>,
        addEventListener(_type: string, listener: () => void) { this.listeners.push(listener); },
      }));
      const paragraph = (id: string) => {
        const match = new RegExp(`<p class="[^"]*" id="${id}" role="[a-z]+"( hidden)?>([^<]*)</p>`).exec(html);
        assert.ok(match, `the page has #${id}`);
        return { hidden: match[1] !== undefined, textContent: match[2]! };
      };
      const notice = paragraph('sign-in-notice');
      const alert = paragraph('flow-alert');
      const buttonMatch = /<button class="primary-button"[^>]*?data-label="([^"]*)" data-different-label="([^"]*)" disabled>([^<]*)<\/button>/
        .exec(html);
      assert.ok(buttonMatch, 'the page has its Continue button');
      const labels: Record<string, string> = { 'data-label': buttonMatch[1]!, 'data-different-label': buttonMatch[2]! };
      const button = { disabled: true, textContent: buttonMatch[3]!, getAttribute: (name: string) => labels[name] };
      const radios = inputs.filter(({ type, name }) => type === 'radio' && name === 'ownerKind');
      const submitListeners: Array<(event: { preventDefault(): void }) => Promise<void>> = [];
      const form = {
        action: `/setup/${setupId}/authorize`,
        querySelectorAll: (selector: string) => selector === 'input[name="ownerKind"]' ? radios : [],
        querySelector: (selector: string) =>
          selector === 'input[name="ownerKind"]:checked' ? radios.find(({ checked }) => checked) ?? null
            : selector === 'input[name="differentAccount"]' ? inputs.find(({ name }) => name === 'differentAccount') ?? null
              : null,
        addEventListener: (_type: string, listener: (typeof submitListeners)[number]) => { submitListeners.push(listener); },
      };
      const assigned: string[] = [];
      runInNewContext(pageScript(html), {
        document: {
          getElementById: (id: string) => ({ 'connector-form': form, 'flow-alert': alert, 'sign-in-notice': notice })[id] ?? null,
          querySelector: (selector: string) =>
            selector === 'button[form="connector-form"][value="authorize"]' ? button : null,
        },
        fetch: browserFetch,
        FormData: function FormData() {
          return inputs.filter(({ name, disabled, type, checked }) => name && !disabled && (type !== 'radio' || checked))
            .map(({ name, value }) => [name, value]);
        },
        URLSearchParams,
        URL,
        location: { assign: (href: string) => { assigned.push(href); } },
      });
      return {
        inputs, notice, alert, button, assigned,
        chooseOwner(ownerKind: 'member' | 'team') {
          for (const radio of radios) radio.checked = radio.value === ownerKind;
          radios.find(({ value }) => value === ownerKind)!.listeners.forEach((listener) => listener());
        },
        submit: () => submitListeners[0]!({ preventDefault() {} }),
      };
    },
    /** Open the page the provider returns to and let its script poll until it stops. */
    async waitingPageStatus(): Promise<string> {
      const html = await (await app.request(`http://localhost/setup/${setupId}?poll=1`, {
        headers: { cookie },
      })).text();
      const status = { textContent: '' };
      const timers: Array<() => Promise<void>> = [];
      runInNewContext(pageScript(html), {
        document: { getElementById: (id: string) => id === 'poll-status' ? status : null },
        fetch: browserFetch,
        setTimeout: (callback: () => Promise<void>) => { timers.push(callback); },
        location: { pathname: `/setup/${setupId}`, replace() {} },
      });
      for (let timer = timers.shift(); timer; timer = timers.shift()) await timer();
      return status.textContent;
    },
    close() {
      identity.close();
      config.close();
      management.close();
      settings.close();
    },
  };
}

test('a Slack Notion link refuses a sign-in whose Notion person already backs a team connection', async () => {
  const h = await notionMixSetupHarness('notion-mix-refused', {
    teamCreator: 'teammate', teamPerson: 'notion:ws-1:user-maya', signInPerson: 'notion:ws-1:user-maya',
  });
  try {
    const started = await authorize(h.app, h.setupId, h.cookie, { ownerKind: 'member', access: 'read' });
    assert.equal(started.status, 200, await started.clone().text());

    const refusal = signInMixRefusal(MANAGED_CONNECTOR_CATALOG.connector('notion')!, 'team', { samePerson: true, manageable: true });
    assert.equal(await h.waitingPageStatus(), refusal, 'the page the provider returns to shows the refusal');
    assert.deepEqual(h.responses.map(({ status, body }) => ({ status, body })), [{
      status: 409, body: { error: 'managed_sign_in_mix_refused', message: refusal },
    }]);
    assert.deepEqual(h.cleaned, ['ca_notion_1'], 'the new connected account is removed');
    assert.deepEqual((await h.config.listConnectionAccounts(h.owner.user.slackTeamId)).map(({ id }) => id),
      ['connection_notion_team'], 'nothing is saved');
    assert.equal((await h.management.getSetup(h.setupId))?.status, 'pending', 'the link still works for another account');
  } finally {
    h.close();
  }
});

test('a Slack Notion link stops before Notion opens for the team connection\'s creator until they choose a different account', async () => {
  const h = await notionMixSetupHarness('notion-mix-notice', {
    teamCreator: 'owner', teamPerson: 'notion:ws-1:user-maya', signInPerson: 'notion:ws-1:user-ravi',
  });
  try {
    const stopped = await authorize(h.app, h.setupId, h.cookie, { ownerKind: 'member', access: 'read' });
    assert.equal(stopped.status, 409);
    assert.deepEqual(await stopped.json(), {
      error: 'managed_sign_in_other_kind',
      message: signInOtherKindNotice(MANAGED_CONNECTOR_CATALOG.connector('notion')!, 'team'),
    });
    assert.deepEqual(h.authorized, [], 'Composio is never asked for a sign-in link');
    assert.equal((await h.management.getSetup(h.setupId))?.status, 'pending');

    const continued = await authorize(h.app, h.setupId, h.cookie, {
      ownerKind: 'member', access: 'read', differentAccount: '1',
    });
    assert.equal(continued.status, 200, await continued.clone().text());
    assert.deepEqual(h.authorized, ['ca_notion_1']);
  } finally {
    h.close();
  }
});

test('the Slack Notion setup page shows the notice with Cancel and a different-account Continue', async () => {
  const h = await notionMixSetupHarness('notion-mix-page', {
    teamCreator: 'owner', teamPerson: 'notion:ws-1:user-maya', signInPerson: 'notion:ws-1:user-ravi',
  });
  try {
    const notice = signInOtherKindNotice(MANAGED_CONNECTOR_CATALOG.connector('notion')!, 'team');
    const page = await h.setupPage();
    assert.equal(page.notice.hidden, true);
    assert.equal(page.button.textContent, 'Continue to Notion');

    page.chooseOwner('member');
    await page.submit();
    assert.equal(page.notice.hidden, false, 'the notice shows');
    assert.equal(page.notice.textContent, notice);
    assert.equal(page.alert.hidden, true, 'the notice is not shown as a failure');
    assert.equal(page.button.textContent, 'Continue with a different Notion account');
    assert.equal(page.button.disabled, false);
    assert.deepEqual(h.authorized, []);

    page.chooseOwner('team');
    assert.equal(page.notice.hidden, true, 'choosing the other owner clears the notice');
    assert.equal(page.button.textContent, 'Continue to Notion');
    page.chooseOwner('member');
    await page.submit();
    assert.equal(page.notice.hidden, false);

    await page.submit();
    assert.deepEqual(page.assigned, ['https://backend.composio.dev/link/1'], 'Notion opens');
    assert.deepEqual(h.responses.map(({ status }) => status), [409, 409, 200]);
  } finally {
    h.close();
  }
});

test('the Slack Notion setup page renders the notice itself for a plain form post', async () => {
  const h = await notionMixSetupHarness('notion-mix-form', {
    teamCreator: 'owner', teamPerson: 'notion:ws-1:user-maya', signInPerson: 'notion:ws-1:user-ravi',
  });
  try {
    const response = await h.app.request(`http://localhost/setup/${h.setupId}/authorize`, {
      method: 'POST',
      headers: { origin: 'http://localhost', cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ownerKind=member&access=read',
    });
    assert.equal(response.status, 409);
    const html = await response.text();
    const notice = signInOtherKindNotice(MANAGED_CONNECTOR_CATALOG.connector('notion')!, 'team');
    assert.ok(html.includes(`<p class="flow-notice" id="sign-in-notice" role="status">${escapeHtml(notice)}</p>`));
    assert.deepEqual(formInputs(html).filter(({ name }) => name === 'ownerKind' || name === 'differentAccount'), [
      { type: 'radio', name: 'ownerKind', value: 'member', checked: true, disabled: false },
      { type: 'radio', name: 'ownerKind', value: 'team', checked: false, disabled: false },
      { type: 'hidden', name: 'differentAccount', value: '1', checked: false, disabled: false },
    ], 'the chosen owner stays chosen and continuing asks for a different account');
    assert.match(html, />Continue with a different Notion account<\/button>/);
    assert.match(html, /action="\/setup\/[^"]+\/cancel"><button class="text-button" type="submit">Cancel<\/button>/);
    assert.deepEqual(h.authorized, []);
  } finally {
    h.close();
  }
});

function pageScript(html: string): string {
  const script = /<script nonce="setup">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'the page has its setup script');
  return script;
}

/** The form controls a page renders, as attributes. */
function formInputs(html: string) {
  return [...html.matchAll(/<input\b([^>]*)>/g)].map(([, attributes = '']) => {
    const attribute = (name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];
    return {
      type: attribute('type'),
      name: attribute('name'),
      value: attribute('value'),
      checked: /(?:^|\s)checked(?:\s|$|=)/.test(attributes),
      disabled: /(?:^|\s)disabled(?:\s|$|=)/.test(attributes),
    };
  });
}

test('BugSnag Slack setup stays pending through OAuth until reviewed tool access is saved', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: 'bugsnag-landing' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const agent = await config.createAgent({ id: 'agent_bugsnag', name: 'Error Guide', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', lifecycle: 'active', configurationGeneration: 1,
      instructions: 'Investigate errors.', enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [] });
    await config.ensureWorkspaceInstallation({ workspaceId: owner.user.slackTeamId, transportMode: 'direct', defaultAgentId: agent.id });
    const setupId = 'setup_bugsnag';
    await management.putSetup({ record: {
      setupOperationId: setupId, organizationId: owner.membership.organizationId,
      actorUserId: owner.user.id, actorMembershipId: owner.membership.id,
      origin: { kind: 'slack', workspaceId: owner.user.slackTeamId, channelId: 'D_BUGSNAG', threadTs: '1800200000.000200', agentId: agent.id },
      action: 'catalog_connection', target: { kind: 'catalog_connection', provider: 'bugsnag', targetId: `agent:${agent.id}:catalog:bugsnag`,
        targetLabel: 'BugSnag', expectedRevision: agent.revision, agentId: agent.id, agentName: agent.name,
        connectionId: 'connection_bugsnag', replacement: false, ownerKind: 'member', presetId: 'bugsnag' },
      scopes: [], tokenDigest: createHash('sha256').update(CAPABILITY).digest('base64url'), status: 'pending',
      expiresAt: NOW + 60_000, createdAt: NOW, updatedAt: NOW,
    } });
    const principal: AuthPrincipal = { userId: owner.user.id, membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId, role: 'owner', authenticatorKind: 'better_auth',
      credentialId: 'session_bugsnag', correlationId: 'bugsnag_owner', machine: false };
    let started: StartMcpOAuthInput;
    let state = '';
    const discoveredTools = ['bugsnag_get_error', 'bugsnag_update_error'].map((name) => ({ name,
      readOnlyHint: name === 'bugsnag_get_error', inputSchema: {
        propertyNames: ['projectId', 'errorId', 'operation'], accountFields: [], ambiguous: false, fingerprint: 'a'.repeat(64),
      },
    }));
    const app = createManagementSetupRoutes({ identity, config, management, settings, now: () => NOW,
      authenticatePrincipal: async () => principal,
      startMcpOAuth: async (input) => {
        started = input;
        state = mcpOAuthState(input.ref, 'bugsnag_nonce');
        return { authorizationUrl: new URL('https://oauth.bugsnag.com/authorize'), state };
      },
      completeMcpOAuth: async () => ({ ref: started.ref, accountRevision: started.accountRevision!,
        oauthAttemptId: started.oauthAttemptId!, authorizationAuthority: started.authorizationAuthority!, returnAgentId: agent.id }),
      resolveMcpOAuthToken: async () => 'test-bugsnag-token',
      discoverMcp: async () => ({ tools: discoveredTools }),
      identifyMcp: async () => undefined,
      deliverReceipt: async () => ({ deliveryRef: 'slack:D_BUGSNAG:receipt.1' }),
    });
    const exchanged = await exchange(app, setupId);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const cookie = exchanged.headers.get('set-cookie')!.split(';')[0]!;
    const startedResponse = await authorize(app, setupId, cookie, { ownerKind: 'member' });
    assert.equal(startedResponse.status, 200, await startedResponse.clone().text());
    assert.equal(started!.scope, 'api');
    const callback = await app.request(`http://localhost/setup/${setupId}/oauth/mcp/callback?state=${state}&code=bugsnag-code`, { headers: { cookie } });
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal((await management.getSetup(setupId))?.status, 'authorizing');
    const connected = (await config.listConnectionAccounts(owner.user.slackTeamId))[0]!;
    assert.equal(connected.policy.kind, 'mcp');
    if (connected.policy.kind !== 'mcp') throw new Error('expected MCP');
    assert.deepEqual(connected.policy.allowedTools, []);
    const review = await app.request(`http://localhost/setup/${setupId}`, { headers: { cookie } });
    const html = await review.text();
    assert.match(html, /name="tool:bugsnag_get_error" checked/);
    assert.doesNotMatch(html, /name="tool:bugsnag_update_error" checked|<textarea/);
    const save = (fields: Record<string, string>) => app.request(`http://localhost/setup/${setupId}/mcp/access`, {
      method: 'POST', headers: { origin: 'http://localhost', cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    assert.equal((await save({ 'tool:invented': 'on' })).status, 422);
    const saved = await save({ 'tool:bugsnag_get_error': 'on', 'tool:bugsnag_update_error': 'on' });
    assert.equal(saved.status, 303, await saved.clone().text());
    assert.equal((await management.getSetup(setupId))?.status, 'completed');
    const selected = (await config.listConnectionAccounts(owner.user.slackTeamId))[0]!;
    if (selected.policy.kind !== 'mcp') throw new Error('expected MCP');
    assert.deepEqual(selected.policy.allowedTools, ['bugsnag_get_error', 'bugsnag_update_error']);
    assert.equal(selected.policy.toolPolicies?.bugsnag_update_error?.effect, 'write');
    assert.equal(selected.policy.toolPolicies?.bugsnag_update_error?.argumentConstraints?.operation?.includes('override_severity'), false);
  } finally { identity.close(); config.close(); management.close(); settings.close(); }
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
