import { DatabaseSync } from 'node:sqlite';

import { computeSnapshotHash, type EffectiveSlackConfig } from './effective-config.ts';
import type { AgentSnapshot } from './types.ts';
import { openStateDb, resolveStateDbPath, THREAD_TTL_MS } from '../slack/claim-store.ts';

interface SnapshotRow {
  snapshot_json: string;
}

export class SqliteAgentSnapshotStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.now = now;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS agent_snapshots (
        thread_key TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`,
    );
  }

  close(): void {
    this.db.close();
  }

  get(threadKey: string): AgentSnapshot | undefined {
    const row = this.db
      .prepare('SELECT snapshot_json FROM agent_snapshots WHERE thread_key = ?')
      .get(threadKey) as SnapshotRow | undefined;
    return row ? (JSON.parse(row.snapshot_json) as AgentSnapshot) : undefined;
  }

  getOrCreate(threadKey: string, resolve: () => EffectiveSlackConfig): AgentSnapshot {
    const existing = this.get(threadKey);
    if (existing) return existing;

    this.purgeExpired();
    const snapshot = snapshotFromEffectiveConfig(resolve(), this.now());
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_snapshots (
          thread_key, snapshot_json, snapshot_hash, created_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(threadKey, JSON.stringify(snapshot), snapshot.snapshotHash, snapshot.createdAt);

    if (inserted.changes === 1) {
      return snapshot;
    }
    // A concurrent writer (e.g. the agent self-call as a separate process with
    // its own SQLite connection) won the write-once INSERT. Return the PERSISTED
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
    this.db
      .prepare('DELETE FROM agent_snapshots WHERE created_at < ?')
      .run(this.now() - THREAD_TTL_MS);
  }
}

export function snapshotFromEffectiveConfig(
  config: EffectiveSlackConfig,
  createdAt: number,
): AgentSnapshot {
  return {
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    agentId: config.agentId,
    ...(config.channelPromptAddendum
      ? { channelPromptAddendum: config.channelPromptAddendum }
      : {}),
    agent: config.agent,
    model: config.model,
    providerId: config.provider,
    allowedTools: [...config.allowedTools],
    instructions: config.instructions,
    snapshotHash: computeSnapshotHash(config),
    createdAt,
  };
}

let cachedSnapshotStore: { path: string; store: SqliteAgentSnapshotStore } | undefined;

export function getAgentSnapshotStore(): SqliteAgentSnapshotStore {
  const path = resolveStateDbPath();
  if (cachedSnapshotStore?.path === path) {
    return cachedSnapshotStore.store;
  }
  cachedSnapshotStore?.store.close();
  const store = new SqliteAgentSnapshotStore(path);
  cachedSnapshotStore = { path, store };
  return store;
}
