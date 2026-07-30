import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CfWorkStore } from '../src/config/cf-state-proxies.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { WorkStoreLogic } from '../src/work/store.ts';
import {
  WorkStateError,
  type AdmitShadowRunInput,
  type BindingId,
  type RunExecutionId,
  type RunId,
  type SafeEffectiveConfigInput,
  type WorkId,
} from '../src/work/types.ts';

const CONFIG: SafeEffectiveConfigInput = {
  schemaVersion: 1,
  profileId: 'profile_default',
  configuredModel: 'openai/gpt-5.6-sol',
  snapshotDigest: 'a'.repeat(64),
  capabilityDigest: 'b'.repeat(64),
  skillNames: [],
  connectionIds: [],
  repositoryIds: [],
  memoryMode: 'disabled',
  ceilings: {
    maxModelAttempts: 2,
    maxToolCalls: 10,
    maxActionAttempts: 0,
    timeoutMs: 60_000,
  },
};

test('Work state proxy preserves clone-safe request and response shapes', async () => {
  const db = openStateDb(':memory:');
  try {
    const logic = new WorkStoreLogic(db, { now: () => 1_800_000_000_000 });
    const stub = {
      async workExecute(request: Parameters<TagStateRpc['workExecute']>[0]) {
        return { ok: true as const, value: logic.execute(structuredClone(request)) };
      },
    } as unknown as TagStateRpc;
    const proxy = new CfWorkStore(stub);
    const config = await proxy.putConfigRevision(CONFIG, 1_800_000_000_000);
    assert.equal((await proxy.getConfigRevision(config.id))?.id, config.id);
    const workId = 'work_rpc_shadow' as WorkId;
    const bindingId = 'binding_rpc_shadow' as BindingId;
    const input: AdmitShadowRunInput = {
      work: { id: workId, kind: 'conversation', maximumSensitivity: 'public', createdAt: 1_800_000_000_000 },
      binding: {
        id: bindingId,
        workId,
        adapterKind: 'conformance',
        externalAccountId: 'account_rpc',
        externalConversationId: 'conversation_rpc',
        generation: 1,
        sourceVisibility: 'public',
        configMode: 'resolve_each_run',
        orderingKey: 'ordering_rpc',
        createdAt: 1_800_000_000_000,
      },
      run: {
        id: 'run_rpc_shadow' as RunId,
        workId,
        bindingId,
        kind: 'interactive',
        triggerKind: 'conformance',
        triggerRef: 'trigger_rpc',
        dedupeKey: 'dedupe_rpc',
        actorTrustTier: 'system',
        effectiveCapabilityDigest: CONFIG.capabilityDigest,
        executionAuthority: 'legacy',
        coordinatorKind: 'interactive',
        authorityEpoch: 1,
        createdAt: 1_800_000_000_000,
      },
      safeConfig: CONFIG,
      triggerContent: { sensitivity: 'public', body: 'RPC admission proof' },
      auditEventId: 'audit_rpc_shadow',
      auditIdempotencyKey: 'auditkey_rpc_shadow',
    };
    const admitted = await proxy.admitShadowRun(input);
    assert.equal(admitted.run.id, input.run.id);
    assert.equal(admitted.replayed, false);
    assert.equal((await proxy.admitShadowRun(input)).replayed, true);
    const prepared = await proxy.prepareRunInput({
      runId: input.run.id,
      sensitivity: 'public',
      body: 'RPC prepared input proof',
      preparedAt: 1_800_000_000_001,
    });
    assert.equal(prepared.status, 'input_ready');
    const execution = await proxy.createRunExecution({
      id: 'execution_rpc_shadow' as RunExecutionId,
      runId: input.run.id,
      attemptNumber: 1,
      fencingToken: 1,
      executorKind: 'agent',
      agentName: 'agent_rpc',
      canonicalModel: 'openai/gpt-5.6-sol',
      flueInstanceRef: 'flueinstance_rpc',
      startedAt: 1_800_000_000_002,
    });
    await proxy.recordRunExecutionRoute({
      executionId: execution.id,
      recordedAt: 1_800_000_000_002,
      providerAuthRoute: 'openai_api_key',
    });
    await proxy.markRunExecutionInvoked({
      executionId: execution.id,
      fencingToken: 1,
      invokedAt: 1_800_000_000_003,
    });
    await proxy.settleRunExecution({
      executionId: execution.id,
      fencingToken: 1,
      outcome: 'succeeded',
      modelInvocationStatus: 'settled',
      rawSettlementStatus: 'flue_succeeded',
      flueSubmissionRef: 'fluesubmission_rpc',
      finishedAt: 1_800_000_000_004,
    });
    await proxy.recordRunResponse({
      runId: input.run.id,
      executionId: execution.id,
      fencingToken: 1,
      sensitivity: 'public',
      approvedOutput: 'RPC approved output',
      renderedPayload: '{"text":"RPC rendered output"}',
      recordedAt: 1_800_000_000_005,
    });
    await proxy.startRunDelivery({
      runId: input.run.id,
      fencingToken: 1,
      method: 'conformance_post',
      attemptId: 'delivery_rpc_shadow',
      startedAt: 1_800_000_000_006,
    });
    const delivered = await proxy.finalizeRunDelivery({
      runId: input.run.id,
      fencingToken: 1,
      attemptId: 'delivery_rpc_shadow',
      outcome: 'delivered',
      deliveryRef: 'conformance:receipt:rpc',
      finalizedAt: 1_800_000_000_007,
    });
    assert.equal(delivered.status, 'settled');
    assert.equal((await proxy.getRunExecution(execution.id))?.flueSubmissionRef, 'fluesubmission_rpc');
    const runPage = await proxy.listRuns({ limit: 10, kind: 'interactive', status: 'settled' });
    assert.equal(runPage.items.length, 1);
    assert.equal(runPage.items[0]?.run.id, input.run.id);
    assert.equal(runPage.items[0]?.work.id, workId);
    assert.equal(runPage.items[0]?.binding.id, bindingId);
    assert.equal(runPage.nextCursor, null);
    const executions = await proxy.listRunExecutions(input.run.id);
    assert.deepEqual(executions.map((item) => item.id), [execution.id]);
    assert.deepEqual(await proxy.verifyIntegrity(), {
      foreignKeysEnabled: true,
      foreignKeyViolationCount: 0,
      invariantViolationCount: 0,
    });
  } finally {
    db.close();
  }
});

test('Work state proxy reconstructs typed domain errors', async () => {
  const stub = {
    async workExecute() {
      return {
        ok: false as const,
        error: {
          code: 'work' as const,
          message: 'safe work failure',
          details: { workCode: 'work_route_invalid', executionId: 'execution_test' },
        },
      };
    },
  } as unknown as TagStateRpc;
  const proxy = new CfWorkStore(stub);
  await assert.rejects(
    () => proxy.verifyIntegrity(),
    (error: unknown) =>
      error instanceof WorkStateError &&
      error.code === 'work_route_invalid' &&
      error.details.executionId === 'execution_test',
  );
});
