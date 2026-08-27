import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { openStateDb } from '../src/state/node-state-db.ts';
import {
  SlackAgentViewPresentation,
  deriveSlackThreadTitle,
  type SlackPresentationDeliveryObserver,
  type SlackPresentationStatePort,
} from '../src/slack/agent-view-presentation.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackPresentationMutation,
} from '../src/slack/run-presentations.ts';
import type { SlackPresentationFinalizationRecord } from '../src/slack/run-presentations.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { slackClientMessageId } from '../src/slack/transport/message-id.ts';

const ROOT = {
  workspaceId: 'T_AGENT_VIEW',
  channelId: 'D_AGENT_VIEW',
  threadTs: '1785700100.000100',
  requesterUserId: 'U_AGENT_VIEW',
};

function harness(input: {
  tasks?: string[];
  progressive?: boolean;
  native?: boolean;
  schemaVersion?: 1 | 2 | 3;
  failIntentMutation?: boolean;
  startStreamError?: unknown;
  stopStreamError?: unknown;
  sessionError?: unknown;
  onNativeStarted?: () => Promise<void>;
  persona?: { name: string; avatarUrl: string; avatarRevision: number };
  owner?:
    | { kind: 'selected_agent'; persona: { name: string; avatarUrl: string; avatarRevision: number } }
    | { kind: 'chickpea' };
} = {}) {
  let clock = 1_800_000_000_000;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db, () => clock);
  const runId = input.tasks ? 'run_native_plan' : 'run_progressive';
  const sharedInput = {
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: 'binding_agent_view',
    workBindingGeneration: 1,
    runFencingToken: 0,
    root: ROOT,
    ...(input.tasks ? { taskLabels: input.tasks } : {}),
  };
  store.create(input.schemaVersion === 3
    ? {
        ...sharedInput,
        schemaVersion: 3,
        owner: input.owner ?? { kind: 'chickpea' },
        sessionGeneration: 1785700100000100,
        currentActivity: {
          kind: 'preparing',
          action: 'Preparing',
          object: 'your request',
          generation: 1785700100000100,
          sequence: 1,
          operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
        },
      }
    : {
        ...sharedInput,
        ...(input.schemaVersion ? { schemaVersion: input.schemaVersion } : {}),
        features: {
          progressiveStreaming: input.progressive ?? true,
          nativeTasks: input.native ?? false,
        },
        ...(input.persona ? { persona: input.persona } : {}),
      });
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const finalizationRecords: SlackPresentationFinalizationRecord[] = [];
  let threadReplies: Array<Record<string, unknown>> = [];
  let threadRepliesComplete = true;
  let stream = 0;
  const client = {
    async apiCall(method: string, value: Record<string, unknown>) {
      calls.push({ method, input: value });
      if (input.sessionError) throw input.sessionError;
      return { ok: true };
    },
    assistant: {
      threads: {
        async setTitle(value: Record<string, unknown>) {
          calls.push({ method: 'assistant.threads.setTitle', input: value });
          return { ok: true };
        },
      },
    },
    chat: {
      async startStream(value: Record<string, unknown>) {
        calls.push({ method: 'chat.startStream', input: value });
        if (input.startStreamError) throw input.startStreamError;
        stream += 1;
        return { ok: true, ts: `1785700100.00020${stream}` };
      },
      async appendStream(value: Record<string, unknown>) {
        calls.push({ method: 'chat.appendStream', input: value });
        return { ok: true };
      },
      async stopStream(value: Record<string, unknown>) {
        calls.push({ method: 'chat.stopStream', input: value });
        if (input.stopStreamError) throw input.stopStreamError;
        return { ok: true };
      },
      async update(value: Record<string, unknown>) {
        calls.push({ method: 'chat.update', input: value });
        return { ok: true };
      },
    },
    conversations: {
      async replies(value: Record<string, unknown>) {
        calls.push({ method: 'conversations.replies', input: value });
        return {
          ok: true,
          messages: structuredClone(threadReplies),
          has_more: !threadRepliesComplete,
        };
      },
    },
  } as unknown as WebClient;
  const state: SlackPresentationStatePort = {
    getRunPresentation: (id) => store.get(id),
    getLatestThreadSessionGeneration: (root) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (value) => {
      if (input.failIntentMutation && value.mutation.kind === 'progressive_intent_requested') {
        throw new Error('synthetic intent persistence failure');
      }
      return store.transition(value);
    },
    reserveSlackAppend: (workspaceId) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: (instanceId, submissionId) => ({
      turnJobId: `turn_${runId}`,
      instanceId,
      ...(submissionId ? { submissionId } : {}),
      generation: `turn_${runId}`,
      workCorrelation: {
        runId,
        runExecutionId: `execution_${runId}`,
        mode: 'observe',
      },
    }),
  };
  const presentation = new SlackAgentViewPresentation({
    client,
    state,
    runId,
    runFencingToken: 0,
    footer: { agentName: 'Chickpea', agentId: 'agent_default' },
    minAppendIntervalMs: 750,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    onFinalized: (record) => { finalizationRecords.push(structuredClone(record)); },
    ...(input.onNativeStarted ? { onNativeStarted: input.onNativeStarted } : {}),
  });
  return {
    db,
    store,
    runId,
    calls,
    finalizationRecords,
    presentation,
    setThreadReplies(messages: Array<Record<string, unknown>>, complete = true) {
      threadReplies = structuredClone(messages);
      threadRepliesComplete = complete;
    },
  };
}

function observer(events: Array<Record<string, unknown>>): SlackPresentationDeliveryObserver {
  return {
    async before(input) {
      events.push({ phase: 'before', ...input });
      return 'delivery_attempt';
    },
    async after(input) {
      events.push({ phase: 'after', ...input });
    },
  };
}

async function prepareReceipt(
  h: ReturnType<typeof harness>,
  input: Parameters<SlackAgentViewPresentation['prepareReceipt']>[0],
) {
  await h.presentation.freezeProgressiveEligibility(input.eligibility);
  return h.presentation.prepareReceipt(input);
}

function applyPresentationMutation(
  h: ReturnType<typeof harness>,
  mutation: SlackPresentationMutation,
): void {
  const current = h.store.get(h.runId);
  assert.ok(current);
  const result = h.store.transition({
    runId: current.runId,
    workBindingGeneration: current.workBindingGeneration,
    runFencingToken: current.runFencingToken,
    expectedProjectionVersion: current.projectionVersion,
    expectedStreamState: current.stream.state,
    mutation,
  });
  assert.equal(result.outcome, 'applied');
}

function declareProgressiveIntent(
  relay: NonNullable<Awaited<ReturnType<typeof prepareReceipt>>>,
  input: { submissionId: string; messageId: string; firstBatch?: number },
): void {
  const first = input.firstBatch ?? 2;
  relay.onEvent({
    type: 'tool-input', conversationId: 'conversation', messageId: input.messageId,
    toolCallId: 'stream_call_1', toolName: 'stream_answer', input: {},
    position: { batch: first, index: 0 },
  });
  relay.onEvent({
    type: 'tool-output', conversationId: 'conversation', toolCallId: 'stream_call_1',
    output: 'Delivery preference noted. Continue with the answer.',
    position: { batch: first + 1, index: 0 },
  });
  void input.submissionId;
}

test('ordinary eligible answers start once, append ordered suffixes, and stop once', async () => {
  const h = harness({
    schemaVersion: 3,
    owner: { kind: 'selected_agent', persona: {
      name: 'Support Triage',
      avatarUrl: 'https://chickpea.example/assets/agents/support/avatar/2',
      avatarRevision: 2,
    } },
  });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_progressive',
      receipt: { submissionId: 'submission_progressive', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.ok(relay);
    relay.onEvent({
      type: 'message-started', conversationId: 'conversation',
      submissionId: 'submission_progressive', messageId: 'message_progressive',
      position: { batch: 1, index: 0 },
    });
    declareProgressiveIntent(relay, {
      submissionId: 'submission_progressive',
      messageId: 'message_progressive',
    });
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId: 'message_progressive',
      kind: 'text', delta: 'Hello', position: { batch: 4, index: 0 },
    });
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId: 'message_progressive',
      kind: 'text', delta: ' progressive world.', position: { batch: 5, index: 0 },
    });
    relay.onEvent({
      type: 'message-completed', conversationId: 'conversation', messageId: 'message_progressive',
      position: { batch: 6, index: 0 },
    });
    await relay.closeAndDrain();

    const events: Array<Record<string, unknown>> = [];
    assert.deepEqual(
      await h.presentation.finalize(
        'Hello progressive world.',
        'markdown',
        'complete',
        observer(events),
      ),
      { handled: true, messageTs: '1785700100.000201' },
    );
    await h.presentation.markCanonicalFinalized();
    await h.presentation.markCanonicalFinalized();

    assert.equal(h.calls.filter((call) => call.method === 'chat.startStream').length, 1);
    assert.equal(
      h.calls.find((call) => call.method === 'chat.startStream')?.input.username,
      'Support Triage',
    );
    assert.equal(
      h.calls.find((call) => call.method === 'chat.startStream')?.input.icon_url,
      'https://chickpea.example/assets/agents/support/avatar/2',
    );
    assert.equal(
      Object.hasOwn(h.calls.find((call) => call.method === 'chat.startStream')!.input, 'is_stoppable'),
      false,
    );
    assert.ok(h.calls.filter((call) => call.method === 'chat.appendStream').length <= 1);
    assert.equal(h.calls.filter((call) => call.method === 'chat.stopStream').length, 1);
    const visible = h.calls
      .filter((call) => call.method === 'chat.startStream' || call.method === 'chat.appendStream')
      .map((call) => String(call.input.markdown_text ?? ''))
      .join('');
    assert.equal(visible, 'Hello progressive world.');
    assert.equal(h.store.get(h.runId)?.stream.state, 'finalized');
    const stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion === 3) {
      assert.equal(stored.progressiveIntent.status, 'requested');
    }
    assert.deepEqual(events.map((event) => [event.phase, event.outcome]), [
      ['before', undefined],
      ['after', 'delivered'],
    ]);
    assert.equal(h.finalizationRecords.length, 1);
    assert.equal(h.finalizationRecords[0]?.policyOutcome, 'requested_progressive');
    assert.equal(h.finalizationRecords[0]?.acceptedBytes, 24);
    assert.equal(JSON.stringify(h.finalizationRecords).includes('Hello progressive world.'), false);
  } finally {
    h.db.close();
  }
});

test('V3 native streams project the frozen selected owner and base-app Chickpea identity', async () => {
  const persona = {
    name: 'Frozen Support',
    avatarUrl: 'https://chickpea.example/assets/agents/frozen/avatar/7',
    avatarRevision: 7,
  };
  const selected = harness({
    schemaVersion: 3,
    owner: { kind: 'selected_agent', persona },
  });
  const chickpea = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
  try {
    await selected.presentation.finalize('Selected answer.', 'markdown', 'complete', observer([]));
    await chickpea.presentation.finalize('Base app answer.', 'markdown', 'complete', observer([]));

    const selectedStart = selected.calls.find((call) => call.method === 'chat.startStream')?.input;
    assert.equal(selectedStart?.username, persona.name);
    assert.equal(selectedStart?.icon_url, persona.avatarUrl);

    const chickpeaStart = chickpea.calls.find((call) => call.method === 'chat.startStream')?.input;
    assert.equal(Object.hasOwn(chickpeaStart ?? {}, 'username'), false);
    assert.equal(Object.hasOwn(chickpeaStart ?? {}, 'icon_url'), false);
  } finally {
    selected.db.close();
    chickpea.db.close();
  }
});

test('effect-capable Work starts honest native tasks but emits no progressive answer text', async () => {
  const h = harness({
    tasks: ['Inspect the customer', 'Prepare the update'],
    progressive: true,
    native: true,
  });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_native',
      receipt: { submissionId: 'submission_native', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: false, reason: 'effect_capable' },
    });
    assert.equal(relay, undefined);
    const start = h.calls.find((call) => call.method === 'chat.startStream');
    assert.equal(start?.input.task_display_mode, 'plan');
    assert.deepEqual(
      (start?.input.chunks as Array<{ type: string; status: string }>).map((chunk) => [
        chunk.type,
        chunk.status,
      ]),
      [['task_update', 'in_progress'], ['task_update', 'in_progress']],
    );
    assert.equal(start?.input.markdown_text, undefined);

    await h.presentation.finalize(
      'The customer is ready for review.',
      'markdown',
      'complete',
      observer([]),
    );
    const stop = h.calls.find((call) => call.method === 'chat.stopStream');
    const chunks = stop?.input.chunks as Array<{ type: string; text?: string; status?: string }>;
    assert.equal(chunks[0]?.text, 'The customer is ready for review.');
    assert.deepEqual(chunks.slice(1).map((chunk) => chunk.status), ['complete', 'complete']);
    assert.equal(h.calls.some((call) => call.method === 'chat.appendStream'), false);
  } finally {
    h.db.close();
  }
});

test('V3 milestones stay hidden until an authoritative transition and project one row at a time', async () => {
  const h = harness({
    schemaVersion: 3,
    tasks: ['Inspect the customer', 'Prepare the update', 'Publish the result'],
  });
  try {
    const receipt = {
      instanceId: 'instance_v3_milestones',
      receipt: { submissionId: 'submission_v3_milestones', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: false as const, reason: 'effect_capable' as const },
    };
    assert.equal(await prepareReceipt(h, receipt), undefined);
    assert.equal(h.calls.some((call) => call.method === 'chat.startStream'), false);

    const persisted = h.store.get(h.runId);
    assert.equal(persisted?.schemaVersion, 3);
    if (persisted?.schemaVersion !== 3 || !persisted.plan) return;
    const [inspectId, updateId, publishId] = persisted.plan.tasks.map((task) => task.id);
    await h.presentation.transitionMilestone({ taskId: inspectId!, to: 'in_progress' });
    assert.equal(await h.presentation.prepareReceipt(receipt), undefined);

    const start = h.calls.find((call) => call.method === 'chat.startStream');
    const startedTasks = start?.input.chunks as Array<Record<string, unknown>>;
    assert.deepEqual(startedTasks.map((task) => [task.id, task.status]), [
      [inspectId, 'in_progress'],
      [updateId, 'pending'],
      [publishId, 'pending'],
    ]);

    await h.presentation.transitionMilestone({
      taskId: inspectId!, to: 'completed', detail: 'Completed: customer inspected.',
    });
    await h.presentation.transitionMilestone({ taskId: updateId!, to: 'in_progress' });
    await h.presentation.recordExecutionFailure('the update could not be prepared');

    const failed = h.store.get(h.runId);
    assert.equal(failed?.schemaVersion, 3);
    if (failed?.schemaVersion !== 3) return;
    assert.deepEqual(failed.plan?.tasks.map((task) => [task.outcome, task.detail]), [
      ['completed', 'Completed: customer inspected.'],
      ['failed', 'Failed: the update could not be prepared'],
      ['not_run', 'Not run: work stopped after the prior milestone failed.'],
    ]);
    const projected = h.calls.filter((call) => call.method === 'chat.appendStream').at(-1)
      ?.input.chunks as Array<Record<string, unknown>>;
    assert.deepEqual(projected.map((task) => task.details), [
      'Completed: customer inspected.',
      'Failed: the update could not be prepared',
      'Not run: work stopped after the prior milestone failed.',
    ]);
  } finally {
    h.db.close();
  }
});

test('a durable artifact coordinate reconciles a crashed terminal receipt without another Slack write', async () => {
  const h = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
  try {
    let current = h.store.get(h.runId)!;
    const apply = (mutation: Parameters<typeof h.store.transition>[0]['mutation']) => {
      const result = h.store.transition({
        runId: current.runId,
        workBindingGeneration: current.workBindingGeneration,
        runFencingToken: current.runFencingToken,
        expectedProjectionVersion: current.projectionVersion,
        expectedStreamState: current.stream.state,
        mutation,
      });
      assert.equal(result.outcome, 'applied');
      if (result.outcome === 'applied') current = result.presentation;
    };
    apply({ kind: 'record_terminal_delivery_intent',
      operationId: 'terminal_crash_boundary_1', result: 'answer' });
    apply({ kind: 'stream_start_intent' });
    apply({ kind: 'stream_started', messageTs: '1785700100.000299', flue: {
      instanceId: 'instance_crash_boundary', submissionId: 'submission_crash_boundary',
    } });
    apply({ kind: 'close_stream', outcome: 'terminal_only' });
    apply({ kind: 'mark_finalizing' });
    apply({ kind: 'mark_artifact_delivered', outcome: 'terminal_only' });
    assert.equal(h.calls.length, 0);

    const result = await h.presentation.finalize(
      'Already delivered.', 'markdown', 'complete', observer([]),
    );
    assert.equal(result.handled, true);
    assert.equal(h.calls.length, 0);
    const recovered = h.store.get(h.runId);
    assert.equal(recovered?.schemaVersion === 3 &&
      recovered.terminalDelivery.state === 'intended'
      ? recovered.terminalDelivery.operation.certainty
      : undefined, 'acknowledged');
  } finally {
    h.db.close();
  }
});

test('V3 supersedes a failed answer delivery with failure, but never pending, unknown, or acknowledged answer', async () => {
  const h = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
  try {
    applyPresentationMutation(h, {
      kind: 'record_terminal_delivery_intent',
      operationId: 'terminal_answer_failed',
      result: 'answer',
    });
    applyPresentationMutation(h, {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_answer_failed',
      certainty: 'failed',
    });
    await h.presentation.finalize('The work failed.', 'markdown', 'error', observer([]));
    const superseded = h.store.get(h.runId);
    assert.equal(superseded?.schemaVersion, 3);
    if (superseded?.schemaVersion === 3 && superseded.terminalDelivery.state === 'intended') {
      assert.equal(superseded.terminalDelivery.result, 'failure');
      assert.equal(superseded.terminalDelivery.operation.certainty, 'acknowledged');
      assert.notEqual(superseded.terminalDelivery.operation.operationId, 'terminal_answer_failed');
    } else {
      assert.fail('the failed answer delivery was not superseded');
    }

    for (const certainty of ['pending', 'unknown', 'acknowledged'] as const) {
      const blocked = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
      try {
        applyPresentationMutation(blocked, {
          kind: 'record_terminal_delivery_intent',
          operationId: `terminal_answer_${certainty}`,
          result: 'answer',
        });
        if (certainty !== 'pending') {
          applyPresentationMutation(blocked, {
            kind: 'record_terminal_delivery_receipt',
            operationId: `terminal_answer_${certainty}`,
            certainty,
          });
        }
        await assert.rejects(
          blocked.presentation.finalize('The work failed.', 'markdown', 'error', observer([])),
          /requires reconciliation/,
        );
        const stored = blocked.store.get(blocked.runId);
        assert.equal(stored?.schemaVersion, 3);
        if (stored?.schemaVersion === 3 && stored.terminalDelivery.state === 'intended') {
          assert.equal(stored.terminalDelivery.result, 'answer');
          assert.equal(stored.terminalDelivery.operation.certainty, certainty);
        }
        assert.equal(blocked.calls.some((call) => call.method.startsWith('chat.')), false);
      } finally {
        blocked.db.close();
      }
    }
  } finally {
    h.db.close();
  }
});

test('V3 reconciles unknown activity posts and cleanup receipts without replaying incomplete reads', async () => {
  const h = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
  try {
    const prepared = await h.presentation.beginActivity({
      kind: 'reading', action: 'Reading', object: 'the request', text: 'Reading the request',
    }, 'message');
    assert.ok(prepared);
    await h.presentation.recordActivityReceipt(prepared.operationId, 'unknown');
    h.setThreadReplies([{
      ts: '1785700100.000355',
      client_msg_id: slackClientMessageId(prepared.operationId),
    }]);
    await h.presentation.reconcileActivityReceipts();
    let stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion !== 3) return;
    assert.deepEqual(stored.currentActivity?.operation, {
      operationId: prepared.operationId, certainty: 'acknowledged',
    });
    assert.deepEqual(stored.activityProjection, {
      surface: 'message', state: 'visible', messageTs: '1785700100.000355',
    });

    applyPresentationMutation(h, {
      kind: 'record_terminal_delivery_intent', operationId: 'terminal_activity_cleanup', result: 'answer',
    });
    applyPresentationMutation(h, {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_activity_cleanup', certainty: 'acknowledged',
    });
    const cleanup = await h.presentation.prepareActivityCleanup();
    assert.ok(cleanup);
    await h.presentation.recordActivityCleanupReceipt(cleanup.operationId, 'unknown');
    h.setThreadReplies([{ ts: ROOT.threadTs }]);
    await h.presentation.reconcileActivityReceipts();
    stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion === 3) {
      assert.equal(stored.cleanup.state, 'required');
      assert.equal(stored.cleanup.state === 'required'
        ? stored.cleanup.operation.certainty
        : undefined, 'acknowledged');
      assert.equal(stored.activityProjection.state, 'cleared');
    }

    const incomplete = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
    try {
      const unproven = await incomplete.presentation.beginActivity({
        kind: 'reading', action: 'Reading', object: 'the request', text: 'Reading the request',
      }, 'message');
      assert.ok(unproven);
      await incomplete.presentation.recordActivityReceipt(unproven.operationId, 'unknown');
      incomplete.setThreadReplies([], false);
      await incomplete.presentation.reconcileActivityReceipts();
      const unresolved = incomplete.store.get(incomplete.runId);
      assert.equal(
        unresolved?.schemaVersion === 3
          ? unresolved.currentActivity?.operation.certainty
          : undefined,
        'unknown',
      );
      assert.equal(await incomplete.presentation.beginActivity({
        kind: 'reading', action: 'Reading', object: 'the request', text: 'Reading the request',
      }, 'message'), undefined);
      incomplete.setThreadReplies([], true);
      await incomplete.presentation.reconcileActivityReceipts();
      const absent = incomplete.store.get(incomplete.runId);
      assert.equal(absent?.schemaVersion, 3);
      if (absent?.schemaVersion === 3) {
        assert.equal(absent.currentActivity?.operation.certainty, 'failed');
      }
    } finally {
      incomplete.db.close();
    }

    const stillVisible = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
    try {
      const visible = await stillVisible.presentation.beginActivity({
        kind: 'reading', action: 'Reading', object: 'the request', text: 'Reading the request',
      }, 'message');
      assert.ok(visible);
      await stillVisible.presentation.recordActivityReceipt(
        visible.operationId,
        'acknowledged',
        '1785700100.000356',
      );
      applyPresentationMutation(stillVisible, {
        kind: 'record_terminal_delivery_intent',
        operationId: 'terminal_cleanup_visible', result: 'answer',
      });
      applyPresentationMutation(stillVisible, {
        kind: 'record_terminal_delivery_receipt',
        operationId: 'terminal_cleanup_visible', certainty: 'acknowledged',
      });
      const cleanup = await stillVisible.presentation.prepareActivityCleanup();
      assert.ok(cleanup);
      await stillVisible.presentation.recordActivityCleanupReceipt(cleanup.operationId, 'unknown');
      stillVisible.setThreadReplies([{ ts: '1785700100.000356' }]);
      await stillVisible.presentation.reconcileActivityReceipts();
      const cleanupFailed = stillVisible.store.get(stillVisible.runId);
      assert.equal(cleanupFailed?.schemaVersion, 3);
      if (cleanupFailed?.schemaVersion === 3 && cleanupFailed.cleanup.state === 'required') {
        assert.equal(cleanupFailed.cleanup.operation.certainty, 'failed');
        assert.equal(cleanupFailed.activityProjection.state, 'visible');
      }
    } finally {
      stillVisible.db.close();
    }
  } finally {
    h.db.close();
  }
});

test('V3 keeps one native processing status active until an acknowledged terminal reply', async () => {
  const persona = {
    name: 'Sprout',
    avatarUrl: 'https://chickpea.example/assets/agents/sprout/avatar/4',
    avatarRevision: 4,
  };
  const h = harness({
    schemaVersion: 3,
    owner: { kind: 'selected_agent', persona },
  });
  try {
    assert.equal(await h.presentation.beginAgentSessionProcessing(), true);
    assert.equal(await h.presentation.beginAgentSessionProcessing(), true);
    assert.deepEqual(h.calls.filter(({ method }) => method === 'agents.sessions.setStatus'), [{
      method: 'agents.sessions.setStatus',
      input: {
        channel_id: ROOT.channelId,
        thread_ts: ROOT.threadTs,
        status: 'processing',
        initiator_user_id: ROOT.requesterUserId,
        username: persona.name,
        icon_url: persona.avatarUrl,
      },
    }]);

    applyPresentationMutation(h, {
      kind: 'record_terminal_delivery_intent', operationId: 'terminal_session_answer', result: 'answer',
    });
    applyPresentationMutation(h, {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_session_answer', certainty: 'acknowledged',
    });
    await h.presentation.settleAgentSession('answer');
    assert.deepEqual(
      h.calls.filter(({ method }) => method === 'agents.sessions.setStatus')
        .map(({ input }) => input.status),
      ['processing', 'active'],
    );
    const stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion === 3) {
      assert.equal(stored.agentSession.desired, 'active');
      assert.equal(stored.agentSession.acknowledged, 'active');
      assert.equal(stored.agentSession.operation?.certainty, 'acknowledged');
    }
  } finally {
    h.db.close();
  }
});

test('V3 quarantines an unknown native processing receipt instead of blindly retrying', async () => {
  const h = harness({
    schemaVersion: 3,
    owner: { kind: 'chickpea' },
    sessionError: Object.assign(new Error('timeout'), { code: ErrorCode.RequestError }),
  });
  try {
    assert.equal(await h.presentation.beginAgentSessionProcessing(), false);
    assert.equal(await h.presentation.beginAgentSessionProcessing(), false);
    assert.equal(
      h.calls.filter(({ method }) => method === 'agents.sessions.setStatus').length,
      1,
    );
    const stored = h.store.get(h.runId);
    assert.equal(
      stored?.schemaVersion === 3 ? stored.agentSession.operation?.certainty : undefined,
      'unknown',
    );
  } finally {
    h.db.close();
  }
});

test('V3 marks a permanently unsupported native processing surface unavailable', async () => {
  const h = harness({
    schemaVersion: 3,
    owner: { kind: 'chickpea' },
    sessionError: new SlackTransportError('agents.sessions.setStatus', 'gateway_http_403', {
      retryable: false,
      effectOutcome: 'failed',
    }),
  });
  try {
    assert.equal(await h.presentation.beginAgentSessionProcessing(), false);
    const stored = h.store.get(h.runId);
    assert.equal(
      stored?.schemaVersion === 3 ? stored.agentSession.disposition : undefined,
      'unavailable',
    );
  } finally {
    h.db.close();
  }
});

test('new V2 work falls back cleanly when Slack rejects its native task stream', async () => {
  const h = harness({
    tasks: ['Inspect the customer'],
    startStreamError: { code: ErrorCode.PlatformError, data: { error: 'invalid_blocks' } },
  });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_native_rejected',
      receipt: { submissionId: 'submission_native_rejected', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: false, reason: 'effect_capable' },
    });
    assert.equal(relay, undefined);
    const stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 2);
    assert.equal(stored?.stream.state, 'fallback');
    assert.deepEqual(
      await h.presentation.finalize(
        'The checklist fallback remains authoritative.',
        'markdown',
        'complete',
        observer([]),
      ),
      { handled: false, fallbackPresentation: true },
    );
    assert.deepEqual(
      h.calls.filter((call) => call.method.startsWith('chat.')).map((call) => call.method),
      ['chat.startStream'],
    );
  } finally {
    h.db.close();
  }
});

test('new V2 work falls back when the gateway confirms its native task stream was rejected', async () => {
  const gatewayRejection = new SlackTransportError('chat.startStream', 'gateway_rejected', {
    effectOutcome: 'failed',
  });
  const h = harness({
    tasks: ['Inspect the customer'],
    native: true,
    startStreamError: gatewayRejection,
  });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_native_gateway_rejected',
      receipt: {
        submissionId: 'submission_native_gateway_rejected', acceptedAt: 'now', uid: 'uid',
      },
      eligibility: { allowed: false, reason: 'effect_capable' },
    });
    assert.equal(relay, undefined);
    assert.equal(h.store.get(h.runId)?.stream.state, 'fallback');
    assert.deepEqual(
      await h.presentation.finalize(
        'The ordinary Slack reply remains available.',
        'markdown',
        'complete',
        observer([]),
      ),
      { handled: false, fallbackPresentation: true },
    );
  } finally {
    h.db.close();
  }
});

test('native task start logs only the safe Slack transport code when acceptance is unknown', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => {
    warnings.push(values.map(String).join(' '));
  });
  const h = harness({
    tasks: ['Inspect the customer'],
    native: true,
    startStreamError: {
      code: ErrorCode.RequestError,
      message: 'secret-shaped transport diagnostic',
    },
  });
  try {
    await assert.rejects(prepareReceipt(h, {
      instanceId: 'instance_native_start_unknown',
      receipt: {
        submissionId: 'submission_native_start_unknown', acceptedAt: 'now', uid: 'uid',
      },
      eligibility: { allowed: false, reason: 'effect_capable' },
    }));
    assert.deepEqual(warnings, [
      '[chickpea] Slack Agent View native stream start unknown: slack_webapi_request_error',
    ]);
    assert.equal(h.store.get(h.runId)?.stream.state, 'unknown');
  } finally {
    h.db.close();
  }
});

test('native finalization logs only the safe Slack rejection code', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => {
    warnings.push(values.map(String).join(' '));
  });
  const h = harness({
    tasks: ['Inspect the customer'],
    native: true,
    stopStreamError: {
      code: ErrorCode.PlatformError,
      data: {
        error: 'invalid_chunks',
        response_metadata: { messages: ['[ERROR] secret-shaped diagnostic'] },
      },
    },
  });
  try {
    await prepareReceipt(h, {
      instanceId: 'instance_native_finalize_rejected',
      receipt: {
        submissionId: 'submission_native_finalize_rejected', acceptedAt: 'now', uid: 'uid',
      },
      eligibility: { allowed: false, reason: 'effect_capable' },
    });

    await assert.rejects(h.presentation.finalize(
      'The customer is ready for review.',
      'markdown',
      'complete',
      observer([]),
    ));
    assert.deepEqual(warnings, [
      '[chickpea] Slack Agent View stream finalization failed: invalid_chunks',
    ]);
  } finally {
    h.db.close();
  }
});

test('a late-attached plan opens a native task card and supersedes the interim checklist', async () => {
  const cleanups: string[] = [];
  // A late-classified mention is frozen WITHOUT tasks but WITH native tasks on.
  const h = harness({
    native: true,
    onNativeStarted: async () => { cleanups.push('deleted'); },
  });
  try {
    // No plan yet: nothing to open.
    assert.equal(h.store.get(h.runId)?.plan, undefined);

    await h.presentation.adoptLatePlan(['Mention result artifact']);
    const withPlan = h.store.get(h.runId);
    assert.equal(withPlan?.plan?.displayMode, 'timeline');
    assert.deepEqual(
      withPlan?.plan?.tasks.map((task) => task.status),
      ['pending'],
    );

    await prepareReceipt(h, {
      instanceId: 'instance_late_plan',
      receipt: { submissionId: 'submission_late_plan', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: false, reason: 'effect_capable' },
    });
    const start = h.calls.find((call) => call.method === 'chat.startStream');
    assert.deepEqual(
      (start?.input.chunks as Array<{ type: string; status: string }>).map((chunk) => [
        chunk.type,
        chunk.status,
      ]),
      [['task_update', 'in_progress']],
    );
    // The native stream is proven started, so the interim checklist cleanup ran.
    assert.deepEqual(cleanups, ['deleted']);
    assert.equal(h.store.get(h.runId)?.stream.state, 'streaming');
  } finally {
    h.db.close();
  }
});

test('adoptLatePlan is a no-op without native tasks and never overwrites an existing plan', async () => {
  const off = harness({ schemaVersion: 1, native: false });
  try {
    await off.presentation.adoptLatePlan(['Mention result artifact']);
    assert.equal(off.store.get(off.runId)?.plan, undefined);
  } finally {
    off.db.close();
  }
  const withPlan = harness({ tasks: ['Ambient artifact'], native: true });
  try {
    await withPlan.presentation.adoptLatePlan(['Mention result artifact']);
    // The admission plan is preserved byte-for-byte; the late label is ignored.
    assert.deepEqual(
      withPlan.store.get(withPlan.runId)?.plan?.tasks.map((task) => task.title),
      ['Ambient artifact'],
    );
  } finally {
    withPlan.db.close();
  }
});

test('a V1 progressive-off presentation stays terminal-only after the V2 deploy', async () => {
  const h = harness({ schemaVersion: 1, progressive: false, native: false });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_v1_terminal',
      receipt: { submissionId: 'submission_v1_terminal', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.equal(relay, undefined);
    assert.equal(h.calls.some((call) => call.method === 'chat.startStream'), false);

    assert.deepEqual(
      await h.presentation.finalize('Legacy terminal answer.', 'markdown', 'complete', observer([])),
      { handled: true, messageTs: '1785700100.000201' },
    );
    const stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 1);
    if (stored?.schemaVersion === 1) {
      assert.deepEqual(stored.features, { progressiveStreaming: false, nativeTasks: false });
    }
  } finally {
    h.db.close();
  }
});

test('a retry reuses frozen eligibility after the operations environment changes', async () => {
  const h = harness();
  try {
    assert.deepEqual(
      await h.presentation.freezeProgressiveEligibility({
        allowed: true,
        reason: 'safe_early_release',
      }),
      {
        allowed: true,
        reason: 'safe_early_release',
        presentationSchemaVersion: 2,
      },
    );
    assert.deepEqual(
      await h.presentation.freezeProgressiveEligibility({
        allowed: false,
        reason: 'operations_disabled',
      }),
      {
        allowed: true,
        reason: 'safe_early_release',
        presentationSchemaVersion: 2,
      },
    );
    assert.equal(h.store.get(h.runId)?.projectionVersion, 2);
  } finally {
    h.db.close();
  }
});

test('a V3 eligible answer without a declaration remains terminal and records not_requested', async () => {
  const h = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_terminal_choice',
      receipt: { submissionId: 'submission_terminal_choice', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.ok(relay);
    relay.onEvent({
      type: 'message-started', conversationId: 'conversation',
      submissionId: 'submission_terminal_choice', messageId: 'message_terminal_choice',
      position: { batch: 1, index: 0 },
    });
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId: 'message_terminal_choice',
      kind: 'text', delta: 'Short terminal answer.', position: { batch: 2, index: 0 },
    });
    await relay.closeAndDrain();
    assert.equal(h.calls.some((call) => call.method.startsWith('chat.')), false);
    const beforeFinal = h.store.get(h.runId);
    assert.equal(beforeFinal?.schemaVersion, 3);
    if (beforeFinal?.schemaVersion === 3) {
      assert.equal(beforeFinal.progressiveIntent.status, 'not_requested');
    }

    await h.presentation.finalize('Short terminal answer.', 'markdown', 'complete', observer([]));
    assert.deepEqual(
      h.calls.filter((call) => call.method.startsWith('chat.')).map((call) => call.method),
      ['chat.startStream', 'chat.stopStream'],
    );
  } finally {
    h.db.close();
  }
});

test('a V3 late progressive declaration is denied before any answer text is exposed', async () => {
  const h = harness({ schemaVersion: 3, owner: { kind: 'chickpea' } });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_v3_late_intent',
      receipt: { submissionId: 'submission_v3_late_intent', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.ok(relay);
    relay.onEvent({
      type: 'message-started', conversationId: 'conversation',
      submissionId: 'submission_v3_late_intent', messageId: 'message_v3_late_intent',
      position: { batch: 1, index: 0 },
    });
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId: 'message_v3_late_intent',
      kind: 'text', delta: 'This must remain terminal.', position: { batch: 2, index: 0 },
    });
    declareProgressiveIntent(relay, {
      submissionId: 'submission_v3_late_intent',
      messageId: 'message_v3_late_intent',
      firstBatch: 3,
    });
    const summary = await relay.closeAndDrain();
    assert.equal(summary.acceptedBytes, 0);
    assert.equal(h.calls.some((call) => call.method.startsWith('chat.')), false);
    const stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion === 3) {
      assert.deepEqual(stored.progressiveIntent, {
        status: 'denied', reason: 'late_declaration', decidedAt: 1_800_000_000_000,
      });
    }
  } finally {
    h.db.close();
  }
});

test('replaying a requested receipt repeats neither intent transitions nor Slack effects', async () => {
  const h = harness();
  try {
    const receipt = {
      submissionId: 'submission_replay', acceptedAt: 'now', uid: 'uid',
    } as const;
    const first = await prepareReceipt(h, {
      instanceId: 'instance_replay',
      receipt,
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.ok(first);
    const replayEvents = (relay: NonNullable<typeof first>) => {
      relay.onEvent({
        type: 'conversation-reset', conversationId: 'conversation',
        snapshot: { v: 1, conversationId: 'conversation', offset: '0', messages: [], settlements: [] },
        position: { batch: 0, index: 0 },
      });
      relay.onEvent({
        type: 'message-started', conversationId: 'conversation',
        submissionId: receipt.submissionId, messageId: 'message_replay',
        position: { batch: 1, index: 0 },
      });
      declareProgressiveIntent(relay, {
        submissionId: receipt.submissionId,
        messageId: 'message_replay',
      });
      relay.onEvent({
        type: 'message-delta', conversationId: 'conversation', messageId: 'message_replay',
        kind: 'text', delta: 'Replay-safe answer.', position: { batch: 4, index: 0 },
      });
    };
    replayEvents(first);
    await first.closeAndDrain();
    const afterFirst = h.store.get(h.runId);
    assert.equal(afterFirst?.schemaVersion, 2);
    const requestedVersion = afterFirst?.projectionVersion;
    const visibleEffects = () => h.calls.filter((call) =>
      call.method === 'chat.startStream' || call.method === 'chat.appendStream'
    );
    assert.equal(visibleEffects().length, 1);

    const replay = await h.presentation.prepareReceipt({
      instanceId: 'instance_replay',
      receipt,
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.ok(replay);
    replayEvents(replay);
    await replay.closeAndDrain();
    assert.equal(visibleEffects().length, 1);
    assert.equal(h.store.get(h.runId)?.projectionVersion, requestedVersion);

    await h.presentation.finalize('Replay-safe answer.', 'markdown', 'complete', observer([]));
    assert.equal(h.calls.filter((call) => call.method === 'chat.stopStream').length, 1);
  } finally {
    h.db.close();
  }
});

test('a retained V1 progressive-on row keeps its immediate legacy relay', async () => {
  const h = harness({ schemaVersion: 1, progressive: true, native: false });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_v1_progressive',
      receipt: { submissionId: 'submission_v1_progressive', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.ok(relay);
    relay.onEvent({
      type: 'message-started', conversationId: 'conversation',
      submissionId: 'submission_v1_progressive', messageId: 'message_v1_progressive',
      position: { batch: 1, index: 0 },
    });
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId: 'message_v1_progressive',
      kind: 'text', delta: 'Legacy progressive answer.', position: { batch: 2, index: 0 },
    });
    await relay.closeAndDrain();
    assert.equal(h.calls.filter((call) => call.method === 'chat.startStream').length, 1);
    const stored = h.store.get(h.runId);
    assert.equal(stored?.schemaVersion, 1);
    assert.equal(stored && 'progressiveIntent' in stored, false);
  } finally {
    h.db.close();
  }
});

test('V3 intent persistence failure emits no answer text and marks presentation for repair', async () => {
  const h = harness({
    schemaVersion: 3,
    owner: { kind: 'chickpea' },
    failIntentMutation: true,
  });
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_intent_failure',
      receipt: { submissionId: 'submission_intent_failure', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.ok(relay);
    relay.onEvent({
      type: 'message-started', conversationId: 'conversation',
      submissionId: 'submission_intent_failure', messageId: 'message_intent_failure',
      position: { batch: 1, index: 0 },
    });
    declareProgressiveIntent(relay, {
      submissionId: 'submission_intent_failure',
      messageId: 'message_intent_failure',
    });
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId: 'message_intent_failure',
      kind: 'text', delta: 'must not escape', position: { batch: 4, index: 0 },
    });
    assert.equal((await relay.closeAndDrain()).invalidationReason, 'intent_persistence_failed');
    assert.equal(h.calls.some((call) => call.method.startsWith('chat.')), false);
    const stored = h.store.get(h.runId);
    assert.equal(stored?.stream.state, 'unknown');
    assert.equal(stored?.repairRequired, true);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion === 3) {
      assert.deepEqual(stored.progressiveIntent, {
        status: 'denied',
        reason: 'persistence_failure',
        decidedAt: 1_800_000_000_000,
      });
    }
  } finally {
    h.db.close();
  }
});

test('legacy checklist cleanup cannot make a proven native stream ambiguous', async () => {
  const h = harness({
    tasks: ['Inspect the customer'],
    native: true,
    onNativeStarted: async () => { throw new Error('cleanup unavailable'); },
  });
  try {
    await prepareReceipt(h, {
      instanceId: 'instance_native_cleanup',
      receipt: { submissionId: 'submission_native_cleanup', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: false, reason: 'effect_capable' },
    });

    const stored = h.store.get(h.runId);
    assert.equal(stored?.stream.state, 'streaming');
    assert.equal(stored?.repairRequired, false);
  } finally {
    h.db.close();
  }
});

test('a divergent terminal answer corrects the exact stream instead of posting a second answer', async () => {
  const h = harness();
  try {
    const relay = await prepareReceipt(h, {
      instanceId: 'instance_correction',
      receipt: { submissionId: 'submission_correction', acceptedAt: 'now', uid: 'uid' },
      eligibility: { allowed: true, reason: 'safe_early_release' },
    });
    assert.ok(relay);
    relay.onEvent({
      type: 'message-started', conversationId: 'conversation',
      submissionId: 'submission_correction', messageId: 'message_correction',
      position: { batch: 1, index: 0 },
    });
    declareProgressiveIntent(relay, {
      submissionId: 'submission_correction',
      messageId: 'message_correction',
    });
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId: 'message_correction',
      kind: 'text', delta: 'Draft answer', position: { batch: 4, index: 0 },
    });
    await relay.closeAndDrain();

    await h.presentation.finalize('Approved answer', 'markdown', 'complete', observer([]));
    assert.deepEqual(
      h.calls.filter((call) => call.method.startsWith('chat.')).map((call) => call.method),
      ['chat.startStream', 'chat.stopStream', 'chat.update'],
    );
    const update = h.calls.find((call) => call.method === 'chat.update')?.input;
    assert.equal(update?.ts, '1785700100.000201');
    assert.match(JSON.stringify(update), /Approved answer/);
    assert.match(JSON.stringify(update), /Corrected/);
    assert.equal(h.store.get(h.runId)?.stream.presentationOutcome, 'corrected');
  } finally {
    h.db.close();
  }
});

test('thread titles are deterministic, bounded, and reject credential-shaped input', async () => {
  assert.equal(deriveSlackThreadTitle('  <@U123> **Review** the release  '), 'Review the release');
  assert.equal(
    deriveSlackThreadTitle('<!subteam^S0BRSUAUTUL> hey bud'),
    'hey bud',
  );
  assert.equal(
    deriveSlackThreadTitle('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456'),
    'New request',
  );
  assert.ok(deriveSlackThreadTitle('x'.repeat(200)).length <= 80);

  const h = harness();
  try {
    await h.presentation.setTitle('Review the release');
    await h.presentation.setTitle('Review the release');
    assert.equal(
      h.calls.filter((call) => call.method === 'assistant.threads.setTitle').length,
      1,
    );
    assert.equal(h.store.get(h.runId)?.title?.outcome, 'set');
  } finally {
    h.db.close();
  }
});
