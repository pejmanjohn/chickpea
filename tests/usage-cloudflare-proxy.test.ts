import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfUsageStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { UsageStateError, type UsageRpcRequest, type UsageRpcResponse } from '../src/usage/index.ts';
import type { ModelRequestRecord } from '../src/usage/model-requests.ts';
import { UsageStoreLogic } from '../src/usage/store.ts';

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
      agentId: null,
      agentLabel: null,
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

test('Cloudflare usage proxy records and reads a model request record through its RPC', async () => {
  const logic = new UsageStoreLogic(openStateDb(':memory:'));
  const kinds: string[] = [];
  const stub = {
    async usageExecute(request: UsageRpcRequest): Promise<StateRpcResult<UsageRpcResponse>> {
      kinds.push(request.kind);
      return { ok: true, value: structuredClone(logic.execute(structuredClone(request))) };
    },
  } as unknown as TagStateRpc;
  const store = new CfUsageStore(stub);
  const record: ModelRequestRecord = {
    requestId: 'request-cf', installationId: 'installation', runId: 'run-cf', attemptId: 'attempt-cf',
    agentId: null, provider: 'openai', model: 'gpt-4.1-mini', fundingSource: 'customer', outcome: 'stopped',
    inputTokens: 10, outputTokens: { total: 2, reasoning: 1 }, cacheReadTokens: 0,
    cacheWriteTokens: { total: 0, oneHour: null }, priceVersionId: null, listPriceUsdMicros: null, priceUnknownReason: 'price_unknown',
    finishedAt: 1_000,
  };

  assert.equal(await store.getModelRequest('request-cf'), undefined);
  assert.deepEqual(await store.recordModelRequest(record), record);
  assert.deepEqual(await store.recordModelRequest({ ...record, inputTokens: 99 }), record);
  assert.deepEqual(await store.getModelRequest('request-cf'), record);
  assert.deepEqual(kinds, ['get_model_request', 'record_model_request', 'record_model_request', 'get_model_request']);
});
