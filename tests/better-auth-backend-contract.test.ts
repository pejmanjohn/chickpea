import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { D1BetterAuthBackend } from '../src/auth/better-auth-cloudflare.ts';
import { applyBetterAuthMigrations, NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import {
  betterAuthBackendContract,
  type BetterAuthBackendContract,
} from './helpers/better-auth-backend-contract.ts';
import { sqliteD1 } from './helpers/d1-sqlite.ts';

// PostgreSQL runs the same contract in better-auth-postgres.test.ts.
const contracts: BetterAuthBackendContract[] = [{
  label: 'Node SQLite',
  async open() {
    const backend = new NodeBetterAuthBackend(':memory:');
    return {
      backend,
      count: async (table) => sqliteCount(backend.database, table),
      close: async () => backend.close(),
    };
  },
}, {
  label: 'D1',
  async open() {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON;');
    applyBetterAuthMigrations(database);
    return {
      backend: new D1BetterAuthBackend(sqliteD1(database)),
      count: async (table) => sqliteCount(database, table),
      close: async () => database.close(),
    };
  },
}];

for (const { name, run } of contracts.flatMap(betterAuthBackendContract)) {
  test(name, { timeout: 60_000 }, run);
}

function sqliteCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number };
  return Number(row.count);
}
