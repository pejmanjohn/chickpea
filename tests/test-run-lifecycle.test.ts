import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveRuntimePlanInstanceId, parseRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { TEST_RUN_DAILY_LIMIT_USD_MICROS, TEST_RUN_WAKE_MS } from '../src/management/test-runs.ts';
import {
  TEST_RUN_ABORT_AFTER_MS,
  TEST_RUN_DEADLINE_MS,
  TEST_RUN_DISPATCH_GRACE_MS,
  TEST_RUN_FORCED_ERASE_MS,
} from '../src/state/test-run-lifecycle.ts';
import { hostedDeployment, hostedInstallation, type HostedInstallation } from './helpers/installation-objects.ts';
import {
  cancelInstallationObjectPendingWork,
  installationStateStoreObject,
} from '../src/state/installation-objects.ts';
import { quiesceStateStoreForRestore } from '../src/state/state-store-host.ts';
import type { TestRunLifecycle } from '../src/state/test-run-lifecycle.ts';
import { FakeTestRunInstances, startRequest, TestClock, testRunLifecycle } from './helpers/test-runs.ts';

const NOON = Date.UTC(2027, 0, 15, 12);

function setup(name: string) {
  const installation = hostedInstallation(name);
  const instances = new FakeTestRunInstances();
  const clock = new TestClock(NOON);
  const lifecycle = testRunLifecycle(installation, instances, clock);
  return { installation, instances, clock, lifecycle };
}

async function started(context: ReturnType<typeof setup>, options: Parameters<typeof startRequest>[1] = {}) {
  const request = startRequest(context.installation, { at: context.clock.now(), ...options });
  const result = await context.lifecycle.start(request);
  assert.ok(result.kind === 'admitted', JSON.stringify(result));
  const instanceId = deriveRuntimePlanInstanceId(parseRuntimePlanV2(request.initialData.runtimePlan));
  return { request, instanceId, row: () => context.installation.stores.testRuns.get(request.run.testRunId)! };
}

function usageOf(installation: HostedInstallation, operationId: string) {
  const detail = installation.stores.usage.getOperation(operationId)!;
  return { status: detail.operation.status, billingRunId: detail.measurements.at(-1)?.billingRunId ?? null };
}

test('a run is admitted and dispatched in one call, as a plain message keyed by the run, and its alarm armed', async () => {
  const context = setup('inst_lifecycle_start');
  const { request, instanceId, row } = await started(context);
  assert.deepEqual(context.instances.on(instanceId), ['dispatch']);
  assert.deepEqual(context.instances.dispatched, [{
    message: request.message, initialData: request.initialData, idempotencyKey: request.run.testRunId,
  }]);
  assert.equal(row().status, 'running');
  assert.equal(row().submissionId, 'sub_1');
  assert.equal(row().planJson, JSON.stringify(request.initialData.runtimePlan), 'the row holds the plan the dispatch carries');
  assert.equal(context.installation.storage.alarm, NOON + TEST_RUN_WAKE_MS);

  // A plan for another run, or a Slack plan, is never admitted.
  const other = startRequest(context.installation);
  await assert.rejects(context.lifecycle.start({ ...other, run: { ...other.run, testRunId: 'testrun_other' } }),
    /its own test run plan/);
});

test('an answered run settles with its reply, frees the lock, and its instance is erased', async () => {
  const context = setup('inst_lifecycle_answer');
  const { request, instanceId, row } = await started(context);
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Order 42 shipped.', read: ['Orders'] });
  context.clock.advance(12_000);
  const view = await context.lifecycle.observe({
    organizationId: request.run.organizationId, actorMembershipId: request.run.actorMembershipId, runToken: request.run.runToken,
  });
  assert.deepEqual(view && [view.status, view.result], ['answered', { reply: 'Order 42 shipped.', read: ['Orders'] }]);
  assert.equal(row().planJson, null);
  assert.equal(row().erasedAt, NOON + 12_000);
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'settlement', 'erase']);
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'completed', billingRunId: 'sub_1' });
  assert.equal(context.lifecycle.nextDueAt(), undefined, 'nothing left to wake for');
  // The lock is free.
  assert.equal((await context.lifecycle.start(startRequest(context.installation))).kind, 'admitted');
});

test('an instance that never settles is aborted at 125 seconds, failed at 150 whatever it reports, and erased at 10 minutes', async () => {
  const context = setup('inst_lifecycle_deadline');
  const { instanceId, row, request } = await started(context);
  context.clock.advance(TEST_RUN_ABORT_AFTER_MS - 1);
  await context.lifecycle.pass();
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'settlement'], 'nothing is aborted before 125 seconds');
  context.clock.advance(1);
  await context.lifecycle.pass();
  assert.deepEqual(context.instances.on(instanceId).slice(2), ['abort', 'settlement']);
  assert.equal(row().status, 'running', 'still Flue\'s to settle');

  context.clock.advance(TEST_RUN_DEADLINE_MS - TEST_RUN_ABORT_AFTER_MS);
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().failure, row().planJson], ['failed', 'deadline', null]);
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'interrupted', billingRunId: 'sub_1' });
  assert.ok(context.instances.calls.some(([call, id]) => call === 'credit_back:timeout' && id === 'sub_1'));
  assert.equal(row().erasedAt, null, 'an instance that still reports running is not erased yet');
  // The lock is free though: the next run is admitted.
  assert.equal((await context.lifecycle.start(startRequest(context.installation, { at: context.clock.now() }))).kind, 'admitted');

  context.clock.advance(TEST_RUN_FORCED_ERASE_MS - TEST_RUN_DEADLINE_MS - 1);
  await context.lifecycle.step(request.run.testRunId);
  assert.equal(row().erasedAt, null);
  context.clock.advance(1);
  await context.lifecycle.step(request.run.testRunId);
  assert.equal(row().erasedAt, context.clock.now(), 'erased anyway, ten minutes after admission');
});

test('an instance that settles after the store\'s deadline is erased as soon as it settles', async () => {
  const context = setup('inst_lifecycle_late_settle');
  const { instanceId, row } = await started(context);
  context.clock.advance(TEST_RUN_DEADLINE_MS);
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().erasedAt], ['failed', null]);
  context.instances.settlements.set(instanceId, { kind: 'failed', failure: 'deadline', creditBack: 'timeout' });
  context.clock.advance(TEST_RUN_WAKE_MS);
  await context.lifecycle.pass();
  assert.equal(row().erasedAt, context.clock.now());
  assert.equal(row().failure, 'deadline', 'the store\'s terminal stands');
});

test('an instance not found counts as settled: the run fails and its instance is erased', async () => {
  const context = setup('inst_lifecycle_not_found');
  const { instanceId, row, request } = await started(context);
  context.instances.settlements.set(instanceId, { kind: 'not_found' });
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().failure], ['failed', 'failed']);
  assert.equal(row().erasedAt, NOON);
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'failed', billingRunId: 'sub_1' });
});

test('a lost receipt: the run\'s first model request binds its submission, its spend counts, and it settles and is erased', async () => {
  const context = setup('inst_lifecycle_lost_receipt');
  context.instances.dispatchFails = true;
  const { instanceId, row, request } = await started(context);
  assert.deepEqual([row().status, row().submissionId], ['admitted', null]);
  // The dispatch landed after all: its first model request binds it.
  assert.ok(context.installation.stores.testRuns.bindModelAccess(instanceId, 'sub_landed'));
  assert.deepEqual([row().status, row().submissionId], ['running', 'sub_landed']);
  context.installation.stores.usage.recordModelRequest({
    requestId: 'req_landed', installationId: context.installation.installationId, runId: 'sub_landed', attemptId: 'sub_landed:1',
    agentId: 'agent_tested', purpose: 'reply', provider: 'anthropic', model: 'claude-haiku-4-5', fundingSource: 'platform',
    outcome: 'completed', inputTokens: 1, outputTokens: { total: 1, reasoning: null }, cacheReadTokens: 0,
    cacheWriteTokens: { total: 0, oneHour: null }, priceVersionId: 'price_1', listPriceUsdMicros: TEST_RUN_DAILY_LIMIT_USD_MICROS,
    priceUnknownReason: null, providerCostUsdMicros: null, providerResponseId: null, providerServiceTier: null,
    providerInferenceGeo: null, finishedAt: NOON,
  });
  // Past the 30-second rule: a bound run is not failed as undispatched.
  context.clock.advance(TEST_RUN_DISPATCH_GRACE_MS);
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Shipped.', read: [] });
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().erasedAt], ['answered', context.clock.now()]);
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'completed', billingRunId: 'sub_landed' });
  // Its spend counts: the day's $2 is used.
  const next = await context.lifecycle.start(startRequest(context.installation, { at: context.clock.now() }));
  assert.equal(next.kind, 'daily_limit');
});

test('a run with no submission 30 seconds after admission fails as not dispatched, is aborted, erased, and refuses a late request', async () => {
  const context = setup('inst_lifecycle_not_dispatched');
  context.instances.dispatchFails = true;
  const { instanceId, row, request } = await started(context);
  context.clock.advance(TEST_RUN_DISPATCH_GRACE_MS - 1);
  await context.lifecycle.pass();
  assert.equal(row().status, 'admitted');
  context.clock.advance(1);
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().failure, row().planJson], ['failed', 'not_dispatched', null]);
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'abort', 'erase']);
  assert.equal(row().erasedAt, context.clock.now());
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'failed', billingRunId: null });
  assert.equal(context.installation.stores.testRuns.bindModelAccess(instanceId, 'sub_late'), undefined, 'its next request is refused');
});

test('no step addresses an erased run\'s instance', async () => {
  const context = setup('inst_lifecycle_erased');
  const { instanceId, request } = await started(context);
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Done.', read: [] });
  await context.lifecycle.pass();
  const calls = context.instances.on(instanceId).length;
  context.clock.advance(TEST_RUN_FORCED_ERASE_MS);
  await context.lifecycle.step(request.run.testRunId);
  await context.lifecycle.step(request.run.testRunId, 'cancel');
  await context.lifecycle.pass('cancel');
  await context.lifecycle.observe({
    organizationId: request.run.organizationId, actorMembershipId: request.run.actorMembershipId, runToken: request.run.runToken,
  });
  assert.equal(context.instances.on(instanceId).length, calls);
});

test('a failed erase is retried at the next step', async () => {
  const context = setup('inst_lifecycle_erase_retry');
  context.instances.eraseFailures = 1;
  const { instanceId, row } = await started(context);
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Done.', read: [] });
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().erasedAt], ['answered', null]);
  assert.ok(context.lifecycle.nextDueAt() !== undefined, 'the alarm comes back for it');
  context.clock.advance(TEST_RUN_WAKE_MS);
  await context.lifecycle.pass();
  assert.equal(row().erasedAt, context.clock.now());
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'settlement', 'erase', 'settlement', 'erase']);
});

test('a restore inside a run: the row comes back unerased past its deadline, is failed at once, and erased once its instance reads not found', async () => {
  const context = setup('inst_lifecycle_restore');
  const { instanceId, row } = await started(context);
  // The restore brought back the row as it was; its instance, outside the plan, was erased long ago.
  context.clock.advance(4 * 60_000);
  context.instances.settlements.set(instanceId, { kind: 'not_found' });
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().failure], ['failed', 'deadline']);
  assert.equal(row().erasedAt, context.clock.now());
});

test('steps for one run never overlap: a second caller joins the step going', async () => {
  const context = setup('inst_lifecycle_guard');
  const { instanceId, request } = await started(context);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const settlement = context.instances.settlement.bind(context.instances);
  let inside = 0;
  let most = 0;
  context.instances.settlement = async (id) => {
    inside += 1;
    most = Math.max(most, inside);
    await gate;
    inside -= 1;
    return settlement(id);
  };
  const steps = [context.lifecycle.step(request.run.testRunId), context.lifecycle.step(request.run.testRunId), context.lifecycle.pass()];
  release();
  await Promise.all(steps);
  assert.equal(most, 1);
  assert.equal(context.instances.on(instanceId).filter((call) => call === 'settlement').length, 1);
});

test('cancellation settles and erases a test run in the same call; one not yet erased holds the drain, and the next pass releases it', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const instances = new FakeTestRunInstances();
  const clock = new TestClock(NOON);
  const lifecycles = new Map<string, TestRunLifecycle>();
  const deployment = hostedDeployment(['inst_cancel_test_run'], {
    stopAgents: async (agents) => ({ stopped: agents.length, notStopped: 0 }),
    testRuns: (installation) => lifecycles.get(installation.installationId)!,
  });
  const installation = deployment.installation('inst_cancel_test_run');
  const lifecycle = testRunLifecycle(installation, instances, clock);
  lifecycles.set(installation.installationId, lifecycle);
  const request = startRequest(installation, { at: NOON });
  assert.equal((await lifecycle.start(request)).kind, 'admitted');
  const row = () => installation.stores.testRuns.get(request.run.testRunId)!;
  const instanceId = row().instanceId;
  instances.settleOnAbort = { kind: 'failed', failure: 'deadline', creditBack: 'timeout' };
  instances.eraseFailures = 1;
  assert.throws(() => quiesceStateStoreForRestore(installation.stores), { code: 'restore_object_busy' });

  const cancel = () => cancelInstallationObjectPendingWork(installation.env, installationStateStoreObject(installation.env)) as
    Promise<{ agentsStopped: number; agentsNotStopped: number }>;
  const held = await cancel();
  assert.deepEqual([held.agentsStopped, held.agentsNotStopped], [0, 1], 'unerased, it holds erasure\'s drain');
  assert.deepEqual([row().status, row().failure, row().erasedAt], ['failed', 'cancelled', null]);
  assert.deepEqual(usageOf(installation, request.run.usage.operationId).status, 'interrupted');
  assert.deepEqual(instances.on(instanceId), ['dispatch', 'abort', 'settlement', 'erase']);
  assert.throws(() => quiesceStateStoreForRestore(installation.stores), { code: 'restore_object_busy' },
    'settled but not erased: still no restore');

  const released = await cancel();
  assert.deepEqual([released.agentsStopped, released.agentsNotStopped], [1, 0]);
  assert.equal(row().erasedAt, NOON);
  quiesceStateStoreForRestore(installation.stores);
  assert.deepEqual((await cancel() as { agentsStopped: number; agentsNotStopped: number }).agentsStopped, 0, 'an erased run is not counted again');
});
