import type { StateDb } from './state-db.ts';

/**
 * Cross-domain link DDL, in one place.
 *
 * The Work ledger is the canonical record, but the Routine and Usage tables
 * predate it and carry nullable pointers back into it (`routines.work_id`,
 * `routines.binding_id`, `routine_runs.canonical_run_id`,
 * `usage_operations.run_id`, `usage_measurements.run_execution_id`). Those
 * columns belong to no single domain: whichever store initializes first has to
 * be able to install them, because the Work migration that installs them is
 * marked applied even when it finds nothing to link (the Routine and Usage
 * tables do not exist yet on a fresh database) and never runs again.
 *
 * So every owner calls `installLedgerLinks` and each block is guarded by
 * `tableExists`: the first store through creates what it can, later stores fill
 * in the rest, and all of it is idempotent. Keep the statements exactly as they
 * are — the column names, index names, and partial `WHERE … IS NOT NULL`
 * clauses are what existing installs already have on disk.
 */
export function installLedgerLinks(db: StateDb): void {
  if (tableExists(db, 'routines')) {
    addColumnIfMissing(db, 'routines', 'work_id', 'TEXT');
    addColumnIfMissing(db, 'routines', 'binding_id', 'TEXT');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS routines_work_link_unique ON routines (work_id) WHERE work_id IS NOT NULL',
    );
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS routines_binding_link_unique ON routines (binding_id) WHERE binding_id IS NOT NULL',
    );
  }
  if (tableExists(db, 'routine_runs')) {
    addColumnIfMissing(db, 'routine_runs', 'canonical_run_id', 'TEXT');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_canonical_link_unique ON routine_runs (canonical_run_id) WHERE canonical_run_id IS NOT NULL',
    );
  }
  if (tableExists(db, 'usage_operations')) {
    addColumnIfMissing(db, 'usage_operations', 'run_id', 'TEXT');
    db.exec(
      'CREATE INDEX IF NOT EXISTS usage_operations_run_idx ON usage_operations (run_id) WHERE run_id IS NOT NULL',
    );
  }
  if (tableExists(db, 'usage_measurements')) {
    addColumnIfMissing(db, 'usage_measurements', 'run_execution_id', 'TEXT');
    db.exec(
      'CREATE INDEX IF NOT EXISTS usage_measurements_run_execution_idx ON usage_measurements (run_execution_id) WHERE run_execution_id IS NOT NULL',
    );
  }
}

/** Does the table exist yet? Every cross-domain probe is a "maybe" by nature. */
export function tableExists(db: StateDb, table: string): boolean {
  return Boolean(
    db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", table),
  );
}

/** The table's current column names, for migrations that branch on shape. */
export function tableColumns(db: StateDb, table: string): Set<string> {
  return new Set(db.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
}

/** Add a nullable column once; re-running an install must stay a no-op. */
export function addColumnIfMissing(
  db: StateDb,
  table: string,
  column: string,
  definition: string,
): void {
  const present = db.all(`PRAGMA table_info(${table})`).some((row) => row.name === column);
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
