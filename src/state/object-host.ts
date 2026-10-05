import { createHash } from 'node:crypto';

import {
  deploymentTenancy,
  InstallationContextError,
  requireInstallationScope,
  type InstallationScope,
} from '../config/installation-scope.ts';
import { RETIRED_SETTING_KEYS } from '../config/retired-settings.ts';

/**
 * What a host serving many installations may ask of each Durable Object an
 * installation owns (its state store, thread runners and Flue instances),
 * from an operator job: export its storage, restore it, erase it, and stop
 * the work it would start on its own. Every call names the installation
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

export interface ObjectRestoreBookmarksRequest extends ObjectHostRequest {
  /**
   * Point in time T, in Unix epoch milliseconds: within the last 30 days and
   * strictly before now on the object's own clock.
   */
  readonly timestamp: number;
}

export interface ObjectRestoreBookmarks {
  readonly timestamp: number;
  /** The fence scheduling must present, from this same object; also its undo point. */
  readonly currentBookmark: string;
  readonly targetBookmark: string;
  /**
   * The object's ID and storage when the fence was read, as
   * `objectStorageDigest`. Scheduling compares it, not the bookmark: every
   * new session of an object starts a new current bookmark without any write.
   */
  readonly contentDigest: string;
}

export interface ObjectRestoreRequest extends ObjectHostRequest {
  readonly expectedCurrentBookmark: string;
  /**
   * The `contentDigest` this object's preparation read with that fence:
   * scheduling refuses once the storage differs from it, or when it is
   * another object's.
   */
  readonly expectedContentDigest: string;
  readonly targetBookmark: string;
}

/** A scheduled restore: the object's storage becomes `targetBookmark` when it next restarts. */
export interface ObjectRestoreReceipt {
  readonly expectedCurrentBookmark: string;
  readonly expectedContentDigest: string;
  readonly targetBookmark: string;
  /** Cloudflare's bookmark for just before the restore; restoring to it undoes the restore. */
  readonly undoBookmark: string;
}

export interface ObjectRestoreRestartRequest extends ObjectHostRequest {
  /** The fence the restore was scheduled against: its receipt's `expectedCurrentBookmark`. */
  readonly expectedCurrentBookmark: string;
}

/**
 * Returned only by a session with no restore scheduled in it whose current
 * bookmark is no longer the fence and whose storage no longer holds the
 * restore mark (`OBJECT_RESTORE_MARK_KEY`) its scheduling wrote. Given the
 * receipt, the restore has applied: the mark was written after the restore
 * was scheduled, so only the restore removes it. A session still holding it
 * refuses with `restore_not_applied`. Without a receipt this proves nothing:
 * every new session leaves the fence.
 */
export interface ObjectRestoreApplied {
  readonly applied: true;
  readonly currentBookmark: string;
  /**
   * The storage this session holds, as `objectStorageDigest`, read in the
   * same input gate as `currentBookmark`; null when it is over the digest
   * budget. A record of what the restored object holds; it decides nothing.
   * Equal to the prepared `contentDigest` is expected of an object that held
   * at T what it held at preparation, and a waking Sandbox arms its container
   * runtime's alarm, which changes it.
   */
  readonly contentDigest: string | null;
}

export interface InstallationObjectRestoreRpc {
  chickpeaHostRestoreBookmarks(request: ObjectRestoreBookmarksRequest): Promise<ObjectRestoreBookmarks>;
  /**
   * Schedules the restore for the object's next session and returns the receipt.
   * Does not restart the object: `chickpeaHostRestoreRestart` does.
   */
  chickpeaHostRestore(request: ObjectRestoreRequest): Promise<ObjectRestoreReceipt>;
  /**
   * Restarts the object when this session has the restore scheduled, which
   * interrupts the call. Otherwise returns only once the bookmark has left
   * the fence and the restore mark is gone; refuses with
   * `restore_not_scheduled` while the object still holds the fence, and with
   * `restore_not_applied` while it still holds the mark. Every new session
   * leaves the fence, so the return proves the restore applied only to a
   * caller holding its receipt.
   */
  chickpeaHostRestoreRestart(request: ObjectRestoreRestartRequest): Promise<ObjectRestoreApplied>;
}

/** The SQLite PITR and lifecycle APIs from DurableObjectState, without a runtime import. */
export interface HostObjectRestoreContext {
  /**
   * The object's ID, which its content digest binds as `toString()`. Every
   * session has it, unlike its name, which a session woken by ID (a
   * Sandbox's egress handler or lease sweep) lacks; a named object's ID is
   * derived from its name, so it binds the name too.
   */
  readonly id: { toString(): string };
  readonly storage: {
    getCurrentBookmark(): Promise<string>;
    getBookmarkForTime(timestamp: number | Date): Promise<string>;
    onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  abort(reason?: string): void;
}

/** The reason a restart passes to `ctx.abort`; the runtime logs it with the reset. */
export const OBJECT_RESTORE_ABORT_REASON = 'Installation point-in-time restore';

/**
 * The key-value entry scheduling writes, holding the fence, right after the
 * restore is scheduled. Every write since the target is discarded by the
 * restore, this one included, so a later session that still holds it
 * restarted without restoring. The fence did not exist at T, so storage at T
 * never holds this restore's mark. A back-out to the receipt's undo bookmark
 * brings back the first restore's mark, which the back-out's own fence does
 * not match.
 */
export const OBJECT_RESTORE_MARK_KEY = 'chickpea.restore.scheduled.v1';

const OBJECT_RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export type ObjectRestoreErrorCode =
  | 'restore_time_invalid'
  | 'restore_bookmark_invalid'
  | 'restore_digest_invalid'
  | 'restore_content_moved'
  | 'restore_object_too_large'
  | 'restore_unavailable'
  | 'restore_object_busy'
  | 'restore_already_scheduled'
  | 'restore_not_scheduled'
  | 'restore_not_applied'
  | 'restore_restarting';

export class ObjectRestoreError extends Error {
  constructor(readonly code: ObjectRestoreErrorCode, message: string) {
    super(message);
    this.name = 'ObjectRestoreError';
  }
}

/**
 * The restore each object session has scheduled, by its context. A restart
 * or an eviction gives the object a new context, which has none: the restore
 * has applied.
 */
const scheduledRestores = new WeakMap<HostObjectRestoreContext, ObjectRestoreReceipt>();

/**
 * Read an object's bookmarks, schedule its restore and restart it, while the
 * host keeps its installation suspended. Scheduling and restarting are
 * separate calls so the host can schedule every object of an installation,
 * each against its own fence, before any of them restarts into restored
 * state and writes to another (see docs/design/installation-restore.md).
 * Cloudflare validates the opaque target bookmark and its retained history.
 *
 * Scheduling checks the storage, not the bookmark, against preparation: a
 * Durable Object evicted and woken again starts a new current bookmark
 * without writing anything, so an idle object's bookmark rarely survives
 * until scheduling, while its storage does. The digest is bounded by
 * `OBJECT_DIGEST_BUDGET`: it runs inside `blockConcurrencyWhile`, which
 * resets the object after 30 seconds. Restart tells an applied restore from
 * one that never applied by the mark scheduling writes after scheduling
 * (`OBJECT_RESTORE_MARK_KEY`), not by the digest: storage idle since T
 * digests the same restored or not.
 */
export function objectRestoreHostFunctions(object: {
  readonly env: Record<string, unknown> | undefined;
  /** What the content digest covers: the storage a restore replaces. */
  readonly storage: HostObjectStorage;
  readonly restoreContext?: HostObjectRestoreContext;
  /** Ownership checks beyond the object's name, within the input gate of every restore call. */
  readonly assertOwner?: (scope: InstallationScope) => void;
  /**
   * Within the input gate, before a fence is read for preparing or scheduling:
   * refuse an object that is not quiet, and settle the writes it would
   * otherwise make right after the read. Never on restart.
   */
  readonly quiesce?: () => Promise<void>;
  /** `OBJECT_DIGEST_BUDGET` unless a test sets a smaller one. */
  readonly digestBudget?: ObjectDigestBudget;
}): InstallationObjectRestoreRpc {
  /** The object's session context and the ID its digest binds. */
  const context = (): { ctx: HostObjectRestoreContext; objectId: string } => {
    const ctx = object.restoreContext;
    if (!ctx) throw new ObjectRestoreError('restore_unavailable', 'This object has no SQLite restore context.');
    // Not the name: a session woken by ID has none, and a digest that bound
    // it only where present would differ between two sessions of one object.
    const objectId = ctx.id.toString === Object.prototype.toString ? '' : String(ctx.id.toString());
    if (!objectId) throw new ObjectRestoreError('restore_unavailable', 'This object has no ID to bind its content digest to.');
    return { ctx, objectId };
  };
  const digest = (objectId: string): Promise<string> =>
    objectStorageDigest(object.storage, objectId, object.digestBudget ?? OBJECT_DIGEST_BUDGET);
  return {
    async chickpeaHostRestoreBookmarks(request) {
      const scope = assertObjectHostCall(object.env, request);
      const { timestamp } = request;
      const now = Date.now();
      if (!Number.isSafeInteger(timestamp) || timestamp < now - OBJECT_RESTORE_WINDOW_MS || timestamp >= now) {
        throw new ObjectRestoreError('restore_time_invalid', 'Restore time must be within the past 30 days and before now.');
      }
      const { ctx, objectId } = context();
      return restoreExclusive(ctx, async () => {
        object.assertOwner?.(scope);
        if (scheduledRestores.has(ctx)) throw alreadyScheduled();
        await object.quiesce?.();
        const targetBookmark = await ctx.storage.getBookmarkForTime(timestamp);
        const currentBookmark = await ctx.storage.getCurrentBookmark();
        const contentDigest = await digest(objectId);
        return { timestamp, currentBookmark, targetBookmark, contentDigest };
      });
    },
    async chickpeaHostRestore(request) {
      const scope = assertObjectHostCall(object.env, request);
      const { expectedCurrentBookmark, expectedContentDigest, targetBookmark } = request;
      if (typeof expectedCurrentBookmark !== 'string' || !expectedCurrentBookmark.trim() ||
          typeof targetBookmark !== 'string' || !targetBookmark.trim()) {
        throw new ObjectRestoreError('restore_bookmark_invalid', 'Restore requires current and target bookmarks.');
      }
      if (typeof expectedContentDigest !== 'string' || !expectedContentDigest.trim()) {
        throw new ObjectRestoreError('restore_digest_invalid', 'Restore requires the content digest read with its fence.');
      }
      const { ctx, objectId } = context();
      return restoreExclusive(ctx, async () => {
        object.assertOwner?.(scope);
        // The session holding a restore answers a repeated call, whose first
        // answer was lost, with the same receipt, but only when it presents
        // the same fence, digest and target. Anything else, and a new
        // preparation, is refused until the object restarts.
        const scheduled = scheduledRestores.get(ctx);
        if (scheduled) {
          if (scheduled.expectedCurrentBookmark === expectedCurrentBookmark &&
              scheduled.expectedContentDigest === expectedContentDigest && scheduled.targetBookmark === targetBookmark) {
            return scheduled;
          }
          throw alreadyScheduled();
        }
        await object.quiesce?.();
        if (await digest(objectId) !== expectedContentDigest) {
          throw new ObjectRestoreError(
            'restore_content_moved',
            'The storage no longer matches the prepared digest, or the digest is another object\'s; prepare it again.',
          );
        }
        const undoBookmark = await ctx.storage.onNextSessionRestoreBookmark(targetBookmark);
        const receipt: ObjectRestoreReceipt = { expectedCurrentBookmark, expectedContentDigest, targetBookmark, undoBookmark };
        scheduledRestores.set(ctx, receipt);
        // After scheduling, so the restore discards it: restart reads it back.
        await object.storage.put(OBJECT_RESTORE_MARK_KEY, expectedCurrentBookmark);
        return receipt;
      });
    },
    async chickpeaHostRestoreRestart(request) {
      const scope = assertObjectHostCall(object.env, request);
      const { expectedCurrentBookmark } = request;
      if (typeof expectedCurrentBookmark !== 'string' || !expectedCurrentBookmark.trim()) {
        throw new ObjectRestoreError('restore_bookmark_invalid', 'Restart requires the fence the restore was scheduled against.');
      }
      const { ctx, objectId } = context();
      return restoreExclusive(ctx, async () => {
        object.assertOwner?.(scope);
        const scheduled = scheduledRestores.get(ctx);
        if (scheduled) {
          if (scheduled.expectedCurrentBookmark !== expectedCurrentBookmark) {
            throw new ObjectRestoreError('restore_already_scheduled', 'A restore against another fence is scheduled.');
          }
          ctx.abort(OBJECT_RESTORE_ABORT_REASON);
          // Not reached once the reset takes effect; a session that runs on must not report the restore applied.
          throw new ObjectRestoreError('restore_restarting', 'The object is restarting to apply its restore; call again.');
        }
        // A new session. Every session starts a new bookmark, so this proves
        // nothing without a receipt.
        const currentBookmark = await ctx.storage.getCurrentBookmark();
        if (currentBookmark === expectedCurrentBookmark) {
          throw new ObjectRestoreError('restore_not_scheduled', 'No restore is scheduled or applied: the object still holds the fence.');
        }
        // Given the receipt, its scheduling wrote the mark after scheduling:
        // a restore discards it, so a session still holding it never restored.
        if (await object.storage.get(OBJECT_RESTORE_MARK_KEY) === expectedCurrentBookmark) {
          throw new ObjectRestoreError(
            'restore_not_applied',
            'The object restarted still holding what was written after its restore was scheduled: the restore did not apply.',
          );
        }
        // The restored storage may be larger than the prepared one: over the
        // budget the answer stands without a digest rather than failing.
        let contentDigest: string | null = null;
        try {
          contentDigest = await digest(objectId);
        } catch (error) {
          if (!(error instanceof ObjectRestoreError && error.code === 'restore_object_too_large')) throw error;
        }
        return { applied: true as const, currentBookmark, contentDigest };
      });
    },
  };
}

function alreadyScheduled(): ObjectRestoreError {
  return new ObjectRestoreError('restore_already_scheduled', 'A restore is already scheduled; restart the object first.');
}

/** Keep each restore call's checks, fence and scheduling in one input gate. A refusal must not reset the object. */
async function restoreExclusive<T>(ctx: HostObjectRestoreContext, operation: () => Promise<T>): Promise<T> {
  const result = await ctx.blockConcurrencyWhile(async () => {
    try {
      return { ok: true as const, value: await operation() };
    } catch (error) {
      // A rejected blockConcurrencyWhile callback resets the object. Throw
      // outside it so an invalid request or a moved fence leaves it alone.
      return { ok: false as const, error };
    }
  });
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * `portable` leaves out what only this deployment can use or must never
 * leave it: every envelope (a ciphertext or nonce column, and any JSON
 * object carrying both a `ciphertext` and a `nonce`, at any depth of a stored
 * value, is nulled), every plaintext secret setting (MCP, API and connection
 * credentials and OAuth state, GitHub, Browserbase, plaintext model keys),
 * the telemetry HMAC key, OAuth continuation state, and Chickpea's own setup
 * capabilities: the `#setup=` fragment of every setup link, in a link field
 * (`setupUrl`, `handoffUrl`) or in text that carries the link (a posted
 * Slack message, a transcript), is cut, leaving the link without the
 * capability. `full` keeps everything, so it is only as safe as wherever it
 * is stored.
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
 * The note an export carries for coding workspaces, whose files and
 * checkpoints it leaves out: a working copy of the tenant's GitHub
 * repositories, kept at most three days, that may hold `.env` files.
 */
export const CODING_WORKSPACE_EXPORT_NOTE = 'Unpushed work in a coding workspace is not exported.';

/**
 * One line of an export:
 * - `object`: the first line, naming the format and mode, and for an object
 *   whose storage is left out (a coding workspace's Sandbox) the note why;
 * - `table`: a SQL table's definition, before its rows;
 * - `row`: one row, every column (BLOBs as `{"$bytes": base64}`);
 * - `kv`: one key-value storage entry (structured values tagged, see `encodeStoredValue`).
 */
export type ObjectExportRecord =
  | { t: 'object'; format: typeof OBJECT_EXPORT_FORMAT; mode: ObjectExportMode; note?: string }
  | { t: 'table'; table: string; sql: string | null }
  | { t: 'row'; table: string; row: Record<string, unknown> }
  | { t: 'kv'; key: string; value: unknown };

export interface ObjectEraseResult {
  readonly erased: true;
}

/** What one object stopped: its alarm, and for a thread runner its open jobs. */
export interface ObjectPendingWorkCancellation {
  readonly alarmCleared: true;
  /** Thread runners: open jobs not running, settled without running. */
  readonly runnerJobs?: number;
  /**
   * Thread runners: jobs still running, not stopped here. Each settles as
   * its run ends; its turn is parked in the state store, which aborts its
   * submission, and the installation's admission refuses its model calls.
   */
  readonly runnerJobsRunning?: number;
}

/** The host functions every installation object answers; each class delegates to `objectHostFunctions`. */
export interface InstallationObjectHostRpc extends InstallationObjectRestoreRpc {
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
    exec(query: string, ...bindings: unknown[]): {
      toArray(): Record<string, unknown>[];
      /** Steps the statement a row at a time, each row its values in column order, as `SqlStorageCursor` does. */
      raw(): Iterable<unknown[]>;
      readonly columnNames: readonly string[];
    };
    /** The SQLite database's size in bytes, as `SqlStorage.databaseSize`: indexes, key-value storage and free pages included. */
    readonly databaseSize: number;
  };
  list(options?: { startAfter?: string; limit?: number }): Promise<Map<string, unknown>>;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
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
  readonly restoreContext?: HostObjectRestoreContext;
  readonly onErased?: () => void;
  readonly cancel?: (now: number) => Omit<ObjectPendingWorkCancellation, 'alarmCleared'>;
  /** Refuses a restore's preparation and scheduling while the object has work owed (see `objectRestoreHostFunctions`). */
  readonly quiesce?: () => Promise<void>;
  readonly digestBudget?: ObjectDigestBudget;
}): InstallationObjectHostRpc {
  return {
    ...objectRestoreHostFunctions(object),
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
      const encoded = encodeStoredValue(value);
      if (!push({ t: 'kv', key, value: mode === 'portable' ? portableValue(encoded) : encoded })) {
        return page({ v: 1, mode, phase: 'kv', ...(startAfter === undefined ? {} : { kvAfter: startAfter }) });
      }
      startAfter = key;
    }
    if (entries.size < KV_BATCH) break;
  }
  return page(null);
}

/** How much one content digest may read before it refuses (see `OBJECT_DIGEST_BUDGET`). */
export interface ObjectDigestBudget {
  /** Records: the ID, schema entries, table headers, rows, key-value entries and the alarm. */
  readonly rows: number;
  /** Column values: every value of every row, so wide rows reach it before `rows`. */
  readonly cells: number;
  /** UTF-8 bytes of the records' serialized form, BLOBs in base64. */
  readonly bytes: number;
  /** The SQLite database's size (`databaseSize`), checked before anything is read. */
  readonly databaseBytes: number;
}

/**
 * The bound on one content digest: 500,000 records, 16,000,000 column values
 * (500,000 rows of 32 columns) or 512 MiB serialized, whichever comes first,
 * and refused before reading anything when the database is over 2 GiB. The
 * digest runs inside `blockConcurrencyWhile`, after whose 30 seconds
 * Cloudflare resets the object, so an object too large to digest in time
 * would be reset by every preparation and could never be restored.
 * Measured on local workerd SQLite inside the gate, a digest at this bound
 * takes at most 1.1 s (500,000 rows of 30 columns; 1.0 s for rows of the
 * widest Chickpea table's 52 columns, 0.9 s for 100 columns or 490,000
 * key-value entries, 0.3 s for 512 MiB of transcript chunks), and a refusal
 * stops within 0.9 s. Allowing for run-to-run variance of up to 1.7x and a
 * production CPU twice as slow, that is about 3.7 s, an eighth of the gate's
 * 30 s and of the 30 s of CPU a request gets. The values bound is what keeps
 * wide rows there: 500,000 rows of 100 columns took 2.85 s, about 9.7 s
 * with the same allowances, a margin of only 3x. Reading pages a deployed
 * object has not cached is not measured; staging times the largest real
 * object before apply is enabled (docs/design/installation-restore.md).
 * The database size counts indexes, key-value storage and free pages, so
 * its bound is four times the serialized one: it refuses only an object far
 * over the others. Reading a row at a time keeps memory to one row (at most
 * 2 MB) and 16 key-value entries, far under an isolate's 128 MB.
 */
export const OBJECT_DIGEST_BUDGET: ObjectDigestBudget = Object.freeze({
  rows: 500_000,
  cells: 16_000_000,
  bytes: 512 * 1024 * 1024,
  databaseBytes: 2 * 1024 * 1024 * 1024,
});

/** Key-value entries a digest lists at once: up to 2 MB each, so at most 32 MB held. */
const DIGEST_KV_BATCH = 16;

/**
 * A SHA-256 digest of one object's ID and everything a restore replaces:
 * each schema entry (but SQLite's and Durable Objects' own), every row of
 * every table in key order, every key-value entry and the alarm. Unlike an
 * export, it leaves nothing out. Equal digests mean the same object holding
 * equal storage whatever the bookmarks say; a write that changes what is
 * stored changes it, and one that stores the same values again does not.
 * Values are compared as JavaScript reads them, so it does not tell apart an
 * INTEGER from an equal REAL or integers beyond 2^53 that read alike. It
 * leaves out `sqlite_sequence` (AUTOINCREMENT counters) with SQLite's own
 * tables, and the rowid of a table without an INTEGER PRIMARY KEY, which
 * `SELECT *` does not return: its rows are read in rowid order, but rows
 * renumbered in the same order digest alike.
 *
 * `objectId` is the object's ID (`ctx.id.toString()`), which makes the digest
 * this object's. Each table is one statement read a row at a time as an
 * array of values, its column names hashed once: memory holds one row, not
 * the table. Past `budget` it stops reading and refuses with
 * `restore_object_too_large`; over its database size, before reading.
 */
export async function objectStorageDigest(
  storage: HostObjectStorage,
  objectId: string,
  budget: ObjectDigestBudget = OBJECT_DIGEST_BUDGET,
): Promise<string> {
  const tooLarge = (): ObjectRestoreError => new ObjectRestoreError(
    'restore_object_too_large',
    `This object holds more than a restore can check: over ${budget.rows} records, ${budget.cells} values, `
      + `${budget.bytes} bytes or a ${budget.databaseBytes}-byte database.`,
  );
  if (storage.sql.databaseSize > budget.databaseBytes) throw tooLarge();
  const hash = createHash('sha256');
  let rows = 0;
  let cells = 0;
  let bytes = 0;
  const add = (record: unknown): void => {
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    rows += 1;
    bytes += line.byteLength;
    if (rows > budget.rows || cells > budget.cells || bytes > budget.bytes) throw tooLarge();
    hash.update(line);
  };
  add(['object', objectId]);
  for (const entry of storage.sql.exec(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE ${OWN_SCHEMA_ENTRY} ORDER BY type, name`,
  ).raw()) {
    add(['schema', ...entry]);
  }
  for (const table of listTables(storage)) {
    const rowsOf = storage.sql.exec(
      `SELECT * FROM ${quoteIdentifier(table.name)} ORDER BY ${table.keyColumns.map(quoteIdentifier).join(', ')}`,
    );
    add(['table', table.name, rowsOf.columnNames]);
    for (const values of rowsOf.raw()) {
      cells += values.length;
      add(['row', values.map(encodeSqlValue)]);
    }
  }
  let startAfter: string | undefined;
  for (;;) {
    const entries = await storage.list({ ...(startAfter === undefined ? {} : { startAfter }), limit: DIGEST_KV_BATCH });
    for (const [key, value] of entries) {
      add(['kv', key, encodeStoredValue(value)]);
      startAfter = key;
    }
    if (entries.size < DIGEST_KV_BATCH) break;
  }
  add(['alarm', await storage.getAlarm()]);
  return `sha256:${hash.digest('hex')}`;
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
 * A `sqlite_master` entry of the object's own: not SQLite's internal ones nor
 * Durable Objects' reserved `_cf_` ones (which hold key-value storage, read
 * through `list`), which are not readable as SQL.
 */
const OWN_SCHEMA_ENTRY = "name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'";

/** The object's own tables, by name. */
function listTables(storage: HostObjectStorage): ExportedTable[] {
  return storage.sql.exec(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND ${OWN_SCHEMA_ENTRY} ORDER BY name`,
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

/**
 * Settings no export carries: the host's operational records of the
 * installation's coding workspaces (running-container leases, metered
 * container time, the GitHub write rate). A census counts them; erasure
 * deletes them with the store.
 */
const OPERATIONAL_SETTINGS: readonly RegExp[] = [
  /^sandbox\.containerLeases$/,
  /^sandbox\.monthlyContainerSeconds\./,
  /^sandbox\.githubWrites$/,
];

/** A row as exported, or undefined when the export leaves it out. */
function exportedRow(
  table: string,
  row: Record<string, unknown>,
  mode: ObjectExportMode,
): Record<string, unknown> | undefined {
  if (table === 'app_settings' && typeof row.key === 'string') {
    const key = row.key;
    if (OPERATIONAL_SETTINGS.some((pattern) => pattern.test(key))) return undefined;
    // A retired setting is not the installation's configuration any more.
    if (RETIRED_SETTING_KEYS.has(key)) return undefined;
    if (mode === 'portable' && PORTABLE_EXCLUDED_SETTINGS.some((pattern) => pattern.test(key))) return undefined;
  }
  const exported: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (mode !== 'portable') exported[column] = encodeSqlValue(value);
    else if (ENVELOPE_COLUMN.test(column) && value !== null) exported[column] = null;
    else exported[column] = encodeSqlValue(typeof value === 'string' ? portableValue(value) : value);
  }
  return exported;
}

/**
 * A stored value as a portable export carries it: every envelope in it
 * nulled (any object that carries both a `ciphertext` and a `nonce`) and
 * every setup capability cut, at any depth, including inside a string that
 * parses as a JSON object or array (a setting's value, a record's JSON
 * column, a transcript). Settings keep envelopes inside their JSON values,
 * such as the gateway deployment identity's private key and the HTTP
 * delivery keys, so redaction follows the structure, not a list of keys. A
 * value with neither is returned as it is, byte for byte.
 */
function portableValue(value: unknown, field?: string): unknown {
  if (typeof value === 'string') {
    const parsed = jsonStructure(value);
    if (parsed === undefined) return withoutSetupCapabilities(value, field);
    const redacted = portableValue(parsed);
    return redacted === parsed ? value : JSON.stringify(redacted);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => portableValue(item));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (Object.hasOwn(value, 'ciphertext') && Object.hasOwn(value, 'nonce')) return null;
  const entries = Object.entries(value).map(([key, item]) => [key, portableValue(item, key)] as const);
  return entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key])
    ? Object.fromEntries(entries)
    : value;
}

/**
 * Fields that hold a Chickpea setup link (`/setup/<operation>#setup=…`,
 * `/admin/setup#setup=…`): a management receipt's connector actions and
 * Agent link, and a setup tool's result.
 */
const SETUP_LINK_FIELDS: ReadonlySet<string> = new Set(['setupUrl', 'handoffUrl']);

/**
 * A setup capability rides only in a link's `#setup=` fragment (never sent
 * to a server); it is 43 base64url characters (src/auth/setup-capability.mjs,
 * management/service.ts). In a link field the whole fragment goes, whatever
 * it holds; in text, the fragment of each of Chickpea's own setup links
 * (`/setup/<operation>`, `/admin/setup`), such as a posted Slack link
 * `<https://…/setup/…#setup=…|Connect …>`. Anyone else's link stays as it is.
 */
const SETUP_LINK_FIELD_FRAGMENT = /#setup=[^\s<>|"']*/g;
const SETUP_CAPABILITY_IN_TEXT =
  /(https?:\/\/[^\s<>|"'`#/]+\/(?:setup\/[A-Za-z0-9._~%-]+|admin\/setup))#setup=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

function withoutSetupCapabilities(text: string, field: string | undefined): string {
  if (!text.includes('#setup=')) return text;
  return field !== undefined && SETUP_LINK_FIELDS.has(field)
    ? text.replace(SETUP_LINK_FIELD_FRAGMENT, '')
    : text.replace(SETUP_CAPABILITY_IN_TEXT, '$1');
}

/** A string's JSON object or array, or undefined when it holds neither. */
function jsonStructure(text: string): object | undefined {
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
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
