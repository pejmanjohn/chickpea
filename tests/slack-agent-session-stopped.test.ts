import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Hono } from 'hono';

import { channel as slackChannel, processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import { buildSlackAppManifest, slackManifestFingerprint } from '../src/slack/app-manifest.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  stageSlackCredentialBundle,
} from '../src/slack/installation-credentials.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { parseSlackAgentSessionStopped } from '../src/slack/types.ts';
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
  /** `steering.stop_button` tokens logged, in order. */
  tokens: unknown[];
  deliver(message: {
    ts: string;
    text: string;
    user?: string;
    channel?: string;
    threadTs?: string;
    eventId?: string;
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
          return input.channel === 'C1'
            ? { channel }
            : { channel: { id: input.channel, is_im: true, user: 'U1' } };
        }
        if (operation === 'conversations.members') return { members: ['U1', 'U2', 'U3', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [channel] };
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
      tokens,
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
            channel_type: direct ? 'im' : 'channel',
            user: message.user ?? 'U1',
            ts: message.ts,
            text: message.text,
            ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
          },
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
  const envKeys = [
    'TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH',
  ] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-stop-button-'));
  process.env.TAG_DB_PATH = ':memory:';
  process.env.SLACK_STATE_DB_PATH = ':memory:';
  process.env.CHICKPEA_AUTH_DB_PATH = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  const previousFetch = globalThis.fetch;
  const slackCalls: string[] = [];
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
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
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'direct', appId: 'A1', botUserId: 'UBOT', teamId: 'T1',
    });
    await stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'ops', lifecycle: 'active' }, 0);
    await stores.config.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: 'agent_ops', status: 'active',
      createdByMembershipId: owner.membership.id, channelLabel: 'ops', channelIsPrivate: false,
    }, 0);
    const agent = await stores.config.getAgent('agent_ops');
    await stores.config.putAgentThreadRoute({
      workspaceId: 'T1', channelId: 'C1', threadTs: ROOT_TS, agentId: 'agent_ops',
      agentGeneration: agent!.configurationGeneration ?? agent!.revision, ownerIncarnation: 1,
    }, 0);

    // The installation's encrypted credentials, as setup leaves them.
    const signingSecret = 'stop-button-signing-secret';
    const credentials = { state: stores.identity, keyring: loadCredentialKeyring() };
    const manifestFingerprint = slackManifestFingerprint(
      buildSlackAppManifest({ kind: 'workspace_app', origin: 'https://chickpea.example' }),
    );
    const app = await stageSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
      purpose: 'app_credentials', expectedActiveRevision: null, appId: 'A1', manifestFingerprint,
      secrets: { clientId: '123.456', clientSecret: 'client-secret', signingSecret },
    });
    await promoteSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: app.revision, expectedActiveRevision: null,
    });
    const connected = await stageSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
      purpose: 'connected_credentials', expectedActiveRevision: app.revision,
      appId: 'A1', teamId: 'T1', botUserId: 'UBOT', grantedScopes: ['chat:write'], validatedAt: Date.now(),
      manifestFingerprint,
      secrets: { clientId: '123.456', clientSecret: 'client-secret', signingSecret, botToken: 'xoxb-stop-button' },
    });
    await promoteSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: connected.revision,
      expectedActiveRevision: app.revision,
    });

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

    // Slack's Web API, as the direct transport calls it.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = new URL(String(input instanceof Request ? input.url : input)).pathname.split('/').at(-1)!;
      slackCalls.push(method);
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      const body = method === 'users.info'
        ? {
            ok: true,
            user: {
              deleted: false, is_bot: false, is_app_user: false, is_restricted: false,
              is_ultra_restricted: false, is_stranger: false, ...USERS[form.get('user') ?? ''],
            },
          }
        : method === 'conversations.members'
          ? { ok: true, members: ['U1', 'U2', 'UBOT'], response_metadata: { next_cursor: '' } }
          : { ok: true };
      return Response.json(body);
    }) as typeof fetch;

    const payload = JSON.stringify({
      token: '', team_id: 'T1', api_app_id: 'A1', event_id: 'EvStopDirect', event_time: 1800000010,
      type: 'event_callback',
      event: {
        type: 'agent_session_stopped', channel: 'C1', thread_ts: ROOT_TS, user: 'U2',
        event_ts: '1800000010.000100', streaming_message_ts: [],
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const ingress = new Hono();
    ingress.route('/channels/slack', slackChannel.route());
    const response = await ingress.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${payload}`).digest('hex')}`,
      },
      body: payload,
    });
    assert.equal(response.status, 200, await response.clone().text());

    // The intake runs past the acknowledgement (detached, as on Cloudflare).
    let stop: unknown;
    for (let tries = 0; tries < 100; tries += 1) {
      stop = (await stores.slackState.listPendingTurns!()).find((job) => job.id === ROOT_ID)?.stop;
      if (stop) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual({ ...(stop as Record<string, unknown>), stoppedAt: undefined }, {
      schemaVersion: 1, role: 'stopped', source: 'button', stopperUserId: 'U2',
      cutoffTs: '1800000010.000100', stoppedAt: undefined,
    }, JSON.stringify(slackCalls));
    assert.deepEqual(slackCalls.filter((method) => method.startsWith('chat.')), [], 'nothing posted');
  } finally {
    globalThis.fetch = previousFetch;
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
    rmSync(directory, { recursive: true, force: true });
  }
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
