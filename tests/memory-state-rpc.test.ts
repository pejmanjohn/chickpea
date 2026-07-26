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

test('Cloudflare memory proxy confirms injected conversation epochs', async () => {
  const calls: MemoryRpcRequest[] = [];
  const stub = {
    async memoryExecute(request: MemoryRpcRequest): Promise<StateRpcResult<MemoryRpcResponse>> {
      calls.push(request);
      return { ok: true, value: { kind: 'conversation_context_confirmed', confirmed: true } };
    },
  } as unknown as TagStateRpc;
  const store = new CfMemoryStateStore(stub);
  const input = {
    baseConversationKey: 'T:C:1.0',
    epoch: 2,
    selectionFingerprint: 'fingerprint',
  };
  assert.equal(await store.confirmConversationContext(input), true);
  assert.deepEqual(calls, [{ kind: 'confirm_conversation_context', input }]);
});

test('Cloudflare memory proxy distinguishes a missing import replay receipt', async () => {
  const calls: MemoryRpcRequest[] = [];
  const stub = {
    async memoryExecute(request: MemoryRpcRequest): Promise<StateRpcResult<MemoryRpcResponse>> {
      calls.push(request);
      return { ok: true, value: { kind: 'import_replay', entries: null } };
    },
  } as unknown as TagStateRpc;
  const store = new CfMemoryStateStore(stub);
  const input = {
    storeId: 'store_public_T_TEST', workspaceId: 'T_TEST', actorId: 'admin',
    archiveSha256: 'a'.repeat(64), idempotencyKey: 'admin:import:1',
  };
  assert.equal(await store.replayImport(input), undefined);
  assert.deepEqual(calls, [{ kind: 'replay_import', input }]);
});
