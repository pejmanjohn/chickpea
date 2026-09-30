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
import type { OAuthRefreshTelemetryEvent } from '../src/config/oauth-refresh-telemetry.ts';
import { apiOAuthLifecycleDependencies } from '../src/connections/api-oauth-lifecycle.ts';
import {
  resolveConnectionAccountContext,
  resolveEffectiveConnectionAccounts,
  resolvePersonalConnectionAuthorizationOptions,
} from '../src/connections/runtime.ts';

async function fixture(ownerKind: 'member' | 'team' = 'member') {
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
    id: 'connection_oauth', workspaceId, ownerKind,
    ...(ownerKind === 'member' ? { ownerMembershipId: actorMembershipId } : {}),
    createdByMembershipId: actorMembershipId,
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
    // A personal account recovers through the member's own authorization.
    assert.deepEqual((await resolveConnectionAccountContext(f.context)).teamReconnects, []);
  } finally { f.close(); }
});

test('a demoted team API account is named for admin reconnect instead of offered to the member', async () => {
  const f = await fixture('team');
  try {
    await assert.rejects(resolveApiOAuthAccessToken({ ref: f.ref, provider: 'google' }, {
      ...f.dependencies,
      fetchFn: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    }), { code: 'reauthorization_required' });
    assert.equal((await f.config.listConnectionAccounts('T_OAUTH'))[0]?.lifecycle, 'needs_attention');
    const context = await resolveConnectionAccountContext(f.context);
    assert.deepEqual(context.effective, []);
    assert.deepEqual(context.authorizations, []);
    assert.deepEqual(context.teamReconnects, [{ providerId: 'google', label: 'Work' }]);
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

test('a ready account whose credential vanished is demoted instead of failing silently', async () => {
  const f = await fixture();
  const events: OAuthRefreshTelemetryEvent[] = [];
  try {
    await f.settings.deleteSetting(f.keys[2]);
    await assert.rejects(resolveApiOAuthAccessToken({ ref: f.ref, provider: 'google' }, {
      ...f.dependencies,
      refreshTelemetry: { trigger: 'turn', emit: (event) => events.push(event) },
      fetchFn: async () => assert.fail('no provider request without a credential'),
    }), { code: 'reauthorization_required' });
    assert.equal((await f.config.listConnectionAccounts('T_OAUTH'))[0]?.lifecycle, 'needs_attention');
    assert.equal((await f.config.getAgentScheduleReference('schedule_mail'))?.state, 'needs_attention');
    assert.deepEqual(events.map(({ outcome, connectionId }) => ({ outcome, connectionId })), [
      { outcome: 'missing', connectionId: f.account.id },
    ]);
  } finally { f.close(); }
});

test('API refresh telemetry reports each outcome with bounded reasons', async () => {
  for (const [label, fetchFn, outcome, reason] of [
    ['refreshed', async () => Response.json({ access_token: 'fresh', token_type: 'Bearer', expires_in: 3600 }), 'refreshed', null],
    ['rejected', async () => Response.json({ error: 'invalid_grant' }, { status: 400 }), 'rejected', 'invalid_grant'],
    ['unregistered code', async () => Response.json({ error: 'Down <b>now</b>' }, { status: 503 }), 'unavailable', 'other'],
    ['no code', async () => new Response('bad gateway', { status: 502 }), 'unavailable', 'http_502'],
    ['network', async () => { throw new TypeError('fetch failed'); }, 'unavailable', 'network'],
  ] as const) {
    const f = await fixture();
    const events: OAuthRefreshTelemetryEvent[] = [];
    try {
      const result = resolveApiOAuthAccessToken({ ref: f.ref, provider: 'google' }, {
        ...f.dependencies,
        refreshTelemetry: { trigger: 'keepalive', emit: (event) => events.push(event) },
        fetchFn,
      });
      if (outcome === 'refreshed') assert.equal(await result, 'fresh');
      else await assert.rejects(result);
      assert.equal(events.length, 1, label);
      assert.equal(events[0]!.outcome, outcome, label);
      assert.equal(events[0]!.reason, reason, label);
      assert.equal(events[0]!.trigger, 'keepalive', label);
      assert.equal(events[0]!.tokenDeleted, outcome === 'rejected', label);
      assert.equal(JSON.stringify(events).includes('old-refresh'), false, label);
    } finally { f.close(); }
  }
});

test('refreshIfObtainedBefore renews a still-valid Google credential only when it is older', async () => {
  const f = await fixture();
  let refreshes = 0;
  try {
    const fresh = JSON.stringify({ provider: 'google', accessToken: 'valid', refreshToken: 'old-refresh', tokenType: 'Bearer', obtainedAt: 5_000, expiresIn: 86_400 });
    await f.settings.setSetting(f.keys[2], fresh);
    const dependencies = {
      ...f.dependencies,
      now: () => 10_000,
      refreshTelemetry: { trigger: 'keepalive' as const, emit: () => {} },
      fetchFn: async () => {
        refreshes += 1;
        return Response.json({ access_token: 'renewed', token_type: 'Bearer', expires_in: 3_600 });
      },
    };
    assert.equal(await resolveApiOAuthAccessToken({ ref: f.ref, provider: 'google', refreshIfObtainedBefore: 5_000 }, dependencies), 'valid');
    assert.equal(refreshes, 0);
    assert.equal(await resolveApiOAuthAccessToken({ ref: f.ref, provider: 'google', refreshIfObtainedBefore: 5_001 }, dependencies), 'renewed');
    assert.equal(refreshes, 1);
  } finally { f.close(); }
});
