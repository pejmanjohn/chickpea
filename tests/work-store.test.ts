import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AuditStoreLogic } from '../src/audit/store.ts';
import { RoutineStoreLogic } from '../src/routines/store.ts';
import { UsageStoreLogic } from '../src/usage/store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { SqlParam, StateDb } from '../src/state/state-db.ts';
import { installWorkMigrations } from '../src/work/migrations.ts';
import { WorkStoreLogic } from '../src/work/store.ts';
import {
  WorkStateError,
  type BindingId,
  type CreateWorkGraphInput,
  type EffectiveConfigRevisionId,
  type RunExecutionId,
  type RunId,
  type SafeEffectiveConfigInput,
  type WorkId,
} from '../src/work/types.ts';

const NOW = 1_800_000_000_000;

function safeConfig(overrides: Partial<SafeEffectiveConfigInput> = {}): SafeEffectiveConfigInput {
  return {
    schemaVersion: 1,
    profileId: 'profile_default',
    configuredModel: 'openai/gpt-5.6-sol',
    snapshotDigest: 'a'.repeat(64),
    capabilityDigest: 'b'.repeat(64),
    skillNames: ['github', 'asana'],
    connectionIds: ['github_main'],
    repositoryIds: ['repo_main'],
    memoryMode: 'mixed',
    ceilings: {
      maxModelAttempts: 3,
      maxToolCalls: 20,
      maxActionAttempts: 5,
      timeoutMs: 120_000,
    },
    ...overrides,
  };
}

function graph(
  configRevisionId: EffectiveConfigRevisionId,
  suffix = 'alpha',
): CreateWorkGraphInput {
  const workId = `work_${suffix}` as WorkId;
  const bindingId = `binding_${suffix}` as BindingId;
  const runId = `run_${suffix}` as RunId;
  return {
    work: {
      id: workId,
      kind: 'conversation',
      maximumSensitivity: 'public',
      createdAt: NOW,
    },
    binding: {
      id: bindingId,
      workId,
      adapterKind: 'slack',
      externalAccountId: `T_${suffix}`,
      externalConversationId: `C_${suffix}`,
      generation: 1,
      sourceVisibility: 'public',
      configMode: 'frozen_on_open',
      pinnedConfigRevisionId: configRevisionId,
      orderingKey: `slack:T_${suffix}:C_${suffix}`,
      createdAt: NOW,
    },
    run: {
      id: runId,
      workId,
      bindingId,
      kind: 'interactive',
      admissionSequence: 1,
      triggerKind: 'app_mention',
      triggerRef: `event:E_${suffix}`,
      dedupeKey: `slack:event:E_${suffix}`,
      actorRef: `U_${suffix}`,
      actorTrustTier: 'member',
      sourceContextWatermark: `ts:${NOW}`,
      configRevisionId,
      effectiveCapabilityDigest: 'b'.repeat(64),
      executionAuthority: 'legacy',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
      createdAt: NOW,
    },
    auditEventId: `work:admit:${suffix}`,
    auditIdempotencyKey: `work:admit:${suffix}`,
  };
}

test('Work migrations install the six product tables without a Session table or Work leases', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec('CREATE TABLE existing_application_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run(
      'INSERT INTO existing_application_state (id, value) VALUES (?, ?)',
      'before-work-ledger',
      'preserved',
    );
    new WorkStoreLogic(db, { now: () => NOW });
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => String(row.name));
    for (const table of [
      'works',
      'bindings',
      'runs',
      'run_executions',
      'effective_config_revisions',
      'ledger_content',
    ]) assert.ok(tables.includes(table), table);
    assert.equal(tables.includes('sessions'), false);
    assert.equal(
      db.get('SELECT value FROM existing_application_state WHERE id = ?', 'before-work-ledger')
        ?.value,
      'preserved',
    );
    const workColumns = db.all('PRAGMA table_info(works)').map((row) => String(row.name));
    assert.equal(workColumns.some((name) => /lease|executor/.test(name)), false);
    assert.deepEqual(
      db
        .all("SELECT version FROM app_migrations WHERE domain = 'work' ORDER BY version")
        .map((row) => Number(row.version)),
      [1, 2],
    );
  } finally {
    db.close();
  }
});

test('a fresh database gets every ledger link column whichever store opens it first', () => {
  const db = openStateDb(':memory:');
  try {
    // The Work migration that owns the cross-domain link columns runs first
    // and finds nothing to link — the Routine and Usage tables do not exist
    // yet — but is still recorded as applied and never runs again. Each later
    // store therefore has to install the links it needs itself.
    new WorkStoreLogic(db, { now: () => NOW });
    assert.deepEqual(
      db
        .all("SELECT version FROM app_migrations WHERE domain = 'work' ORDER BY version")
        .map((row) => Number(row.version)),
      [1, 2],
    );
    new RoutineStoreLogic(db, () => NOW);
    new UsageStoreLogic(db, () => NOW);
    for (const [table, column] of [
      ['routines', 'work_id'],
      ['routines', 'binding_id'],
      ['routine_runs', 'canonical_run_id'],
      ['usage_operations', 'run_id'],
      ['usage_measurements', 'run_execution_id'],
    ] as const) {
      const columns = db.all(`PRAGMA table_info(${table})`).map((row) => String(row.name));
      assert.ok(columns.includes(column), `${table}.${column}`);
    }
    // Fresh tables declare the link columns inline, so only the indexes prove
    // the shared install actually ran for each domain.
    const indexes = db
      .all("SELECT name FROM sqlite_master WHERE type = 'index'")
      .map((row) => String(row.name));
    for (const index of [
      'routines_work_link_unique',
      'routines_binding_link_unique',
      'routine_runs_canonical_link_unique',
      'usage_operations_run_idx',
      'usage_measurements_run_execution_idx',
    ]) assert.ok(indexes.includes(index), index);
  } finally {
    db.close();
  }
});

test('each Work migration statement and marker is crash-atomic and retryable', () => {
  const countDb = openStateDb(':memory:');
  let operationCount = 0;
  const counting = interceptMigrationWrites(countDb, () => {
    operationCount += 1;
  });
  installWorkMigrations(counting);
  countDb.close();

  for (let failAt = 2; failAt <= operationCount; failAt += 1) {
    const db = openStateDb(':memory:');
    let operation = 0;
    let injected = false;
    const faulted = interceptMigrationWrites(db, () => {
      operation += 1;
      if (!injected && operation === failAt) {
        injected = true;
        throw new Error(`injected migration failure ${failAt}`);
      }
    });
    assert.throws(() => installWorkMigrations(faulted), /injected migration failure/);
    const applied = db
      .all("SELECT version FROM app_migrations WHERE domain = 'work' ORDER BY version")
      .map((row) => Number(row.version));
    if (!applied.includes(1)) {
      assert.equal(
        db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'works'"),
        undefined,
      );
    } else {
      assert.deepEqual(applied, [1]);
      assert.ok(
        db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'works'"),
      );
    }
    installWorkMigrations(faulted);
    assert.deepEqual(
      db
        .all("SELECT version FROM app_migrations WHERE domain = 'work' ORDER BY version")
        .map((row) => Number(row.version)),
      [1, 2],
    );
    db.close();
  }
});

test('concurrent Node openers converge on one complete Work schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-work-migration-'));
  const path = join(directory, 'state.sqlite');
  try {
    const source = `
      import { SqliteWorkStore } from './src/work/store.ts';
      const store = new SqliteWorkStore(${JSON.stringify(path)});
      const integrity = await store.verifyIntegrity();
      if (!integrity.foreignKeysEnabled || integrity.foreignKeyViolationCount !== 0) process.exit(2);
      store.close();
    `;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runChild([
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        source,
      ])),
    );
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
    const db = openStateDb(path);
    assert.deepEqual(
      db
        .all("SELECT version FROM app_migrations WHERE domain = 'work' ORDER BY version")
        .map((row) => Number(row.version)),
      [1, 2],
    );
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('safe configuration canonicalizes equivalent policy and rejects unknown or secret-bearing input', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const first = store.putConfigRevision(safeConfig(), NOW);
    const equivalent = store.putConfigRevision(
      safeConfig({
        skillNames: ['asana', 'github', 'asana'],
        repositoryIds: ['repo_main', 'repo_main'],
      }),
      NOW + 1,
    );
    assert.equal(equivalent.id, first.id);
    assert.equal(equivalent.canonicalJson, first.canonicalJson);
    assert.deepEqual(JSON.parse(first.canonicalJson).skillNames, ['asana', 'github']);

    for (const configuredModel of [
      'cloudflare/@cf/zai-org/glm-5.2',
      'openrouter/openai/gpt-4.1',
    ]) {
      const nested = store.putConfigRevision(safeConfig({ configuredModel }), NOW + 1);
      assert.equal(JSON.parse(nested.canonicalJson).configuredModel, configuredModel);
    }

    for (const configuredModel of [
      'https://models.example.invalid/private',
      'cloudflare//glm-5.2',
      'cloudflare/@cf/../glm-5.2',
      'cloudflare/@cf/zai-org/glm-5.2/',
    ]) {
      assert.throws(
        () => store.putConfigRevision(safeConfig({ configuredModel }), NOW + 1),
        (error: unknown) =>
          error instanceof WorkStateError &&
          (error.code === 'work_config_invalid' || error.code === 'work_secret_rejected'),
      );
    }

    assert.throws(
      () => store.putConfigRevision({ ...safeConfig(), apiKey: 'sk-not-allowed' } as never),
      (error: unknown) =>
        error instanceof WorkStateError && error.code === 'work_input_invalid',
    );
    assert.throws(
      () => store.putConfigRevision(
        safeConfig({ connectionIds: ['https://example.com/private'] }),
      ),
      (error: unknown) =>
        error instanceof WorkStateError && error.code === 'work_secret_rejected',
    );

    db.run(
      `UPDATE effective_config_revisions SET canonical_json = ? WHERE id = ?`,
      '{"different":true}',
      first.id,
    );
    assert.throws(
      () => store.putConfigRevision(safeConfig()),
      (error: unknown) =>
        error instanceof WorkStateError && error.code === 'work_config_digest_conflict',
    );
  } finally {
    db.close();
  }
});

test('graph admission is atomic, idempotent, and relationally constrained', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const config = store.putConfigRevision(safeConfig());
    const input = graph(config.id);
    const created = store.createGraph(input);
    assert.equal(created.run.status, 'admitted');
    assert.equal(created.run.executionAuthority, 'legacy');
    assert.deepEqual(store.createGraph(input), created);
    assert.equal(store.listAuditEvents(created.run.id).length, 1);

    const conflicting = graph(config.id, 'beta');
    conflicting.binding.externalAccountId = input.binding.externalAccountId;
    conflicting.binding.externalConversationId = input.binding.externalConversationId;
    assert.throws(() => store.createGraph(conflicting), /UNIQUE constraint failed/);
    assert.equal(store.getWork(conflicting.work.id), undefined);

    db.run(
      `INSERT INTO works (
        id, kind, lifecycle, maximum_sensitivity, created_at, updated_at, closed_at
      ) VALUES ('work_foreign', 'conversation', 'open', 'public', ?, ?, NULL)`,
      NOW,
      NOW,
    );
    assert.throws(
      () => db.run(
        `INSERT INTO runs (
          id, work_id, binding_id, kind, admission_sequence, trigger_kind, trigger_ref,
          dedupe_key, actor_trust_tier, config_revision_id, effective_capability_digest,
          execution_authority, coordinator_kind, authority_epoch, status,
          delivery_status, fencing_token, created_at, updated_at
        ) VALUES (
          'run_foreign', 'work_foreign', ?, 'interactive', 2, 'app_mention',
          'event:foreign', 'event:foreign', 'member', ?, ?, 'legacy', 'interactive',
          1, 'admitted', 'not_ready', 0, ?, ?
        )`,
        input.binding.id,
        config.id,
        'b'.repeat(64),
        NOW,
        NOW,
      ),
      /FOREIGN KEY constraint failed/,
    );
    assert.deepEqual(store.verifyIntegrity(), {
      foreignKeysEnabled: true,
      foreignKeyViolationCount: 0,
      invariantViolationCount: 0,
    });
  } finally {
    db.close();
  }
});

test('runtime drain count includes only executing Runs', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const config = store.putConfigRevision(safeConfig());
    const executing = store.createGraph(graph(config.id, 'drain-executing')).run;
    store.createGraph(graph(config.id, 'drain-admitted'));
    store.prepareRunInput({
      runId: executing.id,
      sensitivity: 'public',
      body: 'Runtime drain proof input',
      preparedAt: NOW + 1,
    });
    db.run("UPDATE runs SET status = 'executing' WHERE id = ?", executing.id);

    assert.equal(store.countExecutingRuns(), 1);
  } finally {
    db.close();
  }
});

test('an audit write failure rolls the local Work graph back and a retry records one event', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const config = store.putConfigRevision(safeConfig());
    const input = graph(config.id, 'rollback');
    new AuditStoreLogic(db).append({
      eventId: input.auditEventId,
      domain: 'work',
      eventType: 'work.run_admitted',
      outcome: 'success',
      actorClass: 'system',
      subjectId: 'run_existing',
      createdAt: NOW,
      metadataJson: JSON.stringify({
        bindingId: 'binding_existing',
        runId: 'run_existing',
        workId: 'work_existing',
      }),
      idempotencyKey: 'work:existing:audit',
    });
    assert.throws(() => store.createGraph(input), /UNIQUE constraint failed/);
    assert.equal(store.getWork(input.work.id), undefined);
    db.run('DELETE FROM audit_events WHERE event_id = ?', input.auditEventId);
    const retried = store.createGraph(input);
    assert.equal(retried.run.id, input.run.id);
    assert.equal(store.listAuditEvents(input.run.id).length, 1);
  } finally {
    db.close();
  }
});

test('private content follows the Work sensitivity ceiling and unknown authority stores no body', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const config = store.putConfigRevision(safeConfig());
    const canary = 'PRIVATE_WORK_CANARY_7f2614';
    const content = store.putContent({
      sensitivity: 'private',
      body: canary,
      createdAt: NOW,
    });
    const invalid = graph(config.id, 'private_invalid');
    invalid.run.triggerContentRef = content.ref;
    assert.throws(
      () => store.createGraph(invalid),
      (error: unknown) => {
        assert.doesNotMatch(error instanceof Error ? error.message : String(error), /PRIVATE_WORK_CANARY/);
        return error instanceof WorkStateError && error.code === 'work_sensitivity_invalid';
      },
    );
    assert.equal(store.getWork(invalid.work.id), undefined);

    const unknown = graph(config.id, 'unknown_private');
    unknown.work.maximumSensitivity = 'private';
    unknown.binding.sourceVisibility = 'unknown';
    unknown.run.actorTrustTier = 'unknown';
    unknown.run.actorRef = null;
    unknown.run.triggerContentRef = content.ref;
    assert.throws(
      () => store.createGraph(unknown),
      (error: unknown) =>
        error instanceof WorkStateError && error.code === 'work_content_forbidden',
    );

    const valid = graph(config.id, 'private_valid');
    valid.work.maximumSensitivity = 'private';
    valid.binding.sourceVisibility = 'private';
    valid.run.triggerContentRef = content.ref;
    const created = store.createGraph(valid);
    assert.equal(created.work.maximumSensitivity, 'private');
    assert.doesNotMatch(
      JSON.stringify({
        config: store.getConfigRevision(config.id),
        events: store.listAuditEvents(created.run.id),
      }),
      /PRIVATE_WORK_CANARY/,
    );
  } finally {
    db.close();
  }
});

test('RunExecution keeps route evidence immutable and rejects internal or secret fields', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const config = store.putConfigRevision(safeConfig());
    const admitted = store.createGraph(graph(config.id, 'route'));
    const prepared = store.putContent({
      sensitivity: 'public',
      body: 'prepared input',
      createdAt: NOW,
    });
    db.run(
      `UPDATE runs SET status = 'input_ready', prepared_input_ref = ?, updated_at = ?
       WHERE id = ?`,
      prepared.ref,
      NOW,
      admitted.run.id,
    );
    const executionId = 'execution_route' as RunExecutionId;
    const execution = store.createRunExecution({
      id: executionId,
      runId: admitted.run.id,
      attemptNumber: 1,
      fencingToken: 1,
      executorKind: 'agent',
      agentName: 'slack-thread',
      canonicalModel: 'openai/gpt-5.6-sol',
      startedAt: NOW + 1,
    });
    assert.equal(execution.modelInvocationStatus, 'not_invoked');
    const route = store.recordRunExecutionRoute({
      executionId,
      recordedAt: NOW + 1,
      providerAuthRoute: 'openai_subscription',
      catalogSource: 'bundled',
      catalogRevision: 'revision:0',
      catalogDigest: 'c'.repeat(64),
      compiledProfile: 'openai-codex-responses-standard@1',
      modelCredentialRef: 'openai_subscription_installation',
      modelCredentialVersion: 1,
    });
    assert.equal(route.modelInvocationStatus, 'ready');
    assert.equal(route.providerAuthRoute, 'openai_subscription');
    assert.equal(
      store.recordRunExecutionRoute({
        executionId,
        recordedAt: NOW + 1,
        providerAuthRoute: 'openai_subscription',
        catalogSource: 'bundled',
        catalogRevision: 'revision:0',
        catalogDigest: 'c'.repeat(64),
        compiledProfile: 'openai-codex-responses-standard@1',
        modelCredentialRef: 'openai_subscription_installation',
        modelCredentialVersion: 1,
      }).id,
      executionId,
    );
    assert.throws(
      () => store.recordRunExecutionRoute({
        executionId,
        recordedAt: NOW + 1,
        providerAuthRoute: 'openai_api_key',
        modelCredentialRef: 'openai_platform',
        modelCredentialVersion: 1,
      }),
      (error: unknown) =>
        error instanceof WorkStateError && error.code === 'work_route_conflict',
    );

    const nextId = 'execution_secret' as RunExecutionId;
    db.run(
      `UPDATE runs SET status = 'input_ready', updated_at = ? WHERE id = ?`,
      NOW + 2,
      admitted.run.id,
    );
    store.createRunExecution({
      id: nextId,
      runId: admitted.run.id,
      attemptNumber: 2,
      fencingToken: 2,
      executorKind: 'agent',
      agentName: 'slack-thread',
      canonicalModel: 'openai/gpt-5.6-sol',
      startedAt: NOW + 2,
    });
    assert.throws(
      () => store.recordRunExecutionRoute({
        executionId: nextId,
        recordedAt: NOW + 2,
        providerAuthRoute: 'openai_api_key',
        modelCredentialRef: 'sk-secret-value',
        modelCredentialVersion: 1,
      }),
      WorkStateError,
    );
    assert.throws(
      () => store.recordRunExecutionRoute({
        executionId: nextId,
        recordedAt: NOW + 2,
        providerAuthRoute: 'openai_api_key',
        transportMarker: 'internal',
      } as never),
      WorkStateError,
    );

    const audit = new AuditStoreLogic(db);
    const actionMetadata = {
      actionAttemptId: 'action_route_1',
      actionClass: 'repository_read',
      flueCorrelation: 'tool_call_route_1',
      runExecutionId: executionId,
      runId: admitted.run.id,
      status: 'started',
      targetKind: 'github_repository',
    };
    audit.append({
      eventId: 'work:action:route:started',
      domain: 'work',
      eventType: 'work.action_started',
      outcome: 'requested',
      actorClass: 'system',
      subjectId: admitted.run.id,
      createdAt: NOW + 3,
      metadataJson: JSON.stringify(actionMetadata),
      idempotencyKey: 'work:action:route:started',
    });
    audit.append({
      eventId: 'work:action:route:succeeded',
      domain: 'work',
      eventType: 'work.action_succeeded',
      outcome: 'success',
      actorClass: 'system',
      subjectId: admitted.run.id,
      createdAt: NOW + 4,
      metadataJson: JSON.stringify({ ...actionMetadata, status: 'succeeded' }),
      idempotencyKey: 'work:action:route:succeeded',
    });
    assert.throws(
      () => audit.append({
        eventId: 'work:action:route:invalid',
        domain: 'work',
        eventType: 'work.action_failed',
        outcome: 'failure',
        actorClass: 'system',
        subjectId: admitted.run.id,
        createdAt: NOW + 5,
        metadataJson: JSON.stringify({
          ...actionMetadata,
          status: 'failed',
          connectorArguments: { repository: 'private' },
        }),
        idempotencyKey: 'work:action:route:invalid',
      }),
      /metadata shape is invalid/,
    );
    assert.equal(store.verifyIntegrity().invariantViolationCount, 0);
  } finally {
    db.close();
  }
});

test('recovery quarantine is terminal, idempotent, body-free, and atomic with audit', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const config = store.putConfigRevision(safeConfig());
    const run = store.createGraph(graph(config.id, 'recovery')).run;
    store.requireRecovery({
      runId: run.id,
      safeFailureCode: 'delivery_outcome_unknown',
      at: NOW + 1,
      auditEventId: 'work:recovery:recovery',
      auditIdempotencyKey: 'work:recovery:recovery',
    });
    const input = {
      runId: run.id,
      adminCredentialId: 'admin_credential_primary',
      operatorLabel: 'Release operator',
      authOrigin: 'admin_session' as const,
      safeReasonCode: 'accepted_unknown' as const,
      requestId: 'request_quarantine_recovery',
      idempotencyKey: 'work:quarantine:recovery',
      resolvedAt: NOW + 2,
    };
    const quarantined = store.quarantineRun(input);
    assert.equal(quarantined.status, 'settled');
    assert.equal(quarantined.terminalDisposition, 'quarantined');
    assert.equal(quarantined.safeFailureCode, 'delivery_outcome_unknown');
    assert.equal(store.quarantineRun(input).id, run.id);
    const events = store.listAuditEvents(run.id);
    assert.equal(events.filter(({ eventType }) => eventType === 'work.run_quarantined').length, 1);
    assert.doesNotMatch(events.map(({ metadataJson }) => metadataJson).join(' '), /payload|body|message/i);
    assert.throws(
      () => store.quarantineRun({ ...input, requestId: 'request_conflict' }),
      (error: unknown) =>
        error instanceof WorkStateError && error.code === 'work_recovery_conflict',
    );
    assert.throws(
      () => store.quarantineRun({ ...input, arbitraryMetadata: { body: 'secret' } } as never),
      WorkStateError,
    );
  } finally {
    db.close();
  }
});

test('Routine compatibility links preserve coordinator admission and project canonical route evidence', () => {
  const db = openStateDb(':memory:');
  try {
    const routines = new RoutineStoreLogic(db, () => NOW);
    const routine = routines.save({
      actorId: 'U_ROUTINE',
      actorClass: 'member',
      workspaceId: 'T_ROUTINE',
      channelId: 'C_ROUTINE',
      draft: {
        action: 'create',
        routineId: 'routine_linked',
        definition: {
          name: 'Linked routine',
          description: 'Proves canonical Work correlation.',
          taskText: 'Inspect the approved source and report the result.',
          triggerKind: 'schedule',
          scheduleInput: 'Every day at 9am',
          scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 9 * * *' }),
          timezone: 'America/Los_Angeles',
          outputPolicy: 'post',
          authorityMode: 'live_channel_v1',
        },
        nextRunAt: NOW + 60 * 60 * 1_000,
        projectedDailyStarts: 1,
        reservations: [{ windowStart: NOW + 60 * 60 * 1_000, count: 1 }],
      },
      idempotencyKey: 'routine:linked:create',
    });
    const occurrence = routines.createOccurrence({
      runId: 'rrun_linked',
      idempotencyKey: 'routine:linked:slot',
      routineId: routine.id,
      routineVersion: routine.version,
      scheduledFor: NOW + 60 * 60 * 1_000,
      triggerSource: 'schedule',
      queuedAt: NOW,
      deadlineAt: NOW + 15 * 60 * 1_000,
    });
    const work = new WorkStoreLogic(db, { now: () => NOW });
    const config = work.putConfigRevision(safeConfig());
    const input = graph(config.id, 'routine_linked');
    input.work.kind = 'routine';
    input.binding.adapterKind = 'routine';
    input.run.kind = 'routine';
    input.run.coordinatorKind = 'flue_workflow';
    const canonical = work.createGraph(input);
    db.run(
      'UPDATE routines SET work_id = ?, binding_id = ? WHERE id = ?',
      canonical.work.id,
      canonical.binding.id,
      routine.id,
    );
    db.run(
      'UPDATE routine_runs SET canonical_run_id = ? WHERE id = ?',
      canonical.run.id,
      occurrence.id,
    );
    assert.equal(
      db.get('SELECT COUNT(*) AS count FROM run_executions WHERE run_id = ?', canonical.run.id)?.count,
      0,
    );
    const prepared = work.putContent({
      sensitivity: 'public',
      body: 'prepared routine input',
      createdAt: NOW,
    });
    db.run(
      `UPDATE runs SET status = 'input_ready', prepared_input_ref = ?, updated_at = ?
       WHERE id = ?`,
      prepared.ref,
      NOW + 1,
      canonical.run.id,
    );
    const executionId = 'execution_routine_linked' as RunExecutionId;
    work.createRunExecution({
      id: executionId,
      runId: canonical.run.id,
      attemptNumber: 1,
      fencingToken: 1,
      executorKind: 'workflow',
      agentName: 'routine-runner',
      canonicalModel: 'openai/gpt-5.6-sol',
      startedAt: NOW + 2,
    });
    work.recordRunExecutionRoute({
      executionId,
      recordedAt: NOW + 1,
      providerAuthRoute: 'openai_subscription',
      catalogSource: 'bundled',
      catalogRevision: 'revision:0',
      catalogDigest: 'c'.repeat(64),
      compiledProfile: 'openai-codex-responses-standard@1',
      modelCredentialRef: 'openai_subscription_installation',
      modelCredentialVersion: 1,
    });
    assert.equal(routines.getRoutine(routine.id)?.workId, canonical.work.id);
    assert.equal(routines.getRun(occurrence.id)?.canonicalRunId, canonical.run.id);
    assert.equal(routines.getRun(occurrence.id)?.providerAuthRoute, 'openai_subscription');
    assert.equal(work.verifyIntegrity().invariantViolationCount, 0);
  } finally {
    db.close();
  }
});

function interceptMigrationWrites(db: StateDb, beforeWrite: () => void): StateDb {
  return {
    run(sql: string, ...params: SqlParam[]) {
      beforeWrite();
      return db.run(sql, ...params);
    },
    get: (sql: string, ...params: SqlParam[]) => db.get(sql, ...params),
    all: (sql: string, ...params: SqlParam[]) => db.all(sql, ...params),
    exec(sql: string) {
      beforeWrite();
      db.exec(sql);
    },
    transaction: <T>(fn: () => T) => db.transaction(fn),
  };
}

function runChild(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}
