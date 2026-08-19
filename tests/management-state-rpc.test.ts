import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfManagementStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import {
  ManagementError,
  type ManagementRpcRequest,
  type ManagementRpcResponse,
} from '../src/management/types.ts';

const NOW = 1_800_000_000_000;

test('Cloudflare management proxy preserves the canonical ledger contract and typed errors', async () => {
  const direct = new SqliteManagementStore(':memory:');
  const calls: ManagementRpcRequest[] = [];
  const stub = {
    async managementExecute(request: ManagementRpcRequest): Promise<StateRpcResult<ManagementRpcResponse>> {
      calls.push(request);
      try {
        return { ok: true, value: await direct.execute(request) };
      } catch (error) {
        if (error instanceof ManagementError) {
          return {
            ok: false,
            error: {
              code: 'management',
              message: error.message,
              details: { managementCode: error.code },
            },
          };
        }
        throw error;
      }
    },
  } as TagStateRpc;
  const proxy = new CfManagementStore(stub);
  const input = {
    operationId: 'operation_rpc',
    organizationId: 'org_rpc',
    actorUserId: 'user_rpc',
    actorMembershipId: 'member_rpc',
    originKey: 'mcp:client_rpc',
    idempotencyKey: 'idem_rpc',
    digest: 'a'.repeat(64),
    operations: [{
      itemId: 'create',
      kind: 'create_agent' as const,
      agent: {
        id: 'agent_rpc',
        name: 'RPC Agent',
        instructions: 'Exercise the management RPC.',
        enabled: true,
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
      },
    }],
    at: NOW,
  };
  try {
    const reserved = await proxy.reserveRequest(input);
    assert.equal(reserved.created, true);
    assert.equal((await proxy.getRequest('operation_rpc'))?.idempotencyKey, 'idem_rpc');
    await assert.rejects(
      () => proxy.reserveRequest({ ...input, digest: 'b'.repeat(64) }),
      (error: unknown) => error instanceof ManagementError &&
        error.code === 'idempotency_conflict',
    );
    assert.deepEqual(calls.map(({ kind }) => kind), [
      'reserve_request',
      'get_request',
      'reserve_request',
    ]);
  } finally {
    direct.close();
  }
});

