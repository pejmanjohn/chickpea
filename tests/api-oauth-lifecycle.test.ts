import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apiOAuthSettingKeys,
  connectionAccountOAuthRef,
  resolveApiOAuthAccessToken,
} from '../src/config/api-oauth.ts';
import { googleWorkspaceApiPolicy } from '../src/config/api-oauth-policy.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { apiOAuthLifecycleDependencies } from '../src/connections/api-oauth-lifecycle.ts';
import {
  resolveEffectiveConnectionAccounts,
  resolvePersonalConnectionAuthorizationOptions,
} from '../src/connections/runtime.ts';

async function fixture() {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const agentId = 'agent_oauth';
  const workspaceId = 'T_OAUTH';
  const actorMembershipId = 'member_oauth';
  await config.createAgent({
    id: agentId, name: 'OAuth', instructions: 'Read mail', enabled: true,
    creatorMembershipId: actorMembershipId, editPolicy: 'creator_and_admins',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  await config.ensureWorkspaceInstallation({ workspaceId, transportMode: 'direct', defaultAgentId: agentId });
  const oauthScopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  const account = await config.putConnectionAccount({
    id: 'connection_oauth', workspaceId, ownerKind: 'member',
    ownerMembershipId: actorMembershipId, createdByMembershipId: actorMembershipId,
    providerId: 'google', label: 'Work', lifecycle: 'ready', secretRefId: 'secret_oauth',
    policy: { kind: 'api', authMode: 'oauth', oauthProvider: 'google', oauthScopes,
      ...googleWorkspaceApiPolicy(oauthScopes) },
  }, 0);
  await config.putAgentConnectionBinding({
    agentId, connectionAccountId: account.id, providerId: 'google',
    allowedCapabilities: oauthScopes, enabled: true,
  });
  for (const [scheduleId, requiredConnectionAccountIds] of [
    ['schedule_mail', [account.id]], ['schedule_reminder', []],
  ] as const) {
    await config.putAgentScheduleReference({
      scheduleId, agentId, workspaceId, channelId: 'C_OAUTH',
      createdByMembershipId: actorMembershipId, runsAsMembershipId: actorMembershipId,
      authorityReceiptId: `authority_${scheduleId}`,
      requiredConnectionAccountIds: [...requiredConnectionAccountIds], state: 'active',
    });
  }
  const ref = connectionAccountOAuthRef(account.id);
  const keys = apiOAuthSettingKeys(ref);
  const oldToken = JSON.stringify({ provider: 'google', accessToken: 'old', refreshToken: 'old-refresh', tokenType: 'Bearer', obtainedAt: 1, expiresIn: 1 });
  await settings.setSetting(keys[0], JSON.stringify({ provider: 'google', clientId: 'client', clientSecret: 'secret' }));
  await settings.setSetting(keys[2], oldToken);
  const dependencies = { settings, ...apiOAuthLifecycleDependencies(config, settings) };
  const context = { config, workspaceId, agentId, actorMembershipId };
  return { config, settings, account, ref, keys, oldToken, dependencies, context,
    close() { config.close(); settings.close(); } };
}

test('native invalid_grant demotes the exact account, pauses dependencies and offers reconnect next turn', async () => {
  const f = await fixture();
  try {
    await assert.rejects(resolveApiOAuthAccessToken({ ref: f.ref, provider: 'google' }, {
      ...f.dependencies,
      fetchFn: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    }), { code: 'reauthorization_required' });
    assert.equal(await f.settings.getSetting(f.keys[2]), undefined);
    assert.equal((await f.config.listConnectionAccounts('T_OAUTH'))[0]?.lifecycle, 'needs_attention');
    const schedule = await f.config.getAgentScheduleReference('schedule_mail');
    assert.equal(schedule?.state, 'needs_attention');
    assert.deepEqual(schedule?.connectionPauseAccountIds, [f.account.id]);
    assert.equal((await f.config.getAgentScheduleReference('schedule_reminder'))?.state, 'active');
    assert.deepEqual(await resolveEffectiveConnectionAccounts(f.context), []);
    const options = await resolvePersonalConnectionAuthorizationOptions(f.context);
    assert.deepEqual(options[0]?.accounts, [{ id: f.account.id, label: 'Work', lifecycle: 'needs_attention' }]);
  } finally { f.close(); }
});

for (const winner of ['reauthorized', 'disconnected', 'refresh', 'after-deletion', 'before-demotion'] as const) {
  test(`late invalid_grant respects concurrent ${winner} winner`, async (t) => {
    const f = await fixture();
    const newToken = JSON.stringify({ provider: 'google', accessToken: 'winner', tokenType: 'Bearer', obtainedAt: Date.now(), expiresIn: 3600 });
    let expectedLifecycle = 'ready';
    const replaceAccount = async () => {
      expectedLifecycle = winner === 'disconnected' ? 'revoked' : 'ready';
      await f.config.putConnectionAccount({ ...f.account, lifecycle: expectedLifecycle as 'ready' | 'revoked' }, f.account.revision);
    };
    try {
      if (winner === 'after-deletion') {
        const callback = f.dependencies.onReauthorizationRequired!;
        f.dependencies.onReauthorizationRequired = async (...args) => {
          await replaceAccount();
          await f.settings.setSetting(f.keys[2], newToken);
          await callback(...args);
        };
      }
      if (winner === 'before-demotion') {
        const listAgents = f.config.listAgents.bind(f.config);
        t.mock.method(f.config, 'listAgents', async () => {
          await replaceAccount();
          return listAgents();
        });
      }
      const result = resolveApiOAuthAccessToken({ ref: f.ref, provider: 'google' }, {
        ...f.dependencies,
        fetchFn: async () => {
          if (winner === 'reauthorized' || winner === 'disconnected') await replaceAccount();
          if (winner === 'reauthorized' || winner === 'refresh') await f.settings.setSetting(f.keys[2], newToken);
          if (winner === 'disconnected') await f.settings.deleteSetting(f.keys[2]);
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        },
      });
      if (winner === 'reauthorized' || winner === 'refresh') assert.equal(await result, 'winner');
      else await assert.rejects(result, { code: 'reauthorization_required' });
      assert.equal((await f.config.listConnectionAccounts('T_OAUTH'))[0]?.lifecycle, expectedLifecycle);
      assert.equal((await f.config.getAgentScheduleReference('schedule_mail'))?.state, 'active');
      if (winner === 'reauthorized' || winner === 'refresh' || winner === 'after-deletion') {
        assert.equal(await f.settings.getSetting(f.keys[2]), newToken);
      }
    } finally { f.close(); }
  });
}

for (const failure of ['unavailable', 'timeout'] as const) {
  test(`transient refresh ${failure} preserves account, token and schedule`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(resolveApiOAuthAccessToken({ ref: f.ref, provider: 'google' }, {
        ...f.dependencies,
        fetchFn: async () => {
          if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
          return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
        },
      }), { code: 'oauth_unavailable' });
      assert.equal(await f.settings.getSetting(f.keys[2]), f.oldToken);
      assert.equal((await f.config.listConnectionAccounts('T_OAUTH'))[0]?.lifecycle, 'ready');
      assert.equal((await f.config.getAgentScheduleReference('schedule_mail'))?.state, 'active');
    } finally { f.close(); }
  });
}
