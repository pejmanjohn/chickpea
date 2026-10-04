import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { hasDeliveredOnboardingReply } from '../src/admin/onboarding-proof.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import {
  DEFERRED_SHADOW_WRITE_BUDGET_MS,
  SHADOW_BACKLOG_DEADLINE_MS,
  ShadowWorkLifecycle,
} from '../src/work/lifecycle.ts';
import { createWorkExecutionLifecycle } from '../src/work/executor.ts';
import { SqliteWorkStore, WorkStoreLogic } from '../src/work/store.ts';
import {
  WorkStateError,
  type AdmitShadowRunInput,
  type BindingId,
  type RunId,
  type WorkStore,
  type WorkId,
} from '../src/work/types.ts';

const NOW = 1_900_000_000_000;

test('settled Slack recovery reuses the execution and pending delivery without rewriting output', async () => {
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('original prompt');
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const pending = await fixture.lifecycle.beforeDelivery({ method: 'slack_chat_stream_resume',
      approvedOutput: 'Approved answer', renderedPayload: '{"stop":"original suffix"}' });
    const before = await fixture.store.listRunExecutions(fixture.runId);
    const gaps: string[] = [];
    const resumed = await createWorkExecutionLifecycle(fixture.store, {
      runId: fixture.runId, attemptNumber: 2, executorKind: 'agent', agentName: 'profile_alpha',
      canonicalModel: 'openai/gpt-5.6-sol', flueInstanceRef: 'flueinstance_test', routeEvidence: {},
      resumeSettled: true,
    }, { mode: 'enforce', now: () => NOW + 1000, onGap: (stage) => gaps.push(stage) });
    assert.equal(await resumed.prepareExecution('rehydrated prompt'), 'original prompt');
    assert.equal(resumed.executionId, fixture.lifecycle.executionId);
    await resumed.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await resumed.beforeDelivery({ method: 'slack_chat_stream_recover',
      approvedOutput: 'Approved answer', renderedPayload: '{"update":"Approved answer"}' });
    assert.equal(attemptId, pending);
    await resumed.afterDelivery({ attemptId, outcome: 'delivered', deliveryRef: 'slack:C123:123.456' });
    assert.deepEqual(await fixture.store.listRunExecutions(fixture.runId), before);
    assert.equal((await fixture.store.getRun(fixture.runId))?.status, 'settled');
    assert.deepEqual(gaps, []);
  } finally { fixture.close(); }
});

test('legacy shadow writes stop blocking after their bounded observer budget', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  context.mock.method(console, 'warn', () => undefined);
  const never = new Promise<never>(() => undefined);
  const gaps: string[] = [];
  let laterWrites = 0;
  const lifecycle = new ShadowWorkLifecycle({
    store: {
      prepareRunInput: async () => never,
      createRunExecution: async () => { laterWrites += 1; },
      recordRunExecutionRoute: async () => { laterWrites += 1; },
    } as unknown as WorkStore,
    runId: 'run_shadow_budget' as RunId,
    attemptNumber: 1,
    agentName: 'profile_shadow_budget',
    canonicalModel: 'openai/gpt-5.6-sol',
    sensitivity: 'public',
    routeEvidence: {},
    mode: 'observe',
    observeWriteBudgetMs: 5,
    onGap: (stage) => gaps.push(stage),
  });
  let settled = false;
  const preparation = lifecycle.prepareExecution('prompt').then((value) => {
    settled = true;
    return value;
  });
  context.mock.timers.tick(4);
  // Flush the promise chain without advancing the controlled timeout clock.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the observer must wait for its full budget');
  context.mock.timers.tick(1);
  assert.equal(await preparation, undefined);
  assert.equal(Date.now(), NOW + 5);
  assert.equal(lifecycle.hasExecution, false);
  // The write the turn stopped waiting for may still land: not a gap yet.
  assert.deepEqual(gaps, []);
  let drained = false;
  const backlog = lifecycle.settled().then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  context.mock.timers.tick(DEFERRED_SHADOW_WRITE_BUDGET_MS - 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'the backlog waits its own budget for the slow write');
  context.mock.timers.tick(1);
  await backlog;
  assert.deepEqual(gaps, ['prepare_input']);
  assert.equal(laterWrites, 0, 'nothing is recorded behind a write that never landed');
});

// Hosted run 9b: a thread runner reaches the state store over RPC, and one
// write slower than the 100 ms observer budget left the DM's Run unsettled,
// so onboarding's Try step never saw the delivered reply.
for (const slow of [
  'prepareRunInput',
  'createRunExecution',
  'recordRunExecutionRoute',
  'settleRunExecution',
  'recordRunResponse',
  'startRunDelivery',
  'finalizeRunDelivery',
] as const) {
  test(`a delivered DM still settles its Run when ${slow} outlives the observer budget`, async (context) => {
    context.mock.method(console, 'warn', () => undefined);
    const fixture = await slowDmFixture(slow);
    try {
      const gaps: string[] = [];
      let tick = 0;
      const lifecycle = await createWorkExecutionLifecycle(fixture.store, {
        runId: fixture.runId,
        attemptNumber: 1,
        executorKind: 'agent',
        agentName: 'agent_try',
        canonicalModel: 'openai/gpt-5.6-terra',
        routeEvidence: { providerAuthRoute: 'openai_api_key' },
      }, { mode: 'observe', now: () => NOW + (++tick), onGap: (stage) => gaps.push(stage) });
      // The whole turn runs while the slow write is still held: it never waits for it.
      await lifecycle.prepareExecution('Hi Chickpea. What is a good first teammate?');
      const linked: string[] = [];
      lifecycle.whenExecutionRecorded((executionId) => linked.push(executionId));
      const creationHeld = slow === 'prepareRunInput' || slow === 'createRunExecution';
      assert.deepEqual(linked, creationHeld ? [] : [lifecycle.executionId]);
      await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
      const attemptId = await lifecycle.beforeDelivery({
        method: 'slack_chat_stream',
        approvedOutput: 'Start with a planner.',
        renderedPayload: '{"stop":"Start with a planner."}',
      });
      assert.ok(attemptId, 'delivery keeps its attempt behind the slow write');
      await lifecycle.afterDelivery({
        attemptId, outcome: 'delivered', deliveryRef: 'slack:D0TRY:1900000000.000002',
      });
      assert.equal(fixture.calls(slow), 1);
      assert.notEqual((await fixture.store.getRun(fixture.runId))?.status, 'settled');

      fixture.release();
      await lifecycle.settled();

      const run = await fixture.store.getRun(fixture.runId);
      assert.equal(run?.status, 'settled');
      assert.equal(run?.terminalDisposition, 'succeeded');
      assert.equal(run?.deliveryStatus, 'delivered');
      assert.equal(run?.deliveryRef, 'slack:D0TRY:1900000000.000002');
      assert.equal((await fixture.store.getRunExecution(lifecycle.executionId))?.outcome, 'succeeded');
      assert.equal(fixture.calls(slow), 1, 'the slow write is awaited, never repeated');
      assert.deepEqual(linked, [lifecycle.executionId], 'usage can name the execution once it lands');
      assert.deepEqual(gaps, []);
      assert.deepEqual(
        (await fixture.store.listAuditEvents(fixture.runId)).reverse().map((event) => event.eventType),
        [
          'work.run_admitted',
          'work.input_prepared',
          'work.execution_created',
          'work.execution_route_recorded',
          'work.execution_settled',
          'work.response_recorded',
          'work.delivery_started',
          'work.delivery_delivered',
        ],
      );
      assert.equal(await hasDeliveredOnboardingReply(fixture.store, fixture.onboarding), true);
    } finally {
      fixture.close();
    }
  });
}

test('a slow write that then fails is a gap, and nothing is recorded behind it', async (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const fixture = await slowDmFixture('prepareRunInput');
  try {
    const gaps: string[] = [];
    const lifecycle = await createWorkExecutionLifecycle(fixture.store, {
      runId: fixture.runId,
      attemptNumber: 1,
      executorKind: 'agent',
      agentName: 'agent_try',
      canonicalModel: 'openai/gpt-5.6-terra',
      routeEvidence: {},
    }, { mode: 'observe', onGap: (stage) => gaps.push(stage) });
    assert.equal(await lifecycle.prepareExecution('prompt'), undefined);
    const linked: string[] = [];
    lifecycle.whenExecutionRecorded((executionId) => linked.push(executionId));
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message', approvedOutput: 'answer', renderedPayload: '{}',
    });
    await lifecycle.afterDelivery({ attemptId, outcome: 'delivered', deliveryRef: 'slack:D0TRY:1.2' });

    fixture.release(new Error('state store unavailable'));
    await lifecycle.settled();

    assert.deepEqual(gaps, ['prepare_input']);
    assert.deepEqual(linked, [], 'no execution that never existed is handed out');
    assert.equal(fixture.calls('createRunExecution'), 0);
    assert.equal(fixture.calls('finalizeRunDelivery'), 0);
    assert.equal((await fixture.store.getRun(fixture.runId))?.status, 'admitted');
    // Once a gap is recorded the lifecycle stays out of the way.
    assert.equal(await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message', approvedOutput: 'answer', renderedPayload: '{}',
    }), undefined);
  } finally {
    fixture.close();
  }
});

test('a finished turn waits a bounded time for its queued writes, then records a gap', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const warnings: string[] = [];
  context.mock.method(console, 'warn', (message: unknown) => { warnings.push(String(message)); });
  // Every write lands well inside its own budget, but together they would
  // hold the thread's next message far longer than the backlog may.
  const writes: string[] = [];
  const store = Object.fromEntries([
    'prepareRunInput', 'createRunExecution', 'recordRunExecutionRoute', 'settleRunExecution',
    'recordRunResponse', 'startRunDelivery', 'finalizeRunDelivery',
  ].map((method) => [method, async () => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    writes.push(method);
  }])) as unknown as WorkStore;
  const gaps: string[] = [];
  const lifecycle = new ShadowWorkLifecycle({
    store,
    runId: 'run_shadow_backlog' as RunId,
    attemptNumber: 1,
    agentName: 'profile_shadow_backlog',
    canonicalModel: 'openai/gpt-5.6-sol',
    sensitivity: 'public',
    routeEvidence: {},
    mode: 'observe',
    onGap: (stage) => gaps.push(stage),
  });
  const preparing = lifecycle.prepareExecution('prompt');
  await advance(context, 100);
  assert.equal(await preparing, undefined);
  await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
  const attemptId = await lifecycle.beforeDelivery({
    method: 'slack_chat_post_message', approvedOutput: 'answer', renderedPayload: '{}',
  });
  assert.ok(attemptId);
  await lifecycle.afterDelivery({ attemptId, outcome: 'delivered', deliveryRef: 'slack:D0:1.2' });
  assert.equal(Date.now(), NOW + 100, 'the turn waits one observer budget and none of the queued writes');

  let finished = false;
  const settling = lifecycle.settled().then(() => { finished = true; });
  await advance(context, SHADOW_BACKLOG_DEADLINE_MS - 1);
  assert.equal(finished, false);
  assert.deepEqual(writes, ['prepareRunInput', 'createRunExecution']);
  assert.deepEqual(gaps, []);
  await advance(context, 1);
  assert.equal(finished, true, 'the backlog stops at its deadline');
  await settling;
  assert.deepEqual(gaps, ['record_route'], 'the write in flight at the deadline is the gap');
  assert.ok(warnings.some((warning) => warning.includes('gap at record_route')));
  await advance(context, DEFERRED_SHADOW_WRITE_BUDGET_MS);
  assert.deepEqual(
    writes,
    ['prepareRunInput', 'createRunExecution', 'recordRunExecutionRoute'],
    'nothing behind the gap is written',
  );
});

test('a resumed stream recovery waits for the writes queued before it, then finalizes its delivery', async (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('original prompt');
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const pending = await fixture.lifecycle.beforeDelivery({ method: 'slack_chat_stream_resume',
      approvedOutput: 'Approved answer', renderedPayload: '{"stop":"original suffix"}' });
    const held = holdStoreMethod(fixture.store, 'settleRunExecution');
    const gaps: string[] = [];
    const resumed = await createWorkExecutionLifecycle(held.store, {
      runId: fixture.runId, attemptNumber: 2, executorKind: 'agent', agentName: 'profile_alpha',
      canonicalModel: 'openai/gpt-5.6-sol', flueInstanceRef: 'flueinstance_test', routeEvidence: {},
      resumeSettled: true,
    }, { mode: 'observe', now: () => NOW + 1000, onGap: (stage) => gaps.push(stage) });
    assert.equal(await resumed.prepareExecution('rehydrated prompt'), 'original prompt');
    // Outlives the observer budget: queued, and the recovery read is behind it.
    await resumed.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    setTimeout(() => held.release(), 50);
    const attemptId = await resumed.beforeDelivery({ method: 'slack_chat_stream_recover',
      approvedOutput: 'Approved answer', renderedPayload: '{"update":"Approved answer"}' });
    assert.equal(attemptId, pending, 'the recovery reads its pending delivery, never skips it');
    const afterSettle = held.calls.slice(held.calls.indexOf('settleRunExecution'));
    const landed = afterSettle.indexOf('settleRunExecution landed');
    assert.ok(
      landed > 0 && afterSettle.indexOf('getRun') > landed,
      'the recovery read waits for the write queued before it',
    );
    await resumed.afterDelivery({ attemptId, outcome: 'delivered', deliveryRef: 'slack:C123:123.456' });
    await resumed.settled();
    const run = await fixture.store.getRun(fixture.runId);
    assert.equal(run?.status, 'settled');
    assert.equal(run?.deliveryStatus, 'delivered');
    assert.deepEqual(gaps, []);
  } finally { fixture.close(); }
});

test('a resumed attempt reads its saved input although the read outlives the observer budget', async (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('original prompt');
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const held = holdStoreMethod(fixture.store, 'getContent');
    const gaps: string[] = [];
    const resumed = await createWorkExecutionLifecycle(held.store, {
      runId: fixture.runId, attemptNumber: 2, executorKind: 'agent', agentName: 'profile_alpha',
      canonicalModel: 'openai/gpt-5.6-sol', flueInstanceRef: 'flueinstance_test', routeEvidence: {},
      resumeSettled: true,
    }, { mode: 'observe', onGap: (stage) => gaps.push(stage) });
    setTimeout(() => held.release(), 150);
    assert.equal(await resumed.prepareExecution('rehydrated prompt'), 'original prompt');
    assert.equal(resumed.hasExecution, true);
    assert.deepEqual(gaps, []);
  } finally { fixture.close(); }
});

test('a resumed read the store never answers is a gap after its bound', { timeout: 5000 }, async (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('original prompt');
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    await fixture.lifecycle.beforeDelivery({ method: 'slack_chat_stream_resume',
      approvedOutput: 'Approved answer', renderedPayload: '{"stop":"original suffix"}' });
    const held = holdStoreMethod(fixture.store, 'getRun', false);
    const gaps: string[] = [];
    const resumed = await createWorkExecutionLifecycle(held.store, {
      runId: fixture.runId, attemptNumber: 2, executorKind: 'agent', agentName: 'profile_alpha',
      canonicalModel: 'openai/gpt-5.6-sol', flueInstanceRef: 'flueinstance_test', routeEvidence: {},
      resumeSettled: true,
    }, { mode: 'observe', onGap: (stage) => gaps.push(stage) });
    assert.equal(await resumed.prepareExecution('rehydrated prompt'), 'original prompt');
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
    held.arm();
    let done = false;
    const recovering = resumed.beforeDelivery({ method: 'slack_chat_stream_recover',
      approvedOutput: 'Approved answer', renderedPayload: '{"update":"Approved answer"}' })
      .then((attemptId) => { done = true; return attemptId; });
    await advance(context, DEFERRED_SHADOW_WRITE_BUDGET_MS - 1);
    assert.equal(done, false, 'the read waits its bound for the store');
    await advance(context, 1);
    assert.equal(done, true, 'and no longer');
    assert.equal(await recovering, undefined);
    assert.deepEqual(gaps, ['start_delivery']);
  } finally { fixture.close(); }
});

test('durable observational Work waits past 100ms without turning a slow owner into a gap', async () => {
  const fixture = await lifecycleFixture('public');
  const gaps: string[] = [];
  const delayed = new Proxy(fixture.store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      return async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 125));
        return bound(...args);
      };
    },
  }) as WorkStore;
  try {
    const lifecycle = new ShadowWorkLifecycle({
      store: delayed,
      runId: fixture.runId,
      attemptNumber: 2,
      agentName: 'profile_durable_routine',
      canonicalModel: 'openai/gpt-5.6-sol',
      sensitivity: 'public',
      routeEvidence: { providerAuthRoute: 'openai_api_key' },
      mode: 'observe',
      persistenceMode: 'durable',
      observeWriteBudgetMs: 5,
      onGap: (stage) => gaps.push(stage),
      now: () => NOW + 100,
    });
    const started = performance.now();
    assert.equal(await lifecycle.prepareExecution('durable routine prompt'), 'durable routine prompt');
    assert.ok(performance.now() - started >= 475);
    assert.equal(lifecycle.hasExecution, true);
    assert.deepEqual(gaps, []);
  } finally {
    fixture.close();
  }
});

test('legacy shadow lifecycle settles through the synchronous in-isolate store', async () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const runId = 'run_lifecycle_alpha' as RunId;
    store.admitShadowRun(lifecycleAdmission('public'));
    const lifecycle = new ShadowWorkLifecycle({
      store: store as unknown as WorkStore,
      runId,
      attemptNumber: 1,
      agentName: 'profile_sync_in_isolate',
      canonicalModel: 'cloudflare/@cf/zai-org/glm-5.2',
      sensitivity: 'public',
      routeEvidence: {},
      mode: 'observe',
      now: () => NOW,
    });

    assert.equal(await lifecycle.prepareExecution('prepared prompt'), 'prepared prompt');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'accepted answer',
      renderedPayload: '{"text":"accepted answer"}',
    });
    await lifecycle.afterDelivery({
      attemptId,
      outcome: 'delivered',
      deliveryRef: 'slack:C123:1900000000.000004',
    });

    assert.ok(attemptId);
    assert.equal(store.getRun(runId)?.status, 'settled');
    assert.equal(store.getRun(runId)?.deliveryStatus, 'delivered');
    assert.equal(store.getRunExecution(lifecycle.executionId)?.outcome, 'succeeded');
  } finally {
    db.close();
  }
});

test('shadow lifecycle keeps prepared input, approved output, render, and delivery distinct', async () => {
  const fixture = await lifecycleFixture('public');
  try {
    const lifecycle = fixture.lifecycle;
    assert.equal(await lifecycle.prepareExecution('prepared prompt'), 'prepared prompt');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'accepted answer',
      renderedPayload: '{"blocks":["rendered answer"]}',
    });
    await lifecycle.afterDelivery({
      attemptId,
      outcome: 'delivered',
      deliveryRef: 'slack:C123:1900000000.000001',
    });

    const run = await fixture.store.getRun(fixture.runId);
    assert.ok(run);
    assert.equal(run.status, 'settled');
    assert.equal(run.terminalDisposition, 'succeeded');
    assert.equal(run.deliveryStatus, 'delivered');
    assert.notEqual(run.triggerContentRef, run.preparedInputRef);
    assert.notEqual(run.preparedInputRef, run.policyApprovedOutputRef);
    assert.notEqual(run.policyApprovedOutputRef, run.renderedPayloadRef);
    assert.equal((await fixture.store.getContent(run.preparedInputRef!))?.body, 'prepared prompt');
    assert.equal(
      (await fixture.store.getContent(run.policyApprovedOutputRef!))?.body,
      'accepted answer',
    );
    assert.equal(
      (await fixture.store.getContent(run.renderedPayloadRef!))?.body,
      '{"blocks":["rendered answer"]}',
    );
    const execution = await fixture.store.getRunExecution(lifecycle.executionId);
    assert.equal(execution?.outcome, 'succeeded');
    assert.equal(execution?.modelInvocationStatus, 'settled');
    assert.equal(execution?.providerAuthRoute, 'openai_api_key');
    assert.deepEqual(
      (await fixture.store.listAuditEvents(fixture.runId))
        .reverse()
        .map((event) => event.eventType),
      [
        'work.run_admitted',
        'work.input_prepared',
        'work.execution_created',
        'work.execution_route_recorded',
        'work.execution_invoked',
        'work.execution_settled',
        'work.response_recorded',
        'work.delivery_started',
        'work.delivery_delivered',
      ],
    );
  } finally {
    fixture.close();
  }
});

test('confirmed non-delivery can replace only the adapter render before fallback', async () => {
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('prepared prompt');
    await fixture.lifecycle.markInvoked();
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const streamAttempt = await fixture.lifecycle.beforeDelivery({
      method: 'slack_chat_stream',
      approvedOutput: 'same answer',
      renderedPayload: '{"method":"stream"}',
    });
    await fixture.lifecycle.afterDelivery({
      attemptId: streamAttempt,
      outcome: 'failed',
      safeFailureCode: 'slack_stream_not_started',
    });
    const failed = await fixture.store.getRun(fixture.runId);
    const approvedRef = failed?.policyApprovedOutputRef;
    const streamRenderRef = failed?.renderedPayloadRef;
    assert.equal(failed?.deliveryStatus, 'failed');

    const postAttempt = await fixture.lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'same answer',
      renderedPayload: '{"method":"post"}',
    });
    await fixture.lifecycle.afterDelivery({
      attemptId: postAttempt,
      outcome: 'delivered',
      deliveryRef: 'slack:C123:1900000000.000002',
    });
    const delivered = await fixture.store.getRun(fixture.runId);
    assert.equal(delivered?.policyApprovedOutputRef, approvedRef);
    assert.notEqual(delivered?.renderedPayloadRef, streamRenderRef);
    assert.equal(delivered?.deliveryMethod, 'slack_chat_post_message');
  } finally {
    fixture.close();
  }
});

test('a confirmed delivery retry reuses durable prepared input despite later context drift', async () => {
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('original prepared prompt');
    await fixture.lifecycle.markInvoked();
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const firstAttempt = await fixture.lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'first answer',
      renderedPayload: '{"attempt":1}',
    });
    await fixture.lifecycle.afterDelivery({
      attemptId: firstAttempt,
      outcome: 'failed',
      safeFailureCode: 'slack_post_failed',
    });
    const firstRun = await fixture.store.getRun(fixture.runId);
    const preparedRef = firstRun?.preparedInputRef;

    const retry = new ShadowWorkLifecycle({
      store: fixture.store,
      runId: fixture.runId,
      attemptNumber: 2,
      agentName: 'profile_alpha',
      canonicalModel: 'openai/gpt-5.6-sol',
      sensitivity: 'public',
      routeEvidence: { providerAuthRoute: 'openai_api_key' },
      now: () => NOW + 100,
    });
    assert.equal(
      await retry.prepareExecution('edited or rehydrated prompt'),
      'original prepared prompt',
    );
    assert.equal((await fixture.store.getRun(fixture.runId))?.preparedInputRef, preparedRef);
    assert.equal((await fixture.store.getRunExecution(retry.executionId))?.attemptNumber, 2);
  } finally {
    fixture.close();
  }
});

test('private bodies never enter Work audit and stale fences cannot append lifecycle state', async () => {
  const fixture = await lifecycleFixture('private');
  const canary = 'PRIVATE_LIFECYCLE_CANARY_4b9a';
  try {
    await fixture.lifecycle.prepareExecution(canary);
    await fixture.lifecycle.markInvoked();
    await fixture.lifecycle.settleExecution({ outcome: 'failed', rawStatus: 'flue_failed', safeFailureCode: 'provider_failed' });
    const attemptId = await fixture.lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: canary,
      renderedPayload: JSON.stringify({ text: canary }),
    });
    assert.ok(attemptId);
    await assert.rejects(
      fixture.store.finalizeRunDelivery({
        runId: fixture.runId,
        fencingToken: 2,
        attemptId: attemptId!,
        outcome: 'delivered',
        deliveryRef: 'slack:C123:1900000000.000003',
        finalizedAt: NOW + 20,
      }),
      (error: unknown) => error instanceof WorkStateError && error.code === 'work_fence_stale',
    );
    assert.doesNotMatch(
      JSON.stringify(await fixture.store.listAuditEvents(fixture.runId)),
      new RegExp(canary),
    );
  } finally {
    fixture.close();
  }
});

test('action receipts are fenced, paired, body-free, and unknown outcomes require recovery', async () => {
  const fixture = await lifecycleFixture('private');
  try {
    await fixture.lifecycle.prepareExecution('private action prompt');
    await fixture.lifecycle.markInvoked();
    const common = {
      runId: fixture.runId,
      runExecutionId: fixture.lifecycle.executionId,
      fencingToken: fixture.lifecycle.fencingToken,
      actionAttemptId: 'action_lifecycle_alpha',
      actionClass: 'mcp_write',
      targetKind: 'asana_task',
      flueCorrelation: 'toolcall_lifecycle_alpha',
    } as const;
    await fixture.store.recordWorkAction({
      ...common,
      eventId: 'audit_action_started_alpha',
      idempotencyKey: 'auditkey_action_started_alpha',
      status: 'started',
      createdAt: NOW + 30,
    });
    await fixture.store.recordWorkAction({
      ...common,
      eventId: 'audit_action_unknown_alpha',
      idempotencyKey: 'auditkey_action_unknown_alpha',
      status: 'unknown',
      reasonCode: 'external_outcome_unknown',
      createdAt: NOW + 31,
    });
    const run = await fixture.store.getRun(fixture.runId);
    assert.equal(run?.status, 'recovery_required');
    assert.equal(run?.safeFailureCode, 'action_unknown');
    const serialized = JSON.stringify(await fixture.store.listAuditEvents(fixture.runId));
    assert.match(serialized, /mcp_write/);
    assert.doesNotMatch(serialized, /private action prompt/);
    assert.deepEqual(await fixture.store.verifyIntegrity(), {
      foreignKeysEnabled: true,
      foreignKeyViolationCount: 0,
      invariantViolationCount: 0,
    });
  } finally {
    fixture.close();
  }
});

test('pre-call resolver failure records not submitted without fabricating invocation evidence', async () => {
  const fixture = await lifecycleFixture('public', true);
  try {
    await fixture.lifecycle.prepareExecution('prepared resolver input');
    await fixture.lifecycle.settleExecution({
      outcome: 'not_submitted',
      rawStatus: 'model_not_invoked',
      safeFailureCode: 'subscription_reconnect',
    });
    const execution = await fixture.store.getRunExecution(fixture.lifecycle.executionId);
    assert.equal(execution?.outcome, 'not_submitted');
    assert.equal(execution?.modelInvocationStatus, 'not_invoked');
    assert.equal(execution?.providerAuthRoute, null);
    assert.equal(execution?.catalogRevision, null);
    assert.equal(execution?.modelCredentialRef, null);
    assert.equal(execution?.flueSubmissionRef, null);
  } finally {
    fixture.close();
  }
});

for (const [label, rawStatus, method] of [
  ['a management approval', 'host_management_approval_succeeded', 'slack_chat_post_message'],
  ['a react-only turn', 'adapter_reaction_only', 'slack_reaction_add'],
] as const) {
  test(`${label} with a prepared OpenAI route settles its execution and run without a model call`, async () => {
    const fixture = await lifecycleFixture('public');
    try {
      await fixture.lifecycle.prepareExecution('prepared input');
      const ready = await fixture.store.getRunExecution(fixture.lifecycle.executionId);
      assert.equal(ready?.providerAuthRoute, 'openai_api_key', 'the route is recorded at prepare');
      await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus, modelInvoked: false });
      const execution = await fixture.store.getRunExecution(fixture.lifecycle.executionId);
      assert.equal(execution?.outcome, 'succeeded');
      assert.equal(execution?.modelInvocationStatus, 'not_invoked');
      assert.equal(execution?.providerAuthRoute, null);
      const attemptId = await fixture.lifecycle.beforeDelivery({
        method, approvedOutput: 'Done.', renderedPayload: JSON.stringify({ method }),
      });
      assert.ok(attemptId, 'the lifecycle stays usable after settlement');
      await fixture.lifecycle.afterDelivery({ attemptId, outcome: 'delivered', deliveryRef: 'slack:C123:123.456' });
      const run = await fixture.store.getRun(fixture.runId);
      assert.equal(run?.status, 'settled', 'the Work run is not left executing');
      assert.equal(run?.deliveryStatus, 'delivered');
    } finally {
      fixture.close();
    }
  });
}

async function lifecycleFixture(
  sensitivity: 'public' | 'private',
  deferRoute = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-work-lifecycle-'));
  const store = new SqliteWorkStore(join(directory, 'state.sqlite'), { now: () => NOW });
  const runId = 'run_lifecycle_alpha' as RunId;
  await store.admitShadowRun(lifecycleAdmission(sensitivity));
  let tick = 0;
  const lifecycle = new ShadowWorkLifecycle({
    store,
    runId,
    attemptNumber: 1,
    agentName: 'profile_alpha',
    canonicalModel: 'openai/gpt-5.6-sol',
    sensitivity,
    flueInstanceRef: 'flueinstance_test',
    routeEvidence: {
      providerAuthRoute: 'openai_api_key',
      catalogSource: 'bundled',
      catalogRevision: '0',
      catalogDigest: 'c'.repeat(64),
      compiledProfile: 'openai-platform-responses-sol-tier@1',
      modelCredentialRef: 'cred_openai_alpha',
      modelCredentialVersion: 1,
    },
    ...(deferRoute ? { deferRoute: true } : {}),
    now: () => NOW + (++tick),
  });
  return {
    store,
    runId,
    lifecycle,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Advance mocked timers in steps, letting each step's promise work run. */
async function advance(context: TestContext, ms: number, step = 100): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    context.mock.timers.tick(Math.min(step, left));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** `base` with one method held, once armed, until `release`; `calls` lists every call in order. */
function holdStoreMethod(base: WorkStore, method: keyof WorkStore, armed = true) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let holding = armed;
  const calls: string[] = [];
  const store = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      return async (...args: unknown[]) => {
        calls.push(String(property));
        if (property !== method) return bound(...args);
        if (holding) await held;
        const result = await bound(...args);
        calls.push(`${method} landed`);
        return result;
      };
    },
  }) as WorkStore;
  return { store, calls, arm: () => { holding = true; }, release };
}

const TRY_ASSIGNMENT: ResolvedAssignment = {
  workspaceId: 'T0TRY',
  channelId: 'D0TRY',
  agentId: 'agent_try',
  model: 'openai/gpt-5.6-terra',
  agent: {
    id: 'agent_try',
    kind: 'user',
    revision: 1,
    name: 'Try Guide',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

/**
 * An onboarding Try DM's Run in a store whose `slow` method is held until
 * `release`, like a thread runner's state-store RPC that outlives the budget.
 */
async function slowDmFixture(slow: keyof WorkStore) {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-work-slow-'));
  const base = new SqliteWorkStore(join(directory, 'state.sqlite'));
  const turn: NormalizedSlackTurn = {
    workspaceId: 'T0TRY',
    channelId: 'D0TRY',
    channelType: 'im',
    eventId: 'Ev0TRY',
    text: 'Hi Chickpea. What is a good first teammate?',
    userId: 'U0OWNER',
    messageTs: '1900000000.000001',
    threadTs: '1900000000.000001',
    source: 'dm_message',
    contextMode: 'thread',
  };
  const admitted = await base.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: TRY_ASSIGNMENT, sourceVisibility: 'private', admittedAt: NOW,
  }));
  const counts = new Map<string, number>();
  let release!: (error?: Error) => void;
  const held = new Promise<void>((resolve, reject) => {
    release = (error) => (error ? reject(error) : resolve());
  });
  held.catch(() => undefined);
  const store = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      return async (...args: unknown[]) => {
        counts.set(String(property), (counts.get(String(property)) ?? 0) + 1);
        if (property === slow) await held;
        return bound(...args);
      };
    },
  }) as WorkStore;
  return {
    store,
    runId: admitted.run.id,
    onboarding: { workspaceId: turn.workspaceId, slackUserId: turn.userId, tryStartedAt: NOW },
    calls: (method: string) => counts.get(method) ?? 0,
    release,
    close() {
      base.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function lifecycleAdmission(sensitivity: 'public' | 'private'): AdmitShadowRunInput {
  const workId = 'work_lifecycle_alpha' as WorkId;
  const bindingId = 'binding_lifecycle_alpha' as BindingId;
  const runId = 'run_lifecycle_alpha' as RunId;
  return {
    work: {
      id: workId,
      kind: 'conversation',
      maximumSensitivity: sensitivity,
      createdAt: NOW,
    },
    binding: {
      id: bindingId,
      workId,
      adapterKind: 'slack',
      externalAccountId: 'account_lifecycle_alpha',
      externalConversationId: 'conversation_lifecycle_alpha',
      generation: 1,
      sourceVisibility: sensitivity,
      configMode: 'frozen_on_open',
      orderingKey: 'ordering_lifecycle_alpha',
      createdAt: NOW,
    },
    run: {
      id: runId,
      workId,
      bindingId,
      kind: 'interactive',
      triggerKind: 'slack_app_mention',
      triggerRef: 'trigger_lifecycle_alpha',
      dedupeKey: 'dedupe_lifecycle_alpha',
      actorRef: 'actor_lifecycle_alpha',
      actorTrustTier: 'member',
      sourceContextWatermark: 'watermark_lifecycle_alpha',
      effectiveCapabilityDigest: 'b'.repeat(64),
      executionAuthority: 'legacy',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
      createdAt: NOW,
    },
    safeConfig: {
      schemaVersion: 1,
      profileId: 'profile_lifecycle_alpha',
      configuredModel: 'openai/gpt-5.6-sol',
      snapshotDigest: 'a'.repeat(64),
      capabilityDigest: 'b'.repeat(64),
      skillNames: [],
      connectionIds: [],
      repositoryIds: [],
      memoryMode: sensitivity,
      ceilings: {
        maxModelAttempts: 3,
        maxToolCalls: 20,
        maxActionAttempts: 0,
        timeoutMs: 120_000,
      },
    },
    triggerContent: { sensitivity, body: 'trigger' },
    auditEventId: 'audit_lifecycle_alpha',
    auditIdempotencyKey: 'auditkey_lifecycle_alpha',
  };
}

test('settlement recovery rejects changed execution identity and approved output', async () => {
  const fixture = await lifecycleFixture('public');
  try {
    await fixture.lifecycle.prepareExecution('original prompt');
    await fixture.lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    await fixture.lifecycle.beforeDelivery({ method: 'slack_chat_stream_resume',
      approvedOutput: 'Approved answer', renderedPayload: 'original render' });
    const descriptor = { runId: fixture.runId, attemptNumber: 2, executorKind: 'agent' as const,
      agentName: 'profile_alpha', canonicalModel: 'openai/gpt-5.6-sol',
      flueInstanceRef: 'flueinstance_test', routeEvidence: {}, resumeSettled: true };
    for (const changed of [{ flueInstanceRef: 'other_instance' }, { canonicalModel: 'other/model' }, { agentName: 'other_agent' }]) {
      await assert.rejects(createWorkExecutionLifecycle(fixture.store, { ...descriptor, ...changed }, { mode: 'enforce' }),
        (error: unknown) => error instanceof WorkStateError && error.code === 'work_execution_conflict');
    }
    const resumed = await createWorkExecutionLifecycle(fixture.store, descriptor, { mode: 'enforce' });
    await resumed.prepareExecution('rehydrated prompt');
    await assert.rejects(resumed.beforeDelivery({ method: 'slack_chat_stream_recover',
      approvedOutput: 'Changed answer', renderedPayload: 'replacement render' }), /pending approved delivery/);
    assert.equal((await fixture.store.getRun(fixture.runId))?.deliveryStatus, 'pending');
  } finally { fixture.close(); }
});
