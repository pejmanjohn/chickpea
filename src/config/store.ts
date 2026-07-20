import { AgentExistsError, AgentStillAssignedError, UnknownAgentError } from './errors.ts';
import type { AssignmentLookupOptions } from './resolver.ts';
import { seededAgents, seededAssignments } from './seed.ts';
import type { ChannelAssignment, CustomAgentConfig } from './types.ts';
import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';

export interface ConfigSeed {
  agents: readonly CustomAgentConfig[];
  assignments: readonly ChannelAssignment[];
}

const DEFAULT_SEED: ConfigSeed = {
  agents: seededAgents,
  assignments: seededAssignments,
};

const SEED_META_KEY = 'config_seeded_v1';
const SCHEMA_VERSION_KEY = 'schema_version';

interface AgentRow {
  id: string;
  name: string;
  instructions: string;
  enabled: number;
  model: string | null;
  skills_json: string;
  mcp_servers_json: string;
}

interface AssignmentRow {
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  enabled: number;
  channel_label: string | null;
  channel_prompt_addendum: string | null;
}

/** PATCH shape: `model: null` clears a pinned model; omitting it keeps the pin. */
export type ConfigAgentPatch = Partial<Omit<CustomAgentConfig, 'id' | 'model'>> & {
  model?: string | null;
};

/**
 * Public async config store — the interface every consumer (routes, channel,
 * agent) is written against. The Node backend answers from local SQLite (the
 * awaits resolve immediately); the Cloudflare backend proxies each call to a
 * Durable Object over RPC. Domain errors (UnknownAgentError & co.) are part of
 * the contract on both backends.
 */
export interface ConfigStore {
  listAgents(): Promise<CustomAgentConfig[]>;
  getAgent(agentId: string): Promise<CustomAgentConfig>;
  createAgent(agent: CustomAgentConfig): Promise<CustomAgentConfig>;
  updateAgent(agentId: string, patch: ConfigAgentPatch): Promise<CustomAgentConfig>;
  deleteAgent(agentId: string): Promise<boolean>;
  listAssignments(): Promise<ChannelAssignment[]>;
  getAssignment(workspaceId: string, channelId: string): Promise<ChannelAssignment | undefined>;
  listAssignmentsForAgent(agentId: string): Promise<ChannelAssignment[]>;
  putAssignment(assignment: ChannelAssignment): Promise<ChannelAssignment>;
  deleteAssignment(workspaceId: string, channelId: string): Promise<boolean>;
  find(
    workspaceId: string,
    channelId: string,
    options?: AssignmentLookupOptions,
  ): Promise<ChannelAssignment | undefined>;
  /** Node backend only (closes the SQLite handle); absent on RPC proxies. */
  close?(): void;
}

/**
 * Target-neutral config store logic over the StateDb mini-interface: the
 * single source of the schema, migrations, seeding, and every query. The Node
 * backend runs it over `node:sqlite`; the Cloudflare Durable Object runs the
 * same class over `ctx.storage.sql`. Methods are synchronous — both backends
 * execute SQL synchronously — and the async public interface wraps them.
 */
export class ConfigStoreLogic {
  constructor(
    private readonly db: StateDb,
    seed: ConfigSeed = DEFAULT_SEED,
  ) {
    // One statement per exec: DO SQLite rejects multi-statement strings.
    db.exec(
      `CREATE TABLE IF NOT EXISTS config_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    this.runMigrations();
    this.seedOnce(seed);
  }

  listAgents(): CustomAgentConfig[] {
    return this.db
      .all('SELECT * FROM config_agents ORDER BY id')
      .map((row) => rowToAgent(row as unknown as AgentRow));
  }

  getAgent(agentId: string): CustomAgentConfig {
    const row = this.db.get('SELECT * FROM config_agents WHERE id = ?', agentId);
    if (!row) {
      throw new UnknownAgentError(agentId);
    }
    return rowToAgent(row as unknown as AgentRow);
  }

  createAgent(agent: CustomAgentConfig): CustomAgentConfig {
    let inserted;
    try {
      inserted = this.insertAgent(agent);
    } catch (err) {
      if (isConstraintViolation(err)) {
        throw new AgentExistsError(agent.id);
      }
      throw err;
    }
    if (inserted.changes !== 1) {
      throw new Error(`Agent ${agent.id} was not created`);
    }
    return this.getAgent(agent.id);
  }

  updateAgent(agentId: string, patch: ConfigAgentPatch): CustomAgentConfig {
    const current = this.getAgent(agentId);
    const model = patch.model === undefined ? (current.model ?? null) : patch.model;
    const next = { ...current, ...patch, id: agentId };
    this.db.run(
      `UPDATE config_agents
       SET name = ?, instructions = ?, enabled = ?, model = ?,
           skills_json = ?, mcp_servers_json = ?
       WHERE id = ?`,
      next.name,
      next.instructions,
      next.enabled ? 1 : 0,
      model,
      JSON.stringify(next.skills),
      JSON.stringify(next.mcpServers),
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
      throw new AgentStillAssignedError(agentId, keys);
    }
    const deleted = this.db.run('DELETE FROM config_agents WHERE id = ?', agentId);
    return deleted.changes === 1;
  }

  listAssignments(): ChannelAssignment[] {
    return this.db
      .all('SELECT * FROM config_assignments ORDER BY workspace_id, channel_id')
      .map((row) => rowToAssignment(row as unknown as AssignmentRow));
  }

  getAssignment(workspaceId: string, channelId: string): ChannelAssignment | undefined {
    const row = this.db.get(
      'SELECT * FROM config_assignments WHERE workspace_id = ? AND channel_id = ?',
      workspaceId,
      channelId,
    );
    return row ? rowToAssignment(row as unknown as AssignmentRow) : undefined;
  }

  listAssignmentsForAgent(agentId: string): ChannelAssignment[] {
    return this.db
      .all(
        `SELECT * FROM config_assignments
         WHERE agent_id = ?
         ORDER BY workspace_id, channel_id`,
        agentId,
      )
      .map((row) => rowToAssignment(row as unknown as AssignmentRow));
  }

  putAssignment(assignment: ChannelAssignment): ChannelAssignment {
    this.getAgent(assignment.agentId);
    this.db.run(
      `INSERT INTO config_assignments (
        workspace_id, channel_id, agent_id, enabled, channel_label, channel_prompt_addendum
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        enabled = excluded.enabled,
        channel_label = excluded.channel_label,
        channel_prompt_addendum = excluded.channel_prompt_addendum`,
      assignment.workspaceId,
      assignment.channelId,
      assignment.agentId,
      assignment.enabled ? 1 : 0,
      assignment.channelLabel ?? null,
      assignment.channelPromptAddendum ?? null,
    );
    return this.getAssignment(assignment.workspaceId, assignment.channelId) as ChannelAssignment;
  }

  deleteAssignment(workspaceId: string, channelId: string): boolean {
    const deleted = this.db.run(
      'DELETE FROM config_assignments WHERE workspace_id = ? AND channel_id = ?',
      workspaceId,
      channelId,
    );
    return deleted.changes === 1;
  }

  // Assignment precedence, most specific first: exact (workspace, channel), then
  // (workspace, '*'), then ('*', channel), then the ('*', '*') catch-all. The
  // winning row is selected regardless of its enabled flag: a disabled row at the
  // winning specificity turns the channel OFF rather than silently falling
  // through to a broader enabled rule, so PUT {enabled: false} is an explicit
  // off switch — not a reset to the wildcard agent.
  //
  // The ('*', '*') catch-all is the DIRECT-conversation default only. A 'channel'
  // surface excludes it entirely (fail-closed): a public/private channel answers
  // only where an operator explicitly assigned a profile.
  find(
    workspaceId: string,
    channelId: string,
    options: AssignmentLookupOptions = {},
  ): ChannelAssignment | undefined {
    const excludeGlobalWildcard = (options.surface ?? 'direct') === 'channel';
    const row = this.db.get(
      `SELECT * FROM config_assignments
       WHERE (workspace_id = ? OR workspace_id = '*')
         AND (channel_id = ? OR channel_id = '*')
         ${excludeGlobalWildcard ? "AND NOT (workspace_id = '*' AND channel_id = '*')" : ''}
       ORDER BY CASE
         WHEN workspace_id = ? AND channel_id = ? THEN 0
         WHEN workspace_id = ? AND channel_id = '*' THEN 1
         WHEN workspace_id = '*' AND channel_id = ? THEN 2
         ELSE 3
       END
       LIMIT 1`,
      workspaceId,
      channelId,
      workspaceId,
      channelId,
      workspaceId,
      channelId,
    );
    if (!row) return undefined;
    const assignment = rowToAssignment(row as unknown as AssignmentRow);
    return assignment.enabled ? assignment : undefined;
  }

  private seedOnce(seed: ConfigSeed): void {
    const seeded = this.db.get('SELECT value FROM config_meta WHERE key = ?', SEED_META_KEY);
    if (seeded) return;

    // Seed rows and the seeded marker commit atomically: a crash mid-seed must
    // not leave a half-seeded DB that the marker then stamps as complete.
    this.db.transaction(() => {
      const agentCount = countRows(this.db, 'config_agents');
      const assignmentCount = countRows(this.db, 'config_assignments');
      if (agentCount === 0 && assignmentCount === 0) {
        for (const agent of seed.agents) {
          this.insertAgent(agent);
        }
        for (const assignment of seed.assignments) {
          this.putAssignment(assignment);
        }
      }
      this.db.run(
        'INSERT INTO config_meta (key, value) VALUES (?, ?)',
        SEED_META_KEY,
        new Date().toISOString(),
      );
    });
  }

  private insertAgent(agent: CustomAgentConfig): { changes: number } {
    return this.db.run(
      `INSERT INTO config_agents (
        id, name, instructions, enabled, model,
        skills_json, mcp_servers_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      agent.id,
      agent.name,
      agent.instructions,
      agent.enabled ? 1 : 0,
      agent.model ?? null,
      JSON.stringify(agent.skills ?? []),
      JSON.stringify(agent.mcpServers ?? []),
    );
  }

  // Fresh databases start from the clean v1 schema. Migration v2 is a narrow
  // compatibility bridge for databases created by the pre-release v1 schema,
  // which still included the removed default_models_json column.
  private runMigrations(): void {
    const MIGRATIONS: Array<{ version: number; up: (db: StateDb) => void }> = [
      {
        version: 1,
        up: (db) => {
          // One statement per exec: Durable Object SQLite rejects
          // multi-statement strings.
          db.exec(
            `CREATE TABLE IF NOT EXISTS config_agents (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              instructions TEXT NOT NULL,
              enabled INTEGER NOT NULL,
              model TEXT,
              skills_json TEXT NOT NULL DEFAULT '[]',
              mcp_servers_json TEXT NOT NULL DEFAULT '[]'
            )`,
          );
          db.exec(
            `CREATE TABLE IF NOT EXISTS config_assignments (
              workspace_id TEXT NOT NULL,
              channel_id TEXT NOT NULL,
              agent_id TEXT NOT NULL,
              enabled INTEGER NOT NULL,
              channel_label TEXT,
              channel_prompt_addendum TEXT,
              PRIMARY KEY (workspace_id, channel_id)
            )`,
          );
        },
      },
      {
        version: 2,
        up: (db) => {
          const hasLegacyDefaultModels = db
            .all('PRAGMA table_info(config_agents)')
            .some((column) => column.name === 'default_models_json');
          if (hasLegacyDefaultModels) {
            db.exec('ALTER TABLE config_agents DROP COLUMN default_models_json');
          }
        },
      },
    ];
    const row = this.db.get('SELECT value FROM config_meta WHERE key = ?', SCHEMA_VERSION_KEY) as
      | { value: string }
      | undefined;
    const applied = row ? Number(row.value) : 0;
    for (const migration of MIGRATIONS) {
      if (migration.version > applied) {
        migration.up(this.db);
      }
    }
    const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
    if (latest > applied) {
      this.db.run(
        'INSERT INTO config_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        SCHEMA_VERSION_KEY,
        String(latest),
      );
    }
  }
}

/**
 * Node backend: the target-neutral logic over a file-backed (or `:memory:`)
 * `node:sqlite` database, wrapped in the async public interface. Schema,
 * migrations, and seeding run synchronously in the constructor — a constructed
 * store is fully initialized, exactly as before the async refactor.
 */
export class SqliteConfigStore implements ConfigStore {
  private readonly db: NodeStateDb;
  private readonly logic: ConfigStoreLogic;

  constructor(path: string = resolveStateDbPath(), seed: ConfigSeed = DEFAULT_SEED) {
    this.db = openStateDb(path);
    this.logic = new ConfigStoreLogic(this.db, seed);
  }

  close(): void {
    this.db.close();
  }

  async listAgents(): Promise<CustomAgentConfig[]> {
    return this.logic.listAgents();
  }

  async getAgent(agentId: string): Promise<CustomAgentConfig> {
    return this.logic.getAgent(agentId);
  }

  async createAgent(agent: CustomAgentConfig): Promise<CustomAgentConfig> {
    return this.logic.createAgent(agent);
  }

  async updateAgent(agentId: string, patch: ConfigAgentPatch): Promise<CustomAgentConfig> {
    return this.logic.updateAgent(agentId, patch);
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    return this.logic.deleteAgent(agentId);
  }

  async listAssignments(): Promise<ChannelAssignment[]> {
    return this.logic.listAssignments();
  }

  async getAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<ChannelAssignment | undefined> {
    return this.logic.getAssignment(workspaceId, channelId);
  }

  async listAssignmentsForAgent(agentId: string): Promise<ChannelAssignment[]> {
    return this.logic.listAssignmentsForAgent(agentId);
  }

  async putAssignment(assignment: ChannelAssignment): Promise<ChannelAssignment> {
    return this.logic.putAssignment(assignment);
  }

  async deleteAssignment(workspaceId: string, channelId: string): Promise<boolean> {
    return this.logic.deleteAssignment(workspaceId, channelId);
  }

  async find(
    workspaceId: string,
    channelId: string,
    options: AssignmentLookupOptions = {},
  ): Promise<ChannelAssignment | undefined> {
    return this.logic.find(workspaceId, channelId, options);
  }
}

// Only UNIQUE/PRIMARY KEY violations mean "this agent id is taken". Mapping the
// whole SQLITE_CONSTRAINT family here once turned a NOT NULL violation (stale
// dev schema) into a misleading agent_exists 409 — any other constraint error
// must surface as a real failure, not a duplicate id.
function isConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errcode = (err as { errcode?: number }).errcode;
  if (typeof errcode === 'number') {
    // SQLITE_CONSTRAINT_PRIMARYKEY (1555) / SQLITE_CONSTRAINT_UNIQUE (2067)
    return errcode === 1555 || errcode === 2067;
  }
  return (
    err.message.includes('UNIQUE constraint failed') ||
    err.message.includes('PRIMARY KEY constraint failed')
  );
}

function rowToAgent(row: AgentRow): CustomAgentConfig {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    enabled: Boolean(row.enabled),
    ...(row.model ? { model: row.model } : {}),
    skills: JSON.parse(row.skills_json) as CustomAgentConfig['skills'],
    mcpServers: JSON.parse(row.mcp_servers_json) as CustomAgentConfig['mcpServers'],
  };
}

function rowToAssignment(row: AssignmentRow): ChannelAssignment {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    agentId: row.agent_id,
    enabled: Boolean(row.enabled),
    ...(row.channel_label ? { channelLabel: row.channel_label } : {}),
    ...(row.channel_prompt_addendum
      ? { channelPromptAddendum: row.channel_prompt_addendum }
      : {}),
  };
}

function countRows(db: StateDb, table: string): number {
  const row = db.get(`SELECT COUNT(*) AS count FROM ${table}`) as { count: number } | undefined;
  return row?.count ?? 0;
}
