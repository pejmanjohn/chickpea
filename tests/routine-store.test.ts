import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
import { ROUTINE_LIMITS } from '../src/routines/limits.ts';
import { normalizeRoutineSchedule } from '../src/routines/schedule.ts';
import { RoutineService } from '../src/routines/service.ts';
import { RoutineStoreLogic, SqliteRoutineStore } from '../src/routines/store.ts';
import {
  RoutineStateError,
  type RoutineConfirmationDraft,
  type RoutineDefinition,
  type RoutineDefinitionContent,
  type SaveRoutineInput,
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
    scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 9 * * *' }),
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
  assert.ok(
    sqlite.all('PRAGMA table_info(routines)').some((column) => column.name === 'work_id'),
  );
  assert.ok(
    sqlite.all('PRAGMA table_info(routines)').some((column) => column.name === 'binding_id'),
  );
  assert.ok(
    sqlite.all('PRAGMA table_info(routine_runs)')
      .some((column) => column.name === 'canonical_run_id'),
  );
  sqlite.close();
});

test('direct save is idempotent and keeps deletion behind confirmation', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  const input: SaveRoutineInput = {
    actorId: 'U_MEMBER',
    actorClass: 'member',
    workspaceId: 'T_TEST',
    channelId: 'C_TEST',
    draft: createDraft('routine_direct_save'),
    idempotencyKey: 'routine:save:direct',
  };
  try {
    const routine = await store.save(input);
    assert.deepEqual(await store.save(input), routine);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 1);
    assert.equal((await store.listRevisions(routine.id)).length, 1);
    assert.equal((await store.listAuditEvents({ subjectId: routine.id })).length, 1);

    await assert.rejects(
      () => store.save({
        ...input,
        draft: {
          action: 'delete',
          routineId: routine.id,
          expectedVersion: routine.version,
        } as never,
        idempotencyKey: 'routine:save:forged-delete',
      }),
      (error: unknown) => (
        error instanceof RoutineStateError && error.code === 'routine_confirmation_required'
      ),
    );
    assert.equal((await store.getRoutine(routine.id))?.deletedAt, null);
  } finally {
    store.close();
  }
});

test('runtime drain count includes admitting and running routine occurrences only', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const routine = await confirmDraft(store, createDraft('routine_drain'), 'runtime-drain');
    const run = await store.createOccurrence({
      runId: 'rrun_runtime_drain',
      idempotencyKey: 'routine:runtime-drain',
      routineId: routine.id,
      routineVersion: routine.version,
      scheduledFor: CREATED_AT,
      triggerSource: 'run_now',
      requestedBy: 'U_MEMBER',
      queuedAt: CREATED_AT,
      deadlineAt: CREATED_AT + 15 * 60 * 1_000,
    });
    assert.equal(await store.countAdmittingOrRunningOccurrences(), 0);

    await store.transitionRun({
      occurrenceId: run.id,
      from: ['queued'],
      to: 'admitting',
      at: CREATED_AT + 1,
    });
    assert.equal(await store.countAdmittingOrRunningOccurrences(), 1);
  } finally {
    store.close();
  }
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

test('control revisions retain request provenance and deletion scrubs every copied request', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const sourceText = `Every day, ${definition().taskText}`;
    const routine = await store.save({
      actorId: 'U_MEMBER', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
      draft: createDraft('routine_control_provenance'),
      provenance: {
        sourceKind: 'slack_request', requestText: sourceText, eventId: 'Ev_control_provenance',
        messageTs: '1785000000.000100', threadTs: '1785000000.000100',
        authoritySource: 'current_request',
      },
      idempotencyKey: 'routine:control-provenance:create',
    });
    const paused = await store.control({
      routineId: routine.id, expectedVersion: routine.version, action: 'pause', actorId: 'U_MEMBER',
      actorClass: 'member', idempotencyKey: 'routine:control-provenance:pause',
    });
    const resumed = await store.control({
      routineId: routine.id, expectedVersion: paused.version, action: 'resume', actorId: 'U_MEMBER',
      actorClass: 'member', idempotencyKey: 'routine:control-provenance:resume',
    });
    const disabled = await store.control({
      routineId: routine.id, expectedVersion: resumed.version, action: 'disable', actorId: 'U_MEMBER',
      actorClass: 'member', idempotencyKey: 'routine:control-provenance:disable',
    });
    const revisions = await store.listRevisions(routine.id);
    assert.deepEqual(revisions.map((revision) => revision.provenance?.requestText), [
      sourceText, sourceText, sourceText, sourceText,
    ]);
    assert.deepEqual(
      revisions.map((revision) => revision.provenance?.definitionHash),
      revisions.map((revision) => revision.definitionHash),
    );

    const service = new RoutineService(store, {
      now: () => CREATED_AT,
      confirmationId: () => 'rconfirm_control_provenance_delete',
      token: () => 'token-control-provenance-delete',
    });
    const confirmation = await service.createConfirmation({
      action: 'delete', routineId: routine.id, expectedVersion: disabled.version,
      actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
    });
    await service.confirm({
      token: confirmation.token, actorId: 'U_MEMBER', workspaceId: 'T_TEST', channelId: 'C_TEST',
      previewHash: confirmation.previewHash, idempotencyKey: 'routine:control-provenance:delete',
    });
    assert.deepEqual(
      (await store.listRevisions(routine.id)).map((revision) => revision.provenance?.requestText),
      [null, null, null, null, undefined],
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
        projectedDailyStarts: ROUTINE_LIMITS.scheduledStartsPerRoutinePerDay,
        reservations: [{ windowStart: NEXT_RUN, count: ROUTINE_LIMITS.startsPerRollingFifteenMinutes }],
      }),
      'capacity-a',
    );
    await confirmDraft(
      store,
      createDraft('routine_capacity_b', {
        projectedDailyStarts: ROUTINE_LIMITS.scheduledStartsPerDay -
          ROUTINE_LIMITS.scheduledStartsPerRoutinePerDay - 1,
        reservations: [{ windowStart: NEXT_RUN + 15 * 60_000, count: 1 }],
      }),
      'capacity-b',
    );
    await assert.rejects(
      () => confirmDraft(
        store,
        createDraft('routine_capacity_c', {
          projectedDailyStarts: 2,
          reservations: [{ windowStart: NEXT_RUN + 30 * 60_000, count: 1 }],
        }),
        'capacity-c',
      ),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_scheduled_capacity',
    );
    await assert.rejects(
      () => confirmDraft(
        store,
        createDraft('routine_capacity_collision', {
          projectedDailyStarts: 1,
          reservations: [{ windowStart: NEXT_RUN, count: 1 }],
        }),
        'capacity-collision',
      ),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_cluster_capacity',
    );
    assert.equal((await store.listRoutines()).length, 2);
  } finally {
    store.close();
  }
});

test('one five-minute routine can coexist with ordinary scheduled work', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    await confirmDraft(
      store,
      createDraft('routine_ordinary', {
        projectedDailyStarts: 30,
        reservations: [{ windowStart: NEXT_RUN, count: 1 }],
      }),
      'ordinary-work',
    );
    const fiveMinute = normalizeRoutineSchedule('*/5 * * * *', 'UTC', CREATED_AT);
    const saved = await confirmDraft(
      store,
      createDraft('routine_five_minute', {
        nextRunAt: fiveMinute.nextRunAt,
        projectedDailyStarts: fiveMinute.projectedDailyStarts,
        reservations: fiveMinute.reservations,
      }),
      'five-minute-work',
    );

    assert.equal(saved.projectedDailyStarts, 288);
    assert.equal((await store.listRoutines()).length, 2);
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
        reservations: [{ windowStart: NEXT_RUN, count: ROUTINE_LIMITS.startsPerRollingFifteenMinutes }],
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

test('resume reprojects the schedule and reservations from current time', async () => {
  let now = CREATED_AT;
  const store = new SqliteRoutineStore(':memory:', () => now);
  try {
    let routine = await confirmDraft(store, createDraft(), 'resume-projection', now);
    const originalNextRunAt = routine.nextRunAt;
    routine = await store.control({
      routineId: routine.id,
      expectedVersion: routine.version,
      action: 'pause',
      actorId: 'U_MEMBER',
      actorClass: 'member',
      idempotencyKey: 'routine:pause:resume-projection',
    });
    now += 14 * 24 * 60 * 60 * 1_000;
    routine = await store.control({
      routineId: routine.id,
      expectedVersion: routine.version,
      action: 'resume',
      actorId: 'U_MEMBER',
      actorClass: 'member',
      idempotencyKey: 'routine:resume:resume-projection',
    });

    assert.equal(routine.state, 'active');
    assert.notEqual(routine.nextRunAt, originalNextRunAt);
    assert.ok(routine.nextRunAt !== null && routine.nextRunAt > now);
    assert.equal(routine.reservationWindows[0]?.windowStart, routine.nextRunAt);
    assert.ok(routine.reservationWindows.every(({ windowStart }) => windowStart > now));
  } finally {
    store.close();
  }
});

test('hourly schedules persist and refresh a compact rolling reservation projection', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const projection = normalizeRoutineSchedule('0 * * * *', 'UTC', CREATED_AT);
    assert.equal(projection.reservations.length, 49);
    let routine = await confirmDraft(
      store,
      createDraft('routine_hourly', {
        definition: definition({
          scheduleInput: projection.schedule.expression,
          scheduleJson: projection.scheduleJson,
          timezone: 'UTC',
        }),
        nextRunAt: projection.nextRunAt,
        projectedDailyStarts: projection.projectedDailyStarts,
        reservations: projection.reservations,
      }),
      'hourly-projection',
    );
    assert.equal(routine.reservationWindows.length, projection.reservations.length);
    assert.deepEqual(routine.reservationWindows.at(-1), projection.reservations.at(-1));
    assert.ok(JSON.stringify(routine.reservationWindows).length < 5_000);

    const claims = await store.claimDueSchedules({
      now: projection.nextRunAt,
      owner: 'heartbeat-compact-projection',
      limit: 1,
    });
    assert.equal(claims.runs.length, 1);
    routine = (await store.getRoutine(routine.id))!;
    assert.equal(routine.reservationWindows.length, 49);
    assert.equal(routine.reservationWindows[0]?.windowStart, routine.nextRunAt);
    assert.ok(routine.reservationWindows.every(({ windowStart }) => windowStart > projection.nextRunAt));
  } finally {
    store.close();
  }
});

test('run-now and deployment concurrency ceilings are enforced transactionally', async () => {
  let now = CREATED_AT;
  const store = new SqliteRoutineStore(':memory:', () => now);
  try {
    const routine = await confirmDraft(store, createDraft(), 'run-now-limit', now);
    let lastRun;
    for (let index = 0; index < 10; index += 1) {
      const queuedAt = now + index * 60 * 60 * 1_000;
      lastRun = await store.createOccurrence({
        runId: `rrun_run_now_${index}`,
        idempotencyKey: `routine:run-now:${index}`,
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: queuedAt,
        triggerSource: 'run_now',
        requestedBy: 'U_MEMBER',
        queuedAt,
        deadlineAt: queuedAt + 15 * 60 * 1_000,
      });
      await store.transitionRun({
        occurrenceId: lastRun.id,
        from: ['queued'],
        to: 'cancelled',
        at: queuedAt + 1,
      });
    }
    const replay = await store.createOccurrence({
        runId: lastRun!.id,
        idempotencyKey: lastRun!.idempotencyKey,
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: lastRun!.scheduledFor,
        triggerSource: 'run_now',
        requestedBy: 'U_MEMBER',
        queuedAt: lastRun!.queuedAt,
        deadlineAt: lastRun!.deadlineAt,
      });
    assert.equal(replay.id, lastRun!.id);
    assert.equal(replay.status, 'cancelled');
    await assert.rejects(
      () => store.createOccurrence({
        runId: 'rrun_run_now_rejected',
        idempotencyKey: 'routine:run-now:rejected',
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: now + 10 * 60 * 60 * 1_000,
        triggerSource: 'run_now',
        requestedBy: 'U_MEMBER',
        queuedAt: now + 10 * 60 * 60 * 1_000,
        deadlineAt: now + 10 * 60 * 60 * 1_000 + 15 * 60 * 1_000,
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_run_now_limit',
    );

    now += 24 * 60 * 60 * 1_000 + 12;
    assert.equal(
      (await store.createOccurrence({
        runId: 'rrun_run_now_after_window',
        idempotencyKey: 'routine:run-now:after-window',
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: now,
        triggerSource: 'run_now',
        requestedBy: 'U_MEMBER',
        queuedAt: now,
        deadlineAt: now + 15 * 60 * 1_000,
      })).status,
      'queued',
    );
  } finally {
    store.close();
  }
});

test('the total rolling-day start ceiling protects reserved scheduled capacity', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const routine = await confirmDraft(store, createDraft(), 'total-start-limit');
    for (let index = 0; index < ROUTINE_LIMITS.totalStartsRollingDay; index += 1) {
      const queuedAt = CREATED_AT + Math.floor(index / ROUTINE_LIMITS.startsPerRollingFifteenMinutes) *
        15 * 60 * 1_000 + (index % ROUTINE_LIMITS.startsPerRollingFifteenMinutes);
      const run = await store.createOccurrence({
        runId: `rrun_total_${index}`,
        idempotencyKey: `routine:total:${index}`,
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: queuedAt,
        triggerSource: 'schedule',
        queuedAt,
        deadlineAt: queuedAt + 15 * 60 * 1_000,
      });
      await store.transitionRun({
        occurrenceId: run.id,
        from: ['queued'],
        to: 'cancelled',
        at: queuedAt + 1,
      });
    }
    await assert.rejects(
      () => store.createOccurrence({
        runId: 'rrun_total_rejected',
        idempotencyKey: 'routine:total:rejected',
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: CREATED_AT + Math.floor(ROUTINE_LIMITS.totalStartsRollingDay / ROUTINE_LIMITS.startsPerRollingFifteenMinutes) * 15 * 60 * 1_000 + (ROUTINE_LIMITS.totalStartsRollingDay % ROUTINE_LIMITS.startsPerRollingFifteenMinutes),
        triggerSource: 'schedule',
        queuedAt: CREATED_AT + Math.floor(ROUTINE_LIMITS.totalStartsRollingDay / ROUTINE_LIMITS.startsPerRollingFifteenMinutes) * 15 * 60 * 1_000 + (ROUTINE_LIMITS.totalStartsRollingDay % ROUTINE_LIMITS.startsPerRollingFifteenMinutes),
        deadlineAt: CREATED_AT + Math.floor(ROUTINE_LIMITS.totalStartsRollingDay / ROUTINE_LIMITS.startsPerRollingFifteenMinutes) * 15 * 60 * 1_000 + (ROUTINE_LIMITS.totalStartsRollingDay % ROUTINE_LIMITS.startsPerRollingFifteenMinutes) + 15 * 60 * 1_000,
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_total_start_limit',
    );
  } finally {
    store.close();
  }
});

test('actual occurrence starts enforce the rolling cluster ceiling after preview reservations', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const routine = await confirmDraft(store, createDraft(), 'actual-cluster-limit');
    for (let index = 0; index < ROUTINE_LIMITS.startsPerRollingFifteenMinutes; index += 1) {
      const run = await store.createOccurrence({
        runId: `rrun_actual_cluster_${index}`,
        idempotencyKey: `routine:actual-cluster:${index}`,
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: CREATED_AT + index,
        triggerSource: 'schedule',
        queuedAt: CREATED_AT,
        deadlineAt: CREATED_AT + 15 * 60 * 1_000,
      });
      await store.transitionRun({
        occurrenceId: run.id,
        from: ['queued'],
        to: 'cancelled',
        at: CREATED_AT + 1,
      });
    }
    await assert.rejects(
      () => store.createOccurrence({
        runId: 'rrun_actual_cluster_rejected',
        idempotencyKey: 'routine:actual-cluster:rejected',
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: CREATED_AT + ROUTINE_LIMITS.startsPerRollingFifteenMinutes,
        triggerSource: 'schedule',
        queuedAt: CREATED_AT,
        deadlineAt: CREATED_AT + 15 * 60 * 1_000,
      }),
      (error: unknown) =>
        error instanceof RoutineStateError && error.code === 'routine_cluster_capacity',
    );
  } finally {
    store.close();
  }
});

test('deployment active-run ceiling rejects a fifth distinct routine', async () => {
  const store = new SqliteRoutineStore(':memory:', () => CREATED_AT);
  try {
    const routines: RoutineDefinition[] = [];
    for (let index = 0; index < 5; index += 1) {
      routines.push(await confirmDraft(
        store,
        createDraft(`routine_concurrent_${index}`, {
          nextRunAt: NEXT_RUN + index * 15 * 60 * 1_000,
          reservations: [{ windowStart: NEXT_RUN + index * 15 * 60 * 1_000, count: 1 }],
        }),
        `concurrent-${index}`,
      ));
    }
    for (let index = 0; index < 4; index += 1) {
      await store.createOccurrence({
        runId: `rrun_concurrent_${index}`,
        idempotencyKey: `routine:concurrent:${index}`,
        routineId: routines[index]!.id,
        routineVersion: routines[index]!.version,
        scheduledFor: CREATED_AT,
        triggerSource: 'run_now',
        requestedBy: 'U_MEMBER',
        queuedAt: CREATED_AT,
        deadlineAt: CREATED_AT + 15 * 60 * 1_000,
      });
    }
    await assert.rejects(
      () => store.createOccurrence({
        runId: 'rrun_concurrent_rejected',
        idempotencyKey: 'routine:concurrent:rejected',
        routineId: routines[4]!.id,
        routineVersion: routines[4]!.version,
        scheduledFor: CREATED_AT,
        triggerSource: 'run_now',
        requestedBy: 'U_MEMBER',
        queuedAt: CREATED_AT,
        deadlineAt: CREATED_AT + 15 * 60 * 1_000,
      }),
      (error: unknown) => error instanceof RoutineStateError && error.code === 'routine_concurrent_capacity',
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
    assert.equal(run.usageProvenance, 'legacy_routine');
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
      await store.beginOccurrence({
        occurrenceId: run.id, flueRunId: 'run_flue_primary', startedAt: CREATED_AT + 3,
        resolvedAccessHash: 'a'.repeat(64), resolvedAgentId: 'agent_default',
        model: 'openai/gpt-5.4', providerAuthRoute: 'openai_subscription',
        traceId: 'run_flue_primary',
      }),
      'started',
    );
    assert.equal(
      await store.beginOccurrence({ occurrenceId: run.id, flueRunId: 'run_flue_duplicate', startedAt: CREATED_AT + 4 }),
      'superseded',
    );
    assert.equal((await store.getRun(run.id))?.flueRunId, 'run_flue_primary');
    assert.equal((await store.getRun(run.id))?.resolvedAccessHash, 'a'.repeat(64));
    assert.equal((await store.getRun(run.id))?.resolvedAgentId, 'agent_default');
    assert.equal((await store.getRun(run.id))?.providerAuthRoute, 'openai_subscription');
    const startedAudit = (await store.listAuditEvents({ eventType: 'routine.occurrence_started' }))[0];
    assert.deepEqual(JSON.parse(startedAudit!.metadataJson), {
      routineId: routine.id,
      status: 'running',
      triggerSource: 'schedule',
      providerAuthRoute: 'openai_subscription',
    });
    assert.deepEqual((await store.listAdmissions(run.id)).map((item) => item.status), ['attached', 'superseded']);
    assert.equal(await store.claimDelivery({
      occurrenceId: run.id, at: CREATED_AT + 4, leaseUntil: CREATED_AT + 60_004,
    }), 'claimed');
    assert.equal(await store.claimDelivery({
      occurrenceId: run.id, at: CREATED_AT + 4, leaseUntil: CREATED_AT + 60_004,
    }), 'superseded');
    await store.recordDelivery({
      occurrenceId: run.id, outcome: 'delivered', at: CREATED_AT + 4,
      channelId: 'C_TEST', messageTs: '1785000000.000100', changeKeyHash: 'b'.repeat(64),
    });
    await store.transitionRun({
      occurrenceId: run.id, from: ['running'], to: 'succeeded', at: CREATED_AT + 5,
      model: 'anthropic/claude-sonnet-4-6', inputTokens: 10, outputTokens: 20,
      cacheReadTokens: 2, cacheWriteTokens: 1, costEstimate: 0.003,
      costUnit: 'model_registry_unit', toolCallCount: 2,
      usageLedgerOperationId: run.id, usageProvenance: 'usage_ledger',
      usageCompleteness: 'complete',
      changeKeyHash: 'b'.repeat(64), suppressedAsNoOp: false,
    });
    const completed = await store.getRun(run.id);
    assert.equal(completed?.inputTokens, 10);
    assert.equal(completed?.toolCallCount, 2);
    assert.equal(completed?.usageLedgerOperationId, run.id);
    assert.equal(completed?.usageProvenance, 'usage_ledger');
    assert.equal(completed?.usageCompleteness, 'complete');
    assert.equal(completed?.changeKeyHash, 'b'.repeat(64));
    assert.equal(completed?.deliveryStatus, 'delivered');
    assert.equal((await store.getRoutine(routine.id))?.lastChangeKeyHash, 'b'.repeat(64));
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
