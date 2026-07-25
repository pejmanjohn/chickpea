import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfMemoryStateStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import type { MemoryRpcRequest, MemoryRpcResponse } from '../src/memory/types.ts';

test('Cloudflare memory proxy forwards clone-safe requests and returns typed values', async () => {
  const calls: MemoryRpcRequest[] = [];
  const stub = {
    async memoryExecute(request: MemoryRpcRequest): Promise<StateRpcResult<MemoryRpcResponse>> {
      calls.push(request);
      return {
        ok: true,
        value: {
          kind: 'cleanup',
          actorIdsCleared: 1,
          rateWindowsDeleted: 2,
          contextsDeleted: 3,
        },
      };
    },
  } as unknown as TagStateRpc;

  const store = new CfMemoryStateStore(stub);
  assert.deepEqual(await store.cleanupRetention(), {
    actorIdsCleared: 1,
    rateWindowsDeleted: 2,
    contextsDeleted: 3,
  });
  assert.deepEqual(calls, [{ kind: 'cleanup_retention' }]);
});

test('Cloudflare memory proxy preserves typed memory conflict errors', async () => {
  const stub = {
    async memoryExecute(): Promise<StateRpcResult<MemoryRpcResponse>> {
      return {
        ok: false,
        error: {
          code: 'memory',
          message: 'Memory entry changed before this update.',
          details: {
            memoryCode: 'memory_version_conflict',
            entryId: 'mem_01',
            currentVersion: '3',
          },
        },
      };
    },
  } as unknown as TagStateRpc;

  const store = new CfMemoryStateStore(stub);
  await assert.rejects(
    () =>
      store.updateEntry({
        entryId: 'mem_01',
        expectedVersion: 2,
        description: 'Updated.',
        body: 'Updated body.',
        type: 'fact',
        actorId: 'U_MEMBER',
        actorClass: 'member',
        idempotencyKey: 'memory:slack:T_TEST:E2:0',
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'MemoryVersionConflictError' &&
      'currentVersion' in error &&
      error.currentVersion === 3,
  );
});
