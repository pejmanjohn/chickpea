import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const OWNER = {
  id: 'U1', team_id: 'T1', name: 'Owner', deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, is_stranger: false,
};

test('a Channel turn records the current Slack name and refreshes labels cached before a rename', async () => {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.createAgent({
      id: 'agent_support', name: 'support', instructions: '', enabled: true, lifecycle: 'active',
      model: 'local-stub/channel-label',
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active',
        health: 'healthy', userGroupId: 'SSUPPORT',
        avatar: { kind: 'generated', revision: 1, seed: 'support' },
      },
    });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1',
    });
    // Assigned while the Slack Channel was still called "new-channel".
    await stores.config.putChannel({
      workspaceId: 'T1', channelId: 'C1', label: 'new-channel', lifecycle: 'active',
    }, 0);
    await stores.config.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: 'agent_support', status: 'active',
      createdByMembershipId: owner.membership.id, channelLabel: 'new-channel',
      channelIsPrivate: false,
    }, 0);

    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const liveChannel = {
      id: 'C1', name: 'qa-cobalt', is_channel: true, is_private: false, is_member: true,
      is_archived: false,
    };
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string) {
        if (operation === 'users.info') return { user: OWNER };
        if (operation === 'conversations.info') return { channel: liveChannel };
        if (operation === 'conversations.members') return { members: ['U1', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [liveChannel] };
        if (operation === 'chat.postMessage') return { ts: '1000.0001', channel: 'C1' };
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    const jobs: TurnJob[] = [];
    const accepted = await processGatewaySlackEnvelope({
      workspaceId: 'T1', eventId: 'Ev3000', eventTime: 3000,
      event: {
        type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '3000.000100',
        text: '<!subteam^SSUPPORT|@support> Hello there.',
      },
    }, undefined, gateway, {
      stores,
      enqueueTurn: async (job) => { jobs.push(job); return { ok: true, value: null }; },
    });

    assert.equal(accepted, 'accepted');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.assignment.channelLabel, 'qa-cobalt');
    assert.equal((await stores.config.getChannel('T1', 'C1'))?.label, 'qa-cobalt');
    assert.deepEqual(
      (await stores.config.listAgentChannelGrants('T1', 'C1')).map(({ channelLabel }) => channelLabel),
      ['qa-cobalt'],
    );
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
});
