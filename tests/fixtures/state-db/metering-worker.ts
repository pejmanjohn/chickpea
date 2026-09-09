// Bounded local workerd probe over the real Durable Object adapter: what
// Durable Objects SQLite meters as rows read for the statement shapes the
// state stores issue at construction, how nested transactions behave, and
// whether a failed schema install rolls back atomically with its marker.
import { DurableObject } from 'cloudflare:workers';

import { DoSqlStateDb } from '../../../src/state/do-state-db.ts';
import { StateSchemaMarker } from '../../../src/state/schema-lifecycle.ts';

interface Measurement {
  label: string;
  rowsRead: number;
  rowsWritten: number;
  rows: number;
}

const FINGERPRINT = 'worker:11111111-2222-4333-8444-555555555555:' +
  'abcdef0123456789abcdef0123456789abcdef01:0.1.8';

export class MeteringStore extends DurableObject {
  async fetch(): Promise<Response> {
    const sql = this.ctx.storage.sql;
    const db = new DoSqlStateDb(this.ctx.storage);
    const measure = (label: string, query: string, ...params: (string | number)[]): Measurement => {
      const cursor = sql.exec(query, ...params);
      const rows = cursor.toArray();
      return { label, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten, rows: rows.length };
    };
    for (let index = 0; index < 100; index += 1) {
      sql.exec(`CREATE TABLE IF NOT EXISTS t${index} (id INTEGER PRIMARY KEY, v TEXT)`);
    }
    sql.exec('CREATE TABLE IF NOT EXISTS parent (id INTEGER PRIMARY KEY)');
    sql.exec('CREATE TABLE IF NOT EXISTS child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))');
    for (let index = 1; index <= 500; index += 1) {
      sql.exec('INSERT OR IGNORE INTO parent (id) VALUES (?)', index);
      sql.exec('INSERT OR IGNORE INTO child (id, parent_id) VALUES (?, ?)', index, index);
    }
    const results: Measurement[] = [
      measure('create_if_not_exists_existing', 'CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY, v TEXT)'),
      measure('sqlite_master_by_name', "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 't50'"),
      measure('sqlite_master_count', 'SELECT COUNT(*) AS n FROM sqlite_master'),
      measure('pragma_table_info', 'PRAGMA table_info(child)'),
      measure('pragma_foreign_keys', 'PRAGMA foreign_keys'),
      measure('pragma_foreign_key_check', 'PRAGMA foreign_key_check'),
      measure('pk_lookup', 'SELECT id FROM parent WHERE id = ?', 250),
      measure('count_left_join_scan', 'SELECT COUNT(*) AS n FROM child c LEFT JOIN parent p ON p.id = c.parent_id WHERE p.id IS NULL'),
    ];

    // Caught inner rollback through the adapter: outer keeps 1 and 3, the
    // inner 2 is discarded with its own savepoint.
    db.exec('CREATE TABLE IF NOT EXISTS nested_probe (id INTEGER PRIMARY KEY)');
    db.run('DELETE FROM nested_probe');
    let innerError = 'not_thrown';
    db.transaction(() => {
      db.run('INSERT INTO nested_probe (id) VALUES (1)');
      try {
        db.transaction(() => {
          db.run('INSERT INTO nested_probe (id) VALUES (2)');
          throw new Error('inner');
        });
      } catch (error) {
        innerError = error instanceof Error ? error.message : String(error);
      }
      db.run('INSERT INTO nested_probe (id) VALUES (3)');
    });
    const nestedRows = db.all('SELECT id FROM nested_probe ORDER BY id').map((row) => Number(row.id));

    // Atomic bootstrap: prior schema and data survive; the failed install's
    // tables, rows, nested seed and marker all vanish.
    db.exec('CREATE TABLE IF NOT EXISTS prior_data (id INTEGER PRIMARY KEY, v TEXT)');
    db.run("INSERT OR REPLACE INTO prior_data (id, v) VALUES (1, 'before')");
    const marker = new StateSchemaMarker(db, FINGERPRINT);
    let installError = 'not_thrown';
    try {
      db.transaction(() => {
        db.exec('CREATE TABLE IF NOT EXISTS installed_table (id INTEGER PRIMARY KEY)');
        db.run('INSERT INTO installed_table (id) VALUES (1)');
        db.transaction(() => {
          db.run('INSERT INTO installed_table (id) VALUES (2)');
        });
        db.run("UPDATE prior_data SET v = 'during' WHERE id = 1");
        marker.record(1_800_000_000_000);
        throw new Error('bootstrap');
      });
    } catch (error) {
      installError = error instanceof Error ? error.message : String(error);
    }
    const metadata = (this.env as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA;
    return Response.json({
      results,
      nested: { innerError, rows: nestedRows },
      bootstrap: {
        installError,
        installedTableExists: db.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'installed_table'") !== undefined,
        markerInstalled: marker.isInstalled(),
        markerTableRows: db.all('SELECT key FROM state_schema_installs').length,
        priorValue: String(db.get('SELECT v FROM prior_data WHERE id = 1')?.v),
      },
      localVersionId: metadata?.id ?? null,
    });
  }
}

interface MeteringNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export default {
  fetch(request: Request, env: { METERING: MeteringNamespace }): Promise<Response> {
    return env.METERING.get(env.METERING.idFromName('probe')).fetch(request);
  },
};
