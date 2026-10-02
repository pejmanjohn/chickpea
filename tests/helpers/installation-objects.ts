import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { DurableObjectStorage } from 'cloudflare:workers';

import { scopeInstallationEnv } from '../../src/config/installation-scope.ts';
import type { PlatformEnv } from '../../src/config/state-backend.ts';
import { DoSqlStateDb } from '../../src/state/do-state-db.ts';
import { buildTagStateStores, type TagStateStores } from '../../src/state/tag-state-stores.ts';

/**
 * A Durable Object's storage over Node SQLite, as the object classes and the
 * host functions see it: synchronous SQL with nesting transactions
 * (savepoints, as `transactionSync` nests), key-value entries, one alarm and
 * `deleteAll`. Real workerd storage is covered by
 * hosted-object-storage-workerd.test.ts.
 */
export class FakeObjectStorage {
  readonly database = new DatabaseSync(':memory:');
  readonly kv = new Map<string, unknown>();
  alarm: number | null = null;
  deleteAllCalls = 0;
  private depth = 0;

  constructor() {
    this.database.exec('PRAGMA foreign_keys = ON;');
  }

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = this.database.prepare(query);
      const values = bindings as SQLInputValue[];
      const rows = statement.columns().length > 0
        ? statement.all(...values).map((row) => ({ ...row }) as Record<string, unknown>)
        : (statement.run(...values), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0]!;
        },
        rowsRead: 0,
        rowsWritten: 0,
      };
    },
  };

  transactionSync<T>(fn: () => T): T {
    const savepoint = `chickpea_tx_${this.depth}`;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      this.database.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth -= 1;
      this.database.exec(`ROLLBACK TO ${savepoint}`);
      this.database.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  async get(key: string): Promise<unknown> {
    return this.kv.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.kv.set(key, structuredClone(value));
  }

  async list(options: { startAfter?: string; limit?: number } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.kv.keys()].sort()
      .filter((key) => options.startAfter === undefined || key > options.startAfter)
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
    return new Map(keys.map((key) => [key, structuredClone(this.kv.get(key))]));
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  /** As on SQLite-backed objects at compatibility date 2026-02-24 or later: tables, entries and the alarm. */
  async deleteAll(): Promise<void> {
    this.deleteAllCalls += 1;
    this.database.exec('PRAGMA foreign_keys = OFF;');
    for (const row of this.database.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view')",
    ).all() as Array<{ type: string; name: string }>) {
      this.database.exec(`DROP ${row.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${row.name}"`);
    }
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.kv.clear();
    this.alarm = null;
  }

  /** The object's own SQL tables, by name. */
  tables(): string[] {
    return (this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
  }

  asDurableObjectStorage(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }
}

export interface HostedInstallation {
  readonly installationId: string;
  readonly organizationId: string;
  readonly env: PlatformEnv;
  readonly storage: FakeObjectStorage;
  readonly db: DoSqlStateDb;
  readonly stores: TagStateStores;
}

/**
 * One installation of a deployment serving many: its scoped env (with any
 * `bindings`) and its state store's stores, built exactly as `TagStateStore`
 * builds them, over a fake object storage, provisioned with its IDs.
 */
export function hostedInstallation(
  installationId: string,
  bindings: Record<string, unknown> = {},
): HostedInstallation {
  const env = scopeInstallationEnv(
    { CHICKPEA_TENANCY: 'installation', ...bindings } as PlatformEnv,
    { installationId },
  );
  const storage = new FakeObjectStorage();
  const db = new DoSqlStateDb(storage.asDurableObjectStorage());
  const stores = buildTagStateStores(db, env, { gatewayLeaseOwner: `test-${installationId}` });
  const organizationId = `org_${installationId}`;
  stores.installationBinding.bind({ organizationId, installationId });
  return { installationId, organizationId, env, storage, db, stores };
}
