import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { createRoutineAdminApi } from '../src/admin/routines-api.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { RoutineService } from '../src/routines/service.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinitionContent } from '../src/routines/types.ts';

const NOW = Date.UTC(2026, 6, 27, 12);
const TOKEN = 'admin-scheduled-work-token';

function definition(): RoutineDefinitionContent {
  return {
    name: 'Approval chaser',
    description: 'Tracks pending approvals.',
    taskText: 'Check pending approvals, update the tracker, and post changes.',
    triggerKind: 'schedule',
    scheduleInput: '0 9 * * 1-5',
    scheduleJson: '{"version":1,"kind":"cron","expression":"0 9 * * 1-5"}',
    timezone: 'America/Los_Angeles',
    outputPolicy: 'post_on_change',
    authorityMode: 'live_channel_v1',
  };
}

async function seededRoutine(store: SqliteRoutineStore, now: () => number = () => NOW) {
  const service = new RoutineService(store, {
    now, routineId: () => 'routine_admin',
  });
  return service.save({
    action: 'create', actorId: 'U_CREATOR', workspaceId: 'T_TEST', channelId: 'C_TEST',
    definition: definition(), nextRunAt: NOW + 3_600_000, projectedDailyStarts: 5,
    reservations: [{ windowStart: NOW + 3_600_000, count: 1 }],
    provenance: {
      sourceKind: 'slack_request', requestText: `Every weekday, ${definition().taskText}`,
      eventId: 'Ev_admin_seed', messageTs: '1785000000.000100', threadTs: '1785000000.000100',
      authoritySource: 'current_request',
    },
  }, 'seed-routine-admin');
}

async function seedCompletedOneTimeRoutine(store: SqliteRoutineStore, routineId: string) {
  const scheduledFor = NOW - 60 * 60_000;
  await store.save({
    actorId: 'U_CREATOR', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
    draft: {
      action: 'create', routineId,
      definition: {
        ...definition(), name: `Completed ${routineId}`, triggerKind: 'once',
        scheduleInput: '2026-07-27T11:00',
        scheduleJson: JSON.stringify({
          version: 1, kind: 'once', localDateTime: '2026-07-27T11:00', at: scheduledFor,
        }),
      },
      nextRunAt: scheduledFor, projectedDailyStarts: 0,
      reservations: [{ windowStart: scheduledFor, count: 1 }],
    },
    idempotencyKey: `seed-completed:${routineId}`,
  });
}

test('Scheduled Work APIs are admin-authenticated, body-safe, filterable, and controllable', async () => {
  const routines = new SqliteRoutineStore(':memory:');
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const routine = await seededRoutine(routines, Date.now);
    await routines.createOccurrence({
      runId: 'rrun_admin', idempotencyKey: 'run-admin', routineId: routine.id,
      routineVersion: routine.version, scheduledFor: NOW, triggerSource: 'run_now',
      requestedBy: 'U_MEMBER', queuedAt: NOW, deadlineAt: NOW + 900_000,
    });
    const app = new Hono();
    app.route('/', createAdminRoutes({
      store: config, settings, routines, adminToken: TOKEN, knownProviders: new Set(['local-stub']),
    }));

    const unauthorized = await app.request('/admin/api/audit/scheduled_work/routines');
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const list = await app.request(
      '/admin/api/audit/scheduled_work/routines?workspaceId=T_TEST&state=active&limit=10',
      { headers },
    );
    assert.equal(list.status, 200);
    const listBody = await list.json() as Record<string, any>;
    assert.equal(listBody.routines.length, 1);
    assert.equal(listBody.routines[0].id, routine.id);
    assert.equal(listBody.routines[0].triggerKind, 'schedule');
    assert.equal(listBody.routines[0].taskText, undefined);
    assert.equal(listBody.capability.reason, 'unsupported_target');
    assert.equal(listBody.limits.concurrentDeploymentRuns, 4);
    assert.equal(listBody.limits.scheduledStartsPerRoutinePerDay, 300);
    assert.equal(listBody.limits.scheduledStartsPerDay, 600);
    assert.equal(listBody.limits.totalStartsRollingDay, 610);
    assert.equal(listBody.limits.retentionDays, 365);
    const completedList = await app.request(
      '/admin/api/audit/scheduled_work/routines?state=completed',
      { headers },
    );
    assert.equal(completedList.status, 200);

    const detail = await app.request(
      `/admin/api/audit/scheduled_work/routines/${routine.id}`,
      { headers },
    );
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as Record<string, any>;
    assert.equal(detailBody.routine.taskText, definition().taskText);
    assert.equal(
      detailBody.revisions[0].provenance.requestText,
      `Every weekday, ${definition().taskText}`,
    );
    assert.equal(detailBody.runs[0].id, 'rrun_admin');
    assert.ok(detailBody.events.some((event: Record<string, unknown>) =>
      event.eventType === 'routine.occurrence_created'));
    const runWire = JSON.stringify(detailBody.runs[0]);
    assert.doesNotMatch(runWire, /taskText|revision|toolOutput|prompt/i);

    const paused = await app.request(
      `/admin/api/audit/scheduled_work/routines/${routine.id}/control`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'pause-one' },
        body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
      },
    );
    assert.equal(paused.status, 200);
    assert.equal(((await paused.json()) as Record<string, any>).routine.state, 'paused');
    const pausedDetail = await app.request(
      `/admin/api/audit/scheduled_work/routines/${routine.id}`,
      { headers },
    );
    const pausedDetailBody = await pausedDetail.json() as Record<string, any>;
    assert.equal(
      pausedDetailBody.revisions[1].provenance.requestText,
      `Every weekday, ${definition().taskText}`,
    );

    const events = await app.request('/admin/api/audit/scheduled_work/events?channelId=C_TEST', { headers });
    assert.equal(events.status, 200, await events.clone().text());
    assert.ok(((await events.json()) as Record<string, any>).events.length >= 2);

    const deletion = await app.request(
      `/admin/api/audit/scheduled_work/routines/${routine.id}/control`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'delete-one' },
        body: JSON.stringify({ action: 'delete', expectedVersion: 2, acknowledgeIrreversible: true }),
      },
    );
    assert.equal(deletion.status, 200, await deletion.clone().text());
    assert.equal(((await deletion.json()) as Record<string, any>).irreversible, true);
    assert.notEqual((await routines.getRoutine(routine.id))?.deletedAt, null);
  } finally {
    routines.close();
    config.close();
    settings.close();
  }
});

test('Scheduled Work list pages completed one-time definitions and filters by retained run status', async () => {
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    await Promise.all([
      seedCompletedOneTimeRoutine(routines, 'routine_completed_0'),
      seedCompletedOneTimeRoutine(routines, 'routine_completed_1'),
      seedCompletedOneTimeRoutine(routines, 'routine_completed_2'),
    ]);
    await routines.claimDueSchedules({ now: NOW, owner: 'admin-pagination', limit: 25 });
    const api = createRoutineAdminApi({ store: () => routines, now: () => NOW });

    const first = await api.request('/audit/scheduled_work/routines?state=completed&limit=2');
    assert.equal(first.status, 200);
    const firstBody = await first.json() as Record<string, any>;
    assert.equal(firstBody.routines.length, 2);
    assert.equal(firstBody.nextCursor, '2');
    assert.equal(firstBody.routines[0].state, 'completed');
    assert.equal(firstBody.routines[0].triggerKind, 'once');

    const second = await api.request(`/audit/scheduled_work/routines?state=completed&limit=2&cursor=${firstBody.nextCursor}`);
    const secondBody = await second.json() as Record<string, any>;
    assert.equal(secondBody.routines.length, 1);
    assert.equal(secondBody.nextCursor, null);

    const byStatus = await api.request('/audit/scheduled_work/routines?state=completed&status=skipped&limit=10');
    const byStatusBody = await byStatus.json() as Record<string, any>;
    assert.equal(byStatusBody.routines.length, 3);
    const detail = await api.request(
      `/audit/scheduled_work/routines/${firstBody.routines[0].id}`,
    );
    const detailBody = await detail.json() as Record<string, any>;
    assert.equal(detailBody.routine.state, 'completed');
    assert.equal(detailBody.routine.taskText, definition().taskText);
  } finally {
    routines.close();
  }
});

test('cookie-style unsafe Scheduled Work controls require same-origin and idempotency', async () => {
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const routine = await seededRoutine(routines);
    const api = createRoutineAdminApi({ store: () => routines, now: () => NOW });
    const crossOrigin = await api.request(
      `https://chickpea.test/audit/scheduled_work/routines/${routine.id}/control`,
      {
        method: 'POST',
        headers: { cookie: 'flue_admin=session', origin: 'https://evil.test', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
      },
    );
    assert.equal(crossOrigin.status, 403);
    const missingKey = await api.request(
      `https://chickpea.test/audit/scheduled_work/routines/${routine.id}/control`,
      {
        method: 'POST',
        headers: { cookie: 'flue_admin=session', origin: 'https://chickpea.test', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
      },
    );
    assert.equal(missingKey.status, 400);
  } finally {
    routines.close();
  }
});
