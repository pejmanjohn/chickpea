import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileRuntimePlanV2,
  deriveRuntimePlanInstanceId,
} from '../src/agents/runtime-plan.ts';
import type { TurnJob } from '../src/config/state-rpc.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type CustomAgentConfig,
  type ResolvedAssignment,
} from '../src/config/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { CLAIM_TTL_MS, SlackStateLogic } from '../src/slack/claim-store.ts';
import {
  MAX_TURN_ATTEMPTS,
  SLACK_AGENT_BINDING_TTL_MS,
  replayTextForTurnProgress,
  TURN_JOB_RECOVERY_BACKSTOP_MS,
  TURN_JOB_TTL_MS,
  TurnJobStoreLogic,
} from '../src/slack/turn-jobs.ts';

const AGENT: CustomAgentConfig = {
  id: 'agent_test',
  name: 'Test',
  instructions: 'do the thing',
  enabled: true,
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

function turn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1',
    channelId: 'C1',
    eventId: 'Ev1',
    slackIdentityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    text: 'hi',
    userId: 'U1',
    messageTs: '1000.0001',
    threadTs: '1000.0001',
    source: 'app_mention',
    contextMode: 'thread',
    ...overrides,
  };
}

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T1',
    channelId: 'C1',
    agentId: 'agent_test',
    slackIdentityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    agent: AGENT,
    model: 'local-stub/x',
  };
}

function job(id: string): TurnJob {
  return { id, evtKey: `evt:${id}`, msgKey: id, turn: turn(), assignment: assignment() };
}

function newStore(now: () => number = Date.now) {
  const db = openStateDb(':memory:');
  return new TurnJobStoreLogic(db, now);
}

test('enqueue is idempotent by id and round-trips the job payload', () => {
  const store = newStore();
  assert.equal(store.enqueue(job('msg:C1:1')), true);
  // Duplicate enqueue (the app_mention + message fan-out) is ignored.
  assert.equal(store.enqueue(job('msg:C1:1')), false);

  const pending = store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, 'msg:C1:1');
  assert.equal(pending[0]?.evtKey, 'evt:msg:C1:1');
  assert.equal(pending[0]?.attempts, 0);
  assert.deepEqual(pending[0]?.progress, {});
  // Nested objects survive the JSON round-trip.
  assert.equal(pending[0]?.turn.channelId, 'C1');
  assert.equal(pending[0]?.assignment.agent.id, 'agent_test');
  assert.equal(pending[0]?.assignment.model, 'local-stub/x');
});

test('TurnJob round-trips a dedicated identity without storing credentials', () => {
  const store = newStore();
  const dedicated = job('dedicated');
  dedicated.turn.slackIdentityId = 'slack_identity_finance';
  dedicated.assignment.slackIdentityId = 'slack_identity_finance';
  assert.equal(store.enqueue(dedicated), true);

  const pending = store.listPending()[0];
  assert.equal(pending?.turn.slackIdentityId, 'slack_identity_finance');
  assert.equal(pending?.assignment.slackIdentityId, 'slack_identity_finance');
  assert.doesNotMatch(JSON.stringify(pending), /xoxb-|signingSecret|botToken/i);
});

test('markDelivered and markError tombstone a job out of the pending scan', () => {
  const store = newStore();
  store.enqueue(job('a'));
  store.enqueue(job('b'));
  assert.equal(store.listPending().length, 2);

  store.markDelivered('a');
  store.markError('b');
  assert.deepEqual(store.listPending(), []);
});

test('delivered work keeps only retryable Slack cleanup coordinates', () => {
  const store = newStore();
  store.enqueue(job('work'));
  store.recordInteractionIntent('work', {
    disposition: 'work',
    reason: 'substantive_request',
    checklist: ['Inspect the artifact'],
  });
  store.recordSlackInteractionProgress('work', {
    acknowledgment: {
      channelId: 'C1', messageTs: '1000.0001', name: 'eyes', created: true,
      cleanup: 'pending',
    },
  });
  store.recordSlackInteractionProgress('work', {
    checklist: {
      channelId: 'C1', threadTs: '1000.0001', messageTs: '1000.0002',
      cleanup: 'pending',
    },
  });

  store.markDelivered('work');
  const cleanup = store.listPendingSlackInteractionCleanups();
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0]?.progress.slackInteraction?.checklist?.terminal, 'success');
  assert.deepEqual(cleanup[0]?.progress.slackInteraction?.acknowledgment, {
    channelId: 'C1', messageTs: '1000.0001', name: 'eyes', created: true,
    cleanup: 'pending',
  });

  store.recordSlackInteractionProgress('work', {
    acknowledgment: { ...cleanup[0]!.progress.slackInteraction!.acknowledgment!, cleanup: 'done' },
    checklist: { ...cleanup[0]!.progress.slackInteraction!.checklist!, cleanup: 'done' },
  });
  assert.equal(store.hasPendingSlackInteractionCleanup(), false);
});

test('recordAttempt advances the counter the alarm caps on', () => {
  const store = newStore();
  store.enqueue(job('a'));
  store.recordAttempt('a', 1);
  assert.equal(store.listPending()[0]?.attempts, 1);
  store.recordAttempt('a', MAX_TURN_ATTEMPTS);
  assert.equal(store.listPending()[0]?.attempts, MAX_TURN_ATTEMPTS);
});

test('usage persistence outcomes survive relay restart as a coverage denominator', () => {
  const store = newStore();
  store.enqueue(job('usage'));
  store.recordUsagePersistence('usage', {
    executionId: 'exec:usage:1',
    phase: 'admission',
    outcome: 'recorded',
  });
  store.recordUsagePersistence('usage', {
    executionId: 'exec:usage:1',
    phase: 'terminal',
    outcome: 'timed_out',
  });
  store.recordUsagePersistence('usage', {
    executionId: 'exec:usage:1',
    phase: 'repair',
    outcome: 'recorded',
  });
  assert.deepEqual(store.listPending()[0]?.progress.usageTelemetry, {
    executionId: 'exec:usage:1',
    admission: 'recorded',
    terminal: 'timed_out',
    repair: 'recorded',
  });
});

test('recorded PR progress makes a retry replay instead of opening another PR', () => {
  const store = newStore();
  store.enqueue(job('msg:C1:1'));
  const recorded = store.recordPullRequest('msg:C1:1', {
    number: 42,
    url: 'https://github.com/Acme/Alpha/pull/42',
    repository: 'Acme/Alpha',
    branch: 'chickpea/fix-42',
  });
  // A duplicate response cannot replace the durable first marker.
  store.recordPullRequest('msg:C1:1', {
    number: 43,
    url: 'https://github.com/Acme/Alpha/pull/43',
    repository: 'Acme/Alpha',
  });

  const retry = store.listPending()[0];
  assert.deepEqual(retry?.progress, recorded);
  assert.equal(
    replayTextForTurnProgress(retry?.progress ?? {}),
    'Pull request #42 is already open: https://github.com/Acme/Alpha/pull/42',
  );

  let opened = 0;
  const replay = replayTextForTurnProgress(retry?.progress ?? {});
  if (replay === undefined) {
    opened += 1;
  }
  assert.equal(opened, 0, 'the second attempt must not execute the PR-opening path');
});

test('age purge removes only terminal rows whose Slack cleanup is complete', () => {
  let clock = 1_000_000;
  const store = newStore(() => clock);
  store.enqueue(job('pending'));
  store.enqueue(job('terminal'));
  store.enqueue(job('cleanup'));
  store.recordSlackInteractionProgress('cleanup', {
    acknowledgment: {
      channelId: 'C1', messageTs: '1000.0001', name: 'eyes', created: true,
      cleanup: 'pending',
    },
  });
  store.markDelivered('terminal');
  store.markDelivered('cleanup');

  clock += TURN_JOB_TTL_MS + 1;
  store.enqueue(job('fresh'));
  assert.deepEqual(store.listPending().map((row) => row.id), ['pending', 'fresh']);
  assert.deepEqual(
    store.listPendingSlackInteractionCleanups().map((row) => row.id),
    ['cleanup'],
  );
});

test('dispatch envelope, receipt, and settlement checkpoints survive retry and restart', () => {
  let clock = 1_800_000_000_000;
  const store = newStore(() => clock++);
  const runtimePlan = compileRuntimePlanV2({
    turn: turn(),
    assignment: assignment(),
    instructions: 'Frozen instructions.',
    memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  store.enqueue(job('dispatch-job'));
  const decision = store.freezeRuntimePlan('dispatch-job', runtimePlan);
  const observation = {
    generation: 'dispatch-job',
    workCorrelation: {
      runId: 'run_dispatch_job',
      runExecutionId: 'execution_dispatch_job',
      mode: 'enforce' as const,
    },
  };
  const envelope = store.prepareFlueDispatch('dispatch-job', 'answer this', observation);
  assert.deepEqual(envelope, {
    schemaVersion: 1,
    agentName: 'chickpea-slack-v2',
    instanceId: decision.instanceId,
    uid: null,
    message: { kind: 'user', body: 'answer this' },
    initialData: runtimePlan,
    idempotencyKey: 'dispatch-job',
  });
  assert.deepEqual(
    store.prepareFlueDispatch('dispatch-job', 'answer this', { generation: 'other' }),
    envelope,
    'an identical retry reuses the first dispatch payload',
  );

  const receipt = {
    submissionId: 'submission_opaque',
    acceptedAt: '2026-08-01T12:00:00.000Z',
    uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  };
  assert.deepEqual(store.recordFlueReceipt('dispatch-job', receipt), receipt);
  assert.deepEqual(store.recordFlueReceipt('dispatch-job', receipt), receipt);
  assert.equal(
    store.getAgentBinding(runtimePlan.conversation.continuityKey)?.uid,
    receipt.uid,
  );
  const result = {
    text: 'done',
    requestedModel: runtimePlan.model,
    returnedModel: { provider: 'local-stub', id: 'x' },
    reportedUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    usageCompleteness: 'complete' as const,
    flueSubmissionRef: 'fluesubmission_opaque',
  };
  store.recordFlueSettlement('dispatch-job', {
    outcome: 'completed',
    settledAt: clock,
    result,
  });
  store.recordContinuityNotice('dispatch-job', { status: 'posting' });
  store.recordContinuityNotice('dispatch-job', {
    status: 'delivered',
    messageTs: '1800000000.000100',
  });
  store.recordContinuityNotice('dispatch-job', { status: 'unknown' });
  const restored = store.listPending()[0];
  assert.deepEqual(restored?.dispatchEnvelope, envelope);
  assert.deepEqual(restored?.dispatchReceipt, receipt);
  assert.deepEqual(restored?.flueSettlement, {
    outcome: 'completed',
    settledAt: clock,
    result,
  });
  assert.deepEqual(restored?.progress.continuityNotice, {
    status: 'delivered',
    messageTs: '1800000000.000100',
  });
});

test('pending jobs normalize persisted App Home runtime plans without poisoning the batch', () => {
  const db = openStateDb(':memory:');
  const store = new TurnJobStoreLogic(db);
  const runtimePlan = compileRuntimePlanV2({
    turn: turn({
      channelId: 'D1',
      threadTs: '1000.0001',
      sessionThreadTs: 'dm',
      source: 'dm_message',
      channelType: 'im',
      contextMode: 'dm_history',
    }),
    assignment: { ...assignment(), channelId: 'D1' },
    instructions: 'Frozen direct-message instructions.',
    memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  store.enqueue({
    ...job('legacy-app-home'),
    turn: { ...job('legacy-app-home').turn, channelId: 'D1' },
    assignment: { ...assignment(), channelId: 'D1' },
  });
  store.enqueue(job('ordinary-pending'));
  store.freezeRuntimePlan('legacy-app-home', runtimePlan);
  const persistedLegacyPlan = structuredClone(runtimePlan) as unknown as {
    conversation: { surface: string };
  };
  persistedLegacyPlan.conversation.surface = 'app_home';
  db.run(
    'UPDATE turn_jobs SET runtime_plan_json = ? WHERE id = ?',
    JSON.stringify(persistedLegacyPlan),
    'legacy-app-home',
  );

  const pending = store.listPending();

  assert.deepEqual(pending.map(({ id }) => id), ['legacy-app-home', 'ordinary-pending']);
  assert.equal(pending[0]?.runtimePlan?.conversation.surface, 'direct_message');
});

test('same-key dispatch payload drift fails closed in retained recovery state', () => {
  const store = newStore();
  store.enqueue(job('payload-conflict'));
  store.freezeRuntimePlan('payload-conflict', compileRuntimePlanV2({
    turn: turn(), assignment: assignment(), instructions: 'Frozen.', memoryEpoch: 1,
    sandboxMode: 'bash',
  }));
  store.prepareFlueDispatch('payload-conflict', 'original', { generation: 'first' });
  assert.throws(
    () => store.prepareFlueDispatch('payload-conflict', 'changed', { generation: 'second' }),
    /payload conflicts/i,
  );
  assert.equal(store.listPending().length, 0);
  assert.equal(store.runtimeDrainCounts().pendingLegacyTurnJobs, 1);
});

test('receipt checkpoint conflicts fail closed without replacing durable state', () => {
  const store = newStore();
  store.enqueue(job('receipt-conflict'));
  store.freezeRuntimePlan('receipt-conflict', compileRuntimePlanV2({
    turn: turn(), assignment: assignment(), instructions: 'Frozen.', memoryEpoch: 1,
    sandboxMode: 'bash',
  }));
  store.prepareFlueDispatch('receipt-conflict', 'message', { generation: 'first' });
  store.recordFlueReceipt('receipt-conflict', {
    submissionId: 'submission_original',
    acceptedAt: '2026-08-01T12:00:00.000Z',
    uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  });
  assert.throws(
    () => store.recordFlueReceipt('receipt-conflict', {
      submissionId: 'submission_conflicting',
      acceptedAt: '2026-08-01T12:00:01.000Z',
      uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }),
    /receipt conflicts/i,
  );
  assert.equal(store.listPending().length, 0);
  assert.equal(store.runtimeDrainCounts().pendingLegacyTurnJobs, 1);
});

test('nonterminal TurnJobs retain their admission claims beyond the old claim TTL', () => {
  let clock = 1_000_000;
  const db = openStateDb(':memory:');
  const claims = new SlackStateLogic(db, () => clock);
  const turns = new TurnJobStoreLogic(db, () => clock);
  const pending = job('claim-retained');
  assert.equal(claims.claim(pending.evtKey), true);
  assert.equal(claims.claim(pending.msgKey), true);
  assert.equal(claims.claim(`decision:${pending.msgKey}`), true);
  turns.enqueue(pending);

  clock += CLAIM_TTL_MS + 1;
  assert.equal(claims.claim('purge-trigger'), true);
  assert.equal(claims.claim(pending.evtKey), false);
  assert.equal(claims.claim(pending.msgKey), false);
  assert.equal(claims.claim(`decision:${pending.msgKey}`), false);

  turns.markDelivered(pending.id);
  clock += 1;
  assert.equal(claims.claim('terminal-purge-trigger'), true);
  assert.equal(claims.claim(pending.evtKey), true, 'terminal ownership releases TTL retention');
});

test('observation matching uses exact receipts and rejects receiptless ambiguity or stale delivery', () => {
  const store = newStore();
  const runtimePlan = compileRuntimePlanV2({
    turn: turn(), assignment: assignment(), instructions: 'Frozen.', memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  const start = (id: string) => {
    store.enqueue(job(id));
    const decision = store.freezeRuntimePlan(id, runtimePlan);
    store.prepareFlueDispatch(id, `message ${id}`, { generation: id });
    return decision.instanceId;
  };
  const instanceId = start('first');
  assert.equal(store.matchFlueObservation(instanceId, 'sub-first')?.turnJobId, 'first');
  start('second');
  assert.equal(store.matchFlueObservation(instanceId, 'sub-unknown'), undefined);
  store.recordFlueReceipt('first', {
    submissionId: 'sub-first', acceptedAt: '2026-08-01T12:00:00.000Z',
    uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  });
  assert.equal(store.matchFlueObservation(instanceId, 'sub-first')?.turnJobId, 'first');
  store.markDelivered('first');
  assert.equal(store.matchFlueObservation(instanceId, 'sub-first'), undefined);
});

test('dispatch-started jobs cannot be discarded and cross the 30-day backstop visibly', () => {
  let clock = 1_000_000;
  const store = newStore(() => clock);
  const runtimePlan = compileRuntimePlanV2({
    turn: turn(), assignment: assignment(), instructions: 'Frozen.', memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  store.enqueue(job('never-dispatched'));
  assert.equal(store.discard('never-dispatched'), true);
  store.enqueue(job('started'));
  store.freezeRuntimePlan('started', runtimePlan);
  const instanceId = store.prepareFlueDispatch(
    'started', 'message', { generation: 'started' },
  ).instanceId;
  assert.equal(store.discard('started'), false);
  assert.equal(store.listPending().length, 0, 'recovery rows do not auto-redrive');
  assert.equal(store.runtimeDrainCounts().pendingLegacyTurnJobs, 1);
  assert.equal(store.matchFlueObservation(instanceId)?.turnJobId, 'started');

  store.enqueue(job('aging'));

  clock += TURN_JOB_RECOVERY_BACKSTOP_MS + 1;
  store.enqueue(job('fresh'));
  assert.deepEqual(store.listPending().map((row) => row.id), ['fresh']);
  assert.equal(
    store.runtimeDrainCounts().pendingLegacyTurnJobs,
    3,
    'operator drain status includes both recovery rows and the fresh pending row',
  );
});

test('pending jobs come back in enqueue order', () => {
  let clock = 1;
  const store = newStore(() => clock);
  store.enqueue(job('first'));
  clock += 5;
  store.enqueue(job('second'));
  clock += 5;
  store.enqueue(job('third'));
  assert.deepEqual(
    store.listPending().map((row) => row.id),
    ['first', 'second', 'third'],
  );
});

test('bounded pending scans preserve the remaining compatibility queue', () => {
  let clock = 1;
  const store = newStore(() => clock++);
  for (const id of ['first', 'second', 'third']) store.enqueue(job(id));
  assert.deepEqual(store.listPending(2).map((row) => row.id), ['first', 'second']);
  assert.equal(store.hasPending(), true);
  store.markDelivered('first');
  store.markDelivered('second');
  assert.deepEqual(store.listPending(2).map((row) => row.id), ['third']);
  store.markDelivered('third');
  assert.equal(store.hasPending(), false);
});

test('legacy and ledger authority lanes never drain each other', () => {
  const store = newStore();
  store.enqueue(job('legacy'));
  store.enqueue({
    ...job('ledger'),
    runId: 'run_ledger_fixture',
    executionAuthority: 'ledger',
  });
  assert.deepEqual(store.listPending().map((row) => row.id), ['legacy']);
  assert.deepEqual(store.listPending(10, 'ledger').map((row) => row.id), ['ledger']);
  assert.equal(store.getPendingByRunId('run_ledger_fixture')?.id, 'ledger');
  assert.equal(store.hasPending('legacy'), true);
  assert.equal(store.hasPending('ledger'), true);
});

test('runtime drain counts separate turn authorities and pending Slack cleanup', () => {
  const store = newStore();
  store.enqueue(job('legacy'));
  store.enqueue({ ...job('ledger'), executionAuthority: 'ledger', runId: 'run_ledger' });
  store.enqueue(job('cleanup'));
  store.recordSlackInteractionProgress('cleanup', {
    acknowledgment: {
      channelId: 'C1',
      messageTs: '1000.0001',
      name: 'eyes',
      created: true,
      cleanup: 'pending',
    },
  });
  store.markDelivered('cleanup');

  assert.deepEqual(store.runtimeDrainCounts(), {
    pendingLegacyTurnJobs: 1,
    pendingLedgerTurnJobs: 1,
    pendingSlackInteractionCleanups: 1,
    recoveryRequiredTurnJobs: 0,
  });
});

test('runtime plans freeze once and record surface-specific rotation decisions', () => {
  const store = newStore(() => 1_800_000_000_000);
  const dmTurn = turn({
    channelId: 'D1',
    threadTs: '1782770100.000100',
    sessionThreadTs: 'dm',
    source: 'dm_message',
    channelType: 'im',
    contextMode: 'dm_history',
  });
  const dmAssignment = { ...assignment(), channelId: 'D1' };
  const baseline = compileRuntimePlanV2({
    turn: dmTurn,
    assignment: dmAssignment,
    instructions: 'Frozen instructions.',
    memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  store.enqueue({
    ...job('dm-first'),
    turn: dmTurn,
    assignment: dmAssignment,
  });
  const first = store.freezeRuntimePlan('dm-first', baseline);
  assert.equal(first.instanceId, deriveRuntimePlanInstanceId(baseline));
  assert.equal(first.continuityNoticeRequired, false, 'a first conversation is not a rotation');

  const binding = {
    continuityKey: baseline.conversation.continuityKey,
    instanceId: first.instanceId,
    uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    updatedAt: 1_800_000_000_000,
  };
  store.pinAgentBinding(binding);

  const rotated = compileRuntimePlanV2({
    turn: { ...dmTurn, eventId: 'Ev2', messageTs: '1782770101.000100' },
    assignment: { ...dmAssignment, model: 'anthropic/claude-haiku-4-5' },
    instructions: 'Frozen instructions.',
    memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  store.enqueue({
    ...job('dm-rotated'),
    turn: { ...dmTurn, eventId: 'Ev2', messageTs: '1782770101.000100' },
    assignment: { ...dmAssignment, model: 'anthropic/claude-haiku-4-5' },
  });
  const dmDecision = store.freezeRuntimePlan('dm-rotated', rotated);
  assert.equal(dmDecision.continuityNoticeRequired, true);

  const driftedRetry = compileRuntimePlanV2({
    turn: dmTurn,
    assignment: { ...dmAssignment, model: 'local-stub/changed-after-admission' },
    instructions: 'Changed after admission.',
    memoryEpoch: 2,
    sandboxMode: 'cloudflare',
  });
  assert.deepEqual(
    store.freezeRuntimePlan('dm-first', driftedRetry),
    first,
    'a retry keeps the first accepted plan and target',
  );

  const channelPlan = compileRuntimePlanV2({
    turn: turn(),
    assignment: assignment(),
    instructions: 'Channel instructions.',
    memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  store.pinAgentBinding({
    continuityKey: channelPlan.conversation.continuityKey,
    instanceId: `agent_${'c'.repeat(40)}`,
    uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAA',
    updatedAt: 1_800_000_000_000,
  });
  store.enqueue(job('channel-rotated'));
  assert.equal(
    store.freezeRuntimePlan('channel-rotated', channelPlan).continuityNoticeRequired,
    false,
    'channel context is reassembled silently',
  );
});

test('minimal bindings use CAS rotation, reject conflicting uids, and expire after 30 days', () => {
  let clock = 1_800_000_000_000;
  const store = newStore(() => clock);
  const initial = {
    continuityKey: `agent_${'a'.repeat(40)}`,
    instanceId: `agent_${'b'.repeat(40)}`,
    uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    updatedAt: clock,
  };
  assert.deepEqual(store.pinAgentBinding(initial), initial);
  assert.deepEqual(store.getAgentBinding(initial.continuityKey), initial);

  clock += 1;
  assert.throws(
    () => store.pinAgentBinding({
      ...initial,
      uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      updatedAt: clock,
    }),
    /conflicting uid/i,
  );
  const rotated = {
    ...initial,
    instanceId: `agent_${'c'.repeat(40)}`,
    uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAX',
    updatedAt: clock,
  };
  assert.throws(() => store.pinAgentBinding(rotated), /compare-and-set/i);
  assert.deepEqual(
    store.pinAgentBinding(rotated, {
      instanceId: initial.instanceId,
      uid: initial.uid,
    }),
    rotated,
  );

  clock += SLACK_AGENT_BINDING_TTL_MS + 1;
  assert.equal(store.getAgentBinding(initial.continuityKey), undefined);
});

test('an expired binding collision durably reconciles to the proven Flue uid', () => {
  const store = newStore(() => 1_800_000_000_000);
  const runtimePlan = compileRuntimePlanV2({
    turn: turn(), assignment: assignment(), instructions: 'Frozen.', memoryEpoch: 1,
    sandboxMode: 'bash',
  });
  store.enqueue(job('binding-reconcile'));
  store.freezeRuntimePlan('binding-reconcile', runtimePlan);
  const created = store.prepareFlueDispatch(
    'binding-reconcile',
    'message',
    { generation: 'binding-reconcile' },
  );
  assert.equal(created.uid, null);
  assert.ok(created.initialData);

  const uid = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAY';
  const reconciled = store.reconcileFlueExistingInstance('binding-reconcile', uid);
  assert.equal(reconciled.uid, uid);
  assert.equal(reconciled.initialData, undefined);
  assert.deepEqual(store.reconcileFlueExistingInstance('binding-reconcile', uid), reconciled);

  store.recordFlueReceipt('binding-reconcile', {
    submissionId: 'submission_binding_reconcile',
    acceptedAt: '2026-08-01T12:00:00.000Z',
    uid,
  });
  assert.equal(store.getAgentBinding(runtimePlan.conversation.continuityKey)?.uid, uid);
});

test('recovery inventory is bounded and explicitly terminalized', () => {
  const store = newStore(() => 1_800_000_000_000);
  store.enqueue(job('recovery-inventory'));
  store.markRecoveryRequired('recovery-inventory', 'flue_receipt_conflict');
  assert.deepEqual(store.listRecoveryRequired(), [{
    id: 'recovery-inventory',
    executionAuthority: 'legacy',
    reason: 'flue_receipt_conflict',
    enqueuedAt: 1_800_000_000_000,
  }]);
  assert.equal(store.runtimeDrainCounts().recoveryRequiredTurnJobs, 1);
  assert.equal(store.resolveRecoveryRequired('recovery-inventory'), true);
  assert.equal(store.resolveRecoveryRequired('recovery-inventory'), false);
  assert.deepEqual(store.listRecoveryRequired(), []);
  assert.equal(store.runtimeDrainCounts().recoveryRequiredTurnJobs, 0);
});

test('existing turn job tables gain progress storage without losing pending rows', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec(
      `CREATE TABLE turn_jobs (
        id TEXT PRIMARY KEY,
        evt_key TEXT NOT NULL,
        msg_key TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        assignment_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        enqueued_at INTEGER NOT NULL
      )`,
    );
    const legacy = job('before-migration');
    delete legacy.turn.slackIdentityId;
    delete legacy.assignment.slackIdentityId;
    db.run(
      `INSERT INTO turn_jobs (
        id, evt_key, msg_key, turn_json, assignment_json, attempts, delivered, status, enqueued_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', ?)`,
      legacy.id,
      legacy.evtKey,
      legacy.msgKey,
      JSON.stringify(legacy.turn),
      JSON.stringify(legacy.assignment),
      Date.now(),
    );
    const store = new TurnJobStoreLogic(db);
    const pending = store.listPending();
    assert.equal(pending[0]?.id, 'before-migration');
    assert.equal(pending[0]?.executionAuthority, 'legacy');
    assert.deepEqual(pending[0]?.progress, {});
    assert.equal(pending[0]?.turn.slackIdentityId, WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
    assert.equal(pending[0]?.assignment.slackIdentityId, WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
    const bindingColumns = db.all('PRAGMA table_info(slack_agent_bindings)')
      .map((column) => String(column.name));
    assert.deepEqual(bindingColumns, ['continuity_key', 'instance_id', 'uid', 'updated_at']);
    assert.equal(
      db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'slack_agent_execution_contexts'"),
      undefined,
    );
  } finally {
    db.close();
  }
});
