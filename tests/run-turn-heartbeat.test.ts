import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import type { ResolvedAssignment } from '../src/config/types.ts';
import type { SlackInteractionProgressPatch } from '../src/config/state-rpc.ts';
import {
  AgentPromptFailure,
  type AgentDispatchResult,
  type SlackFlueDispatchState,
} from '../src/slack/flue-dispatch.ts';
import type {
  FlueDispatchEnvelopeV1,
  FlueDispatchReceiptV1,
} from '../src/slack/turn-job-types.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { SANDBOX_UNAVAILABLE_FALLBACK_NOTICE } from '../src/slack/web-client-presenter.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const assignment: ResolvedAssignment = {
  workspaceId: 'T_HEARTBEAT',
  channelId: 'D_HEARTBEAT',
  agentId: 'agent_heartbeat',
  model: 'local-stub/heartbeat',
  agent: {
    id: 'agent_heartbeat',
    name: 'Chickpea',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

function workTurn(eventId: string): NormalizedSlackTurn {
  return {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    eventId,
    text: 'Complete the verification.',
    userId: 'U_HEARTBEAT',
    messageTs: '1785509000.000100',
    threadTs: '1785509000.000100',
    source: 'dm_message',
    channelType: 'im',
    contextMode: 'dm_history',
    interactionIntent: {
      disposition: 'work',
      reason: 'substantive_request',
      checklist: ['Verification result'],
    },
  };
}

function heartbeatClient(options: { failFinal?: boolean } = {}): {
  client: WebClient;
  heartbeatStarted: Promise<void>;
  finalAttempted: Promise<void>;
  releaseHeartbeat(): void;
  updateCount(): number;
  removedCount(): number;
  trace(): readonly string[];
} {
  const heartbeat = deferred<void>();
  const heartbeatStarted = deferred<void>();
  const finalAttempted = deferred<void>();
  let updates = 0;
  let removals = 0;
  let posts = 0;
  const trace: string[] = [];
  const client = {
    assistant: {
      threads: {
        setStatus: async () => {
          trace.push('status');
          return { ok: true };
        },
      },
    },
    reactions: {
      add: async () => ({ ok: true }),
      remove: async () => {
        trace.push('reaction.remove');
        removals += 1;
        return { ok: true };
      },
    },
    conversations: {
      history: async () => {
        trace.push('history.start');
        await delay(1_100, undefined);
        trace.push('history.end');
        return { ok: true, messages: [] };
      },
    },
    chat: {
      postMessage: async () => {
        posts += 1;
        if (options.failFinal && posts > 1) {
          trace.push('final.fallback');
          throw new Error('simulated Slack post failure');
        }
        return { ok: true, channel: assignment.channelId, ts: 'checklist-ts' };
      },
      update: async () => {
        trace.push(`update.${updates + 1}`);
        updates += 1;
        if (updates === 1) {
          heartbeatStarted.resolve(undefined);
          await heartbeat.promise;
        }
        return { ok: true };
      },
      startStream: async () => {
        trace.push('final.start');
        finalAttempted.resolve(undefined);
        if (options.failFinal) throw new Error('simulated unknown Slack delivery outcome');
        return { ok: true, ts: 'final-ts' };
      },
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;

  return {
    client,
    heartbeatStarted: heartbeatStarted.promise,
    finalAttempted: finalAttempted.promise,
    releaseHeartbeat: () => heartbeat.resolve(undefined),
    updateCount: () => updates,
    removedCount: () => removals,
    trace: () => trace,
  };
}

test('runTurn drains an in-flight heartbeat before terminal checklist finalization', async () => {
  const harness = heartbeatClient();
  let settled = false;
  const running = runTurn(workTurn('Ev_HEARTBEAT_SUCCESS'), assignment, undefined, {
    client: harness.client,
    replayText: 'Verification complete.',
    progressHeartbeatMs: 1_000,
    usageRecordingEnabled: false,
  }).finally(() => {
    settled = true;
  });

  await harness.heartbeatStarted;
  await harness.finalAttempted;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(harness.updateCount(), 1);

  harness.releaseHeartbeat();
  await running;
  assert.equal(harness.updateCount(), 2);
  assert.equal(harness.removedCount(), 1);
});

test('runTurn failure cleanup does not wait for an in-flight heartbeat', async () => {
  const harness = heartbeatClient({ failFinal: true });
  const outcome = runTurn(workTurn('Ev_HEARTBEAT_FAILURE'), assignment, undefined, {
    client: harness.client,
    replayText: 'Verification complete.',
    progressHeartbeatMs: 1_000,
    usageRecordingEnabled: false,
  }).then(() => 'resolved' as const, () => 'rejected' as const);

  await harness.heartbeatStarted;
  await harness.finalAttempted;
  assert.equal(
    await Promise.race([outcome, delay(250, 'timeout' as const)]),
    'rejected',
    harness.trace().join(', '),
  );
  assert.equal(harness.updateCount(), 1);
  assert.equal(harness.removedCount(), 1);

  harness.releaseHeartbeat();
});

test('runTurn bounds a never-settling heartbeat without racing a terminal update', async () => {
  const harness = heartbeatClient();
  const progress: SlackInteractionProgressPatch[] = [];
  const outcome = runTurn(workTurn('Ev_HEARTBEAT_TIMEOUT'), assignment, undefined, {
    client: harness.client,
    replayText: 'Verification complete.',
    progressHeartbeatMs: 1_000,
    progressHeartbeatDrainMs: 50,
    usageRecordingEnabled: false,
    onInteractionProgress(patch) {
      progress.push(patch);
    },
  }).then(() => 'resolved' as const, () => 'rejected' as const);

  await harness.heartbeatStarted;
  await harness.finalAttempted;
  assert.equal(await Promise.race([outcome, delay(250, 'timeout' as const)]), 'resolved');
  assert.equal(harness.updateCount(), 1, 'terminal update must not race the hung heartbeat');
  assert.equal(
    progress.some((patch) =>
      patch.checklist?.messageTs === 'checklist-ts' && patch.checklist.cleanup === 'pending'
    ),
    true,
    'the repair lane must receive the pending checklist coordinate',
  );
  assert.equal(
    progress.some((patch) => patch.checklist?.cleanup === 'done'),
    false,
    'durable repair must retain ownership of checklist finalization',
  );
  assert.equal(harness.removedCount(), 1);
});

test('replay delivery skips model activity and never invokes the agent provider', async () => {
  const statusCalls: Array<{ status?: string; loading_messages?: string[] }> = [];
  let agentCalls = 0;
  const client = {
    assistant: {
      threads: {
        async setStatus(input: { status?: string; loading_messages?: string[] }) {
          statusCalls.push(input);
          return { ok: true };
        },
      },
    },
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async () => ({ ok: true, ts: 'final-ts' }),
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true, channel: assignment.channelId, ts: 'final-ts' }),
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_REPLAY_NO_MODEL'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };

  await runTurn(turn, assignment, undefined, {
    client,
    replayText: 'Previously completed answer.',
    usageRecordingEnabled: false,
    async agentPrompt(): Promise<AgentDispatchResult> {
      agentCalls += 1;
      throw new Error('replay must not invoke the agent provider');
    },
  });

  assert.equal(agentCalls, 0);
  assert.equal(
    statusCalls.some((call) =>
      call.loading_messages?.includes(`Using ${assignment.model}`)
    ),
    false,
  );
});

test('a recovery-required Flue conflict emits no Slack final', async () => {
  let finalAttempts = 0;
  const client = {
    assistant: {
      threads: {
        setStatus: async () => ({ ok: true }),
      },
    },
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async () => {
        finalAttempts += 1;
        return { ok: true, ts: 'unexpected-final' };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async () => {
        finalAttempts += 1;
        return { ok: true, channel: assignment.channelId, ts: 'unexpected-final' };
      },
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_RECOVERY_REQUIRED'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };

  await assert.rejects(
    () => runTurn(turn, assignment, undefined, {
      client,
      usageRecordingEnabled: false,
      async agentPrompt(): Promise<AgentDispatchResult> {
        throw new AgentPromptFailure('agent', 409, true);
      },
    }),
    (error: unknown) => error instanceof AgentPromptFailure && error.recoveryRequired,
  );
  assert.equal(finalAttempts, 0);
});

test('a retryable Flue interruption emits no Slack final', async () => {
  let finalAttempts = 0;
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      startStream: async () => {
        finalAttempts += 1;
        return { ok: true, ts: 'unexpected-final' };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async () => {
        finalAttempts += 1;
        return { ok: true, channel: assignment.channelId, ts: 'unexpected-final' };
      },
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_RETRYABLE_INTERRUPTION'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };

  await assert.rejects(
    () => runTurn(turn, assignment, undefined, {
      client,
      usageRecordingEnabled: false,
      async agentPrompt(): Promise<AgentDispatchResult> {
        throw new AgentPromptFailure('agent', 503, false, true);
      },
    }),
    (error: unknown) => error instanceof AgentPromptFailure && error.retryable,
  );
  assert.equal(finalAttempts, 0);
});

test('a stalled detail status does not delay agent start or final delivery', async () => {
  const detailWrite = deferred<void>();
  const agentStarted = deferred<void>();
  const finalAttempted = deferred<void>();
  const lateClear = deferred<void>();
  let nonEmptyStatusCalls = 0;
  let clearCalls = 0;
  const client = {
    assistant: {
      threads: {
        async setStatus(input: { status?: string }) {
          if (input.status === '') {
            clearCalls += 1;
            if (clearCalls === 2) lateClear.resolve(undefined);
            return { ok: true };
          }
          nonEmptyStatusCalls += 1;
          if (nonEmptyStatusCalls === 2) {
            await detailWrite.promise;
          }
          return { ok: true };
        },
      },
    },
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async () => {
        finalAttempted.resolve(undefined);
        return { ok: true, ts: 'final-ts' };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true, channel: assignment.channelId, ts: 'final-ts' }),
    },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_STATUS_DOES_NOT_BLOCK'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };

  const outcome = runTurn(turn, assignment, undefined, {
    client,
    usageRecordingEnabled: false,
    async agentPrompt(): Promise<AgentDispatchResult> {
      agentStarted.resolve(undefined);
      return {
        text: 'Fresh answer.',
        requestedModel: assignment.model ?? null,
        returnedModel: null,
        reportedUsage: null,
        usageCompleteness: 'not_reported',
      };
    },
  }).then(() => 'resolved' as const, () => 'rejected' as const);

  await agentStarted.promise;
  await finalAttempted.promise;
  assert.equal(await Promise.race([outcome, delay(100, 'timeout' as const)]), 'resolved');
  assert.equal(clearCalls, 1, 'final delivery should trigger an immediate clear');

  detailWrite.resolve(undefined);
  await lateClear.promise;
  assert.equal(clearCalls, 2, 'the late detail write should be cleared after it settles');
});

test('runTurn freezes eligibility before exposing the receipt-scoped relay factory', async () => {
  const work = new SqliteWorkStore(':memory:', { now: () => 1_800_000_000_000 });
  try {
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      startStream: async () => ({ ok: true, ts: 'final-ts' }),
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true, channel: assignment.channelId, ts: 'final-ts' }),
    },
  } as unknown as WebClient;
  const currentTurn: NormalizedSlackTurn = {
    ...workTurn('Ev_PROGRESSIVE_ELIGIBILITY'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runtimePlan = compileRuntimePlanV2({
    turn: currentTurn,
    assignment,
    instructions: assignment.agent.instructions,
    memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  const captured: unknown[] = [];
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn: currentTurn,
    assignment,
    sourceVisibility: 'private',
    admittedAt: 1_800_000_000_000,
  }));

  await runTurn(currentTurn, assignment, undefined, {
    client,
    runId: admitted.run.id,
    runAttempt: 1,
    workStore: work,
    runtimePlanDecision: {
      runtimePlan,
      instanceId: deriveRuntimePlanInstanceId(runtimePlan),
      continuityNoticeRequired: false,
    },
    progressiveAttributionProven: true,
    prepareProgressiveRelay: async (input) => {
      captured.push(structuredClone(input));
      return undefined;
    },
    usageRecordingEnabled: false,
    async agentPrompt(input): Promise<AgentDispatchResult> {
      assert.equal(typeof input.prepareProgressiveRelay, 'function');
      await input.prepareProgressiveRelay?.({
        instanceId: deriveRuntimePlanInstanceId(runtimePlan),
        receipt: {
          submissionId: 'submission_progressive_eligibility',
          acceptedAt: '2026-08-02T12:00:00.000Z',
          uid: 'uid_progressive_eligibility',
        },
      });
      return {
        text: 'Fresh answer.',
        requestedModel: assignment.model ?? null,
        returnedModel: null,
        reportedUsage: null,
        usageCompleteness: 'not_reported',
      };
    },
  });

  assert.deepEqual(captured, [{
    runId: admitted.run.id,
    runFencingToken: 0,
    instanceId: deriveRuntimePlanInstanceId(runtimePlan),
    receipt: {
      submissionId: 'submission_progressive_eligibility',
      acceptedAt: '2026-08-02T12:00:00.000Z',
      uid: 'uid_progressive_eligibility',
    },
    eligibility: { allowed: true, reason: 'safe_early_release' },
  }]);
  } finally {
    work.close();
  }
});

test('a frozen Cloudflare plan narrows unsettled dispatches when its live binding disappeared', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Cloudflare-Workers' },
  });
  const repositoryAssignment: ResolvedAssignment = {
    ...assignment,
    agent: {
      ...assignment.agent,
      repositories: [{
        id: 'repo-runtime-fallback',
        installationId: 42,
        accountLogin: 'Acme',
        fullName: 'Acme/RuntimeFallback',
        enabled: true,
      }],
    },
  };
  const turn: NormalizedSlackTurn = {
    ...workTurn('Ev_SANDBOX_BINDING_REMOVED'),
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runtimePlan = compileRuntimePlanV2({
    turn,
    assignment: repositoryAssignment,
    instructions: repositoryAssignment.agent.instructions,
    memoryEpoch: 1,
    sandboxMode: 'cloudflare',
  });
  const finalPayloads: unknown[] = [];
  const client = {
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      startStream: async (input: unknown) => {
        finalPayloads.push(input);
        return { ok: true, ts: 'final-ts' };
      },
      stopStream: async (input: unknown) => {
        finalPayloads.push(input);
        return { ok: true };
      },
      postMessage: async (input: unknown) => {
        finalPayloads.push(input);
        return { ok: true, channel: assignment.channelId, ts: 'final-ts' };
      },
    },
  } as unknown as WebClient;
  try {
    for (const checkpoint of ['unstarted', 'envelope', 'receipt'] as const) {
      const dispatchEnvelope: FlueDispatchEnvelopeV1 = {
        schemaVersion: 1,
        agentName: 'chickpea-slack-v2',
        instanceId: deriveRuntimePlanInstanceId(runtimePlan),
        uid: null,
        message: { kind: 'user', body: `durable ${checkpoint} message` },
        initialData: runtimePlan,
        idempotencyKey: `sandbox-binding-removed:${checkpoint}`,
      };
      const dispatchReceipt: FlueDispatchReceiptV1 = {
        submissionId: `submission_sandbox_binding_removed_${checkpoint}`,
        acceptedAt: '2026-08-08T18:00:00.000Z',
        uid: `uid_sandbox_binding_removed_${checkpoint}`,
      };
      const flueDispatch: SlackFlueDispatchState = {
        ...(checkpoint === 'unstarted' ? {} : { dispatchEnvelope }),
        ...(checkpoint === 'receipt' ? { dispatchReceipt } : {}),
        prepare: async () => { throw new Error('focused agent override owns dispatch'); },
        recordReceipt: async (receipt) => receipt,
        recordSettlement: async (settlement) => settlement,
        reconcileExistingInstance: async () => { throw new Error('not used'); },
        markRecoveryRequired: async () => {},
      };
      await runTurn({ ...turn, eventId: `${turn.eventId}_${checkpoint}` }, repositoryAssignment, {}, {
        client,
        runtimePlanDecision: {
          runtimePlan,
          instanceId: deriveRuntimePlanInstanceId(runtimePlan),
          continuityNoticeRequired: false,
        },
        flueDispatch,
        usageRecordingEnabled: false,
        async agentPrompt(input): Promise<AgentDispatchResult> {
          assert.equal(input.useCloudflareSandbox, false, checkpoint);
          assert.equal(input.state.dispatchEnvelope, checkpoint === 'unstarted' ? undefined : dispatchEnvelope);
          assert.equal(input.state.dispatchReceipt, checkpoint === 'receipt' ? dispatchReceipt : undefined);
          return {
            text: 'Normal response without repository access.',
            requestedModel: repositoryAssignment.model ?? null,
            returnedModel: null,
            reportedUsage: null,
            usageCompleteness: 'not_reported',
          };
        },
      });
    }
    assert.match(JSON.stringify(finalPayloads), new RegExp(SANDBOX_UNAVAILABLE_FALLBACK_NOTICE));
    assert.doesNotMatch(JSON.stringify(finalPayloads), /control-plane|binding|credential|token/i);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
