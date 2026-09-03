import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  connectionAccountSecretSettingKey,
  resolveConnectionAccountSecret,
} from '../src/config/connector-secrets.ts';
import type { OAuthAuthorizationAuthority } from '../src/config/oauth-authorization.ts';
import { McpOAuthError } from '../src/config/mcp-oauth.ts';
import { SqliteConfigStore, type ConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
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
      expiresAt: NOW + 60_000,
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
    assert.match(setupHtml, /<option value="" selected disabled>Choose Personal or Team<\/option>/);
    assert.match(setupHtml, /<option value="member">My connection<\/option>/);
    assert.match(setupHtml, /<option value="team">Team connection<\/option>/);
    assert.doesNotMatch(setupHtml, /<option value="(?:member|team)" selected/);
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
  const config = new SqliteConfigStore(':memory:', { agents: [] });
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
    assert.equal(personal.status, 200, await personal.clone().text());
    assert.deepEqual(await personal.json(), { completed: true });
    await assertOriginalState();
    const personalAccount = (await config.listConnectionAccounts(owner.user.slackTeamId))
      .find(({ ownerKind, ownerMembershipId }) =>
        ownerKind === 'member' && ownerMembershipId === secondEditor.membershipId
      );
    assert.ok(personalAccount);
    assert.notEqual(personalAccount.id, accountId);
    assert.equal(personalAccount.lifecycle, 'ready');
    assert.equal(
      await resolveConnectionAccountSecret(
        { secretRefId: personalAccount.secretRefId },
        undefined,
        settings,
      ),
      'personal-token',
    );
    assert.equal(
      (await config.getAgentConnectionBindingForAccount(personalAccount.id))?.agentId,
      agent.id,
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
