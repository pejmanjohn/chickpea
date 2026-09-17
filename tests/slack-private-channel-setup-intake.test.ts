import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  processGatewayAgentSelection,
  processGatewayPrivateChannelSetup,
  processGatewaySlackEnvelope,
} from '../src/channels/slack.ts';
import {
  closeNodeStateStores,
  resolveStores,
  type AppStores,
} from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { GatewayPrivateChannelSetupDelivery } from '../src/slack/gateway/protocol.ts';
import { PRIVATE_CHANNEL_SETUP_ADD_ACTION } from '../src/slack/private-channel-setup.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

async function fixture() {
  closeNodeStateStores();
  const stores = resolveStores();
  const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
  await stores.config.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT', gatewayBindingId: 'binding1',
  });
  await stores.config.createAgent({
    id: 'agent_ops', name: 'Ops', instructions: 'Help.', enabled: true, lifecycle: 'active',
    creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: { requestedHandle: 'ops', normalizedHandle: 'ops', desiredState: 'unpublished',
      health: 'unpublished', avatar: { kind: 'generated', revision: 1, seed: 'ops' } },
  });
  const state = { private: true, lookupFails: false, ephemeralFails: false, restricted: false, members: ['U1', 'UBOT'], bindingId: 'binding1' };
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const groups: Array<Record<string, unknown>> = [];
  const gateway = {
    workspaceId: 'T1',
    async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: state.bindingId }; },
    async publishAvatar() { return 'https://avatars.example.test/ops.png'; },
    async call(operation: string, input: Record<string, unknown>) {
      calls.push({ operation, input });
      if (operation === 'users.info') return { user: { id: input.user, team_id: 'T1', name: 'Owner', deleted: false,
        is_bot: false, is_app_user: false, is_restricted: state.restricted, is_ultra_restricted: false, is_stranger: false } };
      if (operation === 'conversations.info') {
        if (state.lookupFails) throw new Error('channel_not_found');
        return { channel: { id: 'C1', name: 'private-lab', is_private: state.private, is_member: true, is_archived: false } };
      }
      if (operation === 'conversations.members') return { members: state.members };
      if (operation === 'usergroups.list') return { usergroups: groups };
      if (operation === 'usergroups.create') {
        const group = { id: 'SOPS', name: input.name, handle: input.handle, date_delete: 0 };
        groups.push(group); return { usergroup: group };
      }
      if (operation === 'usergroups.update') { Object.assign(groups[0]!, input); return { usergroup: groups[0] }; }
      if (operation === 'chat.postEphemeral' && state.ephemeralFails) throw new Error('delivery_failed');
      if (operation === 'chat.postEphemeral' || operation === 'chat.postMessage') return { ok: true, ts: '100.1', channel: 'C1' };
      throw new Error(`Unexpected gateway operation: ${operation}`);
    },
  } as unknown as GatewayDeploymentClient;
  const delivery = { stores, enqueueTurn: async () => { assert.fail('setup must not enqueue an Agent turn'); } };
  const join = async (inviter: string | undefined = 'U1', id = 'EvJoin') => processGatewaySlackEnvelope({
    workspaceId: 'T1', eventId: id, eventTime: 100,
    event: { type: 'member_joined_channel', user: 'UBOT', channel: 'C1', team: 'T1', channel_type: 'G', event_ts: '100.0',
      ...(inviter ? { inviter } : {}) },
  }, undefined, gateway, delivery);
  const messages = () => calls.filter(({ operation }) => operation.startsWith('chat.'));
  const action = (setupId: string, patch: Partial<GatewayPrivateChannelSetupDelivery> = {}): GatewayPrivateChannelSetupDelivery => ({
    protocolVersion: 1, kind: 'interaction.channel_agent_add', deliveryId: 'click1', bindingId: 'binding1',
    workspaceId: 'T1', channelId: 'C1', userId: 'U1', setupId, agentId: 'agent_ops', ...patch,
  });
  const add = (value: GatewayPrivateChannelSetupDelivery) => processGatewayPrivateChannelSetup(value, undefined, gateway, stores);
  const setupId = () => {
    const blocks = messages()[0]!.input.blocks as Array<{ elements?: Array<{ action_id?: string; value?: string }> }>;
    return blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === PRIVATE_CHANNEL_SETUP_ADD_ACTION)!.value!;
  };
  return { stores, owner, state, calls, groups, join, messages, action, add, setupId };
}

const databaseKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;

test('Agent selection rejects a gateway whose app or bot identity no longer matches', async () => {
  const installation = {
    workspaceId: 'T1',
    transportMode: 'gateway',
    health: 'healthy',
    appId: 'A1',
    botUserId: 'UBOT',
    gatewayBindingId: 'binding1',
  };
  const stores = {
    config: {
      getWorkspaceInstallation: async () => installation,
    },
  } as unknown as AppStores;
  for (const binding of [
    { bindingId: 'binding1', workspaceId: 'T1', appId: 'A_OTHER', botUserId: 'UBOT' },
    { bindingId: 'binding1', workspaceId: 'T1', appId: 'A1', botUserId: 'U_OTHER' },
  ]) {
    const gateway = {
      async loadBinding() { return binding; },
      async call() { assert.fail('mismatched selection must not call Slack'); },
    } as unknown as GatewayDeploymentClient;
    assert.equal(await processGatewayAgentSelection({
      workspaceId: 'T1',
      userId: 'U1',
      agentId: 'agent_ops',
      deliveryId: 'selection1',
    }, undefined, gateway, stores), 'rejected');
  }
});

async function isolated(body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const previous = databaseKeys.map((key) => process.env[key]);
  databaseKeys.forEach((key) => { process.env[key] = ':memory:'; });
  try { await body(await fixture()); }
  finally {
    closeNodeStateStores();
    databaseKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
}

test('private invitation offers only an ephemeral card; Add publishes one selected custom Agent', async () => isolated(async (f) => {
  await f.stores.settings.applySettingsPatch({ set: [{ key: 'slack.behavior.welcomeOnJoin', value: 'false' }] });
  await f.join();
  assert.equal(f.messages().length, 1);
  assert.equal(f.messages()[0]!.operation, 'chat.postEphemeral');
  assert.equal(f.messages()[0]!.input.user, 'U1');
  assert.deepEqual(await f.stores.config.listAgentChannelGrants('T1', 'C1'), []);
  const setupId = f.setupId();
  await f.join();
  assert.equal(f.messages().length, 1, 'retried invitation is silent');
  await f.add(f.action(setupId, { agentId: null }));
  assert.match(String(f.messages().at(-1)!.input.text), /Choose an Agent/);
  assert.equal(f.groups.length, 0);
  await f.add(f.action(setupId, { deliveryId: 'click2' }));
  assert.match(String(f.messages().at(-1)!.input.text), /@ops is ready/);
  assert.equal((await f.stores.config.listAgentChannelGrants('T1', 'C1'))[0]?.status, 'active');
  assert.equal(f.groups.length, 1);
  await f.add(f.action(setupId, { deliveryId: 'click3' }));
  assert.equal(f.groups.length, 1, 'replay never republishes');
  await f.add(f.action(setupId, { deliveryId: 'click4', agentId: null }));
  assert.match(String(f.messages().at(-1)!.input.text), /@ops is ready/);
  await f.stores.config.deleteAgentChannelGrant('T1', 'C1', 'agent_ops');
  await f.add(f.action(setupId, { deliveryId: 'click5' }));
  assert.match(String(f.messages().at(-1)!.input.text), /no longer available/);
  assert.doesNotMatch(String(f.messages().at(-1)!.input.text), /retry|pending/);
  assert.deepEqual(await f.stores.config.listAgentChannelGrants('T1', 'C1'), []);
  assert.equal(f.groups.length, 1);
  assert.ok(f.messages().every(({ operation, input }) => operation === 'chat.postEphemeral' && input.user === 'U1'));
}));

test('expired cards explain expiry and revoked inviters receive no setup feedback', async () => {
  await isolated(async (f) => {
    await f.join();
    const action = f.action(f.setupId());
    const originalNow = Date.now;
    const later = Date.now() + 31 * 60_000;
    Date.now = () => later;
    try { await f.add(action); } finally { Date.now = originalNow; }
    assert.match(String(f.messages().at(-1)!.input.text), /card has expired/);
    assert.doesNotMatch(String(f.messages().at(-1)!.input.text), /retry|pending|Invite Chickpea again/);
    assert.deepEqual(await f.stores.config.listAgentChannelGrants('T1', 'C1'), []);
  });
  await isolated(async (f) => {
    await f.join();
    const action = f.action(f.setupId());
    f.state.restricted = true;
    await f.add(action);
    assert.equal(f.messages().length, 1, 'no new feedback after losing authority');
    assert.deepEqual(await f.stores.config.listAgentChannelGrants('T1', 'C1'), []);
  });
});

test('unknown privacy, absent inviter, and ineligible inviters stay silent', async () => {
  for (const scenario of ['privacy', 'inviter', 'restricted', 'nonmember'] as const) await isolated(async (f) => {
    if (scenario === 'privacy') f.state.lookupFails = true;
    if (scenario === 'restricted') f.state.restricted = true;
    if (scenario === 'nonmember') f.state.members = ['UBOT'];
    await f.join(scenario === 'inviter' ? '' : 'U1');
    assert.deepEqual(f.messages(), [], scenario);
    assert.deepEqual(await f.stores.config.listAgentChannelGrants('T1', 'C1'), []);
  });
});

test('ephemeral delivery failure never falls back to a public welcome', async () => isolated(async (f) => {
  f.state.ephemeralFails = true;
  await f.join();
  await f.join();
  assert.deepEqual(f.messages().map(({ operation }) => operation), ['chat.postEphemeral']);
}));

test('public invitations retain active-grant and welcome-setting gates', async () => isolated(async (f) => {
  f.state.private = false;
  await f.join();
  assert.deepEqual(f.messages(), []);
  await f.stores.config.putAgentChannelGrant({ workspaceId: 'T1', channelId: 'C1', agentId: 'agent_ops', status: 'active', createdByMembershipId: f.owner.membership.id }, 0);
  await f.join('U1', 'EvPublic');
  assert.deepEqual(f.messages().map(({ operation }) => operation), ['chat.postMessage']);
  await f.stores.settings.applySettingsPatch({ set: [{ key: 'slack.behavior.welcomeOnJoin', value: 'false' }] });
  await f.join('U1', 'EvDisabled');
  assert.equal(f.messages().length, 1);
}));

test('wrong inviter and stale gateway binding cannot act on the card', async () => isolated(async (f) => {
  await f.join();
  const setupId = f.setupId();
  await f.add(f.action(setupId, { userId: 'U2' }));
  assert.equal(f.messages().length, 1);
  assert.equal(await f.add(f.action(setupId, { bindingId: 'old-binding' })), 'rejected');
  f.state.bindingId = 'another-binding';
  assert.equal(await f.add(f.action(setupId)), 'rejected');
  assert.deepEqual(await f.stores.config.listAgentChannelGrants('T1', 'C1'), []);
  assert.equal(f.groups.length, 0);
}));
