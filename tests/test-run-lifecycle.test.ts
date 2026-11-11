import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveRuntimePlanInstanceId, parseRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { practiceQuestionDigest, TEST_RUN_WAKE_MS } from '../src/management/test-runs.ts';
import {
  TEST_RUN_ABORT_AFTER_MS,
  TEST_RUN_DEADLINE_MS,
  TEST_RUN_DISPATCH_GRACE_MS,
  TEST_RUN_FORCED_ERASE_MS,
  TEST_RUN_INSTANCE_CALL_MS,
  TEST_RUN_UNBOUND_ERASE_MS,
} from '../src/state/test-run-lifecycle.ts';
import { hostedDeployment, hostedInstallation, type HostedInstallation } from './helpers/installation-objects.ts';
import {
  cancelInstallationObjectPendingWork,
  installationStateStoreObject,
} from '../src/state/installation-objects.ts';
import { quiesceStateStoreForRestore } from '../src/state/state-store-host.ts';
import type { TestRunLifecycle } from '../src/state/test-run-lifecycle.ts';
import { TestRunUsageRecorder } from '../src/usage/test-run-usage.ts';
import { FakeTestRunInstances, startRequest, TestClock, testRunLifecycle } from './helpers/test-runs.ts';

/** How long a caller reads their run, and when its text goes. */
const AN_HOUR = 60 * 60_000;

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
    message: request.run.question, initialData: request.initialData, idempotencyKey: request.run.testRunId,
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
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Order 42 shipped.', read: ['Orders'], steps: [] });
  context.clock.advance(12_000);
  const view = await context.lifecycle.observe({
    organizationId: request.run.organizationId, actorMembershipId: request.run.actorMembershipId, runToken: request.run.runToken,
  });
  assert.deepEqual(view && [view.status, view.result], ['answered', {
    off: ['Posting, files and images in Slack'], reply: 'Order 42 shipped.', read: ['Orders'], steps: [],
  }]);
  assert.equal(row().planJson, null);
  assert.equal(row().erasedAt, NOON + 12_000);
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'settlement', 'erase']);
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'completed', billingRunId: 'sub_1' });
  assert.equal(context.lifecycle.nextDueAt(), NOON + 12_000 + AN_HOUR, 'only its text\'s erase, an hour after it settled, is left to wake for');
});

test('an instance that never settles is aborted 5 seconds past the timeout, failed 30 seconds past it whatever it reports, and erased 7.5 minutes after that', async () => {
  const context = setup('inst_lifecycle_deadline');
  const { instanceId, row, request } = await started(context);
  context.clock.advance(TEST_RUN_ABORT_AFTER_MS - 1);
  await context.lifecycle.pass();
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'settlement'], 'nothing is aborted before then');
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
  // Another run is admitted meanwhile.
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

test('an instance not found is a lost run: it fails, is erased, and is credited back as a direct message\'s lost run is, at its deadline too', async () => {
  const context = setup('inst_lifecycle_not_found');
  const { instanceId, row, request } = await started(context);
  context.instances.settlements.set(instanceId, { kind: 'not_found' });
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().failure, row().result?.creditedBack], ['failed', 'failed', true]);
  assert.equal(row().erasedAt, NOON);
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'failed', billingRunId: 'sub_1' });
  // Lost at its deadline it reads as a timeout, and is credited all the same: never charged as one.
  const late = await started(context, { actorMembershipId: 'membership_ada' });
  context.clock.advance(TEST_RUN_DEADLINE_MS);
  context.instances.settlements.set(late.instanceId, { kind: 'not_found' });
  await context.lifecycle.pass();
  assert.deepEqual([late.row().failure, late.row().result?.creditedBack], ['deadline', true]);
  assert.deepEqual(context.instances.calls.filter(([call]) => call.startsWith('credit_back')),
    [['credit_back:evicted', row().submissionId], ['credit_back:evicted', late.row().submissionId]], 'the reason a direct message\'s lost run gets');
});

test('a lost receipt: the run\'s first model request binds its submission, and it settles and is erased', async () => {
  const context = setup('inst_lifecycle_lost_receipt');
  context.instances.dispatchFails = true;
  const { instanceId, row, request } = await started(context);
  assert.deepEqual([row().status, row().submissionId], ['admitted', null]);
  // The dispatch landed after all: its first model request binds it.
  assert.ok(context.installation.stores.testRuns.bindModelAccess(instanceId, 'sub_landed'));
  assert.deepEqual([row().status, row().submissionId], ['running', 'sub_landed']);
  // Past the 30-second rule: a bound run is not failed as undispatched.
  context.clock.advance(TEST_RUN_DISPATCH_GRACE_MS);
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Shipped.', read: [], steps: [] });
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().erasedAt], ['answered', context.clock.now()]);
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'completed', billingRunId: 'sub_landed' });
});

test('a run with no submission 30 seconds after admission fails as not dispatched and is aborted; with nothing to read, its erase waits', async () => {
  const context = setup('inst_lifecycle_not_dispatched');
  context.instances.dispatchFails = true;
  const { instanceId, row, request } = await started(context);
  context.clock.advance(TEST_RUN_DISPATCH_GRACE_MS - 1);
  await context.lifecycle.pass();
  assert.equal(row().status, 'admitted');
  context.clock.advance(1);
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().failure, row().planJson], ['failed', 'not_dispatched', null]);
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'abort']);
  assert.equal(row().erasedAt, null, 'one answered abort is no settlement');
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'failed', billingRunId: null });
  assert.equal(context.installation.stores.testRuns.bindModelAccess(instanceId, 'sub_late')?.runtimePlan, undefined,
    'its next request is refused');

  // The late submission is bound, so the store reads it, and asks it to stop since the abort came before it.
  context.clock.advance(TEST_RUN_WAKE_MS);
  await context.lifecycle.pass();
  assert.equal(row().erasedAt, null);
  assert.deepEqual(context.instances.on(instanceId).slice(2), ['settlement', 'abort', 'settlement']);
  context.instances.settlements.set(instanceId, { kind: 'failed', failure: 'failed', creditBack: 'chickpea' });
  context.clock.advance(TEST_RUN_WAKE_MS);
  await context.lifecycle.pass();
  assert.equal(row().erasedAt, context.clock.now(), 'erased once it settled');
  assert.equal(row().failure, 'not_dispatched', 'the store\'s terminal stands');
});

test('a run that never gets a submission is erased ten minutes after admission: it has no timeout to outlast', async () => {
  assert.equal(TEST_RUN_UNBOUND_ERASE_MS, 10 * 60_000);
  const context = setup('inst_lifecycle_never_bound');
  context.instances.dispatchFails = true;
  const { instanceId, row } = await started(context);
  context.clock.advance(TEST_RUN_DISPATCH_GRACE_MS);
  await context.lifecycle.pass();
  context.clock.advance(TEST_RUN_UNBOUND_ERASE_MS - TEST_RUN_DISPATCH_GRACE_MS - 1);
  // A cancellation pass cannot erase it sooner, so until then it holds a restore and erasure's drain.
  assert.deepEqual(await context.lifecycle.pass('cancel'), { erased: 0, unerased: 1 });
  await context.lifecycle.pass();
  assert.equal(row().erasedAt, null);
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'abort'], 'asked to stop once, then left to its bound');
  context.clock.advance(1);
  await context.lifecycle.pass();
  assert.equal(row().erasedAt, context.clock.now());
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'abort', 'erase']);
});

test('a cancellation while the dispatch is out leaves the instance alone and counts the run not stopped; once it lands, it is aborted and erased', async () => {
  const context = setup('inst_lifecycle_dispatch_race');
  const release = context.instances.holdDispatches();
  context.instances.settleOnAbort = { kind: 'failed', failure: 'deadline', creditBack: 'timeout' };
  const request = startRequest(context.installation, { at: NOON });
  const starting = context.lifecycle.start(request);
  await context.instances.sent();
  const row = () => context.installation.stores.testRuns.get(request.run.testRunId)!;
  const instanceId = row().instanceId;

  const raced = await context.lifecycle.pass('cancel');
  assert.deepEqual(raced, { erased: 0, unerased: 1 }, 'its dispatch is still out, so it holds the drain');
  assert.deepEqual([row().status, row().failure, row().planJson, row().erasedAt], ['failed', 'cancelled', null, null]);
  assert.deepEqual(context.instances.on(instanceId), [], 'no abort or erase before the dispatch lands');

  release();
  assert.equal((await starting).kind, 'admitted');
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'settlement', 'abort', 'settlement', 'erase']);
  assert.deepEqual([row().submissionId, row().erasedAt, row().failure], ['sub_1', NOON, 'cancelled']);
  assert.equal(context.instances.calls.some(([call]) => call.startsWith('credit_back')), false, 'a cancellation credits nothing back');
  assert.deepEqual(await context.lifecycle.pass('cancel'), { erased: 0, unerased: 0 });
});

test('the 30-second rule waits for a dispatch still out, then aborts and erases what landed', async () => {
  const context = setup('inst_lifecycle_slow_dispatch');
  const release = context.instances.holdDispatches();
  context.instances.settleOnAbort = { kind: 'failed', failure: 'deadline', creditBack: 'timeout' };
  const request = startRequest(context.installation, { at: NOON });
  const starting = context.lifecycle.start(request);
  await context.instances.sent();
  const row = () => context.installation.stores.testRuns.get(request.run.testRunId)!;
  context.clock.advance(TEST_RUN_DISPATCH_GRACE_MS);
  assert.deepEqual(await context.lifecycle.pass(), { erased: 0, unerased: 1 });
  assert.deepEqual([row().failure, row().erasedAt], ['not_dispatched', null]);
  assert.deepEqual(context.instances.on(row().instanceId), []);
  release();
  await starting;
  assert.deepEqual(context.instances.on(row().instanceId), ['dispatch', 'settlement', 'abort', 'settlement', 'erase']);
  assert.equal(row().erasedAt, context.clock.now());
});

test('a receipt that lands after the forced erase unerases the run and arms the alarm, and the run is aborted and erased again', async (t) => {
  t.mock.method(console, 'info', () => undefined);
  const context = setup('inst_lifecycle_reopen');
  const release = context.instances.holdDispatches();
  const request = startRequest(context.installation, { at: NOON });
  const starting = context.lifecycle.start(request);
  await context.instances.sent();
  const row = () => context.installation.stores.testRuns.get(request.run.testRunId)!;
  const instanceId = row().instanceId;
  context.clock.advance(TEST_RUN_UNBOUND_ERASE_MS - 1);
  await context.lifecycle.pass();
  assert.equal(row().erasedAt, null, 'until its bound, an outstanding dispatch holds the erase');
  context.clock.advance(1);
  await context.lifecycle.pass();
  assert.equal(row().erasedAt, context.clock.now(), 'past the bound, an outstanding dispatch no longer holds the erase');
  assert.deepEqual(context.instances.on(instanceId), ['abort', 'erase']);
  await context.installation.storage.deleteAlarm();

  context.clock.advance(1_000);
  release();
  await starting;
  assert.equal(context.installation.storage.alarm, context.clock.now(), 'the alarm comes back for it');
  assert.deepEqual(context.instances.on(instanceId), ['abort', 'erase', 'dispatch', 'abort', 'erase']);
  assert.deepEqual([row().submissionId, row().erasedAt], ['sub_1', context.clock.now()]);
});

test('a receipt that lands after its bound and after a cancellation deleted the alarm arms it again, and the run is aborted and erased', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = setup('inst_lifecycle_late_receipt');
  const release = context.instances.holdDispatches();
  context.instances.settleOnAbort = { kind: 'failed', failure: 'deadline', creditBack: 'timeout' };
  const request = startRequest(context.installation, { at: NOON });
  const starting = context.lifecycle.start(request);
  await context.instances.sent();
  t.mock.timers.tick(TEST_RUN_INSTANCE_CALL_MS);
  assert.equal((await starting).kind, 'admitted', 'the call returns at its bound with the dispatch still out');
  const row = () => context.installation.stores.testRuns.get(request.run.testRunId)!;
  const instanceId = row().instanceId;
  assert.deepEqual(await context.lifecycle.pass('cancel'), { erased: 0, unerased: 1 });
  await context.installation.storage.deleteAlarm();

  release();
  for (let turn = 0; turn < 20 && context.installation.storage.alarm === null; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(context.installation.storage.alarm, null, 'the landed receipt arms the alarm again');
  assert.deepEqual(await context.lifecycle.pass(), { erased: 1, unerased: 0 });
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'settlement', 'abort', 'settlement', 'erase']);
});

test('no step addresses an erased run\'s instance', async () => {
  const context = setup('inst_lifecycle_erased');
  const { instanceId, request } = await started(context);
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Done.', read: [], steps: [] });
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
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Done.', read: [], steps: [] });
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
  context.clock.advance(TEST_RUN_DEADLINE_MS + 60_000);
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

test('a terminal Usage refuses never keeps the run live: the store\'s deadline settles it, the lock frees, and a later step writes the terminal', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const context = setup('inst_lifecycle_terminal_refused');
  const { row, request } = await started(context);
  const { usage } = context.installation.stores;
  const record = usage.recordTerminal.bind(usage);
  let refuse = true;
  usage.recordTerminal = (input) => {
    if (refuse) throw new Error('Usage refused the terminal.');
    return record(input);
  };
  context.clock.advance(TEST_RUN_DEADLINE_MS);
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().failure, row().planJson], ['failed', 'deadline', null]);
  assert.equal(usageOf(context.installation, request.run.usage.operationId).status, 'admitted', 'its terminal is owed');
  assert.equal(context.installation.stores.testRuns.bindModelAccess(row().instanceId, 'sub_1')?.runtimePlan, undefined);
  context.clock.advance(TEST_RUN_WAKE_MS);
  await context.lifecycle.pass();
  assert.equal(usageOf(context.installation, request.run.usage.operationId).status, 'admitted', 'refused again');
  refuse = false;
  assert.equal((await context.lifecycle.start(startRequest(context.installation, { at: context.clock.now() }))).kind, 'admitted',
    'another run is admitted');
  context.clock.advance(TEST_RUN_WAKE_MS);
  await context.lifecycle.pass();
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'interrupted', billingRunId: 'sub_1' },
    'a later step wrote it');
});

test('an answer whose terminal Usage refuses keeps its reply, with its usage unreported', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const context = setup('inst_lifecycle_answer_terminal_refused');
  const { row, request, instanceId } = await started(context);
  const { usage } = context.installation.stores;
  const record = usage.recordTerminal.bind(usage);
  let refusals = 1;
  usage.recordTerminal = (input) => {
    if (refusals-- > 0) throw new Error('Usage refused the token counts.');
    return record(input);
  };
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Shipped.', read: [], steps: [] });
  await context.lifecycle.pass();
  assert.deepEqual([row().status, row().result, row().erasedAt], ['answered', { off: ['Posting, files and images in Slack'], reply: 'Shipped.', read: [], steps: [] }, NOON]);
  const detail = context.installation.stores.usage.getOperation(request.run.usage.operationId)!;
  assert.deepEqual([detail.operation.status, detail.measurements.at(-1)?.usageCompleteness], ['completed', 'not_reported']);
});

test('the store runs only a plan for this run, its caller and its Agent, on an instance of its own installation', async () => {
  const context = setup('inst_lifecycle_coordinates');
  const request = startRequest(context.installation);
  for (const run of [{ ...request.run, actorMembershipId: 'membership_other' }, { ...request.run, agentId: 'agent_other' }]) {
    await assert.rejects(context.lifecycle.start({ ...request, run }), /its own test run plan/);
  }
  await assert.rejects(context.lifecycle.start(startRequest(hostedInstallation('inst_lifecycle_coordinates_other'))),
    /its own test run plan/);
  assert.deepEqual(context.installation.stores.testRuns.unerased(), [], 'nothing admitted');
  assert.deepEqual(context.instances.calls, []);
  assert.equal((await context.lifecycle.start(request)).kind, 'admitted');
});

test('an hour after it settles a run is gone to its caller: a replay reads as not found, and the same key starts a new run', async () => {
  const context = setup('inst_lifecycle_replay_hour');
  const { request, instanceId } = await started(context);
  const replay = { organizationId: request.run.organizationId, actorMembershipId: request.run.actorMembershipId,
    idempotencyKey: request.run.idempotencyKey, agentId: request.run.agentId, practiceId: null,
    questionDigest: practiceQuestionDigest(request.run.organizationId, request.run.question) };
  // It settles two hours after it was asked, as a direct message can: its hour starts then.
  context.clock.advance(2 * AN_HOUR);
  assert.equal((await context.lifecycle.replay(replay))?.status, 'running', 'a run still going replays past the hour');
  context.instances.settlements.set(instanceId, { kind: 'answered', reply: 'Shipped.', read: [], steps: [] });
  assert.equal((await context.lifecycle.replay(replay))?.status, 'answered', 'settled now');
  context.clock.advance(AN_HOUR - 1);
  assert.equal((await context.lifecycle.replay(replay))?.status, 'answered');
  context.clock.advance(1);
  assert.equal(await context.lifecycle.replay(replay), undefined);
  const again = startRequest(context.installation, { at: context.clock.now(), idempotencyKey: request.run.idempotencyKey, question: request.run.question });
  assert.equal((await context.lifecycle.start(again)).kind, 'admitted');
});

test('after a cancellation deletes the alarm, a caller\'s read of a run not yet erased arms it again', async () => {
  const context = setup('inst_lifecycle_rearm');
  const { request } = await started(context);
  await context.installation.storage.deleteAlarm();
  context.clock.advance(1_000);
  await context.lifecycle.observe({
    organizationId: request.run.organizationId, actorMembershipId: request.run.actorMembershipId, runToken: request.run.runToken,
  });
  assert.equal(context.installation.storage.alarm, context.clock.now() + TEST_RUN_WAKE_MS);
});

test('a cancellation that finds the instance still running fails the run as cancelled, with nothing credited back', async () => {
  const context = setup('inst_lifecycle_cancel_running');
  const { row, request, instanceId } = await started(context);
  const pass = await context.lifecycle.pass('cancel');
  assert.deepEqual(pass, { erased: 0, unerased: 1 });
  assert.deepEqual([row().status, row().failure], ['failed', 'cancelled']);
  assert.deepEqual(usageOf(context.installation, request.run.usage.operationId), { status: 'interrupted', billingRunId: 'sub_1' });
  assert.deepEqual(context.instances.on(instanceId), ['dispatch', 'abort', 'settlement', 'settlement']);
  assert.equal(context.instances.calls.some(([call]) => call.startsWith('credit_back')), false);
});

test('a cancellation whose abort the instance settles is cancelled, not a timeout, and nothing is credited back', async () => {
  const context = setup('inst_lifecycle_cancel_aborted');
  const { row, instanceId } = await started(context);
  // Flue settles an aborted submission as testRunSettlement reads it: a deadline credited as a timeout.
  context.instances.settleOnAbort = { kind: 'failed', failure: 'deadline', creditBack: 'timeout' };
  assert.deepEqual(await context.lifecycle.pass('cancel'), { erased: 1, unerased: 0 });
  assert.deepEqual([row().status, row().failure], ['failed', 'cancelled']);
  assert.ok(context.instances.on(instanceId).includes('erase'));
  assert.equal(context.instances.calls.some(([call]) => call.startsWith('credit_back')), false);
});

test('a settlement that loses to one already written credits nothing back', async () => {
  const context = setup('inst_lifecycle_settle_lost');
  const { request, row } = await started(context);
  const { testRuns, usage } = context.installation.stores;
  const read = context.instances.settlement.bind(context.instances);
  // The run answers while this step's read of its instance is out, and the read comes back a timeout.
  context.instances.settlement = async (id) => {
    await read(id);
    const recorder = new TestRunUsageRecorder(usage.getOperation(row().usageOperationId)!.operation);
    assert.equal(testRuns.settle(request.run.testRunId, {
      status: 'answered', result: { reply: 'Two are overdue.', read: [] }, terminal: recorder.completed(undefined, context.clock.now(), row().submissionId),
    }), true);
    return { kind: 'failed', failure: 'deadline', creditBack: 'timeout' };
  };
  await context.lifecycle.step(request.run.testRunId);
  assert.deepEqual([row().status, row().result?.reply, row().result?.creditedBack], ['answered', 'Two are overdue.', undefined]);
  assert.deepEqual(context.instances.calls.filter(([call]) => call.startsWith('credit_back')), [], 'an answer is charged: nothing is credited');
});

test('every timeout is credited back, as a direct message\'s is, however many a person has had', async () => {
  const context = setup('inst_lifecycle_timeout_credit');
  const timedOut = async (actorMembershipId: string) => {
    const run = await started(context, { actorMembershipId });
    context.clock.advance(TEST_RUN_DEADLINE_MS);
    await context.lifecycle.pass();
    return run.row();
  };
  const runs = [];
  for (let index = 0; index < 4; index += 1) runs.push(await timedOut('membership_ada'));
  const credited = () => context.instances.calls.filter(([call]) => call === 'credit_back:timeout').map(([, submission]) => submission);
  assert.deepEqual(credited(), runs.map(({ submissionId }) => submissionId), 'no count of a person\'s timeouts decides it');
  for (const run of runs) {
    assert.deepEqual([run.failure, run.result], ['deadline', { off: ['Posting, files and images in Slack'], creditedBack: true }]);
  }
  // A deadline the instance reports is credited back the same way.
  const reported = await started(context, { actorMembershipId: 'membership_ada' });
  context.instances.settlements.set(reported.instanceId, { kind: 'failed', failure: 'deadline', creditBack: 'timeout' });
  await context.lifecycle.pass();
  assert.equal(reported.row().result?.creditedBack, true);
  assert.equal(credited().length, 5);
  // So is any other failure Chickpea owns.
  const ours = await started(context, { actorMembershipId: 'membership_ada' });
  context.instances.settlements.set(ours.instanceId, { kind: 'failed', failure: 'failed', creditBack: 'chickpea' });
  await context.lifecycle.pass();
  assert.equal(ours.row().result?.creditedBack, true);
});

test('admission steps no one else\'s run: another member\'s stuck instance never delays it', async () => {
  const context = setup('inst_lifecycle_others_stuck');
  const stuck = await started(context, { actorMembershipId: 'membership_ada' });
  const before = context.instances.on(stuck.instanceId).length;
  context.instances.settlement = () => new Promise<never>(() => undefined);
  const mine = await context.lifecycle.start(startRequest(context.installation, { actorMembershipId: 'membership_bo', at: context.clock.now() }));
  assert.equal(mine.kind, 'admitted');
  assert.equal(context.instances.on(stuck.instanceId).length, before, 'the stuck run\'s instance was never asked');
});

test('the same ask on the same plan moments after it settled is that run again, marked a repeat, with nothing dispatched', async () => {
  const context = setup('inst_lifecycle_repeat');
  const first = await started(context, { question: 'Who is overdue?' });
  context.instances.settlements.set(first.instanceId, { kind: 'answered', reply: 'Two.', read: [], steps: [] });
  await context.lifecycle.pass();
  context.clock.advance(30_000);
  const again = await context.lifecycle.start(startRequest(context.installation, { question: 'Who is overdue?', at: context.clock.now() }));
  assert.equal(again.kind, 'repeat');
  assert.deepEqual(again.kind === 'repeat' && [again.run.runToken, again.run.repeat, again.run.result?.reply],
    [first.request.run.runToken, true, 'Two.']);
  assert.equal(context.instances.dispatched.length, 1);
});

test('a follow-up is dispatched with its conversation\'s earlier turns from the store\'s rows, and the creation data says so', async () => {
  const context = setup('inst_lifecycle_follow_up');
  const RAW = 'SECRET_ROW: {"customer":"Northwind"}';
  const first = await started(context, { question: 'Who is <overdue>?' });
  context.instances.settlements.set(first.instanceId, {
    kind: 'answered', reply: 'Northwind is overdue.', read: ['Probe Board'],
    steps: [{ kind: 'tool', service: 'Probe Board', tool: 'probe_board_search', input: '{"q":"overdue"}', outcome: 'ok', result: { data: RAW, size: RAW.length, truncated: false } }],
  });
  context.clock.advance(5_000);
  await context.lifecycle.pass();
  const practiceId = first.row().practiceId!;
  assert.equal(first.row().status, 'answered');

  // A Worker never sets the flag; one it sent anyway is the store's to decide.
  const request = startRequest(context.installation, { at: context.clock.now(), practiceId, question: 'And last week?' });
  const sent = { ...request, initialData: { ...request.initialData, quotesEarlierTurns: true } };
  const followUp = await context.lifecycle.start(sent);
  assert.deepEqual([followUp.kind, followUp.kind === 'admitted' && followUp.run.turn], ['admitted', 2]);
  const dispatched = context.instances.dispatched.at(-1)!;
  assert.equal(dispatched.message, [
    'Earlier in this practice conversation (quoted):',
    '',
    'Turn 1. They asked:',
    '> Who is &lt;overdue&gt;?',
    'You answered:',
    '> Northwind is overdue.',
    'Read: Probe Board (probe_board_search, ok).',
    '',
    'New question:',
    'And last week?',
  ].join('\n'));
  assert.doesNotMatch(dispatched.message, /SECRET_ROW|"q"/, 'no raw result or input');
  assert.deepEqual(dispatched.initialData, { ...request.initialData, quotesEarlierTurns: true });

  const fresh = startRequest(context.installation, { at: context.clock.now(), question: 'A new one?' });
  await context.lifecycle.start({ ...fresh, initialData: { ...fresh.initialData, quotesEarlierTurns: true } });
  assert.deepEqual(context.instances.dispatched.at(-1), {
    message: 'A new one?', initialData: fresh.initialData, idempotencyKey: fresh.run.testRunId,
  }, 'a first question quotes nothing, and its creation data says nothing of earlier turns');

  const ended = startRequest(context.installation, { at: context.clock.now(), practiceId, actorMembershipId: 'membership_other', question: 'Theirs?' });
  assert.deepEqual(await context.lifecycle.start(ended), { kind: 'ended' });
  assert.equal(context.instances.dispatched.length, 3, 'an ended conversation dispatches nothing');
});
