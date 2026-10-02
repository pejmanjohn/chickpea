import {
  deploymentTenancy,
  InstallationContextError,
  requireInstallationScope,
  type InstallationScope,
} from '../config/installation-scope.ts';

/**
 * What a host serving many installations may ask of each Durable Object an
 * installation owns (its state store, thread runners and Flue instances),
 * from an operator job: export its storage a page at a time, erase it, and
 * stop the work it would start on its own. Every call names the installation
 * the caller acts for; an object refuses unless its own name scopes it to
 * that installation, and refuses outright on a standalone deployment.
 *
 * Kept free of `cloudflare:workers`: the object classes delegate here, and
 * tests run it over Node SQLite.
 */

export interface ObjectHostRequest {
  /** The installation the host acts for; must be the one the object's name scopes. */
  readonly installationId: string;
}

/**
 * `portable` leaves out what only this deployment can use or must never
 * leave it: envelope ciphertext and nonces, every plaintext secret setting
 * (MCP, API and connection credentials and OAuth state, GitHub, Browserbase,
 * plaintext model keys), the telemetry HMAC key and OAuth continuation state.
 * `full` keeps everything, so it is only as safe as wherever it is stored.
 */
export type ObjectExportMode = 'portable' | 'full';

export interface ObjectExportRequest extends ObjectHostRequest {
  readonly mode: ObjectExportMode;
  /** The previous page's `nextCursor`; absent for the first page. */
  readonly cursor?: string | null;
  /** Soft cap on a page's bytes; a single record larger than it fills a page alone. */
  readonly maxBytes?: number;
}

export interface ObjectExportPage {
  /** JSON Lines, one record per line (see `ObjectExportRecord`). */
  readonly lines: string;
  readonly records: number;
  /** Pass back for the next page; null once the object is fully exported. */
  readonly nextCursor: string | null;
}

/**
 * One line of an export:
 * - `object`: the first line, naming the format and mode;
 * - `table`: a SQL table's definition, before its rows;
 * - `row`: one row, every column (BLOBs as `{"$bytes": base64}`);
 * - `kv`: one key-value storage entry (structured values tagged, see `encodeStoredValue`).
 */
export type ObjectExportRecord =
  | { t: 'object'; format: typeof OBJECT_EXPORT_FORMAT; mode: ObjectExportMode }
  | { t: 'table'; table: string; sql: string | null }
  | { t: 'row'; table: string; row: Record<string, unknown> }
  | { t: 'kv'; key: string; value: unknown };

export interface ObjectEraseResult {
  readonly erased: true;
}

/** What one object stopped: its alarm, and for a thread runner its open jobs. */
export interface ObjectPendingWorkCancellation {
  readonly alarmCleared: true;
  /** Thread runners: open jobs settled without running. */
  readonly runnerJobs?: number;
}

/** The host functions every installation object answers; each class delegates to `objectHostFunctions`. */
export interface InstallationObjectHostRpc {
  chickpeaHostExportPage(request: ObjectExportRequest): Promise<ObjectExportPage>;
  chickpeaHostErase(request: ObjectHostRequest): Promise<ObjectEraseResult>;
  chickpeaHostCancelPendingWork(request: ObjectHostRequest): Promise<ObjectPendingWorkCancellation>;
}

export const OBJECT_EXPORT_FORMAT = 'chickpea.object-export.v1';
export const DEFAULT_EXPORT_PAGE_BYTES = 512 * 1024;
const MIN_EXPORT_PAGE_BYTES = 4 * 1024;
const MAX_EXPORT_PAGE_BYTES = 8 * 1024 * 1024;
const ROW_BATCH = 200;
const KV_BATCH = 128;

/** The storage surface these functions use: a Durable Object's `ctx.storage`. */
export interface HostObjectStorage {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  list(options?: { startAfter?: string; limit?: number }): Promise<Map<string, unknown>>;
  deleteAll(): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
}

/**
 * The host functions of one object (a thread runner or a Flue instance), over
 * its env (scoped by its own name) and storage. `onErased` drops whatever the
 * object holds in memory of its storage; `cancel` stops its own pending work
 * before the alarm is cleared. Erasure must be the object's last contact:
 * a later call to the object, any of these included, finds it constructed
 * again with its schema re-created (state/installation-objects.ts).
 */
export function objectHostFunctions(object: {
  readonly env: Record<string, unknown> | undefined;
  readonly storage: HostObjectStorage;
  readonly onErased?: () => void;
  readonly cancel?: (now: number) => Omit<ObjectPendingWorkCancellation, 'alarmCleared'>;
}): InstallationObjectHostRpc {
  return {
    async chickpeaHostExportPage(request) {
      assertObjectHostCall(object.env, request);
      return exportObjectPage(object.storage, request);
    },
    async chickpeaHostErase(request) {
      assertObjectHostCall(object.env, request);
      const erased = await eraseObjectStorage(object.storage);
      object.onErased?.();
      return erased;
    },
    async chickpeaHostCancelPendingWork(request) {
      assertObjectHostCall(object.env, request);
      const cancelled = object.cancel?.(Date.now()) ?? {};
      await object.storage.deleteAlarm();
      return { alarmCleared: true, ...cancelled };
    },
  };
}

/**
 * Refuse a host call unless this deployment serves many installations and
 * the object (whose env its own name scoped) serves the installation the
 * caller names. Returns that installation.
 */
export function assertObjectHostCall(
  env: Record<string, unknown> | undefined,
  request: ObjectHostRequest | undefined,
): InstallationScope {
  if (deploymentTenancy(env) !== 'installation') {
    throw new InstallationContextError(
      'installation_context_invalid',
      'Host functions run only on a deployment serving many installations.',
    );
  }
  const scope = requireInstallationScope(env)!;
  if (typeof request?.installationId !== 'string' || request.installationId !== scope.installationId) {
    throw new InstallationContextError(
      'installation_context_mismatch',
      'This object belongs to another installation.',
    );
  }
  return scope;
}

/**
 * Delete every SQL table, key-value entry and the alarm of one object.
 * `deleteAll` removes the alarm too at the deployment's compatibility date;
 * it is deleted first anyway, so an alarm never fires on a half-erased object.
 */
export async function eraseObjectStorage(storage: HostObjectStorage): Promise<ObjectEraseResult> {
  await storage.deleteAlarm();
  await storage.deleteAll();
  return { erased: true };
}

/**
 * One page of an object's storage: its SQL tables in name order, each row
 * in key order, then its key-value entries. A cursor resumes exactly where
 * the previous page stopped, and the same cursor over unchanged storage
 * returns the same bytes.
 */
export async function exportObjectPage(
  storage: HostObjectStorage,
  request: ObjectExportRequest,
): Promise<ObjectExportPage> {
  const mode = request.mode;
  if (mode !== 'portable' && mode !== 'full') throw new Error('Export mode must be portable or full.');
  const maxBytes = request.maxBytes ?? DEFAULT_EXPORT_PAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_EXPORT_PAGE_BYTES || maxBytes > MAX_EXPORT_PAGE_BYTES) {
    throw new Error(`An export page holds ${MIN_EXPORT_PAGE_BYTES} to ${MAX_EXPORT_PAGE_BYTES} bytes.`);
  }
  let cursor = request.cursor ? decodeCursor(request.cursor, mode) : undefined;
  const lines: string[] = [];
  let bytes = 0;
  /** Add one record, unless the page already holds one and this would overflow it. */
  const push = (record: ObjectExportRecord): boolean => {
    const line = JSON.stringify(record);
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (lines.length > 0 && bytes + size > maxBytes) return false;
    lines.push(line);
    bytes += size;
    return true;
  };
  const page = (next: ExportCursor | null): ObjectExportPage => ({
    lines: lines.length ? `${lines.join('\n')}\n` : '',
    records: lines.length,
    nextCursor: next ? encodeCursor(next) : null,
  });

  if (!cursor) {
    push({ t: 'object', format: OBJECT_EXPORT_FORMAT, mode });
    cursor = { v: 1, mode, phase: 'sql' };
  }
  if (cursor.phase === 'sql') {
    for (const table of listTables(storage)) {
      if (cursor.table !== undefined && table.name < cursor.table) continue;
      let after = cursor.table === table.name ? cursor.after : undefined;
      if (cursor.table !== table.name || !cursor.started) {
        if (!push({ t: 'table', table: table.name, sql: table.sql })) {
          return page({ v: 1, mode, phase: 'sql', table: table.name, started: false });
        }
        after = undefined;
      }
      for (;;) {
        const rows = readRows(storage, table, after);
        for (const { key, row } of rows) {
          const exported = exportedRow(table.name, row, mode);
          if (exported && !push({ t: 'row', table: table.name, row: exported })) {
            return page({ v: 1, mode, phase: 'sql', table: table.name, started: true, ...(after ? { after } : {}) });
          }
          after = key;
        }
        if (rows.length < ROW_BATCH) break;
      }
      // Past this table: the next one starts from its definition.
      cursor = { v: 1, mode, phase: 'sql', table: table.name, started: true };
    }
    cursor = { v: 1, mode, phase: 'kv' };
  }
  let startAfter = cursor.kvAfter;
  for (;;) {
    const entries = await storage.list({ ...(startAfter === undefined ? {} : { startAfter }), limit: KV_BATCH });
    for (const [key, value] of entries) {
      if (!push({ t: 'kv', key, value: encodeStoredValue(value) })) {
        return page({ v: 1, mode, phase: 'kv', ...(startAfter === undefined ? {} : { kvAfter: startAfter }) });
      }
      startAfter = key;
    }
    if (entries.size < KV_BATCH) break;
  }
  return page(null);
}

interface ExportCursor {
  v: 1;
  mode: ObjectExportMode;
  phase: 'sql' | 'kv';
  /** The table being exported. */
  table?: string;
  /** Its definition was already exported. */
  started?: boolean;
  /** The key of the last row exported from it. */
  after?: SqlKey;
  /** The last key-value entry exported. */
  kvAfter?: string;
}

type SqlKey = readonly SqlValue[];
type SqlValue = string | number | null;

interface ExportedTable {
  name: string;
  sql: string | null;
  /** `rowid`, or the primary key columns of a table without one. */
  keyColumns: readonly string[];
}

/**
 * The object's own tables, by name. SQLite's internal tables and Durable
 * Objects' reserved `_cf_` tables (which hold key-value storage, exported
 * through `list`) are not readable as SQL.
 */
function listTables(storage: HostObjectStorage): ExportedTable[] {
  return storage.sql.exec(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
     ORDER BY name`,
  ).toArray().map((row) => {
    const name = String(row.name);
    const sql = typeof row.sql === 'string' ? row.sql : null;
    const withoutRowid = sql !== null && /\bWITHOUT\s+ROWID\b/i.test(sql);
    const keyColumns = withoutRowid
      ? storage.sql.exec(`PRAGMA table_info(${quoteIdentifier(name)})`).toArray()
        .filter((column) => Number(column.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => String(column.name))
      : ['rowid'];
    return { name, sql, keyColumns };
  });
}

function readRows(
  storage: HostObjectStorage,
  table: ExportedTable,
  after: SqlKey | undefined,
): Array<{ key: SqlKey; row: Record<string, unknown> }> {
  const keys = table.keyColumns.map((column, index) => `${quoteIdentifier(column)} AS "__chickpea_key_${index}"`);
  const order = table.keyColumns.map(quoteIdentifier).join(', ');
  const where = after
    ? `WHERE (${order}) > (${table.keyColumns.map(() => '?').join(', ')})`
    : '';
  const rows = storage.sql.exec(
    `SELECT ${keys.join(', ')}, * FROM ${quoteIdentifier(table.name)} ${where} ORDER BY ${order} LIMIT ${ROW_BATCH}`,
    ...(after ?? []),
  ).toArray();
  return rows.map((raw) => {
    const key: SqlValue[] = [];
    const row: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(raw)) {
      const match = /^__chickpea_key_(\d+)$/.exec(column);
      if (match) key[Number(match[1])] = value as SqlValue;
      else row[column] = value;
    }
    return { key, row };
  });
}

/** Columns that hold an envelope's ciphertext or nonce in any table. */
const ENVELOPE_COLUMN = /(^|_)(ciphertext|nonce)$/i;

/**
 * Settings a portable export leaves out: plaintext secrets, OAuth state and
 * the telemetry identity (its HMAC key). Matched as exact keys or prefixes.
 */
const PORTABLE_EXCLUDED_SETTINGS: readonly RegExp[] = [
  /^mcp\./,
  /^connector\./,
  /^connection-account\./,
  /^github\./,
  /^browser\.browserbase\./,
  /^provider\.[^.]+\.apiKey$/,
  /^chatgpt-plan\./,
  /^composio_project$/,
  /^telemetry\.identity\.v1$/,
  /^connection-oauth-continuation\./,
  /^connection-oauth-provider-state\./,
  /^connection-oauth-resume-pending$/,
  /^slack\.pendingEnvelope$/,
];

/** A row as exported, or undefined when a portable export leaves it out. */
function exportedRow(
  table: string,
  row: Record<string, unknown>,
  mode: ObjectExportMode,
): Record<string, unknown> | undefined {
  if (mode === 'portable') {
    if (table === 'app_settings' && typeof row.key === 'string' &&
        PORTABLE_EXCLUDED_SETTINGS.some((pattern) => pattern.test(row.key as string))) {
      return undefined;
    }
  }
  const exported: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    exported[column] = mode === 'portable' && ENVELOPE_COLUMN.test(column) && value !== null
      ? null
      : encodeSqlValue(value);
  }
  return exported;
}

function encodeSqlValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { $bytes: Buffer.from(value).toString('base64') };
  if (ArrayBuffer.isView(value)) {
    return { $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  return value;
}

/**
 * A key-value entry's structured value as JSON: plain data as itself, and
 * the structured-clone types JSON cannot carry tagged by a `$` key (an
 * object whose own keys start with `$` is wrapped in `$object`).
 */
export function encodeStoredValue(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return encodeSqlValue(value);
  if (value instanceof Map) return { $map: [...value].map(([key, item]) => [encodeStoredValue(key), encodeStoredValue(item)]) };
  if (value instanceof Set) return { $set: [...value].map(encodeStoredValue) };
  if (Array.isArray(value)) return value.map(encodeStoredValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, encodeStoredValue(item)] as const);
    const object = Object.fromEntries(entries);
    return entries.some(([key]) => key.startsWith('$')) ? { $object: object } : object;
  }
  return { $unsupported: typeof value };
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function encodeCursor(cursor: ExportCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string, mode: ObjectExportMode): ExportCursor {
  let cursor: Partial<ExportCursor> | undefined;
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ExportCursor>;
  } catch {
    cursor = undefined;
  }
  if (!cursor || cursor.v !== 1 || (cursor.phase !== 'sql' && cursor.phase !== 'kv') ||
      (cursor.table !== undefined && typeof cursor.table !== 'string') ||
      (cursor.after !== undefined && !Array.isArray(cursor.after)) ||
      (cursor.kvAfter !== undefined && typeof cursor.kvAfter !== 'string')) {
    throw new Error('The export cursor is malformed.');
  }
  if (cursor.mode !== mode) throw new Error('The export cursor belongs to an export in another mode.');
  return cursor as ExportCursor;
}
