import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveRuntimePlanInstanceId, parseRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import {
  TEST_RUN_DAILY_LIMIT_USD_MICROS,
  TEST_RUN_DAILY_RUNS,
  TEST_RUN_VISIBLE_MS,
} from '../src/management/test-runs.ts';
import type { TestRunAdmissionRequest } from '../src/management/test-run-types.ts';
import { TestRunUsageRecorder } from '../src/usage/test-run-usage.ts';
import { hostedInstallation, type HostedInstallation } from './helpers/installation-objects.ts';
import { startRequest } from './helpers/test-runs.ts';

/** Midday, UTC, on a fixed day. */
const NOON = Date.UTC(2027, 0, 15, 12);
const MIDNIGHT = Date.UTC(2027, 0, 16);

function admission(installation: HostedInstallation, options: Parameters<typeof startRequest>[1] = {}): TestRunAdmissionRequest {
  const request = startRequest(installation, { at: NOON, ...options });
  const plan = parseRuntimePlanV2(request.initialData.runtimePlan);
  return { ...request.run, instanceId: deriveRuntimePlanInstanceId(plan), planJson: JSON.stringify(request.initialData.runtimePlan) };
}

/** Settles a run as answered, freeing the lock, as the lifecycle does. */
function answer(installation: HostedInstallation, testRunId: string, at?: number): void {
  const row = installation.stores.testRuns.get(testRunId)!;
  at ??= row.createdAt;
  const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(row.usageOperationId)!.operation);
  assert.equal(installation.stores.testRuns.settle(testRunId, {
    status: 'answered', result: { reply: 'Order 42 shipped.', read: ['Orders'] }, terminal: recorder.completed(undefined, at, row.submissionId),
  }, at), true);
}

/** One priced model request under a submission, as model access records each. */
function priced(installation: HostedInstallation, runId: string, micros: number, requestId = `req_${runId}_${micros}`): void {
  installation.stores.usage.recordModelRequest({
    requestId, installationId: installation.installationId, runId, attemptId: `${runId}:1`, agentId: 'agent_tested',
    purpose: 'reply', provider: 'anthropic', model: 'claude-haiku-4-5', fundingSource: 'platform', outcome: 'completed',
    inputTokens: 10, outputTokens: { total: 10, reasoning: null }, cacheReadTokens: 0,
    cacheWriteTokens: { total: 0, oneHour: null }, priceVersionId: 'price_1', listPriceUsdMicros: micros,
    priceUnknownReason: null, providerCostUsdMicros: null, providerResponseId: null, providerServiceTier: null,
    providerInferenceGeo: null, finishedAt: NOON,
  });
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
  assert.equal(row.expiresAt, NOON + TEST_RUN_VISIBLE_MS);
  const operation = usage.getOperation(row.usageOperationId)!.operation;
  assert.deepEqual(
    [operation.operationKind, operation.status, operation.conversationKind, operation.channelId, operation.requesterMembershipId],
    ['test_turn', 'admitted', 'direct_message', null, 'membership_caller'],
  );

  // The lock is held, yet the same caller's same key gets the same run.
  assert.deepEqual(testRuns.admit({ ...admission(installation), idempotencyKey: 'key_once' }, NOON), { kind: 'replayed', row });
  // The same key from the same caller for another Agent is refused.
  assert.deepEqual(testRuns.admit({ ...admission(installation, { agentId: 'agent_other' }), idempotencyKey: 'key_once' }, NOON),
    { kind: 'key_reused' });
  // Another key while it runs: one run at a time.
  assert.deepEqual(testRuns.admit(admission(installation), NOON), { kind: 'in_progress' });

  // A failed usage admission leaves no row behind.
  const broken = admission(installation, { organizationId: 'org_other' });
  assert.throws(() => testRuns.admit({ ...broken, usage: { ...broken.usage, operationKind: 'unknown' as never } }, NOON));
  assert.equal(testRuns.get(broken.testRunId), undefined, 'the row rolls back with the usage operation');
});

test('one run at a time per installation is the partial unique index, freed at settlement', () => {
  const installation = hostedInstallation('inst_test_store_lock');
  const { db } = installation;
  const first = admission(installation);
  testRuns(installation).admit(first, NOON);
  // Written directly, a second live row is refused by the index alone.
  const second = admission(installation);
  const insert = (request: TestRunAdmissionRequest, status: string) => db.run(
    `INSERT INTO management_test_runs (test_run_id, run_token, coordinate_token, organization_id, actor_membership_id,
       agent_id, status, idempotency_key, instance_id, plan_json, usage_operation_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    request.testRunId, request.runToken, request.coordinateToken, request.organizationId, request.actorMembershipId,
    request.agentId, status, request.idempotencyKey, request.instanceId, request.planJson, request.usage.operationId, NOON,
    NOON + TEST_RUN_VISIBLE_MS,
  );
  assert.throws(() => insert(second, 'running'), /UNIQUE constraint failed/);
  // Another organization's run is its own.
  testRuns(installation).admit(admission(installation, { organizationId: 'org_neighbour' }), NOON);

  answer(installation, first.testRunId);
  assert.equal(testRuns(installation).admit(second, NOON).kind, 'admitted', 'settlement frees the lock');
  // Settled rows never hold it, however many.
  answer(installation, second.testRunId);
  insert(admission(installation), 'answered');
  insert(admission(installation), 'failed');
});

function testRuns(installation: HostedInstallation) {
  return installation.stores.testRuns;
}

test(`a workspace admits ${TEST_RUN_DAILY_RUNS} test runs a UTC day, and the next one at midnight`, () => {
  const installation = hostedInstallation('inst_test_store_cap');
  for (let run = 0; run < TEST_RUN_DAILY_RUNS; run += 1) {
    const request = admission(installation);
    assert.equal(testRuns(installation).admit(request, NOON + run).kind, 'admitted');
    answer(installation, request.testRunId, NOON + run);
  }
  assert.deepEqual(testRuns(installation).admit(admission(installation), NOON + 100), { kind: 'daily_limit', resumesAt: MIDNIGHT });
  // Yesterday's runs don't count today; nor does a neighbour count against it.
  assert.equal(testRuns(installation).admit(admission(installation, { organizationId: 'org_neighbour' }), NOON).kind, 'admitted');
  assert.equal(testRuns(installation).admit(admission(installation), MIDNIGHT).kind, 'admitted');
});

test('a workspace admits no test run once today\'s runs reached $2 of list price, failed and aborted requests included', () => {
  const installation = hostedInstallation('inst_test_store_dollars');
  const first = admission(installation);
  testRuns(installation).admit(first, NOON);
  testRuns(installation).recordSubmission(first.testRunId, 'sub_first');
  priced(installation, 'sub_first', 1_200_000);
  answer(installation, first.testRunId);
  // A Slack turn's request never counts against test runs.
  priced(installation, 'sub_slack_turn', 5_000_000);
  const second = admission(installation);
  assert.equal(testRuns(installation).admit(second, NOON + 1).kind, 'admitted', '$1.20 of $2');
  testRuns(installation).recordSubmission(second.testRunId, 'sub_second');
  // A request that ended in an error is priced too.
  priced(installation, 'sub_second', TEST_RUN_DAILY_LIMIT_USD_MICROS - 1_200_000 - 1);
  answer(installation, second.testRunId);
  assert.equal(testRuns(installation).admit(admission(installation), NOON + 2).kind, 'admitted', 'one micro under the limit');
  answer(installation, testRuns(installation).unerased().at(-1)!.testRunId);
  priced(installation, 'sub_second', 1, 'req_last_micro');
  assert.deepEqual(testRuns(installation).admit(admission(installation), NOON + 3), { kind: 'daily_limit', resumesAt: MIDNIGHT });
  assert.equal(testRuns(installation).admit(admission(installation), MIDNIGHT).kind, 'admitted', 'a new UTC day');
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
  assert.ok(testRuns(installation).bindModelAccess(request.instanceId, 'sub_a'), 'the same submission again');
  assert.equal(testRuns(installation).bindModelAccess(request.instanceId, 'sub_b'), undefined, 'any other submission');
  // The receipt arriving late keeps the bound one.
  assert.equal(testRuns(installation).recordSubmission(request.testRunId, 'sub_b').submissionId, 'sub_a');

  answer(installation, request.testRunId);
  const settled = testRuns(installation).get(request.testRunId)!;
  assert.equal(settled.planJson, null, 'settlement nulls the plan');
  assert.equal(testRuns(installation).bindModelAccess(request.instanceId, 'sub_a'), undefined, 'a settled run grants nothing');

  // A run with no submission binds the first to ask even when it refuses it: a settled one with its plan gone.
  const late = admission(installation);
  testRuns(installation).admit(late, NOON + 1);
  testRuns(installation).settle(late.testRunId, {
    status: 'failed', failure: 'not_dispatched',
    terminal: new TestRunUsageRecorder(installation.stores.usage.getOperation(late.usage.operationId)!.operation).failed(NOON + 1, null),
  }, NOON + 1);
  assert.equal(testRuns(installation).bindModelAccess(late.instanceId, 'sub_late'), undefined);
  assert.equal(testRuns(installation).get(late.testRunId)!.submissionId, 'sub_late', 'its spend is counted under it');
});

test('a run settles once: the first settlement writes the usage terminal, and a later one changes nothing', () => {
  const installation = hostedInstallation('inst_test_store_settle');
  const request = admission(installation);
  testRuns(installation).admit(request, NOON);
  answer(installation, request.testRunId);
  const recorder = new TestRunUsageRecorder(installation.stores.usage.getOperation(request.usage.operationId)!.operation);
  assert.equal(testRuns(installation).settle(request.testRunId,
    { status: 'failed', failure: 'deadline', terminal: recorder.interrupted(NOON + 5, null) }, NOON + 5), false);
  const row = testRuns(installation).get(request.testRunId)!;
  assert.deepEqual([row.status, row.failure, row.result], ['answered', null, { reply: 'Order 42 shipped.', read: ['Orders'] }]);
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
  assert.equal(testRuns(installation).read(query, NOON + TEST_RUN_VISIBLE_MS - 1)?.testRunId, request.testRunId);
  assert.equal(testRuns(installation).read(query, NOON + TEST_RUN_VISIBLE_MS), undefined);
});

test('retention keeps a run until its hour and UTC day have passed and its instance is erased, and the cap counts it until then', () => {
  const installation = hostedInstallation('inst_test_store_retention');
  const { management } = installation.stores;
  const late = Date.UTC(2027, 0, 15, 23, 30);
  const erased = admission(installation);
  testRuns(installation).admit(erased, late);
  answer(installation, erased.testRunId, late);
  testRuns(installation).markErased(erased.testRunId, late + 60_000);
  const unerased = admission(installation);
  testRuns(installation).admit(unerased, late + 1);
  answer(installation, unerased.testRunId, late + 1);

  management.cleanupRetention(late + TEST_RUN_VISIBLE_MS / 2, 250);
  assert.ok(testRuns(installation).get(erased.testRunId)?.result, 'inside its hour, its reply stays');
  // Past the hour and past midnight: the erased run goes, the unerased one stays, reply removed.
  management.cleanupRetention(late + TEST_RUN_VISIBLE_MS + 1, 250);
  assert.equal(testRuns(installation).get(erased.testRunId), undefined);
  assert.equal(testRuns(installation).get(unerased.testRunId)?.result, null, 'its reply goes once it cannot be read');

  // Today's settled runs are kept, bare, so the cap still counts them.
  const today = admission(installation);
  testRuns(installation).admit(today, NOON);
  answer(installation, today.testRunId);
  testRuns(installation).markErased(today.testRunId, NOON);
  management.cleanupRetention(NOON + TEST_RUN_VISIBLE_MS + 1, 250);
  assert.ok(testRuns(installation).get(today.testRunId), 'kept until its UTC day ends');
  assert.equal(testRuns(installation).get(today.testRunId)?.result, null);
});
