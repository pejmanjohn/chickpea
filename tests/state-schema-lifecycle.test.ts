import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import type { StateDb, SqlParam } from '../src/state/state-db.ts';
import {
  StateSchemaMarker,
  attachStateDb,
  stateSchemaFingerprint,
} from '../src/state/schema-lifecycle.ts';
import { IdentityStoreLogic } from '../src/identity/store.ts';
import { ConfigStoreLogic } from '../src/config/store.ts';
import { SnapshotStoreLogic } from '../src/config/snapshot-store.ts';
import { SlackStateLogic } from '../src/slack/claim-store.ts';
import { SettingsStoreLogic } from '../src/config/settings-store.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { GatewayInboxStoreLogic } from '../src/slack/gateway/inbox.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { MemoryStoreLogic } from '../src/memory/store.ts';
import { RoutineStoreLogic } from '../src/routines/store.ts';
import { UsageStoreLogic } from '../src/usage/store.ts';
import { ManagementStoreLogic } from '../src/management/store.ts';
import { WorkStoreLogic } from '../src/work/store.ts';

/**
 * The Cloudflare TagStateStore constructs every store on each Durable Object
 * cold start, and Durable Objects SQLite meters every row a statement reads.
 * A warm attach must therefore issue no schema work, while a full install
 * must remain exactly as complete and as atomic as before.
 */
function recording(inner: StateDb): { db: StateDb; statements: string[] } {
  const statements: string[] = [];
  const db: StateDb = {
    ...(inner.schema ? { schema: inner.schema } : {}),
    run: (sql: string, ...params: SqlParam[]) => { statements.push(sql); return inner.run(sql, ...params); },
    get: (sql: string, ...params: SqlParam[]) => { statements.push(sql); return inner.get(sql, ...params); },
    all: (sql: string, ...params: SqlParam[]) => { statements.push(sql); return inner.all(sql, ...params); },
    exec: (sql: string) => { statements.push(sql); inner.exec(sql); },
    transaction: <T>(fn: () => T) => inner.transaction(fn),
  };
  return { db, statements };
}

function constructAll(db: StateDb) {
  const identity = new IdentityStoreLogic(db); const config = new ConfigStoreLogic(db);
  new SnapshotStoreLogic(db); new SlackStateLogic(db); const settings = new SettingsStoreLogic(db);
  new TurnJobStoreLogic(db); new GatewayInboxStoreLogic(db); new SlackRunPresentationStoreLogic(db);
  new MemoryStoreLogic(db); new RoutineStoreLogic(db); new UsageStoreLogic(db);
  new ManagementStoreLogic(db); const work = new WorkStoreLogic(db, { env: {} });
  return { identity, config, settings, work };
}

const RELEASE = { version: '0.1.8', sourceCommit: 'abcdef0123456789abcdef0123456789abcdef01' };
const FINGERPRINT = `worker:11111111-2222-4333-8444-555555555555:${RELEASE.sourceCommit}:${RELEASE.version}`;

test('a warm attach constructs every store without schema work and stays fully functional', () => {
  const inner = openStateDb(':memory:');
  try {
    const install = recording(inner);
    constructAll(install.db);
    const marker = new StateSchemaMarker(install.db, FINGERPRINT);
    marker.record(1_800_000_000_000);
    const installStatements = install.statements.length;
    assert.ok(installStatements > 300, `install issued ${installStatements} statements`);

    const attach = recording(attachStateDb(inner));
    const attachMarker = new StateSchemaMarker(attach.db, FINGERPRINT);
    assert.equal(attachMarker.isInstalled(), true);
    const markerStatements = attach.statements.length;
    const stores = constructAll(attach.db);
    const attachStatements = attach.statements.slice(markerStatements);
    // The only construction-time reads are the config column probe (once for
    // the config store, once for the routine store's nested config store),
    // served from the schema cache. No DDL, no sqlite_master, no integrity scans.
    assert.ok(attachStatements.length <= 2, `attach issued ${attachStatements.length} statements`);
    assert.deepEqual([...new Set(attachStatements)], ['PRAGMA table_info(config_channels)']);
    assert.equal(attach.statements.some((sql) => /sqlite_master|foreign_key_check|CREATE |ALTER /i.test(sql) && !/state_schema_installs/.test(sql)), false);

    stores.settings.setSetting('lifecycle.probe', 'attached');
    assert.equal(stores.settings.getSetting('lifecycle.probe'), 'attached');
    assert.ok(Array.isArray(stores.config.listAgents()));
    const integrity = stores.work.verifyIntegrity();
    assert.equal(integrity.foreignKeyViolationCount, 0, 'the explicit integrity RPC still works on attach');
  } finally {
    inner.close();
  }
});

test('the marker never hides a schema change: a new code version installs again and rewrites it', () => {
  const inner = openStateDb(':memory:');
  try {
    const first = recording(inner);
    constructAll(first.db);
    new StateSchemaMarker(first.db, 'worker:11111111-1111-4111-8111-111111111111').record(1);
    const next = new StateSchemaMarker(first.db, FINGERPRINT);
    assert.equal(next.isInstalled(), false, 'a different upload id must install');
    const reinstall = recording(inner);
    constructAll(reinstall.db);
    assert.ok(reinstall.statements.some((sql) => /^\s*CREATE TABLE IF NOT EXISTS/i.test(sql)), 'install ran DDL again');
    next.record(2);
    assert.equal(next.isInstalled(), true);
    assert.equal(new StateSchemaMarker(first.db, 'worker:11111111-1111-4111-8111-111111111111').isInstalled(), false,
      'rollback to the previous version installs again rather than trusting the new marker');
  } finally {
    inner.close();
  }
});

test('a failed bootstrap leaves no marker, so the next cold start installs again', () => {
  const inner = openStateDb(':memory:');
  try {
    let failOnce = true;
    const interrupted: StateDb = {
      run: (sql, ...params) => inner.run(sql, ...params),
      get: (sql, ...params) => inner.get(sql, ...params),
      all: (sql, ...params) => inner.all(sql, ...params),
      exec: (sql) => {
        if (failOnce && /CREATE TABLE IF NOT EXISTS slack_run_presentations/.test(sql)) {
          failOnce = false;
          throw new Error('simulated bootstrap interruption');
        }
        inner.exec(sql);
      },
      transaction: (fn) => inner.transaction(fn),
    };
    const marker = new StateSchemaMarker(interrupted, FINGERPRINT);
    assert.throws(() => {
      constructAll(interrupted);
      marker.record(1);
    }, /simulated bootstrap interruption/);
    assert.equal(marker.isInstalled(), false);
    assert.equal(inner.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'slack_run_presentations'"), undefined);
    constructAll(interrupted);
    marker.record(2);
    assert.equal(marker.isInstalled(), true);
    assert.ok(inner.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'slack_run_presentations'"));
  } finally {
    inner.close();
  }
});

test('only a real upload id with a released build identity may vouch for an installed schema', () => {
  assert.equal(stateSchemaFingerprint('11111111-2222-4333-8444-555555555555'.toUpperCase(), RELEASE), FINGERPRINT);
  for (const value of [undefined, '', '  ', 'dev', '00000000-0000-0000-0000-000000000000', 'not-a-uuid-at-all']) {
    assert.equal(stateSchemaFingerprint(value, RELEASE), undefined, String(value));
  }
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(stateSchemaFingerprint(id, { version: 'development', sourceCommit: null }), undefined,
    'a development build never attaches, even with a real-looking local id');
  assert.equal(stateSchemaFingerprint(id, { version: '0.1.8', sourceCommit: null }), undefined);
  assert.equal(stateSchemaFingerprint(id, { version: '0.1.8', sourceCommit: 'abc' }), undefined);
  assert.notEqual(
    stateSchemaFingerprint(id, { ...RELEASE, sourceCommit: 'f'.repeat(40) }),
    stateSchemaFingerprint(id, RELEASE),
    'a new commit under the same upload id installs again',
  );
});

test('a local Vite serve lane never attaches, even with a real id and a released identity', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(stateSchemaFingerprint(id, RELEASE, { localServe: true }), undefined);
  assert.equal(stateSchemaFingerprint(id, RELEASE, { localServe: false }), FINGERPRINT);
  assert.equal(stateSchemaFingerprint(id, RELEASE, {}), FINGERPRINT);
  // The flag is a build-time define wired to Vite's command, so every serve
  // lane sets it and every deployed build clears it.
  const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(viteConfig, /__CHICKPEA_VITE_SERVE__: JSON\.stringify\(command === 'serve'\)/);
  const identitySource = readFileSync(new URL('../src/release/identity.ts', import.meta.url), 'utf8');
  assert.match(identitySource, /__CHICKPEA_VITE_SERVE__ === true/);
});
