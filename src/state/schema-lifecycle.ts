import type { StateDb } from './state-db.ts';

/**
 * Warm-schema attach for metered SQLite.
 *
 * Every store constructor installs its schema with IF NOT EXISTS DDL,
 * migrations, sqlite_master probes and seeds. That is correct and cheap on
 * Node, where construction happens once per process. On Cloudflare the
 * TagStateStore is re-constructed on every Durable Object cold start, and
 * Durable Objects SQLite meters every row those statements read, so the same
 * work exhausts the free-tier daily read budget with no user traffic at all.
 *
 * Contract: a one-row marker records the fingerprint of the code version that
 * last completed a full install on this storage. A constructor may attach
 * (skip all schema work) only when the marker equals the fingerprint of the
 * code that is running. The fingerprint is the immutable Worker upload id, so
 * any deploy, forward or rollback, installs once and rewrites the marker; a
 * marker therefore never hides a migration. The marker is written last,
 * inside the install transaction, so a partial or failed install leaves no
 * marker and the next cold start installs again.
 */

const MARKER_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS state_schema_installs (
    key TEXT PRIMARY KEY CHECK (key = 'current'),
    fingerprint TEXT NOT NULL,
    installed_at INTEGER NOT NULL
  )`;

const WORKER_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_VERSION_ID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;

export interface StateSchemaBuildIdentity {
  version: string;
  sourceCommit: string | null;
}

export interface StateSchemaFingerprintOptions {
  /**
   * A Vite serve lane. The build identity there is the committed source while
   * the schema comes from the working tree, so the marker must never be
   * trusted: local development always installs.
   */
  localServe?: boolean;
}

/**
 * Only a deployed build may vouch for an installed schema: a real Worker
 * upload id, a released build identity, and not a local serve lane.
 * Production carries all three, and every upload has a new id. Local
 * `wrangler dev` presents a real-looking random id (measured 2026-09-09) and
 * local Vite serve carries the committed identity, so neither may attach;
 * the explicit serve flag closes that lane. Node never attaches either.
 */
export function stateSchemaFingerprint(
  workerVersionId: string | undefined,
  identity: StateSchemaBuildIdentity,
  options: StateSchemaFingerprintOptions = {},
): string | undefined {
  if (options.localServe) return undefined;
  const id = workerVersionId?.trim();
  if (!id || !WORKER_VERSION_ID.test(id) || PLACEHOLDER_VERSION_ID.test(id)) return undefined;
  if (!identity.sourceCommit || !SOURCE_COMMIT.test(identity.sourceCommit)) return undefined;
  if (!identity.version || identity.version === 'development') return undefined;
  return `worker:${id.toLowerCase()}:${identity.sourceCommit}:${identity.version}`;
}

export class StateSchemaMarker {
  constructor(
    private readonly db: StateDb,
    readonly fingerprint: string,
  ) {}

  /** One DDL no-op plus one primary-key read on a warm schema. */
  isInstalled(): boolean {
    this.db.exec(MARKER_TABLE_DDL);
    const row = this.db.get("SELECT fingerprint FROM state_schema_installs WHERE key = 'current'");
    return row?.fingerprint === this.fingerprint;
  }

  /** Call last, inside the install transaction, after every store constructed. */
  record(installedAt: number): void {
    this.db.exec(MARKER_TABLE_DDL);
    this.db.run(
      `INSERT INTO state_schema_installs (key, fingerprint, installed_at)
       VALUES ('current', ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         installed_at = excluded.installed_at`,
      this.fingerprint,
      installedAt,
    );
  }
}

/** The same storage, presented to constructors as already installed. */
export function attachStateDb(db: StateDb): StateDb {
  return {
    schema: 'attach',
    run: (sql, ...params) => db.run(sql, ...params),
    get: (sql, ...params) => db.get(sql, ...params),
    all: (sql, ...params) => db.all(sql, ...params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
  };
}
