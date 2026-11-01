import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectAgentWebsiteLogins } from '../src/browser/agent-website-logins.ts';
import { listWebsiteLogins } from '../src/browser/logins.ts';
import CONFIG_STORAGE_CONTRACT from '../src/config/storage-contract.json' with { type: 'json' };
import { readConfigStorageScenario, writeConfigStorageScenario } from './helpers/config-storage-scenario.ts';
import {
  CURRENT_FIXTURE, PREVIOUS_RELEASE_FIXTURE, SETTINGS_TABLE, atScenarioClock, entryName, maskedJson, namespaceOf,
  readbackLosses, restoreStorage, scenarioDigest, storageChanges, storesOf, unbumped, viewStorage,
  type CurrentFixture, type ReleaseFixture, type StorageContract,
} from './helpers/config-storage.ts';

const contract: StorageContract = CONFIG_STORAGE_CONTRACT;
const { kit, open } = await storesOf(fileURLToPath(new URL('..', import.meta.url)));
const release: ReleaseFixture = JSON.parse(readFileSync(PREVIOUS_RELEASE_FIXTURE, 'utf8'));
const recorded: CurrentFixture = JSON.parse(readFileSync(CURRENT_FIXTURE, 'utf8'));
const REFRESH = 'npm run fixture:config-storage -- current';

function installed() {
  const db = open();
  atScenarioClock(() => kit(db));
  return db;
}

function scenario() {
  const db = open();
  atScenarioClock(() => writeConfigStorageScenario(kit, db));
  return db;
}

function releaseDatabase() {
  const db = open();
  restoreStorage(db, release);
  return db;
}

test('the storage contract names the schema version, migrations, tables and JSON columns of a fresh install', () => {
  const db = installed();
  const meta = (key: string) => db.get('SELECT value FROM config_meta WHERE key = ?', key)?.value;
  assert.equal(meta('schema_version'), String(contract.schemaVersion));
  assert.equal(meta('schema_marker'), contract.schemaMarker);
  assert.deepEqual(db.all('SELECT id FROM config_migrations ORDER BY rowid').map((row) => row.id), contract.migrations);
  const { tables } = viewStorage(db, contract);
  assert.deepEqual(Object.keys(tables).sort(), Object.keys(contract.tables).sort());
  assert.deepEqual(
    Object.entries(tables).flatMap(([table, { columns }]) =>
      Object.keys(columns).filter((column) => column.endsWith('_json')).map((column) => `${table}.${column}`)).sort(),
    Object.keys(contract.columns).sort(),
  );
});

test('the scenario writes every table, JSON column and settings namespace of the contract, the same way each run', () => {
  const db = scenario();
  const view = viewStorage(db, contract);
  const rows = (table: string) => Object.values(view.tables[table]?.rows ?? {});
  assert.deepEqual(Object.keys(contract.tables).filter((table) => table !== SETTINGS_TABLE && rows(table).length === 0), [],
    'tables without a row');
  assert.deepEqual(Object.keys(contract.columns).filter((name) => {
    const [table, column] = name.split('.') as [string, string];
    return !rows(table).some((row) => !['null', '""', '[]', '{}'].includes(row[column]!));
  }), [], 'JSON columns without a value');
  assert.deepEqual(Object.keys(contract.settings).filter((namespace) => !view.settings[namespace]), [], 'namespaces without a setting');
  assert.deepEqual(db.all('SELECT key FROM app_settings ORDER BY key').map((row) => String(row.key))
    .filter((key) => !namespaceOf(contract, key)), [], 'settings outside every contract namespace');
  assert.deepEqual(viewStorage(scenario(), contract), view, 'a generated value escaped the masks in tests/helpers/config-storage.ts');
});

test('both fixtures ran the current scenario', () => {
  assert.equal(recorded.scenario, scenarioDigest(), `The scenario changed. Run ${REFRESH}`);
  assert.equal(release.scenario, scenarioDigest(),
    `The scenario changed. Run npm run fixture:config-storage -- release <checkout of v${release.release}>`);
});

test('a stored value changes only with a higher contract version', () => {
  const changes = storageChanges(recorded.view, viewStorage(scenario(), contract));
  assert.deepEqual(unbumped(changes, recorded.contract, contract).map(entryName), [],
    'These stored values changed. Increase their versions in src/config/storage-contract.json, then run ' + REFRESH);
  assert.deepEqual(recorded.contract, contract, `Record the changed contract: ${REFRESH}`);
});

test(`this code upgrades v${release.release}'s config storage to the schema a fresh install creates`, () => {
  const db = releaseDatabase();
  atScenarioClock(() => kit(db));
  const upgraded = viewStorage(db, contract).tables;
  const fresh = viewStorage(installed(), contract).tables;
  for (const table of Object.keys(fresh)) {
    assert.deepEqual(upgraded[table]?.columns, fresh[table]!.columns, `${table} columns`);
    assert.deepEqual(upgraded[table]?.indexes, fresh[table]!.indexes, `${table} indexes`);
  }
  assert.deepEqual(Object.keys(upgraded).sort(), Object.keys(fresh).sort());
  assert.deepEqual(db.all('SELECT id FROM config_migrations ORDER BY id').map((row) => row.id), [...contract.migrations].sort());
});

test(`this code reads v${release.release}'s stored values as v${release.release} read them`, async () => {
  const db = releaseDatabase();
  const readback = maskedJson(await atScenarioClock(() => readConfigStorageScenario(kit, db)));
  assert.deepEqual(readbackLosses(release.readback, readback), [],
    'This code reads these values differently. A version bump does not cover a read change. If the change is ' +
    'intended, change readConfigStorageScenario and regenerate the release fixture.');
});

test(`a personal website login v${release.release} stored keeps its owner on disk and shows as a team login`, async () => {
  const { settings } = kit(releaseDatabase());
  const logins = await listWebsiteLogins({
    getSetting: async (key) => settings.getSetting(key),
    getSettings: async (keys) => settings.getSettings(keys),
  });
  assert.equal(logins.filter(({ ownerKind }) => ownerKind === 'member').length, 1,
    'the release fixture keeps a personal login as the old-data case');
  const views = projectAgentWebsiteLogins(logins.map(({ id }) => ({ loginId: id, level: 'check', enabled: true })), logins);
  assert.deepEqual(views.map(({ loginId, ownerKind }) => [loginId, ownerKind]), logins.map(({ id }) => [id, 'team']));
  assert.equal(views.some((view) => 'ownerMembershipId' in view), false);
});
