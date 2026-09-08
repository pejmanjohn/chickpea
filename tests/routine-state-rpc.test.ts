import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfRoutineStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineRpcRequest,
  type RoutineRpcResponse,
  type SaveRoutineInput,
} from '../src/routines/types.ts';

const routine: RoutineDefinition = {
  id: 'routine_rpc', workspaceId: 'T_TEST', channelId: 'C_TEST', creatorUserId: 'U_MEMBER',
  destination: { kind: 'channel', channelId: 'C_TEST' },
  name: 'RPC routine', description: '', taskText: 'Do the task.', triggerKind: 'schedule',
  scheduleInput: 'hourly', scheduleJson: '{"kind":"cron","expression":"0 * * * *"}',
  timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1', state: 'active',
  version: 1, nextRunAt: 1, lastScheduledAt: null, lastFinishedAt: null,
  consecutiveFailures: 0, lastChangeKeyHash: null, projectedDailyStarts: 24,
  reservationWindows: [{ windowStart: 1, count: 1 }], createdAt: 0, createdBy: 'U_MEMBER',
  updatedAt: 0, updatedBy: 'U_MEMBER', pausedAt: null, pausedBy: null, pausedReason: null,
  disabledAt: null, disabledBy: null, disabledReason: null, deletedAt: null, deletedBy: null,
};

test('Cloudflare routine proxy preserves the typed execute request and response', async () => {
  const requests: RoutineRpcRequest[] = [];
  const { destination: _legacyOmission, ...legacyRoutine } = routine;
  const stub = {
    async routinesExecute(request: RoutineRpcRequest): Promise<StateRpcResult<RoutineRpcResponse>> {
      requests.push(request);
      return {
        ok: true,
        value: { kind: 'routine', routine: legacyRoutine as unknown as RoutineDefinition },
      };
    },
  } as unknown as TagStateRpc;
  const store = new CfRoutineStore(stub);

  assert.deepEqual(await store.getRoutine(routine.id), routine);
  assert.deepEqual(await store.getRoutineByWorkId('work_rpc'), routine);
  assert.deepEqual(requests, [
    { kind: 'get_routine', routineId: routine.id },
    { kind: 'get_routine_by_work', workId: 'work_rpc' },
  ]);
});

test('Cloudflare routine proxy carries the drain count across the RPC seam', async () => {
  const requests: RoutineRpcRequest[] = [];
  const stub = {
    async routinesExecute(request: RoutineRpcRequest): Promise<StateRpcResult<RoutineRpcResponse>> {
      requests.push(request);
      return { ok: true, value: { kind: 'count', count: 2 } };
    },
  } as unknown as TagStateRpc;
  const store = new CfRoutineStore(stub);

  assert.equal(await store.countAdmittingOrRunningOccurrences(), 2);
  assert.deepEqual(requests, [{ kind: 'count_admitting_or_running_occurrences' }]);
});

test('Cloudflare routine proxy carries one-message saves across the RPC seam', async () => {
  const requests: RoutineRpcRequest[] = [];
  const stub = {
    async routinesExecute(request: RoutineRpcRequest): Promise<StateRpcResult<RoutineRpcResponse>> {
      requests.push(request);
      return { ok: true, value: { kind: 'routine', routine } };
    },
  } as unknown as TagStateRpc;
  const store = new CfRoutineStore(stub);
  const input: SaveRoutineInput = {
    actorId: 'U_MEMBER',
    actorClass: 'member',
    workspaceId: 'T_TEST',
    channelId: 'C_TEST',
    idempotencyKey: 'routine:rpc:save',
    draft: {
      action: 'create',
      routineId: routine.id,
      definition: {
        name: routine.name,
        description: routine.description,
        taskText: routine.taskText,
        triggerKind: routine.triggerKind,
        scheduleInput: routine.scheduleInput,
        scheduleJson: routine.scheduleJson,
        timezone: routine.timezone,
        outputPolicy: routine.outputPolicy,
        authorityMode: routine.authorityMode,
      },
      nextRunAt: routine.nextRunAt!,
      projectedDailyStarts: routine.projectedDailyStarts,
      reservations: routine.reservationWindows,
    },
  };

  assert.deepEqual(await store.save(input), routine);
  assert.deepEqual(requests, [{ kind: 'save', input }]);
});

test('Cloudflare routine proxy carries direct activation and recovery receipts across the RPC seam', async () => {
  const requests: RoutineRpcRequest[] = [];
  const recovery = {
    occurrenceId: 'rrun_rpc',
    claimedAt: null,
    status: 'pending' as const,
    messageTs: null,
    failureClass: 'direct_thread_unavailable' as const,
    updatedAt: 10,
  };
  const stub = {
    async routinesExecute(request: RoutineRpcRequest): Promise<StateRpcResult<RoutineRpcResponse>> {
      requests.push(request);
      if (request.kind === 'activate_direct_routine') {
        return { ok: true, value: { kind: 'routine', routine } };
      }
      if (request.kind === 'get_recovery_delivery') {
        return { ok: true, value: { kind: 'recovery_delivery', delivery: recovery } };
      }
      if (request.kind === 'claim_recovery_delivery') {
        return { ok: true, value: { kind: 'recovery_delivery_claim', outcome: 'claimed' } };
      }
      return { ok: true, value: { kind: 'recovery_delivery', delivery: { ...recovery, status: 'unknown' } } };
    },
  } as unknown as TagStateRpc;
  const store = new CfRoutineStore(stub);
  const activation = {
    routineId: routine.id,
    expectedVersion: 1,
    expectedReferenceRevision: 2,
    destinationBindingDigest: 'a'.repeat(64),
  };

  assert.deepEqual(await store.activateDirectRoutine(activation), routine);
  assert.deepEqual(await store.getRecoveryDelivery('rrun_rpc'), recovery);
  assert.deepEqual(
    await store.deferRecoveryDelivery({ occurrenceId: 'rrun_rpc', at: 9 }),
    { ...recovery, status: 'unknown' },
  );
  assert.equal(await store.claimRecoveryDelivery({ occurrenceId: 'rrun_rpc', at: 10 }), 'claimed');
  assert.equal(
    (await store.recordRecoveryDelivery({
      occurrenceId: 'rrun_rpc', outcome: 'unknown', at: 11,
    })).status,
    'unknown',
  );
  assert.deepEqual(requests, [
    { kind: 'activate_direct_routine', input: activation },
    { kind: 'get_recovery_delivery', occurrenceId: 'rrun_rpc' },
    { kind: 'defer_recovery_delivery', input: { occurrenceId: 'rrun_rpc', at: 9 } },
    { kind: 'claim_recovery_delivery', input: { occurrenceId: 'rrun_rpc', at: 10 } },
    {
      kind: 'record_recovery_delivery',
      input: { occurrenceId: 'rrun_rpc', outcome: 'unknown', at: 11 },
    },
  ]);
});

test('Cloudflare routine proxy carries bounded admin routine pages across the RPC seam', async () => {
  const requests: RoutineRpcRequest[] = [];
  const stub = {
    async routinesExecute(request: RoutineRpcRequest): Promise<StateRpcResult<RoutineRpcResponse>> {
      requests.push(request);
      return { ok: true, value: { kind: 'admin_routine_page', page: { routines: [routine], nextCursor: 2 } } };
    },
  } as unknown as TagStateRpc;
  const store = new CfRoutineStore(stub);
  const input = { workspaceId: 'T_TEST', state: 'completed' as const, runStatus: 'skipped' as const, cursor: 0, limit: 2 };

  assert.deepEqual(await store.listAdminRoutinePage(input), { routines: [routine], nextCursor: 2 });
  assert.deepEqual(requests, [{ kind: 'list_admin_routine_page', input }]);
});

test('Cloudflare routine proxy carries maintenance results across the RPC seam', async () => {
  const requests: RoutineRpcRequest[] = [];
  const result = {
    confirmationsPurged: 1,
    reservationsPurged: 2,
    scheduleActionsDeleted: 3,
    recoveryNoticesReconciled: 4,
    deliveryLeasesReconciled: 5,
    deadlineRunsReconciled: 6,
    runsDeleted: 7,
    auditEventsDeleted: 8,
  };
  const stub = {
    async routinesExecute(request: RoutineRpcRequest): Promise<StateRpcResult<RoutineRpcResponse>> {
      requests.push(request);
      return { ok: true, value: { kind: 'maintenance', result } };
    },
  } as unknown as TagStateRpc;
  const store = new CfRoutineStore(stub);

  assert.deepEqual(await store.cleanupRetention(), result);
  assert.deepEqual(requests, [{ kind: 'cleanup_retention' }]);
});

test('Cloudflare routine proxy reconstructs stable domain errors', async () => {
  const stub = {
    async routinesExecute(): Promise<StateRpcResult<RoutineRpcResponse>> {
      return {
        ok: false,
        error: {
          code: 'routine',
          message: 'Routine changed. Refresh and try again.',
          details: {
            routineCode: 'routine_version_conflict',
            routineId: 'routine_rpc',
            currentVersion: '2',
          },
        },
      };
    },
  } as unknown as TagStateRpc;
  const store = new CfRoutineStore(stub);

  await assert.rejects(
    () => store.getRoutine('routine_rpc'),
    (error: unknown) =>
      error instanceof RoutineStateError &&
      error.code === 'routine_version_conflict' &&
      error.details.currentVersion === '2',
  );
});
