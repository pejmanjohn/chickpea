import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { createRoutineAdminApi } from '../src/admin/routines-api.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { RoutineService } from '../src/routines/service.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinitionContent } from '../src/routines/types.ts';
import type { SlackTransport } from '../src/slack/transport/types.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import type { SourceVisibility } from '../src/work/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

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

async function seededRoutine(
  store: SqliteRoutineStore,
  now: () => number = () => NOW,
  sourceVisibility: SourceVisibility = 'public',
) {
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
    sourceVisibility,
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
    sourceVisibility: 'public',
  });
}

async function seedActiveRoutine(store: SqliteRoutineStore, routineId: string, nextRunAt: number) {
  await store.save({
    actorId: 'U_CREATOR', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
    draft: {
      action: 'create', routineId,
      definition: { ...definition(), name: routineId },
      nextRunAt, projectedDailyStarts: 5,
      reservations: [{ windowStart: nextRunAt, count: 1 }],
    },
    idempotencyKey: `seed-active:${routineId}`,
    sourceVisibility: 'public',
  });
}

test('Scheduled Work APIs are admin-authenticated, body-safe, filterable, and controllable', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-routine-')), 'state.db');
  const routines = new SqliteRoutineStore(path);
  const config = new SqliteConfigStore(path, { agents: [] });
  const settings = new SqliteSettingsStore(path);
  const work = new SqliteWorkStore(path);
  try {
    const routine = await seededRoutine(routines, Date.now);
    await config.createAgent({
      id: 'agent_routine_admin',
      revision: 1,
      name: 'Routine admin profile',
      instructions: 'Handle scheduled work.',
      enabled: true,
      model: 'local-stub/routine-admin',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    await config.putChannel({
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      label: 'routine-admin-lab',
      lifecycle: 'active',
    });
    await config.putAgentChannelGrant({
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      agentId: 'agent_routine_admin',
      status: 'active',
      createdByMembershipId: 'membership_owner',
    });
    await routines.createOccurrence({
      runId: 'rrun_admin', idempotencyKey: 'run-admin', routineId: routine.id,
      routineVersion: routine.version, scheduledFor: NOW, triggerSource: 'run_now',
      requestedBy: 'U_MEMBER', queuedAt: NOW, deadlineAt: NOW + 900_000,
    });
    const app = new Hono();
    app.route('/', createAdminRoutes({
      store: config, settings, routines, work, ...testAdminAuthority(TOKEN),
      knownProviders: new Set(['local-stub']),
    }));

    const unauthorized = await app.request('/admin/api/audit/scheduled_work/routines');
    assert.equal(unauthorized.status, 401);
    const headers = testAdminHeaders(TOKEN, { 'content-type': 'application/json' });
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
    const currentList = await app.request(
      '/admin/api/audit/scheduled_work/routines?workspaceId=T_TEST&state=current&limit=10',
      { headers },
    );
    assert.equal(currentList.status, 200);
    assert.equal(((await currentList.json()) as Record<string, any>).routines[0].state, 'active');
    const allList = await app.request(
      '/admin/api/audit/scheduled_work/routines?workspaceId=T_TEST&state=all&limit=10',
      { headers },
    );
    assert.equal(allList.status, 200);
    assert.equal(((await allList.json()) as Record<string, any>).routines.length, 1);
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
    assert.equal(detailBody.runs[0].canonicalRunId, null);
    assert.equal(Object.hasOwn(detailBody.runs[0], 'sessionDeepLink'), false);
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
    const pausedCurrentList = await app.request(
      '/admin/api/audit/scheduled_work/routines?workspaceId=T_TEST&state=current&limit=10',
      { headers },
    );
    assert.equal(pausedCurrentList.status, 200);
    assert.equal(((await pausedCurrentList.json()) as Record<string, any>).routines[0].state, 'paused');
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
    const allAfterDeletion = await app.request(
      '/admin/api/audit/scheduled_work/routines?workspaceId=T_TEST&state=all&limit=10',
      { headers },
    );
    assert.equal(((await allAfterDeletion.json()) as Record<string, any>).routines.length, 0);
  } finally {
    routines.close();
    config.close();
    settings.close();
    work.close();
  }
});

test('Scheduled Work list pages completed one-time definitions and filters by retained run status', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-routine-page-')), 'state.db');
  const routines = new SqliteRoutineStore(path, () => NOW);
  const work = new SqliteWorkStore(path, { now: () => NOW });
  try {
    await Promise.all([
      seedCompletedOneTimeRoutine(routines, 'routine_completed_0'),
      seedCompletedOneTimeRoutine(routines, 'routine_completed_1'),
      seedCompletedOneTimeRoutine(routines, 'routine_completed_2'),
    ]);
    await routines.claimDueSchedules({ now: NOW, owner: 'admin-pagination', limit: 25 });
    const api = createRoutineAdminApi({ store: () => routines, work: () => work, now: () => NOW });

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
    work.close();
  }
});

test('Scheduled Work Current filter orders active schedules by next run before paused schedules', async () => {
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    await Promise.all([
      seedActiveRoutine(routines, 'routine_active_later', NOW + 2 * 3_600_000),
      seedActiveRoutine(routines, 'routine_paused', NOW + 30 * 60_000),
      seedActiveRoutine(routines, 'routine_active_soon', NOW + 3_600_000),
    ]);
    await routines.control({
      action: 'pause', routineId: 'routine_paused', expectedVersion: 1,
      actorId: 'U_CREATOR', actorClass: 'member', idempotencyKey: 'pause-current-ordering',
    });

    const current = await routines.listAdminRoutinePage({ state: 'current', limit: 10 });
    assert.deepEqual(
      current.routines.map((routine) => routine.id),
      ['routine_active_soon', 'routine_active_later', 'routine_paused'],
    );
  } finally {
    routines.close();
  }
});

test('Scheduled Work structurally redacts private and unlinked definition content before serialization', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-routine-private-')), 'state.db');
  const routines = new SqliteRoutineStore(path, () => NOW);
  const work = new SqliteWorkStore(path, { now: () => NOW });
  const canary = 'PRIVATE_ROUTINE_CANARY_<script>alert(71)</script>';
  try {
    const service = new RoutineService(routines, {
      now: () => NOW,
      routineId: () => 'routine_private_admin',
    });
    const routine = await service.save({
      action: 'create',
      actorId: 'U_PRIVATE',
      workspaceId: 'T_PRIVATE',
      channelId: 'C_PRIVATE',
      definition: {
        ...definition(),
        name: canary,
        description: `description ${canary}`,
        taskText: `task ${canary}`,
      },
      nextRunAt: NOW + 3_600_000,
      projectedDailyStarts: 5,
      reservations: [{ windowStart: NOW + 3_600_000, count: 1 }],
      provenance: {
        sourceKind: 'slack_request',
        requestText: `Please run task ${canary}`,
        eventId: 'Ev_private_seed',
        messageTs: '1785000000.000100',
        threadTs: '1785000000.000100',
        authoritySource: 'current_request',
      },
      sourceVisibility: 'private',
    }, 'seed-private-routine');
    const api = createRoutineAdminApi({ store: () => routines, work: () => work, now: () => NOW });

    const listText = await (await api.request('/audit/scheduled_work/routines')).text();
    assert.doesNotMatch(listText, /PRIVATE_ROUTINE_CANARY|alert\(71\)/);
    const list = JSON.parse(listText) as Record<string, any>;
    assert.equal(list.routines[0].name, null);
    assert.equal(list.routines[0].description, null);
    assert.equal(list.routines[0].contentAccess, 'authorization_unknown');

    const detailText = await (await api.request(
      `/audit/scheduled_work/routines/${routine.id}`,
    )).text();
    assert.doesNotMatch(detailText, /PRIVATE_ROUTINE_CANARY|alert\(71\)/);
    const detail = JSON.parse(detailText) as Record<string, any>;
    assert.equal(detail.projection, 'redacted');
    assert.equal(detail.routine.taskText, null);
    assert.equal(detail.revisions[0].definition, null);
    assert.equal(detail.revisions[0].provenance, null);

    const unlinked = createRoutineAdminApi({ store: () => routines, now: () => NOW });
    const unlinkedText = await (await unlinked.request(
      `/audit/scheduled_work/routines/${routine.id}`,
    )).text();
    assert.doesNotMatch(unlinkedText, /PRIVATE_ROUTINE_CANARY|alert\(71\)/);
    const unlinkedDetail = JSON.parse(unlinkedText) as Record<string, any>;
    assert.equal(unlinkedDetail.projection, 'redacted');
    assert.equal(unlinkedDetail.routine.contentAccess, 'authorization_unknown');
  } finally {
    routines.close();
    work.close();
  }
});

test('private schedule projections are readable only to proven Channel members across global and Agent APIs', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-routine-private-member-')), 'state.db');
  const routines = new SqliteRoutineStore(path);
  const work = new SqliteWorkStore(path);
  const config = new SqliteConfigStore(path, { agents: [] });
  const settings = new SqliteSettingsStore(path);
  const canary = 'PRIVATE_MEMBER_ROUTINE_CANARY';
  const identity = {
    getMembership: async (membershipId: string) => ({
      id: membershipId,
      organizationId: 'org_oss',
      userId: membershipId === 'membership_member' ? 'user_member' : 'user_nonmember',
      role: 'owner',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }),
    getUser: async (userId: string) => ({
      id: userId,
      slackTeamId: 'T_TEST',
      slackUserId: userId === 'user_member' ? 'U_MEMBER' : 'U_NONMEMBER',
      displayName: userId,
      contactEmail: null,
      createdAt: 1,
      updatedAt: 1,
    }),
    listMemberships: async () => [],
    recordAuthAudit: async () => undefined,
  } as unknown as IdentityStore;
  const principal = (member: boolean): AuthPrincipal => ({
    userId: member ? 'user_member' : 'user_nonmember',
    membershipId: member ? 'membership_member' : 'membership_nonmember',
    organizationId: 'org_oss',
    role: 'owner',
    authenticatorKind: 'test_slack_session',
    credentialId: member ? 'session_member' : 'session_nonmember',
    correlationId: member ? 'request_member' : 'request_nonmember',
    machine: false,
  });
  const transport = (member: boolean) => ({
    mode: 'direct',
    listMemberChannels: async () => new Set(member ? ['C_TEST'] : []),
  }) as unknown as SlackTransport;
  try {
    const nextRunAt = Date.now() + 3_600_000;
    const routine = await new RoutineService(routines, {
      now: Date.now,
      routineId: () => 'routine_private_member',
    }).save({
      action: 'create',
      actorId: 'U_CREATOR',
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      definition: {
        ...definition(),
        name: canary,
        description: `description ${canary}`,
        taskText: `task ${canary}`,
      },
      nextRunAt,
      projectedDailyStarts: 5,
      reservations: [{ windowStart: nextRunAt, count: 1 }],
      sourceVisibility: 'private',
    }, 'seed-private-member-routine');
    const agent = await config.createAgent({
      id: 'agent_private_schedule',
      name: 'Private schedule Agent',
      instructions: 'Run private scheduled work.',
      enabled: true,
      lifecycle: 'active',
      creatorMembershipId: 'membership_member',
      editPolicy: 'all_workspace_members',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    await config.putChannel({
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      label: 'private-schedule-lab',
      lifecycle: 'active',
    });
    await config.putAgentScheduleReference({
      scheduleId: routine.id,
      agentId: agent.id,
      workspaceId: routine.workspaceId,
      channelId: routine.channelId,
      createdByMembershipId: 'membership_member',
      runsAsMembershipId: 'membership_member',
      authorityReceiptId: 'receipt_private_member',
      requiredConnectionAccountIds: [],
      state: 'active',
    });
    const appFor = (member: boolean, scheduling = true) => createAdminRoutes({
      store: config,
      settings,
      routines,
      work,
      slackTransport: transport(member),
      routineCapability: () => scheduling
        ? { target: 'cloudflare', available: true, enabled: true, reason: 'enabled' }
        : { target: 'node', available: false, enabled: false, reason: 'unsupported_target' },
      ...testAdminAuthority(TOKEN, undefined, identity, principal(member)),
    });
    const requestBoth = async (member: boolean) => {
      const app = appFor(member);
      const headers = testAdminHeaders(TOKEN);
      const [globalResponse, agentResponse] = await Promise.all([
        app.request('http://localhost/admin/api/audit/scheduled_work/routines', { headers }),
        app.request(`http://localhost/admin/api/agents/${agent.id}/schedules`, { headers }),
      ]);
      assert.equal(globalResponse.status, 200, await globalResponse.clone().text());
      assert.equal(agentResponse.status, 200, await agentResponse.clone().text());
      const globalBody = await globalResponse.json() as Record<string, any>;
      const agentBody = await agentResponse.json() as Record<string, any>;
      return {
        global: globalBody.routines.find((entry: Record<string, any>) => entry.id === routine.id),
        agent: agentBody.schedules.find((entry: Record<string, any>) => entry.id === routine.id),
      };
    };

    const memberView = await requestBoth(true);
    assert.equal(memberView.global.name, canary);
    assert.equal(memberView.agent.name, canary);
    assert.equal(memberView.global.contentAccess, 'private_member');
    assert.equal(memberView.agent.contentAccess, 'private_member');
    assert.equal(memberView.agent.channelLabel, 'private-schedule-lab');
    assert.deepEqual(memberView.agent.actions, { pause: true, resume: false, delete: true });

    const nonmemberView = await requestBoth(false);
    assert.equal(nonmemberView.global.name, null);
    assert.equal(nonmemberView.agent.name, null);
    assert.equal(nonmemberView.global.contentAccess, 'private_nonmember');
    assert.equal(nonmemberView.agent.contentAccess, 'private_nonmember');
    assert.equal(nonmemberView.agent.channelLabel, null);
    assert.deepEqual(nonmemberView.agent.actions, { pause: false, resume: false, delete: false });
    assert.doesNotMatch(JSON.stringify(nonmemberView), /PRIVATE_MEMBER_ROUTINE_CANARY/);

    const controlUrl = `http://localhost/admin/api/agents/${agent.id}/schedules/${routine.id}/control`;
    const controlHeaders = (key: string) => testAdminHeaders(TOKEN, {
      'content-type': 'application/json',
      'idempotency-key': key,
    });
    const crossOrigin = await appFor(true).request(controlUrl, {
      method: 'POST',
      headers: {
        ...controlHeaders('cross-origin-pause'),
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
    });
    assert.equal(crossOrigin.status, 403);
    const missingIdempotency = await appFor(true).request(controlUrl, {
      method: 'POST',
      headers: testAdminHeaders(TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
    });
    assert.equal(missingIdempotency.status, 400);
    const deniedPause = await appFor(false).request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('nonmember-pause'),
      body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
    });
    assert.equal(deniedPause.status, 403);
    assert.equal((await routines.getRoutine(routine.id))?.version, 1);

    const memberApp = appFor(true);
    const paused = await memberApp.request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('member-pause'),
      body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
    });
    assert.equal(paused.status, 200, await paused.clone().text());
    assert.deepEqual((await paused.json() as Record<string, any>).schedule, {
      id: routine.id,
      status: 'paused',
      version: 2,
    });
    const replayedPause = await memberApp.request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('member-pause'),
      body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
    });
    assert.equal(replayedPause.status, 200, await replayedPause.clone().text());
    assert.equal((await replayedPause.json() as Record<string, any>).schedule.version, 2);
    const secondRoutine = await new RoutineService(routines, {
      now: Date.now,
      routineId: () => 'routine_private_member_second',
    }).save({
      action: 'create',
      actorId: 'U_CREATOR',
      workspaceId: 'T_TEST',
      channelId: 'C_TEST',
      definition: { ...definition(), name: 'Second private member routine' },
      nextRunAt: nextRunAt + 60_000,
      projectedDailyStarts: 5,
      reservations: [{ windowStart: nextRunAt + 60_000, count: 1 }],
      sourceVisibility: 'private',
    }, 'seed-private-member-routine-second');
    await config.putAgentScheduleReference({
      scheduleId: secondRoutine.id,
      agentId: agent.id,
      workspaceId: secondRoutine.workspaceId,
      channelId: secondRoutine.channelId,
      createdByMembershipId: 'membership_member',
      runsAsMembershipId: 'membership_member',
      authorityReceiptId: 'receipt_private_member_second',
      requiredConnectionAccountIds: [],
      state: 'active',
    });
    const secondPause = await memberApp.request(
      `http://localhost/admin/api/agents/${agent.id}/schedules/${secondRoutine.id}/control`,
      {
        method: 'POST',
        headers: controlHeaders('member-pause'),
        body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
      },
    );
    assert.equal(secondPause.status, 200, await secondPause.clone().text());
    assert.deepEqual((await secondPause.json() as Record<string, any>).schedule, {
      id: secondRoutine.id,
      status: 'paused',
      version: 2,
    });
    const secondDelete = await memberApp.request(
      `http://localhost/admin/api/agents/${agent.id}/schedules/${secondRoutine.id}/control`,
      {
        method: 'POST',
        headers: controlHeaders('cleanup-second-routine'),
        body: JSON.stringify({
          action: 'delete', expectedVersion: 2, acknowledgeIrreversible: true,
        }),
      },
    );
    assert.equal(secondDelete.status, 200, await secondDelete.clone().text());
    assert.equal((await routines.getRoutine(routine.id))?.pausedReason, 'admin_control');
    const pausedView = await requestBoth(true);
    assert.equal(pausedView.global.name, canary);
    assert.equal(pausedView.global.state, 'paused');
    assert.equal(pausedView.agent.name, canary);
    assert.equal(pausedView.agent.status, 'paused');
    assert.deepEqual(pausedView.agent.actions, { pause: false, resume: true, delete: true });

    const activeReference = (await config.getAgentScheduleReference(routine.id))!;
    const attentionReference = await config.putAgentScheduleReference({
      ...activeReference,
      state: 'needs_attention',
    }, activeReference.revision);
    const attentionView = await requestBoth(true);
    assert.equal(attentionView.agent.status, 'needs_attention');
    assert.deepEqual(attentionView.agent.actions, { pause: false, resume: false, delete: true });
    const blockedAttentionResume = await memberApp.request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('attention-resume'),
      body: JSON.stringify({ action: 'resume', expectedVersion: 2 }),
    });
    assert.equal(blockedAttentionResume.status, 409);
    assert.equal((await blockedAttentionResume.json() as Record<string, any>).error, 'routine_action_unavailable');
    assert.equal((await routines.getRoutine(routine.id))?.state, 'paused');
    assert.equal((await routines.getRoutine(routine.id))?.version, 2);
    await config.putAgentScheduleReference({
      ...attentionReference,
      state: 'active',
    }, attentionReference.revision);

    const unsupportedResume = await appFor(true, false).request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('unsupported-resume'),
      body: JSON.stringify({ action: 'resume', expectedVersion: 2 }),
    });
    assert.equal(unsupportedResume.status, 400);
    assert.equal(
      (await unsupportedResume.json() as Record<string, any>).error,
      'routines_unavailable_on_target',
    );
    assert.equal((await routines.getRoutine(routine.id))?.version, 2);

    const staleResume = await memberApp.request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('stale-resume'),
      body: JSON.stringify({ action: 'resume', expectedVersion: 1 }),
    });
    assert.equal(staleResume.status, 409);
    assert.equal((await routines.getRoutine(routine.id))?.version, 2);
    const resumed = await memberApp.request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('member-resume'),
      body: JSON.stringify({ action: 'resume', expectedVersion: 2 }),
    });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal((await resumed.json() as Record<string, any>).schedule.status, 'active');
    const resumedView = await requestBoth(true);
    assert.equal(resumedView.global.name, canary);
    assert.equal(resumedView.agent.name, canary);
    assert.equal(resumedView.agent.status, 'active');

    const otherAgent = await config.createAgent({
      id: 'agent_other_private_schedule',
      name: 'Other private schedule Agent',
      instructions: 'Own other scheduled work.',
      enabled: true,
      lifecycle: 'active',
      creatorMembershipId: 'membership_member',
      editPolicy: 'all_workspace_members',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const wrongAgent = await memberApp.request(
      `http://localhost/admin/api/agents/${otherAgent.id}/schedules/${routine.id}/control`,
      {
        method: 'POST',
        headers: controlHeaders('wrong-agent-pause'),
        body: JSON.stringify({ action: 'pause', expectedVersion: 3 }),
      },
    );
    assert.equal(wrongAgent.status, 404);

    const deleted = await memberApp.request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('member-delete'),
      body: JSON.stringify({
        action: 'delete',
        expectedVersion: 3,
        acknowledgeIrreversible: true,
      }),
    });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.deepEqual((await deleted.json() as Record<string, any>).schedule, {
      id: routine.id,
      status: 'deleted',
      version: 4,
    });
    const replayedDelete = await memberApp.request(controlUrl, {
      method: 'POST',
      headers: controlHeaders('member-delete'),
      body: JSON.stringify({
        action: 'delete',
        expectedVersion: 3,
        acknowledgeIrreversible: true,
      }),
    });
    assert.equal(replayedDelete.status, 200, await replayedDelete.clone().text());
    assert.equal((await replayedDelete.json() as Record<string, any>).schedule.version, 4);
    const tombstone = await routines.getRoutine(routine.id);
    assert.ok(tombstone?.deletedAt);
    assert.equal(tombstone?.name, '');
    assert.equal(tombstone?.description, '');
    assert.equal(tombstone?.taskText, '');
    assert.equal((await config.getAgentScheduleReference(routine.id))?.state, 'archived');
    const currentSchedules = await memberApp.request(
      `http://localhost/admin/api/agents/${agent.id}/schedules`,
      { headers: testAdminHeaders(TOKEN) },
    );
    assert.deepEqual((await currentSchedules.json() as Record<string, any>).schedules, []);
    assert.doesNotMatch(
      JSON.stringify(await routines.listAuditEvents({ subjectId: routine.id, limit: 100 })),
      /PRIVATE_MEMBER_ROUTINE_CANARY/,
    );
  } finally {
    routines.close();
    work.close();
    config.close();
    settings.close();
  }
});

test('private schedule authorization fails closed with one Slack membership lookup per request', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-routine-private-failure-')), 'state.db');
  const routines = new SqliteRoutineStore(path, () => NOW);
  const work = new SqliteWorkStore(path, { now: () => NOW });
  const config = new SqliteConfigStore(path, { agents: [] });
  const settings = new SqliteSettingsStore(path);
  let membershipCalls = 0;
  const sourceIdentity = {
    getMembership: async () => ({
      id: 'membership_member', organizationId: 'org_oss', userId: 'user_member',
      role: 'owner', status: 'active', createdAt: 1, updatedAt: 1,
    }),
    getUser: async () => ({
      id: 'user_member', slackTeamId: 'T_TEST', slackUserId: 'U_MEMBER',
      displayName: 'Member', contactEmail: null, createdAt: 1, updatedAt: 1,
    }),
    recordAuthAudit: async () => undefined,
  } as unknown as IdentityStore;
  const owner: AuthPrincipal = {
    userId: 'user_member', membershipId: 'membership_member', organizationId: 'org_oss',
    role: 'owner', authenticatorKind: 'test_slack_session', credentialId: 'session_member',
    correlationId: 'request_member', machine: false,
  };
  try {
    for (const suffix of ['one', 'two']) {
      await routines.save({
        actorId: 'U_CREATOR', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
        draft: {
          action: 'create', routineId: `routine_private_failure_${suffix}`,
          definition: { ...definition(), name: `PRIVATE_FAILURE_${suffix}` },
          nextRunAt: NOW + 3_600_000,
          projectedDailyStarts: 5,
          reservations: [{ windowStart: NOW + 3_600_000, count: 1 }],
        },
        idempotencyKey: `seed-private-failure-${suffix}`,
        sourceVisibility: 'private',
      });
    }
    const transport = {
      mode: 'direct',
      listMemberChannels: async () => {
        membershipCalls += 1;
        throw new Error('rate_limited');
      },
    } as unknown as SlackTransport;
    const app = createAdminRoutes({
      store: config,
      settings,
      routines,
      work,
      slackTransport: transport,
      ...testAdminAuthority(TOKEN, undefined, sourceIdentity, owner),
    });
    const response = await app.request(
      'http://localhost/admin/api/audit/scheduled_work/routines',
      { headers: testAdminHeaders(TOKEN) },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as Record<string, any>;
    assert.equal(body.routines.length, 2);
    assert.equal(membershipCalls, 1);
    assert.deepEqual(
      body.routines.map((routine: Record<string, any>) => [routine.name, routine.contentAccess]),
      [[null, 'authorization_unknown'], [null, 'authorization_unknown']],
    );
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_FAILURE_/);
  } finally {
    routines.close();
    work.close();
    config.close();
    settings.close();
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
