import {
  AgentRevisionConflictError,
  AgentSlackIdentityConflictError,
  AgentExistsError,
  AgentStillReferencedError,
  ChannelAssignmentConflictError,
  SlackIdentityExistsError,
  SlackIdentityLifecycleError,
  SlackIdentityRevisionConflictError,
  SlackIdentityStillReferencedError,
  UnknownAgentError,
  UnknownSlackIdentityError,
  WorkspaceDefaultSlackIdentityProtectedError,
} from './errors.ts';
import { AuditStoreLogic } from '../audit/store.ts';
import type { AppendAuditEvent, AuditEvent, AuditEventFilter } from '../audit/types.ts';
import type { AssignmentLookupOptions } from './resolver.ts';
import { seededAgents, seededAssignments } from './seed.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type AgentReferenceSummary,
  type AgentCreateInput,
  type ChannelAssignment,
  type ChannelConfig,
  type ChannelPlacementMutation,
  type ChannelPlacementResult,
  type CustomAgentConfig,
  type SlackIdentity,
  type SlackIdentityDmState,
  type SlackIdentityReferenceSummary,
} from './types.ts';
import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import { MemoryStoreLogic } from '../memory/store.ts';

export interface ConfigSeed {
  agents: readonly AgentCreateInput[];
  assignments: readonly ConfigSeedAssignment[];
  channels?: readonly ChannelConfig[];
}

/** Input-only bridge for pre-cutover fixtures and stored seed data. */
type ConfigSeedAssignment = ChannelAssignment & {
  enabled?: boolean;
  channelLabel?: string;
  channelPromptAddendum?: string;
  participationMode?: ChannelConfig['participationMode'];
};

const DEFAULT_SEED: ConfigSeed = {
  agents: seededAgents,
  assignments: seededAssignments,
};

const SEED_META_KEY = 'config_seeded_v1';
const SCHEMA_VERSION_KEY = 'schema_version';

interface AgentRow {
  id: string;
  revision: number;
  name: string;
  instructions: string;
  enabled: number;
  model: string | null;
  skills_json: string;
  mcp_servers_json: string;
  api_connections_json?: string | null;
  repositories_json?: string | null;
  slack_identity_id?: string | null;
}

interface AssignmentRow {
  workspace_id: string;
  channel_id: string;
  agent_id: string;
}

interface ChannelRow {
  workspace_id: string;
  channel_id: string;
  label: string | null;
  additional_instructions: string | null;
  participation_mode: string;
  lifecycle: string;
}

interface SlackIdentityRow {
  id: string;
  ingress_key: string;
  kind: string;
  lifecycle: string;
  team_id: string | null;
  app_id: string | null;
  bot_user_id: string | null;
  dm_state: string;
  dm_agent_id: string | null;
  credential_provenance: string;
  connection_revision: number;
  observed_display_name: string | null;
  observed_avatar_url: string | null;
  observed_at: number | null;
  health: string;
  health_detail: string | null;
  created_at: number;
  updated_at: number;
  retired_at: number | null;
  setup_intent_json: string | null;
}

/** PATCH shape: `model: null` clears a pinned model; omitting it keeps the pin. */
export type ConfigAgentPatch = Partial<
  Omit<CustomAgentConfig, 'id' | 'revision' | 'model' | 'slackIdentityId'>
> & {
  model?: string | null;
  slackIdentityId?: string | null;
};

export type SlackIdentityPatch = Partial<
  Omit<
    SlackIdentity,
    | 'id'
    | 'kind'
    | 'createdAt'
    | 'updatedAt'
    | 'connectionRevision'
    | 'teamId'
    | 'appId'
    | 'botUserId'
    | 'dmAgentId'
    | 'observedDisplayName'
    | 'observedAvatarUrl'
    | 'observedAt'
    | 'healthDetail'
    | 'retiredAt'
    | 'setupIntent'
  >
> & {
  teamId?: string | null;
  appId?: string | null;
  botUserId?: string | null;
  dmAgentId?: string | null;
  observedDisplayName?: string | null;
  observedAvatarUrl?: string | null;
  observedAt?: number | null;
  healthDetail?: string | null;
  retiredAt?: number | null;
  setupIntent?: SlackIdentity['setupIntent'] | null;
};

export type OAuthReauthorizationTarget =
  | {
      lane: 'mcp';
      agentId: string;
      connectionId: string;
      serverUrl: string;
    }
  | {
      lane: 'api';
      agentId: string;
      connectionId: string;
      provider: 'google';
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
  createAgent(agent: AgentCreateInput): Promise<CustomAgentConfig>;
  updateAgent(agentId: string, patch: ConfigAgentPatch, expectedRevision?: number): Promise<CustomAgentConfig>;
  markOAuthReauthorizationRequired(target: OAuthReauthorizationTarget): Promise<boolean>;
  deleteAgent(agentId: string): Promise<boolean>;
  deleteAgentWithMemory(
    agentId: string,
    idempotencyKey: string,
  ): Promise<boolean>;
  listChannels(): Promise<ChannelConfig[]>;
  getChannel(workspaceId: string, channelId: string): Promise<ChannelConfig | undefined>;
  putChannel(channel: ChannelConfig): Promise<ChannelConfig>;
  putChannelPlacement(input: ChannelPlacementMutation): Promise<ChannelPlacementResult>;
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
  getAgentReferences(agentId: string): Promise<AgentReferenceSummary>;
  listSlackIdentities(): Promise<SlackIdentity[]>;
  getSlackIdentity(identityId: string): Promise<SlackIdentity>;
  getSlackIdentityByIngressKey(ingressKey: string): Promise<SlackIdentity | undefined>;
  createSlackIdentity(identity: SlackIdentity): Promise<SlackIdentity>;
  updateSlackIdentity(
    identityId: string,
    expectedRevision: number,
    patch: SlackIdentityPatch,
  ): Promise<SlackIdentity>;
  listSlackIdentitiesForAgent(agentId: string): Promise<SlackIdentity[]>;
  listAgentsForSlackIdentity(identityId: string): Promise<CustomAgentConfig[]>;
  resolveSlackIdentityForAgent(agentId: string): Promise<SlackIdentity>;
  getSlackIdentityReferences(identityId: string): Promise<SlackIdentityReferenceSummary>;
  setSlackIdentityDmBinding(
    identityId: string,
    expectedRevision: number,
    dmState: SlackIdentityDmState,
    dmAgentId?: string,
  ): Promise<SlackIdentity>;
  completeSlackIdentitySetup(
    identityId: string,
    expectedRevision: number,
    agentId?: string,
    expectedAgentIdentityId?: string | null,
  ): Promise<SlackIdentity>;
  attachAgentToSlackIdentity(
    agentId: string,
    identityId: string,
    expectedIdentityRevision: number,
    expectedAgentIdentityId: string | null,
  ): Promise<CustomAgentConfig>;
  retireSlackIdentity(identityId: string, expectedRevision: number): Promise<SlackIdentity>;
  deleteIncompleteSlackIdentity(
    identityId: string,
    expectedRevision: number,
    credentialsErased: boolean,
  ): Promise<boolean>;
  purgeRetiredSlackIdentity(
    identityId: string,
    expectedRevision: number,
    credentialsErased: boolean,
  ): Promise<boolean>;
  appendSlackIdentityAudit(input: AppendAuditEvent): Promise<AuditEvent>;
  listSlackIdentityAuditEvents(filter?: AuditEventFilter): Promise<AuditEvent[]>;
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
  private readonly audit: AuditStoreLogic;

  constructor(
    private readonly db: StateDb,
    seed: ConfigSeed = DEFAULT_SEED,
  ) {
    this.audit = new AuditStoreLogic(db);
    // One statement per exec: DO SQLite rejects multi-statement strings.
    db.exec(
      `CREATE TABLE IF NOT EXISTS config_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    this.runMigrations();
    this.seedOnce(seed);
    this.backfillWorkspaceDefaultSlackIdentity();
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

  createAgent(agent: AgentCreateInput): CustomAgentConfig {
    if (agent.slackIdentityId) {
      this.requireAssignableSlackIdentity(agent.slackIdentityId);
    }
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

  updateAgent(agentId: string, patch: ConfigAgentPatch, expectedRevision?: number): CustomAgentConfig {
    const current = this.getAgent(agentId);
    const actualRevision = current.revision;
    const requiredRevision = expectedRevision ?? actualRevision;
    if (requiredRevision !== actualRevision) {
      throw new AgentRevisionConflictError(agentId, requiredRevision, actualRevision);
    }
    const model = patch.model === undefined ? (current.model ?? null) : patch.model;
    const slackIdentityId =
      patch.slackIdentityId === undefined
        ? (current.slackIdentityId ?? null)
        : patch.slackIdentityId;
    if (slackIdentityId) {
      this.requireAssignableSlackIdentity(slackIdentityId);
    }
    const next = { ...current, ...patch, id: agentId };
    if (current.enabled && !next.enabled) {
      this.requireAgentHasNoBlockingReferences(agentId);
    }
    this.db.run(
      `UPDATE config_agents
       SET name = ?, instructions = ?, enabled = ?, model = ?,
           skills_json = ?, mcp_servers_json = ?, api_connections_json = ?, repositories_json = ?,
           slack_identity_id = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`,
      next.name,
      next.instructions,
      next.enabled ? 1 : 0,
      model,
      JSON.stringify(next.skills),
      JSON.stringify(next.mcpServers),
      JSON.stringify(next.apiConnections),
      JSON.stringify(next.repositories),
      slackIdentityId,
      agentId,
      requiredRevision,
    );
    const updated = this.db.get('SELECT revision FROM config_agents WHERE id = ?', agentId) as
      | { revision: number }
      | undefined;
    if (!updated || Number(updated.revision) !== requiredRevision + 1) {
      const latest = this.getAgent(agentId);
      throw new AgentRevisionConflictError(agentId, requiredRevision, latest.revision);
    }
    return this.getAgent(agentId);
  }

  markOAuthReauthorizationRequired(target: OAuthReauthorizationTarget): boolean {
    const agent = this.getAgent(target.agentId);
    if (target.lane === 'mcp') {
      const index = agent.mcpServers.findIndex(
        (connection) =>
          connection.id === target.connectionId &&
          connection.authMode === 'oauth' &&
          connection.url === target.serverUrl,
      );
      if (index < 0) return false;
      const mcpServers = agent.mcpServers.slice();
      const { identity: _identity, ...connection } = mcpServers[index]!;
      mcpServers[index] = {
        ...connection,
        lifecycleStatus: 'pending',
        statusText: 'Reconnect required',
      };
      return this.db.run(
        'UPDATE config_agents SET mcp_servers_json = ?, revision = revision + 1 WHERE id = ?',
        JSON.stringify(mcpServers),
        target.agentId,
      ).changes === 1;
    }

    const index = agent.apiConnections.findIndex(
      (connection) =>
        connection.id === target.connectionId &&
        connection.authMode === 'oauth' &&
        connection.oauthProvider === target.provider,
    );
    if (index < 0) return false;
    const apiConnections = agent.apiConnections.slice();
    const { identity: _identity, ...connection } = apiConnections[index]!;
    apiConnections[index] = {
      ...connection,
      lifecycleStatus: 'pending',
      statusText: 'Reconnect required',
    };
    return this.db.run(
      'UPDATE config_agents SET api_connections_json = ?, revision = revision + 1 WHERE id = ?',
      JSON.stringify(apiConnections),
      target.agentId,
    ).changes === 1;
  }

  deleteAgent(agentId: string): boolean {
    this.requireAgentHasNoBlockingReferences(agentId);
    const deleted = this.db.run('DELETE FROM config_agents WHERE id = ?', agentId);
    return deleted.changes === 1;
  }

  deleteAgentWithMemory(
    agentId: string,
    idempotencyKey: string,
    memory: MemoryStoreLogic = new MemoryStoreLogic(this.db),
  ): boolean {
    return this.db.transaction(() => {
      const replay = this.db.get(
        'SELECT agent_id FROM config_agent_deletion_receipts WHERE idempotency_key = ?',
        idempotencyKey,
      );
      if (replay) {
        if (replay.agent_id !== agentId) {
          throw new Error('Agent deletion idempotency key belongs to another Agent.');
        }
        return true;
      }
      this.requireAgentHasNoBlockingReferences(agentId);
      const deleted = this.db.run('DELETE FROM config_agents WHERE id = ?', agentId);
      if (deleted.changes !== 1) return false;
      memory.deleteAgentOwnerRows(agentId);
      this.db.run(
        `INSERT INTO config_agent_deletion_receipts (
          idempotency_key, workspace_id, agent_id, deleted_at
         ) VALUES (?, ?, ?, ?)`,
        idempotencyKey, '*', agentId, Date.now(),
      );
      return true;
    });
  }

  listChannels(): ChannelConfig[] {
    return this.db
      .all('SELECT * FROM config_channels ORDER BY workspace_id, channel_id')
      .map((row) => rowToChannel(row as unknown as ChannelRow));
  }

  getChannel(workspaceId: string, channelId: string): ChannelConfig | undefined {
    const row = this.db.get(
      'SELECT * FROM config_channels WHERE workspace_id = ? AND channel_id = ?',
      workspaceId,
      channelId,
    );
    return row ? rowToChannel(row as unknown as ChannelRow) : undefined;
  }

  putChannel(channel: ChannelConfig): ChannelConfig {
    this.putChannelRow(channel);
    return this.getChannel(channel.workspaceId, channel.channelId) as ChannelConfig;
  }

  putChannelPlacement(input: ChannelPlacementMutation): ChannelPlacementResult {
    if (input.agentId) this.getAgent(input.agentId);
    return this.db.transaction(() => {
      const current = this.getAssignment(input.channel.workspaceId, input.channel.channelId);
      if ((current?.agentId ?? null) !== input.expectedAgentId) {
        throw new ChannelAssignmentConflictError(
          input.channel.workspaceId,
          input.channel.channelId,
          input.expectedAgentId,
          current?.agentId ?? null,
        );
      }
      this.putChannelRow(input.channel);
      let assignment: ChannelAssignment | null = null;
      if (input.agentId) {
        assignment = {
          workspaceId: input.channel.workspaceId,
          channelId: input.channel.channelId,
          agentId: input.agentId,
        };
        this.putAssignmentRow(assignment);
        this.syncDefaultDmIdentityFromAssignment(assignment);
      } else {
        this.deleteAssignmentRow(input.channel.workspaceId, input.channel.channelId);
      }
      return { channel: this.getChannel(input.channel.workspaceId, input.channel.channelId)!, assignment };
    });
  }

  private putChannelRow(channel: ChannelConfig): void {
    this.db.run(
      `INSERT INTO config_channels (
        workspace_id, channel_id, label, additional_instructions, participation_mode, lifecycle
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id) DO UPDATE SET
        label = excluded.label,
        additional_instructions = excluded.additional_instructions,
        participation_mode = excluded.participation_mode,
        lifecycle = excluded.lifecycle`,
      channel.workspaceId,
      channel.channelId,
      channel.label ?? null,
      channel.additionalInstructions ?? null,
      channel.participationMode,
      channel.lifecycle,
    );
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
    return this.db.transaction(() => {
      if (
        assignment.workspaceId !== '*' &&
        assignment.channelId !== '*' &&
        !this.getChannel(assignment.workspaceId, assignment.channelId)
      ) {
        this.putChannelRow(defaultChannelConfig(assignment.workspaceId, assignment.channelId));
      }
      this.putAssignmentRow(assignment);
      this.syncDefaultDmIdentityFromAssignment(assignment);
      return this.getAssignment(assignment.workspaceId, assignment.channelId) as ChannelAssignment;
    });
  }

  private putAssignmentRow(assignment: ChannelAssignment): void {
    this.db.run(
      `INSERT INTO config_assignments (
        workspace_id, channel_id, agent_id
      ) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, channel_id) DO UPDATE SET
        agent_id = excluded.agent_id`,
      assignment.workspaceId,
      assignment.channelId,
      assignment.agentId,
    );
  }

  deleteAssignment(workspaceId: string, channelId: string): boolean {
    return this.db.transaction(() => {
      const deleted = this.deleteAssignmentRow(workspaceId, channelId);
      if (deleted && workspaceId === '*' && channelId === '*') {
        const identity = this.workspaceDefaultSlackIdentity();
        if (identity) {
          this.updateSlackIdentity(identity.id, identity.connectionRevision, {
            dmState: 'needs_setup',
            dmAgentId: null,
          });
        }
      }
      return deleted;
    });
  }

  private deleteAssignmentRow(workspaceId: string, channelId: string): boolean {
    return this.db.run(
      'DELETE FROM config_assignments WHERE workspace_id = ? AND channel_id = ?',
      workspaceId,
      channelId,
    ).changes === 1;
  }

  // Assignment precedence, most specific first: exact (workspace, channel), then
  // (workspace, '*'), then ('*', channel), then the ('*', '*') catch-all. The
  // The ('*', '*') catch-all is the DIRECT-conversation default only. A 'channel'
  // surface excludes it entirely (fail-closed): a public/private channel answers
  // only where an operator explicitly assigned an Agent.
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
    return rowToAssignment(row as unknown as AssignmentRow);
  }

  getAgentReferences(agentId: string): AgentReferenceSummary {
    this.getAgent(agentId);
    const identities = this.listSlackIdentities();
    return {
      agentId,
      channelAssignments: this.listAssignmentsForAgent(agentId).map(
        ({ workspaceId, channelId }) => ({ workspaceId, channelId }),
      ),
      dmIdentityIds: identities
        .filter((identity) => identity.dmAgentId === agentId)
        .map(({ id }) => id),
      identityReferenceIds: identities
        .filter((identity) => identity.setupIntent?.sourceAgentId === agentId)
        .map(({ id }) => id),
    };
  }

  private requireAgentHasNoBlockingReferences(agentId: string): void {
    const references = this.getAgentReferences(agentId);
    const blockers = [
      ...references.channelAssignments.map((ref) => `${ref.workspaceId}/${ref.channelId}`),
      ...references.dmIdentityIds.map((id) => `DM:${id}`),
      ...references.identityReferenceIds.map((id) => `identity:${id}`),
    ];
    if (blockers.length > 0) {
      throw new AgentStillReferencedError(agentId, blockers.join(', '));
    }
  }

  listSlackIdentities(): SlackIdentity[] {
    return this.db
      .all('SELECT * FROM config_slack_identities ORDER BY kind DESC, created_at, id')
      .map((row) => rowToSlackIdentity(row as unknown as SlackIdentityRow));
  }

  getSlackIdentity(identityId: string): SlackIdentity {
    const row = this.db.get('SELECT * FROM config_slack_identities WHERE id = ?', identityId);
    if (!row) {
      throw new UnknownSlackIdentityError(identityId);
    }
    return rowToSlackIdentity(row as unknown as SlackIdentityRow);
  }

  getSlackIdentityByIngressKey(ingressKey: string): SlackIdentity | undefined {
    const row = this.db.get(
      'SELECT * FROM config_slack_identities WHERE ingress_key = ?',
      ingressKey,
    );
    return row ? rowToSlackIdentity(row as unknown as SlackIdentityRow) : undefined;
  }

  createSlackIdentity(identity: SlackIdentity): SlackIdentity {
    this.validateSlackIdentity(identity);
    let inserted;
    try {
      inserted = this.insertSlackIdentity(identity);
    } catch (err) {
      if (isConstraintViolation(err)) {
        throw new SlackIdentityExistsError(identity.id);
      }
      throw err;
    }
    if (inserted.changes !== 1) {
      throw new Error(`Slack identity ${identity.id} was not created`);
    }
    return this.getSlackIdentity(identity.id);
  }

  updateSlackIdentity(
    identityId: string,
    expectedRevision: number,
    patch: SlackIdentityPatch,
    allowRetirement = false,
  ): SlackIdentity {
    const current = this.getSlackIdentity(identityId);
    this.requireSlackIdentityRevision(current, expectedRevision);
    if (
      patch.lifecycle === 'retired' &&
      current.lifecycle !== 'retired' &&
      !allowRetirement
    ) {
      throw new SlackIdentityLifecycleError(identityId, 'retire without retirement checks', current.lifecycle);
    }
    const next = {
      ...current,
      ...patch,
      id: current.id,
      kind: current.kind,
      createdAt: current.createdAt,
      connectionRevision: current.connectionRevision + 1,
      updatedAt: Date.now(),
    } as SlackIdentity;
    for (const key of [
      'teamId',
      'appId',
      'botUserId',
      'dmAgentId',
      'observedDisplayName',
      'observedAvatarUrl',
      'observedAt',
      'healthDetail',
      'retiredAt',
      'setupIntent',
    ] as const) {
      if (patch[key] === null) delete next[key];
    }
    this.validateSlackIdentity(next);
    const updated = this.db.run(
      `UPDATE config_slack_identities
       SET ingress_key = ?, lifecycle = ?, team_id = ?, app_id = ?, bot_user_id = ?,
           dm_state = ?, dm_agent_id = ?, credential_provenance = ?,
           connection_revision = ?, observed_display_name = ?, observed_avatar_url = ?,
           observed_at = ?, health = ?, health_detail = ?, updated_at = ?, retired_at = ?,
           setup_intent_json = ?
       WHERE id = ? AND connection_revision = ?`,
      next.ingressKey,
      next.lifecycle,
      next.teamId ?? null,
      next.appId ?? null,
      next.botUserId ?? null,
      next.dmState,
      next.dmAgentId ?? null,
      next.credentialProvenance,
      next.connectionRevision,
      next.observedDisplayName ?? null,
      next.observedAvatarUrl ?? null,
      next.observedAt ?? null,
      next.health,
      next.healthDetail ?? null,
      next.updatedAt,
      next.retiredAt ?? null,
      next.setupIntent ? JSON.stringify(next.setupIntent) : null,
      identityId,
      expectedRevision,
    );
    if (updated.changes !== 1) {
      const actual = this.getSlackIdentity(identityId).connectionRevision;
      throw new SlackIdentityRevisionConflictError(identityId, expectedRevision, actual);
    }
    return this.getSlackIdentity(identityId);
  }

  listSlackIdentitiesForAgent(agentId: string): SlackIdentity[] {
    const agent = this.getAgent(agentId);
    const effectiveIdentityId = agent.slackIdentityId ?? WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
    return this.db
      .all(
        `SELECT * FROM config_slack_identities
         WHERE id = ? OR dm_agent_id = ?
         ORDER BY kind DESC, created_at, id`,
        effectiveIdentityId,
        agentId,
      )
      .map((row) => rowToSlackIdentity(row as unknown as SlackIdentityRow));
  }

  listAgentsForSlackIdentity(identityId: string): CustomAgentConfig[] {
    this.getSlackIdentity(identityId);
    return this.db
      .all(
        `SELECT * FROM config_agents
         WHERE slack_identity_id = ?
            OR (? = ? AND slack_identity_id IS NULL)
         ORDER BY id`,
        identityId,
        identityId,
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      )
      .map((row) => rowToAgent(row as unknown as AgentRow));
  }

  resolveSlackIdentityForAgent(agentId: string): SlackIdentity {
    const agent = this.getAgent(agentId);
    return this.getSlackIdentity(agent.slackIdentityId ?? WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
  }

  getSlackIdentityReferences(identityId: string): SlackIdentityReferenceSummary {
    const identity = this.getSlackIdentity(identityId);
    return {
      identityId,
      agentIds: this.listAgentsForSlackIdentity(identityId).map(({ id }) => id),
      ...(identity.dmAgentId ? { dmAgentId: identity.dmAgentId } : {}),
    };
  }

  setSlackIdentityDmBinding(
    identityId: string,
    expectedRevision: number,
    dmState: SlackIdentityDmState,
    dmAgentId?: string,
  ): SlackIdentity {
    return this.db.transaction(() => {
      const updated = this.updateSlackIdentity(identityId, expectedRevision, {
        dmState,
        dmAgentId: dmAgentId ?? null,
      });
      if (identityId !== WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) return updated;

      if (dmState !== 'on' || !dmAgentId) {
        this.deleteAssignmentRow('*', '*');
      } else {
        this.putAssignmentRow({
          workspaceId: '*',
          channelId: '*',
          agentId: dmAgentId,
        });
      }
      return updated;
    });
  }

  completeSlackIdentitySetup(
    identityId: string,
    expectedRevision: number,
    agentId?: string,
    expectedAgentIdentityId: string | null = null,
  ): SlackIdentity {
    return this.db.transaction(() => {
      const identity = this.getSlackIdentity(identityId);
      this.requireSlackIdentityRevision(identity, expectedRevision);
      this.requireDedicatedSlackIdentity(identity, 'complete setup');
      if (identity.lifecycle !== 'credentials_pending') {
        throw new SlackIdentityLifecycleError(
          identityId,
          'complete setup',
          identity.lifecycle,
        );
      }
      if (agentId) {
        this.requireAgentSlackIdentity(agentId, expectedAgentIdentityId);
      }
      const retainedSetupIntent = { ...identity.setupIntent };
      delete retainedSetupIntent.sourceAgentId;
      delete retainedSetupIntent.sourceAgentSlackIdentityId;
      delete retainedSetupIntent.reconnecting;
      const connected = this.updateSlackIdentity(identityId, expectedRevision, {
        lifecycle: 'connected',
        health: 'healthy',
        healthDetail: null,
        setupIntent:
          Object.keys(retainedSetupIntent).length > 0
            ? retainedSetupIntent
            : null,
      });
      if (agentId) {
        this.updateAgent(agentId, { slackIdentityId: identityId });
      }
      return connected;
    });
  }

  attachAgentToSlackIdentity(
    agentId: string,
    identityId: string,
    expectedIdentityRevision: number,
    expectedAgentIdentityId: string | null,
  ): CustomAgentConfig {
    return this.db.transaction(() => {
      const identity = this.getSlackIdentity(identityId);
      this.requireSlackIdentityRevision(identity, expectedIdentityRevision);
      this.requireAssignableSlackIdentity(identityId);
      this.requireAgentSlackIdentity(agentId, expectedAgentIdentityId);
      return this.updateAgent(agentId, {
        slackIdentityId:
          identityId === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID ? null : identityId,
      });
    });
  }

  retireSlackIdentity(identityId: string, expectedRevision: number): SlackIdentity {
    const identity = this.getSlackIdentity(identityId);
    this.requireSlackIdentityRevision(identity, expectedRevision);
    this.requireDedicatedSlackIdentity(identity, 'retire');
    if (identity.lifecycle === 'retired') return identity;
    if (identity.lifecycle !== 'connected' && identity.lifecycle !== 'degraded') {
      throw new SlackIdentityLifecycleError(identityId, 'retire', identity.lifecycle);
    }
    const references = this.getSlackIdentityReferences(identityId);
    if (references.agentIds.length > 0) {
      throw new SlackIdentityStillReferencedError(
        identityId,
        references.agentIds.join(', '),
        '',
      );
    }
    if (identity.dmState !== 'off') {
      throw new SlackIdentityStillReferencedError(
        identityId,
        '',
        identity.dmAgentId ?? 'DMs must be turned off',
      );
    }
    return this.updateSlackIdentity(
      identityId,
      expectedRevision,
      {
        lifecycle: 'retired',
        dmAgentId: null,
        health: 'disconnected',
        retiredAt: Date.now(),
      },
      true,
    );
  }

  deleteIncompleteSlackIdentity(
    identityId: string,
    expectedRevision: number,
    credentialsErased: boolean,
  ): boolean {
    const identity = this.getSlackIdentity(identityId);
    this.requireSlackIdentityRevision(identity, expectedRevision);
    this.requireDedicatedSlackIdentity(identity, 'delete');
    if (
      identity.lifecycle !== 'setup_incomplete' &&
      identity.lifecycle !== 'credentials_pending'
    ) {
      throw new SlackIdentityLifecycleError(identityId, 'delete', identity.lifecycle);
    }
    if (!credentialsErased) {
      throw new SlackIdentityLifecycleError(identityId, 'delete before credentials are erased', identity.lifecycle);
    }
    const references = this.getSlackIdentityReferences(identityId);
    // A pending identity's DM Agent is setup intent, not a runtime binding:
    // the identity cannot admit DMs until connected. It must not make a
    // credential-erased cancellation undeletable. Explicit Agent presence
    // references remain blockers.
    if (references.agentIds.length > 0) {
      throw new SlackIdentityStillReferencedError(
        identityId,
        references.agentIds.join(', '),
        '',
      );
    }
    return this.db.run('DELETE FROM config_slack_identities WHERE id = ?', identityId).changes === 1;
  }

  purgeRetiredSlackIdentity(
    identityId: string,
    expectedRevision: number,
    credentialsErased: boolean,
  ): boolean {
    const identity = this.getSlackIdentity(identityId);
    this.requireSlackIdentityRevision(identity, expectedRevision);
    this.requireDedicatedSlackIdentity(identity, 'purge');
    if (identity.lifecycle !== 'retired') {
      throw new SlackIdentityLifecycleError(identityId, 'purge', identity.lifecycle);
    }
    if (!credentialsErased) {
      throw new SlackIdentityLifecycleError(identityId, 'purge before credentials are erased', identity.lifecycle);
    }
    this.requireNoSlackIdentityReferences(identityId);
    return this.db.run('DELETE FROM config_slack_identities WHERE id = ?', identityId).changes === 1;
  }

  appendSlackIdentityAudit(input: AppendAuditEvent): AuditEvent {
    if (input.domain !== 'slack_identity') {
      throw new Error('ConfigStore accepts only Slack identity audit events');
    }
    return this.audit.appendIdempotent(input);
  }

  listSlackIdentityAuditEvents(filter: AuditEventFilter = {}): AuditEvent[] {
    return this.audit.list({ ...filter, domain: 'slack_identity' });
  }

  private requireNoSlackIdentityReferences(identityId: string): void {
    const references = this.getSlackIdentityReferences(identityId);
    if (references.agentIds.length > 0 || references.dmAgentId) {
      throw new SlackIdentityStillReferencedError(
        identityId,
        references.agentIds.join(', '),
        references.dmAgentId ?? '',
      );
    }
  }

  private requireDedicatedSlackIdentity(identity: SlackIdentity, action: string): void {
    if (identity.kind === 'workspace_default') {
      throw new WorkspaceDefaultSlackIdentityProtectedError(action);
    }
  }

  private requireSlackIdentityRevision(identity: SlackIdentity, expectedRevision: number): void {
    if (identity.connectionRevision !== expectedRevision) {
      throw new SlackIdentityRevisionConflictError(
        identity.id,
        expectedRevision,
        identity.connectionRevision,
      );
    }
  }

  private requireAgentSlackIdentity(
    agentId: string,
    expectedIdentityId: string | null,
  ): CustomAgentConfig {
    const agent = this.getAgent(agentId);
    const actualIdentityId = agent.slackIdentityId ?? null;
    if (actualIdentityId !== expectedIdentityId) {
      throw new AgentSlackIdentityConflictError(
        agentId,
        expectedIdentityId,
        actualIdentityId,
      );
    }
    return agent;
  }

  private requireAssignableSlackIdentity(identityId: string): SlackIdentity {
    const identity = this.getSlackIdentity(identityId);
    if (identity.lifecycle !== 'connected' && identity.lifecycle !== 'degraded') {
      throw new SlackIdentityLifecycleError(identityId, 'assign', identity.lifecycle);
    }
    return identity;
  }

  private workspaceDefaultSlackIdentity(): SlackIdentity | undefined {
    const row = this.db.get(
      'SELECT * FROM config_slack_identities WHERE id = ?',
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    );
    return row ? rowToSlackIdentity(row as unknown as SlackIdentityRow) : undefined;
  }

  private syncDefaultDmIdentityFromAssignment(assignment: ChannelAssignment): void {
    if (assignment.workspaceId !== '*' || assignment.channelId !== '*') return;
    const identity = this.workspaceDefaultSlackIdentity();
    if (!identity) return;
    const agent = this.getAgent(assignment.agentId);
    this.updateSlackIdentity(identity.id, identity.connectionRevision, {
      dmState: agent.enabled ? 'on' : 'needs_setup',
      dmAgentId: agent.enabled ? agent.id : null,
    });
  }

  private validateSlackIdentity(identity: SlackIdentity): void {
    if (!identity.id || !identity.ingressKey) {
      throw new Error('Slack identity id and ingress key are required');
    }
    if (!Number.isSafeInteger(identity.connectionRevision) || identity.connectionRevision < 0) {
      throw new Error('Slack identity connection revision must be a non-negative integer');
    }
    if (
      (identity.kind === 'workspace_default') !==
      (identity.id === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID)
    ) {
      throw new Error('The reserved Slack identity id and workspace-default kind must match');
    }
    if (identity.kind === 'workspace_default' && identity.lifecycle === 'retired') {
      throw new WorkspaceDefaultSlackIdentityProtectedError('retire');
    }
    if (identity.dmState === 'on' && !identity.dmAgentId) {
      throw new Error(`Slack identity ${identity.id} requires a DM Agent while DMs are on`);
    }
    if (identity.dmState === 'needs_setup' && identity.dmAgentId) {
      throw new Error(`Slack identity ${identity.id} cannot remember a DM Agent while setup is required`);
    }
    if (identity.dmAgentId) {
      const dmAgent = this.getAgent(identity.dmAgentId);
      if (!dmAgent.enabled && identity.dmState === 'on') {
        throw new Error(`Slack identity ${identity.id} requires an enabled DM Agent`);
      }
    }
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
        for (const channel of seed.channels ?? []) {
          this.putChannelRow(channel);
        }
        for (const assignment of seed.assignments) {
          this.getAgent(assignment.agentId);
          if (
            assignment.workspaceId !== '*' &&
            assignment.channelId !== '*' &&
            !this.getChannel(assignment.workspaceId, assignment.channelId)
          ) {
            this.putChannelRow(channelFromSeedAssignment(assignment));
          }
          if (assignment.enabled !== false) this.putAssignmentRow(assignment);
        }
      }
      this.db.run(
        'INSERT INTO config_meta (key, value) VALUES (?, ?)',
        SEED_META_KEY,
        new Date().toISOString(),
      );
    });
  }

  private insertAgent(agent: AgentCreateInput): { changes: number } {
    return this.db.run(
      `INSERT INTO config_agents (
        id, revision, name, instructions, enabled, model,
        skills_json, mcp_servers_json, api_connections_json, repositories_json,
        slack_identity_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agent.id,
      1,
      agent.name,
      agent.instructions,
      agent.enabled ? 1 : 0,
      agent.model ?? null,
      JSON.stringify(agent.skills ?? []),
      JSON.stringify(agent.mcpServers ?? []),
      JSON.stringify(agent.apiConnections ?? []),
      JSON.stringify(agent.repositories ?? []),
      agent.slackIdentityId ?? null,
    );
  }

  private insertSlackIdentity(identity: SlackIdentity): { changes: number } {
    return this.db.run(
      `INSERT INTO config_slack_identities (
        id, ingress_key, kind, lifecycle, team_id, app_id, bot_user_id,
        dm_state, dm_agent_id, credential_provenance, connection_revision,
        observed_display_name, observed_avatar_url, observed_at, health,
        health_detail, created_at, updated_at, retired_at, setup_intent_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      identity.id,
      identity.ingressKey,
      identity.kind,
      identity.lifecycle,
      identity.teamId ?? null,
      identity.appId ?? null,
      identity.botUserId ?? null,
      identity.dmState,
      identity.dmAgentId ?? null,
      identity.credentialProvenance,
      identity.connectionRevision,
      identity.observedDisplayName ?? null,
      identity.observedAvatarUrl ?? null,
      identity.observedAt ?? null,
      identity.health,
      identity.healthDetail ?? null,
      identity.createdAt,
      identity.updatedAt,
      identity.retiredAt ?? null,
      identity.setupIntent ? JSON.stringify(identity.setupIntent) : null,
    );
  }

  private backfillWorkspaceDefaultSlackIdentity(): void {
    if (
      this.db.get(
        'SELECT id FROM config_slack_identities WHERE id = ?',
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      )
    ) {
      return;
    }
    const direct = this.db.get(
      `SELECT a.id, a.enabled AS agent_enabled
       FROM config_assignments x
       LEFT JOIN config_agents a ON a.id = x.agent_id
       WHERE x.workspace_id = '*' AND x.channel_id = '*'`,
    );
    const dmAgentId =
      direct && Number(direct.agent_enabled) === 1
        ? String(direct.id)
        : undefined;
    const now = Date.now();
    this.insertSlackIdentity({
      id: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      ingressKey: generateSlackIdentityIngressKey(),
      kind: 'workspace_default',
      lifecycle: 'setup_incomplete',
      dmState: dmAgentId ? 'on' : 'needs_setup',
      ...(dmAgentId ? { dmAgentId } : {}),
      credentialProvenance: 'workspace_default',
      connectionRevision: 0,
      health: 'unknown',
      createdAt: now,
      updatedAt: now,
    });
  }

  // Fresh databases start from the clean v1 schema. Migration v2 bridges the
  // pre-release default_models_json column; v3 adds API connection policy;
  // v4 adds per-Agent repository grants. v5 is reserved after the pre-release
  // per-Agent OpenAI auth experiment moved to one installation setting. v6
  // added the original assignment-owned participation ceiling. v7 adds
  // SlackIdentity policy and the reserved workspace-default backfill. v8
  // separates durable Channel state from Agent placement. v10 adds Agent CAS.
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
      {
        version: 3,
        up: (db) => {
          const hasApiConnections = db
            .all('PRAGMA table_info(config_agents)')
            .some((column) => column.name === 'api_connections_json');
          if (!hasApiConnections) {
            db.exec(
              "ALTER TABLE config_agents ADD COLUMN api_connections_json TEXT NOT NULL DEFAULT '[]'",
            );
          }
        },
      },
      {
        version: 4,
        up: (db) => {
          const hasRepositories = db
            .all('PRAGMA table_info(config_agents)')
            .some((column) => column.name === 'repositories_json');
          if (!hasRepositories) {
            db.exec(
              "ALTER TABLE config_agents ADD COLUMN repositories_json TEXT NOT NULL DEFAULT '[]'",
            );
          }
        },
      },
      {
        version: 5,
        up: () => {},
      },
      {
        version: 6,
        up: (db) => {
          const hasParticipationMode = db
            .all('PRAGMA table_info(config_assignments)')
            .some((column) => column.name === 'participation_mode');
          if (!hasParticipationMode) {
            db.exec(
              "ALTER TABLE config_assignments ADD COLUMN participation_mode TEXT NOT NULL DEFAULT 'ambient'",
            );
          }
        },
      },
      {
        version: 7,
        up: (db) => {
          const hasSlackIdentityId = db
            .all('PRAGMA table_info(config_agents)')
            .some((column) => column.name === 'slack_identity_id');
          if (!hasSlackIdentityId) {
            db.exec('ALTER TABLE config_agents ADD COLUMN slack_identity_id TEXT');
          }
          db.exec(
            `CREATE TABLE IF NOT EXISTS config_slack_identities (
              id TEXT PRIMARY KEY,
              ingress_key TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL,
              lifecycle TEXT NOT NULL,
              team_id TEXT,
              app_id TEXT,
              bot_user_id TEXT,
              dm_state TEXT NOT NULL,
              dm_agent_id TEXT,
              credential_provenance TEXT NOT NULL,
              connection_revision INTEGER NOT NULL,
              observed_display_name TEXT,
              observed_avatar_url TEXT,
              observed_at INTEGER,
              health TEXT NOT NULL,
              health_detail TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              retired_at INTEGER,
              setup_intent_json TEXT
            )`,
          );
          db.exec(
            'CREATE UNIQUE INDEX IF NOT EXISTS config_slack_identities_app_id_unique ON config_slack_identities(app_id) WHERE app_id IS NOT NULL',
          );
          db.exec(
            'CREATE INDEX IF NOT EXISTS config_slack_identities_dm_agent_idx ON config_slack_identities(dm_agent_id)',
          );
          db.exec(
            'CREATE INDEX IF NOT EXISTS config_agents_slack_identity_idx ON config_agents(slack_identity_id)',
          );
        },
      },
      {
        version: 8,
        up: (db) => {
          const assignmentColumns = new Set(
            db.all('PRAGMA table_info(config_assignments)').map((column) => String(column.name)),
          );
          db.exec(
            `CREATE TABLE IF NOT EXISTS config_channels (
              workspace_id TEXT NOT NULL,
              channel_id TEXT NOT NULL,
              label TEXT,
              additional_instructions TEXT,
              participation_mode TEXT NOT NULL,
              lifecycle TEXT NOT NULL,
              PRIMARY KEY (workspace_id, channel_id)
            )`,
          );
          const legacyParticipation = assignmentColumns.has('participation_mode')
            ? "COALESCE(participation_mode, 'ambient')"
            : "'ambient'";
          db.exec(
            `INSERT OR IGNORE INTO config_channels (
              workspace_id, channel_id, label, additional_instructions,
              participation_mode, lifecycle
            )
            SELECT workspace_id, channel_id, channel_label, channel_prompt_addendum,
                   ${legacyParticipation}, 'active'
            FROM config_assignments
            WHERE workspace_id != '*' AND channel_id != '*'`,
          );
          db.exec(
            `CREATE TABLE config_assignments_v8 (
              workspace_id TEXT NOT NULL,
              channel_id TEXT NOT NULL,
              agent_id TEXT NOT NULL,
              PRIMARY KEY (workspace_id, channel_id)
            )`,
          );
          db.exec(
            `INSERT INTO config_assignments_v8 (workspace_id, channel_id, agent_id)
             SELECT workspace_id, channel_id, agent_id
             FROM config_assignments
             WHERE enabled = 1`,
          );
          db.exec('DROP TABLE config_assignments');
          db.exec('ALTER TABLE config_assignments_v8 RENAME TO config_assignments');
          db.exec(
            'CREATE INDEX IF NOT EXISTS config_assignments_agent_idx ON config_assignments(agent_id)',
          );
        },
      },
      {
        version: 9,
        up: (db) => {
          db.exec(
            `CREATE TABLE IF NOT EXISTS config_agent_deletion_receipts (
              idempotency_key TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              agent_id TEXT NOT NULL,
              deleted_at INTEGER NOT NULL
            )`,
          );
        },
      },
      {
        version: 10,
        up: (db) => {
          const hasRevision = db
            .all('PRAGMA table_info(config_agents)')
            .some((column) => column.name === 'revision');
          if (!hasRevision) {
            db.exec('ALTER TABLE config_agents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
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

  async createAgent(agent: AgentCreateInput): Promise<CustomAgentConfig> {
    return this.logic.createAgent(agent);
  }

  async updateAgent(agentId: string, patch: ConfigAgentPatch, expectedRevision?: number): Promise<CustomAgentConfig> {
    return this.logic.updateAgent(agentId, patch, expectedRevision);
  }

  async markOAuthReauthorizationRequired(target: OAuthReauthorizationTarget): Promise<boolean> {
    return this.logic.markOAuthReauthorizationRequired(target);
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    return this.logic.deleteAgent(agentId);
  }

  async deleteAgentWithMemory(
    agentId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    return this.logic.deleteAgentWithMemory(agentId, idempotencyKey);
  }

  async listChannels(): Promise<ChannelConfig[]> {
    return this.logic.listChannels();
  }

  async getChannel(workspaceId: string, channelId: string): Promise<ChannelConfig | undefined> {
    return this.logic.getChannel(workspaceId, channelId);
  }

  async putChannel(channel: ChannelConfig): Promise<ChannelConfig> {
    return this.logic.putChannel(channel);
  }

  async putChannelPlacement(input: ChannelPlacementMutation): Promise<ChannelPlacementResult> {
    return this.logic.putChannelPlacement(input);
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

  async getAgentReferences(agentId: string): Promise<AgentReferenceSummary> {
    return this.logic.getAgentReferences(agentId);
  }

  async listSlackIdentities(): Promise<SlackIdentity[]> {
    return this.logic.listSlackIdentities();
  }

  async getSlackIdentity(identityId: string): Promise<SlackIdentity> {
    return this.logic.getSlackIdentity(identityId);
  }

  async getSlackIdentityByIngressKey(ingressKey: string): Promise<SlackIdentity | undefined> {
    return this.logic.getSlackIdentityByIngressKey(ingressKey);
  }

  async createSlackIdentity(identity: SlackIdentity): Promise<SlackIdentity> {
    return this.logic.createSlackIdentity(identity);
  }

  async updateSlackIdentity(
    identityId: string,
    expectedRevision: number,
    patch: SlackIdentityPatch,
  ): Promise<SlackIdentity> {
    return this.logic.updateSlackIdentity(identityId, expectedRevision, patch);
  }

  async listSlackIdentitiesForAgent(agentId: string): Promise<SlackIdentity[]> {
    return this.logic.listSlackIdentitiesForAgent(agentId);
  }

  async listAgentsForSlackIdentity(identityId: string): Promise<CustomAgentConfig[]> {
    return this.logic.listAgentsForSlackIdentity(identityId);
  }

  async resolveSlackIdentityForAgent(agentId: string): Promise<SlackIdentity> {
    return this.logic.resolveSlackIdentityForAgent(agentId);
  }

  async getSlackIdentityReferences(
    identityId: string,
  ): Promise<SlackIdentityReferenceSummary> {
    return this.logic.getSlackIdentityReferences(identityId);
  }

  async setSlackIdentityDmBinding(
    identityId: string,
    expectedRevision: number,
    dmState: SlackIdentityDmState,
    dmAgentId?: string,
  ): Promise<SlackIdentity> {
    return this.logic.setSlackIdentityDmBinding(
      identityId,
      expectedRevision,
      dmState,
      dmAgentId,
    );
  }

  async completeSlackIdentitySetup(
    identityId: string,
    expectedRevision: number,
    agentId?: string,
    expectedAgentIdentityId?: string | null,
  ): Promise<SlackIdentity> {
    return this.logic.completeSlackIdentitySetup(
      identityId,
      expectedRevision,
      agentId,
      expectedAgentIdentityId,
    );
  }

  async attachAgentToSlackIdentity(
    agentId: string,
    identityId: string,
    expectedIdentityRevision: number,
    expectedAgentIdentityId: string | null,
  ): Promise<CustomAgentConfig> {
    return this.logic.attachAgentToSlackIdentity(
      agentId,
      identityId,
      expectedIdentityRevision,
      expectedAgentIdentityId,
    );
  }

  async retireSlackIdentity(
    identityId: string,
    expectedRevision: number,
  ): Promise<SlackIdentity> {
    return this.logic.retireSlackIdentity(identityId, expectedRevision);
  }

  async deleteIncompleteSlackIdentity(
    identityId: string,
    expectedRevision: number,
    credentialsErased: boolean,
  ): Promise<boolean> {
    return this.logic.deleteIncompleteSlackIdentity(
      identityId,
      expectedRevision,
      credentialsErased,
    );
  }

  async purgeRetiredSlackIdentity(
    identityId: string,
    expectedRevision: number,
    credentialsErased: boolean,
  ): Promise<boolean> {
    return this.logic.purgeRetiredSlackIdentity(
      identityId,
      expectedRevision,
      credentialsErased,
    );
  }

  async appendSlackIdentityAudit(input: AppendAuditEvent): Promise<AuditEvent> {
    return this.logic.appendSlackIdentityAudit(input);
  }

  async listSlackIdentityAuditEvents(
    filter: AuditEventFilter = {},
  ): Promise<AuditEvent[]> {
    return this.logic.listSlackIdentityAuditEvents(filter);
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
    revision: Number(row.revision ?? 1),
    name: row.name,
    instructions: row.instructions,
    enabled: Boolean(row.enabled),
    ...(row.model ? { model: row.model } : {}),
    skills: JSON.parse(row.skills_json) as CustomAgentConfig['skills'],
    mcpServers: JSON.parse(row.mcp_servers_json) as CustomAgentConfig['mcpServers'],
    apiConnections: parseApiConnections(row.api_connections_json),
    repositories: parseRepositories(row.repositories_json),
    ...(row.slack_identity_id ? { slackIdentityId: row.slack_identity_id } : {}),
  };
}

function rowToSlackIdentity(row: SlackIdentityRow): SlackIdentity {
  return {
    id: row.id,
    ingressKey: row.ingress_key,
    kind: row.kind as SlackIdentity['kind'],
    lifecycle: row.lifecycle as SlackIdentity['lifecycle'],
    ...(row.team_id ? { teamId: row.team_id } : {}),
    ...(row.app_id ? { appId: row.app_id } : {}),
    ...(row.bot_user_id ? { botUserId: row.bot_user_id } : {}),
    dmState: row.dm_state as SlackIdentity['dmState'],
    ...(row.dm_agent_id ? { dmAgentId: row.dm_agent_id } : {}),
    credentialProvenance:
      row.credential_provenance as SlackIdentity['credentialProvenance'],
    connectionRevision: Number(row.connection_revision),
    ...(row.observed_display_name
      ? { observedDisplayName: row.observed_display_name }
      : {}),
    ...(row.observed_avatar_url ? { observedAvatarUrl: row.observed_avatar_url } : {}),
    ...(row.observed_at !== null ? { observedAt: Number(row.observed_at) } : {}),
    health: row.health as SlackIdentity['health'],
    ...(row.health_detail ? { healthDetail: row.health_detail } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.retired_at !== null ? { retiredAt: Number(row.retired_at) } : {}),
    ...(row.setup_intent_json
      ? { setupIntent: parseSlackIdentitySetupIntent(row.setup_intent_json) }
      : {}),
  };
}

function parseSlackIdentitySetupIntent(raw: string): NonNullable<SlackIdentity['setupIntent']> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as NonNullable<SlackIdentity['setupIntent']>)
      : {};
  } catch {
    return {};
  }
}

function parseApiConnections(raw: string | null | undefined): CustomAgentConfig['apiConnections'] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? (parsed as CustomAgentConfig['apiConnections']) : [];
  } catch {
    return [];
  }
}

function parseRepositories(raw: string | null | undefined): CustomAgentConfig['repositories'] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? (parsed as CustomAgentConfig['repositories']) : [];
  } catch {
    return [];
  }
}

function rowToAssignment(row: AssignmentRow): ChannelAssignment {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    agentId: row.agent_id,
  };
}

function rowToChannel(row: ChannelRow): ChannelConfig {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    ...(row.label ? { label: row.label } : {}),
    ...(row.additional_instructions
      ? { additionalInstructions: row.additional_instructions }
      : {}),
    participationMode: row.participation_mode === 'mention_only' ? 'mention_only' : 'ambient',
    lifecycle: row.lifecycle === 'archived' ? 'archived' : 'active',
  };
}

function defaultChannelConfig(workspaceId: string, channelId: string): ChannelConfig {
  return {
    workspaceId,
    channelId,
    participationMode: 'ambient',
    lifecycle: 'active',
  };
}

function channelFromSeedAssignment(assignment: ConfigSeedAssignment): ChannelConfig {
  return {
    ...defaultChannelConfig(assignment.workspaceId, assignment.channelId),
    ...(assignment.channelLabel ? { label: assignment.channelLabel } : {}),
    ...(assignment.channelPromptAddendum
      ? { additionalInstructions: assignment.channelPromptAddendum }
      : {}),
    participationMode: assignment.participationMode ?? 'ambient',
  };
}

function countRows(db: StateDb, table: string): number {
  const row = db.get(`SELECT COUNT(*) AS count FROM ${table}`) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** 192 bits of target-neutral CSPRNG material, encoded without Node globals. */
export function generateSlackIdentityIngressKey(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
