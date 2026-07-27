import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfRoutineStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineRpcRequest,
  type RoutineRpcResponse,
} from '../src/routines/types.ts';

const routine: RoutineDefinition = {
  id: 'routine_rpc', workspaceId: 'T_TEST', channelId: 'C_TEST', creatorUserId: 'U_MEMBER',
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
  const stub = {
    async routinesExecute(request: RoutineRpcRequest): Promise<StateRpcResult<RoutineRpcResponse>> {
      requests.push(request);
      return { ok: true, value: { kind: 'routine', routine } };
    },
  } as unknown as TagStateRpc;
  const store = new CfRoutineStore(stub);

  assert.deepEqual(await store.getRoutine(routine.id), routine);
  assert.deepEqual(requests, [{ kind: 'get_routine', routineId: routine.id }]);
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
