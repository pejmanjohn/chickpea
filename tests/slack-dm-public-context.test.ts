import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import { recordDeliveredSlackAgentMessage, retainedSlackReplyBackground } from '../src/slack/public-context.ts';
import { WebClientPresenter } from '../src/slack/web-client-presenter.ts';
import { assembleSlackPrompt, hydrateSlackContextViaWebClient } from '../src/slack/web-client-context.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import type { WebClient } from '@slack/web-api';
import { createSlackOwner } from './helpers/slack-owner.ts';

test('gateway-admitted Agent DM roots retain only their own delivered public replies', async () => {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    for (const [id, handle, group] of [['agent_support', 'support', 'SSUPPORT'], ['agent_other', 'other', 'SOTHER']] as const) {
      await stores.config.createAgent({
        id, name: handle, instructions: '', enabled: true, lifecycle: 'active',
        creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
        skills: [], mcpServers: [], apiConnections: [], repositories: [],
        slackPresence: { requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy', userGroupId: group, avatar: { kind: 'generated', revision: 1, seed: handle } },
      });
    }
    await stores.config.ensureWorkspaceInstallation({ workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT', gatewayBindingId: 'binding1' });
    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string) {
        if (operation === 'users.info') return { user: { id: 'U1', team_id: 'T1', name: 'Owner', deleted: false, is_bot: false, is_app_user: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false } };
        if (operation === 'conversations.info') return { channel: { id: 'D1', is_im: true, user: 'U1' } };
        if (operation === 'users.conversations') return { channels: [] };
        if (operation === 'chat.postMessage') return { ts: '1000.0001', channel: 'D1' };
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
    const jobs: TurnJob[] = [];
    const admit = async (ts: string, text: string) => {
      const previousCount = jobs.length;
      assert.equal(await processGatewaySlackEnvelope({
        workspaceId: 'T1', eventId: `Ev${ts}`, eventTime: Number(ts),
        event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts, text },
      }, undefined, gateway, { stores, enqueueTurn: async (job) => { jobs.push(job); return { ok: true, value: null }; } }), 'accepted');
      assert.equal(jobs.length, previousCount + 1);
      return jobs.at(-1)!;
    };
    const first = await admit('1000', '<!subteam^SSUPPORT|@support> Invent a code.');
    assert.equal(first.assignment.agentId, 'agent_support');
    assert.equal(first.assignment.runtimeContract, 'chickpea-v1');
    assert.equal(first.turn.contextMode, 'thread', 'native admission isolates Slack hydration to this root');
    const presenter = new WebClientPresenter({ chat: {
      async startStream() { return { ok: true, ts: '1001' }; },
      async stopStream() { return { ok: true }; },
    } } as unknown as WebClient, {
      channelId: 'D1', threadTs: first.turn.threadTs, workspaceId: 'T1', userId: 'U1', agentId: 'agent_support', agentName: 'Support',
    }, undefined, { onPublicDelivery: (delivery) => recordDeliveredSlackAgentMessage(stores.config, first.turn, first.assignment, delivery) });
    await presenter.deliverFinal('The code is CEDARX.', 'markdown');
    await stores.config.putSlackPublicContext({ workspaceId: 'T1', channelId: 'D1', rootTs: '1500', messageTs: '1501', role: 'agent', agentId: 'agent_other', text: 'OTHER_AGENT_PRIVATE_ROOT' });
    const second = await admit('2000', '<!subteam^SSUPPORT|@support> What code did you give me?');
    assert.equal(second.turn.contextMode, 'thread');
    const handoffBlock = await retainedSlackReplyBackground(stores.config, second.turn, second.assignment.agentId);
    const context = await hydrateSlackContextViaWebClient({ conversations: {
      async replies(input: { ts: string }) { assert.equal(input.ts, second.turn.threadTs); return { ok: true, messages: [{ ts: '2000', user: 'U1', text: second.turn.text }] }; },
      async history() { assert.fail('shared DM history must remain inaccessible'); },
    } } as unknown as WebClient, second.turn);
    const prompt = assembleSlackPrompt(second.turn, context, { ...(handoffBlock ? { handoffBlock } : {}) });
    assert.match(prompt, /CEDARX/);
    assert.match(prompt, /Historical background only/);
    assert.doesNotMatch(prompt, /OTHER_AGENT_PRIVATE_ROOT/);
    assert.equal(await retainedSlackReplyBackground(stores.config, { ...second.turn, channelType: 'mpim' }, second.assignment.agentId), undefined, 'group DMs do not use the cross-root reader');
    assert.equal(await retainedSlackReplyBackground(stores.config, { ...second.turn, messageTs: '2001' }, second.assignment.agentId), undefined, 'a follow-up inside the new thread must not import another root');
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    envKeys.forEach((key, index) => { if (previousEnv[index] === undefined) delete process.env[key]; else process.env[key] = previousEnv[index]; });
  }
});
