import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBrowserAction, getBrowserAction } from '../src/browser/actions.ts';
import { SlackStateLogic, SqliteSlackStateStore } from '../src/slack/claim-store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { stopNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import { defaultSlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const ROOT_TS = '1800000000.000100';
const ROOT_ID = `msg:C1:${ROOT_TS}`;
const OPS = '<!subteam^SOPS|@ops>';

const USERS: Record<string, Record<string, unknown>> = {
  U1: { id: 'U1', team_id: 'T1', name: 'Owner' },
  U2: { id: 'U2', team_id: 'T1', name: 'Teammate' },
  U3: { id: 'U3', team_id: 'T1', name: 'Guest', is_restricted: true },
};

interface SlackPost {
  operation: 'chat.postMessage' | 'chat.postEphemeral';
  input: Record<string, unknown>;
}

interface Harness {
  stores: AppStores;
  ownerMembershipId: string;
  /** Turns handed to the durable relay (the Cloudflare enqueue). */
  jobs: TurnJob[];
  posts: SlackPost[];
  /** Mid-run 👀 added, as `<ts>:<name>` (U8). */
  reactions: string[];
  deliver(message: {
    ts: string;
    text: string;
    user?: string;
    channel?: string;
    /** Slack's `channel_type`; by default `im` for a D… channel, else `channel`. */
    channelType?: string;
    threadTs?: string;
    eventId?: string;
  }): Promise<void>;
  pending(): Promise<Awaited<ReturnType<NonNullable<AppStores['slackState']['listPendingTurns']>>>>;
}

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  options: { target?: 'cloudflare' | 'node' } = {},
): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.createAgent({
      id: 'agent_ops', name: 'ops', instructions: '', enabled: true, lifecycle: 'active',
      model: 'local-stub/steering',
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'ops', normalizedHandle: 'ops', desiredState: 'active',
        health: 'healthy', userGroupId: 'SOPS',
        avatar: { kind: 'generated', revision: 1, seed: 'ops' },
      },
    });
    // No model: its turns take the legacy lane (no canonical admission).
    await stores.config.createAgent({
      id: 'agent_plain', name: 'plain', instructions: '', enabled: true, lifecycle: 'active',
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'plain', normalizedHandle: 'plain', desiredState: 'active',
        health: 'healthy', userGroupId: 'SPLAIN',
        avatar: { kind: 'generated', revision: 1, seed: 'plain' },
      },
    });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1',
    });
    await stores.config.putChannel({
      workspaceId: 'T1', channelId: 'C1', label: 'ops', lifecycle: 'active',
    }, 0);
    for (const agentId of ['agent_ops', 'agent_plain']) {
      await stores.config.putAgentChannelGrant({
        workspaceId: 'T1', channelId: 'C1', agentId, status: 'active',
        createdByMembershipId: owner.membership.id, channelLabel: 'ops', channelIsPrivate: false,
      }, 0);
    }

    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const channel = {
      id: 'C1', name: 'ops', is_channel: true, is_private: false, is_member: true, is_archived: false,
    };
    const posts: SlackPost[] = [];
    const reactions: string[] = [];
    let posted = 0;
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string, input: Record<string, unknown>) {
        if (operation === 'users.info') {
          return {
            user: {
              deleted: false, is_bot: false, is_app_user: false, is_restricted: false,
              is_ultra_restricted: false, is_stranger: false,
              ...USERS[String(input.user)],
            },
          };
        }
        if (operation === 'conversations.info') {
          if (input.channel === 'C1') return { channel };
          return String(input.channel).startsWith('G')
            ? { channel: { id: input.channel, is_mpim: true, is_private: true, is_member: true } }
            : { channel: { id: input.channel, is_im: true, user: 'U1' } };
        }
        if (operation === 'conversations.members') return { members: ['U1', 'U2', 'U3', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [channel] };
        if (operation === 'chat.postMessage' || operation === 'chat.postEphemeral') {
          posts.push({ operation, input });
          posted += 1;
          return { ok: true, ts: `1900000000.${String(posted).padStart(6, '0')}`, channel: input.channel };
        }
        if (operation === 'reactions.add') {
          reactions.push(`${String(input.timestamp)}:${String(input.name)}`);
          return { ok: true };
        }
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    if (options.target !== 'node') {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true, value: { userAgent: 'Cloudflare-Workers' },
      });
    }
    const jobs: TurnJob[] = [];
    await run({
      stores,
      ownerMembershipId: owner.membership.id,
      jobs,
      posts,
      reactions,
      async deliver(message) {
        const channelId = message.channel ?? 'C1';
        const direct = channelId.startsWith('D');
        assert.equal(await processGatewaySlackEnvelope({
          workspaceId: 'T1',
          eventId: message.eventId ?? `Ev${message.ts.replace('.', '')}`,
          eventTime: Math.floor(Number(message.ts)),
          event: {
            type: 'message',
            channel: channelId,
            channel_type: message.channelType ?? (direct ? 'im' : 'channel'),
            user: message.user ?? 'U1',
            ts: message.ts,
            text: message.text,
            ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
          },
        }, undefined, gateway, {
          stores,
          // As the state store's gateway drain does: write the row (a canonical
          // admission already did, and this is then a no-op).
          enqueueTurn: async (job) => {
            jobs.push(job);
            await stores.slackState.enqueueTurn!(job);
            return { ok: true, value: null };
          },
        }), 'accepted');
      },
      async pending() {
        return stores.slackState.listPendingTurns!();
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

/**
 * Start a run: the Agent's thread root, admitted and still undelivered. Run
 * facts live in the process-wide status registry, so a test that must see
 * none starts its run at another timestamp.
 */
async function startRun(harness: Harness, rootTs = ROOT_TS): Promise<void> {
  await harness.deliver({ ts: rootTs, text: `${OPS} Investigate the flaky build.` });
  assert.equal(harness.jobs.length, 1);
  assert.ok(harness.jobs[0]?.runId, 'admitted through the canonical lane');
  assert.equal((await harness.pending()).length, 1);
}

async function stopRecordOf(harness: Harness, id = ROOT_ID) {
  return (await harness.pending()).find((job) => job.id === id)?.stop;
}

test('covers AE2: "@Agent Stop please!" stops the run without queueing a turn', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.deliver({
      ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: `${OPS} Stop please!`,
    });

    assert.equal(harness.jobs.length, 1, 'the stop is never handed to the relay');
    const pending = await harness.pending();
    assert.deepEqual(pending.map(({ id }) => id), [ROOT_ID], 'no TurnJob for the stop');
    assert.deepEqual(
      { ...pending[0]!.stop, stoppedAt: undefined },
      {
        schemaVersion: 1, role: 'stopped', source: 'typed', stopperUserId: 'U2',
        cutoffTs: '1800000010.000100', stoppedAt: undefined,
      },
    );
    assert.deepEqual(harness.posts, [], 'the stop note is the stopped ending\'s, not admission\'s');
    assert.deepEqual(harness.reactions, [], 'a stop gets no mid-run 👀');
  });
});

test('covers AE2: a stop word inside a sentence is an ordinary mid-run message', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.deliver({
      ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: "don't stop the migration halfway",
    });

    assert.equal(harness.jobs.length, 2);
    assert.equal(harness.jobs[1]?.turn.text, "don't stop the migration halfway");
    assert.equal(await stopRecordOf(harness), undefined);
    assert.equal((await harness.pending()).length, 2);
    assert.deepEqual(harness.reactions, ['1800000010.000100:eyes'], 'it gets the mid-run 👀 (R12)');
  });
});

test('"stop" with nothing undelivered in the thread is an ordinary message', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.stores.slackState.markTurnDelivered!(ROOT_ID);
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, text: 'stop' });

    assert.equal(harness.jobs.length, 2);
    assert.equal(harness.jobs[1]?.turn.text, 'stop');
    const pending = await harness.pending();
    assert.deepEqual(pending.map(({ id }) => id), ['msg:C1:1800000010.000100']);
    assert.equal(pending[0]?.stop, undefined);
  });
});

test('a Slack retry and the mention fan-out of one stop record one stop', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    const stop = { ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: 'cancel' };
    await harness.deliver(stop);
    const first = await stopRecordOf(harness);
    assert.equal(first?.role, 'stopped');

    await harness.deliver(stop);
    await harness.deliver({ ...stop, eventId: 'EvFanOut' });
    assert.deepEqual(await stopRecordOf(harness), first);
    assert.equal(harness.jobs.length, 1);
    assert.equal((await harness.pending()).length, 1);
  });
});

test('covers AE5: "status" answers only the asker from the run facts and leaves the run alone', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    const now = Date.now();
    defaultSlackStatusRegistry.saveRunFacts(ROOT_ID, {
      startedAt: now - 42 * 60_000,
      step: 'Running the test suite…',
      progressAt: now - 12 * 60_000,
      milestones: 0,
    });
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: 'status' });

    assert.equal(harness.jobs.length, 1, 'the check-in is never queued');
    assert.deepEqual((await harness.pending()).map(({ id }) => id), [ROOT_ID]);
    assert.equal(await stopRecordOf(harness), undefined);
    assert.equal(harness.posts.length, 1);
    const [reply] = harness.posts;
    assert.equal(reply?.operation, 'chat.postEphemeral');
    assert.equal(reply?.input.channel, 'C1');
    assert.equal(reply?.input.user, 'U2');
    assert.equal(reply?.input.thread_ts, ROOT_TS);
    assert.match(String(reply?.input.text), /Current step: Running the test suite…/);
    assert.match(String(reply?.input.text), /No new progress for 10\+ minutes/);
    assert.match(String(reply?.input.text), /Running for 42 minutes/);

    // A retry of the same check-in answers nothing more.
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: 'status' });
    assert.equal(harness.posts.length, 1);
  });
});

test('a check-in before the run has any facts says what the state store knows', async () => {
  await withHarness(async (harness) => {
    await startRun(harness, '1800000500.000100');
    await harness.deliver({ ts: '1800000510.000100', threadTs: '1800000500.000100', text: 'Still working?' });

    assert.equal(harness.jobs.length, 1);
    assert.equal(harness.posts.length, 1);
    assert.equal(harness.posts[0]?.input.text, "Queued. This hasn't started yet.");
  });
});

test('covers AE9: a plain "stop" answers the sender\'s pending browser step; "cancel" stops the run', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    const action = await createBrowserAction(harness.stores.settings, {
      workspaceId: 'T1', channelId: 'C1', threadTs: ROOT_TS, agentId: 'agent_ops',
      actorSlackUserId: 'U1', actorMembershipId: harness.ownerMembershipId,
      loginId: `wl_${'a'.repeat(32)}`, host: 'billing.example.com', url: 'https://billing.example.com/plan',
      title: 'Plan', ref: 'e3', role: 'button', name: 'Confirm change', occurrence: 0, action: 'click',
      description: 'click "Confirm change"', now: Date.now(),
    });
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, text: 'stop' });

    assert.equal((await getBrowserAction(harness.stores.settings, action.id))?.status, 'consumed');
    assert.equal(harness.jobs.length, 2, 'the browser reply reaches the Agent as today');
    assert.equal(await stopRecordOf(harness), undefined, 'the run continues');

    await harness.deliver({ ts: '1800000020.000100', threadTs: ROOT_TS, text: 'cancel' });
    assert.equal(harness.jobs.length, 2);
    assert.equal((await stopRecordOf(harness))?.role, 'stopped');
  });
});

test('another person\'s plain "stop" does not answer the requester\'s browser step; it stops the run', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    const action = await createBrowserAction(harness.stores.settings, {
      workspaceId: 'T1', channelId: 'C1', threadTs: ROOT_TS, agentId: 'agent_ops',
      actorSlackUserId: 'U1', actorMembershipId: harness.ownerMembershipId,
      loginId: `wl_${'a'.repeat(32)}`, host: 'billing.example.com', url: 'https://billing.example.com/plan',
      title: 'Plan', ref: 'e3', role: 'button', name: 'Confirm change', occurrence: 0, action: 'click',
      description: 'click "Confirm change"', now: Date.now(),
    });
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: 'stop' });

    assert.equal((await getBrowserAction(harness.stores.settings, action.id))?.status, 'pending');
    assert.equal(harness.jobs.length, 1);
    const stop = await stopRecordOf(harness);
    assert.equal(stop?.role === 'stopped' && stop.stopperUserId, 'U2');
  });
});

test('covers AE4: a stop from someone who may not use the thread\'s Agent gets a private note only', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    // The Agent lost its place in the Channel mid-run: nobody may talk to it there.
    await harness.stores.config.deleteAgentChannelGrant('T1', 'C1', 'agent_ops');
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: 'stop' });

    assert.equal(await stopRecordOf(harness), undefined, 'the run continues');
    assert.equal(harness.jobs.length, 1);
    assert.deepEqual(harness.posts, [{
      operation: 'chat.postEphemeral',
      input: {
        channel: 'C1', user: 'U2', thread_ts: ROOT_TS,
        text: "You can't stop this run. Only people who can use this Agent here can stop it.",
      },
    }]);

    // A retry posts no second note; a sentence is not a stop and stays silent.
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: 'stop' });
    await harness.deliver({ ts: '1800000020.000100', threadTs: ROOT_TS, user: 'U2', text: 'please stop and think' });
    assert.equal(harness.posts.length, 1);
  });
});

test('a guest\'s stop keeps today\'s silence and leaves the run alone', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U3', text: 'stop' });

    assert.equal(await stopRecordOf(harness), undefined);
    assert.equal(harness.jobs.length, 1);
    assert.deepEqual(harness.posts, []);
  });
});

const PRIVATE = '<!subteam^SPRIV|@priv>';

/** A private Agent: with no Channel grant, only its creator (U1) may use it. */
async function createPrivateAgent(harness: Harness): Promise<void> {
  await harness.stores.config.createAgent({
    id: 'agent_private', name: 'priv', instructions: '', enabled: true, lifecycle: 'active',
    model: 'local-stub/steering',
    creatorMembershipId: harness.ownerMembershipId, editPolicy: 'creator_and_admins',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: 'priv', normalizedHandle: 'priv', desiredState: 'active',
      health: 'healthy', userGroupId: 'SPRIV',
      avatar: { kind: 'generated', revision: 1, seed: 'priv' },
    },
  });
}

test('a stop addressed to another Agent hands the thread over and never stops the private Agent\'s run (R3)', async () => {
  await withHarness(async (harness) => {
    await createPrivateAgent(harness);
    const rootTs = '1800000300.000100';
    await harness.deliver({
      channel: 'G1', channelType: 'mpim', ts: rootTs, text: `<@UBOT> ${PRIVATE} Summarize the report.`,
    });
    assert.equal(harness.jobs.length, 1);
    assert.equal(harness.jobs[0]?.assignment.agentId, 'agent_private');

    // U2 may not use the private Agent; "@Chickpea stop" routes to Chickpea.
    await harness.deliver({
      channel: 'G1', channelType: 'mpim', ts: '1800000310.000100', threadTs: rootTs, user: 'U2',
      text: '<@UBOT> stop',
    });
    const root = (await harness.pending()).find((job) => job.id === `msg:G1:${rootTs}`);
    assert.equal(root?.stop, undefined, 'the private Agent\'s run continues');
    assert.equal(harness.jobs.length, 2, 'the message is today\'s handoff turn');
    assert.equal(harness.jobs[1]?.assignment.agentId, 'agent_chickpea');
    assert.deepEqual(harness.posts, []);
    assert.deepEqual(harness.reactions, [], 'a handoff gets no mid-run 👀 either');
  });
});

test('a stop addressed to the running Agent, or to Chickpea in its own thread, still stops the run', async () => {
  await withHarness(async (harness) => {
    await createPrivateAgent(harness);
    const privateRoot = '1800000400.000100';
    await harness.deliver({
      channel: 'G1', channelType: 'mpim', ts: privateRoot, text: `<@UBOT> ${PRIVATE} Summarize the report.`,
    });
    await harness.deliver({
      channel: 'G1', channelType: 'mpim', ts: '1800000410.000100', threadTs: privateRoot,
      text: `<@UBOT> ${PRIVATE} stop`,
    });
    const privateStop = (await harness.pending()).find((job) => job.id === `msg:G1:${privateRoot}`)?.stop;
    assert.equal(privateStop?.role === 'stopped' && privateStop.stopperUserId, 'U1', 'its creator stops it');

    const chickpeaRoot = '1800000500.000100';
    await harness.deliver({
      channel: 'G1', channelType: 'mpim', ts: chickpeaRoot, text: '<@UBOT> Draft the plan.',
    });
    assert.equal(harness.jobs.at(-1)?.assignment.agentId, 'agent_chickpea');
    await harness.deliver({
      channel: 'G1', channelType: 'mpim', ts: '1800000510.000100', threadTs: chickpeaRoot, user: 'U2',
      text: '<@UBOT> stop',
    });
    const chickpeaStop = (await harness.pending()).find((job) => job.id === `msg:G1:${chickpeaRoot}`)?.stop;
    assert.equal(chickpeaStop?.role === 'stopped' && chickpeaStop.stopperUserId, 'U2');
    assert.equal(harness.jobs.length, 2, 'neither stop is queued');
  });
});

test('a top-level DM stop stops the sender\'s one running DM thread', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ channel: 'D1', ts: '1800000100.000100', text: `${OPS} Summarize the report.` });
    assert.equal(harness.jobs.length, 1);
    await harness.deliver({ channel: 'D1', ts: '1800000110.000100', text: 'stop' });

    assert.equal(harness.jobs.length, 1, 'never queued as a turn');
    const pending = await harness.pending();
    assert.deepEqual(pending.map(({ id }) => id), ['msg:D1:1800000100.000100']);
    assert.equal(pending[0]?.stop?.role, 'stopped');
    assert.equal(pending[0]?.stop?.role === 'stopped' && pending[0].stop.cutoffTs, '1800000110.000100');
    assert.deepEqual(harness.posts, []);
  });
});

test('a top-level DM stop with two running threads, or none, gets a hint in a reply', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ channel: 'D1', ts: '1800000100.000100', text: `${OPS} Summarize the report.` });
    await harness.deliver({ channel: 'D1', ts: '1800000200.000100', text: `${OPS} Draft the plan.` });
    assert.equal(harness.jobs.length, 2);
    await harness.deliver({ channel: 'D1', ts: '1800000210.000100', text: 'stop' });

    assert.equal(harness.jobs.length, 2);
    assert.ok((await harness.pending()).every((job) => job.stop === undefined));
    assert.deepEqual(harness.posts, [{
      operation: 'chat.postMessage',
      input: {
        channel: 'D1', thread_ts: '1800000210.000100',
        text: 'More than one of your conversations here is running. Reply "stop" or "status" in the thread you mean.',
      },
    }]);

    for (const job of await harness.pending()) await harness.stores.slackState.markTurnDelivered!(job.id);
    await harness.deliver({ channel: 'D1', ts: '1800000220.000100', text: 'status' });
    assert.equal(harness.jobs.length, 2);
    assert.equal(harness.posts[1]?.input.text, 'Nothing is running for you here right now.');
    assert.equal(harness.posts[1]?.input.thread_ts, '1800000220.000100');
  });
});

test('"status" in a DM thread is answered with a threaded reply', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ channel: 'D1', ts: '1800000100.000100', text: `${OPS} Summarize the report.` });
    const now = Date.now();
    defaultSlackStatusRegistry.saveRunFacts('msg:D1:1800000100.000100', {
      startedAt: now - 90 * 60_000, step: 'Reading the report…', progressAt: now - 60_000, milestones: 0,
    });
    await harness.deliver({
      channel: 'D1', ts: '1800000110.000100', threadTs: '1800000100.000100', text: 'any update?',
    });

    assert.equal(harness.jobs.length, 1);
    assert.equal(harness.posts.length, 1);
    assert.equal(harness.posts[0]?.operation, 'chat.postMessage');
    assert.equal(harness.posts[0]?.input.thread_ts, '1800000100.000100');
    assert.equal(harness.posts[0]?.input.text, [
      'Still working on this.',
      '• Current step: Reading the report…',
      '• Last progress under 5 minutes ago',
      '• Running for 1 hour 30 minutes',
    ].join('\n'));
  });
});

test('the Node path stops, checks in and adds the mid-run 👀 the same way', async () => {
  // Admission wakes Node's relay (after an ordinary message, and after a new
  // stop); the relay's side is tests/node-turn-relay-stop.test.ts. Keep this
  // process's relay stopped so no wake runs a turn under these assertions.
  await stopNodeTurnRelay();
  await withHarness(async (harness) => {
    // Admit the run through the Cloudflare lane, then steer it through Node's.
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    await startRun(harness);
    Reflect.deleteProperty(globalThis, 'navigator');

    const now = Date.now();
    defaultSlackStatusRegistry.saveRunFacts(ROOT_ID, {
      startedAt: now - 40 * 60_000, step: 'Searching the logs…', progressAt: now - 31 * 60_000, milestones: 0,
    });
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, text: 'how’s it going?' });
    assert.match(String(harness.posts[0]?.input.text), /No new progress for 30\+ minutes/);

    await harness.deliver({ ts: '1800000015.000100', threadTs: ROOT_TS, text: 'Also check the nightly job.' });
    assert.deepEqual(harness.reactions, ['1800000015.000100:eyes'], 'a mid-run message gets 👀 (R12)');

    await harness.deliver({ ts: '1800000020.000100', threadTs: ROOT_TS, text: 'halt' });
    const pending = await harness.pending();
    assert.deepEqual(pending.map(({ id }) => id), [ROOT_ID, 'msg:C1:1800000015.000100']);
    assert.equal((await stopRecordOf(harness))?.role, 'stopped');
    assert.equal(pending[1]?.stop?.role, 'held', 'the unread message waits for the stopped ending');
  }, { target: 'node' });
});

test('the legacy lane (no canonical admission) decides a stop and a check-in after its claims', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: '<!subteam^SPLAIN|@plain> Investigate the flaky build.' });
    assert.equal(harness.jobs.length, 1);
    assert.equal(harness.jobs[0]?.runId, undefined, 'admitted through the legacy lane');

    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: 'status?' });
    assert.equal(harness.posts.length, 1);
    assert.equal(harness.posts[0]?.operation, 'chat.postEphemeral');

    await harness.deliver({ ts: '1800000020.000100', threadTs: ROOT_TS, user: 'U2', text: 'Abort!' });
    assert.equal(harness.jobs.length, 1);
    assert.deepEqual((await harness.pending()).map(({ id }) => id), [ROOT_ID]);
    const stop = await stopRecordOf(harness);
    assert.equal(stop?.role === 'stopped' && stop.cutoffTs, '1800000020.000100');
  });
});

test('a steered canonical admission holds its claims and writes no Run, TurnJob or presentation', () => {
  const db = openStateDb(':memory:');
  try {
    const slack = new SlackStateLogic(db, () => 1_800_000_000_000);
    const stop = { created: true, headId: 'turn_head' };
    const calls: string[] = [];
    const input = {
      evtKey: 'evt:stop',
      msgKey: 'msg:stop',
      threadKey: 'T1:C1:1800000000.000100',
      admission: {},
      turnJob: { id: 'msg:stop' },
      steering: {
        kind: 'stop' as const, threadKey: 'T1:C1:1800000000.000100', source: 'typed' as const,
        stopperUserId: 'U2', cutoffTs: '1800000010.000100',
      },
      presentation: {},
    };
    const work = {
      admitShadowRunInTransaction() { calls.push('work'); return { run: {} }; },
    };
    const turnJobs = {
      steerInTransaction(request: unknown, enqueue?: unknown) {
        calls.push('steer');
        assert.equal(slack.claim('evt:stop'), false, 'decided after the event claim');
        assert.equal(slack.claim('msg:stop'), false, 'decided after the message claim');
        assert.deepEqual(request, input.steering);
        assert.equal(enqueue, undefined, 'the canonical TurnJob is enqueued only on `enqueue`');
        return { outcome: 'stopped', stop };
      },
      enqueueInTransaction() { calls.push('enqueue'); return true; },
    };
    const presentations = { createInTransaction() { calls.push('presentation'); } };

    assert.deepEqual(
      slack.admitCanonical(input as never, work as never, turnJobs as never, presentations as never),
      { claimed: true, steered: { outcome: 'stopped', stop } },
    );
    assert.deepEqual(calls, ['steer']);
    assert.equal(slack.claim('evt:stop'), false, 'a Slack retry is a duplicate');
    assert.equal(slack.claim('msg:stop'), false);
    assert.equal(slack.has('T1:C1:1800000000.000100'), false);

    // A thread with nothing to steer admits the message in the same transaction.
    calls.length = 0;
    turnJobs.steerInTransaction = () => {
      calls.push('steer');
      return { outcome: 'enqueue', undelivered: false } as never;
    };
    const admitted = slack.admitCanonical(
      { ...input, evtKey: 'evt:plain', msgKey: 'msg:plain', turnJob: { id: 'msg:plain', runId: 'run_plain' } } as never,
      {
        admitShadowRunInTransaction() {
          calls.push('work');
          return {
            run: { id: 'run_plain', executionAuthority: 'legacy', fencingToken: 0 },
            binding: { id: 'binding_plain', generation: 1 },
          };
        },
      } as never,
      turnJobs as never,
      presentations as never,
    );
    assert.equal(admitted.claimed, true);
    assert.equal('steered' in admitted, false);
    assert.deepEqual(calls, ['steer', 'work', 'enqueue', 'presentation']);
  } finally {
    db.close();
  }
});

test('the running DM thread lookup keys only the sender\'s undelivered runs in that DM', async () => {
  const state = new SqliteSlackStateStore(':memory:');
  try {
    const job = (channelId: string, threadTs: string, messageTs: string, userId: string) => ({
      id: `msg:${channelId}:${messageTs}`,
      evtKey: `evt:${messageTs}`,
      msgKey: `msg:${channelId}:${messageTs}`,
      turn: {
        workspaceId: 'T1', channelId, userId, text: 'Work on it.', eventId: `Ev${messageTs}`,
        messageTs, threadTs, sessionThreadTs: 'dm', source: 'dm_message', channelType: 'im',
        contextMode: 'thread',
      },
      assignment: { runtimeContract: 'chickpea-v1', agentId: 'agent_ops', agent: { id: 'agent_ops' } },
    }) as unknown as TurnJob;
    await state.enqueueTurn!(job('D1', '1800000100.000100', '1800000100.000100', 'U1'));
    await state.enqueueTurn!(job('D1', '1800000100.000100', '1800000105.000100', 'U1'));
    await state.enqueueTurn!(job('D10', '1800000150.000100', '1800000150.000100', 'U1'));
    await state.enqueueTurn!(job('D1', '1800000160.000100', '1800000160.000100', 'U9'));
    const query = { workspaceId: 'T1', channelId: 'D1', requesterUserId: 'U1' };
    assert.deepEqual(await state.runningDirectThreads!(query), ['T1:D1:1800000100.000100']);

    await state.enqueueTurn!(job('D1', '1800000200.000100', '1800000200.000100', 'U1'));
    assert.deepEqual(await state.runningDirectThreads!(query), [
      'T1:D1:1800000100.000100', 'T1:D1:1800000200.000100',
    ]);

    await state.markTurnDelivered!('msg:D1:1800000100.000100');
    await state.markTurnDelivered!('msg:D1:1800000105.000100');
    assert.deepEqual(await state.runningDirectThreads!(query), ['T1:D1:1800000200.000100']);
    assert.deepEqual(
      await state.runningDirectThreads!({ ...query, requesterUserId: 'U2' }),
      [],
    );
  } finally {
    state.close();
  }
});
