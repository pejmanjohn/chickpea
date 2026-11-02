import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type PlatformEnv } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const OWNER = {
  id: 'U1', team_id: 'T1', name: 'Owner', deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, is_stranger: false,
};

test('a Worker admission that queued its turn canonically makes no second enqueue RPC', async () => {
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
      model: 'local-stub/canonical-enqueue',
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
    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string) {
        if (operation === 'users.info') return { user: OWNER };
        if (operation === 'conversations.info') return { channel: { id: 'D1', is_im: true, user: 'U1' } };
        if (operation === 'users.conversations') return { channels: [] };
        if (operation === 'chat.postMessage') return { ts: '1000.0001', channel: 'D1' };
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    const enqueueRpcs: string[] = [];
    const platformEnv = {
      TAG_STATE: {
        getByName: () => ({
          enqueueTurn: async (job: { id: string }) => {
            enqueueRpcs.push(job.id);
            return { ok: true, value: null };
          },
        }),
      },
    } as unknown as PlatformEnv;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });

    assert.equal(await processGatewaySlackEnvelope({
      workspaceId: 'T1', eventId: 'Ev4000', eventTime: 4000,
      event: {
        type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: '4000.000100',
        text: '<!subteam^SSUPPORT|@support> Hello there.',
      },
    }, platformEnv, gateway, { stores }), 'accepted');

    const queued = await stores.slackState.listPendingTurns!();
    assert.deepEqual(queued.map(({ id }) => id), ['msg:D1:4000.000100'], 'the admission queued the turn');
    assert.ok(queued[0]?.runId, 'with its canonical Run');
    assert.deepEqual(enqueueRpcs, [], 'no second enqueue RPC after the canonical admission');
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
