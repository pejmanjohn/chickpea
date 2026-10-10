import assert from 'node:assert/strict';
import { test } from 'node:test';

import { processGatewaySlackEnvelope, processGatewayUiAction } from '../src/channels/slack.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { addAgentToChannel, parseAgentChannelAddClick } from '../src/slack/agent-channel-offer.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { withDirectSlackInstall } from './helpers/direct-slack-install.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/** The Slack button that adds a mentioned Agent; the gateway forwards it by this prefix. */
const ADD_ACTION = 'chickpea.host.v1.agent_channel_add';

interface AgentSeed {
  id: string;
  name: string;
  handle: string;
  granted: boolean;
}

interface Lane {
  stores: ReturnType<typeof resolveStores>;
  jobs: TurnJob[];
  posts: Array<Record<string, unknown>>;
  send(event: { user: string; text: string; ts: string; channel?: string; thread_ts?: string }): Promise<void>;
  click(input: { user: string; value: string; actionTs: string }): Promise<'accepted' | 'rejected'>;
}

const HELP: AgentSeed = { id: 'agent_help', name: 'Support', handle: 'help', granted: true };
const LEGAL: AgentSeed = { id: 'agent_legal', name: 'Legal', handle: 'legal', granted: false };
const CHARLIE: AgentSeed = { id: 'agent_charlie', name: 'Charlie', handle: 'charlie', granted: true };

function slackUser(id: string) {
  return {
    id, team_id: 'T1', name: id, deleted: false, is_bot: false, is_app_user: false,
    is_restricted: false, is_ultra_restricted: false, is_stranger: false,
  };
}

/**
 * One Chickpea installation on the shared gateway, in workspace T1, with
 * Channel #team (C1). U1 is its Owner and U2 a member. The workspace's
 * directory also holds every group in `directory`: another app's Agents and
 * groups of people.
 */
async function withLane(
  agents: AgentSeed[],
  scenario: (lane: Lane) => Promise<void>,
  directory: Array<{ id: string; handle: string }> = [],
): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1', runtimeContract: 'chickpea-v1',
    });
    await stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'team', lifecycle: 'active' }, 0);
    for (const seed of agents) {
      const agent = await stores.config.createAgent({
        id: seed.id, name: seed.name, instructions: `Help as ${seed.name}.`, enabled: true,
        lifecycle: 'active', creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
        model: `local-stub/${seed.handle}`, skills: [], mcpServers: [], apiConnections: [], repositories: [],
        slackPresence: {
          requestedHandle: seed.handle, normalizedHandle: seed.handle, desiredState: 'active',
          health: 'healthy', userGroupId: `S${seed.handle.toUpperCase()}`,
          avatar: { kind: 'generated', revision: 1, seed: seed.handle, url: `https://example.com/${seed.handle}.svg` },
        },
      });
      if (seed.granted) {
        await stores.config.putAgentChannelGrant({
          workspaceId: 'T1', channelId: 'C1', agentId: agent.id, status: 'active',
          createdByMembershipId: owner.membership.id, channelLabel: 'team', channelIsPrivate: false,
        }, 0);
      }
    }
    const groups = [
      ...agents.map(({ name, handle }) => ({ id: `S${handle.toUpperCase()}`, name, handle })),
      ...directory.map(({ id, handle }) => ({ id, name: handle, handle })),
    ].map((group) => ({ ...group, description: '', date_delete: 0, date_update: 1_800_000_000 }));
    const posts: Array<Record<string, unknown>> = [];
    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const liveChannel = {
      id: 'C1', name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false,
    };
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async publishAvatar({ agentId }: { agentId: string }) { return `https://example.com/${agentId}.png`; },
      async call(operation: string, args: Record<string, unknown>) {
        if (operation === 'users.info') return { user: slackUser(String(args.user)) };
        if (operation === 'conversations.info') return { channel: liveChannel };
        if (operation === 'conversations.members') return { members: ['U1', 'U2', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [liveChannel] };
        if (operation === 'usergroups.list') return { usergroups: groups };
        if (operation === 'usergroups.update') {
          const group = groups.find(({ id }) => id === args.usergroup)!;
          Object.assign(group, { name: args.name, handle: args.handle, description: args.description });
          return { usergroup: group };
        }
        if (operation === 'chat.postMessage') {
          posts.push(args);
          return { ok: true, ts: `9000.00000${posts.length}`, channel: args.channel };
        }
        if (operation === 'chat.postEphemeral') {
          posts.push({ ...args, ephemeral: true });
          return { ok: true };
        }
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    const jobs: TurnJob[] = [];
    const enqueueTurn = async (job: TurnJob) => {
      if (!jobs.some(({ id }) => id === job.id)) jobs.push(job);
      return { ok: true as const, value: null };
    };
    let events = 0;
    await scenario({
      stores, jobs, posts,
      async send(event) {
        events += 1;
        const channel = event.channel ?? 'C1';
        await processGatewaySlackEnvelope({
          workspaceId: 'T1', eventId: `Ev${events}`, eventTime: 1_000 + events,
          event: {
            type: 'message', channel, channel_type: channel.startsWith('D') ? 'im' : 'channel',
            user: event.user, ts: event.ts, text: event.text,
            ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
          },
        }, undefined, gateway, { stores, enqueueTurn });
      },
      click({ user, value, actionTs }) {
        return processGatewayUiAction({
          protocolVersion: 1, kind: 'interaction.ui_action', deliveryId: `ui:${user}:${actionTs}`,
          bindingId: 'binding1', workspaceId: 'T1', userId: user, containerType: 'message',
          channelId: 'C1', messageTs: '5000.000200', threadTs: null, isEphemeral: true, viewId: null,
          actionId: ADD_ACTION, blockId: ADD_ACTION, actionType: 'button', value, selected: [], state: {},
          actionTs, triggerId: 'trigger1',
        }, undefined, gateway, { stores, enqueueTurn });
      },
    });
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
}

function buttons(post: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const blocks = (post?.blocks ?? []) as Array<{ type: string; elements?: Array<Record<string, unknown>> }>;
  return blocks.filter(({ type }) => type === 'actions').flatMap(({ elements }) => elements ?? []);
}

test('only the Chickpea that owns a mentioned Agent answers it; another Chickpea in the Channel stays silent', async () => {
  const mention = { user: 'U1', ts: '5000.000100', text: '<!subteam^SHELP|@help> what instrument does chickpea play?' };
  // The installation whose Agent @help is.
  await withLane([HELP], async ({ jobs, posts, send }) => {
    await send(mention);
    // One mention is one run, in the mention's own thread, and nothing else is posted.
    assert.deepEqual(jobs.map(({ assignment, turn }) => [assignment.agentId, turn.channelId, turn.threadTs]), [
      [HELP.id, 'C1', mention.ts],
    ]);
    assert.deepEqual(posts, []);
  });
  // A second Chickpea in the same Channel, whose Agents do not include @help.
  await withLane([CHARLIE], async ({ jobs, posts, send }) => {
    await send(mention);
    assert.deepEqual(jobs, []);
    assert.deepEqual(posts, []);
  }, [{ id: 'SHELP', handle: 'help' }]);
});

test('a DM request that mentions a people group goes to Chickpea as written', async () => {
  await withLane([HELP], async ({ stores, jobs, posts, send }) => {
    await stores.config.materializeChickpeaAgent();
    const text = 'create me a <!subteam^SOLDSUPPORT|@support> agent that ill connect to zendesk';
    await send({ user: 'U1', channel: 'D1', ts: '6000.000100', text });
    assert.deepEqual(posts, []);
    assert.deepEqual(jobs.map(({ assignment, turn }) => [assignment.agentId, turn.text]), [[CHICKPEA_AGENT_ID, text]]);
  }, [{ id: 'SOLDSUPPORT', handle: 'support' }]);
});

test('a person who may add a mentioned Agent to this Channel is offered a button that adds it', async () => {
  await withLane([HELP, LEGAL], async ({ stores, jobs, posts, send, click }) => {
    await send({ user: 'U1', ts: '5000.000100', text: '<!subteam^SLEGAL|@legal> can we use this logo?' });
    assert.equal(jobs.length, 0);
    assert.equal(posts.length, 1);
    const offer = posts[0]!;
    assert.equal(offer.ephemeral, true);
    assert.equal(offer.user, 'U1');
    assert.equal(offer.text, '@legal isn’t in <#C1> yet.');
    assert.deepEqual(buttons(offer).map(({ action_id, value, text }) => [action_id, value, (text as { text: string }).text]), [
      [ADD_ACTION, LEGAL.id, 'Add @legal to #team'],
    ]);

    assert.equal(await click({ user: 'U1', value: LEGAL.id, actionTs: '5001.000100' }), 'accepted');
    const grant = (await stores.config.listAgentChannelGrants('T1', 'C1')).find(({ agentId }) => agentId === LEGAL.id);
    assert.equal(grant?.status, 'active');
    const welcome = posts.find((post) => !post.ephemeral && post.username === 'Legal');
    assert.equal(welcome?.channel, 'C1');
    assert.equal(welcome?.thread_ts, undefined);
    assert.equal(welcome?.icon_url, 'https://example.com/agent_legal.png');
    assert.match(String(welcome?.text), /Mention <!subteam\^SLEGAL\|@legal> to start a thread with me\./);
    assert.equal(posts.at(-1)?.ephemeral, true);
    assert.equal(posts.at(-1)?.text, '@legal is ready in this channel. Mention @legal to start a conversation.');

    await send({ user: 'U1', ts: '5002.000100', text: '<!subteam^SLEGAL|@legal> can we use this logo?' });
    assert.deepEqual(jobs.map(({ assignment }) => assignment.agentId), [LEGAL.id]);
  });
});

test('a person who may not add the Agent is told who can, and a forged click adds nothing', async () => {
  await withLane([HELP, LEGAL], async ({ stores, posts, send, click }) => {
    await send({ user: 'U2', ts: '5000.000100', text: '<!subteam^SLEGAL|@legal> can we use this logo?' });
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.user, 'U2');
    assert.equal(posts[0]!.text,
      '@legal isn’t in <#C1> yet. Ask a workspace Owner or Admin, such as <@U1>, to add it.');
    assert.deepEqual(buttons(posts[0]), []);

    await click({ user: 'U2', value: LEGAL.id, actionTs: '5001.000100' });
    assert.equal(
      (await stores.config.listAgentChannelGrants('T1', 'C1')).some(({ agentId }) => agentId === LEGAL.id),
      false,
    );
    assert.equal(posts.at(-1)?.user, 'U2');
    assert.equal(posts.at(-1)?.text, 'Ask a workspace Owner or Admin, such as <@U1>, to add @legal to this channel.');
  });
});

test('on a direct install, as hosted runs, the Add button adds the Agent through Slack\'s signed click', async () => {
  const group = { id: 'SLEGAL', name: 'Legal', handle: 'legal', description: 'Legal Agent', date_delete: 0, date_update: 1 };
  await withDirectSlackInstall({
    answer: (method, body) => {
      if (method === 'users.info') return { ok: true, user: slackUser(body.get('user') ?? 'U1') };
      if (method === 'conversations.info') {
        return { ok: true, channel: { id: 'C1', name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false } };
      }
      if (method === 'conversations.members') return { ok: true, members: ['U1', 'UBOT'] };
      if (method === 'usergroups.list') return { ok: true, usergroups: [group] };
      return undefined;
    },
  }, async ({ stores, ownerMembershipId, calls, deliver }) => {
    await stores.config.createAgent({
      id: LEGAL.id, name: 'Legal', instructions: 'Help as Legal.', enabled: true, lifecycle: 'active',
      creatorMembershipId: ownerMembershipId, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'legal', normalizedHandle: 'legal', desiredState: 'active', health: 'healthy',
        userGroupId: 'SLEGAL', avatar: { kind: 'generated', revision: 1, seed: 'legal' },
      },
    });
    const response = await deliver('interactions', {
      type: 'block_actions', api_app_id: 'A1', team: { id: 'T1' }, user: { id: 'U1' },
      channel: { id: 'C1' }, trigger_id: 'trigger1',
      container: { type: 'message', channel_id: 'C1', message_ts: '1800000000.000200', is_ephemeral: true },
      actions: [{
        type: 'button', action_id: ADD_ACTION, block_id: ADD_ACTION, value: LEGAL.id,
        action_ts: '1800000001.000100',
      }],
    });
    assert.equal(response.status, 200);
    let notice: URLSearchParams | undefined;
    for (let tries = 0; tries < 200 && !notice; tries += 1) {
      notice = calls.find(({ method }) => method === 'chat.postEphemeral')?.body;
      if (!notice) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(notice?.get('text'), '@legal is ready in this channel. Mention @legal to start a conversation.');
    const grant = (await stores.config.listAgentChannelGrants('T1', 'C1')).find(({ agentId }) => agentId === LEGAL.id);
    assert.equal(grant?.status, 'active');
  });
});

test('a clicker who is not in the Channel is refused before anything is published', async () => {
  const notices: string[] = [];
  let published = 0;
  await addAgentToChannel({
    workspaceId: 'T1', userId: 'U1', channelId: 'C1', threadTs: null, agentId: LEGAL.id, requestId: '5001.000100',
  }, {
    claim: async () => true,
    resolveActor: async () => ({
      routing: { fullMember: true, channelMember: false },
      principal: {
        userId: 'user_owner', membershipId: 'membership_owner', organizationId: 'org_oss', role: 'owner',
        authenticatorKind: 'slack_event', credentialId: 'slack:T1:U1', correlationId: 'slack-event:T1:U1', machine: false,
      },
    }),
    getAgent: async () => ({
      id: LEGAL.id, kind: 'user', name: 'Legal', creatorMembershipId: 'membership_owner',
      editPolicy: 'creator_and_admins',
      slackPresence: { normalizedHandle: 'legal', userGroupId: 'SLEGAL' },
    }) as unknown as CustomAgentConfig,
    identity: { listMemberships: async () => [], listExternalIdentities: async () => [] },
    publish: async () => { published += 1; },
    adminUrl: async () => undefined,
    client: { chat: { postEphemeral: async (input: { text?: string }) => { notices.push(String(input.text)); return { ok: true }; } } } as never,
  });
  assert.equal(published, 0);
  assert.deepEqual(notices, ['That Agent is not available here.']);
});

test('a click names an Agent only by the persisted Agent id grammar', () => {
  const click = (value: string) => parseAgentChannelAddClick({
    workspaceId: 'T1', userId: 'U1', containerType: 'message', channelId: 'C1', messageTs: '5000.000200',
    threadTs: null, isEphemeral: true, viewId: null, actionId: ADD_ACTION, blockId: ADD_ACTION,
    actionType: 'button', value, selected: [], state: {}, actionTs: '5001.000100', triggerId: 'trigger1',
  });
  assert.equal(click(LEGAL.id)?.agentId, LEGAL.id);
  for (const value of ['Agent_Legal', '../agent_legal', '']) assert.equal(click(value), undefined, value);
});
