import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { hydrateSlackContextViaWebClient } from '../src/slack/web-client-context.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * Group DMs end to end, through the gateway as Slack delivers them: an
 * `app_mention` with no `channel_type` and a `C…` id that looks like a
 * Channel's, and `message.mpim` events marked `channel_type: 'mpim'`.
 */

const GROUP_DM = 'C0GROUPDM';
/** A group DM with someone from another organization (Slack Connect). */
const CONNECT_DM = 'C0CONNECTDM';
const OPS = '<!subteam^SOPS|@ops>';
const HELPER = '<!subteam^SHELPER|@helper>';
const SOLO = '<!subteam^SSOLO|@solo>';
const SECRET = '<!subteam^SSECRET|@secret>';
const OFF = '<!subteam^SOFF|@off>';
const ONLY_WORKSPACE_WIDE = 'Only Agents everyone in this workspace can use answer in group DMs.';
const NOT_AVAILABLE = 'That Agent is not available here.';

const USERS: Record<string, Record<string, unknown>> = {
  U1: { id: 'U1', team_id: 'T1', name: 'Owner' },
  U2: { id: 'U2', team_id: 'T1', name: 'Teammate' },
  U3: { id: 'U3', team_id: 'T1', name: 'Guest', is_restricted: true },
};

const CHANNELS: Record<string, Record<string, unknown>> = {
  C1: { id: 'C1', name: 'ops', is_channel: true, is_private: false, is_member: true, is_archived: false },
  CPRIVATE: { id: 'CPRIVATE', name: 'secret', is_group: true, is_private: true, is_member: true, is_archived: false },
  [GROUP_DM]: {
    id: GROUP_DM, name: 'mpdm-owner--teammate--guest-1', is_mpim: true, is_private: true,
    is_member: true, is_archived: false,
  },
  [CONNECT_DM]: {
    id: CONNECT_DM, name: 'mpdm-owner--partner-1', is_mpim: true, is_private: true,
    is_member: true, is_archived: false, is_shared: true, is_ext_shared: true,
  },
};

interface Harness {
  stores: AppStores;
  jobs: TurnJob[];
  posts: Array<{ operation: string; input: Record<string, unknown> }>;
  /** Every gateway operation, in order. */
  calls: string[];
  /** A `message.mpim` event, or with `appMention` the `app_mention` Slack sends beside it. */
  deliver(message: {
    ts: string;
    text: string;
    user?: string;
    channel?: string;
    threadTs?: string;
    eventId?: string;
    appMention?: boolean;
  }): Promise<void>;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    const createAgent = (id: string, handle: string, enabled = true) => stores.config.createAgent({
      id, name: handle, instructions: '', enabled, lifecycle: 'active', model: 'local-stub/group-dm',
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy',
        userGroupId: `S${handle.toUpperCase()}`, avatar: { kind: 'generated', revision: 1, seed: handle },
      },
    });
    // @ops and @helper are in a public Channel: everyone in the workspace may use them.
    // @solo has no Channel: only its creator (U1) may. @secret is only in a private Channel.
    for (const [id, handle] of [
      ['agent_ops', 'ops'], ['agent_helper', 'helper'], ['agent_solo', 'solo'], ['agent_secret', 'secret'],
    ] as const) await createAgent(id, handle);
    await createAgent('agent_off', 'off', false);
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT', gatewayBindingId: 'binding1',
    });
    for (const [agentId, channelId, channelIsPrivate] of [
      ['agent_ops', 'C1', false], ['agent_helper', 'C1', false], ['agent_secret', 'CPRIVATE', true],
    ] as const) {
      await stores.config.putAgentChannelGrant({
        workspaceId: 'T1', channelId, agentId, status: 'active',
        createdByMembershipId: owner.membership.id, channelLabel: channelId, channelIsPrivate,
      }, 0);
    }

    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const posts: Harness['posts'] = [];
    const calls: string[] = [];
    let posted = 0;
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string, input: Record<string, unknown>) {
        calls.push(operation);
        if (operation === 'users.info') {
          return {
            user: {
              deleted: false, is_bot: false, is_app_user: false, is_restricted: false,
              is_ultra_restricted: false, is_stranger: false, ...USERS[String(input.user)],
            },
          };
        }
        if (operation === 'conversations.info') {
          const channel = CHANNELS[String(input.channel)];
          if (!channel) throw new Error(`Unexpected conversation: ${String(input.channel)}`);
          return { channel };
        }
        if (operation === 'users.conversations') return { channels: [CHANNELS.C1, CHANNELS.CPRIVATE] };
        if (operation === 'chat.postMessage' || operation === 'chat.postEphemeral') {
          posts.push({ operation, input });
          posted += 1;
          return { ok: true, ts: `1900000000.${String(posted).padStart(6, '0')}`, channel: input.channel };
        }
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    const jobs: TurnJob[] = [];
    await run({
      stores,
      jobs,
      posts,
      calls,
      async deliver(message) {
        const posted = {
          channel: message.channel ?? GROUP_DM,
          user: message.user ?? 'U1',
          ts: message.ts,
          text: message.text,
          ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
        };
        assert.equal(await processGatewaySlackEnvelope({
          workspaceId: 'T1',
          eventId: message.eventId ?? `Ev${message.ts.replace('.', '')}`,
          eventTime: Math.floor(Number(message.ts)),
          event: message.appMention
            ? { type: 'app_mention', event_ts: message.ts, ...posted }
            : { type: 'message', channel_type: 'mpim', event_ts: message.ts, ...posted },
        }, undefined, gateway, {
          stores,
          enqueueTurn: async (job) => {
            jobs.push(job);
            await stores.slackState.enqueueTurn!(job);
            return { ok: true, value: null };
          },
        }), 'accepted');
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

const refusal = (text: string, threadTs?: string) => ({
  operation: 'chat.postEphemeral',
  input: { channel: GROUP_DM, user: 'U2', ...(threadTs ? { thread_ts: threadTs } : {}), text },
});

test('a bare @Chickpea in a group DM is answered as in a DM, with the group\'s recent history', async () => {
  // Amber 2026-10-25: Slack's app_mention names no kind, so the group DM
  // routed as a Channel turn and died before the model.
  await withHarness(async (harness) => {
    await harness.deliver({ ts: '1800000100.000100', text: '<@UBOT> what did we decide?', appMention: true });
    assert.equal(harness.jobs.length, 1);
    const [job] = harness.jobs;
    assert.equal(job?.assignment.agentId, 'agent_chickpea');
    assert.equal(job?.assignment.interactionMode, undefined, 'no Channel workspace-management thread');
    assert.equal(job?.turn.channelType, 'mpim', 'Slack named the kind, and the turn keeps it');
    assert.equal(job?.turn.contextMode, 'channel_history', 'a root reads the group DM, as a Channel root does');
    assert.deepEqual(harness.posts, []);
    assert.deepEqual(await harness.stores.config.listAgentChannelGrants('T1', GROUP_DM), []);
  });
});

test('either delivery of one mention, in either order, is the same group DM turn and runs once', async () => {
  for (const order of [[true, false], [false, true]]) {
    await withHarness(async (harness) => {
      for (const [index, appMention] of order.entries()) {
        await harness.deliver({
          ts: '1800000200.000100', text: '<@UBOT> draft the plan', appMention, eventId: `EvFanOut${index}`,
        });
      }
      assert.equal(harness.jobs.length, 1, JSON.stringify(order));
      assert.equal(harness.jobs[0]?.turn.channelType, 'mpim');
      assert.equal(harness.jobs[0]?.id, `msg:${GROUP_DM}:1800000200.000100`);
      assert.deepEqual(harness.posts, []);
    });
  }
});

test('a workspace-wide Agent answers its handle at the root, and anyone\'s plain reply in its thread', async () => {
  await withHarness(async (harness) => {
    const rootTs = '1800000300.000100';
    await harness.deliver({ ts: rootTs, text: `${OPS} what changed this week?` });
    assert.equal(harness.jobs.at(-1)?.assignment.agentId, 'agent_ops');

    await harness.deliver({ ts: '1800000310.000100', threadTs: rootTs, user: 'U2', text: 'and the dates?' });
    assert.equal(harness.jobs.length, 2);
    assert.equal(harness.jobs[1]?.assignment.agentId, 'agent_ops', 'the thread\'s owner answers');
    assert.equal(harness.jobs[1]?.turn.userId, 'U2', 'the asker is whoever wrote');
    assert.deepEqual(harness.posts, []);
  });
});

test('people talking to each other in a group DM reach no Agent, and Slack is not asked', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: '1800000400.000100', text: 'lunch at noon?' });
    await harness.deliver({ ts: '1800000410.000100', threadTs: '1800000400.000100', user: 'U2', text: 'sure' });
    await harness.deliver({ ts: '1800000420.000100', text: '<!subteam^SDESIGN|@design-team> thoughts?' });
    assert.deepEqual(harness.jobs, []);
    assert.deepEqual(harness.posts, []);
    assert.deepEqual(harness.calls, ['conversations.info', 'users.info'],
      'only the message naming a group of people is read, as a possible Agent address');
  });
});

test('two workspace-wide Agents mentioned together answer in order', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: '1800000500.000100', user: 'U2', text: `${OPS} ${HELPER} compare notes` });
    assert.deepEqual(harness.jobs.map((job) => job.assignment.agentId), ['agent_ops', 'agent_helper']);
    assert.equal(harness.jobs[1]?.assignment.threadGuest, true, 'the first owns the thread');
    assert.deepEqual(harness.posts, []);
  });
});

test('an Agent only its creator or a private Channel may use never answers in a group DM, even its creator', async () => {
  for (const [handle, user] of [[SOLO, 'U1'], [SOLO, 'U2'], [SECRET, 'U1']] as const) {
    await withHarness(async (harness) => {
      await harness.deliver({ ts: '1800000600.000100', user, text: `${handle} summarize this` });
      assert.deepEqual(harness.jobs, [], `${handle} by ${user}`);
      assert.deepEqual(harness.posts, [{ ...refusal(ONLY_WORKSPACE_WIDE), input: { ...refusal(ONLY_WORKSPACE_WIDE).input, user } }]);
      // Never an Add offer, and never a grant on the group DM.
      assert.deepEqual(await harness.stores.config.listAgentChannelGrants('T1', GROUP_DM), []);

      // A Slack retry of the message is not told twice.
      await harness.deliver({ ts: '1800000600.000100', user, text: `${handle} summarize this` });
      assert.equal(harness.posts.length, 1);
    });
  }
});

test('when one of two co-addressed Agents is not workspace-wide, neither answers, and one note says why', async () => {
  for (const text of [`${OPS} ${SOLO} compare notes`, `${SOLO} ${OPS} compare notes`]) {
    await withHarness(async (harness) => {
      await harness.deliver({ ts: '1800000700.000100', user: 'U2', text });
      assert.deepEqual(harness.jobs, [], text);
      assert.deepEqual(harness.posts, [refusal(ONLY_WORKSPACE_WIDE)]);
    });
  }
});

test('a refusal in an Agent\'s thread is told in that thread, to the asker only', async () => {
  await withHarness(async (harness) => {
    const rootTs = '1800000800.000100';
    await harness.deliver({ ts: rootTs, text: `${OPS} plan the offsite` });
    await harness.deliver({ ts: '1800000810.000100', threadTs: rootTs, user: 'U2', text: `${SOLO} add the budget` });
    assert.equal(harness.jobs.length, 1);
    assert.deepEqual(harness.posts, [refusal(ONLY_WORKSPACE_WIDE, rootTs)]);
  });
});

test('a switched-off Agent in a group DM gets the usual refusal, not the group DM rule', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: '1800000650.000100', user: 'U2', text: `${OFF} summarize this` });
    assert.deepEqual(harness.jobs, []);
    assert.deepEqual(harness.posts, [refusal(NOT_AVAILABLE)]);
  });
});

test('a guest asking in a group DM is not admitted, and only they hear so', async () => {
  await withHarness(async (harness) => {
    for (const text of [`${OPS} help`, '<@UBOT> help']) {
      await harness.deliver({ ts: `18000009${text.length}.000100`, user: 'U3', text });
    }
    assert.deepEqual(harness.jobs, []);
    assert.deepEqual(harness.posts.map(({ operation, input }) => [operation, input.user, input.text]), [
      ['chat.postEphemeral', 'U3', NOT_AVAILABLE],
      ['chat.postEphemeral', 'U3', NOT_AVAILABLE],
    ]);
  });
});

test('a group DM shared with another organization gets no Agent, Chickpea included', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ channel: CONNECT_DM, ts: '1800001000.000100', text: '<@UBOT> help', appMention: true });
    await harness.deliver({ channel: CONNECT_DM, ts: '1800001010.000100', text: `${OPS} help` });
    assert.deepEqual(harness.jobs, []);
    assert.deepEqual(harness.posts.map(({ operation, input }) => [operation, input.channel, input.text]), [
      ['chat.postEphemeral', CONNECT_DM, NOT_AVAILABLE],
      ['chat.postEphemeral', CONNECT_DM, NOT_AVAILABLE],
    ]);
  });
});

test('a group DM\'s history read without mpim:history leaves the turn with its own message, not a failure', async () => {
  const turn: NormalizedSlackTurn = {
    workspaceId: 'T1', channelId: GROUP_DM, eventId: 'EvHistory', text: '<@UBOT> what did we decide?',
    userId: 'U1', messageTs: '1800001100.000100', threadTs: '1800001100.000100',
    source: 'app_mention', channelType: 'mpim', contextMode: 'channel_history',
  };
  const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'missing_scope', needed: 'mpim:history' },
  });
  const client = {
    conversations: { history: async () => { throw missingScope; } },
  } as unknown as WebClient;
  const context = await hydrateSlackContextViaWebClient(client, turn);
  assert.deepEqual(context.messages.map((message) => message.text), [turn.text]);
  assert.equal(context.degradations.length, 1);
  assert.match(context.degradations[0]!, /^slack_context\.channel_history:/);
});
