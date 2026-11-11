import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveRuntimePlanInstanceId, parseRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import {
  PRACTICE_REPEAT_MS,
  TEST_RUN_WAKE_MS,
} from '../src/management/test-runs.ts';
import type { TestRunAdmissionRequest } from '../src/management/test-run-types.ts';
import { TestRunUsageRecorder } from '../src/usage/test-run-usage.ts';
import { hostedInstallation, type HostedInstallation } from './helpers/installation-objects.ts';
import { startRequest } from './helpers/test-runs.ts';

/** How long a caller reads their run, and when its text goes. */
const AN_HOUR = 60 * 60_000;

/** Midday, UTC, on a fixed day. */
const NOON = Date.UTC(2027, 0, 15, 12);

function admission(installation: HostedInstallation, options: Parameters<typeof startRequest>[1] = {}): TestRunAdmissionRequest {
  const request = startRequest(installation, { at: NOON, ...options });
  const plan = parseRuntimePlanV2(request.initialData.runtimePlan);
  const { coordinateToken: _plans, ...run } = request.run;
  return { ...run, instanceId: deriveRuntimePlanInstanceId(plan), planJson: JSON.stringify(request.initialData.runtimePlan) };
}

/** Settles a run as answered, freeing the lock, as the lifecycle does. */
function answer(installation: HostedInstallation, testRunId: string, at?: number): void {
  const row = installation.stores.testRuns.get(testRunId)!;
  at ??= row.createdAt;
  const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(row.usageOperationId)!.operation);
  assert.equal(installation.stores.testRuns.settle(testRunId, {
    status: 'answered', result: { reply: 'Order 42 shipped.', read: ['Orders'] }, terminal: recorder.completed(undefined, at, row.submissionId),
  }), true);
}

test('admission writes the run and its test_turn usage operation in one transaction, and a replay returns the stored run before any check', () => {
  const installation = hostedInstallation('inst_test_store_admit');
  const { testRuns, usage } = installation.stores;
  const request = admission(installation, { idempotencyKey: 'key_once' });
  const admitted = testRuns.admit(request, NOON);
  assert.equal(admitted.kind, 'admitted');
  const row = testRuns.get(request.testRunId)!;
  assert.equal(row.status, 'admitted');
  assert.equal(row.instanceId, request.instanceId);
  const operation = usage.getOperation(row.usageOperationId)!.operation;
  assert.deepEqual(
    [operation.operationKind, operation.status, operation.conversationKind, operation.channelId, operation.requesterMembershipId],
    ['test_turn', 'admitted', 'direct_message', null, 'membership_caller'],
  );

  // The same caller's same key for the same ask gets the same run, until its hour ends.
  const again = { ...admission(installation, { question: request.question }), idempotencyKey: 'key_once' };
  assert.deepEqual(testRuns.admit(again, NOON), { kind: 'replayed', row });
  assert.equal(testRuns.admit(again, NOON + AN_HOUR - 1).kind, 'replayed');
  // The same key for another ask names no run: it starts one under a key of its own.
  const other = { ...admission(installation, { question: 'Something else?' }), idempotencyKey: 'key_once' };
  const minted = testRuns.admit(other, NOON);
  assert.equal(minted.kind, 'admitted', 'never key_reused');
  assert.equal(testRuns.get(other.testRunId)!.idempotencyKey, `minted_${other.testRunId}`);
  // Past its hour the key names nothing either.
  answer(installation, request.testRunId);
  answer(installation, other.testRunId);
  const late = { ...admission(installation, { question: request.question }), idempotencyKey: 'key_once' };
  assert.equal(testRuns.admit(late, NOON + AN_HOUR).kind, 'admitted');

  // A failed usage admission leaves no row behind.
  const broken = admission(installation, { organizationId: 'org_other' });
  assert.throws(() => testRuns.admit({ ...broken, usage: { ...broken.usage, operationKind: 'unknown' as never } }, NOON));
  assert.equal(testRuns.get(broken.testRunId), undefined, 'the row rolls back with the usage operation');
});

function testRuns(installation: HostedInstallation) {
  return installation.stores.testRuns;
}

test('no lock: two people, and one person in two conversations, run at once; the plan\'s funding limits them, not the store', () => {
  const installation = hostedInstallation('inst_test_store_no_lock');
  const store = testRuns(installation);
  const kinds = [
    admission(installation, { actorMembershipId: 'membership_ada', question: 'Where is order 1?' }),
    admission(installation, { actorMembershipId: 'membership_bo', question: 'Where is order 1?' }),
    admission(installation, { actorMembershipId: 'membership_ada', question: 'Where is order 2?' }),
  ].map((request) => store.admit(request, NOON).kind);
  assert.deepEqual(kinds, ['admitted', 'admitted', 'admitted']);
  // Nothing counts runs: a hundred in an hour are each admitted.
  for (let run = 0; run < 100; run += 1) {
    const request = admission(installation, { actorMembershipId: 'membership_cy', question: `Question ${run}?` });
    assert.equal(store.admit(request, NOON + run).kind, 'admitted');
    answer(installation, request.testRunId, NOON + run);
  }
  assert.equal(installation.db.get("SELECT name FROM sqlite_master WHERE name = 'management_test_runs_live_idx'"), undefined,
    'the one-run-per-installation index is gone');
});

test('the same first question going returns that run; a conversation\'s next turn waits for its last', () => {
  const installation = hostedInstallation('inst_test_store_same_ask');
  const store = testRuns(installation);
  const first = admission(installation, { question: 'Who is overdue?' });
  const admitted = store.admit(first, NOON);
  assert.equal(admitted.kind, 'admitted');
  // A keyless retry of the same first question: the run going, not a second one.
  const retry = store.admit(admission(installation, { question: 'Who is overdue?' }), NOON + 5_000);
  assert.deepEqual([retry.kind, retry.kind === 'running' && retry.row.testRunId], ['running', first.testRunId]);
  // Another person's same question is theirs.
  assert.equal(store.admit(admission(installation, { actorMembershipId: 'membership_other', question: 'Who is overdue?' }), NOON).kind, 'admitted');
  // The same conversation's next turn while its last is going.
  const practiceId = store.get(first.testRunId)!.practiceId!;
  assert.deepEqual(store.admit(admission(installation, { practiceId, question: 'And last week?' }), NOON + 6_000),
    { kind: 'in_progress', runToken: first.runToken });
  answer(installation, first.testRunId, NOON + 10_000);
  assert.equal(store.admit(admission(installation, { practiceId, question: 'And last week?' }), NOON + 11_000).kind, 'admitted');
});

test('for two minutes after it settles, the same ask on the same plan returns the settled run; an edit runs it again', () => {
  const installation = hostedInstallation('inst_test_store_repeat');
  const store = testRuns(installation);
  const first = admission(installation, { question: 'Who is overdue?', planDigest: 'plan_a' });
  store.admit(first, NOON);
  answer(installation, first.testRunId, NOON + 20_000);
  const repeat = store.admit(admission(installation, { question: 'Who is overdue?', planDigest: 'plan_a' }), NOON + 20_000 + PRACTICE_REPEAT_MS);
  assert.deepEqual([repeat.kind, repeat.kind === 'repeat' && repeat.row.testRunId], ['repeat', first.testRunId]);
  const edited = admission(installation, { question: 'Who is overdue?', planDigest: 'plan_b' });
  assert.equal(store.admit(edited, NOON + 30_000).kind, 'admitted', 'the Agent changed, so the question runs again');
  answer(installation, edited.testRunId, NOON + 40_000);
  const back = admission(installation, { question: 'Who is overdue?', planDigest: 'plan_a' });
  assert.equal(store.admit(back, NOON + 50_000).kind, 'repeat', 'the run on the same plan, not the newest one');
  const later = admission(installation, { question: 'Who is overdue?', planDigest: 'plan_a' });
  assert.equal(store.admit(later, NOON + 40_001 + PRACTICE_REPEAT_MS).kind, 'admitted', 'past the window');
});

test('an older Worker version\'s one-run lock reads as in progress, never as an error', () => {
  const installation = hostedInstallation('inst_test_store_old_lock');
  installation.db.exec(`CREATE UNIQUE INDEX management_test_runs_live_idx
    ON management_test_runs (organization_id) WHERE status IN ('admitted', 'running')`);
  const store = testRuns(installation);
  assert.equal(store.admit(admission(installation, { actorMembershipId: 'membership_ada' }), NOON).kind, 'admitted');
  const held = admission(installation, { actorMembershipId: 'membership_bo' });
  assert.deepEqual(store.admit(held, NOON), { kind: 'in_progress' });
  assert.equal(store.get(held.testRunId), undefined);
  assert.equal(installation.stores.usage.getOperation(held.usage.operationId), undefined, 'and no usage operation');
});

test('only an answer is given again: the same ask after a run that failed runs again, as a direct message would', () => {
  const installation = hostedInstallation('inst_test_store_failed_again');
  const store = testRuns(installation);
  const first = admission(installation, { question: 'Who is overdue?', planDigest: 'plan_a' });
  store.admit(first, NOON);
  const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(first.usage.operationId)!.operation);
  store.settle(first.testRunId, { status: 'failed', failure: 'out_of_usage', terminal: recorder.failed(NOON + 5_000, null) });
  const again = store.admit(admission(installation, { question: 'Who is overdue?', planDigest: 'plan_a' }), NOON + 10_000);
  assert.equal(again.kind, 'admitted', 'a plan that refused the first may allow the second');
});

test('a run is erased at its hour, text and row, and the alarm wakes for it in an idle workspace', () => {
  const installation = hostedInstallation('inst_test_store_text');
  const store = testRuns(installation);
  const request = admission(installation);
  store.admit(request, NOON);
  answer(installation, request.testRunId, NOON + 20_000);
  store.markErased(request.testRunId, NOON + 30_000);
  assert.equal(store.hasUnerased(), false, 'nothing is left for the run pass');
  assert.equal(store.nextDueAt(NOON + 60_000), NOON + AN_HOUR, 'the wake is the hour');
  assert.equal(store.eraseExpired(NOON + AN_HOUR - 1), 0);
  assert.ok(store.get(request.testRunId)?.result, 'inside its hour it reads whole');
  assert.equal(store.eraseExpired(NOON + AN_HOUR), 1);
  assert.equal(store.get(request.testRunId), undefined, 'the row goes with its text: nothing counts a run afterwards');
  assert.equal(store.nextDueAt(NOON + AN_HOUR), undefined, 'then nothing wakes it');
  // A run whose instance is not erased yet loses its text at the hour, and its row once the instance is erased.
  const held = admission(installation);
  store.admit(held, NOON);
  answer(installation, held.testRunId);
  assert.equal(store.eraseExpired(NOON + AN_HOUR), 0);
  const row = store.get(held.testRunId)!;
  assert.deepEqual([row.question, row.questionDigest, row.result], [null, null, null]);
  store.markErased(held.testRunId, NOON + AN_HOUR);
  assert.equal(store.eraseExpired(NOON + AN_HOUR + 1), 1);
  // A wake already due waits one look, so an erase that keeps failing never spins the alarm.
  const stuck = admission(installation);
  store.admit(stuck, NOON);
  answer(installation, stuck.testRunId);
  store.markErased(stuck.testRunId, NOON);
  assert.equal(store.nextDueAt(NOON + 2 * AN_HOUR), NOON + 2 * AN_HOUR + TEST_RUN_WAKE_MS);
});

test('the model-access binding takes the first submission by compare-and-set and grants only a live run with its plan', () => {
  const installation = hostedInstallation('inst_test_store_bind');
  const request = admission(installation);
  testRuns(installation).admit(request, NOON);
  assert.equal(testRuns(installation).bindModelAccess('agent_unknown_instance', 'sub_a'), undefined);

  // A dispatch whose receipt was lost: its first model request binds it.
  const granted = testRuns(installation).bindModelAccess(request.instanceId, 'sub_a');
  assert.deepEqual(granted, { runtimePlan: JSON.parse(request.planJson) });
  assert.deepEqual([testRuns(installation).get(request.testRunId)!.submissionId, testRuns(installation).get(request.testRunId)!.status],
    ['sub_a', 'running']);
  assert.deepEqual(testRuns(installation).bindModelAccess(request.instanceId, 'sub_a'), granted, 'the same submission again');
  assert.equal(testRuns(installation).bindModelAccess(request.instanceId, 'sub_b'), undefined, 'any other submission');
  // The receipt arriving late keeps the bound one.
  assert.equal(testRuns(installation).recordSubmission(request.testRunId, 'sub_b'), false);
  assert.equal(testRuns(installation).get(request.testRunId)!.submissionId, 'sub_a');

  answer(installation, request.testRunId);
  const settled = testRuns(installation).get(request.testRunId)!;
  assert.equal(settled.planJson, null, 'settlement nulls the plan');
  assert.deepEqual(testRuns(installation).bindModelAccess(request.instanceId, 'sub_a'), {}, 'a settled run grants nothing');

  // A run with no submission binds the first to ask even when it refuses it: a settled one with its plan gone.
  const late = admission(installation);
  testRuns(installation).admit(late, NOON + 1);
  testRuns(installation).settle(late.testRunId, {
    status: 'failed', failure: 'not_dispatched',
    terminal: new TestRunUsageRecorder(installation.stores.usage.getOperation(late.usage.operationId)!.operation).failed(NOON + 1, null),
  });
  assert.deepEqual(testRuns(installation).bindModelAccess(late.instanceId, 'sub_late'), {});
  assert.equal(testRuns(installation).get(late.testRunId)!.submissionId, 'sub_late', 'its spend is counted under it');
});

test('a submission that lands after its run\'s instance was erased unerases the run, by the receipt or by model access', () => {
  const installation = hostedInstallation('inst_test_store_reopen');
  const settleUndispatched = (request: TestRunAdmissionRequest) => {
    testRuns(installation).admit(request, NOON);
    testRuns(installation).settle(request.testRunId, {
      status: 'failed', failure: 'not_dispatched',
      terminal: new TestRunUsageRecorder(installation.stores.usage.getOperation(request.usage.operationId)!.operation).failed(NOON, null),
    });
    testRuns(installation).markErased(request.testRunId, NOON + 1);
  };
  const byReceipt = admission(installation);
  settleUndispatched(byReceipt);
  assert.equal(testRuns(installation).hasUnerased(), false);
  assert.equal(testRuns(installation).recordSubmission(byReceipt.testRunId, 'sub_receipt'), true);
  assert.deepEqual([testRuns(installation).get(byReceipt.testRunId)!.erasedAt, testRuns(installation).get(byReceipt.testRunId)!.status],
    [null, 'failed'], 'unerased, still settled');
  testRuns(installation).markErased(byReceipt.testRunId, NOON + 2);
  assert.equal(testRuns(installation).recordSubmission(byReceipt.testRunId, 'sub_receipt'), false, 'once only');
  assert.equal(testRuns(installation).get(byReceipt.testRunId)!.erasedAt, NOON + 2);

  const byRequest = admission(installation);
  settleUndispatched(byRequest);
  assert.deepEqual(testRuns(installation).bindModelAccess(byRequest.instanceId, 'sub_request'), { reopened: true },
    'refused, and the run is unerased');
  assert.equal(testRuns(installation).hasUnerased(), true);
  assert.deepEqual(testRuns(installation).bindModelAccess(byRequest.instanceId, 'sub_request'), {}, 'a repeat reopens nothing');
});

test('a run settles once: the first settlement writes the usage terminal, and a later one changes nothing', () => {
  const installation = hostedInstallation('inst_test_store_settle');
  const request = admission(installation);
  testRuns(installation).admit(request, NOON);
  answer(installation, request.testRunId);
  const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(request.usage.operationId)!.operation);
  assert.equal(testRuns(installation).settle(request.testRunId,
    { status: 'failed', failure: 'deadline', terminal: recorder.interrupted(NOON + 5, null) }), false);
  const row = testRuns(installation).get(request.testRunId)!;
  assert.deepEqual([row.status, row.failure, row.result], ['answered', null, {
    off: ['Posting, files and images in Slack'], reply: 'Order 42 shipped.', read: ['Orders'],
  }], 'what admission stored is kept beside the reply');
  const detail = installation.stores.usage.getOperation(request.usage.operationId)!;
  assert.deepEqual([detail.operation.status, detail.measurements.length], ['completed', 1]);
});

test('only the caller reads a run, by its token, for an hour', () => {
  const installation = hostedInstallation('inst_test_store_read');
  const request = admission(installation);
  testRuns(installation).admit(request, NOON);
  const query = { organizationId: request.organizationId, actorMembershipId: request.actorMembershipId, runToken: request.runToken };
  assert.equal(testRuns(installation).read(query, NOON)?.testRunId, request.testRunId);
  assert.equal(testRuns(installation).read({ ...query, actorMembershipId: 'membership_other' }, NOON), undefined);
  assert.equal(testRuns(installation).read({ ...query, organizationId: 'org_other' }, NOON), undefined);
  assert.equal(testRuns(installation).read({ ...query, runToken: 'tr_unknown' }, NOON), undefined);
  assert.equal(testRuns(installation).read(query, NOON + AN_HOUR - 1)?.testRunId, request.testRunId);
  assert.equal(testRuns(installation).read(query, NOON + AN_HOUR), undefined);
});

test('retention erases a run once its hour has passed and its instance is erased, whatever the day', () => {
  const installation = hostedInstallation('inst_test_store_retention');
  const { management } = installation.stores;
  const erased = admission(installation);
  testRuns(installation).admit(erased, NOON);
  answer(installation, erased.testRunId, NOON);
  testRuns(installation).markErased(erased.testRunId, NOON + 60_000);
  const unerased = admission(installation);
  testRuns(installation).admit(unerased, NOON + 1);
  answer(installation, unerased.testRunId, NOON + 1);

  management.cleanupRetention(NOON + AN_HOUR / 2, 250);
  assert.ok(testRuns(installation).get(erased.testRunId)?.result, 'inside its hour, its reply stays');
  // Past the hour, the same UTC day: the erased run goes, the unerased one stays, reply removed.
  management.cleanupRetention(NOON + AN_HOUR + 1, 250);
  assert.equal(testRuns(installation).get(erased.testRunId), undefined, 'no bare row is kept to the end of the day');
  assert.equal(testRuns(installation).get(unerased.testRunId)?.result, null, 'its reply goes once it cannot be read');
  testRuns(installation).markErased(unerased.testRunId, NOON + AN_HOUR + 2);
  management.cleanupRetention(NOON + AN_HOUR + 3, 250);
  assert.equal(testRuns(installation).get(unerased.testRunId), undefined, 'and its row once its instance is erased');
});
