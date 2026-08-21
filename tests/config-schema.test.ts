import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIG_SCHEMA_MARKER,
  CONFIG_SCHEMA_VERSION,
  ConfigStoreLogic,
} from '../src/config/store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { StateDb } from '../src/state/state-db.ts';

test('fresh config state installs the exact Agent-first schema marker atomically', () => {
  const db = openStateDb(':memory:');
  try {
    let failOnce = true;
    const interrupted: StateDb = {
      run: (sql, ...params) => db.run(sql, ...params),
      get: (sql, ...params) => db.get(sql, ...params),
      all: (sql, ...params) => db.all(sql, ...params),
      exec: (sql) => {
        if (failOnce && /CREATE TABLE IF NOT EXISTS config_agent_schedule_references/.test(sql)) {
          failOnce = false;
          throw new Error('simulated schema interruption');
        }
        db.exec(sql);
      },
      transaction: (fn) => db.transaction(fn),
    };

    assert.throws(
      () => new ConfigStoreLogic(interrupted, { agents: [] }),
      /simulated schema interruption/,
    );
    assert.deepEqual(
      db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'config_%'"),
      [],
    );

    new ConfigStoreLogic(interrupted, { agents: [] });
    assert.equal(
      db.get("SELECT value FROM config_meta WHERE key = 'schema_version'")?.value,
      String(CONFIG_SCHEMA_VERSION),
    );
    assert.equal(
      db.get("SELECT value FROM config_meta WHERE key = 'schema_marker'")?.value,
      CONFIG_SCHEMA_MARKER,
    );
    assert.ok(db.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'config_agent_archive_snapshots'",
    ));

    // A second target-neutral construction is a no-op and uses no PRAGMA-only
    // migration behavior, matching Durable Object SQLite's StateDb contract.
    new ConfigStoreLogic(interrupted, { agents: [] });
  } finally {
    db.close();
  }
});

test('legacy numeric config ledgers fail closed before Agent-first tables are installed', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec('CREATE TABLE config_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run("INSERT INTO config_meta (key, value) VALUES ('schema_version', '11')");

    assert.throws(
      () => new ConfigStoreLogic(db, { agents: [] }),
      /incompatible pre-Agent config state; use a fresh deployment/,
    );
    assert.equal(
      db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'config_agents'"),
      undefined,
    );
  } finally {
    db.close();
  }
});

test('an exact numeric version without the Agent-first marker is never accepted', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec('CREATE TABLE config_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run(
      'INSERT INTO config_meta (key, value) VALUES (?, ?)',
      'schema_version',
      String(CONFIG_SCHEMA_VERSION),
    );

    assert.throws(
      () => new ConfigStoreLogic(db, { agents: [] }),
      /incompatible pre-Agent config state; use a fresh deployment/,
    );
  } finally {
    db.close();
  }
});
