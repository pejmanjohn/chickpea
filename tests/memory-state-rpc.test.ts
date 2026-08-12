import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfMemoryStateStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import {
  MemoryRateLimitError,
  type MemoryRpcRequest,
  type MemoryRpcResponse,
} from '../src/memory/types.ts';

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
          forgetChallengesDeleted: 4,
        },
      };
    },
  } as unknown as TagStateRpc;

  const store = new CfMemoryStateStore(stub);
  assert.deepEqual(await store.cleanupRetention(), {
    actorIdsCleared: 1,
    rateWindowsDeleted: 2,
    contextsDeleted: 3,
    forgetChallengesDeleted: 4,
  });
  assert.deepEqual(calls, [{ kind: 'cleanup_retention' }]);
});

test('Cloudflare memory proxy forwards owner-native lifecycle calls', async () => {
  const calls: MemoryRpcRequest[] = [];
  const descriptor = {
    storeId: 'memory_owner_agent_T_TEST_agent_ops', workspaceId: 'T_TEST',
    ownerKind: 'agent' as const, ownerId: 'agent_ops', lifecycle: 'active' as const,
    resetEpoch: 1, createdAt: 100, sealedAt: null, sealedReason: null, schemaVersion: 2 as const,
  };
  const stub = {
    async memoryExecute(request: MemoryRpcRequest): Promise<StateRpcResult<MemoryRpcResponse>> {
      calls.push(request);
      return { ok: true, value: { kind: 'owner', owner: descriptor } };
    },
  } as unknown as TagStateRpc;
  const store = new CfMemoryStateStore(stub);
  assert.deepEqual(await store.ensureOwner({
    workspaceId: 'T_TEST', ownerKind: 'agent', ownerId: 'agent_ops',
  }), descriptor);
  assert.deepEqual(calls, [{ kind: 'ensure_owner', owner: {
    workspaceId: 'T_TEST', ownerKind: 'agent', ownerId: 'agent_ops',
  } }]);
});

test('Cloudflare memory proxy preserves typed rate-limit retry timestamps', async () => {
  const stub = {
    async memoryExecute(): Promise<StateRpcResult<MemoryRpcResponse>> {
      return {
        ok: false,
        error: {
          code: 'memory',
          message: 'Too many memory changes; try again later.',
          details: {
            memoryCode: 'memory_rate_limited',
            retryAt: '1785000000123',
          },
        },
      };
    },
  } as unknown as TagStateRpc;

  const store = new CfMemoryStateStore(stub);
  await assert.rejects(
    () => store.createEntry({} as never),
    (error: unknown) =>
      error instanceof MemoryRateLimitError && error.retryAt === 1_785_000_000_123,
  );
});

test('Cloudflare memory proxy forwards lifecycle retention and grouped entry summaries', async () => {
  const calls: MemoryRpcRequest[] = [];
  const retained = {
    workspaceId: 'T_TEST', channelId: 'C_PRIVATE', privacy: 'private' as const,
    lifecycle: 'retained' as const, privateGeneration: 1,
    privateStoreId: 'store_private_T_TEST_C_PRIVATE_1', currentDisplayName: 'private',
    lastPublicDisplayName: null, firstObservedAt: 100, lastObservedAt: 200,
    lastVerifiedAt: 200, visibilityBarrierAt: null, transitionVersion: 2,
  };
  const stub = {
    async memoryExecute(request: MemoryRpcRequest): Promise<StateRpcResult<MemoryRpcResponse>> {
      calls.push(request);
      if (request.kind === 'retain_channel_scope') {
        return { ok: true, value: { kind: 'channel_scope', state: retained } };
      }
      return {
        ok: true,
        value: {
          kind: 'entry_scope_summaries',
          summaries: [{
            storeId: 'store_public_T_TEST', sourceChannelId: 'C_PUBLIC', entryCount: 3,
          }],
        },
      };
    },
  } as unknown as TagStateRpc;
  const store = new CfMemoryStateStore(stub);
  const input = {
    workspaceId: 'T_TEST', channelId: 'C_PRIVATE', reason: 'archived' as const,
    observedAt: 200,
  };

  assert.deepEqual(await store.retainChannelScope(input), retained);
  assert.deepEqual(await store.listEntryScopeSummaries('T_TEST'), [{
    storeId: 'store_public_T_TEST', sourceChannelId: 'C_PUBLIC', entryCount: 3,
  }]);
  assert.deepEqual(calls, [
    { kind: 'retain_channel_scope', input },
    { kind: 'list_entry_scope_summaries', workspaceId: 'T_TEST' },
  ]);
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
