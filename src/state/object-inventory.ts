import { createHash } from 'node:crypto';

import {
  deploymentTenancy,
  InstallationContextError,
  requireInstallationScope,
  scopedObjectName,
  splitInstallationObjectName,
  type InstallationScope,
} from '../config/installation-scope.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { runnerKeyOf } from '../slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import { schemaInstallRequired, type StateDb } from './state-db.ts';

/**
 * The Durable Objects an installation of a deployment serving many owns,
 * besides its state store. Object IDs are hashes of names and Cloudflare
 * lists no object by name, so an object whose name is not recorded here can
 * be neither exported, erased nor restored. Each name is recorded where it is
 * first persisted, before anything can address it:
 *
 * - `thread_runner`: a Slack thread's turn runner, when a turn is enqueued;
 * - `slack_agent`: a Slack thread's Flue transcript, when a turn freezes its
 *   runtime plan (which names the instance);
 * - `routine_agent`: one routine attempt's Flue instance, when the attempt's
 *   dispatch envelope is persisted;
 * - `sandbox`: a coding workspace's Sandbox, by its hosted name
 *   (sandbox/sandbox-object.ts), before anything addresses it;
 * - `coding_worker`: a coding worker's Flue instance, before its task is
 *   recorded or dispatched.
 *
 * The state store itself is implicit: its name is the installation's.
 */
export const INSTALLATION_OBJECT_KINDS = [
  'coding_worker',
  'routine_agent',
  'sandbox',
  'slack_agent',
  'thread_runner',
] as const;
export type InstallationObjectKind = typeof INSTALLATION_OBJECT_KINDS[number];

/** Objects of a coding workspace, recorded by whoever first addresses them (not by a store). */
export type InstallationWorkspaceObjectKind = 'coding_worker' | 'sandbox';

/** One recorded object: its kind and the exact name the host addresses it by. */
export interface InstallationObjectRecord {
  readonly kind: InstallationObjectKind;
  readonly name: string;
  /**
   * When the name was recorded, before anything addressed the object; or
   * `BACKFILLED_FIRST_SEEN_AT` (0) for a name the backfill recorded, whose
   * object predates the inventory.
   */
  readonly firstSeenAt: number;
}

/**
 * The `first_seen_at` of a name the backfill records. Its object predates
 * the inventory, at a time nothing kept, so it is stamped as older than any
 * point a restore can target: preparing a restore never skips it as younger.
 */
export const BACKFILLED_FIRST_SEEN_AT = 0;

export interface InstallationObjectInventoryPage {
  readonly objects: readonly InstallationObjectRecord[];
  /** Pass back to read the next page; null once every object was listed. */
  readonly nextCursor: string | null;
}

export interface InstallationObjectBackfill {
  /** Names recorded from the store's surviving records, per kind (already-recorded names included). */
  readonly recovered: Readonly<Record<InstallationObjectKind, number>>;
  /**
   * At least this many objects exist that cannot be addressed: Flue
   * instances the Work ledger saw run whose names nothing left can tell. A
   * lower bound, not a count: thread runners whose turns aged out of
   * `turn_jobs`, guest runners especially, are not counted, because the Work
   * ledger keeps no reference to a runner.
   */
  readonly unknownResidue: number;
}

/** What the stores that first persist an object name use to record it. */
export interface InstallationObjectRecorder {
  /** The turn runner of one Slack thread key (standalone name). */
  recordThreadRunner(threadKey: string): void;
  /** A Flue instance, by the instance ID that already names its installation. */
  recordAgentInstance(kind: 'routine_agent' | 'slack_agent', instanceId: string): void;
}

/** One object of a coding workspace, by the exact name that already names its installation. */
export interface InstallationWorkspaceObject {
  readonly kind: InstallationWorkspaceObjectKind;
  readonly name: string;
}

const MAX_PAGE = 1_000;
const DEFAULT_PAGE = 500;
/** Owner incarnations of one thread route to name; a route past this is malformed. */
const MAX_ROUTE_INCARNATIONS = 64;

/**
 * The installation's object inventory in its state store. Only a store
 * serving many installations creates the table, outside every schema
 * ledger like `installation_binding`, so standalone never migrates for it
 * and records nothing. Names are never pruned: only erasure removes them,
 * with the store.
 */
export class InstallationObjectInventoryLogic implements InstallationObjectRecorder {
  private readonly scope: InstallationScope | undefined;

  constructor(
    private readonly db: StateDb,
    env: Record<string, unknown> | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.scope = deploymentTenancy(env) === 'installation' ? requireInstallationScope(env) : undefined;
    if (this.scope && schemaInstallRequired(db)) installInventoryTable(db);
  }

  /** Whether this store records objects: it serves one installation of many. */
  get enabled(): boolean {
    return this.scope !== undefined;
  }

  recordThreadRunner(threadKey: string): void {
    if (!this.scope) return;
    this.insert('thread_runner', scopedObjectName(this.scope, threadKey));
  }

  recordAgentInstance(kind: 'routine_agent' | 'slack_agent', instanceId: string): void {
    if (!this.scope) return;
    this.insert(kind, this.ownName(instanceId));
  }

  /**
   * A coding workspace's Sandbox or coding worker, by its hosted name. Its
   * opener records it here before addressing it; only a store serving one
   * installation of many records anything.
   */
  recordWorkspaceObject(object: InstallationWorkspaceObject): void {
    if (!this.scope) return;
    const pattern = WORKSPACE_OBJECT_NAMES[object.kind];
    if (!pattern) throw new Error('Unknown coding workspace object kind.');
    const name = this.ownName(object.name);
    if (!pattern.test(splitInstallationObjectName(name).name)) {
      throw new InstallationContextError('installation_context_invalid', 'The object name is malformed.');
    }
    this.insert(object.kind, name);
  }

  /** Every recorded object, ordered by kind then name, a page at a time. */
  list(input: { cursor?: string | null | undefined; limit?: number | undefined } = {}): InstallationObjectInventoryPage {
    this.requireEnabled();
    const limit = pageLimit(input.limit);
    const after = input.cursor ? decodeCursor(input.cursor) : undefined;
    const rows = after
      ? this.db.all(
        `SELECT kind, name, first_seen_at FROM installation_object_inventory
         WHERE (kind, name) > (?, ?) ORDER BY kind, name LIMIT ?`,
        after[0], after[1], limit + 1,
      )
      : this.db.all(
        'SELECT kind, name, first_seen_at FROM installation_object_inventory ORDER BY kind, name LIMIT ?',
        limit + 1,
      );
    const objects = rows.slice(0, limit).map((row) => ({
      kind: String(row.kind) as InstallationObjectKind,
      name: String(row.name),
      firstSeenAt: Number(row.first_seen_at),
    }));
    const last = objects.at(-1);
    return {
      objects,
      nextCursor: rows.length > limit && last ? encodeCursor([last.kind, last.name]) : null,
    };
  }

  /** Recorded objects per kind. */
  counts(): Record<InstallationObjectKind, number> {
    this.requireEnabled();
    const counts = emptyCounts();
    for (const row of this.db.all(
      'SELECT kind, COUNT(*) AS count FROM installation_object_inventory GROUP BY kind',
    )) counts[String(row.kind) as InstallationObjectKind] = Number(row.count);
    return counts;
  }

  /**
   * Record the names an installation's stores still hold, for objects
   * created before the inventory existed: turn rows (runner keys, Flue
   * instances and the instances they replaced), the Slack conversation
   * bindings (30 days), routine attempts' envelopes (365 days) and thread
   * routes (runner keys of every owner incarnation). Safe to repeat. What
   * aged out of all of them is counted from the Work ledger, which keeps an
   * opaque reference to every Flue instance that ran but cannot name one.
   * That count is a lower bound: a thread runner leaves no such reference.
   * A name it records gets `BACKFILLED_FIRST_SEEN_AT`; one already recorded
   * keeps its time.
   */
  backfill(): InstallationObjectBackfill {
    this.requireEnabled();
    // No coding workspace object predates the inventory: hosted Sandboxes arrived with it.
    const recovered = emptyCounts();
    const runners = new Set<string>();
    const agents = { routine_agent: new Set<string>(), slack_agent: new Set<string>() };
    const ownAgent = (kind: 'routine_agent' | 'slack_agent', value: unknown) => {
      if (typeof value !== 'string' || value.length === 0) return;
      const split = splitInstallationObjectName(value);
      if (split.scope?.installationId === this.scope!.installationId) agents[kind].add(value);
    };

    if (this.hasTable('turn_jobs')) {
      for (const row of this.db.all(
        `SELECT turn_json, assignment_json, agent_instance_id,
           json_extract(dispatch_envelope_json, '$.previousBinding.instanceId') AS previous_instance_id
         FROM turn_jobs`,
      )) {
        ownAgent('slack_agent', row.agent_instance_id);
        ownAgent('slack_agent', row.previous_instance_id);
        const key = storedRunnerKey(row.turn_json, row.assignment_json);
        if (key) runners.add(key);
      }
    }
    if (this.hasTable('slack_agent_bindings')) {
      for (const row of this.db.all('SELECT instance_id FROM slack_agent_bindings')) {
        ownAgent('slack_agent', row.instance_id);
      }
    }
    if (this.hasTable('routine_runs')) {
      for (const row of this.db.all(
        `SELECT json_extract(flue_agent_envelope_json, '$.instanceId') AS instance_id
         FROM routine_runs WHERE flue_agent_envelope_json IS NOT NULL`,
      )) ownAgent('routine_agent', row.instance_id);
    }
    if (this.hasTable('config_agent_thread_routes')) {
      for (const row of this.db.all(
        'SELECT workspace_id, channel_id, thread_ts, owner_incarnation FROM config_agent_thread_routes',
      )) {
        const incarnations = Math.min(Number(row.owner_incarnation) || 1, MAX_ROUTE_INCARNATIONS);
        for (let incarnation = 1; incarnation <= incarnations; incarnation += 1) {
          runners.add(`${String(row.workspace_id)}:${String(row.channel_id)}:${String(row.thread_ts)}:owner-i${incarnation}`);
        }
      }
    }

    this.db.transaction(() => {
      for (const key of runners) {
        this.insert('thread_runner', scopedObjectName(this.scope!, key), BACKFILLED_FIRST_SEEN_AT);
      }
      for (const kind of ['routine_agent', 'slack_agent'] as const) {
        for (const name of agents[kind]) this.insert(kind, name, BACKFILLED_FIRST_SEEN_AT);
      }
    });
    recovered.thread_runner = runners.size;
    recovered.slack_agent = agents.slack_agent.size;
    recovered.routine_agent = agents.routine_agent.size;
    return { recovered, unknownResidue: this.unknownResidue() };
  }

  /**
   * Flue instances the Work ledger saw run that the inventory cannot name;
   * runners are not counted. An approval the host applied ran no Flue
   * instance: releases before this one still gave its execution a
   * reference, made up from its thread key, that names no object.
   */
  private unknownResidue(): number {
    if (!this.hasTable('run_executions')) return 0;
    const known = new Set(this.db.all(
      "SELECT name FROM installation_object_inventory WHERE kind IN ('routine_agent', 'slack_agent')",
    ).map((row) => flueInstanceRef(String(row.name))));
    let residue = 0;
    for (const row of this.db.all(
      `SELECT DISTINCT flue_instance_ref FROM run_executions
       WHERE flue_instance_ref IS NOT NULL
         AND raw_settlement_status IS NOT 'host_management_approval_succeeded'`,
    )) {
      if (!known.has(String(row.flue_instance_ref))) residue += 1;
    }
    return residue;
  }

  /** Record a name once: a name already recorded keeps its first time. */
  private insert(kind: InstallationObjectKind, name: string, firstSeenAt = this.now()): void {
    this.db.run(
      `INSERT INTO installation_object_inventory (kind, name, first_seen_at)
       VALUES (?, ?, ?) ON CONFLICT (kind, name) DO NOTHING`,
      kind, name, firstSeenAt,
    );
  }

  /** An object name this installation may own: one its own name scopes. */
  private ownName(instanceId: string): string {
    const split = splitInstallationObjectName(instanceId);
    if (split.scope?.installationId !== this.scope!.installationId) {
      throw new InstallationContextError(
        'installation_context_mismatch',
        'An object of another installation cannot be recorded here.',
      );
    }
    return instanceId;
  }

  private hasTable(name: string): boolean {
    return this.db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== undefined;
  }

  private requireEnabled(): void {
    if (!this.scope) {
      throw new InstallationContextError(
        'installation_context_invalid',
        'Only a deployment serving many installations keeps an object inventory.',
      );
    }
  }
}

/** The standalone part of a coding workspace object's hosted name, by kind. */
const WORKSPACE_OBJECT_NAMES: Readonly<Record<InstallationWorkspaceObjectKind, RegExp>> = {
  sandbox: /^w[a-z2-7]{21}$/,
  coding_worker: /^codingworker_[a-f0-9]{40}$/,
};

const INVENTORY_TABLE_SQL = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (
  kind TEXT NOT NULL CHECK (kind IN (${INSTALLATION_OBJECT_KINDS.map((kind) => `'${kind}'`).join(', ')})),
  name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (kind, name)
)`;

/**
 * Create the inventory, or widen an existing one's kinds: SQLite cannot
 * alter a CHECK constraint, so a table that predates a kind is copied into
 * one that admits it, rows and all, in one transaction.
 */
function installInventoryTable(db: StateDb): void {
  const existing = db.get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'installation_object_inventory'",
  );
  if (!existing) {
    db.exec(INVENTORY_TABLE_SQL('installation_object_inventory'));
    return;
  }
  const declared = String(existing.sql);
  if (INSTALLATION_OBJECT_KINDS.every((kind) => declared.includes(`'${kind}'`))) return;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS installation_object_inventory_next');
    db.exec(INVENTORY_TABLE_SQL('installation_object_inventory_next'));
    db.exec(`INSERT INTO installation_object_inventory_next (kind, name, first_seen_at)
      SELECT kind, name, first_seen_at FROM installation_object_inventory`);
    db.exec('DROP TABLE installation_object_inventory');
    db.exec('ALTER TABLE installation_object_inventory_next RENAME TO installation_object_inventory');
  });
}

function emptyCounts(): Record<InstallationObjectKind, number> {
  return Object.fromEntries(INSTALLATION_OBJECT_KINDS.map((kind) => [kind, 0])) as Record<InstallationObjectKind, number>;
}

/** The runner key a stored turn row runs on, or undefined for an unreadable row. */
function storedRunnerKey(turnJson: unknown, assignmentJson: unknown): string | undefined {
  try {
    return runnerKeyOf({
      turn: JSON.parse(String(turnJson)) as NormalizedSlackTurn,
      assignment: JSON.parse(String(assignmentJson)) as ResolvedAssignment,
    });
  } catch {
    return undefined;
  }
}

/** The Work ledger's opaque reference to a Flue instance (`opaqueId('flueinstance', ...)`). */
function flueInstanceRef(instanceId: string): string {
  return `flueinstance_${createHash('sha256').update(instanceId).digest('hex').slice(0, 40)}`;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new Error(`An inventory page holds 1 to ${MAX_PAGE} objects.`);
  }
  return value;
}

function encodeCursor(value: readonly [string, string]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string')) {
      return [value[0] as string, value[1] as string];
    }
  } catch {
    // Reported below.
  }
  throw new Error('The inventory cursor is malformed.');
}
