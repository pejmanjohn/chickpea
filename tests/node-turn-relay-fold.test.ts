import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { closeNodeStateStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import {
  SqliteSlackStateStore,
  slackSessionGenerationFromTimestamp,
  type SlackStateStore,
} from '../src/slack/claim-store.ts';
import { wakeNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import type { RunTurnOptions } from '../src/slack/run-turn.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { turnStopThreadKey } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

/**
 * Node parity for follow-ups (steering A): the Node relay runs its own copy
 * of the executor, which forwards the same store claim to `runTurn`; the
 * rows a run took settle with it and never run, exactly as on a Cloudflare
 * thread runner (tests/slack-thread-runner-execution.test.ts).
 */

const UID = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BOT = 'U_CHICKPEA';

const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-node-fold-'));
const statePath = join(stateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const config = new SqliteConfigStore(statePath, agentRoutineDeletion, { agents: [] });
  const assignment = nodeAssignment();
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
  closeNodeStateStores();
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

function nodeAssignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_NODEFOLD', channelId: 'C_NODEFOLD', agentId: 'agent_nodefold', model: 'local-stub/node',
    modelAttribution: { source: 'pinned', providerId: 'local-stub' },
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_nodefold', kind: 'user', revision: 1, name: 'Node', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
}

/** One Slack thread per test: the relay's per-thread loops are process-wide. */
function slackThread(rootTs: string) {
  const [seconds] = rootTs.split('.');
  const ts = (suffix: string) => `${seconds}.000${suffix}`;
  const job = (id: string, suffix: string): TurnJob => ({
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`,
    turn: {
      workspaceId: 'T_NODEFOLD', channelId: 'C_NODEFOLD', eventId: `Ev_${id}`,
      text: `Message ${suffix}`, userId: 'U_MEMBER', messageTs: ts(suffix), threadTs: rootTs,
      source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel',
      interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
    },
    assignment: nodeAssignment(),
  });
  return { rootTs, ts, job, threadKey: turnStopThreadKey(job('root', '100').turn, nodeAssignment()) };
}

type SlackThread = ReturnType<typeof slackThread>;

/** Admit a message as Node's Slack admission does, with its mid-run 👀 when asked. */
async function admit(state: SlackStateStore, thread: SlackThread, queued: TurnJob, midRun = false) {
  const admission = prepareSlackShadowAdmission({
    turn: queued.turn, assignment: queued.assignment, sourceVisibility: 'public', admittedAt: Date.now(),
  });
  const admitted = await state.admitCanonical({
    evtKey: queued.evtKey,
    msgKey: queued.msgKey,
    threadKey: `thread:${thread.rootTs}`,
    admission,
    turnJob: { ...queued, runId: admission.run.id, executionAuthority: admission.run.executionAuthority },
    ...(midRun
      ? {
          midRun: {
            threadKey: thread.threadKey,
            receipt: { channelId: 'C_NODEFOLD', messageTs: queued.turn.messageTs, name: 'eyes' },
          },
        }
      : {}),
    presentation: {
      schemaVersion: 3,
      root: { workspaceId: 'T_NODEFOLD', channelId: 'C_NODEFOLD', threadTs: thread.rootTs, requesterUserId: 'U_MEMBER' },
      owner: { kind: 'chickpea' },
      sessionGeneration: slackSessionGenerationFromTimestamp(queued.turn.messageTs),
    },
  });
  assert.equal(admitted.claimed, true);
  return admission.run.id;
}

type Script = (options: RunTurnOptions, turn: NormalizedSlackTurn) => Promise<void>;

/** The real Node state store behind the real relay, with Slack and `runTurn` scripted. */
function relayHarness() {
  const state = new SqliteSlackStateStore(':memory:');
  const work = new SqliteWorkStore(':memory:');
  const reactions: string[] = [];
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }), setTitle: async () => ({ ok: true }) } },
    conversations: {
      info: async () => ({ ok: true, channel: { id: 'C_NODEFOLD', is_member: true } }),
      history: async () => ({ ok: true, messages: [] }),
      replies: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      postMessage: async () => ({ ok: true, channel: 'C_NODEFOLD', ts: '1800009999.000001' }),
      postEphemeral: async () => ({ ok: true, message_ts: '1800009998.000001' }),
      update: async () => ({ ok: true }),
    },
    reactions: {
      add: async () => ({ ok: true }),
      remove: async (value: Record<string, unknown>) => {
        reactions.push(`remove ${String(value.timestamp)}:${String(value.name)}`);
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const scripts = new Map<string, Script>();
  const runs: string[] = [];
  const executeTurn = async (
    turn: NormalizedSlackTurn,
    _assignment: ResolvedAssignment,
    _env: unknown,
    options: RunTurnOptions,
  ) => {
    runs.push(options.turnId!);
    const script = scripts.get(options.turnId!);
    if (script) return script(options, turn);
    await options.onDelivered?.('succeeded');
  };
  const overrides = { state, work, client, executeTurn: executeTurn as never };
  return {
    state,
    work,
    reactions,
    scripts,
    runs,
    wake: () => wakeNodeTurnRelay(undefined, overrides as never),
    close() {
      state.close();
      work.close();
    },
  };
}

/** What `runTurn` does: claim the follow-ups, then freeze, prepare, dispatch and settle. */
async function runClaiming(
  options: RunTurnOptions,
  turn: NormalizedSlackTurn,
  outcome: 'completed' | 'failed',
): Promise<string[]> {
  const claim = await options.claimFold!({ phase: 'start', headId: options.turnId! });
  await options.onRuntimePlan!(compileRuntimePlanV2({
    turn, assignment: nodeAssignment(), instructions: 'Help.', memoryEpoch: 1,
  }));
  await options.flueDispatch!.prepare('Do the work', { generation: options.turnId! });
  await options.flueDispatch!.recordReceipt({
    submissionId: `sub_${options.turnId}`, acceptedAt: new Date().toISOString(), uid: UID,
  });
  await options.flueDispatch!.recordSettlement(outcome === 'completed'
    ? {
        outcome, settledAt: Date.now(),
        result: { text: 'Done.', requestedModel: null, returnedModel: null, reportedUsage: null, usageCompleteness: 'not_reported' },
      }
    : { outcome, settledAt: Date.now(), failureKind: 'provider' });
  await options.onDelivered?.(outcome === 'completed' ? 'succeeded' : 'failed');
  return claim.messages.map((message) => message.turnJobId);
}

async function statusOf(state: SlackStateStore, id: string) {
  return (await state.turnJobView!(id)).status;
}

test('a burst on Node runs once: the follow-ups settle without running, their records close, and their 👀 go', async () => {
  const h = relayHarness();
  const thread = slackThread('1800000700.000100');
  try {
    const head = thread.job('nf1_head', '101');
    await admit(h.state, thread, head);
    const memberRuns = [
      await admit(h.state, thread, thread.job('nf1_m1', '102'), true),
      await admit(h.state, thread, thread.job('nf1_m2', '103'), true),
    ];
    const taken: string[][] = [];
    h.scripts.set(head.id, async (options, turn) => {
      taken.push(await runClaiming(options, turn, 'completed'));
    });
    await h.wake();

    assert.deepEqual(h.runs, [head.id], 'one run');
    assert.deepEqual(taken, [['nf1_m1', 'nf1_m2']]);
    for (const id of [head.id, 'nf1_m1', 'nf1_m2']) assert.equal(await statusOf(h.state, id), 'done', id);
    for (const runId of memberRuns) {
      const presentation = await h.state.getRunPresentation!(runId);
      assert.equal(presentation?.schemaVersion === 3 && presentation.lifecyclePhase, 'settled');
    }
    await h.wake();
    assert.deepEqual(h.reactions, [`remove ${thread.ts('102')}:eyes`, `remove ${thread.ts('103')}:eyes`]);
    assert.deepEqual(await h.state.listPendingSlackInteractionCleanups!(), []);
  } finally { h.close(); }
});

test('a failed head on Node releases its follow-ups, which then run once as one turn', async () => {
  const h = relayHarness();
  const thread = slackThread('1800000800.000100');
  try {
    const head = thread.job('nf2_head', '101');
    await admit(h.state, thread, head);
    await admit(h.state, thread, thread.job('nf2_m1', '102'), true);
    await admit(h.state, thread, thread.job('nf2_m2', '103'), true);
    const taken: string[][] = [];
    h.scripts.set(head.id, async (options, turn) => {
      taken.push(await runClaiming(options, turn, 'failed'));
    });
    h.scripts.set('nf2_m1', async (options, turn) => {
      taken.push(await runClaiming(options, turn, 'completed'));
    });
    await h.wake();

    assert.deepEqual(h.runs, [head.id, 'nf2_m1']);
    assert.deepEqual(taken, [['nf2_m1', 'nf2_m2'], ['nf2_m2']]);
    for (const id of [head.id, 'nf2_m1', 'nf2_m2']) assert.equal(await statusOf(h.state, id), 'done', id);
  } finally { h.close(); }
});

