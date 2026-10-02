import assert from 'node:assert/strict';
import { test } from 'node:test';

import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { parseSlackAgentSessionStopped } from '../src/slack/types.ts';
import { withDirectSlackInstall } from './helpers/direct-slack-install.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * Slack's Stop button (U7, KTD5): an `agent_session_stopped` event from the
 * working indicator of a thread's Agent Session stops that thread's run, as
 * a typed stop would, when the person who pressed it may talk to its Agent.
 */

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

interface Press {
  eventTs: string;
  user?: string;
  channel?: string;
  threadTs?: string;
  eventId?: string;
  /** Replaces the whole event, for malformed deliveries. */
  event?: Record<string, unknown>;
}

interface Harness {
  stores: AppStores;
  jobs: TurnJob[];
  posts: SlackPost[];
  /** Agent Session status writes (`agents.sessions.setStatus`), in order. */
  sessions: Array<Record<string, unknown>>;
  /** Make the next Agent Session status writes fail. */
  failSessions(): void;
  /** `steering.stop_button` tokens logged, in order. */
  tokens: unknown[];
  deliver(message: {
    ts: string;
    text: string;
    user?: string;
    channel?: string;
    threadTs?: string;
    eventId?: string;
    /** Slack's `app_mention` event (it carries no `channel_type`) instead of a `message`. */
    appMention?: boolean;
    /** A `message` event's `channel_type`; by default `im` for a D… channel, else `channel`. */
    channelType?: string;
  }): Promise<void>;
  press(press: Press): Promise<void>;
  pending(): Promise<Awaited<ReturnType<NonNullable<AppStores['slackState']['listPendingTurns']>>>>;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousInfo = console.info;
  closeNodeStateStores();
  const stores = resolveStores();
  const tokens: unknown[] = [];
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
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1',
    });
    await stores.config.putChannel({
      workspaceId: 'T1', channelId: 'C1', label: 'ops', lifecycle: 'active',
    }, 0);
    await stores.config.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: 'agent_ops', status: 'active',
      createdByMembershipId: owner.membership.id, channelLabel: 'ops', channelIsPrivate: false,
    }, 0);

    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const channel = {
      id: 'C1', name: 'ops', is_channel: true, is_private: false, is_member: true, is_archived: false,
    };
    const posts: SlackPost[] = [];
    const sessions: Array<Record<string, unknown>> = [];
    let sessionsFail = false;
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
        if (operation === 'agents.sessions.setStatus') {
          sessions.push(input);
          if (sessionsFail) throw new Error('gateway unavailable for T1 C1 U1');
          return { ok: true };
        }
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    console.info = (...args: unknown[]) => {
      if (args[0] === '[chickpea] steering.stop_button') tokens.push(args[1]);
    };
    const jobs: TurnJob[] = [];
    const execution = {
      stores,
      // As the state store's gateway drain does: write the row (a canonical
      // admission already did, and this is then a no-op).
      enqueueTurn: async (job: TurnJob) => {
        jobs.push(job);
        await stores.slackState.enqueueTurn!(job);
        return { ok: true as const, value: null };
      },
    };
    await run({
      stores,
      jobs,
      posts,
      sessions,
      failSessions() { sessionsFail = true; },
      tokens,
      async deliver(message) {
        const channelId = message.channel ?? 'C1';
        const direct = channelId.startsWith('D');
        const posted = {
          channel: channelId,
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
            : { type: 'message', channel_type: message.channelType ?? (direct ? 'im' : 'channel'), ...posted },
        }, undefined, gateway, execution), 'accepted');
      },
      async press(press) {
        assert.equal(await processGatewaySlackEnvelope({
          workspaceId: 'T1',
          eventId: press.eventId ?? `EvStop${press.eventTs.replace('.', '')}`,
          eventTime: Math.floor(Number(press.eventTs)),
          event: (press.event ?? {
            type: 'agent_session_stopped',
            channel: press.channel ?? 'C1',
            thread_ts: press.threadTs ?? ROOT_TS,
            user: press.user ?? 'U1',
            event_ts: press.eventTs,
            streaming_message_ts: [],
          }) as never,
        }, undefined, gateway, execution), 'accepted');
      },
      async pending() {
        return stores.slackState.listPendingTurns!();
      },
    });
  } finally {
    console.info = previousInfo;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
}

/** Start a run: the Agent's thread root, admitted and still undelivered. */
async function startRun(harness: Harness, rootTs = ROOT_TS, channel = 'C1'): Promise<void> {
  const before = harness.jobs.length;
  await harness.deliver({ ts: rootTs, channel, text: `${OPS} Investigate the flaky build.` });
  assert.equal(harness.jobs.length, before + 1);
  assert.ok(harness.jobs.at(-1)?.runId, 'admitted through the canonical lane');
}

async function stopRecordOf(harness: Harness, id = ROOT_ID) {
  return (await harness.pending()).find((job) => job.id === id)?.stop;
}

test('an eligible person pressing Stop stops the thread\'s run at the press, without a turn', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });

    assert.equal(harness.jobs.length, 1, 'the press is never handed to the relay');
    const pending = await harness.pending();
    assert.deepEqual(pending.map(({ id }) => id), [ROOT_ID]);
    assert.deepEqual({ ...pending[0]!.stop, stoppedAt: undefined }, {
      schemaVersion: 1, role: 'stopped', source: 'button', stopperUserId: 'U2',
      cutoffTs: '1800000010.000100', stoppedAt: undefined,
    }, 'the press\'s own Slack timestamp is the cutoff');
    assert.deepEqual(harness.posts, [], 'the stop note is the stopped ending\'s');
    assert.deepEqual(harness.tokens, []);
  });
});

test('a press in a DM thread stops that thread\'s run', async () => {
  await withHarness(async (harness) => {
    await startRun(harness, '1800000100.000100', 'D1');
    await harness.press({ channel: 'D1', threadTs: '1800000100.000100', eventTs: '1800000110.000100' });

    const [job] = await harness.pending();
    assert.equal(job?.id, 'msg:D1:1800000100.000100');
    assert.equal(job?.stop?.role === 'stopped' && job.stop.source, 'button');
    assert.deepEqual(harness.posts, []);
  });
});

test('a press in a group DM stops its thread\'s run, as a mention there is admitted', async () => {
  await withHarness(async (harness) => {
    // Group DMs deliver only `app_mention` (no message.mpim subscription),
    // with no channel_type: admission and the press both take the G… id as a
    // Channel, where the thread's Chickpea needs no grant.
    const rootTs = '1800000300.000100';
    await harness.deliver({ channel: 'G1', ts: rootTs, text: '<@UBOT> Draft the plan.', appMention: true });
    assert.equal(harness.jobs.length, 1);
    assert.equal(harness.jobs[0]?.assignment.agentId, 'agent_chickpea');
    await harness.press({ channel: 'G1', threadTs: rootTs, eventTs: '1800000310.000100', user: 'U2' });

    const stop = (await harness.pending()).find((job) => job.id === `msg:G1:${rootTs}`)?.stop;
    assert.equal(stop?.role === 'stopped' && stop.source, 'button');
    assert.equal(stop?.role === 'stopped' && stop.stopperUserId, 'U2');
    assert.deepEqual(harness.posts, []);
    assert.deepEqual(harness.tokens, []);
  });
});

test('a press on a thread without an Agent route is ignored and logs no_route', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.press({ threadTs: '1800000900.000100', eventTs: '1800000910.000100' });

    assert.equal(await stopRecordOf(harness), undefined, 'the other thread\'s run continues');
    assert.deepEqual(harness.posts, []);
    assert.deepEqual(harness.tokens, [{ outcome: 'no_route' }]);
  });
});

test('a press with nothing running, or an unreadable event, does nothing and logs a token', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.stores.slackState.markTurnDelivered!(ROOT_ID);
    await harness.press({ eventTs: '1800000010.000100' });
    assert.deepEqual(await harness.pending(), []);
    assert.deepEqual(harness.posts, []);
    assert.deepEqual(harness.tokens, [{ outcome: 'no_running_job' }]);
    // Slack leaves the orphaned indicator processing: the app moves it out.
    assert.deepEqual(harness.sessions, [{ channel_id: 'C1', thread_ts: ROOT_TS, status: 'active' }]);

    await startRun(harness, '1800000200.000100');
    await harness.press({
      eventTs: '1800000210.000100',
      event: { type: 'agent_session_stopped', channel: 'C1', user: 'U1', event_ts: '1800000210.000100' },
    });
    await harness.press({
      eventTs: '1800000211.000100',
      event: {
        type: 'agent_session_stopped', channel: 'C1', user: 'U1',
        thread_ts: '1800000200.000100', event_ts: 'not-a-timestamp',
      },
    });
    assert.equal(await stopRecordOf(harness, 'msg:C1:1800000200.000100'), undefined);
    assert.deepEqual(harness.tokens.slice(1), [{ outcome: 'invalid' }, { outcome: 'invalid' }]);
  });
});

test('a failed session write on a press with nothing running is logged without content and never throws', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.stores.slackState.markTurnDelivered!(ROOT_ID);
    harness.failSessions();
    const warnings: unknown[][] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await harness.press({ eventTs: '1800000010.000100', user: 'U2' });
    } finally {
      console.warn = previousWarn;
    }
    assert.equal(harness.sessions.length, 1);
    assert.deepEqual(harness.tokens, [{ outcome: 'no_running_job' }]);
    assert.deepEqual(warnings, [['[chickpea] Stop button could not settle an idle Agent Session']]);
  });
});

test('the idle session settles under the thread\'s Agent persona, as a run\'s settle does', async () => {
  await withHarness(async (harness) => {
    const installation = await harness.stores.config.getWorkspaceInstallation('T1');
    await harness.stores.config.updateWorkspaceInstallation('T1', { health: 'healthy' }, installation!.revision);
    await harness.stores.settings.setSetting('slack.publicUrl', 'https://chickpea.example');
    await startRun(harness);
    await harness.stores.slackState.markTurnDelivered!(ROOT_ID);
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });

    assert.equal(harness.sessions.length, 1);
    const [session] = harness.sessions;
    assert.equal(session?.status, 'active');
    assert.equal(session?.username, 'ops');
    assert.match(String(session?.icon_url), /^https:\/\/chickpea\.example\//);
  });
});

test('a press on a running thread leaves the session to the stopped ending', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });
    assert.equal((await stopRecordOf(harness))?.role, 'stopped');
    assert.deepEqual(harness.sessions, []);
  });
});

test('covers AE4: a press by someone who may not use the thread\'s Agent gets a private note only', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    // The Agent lost its place in the Channel mid-run: nobody may talk to it there.
    await harness.stores.config.deleteAgentChannelGrant('T1', 'C1', 'agent_ops');
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });

    assert.equal(await stopRecordOf(harness), undefined, 'the run continues');
    assert.deepEqual(harness.posts, [{
      operation: 'chat.postEphemeral',
      input: {
        channel: 'C1', user: 'U2', thread_ts: ROOT_TS,
        text: "You can't stop this run. Only people who can use this Agent here can stop it.",
      },
    }]);

    // A Slack retry of the same press posts no second note.
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });
    assert.equal(harness.posts.length, 1);
  });
});

test('after a handoff to Chickpea, a press by someone who may not use the running Agent gets a private note only (R3)', async () => {
  await withHarness(async (harness) => {
    // A private Agent: with no grant anywhere, only its creator (U1) may use it.
    const owner = await harness.stores.config.getAgent('agent_ops');
    await harness.stores.config.createAgent({
      id: 'agent_private', name: 'priv', instructions: '', enabled: true, lifecycle: 'active',
      model: 'local-stub/steering',
      creatorMembershipId: owner!.creatorMembershipId!, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'priv', normalizedHandle: 'priv', desiredState: 'active',
        health: 'healthy', userGroupId: 'SPRIV',
        avatar: { kind: 'generated', revision: 1, seed: 'priv' },
      },
    });
    const rootTs = '1800000300.000100';
    await harness.deliver({
      channel: 'G1', channelType: 'mpim', ts: rootTs, text: '<@UBOT> <!subteam^SPRIV|@priv> Summarize the report.',
    });
    assert.equal(harness.jobs.at(-1)?.assignment.agentId, 'agent_private');
    // U2 hands the thread to Chickpea; the private Agent's run keeps going.
    await harness.deliver({
      channel: 'G1', channelType: 'mpim', ts: '1800000310.000100', threadTs: rootTs, user: 'U2',
      text: '<@UBOT> hi',
    });
    assert.equal(harness.jobs.at(-1)?.assignment.agentId, 'agent_chickpea');

    await harness.press({ channel: 'G1', threadTs: rootTs, eventTs: '1800000320.000100', user: 'U2' });
    const pending = await harness.pending();
    assert.equal(pending.find((job) => job.id === `msg:G1:${rootTs}`)?.stop, undefined, 'the run continues');
    assert.equal(pending.find((job) => job.id === 'msg:G1:1800000310.000100')?.stop, undefined);
    assert.deepEqual(harness.posts, [{
      operation: 'chat.postEphemeral',
      input: {
        channel: 'G1', user: 'U2', thread_ts: rootTs,
        text: "You can't stop this run. Only people who can use this Agent here can stop it.",
      },
    }]);
    assert.deepEqual(harness.sessions, [], 'the session is the running Agent\'s to settle');

    // A Slack retry of the same press posts no second note.
    await harness.press({ channel: 'G1', threadTs: rootTs, eventTs: '1800000320.000100', user: 'U2' });
    assert.equal(harness.posts.length, 1);
  });
});

/**
 * Runs that end while a presser is checked against them: before the `n`-th
 * stop decided through the state store, the rows listed for `n` are
 * delivered. Returns how many were decided.
 */
function deliverBeforeSteering(
  harness: Harness,
  rows: Record<number, readonly string[]>,
): () => number {
  const state = harness.stores.slackState;
  const steer = state.steerTurn!.bind(state);
  let decided = 0;
  state.steerTurn = async (request, enqueue) => {
    if (request.kind !== 'message') {
      decided += 1;
      for (const id of rows[decided] ?? []) await state.markTurnDelivered!(id);
    }
    return await steer(request, enqueue);
  };
  return () => decided;
}

test('a press whose run, another Agent\'s after a handoff, ends while the presser is checked settles the idle session', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.deliver({ ts: '1800000005.000100', threadTs: ROOT_TS, user: 'U2', text: '<@UBOT> hi' });
    assert.equal(harness.jobs.at(-1)?.assignment.agentId, 'agent_chickpea');
    // The Agent's run, and the handoff turn behind it, finish during U2's check.
    const decided = deliverBeforeSteering(harness, { 2: [ROOT_ID, 'msg:C1:1800000005.000100'] });
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });

    assert.equal(decided(), 2, 'decided again once, bound to the Agent whose run it was');
    assert.deepEqual(await harness.pending(), []);
    assert.deepEqual(harness.posts, []);
    assert.deepEqual(harness.tokens, [{ outcome: 'no_running_job' }], 'as with nothing running');
    assert.deepEqual(harness.sessions, [{ channel_id: 'C1', thread_ts: ROOT_TS, status: 'active' }]);

    // A Slack retry of the same press is a duplicate.
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });
    assert.equal(decided(), 2);
    assert.equal(harness.tokens.length, 1);
    assert.equal(harness.sessions.length, 1);
  });
});

test('a press whose thread\'s run moves on to a third Agent while it is decided is refused, never applied unchecked', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    // The thread passes to Chickpea, back to the Agent, and to Chickpea again.
    await harness.deliver({ ts: '1800000005.000100', threadTs: ROOT_TS, user: 'U2', text: '<@UBOT> hi' });
    await harness.deliver({ ts: '1800000006.000100', threadTs: ROOT_TS, user: 'U2', text: `${OPS} again` });
    await harness.deliver({ ts: '1800000007.000100', threadTs: ROOT_TS, user: 'U2', text: '<@UBOT> back' });
    assert.deepEqual(
      harness.jobs.map((job) => job.assignment.agentId),
      ['agent_ops', 'agent_chickpea', 'agent_ops', 'agent_chickpea'],
    );
    // Each time the stop is decided again, the run it was bound to is over
    // and the next row is another Agent's.
    const decided = deliverBeforeSteering(harness, { 2: [ROOT_ID], 3: ['msg:C1:1800000005.000100'] });
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });

    assert.equal(decided(), 3, 'decided again twice at most');
    const stops = (await harness.pending()).map((job) => job.stop);
    assert.deepEqual(stops, [undefined, undefined], 'the third run is not stopped');
    assert.deepEqual(harness.posts, [{
      operation: 'chat.postEphemeral',
      input: {
        channel: 'C1', user: 'U2', thread_ts: ROOT_TS,
        text: "You can't stop this run. Only people who can use this Agent here can stop it.",
      },
    }]);
    assert.deepEqual(harness.sessions, [], 'the session is the running Agent\'s to settle');
    assert.deepEqual(harness.tokens, []);
  });
});

test('a guest\'s press keeps Chickpea\'s silence toward guests and leaves the run alone', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.press({ eventTs: '1800000010.000100', user: 'U3' });

    assert.equal(await stopRecordOf(harness), undefined);
    assert.deepEqual(harness.posts, []);
    assert.deepEqual(harness.tokens, [{ outcome: 'not_allowed' }]);
  });
});

test('a repeated press, a Slack retry and a typed stop for the same run record one stop', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });
    const first = await stopRecordOf(harness);
    assert.equal(first?.role === 'stopped' && first.source, 'button');

    await harness.press({ eventTs: '1800000010.000100', user: 'U2' });
    await harness.press({ eventTs: '1800000012.000100', user: 'U1' });
    await harness.deliver({ ts: '1800000015.000100', threadTs: ROOT_TS, text: 'stop' });
    assert.deepEqual(await stopRecordOf(harness), first, 'the first stop stands');
    assert.equal(harness.jobs.length, 1, 'the typed stop is not queued either');
    assert.deepEqual((await harness.pending()).map(({ id }) => id), [ROOT_ID]);
  });
});

test('a press after a typed stop leaves the typed stop standing', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    await harness.deliver({ ts: '1800000010.000100', threadTs: ROOT_TS, user: 'U2', text: 'stop' });
    const typed = await stopRecordOf(harness);
    assert.equal(typed?.role === 'stopped' && typed.source, 'typed');

    await harness.press({ eventTs: '1800000012.000100', user: 'U1' });
    assert.deepEqual(await stopRecordOf(harness), typed);
    assert.equal(harness.jobs.length, 1);
    assert.deepEqual(harness.posts, []);
  });
});

test('a message posted before the press is held by the stop; one posted after it runs as a new turn', async () => {
  await withHarness(async (harness) => {
    await startRun(harness);
    // Admitted before the press (the gateway orders them by thread).
    await harness.deliver({ ts: '1800000005.000100', threadTs: ROOT_TS, text: 'Also check the deploy logs.' });
    assert.equal(harness.jobs.length, 2);
    await harness.press({ eventTs: '1800000010.000100' });
    // Posted before the press but admitted after it: still before the cutoff.
    await harness.deliver({ ts: '1800000008.000100', threadTs: ROOT_TS, text: 'And the canary.' });
    // Posted after the press: a new turn once the stopped run has ended.
    await harness.deliver({ ts: '1800000020.000100', threadTs: ROOT_TS, text: 'Now look at the test only.' });

    const stops = Object.fromEntries((await harness.pending()).map((job) => [job.id, job.stop]));
    assert.equal(stops[ROOT_ID]?.role, 'stopped');
    assert.equal(stops['msg:C1:1800000005.000100']?.role, 'held');
    assert.equal(stops['msg:C1:1800000008.000100']?.role, 'held');
    assert.equal(stops['msg:C1:1800000020.000100'], undefined);
    assert.equal(harness.jobs.length, 4, 'the press itself is never a turn');
  });
});

test('a customer-owned app\'s signed Stop event (direct transport) stops the run the same way', async () => {
  // On Node a new stop wakes the relay, which takes it in process (see
  // tests/node-turn-relay-stop.test.ts); the harness keeps this process's
  // relay stopped so no wake runs the stopped turn under these assertions.
  await withDirectSlackInstall({
    signingSecret: 'stop-button-signing-secret',
    botToken: 'xoxb-stop-button',
    answer: (method, form) => method === 'users.info'
      ? {
          ok: true,
          user: {
            deleted: false, is_bot: false, is_app_user: false, is_restricted: false,
            is_ultra_restricted: false, is_stranger: false, ...USERS[form.get('user') ?? ''],
          },
        }
      : method === 'conversations.members'
        ? { ok: true, members: ['U1', 'U2', 'UBOT'], response_metadata: { next_cursor: '' } }
        : undefined,
  }, async ({ stores, ownerMembershipId, calls, deliver }) => {
    await stores.config.createAgent({
      id: 'agent_ops', name: 'ops', instructions: '', enabled: true, lifecycle: 'active',
      model: 'local-stub/steering',
      creatorMembershipId: ownerMembershipId, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'ops', normalizedHandle: 'ops', desiredState: 'active',
        health: 'healthy', userGroupId: 'SOPS',
        avatar: { kind: 'generated', revision: 1, seed: 'ops' },
      },
    });
    await stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'ops', lifecycle: 'active' }, 0);
    await stores.config.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: 'agent_ops', status: 'active',
      createdByMembershipId: ownerMembershipId, channelLabel: 'ops', channelIsPrivate: false,
    }, 0);
    const agent = await stores.config.getAgent('agent_ops');
    await stores.config.putAgentThreadRoute({
      workspaceId: 'T1', channelId: 'C1', threadTs: ROOT_TS, agentId: 'agent_ops',
      agentGeneration: agent!.configurationGeneration ?? agent!.revision, ownerIncarnation: 1,
    }, 0);

    // A running turn in the Agent's thread.
    await stores.slackState.enqueueTurn!({
      id: ROOT_ID, evtKey: `evt:${ROOT_TS}`, msgKey: ROOT_ID,
      turn: {
        workspaceId: 'T1', channelId: 'C1', userId: 'U1', text: 'Investigate the flaky build.',
        eventId: 'EvRoot', messageTs: ROOT_TS, threadTs: ROOT_TS, source: 'app_mention',
        channelType: 'channel', contextMode: 'thread',
      },
      assignment: { runtimeContract: 'chickpea-v1', agentId: 'agent_ops', agent: { id: 'agent_ops' } },
    } as unknown as TurnJob);

    const response = await deliver('events', {
      token: '', team_id: 'T1', api_app_id: 'A1', event_id: 'EvStopDirect', event_time: 1800000010,
      type: 'event_callback',
      event: {
        type: 'agent_session_stopped', channel: 'C1', thread_ts: ROOT_TS, user: 'U2',
        event_ts: '1800000010.000100', streaming_message_ts: [],
      },
    });
    assert.equal(response.status, 200, await response.clone().text());

    // The intake runs past the acknowledgement (detached, as on Cloudflare).
    let stop: unknown;
    for (let tries = 0; tries < 100; tries += 1) {
      stop = (await stores.slackState.listPendingTurns!()).find((job) => job.id === ROOT_ID)?.stop;
      if (stop) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const slackCalls = calls.map(({ method }) => method);
    assert.deepEqual({ ...(stop as Record<string, unknown>), stoppedAt: undefined }, {
      schemaVersion: 1, role: 'stopped', source: 'button', stopperUserId: 'U2',
      cutoffTs: '1800000010.000100', stoppedAt: undefined,
    }, JSON.stringify(slackCalls));
    assert.deepEqual(slackCalls.filter((method) => method.startsWith('chat.')), [], 'nothing posted');
  });
});

test('the Stop event parser keeps only a usable press', () => {
  const event = {
    type: 'agent_session_stopped', channel: 'C1', thread_ts: '1800000000.000100',
    user: 'U2', event_ts: '1800000010.000100', streaming_message_ts: ['1800000001.000100'],
  };
  assert.deepEqual(parseSlackAgentSessionStopped(event), {
    userId: 'U2', channelId: 'C1', threadTs: '1800000000.000100', eventTs: '1800000010.000100',
  });
  for (const broken of [
    undefined, null, 'agent_session_stopped', [],
    { ...event, type: 'message' },
    { ...event, user: undefined },
    { ...event, user: '' },
    { ...event, channel: 'C1:evil' },
    { ...event, channel: 42 },
    { ...event, thread_ts: undefined },
    { ...event, thread_ts: '1800000000' },
    { ...event, event_ts: '1800000010.000100.1' },
  ]) {
    assert.equal(parseSlackAgentSessionStopped(broken), undefined, JSON.stringify(broken));
  }
});
