import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfUsageStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { UsageStateError, type UsageRpcRequest, type UsageRpcResponse } from '../src/usage/index.ts';

test('Cloudflare usage proxy preserves clone-safe requests and typed domain failures', async () => {
  const requests: UsageRpcRequest[] = [];
  const stub = {
    async usageExecute(request: UsageRpcRequest): Promise<StateRpcResult<UsageRpcResponse>> {
      requests.push(request);
      if (request.kind === 'get_operation' || request.kind === 'get_operation_by_run') {
        return { ok: true, value: { kind: 'detail', detail: null } };
      }
      return {
        ok: false,
        error: {
          code: 'usage',
          message: 'conflict',
          details: { usageCode: 'usage_operation_conflict', operationId: 'op_conflict' },
        },
      };
    },
  } as unknown as TagStateRpc;
  const store = new CfUsageStore(stub);

  assert.equal(await store.getOperation('op_missing'), undefined);
  assert.deepEqual(requests[0], { kind: 'get_operation', operationId: 'op_missing' });
  assert.equal(await store.getOperationByRunId('run_missing'), undefined);
  assert.deepEqual(requests[1], { kind: 'get_operation_by_run', runId: 'run_missing' });
  await assert.rejects(
    store.admitOperation({
      operationId: 'op_conflict',
      operationKind: 'interactive_turn',
      sourceId: 'op_conflict',
      startedAt: 1,
      installationId: 'installation',
      workspaceId: null,
      profileId: null,
      profileLabel: null,
      channelId: null,
      channelLabel: null,
      conversationKind: 'unknown',
      requestedProvider: null,
      requestedModel: null,
      credentialRefId: null,
      credentialVersion: null,
    }),
    (error: unknown) =>
      error instanceof UsageStateError &&
      error.code === 'usage_operation_conflict' &&
      error.details.operationId === 'op_conflict',
  );
});
