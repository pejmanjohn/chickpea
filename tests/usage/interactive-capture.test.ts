import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ResolvedAssignment } from '../../src/config/types.ts';
import type { AgentDispatchResult } from '../../src/slack/flue-dispatch.ts';
import type { NormalizedSlackTurn } from '../../src/slack/types.ts';
import { SqliteUsageStore } from '../../src/usage/store.ts';
import {
  InteractiveUsageRecorder,
  type UsagePersistenceEvent,
} from '../../src/usage/runtime-recorder.ts';
import type { UsageStore } from '../../src/usage/types.ts';

const turn: NormalizedSlackTurn = {
  workspaceId: 'T_USAGE',
  channelId: 'C_USAGE',
  eventId: 'Ev_USAGE',
  text: 'content is deliberately not persisted',
  userId: 'U_USAGE',
  actorMembershipId: 'membership_usage',
  messageTs: '1000.0001',
  threadTs: '1000.0001',
  source: 'app_mention',
  contextMode: 'thread',
};

const assignment: ResolvedAssignment = {
  workspaceId: 'T_USAGE',
  channelId: 'C_USAGE',
  channelLabel: 'usage-lab',
  agentId: 'agent_usage',
  model: 'openai/gpt-4.1-mini',
  modelAttribution: {
    source: 'workspace_default',
    providerId: 'openai',
    workspaceDefaultRevision: 9,
    catalogRevision: 'catalog_2026_08',
  },
  modelCredential: {
    credentialRefId: 'cred_openai_environment',
    version: 7,
    providerId: 'openai',
    sourceKind: 'environment',
    label: 'Production project',
    scopeLabel: 'proj_usage',
    unknownRotation: false,
  },
  agent: {
    id: 'agent_usage',
    kind: 'user',
    revision: 1,
    name: 'Usage profile',
    instructions: 'private instructions',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

function success(overrides: Partial<AgentDispatchResult> = {}): AgentDispatchResult {
  return {
    text: 'private output',
    requestedModel: 'openai/gpt-4.1-mini',
    returnedModel: { provider: 'openai', id: 'gpt-4.1-mini-2025-04-14' },
    reportedUsage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 180,
    },
    usageCompleteness: 'complete',
    ...overrides,
  };
}

test('interactive capture persists only bounded attribution and aggregate response usage', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    const recorder = new InteractiveUsageRecorder({
      turn,
      assignment,
      requestedModel: assignment.model!,
      operationId: 'msg:C_USAGE:1000.0001',
      executionId: 'exec:msg:C_USAGE:1000.0001:1',
      runId: 'run_usage_interactive',
      runExecutionId: 'execution_usage_interactive_1',
      store,
      processEnv: { CHICKPEA_INSTALLATION_ID: 'installation_usage' },
      now: (() => { let now = 1_000_000; return () => now += 10; })(),
    });
    await recorder.admit();
    await recorder.recordSuccess(success());

    const detail = await store.getOperation('msg:C_USAGE:1000.0001');
    assert.equal(detail?.operation.agentLabel, 'Usage profile');
    assert.equal(detail?.operation.channelLabel, 'usage-lab');
    assert.equal(detail?.operation.credentialVersion, 7);
    assert.equal(detail?.operation.runId, 'run_usage_interactive');
    assert.equal(detail?.operation.requesterMembershipId, 'membership_usage');
    assert.equal(detail?.operation.executionPrincipalId, 'agent_usage');
    assert.equal(detail?.operation.modelSource, 'workspace_default');
    assert.equal(detail?.operation.workspaceDefaultRevision, 9);
    assert.equal(detail?.operation.catalogRevision, 'catalog_2026_08');
    assert.equal(detail?.operation.telemetrySchemaVersion, 2);
    assert.equal(detail?.measurements[0]?.runExecutionId, 'execution_usage_interactive_1');
    assert.equal(detail?.measurements[0]?.cacheReadTokens, 20);
    assert.equal(detail?.measurements[0]?.cacheWriteTokens, 10);
    assert.equal(detail?.measurements[0]?.totalTokens, 180);
    assert.doesNotMatch(
      JSON.stringify(detail),
      /content is deliberately|private output|private instructions|Production project/,
    );
  } finally {
    store.close();
  }
});

test('interactive Usage links an execution only after lifecycle creation', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    const recorder = new InteractiveUsageRecorder({
      turn,
      assignment,
      requestedModel: assignment.model!,
      operationId: 'msg_late_execution',
      executionId: 'exec_late_execution',
      runId: 'run_late_execution',
      store,
      now: () => 1_500_000,
    });
    await recorder.admit();
    recorder.linkRunExecution('execution_late_created');
    await recorder.recordSuccess(success());
    assert.equal(
      (await store.getOperation('msg_late_execution'))?.measurements[0]?.runExecutionId,
      'execution_late_created',
    );
  } finally {
    store.close();
  }
});

test('operations-only success and provider failure remain explicit unknowns', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    const unmetered = new InteractiveUsageRecorder({
      turn,
      assignment,
      requestedModel: assignment.model!,
      operationId: 'msg_unmetered',
      executionId: 'exec_unmetered',
      store,
      now: () => 2_000_000,
    });
    await unmetered.admit();
    await unmetered.recordSuccess(success({
      reportedUsage: null,
      usageCompleteness: 'not_reported',
    }));
    const failed = new InteractiveUsageRecorder({
      turn,
      assignment,
      requestedModel: assignment.model!,
      operationId: 'msg_failed',
      executionId: 'exec_failed',
      store,
      now: () => 3_000_000,
    });
    await failed.admit();
    await failed.recordFailure();

    assert.equal(
      (await store.getOperation('msg_unmetered'))?.measurements[0]?.usageUnknownReason,
      'usage_not_reported',
    );
    assert.equal((await store.getOperation('msg_failed'))?.operation.status, 'failed');
    assert.equal(
      (await store.getOperation('msg_failed'))?.measurements[0]?.usageUnknownReason,
      'provider_request_unknown',
    );
  } finally {
    store.close();
  }
});

test('runtime estimates are independently flagged and retain immutable price provenance', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    const pricedTurn = { ...turn, messageTs: '1785240000.0001', threadTs: '1785240000.0001' };
    const recorder = new InteractiveUsageRecorder({
      turn: pricedTurn,
      assignment,
      requestedModel: assignment.model!,
      operationId: 'msg_priced',
      executionId: 'exec_priced',
      store,
      processEnv: { USAGE_ESTIMATES: '1' },
      now: () => Date.UTC(2026, 6, 28, 13),
    });
    await recorder.admit();
    await recorder.recordSuccess(success({
      reportedUsage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
    }));
    const estimate = (await store.getOperation('msg_priced'))?.measurements[0];
    assert.equal(estimate?.estimateAmountMicros, 16);
    assert.equal(estimate?.priceVersionId, 'openai_2026-07-28');
  } finally {
    store.close();
  }
});

test('a real recovery invocation adds usage while one execution persistence retry is idempotent', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    for (const [executionId, input, output] of [
      ['exec_retry_1', 100, 20],
      ['exec_retry_2', 50, 10],
    ] as const) {
      const recorder = new InteractiveUsageRecorder({
        turn,
        assignment,
        requestedModel: assignment.model!,
        operationId: 'msg_retry',
        executionId,
        store,
        now: () => executionId.endsWith('1') ? 4_000_000 : 5_000_000,
      });
      await recorder.admit();
      await recorder.recordSuccess(success({
        reportedUsage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
      }));
      await recorder.repairAfterDelivery();
    }
    const detail = await store.getOperation('msg_retry');
    assert.equal(detail?.measurements.length, 2);
    assert.equal(detail?.measurements.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0), 180);
  } finally {
    store.close();
  }
});

test('slow telemetry cannot hold delivery beyond the budget and one repair records the same execution', async () => {
  const durable = new SqliteUsageStore(':memory:');
  const never = new Promise<never>(() => undefined);
  let admissionCalls = 0;
  let terminalCalls = 0;
  const store: UsageStore = {
    admitOperation: async (input) => (++admissionCalls === 1 ? never : durable.admitOperation(input)),
    recordTerminal: async (input) => (++terminalCalls === 1 ? never : durable.recordTerminal(input)),
    recordConnectorUsage: (input) => durable.recordConnectorUsage(input),
    reserveConnectorQuota: (input) => durable.reserveConnectorQuota(input),
    releaseConnectorQuota: (input) => durable.releaseConnectorQuota(input),
    summarizeConnectorUsage: (query) => durable.summarizeConnectorUsage(query),
    getOperation: (id) => durable.getOperation(id),
    getOperationByRunId: (runId) => durable.getOperationByRunId(runId),
    listOperations: (query) => durable.listOperations(query),
    summarize: (query) => durable.summarize(query),
    putCredential: (input) => durable.putCredential(input),
    retireCredential: (ref, version, at) => durable.retireCredential(ref, version, at),
    listCredentials: (provider) => durable.listCredentials(provider),
    cleanupRetention: (at) => durable.cleanupRetention(at),
    getRetentionStatus: () => durable.getRetentionStatus(),
    listUsageAuditEvents: (limit) => durable.listUsageAuditEvents(limit),
  };
  const events: UsagePersistenceEvent[] = [];
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const recorder = new InteractiveUsageRecorder({
      turn,
      assignment,
      requestedModel: assignment.model!,
      operationId: 'msg_slow',
      executionId: 'exec_slow_1',
      store,
      writeBudgetMs: 5,
      now: () => 6_000_000,
      onPersistence: (event) => events.push(event),
    });
    const started = performance.now();
    await recorder.admit();
    await recorder.recordSuccess(success());
    const readyToDeliverMs = performance.now() - started;
    assert.ok(readyToDeliverMs < 40, `telemetry delayed delivery ${readyToDeliverMs}ms`);
    await recorder.repairAfterDelivery();
    assert.deepEqual(events.map(({ phase, outcome }) => [phase, outcome]), [
      ['admission', 'timed_out'],
      ['terminal', 'timed_out'],
      ['repair', 'recorded'],
    ]);
    assert.equal((await durable.getOperation('msg_slow'))?.measurements[0]?.executionId, 'exec_slow_1');
  } finally {
    console.warn = originalWarn;
    durable.close();
  }
});
