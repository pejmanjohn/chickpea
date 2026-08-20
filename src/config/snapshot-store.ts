import {
  computeSnapshotHash,
  resolvedAssignmentFromEffectiveConfig,
  type EffectiveSlackConfig,
} from './effective-config.ts';
import {
  type AgentSnapshot,
  type AgentSnapshotRootReference,
} from './types.ts';
import { THREAD_TTL_MS } from '../slack/claim-store.ts';
import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import { promisify } from '../state/async-facade.ts';
import type { StateDb } from '../state/state-db.ts';

interface SnapshotRow {
  snapshot_json: string;
  schema_version: number | null;
  agent_id: string | null;
}

interface SnapshotRootRow {
  thread_key: string;
  agent_id: string;
  last_activity_at: number;
}

export const AGENT_SNAPSHOT_SCHEMA_VERSION = 2;

/**
 * Public async snapshot store. The write path is `putIfAbsent`, not a plain
 * put: snapshots are write-once per thread, and INSERT OR IGNORE inside the
 * backend keeps the first-writer-wins race decision next to the data (Node and
 * Durable Object callers resolve it identically).
 */
export interface AgentSnapshotStore {
  get(threadKey: string): Promise<AgentSnapshot | undefined>;
  /**
   * Insert the snapshot unless the thread already has one; resolves to the
   * PERSISTED row either way, never a losing writer's discarded build.
   */
  putIfAbsent(threadKey: string, snapshot: AgentSnapshot): Promise<AgentSnapshot>;
  /** Replace the active snapshot after an authorized Agent handoff. */
  replace(threadKey: string, snapshot: AgentSnapshot): Promise<AgentSnapshot>;
  listLiveRootsByAgent(agentId: string): Promise<AgentSnapshotRootReference[]>;
  /** Node backend only (closes the SQLite handle); absent on RPC proxies. */
  close?(): void;
}

/**
 * Target-neutral snapshot storage logic over the StateDb mini-interface —
 * shared by the Node backend and the Cloudflare Durable Object. Methods are
 * synchronous; the async public interface wraps them.
 */
export class SnapshotStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS agent_snapshots (
        thread_key TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        schema_version INTEGER,
        agent_id TEXT,
        last_activity_at INTEGER
      )`,
    );
    this.ensureV2Schema();
  }

  get(threadKey: string): AgentSnapshot | undefined {
    const row = this.db.get(
      'SELECT snapshot_json, schema_version, agent_id FROM agent_snapshots WHERE thread_key = ?',
      threadKey,
    ) as SnapshotRow | undefined;
    if (!row) {
      return undefined;
    }
    const snapshot = parseSnapshot(row.snapshot_json);
    if (
      row.schema_version !== AGENT_SNAPSHOT_SCHEMA_VERSION ||
      row.agent_id === null ||
      snapshot?.schemaVersion !== AGENT_SNAPSHOT_SCHEMA_VERSION ||
      snapshot.agentId !== row.agent_id
    ) {
      this.db.run('DELETE FROM agent_snapshots WHERE thread_key = ?', threadKey);
      return undefined;
    }
    // Touch on read: the purge horizon must track LAST ACTIVITY, not thread
    // birth. The thread registry refreshes started_at on every turn, so a
    // long-lived thread stays admissible past 30 days — a birth-dated snapshot
    // would be purged under it, silently un-freezing the live thread's config.
    this.db.run(
      'UPDATE agent_snapshots SET last_activity_at = ? WHERE thread_key = ?',
      this.now(),
      threadKey,
    );
    return snapshot;
  }

  putIfAbsent(threadKey: string, snapshot: AgentSnapshot): AgentSnapshot {
    this.purgeExpired();
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO agent_snapshots (
        thread_key, snapshot_json, snapshot_hash, created_at,
        schema_version, agent_id, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      threadKey,
      JSON.stringify(snapshot),
      snapshot.snapshotHash,
      snapshot.createdAt,
      snapshot.schemaVersion,
      snapshot.agentId,
      snapshot.createdAt,
    );

    if (inserted.changes === 1) {
      return snapshot;
    }
    // A concurrent writer with its own SQLite connection won the write-once
    // INSERT. Return the PERSISTED
    // row, never our discarded build, so the snapshot the caller acts on is the
    // one actually stored and served.
    const stored = this.get(threadKey);
    if (!stored) {
      throw new Error(`Agent snapshot for ${threadKey} was not readable after insert`);
    }
    return stored;
  }

  replace(threadKey: string, snapshot: AgentSnapshot): AgentSnapshot {
    this.purgeExpired();
    this.db.run(
      `INSERT INTO agent_snapshots (
        thread_key, snapshot_json, snapshot_hash, created_at,
        schema_version, agent_id, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        snapshot_hash = excluded.snapshot_hash,
        created_at = excluded.created_at,
        schema_version = excluded.schema_version,
        agent_id = excluded.agent_id,
        last_activity_at = excluded.last_activity_at`,
      threadKey,
      JSON.stringify(snapshot),
      snapshot.snapshotHash,
      snapshot.createdAt,
      snapshot.schemaVersion,
      snapshot.agentId,
      snapshot.createdAt,
    );
    return this.get(threadKey)!;
  }

  listLiveRootsByAgent(agentId: string): AgentSnapshotRootReference[] {
    this.purgeExpired();
    return this.db
      .all(
        `SELECT thread_key, agent_id, last_activity_at
         FROM agent_snapshots
         WHERE schema_version = ? AND agent_id = ?
         ORDER BY last_activity_at DESC, thread_key`,
        AGENT_SNAPSHOT_SCHEMA_VERSION,
        agentId,
      )
      .map((row) => {
        const root = row as unknown as SnapshotRootRow;
        return {
          threadKey: root.thread_key,
          agentId: root.agent_id,
          lastActivityAt: Number(root.last_activity_at),
        };
      });
  }

  // Snapshots outlive their thread's admissibility by no more than the thread
  // TTL: past it an implicit reply is no longer admitted (slack_threads is
  // purged on the same horizon), so the row is dead weight. Bounds the table.
  private purgeExpired(): void {
    this.db.run(
      'DELETE FROM agent_snapshots WHERE last_activity_at IS NULL OR last_activity_at < ?',
      this.now() - THREAD_TTL_MS,
    );
  }

  private ensureV2Schema(): void {
    const columns = new Set(
      this.db.all('PRAGMA table_info(agent_snapshots)').map((column) => String(column.name)),
    );
    if (!columns.has('schema_version')) {
      this.db.exec('ALTER TABLE agent_snapshots ADD COLUMN schema_version INTEGER');
    }
    if (!columns.has('agent_id')) {
      this.db.exec('ALTER TABLE agent_snapshots ADD COLUMN agent_id TEXT');
    }
    if (!columns.has('last_activity_at')) {
      this.db.exec('ALTER TABLE agent_snapshots ADD COLUMN last_activity_at INTEGER');
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS agent_snapshots_agent_live_idx ON agent_snapshots(agent_id, last_activity_at)',
    );
    this.db.run(
      'DELETE FROM agent_snapshots WHERE schema_version IS NULL OR schema_version != ?',
      AGENT_SNAPSHOT_SCHEMA_VERSION,
    );
  }
}

/** Node backend: the target-neutral logic over `node:sqlite`, async-wrapped. */
export interface SqliteAgentSnapshotStore extends AgentSnapshotStore {
  close(): void;
}

export class SqliteAgentSnapshotStore {
  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    const db = openStateDb(path);
    // The Proxy facade drops the `implements` compile check, so this typed
    // binding is the conformance assertion that keeps it: a logic method that
    // stops matching AgentSnapshotStore fails typecheck here.
    const _conforms: AgentSnapshotStore = promisify(new SnapshotStoreLogic(db, now), {
      close: () => db.close(),
    });
    return _conforms as unknown as SqliteAgentSnapshotStore;
  }
}

/**
 * Freeze-at-first-turn read path shared by the Slack channel and the durable
 * agent: serve the existing snapshot if the thread has one, otherwise resolve
 * the CURRENT effective config, build the snapshot, and write it write-once.
 * The store decides races (INSERT OR IGNORE) and always returns the persisted
 * row, so both callers act on the row that is actually served.
 */
export async function getOrCreateSnapshot(
  store: AgentSnapshotStore,
  threadKey: string,
  resolve: () => EffectiveSlackConfig | Promise<EffectiveSlackConfig>,
  now: () => number = Date.now,
): Promise<AgentSnapshot> {
  const existing = await store.get(threadKey);
  if (existing) return existing;
  const built = snapshotFromEffectiveConfig(await resolve(), now());
  return store.putIfAbsent(threadKey, built);
}

/**
 * Converge a thread snapshot on its persisted Agent route. A handoff (or an
 * explicit re-invocation after an Agent edit) replaces the old frozen config;
 * ordinary replies keep serving the same snapshot.
 */
export async function getOrReplaceSnapshotForRoute(
  store: AgentSnapshotStore,
  threadKey: string,
  route: { agentId: string; agentGeneration: number },
  resolve: () => EffectiveSlackConfig | Promise<EffectiveSlackConfig>,
  now: () => number = Date.now,
): Promise<AgentSnapshot> {
  const existing = await store.get(threadKey);
  const existingGeneration = existing?.agent.configurationGeneration ?? existing?.agent.revision;
  if (
    existing && existing.agentId === route.agentId &&
    existingGeneration === route.agentGeneration
  ) return existing;
  return store.replace(threadKey, snapshotFromEffectiveConfig(await resolve(), now()));
}

export function snapshotFromEffectiveConfig(
  config: EffectiveSlackConfig,
  createdAt: number,
): AgentSnapshot {
  return {
    schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
    ...resolvedAssignmentFromEffectiveConfig(config),
    model: config.model,
    providerId: config.provider,
    instructions: config.instructions,
    repositories: config.agent.repositories,
    snapshotHash: computeSnapshotHash(config),
    createdAt,
  };
}

function parseSnapshot(raw: string): AgentSnapshot | undefined {
  try {
    const parsed = JSON.parse(raw) as AgentSnapshot;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
