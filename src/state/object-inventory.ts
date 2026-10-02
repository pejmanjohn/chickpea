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
 *   dispatch envelope is persisted.
 *
 * The state store itself is implicit: its name is the installation's.
 */
export const INSTALLATION_OBJECT_KINDS = ['routine_agent', 'slack_agent', 'thread_runner'] as const;
export type InstallationObjectKind = typeof INSTALLATION_OBJECT_KINDS[number];

/** One recorded object: its kind and the exact name the host addresses it by. */
export interface InstallationObjectRecord {
  readonly kind: InstallationObjectKind;
  readonly name: string;
  readonly firstSeenAt: number;
}

export interface InstallationObjectInventoryPage {
  readonly objects: readonly InstallationObjectRecord[];
  /** Pass back to read the next page; null once every object was listed. */
  readonly nextCursor: string | null;
}

export interface InstallationObjectBackfill {
  /** Names recorded from the store's surviving records, per kind (already-recorded names included). */
  readonly recovered: Readonly<Record<InstallationObjectKind, number>>;
  /** Agent instances the Work ledger saw run whose names nothing left can tell: they cannot be addressed. */
  readonly unknownResidue: number;
}

/** What the stores that first persist an object name use to record it. */
export interface InstallationObjectRecorder {
  /** The turn runner of one Slack thread key (standalone name). */
  recordThreadRunner(threadKey: string): void;
  /** A Flue instance, by the instance ID that already names its installation. */
  recordAgentInstance(kind: 'routine_agent' | 'slack_agent', instanceId: string): void;
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
    if (this.scope && schemaInstallRequired(db)) {
      db.exec(`CREATE TABLE IF NOT EXISTS installation_object_inventory (
        kind TEXT NOT NULL CHECK (kind IN ('routine_agent', 'slack_agent', 'thread_runner')),
        name TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (kind, name)
      )`);
    }
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
    const counts = { routine_agent: 0, slack_agent: 0, thread_runner: 0 };
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
   */
  backfill(): InstallationObjectBackfill {
    this.requireEnabled();
    const recovered = { routine_agent: 0, slack_agent: 0, thread_runner: 0 };
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
      for (const key of runners) this.recordThreadRunner(key);
      for (const kind of ['routine_agent', 'slack_agent'] as const) {
        for (const name of agents[kind]) this.insert(kind, name);
      }
    });
    recovered.thread_runner = runners.size;
    recovered.slack_agent = agents.slack_agent.size;
    recovered.routine_agent = agents.routine_agent.size;
    return { recovered, unknownResidue: this.unknownResidue() };
  }

  private unknownResidue(): number {
    if (!this.hasTable('run_executions')) return 0;
    const known = new Set(this.db.all(
      "SELECT name FROM installation_object_inventory WHERE kind IN ('routine_agent', 'slack_agent')",
    ).map((row) => flueInstanceRef(String(row.name))));
    let residue = 0;
    for (const row of this.db.all(
      'SELECT DISTINCT flue_instance_ref FROM run_executions WHERE flue_instance_ref IS NOT NULL',
    )) {
      if (!known.has(String(row.flue_instance_ref))) residue += 1;
    }
    return residue;
  }

  private insert(kind: InstallationObjectKind, name: string): void {
    this.db.run(
      `INSERT INTO installation_object_inventory (kind, name, first_seen_at)
       VALUES (?, ?, ?) ON CONFLICT (kind, name) DO NOTHING`,
      kind, name, this.now(),
    );
  }

  /** A Flue instance ID this installation may own: one its own name scopes. */
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
