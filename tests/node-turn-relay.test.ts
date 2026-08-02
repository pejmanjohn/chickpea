import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SqliteSlackStateStore, type SlackStateStore } from '../src/slack/claim-store.ts';
import type { LedgerSlackTurnExecutor } from '../src/slack/ledger-turn-driver.ts';
import { drainNodeTurnRelayOnce, wakeNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import type { WorkStore } from '../src/work/types.ts';

test('a wake admitted during a Node drain starts a follow-up drain immediately', async () => {
  const jobs = [relayJob('first')];
  const executions: string[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const sawFirst = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const state = {
    listPendingTurns: async () => [...jobs],
    freezeRuntimePlan: async (_id: string, runtimePlan: Parameters<typeof deriveRuntimePlanInstanceId>[0]) => ({
      runtimePlan,
      instanceId: deriveRuntimePlanInstanceId(runtimePlan),
      continuityNoticeRequired: false,
    }),
    recordTurnAttempt: async () => true,
    recordInteractionIntent: async () => undefined,
    recordSlackInteractionProgress: async () => undefined,
    listPendingSlackInteractionCleanups: async () => [],
    markTurnDelivered: async (id: string) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index >= 0) jobs.splice(index, 1);
      return true;
    },
    discardTurn: async () => true,
    release: async () => undefined,
  } as unknown as SlackStateStore;
  const options = {
    state,
    work: {} as WorkStore,
    executeTurn: (async (_turn, _assignment, _env, runOptions) => {
      const id = runOptions?.turnId ?? 'missing';
      executions.push(id);
      if (id.endsWith('first')) {
        markFirstStarted();
        await holdFirst;
      }
    }) as LedgerSlackTurnExecutor,
  };
  const firstWake = wakeNodeTurnRelay(undefined, options);
  await sawFirst;
  jobs.push(relayJob('second'));
  const secondWake = wakeNodeTurnRelay(undefined, options);
  releaseFirst();
  await Promise.all([firstWake, secondWake]);

  assert.deepEqual(executions, ['msg_relay_first', 'msg_relay_second']);
  assert.equal(jobs.length, 0);
});

test('the Node relay drains a ledger Run once and tombstones its adapter job', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-ledger-relay-'));
  const path = join(directory, 'state.sqlite');
  const state = new SqliteSlackStateStore(path);
  const work = new SqliteWorkStore(path);
  try {
    const slackTurn = turn();
    const resolvedAssignment = assignment();
    const admission = prepareSlackShadowAdmission({
      turn: slackTurn,
      assignment: resolvedAssignment,
      sourceVisibility: 'public',
      admittedAt: Date.now(),
      executionAuthority: 'ledger',
    });
    const job = {
      id: 'msg_node_ledger_relay',
      evtKey: 'evt_node_ledger_relay',
      msgKey: 'msg_node_ledger_relay',
      turn: slackTurn,
      assignment: resolvedAssignment,
      runId: admission.run.id,
      executionAuthority: 'ledger' as const,
    };
    assert.deepEqual(
      await state.admitCanonical({
        evtKey: job.evtKey,
        msgKey: job.msgKey,
        threadKey: 'thread_node_ledger_relay',
        admission,
        turnJob: job,
      }).then((result) => result.claimed),
      true,
    );

    let executions = 0;
    const executeTurn: LedgerSlackTurnExecutor = async (
      _turn,
      _assignment,
      _env,
      options,
    ) => {
      executions += 1;
      if (!options?.workStore || !options.runId || options.runFencingToken === undefined) {
        throw new Error('Ledger relay did not supply canonical execution context.');
      }
      const lifecycle = new ShadowWorkLifecycle({
        store: options.workStore,
        runId: options.runId as never,
        attemptNumber: options.runFencingToken,
        fencingToken: options.runFencingToken,
        agentName: 'agent_node_relay',
        canonicalModel: 'local-stub/node-relay',
        sensitivity: 'public',
        routeEvidence: {},
        mode: 'enforce',
      });
      await lifecycle.prepareExecution('Prepared input');
      await lifecycle.markInvoked();
      await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'fixture_succeeded' });
      await lifecycle.settleWithoutDelivery({ terminalDisposition: 'no_op' });
    };

    await drainNodeTurnRelayOnce({
      state,
      work,
      client: {} as WebClient,
      executeTurn,
    });
    assert.equal(executions, 1);
    assert.equal((await work.getRun(admission.run.id))?.status, 'settled');
    assert.equal(await state.getPendingTurnByRunId(admission.run.id), undefined);

    await drainNodeTurnRelayOnce({
      state,
      work,
      client: {} as WebClient,
      executeTurn,
    });
    assert.equal(executions, 1, 'the delivered tombstone prevents a second execution');
  } finally {
    state.close();
    work.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('delivered Node turns repair a checklist and remove only their created acknowledgment', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-slack-cleanup-'));
  const path = join(directory, 'state.sqlite');
  const state = new SqliteSlackStateStore(path);
  const work = new SqliteWorkStore(path);
  try {
    const slackTurn = {
      ...turn(),
      interactionIntent: {
        disposition: 'work' as const,
        reason: 'substantive_request' as const,
        checklist: ['Verified artifact'],
      },
    };
    const resolvedAssignment = assignment();
    const admission = prepareSlackShadowAdmission({
      turn: slackTurn,
      assignment: resolvedAssignment,
      sourceVisibility: 'public',
      admittedAt: Date.now(),
      executionAuthority: 'legacy',
    });
    const id = 'msg_node_cleanup';
    await state.admitCanonical({
      evtKey: 'evt_node_cleanup',
      msgKey: id,
      threadKey: 'thread_node_cleanup',
      admission,
      turnJob: {
        id, evtKey: 'evt_node_cleanup', msgKey: id,
        turn: slackTurn, assignment: resolvedAssignment,
        runId: admission.run.id, executionAuthority: 'legacy',
      },
    });
    await state.recordSlackInteractionProgress?.(id, {
      acknowledgment: {
        channelId: 'C_node', messageTs: '100.001', name: 'eyes', created: true,
        cleanup: 'pending',
      },
      checklist: {
        channelId: 'C_node', threadTs: '100.001', messageTs: '100.002',
        cleanup: 'pending',
      },
    });
    await state.markTurnDelivered?.(id);

    const calls: string[] = [];
    const client = {
      chat: {
        update: async () => { calls.push('chat.update'); return { ok: true }; },
      },
      reactions: {
        remove: async () => { calls.push('reactions.remove'); return { ok: true }; },
      },
    } as unknown as WebClient;
    await drainNodeTurnRelayOnce({ state, work, client });

    assert.deepEqual(calls, ['chat.update', 'reactions.remove']);
    assert.deepEqual(await state.listPendingSlackInteractionCleanups?.(), []);
  } finally {
    state.close();
    work.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function turn(): NormalizedSlackTurn {
  return {
    workspaceId: 'T_node', channelId: 'C_node', eventId: 'Ev_node',
    text: 'Run the fixture', userId: 'U_node', messageTs: '100.001', threadTs: '100.001',
    source: 'app_mention', contextMode: 'thread', channelType: 'channel',
  };
}

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_node', channelId: 'C_node', agentId: 'agent_node_relay',
    model: 'local-stub/node-relay',
    agent: {
      id: 'agent_node_relay', name: 'Node relay', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
}

function relayJob(suffix: string) {
  return {
    id: `msg_relay_${suffix}`,
    evtKey: `evt_relay_${suffix}`,
    msgKey: `msg_relay_${suffix}`,
    turn: { ...turn(), eventId: `Ev_${suffix}`, messageTs: `100.${suffix === 'first' ? '001' : '002'}` },
    assignment: assignment(),
    attempts: 0,
    progress: {},
    executionAuthority: 'legacy' as const,
  };
}
