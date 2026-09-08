import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SqliteUsageStore, UsageStateError } from '../src/usage/store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { AdmitUsageOperationInput, RecordUsageTerminalInput } from '../src/usage/types.ts';

const START = Date.UTC(2026, 6, 28, 12);

function operation(
  operationId: string,
  overrides: Partial<AdmitUsageOperationInput> = {},
): AdmitUsageOperationInput {
  return {
    operationId,
    operationKind: 'interactive_turn',
    sourceId: operationId,
    startedAt: START,
    installationId: 'installation',
    workspaceId: 'T_USAGE',
    agentId: 'agent_default',
    agentLabel: 'Default',
    channelId: 'C_USAGE',
    channelLabel: 'usage-lab',
    conversationKind: 'named_channel',
    requesterMembershipId: 'membership_usage',
    executionPrincipalId: 'agent_default',
    modelSource: 'workspace_default',
    workspaceDefaultRevision: 12,
    catalogRevision: 'catalog_2026_08',
    requestedProvider: 'openai',
    requestedModel: 'gpt-4.1-mini',
    credentialRefId: 'cred_openai_environment',
    credentialVersion: 1,
    ...overrides,
  };
}

function terminal(
  operationId: string,
  overrides: Partial<RecordUsageTerminalInput> = {},
): RecordUsageTerminalInput {
  return {
    operationId,
    executionId: `exec_${operationId}`,
    status: 'completed',
    finishedAt: START + 2_000,
    observedAt: START + 2_000,
    providerRoute: 'openai',
    requestedProvider: 'openai',
    requestedModel: 'gpt-4.1-mini',
    returnedProvider: 'openai',
    returnedModel: 'gpt-4.1-mini-2025-04-14',
    credentialRefId: 'cred_openai_environment',
    credentialVersion: 1,
    usageCompleteness: 'complete',
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    usageUnknownReason: null,
    estimateCompleteness: 'not_priced',
    estimateAmountMicros: null,
    estimateCurrency: null,
    priceVersionId: null,
    priceUnknownReason: 'price_unknown',
    ...overrides,
  };
}

test('usage admission and terminal recording are idempotent and immutable', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    const admitted = await store.admitOperation(operation('op_1'));
    assert.equal(admitted.status, 'admitted');
    assert.equal(admitted.requesterMembershipId, 'membership_usage');
    assert.equal(admitted.executionPrincipalId, 'agent_default');
    assert.equal(admitted.modelSource, 'workspace_default');
    assert.equal(admitted.workspaceDefaultRevision, 12);
    assert.equal(admitted.catalogRevision, 'catalog_2026_08');
    assert.equal(admitted.telemetrySchemaVersion, 2);
    assert.deepEqual(await store.admitOperation(operation('op_1')), admitted);

    const recorded = await store.recordTerminal(terminal('op_1'));
    assert.equal(recorded.operation.status, 'completed');
    assert.equal(recorded.measurements[0]?.inputTokens, 100);
    assert.deepEqual(await store.recordTerminal(terminal('op_1')), recorded);

    await assert.rejects(
      store.recordTerminal(terminal('op_1', { totalTokens: 126 })),
      (error: unknown) =>
        error instanceof UsageStateError && error.code === 'usage_measurement_conflict',
    );
  } finally {
    store.close();
  }
});

test('usage observations retain optional canonical Run and RunExecution links', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    const admitted = await store.admitOperation(operation('op_linked', {
      runId: 'run_usage_linked',
    }));
    assert.equal(admitted.runId, 'run_usage_linked');
    const recorded = await store.recordTerminal(terminal('op_linked', {
      runExecutionId: 'execution_usage_linked',
    }));
    assert.equal(recorded.operation.runId, 'run_usage_linked');
    assert.equal(recorded.measurements[0]?.runExecutionId, 'execution_usage_linked');
    assert.equal(
      (await store.getOperationByRunId('run_usage_linked'))?.operation.operationId,
      'op_linked',
    );
    assert.equal(await store.getOperationByRunId('run_missing'), undefined);
  } finally {
    store.close();
  }
});

test('missing usage remains null with an explicit reason and direct messages stay generic', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    await store.admitOperation(operation('op_dm', {
      channelId: 'D_PRIVATE',
      channelLabel: null,
      conversationKind: 'direct_message',
      requestedProvider: 'custom',
      requestedModel: 'local-model',
      credentialRefId: 'cred_custom',
    }));
    await store.recordTerminal(terminal('op_dm', {
      providerRoute: 'custom',
      requestedProvider: 'custom',
      requestedModel: 'local-model',
      returnedProvider: 'custom',
      returnedModel: 'local-model',
      credentialRefId: 'cred_custom',
      usageCompleteness: 'not_reported',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageUnknownReason: 'usage_not_reported',
    }));

    const detail = await store.getOperation('op_dm');
    assert.equal(detail?.operation.channelLabel, null);
    assert.equal(detail?.measurements[0]?.totalTokens, null);
    assert.equal(detail?.measurements[0]?.usageUnknownReason, 'usage_not_reported');
    assert.doesNotMatch(JSON.stringify(detail), /prompt|resultText|authorization|apiKey/i);

    const grouped = await store.summarize({
      from: START - 1,
      to: START + 10_000,
      groupBy: 'channel',
    });
    assert.equal(grouped.groups[0]?.key, 'direct_message');
    assert.equal(grouped.groups[0]?.label, 'Direct message');
    const filtered = await store.listOperations({
      from: START - 1,
      to: START + 10_000,
      filters: { channel: ['direct_message'] },
    });
    assert.equal(filtered.items[0]?.operation.operationId, 'op_dm');
  } finally {
    store.close();
  }
});

test('a recovered work instance retains each distinct model execution without double-counting work', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    await store.admitOperation(operation('op_retry'));
    await store.recordTerminal(terminal('op_retry', {
      executionId: 'exec_retry_1',
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    }));
    await store.recordTerminal(terminal('op_retry', {
      executionId: 'exec_retry_2',
      finishedAt: START + 3_000,
      observedAt: START + 3_000,
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
    }));

    const detail = await store.getOperation('op_retry');
    assert.equal(detail?.measurements.length, 2);
    const summary = await store.summarize({ from: START - 1, to: START + 10_000 });
    assert.equal(summary.totals.operationCount, 1);
    assert.equal(summary.totals.meteredOperationCount, 1);
    assert.equal(summary.totals.totalTokens, 150);
  } finally {
    store.close();
  }
});

test('rollups reconcile to bounded work-instance pages without treating unknowns as zero', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    await store.admitOperation(operation('op_a'));
    await store.recordTerminal(terminal('op_a', {
      estimateCompleteness: 'complete',
      estimateAmountMicros: 250,
      estimateCurrency: 'USD',
      priceVersionId: 'prices_2026_07_28',
      priceUnknownReason: null,
    }));
    await store.admitOperation(operation('op_b', {
      agentId: 'agent_support',
      agentLabel: 'Support',
      channelId: 'C_SUPPORT',
      channelLabel: 'support',
    }));
    await store.recordTerminal(terminal('op_b', {
      status: 'failed',
      usageCompleteness: 'not_reported',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageUnknownReason: 'provider_request_unknown',
    }));

    const summary = await store.summarize({
      from: START - 1,
      to: START + 10_000,
      groupBy: 'agent',
      currency: 'USD',
    });
    assert.equal(summary.totals.operationCount, 2);
    assert.equal(summary.totals.meteredOperationCount, 1);
    assert.equal(summary.totals.pricedOperationCount, 1);
    assert.equal(summary.totals.unknownUsageOperationCount, 1);
    assert.equal(summary.totals.estimateAmountMicros, 250);
    assert.equal(
      summary.groups.reduce((sum, group) => sum + group.operationCount, 0),
      summary.totals.operationCount,
    );

    const first = await store.listOperations({ from: START - 1, to: START + 10_000, limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await store.listOperations({
      from: START - 1,
      to: START + 10_000,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0]?.operation.operationId, first.items[0]?.operation.operationId);
  } finally {
    store.close();
  }
});

test('usage schema initialization is additive beside existing application data', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-usage-schema-')), 'state.db');
  const before = openStateDb(path);
  before.exec('CREATE TABLE preserved_fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  before.run('INSERT INTO preserved_fixture (id, value) VALUES (?, ?)', 'keep', 'untouched');
  before.close();

  const usage = new SqliteUsageStore(path);
  usage.close();

  const after = openStateDb(path);
  try {
    const preserved = after.get('SELECT id, value FROM preserved_fixture WHERE id = ?', 'keep');
    assert.equal(preserved?.id, 'keep');
    assert.equal(preserved?.value, 'untouched');
    assert.ok(after.get("SELECT name FROM sqlite_master WHERE name = 'usage_operations'"));
    assert.ok(after.get("SELECT name FROM sqlite_master WHERE name = 'usage_measurements'"));
  } finally {
    after.close();
  }
});
