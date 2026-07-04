import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { resolveStateDbPath } from '../slack/claim-store.ts';
import { seededAgents, seededAssignments } from './seed.ts';
import type { ChannelAssignment, CustomAgentConfig } from './types.ts';

export interface ConfigSeed {
  agents: readonly CustomAgentConfig[];
  assignments: readonly ChannelAssignment[];
}

const DEFAULT_SEED: ConfigSeed = {
  agents: seededAgents,
  assignments: seededAssignments,
};

const SEED_META_KEY = 'config_seeded_v1';
type AgentStatementValues = [
  string,
  string,
  string,
  string,
  number,
  string | null,
  string,
  string,
];

interface AgentRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: number;
  model: string | null;
  default_models_json: string;
  allowed_tools_json: string;
}

interface AssignmentRow {
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  enabled: number;
  channel_prompt_addendum: string | null;
}

export class SqliteConfigStore {
  private readonly db: DatabaseSync;

  constructor(path: string = resolveStateDbPath(), seed: ConfigSeed = DEFAULT_SEED) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        model TEXT,
        default_models_json TEXT NOT NULL,
        allowed_tools_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config_assignments (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        channel_prompt_addendum TEXT,
        PRIMARY KEY (workspace_id, channel_id)
      );`,
    );
    this.seedOnce(seed);
  }

  close(): void {
    this.db.close();
  }

  listAgents(): CustomAgentConfig[] {
    return this.db
      .prepare('SELECT * FROM config_agents ORDER BY id')
      .all()
      .map((row) => rowToAgent(row as unknown as AgentRow));
  }

  getAgent(agentId: string): CustomAgentConfig {
    const row = this.db.prepare('SELECT * FROM config_agents WHERE id = ?').get(agentId);
    if (!row) {
      throw new Error(`Unknown agent ${agentId}`);
    }
    return rowToAgent(row as unknown as AgentRow);
  }

  createAgent(agent: CustomAgentConfig): CustomAgentConfig {
    const inserted = this.agentInsertStatement().run(...agentStatementValues(agent));
    if (inserted.changes !== 1) {
      throw new Error(`Agent ${agent.id} was not created`);
    }
    return this.getAgent(agent.id);
  }

  updateAgent(
    agentId: string,
    // `model: null` clears a pinned model (PATCH semantics); omitting it keeps
    // the current pin.
    patch: Partial<Omit<CustomAgentConfig, 'id' | 'model'>> & { model?: string | null },
  ): CustomAgentConfig {
    const current = this.getAgent(agentId);
    const model = patch.model === undefined ? (current.model ?? null) : patch.model;
    const next = { ...current, ...patch, id: agentId };
    this.db
      .prepare(
        `UPDATE config_agents
         SET name = ?, description = ?, instructions = ?, enabled = ?, model = ?,
             default_models_json = ?, allowed_tools_json = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        next.instructions,
        next.enabled ? 1 : 0,
        model,
        JSON.stringify(next.defaultModels),
        JSON.stringify(next.allowedTools),
        agentId,
      );
    return this.getAgent(agentId);
  }

  deleteAgent(agentId: string): boolean {
    const references = this.listAssignmentsForAgent(agentId);
    if (references.length > 0) {
      const keys = references
        .map((assignment) => `${assignment.workspaceId}/${assignment.channelId}`)
        .join(', ');
      throw new Error(`Agent ${agentId} is still assigned to ${keys}`);
    }
    const deleted = this.db.prepare('DELETE FROM config_agents WHERE id = ?').run(agentId);
    return deleted.changes === 1;
  }

  listAssignments(): ChannelAssignment[] {
    return this.db
      .prepare('SELECT * FROM config_assignments ORDER BY workspace_id, channel_id')
      .all()
      .map((row) => rowToAssignment(row as unknown as AssignmentRow));
  }

  getAssignment(workspaceId: string, channelId: string): ChannelAssignment | undefined {
    const row = this.db
      .prepare('SELECT * FROM config_assignments WHERE workspace_id = ? AND channel_id = ?')
      .get(workspaceId, channelId);
    return row ? rowToAssignment(row as unknown as AssignmentRow) : undefined;
  }

  listAssignmentsForAgent(agentId: string): ChannelAssignment[] {
    return this.db
      .prepare(
        `SELECT * FROM config_assignments
         WHERE agent_id = ?
         ORDER BY workspace_id, channel_id`,
      )
      .all(agentId)
      .map((row) => rowToAssignment(row as unknown as AssignmentRow));
  }

  putAssignment(assignment: ChannelAssignment): ChannelAssignment {
    this.getAgent(assignment.agentId);
    this.db
      .prepare(
        `INSERT INTO config_assignments (
          workspace_id, channel_id, agent_id, enabled, channel_prompt_addendum
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, channel_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          enabled = excluded.enabled,
          channel_prompt_addendum = excluded.channel_prompt_addendum`,
      )
      .run(
        assignment.workspaceId,
        assignment.channelId,
        assignment.agentId,
        assignment.enabled ? 1 : 0,
        assignment.channelPromptAddendum ?? null,
      );
    return this.getAssignment(assignment.workspaceId, assignment.channelId) as ChannelAssignment;
  }

  deleteAssignment(workspaceId: string, channelId: string): boolean {
    const deleted = this.db
      .prepare('DELETE FROM config_assignments WHERE workspace_id = ? AND channel_id = ?')
      .run(workspaceId, channelId);
    return deleted.changes === 1;
  }

  // Assignment precedence, most specific first: exact (workspace, channel), then
  // (workspace, '*'), then ('*', channel), then the ('*', '*') catch-all. The
  // winning row is selected regardless of its enabled flag: a disabled row at the
  // winning specificity turns the channel OFF rather than silently falling
  // through to a broader enabled rule, so PUT {enabled: false} is an explicit
  // off switch — not a reset to the wildcard agent.
  find(workspaceId: string, channelId: string): ChannelAssignment | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM config_assignments
         WHERE (workspace_id = ? OR workspace_id = '*')
           AND (channel_id = ? OR channel_id = '*')
         ORDER BY CASE
           WHEN workspace_id = ? AND channel_id = ? THEN 0
           WHEN workspace_id = ? AND channel_id = '*' THEN 1
           WHEN workspace_id = '*' AND channel_id = ? THEN 2
           ELSE 3
         END
         LIMIT 1`,
      )
      .get(workspaceId, channelId, workspaceId, channelId, workspaceId, channelId);
    if (!row) return undefined;
    const assignment = rowToAssignment(row as unknown as AssignmentRow);
    return assignment.enabled ? assignment : undefined;
  }

  private seedOnce(seed: ConfigSeed): void {
    const seeded = this.db
      .prepare('SELECT value FROM config_meta WHERE key = ?')
      .get(SEED_META_KEY);
    if (seeded) return;

    // Seed rows and the seeded marker commit atomically: a crash mid-seed must
    // not leave a half-seeded DB that the marker then stamps as complete.
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const agentCount = countRows(this.db, 'config_agents');
      const assignmentCount = countRows(this.db, 'config_assignments');
      if (agentCount === 0 && assignmentCount === 0) {
        const insertAgent = this.agentInsertStatement();
        for (const agent of seed.agents) {
          insertAgent.run(...agentStatementValues(agent));
        }
        for (const assignment of seed.assignments) {
          this.putAssignment(assignment);
        }
      }
      this.db
        .prepare('INSERT INTO config_meta (key, value) VALUES (?, ?)')
        .run(SEED_META_KEY, new Date().toISOString());
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  private agentInsertStatement(): StatementSync {
    return this.db.prepare(
      `INSERT INTO config_agents (
        id, name, description, instructions, enabled, model,
        default_models_json, allowed_tools_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }
}

function agentStatementValues(agent: CustomAgentConfig): AgentStatementValues {
  return [
    agent.id,
    agent.name,
    agent.description,
    agent.instructions,
    agent.enabled ? 1 : 0,
    agent.model ?? null,
    JSON.stringify(agent.defaultModels),
    JSON.stringify(agent.allowedTools),
  ];
}

let cachedConfigStore: { path: string; store: SqliteConfigStore } | undefined;

export function getConfigStore(): SqliteConfigStore {
  const path = resolveStateDbPath();
  if (cachedConfigStore?.path === path) {
    return cachedConfigStore.store;
  }
  cachedConfigStore?.store.close();
  const store = new SqliteConfigStore(path);
  cachedConfigStore = { path, store };
  return store;
}

function rowToAgent(row: AgentRow): CustomAgentConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    enabled: Boolean(row.enabled),
    ...(row.model ? { model: row.model } : {}),
    defaultModels: JSON.parse(row.default_models_json) as CustomAgentConfig['defaultModels'],
    allowedTools: JSON.parse(row.allowed_tools_json) as string[],
  };
}

function rowToAssignment(row: AssignmentRow): ChannelAssignment {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    agentId: row.agent_id,
    enabled: Boolean(row.enabled),
    ...(row.channel_prompt_addendum
      ? { channelPromptAddendum: row.channel_prompt_addendum }
      : {}),
  };
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}
