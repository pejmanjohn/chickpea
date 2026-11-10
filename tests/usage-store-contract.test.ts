import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { estimateUsage } from '../src/usage/pricing/estimate.ts';
import { SqliteUsageStore, UsageStateError, UsageStoreLogic } from '../src/usage/store.ts';
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

test('a terminal replayed by a release that prices it differently is the same measurement', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    const observedAt = Date.UTC(2026, 9, 5, 6);
    const haiku = {
      finishedAt: observedAt,
      observedAt,
      providerRoute: 'anthropic',
      requestedProvider: 'anthropic',
      requestedModel: 'claude-haiku-4-5',
      returnedProvider: 'anthropic',
      returnedModel: 'claude-haiku-4-5',
      credentialRefId: null,
      credentialVersion: null,
      inputTokens: 231,
      outputTokens: 732,
      cacheReadTokens: 85_706,
      cacheWriteTokens: 15_654,
      totalTokens: 102_323,
    };
    // A release without this model's cache prices, and one with them.
    const partial = {
      estimateCompleteness: 'partial',
      estimateAmountMicros: null,
      estimateCurrency: null,
      priceVersionId: null,
      priceUnknownReason: 'pricing_dimension_unknown',
    } as const;
    const priced = estimateUsage({ ...haiku, usageCompleteness: 'complete' });
    assert.equal(priced.estimateAmountMicros, 32_029);
    // A release without any price for this model.
    const unlisted = { ...partial, estimateCompleteness: 'unknown', priceUnknownReason: 'price_unknown' } as const;

    const admit = (operationId: string) => store.admitOperation(operation(operationId, {
      startedAt: observedAt - 1_000,
      requestedProvider: 'anthropic',
      requestedModel: 'claude-haiku-4-5',
      credentialRefId: null,
      credentialVersion: null,
    }));
    // Either release can replay during a rolling deploy. The first write stays.
    for (const [operationId, first, replay] of [
      ['op_unknown_then_priced', partial, priced],
      ['op_priced_then_unknown', priced, partial],
      ['op_unlisted_then_partial', unlisted, partial],
      ['op_partial_then_unlisted', partial, unlisted],
      ['op_unlisted_then_priced', unlisted, priced],
      ['op_priced_then_unlisted', priced, unlisted],
      ['op_priced_then_other_version', priced, { ...priced, priceVersionId: 'anthropic_2026-07-28' }],
    ] as const) {
      await admit(operationId);
      const recorded = await store.recordTerminal(terminal(operationId, { ...haiku, ...first }));
      assert.deepEqual(
        await store.recordTerminal(terminal(operationId, { ...haiku, ...replay })),
        recorded,
        operationId,
      );
    }

    const conflict = (error: unknown) =>
      error instanceof UsageStateError && error.code === 'usage_measurement_conflict';
    const changed = { cacheWriteTokens: 15_655, totalTokens: 102_324 };
    for (const [operationId, replay] of [
      ['op_unknown_then_priced', { ...haiku, ...changed, ...estimateUsage({ ...haiku, ...changed, usageCompleteness: 'complete' }) }],
      ['op_unknown_then_priced', { ...haiku, ...changed, ...partial }],
      ['op_priced_then_unknown', { ...haiku, ...changed, ...partial }],
      ['op_priced_then_unknown', { ...haiku, ...priced, estimateAmountMicros: 32_030 }],
    ] as const) {
      await assert.rejects(store.recordTerminal(terminal(operationId, replay)), conflict, operationId);
    }
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

test('one channel or Agent is one group even when operations recorded different labels', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    // Operations in one channel can carry different stored labels: each
    // Agent's assignment has its own channel label, an assignment without one
    // falls back to the channel id, and an Agent can be renamed between turns.
    await store.admitOperation(operation('op_label_named', {
      channelLabel: 'qa-cobalt',
      agentLabel: 'Coder',
    }));
    await store.admitOperation(operation('op_label_fallback', {
      channelLabel: 'C_USAGE',
      agentLabel: 'Renamed Coder',
    }));
    await store.admitOperation(operation('op_label_missing', {
      channelLabel: null,
      agentLabel: null,
    }));
    await store.admitOperation(operation('op_label_dm', {
      channelId: 'D_USAGE',
      channelLabel: null,
      conversationKind: 'direct_message',
    }));

    const byChannel = await store.summarize({
      from: START - 1,
      to: START + 10_000,
      groupBy: 'channel',
    });
    assert.deepEqual(
      byChannel.groups.map(({ key, label, operationCount }) => ({ key, label, operationCount })),
      [
        { key: 'C_USAGE', label: 'qa-cobalt', operationCount: 3 },
        { key: 'direct_message', label: 'Direct message', operationCount: 1 },
      ],
    );

    const byAgent = await store.summarize({
      from: START - 1,
      to: START + 10_000,
      groupBy: 'agent',
    });
    assert.equal(byAgent.groups.length, 1);
    assert.equal(byAgent.groups[0]?.key, 'agent_default');
    assert.equal(byAgent.groups[0]?.operationCount, 4);
    assert.notEqual(byAgent.groups[0]?.label, 'agent_default');
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

test('a credential epoch takes a new label in place, audited, but refuses any other change', async () => {
  let now = START;
  const store = new SqliteUsageStore(':memory:', () => now);
  try {
    const epoch = {
      credentialRefId: 'platform:openai', version: 1, providerId: 'openai', sourceKind: 'platform' as const,
      label: 'Old label', scopeLabel: 'Project', unknownRotation: false, activeFrom: 0,
    };
    await store.putCredential(epoch);
    now = START + 1;
    const relabelled = await store.putCredential({ ...epoch, label: 'New label' });
    assert.deepEqual([relabelled.version, relabelled.label, relabelled.scopeLabel], [1, 'New label', 'Project']);
    assert.deepEqual(
      (await store.listCredentials('openai')).map(({ version, label, scopeLabel }) => ({ version, label, scopeLabel })),
      [{ version: 1, label: 'New label', scopeLabel: 'Project' }],
    );
    now = START + 2;
    await store.putCredential({ ...epoch, label: 'New label' });
    now = START + 3;
    await store.putCredential(epoch);
    assert.deepEqual(
      (await store.listUsageAuditEvents())
        .filter(({ eventType }) => eventType === 'usage.credential_relabeled')
        .map(({ subjectId, subjectVersion, createdAt }) => ({ subjectId, subjectVersion, createdAt }))
        .sort((left, right) => left.createdAt - right.createdAt),
      [
        { subjectId: 'platform:openai', subjectVersion: 1, createdAt: START + 1 },
        { subjectId: 'platform:openai', subjectVersion: 1, createdAt: START + 3 },
      ],
      'one event per relabel, none for the same label again',
    );
    for (const changed of [
      { scopeLabel: 'Another project' },
      { scopeLabel: null },
      { sourceKind: 'stored' as const },
      { unknownRotation: true },
      { activeFrom: 1 },
    ]) {
      await assert.rejects(
        store.putCredential({ ...epoch, ...changed }),
        (error: unknown) => error instanceof UsageStateError && error.code === 'usage_credential_conflict',
        JSON.stringify(changed),
      );
    }
  } finally {
    store.close();
  }
});

test('a measurement keeps the billing run key its charges carry, and a replay only fills a missing one', async () => {
  const store = new SqliteUsageStore(':memory:');
  try {
    await store.admitOperation(operation('op_keyed'));
    const keyed = await store.recordTerminal(terminal('op_keyed', { billingRunId: 'sub_ik_keyed' }));
    assert.equal(keyed.measurements[0]?.billingRunId, 'sub_ik_keyed');
    for (const replay of [{}, { billingRunId: null }, { billingRunId: 'sub_ik_other' }]) {
      const replayed = await store.recordTerminal(terminal('op_keyed', replay));
      assert.equal(replayed.measurements[0]?.billingRunId, 'sub_ik_keyed', `a replay with ${JSON.stringify(replay)} keeps the first key`);
    }

    await store.admitOperation(operation('op_unkeyed'));
    assert.equal((await store.recordTerminal(terminal('op_unkeyed'))).measurements[0]?.billingRunId, null);
    const filled = await store.recordTerminal(terminal('op_unkeyed', { billingRunId: 'sub_ik_late' }));
    assert.equal(filled.measurements[0]?.billingRunId, 'sub_ik_late');

    await store.admitOperation(operation('op_bad_key'));
    await assert.rejects(
      store.recordTerminal(terminal('op_bad_key', { billingRunId: 'sub ik/1' })),
      (error: unknown) => error instanceof UsageStateError && error.code === 'usage_invalid_input',
    );
  } finally {
    store.close();
  }
});

test('a usage store created before billing run keys gains the column in place and fills it on replay', () => {
  const db = openStateDb(':memory:');
  try {
    const before = new UsageStoreLogic(db);
    before.admitOperation(operation('op_before_keys'));
    before.recordTerminal(terminal('op_before_keys'));
    db.exec('ALTER TABLE usage_measurements DROP COLUMN billing_run_id');

    const upgraded = new UsageStoreLogic(db);
    const column = db.all('PRAGMA table_info(usage_measurements)').find((row) => row.name === 'billing_run_id');
    assert.deepEqual([column?.type, column?.notnull, column?.dflt_value], ['TEXT', 0, null], 'added nullable, with no default');
    assert.equal(upgraded.getOperation('op_before_keys')?.measurements[0]?.billingRunId, null);
    const replayed = upgraded.recordTerminal(terminal('op_before_keys', { billingRunId: 'sub_ik_after_upgrade' }));
    assert.equal(replayed.measurements[0]?.billingRunId, 'sub_ik_after_upgrade');
  } finally {
    db.close();
  }
});

test('activity attributions list public customer work in range, oldest first, with its model, estimate and run keys', async () => {
  const store = new SqliteUsageStore(':memory:');
  const priced = (micros: number): Partial<RecordUsageTerminalInput> => ({
    estimateCompleteness: 'complete', estimateAmountMicros: micros, estimateCurrency: 'USD',
    priceVersionId: 'openai-2026-07', priceUnknownReason: null,
  });
  try {
    // A turn whose coding worker ran on another model under the same submission.
    await store.admitOperation(operation('op_turn', { startedAt: START + 10, requesterMembershipId: 'membership_maya' }));
    await store.recordTerminal(terminal('op_turn', {
      executionId: 'exec_turn:coding:1', observedAt: START + 500, finishedAt: START + 500,
      returnedModel: 'gpt-5-codex', billingRunId: 'sub_ik_turn', ...priced(400),
    }));
    await store.recordTerminal(terminal('op_turn', { billingRunId: 'sub_ik_turn', ...priced(1_000) }));
    // A routine retried: one submission per attempt; the second attempt returned no model.
    await store.admitOperation(operation('op_routine', {
      operationKind: 'routine_run', startedAt: START, routineId: 'routine_daily', routineLabel: 'Daily', routineRunId: 'op_routine',
      requesterMembershipId: 'membership_maya',
    }));
    // Priced in another currency, which a USD estimate cannot add.
    await store.recordTerminal(terminal('op_routine', {
      executionId: 'exec_routine:1', billingRunId: 'sub_ik_attempt_1', ...priced(700), estimateCurrency: 'EUR',
    }));
    await store.recordTerminal(terminal('op_routine', {
      executionId: 'exec_routine:2', observedAt: START + 3_000, finishedAt: START + 3_000, billingRunId: 'sub_ik_attempt_2',
      returnedProvider: null, returnedModel: null, requestedModel: 'gpt-4.1',
      usageCompleteness: 'not_reported', inputTokens: null, outputTokens: null, totalTokens: null,
      usageUnknownReason: 'provider_request_unknown',
    }));
    // A turn still running: no measurement yet.
    await store.admitOperation(operation('op_running', { startedAt: START + 20, agentId: null, requesterMembershipId: null }));
    // A test run of an Agent, charged as its caller's direct message.
    await store.admitOperation(operation('op_test_run', {
      operationKind: 'test_turn', startedAt: START + 30, conversationKind: 'direct_message', channelId: null, channelLabel: null,
      requesterMembershipId: 'membership_maya',
    }));
    await store.recordTerminal(terminal('op_test_run', { billingRunId: 'sub_ik_test_run', ...priced(250) }));
    // Never listed: a private routine, an internal classification, and work outside the range.
    await store.admitOperation(operation('op_private_routine', {
      operationKind: 'routine_run', conversationKind: 'direct_message', channelLabel: null,
      routineId: 'routine_private', routineLabel: 'Mine', routineRunId: 'op_private_routine',
    }));
    await store.recordTerminal(terminal('op_private_routine', { billingRunId: 'sub_ik_private' }));
    await store.admitOperation(operation('op_classify', { operationKind: 'interaction_classification' }));
    await store.admitOperation(operation('op_before', { startedAt: START - 1 }));
    await store.admitOperation(operation('op_after', { startedAt: START + 60_000 }));

    assert.deepEqual(await store.listActivityAttributions({ from: START, to: START + 60_000 }), [
      {
        operationId: 'op_routine', operationKind: 'routine_run', startedAt: START, agentId: 'agent_default',
        requesterMembershipId: 'membership_maya', model: 'openai/gpt-4.1', estimateMicros: null,
        billingRunIds: ['sub_ik_attempt_1', 'sub_ik_attempt_2'],
      },
      {
        operationId: 'op_turn', operationKind: 'interactive_turn', startedAt: START + 10, agentId: 'agent_default',
        requesterMembershipId: 'membership_maya', model: 'openai/gpt-4.1-mini-2025-04-14', estimateMicros: 1_400,
        billingRunIds: ['sub_ik_turn'],
      },
      {
        operationId: 'op_running', operationKind: 'interactive_turn', startedAt: START + 20, agentId: null,
        requesterMembershipId: null, model: 'openai/gpt-4.1-mini', estimateMicros: null, billingRunIds: [],
      },
      {
        operationId: 'op_test_run', operationKind: 'test_turn', startedAt: START + 30, agentId: 'agent_default',
        requesterMembershipId: 'membership_maya', model: 'openai/gpt-4.1-mini-2025-04-14', estimateMicros: 250,
        billingRunIds: ['sub_ik_test_run'],
      },
    ]);

    for (const range of [{ from: START, to: START }, { from: START, to: START + 367 * 86_400_000 }]) {
      await assert.rejects(
        store.listActivityAttributions(range),
        (error: unknown) => error instanceof UsageStateError && error.code === 'usage_query_invalid',
      );
    }
  } finally {
    store.close();
  }
});
