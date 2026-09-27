import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { SlackInteractionProgress, SlackInteractionProgressPatch } from '../src/config/state-rpc.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { SlackInteractionIntent } from '../src/slack/interaction-intent.ts';
import { runTurn, type RunTurnOptions } from '../src/slack/run-turn.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import {
  executeTurnJob,
  removeDroppedReceipts,
  type TurnExecutionOptions,
  type TurnExecutionPorts,
} from '../src/slack/turn-executor.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic, type PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * 👀 on mid-run messages (U8, R12, KTD9): a message posted while its
 * thread's run is in progress gets Chickpea's 👀 at admission, recorded as a
 * receipt on its own TurnJob; its queued turn reuses that receipt and removes
 * it when it finishes, a stop that drops the message removes it, and nothing
 * ever removes a 👀 Chickpea did not add.
 */

const ROOT_TS = '1800000000.000100';
const ROOT_ID = `msg:C1:${ROOT_TS}`;
const MID_TS = '1800000010.000100';
const MID_ID = `msg:C1:${MID_TS}`;
const OPS = '<!subteam^SOPS|@ops>';
const PLAIN = '<!subteam^SPLAIN|@plain>';
const BOT = 'UBOT';

const USERS: Record<string, Record<string, unknown>> = {
  U1: { id: 'U1', team_id: 'T1', name: 'Owner' },
  U2: { id: 'U2', team_id: 'T1', name: 'Teammate' },
};

function platformError(error: string) {
  return { code: ErrorCode.PlatformError, data: { ok: false, error } };
}

/** Slack reactions per person, as Slack keeps them: a remove takes only the caller's own. */
class Reactions {
  readonly log: string[] = [];
  private readonly users = new Map<string, Set<string>>();

  constructor(private readonly mode: () => 'ok' | 'refused' = () => 'ok') {}

  react(user: string, ts: string, name: string): void {
    const key = `${ts}:${name}`;
    this.users.set(key, new Set([...(this.users.get(key) ?? []), user]));
  }

  on(ts: string, name = 'eyes'): string[] {
    return [...(this.users.get(`${ts}:${name}`) ?? [])].sort();
  }

  add(input: Record<string, unknown>, error: (code: string) => unknown): Record<string, unknown> {
    const key = `${String(input.timestamp)}:${String(input.name)}`;
    this.log.push(`add ${key}`);
    if (this.mode() === 'refused') throw error('too_many_reactions');
    const users = this.users.get(key) ?? new Set<string>();
    if (users.has(BOT)) throw error('already_reacted');
    users.add(BOT);
    this.users.set(key, users);
    return { ok: true };
  }

  remove(input: Record<string, unknown>, error: (code: string) => unknown): Record<string, unknown> {
    const key = `${String(input.timestamp)}:${String(input.name)}`;
    this.log.push(`remove ${key}`);
    const users = this.users.get(key);
    if (!users?.has(BOT)) throw error('no_reaction');
    users.delete(BOT);
    return { ok: true };
  }
}

// ── admission ──────────────────────────────────────────────────────────

interface Harness {
  stores: AppStores;
  jobs: TurnJob[];
  reactions: Reactions;
  refuseReactions(): void;
  /** Runs while Slack is still adding a 👀: the add lands after it. */
  whileAdding(hook: (() => Promise<void>) | undefined): void;
  deliver(message: { ts: string; text: string; user?: string; threadTs?: string }): Promise<void>;
  pending(): Promise<PendingTurnJob[]>;
  receiptOf(id: string): Promise<SlackInteractionProgress['acknowledgment']>;
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
    await stores.config.createAgent({
      id: 'agent_ops', name: 'ops', instructions: '', enabled: true, lifecycle: 'active',
      model: 'local-stub/midrun',
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
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: BOT,
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

    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: BOT, bindingId: 'binding1' };
    const channel = {
      id: 'C1', name: 'ops', is_channel: true, is_private: false, is_member: true, is_archived: false,
    };
    let refused = false;
    let whileAdding: (() => Promise<void>) | undefined;
    const reactions = new Reactions(() => refused ? 'refused' : 'ok');
    const gatewayError = (operation: string) => (code: string) =>
      new SlackTransportError(operation, code, { effectOutcome: 'failed' });
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
        if (operation === 'conversations.info') return { channel };
        if (operation === 'conversations.members') return { members: ['U1', 'U2', BOT] };
        if (operation === 'users.conversations') return { channels: [channel] };
        if (operation === 'reactions.add') {
          await whileAdding?.();
          return reactions.add(input, gatewayError(operation));
        }
        if (operation === 'reactions.remove') return reactions.remove(input, gatewayError(operation));
        if (operation === 'chat.postMessage' || operation === 'chat.postEphemeral') {
          return { ok: true, ts: '1900000000.000001', channel: input.channel };
        }
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    const jobs: TurnJob[] = [];
    const pending = () => stores.slackState.listPendingTurns!();
    await run({
      stores,
      jobs,
      reactions,
      refuseReactions() { refused = true; },
      whileAdding(hook) { whileAdding = hook; },
      async deliver(message) {
        assert.equal(await processGatewaySlackEnvelope({
          workspaceId: 'T1',
          eventId: `Ev${message.ts.replace('.', '')}`,
          eventTime: Math.floor(Number(message.ts)),
          event: {
            type: 'message',
            channel: 'C1',
            channel_type: 'channel',
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
      pending,
      async receiptOf(id) {
        return (await pending()).find((job) => job.id === id)?.progress.slackInteraction?.acknowledgment;
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

const RECEIPT = {
  channelId: 'C1', messageTs: MID_TS, name: 'eyes', created: true, cleanup: 'pending', reaction: 'seen_mid_run',
} as const;

test('a message posted during a run gets 👀 on its own timestamp and a receipt on its TurnJob', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${OPS} Investigate the flaky build.` });
    assert.ok(harness.jobs[0]?.runId, 'admitted through the canonical lane');
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, user: 'U2', text: 'Also check the nightly job.' });

    assert.deepEqual(harness.reactions.log, [`add ${MID_TS}:eyes`], 'one 👀, on the mid-run message only');
    assert.deepEqual(harness.reactions.on(MID_TS), [BOT]);
    assert.deepEqual(await harness.receiptOf(MID_ID), RECEIPT);
    assert.equal(await harness.receiptOf(ROOT_ID), undefined, 'the running turn keeps its own progress');
    assert.equal(harness.jobs.length, 2, 'the message is queued as its own turn (release 1)');
  });
});

test('a message with no run in progress gets no admission reaction', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${OPS} Investigate the flaky build.` });
    assert.deepEqual(harness.reactions.log, [], 'the thread\'s first message has nothing to wait for');

    await harness.stores.slackState.markTurnDelivered!(ROOT_ID);
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, text: 'Thanks, one more thing.' });
    assert.deepEqual(harness.reactions.log, []);
    assert.equal(await harness.receiptOf(MID_ID), undefined);
    assert.equal(harness.jobs.length, 2);
  });
});

test('a mention of a different Agent gets no admission reaction', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${OPS} Investigate the flaky build.` });
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, text: `${PLAIN} can you take this one?` });

    assert.equal(harness.jobs.length, 2);
    assert.equal(harness.jobs[1]?.assignment.agentId, 'agent_plain', 'the thread is handed over');
    assert.deepEqual(harness.reactions.log, []);
    assert.equal(await harness.receiptOf(MID_ID), undefined);
  });
});

test('a stop and a check-in get no admission reaction', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${OPS} Investigate the flaky build.` });
    await harness.deliver({ ts: '1800000005.000100', threadTs: ROOT_TS, user: 'U2', text: 'status' });
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, user: 'U2', text: 'stop' });

    assert.deepEqual(harness.reactions.log, []);
    assert.equal(harness.jobs.length, 1, 'neither is queued');
  });
});

test('the legacy lane records the receipt with its enqueue and adds the same 👀', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${PLAIN} Investigate the flaky build.` });
    assert.equal(harness.jobs[0]?.runId, undefined, 'admitted through the legacy lane');
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, user: 'U2', text: 'Also check the nightly job.' });

    assert.deepEqual(harness.reactions.log, [`add ${MID_TS}:eyes`]);
    assert.deepEqual(await harness.receiptOf(MID_ID), RECEIPT);
  });
});

test('a person\'s 👀 on the message stays theirs: Chickpea adds and records only its own', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${OPS} Investigate the flaky build.` });
    harness.reactions.react('U2', MID_TS, 'eyes');
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, user: 'U2', text: 'Also check the nightly job.' });

    assert.deepEqual(harness.reactions.on(MID_TS), ['U2', BOT]);
    assert.deepEqual(await harness.receiptOf(MID_ID), RECEIPT, 'the receipt is Chickpea\'s own 👀');
  });
});

test('a 👀 Slack says Chickpea already shows, or refuses, is corrected to a receipt nothing removes', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${OPS} Investigate the flaky build.` });
    harness.reactions.react(BOT, MID_TS, 'eyes');
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, user: 'U2', text: 'Also check the nightly job.' });
    assert.deepEqual(await harness.receiptOf(MID_ID), { ...RECEIPT, created: false, cleanup: 'done' });

    harness.refuseReactions();
    const refusedTs = '1800000020.000100';
    await harness.deliver({ ts: refusedTs, threadTs: ROOT_TS, user: 'U2', text: 'And the weekly one.' });
    assert.deepEqual(await harness.receiptOf(`msg:C1:${refusedTs}`), {
      ...RECEIPT, messageTs: refusedTs, created: false, cleanup: 'done',
    });
    assert.equal(harness.jobs.length, 3, 'a failed reaction never affects the admitted turn');
  });
});

test('a 👀 whose add lands after a stop dropped its message is removed at once (invariant 8)', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${OPS} Investigate the flaky build.` });
    const state = harness.stores.slackState;
    const client = {
      reactions: {
        remove: async (input: Record<string, unknown>) => harness.reactions.remove(input, platformError),
      },
    } as unknown as Pick<WebClient, 'reactions'>;
    // A stop drops the message and its ending removes the 👀 (not there yet:
    // Slack answers no_reaction) while Slack is still adding it.
    harness.whileAdding(async () => {
      assert.equal((await state.steerTurn!({
        kind: 'stop', threadKey: `T1:C1:${ROOT_TS}`, source: 'typed',
        stopperUserId: 'U1', cutoffTs: '1800000020.000100',
      })).outcome, 'stopped');
      const finished = await state.finishTurnStop!(ROOT_ID, 'dropped');
      assert.deepEqual(finished?.rows.map(({ id }) => id), [MID_ID]);
      await removeDroppedReceipts(finished!.rows, client, (id, patch) =>
        state.recordSlackInteractionProgress!(id, patch));
    });
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, user: 'U2', text: 'Also check the nightly job.' });

    assert.deepEqual(harness.reactions.log, [
      `remove ${MID_TS}:eyes`, `add ${MID_TS}:eyes`, `remove ${MID_TS}:eyes`,
    ]);
    assert.deepEqual(harness.reactions.on(MID_TS), [], 'no 👀 stays on a message the stop dropped');
    const view = await state.turnJobView!(MID_ID);
    assert.equal(view.status, 'done');
    assert.equal(view.cleanupPending, undefined, 'its receipt is finished');
  });
});

test('a 👀 whose add lands after its turn already cleared the receipt is removed; a live one stays', async () => {
  await withHarness(async (harness) => {
    await harness.deliver({ ts: ROOT_TS, text: `${OPS} Investigate the flaky build.` });
    const state = harness.stores.slackState;
    harness.whileAdding(async () => {
      await state.recordSlackInteractionProgress!(MID_ID, {
        acknowledgment: { ...RECEIPT, cleanup: 'done' },
      });
    });
    await harness.deliver({ ts: MID_TS, threadTs: ROOT_TS, user: 'U2', text: 'Also check the nightly job.' });
    assert.deepEqual(harness.reactions.on(MID_TS), []);
    assert.deepEqual(await harness.receiptOf(MID_ID), { ...RECEIPT, cleanup: 'done' });

    // Nothing touched this one's receipt meanwhile: its queued turn removes it.
    harness.whileAdding(undefined);
    const liveTs = '1800000020.000100';
    await harness.deliver({ ts: liveTs, threadTs: ROOT_TS, user: 'U2', text: 'And the weekly one.' });
    assert.deepEqual(harness.reactions.on(liveTs), [BOT]);
    assert.deepEqual(await harness.receiptOf(`msg:C1:${liveTs}`), { ...RECEIPT, messageTs: liveTs });
  });
});

// ── the TurnJob store ──────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const THREAD_TS = '1800000000.000100';
const STOPPER = 'U_STOPPER';
const UID = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ABORTED = { outcome: 'aborted' as const, settledAt: NOW, failureKind: 'agent' as const };

function channelTurn(messageTs: string, text = 'Do the work'): NormalizedSlackTurn {
  return {
    workspaceId: 'T_MID', channelId: 'C_MID', eventId: `Ev_${messageTs}`,
    text, userId: 'U_MEMBER', messageTs, threadTs: THREAD_TS,
    source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel',
  };
}

function midAssignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_MID', channelId: 'C_MID', agentId: 'agent_mid', model: 'local-stub/midrun',
    modelAttribution: { source: 'pinned', providerId: 'local-stub' },
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_mid', kind: 'user', revision: 1, name: 'Mid', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
}

function job(id: string, messageTs: string, receipt = true): TurnJob {
  return {
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`,
    turn: channelTurn(messageTs), assignment: midAssignment(),
    ...(receipt ? { midRunReceipt: { channelId: 'C_MID', messageTs, name: 'eyes' } } : {}),
  };
}

function midReceipt(messageTs: string) {
  return {
    channelId: 'C_MID', messageTs, name: 'eyes', created: true, cleanup: 'pending', reaction: 'seen_mid_run',
  } as const;
}

test('a receipt is written only for its own message, and a stop\'s dropped rows carry theirs', () => {
  const db = openStateDb(':memory:');
  try {
    const turns = new TurnJobStoreLogic(db, () => NOW);
    turns.enqueue(job('head', '1800000000.000101', false));
    turns.enqueue(job('unread_1', '1800000000.000102'));
    turns.enqueue(job('unread_2', '1800000000.000103'));
    // A receipt naming another message is never Chickpea's to remove here.
    turns.enqueue({ ...job('forged', '1800000000.000104'), midRunReceipt: {
      channelId: 'C_MID', messageTs: '1800000000.000101', name: 'eyes',
    } });
    assert.equal(turns.getProgress('head')?.slackInteraction, undefined);
    assert.deepEqual(turns.getProgress('unread_1')?.slackInteraction, {
      acknowledgment: midReceipt('1800000000.000102'),
    });
    assert.equal(turns.getProgress('forged')?.slackInteraction, undefined);

    // Chickpea did not create the second one's 👀 (Slack already showed it).
    turns.recordSlackInteractionProgress('unread_2', {
      acknowledgment: { ...midReceipt('1800000000.000103'), created: false, cleanup: 'done' },
    });
    assert.equal(turns.steer({
      kind: 'stop', threadKey: `T_MID:C_MID:${THREAD_TS}`, source: 'typed',
      stopperUserId: STOPPER, cutoffTs: '1800000000.000110',
    }).outcome, 'stopped');
    const finished = turns.finishStop('head', 'dropped');
    assert.deepEqual(finished?.rows.map((row) => ({ id: row.id, receipt: row.receipt })), [
      { id: 'unread_1', receipt: { channelId: 'C_MID', messageTs: '1800000000.000102', name: 'eyes' } },
      { id: 'unread_2', receipt: undefined },
      { id: 'forged', receipt: undefined },
    ]);
  } finally { db.close(); }
});

// ── the stopped ending ─────────────────────────────────────────────────

function pendingOf(turns: TurnJobStoreLogic, id: string): PendingTurnJob {
  const view = turns.runnerView(id);
  assert.equal(view.status, 'pending');
  return view.job!;
}

function stopExecutor(turns: TurnJobStoreLogic, script: (options: RunTurnOptions) => Promise<void>) {
  const reactions = new Reactions();
  const calls: string[] = [];
  const client = {
    conversations: { info: async () => ({ ok: true, channel: { id: 'C_MID', is_member: true } }) },
    chat: { postEphemeral: async () => ({ ok: true, message_ts: '1800000000.000900' }) },
    reactions: {
      add: async (input: Record<string, unknown>) => reactions.add(input, platformError),
      remove: async (input: Record<string, unknown>) => reactions.remove(input, platformError),
    },
  } as unknown as WebClient;
  const traced = <K extends keyof TurnJobStoreLogic>(name: K) =>
    (...args: unknown[]) => {
      calls.push(`${String(name)}(${String(args[0])})`);
      return (turns[name] as (...values: unknown[]) => unknown).apply(turns, args);
    };
  const ports = {
    env: {},
    turnJobs: {
      recordAttempt: traced('recordAttempt'),
      markRecoveryRequired: traced('markRecoveryRequired'),
      prepareFlueDispatch: traced('prepareFlueDispatch'),
      reconcileFlueExistingInstance: traced('reconcileFlueExistingInstance'),
      recordFlueReceipt: traced('recordFlueReceipt'),
      recordFlueSettlement: traced('recordFlueSettlement'),
      recordPullRequest: traced('recordPullRequest'),
      freezeRuntimePlan: traced('freezeRuntimePlan'),
      getBoundRuntimePlan: traced('getBoundRuntimePlan'),
      recordUsagePersistence: () => undefined,
      recordInteractionIntent: traced('recordInteractionIntent'),
      recordSlackInteractionProgress: traced('recordSlackInteractionProgress'),
      markDelivered: traced('markDelivered'),
      markError: traced('markError'),
      finishStop: traced('finishStop'),
    },
    slack: {
      setActiveWork: () => undefined,
      markCodingActiveWork: () => undefined,
      isCodingActiveWork: () => false,
      release: () => undefined,
    },
    config: {},
    presentationState: {},
    telemetry: { capture: () => undefined },
    resolveInstallation: async () => ({ workspaceId: 'T_MID', client }),
    sandboxes: () => [],
    runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
      await script(options);
    },
  } as unknown as TurnExecutionPorts;
  const options: TurnExecutionOptions = {
    latency: { lane: 'cloudflare', executor: 'runner' },
    onRetry: () => undefined,
  };
  return { ports, options, reactions, calls };
}

/** Freeze, prepare and admit the row's Flue dispatch, as a running turn has. */
function dispatch(turns: TurnJobStoreLogic, queued: TurnJob): void {
  turns.freezeRuntimePlan(queued.id, compileRuntimePlanV2({
    turn: queued.turn, assignment: queued.assignment, instructions: 'Help.', memoryEpoch: 1,
  }));
  turns.prepareFlueDispatch(queued.id, 'Do the work', { generation: queued.id });
  turns.recordFlueReceipt(queued.id, {
    submissionId: `sub_${queued.id}`, acceptedAt: '2026-09-26T12:00:00.000Z', uid: UID,
  });
}

/** A running head with two mid-run messages (each with its 👀 receipt) behind it, then a stop. */
function stoppedThread() {
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => NOW);
  const head = job('head', '1800000000.000101', false);
  turns.enqueue(head);
  turns.enqueue(job('unread_1', '1800000000.000102'));
  turns.enqueue(job('unread_2', '1800000000.000103'));
  dispatch(turns, head);
  assert.equal(turns.steer({
    kind: 'stop', threadKey: `T_MID:C_MID:${THREAD_TS}`, source: 'typed',
    stopperUserId: STOPPER, cutoffTs: '1800000000.000110',
  }).outcome, 'stopped');
  return { db, turns };
}

test('a stop removes the 👀 of the messages it dropped, each on its own timestamp, and records it', async () => {
  const { db, turns } = stoppedThread();
  try {
    turns.recordFlueSettlement('head', ABORTED);
    const h = stopExecutor(turns, async (options) => {
      const facts = await options.stopEnding!.finish();
      assert.equal(facts?.unread, 2);
      await options.onDelivered?.('stopped');
    });
    // Admission added both, and a teammate reacted 👀 to the second as well.
    h.reactions.react(BOT, '1800000000.000102', 'eyes');
    h.reactions.react(BOT, '1800000000.000103', 'eyes');
    h.reactions.react('U_MEMBER', '1800000000.000103', 'eyes');
    assert.equal(await executeTurnJob(pendingOf(turns, 'head'), h.ports, h.options), true);

    assert.deepEqual(h.reactions.log, [
      'remove 1800000000.000102:eyes',
      'remove 1800000000.000103:eyes',
    ]);
    assert.deepEqual(h.reactions.on('1800000000.000102'), []);
    assert.deepEqual(h.reactions.on('1800000000.000103'), ['U_MEMBER'], 'the person\'s 👀 stays');
    for (const [id, ts] of [['unread_1', '1800000000.000102'], ['unread_2', '1800000000.000103']] as const) {
      assert.deepEqual(turns.getProgress(id)?.slackInteraction?.acknowledgment, {
        ...midReceipt(ts), cleanup: 'done',
      }, `${id}'s receipt is finished`);
    }
    const finish = h.calls.indexOf('finishStop(head)');
    const delivered = h.calls.indexOf('markDelivered(head)');
    assert.ok(finish >= 0 && delivered > finish, h.calls.join(' '));
  } finally { db.close(); }
});

test('a dropped row whose 👀 removal fails keeps its receipt pending for the repair sweep', async () => {
  const { db, turns } = stoppedThread();
  try {
    turns.recordFlueSettlement('head', ABORTED);
    const h = stopExecutor(turns, async (options) => {
      await options.stopEnding!.finish();
      await options.onDelivered?.('stopped');
    });
    const client = (await h.ports.resolveInstallation('T_MID')).client as unknown as {
      reactions: { remove: (input: Record<string, unknown>) => Promise<unknown> };
    };
    const remove = client.reactions.remove;
    client.reactions.remove = async (input) => {
      if (input.timestamp === '1800000000.000102') throw new Error('socket hang up');
      return remove(input);
    };
    h.reactions.react(BOT, '1800000000.000103', 'eyes');
    assert.equal(await executeTurnJob(pendingOf(turns, 'head'), h.ports, h.options), true);

    assert.deepEqual(turns.getProgress('unread_1')?.slackInteraction?.acknowledgment,
      midReceipt('1800000000.000102'));
    assert.equal(turns.getProgress('unread_2')?.slackInteraction?.acknowledgment?.cleanup, 'done');
    assert.deepEqual(turns.listPendingSlackInteractionCleanups().map(({ id }) => id), ['unread_1'],
      'the delivered row is left to the durable cleanup');
  } finally { db.close(); }
});

test('rows a stop released keep their 👀 until their own turn finishes', async () => {
  const { db, turns } = stoppedThread();
  try {
    // The run finished before the stop took effect (R22).
    turns.recordFlueSettlement('head', {
      outcome: 'completed', settledAt: NOW,
      result: {
        text: 'Done.', requestedModel: null, returnedModel: null, reportedUsage: null,
        usageCompleteness: 'not_reported',
      },
    });
    const h = stopExecutor(turns, async (options) => {
      await options.onDelivered?.('succeeded');
    });
    h.reactions.react(BOT, '1800000000.000102', 'eyes');
    assert.equal(await executeTurnJob(pendingOf(turns, 'head'), h.ports, h.options), true);

    assert.deepEqual(h.reactions.log, []);
    assert.equal(turns.runnerView('unread_1').job?.stop?.role, 'released');
    assert.deepEqual(turns.getProgress('unread_1')?.slackInteraction?.acknowledgment,
      midReceipt('1800000000.000102'));
  } finally { db.close(); }
});

// ── the queued turn ────────────────────────────────────────────────────

const assignment = midAssignment();
const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-midrun-'));
const statePath = join(stateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const config = new SqliteConfigStore(statePath, { agents: [] });
  await config.createAgent(assignment.agent);
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: BOT,
  });
  await config.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  config.close();
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

function queuedTurnClient(reactions: Reactions) {
  return {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    reactions: {
      add: async (input: Record<string, unknown>) => reactions.add(input, platformError),
      remove: async (input: Record<string, unknown>) => reactions.remove(input, platformError),
    },
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
      replies: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      postMessage: async () => ({ ok: true, channel: 'C_MID', ts: '1800000000.000500' }),
      update: async () => ({ ok: true }),
      startStream: async () => ({ ok: true, ts: '1800000000.000501' }),
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
}

async function runQueuedTurn(
  turn: NormalizedSlackTurn,
  reactions: Reactions,
  acknowledgment: NonNullable<SlackInteractionProgress['acknowledgment']>,
): Promise<SlackInteractionProgressPatch[]> {
  const patches: SlackInteractionProgressPatch[] = [];
  await runTurn(turn, assignment, undefined, {
    client: queuedTurnClient(reactions),
    replayText: 'Checked the nightly job too.',
    interactionProgress: { acknowledgment },
    onInteractionProgress: (patch) => { patches.push(patch); },
    usageRecordingEnabled: false,
  });
  return patches;
}

test('the queued turn adds no second 👀 and removes the recorded one when it finishes', async () => {
  const ts = '1800000000.000201';
  const intents: SlackInteractionIntent[] = [
    { disposition: 'work', reason: 'substantive_request', checklist: ['Nightly job result'] },
    { disposition: 'reply', reason: 'substantive_request' },
  ];
  for (const interactionIntent of intents) {
    const reactions = new Reactions();
    reactions.react(BOT, ts, 'eyes');
    reactions.react('U_MEMBER', ts, 'eyes');
    const patches = await runQueuedTurn(
      { ...channelTurn(ts, 'Also check the nightly job.'), interactionIntent },
      reactions,
      midReceipt(ts),
    );
    assert.deepEqual(reactions.log, [`remove ${ts}:eyes`], interactionIntent.disposition);
    assert.deepEqual(reactions.on(ts), ['U_MEMBER'], 'a person\'s 👀 is never removed');
    assert.deepEqual(patches.at(-1)?.acknowledgment, { ...midReceipt(ts), cleanup: 'done' });
  }
});

test('a receipt Chickpea did not create is never removed by the queued turn', async () => {
  const ts = '1800000000.000202';
  const reactions = new Reactions();
  reactions.react(BOT, ts, 'eyes');
  await runQueuedTurn(
    { ...channelTurn(ts), interactionIntent: { disposition: 'work', reason: 'substantive_request', checklist: ['Result'] } },
    reactions,
    { ...midReceipt(ts), created: false, cleanup: 'done' },
  );
  assert.deepEqual(reactions.log, [], 'no second 👀 and no removal');
  assert.deepEqual(reactions.on(ts), [BOT]);
});

test('the classifier\'s `seen` on the same message is its answer, so the 👀 stays', async () => {
  const ts = '1800000000.000203';
  const reactions = new Reactions();
  reactions.react(BOT, ts, 'eyes');
  const patches = await runQueuedTurn(
    {
      ...channelTurn(ts, 'noted'),
      interactionIntent: { disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'trigger' },
    },
    reactions,
    midReceipt(ts),
  );
  assert.deepEqual(reactions.log, [`add ${ts}:eyes`], 'Slack already shows it: the answer adopts the 👀');
  assert.deepEqual(reactions.on(ts), [BOT]);
  assert.deepEqual(patches.at(-1)?.acknowledgment, { ...midReceipt(ts), cleanup: 'done' });

  // A different answer on the message still clears the admission 👀.
  const other = '1800000000.000204';
  const next = new Reactions();
  next.react(BOT, other, 'eyes');
  await runQueuedTurn(
    {
      ...channelTurn(other, 'thanks'),
      interactionIntent: { disposition: 'react_only', reason: 'midwork_ack', reaction: 'midwork_seen', target: 'trigger' },
    },
    next,
    midReceipt(other),
  );
  assert.deepEqual(next.log, [`add ${other}:ballot_box_with_check`, `remove ${other}:eyes`]);
  assert.deepEqual(next.on(other), []);
  assert.deepEqual(next.on(other, 'ballot_box_with_check'), [BOT]);
});
