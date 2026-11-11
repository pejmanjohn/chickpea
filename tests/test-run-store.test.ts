import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveRuntimePlanInstanceId, parseRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import {
  installTestRunSchema,
  PRACTICE_LISTED_RUNS,
  PRACTICE_REPEAT_MS,
  PRACTICE_STEP_READ_CHARS,
  PRACTICE_TURNS,
  TEST_RUN_WAKE_MS,
} from '../src/management/test-runs.ts';
import type { PracticeKeptResult, PracticeStep, TestRunAdmissionRequest } from '../src/management/test-run-types.ts';
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

test('for two minutes after it answers, the same ask on the same plan returns that run; an edit runs it again', () => {
  assert.equal(PRACTICE_REPEAT_MS, 120_000, 'two minutes');
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

test('a store that held the one-run lock loses it when it starts on this version, and two people then run at once', () => {
  const installation = hostedInstallation('inst_test_store_lock_dropped');
  const lock = () => installation.db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'management_test_runs_live_idx'");
  installation.db.exec(`CREATE UNIQUE INDEX management_test_runs_live_idx
    ON management_test_runs (organization_id) WHERE status IN ('admitted', 'running')`);
  assert.ok(lock(), 'as an older version left it');
  installTestRunSchema(installation.db);
  assert.equal(lock(), undefined);
  const store = testRuns(installation);
  assert.equal(store.admit(admission(installation, { actorMembershipId: 'membership_ada' }), NOON).kind, 'admitted');
  assert.equal(store.admit(admission(installation, { actorMembershipId: 'membership_bo' }), NOON).kind, 'admitted');
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

test('a run is erased an hour after it settles, text and row, and the alarm wakes for it in an idle workspace', () => {
  const installation = hostedInstallation('inst_test_store_text');
  const store = testRuns(installation);
  const request = admission(installation);
  store.admit(request, NOON);
  const settled = NOON + 20_000;
  answer(installation, request.testRunId, settled);
  store.markErased(request.testRunId, NOON + 30_000);
  assert.equal(store.hasUnerased(), false, 'nothing is left for the run pass');
  assert.equal(store.nextDueAt(NOON + 60_000), settled + AN_HOUR, 'the wake is an hour after it settled');
  assert.equal(store.eraseExpired(settled + AN_HOUR - 1), 0);
  assert.ok(store.get(request.testRunId)?.result, 'inside its hour it reads whole');
  assert.equal(store.eraseExpired(settled + AN_HOUR), 1);
  assert.equal(store.get(request.testRunId), undefined, 'the row goes with its text: nothing counts a run afterwards');
  assert.equal(store.nextDueAt(settled + AN_HOUR), undefined, 'then nothing wakes it');
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

test('a step\'s cut result is kept beside its run: only its caller reads it, by step and offset, and it goes at the run\'s hour', () => {
  const installation = hostedInstallation('inst_test_store_kept');
  const store = testRuns(installation);
  const kept = () => Number(installation.db.get('SELECT COUNT(*) AS n FROM management_test_run_results')!.n);
  const request = admission(installation);
  store.admit(request, NOON);
  const query = { organizationId: request.organizationId, actorMembershipId: request.actorMembershipId, runToken: request.runToken };
  const read = (at: number, step = 2, offset = 0, who: Partial<typeof query> = {}) => store.stepResult({ ...query, ...who, step, offset }, at);
  const whole = 'abcdefghij'.repeat(5_000);
  assert.equal(read(NOON), undefined, 'nothing while it goes');
  const settled = NOON + 10_000;
  answerWith(installation, request.testRunId, 'Read it.', [], settled, { results: [{ step: 2, data: whole }] });
  assert.deepEqual(read(NOON + 20_000), { data: whole.slice(0, PRACTICE_STEP_READ_CHARS), kept: 50_000 });
  assert.equal(PRACTICE_STEP_READ_CHARS, 20_000);
  assert.deepEqual(read(NOON + 20_000, 2, 40_000), { data: whole.slice(40_000), kept: 50_000 });
  assert.deepEqual(read(NOON + 20_000, 2, 60_000), { data: '', kept: 50_000 });
  assert.equal(read(NOON + 20_000, 1), undefined, 'a step it kept nothing more of');
  // Another person's run, or another workspace's, reads as none.
  assert.equal(read(NOON + 20_000, 2, 0, { actorMembershipId: 'membership_other' }), undefined);
  assert.equal(read(NOON + 20_000, 2, 0, { organizationId: 'org_other' }), undefined);
  assert.equal(read(NOON + 20_000, 2, 0, { runToken: 'tr_other' }), undefined);
  // Only an answer keeps them, once: a later settlement changes nothing.
  const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(store.get(request.testRunId)!.usageOperationId)!.operation);
  assert.equal(store.settle(request.testRunId, {
    status: 'answered', result: { reply: 'Again.' }, results: [{ step: 2, data: 'other' }, { step: 3, data: 'more' }],
    terminal: recorder.completed(undefined, settled, null),
  }), false);
  assert.deepEqual([kept(), read(NOON + 20_000)?.kept], [1, 50_000]);
  // At the run's hour it reads as none, and the next erase takes it with the run's text, before its instance is erased.
  assert.equal(read(settled + AN_HOUR - 1)?.kept, 50_000);
  assert.equal(read(settled + AN_HOUR), undefined);
  store.eraseExpired(settled + AN_HOUR - 1);
  assert.equal(kept(), 1, 'kept for the hour');
  store.eraseExpired(settled + AN_HOUR);
  assert.deepEqual([kept(), store.get(request.testRunId)?.result], [0, null], 'gone with the run\'s text');
  // None outlives a run: one whose run is gone goes at the next erase, whatever stopped an earlier one.
  installation.db.run("INSERT INTO management_test_run_results (test_run_id, step, data) VALUES ('testrun_gone', 1, 'left')");
  store.eraseExpired(NOON);
  assert.equal(kept(), 0);
  // A settlement Usage refused keeps them as well.
  const refused = admission(installation);
  store.admit(refused, NOON);
  assert.equal(store.settleWithoutTerminal(refused.testRunId, {
    status: 'answered', result: { reply: 'Read it.' }, results: [{ step: 1, data: whole }],
    terminal: recorder.completed(undefined, NOON + 1_000, null),
  }), true);
  assert.equal(store.stepResult({ ...query, runToken: refused.runToken, step: 1, offset: 0 }, NOON + 2_000)?.kept, 50_000);
  // A failure keeps none.
  const failed = admission(installation);
  store.admit(failed, NOON);
  const own = new TestRunUsageRecorder(installation.stores.usage.getOperation(store.get(failed.testRunId)!.usageOperationId)!.operation);
  assert.equal(store.settle(failed.testRunId, {
    status: 'failed', failure: 'failed', terminal: own.failed(NOON + 1_000, null),
    ...{ results: [{ step: 1, data: whole }] },
  } as Parameters<typeof store.settle>[1]), true);
  assert.equal(kept(), 1);
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

test('a run still going keeps its text and row past the hour, as a direct message runs that long', () => {
  const installation = hostedInstallation('inst_test_store_going');
  const store = testRuns(installation);
  const request = admission(installation);
  store.admit(request, NOON);
  assert.equal(store.eraseExpired(NOON + 3 * AN_HOUR), 0);
  assert.equal(store.get(request.testRunId)?.question, request.question);
  assert.equal(store.nextDueAt(NOON + 3 * AN_HOUR), NOON + 3 * AN_HOUR + TEST_RUN_WAKE_MS, 'only the look at its instance wakes for it');
});

test('only the caller reads a run, by its token: while it goes, and for an hour after it settles', () => {
  const installation = hostedInstallation('inst_test_store_read');
  const request = admission(installation);
  testRuns(installation).admit(request, NOON);
  const query = { organizationId: request.organizationId, actorMembershipId: request.actorMembershipId, runToken: request.runToken };
  assert.equal(testRuns(installation).read(query, NOON)?.testRunId, request.testRunId);
  assert.equal(testRuns(installation).read({ ...query, actorMembershipId: 'membership_other' }, NOON), undefined);
  assert.equal(testRuns(installation).read({ ...query, organizationId: 'org_other' }, NOON), undefined);
  assert.equal(testRuns(installation).read({ ...query, runToken: 'tr_unknown' }, NOON), undefined);
  assert.equal(testRuns(installation).read(query, NOON + 2 * AN_HOUR)?.testRunId, request.testRunId, 'a run going reads past the hour');
  answer(installation, request.testRunId, NOON + 2 * AN_HOUR);
  assert.equal(testRuns(installation).read(query, NOON + 3 * AN_HOUR - 1)?.testRunId, request.testRunId);
  assert.equal(testRuns(installation).read(query, NOON + 3 * AN_HOUR), undefined);
});

// Mutation proof: a lookup without the caller, the Agent, the answer, the first turn or the order names a run here.
test('Before is only the caller\'s own earlier answer to the same first question of the same Agent, from another version, while it reads', () => {
  const installation = hostedInstallation('inst_test_store_before');
  const store = testRuns(installation);
  const QUESTION = 'Who is overdue?';
  let at = NOON;
  /** One run of the question at an Agent version, three minutes after the last, so none repeats; answered unless `failed`. */
  /** A practice conversation's first turn, on another question and answered, for a follow-up to continue. */
  const opened = () => {
    const first = admission(installation, { question: 'Who is new?' });
    at += 3 * 60_000;
    assert.equal(store.admit(first, at).kind, 'admitted');
    answer(installation, first.testRunId, at);
    return first.newPracticeId;
  };
  const run = (version: string, options: Parameters<typeof startRequest>[1] & { failed?: true; followUp?: true } = {}) => {
    const { failed, followUp, ...ask } = options;
    const request = admission(installation, { question: QUESTION, ...ask, ...followUp ? { practiceId: opened() } : {} });
    at += 3 * 60_000;
    const ran = { agentVersion: version, model: 'anthropic/claude-haiku-4-5', memory: false, place: 'dm' as const };
    assert.equal(store.admit({ ...request, admitted: { ...request.admitted, ran } }, at).kind, 'admitted');
    if (failed) {
      const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(request.usage.operationId)!.operation);
      store.settle(request.testRunId, { status: 'failed', failure: 'failed', terminal: recorder.failed(at, null) });
    } else {
      answer(installation, request.testRunId, at);
    }
    return request.testRunId;
  };
  const before = (testRunId: string, when = at) => store.before(store.get(testRunId)!, when);

  // Answers of version 1 that are not the caller's own to this question of this Agent, and a run of theirs that failed.
  run('version_1', { actorMembershipId: 'membership_other' });
  run('version_1', { agentId: 'agent_other' });
  run('version_1', { question: 'Who paid?' });
  run('version_1', { followUp: true });
  run('version_1', { failed: true });
  const second = run('version_2');
  assert.equal(before(second), undefined, 'another person\'s, another Agent\'s, another question\'s, a later turn\'s and a failed run are never named');

  const third = run('version_3');
  const named = { runToken: store.get(second)!.runToken, agentVersion: 'version_2' };
  assert.deepEqual(before(third), named, 'the caller\'s own earlier answer');
  assert.equal(before(second), undefined, 'never a run asked after it');
  assert.equal(before(run('version_4', { followUp: true })), undefined, 'a conversation\'s later turn names none');

  // Named only while the caller can still read it: to the millisecond its hour ends.
  const hourEnds = store.get(second)!.settledAt! + AN_HOUR;
  const reads = (when: number) => store.read({ organizationId: installation.organizationId, actorMembershipId: 'membership_caller', runToken: named.runToken }, when);
  assert.deepEqual([before(third, hourEnds - 1), reads(hourEnds - 1)?.testRunId], [named, second]);
  assert.deepEqual([before(third, hourEnds), reads(hourEnds)], [undefined, undefined]);
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

/** Settles a run with a reply and steps of its own, as the lifecycle does. */
function answerWith(
  installation: HostedInstallation,
  testRunId: string,
  reply: string,
  steps: PracticeStep[] = [],
  at?: number,
  extra: { moreSteps?: number; results?: PracticeKeptResult[] } = {},
): void {
  const row = installation.stores.testRuns.get(testRunId)!;
  const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(row.usageOperationId)!.operation);
  const { results, moreSteps } = extra;
  assert.equal(installation.stores.testRuns.settle(testRunId, {
    status: 'answered', result: { reply, read: [], steps, ...moreSteps ? { moreSteps } : {} }, ...results ? { results } : {},
    terminal: recorder.completed(undefined, at ?? row.createdAt, row.submissionId),
  }), true);
}

function fail(installation: HostedInstallation, testRunId: string): void {
  const row = installation.stores.testRuns.get(testRunId)!;
  const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(row.usageOperationId)!.operation);
  installation.stores.testRuns.settle(testRunId, { status: 'failed', failure: 'failed', terminal: recorder.failed(row.createdAt, null) });
}

/** A conversation of the caller's, its first turn answered at NOON; the new turn's ID. */
function conversation(installation: HostedInstallation): { practiceId: string; first: TestRunAdmissionRequest } {
  const first = admission(installation, { question: 'Who is overdue?' });
  assert.equal(testRuns(installation).admit(first, NOON).kind, 'admitted');
  answerWith(installation, first.testRunId, 'Northwind is overdue.');
  return { practiceId: testRuns(installation).get(first.testRunId)!.practiceId!, first };
}

test('a follow-up continues only the caller\'s own conversation with the same Agent: another person\'s or another Agent\'s reads as ended', () => {
  const installation = hostedInstallation('inst_test_store_follow_owner');
  const store = testRuns(installation);
  const { practiceId } = conversation(installation);
  const theirs = admission(installation, { actorMembershipId: 'membership_other', practiceId, question: 'And last week?' });
  assert.deepEqual(store.admit(theirs, NOON + 60_000), { kind: 'ended' }, 'another person\'s conversation');
  const otherAgent = admission(installation, { agentId: 'agent_other', practiceId, question: 'And last week?' });
  assert.deepEqual(store.admit(otherAgent, NOON + 60_000), { kind: 'ended' }, 'another Agent');
  const otherOrganization = admission(installation, { organizationId: 'org_other', practiceId, question: 'And last week?' });
  assert.deepEqual(store.admit(otherOrganization, NOON + 60_000), { kind: 'ended' }, 'another workspace');
  assert.deepEqual(store.admit(admission(installation, { practiceId: 'pr_unknown', question: 'And last week?' }), NOON + 60_000),
    { kind: 'ended' }, 'an unknown conversation');
  for (const refused of [theirs, otherAgent, otherOrganization]) {
    assert.equal(store.get(refused.testRunId), undefined, 'nothing stored');
    assert.equal(installation.stores.usage.getOperation(refused.usage.operationId), undefined, 'no usage operation');
  }
  const mine = admission(installation, { practiceId, question: 'And last week?' });
  const admitted = store.admit(mine, NOON + 60_000);
  assert.equal(admitted.kind, 'admitted');
  assert.deepEqual([store.get(mine.testRunId)!.practiceId, store.get(mine.testRunId)!.turn], [practiceId, 2],
    'the store numbers the turn in the caller\'s conversation');
});

test('a conversation takes 10 questions, each within an hour of its latest answer; then it has ended', () => {
  const installation = hostedInstallation('inst_test_store_follow_bounds');
  const store = testRuns(installation);
  const { practiceId } = conversation(installation);
  // Ten, by the ruling: the constant is not trusted to say so.
  assert.equal(PRACTICE_TURNS, 10);
  for (let turn = 2; turn <= 10; turn += 1) {
    const next = admission(installation, { practiceId, question: `Turn ${turn}?` });
    assert.equal(store.admit(next, NOON + turn * 1_000).kind, 'admitted', `turn ${turn}`);
    assert.equal(store.get(next.testRunId)!.turn, turn);
    answerWith(installation, next.testRunId, `Answer ${turn}.`);
  }
  assert.deepEqual(store.admit(admission(installation, { practiceId, question: 'An eleventh?' }), NOON + 20_000), { kind: 'ended' });

  const timed = hostedInstallation('inst_test_store_follow_hour');
  const { practiceId: hourly } = conversation(timed);
  const second = admission(timed, { practiceId: hourly, question: 'Inside the hour?' });
  assert.equal(testRuns(timed).admit(second, NOON + 50 * 60_000).kind, 'admitted');
  answerWith(timed, second.testRunId, 'Yes.', [], NOON + 55 * 60_000);
  const third = admission(timed, { practiceId: hourly, question: 'An hour after the first?' });
  const continued = testRuns(timed).admit(third, NOON + AN_HOUR + 1_000);
  assert.equal(continued.kind, 'admitted', 'the hour counts from its latest answer, not its first question');
  // The first turn's text is past its own hour, so nothing quotes it: the next turn says the Agent didn't see it.
  assert.deepEqual(continued.kind === 'admitted' && [continued.earlier.map(({ turn }) => turn), continued.expired], [[2], 1]);
  answerWith(timed, third.testRunId, 'Still yes.', [], NOON + AN_HOUR + 2_000);
  assert.deepEqual(testRuns(timed).admit(admission(timed, { practiceId: hourly, question: 'Past it?' }), NOON + 2 * AN_HOUR + 2_000),
    { kind: 'ended' }, 'an hour after its latest answer');
});

test('a first answer slower than an hour can still be followed up, for an hour from when it answered', () => {
  const installation = hostedInstallation('inst_test_store_follow_slow');
  const store = testRuns(installation);
  const first = admission(installation, { question: 'Who is overdue?' });
  store.admit(first, NOON);
  // While it is still going past its hour, a follow-up waits for it, with its token.
  assert.deepEqual(store.admit(admission(installation, { practiceId: `pr_${first.testRunId}`, question: 'And why?' }), NOON + 70 * 60_000),
    { kind: 'in_progress', runToken: first.runToken });
  answerWith(installation, first.testRunId, 'Northwind is overdue.', [], NOON + 80 * 60_000);
  const follow = store.admit(admission(installation, { practiceId: `pr_${first.testRunId}`, question: 'And why?' }), NOON + 90 * 60_000);
  assert.deepEqual(follow.kind === 'admitted' && [follow.row.turn, follow.earlier.map(({ question }) => question), follow.expired],
    [2, ['Who is overdue?'], 0]);
});

test('a conversation with no answer counts its hour from the end of its first turn; a failed one opens nothing past it', () => {
  const installation = hostedInstallation('inst_test_store_follow_failed');
  const store = testRuns(installation);
  const first = admission(installation, { question: 'Who is overdue?' });
  store.admit(first, NOON);
  fail(installation, first.testRunId);
  const practiceId = `pr_${first.testRunId}`;
  assert.equal(store.admit(admission(installation, { practiceId, question: 'Again?' }), NOON + AN_HOUR - 1).kind, 'admitted');
  const late = hostedInstallation('inst_test_store_follow_failed_late');
  const lost = admission(late, { question: 'Who is overdue?' });
  testRuns(late).admit(lost, NOON);
  fail(late, lost.testRunId);
  assert.deepEqual(testRuns(late).admit(admission(late, { practiceId: `pr_${lost.testRunId}`, question: 'Again?' }), NOON + AN_HOUR),
    { kind: 'ended' });
});

test('a failed turn after the latest answer opens nothing past that answer\'s hour, whether or not the answer\'s row is gone', () => {
  const failAt = (installation: HostedInstallation, testRunId: string, at: number) => {
    const row = installation.stores.testRuns.get(testRunId)!;
    const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(row.usageOperationId)!.operation);
    assert.equal(installation.stores.testRuns.settle(testRunId, { status: 'failed', failure: 'failed', terminal: recorder.failed(at, null) }), true);
  };
  for (const erased of [false, true]) {
    const installation = hostedInstallation(`inst_test_store_follow_failed_after_${erased}`);
    const store = testRuns(installation);
    const { practiceId, first } = conversation(installation);
    const second = admission(installation, { practiceId, question: 'And last week?' });
    assert.equal(store.admit(second, NOON + 50 * 60_000).kind, 'admitted');
    failAt(installation, second.testRunId, NOON + 51 * 60_000);
    // Inside the answer's hour the conversation goes on, quoting the answer and never the failed turn.
    const inside = store.admit(admission(installation, { practiceId, question: 'Inside?' }), NOON + AN_HOUR - 1);
    assert.deepEqual(inside.kind === 'admitted' && [inside.row.turn, inside.earlier.map(({ turn }) => turn)], [3, [1]]);
    failAt(installation, inside.kind === 'admitted' ? inside.row.testRunId : '', NOON + AN_HOUR - 1);
    if (erased) {
      store.markErased(first.testRunId, NOON + AN_HOUR);
      assert.equal(store.eraseExpired(NOON + AN_HOUR), 1, 'the answered turn\'s row is deleted at its hour');
      assert.equal(store.get(first.testRunId), undefined);
    }
    // The failed turns are minutes old; the latest answer is an hour old.
    assert.deepEqual(store.admit(admission(installation, { practiceId, question: 'Past it?' }), NOON + AN_HOUR), { kind: 'ended' },
      erased ? 'its row gone' : 'its row still there');
  }
  // With none answered, the hour runs from the first turn's end, whichever rows are left.
  for (const erased of [false, true]) {
    const installation = hostedInstallation(`inst_test_store_follow_all_failed_${erased}`);
    const store = testRuns(installation);
    const first = admission(installation, { question: 'Who is overdue?' });
    store.admit(first, NOON);
    failAt(installation, first.testRunId, NOON);
    const practiceId = `pr_${first.testRunId}`;
    const second = admission(installation, { practiceId, question: 'Again?' });
    assert.equal(store.admit(second, NOON + 50 * 60_000).kind, 'admitted');
    failAt(installation, second.testRunId, NOON + 51 * 60_000);
    if (erased) {
      store.markErased(first.testRunId, NOON + AN_HOUR);
      assert.equal(store.eraseExpired(NOON + AN_HOUR), 1);
    }
    assert.deepEqual(store.admit(admission(installation, { practiceId, question: 'Once more?' }), NOON + AN_HOUR), { kind: 'ended' },
      erased ? 'its first row gone' : 'its first row still there');
  }
});

test('a conversation whose first turn is gone goes on from its later turns, and counts the gone one as unseen', () => {
  const installation = hostedInstallation('inst_test_store_follow_lost_first');
  const store = testRuns(installation);
  const { practiceId, first } = conversation(installation);
  const second = admission(installation, { practiceId, question: 'And last week?' });
  store.admit(second, NOON + 1_000);
  answerWith(installation, second.testRunId, 'Contoso.', [], NOON + 50 * 60_000);
  // The retention erase deleted the first turn an hour after it answered.
  assert.equal(store.eraseExpired(NOON + AN_HOUR), 0);
  store.markErased(first.testRunId, NOON + AN_HOUR);
  assert.equal(store.eraseExpired(NOON + AN_HOUR + 1), 1);
  assert.equal(store.get(first.testRunId), undefined);
  const third = store.admit(admission(installation, { practiceId, question: 'And today?' }), NOON + AN_HOUR + 2_000);
  assert.deepEqual(third.kind === 'admitted' && [third.row.turn, third.earlier.map(({ turn }) => turn), third.expired], [3, [2], 1]);
  // Still only the caller's own, and only with that Agent.
  assert.deepEqual(store.admit(admission(installation, { practiceId, agentId: 'agent_other', question: 'And today?' }), NOON + AN_HOUR + 3_000),
    { kind: 'ended' });
  assert.deepEqual(store.admit(admission(installation, { practiceId, actorMembershipId: 'membership_other', question: 'And today?' }),
    NOON + AN_HOUR + 3_000), { kind: 'ended' });
});

test('a follow-up while its conversation\'s last turn is going gets that turn\'s runToken', () => {
  const installation = hostedInstallation('inst_test_store_follow_going');
  const store = testRuns(installation);
  const { practiceId } = conversation(installation);
  const second = admission(installation, { practiceId, question: 'And last week?' });
  store.admit(second, NOON + 1_000);
  assert.deepEqual(store.admit(admission(installation, { practiceId, question: 'And today?' }), NOON + 2_000),
    { kind: 'in_progress', runToken: second.runToken });
  // Only the caller's open conversation with this Agent says so: named with another Agent it has ended, and no token is returned.
  assert.deepEqual(store.admit(admission(installation, { agentId: 'agent_other', practiceId, question: 'And today?' }), NOON + 2_000),
    { kind: 'ended' });
});

test('a follow-up gets its conversation\'s answered turns in order, with their steps; a failed turn is left out', () => {
  const installation = hostedInstallation('inst_test_store_follow_history');
  const store = testRuns(installation);
  const { practiceId } = conversation(installation);
  const steps: PracticeStep[] = [{ kind: 'tool', service: 'Probe Board', tool: 'probe_board_search', outcome: 'ok' }];
  const second = admission(installation, { practiceId, question: 'Why?' });
  store.admit(second, NOON + 1_000);
  fail(installation, second.testRunId);
  const third = admission(installation, { practiceId, question: 'And last week?' });
  store.admit(third, NOON + 2_000);
  answerWith(installation, third.testRunId, 'Contoso.', steps, undefined, { moreSteps: 7 });
  const fourth = store.admit(admission(installation, { practiceId, question: 'And today?' }), NOON + 3_000);
  assert.equal(fourth.kind, 'admitted');
  assert.deepEqual(fourth.kind === 'admitted' && [fourth.earlier, fourth.expired], [[
    { turn: 1, question: 'Who is overdue?', reply: 'Northwind is overdue.', steps: [] },
    { turn: 3, question: 'And last week?', reply: 'Contoso.', steps, moreSteps: 7 },
  ], 0]);
  assert.equal(fourth.kind === 'admitted' && fourth.row.turn, 4, 'a failed turn still counts toward the 10');
  const fresh = store.admit(admission(installation, { question: 'A new conversation?' }), NOON + 4_000);
  assert.deepEqual(fresh.kind === 'admitted' && [fresh.earlier, fresh.row.turn], [[], 1]);
});

test('a listing holds only the caller\'s own runs of that Agent they can still read, newest first, and never a reply', () => {
  const installation = hostedInstallation('inst_test_store_list');
  const store = testRuns(installation);
  const { practiceId, first } = conversation(installation);
  const second = admission(installation, { practiceId, question: 'And last week?' });
  store.admit(second, NOON + 1_000);
  store.admit(admission(installation, { actorMembershipId: 'membership_other', question: 'Theirs?' }), NOON + 2_000);
  store.admit(admission(installation, { agentId: 'agent_other', question: 'Another Agent?' }), NOON + 3_000);
  const query = { organizationId: first.organizationId, actorMembershipId: first.actorMembershipId, agentId: first.agentId };
  assert.deepEqual(store.list(query, NOON + 4_000), [
    { runToken: second.runToken, practiceId, turn: 2, status: 'admitted', question: 'And last week?', createdAt: NOON + 1_000 },
    { runToken: first.runToken, practiceId, turn: 1, status: 'answered', question: 'Who is overdue?', createdAt: NOON },
  ]);
  assert.deepEqual(store.list({ ...query, organizationId: 'org_other' }, NOON + 4_000), []);
  assert.deepEqual(store.list(query, NOON + AN_HOUR).map(({ turn }) => turn), [2], 'the first turn\'s hour is over');
  // A run still going past its first hour reads, so it is listed, as long as it goes.
  assert.deepEqual(store.list(query, NOON + 3 * AN_HOUR).map(({ turn }) => turn), [2], 'still going, so still listed');
  assert.equal(store.read({ ...query, runToken: second.runToken }, NOON + 3 * AN_HOUR)?.runToken, second.runToken);
  // Settled late, it is listed for an hour from then, not from when it was asked.
  answerWith(installation, second.testRunId, 'Contoso.', [], NOON + 3 * AN_HOUR);
  assert.deepEqual(store.list(query, NOON + 4 * AN_HOUR - 1).map(({ turn }) => turn), [2], 'an hour from its settlement');
  assert.deepEqual(store.list(query, NOON + 4 * AN_HOUR), [], 'nothing after it');
  assert.equal(store.read({ ...query, runToken: second.runToken }, NOON + 4 * AN_HOUR), undefined, 'as read says');
  for (let run = 0; run < 25; run += 1) store.admit(admission(installation, { question: `Q${run}?` }), NOON + 10_000 + run);
  const listed = store.list(query, NOON + 20_000);
  assert.equal(listed.length, 20, 'the newest 20, which the result budget is measured for');
  assert.equal(PRACTICE_LISTED_RUNS, 20);
  assert.equal(listed[0]!.question, 'Q24?', 'newest first');
});
