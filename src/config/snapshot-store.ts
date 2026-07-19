import { computeSnapshotHash, type EffectiveSlackConfig } from './effective-config.ts';
import type { AgentSnapshot } from './types.ts';
import { THREAD_TTL_MS } from '../slack/claim-store.ts';
import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';

interface SnapshotRow {
  snapshot_json: string;
}

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
        created_at INTEGER NOT NULL
      )`,
    );
  }

  get(threadKey: string): AgentSnapshot | undefined {
    const row = this.db.get(
      'SELECT snapshot_json FROM agent_snapshots WHERE thread_key = ?',
      threadKey,
    ) as SnapshotRow | undefined;
    if (!row) {
      return undefined;
    }
    // Touch on read: the purge horizon must track LAST ACTIVITY, not thread
    // birth. The thread registry refreshes started_at on every turn, so a
    // long-lived thread stays admissible past 30 days — a birth-dated snapshot
    // would be purged under it, silently un-freezing the live thread's config.
    this.db.run(
      'UPDATE agent_snapshots SET created_at = ? WHERE thread_key = ?',
      this.now(),
      threadKey,
    );
    return JSON.parse(row.snapshot_json) as AgentSnapshot;
  }

  putIfAbsent(threadKey: string, snapshot: AgentSnapshot): AgentSnapshot {
    this.purgeExpired();
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO agent_snapshots (
        thread_key, snapshot_json, snapshot_hash, created_at
      ) VALUES (?, ?, ?, ?)`,
      threadKey,
      JSON.stringify(snapshot),
      snapshot.snapshotHash,
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

  // Snapshots outlive their thread's admissibility by no more than the thread
  // TTL: past it an implicit reply is no longer admitted (slack_threads is
  // purged on the same horizon), so the row is dead weight. Bounds the table.
  private purgeExpired(): void {
    this.db.run('DELETE FROM agent_snapshots WHERE created_at < ?', this.now() - THREAD_TTL_MS);
  }
}

/** Node backend: the target-neutral logic over `node:sqlite`, async-wrapped. */
export class SqliteAgentSnapshotStore implements AgentSnapshotStore {
  private readonly db: NodeStateDb;
  private readonly logic: SnapshotStoreLogic;

  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.logic = new SnapshotStoreLogic(this.db, now);
  }

  close(): void {
    this.db.close();
  }

  async get(threadKey: string): Promise<AgentSnapshot | undefined> {
    return this.logic.get(threadKey);
  }

  async putIfAbsent(threadKey: string, snapshot: AgentSnapshot): Promise<AgentSnapshot> {
    return this.logic.putIfAbsent(threadKey, snapshot);
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

export function snapshotFromEffectiveConfig(
  config: EffectiveSlackConfig,
  createdAt: number,
): AgentSnapshot {
  return {
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    agentId: config.agentId,
    ...(config.channelLabel ? { channelLabel: config.channelLabel } : {}),
    ...(config.channelPromptAddendum
      ? { channelPromptAddendum: config.channelPromptAddendum }
      : {}),
    agent: config.agent,
    model: config.model,
    providerId: config.provider,
    instructions: config.instructions,
    snapshotHash: computeSnapshotHash(config),
    createdAt,
  };
}
