import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileRuntimePlanV2,
  deriveRuntimePlanInstanceId,
} from '../src/agents/runtime-plan.ts';
import type { TurnJob } from '../src/config/state-rpc.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import {
  MAX_TURN_ATTEMPTS,
  SLACK_AGENT_BINDING_TTL_MS,
  replayTextForTurnProgress,
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
  return { workspaceId: 'T1', channelId: 'C1', agentId: 'agent_test', agent: AGENT, model: 'local-stub/x' };
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

test('enqueue purges rows past the TTL horizon', () => {
  let clock = 1_000_000;
  const store = newStore(() => clock);
  store.enqueue(job('old'));
  assert.equal(store.listPending().length, 1);

  // Advance past the TTL and enqueue again: the purge on write drops the stale
  // row, leaving only the fresh one.
  clock += TURN_JOB_TTL_MS + 1;
  store.enqueue(job('fresh'));
  const ids = store.listPending().map((row) => row.id);
  assert.deepEqual(ids, ['fresh']);
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
