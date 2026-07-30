import { getRun, invoke, listRuns } from '@flue/runtime';
import {
  DurableObject,
  type DurableObjectState,
  type DurableObjectStorage,
} from 'cloudflare:workers';

import routineSpike from './workflows/routine-spike.ts';
import { hashRoutineValue } from '../../../../src/routines/ids.ts';
import { RoutineStoreLogic } from '../../../../src/routines/store.ts';
import { WorkStoreLogic } from '../../../../src/work/store.ts';
import type {
  BindingId,
  RunId,
  WorkId,
} from '../../../../src/work/types.ts';
import type { SqlParam, StateDb } from '../../../../src/state/state-db.ts';

interface SpikeScheduledController {
  scheduledTime: number;
}

const VISIBILITY_TIMEOUT_MS = 5_000;

export default {
  async scheduled(controller: SpikeScheduledController): Promise<void> {
    const admittedAt = Date.now();
    const receipt = await invoke(routineSpike, {
      input: {
        occurrenceId: `scheduled-${controller.scheduledTime}`,
        scheduledAt: new Date(controller.scheduledTime).toISOString(),
      },
    });

    let record = await getRun(receipt.runId);
    let listed = false;
    while (Date.now() - admittedAt < VISIBILITY_TIMEOUT_MS) {
      const page = await listRuns({ workflowName: 'routine-spike', limit: 100 });
      listed = page.runs.some((run) => run.runId === receipt.runId);
      record ??= await getRun(receipt.runId);
      if (listed && record) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    console.log(
      'ROUTINE_SPIKE_RECEIPT',
      JSON.stringify({
        runId: receipt.runId,
        visibilityMs: Date.now() - admittedAt,
        listed,
        recordVisible: Boolean(record),
      }),
    );
  },
};

class SpikeStateDb implements StateDb {
  constructor(private readonly storage: DurableObjectStorage) {}

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    this.storage.sql.exec(sql, ...params).toArray();
    return { changes: Number(this.storage.sql.exec('SELECT changes() AS changes').one().changes) };
  }
  get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined {
    return this.storage.sql.exec(sql, ...params).toArray()[0];
  }
  all(sql: string, ...params: SqlParam[]): Record<string, unknown>[] {
    return this.storage.sql.exec(sql, ...params).toArray();
  }
  exec(sql: string): void {
    this.storage.sql.exec(sql).toArray();
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

/** Runs the production RoutineStoreLogic over real Durable Object SQLite. */
export class RoutineStateSpike extends DurableObject {
  private readonly db: SpikeStateDb;
  private readonly routines: RoutineStoreLogic;
  private readonly work: WorkStoreLogic;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.db = new SpikeStateDb(ctx.storage);
    this.routines = new RoutineStoreLogic(this.db);
    this.work = new WorkStoreLogic(this.db, { now: () => 1_800_000_000_000 });
  }

  exercise(suffix: string, at: number): {
    routineId: string;
    version: number;
    auditCount: number;
    revisionCount: number;
    foreignKeysEnabled: boolean;
    orphanRejected: boolean;
    foreignKeyViolationCount: number;
    workRunStatus: string;
    workInvariantViolationCount: number;
  } {
    const routineId = `routine_workerd_${suffix}`;
    const tokenHash = hashRoutineValue(`token-${suffix}`);
    const draft = {
      action: 'create' as const,
      routineId,
      definition: {
        name: 'Workerd state parity',
        description: 'Target-neutral Durable Object storage probe.',
        taskText: 'Inspect the current channel state.',
        triggerKind: 'schedule' as const,
        scheduleInput: 'Every hour',
        scheduleJson: JSON.stringify({ kind: 'cron', expression: '0 * * * *' }),
        timezone: 'UTC',
        outputPolicy: 'post' as const,
        authorityMode: 'live_channel_v1' as const,
      },
      nextRunAt: at + 60 * 60 * 1_000,
      projectedDailyStarts: 24,
      reservations: [{ windowStart: at + 60 * 60 * 1_000, count: 1 }],
    };
    const previewHash = hashRoutineValue(JSON.stringify(draft));
    this.routines.putConfirmation({
      confirmationId: `rconfirm_workerd_${suffix}`,
      tokenHash,
      actorId: 'U_WORKERD',
      actorClass: 'member',
      workspaceId: 'T_WORKERD',
      channelId: 'C_WORKERD',
      draft,
      previewHash,
      expiresAt: at + 15 * 60 * 1_000,
    });
    const routine = this.routines.confirm({
      tokenHash,
      actorId: 'U_WORKERD',
      workspaceId: 'T_WORKERD',
      channelId: 'C_WORKERD',
      previewHash,
      idempotencyKey: `routine:workerd:${suffix}`,
    });
    this.db.exec('CREATE TABLE IF NOT EXISTS spike_fk_parent (id TEXT PRIMARY KEY)');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS spike_fk_child (' +
        'id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES spike_fk_parent(id))',
    );
    let orphanRejected = false;
    try {
      this.db.run(
        'INSERT INTO spike_fk_child (id, parent_id) VALUES (?, ?)',
        `child-${suffix}`,
        `missing-${suffix}`,
      );
    } catch {
      orphanRejected = true;
    }
    const workId = `work_${suffix}` as WorkId;
    const bindingId = `binding_${suffix}` as BindingId;
    const canonicalRunId = `run_${suffix}` as RunId;
    const config = this.work.putConfigRevision({
      schemaVersion: 1,
      profileId: 'profile_spike',
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
    });
    const graph = this.work.createGraph({
      work: {
        id: workId,
        kind: 'conversation',
        maximumSensitivity: 'public',
        createdAt: 1_800_000_000_000,
      },
      binding: {
        id: bindingId,
        workId,
        adapterKind: 'conformance',
        externalAccountId: `account_${suffix}`,
        externalConversationId: `conversation_${suffix}`,
        generation: 1,
        sourceVisibility: 'public',
        configMode: 'frozen_on_open',
        pinnedConfigRevisionId: config.id,
        orderingKey: `conformance:${suffix}`,
        createdAt: 1_800_000_000_000,
      },
      run: {
        id: canonicalRunId,
        workId,
        bindingId,
        kind: 'interactive',
        admissionSequence: 1,
        triggerKind: 'conformance',
        triggerRef: `trigger:${suffix}`,
        dedupeKey: `dedupe:${suffix}`,
        actorTrustTier: 'system',
        configRevisionId: config.id,
        effectiveCapabilityDigest: 'b'.repeat(64),
        executionAuthority: 'legacy',
        coordinatorKind: 'interactive',
        authorityEpoch: 1,
        createdAt: 1_800_000_000_000,
      },
      auditEventId: `work:admit:${suffix}`,
      auditIdempotencyKey: `work:admit:${suffix}`,
    });
    const workIntegrity = this.work.verifyIntegrity();
    return {
      routineId: routine.id,
      version: routine.version,
      auditCount: this.routines.listAuditEvents({ subjectId: routine.id }).length,
      revisionCount: this.routines.listRevisions(routine.id).length,
      foreignKeysEnabled: Number(this.db.get('PRAGMA foreign_keys')?.foreign_keys) === 1,
      orphanRejected,
      foreignKeyViolationCount: this.db.all('PRAGMA foreign_key_check').length,
      workRunStatus: graph.run.status,
      workInvariantViolationCount: workIntegrity.invariantViolationCount,
    };
  }
}
