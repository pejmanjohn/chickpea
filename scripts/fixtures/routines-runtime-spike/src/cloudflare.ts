import { getRun, invoke, listRuns } from '@flue/runtime';
import {
  DurableObject,
  type DurableObjectState,
  type DurableObjectStorage,
} from 'cloudflare:workers';

import routineSpike from './workflows/routine-spike.ts';
import { hashRoutineValue } from '../../../../src/routines/ids.ts';
import { RoutineStoreLogic } from '../../../../src/routines/store.ts';
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

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.db = new SpikeStateDb(ctx.storage);
    this.routines = new RoutineStoreLogic(this.db);
  }

  exercise(suffix: string, at: number): {
    routineId: string;
    version: number;
    auditCount: number;
    revisionCount: number;
    foreignKeysEnabled: boolean;
    orphanRejected: boolean;
    foreignKeyViolationCount: number;
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
    return {
      routineId: routine.id,
      version: routine.version,
      auditCount: this.routines.listAuditEvents({ subjectId: routine.id }).length,
      revisionCount: this.routines.listRevisions(routine.id).length,
      foreignKeysEnabled: Number(this.db.get('PRAGMA foreign_keys')?.foreign_keys) === 1,
      orphanRejected,
      foreignKeyViolationCount: this.db.all('PRAGMA foreign_key_check').length,
    };
  }
}
