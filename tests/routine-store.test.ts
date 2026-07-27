import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
import { RoutineStoreLogic, SqliteRoutineStore } from '../src/routines/store.ts';
import {
  RoutineStateError,
  type RoutineConfirmationDraft,
  type RoutineDefinition,
  type RoutineDefinitionContent,
} from '../src/routines/types.ts';

const CREATED_AT = Date.UTC(2026, 6, 27, 12);
const NEXT_RUN = CREATED_AT + 60 * 60 * 1_000;

function definition(overrides: Partial<RoutineDefinitionContent> = {}): RoutineDefinitionContent {
  return {
    name: 'Daily project steward',
    description: 'Summarize the project and follow up on approved actions.',
    taskText: 'Review the current project status and perform the requested channel-authorized actions.',
    triggerKind: 'schedule',
    scheduleInput: 'Every day at 9am',
    scheduleJson: JSON.stringify({ kind: 'cron', expression: '0 9 * * *' }),
    timezone: 'America/Los_Angeles',
    outputPolicy: 'post',
    authorityMode: 'live_channel_v1',
    ...overrides,
  };
}

function createDraft(
  routineId = 'routine_test',
  overrides: Partial<Extract<RoutineConfirmationDraft, { action: 'create' }>> = {},
): Extract<RoutineConfirmationDraft, { action: 'create' }> {
  return {
    action: 'create',
    routineId,
    definition: definition(),
    nextRunAt: NEXT_RUN,
    projectedDailyStarts: 1,
    reservations: [{ windowStart: NEXT_RUN, count: 1 }],
    ...overrides,
  };
}

async function confirmDraft(
  store: SqliteRoutineStore,
  draft: RoutineConfirmationDraft,
  suffix: string,
  now = CREATED_AT,
): Promise<RoutineDefinition> {
  const token = `token-${suffix}`;
  const tokenHash = hashRoutineValue(token);
  const previewHash = hashRoutineValue(JSON.stringify(draft));
  await store.putConfirmation({
    confirmationId: `rconfirm_${suffix}`,
    tokenHash,
    actorId: 'U_MEMBER',
    actorClass: 'member',
    workspaceId: 'T_TEST',
    channelId: 'C_TEST',
    draft,
    previewHash,
    expiresAt: now + 15 * 60 * 1_000,
  });
  return store.confirm({
    tokenHash,
    actorId: 'U_MEMBER',
    workspaceId: 'T_TEST',
    channelId: 'C_TEST',
    previewHash,
    idempotencyKey: `routine:confirm:${suffix}`,
  });
}

test('routine schema is additive and portable across the target-neutral StateDb contract', () => {
  const sqlite = openStateDb(':memory:');
  sqlite.exec('CREATE TABLE existing_fixture (id TEXT PRIMARY KEY)');
  sqlite.run('INSERT INTO existing_fixture (id) VALUES (?)', 'preserved');
  const portable = {
    run: (sql: string, ...params: Array<string | number | null>) => sqlite.run(sql, ...params),
    get: (sql: string, ...params: Array<string | number | null>) => sqlite.get(sql, ...params),
    all: (sql: string, ...params: Array<string | number | null>) => sqlite.all(sql, ...params),
    exec: (sql: string) => {
      if (/^\s*PRAGMA\b/i.test(sql)) throw new Error('Cloudflare StateDb has no PRAGMA contract');
      sqlite.exec(sql);
    },
    transaction: <T>(fn: () => T) => sqlite.transaction(fn),
  };

  assert.doesNotThrow(() => new RoutineStoreLogic(portable, () => CREATED_AT));
  assert.equal(sqlite.get('SELECT id FROM existing_fixture')?.id, 'preserved');
  sqlite.close();
});

test('confirmation atomically creates a versioned routine and body-free scheduled-work audit', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const draft = createDraft();
    const routine = await confirmDraft(store, draft, 'create');
    const replay = await store.confirm({
      tokenHash: hashRoutineValue('token-create'),
      actorId: 'U_MEMBER',
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      previewHash: hashRoutineValue(JSON.stringify(draft)),
      idempotencyKey: 'routine:confirm:create',
    });

    assert.deepEqual(replay, routine);
    assert.equal(routine.state, 'active');
    assert.equal(routine.version, 1);
    assert.equal(routine.creatorUserId, 'U_MEMBER');
    assert.equal(routine.authorityMode, 'live_channel_v1');
    assert.equal((await store.listRevisions(routine.id)).length, 1);
    const audit = await store.listAuditEvents({ subjectId: routine.id });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.domain, 'scheduled_work');
    assert.equal(audit[0]?.eventType, 'routine.created');
    assert.doesNotMatch(audit[0]?.metadataJson ?? '', /project steward|channel-authorized/);
  } finally {
    store.close();
  }
});

test('confirmation is actor, scope, preview, expiry, version, and replay bound', async () => {
  let now = CREATED_AT;
  const store = new SqliteRoutineStore(':memory:', () => now);
  try {
    const draft = createDraft();
    const tokenHash = hashRoutineValue('bound-token');
    const previewHash = hashRoutineValue(JSON.stringify(draft));
    await store.putConfirmation({
      confirmationId: 'rconfirm_bound', tokenHash, actorId: 'U_MEMBER', actorClass: 'member',
      workspaceId: 'T_TEST', channelId: 'C_TEST', draft, previewHash, expiresAt: now + 100,
    });
    for (const patch of [
      { actorId: 'U_OTHER' },
      { channelId: 'C_OTHER' },
      { previewHash: hashRoutineValue('other') },
    ]) {
      await assert.rejects(
        () => store.confirm({
          tokenHash, actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
          previewHash, idempotencyKey: `invalid-${Object.keys(patch)[0]}`, ...patch,
        }),
        (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_confirmation_invalid',
      );
    }
    now += 101;
    await assert.rejects(
      () => store.confirm({
        tokenHash, actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
        previewHash, idempotencyKey: 'expired',
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_confirmation_expired',
    );
  } finally {
    store.close();
  }
});

test('validation rejects control characters, code-point/byte overages, and credential-like content', async () => {
  const cases: Array<{ value: RoutineDefinitionContent; code: string }> = [
    { value: definition({ taskText: 'use xoxb-' + 'a'.repeat(30) }), code: 'routine_credential_rejected' },
    { value: definition({ name: 'x'.repeat(81) }), code: 'routine_content_too_large' },
    { value: definition({ description: 'safe\u0007unsafe' }), code: 'routine_invalid_control_character' },
    { value: definition({ taskText: 'é'.repeat(4_097) }), code: 'routine_content_too_large' },
  ];
  for (const [index, item] of cases.entries()) {
    const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
    try {
      await assert.rejects(
        () => confirmDraft(store, createDraft(`routine_invalid_${index}`, { definition: item.value }), `invalid-${index}`),
        (error: unknown) => error instanceof RoutineStateError && error.code === item.code,
      );
    } finally {
      store.close();
    }
  }
});

test('pause releases reservations and resume reacquires them with optimistic versions', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const routine = await confirmDraft(store, createDraft(), 'controls');
    const paused = await store.control({
      routineId: routine.id, expectedVersion: 1, action: 'pause', actorId: 'U_MEMBER',
      actorClass: 'member', idempotencyKey: 'routine:pause:test',
    });
    assert.equal(paused.state, 'paused');
    assert.equal(paused.version, 2);
    const resumed = await store.control({
      routineId: routine.id, expectedVersion: 2, action: 'resume', actorId: 'U_MEMBER',
      actorClass: 'member', idempotencyKey: 'routine:resume:test',
    });
    assert.equal(resumed.state, 'active');
    assert.equal(resumed.version, 3);
    assert.deepEqual((await store.listRevisions(routine.id)).map((revision) => revision.version), [1, 2, 3]);
    await assert.rejects(
      () => store.control({
        routineId: routine.id, expectedVersion: 1, action: 'disable', actorId: 'U_MEMBER',
        actorClass: 'member', idempotencyKey: 'routine:disable:stale',
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_version_conflict',
    );
  } finally {
    store.close();
  }
});

test('a confirmation draft cannot overwrite a concurrent routine edit or control transition', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const routine = await confirmDraft(store, createDraft(), 'edit-race-create');
    const editDraft: RoutineConfirmationDraft = {
      action: 'edit',
      routineId: routine.id,
      expectedVersion: routine.version,
      definition: definition({ name: 'Edited project steward' }),
      nextRunAt: NEXT_RUN + 60_000,
      projectedDailyStarts: 1,
      reservations: [{ windowStart: NEXT_RUN + 60_000, count: 1 }],
    };
    const tokenHash = hashRoutineValue('edit-race-token');
    const previewHash = hashRoutineValue(JSON.stringify(editDraft));
    await store.putConfirmation({
      confirmationId: 'rconfirm_edit_race', tokenHash, actorId: 'U_MEMBER', actorClass: 'member',
      workspaceId: 'T_TEST', channelId: 'C_TEST', draft: editDraft, previewHash,
      expiresAt: CREATED_AT + 15 * 60 * 1_000,
    });
    await store.control({
      routineId: routine.id, expectedVersion: 1, action: 'pause', actorId: 'U_MEMBER',
      actorClass: 'member', idempotencyKey: 'routine:edit-race:pause',
    });
    await assert.rejects(
      () => store.confirm({
        tokenHash, actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
        previewHash, idempotencyKey: 'routine:edit-race:confirm',
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_version_conflict',
    );
    assert.equal((await store.getRoutine(routine.id))?.name, routine.name);
  } finally {
    store.close();
  }
});

test('confirmation cleanup retains artifacts for 24 hours after consumption or expiry', async () => {
  let now = CREATED_AT;
  const store = new SqliteRoutineStore(':memory:', () => now);
  try {
    await confirmDraft(store, createDraft(), 'purge', now);
    now += 24 * 60 * 60 * 1_000 - 1;
    assert.equal(await store.purgeConfirmations(), 0);
    now += 15 * 60 * 1_000 + 2;
    assert.equal(await store.purgeConfirmations(), 1);
    assert.equal(await store.getConfirmation(hashRoutineValue('token-purge')), undefined);
  } finally {
    store.close();
  }
});

test('schedule capacity and collision reservations fail atomically', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    await confirmDraft(
      store,
      createDraft('routine_capacity_a', {
        projectedDailyStarts: 239,
        reservations: [{ windowStart: NEXT_RUN, count: 4 }],
      }),
      'capacity-a',
    );
    await assert.rejects(
      () => confirmDraft(
        store,
        createDraft('routine_capacity_b', {
          projectedDailyStarts: 2,
          reservations: [{ windowStart: NEXT_RUN + 60_000, count: 1 }],
        }),
        'capacity-b',
      ),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_scheduled_capacity',
    );
    await assert.rejects(
      () => confirmDraft(
        store,
        createDraft('routine_capacity_c', {
          projectedDailyStarts: 1,
          reservations: [{ windowStart: NEXT_RUN, count: 1 }],
        }),
        'capacity-c',
      ),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_cluster_capacity',
    );
    assert.equal((await store.listRoutines()).length, 1);
  } finally {
    store.close();
  }
});

test('cluster reservations enforce every rolling half-open fifteen-minute window', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    await confirmDraft(
      store,
      createDraft('routine_cluster_a', {
        reservations: [{ windowStart: NEXT_RUN, count: 4 }],
      }),
      'cluster-a',
    );
    await assert.rejects(
      () => confirmDraft(
        store,
        createDraft('routine_cluster_b', {
          reservations: [{ windowStart: NEXT_RUN + 14 * 60_000 + 59_000, count: 1 }],
        }),
        'cluster-b',
      ),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_cluster_capacity',
    );
    await confirmDraft(
      store,
      createDraft('routine_cluster_edge', {
        reservations: [{ windowStart: NEXT_RUN + 15 * 60_000, count: 1 }],
      }),
      'cluster-edge',
    );
  } finally {
    store.close();
  }
});

test('occurrence uniqueness, admission attempts, and atomic Workflow begin prevent duplicate work', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const routine = await confirmDraft(store, createDraft(), 'occurrence');
    const input = {
      runId: 'rrun_one', idempotencyKey: 'slot-one', routineId: routine.id,
      routineVersion: 1, scheduledFor: NEXT_RUN, triggerSource: 'schedule' as const,
      queuedAt: CREATED_AT, deadlineAt: CREATED_AT + 15 * 60 * 1_000,
    };
    const run = await store.createOccurrence(input);
    assert.deepEqual(await store.createOccurrence(input), run);
    await assert.rejects(
      () => store.createOccurrence({ ...input, runId: 'rrun_duplicate', idempotencyKey: 'slot-duplicate' }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_run_conflict',
    );
    const attempt = await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat-one', leaseUntil: CREATED_AT + 120_000,
      invokeStartedAt: CREATED_AT + 1,
    });
    await store.recordAdmissionReceipt(run.id, attempt.attempt, 'run_flue_primary', CREATED_AT + 2);
    assert.equal(
      await store.beginOccurrence({ occurrenceId: run.id, flueRunId: 'run_flue_primary', startedAt: CREATED_AT + 3 }),
      'started',
    );
    assert.equal(
      await store.beginOccurrence({ occurrenceId: run.id, flueRunId: 'run_flue_duplicate', startedAt: CREATED_AT + 4 }),
      'superseded',
    );
    assert.equal((await store.getRun(run.id))?.flueRunId, 'run_flue_primary');
    assert.deepEqual((await store.listAdmissions(run.id)).map((item) => item.status), ['attached', 'superseded']);
  } finally {
    store.close();
  }
});

test('attributable failures auto-pause at three while unknown outcomes pause immediately', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    let routine = await confirmDraft(store, createDraft(), 'failures');
    for (let index = 0; index < 3; index += 1) {
      const run = await store.createOccurrence({
        runId: `rrun_failure_${index}`, idempotencyKey: `failure-${index}`,
        routineId: routine.id, routineVersion: routine.version, scheduledFor: NEXT_RUN + index,
        triggerSource: 'run_now', requestedBy: 'U_MEMBER', queuedAt: CREATED_AT + index * 10,
        deadlineAt: CREATED_AT + 15 * 60 * 1_000,
      });
      await store.startAdmissionAttempt({
        occurrenceId: run.id, owner: 'manual', leaseUntil: CREATED_AT + 120_000,
        invokeStartedAt: CREATED_AT + index * 10 + 1,
      });
      await store.beginOccurrence({
        occurrenceId: run.id, flueRunId: `run_failure_${index}`, startedAt: CREATED_AT + index * 10 + 2,
      });
      await store.transitionRun({
        occurrenceId: run.id, from: ['running'], to: 'failed', at: CREATED_AT + index * 10 + 3,
        failureClass: 'tool_failed', publicError: 'The scheduled action failed safely.',
      });
      routine = (await store.getRoutine(routine.id))!;
    }
    assert.equal(routine.consecutiveFailures, 3);
    assert.equal(routine.state, 'paused');
  } finally {
    store.close();
  }
});

test('an unknown external outcome pauses immediately without inventing a retry', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const routine = await confirmDraft(store, createDraft(), 'unknown-outcome');
    const run = await store.createOccurrence({
      runId: 'rrun_unknown', idempotencyKey: 'unknown-run', routineId: routine.id,
      routineVersion: routine.version, scheduledFor: NEXT_RUN, triggerSource: 'run_now',
      requestedBy: 'U_MEMBER', queuedAt: CREATED_AT,
      deadlineAt: CREATED_AT + 15 * 60 * 1_000,
    });
    await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'manual', leaseUntil: CREATED_AT + 120_000,
      invokeStartedAt: CREATED_AT + 1,
    });
    await store.beginOccurrence({
      occurrenceId: run.id, flueRunId: 'run_unknown', startedAt: CREATED_AT + 2,
    });
    await store.transitionRun({
      occurrenceId: run.id, from: ['running'], to: 'failed', at: CREATED_AT + 3,
      failureClass: 'unknown_external_outcome',
      publicError: 'The external result is unknown and needs inspection.',
    });

    const updated = (await store.getRoutine(routine.id))!;
    assert.equal(updated.state, 'paused');
    assert.equal(updated.pausedReason, 'unknown_external_outcome');
    assert.equal(updated.consecutiveFailures, 0);
    assert.equal((await store.listRuns({ routineId: routine.id })).length, 1);
  } finally {
    store.close();
  }
});

test('confirmed deletion scrubs product-owned bodies but retains hashes, runs, and audit metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-routine-delete-'));
  const path = join(dir, 'state.db');
  const store = new SqliteRoutineStore(path, () => CREATED_AT);
  try {
    const routine = await confirmDraft(store, createDraft(), 'delete-create');
    await store.createOccurrence({
      runId: 'rrun_delete', idempotencyKey: 'delete-run', routineId: routine.id,
      routineVersion: routine.version, scheduledFor: NEXT_RUN, triggerSource: 'schedule',
      queuedAt: CREATED_AT, deadlineAt: CREATED_AT + 15 * 60 * 1_000,
    });
    await confirmDraft(
      store,
      { action: 'delete', routineId: routine.id, expectedVersion: routine.version },
      'delete-confirm',
    );
  } finally {
    store.close();
  }

  const db = openStateDb(path);
  try {
    const serialized = JSON.stringify({
      routines: db.all('SELECT * FROM routines'),
      revisions: db.all('SELECT * FROM routine_revisions'),
      confirmations: db.all('SELECT * FROM routine_confirmations'),
      runs: db.all('SELECT * FROM routine_runs'),
      audit: db.all("SELECT * FROM audit_events WHERE domain = 'scheduled_work'"),
    });
    assert.doesNotMatch(serialized, /Daily project steward|channel-authorized|Every day at 9am/);
    assert.equal(db.get('SELECT deleted_at FROM routines WHERE id = ?', 'routine_test')?.deleted_at, CREATED_AT);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM routine_runs')?.count, 1);
    assert.ok(Number(db.get('SELECT COUNT(*) AS count FROM audit_events')?.count) >= 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit failure rolls back confirmation consumption, routine, revision, and reservation writes', async () => {
  const db = openStateDb(':memory:');
  const logic = new RoutineStoreLogic(db, () => CREATED_AT);
  const draft = createDraft();
  const tokenHash = hashRoutineValue('audit-failure');
  const previewHash = hashRoutineValue(JSON.stringify(draft));
  logic.putConfirmation({
    confirmationId: 'rconfirm_audit_failure', tokenHash, actorId: 'U_MEMBER', actorClass: 'member',
    workspaceId: 'T_TEST', channelId: 'C_TEST', draft, previewHash,
    expiresAt: CREATED_AT + 15 * 60 * 1_000,
  });
  db.exec(
    `CREATE TRIGGER reject_routine_audit BEFORE INSERT ON audit_events
     WHEN NEW.domain = 'scheduled_work'
     BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
  );

  assert.throws(
    () => logic.confirm({
      tokenHash, actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
      previewHash, idempotencyKey: 'routine:audit-failure',
    }),
    /audit unavailable/,
  );
  assert.equal(db.get('SELECT COUNT(*) AS count FROM routines')?.count, 0);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM routine_revisions')?.count, 0);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM routine_schedule_reservations')?.count, 0);
  assert.equal(logic.getConfirmation(tokenHash)?.consumedAt, null);
  db.close();
});
