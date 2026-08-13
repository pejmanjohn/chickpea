import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { AgentPromptFailure } from '../src/slack/flue-dispatch.ts';
import {
  SlackIdentityUnavailableError,
  type SlackIdentityExecutionContext,
} from '../src/slack/identity-execution.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SqliteSlackStateStore, type SlackStateStore } from '../src/slack/claim-store.ts';
import type { LedgerSlackTurnExecutor } from '../src/slack/ledger-turn-driver.ts';
import { drainNodeTurnRelayOnce, wakeNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import type { SlackInteractionIntent } from '../src/slack/interaction-intent.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import type { WorkStore } from '../src/work/types.ts';
import { captureSlackIdentityOperationalEvents } from './helpers/slack-identity-observability.ts';

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
    prepareFlueDispatch: async () => { throw new Error('fixture does not dispatch Flue'); },
    reconcileFlueExistingInstance: async () => {
      throw new Error('fixture does not reconcile Flue');
    },
    recordFlueReceipt: async (receipt: unknown) => receipt,
    recordFlueSettlement: async (settlement: unknown) => settlement,
    recordContinuityNotice: async () => undefined,
    matchFlueObservation: async () => undefined,
    markTurnRecoveryRequired: async () => undefined,
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

test('the Node relay serializes queued turns in the same conversation', async () => {
  const jobs = [relayJob('first'), relayJob('second')];
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
    prepareFlueDispatch: async () => { throw new Error('fixture does not dispatch Flue'); },
    reconcileFlueExistingInstance: async () => {
      throw new Error('fixture does not reconcile Flue');
    },
    recordFlueReceipt: async (receipt: unknown) => receipt,
    recordFlueSettlement: async (settlement: unknown) => settlement,
    recordContinuityNotice: async () => undefined,
    matchFlueObservation: async () => undefined,
    markTurnRecoveryRequired: async () => undefined,
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
  const draining = drainNodeTurnRelayOnce({
    state,
    work: {} as WorkStore,
    executeTurn: (async (_turn, _assignment, _env, options) => {
      const id = options?.turnId ?? 'missing';
      executions.push(id);
      if (id.endsWith('first')) {
        markFirstStarted();
        await holdFirst;
      }
    }) as LedgerSlackTurnExecutor,
  });

  await sawFirst;
  await Promise.resolve();
  assert.deepEqual(executions, ['msg_relay_first']);
  releaseFirst();
  await draining;
  assert.deepEqual(executions, ['msg_relay_first', 'msg_relay_second']);
});

test('post-dispatch retries stop in visible recovery state at the bounded ceiling', async () => {
  const job = {
    ...relayJob('reattach'),
    attempts: 7,
    dispatchStartedAt: 1,
    dispatchEnvelope: { idempotencyKey: 'msg_relay_reattach' },
  };
  const recovery: Array<{ id: string; reason: string }> = [];
  const attempts: number[] = [];
  const state = {
    listPendingTurns: async () => [job],
    freezeRuntimePlan: async () => { throw new Error('not reached'); },
    prepareFlueDispatch: async () => { throw new Error('not reached'); },
    reconcileFlueExistingInstance: async () => { throw new Error('not reached'); },
    recordFlueReceipt: async (receipt: unknown) => receipt,
    recordFlueSettlement: async (settlement: unknown) => settlement,
    recordContinuityNotice: async () => undefined,
    matchFlueObservation: async () => undefined,
    markTurnRecoveryRequired: async (id: string, reason: string) => {
      recovery.push({ id, reason });
    },
    recordTurnAttempt: async (_id: string, attempt: number) => {
      attempts.push(attempt);
    },
    recordInteractionIntent: async () => undefined,
    recordSlackInteractionProgress: async () => undefined,
    markTurnDelivered: async () => undefined,
    discardTurn: async () => true,
    release: async () => undefined,
    setActiveWork: async () => undefined,
  } as unknown as SlackStateStore;

  await drainNodeTurnRelayOnce({
    state,
    work: {} as WorkStore,
    executeTurn: (async () => {
      throw new AgentPromptFailure('agent', 503, false, true);
    }) as LedgerSlackTurnExecutor,
  });

  assert.deepEqual(attempts, [8]);
  assert.deepEqual(recovery, [{
    id: job.id,
    reason: 'post_dispatch_attempts_exhausted',
  }]);
});

test('a retained first turn blocks later turns in the same conversation', async () => {
  const first = {
    ...relayJob('first'),
    dispatchStartedAt: 1,
    dispatchEnvelope: { idempotencyKey: 'msg_relay_first' },
  };
  const second = relayJob('second');
  const executions: string[] = [];
  const state = {
    listPendingTurns: async () => [first, second],
    freezeRuntimePlan: async () => { throw new Error('not reached'); },
    prepareFlueDispatch: async () => { throw new Error('not reached'); },
    reconcileFlueExistingInstance: async () => { throw new Error('not reached'); },
    recordFlueReceipt: async (receipt: unknown) => receipt,
    recordFlueSettlement: async (settlement: unknown) => settlement,
    recordContinuityNotice: async () => undefined,
    matchFlueObservation: async () => undefined,
    markTurnRecoveryRequired: async () => undefined,
    recordTurnAttempt: async () => undefined,
    recordInteractionIntent: async () => undefined,
    recordSlackInteractionProgress: async () => undefined,
    markTurnDelivered: async () => undefined,
    discardTurn: async () => true,
    release: async () => undefined,
    setActiveWork: async () => undefined,
  } as unknown as SlackStateStore;

  await drainNodeTurnRelayOnce({
    state,
    work: {} as WorkStore,
    executeTurn: (async (_turn, _assignment, _env, options) => {
      executions.push(options?.turnId ?? 'missing');
      throw new AgentPromptFailure('agent', 503, false, true);
    }) as LedgerSlackTurnExecutor,
  });

  assert.deepEqual(executions, [first.id]);
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
        presentation: {
          root: {
            workspaceId: slackTurn.workspaceId,
            channelId: slackTurn.channelId,
            threadTs: slackTurn.threadTs,
            requesterUserId: slackTurn.userId,
          },
          features: { progressiveStreaming: true, nativeTasks: true },
        },
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
      if (!options?.workStore || !options.runId || options.runFencingToken === undefined ||
          !options.presentationState || options.progressiveAttributionProven !== true) {
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

test('a Node fallback turn is durably relayed without inventing a canonical Run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-fallback-relay-'));
  const path = join(directory, 'state.sqlite');
  const state = new SqliteSlackStateStore(path);
  const work = new SqliteWorkStore(path);
  try {
    const job = relayJob('fallback');
    assert.equal(await state.enqueueTurn(job), true);

    let executionOptions: Parameters<LedgerSlackTurnExecutor>[3];
    await drainNodeTurnRelayOnce({
      state,
      work,
      client: {} as WebClient,
      executeTurn: async (_turn, _assignment, _env, options) => {
        executionOptions = options;
      },
    });

    assert.equal(executionOptions?.turnId, job.id);
    assert.equal(executionOptions?.runId, undefined);
    assert.ok(executionOptions?.flueDispatch, 'fallback execution retains durable Flue state');
    assert.deepEqual(await state.listPendingTurns?.(), []);
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

test('a relay batch isolates one client per referenced Slack identity', async () => {
  const jobs = ['finance', 'legal', 'support'].map((identity, index) => {
    const item = relayJob(identity);
    item.turn.channelId = `C_${identity}`;
    item.turn.threadTs = `100.${index + 10}`;
    item.turn.slackIdentityId = `slack_identity_${identity}`;
    item.assignment.slackIdentityId = `slack_identity_${identity}`;
    return item;
  });
  const state = relayStateFor(jobs);
  const resolutions: string[] = [];
  const used: Array<{ identityId: string; client: WebClient | undefined }> = [];
  const clients = new Map<string, WebClient>();

  await drainNodeTurnRelayOnce({
    state,
    work: {} as WorkStore,
    resolveIdentity: async (identityId) => {
      resolutions.push(identityId);
      const client = { identityId } as unknown as WebClient;
      clients.set(identityId, client);
      return identityContext(identityId, client);
    },
    verifyIdentityAccess: async () => undefined,
    executeTurn: async (slackTurn, _assignment, _env, options) => {
      used.push({
        identityId: slackTurn.slackIdentityId!,
        client: options?.client,
      });
    },
  });

  assert.deepEqual(resolutions.sort(), [
    'slack_identity_finance',
    'slack_identity_legal',
    'slack_identity_support',
  ]);
  assert.equal(used.length, 3);
  for (const item of used) assert.equal(item.client, clients.get(item.identityId));
});

test('a retained TurnJob resolves a rotated token for the same identity on its next attempt', async () => {
  const item = {
    ...relayJob('rotation'),
    dispatchStartedAt: 1,
    dispatchEnvelope: { idempotencyKey: 'msg_relay_rotation' },
  };
  item.turn.slackIdentityId = 'slack_identity_finance';
  item.assignment.slackIdentityId = 'slack_identity_finance';
  const jobs = [item];
  const state = relayStateFor(jobs);
  const firstClient = { tokenVersion: 1 } as unknown as WebClient;
  const secondClient = { tokenVersion: 2 } as unknown as WebClient;
  let resolution = 0;
  const used: Array<WebClient | undefined> = [];
  const options = {
    state,
    work: {} as WorkStore,
    resolveIdentity: async (identityId: string) =>
      identityContext(identityId, ++resolution === 1 ? firstClient : secondClient),
    verifyIdentityAccess: async () => undefined,
    executeTurn: (async (_turn, _assignment, _env, runOptions) => {
      used.push(runOptions?.client);
      if (used.length === 1) throw new AgentPromptFailure('agent', 503, false, true);
    }) as LedgerSlackTurnExecutor,
  };

  await drainNodeTurnRelayOnce(options);
  await drainNodeTurnRelayOnce(options);

  assert.deepEqual(used, [firstClient, secondClient]);
  assert.equal(resolution, 2);
});

test('an unavailable identity enters recovery without model execution or default fallback', async () => {
  const item = relayJob('unavailable');
  item.turn.slackIdentityId = 'slack_identity_finance';
  item.assignment.slackIdentityId = 'slack_identity_finance';
  item.progress.interactionIntent = {
    disposition: 'work',
    reason: 'substantive_request',
    checklist: ['Finish the retained task'],
  };
  const recovery: Array<{ id: string; reason: string }> = [];
  const activeWork: Array<{ generation: string; active: boolean }> = [];
  const state = relayStateFor([item], recovery, activeWork);
  let executions = 0;
  const captured = await captureSlackIdentityOperationalEvents(async () => {
    await drainNodeTurnRelayOnce({
      state,
      work: {} as WorkStore,
      resolveIdentity: async () => {
        throw new SlackIdentityUnavailableError(
          'slack_identity_finance',
          'credentials_missing',
        );
      },
      verifyIdentityAccess: async () => undefined,
      executeTurn: async () => { executions += 1; },
    });
  });

  assert.equal(executions, 0);
  assert.deepEqual(recovery, [{
    id: item.id,
    reason: 'slack_identity_unavailable',
  }]);
  assert.deepEqual(activeWork, [{ generation: item.id, active: false }]);
  assert.ok(captured.events.some((event) =>
    event.operation === 'egress_unavailable' &&
    event.outcome === 'operator_repair' &&
    event.failureClass === 'credentials_missing' &&
    event.fallbackPrevented === true));
});

test('a transient identity preflight keeps the turn pending without model work or repair', async () => {
  const item = relayJob('identity-retry');
  item.turn.slackIdentityId = 'slack_identity_finance';
  item.assignment.slackIdentityId = 'slack_identity_finance';
  const jobs = [item];
  const recovery: Array<{ id: string; reason: string }> = [];
  let executions = 0;
  const captured = await captureSlackIdentityOperationalEvents(async () => {
    await drainNodeTurnRelayOnce({
      state: relayStateFor(jobs, recovery),
      work: {} as WorkStore,
      resolveIdentity: async () => {
        throw new SlackIdentityUnavailableError('slack_identity_finance', 'ratelimited', {
          retryAfterMs: 3_000,
        });
      },
      verifyIdentityAccess: async () => undefined,
      executeTurn: async () => { executions += 1; },
    });
  });

  assert.equal(executions, 0);
  assert.equal(jobs.length, 1);
  assert.deepEqual(recovery, []);
  assert.ok(captured.events.some((event) =>
    event.operation === 'egress_unavailable' &&
    event.outcome === 'retry' &&
    event.failureClass === 'ratelimited' &&
    event.fallbackPrevented === true));
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
      id: 'agent_node_relay', revision: 1, name: 'Node relay', instructions: 'Help.', enabled: true,
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
    progress: {} as { interactionIntent?: SlackInteractionIntent },
    executionAuthority: 'legacy' as const,
  };
}

function identityContext(
  identityId: string,
  client: WebClient,
): SlackIdentityExecutionContext {
  return {
    identityId,
    botToken: `token-for-${identityId}`,
    botUserId: `U_${identityId}`,
    teamId: 'T_node',
    client,
  };
}

function relayStateFor(
  jobs: ReturnType<typeof relayJob>[],
  recovery: Array<{ id: string; reason: string }> = [],
  activeWork: Array<{ generation: string; active: boolean }> = [],
): SlackStateStore {
  return {
    listPendingTurns: async () => [...jobs],
    freezeRuntimePlan: async () => { throw new Error('not reached'); },
    prepareFlueDispatch: async () => { throw new Error('not reached'); },
    reconcileFlueExistingInstance: async () => { throw new Error('not reached'); },
    recordFlueReceipt: async (receipt: unknown) => receipt,
    recordFlueSettlement: async (settlement: unknown) => settlement,
    recordContinuityNotice: async () => undefined,
    matchFlueObservation: async () => undefined,
    markTurnRecoveryRequired: async (id: string, reason: string) => {
      recovery.push({ id, reason });
    },
    recordTurnAttempt: async () => true,
    recordInteractionIntent: async () => undefined,
    recordSlackInteractionProgress: async () => undefined,
    markTurnDelivered: async (id: string) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index >= 0) jobs.splice(index, 1);
      return true;
    },
    discardTurn: async () => true,
    release: async () => undefined,
    setActiveWork: async (_key: string, generation: string, active: boolean) => {
      activeWork.push({ generation, active });
    },
  } as unknown as SlackStateStore;
}
