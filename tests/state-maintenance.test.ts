import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStateDb } from '../src/state/node-state-db.ts';
import { attachStateDb } from '../src/state/schema-lifecycle.ts';
import { RoutineStoreLogic } from '../src/routines/store.ts';
import { WorkStoreLogic } from '../src/work/store.ts';
import { CLAIM_TTL_MS, SlackStateLogic } from '../src/slack/claim-store.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import {
  DAY, MAINTENANCE_INDEXES, NOW, maintenanceFixture, recordingDb, turnJob,
} from './fixtures/state-db/maintenance.ts';

for (const workFirst of [false, true]) {
  test(`routine construction guarantees execution projection, work first=${workFirst}`, () => {
    const db = openStateDb(':memory:');
    try {
      if (workFirst) new WorkStoreLogic(db, { env: {} });
      const trace = recordingDb(db);
      const routines = new RoutineStoreLogic(trace.db);
      assert.ok(db.all('PRAGMA table_info(run_executions)').length > 0);
      trace.statements.length = 0;
      assert.equal(routines.getRun('missing'), undefined);
      assert.deepEqual(routines.listRuns({ statuses: ['queued', 'admitting', 'running'], limit: 100 }), []);
      assert.ok(trace.statements.every(({ sql }) => !/sqlite_master|PRAGMA/.test(sql)));
      const attached = recordingDb(attachStateDb(db));
      const attachedRoutines = new RoutineStoreLogic(attached.db);
      assert.ok(attached.statements.every(({ sql }) => !/CREATE|sqlite_master|ALTER|INSERT/.test(sql)));
      attached.statements.length = 0;
      assert.equal(attachedRoutines.getRun('missing'), undefined);
      assert.ok(attached.statements.every(({ sql }) => !/sqlite_master|PRAGMA|CREATE/.test(sql)));
    } finally { db.close(); }
  });
}

test('claim probe observes a late-created turn table, then memoizes presence and protects pending work', () => {
  const db = openStateDb(':memory:');
  let clock = NOW;
  try {
    const trace = recordingDb(db);
    const claims = new SlackStateLogic(trace.db, () => clock);
    assert.equal(claims.claim('old_without_table'), true);
    clock += CLAIM_TTL_MS + 1;
    assert.equal(claims.claim('old_without_table'), true, 'age-only fallback still purges');
    const turns = new TurnJobStoreLogic(db, () => clock);
    for (const id of ['pending', 'cleanup', 'done']) {
      turns.enqueue(turnJob(id));
      claims.claim(`msg:${id}`);
    }
    turns.markDelivered('cleanup'); turns.markDelivered('done');
    // Legacy progress is intentionally supported by the existing retention guard.
    db.run('UPDATE turn_jobs SET progress_json = ? WHERE id = ?', '{"cleanup":"pending"}', 'cleanup');
    clock += CLAIM_TTL_MS + 1;
    trace.statements.length = 0;
    assert.equal(claims.claim('msg:pending'), false);
    assert.equal(claims.claim('msg:cleanup'), false);
    assert.equal(claims.claim('msg:done'), true);
    assert.equal(trace.statements.filter(({ sql }) => /PRAGMA table_info\(turn_jobs\)/.test(sql)).length, 0,
      'the earlier successful probe is retained');
    assert.equal(trace.statements.some(({ sql }) => /sqlite_master/.test(sql)), false);
  } finally { db.close(); }
});

test('seven indexes install on populated upgrade without changing state; repeat and attach do not rebuild', () => {
  const db = openStateDb(':memory:');
  try {
    const fixture = maintenanceFixture(db, 12);
    const before = fixture.tick();
    for (const index of MAINTENANCE_INDEXES) db.exec(`DROP INDEX ${index}`);
    db.run("DELETE FROM app_migrations WHERE domain = 'work' AND version = 3");
    const trace = recordingDb(db);
    new RoutineStoreLogic(trace.db);
    new WorkStoreLogic(trace.db, { env: {} });
    // These two owners install their own indexes independently of Work.
    new SlackRunPresentationStoreLogic(trace.db);
    new TurnJobStoreLogic(trace.db);
    assert.deepEqual(fixture.tick(), before);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    for (const name of MAINTENANCE_INDEXES) assert.ok(db.get('SELECT name FROM sqlite_master WHERE name = ?', name), name);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM app_migrations WHERE domain = 'work' AND version = 3")?.n, 1);
    const second = recordingDb(db);
    new WorkStoreLogic(second.db, { env: {} });
    assert.equal(second.statements.some(({ sql }) => /CREATE INDEX.*ledger_content_expiry_idx/.test(sql)), false);
    const attached = recordingDb(attachStateDb(db));
    new RoutineStoreLogic(attached.db); new TurnJobStoreLogic(attached.db);
    assert.equal(attached.statements.some(({ sql }) => /CREATE INDEX/.test(sql)), false);
  } finally { db.close(); }
});

test('turn retention computes the bound-plan ID list outside the terminal-row scan', () => {
  const db = openStateDb(':memory:');
  try {
    const trace = recordingDb(db);
    const turns = new TurnJobStoreLogic(trace.db, () => NOW);
    trace.statements.length = 0;
    turns.getAgentBinding(`agent_${'0'.repeat(40)}`);
    const cleanup = trace.statements.find(({ sql }) => /DELETE FROM turn_jobs/.test(sql));
    assert.ok(cleanup);
    const plan = db.all(`EXPLAIN QUERY PLAN ${cleanup.sql}`, ...cleanup.params);
    const retainedIds = plan.find((row) => /^LIST SUBQUERY/.test(String(row.detail)) && Number(row.parent) === 0);
    assert.ok(retainedIds, 'retained IDs must be one uncorrelated list, not a per-terminal-row subquery');
    const bindingScan = plan.find((row) => String(row.detail) === 'SCAN b');
    assert.equal(bindingScan?.parent, retainedIds.id);
    assert.ok(plan.some((row) => String(row.detail).includes('SEARCH prior USING INDEX turn_jobs_instance_id_idx')));
    assert.ok(plan.filter((row) => /CORRELATED/.test(String(row.detail)))
      .every((row) => row.parent === retainedIds.id), 'only latest-plan lookups within the retained list may correlate');
  } finally { db.close(); }
});

test('real maintenance queries use all seven indexes and skip routine runtime schema probes', () => {
  const db = openStateDb(':memory:');
  try {
    const trace = recordingDb(db);
    const fixture = maintenanceFixture(trace.db, 100);
    trace.statements.length = 0;
    fixture.tick();
    fixture.turns.listPending(10);
    fixture.routines.getRun('rrun_meter_0');
    assert.ok(trace.statements.every(({ sql }) => !/sqlite_master/.test(sql)));
    const used = new Set<string>();
    for (const { sql, params } of trace.statements) {
      const plan = db.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => String(row.detail)).join('\n');
      for (const name of MAINTENANCE_INDEXES) if (plan.includes(name)) used.add(name);
      if (/FROM (routine_runs|ledger_content|slack_run_presentations|turn_jobs|routine_confirmations)/.test(sql)) {
        assert.doesNotMatch(plan, /SCAN (?:routine_runs|rr|ledger_content|slack_run_presentations|turn_jobs|routine_confirmations)\b/);
      }
    }
    assert.deepEqual([...used].sort(), [...MAINTENANCE_INDEXES].sort());
  } finally { db.close(); }
});

test('indexed and baseline maintenance have identical mutations, cutoffs, and surviving state', () => {
  const results = [];
  for (const indexed of [false, true]) {
    const db = openStateDb(':memory:');
    try {
      const fixture = maintenanceFixture(db, 12);
      if (!indexed) for (const name of MAINTENANCE_INDEXES) db.exec(`DROP INDEX ${name}`);
      const steps = [];
      for (const at of [NOW, NOW + DAY + 60_000, NOW + 31 * DAY, NOW + 400 * DAY]) {
        fixture.setClock(at);
        steps.push({
          result: fixture.tick(),
          runs: db.all('SELECT id, status, delivery_status FROM routine_runs ORDER BY id'),
          contents: db.all('SELECT body, expires_at, purged_at, byte_size FROM ledger_content ORDER BY body'),
          presentations: db.all('SELECT run_id FROM slack_run_presentations ORDER BY run_id'),
          tombstones: db.all('SELECT * FROM slack_presentation_retention_tombstones ORDER BY sequence'),
          confirmations: db.all('SELECT id FROM routine_confirmations ORDER BY id'),
        });
        assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
      }
      assert.equal(steps[1]!.result.routines.confirmationsPurged, 1, 'only the older consumed setup confirmation expires');
      assert.equal(steps[1]!.confirmations.length, 12, 'strict expiry cutoff preserves fresh confirmations at equality');
      assert.equal(steps[2]!.result.content.purgedCount, 12);
      assert.equal(steps[2]!.result.presentations.expiredTombstoned, 12);
      assert.equal(steps[3]!.result.routines.runsDeleted, 12);
      results.push(steps);
    } finally { db.close(); }
  }
  assert.deepEqual(results[0], results[1]);
});

test('pending index preserves authority isolation, delivery, and recovery exclusion', () => {
  const db = openStateDb(':memory:');
  let clock = NOW;
  try {
    const turns = new TurnJobStoreLogic(db, () => clock);
    for (const id of ['delivered', 'recovery', 'first', 'second']) {
      turns.enqueue(turnJob(id)); clock += 1;
    }
    turns.enqueue(turnJob('ledger', 'ledger'));
    turns.markDelivered('delivered'); turns.markRecoveryRequired('recovery', 'test');
    assert.deepEqual(turns.listPending(100).map((row) => row.id), ['first', 'second']);
    assert.equal(turns.hasPending('legacy'), true); assert.equal(turns.hasPending('ledger'), true);
    turns.markDelivered('first'); turns.markDelivered('second'); turns.markDelivered('ledger');
    assert.equal(turns.hasPending('legacy'), false); assert.equal(turns.hasPending('ledger'), false);
    assert.equal(db.get("SELECT status FROM turn_jobs WHERE id = 'recovery'")?.status, 'recovery_required');
  } finally { db.close(); }
});

test('maintenance indexes preserve the one-active-occurrence constraint and reject without partial writes', () => {
  const db = openStateDb(':memory:');
  try {
    const { routines } = maintenanceFixture(db, 2);
    const routine = routines.getRoutine('routine_meter')!;
    const input = {
      runId: 'rrun_active', idempotencyKey: 'active', routineId: routine.id,
      routineVersion: routine.version, scheduledFor: NOW, triggerSource: 'run_now' as const,
      requestedBy: 'U_TEST', queuedAt: NOW, deadlineAt: NOW + 60_000,
    };
    routines.createOccurrence(input);
    routines.startAdmissionAttempt({ occurrenceId: input.runId, owner: 'test', invokeStartedAt: NOW + 1, leaseUntil: NOW + 60_000 });
    routines.beginOccurrence({ occurrenceId: input.runId, flueRunId: 'flue_active', startedAt: NOW + 2 });
    const before = db.all('SELECT id, status FROM routine_runs ORDER BY id');
    assert.throws(() => routines.createOccurrence({ ...input, runId: 'rrun_conflict', idempotencyKey: 'conflict' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'routine_run_conflict');
    assert.deepEqual(db.all('SELECT id, status FROM routine_runs ORDER BY id'), before);
    assert.throws(() => db.run("UPDATE routine_runs SET status = 'queued' WHERE id = 'rrun_meter_0'"), /UNIQUE/);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally { db.close(); }
});
