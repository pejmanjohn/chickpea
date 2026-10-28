import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SqlParam, StateDb } from '../../src/state/state-db.ts';
import { SCENARIO_NOW, type ConfigStorageKit } from './config-storage-scenario.ts';

/** `src/config/storage-contract.json`: what `release.json`'s `configuration` digest declares. */
export interface StorageContract {
  schemaVersion: number;
  schemaMarker: string;
  migrations: string[];
  tables: Record<string, number>;
  columns: Record<string, number>;
  settings: Record<string, number>;
}

/** A versioned contract entry: a table's schema and plain columns, a `*_json` column, or a settings namespace. */
export interface ContractEntry {
  section: 'tables' | 'columns' | 'settings';
  key: string;
}

type Row = Record<string, SqlParam>;

/** A database's config storage as written: its DDL and raw rows, enough to recreate it. */
export interface StorageSnapshot {
  ddl: string[];
  rows: Record<string, Row[]>;
}

interface TableView {
  columns: Record<string, string>;
  indexes: Record<string, string>;
  sql: string;
  /** Normalized cells by normalized primary key. */
  rows: Record<string, Record<string, string>>;
}

/** Config storage with generated values masked, comparable across runs and releases. */
export interface StorageView {
  tables: Record<string, TableView>;
  /** Normalized value by normalized key, per contract settings namespace. */
  settings: Record<string, Record<string, string>>;
}

/** `previous-release.json`: the database a release wrote, and what it read back from it. */
export interface ReleaseFixture extends StorageSnapshot {
  release: string;
  scenario: string;
  contract: StorageContract;
  readback: unknown;
}

/** `current.json`: what this tree wrote when the contract last changed. */
export interface CurrentFixture {
  scenario: string;
  contract: StorageContract;
  view: StorageView;
}

export const CONFIG_STORAGE_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'config-storage');
export const PREVIOUS_RELEASE_FIXTURE = join(CONFIG_STORAGE_FIXTURES, 'previous-release.json');
export const CURRENT_FIXTURE = join(CONFIG_STORAGE_FIXTURES, 'current.json');
export const CONTRACT_FILE = 'src/config/storage-contract.json';

/** The fixtures record which scenario wrote them: a changed scenario changes what is stored without any codec changing. */
export function scenarioDigest(): string {
  return createHash('sha256').update(readFileSync(join(import.meta.dirname, 'config-storage-scenario.ts'))).digest('hex');
}

/** Governed by `contract.migrations`, not by a table version. */
const MIGRATIONS_TABLE = 'config_migrations';
/** Its schema is a contract table; its values compare per settings namespace. */
export const SETTINGS_TABLE = 'app_settings';
/** `config_meta` rows that `contract.schemaVersion` and `contract.schemaMarker` govern. */
const CONTRACT_META_KEYS = new Set(['schema_version', 'schema_marker']);
/** The system Agent's wording is product copy (seed.ts); a release may reword it without changing how it is stored. */
const SYSTEM_AGENT_COPY = new Set(['name', 'description', 'instructions']);
const EMPTY_SEED = { agents: [] };

/** One source tree's stores, loaded from that tree: the current one in tests, a release checkout when its fixture is written. */
export async function storesOf(root: string): Promise<{ kit: ConfigStorageKit; open: () => StateDb }> {
  const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  const [{ ConfigStoreLogic }, { SettingsStoreLogic }, routines, { openStateDb }] = await Promise.all([
    load('src/config/store.ts'), load('src/config/settings-store.ts'),
    load('src/routines/store.ts'), load('src/state/node-state-db.ts'),
  ]);
  return {
    kit: (db) => ({
      settings: new SettingsStoreLogic(db),
      // v0.1.37's config store takes (db, seed); later ones take (db, agentRoutines, seed).
      config: routines.agentRoutineDeletion
        ? new ConfigStoreLogic(db, routines.agentRoutineDeletion, EMPTY_SEED)
        : new ConfigStoreLogic(db, EMPTY_SEED),
    }),
    open: () => openStateDb(':memory:'),
  };
}

export function readContract(root: string): StorageContract | undefined {
  const file = join(root, CONTRACT_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

/** Stores stamp rows with `Date.now()` and `new Date()`; both read the scenario's instant here. */
export function atScenarioClock<T>(fn: () => T): T {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length) super(...args);
      else super(SCENARIO_NOW);
    }

    static override now() {
      return SCENARIO_NOW;
    }
  } as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** In creation order, so restored rows meet their foreign keys' parents first. */
function configTables(db: StateDb): string[] {
  return db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'config\\_%' ESCAPE '\\' ORDER BY rowid")
    .map((row) => String(row.name));
}

export function namespaceOf(contract: StorageContract, key: string): string | undefined {
  return Object.keys(contract.settings).find((namespace) => namespace.endsWith('.*')
    ? key.startsWith(namespace.slice(0, -1))
    : key === namespace);
}

function hasSettings(db: StateDb): boolean {
  return Boolean(db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", SETTINGS_TABLE));
}

function settingRows(db: StateDb, contract: StorageContract): Row[] {
  if (!hasSettings(db)) return [];
  return db.all(`SELECT * FROM ${SETTINGS_TABLE} ORDER BY key`)
    .filter((row) => namespaceOf(contract, String(row.key))) as Row[];
}

export function snapshotStorage(db: StateDb, contract: StorageContract): StorageSnapshot {
  const tables = [...configTables(db), SETTINGS_TABLE];
  const ddl = db.all(
    `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name IN (${tables.map(() => '?').join(', ')}) ORDER BY rowid`,
    ...tables,
  ).map((row) => String(row.sql));
  const rows: Record<string, Row[]> = {};
  for (const table of configTables(db)) rows[table] = db.all(`SELECT * FROM ${table} ORDER BY rowid`) as Row[];
  rows[SETTINGS_TABLE] = settingRows(db, contract);
  return { ddl, rows };
}

export function restoreStorage(db: StateDb, snapshot: StorageSnapshot): void {
  for (const statement of snapshot.ddl) db.exec(statement);
  for (const [table, rows] of Object.entries(snapshot.rows)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      db.run(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...columns.map((column) => row[column]!),
      );
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * The ids the store generates differ on every run: Agent credential
 * incarnations and connection credential refs (connection-credential-binding.ts).
 * Mask nothing else, or a change to a derived value would pass unseen.
 */
function mask(text: string): string {
  return text.replace(/\b(agent|connection)_[0-9a-f]{32}\b/g, '$1_<generated>');
}

/** JSON text compares by meaning: key order is not stored meaning, value types are. */
function cell(value: SqlParam | undefined, json: boolean): string {
  if (typeof value !== 'string') return JSON.stringify(value ?? null);
  if (json) {
    try {
      return mask(JSON.stringify(canonical(JSON.parse(value))));
    } catch {
      // An unparseable value compares as text.
    }
  }
  return JSON.stringify(mask(value));
}

export function maskedJson(value: unknown): unknown {
  return JSON.parse(mask(JSON.stringify(canonical(value))));
}

/** By key; keys that masking made equal get a suffix in a content-sorted order. */
function keyed<T>(entries: [string, T][]): Record<string, T> {
  const counts = new Map<string, number>();
  const result: Record<string, T> = {};
  const order = ([key, value]: [string, T]) => `${key}\u0000${JSON.stringify(value)}`;
  for (const [key, value] of entries.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))) {
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    result[seen ? `${key}#${seen}` : key] = value;
  }
  return result;
}

export function viewStorage(db: StateDb, contract: StorageContract): StorageView {
  const tables: Record<string, TableView> = {};
  for (const table of [...configTables(db), ...(hasSettings(db) ? [SETTINGS_TABLE] : [])]) {
    if (table === MIGRATIONS_TABLE) continue;
    const info = db.all(`PRAGMA table_info(${table})`);
    const pk = info.filter((column) => Number(column.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk)).map((column) => String(column.name));
    const json = (column: string) => column.endsWith('_json');
    const rows = table === SETTINGS_TABLE ? [] : (db.all(`SELECT * FROM ${table}`) as Row[])
      .filter((row) => table !== 'config_meta' || !CONTRACT_META_KEYS.has(String(row.key)));
    tables[table] = {
      columns: Object.fromEntries(info.map((column) => [String(column.name),
        `${String(column.type)}|${String(column.notnull)}|${String(column.dflt_value)}|${String(column.pk)}`])),
      indexes: Object.fromEntries(db.all(`PRAGMA index_list(${table})`).map((index) => [String(index.name),
        `${String(index.unique)}|${String(index.origin)}|${String(index.partial)}|` +
        db.all(`PRAGMA index_info(${String(index.name)})`).map((part) => String(part.name)).join(',')])),
      sql: String(db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.sql).replace(/\s+/g, ' '),
      rows: keyed(rows.map((row) => [
        JSON.stringify(pk.map((column) => cell(row[column], false))),
        Object.fromEntries(Object.keys(row).map((column) => [column,
          table === 'config_agents' && row.agent_kind === 'system' && SYSTEM_AGENT_COPY.has(column)
            ? '"<product copy>"'
            : cell(row[column], json(column))])),
      ])),
    };
  }
  const entries: Record<string, [string, string][]> = {};
  for (const row of settingRows(db, contract)) {
    (entries[namespaceOf(contract, String(row.key))!] ??= []).push([JSON.stringify(mask(String(row.key))), cell(row.value, true)]);
  }
  const settings = Object.fromEntries(Object.entries(entries).map(([namespace, values]) => [namespace, keyed(values)]));
  return { tables, settings };
}

export function entryName({ section, key }: ContractEntry): string {
  return `${section}[${JSON.stringify(key)}]`;
}

/** Each contract entry whose stored values or schema differ between two views. */
export function storageChanges(before: StorageView, after: StorageView): ContractEntry[] {
  const changed = new Map<string, ContractEntry>();
  const mark = (entry: ContractEntry) => changed.set(entryName(entry), entry);
  const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  for (const table of new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])) {
    const a = before.tables[table];
    const b = after.tables[table];
    if (!a || !b || !same(a.columns, b.columns) || !same(a.indexes, b.indexes) || a.sql !== b.sql ||
        !same(Object.keys(a.rows).sort(), Object.keys(b.rows).sort())) {
      mark({ section: 'tables', key: table });
      if (!a || !b) continue;
    }
    for (const [pk, row] of Object.entries(a.rows)) {
      const other = b.rows[pk];
      if (!other) continue;
      for (const column of new Set([...Object.keys(row), ...Object.keys(other)])) {
        if (row[column] === other[column]) continue;
        mark(column.endsWith('_json') ? { section: 'columns', key: `${table}.${column}` } : { section: 'tables', key: table });
      }
    }
  }
  for (const namespace of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    if (!same(before.settings[namespace] ?? {}, after.settings[namespace] ?? {})) {
      mark({ section: 'settings', key: namespace });
    }
  }
  return [...changed.values()];
}

/** The changed entries whose contract version did not increase. */
export function unbumped(changes: ContractEntry[], before: StorageContract, after: StorageContract): ContractEntry[] {
  return changes.filter(({ section, key }) => (after[section][key] ?? 0) <= (before[section][key] ?? 0));
}

/** Paths where `actual` does not carry a value of `expected`; extra keys in `actual` are allowed. */
export function readbackLosses(expected: unknown, actual: unknown, path = '$'): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [path];
    return expected.flatMap((item, index) => readbackLosses(item, actual[index], `${path}[${index}]`));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return [path];
    return Object.entries(expected).flatMap(([key, value]) =>
      readbackLosses(value, (actual as Record<string, unknown>)[key], `${path}.${key}`));
  }
  return expected === actual ? [] : [path];
}
