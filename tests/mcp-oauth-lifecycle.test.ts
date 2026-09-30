import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionAccountOAuthRef } from '../src/config/api-oauth.ts';
import { mcpOAuthSettingKeys, resolveMcpOAuthAccessToken } from '../src/config/mcp-oauth.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { mcpOAuthLifecycleDependencies } from '../src/connections/mcp-oauth-lifecycle.ts';
import {
  projectTeamConnectionsNeedingReconnect,
  resolveConnectionAccountContext,
  resolveEffectiveConnectionAccounts,
} from '../src/connections/runtime.ts';

const SERVER_URL = 'https://mcp.example.test/mcp';
const TOKEN_ENDPOINT = 'https://auth.example.test/token';

function tokenBundle(accessToken: string, obtainedAt: number, expiresIn: number): string {
  return JSON.stringify({
    serverUrl: SERVER_URL,
    authorizationServerUrl: 'https://auth.example.test',
    metadata: {
      issuer: 'https://auth.example.test',
      authorization_endpoint: 'https://auth.example.test/authorize',
      token_endpoint: TOKEN_ENDPOINT,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    },
    resource: SERVER_URL,
    clientInformation: { client_id: 'registered-client' },
    tokens: { access_token: accessToken, token_type: 'Bearer', refresh_token: 'refresh-old', expires_in: expiresIn },
    obtainedAt,
  });
}

async function fixture() {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const agentId = 'agent_triage';
  const workspaceId = 'T_MCP';
  const actorMembershipId = 'member_owner';
  await config.createAgent({
    id: agentId, name: 'Support', instructions: 'Triage', enabled: true,
    creatorMembershipId: actorMembershipId, editPolicy: 'creator_and_admins',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  await config.ensureWorkspaceInstallation({ workspaceId, transportMode: 'direct', defaultAgentId: agentId });
  const account = await config.putConnectionAccount({
    id: 'connection_errors', workspaceId, ownerKind: 'team',
    createdByMembershipId: actorMembershipId,
    providerId: 'bugsnag', label: 'BugSnag', lifecycle: 'ready', secretRefId: 'secret_errors',
    policy: {
      kind: 'mcp', url: SERVER_URL, transport: 'streamable-http', authMode: 'oauth',
      headerNames: [], discoveredTools: [{ name: 'list_errors' }], allowedTools: ['list_errors'],
      oauthAttemptId: '6f1c1f5e-7a55-4c55-9a4c-3f1f2d8b9e10',
    },
  }, 0);
  await config.putAgentConnectionBinding({
    agentId, connectionAccountId: account.id, providerId: 'bugsnag',
    allowedCapabilities: ['list_errors'], enabled: true,
  });
  for (const [scheduleId, requiredConnectionAccountIds] of [
    ['schedule_triage', [account.id]], ['schedule_digest', []],
  ] as const) {
    await config.putAgentScheduleReference({
      scheduleId, agentId, workspaceId, channelId: 'C_MCP',
      createdByMembershipId: actorMembershipId, runsAsMembershipId: actorMembershipId,
      authorityReceiptId: `authority_${scheduleId}`,
      requiredConnectionAccountIds: [...requiredConnectionAccountIds], state: 'active',
    });
  }
  const ref = connectionAccountOAuthRef(account.id);
  const tokenKey = mcpOAuthSettingKeys(ref)[2];
  let now = 1_000_000;
  const oldToken = tokenBundle('access-old', now - 3_600_000, 3_600);
  await settings.setSetting(tokenKey, oldToken);
  const dependencies = {
    settings,
    now: () => now,
    ...mcpOAuthLifecycleDependencies(config, settings),
    refreshTelemetry: { trigger: 'turn' as const, emit: () => {} },
  };
  const context = { config, workspaceId, agentId, actorMembershipId };
  const lifecycle = async () => (await config.listConnectionAccounts(workspaceId))[0]?.lifecycle;
  const scheduleState = async (id: string) => (await config.getAgentScheduleReference(id))?.state;
  return {
    config, settings, account, ref, tokenKey, oldToken, dependencies, context, lifecycle, scheduleState,
    advance(ms: number) { now += ms; },
    resolve: (fetchFn: typeof fetch) =>
      resolveMcpOAuthAccessToken({ ref, serverUrl: SERVER_URL }, { ...dependencies, fetchFn }),
    close() { config.close(); settings.close(); },
  };
}

const rejectGrant: typeof fetch = async () =>
  Response.json({ error: 'invalid_grant', error_description: 'refresh token expired' }, { status: 400 });

test('a rejected refresh demotes a team MCP account and pauses its dependents', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.resolve(rejectGrant), { code: 'reauthorization_required' });
    assert.equal(await f.settings.getSetting(f.tokenKey), undefined);
    assert.equal(await f.lifecycle(), 'needs_attention');
    const schedule = await f.config.getAgentScheduleReference('schedule_triage');
    assert.equal(schedule?.state, 'needs_attention');
    assert.deepEqual(schedule?.connectionPauseAccountIds, [f.account.id]);
    assert.equal(await f.scheduleState('schedule_digest'), 'active');
    assert.deepEqual(await resolveEffectiveConnectionAccounts(f.context), []);
  } finally { f.close(); }
});

test('later turns name a demoted team MCP connection for an admin until it is reconnected', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await resolveConnectionAccountContext(f.context)).teamReconnects, []);
    await assert.rejects(f.resolve(rejectGrant), { code: 'reauthorization_required' });
    const demoted = await resolveConnectionAccountContext(f.context);
    assert.deepEqual(demoted.effective, []);
    // A team account is not the member's to authorize.
    assert.deepEqual(demoted.authorizations, []);
    assert.deepEqual(demoted.teamReconnects, [{ providerId: 'bugsnag', label: 'BugSnag' }]);

    const [account] = await f.config.listConnectionAccounts('T_MCP');
    await f.config.putConnectionAccount({ ...account!, lifecycle: 'ready' }, account!.revision);
    const reconnected = await resolveConnectionAccountContext(f.context);
    assert.equal(reconnected.effective.length, 1);
    assert.deepEqual(reconnected.teamReconnects, []);
  } finally { f.close(); }
});

test('an abandoned admin reconnect of a working team MCP account is named until it completes', async () => {
  const f = await fixture();
  try {
    // Starting a sign-in moves even a working account to pending with a new
    // attempt; nothing reverts it if the admin never finishes.
    const started = await f.config.putConnectionAccount({
      ...f.account,
      lifecycle: 'pending',
      policy: { ...f.account.policy, oauthAttemptId: '0b4f2a8e-1c3d-4e5f-8a9b-7c6d5e4f3a2b' },
    }, f.account.revision);
    const abandoned = await resolveConnectionAccountContext(f.context);
    assert.deepEqual(abandoned.effective, []);
    assert.deepEqual(abandoned.teamReconnects, [{ providerId: 'bugsnag', label: 'BugSnag' }]);

    await f.config.putConnectionAccount({ ...started, lifecycle: 'ready' }, started.revision);
    assert.deepEqual((await resolveConnectionAccountContext(f.context)).teamReconnects, []);
  } finally { f.close(); }
});

test('a transient MCP refresh failure does not report the connection as needing reconnect', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.resolve(async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })),
      { code: 'oauth_unavailable' },
    );
    assert.deepEqual((await resolveConnectionAccountContext(f.context)).teamReconnects, []);
  } finally { f.close(); }
});

test('only enabled team bindings of this Agent awaiting an admin sign-in are named for reconnect', async () => {
  const f = await fixture();
  try {
    const [account] = await f.config.listConnectionAccounts('T_MCP');
    const demoted = { ...account!, lifecycle: 'needs_attention' as const };
    const pending = { ...demoted, lifecycle: 'pending' as const };
    const personal = { ...demoted, ownerKind: 'member' as const, ownerMembershipId: 'member_owner' };
    const binding = (await f.config.listAgentConnectionBindings('agent_triage'))[0]!;
    const named = [{ providerId: 'bugsnag', label: 'BugSnag' }];
    assert.deepEqual(projectTeamConnectionsNeedingReconnect([demoted], [binding]), named);
    assert.deepEqual(projectTeamConnectionsNeedingReconnect([pending], [binding]), named);
    for (const [accounts, bindings] of [
      [[account!], [binding]],
      [[{ ...demoted, lifecycle: 'revoked' as const }], [binding]],
      [[personal], [binding]],
      [[{ ...personal, lifecycle: 'pending' as const }], [binding]],
      [[demoted], [{ ...binding, enabled: false }]],
      [[demoted], [{ ...binding, providerId: 'sentry' }]],
      [[demoted], []],
    ] as const) {
      assert.deepEqual(projectTeamConnectionsNeedingReconnect([...accounts], [...bindings]), []);
    }
  } finally { f.close(); }
});

test('a ready team MCP account with no stored credential is demoted on its next use', async () => {
  const f = await fixture();
  try {
    await f.settings.deleteSetting(f.tokenKey);
    await assert.rejects(
      f.resolve(async () => assert.fail('no provider request without a credential')),
      { code: 'reauthorization_required' },
    );
    assert.equal(await f.lifecycle(), 'needs_attention');
    assert.equal(await f.scheduleState('schedule_triage'), 'needs_attention');
  } finally { f.close(); }
});

test('a transient refresh failure leaves the MCP account, credential and schedules untouched', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.resolve(async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })),
      { code: 'oauth_unavailable' },
    );
    assert.equal(await f.settings.getSetting(f.tokenKey), f.oldToken);
    assert.equal(await f.lifecycle(), 'ready');
    assert.equal(await f.scheduleState('schedule_triage'), 'active');
  } finally { f.close(); }
});

for (const winner of ['reconnected', 'refreshed', 'disconnected'] as const) {
  test(`a late MCP refresh rejection respects a concurrent ${winner} winner`, async () => {
    const f = await fixture();
    const winnerToken = tokenBundle('access-winner', 1_000_000, 3_600);
    try {
      const result = f.resolve(async () => {
        if (winner === 'reconnected') {
          await f.config.putConnectionAccount({ ...f.account }, f.account.revision);
        }
        if (winner === 'disconnected') {
          await f.config.putConnectionAccount({ ...f.account, lifecycle: 'revoked' }, f.account.revision);
          await f.settings.deleteSetting(f.tokenKey);
        } else {
          await f.settings.setSetting(f.tokenKey, winnerToken);
        }
        return rejectGrant(TOKEN_ENDPOINT);
      });
      if (winner === 'disconnected') {
        await assert.rejects(result, { code: 'reauthorization_required' });
        assert.equal(await f.lifecycle(), 'revoked');
      } else {
        assert.equal(await result, 'access-winner');
        assert.equal(await f.settings.getSetting(f.tokenKey), winnerToken);
        assert.equal(await f.lifecycle(), 'ready');
      }
      assert.equal(await f.scheduleState('schedule_triage'), 'active');
    } finally { f.close(); }
  });
}

test('a rejection reported after a reconnect advanced the account revision does not demote it', async () => {
  const f = await fixture();
  try {
    const result = f.resolve(async () => {
      // A reconnect finished while the refresh was in flight, but its token
      // write landed after this caller's delete.
      await f.config.putConnectionAccount({ ...f.account }, f.account.revision);
      return rejectGrant(TOKEN_ENDPOINT);
    });
    await assert.rejects(result, { code: 'reauthorization_required' });
    assert.equal(await f.lifecycle(), 'ready');
    assert.equal(await f.scheduleState('schedule_triage'), 'active');
  } finally { f.close(); }
});

test('a missing credential during a reconnect leaves the pending account alone', async () => {
  const f = await fixture();
  try {
    const pending = await f.config.putConnectionAccount({ ...f.account, lifecycle: 'pending' }, f.account.revision);
    await f.settings.deleteSetting(f.tokenKey);
    await assert.rejects(
      f.resolve(async () => assert.fail('no provider request without a credential')),
      { code: 'reauthorization_required' },
    );
    const [account] = await f.config.listConnectionAccounts('T_MCP');
    assert.equal(account?.lifecycle, 'pending');
    assert.equal(account?.revision, pending.revision);
    assert.equal(await f.scheduleState('schedule_triage'), 'active');
  } finally { f.close(); }
});

test('a legacy per-Agent connection is marked for reconnection instead of an account', async () => {
  const f = await fixture();
  try {
    const agent = await f.config.getAgent('agent_triage');
    await f.config.updateAgent(agent.id, {
      mcpServers: [{
        id: 'errors', displayName: 'Errors', url: SERVER_URL, transport: 'streamable-http',
        authMode: 'oauth', headerNames: [], enabled: true, lifecycleStatus: 'ready',
        statusText: 'Connected', discoveredTools: [], allowedTools: [],
      }],
    }, agent.revision);
    await f.dependencies.onReauthorizationRequired!({ agentId: 'agent_triage', connectionId: 'errors' }, SERVER_URL);
    const [server] = (await f.config.getAgent('agent_triage')).mcpServers;
    assert.equal(server?.lifecycleStatus, 'pending');
    assert.equal(server?.statusText, 'Reconnect required');
    assert.equal(await f.lifecycle(), 'ready');
  } finally { f.close(); }
});
