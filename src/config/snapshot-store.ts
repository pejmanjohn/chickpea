import { DatabaseSync } from 'node:sqlite';

import { computeSnapshotHash, type EffectiveSlackConfig } from './effective-config.ts';
import type { AgentSnapshot } from './types.ts';
import { openStateDb, resolveStateDbPath } from '../slack/claim-store.ts';

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

    // get() and the insert run with no await between them in this single-process
    // app, so the row provably does not exist yet; INSERT OR IGNORE keeps the
    // write-once guarantee if that assumption ever changes.
    const snapshot = snapshotFromEffectiveConfig(resolve(), this.now());
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_snapshots (
          thread_key, snapshot_json, snapshot_hash, created_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(threadKey, JSON.stringify(snapshot), snapshot.snapshotHash, snapshot.createdAt);
    return snapshot;
  }
}

export function snapshotFromEffectiveConfig(
  config: EffectiveSlackConfig,
  createdAt: number = Date.now(),
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
