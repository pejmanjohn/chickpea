import type { DurableObjectStorage } from 'cloudflare:workers';
import { RoutineStoreLogic } from '../../../src/routines/store.ts';
import { SlackRunPresentationStoreLogic } from '../../../src/slack/run-presentations.ts';
import { TurnJobStoreLogic } from '../../../src/slack/turn-jobs.ts';
import { StateSchemaMarker } from '../../../src/state/schema-lifecycle.ts';
import { DoSqlStateDb } from '../../../src/state/do-state-db.ts';
import type { SqlParam } from '../../../src/state/state-db.ts';
import { MAINTENANCE_INDEXES, NOW, maintenanceFixture, turnJob } from './maintenance.ts';

/** Instrument drained native cursors while the production adapter and stores
 * execute normally. No captured-SQL replay or substitute mutation semantics. */
export function meterMaintenance(storage: DurableObjectStorage) {
  let reads = 0; let writes = 0;
  const meteredSql = new Proxy(storage.sql, {
    get(target, key) {
      if (key !== 'exec') return Reflect.get(target, key, target);
      return (query: string, ...params: SqlParam[]) => {
        const cursor = target.exec(query, ...params);
        let counted = false;
        return new Proxy(cursor, {
          get(target, key) {
            if (key !== 'toArray' && key !== 'one') return Reflect.get(target, key, target);
            return () => {
              const result = target[key]();
              if (!counted) { reads += target.rowsRead; writes += target.rowsWritten; counted = true; }
              return result;
            };
          },
        });
      };
    },
  });
  const db = new DoSqlStateDb(new Proxy(storage, {
    get(target, key) {
      if (key === 'sql') return meteredSql;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }));
  const measure = <T>(fn: () => T) => {
    reads = 0; writes = 0;
    const result = fn();
    return { reads, writes, result };
  };
  const fixture = maintenanceFixture(db, 1_000);
  const indexed = measure(() => fixture.tick());
  const missing = measure(() => fixture.routines.getRun('missing') ?? null);
  const definitions = MAINTENANCE_INDEXES.map((name) => ({
    name, sql: String(db.get('SELECT sql FROM sqlite_master WHERE name = ?', name)?.sql),
  }));
  for (const { name } of definitions) db.exec(`DROP INDEX ${name}`);
  const baseline = measure(() => fixture.tick());
  const builds = definitions.map(({ name, sql }) => ({ name, ...measure(() => db.exec(sql)) }));
  const reinstalled = measure(() => fixture.tick());
  const measureTurn = (id: string) => measure(() => {
    fixture.turns.enqueue(turnJob(id));
    fixture.turns.markDelivered(id);
    return fixture.turns.hasPending('legacy');
  });
  const measureRun = (id: string) => measure(() => {
    // A run-now occurrence is allowed on the paused routine, with fresh actor
    // authorization left to the service boundary as in production.
    const routine = fixture.routines.getRoutine('routine_meter')!;
    const run = fixture.routines.createOccurrence({
      runId: id, idempotencyKey: id, routineId: routine.id,
      routineVersion: routine.version, scheduledFor: NOW + 1, triggerSource: 'run_now',
      requestedBy: 'U_TEST', queuedAt: NOW + 1, deadlineAt: NOW + 60_000,
    });
    fixture.routines.startAdmissionAttempt({ occurrenceId: run.id, owner: 'meter', invokeStartedAt: NOW + 2, leaseUntil: NOW + 60_000 });
    fixture.routines.beginOccurrence({ occurrenceId: run.id, flueRunId: `flue_${id}`, startedAt: NOW + 3 });
    fixture.routines.claimDelivery({ occurrenceId: run.id, at: NOW + 4, leaseUntil: NOW + 60_000 });
    fixture.routines.recordDelivery({ occurrenceId: run.id, outcome: 'delivered', at: NOW + 5, channelId: 'C_TEST', messageTs: '1800000000.000002' });
    fixture.routines.transitionRun({ occurrenceId: run.id, from: ['running'], to: 'succeeded', at: NOW + 6 });
    return fixture.routines.getRun(run.id)?.status;
  });
  const turnLifecycle = measureTurn('turn_write_indexed');
  const runLifecycle = measureRun('rrun_write_indexed');
  for (const { name } of definitions) db.exec(`DROP INDEX ${name}`);
  const baselineTurnLifecycle = measureTurn('turn_write_baseline');
  const baselineRunLifecycle = measureRun('rrun_write_baseline');
  // The production outer install transaction can nest each store's own
  // transactions. Test the actual index install, not a synthetic table alone.
  db.run("DELETE FROM app_migrations WHERE domain = 'work' AND version = 3");
  const marker = new StateSchemaMarker(db, 'failed-index-install');
  marker.isInstalled();
  const previousRuns = db.get('SELECT COUNT(*) AS n FROM routine_runs')?.n;
  let installError = '';
  try {
    db.transaction(() => {
      new RoutineStoreLogic(db); new SlackRunPresentationStoreLogic(db); new TurnJobStoreLogic(db);
      marker.record(NOW);
      throw new Error('after-index-install');
    });
  } catch (error) { installError = error instanceof Error ? error.message : String(error); }
  const failedInstallRollback = installError === 'after-index-install' &&
    MAINTENANCE_INDEXES.every((name) => !db.get('SELECT name FROM sqlite_master WHERE name = ?', name)) &&
    !db.get("SELECT version FROM app_migrations WHERE domain = 'work' AND version = 3") &&
    !db.get("SELECT key FROM state_schema_installs WHERE key = 'current'") &&
    db.get('SELECT COUNT(*) AS n FROM routine_runs')?.n === previousRuns;
  return { indexed, baseline, reinstalled, missing, builds, turnLifecycle, runLifecycle, failedInstallRollback,
    baselineTurnLifecycle, baselineRunLifecycle };
}
