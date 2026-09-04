import {
  AgentRevisionConflictError,
  AgentExistsError,
  AgentStillReferencedError,
  ChannelRevisionConflictError,
  ConnectionAccountAlreadyBoundError,
  ConnectionAccountRevisionConflictError,
  ManagedRemoteAccountAlreadyUsedError,
  ReservedAgentIdentityError,
  UnknownAgentError,
  WorkspaceModelDefaultRevisionConflictError,
} from './errors.ts';
import {
  createChickpeaAgent,
  seededAgents,
  seededAgentChannelGrants,
  SEED_CLOUDFLARE_MODEL_PIN,
  isSeedCloudflareModelPin,
  seededWorkspaceModelDefault,
} from './seed.ts';
import {
  type AgentChannelReference,
  type ActivateChickpeaCutoverInput,
  type AgentChannelGrant,
  type AgentChannelGrantInput,
  type AgentConnectionBinding,
  type AgentConnectionBindingInput,
  type AgentOwnedConnection,
  type AgentOwnedConnectionInput,
  type AgentReferenceSummary,
  type AgentScheduleReference,
  type AgentScheduleReferenceInput,
  type AgentSlackPresence,
  type AgentThreadRoute,
  type AgentThreadRouteInput,
  type AgentCreateInput,
  type ChannelConfig,
  type ChickpeaCutoverActivation,
  type ChickpeaCutoverModelClassification,
  type ChickpeaCutoverPreflight,
  type CustomAgentConfig,
  type ConnectionAccount,
  type ConnectionAccountInput,
  type EnsureWorkspaceInstallationInput,
  type PrepareChickpeaCutoverInput,
  type RollbackChickpeaCutoverInput,
  type SlackPublicContextEntry,
  type SlackPublicContextEntryInput,
  type WorkspaceModelDefault,
  type WorkspaceModelDefaultInput,
  type WorkspaceInstallation,
  type WorkspaceInstallationPatch,
  MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY,
} from './types.ts';
import { promisify } from '../state/async-facade.ts';
import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import { addColumnIfMissing, tableExists } from '../state/schema-links.ts';
import { MemoryStoreLogic } from '../memory/store.ts';
import { normalizeAgentHandle } from '../slack/agent-presence/handles.ts';
import {
  CHICKPEA_AGENT_ID,
  reservedAgentIdentityField,
} from './agent-id.ts';

export interface ConfigSeed {
  agents: readonly AgentCreateInput[];
  grants?: readonly AgentChannelGrantInput[];
  channels?: readonly ChannelConfig[];
}

const DEFAULT_SEED: ConfigSeed = {
  agents: seededAgents,
  grants: seededAgentChannelGrants,
};

const SEED_META_KEY = 'config_seeded_v1';
const SCHEMA_VERSION_KEY = 'schema_version';
const SCHEMA_MARKER_KEY = 'schema_marker';

/**
 * Config state deliberately has no upgrade path from the pre-Agent ledger.
 * Keep both an exact version and an unambiguous marker so a legacy numeric
 * version can never be mistaken for this clean-slate schema.
 */
export const CONFIG_SCHEMA_VERSION = 12;
export const CONFIG_SCHEMA_MARKER = 'agent-first-v1';
export const CONFIG_CHICKPEA_EXTENSION_MIGRATION = '2026-08-23-chickpea-system-agent-v1';
export const CONFIG_CHICKPEA_ROUTING_MIGRATION = '2026-08-24-chickpea-routing-retry-v1';
export const CONFIG_CHICKPEA_CUTOVER_MIGRATION = '2026-08-24-chickpea-cutover-v1';
const MAX_STORED_SLACK_PUBLIC_CONTEXT_ROWS = 200;
const SLACK_PUBLIC_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60_000;

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
  description?: string | null;
  lifecycle?: string | null;
  creator_membership_id?: string | null;
  edit_policy?: string | null;
  configuration_generation?: number | null;
  slack_presence_json?: string | null;
  archived_at?: number | null;
  agent_kind?: string | null;
}

interface WorkspaceInstallationRow {
  workspace_id: string;
  revision: number;
  transport_mode: string;
  runtime_contract?: string | null;
  default_agent_id: string;
  team_id: string | null;
  app_id: string | null;
  bot_user_id: string | null;
  gateway_binding_id: string | null;
  health: string;
  health_detail: string | null;
  created_at: number;
  updated_at: number;
}

interface AgentChannelGrantRow {
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  revision: number;
  status: string;
  created_by_membership_id: string;
  channel_label: string | null;
  channel_is_private: number | null;
  created_at: number;
  updated_at: number;
}

interface AgentThreadRouteRow {
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  agent_id: string;
  agent_generation: number;
  owner_incarnation?: number | null;
  transfer_message_ts?: string | null;
  previous_agent_id?: string | null;
  handoff_context_json?: string | null;
  revision: number;
  updated_at: number;
}

interface WorkspaceModelDefaultRow {
  workspace_id: string;
  model_id: string | null;
  revision: number;
  provenance: string;
  last_changed_by_membership_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ChickpeaCutoverRow {
  workspace_id: string;
  state: string;
  model_classification: string;
  starter_agent_id: string | null;
  starter_agent_generation: number | null;
  prepared_default_revision: number;
  prepared_at: number;
  activated_at: number | null;
  rolled_back_at: number | null;
  route_backfill_count: number;
  starter_pin_cleared: number;
}

interface SlackPublicContextRow {
  workspace_id: string;
  channel_id: string;
  root_ts: string;
  message_ts: string;
  role: string;
  text: string;
  agent_id: string | null;
  updated_at: number;
}

interface ConnectionAccountRow {
  id: string;
  workspace_id: string;
  revision: number;
  owner_kind: string;
  owner_membership_id: string | null;
  created_by_membership_id: string;
  provider_id: string;
  label: string;
  purpose: string | null;
  identity_json: string | null;
  policy_json: string;
  secret_ref_id: string;
  lifecycle: string;
  created_at: number;
  updated_at: number;
}

interface AgentConnectionBindingRow {
  agent_id: string;
  connection_account_id: string;
  provider_id: string;
  allowed_capabilities_json: string;
  resource_constraints_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface AgentScheduleReferenceRow {
  schedule_id: string;
  agent_id: string;
  workspace_id: string;
  channel_id: string;
  destination_kind?: string;
  destination_binding_digest?: string | null;
  created_by_membership_id: string;
  runs_as_membership_id: string;
  authority_receipt_id: string;
  required_connection_account_ids_json: string;
  connection_pause_account_ids_json: string;
  connection_pause_preserves_state: number;
  state: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface AgentArchiveSnapshotRow {
  agent_id: string;
  channel_grants_json: string;
  paused_schedule_ids_json: string;
  created_at: number;
}

interface ChannelRow {
  workspace_id: string;
  channel_id: string;
  revision?: number;
  label: string | null;
  lifecycle: string;
}

/** PATCH shape: `model: null` clears a pinned model; omitting it keeps the pin. */
export type ConfigAgentPatch = Partial<
  Omit<CustomAgentConfig, 'id' | 'revision' | 'model'>
> & {
  model?: string | null;
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
  /** Internal inventory. User-facing callers must use listUserAgents. */
  listAgents(): Promise<CustomAgentConfig[]>;
  listUserAgents(): Promise<CustomAgentConfig[]>;
  getAgent(agentId: string): Promise<CustomAgentConfig>;
  materializeChickpeaAgent(): Promise<CustomAgentConfig>;
  createAgent(agent: AgentCreateInput): Promise<CustomAgentConfig>;
  updateAgent(agentId: string, patch: ConfigAgentPatch, expectedRevision?: number): Promise<CustomAgentConfig>;
  markOAuthReauthorizationRequired(target: OAuthReauthorizationTarget): Promise<boolean>;
  deleteAgent(agentId: string, expectedRevision?: number): Promise<boolean>;
  deleteAgentWithMemory(
    agentId: string,
    idempotencyKey: string,
  ): Promise<boolean>;
  archiveAgent(
    agentId: string,
    options?: { replacementDefaultAgentId?: string; expectedRevision?: number },
  ): Promise<CustomAgentConfig>;
  restoreAgent(agentId: string, expectedRevision?: number): Promise<CustomAgentConfig>;
  ensureWorkspaceInstallation(input: EnsureWorkspaceInstallationInput): Promise<WorkspaceInstallation>;
  getWorkspaceInstallation(workspaceId: string): Promise<WorkspaceInstallation | undefined>;
  listWorkspaceInstallations(): Promise<WorkspaceInstallation[]>;
  updateWorkspaceInstallation(
    workspaceId: string,
    patch: WorkspaceInstallationPatch,
    expectedRevision?: number,
  ): Promise<WorkspaceInstallation>;
  setWorkspaceDefaultAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision?: number,
  ): Promise<WorkspaceInstallation>;
  getWorkspaceModelDefault(workspaceId: string): Promise<WorkspaceModelDefault | undefined>;
  putWorkspaceModelDefault(
    input: WorkspaceModelDefaultInput,
    expectedRevision?: number,
  ): Promise<WorkspaceModelDefault>;
  prepareChickpeaCutover(input: PrepareChickpeaCutoverInput): Promise<ChickpeaCutoverPreflight>;
  preflightChickpeaCutover(workspaceId: string): Promise<ChickpeaCutoverPreflight>;
  activateChickpeaCutover(input: ActivateChickpeaCutoverInput): Promise<ChickpeaCutoverActivation>;
  rollbackChickpeaCutover(input: RollbackChickpeaCutoverInput): Promise<ChickpeaCutoverPreflight>;
  listAgentChannelGrants(workspaceId?: string, channelId?: string): Promise<AgentChannelGrant[]>;
  putAgentChannelGrant(
    input: AgentChannelGrantInput,
    expectedRevision?: number,
  ): Promise<AgentChannelGrant>;
  deleteAgentChannelGrant(workspaceId: string, channelId: string, agentId: string): Promise<boolean>;
  getAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<AgentThreadRoute | undefined>;
  putAgentThreadRoute(
    input: AgentThreadRouteInput,
    expectedRevision?: number,
  ): Promise<AgentThreadRoute>;
  deleteAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<boolean>;
  listSlackPublicContext(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): Promise<SlackPublicContextEntry[]>;
  putSlackPublicContext(input: SlackPublicContextEntryInput): Promise<SlackPublicContextEntry>;
  deleteSlackPublicContextMessage(
    workspaceId: string,
    channelId: string,
    rootTs: string,
    messageTs: string,
  ): Promise<boolean>;
  deleteSlackPublicContextRoot(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): Promise<number>;
  listConnectionAccounts(workspaceId: string): Promise<ConnectionAccount[]>;
  putConnectionAccount(
    input: ConnectionAccountInput,
    expectedRevision?: number,
  ): Promise<ConnectionAccount>;
  createAgentOwnedConnection(input: AgentOwnedConnectionInput): Promise<AgentOwnedConnection>;
  listAgentConnectionBindings(agentId: string): Promise<AgentConnectionBinding[]>;
  getAgentConnectionBindingForAccount(
    connectionAccountId: string,
  ): Promise<AgentConnectionBinding | undefined>;
  putAgentConnectionBinding(input: AgentConnectionBindingInput): Promise<AgentConnectionBinding>;
  listAgentScheduleReferences(agentId: string): Promise<AgentScheduleReference[]>;
  summarizeAdoptionInventory(): Promise<AdoptionInventorySummary>;
  getAgentScheduleReference(scheduleId: string): Promise<AgentScheduleReference | undefined>;
  putAgentScheduleReference(
    input: AgentScheduleReferenceInput,
    expectedRevision?: number,
  ): Promise<AgentScheduleReference>;
  retireAgentScheduleReference(scheduleId: string): Promise<boolean>;
  listChannels(): Promise<ChannelConfig[]>;
  getChannel(workspaceId: string, channelId: string): Promise<ChannelConfig | undefined>;
  putChannel(channel: ChannelConfig, expectedRevision?: number): Promise<ChannelConfig>;
  getAgentReferences(agentId: string): Promise<AgentReferenceSummary>;
  /** Node backend only (closes the SQLite handle); absent on RPC proxies. */
  close?(): void;
}

export interface AdoptionInventorySummary {
  workspaceCount: number;
  userAgentCount: number;
  readyConnectionCount: number;
  enabledScheduleCount: number;
}

/**
 * Target-neutral config store logic over the StateDb mini-interface: the
 * single source of the schema, migrations, seeding, and every query. The Node
 * backend runs it over `node:sqlite`; the Cloudflare Durable Object runs the
 * same class over `ctx.storage.sql`. Methods are synchronous — both backends
 * execute SQL synchronously — and the async public interface wraps them.
 */
export class ConfigStoreLogic {
  private readonly legacyChannelBehaviorColumns: boolean;

  constructor(
    private readonly db: StateDb,
    seed: ConfigSeed = DEFAULT_SEED,
  ) {
    this.installConfigSchema();
    this.installAgentConnectionBindingMigrations();
    this.installAgentScheduleReferenceMigrations();
    const channelTable = this.db.get(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'config_channels'",
    );
    const channelSql = String(channelTable?.sql ?? '');
    this.legacyChannelBehaviorColumns = channelSql.includes('participation_mode') &&
      channelSql.includes('additional_instructions');
    this.seedOnce(seed);
  }

  ensureWorkspaceInstallation(input: EnsureWorkspaceInstallationInput): WorkspaceInstallation {
    const existing = this.getWorkspaceInstallation(input.workspaceId);
    if (existing) return existing;
    const installed = this.listWorkspaceInstallations();
    if (installed.length > 0) {
      throw new Error(
        `This Chickpea deployment is already connected to Slack workspace ${installed[0]!.workspaceId}.`,
      );
    }
    // New installations are created on the chickpea-v1 contract: the Chickpea
    // system principal is the installation default and answers DMs and base
    // mentions until the person creates their first teammate. 'legacy' remains
    // only for compatibility installs that predate the system principal.
    const runtimeContract = input.runtimeContract ?? 'chickpea-v1';
    const now = Date.now();
    return this.db.transaction(() => {
      if (runtimeContract === 'chickpea-v1') this.materializeChickpeaAgent();
      const defaultAgentId = input.defaultAgentId ??
        (runtimeContract === 'chickpea-v1' ? CHICKPEA_AGENT_ID : this.requireFirstActiveAgent().id);
      const defaultAgent = defaultAgentId === CHICKPEA_AGENT_ID && runtimeContract === 'chickpea-v1'
        ? this.requireActiveAgent(defaultAgentId)
        : this.requireActiveUserAgent(defaultAgentId);
      const bootstrapModel = defaultAgent.model ??
        (runtimeContract === 'chickpea-v1' ? seededWorkspaceModelDefault() : undefined);
      this.db.run(
        `INSERT INTO config_workspace_installations (
          workspace_id, revision, transport_mode, runtime_contract, default_agent_id, team_id,
          app_id, bot_user_id, gateway_binding_id, health, health_detail,
          created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        input.workspaceId,
        input.transportMode,
        runtimeContract,
        defaultAgentId,
        input.teamId ?? null,
        input.appId ?? null,
        input.botUserId ?? null,
        input.gatewayBindingId ?? null,
        now,
        now,
      );
      this.insertWorkspaceModelDefault({
        workspaceId: input.workspaceId,
        ...(bootstrapModel ? { modelId: bootstrapModel } : {}),
        provenance: bootstrapModel ? 'installation_bootstrap' : 'migration_pending',
      }, now);
      this.prepareCutoverRow(input.workspaceId, now);
      if (runtimeContract === 'chickpea-v1') {
        const cleared = this.clearProvenStarterPin(input.workspaceId);
        this.db.run(
          `UPDATE config_chickpea_cutovers
           SET state = 'activated', activated_at = ?, rolled_back_at = NULL,
               starter_pin_cleared = ?
           WHERE workspace_id = ?`,
          now,
          cleared ? 1 : 0,
          input.workspaceId,
        );
      }
      return this.getWorkspaceInstallation(input.workspaceId)!;
    });
  }

  getWorkspaceInstallation(workspaceId: string): WorkspaceInstallation | undefined {
    const row = this.db.get(
      'SELECT * FROM config_workspace_installations WHERE workspace_id = ?',
      workspaceId,
    );
    return row ? rowToWorkspaceInstallation(row as unknown as WorkspaceInstallationRow) : undefined;
  }

  listWorkspaceInstallations(): WorkspaceInstallation[] {
    return this.db
      .all('SELECT * FROM config_workspace_installations ORDER BY workspace_id')
      .map((row) => rowToWorkspaceInstallation(row as unknown as WorkspaceInstallationRow));
  }

  updateWorkspaceInstallation(
    workspaceId: string,
    patch: WorkspaceInstallationPatch,
    expectedRevision?: number,
  ): WorkspaceInstallation {
    const current = this.getWorkspaceInstallation(workspaceId);
    if (!current) throw new Error(`Unknown workspace installation ${workspaceId}`);
    const requiredRevision = expectedRevision ?? current.revision;
    if (requiredRevision !== current.revision) {
      throw new Error(
        `Workspace installation ${workspaceId} changed (expected revision ${requiredRevision}, actual ${current.revision})`,
      );
    }
    const updated = this.db.run(
      `UPDATE config_workspace_installations
       SET transport_mode = ?, runtime_contract = ?, team_id = ?, app_id = ?, bot_user_id = ?,
           gateway_binding_id = ?, health = ?, health_detail = ?,
           revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND revision = ?`,
      patch.transportMode ?? current.transportMode,
      patch.runtimeContract ?? current.runtimeContract,
      patch.teamId === undefined ? current.teamId ?? null : patch.teamId,
      patch.appId === undefined ? current.appId ?? null : patch.appId,
      patch.botUserId === undefined ? current.botUserId ?? null : patch.botUserId,
      patch.gatewayBindingId === undefined
        ? current.gatewayBindingId ?? null
        : patch.gatewayBindingId,
      patch.health ?? current.health,
      patch.healthDetail === undefined ? current.healthDetail ?? null : patch.healthDetail,
      Date.now(),
      workspaceId,
      current.revision,
    );
    if (updated.changes !== 1) throw new Error(`Workspace installation ${workspaceId} changed`);
    return this.getWorkspaceInstallation(workspaceId)!;
  }

  getWorkspaceModelDefault(workspaceId: string): WorkspaceModelDefault | undefined {
    const row = this.db.get(
      'SELECT * FROM config_workspace_model_defaults WHERE workspace_id = ?',
      workspaceId,
    );
    return row
      ? rowToWorkspaceModelDefault(row as unknown as WorkspaceModelDefaultRow)
      : undefined;
  }

  putWorkspaceModelDefault(
    input: WorkspaceModelDefaultInput,
    expectedRevision?: number,
  ): WorkspaceModelDefault {
    const current = this.getWorkspaceModelDefault(input.workspaceId);
    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new WorkspaceModelDefaultRevisionConflictError(
          input.workspaceId,
          expectedRevision,
          0,
        );
      }
      this.insertWorkspaceModelDefault(input, Date.now());
      return this.getWorkspaceModelDefault(input.workspaceId)!;
    }
    const requiredRevision = expectedRevision ?? current.revision;
    if (requiredRevision !== current.revision) {
      throw new WorkspaceModelDefaultRevisionConflictError(
        input.workspaceId,
        requiredRevision,
        current.revision,
      );
    }
    const updated = this.db.run(
      `UPDATE config_workspace_model_defaults
       SET model_id = ?, provenance = ?, last_changed_by_membership_id = ?,
           revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND revision = ?`,
      input.modelId ?? null,
      input.provenance,
      input.lastChangedByMembershipId ?? null,
      Date.now(),
      input.workspaceId,
      current.revision,
    );
    if (updated.changes !== 1) {
      const actual = this.getWorkspaceModelDefault(input.workspaceId)?.revision ?? 0;
      throw new WorkspaceModelDefaultRevisionConflictError(
        input.workspaceId,
        current.revision,
        actual,
      );
    }
    return this.getWorkspaceModelDefault(input.workspaceId)!;
  }

  prepareChickpeaCutover(input: PrepareChickpeaCutoverInput): ChickpeaCutoverPreflight {
    const installation = this.getWorkspaceInstallation(input.workspaceId);
    if (!installation) throw new Error(`Unknown workspace installation ${input.workspaceId}`);
    if (!this.cutoverRow(input.workspaceId)) this.prepareCutoverRow(input.workspaceId, Date.now());
    const currentDefault = this.getWorkspaceModelDefault(input.workspaceId);
    const legacyEnvironmentModel = normalizedModelSpecifier(input.legacyEnvironmentModel);
    const cutover = this.requireCutoverRow(input.workspaceId);
    if (
      installation.runtimeContract === 'legacy' &&
      cutover.model_classification === 'model_missing' &&
      !currentDefault?.modelId &&
      legacyEnvironmentModel
    ) {
      this.db.transaction(() => {
        const at = Date.now();
        const revision = currentDefault?.revision ?? 0;
        if (currentDefault) {
          const updated = this.db.run(
            `UPDATE config_workspace_model_defaults
             SET model_id = ?, provenance = 'migrated_environment', revision = revision + 1,
                 last_changed_by_membership_id = NULL, updated_at = ?
             WHERE workspace_id = ? AND revision = ?`,
            legacyEnvironmentModel,
            at,
            input.workspaceId,
            revision,
          );
          if (updated.changes !== 1) throw new Error('Workspace default changed during cutover preparation');
        } else {
          this.insertWorkspaceModelDefault({
            workspaceId: input.workspaceId,
            modelId: legacyEnvironmentModel,
            provenance: 'migrated_environment',
          }, at);
        }
        const preparedDefault = this.getWorkspaceModelDefault(input.workspaceId)!;
        this.db.run(
          `UPDATE config_chickpea_cutovers
           SET model_classification = 'environment_default',
               prepared_default_revision = ?, prepared_at = ?
           WHERE workspace_id = ?`,
          preparedDefault.revision,
          at,
          input.workspaceId,
        );
      });
    }
    return this.preflightChickpeaCutover(input.workspaceId);
  }

  preflightChickpeaCutover(workspaceId: string): ChickpeaCutoverPreflight {
    const installation = this.getWorkspaceInstallation(workspaceId);
    if (!installation) throw new Error(`Unknown workspace installation ${workspaceId}`);
    if (!this.cutoverRow(workspaceId)) this.prepareCutoverRow(workspaceId, Date.now());
    const cutover = this.requireCutoverRow(workspaceId);
    const workspaceDefault = this.getWorkspaceModelDefault(workspaceId);
    const agents = this.listAgents();
    const userAgents = agents.filter(({ kind }) => kind === 'user');
    const systemAgents = agents.filter(({ kind }) => kind === 'system');
    const validChickpeaPrincipalCount = systemAgents.filter(
      ({ id }) => id === CHICKPEA_AGENT_ID,
    ).length;
    const collisions: ChickpeaCutoverPreflight['collisions'] = userAgents.flatMap((agent) => {
      const field = reservedAgentIdentityField({
        id: agent.id,
        name: agent.name,
        ...(agent.slackPresence
          ? { handle: agent.slackPresence.requestedHandle || agent.slackPresence.normalizedHandle }
          : {}),
      });
      return field ? [{ agentId: agent.id, field }] : [];
    });
    if (systemAgents.length !== validChickpeaPrincipalCount || validChickpeaPrincipalCount > 1) {
      for (const agent of systemAgents.filter(({ id }) => id !== CHICKPEA_AGENT_ID)) {
        collisions.push({ agentId: agent.id, field: 'system_principal' });
      }
    }
    const routeCount = Number(this.db.get(
      'SELECT COUNT(*) AS count FROM config_agent_thread_routes WHERE workspace_id = ?',
      workspaceId,
    )?.count ?? 0);
    const routeBackfillCount = Number(this.db.get(
      `SELECT COUNT(*) AS count FROM config_agent_thread_routes
       WHERE workspace_id = ? AND (owner_incarnation IS NULL OR owner_incarnation < 1)`,
      workspaceId,
    )?.count ?? 0);
    const starter = cutover.starter_agent_id
      ? userAgents.find(({ id }) => id === cutover.starter_agent_id)
      : undefined;
    const starterGeneration = Number(cutover.starter_agent_generation ?? 0);
    const starterPinClearCount = starter &&
      isSeedCloudflareModelPin(starter.model) &&
      Number(starter.configurationGeneration ?? 1) === starterGeneration
      ? 1
      : 0;
    const uncertainStarterPinCount = userAgents.some((agent) =>
      agent.id === 'agent_default' &&
      isSeedCloudflareModelPin(agent.model) &&
      !this.isUntouchedCloudflareStarter(agent)
    ) ? 1 : 0;
    const blockers: ChickpeaCutoverPreflight['blockers'] = [];
    if (!workspaceDefault?.modelId) blockers.push('workspace_default_missing');
    if (collisions.some(({ field }) => field !== 'system_principal')) {
      blockers.push('reserved_identity_collision');
    }
    const validSystemShape = systemAgents.length === validChickpeaPrincipalCount &&
      validChickpeaPrincipalCount <= 1;
    if (!validSystemShape) blockers.push('system_principal_invalid');
    return {
      workspaceId,
      state: cutoverState(cutover.state),
      runtimeContract: installation.runtimeContract,
      installationRevision: installation.revision,
      ...(workspaceDefault?.modelId ? { defaultModelId: workspaceDefault.modelId } : {}),
      defaultRevision: workspaceDefault?.revision ?? 0,
      defaultProvenance: workspaceDefault?.provenance ?? 'migration_pending',
      modelClassification: cutoverClassification(cutover.model_classification),
      systemPrincipalCount: systemAgents.length,
      validChickpeaPrincipalCount,
      routeCount,
      routeBackfillCount,
      pinnedAgentCount: userAgents.filter(({ model }) => Boolean(model)).length - starterPinClearCount,
      inheritingAgentCount: userAgents.filter(({ model }) => !model).length + starterPinClearCount,
      starterPinClearCount,
      uncertainStarterPinCount,
      collisions,
      blockers,
    };
  }

  activateChickpeaCutover(input: ActivateChickpeaCutoverInput): ChickpeaCutoverActivation {
    const current = this.getWorkspaceInstallation(input.workspaceId);
    if (!current) throw new Error(`Unknown workspace installation ${input.workspaceId}`);
    const existingCutover = this.cutoverRow(input.workspaceId);
    if (current.runtimeContract === 'chickpea-v1' && existingCutover?.activated_at) {
      return this.cutoverActivation(input.workspaceId, existingCutover);
    }
    const preflight = this.preflightChickpeaCutover(input.workspaceId);
    if (current.revision !== input.expectedInstallationRevision) {
      throw new Error(
        `Workspace installation ${input.workspaceId} changed (expected revision ${input.expectedInstallationRevision}, actual ${current.revision})`,
      );
    }
    if (preflight.defaultRevision !== input.expectedDefaultRevision) {
      throw new WorkspaceModelDefaultRevisionConflictError(
        input.workspaceId,
        input.expectedDefaultRevision,
        preflight.defaultRevision,
      );
    }
    if (!input.defaultReady || preflight.blockers.length > 0) {
      throw new Error(`Chickpea cutover preflight failed: ${[
        ...preflight.blockers,
        ...(!input.defaultReady ? ['workspace_default_not_ready'] : []),
      ].join(', ')}`);
    }
    return this.db.transaction(() => {
      const installation = this.getWorkspaceInstallation(input.workspaceId)!;
      const workspaceDefault = this.getWorkspaceModelDefault(input.workspaceId);
      if (installation.revision !== input.expectedInstallationRevision) {
        throw new Error(`Workspace installation ${input.workspaceId} changed during activation`);
      }
      if (workspaceDefault?.revision !== input.expectedDefaultRevision) {
        throw new WorkspaceModelDefaultRevisionConflictError(
          input.workspaceId,
          input.expectedDefaultRevision,
          workspaceDefault?.revision ?? 0,
        );
      }
      this.materializeChickpeaAgent();
      const routeBackfillCount = this.db.run(
        `UPDATE config_agent_thread_routes SET owner_incarnation = 1
         WHERE workspace_id = ? AND (owner_incarnation IS NULL OR owner_incarnation < 1)`,
        input.workspaceId,
      ).changes;
      const starterPinCleared = this.clearProvenStarterPin(input.workspaceId);
      const updated = this.db.run(
        `UPDATE config_workspace_installations
         SET runtime_contract = 'chickpea-v1', revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND revision = ? AND runtime_contract = 'legacy'`,
        Date.now(),
        input.workspaceId,
        input.expectedInstallationRevision,
      );
      if (updated.changes !== 1) throw new Error('Workspace contract changed during activation');
      const activatedAt = Date.now();
      this.db.run(
        `UPDATE config_chickpea_cutovers
         SET state = 'activated', activated_at = ?, rolled_back_at = NULL,
             route_backfill_count = ?, starter_pin_cleared = ?
         WHERE workspace_id = ?`,
        activatedAt,
        routeBackfillCount,
        starterPinCleared ? 1 : 0,
        input.workspaceId,
      );
      return this.cutoverActivation(input.workspaceId, this.requireCutoverRow(input.workspaceId));
    });
  }

  rollbackChickpeaCutover(input: RollbackChickpeaCutoverInput): ChickpeaCutoverPreflight {
    const current = this.getWorkspaceInstallation(input.workspaceId);
    if (!current) throw new Error(`Unknown workspace installation ${input.workspaceId}`);
    if (current.runtimeContract === 'legacy') return this.preflightChickpeaCutover(input.workspaceId);
    if (current.revision !== input.expectedInstallationRevision) {
      throw new Error(
        `Workspace installation ${input.workspaceId} changed (expected revision ${input.expectedInstallationRevision}, actual ${current.revision})`,
      );
    }
    this.db.transaction(() => {
      const restoredStarterPin = this.restoreCutoverStarterPin(input.workspaceId);
      const updated = this.db.run(
        `UPDATE config_workspace_installations
         SET runtime_contract = 'legacy', revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND revision = ? AND runtime_contract = 'chickpea-v1'`,
        Date.now(),
        input.workspaceId,
        input.expectedInstallationRevision,
      );
      if (updated.changes !== 1) throw new Error('Workspace contract changed during rollback');
      this.db.run(
        `UPDATE config_chickpea_cutovers
         SET state = 'rolled_back', rolled_back_at = ?,
             starter_pin_cleared = CASE WHEN ? = 1 THEN 0 ELSE starter_pin_cleared END
         WHERE workspace_id = ?`,
        Date.now(),
        restoredStarterPin ? 1 : 0,
        input.workspaceId,
      );
    });
    return this.preflightChickpeaCutover(input.workspaceId);
  }

  setWorkspaceDefaultAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision?: number,
  ): WorkspaceInstallation {
    const current = this.getWorkspaceInstallation(workspaceId);
    if (!current) throw new Error(`Unknown workspace installation ${workspaceId}`);
    this.requireActiveUserAgent(agentId);
    const requiredRevision = expectedRevision ?? current.revision;
    if (requiredRevision !== current.revision) {
      throw new Error(
        `Workspace installation ${workspaceId} changed (expected revision ${requiredRevision}, actual ${current.revision})`,
      );
    }
    const updated = this.db.run(
      `UPDATE config_workspace_installations
       SET default_agent_id = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND revision = ?`,
      agentId,
      Date.now(),
      workspaceId,
      current.revision,
    );
    if (updated.changes !== 1) throw new Error(`Workspace installation ${workspaceId} changed`);
    return this.getWorkspaceInstallation(workspaceId)!;
  }

  archiveAgent(
    agentId: string,
    options: { replacementDefaultAgentId?: string; expectedRevision?: number } = {},
  ): CustomAgentConfig {
    const current = this.getAgent(agentId);
    this.requireMutableUserAgent(current);
    // Archive is an idempotent desired-state operation. In particular, never
    // replace the original snapshot with an empty one on a delivery retry.
    if (current.lifecycle === 'archived') return current;
    const requiredRevision = options.expectedRevision ?? current.revision;
    if (requiredRevision !== current.revision) {
      throw new AgentRevisionConflictError(agentId, requiredRevision, current.revision);
    }
    const installations = this.listWorkspaceInstallations().filter(
      (installation) => installation.defaultAgentId === agentId,
    );
    if (installations.length > 0 && !options.replacementDefaultAgentId) {
      throw new Error(`Archiving ${agentId} requires a replacement default Agent`);
    }
    if (options.replacementDefaultAgentId) {
      this.requireActiveUserAgent(options.replacementDefaultAgentId);
    }
    return this.db.transaction(() => {
      for (const installation of installations) {
        this.setWorkspaceDefaultAgent(
          installation.workspaceId,
          options.replacementDefaultAgentId!,
          installation.revision,
        );
      }
      const now = Date.now();
      const channelGrants = this.db.all(
        `SELECT * FROM config_agent_channel_grants
         WHERE agent_id = ?
         ORDER BY workspace_id, channel_id, agent_id`,
        agentId,
      ) as unknown as AgentChannelGrantRow[];
      const pausedScheduleIds = this.db
        .all(
          `SELECT schedule_id FROM config_agent_schedule_references
           WHERE agent_id = ? AND (
             state = 'active' OR (
               state = 'needs_attention' AND connection_pause_account_ids_json <> '[]' AND
               connection_pause_preserves_state = 0
             )
           )
           ORDER BY schedule_id`,
          agentId,
        )
        .map((row) => String(row.schedule_id));
      this.db.run(
        `INSERT INTO config_agent_archive_snapshots (
          agent_id, channel_grants_json, paused_schedule_ids_json, created_at
        ) VALUES (?, ?, ?, ?)`,
        agentId,
        JSON.stringify(channelGrants),
        JSON.stringify(pausedScheduleIds),
        now,
      );
      const updated = this.db.run(
        `UPDATE config_agents
         SET lifecycle = 'archived', enabled = 0, archived_at = ?,
             configuration_generation = configuration_generation + 1,
             revision = revision + 1
         WHERE id = ? AND revision = ?`,
        now,
        agentId,
        current.revision,
      );
      if (updated.changes !== 1) {
        throw new AgentRevisionConflictError(agentId, current.revision, this.getAgent(agentId).revision);
      }
      this.db.run('DELETE FROM config_agent_channel_grants WHERE agent_id = ?', agentId);
      this.db.run(
        `UPDATE config_agent_schedule_references
         SET state = 'paused', revision = revision + 1, updated_at = ?
         WHERE agent_id = ? AND (
           state = 'active' OR (
             state = 'needs_attention' AND connection_pause_account_ids_json <> '[]' AND
             connection_pause_preserves_state = 0
           )
         )`,
        now,
        agentId,
      );
      return this.getAgent(agentId);
    });
  }

  restoreAgent(agentId: string, expectedRevision?: number): CustomAgentConfig {
    const current = this.getAgent(agentId);
    this.requireMutableUserAgent(current);
    // Restoring an already-active Agent is also idempotent and must not bump
    // its configuration generation on a retry.
    if (current.lifecycle !== 'archived') return current;
    const requiredRevision = expectedRevision ?? current.revision;
    if (requiredRevision !== current.revision) {
      throw new AgentRevisionConflictError(agentId, requiredRevision, current.revision);
    }
    return this.db.transaction(() => {
      const snapshot = this.db.get(
        'SELECT * FROM config_agent_archive_snapshots WHERE agent_id = ?',
        agentId,
      ) as unknown as AgentArchiveSnapshotRow | undefined;
      if (!snapshot) {
        throw new Error(
          `Agent ${agentId} has no archive snapshot; use a fresh Agent-first deployment`,
        );
      }
      const channelGrants = parseArchiveChannelGrants(snapshot.channel_grants_json, agentId);
      const pausedScheduleIds = parseArchiveScheduleIds(snapshot.paused_schedule_ids_json, agentId);
      const updated = this.db.run(
        `UPDATE config_agents
         SET lifecycle = 'active', enabled = 1, archived_at = NULL,
             configuration_generation = configuration_generation + 1,
             revision = revision + 1
         WHERE id = ? AND revision = ?`,
        agentId,
        current.revision,
      );
      if (updated.changes !== 1) throw new Error(`Agent ${agentId} changed`);
      for (const grant of channelGrants) {
        this.db.run(
          `INSERT INTO config_agent_channel_grants (
            workspace_id, channel_id, agent_id, revision, status,
            created_by_membership_id, channel_label, channel_is_private,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          grant.workspace_id,
          grant.channel_id,
          grant.agent_id,
          grant.revision,
          grant.status,
          grant.created_by_membership_id,
          grant.channel_label,
          grant.channel_is_private,
          grant.created_at,
          grant.updated_at,
        );
      }
      const now = Date.now();
      for (const scheduleId of pausedScheduleIds) {
        this.db.run(
          `UPDATE config_agent_schedule_references
           SET state = CASE
                 WHEN connection_pause_account_ids_json = '[]' THEN 'active'
                 ELSE 'needs_attention'
               END,
               revision = revision + 1, updated_at = ?
           WHERE schedule_id = ? AND agent_id = ? AND state = 'paused'`,
          now,
          scheduleId,
          agentId,
        );
      }
      this.db.run('DELETE FROM config_agent_archive_snapshots WHERE agent_id = ?', agentId);
      return this.getAgent(agentId);
    });
  }

  listAgentChannelGrants(workspaceId?: string, channelId?: string): AgentChannelGrant[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(workspaceId);
    }
    if (channelId) {
      clauses.push('channel_id = ?');
      params.push(channelId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .all(
        `SELECT * FROM config_agent_channel_grants${where}
         ORDER BY workspace_id, channel_id, agent_id`,
        ...params,
      )
      .map((row) => rowToAgentChannelGrant(row as unknown as AgentChannelGrantRow));
  }

  putAgentChannelGrant(
    input: AgentChannelGrantInput,
    expectedRevision?: number,
  ): AgentChannelGrant {
    if (input.status === 'pending') {
      const agent = this.getAgent(input.agentId);
      this.requireMutableUserAgent(agent);
      if (agent.lifecycle === 'archived') {
        throw new Error(`Agent ${input.agentId} is not active`);
      }
    } else {
      this.requireActiveUserAgent(input.agentId);
    }
    const current = this.db.get(
      `SELECT * FROM config_agent_channel_grants
       WHERE workspace_id = ? AND channel_id = ? AND agent_id = ?`,
      input.workspaceId,
      input.channelId,
      input.agentId,
    ) as unknown as AgentChannelGrantRow | undefined;
    const now = Date.now();
    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new Error(`Agent Channel grant changed (expected revision ${expectedRevision}, actual 0)`);
      }
      this.db.run(
        `INSERT INTO config_agent_channel_grants (
          workspace_id, channel_id, agent_id, revision, status,
          created_by_membership_id, channel_label, channel_is_private,
          created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        input.workspaceId,
        input.channelId,
        input.agentId,
        input.status,
        input.createdByMembershipId,
        input.channelLabel ?? null,
        input.channelIsPrivate === undefined ? null : input.channelIsPrivate ? 1 : 0,
        now,
        now,
      );
    } else {
      const requiredRevision = expectedRevision ?? Number(current.revision);
      if (requiredRevision !== Number(current.revision)) {
        throw new Error(
          `Agent Channel grant changed (expected revision ${requiredRevision}, actual ${current.revision})`,
        );
      }
      this.db.run(
        `UPDATE config_agent_channel_grants
         SET status = ?, created_by_membership_id = ?, channel_label = ?,
             channel_is_private = ?, revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND channel_id = ? AND agent_id = ? AND revision = ?`,
        input.status,
        input.createdByMembershipId,
        input.channelLabel ?? null,
        input.channelIsPrivate === undefined ? null : input.channelIsPrivate ? 1 : 0,
        now,
        input.workspaceId,
        input.channelId,
        input.agentId,
        current.revision,
      );
    }
    return this.listAgentChannelGrants(input.workspaceId, input.channelId).find(
      (grant) => grant.agentId === input.agentId,
    )!;
  }

  deleteAgentChannelGrant(workspaceId: string, channelId: string, agentId: string): boolean {
    return this.db.run(
      `DELETE FROM config_agent_channel_grants
       WHERE workspace_id = ? AND channel_id = ? AND agent_id = ?`,
      workspaceId,
      channelId,
      agentId,
    ).changes === 1;
  }

  getAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): AgentThreadRoute | undefined {
    const row = this.db.get(
      `SELECT * FROM config_agent_thread_routes
       WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?`,
      workspaceId,
      channelId,
      threadTs,
    );
    return row ? rowToAgentThreadRoute(row as unknown as AgentThreadRouteRow) : undefined;
  }

  putAgentThreadRoute(input: AgentThreadRouteInput, expectedRevision?: number): AgentThreadRoute {
    this.requireActiveAgent(input.agentId);
    const current = this.getAgentThreadRoute(input.workspaceId, input.channelId, input.threadTs);
    const now = Date.now();
    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new Error(`Agent thread route changed (expected revision ${expectedRevision}, actual 0)`);
      }
      this.db.run(
        `INSERT INTO config_agent_thread_routes (
          workspace_id, channel_id, thread_ts, agent_id, agent_generation,
          owner_incarnation, transfer_message_ts, previous_agent_id,
          handoff_context_json, revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        input.workspaceId,
        input.channelId,
        input.threadTs,
        input.agentId,
        input.agentGeneration,
        input.ownerIncarnation ?? 1,
        input.handoff?.transferMessageTs ?? null,
        input.handoff?.previousAgentId ?? null,
        input.handoff?.context === undefined ? null : JSON.stringify(input.handoff.context),
        now,
      );
    } else {
      const requiredRevision = expectedRevision ?? current.revision;
      if (requiredRevision !== current.revision) {
        throw new Error(
          `Agent thread route changed (expected revision ${requiredRevision}, actual ${current.revision})`,
        );
      }
      const updated = this.db.run(
        `UPDATE config_agent_thread_routes
         SET agent_id = ?, agent_generation = ?, owner_incarnation = ?,
             transfer_message_ts = ?, previous_agent_id = ?, handoff_context_json = ?,
             revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND revision = ?`,
        input.agentId,
        input.agentGeneration,
        input.ownerIncarnation ?? current.ownerIncarnation,
        input.handoff?.transferMessageTs ?? current.handoff?.transferMessageTs ?? null,
        input.handoff?.previousAgentId ?? current.handoff?.previousAgentId ?? null,
        input.handoff?.context !== undefined
          ? JSON.stringify(input.handoff.context)
          : current.handoff
            ? current.handoff.context === undefined
              ? null
              : JSON.stringify(current.handoff.context)
            : null,
        now,
        input.workspaceId,
        input.channelId,
        input.threadTs,
        current.revision,
      );
      if (updated.changes !== 1) throw new Error('Agent thread route changed');
    }
    return this.getAgentThreadRoute(input.workspaceId, input.channelId, input.threadTs)!;
  }

  deleteAgentThreadRoute(workspaceId: string, channelId: string, threadTs: string): boolean {
    return this.db.transaction(() => {
      this.deleteSlackPublicContextRoot(workspaceId, channelId, threadTs);
      return this.db.run(
        `DELETE FROM config_agent_thread_routes
         WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?`,
        workspaceId,
        channelId,
        threadTs,
      ).changes === 1;
    });
  }

  listSlackPublicContext(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): SlackPublicContextEntry[] {
    this.pruneExpiredSlackPublicContext(Date.now());
    return this.db.all(
      `SELECT * FROM config_slack_public_context
       WHERE workspace_id = ? AND channel_id = ? AND root_ts = ?
       ORDER BY CAST(message_ts AS REAL), message_ts`,
      workspaceId,
      channelId,
      rootTs,
    ).map((row) => rowToSlackPublicContext(row as unknown as SlackPublicContextRow));
  }

  putSlackPublicContext(input: SlackPublicContextEntryInput): SlackPublicContextEntry {
    if (!input.text.trim()) throw new Error('Slack public context text is required');
    if ((input.role === 'agent') !== Boolean(input.agentId)) {
      throw new Error('Slack public Agent context requires exactly one Agent identity');
    }
    if (input.agentId) this.getAgent(input.agentId);
    const now = Date.now();
    this.db.run(
      `INSERT INTO config_slack_public_context (
        workspace_id, channel_id, root_ts, message_ts, role, text, agent_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id, root_ts, message_ts) DO UPDATE SET
        role = excluded.role,
        text = excluded.text,
        agent_id = excluded.agent_id,
        updated_at = excluded.updated_at`,
      input.workspaceId,
      input.channelId,
      input.rootTs,
      input.messageTs,
      input.role,
      input.text,
      input.agentId ?? null,
      now,
    );
    // Retention is root-scoped: one recent message keeps the bounded public
    // handoff ledger for that root intact, while a root with no activity for
    // 30 days is removed as a unit. The write above makes the current root
    // active before this opportunistic sweep runs.
    this.pruneExpiredSlackPublicContext(now);
    this.db.run(
      `DELETE FROM config_slack_public_context
       WHERE workspace_id = ? AND channel_id = ? AND root_ts = ?
         AND message_ts NOT IN (
           SELECT message_ts FROM config_slack_public_context
           WHERE workspace_id = ? AND channel_id = ? AND root_ts = ?
           ORDER BY CAST(message_ts AS REAL) DESC, message_ts DESC
           LIMIT ?
         )`,
      input.workspaceId,
      input.channelId,
      input.rootTs,
      input.workspaceId,
      input.channelId,
      input.rootTs,
      MAX_STORED_SLACK_PUBLIC_CONTEXT_ROWS,
    );
    const stored = this.db.get(
      `SELECT * FROM config_slack_public_context
       WHERE workspace_id = ? AND channel_id = ? AND root_ts = ? AND message_ts = ?`,
      input.workspaceId,
      input.channelId,
      input.rootTs,
      input.messageTs,
    );
    if (!stored) throw new Error('Slack public context was not stored');
    return rowToSlackPublicContext(stored as unknown as SlackPublicContextRow);
  }

  private pruneExpiredSlackPublicContext(now: number): void {
    this.db.run(
      `DELETE FROM config_slack_public_context
       WHERE (workspace_id, channel_id, root_ts) IN (
         SELECT workspace_id, channel_id, root_ts
         FROM config_slack_public_context
         GROUP BY workspace_id, channel_id, root_ts
         HAVING MAX(updated_at) < ?
       )`,
      now - SLACK_PUBLIC_CONTEXT_RETENTION_MS,
    );
  }

  deleteSlackPublicContextMessage(
    workspaceId: string,
    channelId: string,
    rootTs: string,
    messageTs: string,
  ): boolean {
    return this.db.run(
      `DELETE FROM config_slack_public_context
       WHERE workspace_id = ? AND channel_id = ? AND root_ts = ? AND message_ts = ?`,
      workspaceId,
      channelId,
      rootTs,
      messageTs,
    ).changes === 1;
  }

  deleteSlackPublicContextRoot(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): number {
    return this.db.run(
      `DELETE FROM config_slack_public_context
       WHERE workspace_id = ? AND channel_id = ? AND root_ts = ?`,
      workspaceId,
      channelId,
      rootTs,
    ).changes;
  }

  listConnectionAccounts(workspaceId: string): ConnectionAccount[] {
    return this.db
      .all('SELECT * FROM config_connection_accounts WHERE workspace_id = ? ORDER BY id', workspaceId)
      .map((row) => rowToConnectionAccount(row as unknown as ConnectionAccountRow));
  }

  putConnectionAccount(
    input: ConnectionAccountInput,
    expectedRevision?: number,
  ): ConnectionAccount {
    validateConnectionAccountInput(input);
    if (input.policy.kind === 'managed' && input.lifecycle !== 'revoked') {
      const adapterId = input.policy.adapterId.trim().toLowerCase();
      const duplicate = this.db.get(
        `SELECT id FROM config_connection_accounts
         WHERE id <> ?
           AND lifecycle <> 'revoked'
           AND json_extract(policy_json, '$.kind') = 'managed'
           AND lower(trim(json_extract(policy_json, '$.adapterId'))) = ?
           AND json_extract(policy_json, '$.accountRef') = ?
         LIMIT 1`,
        input.id,
        adapterId,
        input.policy.accountRef,
      );
      if (duplicate) {
        throw new ManagedRemoteAccountAlreadyUsedError(adapterId, input.policy.accountRef);
      }
    }
    const current = this.db.get(
      'SELECT * FROM config_connection_accounts WHERE id = ?',
      input.id,
    ) as unknown as ConnectionAccountRow | undefined;
    const now = Date.now();
    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new ConnectionAccountRevisionConflictError(input.id, expectedRevision, 0);
      }
      this.db.run(
        `INSERT INTO config_connection_accounts (
          id, workspace_id, revision, owner_kind, owner_membership_id, created_by_membership_id,
          provider_id, label, purpose, identity_json, policy_json, secret_ref_id, lifecycle,
          created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.workspaceId,
        input.ownerKind,
        input.ownerMembershipId ?? null,
        input.createdByMembershipId,
        input.providerId,
        input.label,
        input.purpose ?? null,
        input.identity ? JSON.stringify(input.identity) : null,
        JSON.stringify(input.policy),
        input.secretRefId,
        input.lifecycle,
        now,
        now,
      );
    } else {
      if (
        current.workspace_id !== input.workspaceId ||
        current.owner_kind !== input.ownerKind ||
        (current.owner_membership_id ?? undefined) !== input.ownerMembershipId ||
        current.created_by_membership_id !== input.createdByMembershipId ||
        current.provider_id !== input.providerId ||
        current.secret_ref_id !== input.secretRefId
      ) {
        throw new Error('Connection account ownership and secret reference are immutable');
      }
      const requiredRevision = expectedRevision ?? Number(current.revision);
      if (requiredRevision !== Number(current.revision)) {
        throw new ConnectionAccountRevisionConflictError(
          input.id,
          requiredRevision,
          Number(current.revision),
        );
      }
      this.db.run(
        `UPDATE config_connection_accounts
         SET label = ?, purpose = ?, identity_json = ?, policy_json = ?, lifecycle = ?,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        input.label,
        input.purpose ?? null,
        input.identity ? JSON.stringify(input.identity) : null,
        JSON.stringify(input.policy),
        input.lifecycle,
        now,
        input.id,
        current.revision,
      );
    }
    return this.listConnectionAccounts(input.workspaceId).find((account) => account.id === input.id)!;
  }

  createAgentOwnedConnection(input: AgentOwnedConnectionInput): AgentOwnedConnection {
    if (
      input.binding.connectionAccountId !== input.account.id ||
      input.binding.providerId !== input.account.providerId
    ) {
      throw new Error('Connection account and initial binding identity must match');
    }
    return this.db.transaction(() => {
      const account = this.putConnectionAccount(input.account, 0);
      const binding = this.putAgentConnectionBindingRow(input.binding);
      return { account, binding };
    });
  }

  listAgentConnectionBindings(agentId: string): AgentConnectionBinding[] {
    return this.db
      .all('SELECT * FROM config_agent_connection_bindings WHERE agent_id = ? ORDER BY connection_account_id', agentId)
      .map((row) => rowToAgentConnectionBinding(row as unknown as AgentConnectionBindingRow));
  }

  getAgentConnectionBindingForAccount(
    connectionAccountId: string,
  ): AgentConnectionBinding | undefined {
    const row = this.db.get(
      'SELECT * FROM config_agent_connection_bindings WHERE connection_account_id = ?',
      connectionAccountId,
    ) as unknown as AgentConnectionBindingRow | undefined;
    return row ? rowToAgentConnectionBinding(row) : undefined;
  }

  putAgentConnectionBinding(input: AgentConnectionBindingInput): AgentConnectionBinding {
    return this.db.transaction(() => this.putAgentConnectionBindingRow(input));
  }

  private putAgentConnectionBindingRow(input: AgentConnectionBindingInput): AgentConnectionBinding {
    this.requireActiveUserAgent(input.agentId);
    const account = this.db.get(
      'SELECT provider_id, workspace_id FROM config_connection_accounts WHERE id = ?',
      input.connectionAccountId,
    );
    if (!account) throw new Error(`Unknown connection account ${input.connectionAccountId}`);
    if (String(account.provider_id) !== input.providerId) {
      throw new Error(`Connection account ${input.connectionAccountId} does not use ${input.providerId}`);
    }
    const installation = this.listWorkspaceInstallations()[0];
    if (installation && installation.workspaceId !== String(account.workspace_id)) {
      throw new Error(
        `Connection account ${input.connectionAccountId} belongs to workspace ` +
        `${String(account.workspace_id)}, not ${installation.workspaceId}`,
      );
    }
    const existing = this.getAgentConnectionBindingForAccount(input.connectionAccountId);
    if (existing && existing.agentId !== input.agentId) {
      throw new ConnectionAccountAlreadyBoundError(input.connectionAccountId, existing.agentId);
    }
    const now = Date.now();
    const resourceConstraints = normalizeBindingResourceConstraints(input.resourceConstraints);
    try {
      this.db.run(
        `INSERT INTO config_agent_connection_bindings (
          agent_id, connection_account_id, provider_id, allowed_capabilities_json,
          resource_constraints_json, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, connection_account_id) DO UPDATE SET
          provider_id = excluded.provider_id,
          allowed_capabilities_json = excluded.allowed_capabilities_json,
          resource_constraints_json = excluded.resource_constraints_json,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at`,
        input.agentId,
        input.connectionAccountId,
        input.providerId,
        JSON.stringify([...new Set(input.allowedCapabilities)]),
        JSON.stringify(resourceConstraints),
        input.enabled ? 1 : 0,
        now,
        now,
      );
    } catch (error) {
      const winner = this.getAgentConnectionBindingForAccount(input.connectionAccountId);
      if (winner && winner.agentId !== input.agentId) {
        throw new ConnectionAccountAlreadyBoundError(input.connectionAccountId, winner.agentId);
      }
      throw error;
    }
    return this.getAgentConnectionBindingForAccount(input.connectionAccountId)!;
  }

  listAgentScheduleReferences(agentId: string): AgentScheduleReference[] {
    return this.db
      .all('SELECT * FROM config_agent_schedule_references WHERE agent_id = ? ORDER BY schedule_id', agentId)
      .map((row) => rowToAgentScheduleReference(row as unknown as AgentScheduleReferenceRow));
  }

  getAgentScheduleReference(scheduleId: string): AgentScheduleReference | undefined {
    const row = this.db.get(
      'SELECT * FROM config_agent_schedule_references WHERE schedule_id = ?',
      scheduleId,
    ) as unknown as AgentScheduleReferenceRow | undefined;
    return row ? rowToAgentScheduleReference(row) : undefined;
  }

  putAgentScheduleReference(
    input: AgentScheduleReferenceInput,
    expectedRevision?: number,
  ): AgentScheduleReference {
    const destination = normalizeScheduleReferenceDestination(input);
    const current = this.db.get(
      'SELECT * FROM config_agent_schedule_references WHERE schedule_id = ?',
      input.scheduleId,
    ) as unknown as AgentScheduleReferenceRow | undefined;
    if (current && String(current.agent_id) === input.agentId) {
      // Provider reconciliation and other lifecycle maintenance must be able to
      // update an existing schedule while its user Agent is archived. Creating
      // or moving a schedule still requires an active user-configured Agent,
      // and the product-owned Chickpea Agent can never own scheduled work.
      this.requireMutableUserAgent(this.getAgent(input.agentId));
    } else {
      this.requireActiveUserAgent(input.agentId);
    }
    const now = Date.now();
    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new Error(`Agent schedule reference changed (expected revision ${expectedRevision}, actual 0)`);
      }
      this.db.run(
        `INSERT INTO config_agent_schedule_references (
          schedule_id, agent_id, workspace_id, channel_id, destination_kind,
          destination_binding_digest, created_by_membership_id,
          runs_as_membership_id, authority_receipt_id,
          required_connection_account_ids_json, connection_pause_account_ids_json,
          connection_pause_preserves_state, state, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        input.scheduleId,
        input.agentId,
        input.workspaceId,
        input.channelId,
        destination.kind,
        destination.bindingDigest,
        input.createdByMembershipId,
        input.runsAsMembershipId,
        input.authorityReceiptId,
        JSON.stringify(input.requiredConnectionAccountIds),
        JSON.stringify(input.connectionPauseAccountIds ?? []),
        input.connectionPausePreservesState ? 1 : 0,
        input.state,
        now,
        now,
      );
    } else {
      const requiredRevision = expectedRevision ?? Number(current.revision);
      if (requiredRevision !== Number(current.revision)) {
        throw new Error(
          `Agent schedule reference changed (expected revision ${requiredRevision}, actual ${current.revision})`,
        );
      }
      if (input.createdByMembershipId !== current.created_by_membership_id) {
        throw new Error('A schedule creator is immutable');
      }
      if (
        (input.runsAsMembershipId !== current.runs_as_membership_id ||
          input.agentId !== current.agent_id) &&
        input.authorityReceiptId === current.authority_receipt_id
      ) {
        throw new Error('Schedule authority reassignment requires a new receipt');
      }
      if (
        destination.kind !== (current.destination_kind ?? 'channel') ||
        destination.bindingDigest !== (current.destination_binding_digest ?? null)
      ) {
        throw new Error('A schedule destination binding is immutable');
      }
      if (
        destination.kind === 'direct_thread' &&
        (input.workspaceId !== current.workspace_id || input.channelId !== current.channel_id)
      ) {
        throw new Error('A direct schedule destination is immutable');
      }
      this.db.run(
        `UPDATE config_agent_schedule_references
         SET agent_id = ?, workspace_id = ?, channel_id = ?, destination_kind = ?,
             destination_binding_digest = ?, created_by_membership_id = ?,
             runs_as_membership_id = ?, authority_receipt_id = ?,
             required_connection_account_ids_json = ?, connection_pause_account_ids_json = ?,
             connection_pause_preserves_state = ?, state = ?,
             revision = revision + 1, updated_at = ?
         WHERE schedule_id = ? AND revision = ?`,
        input.agentId,
        input.workspaceId,
        input.channelId,
        destination.kind,
        destination.bindingDigest,
        input.createdByMembershipId,
        input.runsAsMembershipId,
        input.authorityReceiptId,
        JSON.stringify(input.requiredConnectionAccountIds),
        JSON.stringify(input.connectionPauseAccountIds ?? []),
        input.connectionPausePreservesState ? 1 : 0,
        input.state,
        now,
        input.scheduleId,
        current.revision,
      );
    }
    return this.listAgentScheduleReferences(input.agentId).find(
      (reference) => reference.scheduleId === input.scheduleId,
    )!;
  }

  retireAgentScheduleReference(scheduleId: string): boolean {
    const result = this.db.run(
      `UPDATE config_agent_schedule_references
       SET state = 'archived', revision = revision + 1, updated_at = ?
       WHERE schedule_id = ? AND state <> 'archived'`,
      Date.now(),
      scheduleId,
    );
    return result.changes === 1;
  }

  listAgents(): CustomAgentConfig[] {
    return this.db
      .all('SELECT * FROM config_agents ORDER BY id')
      .map((row) => rowToAgent(row as unknown as AgentRow));
  }

  listUserAgents(): CustomAgentConfig[] {
    return this.db
      .all("SELECT * FROM config_agents WHERE agent_kind = 'user' ORDER BY id")
      .map((row) => rowToAgent(row as unknown as AgentRow));
  }

  summarizeAdoptionInventory(): AdoptionInventorySummary {
    const workspaces = this.listWorkspaceInstallations()
      .filter(({ health }) => health !== 'revoked');
    const agents = this.listUserAgents();
    return {
      workspaceCount: workspaces.length,
      userAgentCount: agents.length,
      readyConnectionCount: workspaces.flatMap(({ workspaceId }) =>
        this.listConnectionAccounts(workspaceId)
      ).filter(({ lifecycle }) => lifecycle === 'ready').length,
      enabledScheduleCount: agents.flatMap(({ id }) =>
        this.listAgentScheduleReferences(id)
      ).filter(({ state }) => state === 'active').length,
    };
  }

  getAgent(agentId: string): CustomAgentConfig {
    const row = this.db.get('SELECT * FROM config_agents WHERE id = ?', agentId);
    if (!row) {
      throw new UnknownAgentError(agentId);
    }
    return rowToAgent(row as unknown as AgentRow);
  }

  materializeChickpeaAgent(): CustomAgentConfig {
    const existing = this.db.get('SELECT * FROM config_agents WHERE id = ?', CHICKPEA_AGENT_ID);
    if (existing) {
      const agent = rowToAgent(existing as unknown as AgentRow);
      if (agent.kind !== 'system') {
        throw new Error('The Chickpea system identity is already claimed by a user Agent');
      }
      return agent;
    }
    const chickpea = createChickpeaAgent();
    const inserted = this.insertAgent(chickpea, { allowSystem: true });
    if (inserted.changes !== 1) throw new Error('Chickpea was not materialized');
    return this.getAgent(CHICKPEA_AGENT_ID);
  }

  createAgent(agent: AgentCreateInput): CustomAgentConfig {
    validateUserAgent(agent);
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
    this.requireMutableUserAgent(current);
    const actualRevision = current.revision;
    const requiredRevision = expectedRevision ?? actualRevision;
    if (requiredRevision !== actualRevision) {
      throw new AgentRevisionConflictError(agentId, requiredRevision, actualRevision);
    }
    const model = patch.model === undefined ? (current.model ?? null) : patch.model;
    const next = { ...current, ...patch, id: agentId };
    validateUserAgent(next);
    if (current.enabled && !next.enabled) {
      this.requireAgentHasNoBlockingReferences(agentId);
    }
    this.db.run(
      `UPDATE config_agents
       SET name = ?, description = ?, instructions = ?, enabled = ?, lifecycle = ?,
           creator_membership_id = ?, edit_policy = ?,
           configuration_generation = ?, slack_presence_json = ?, archived_at = ?, model = ?,
           skills_json = ?, mcp_servers_json = ?, api_connections_json = ?, repositories_json = ?,
           revision = revision + 1
       WHERE id = ? AND revision = ?`,
      next.name,
      next.description ?? null,
      next.instructions,
      next.enabled ? 1 : 0,
      next.lifecycle ?? (next.enabled ? 'active' : 'archived'),
      next.creatorMembershipId ?? null,
      next.editPolicy ?? 'creator_and_admins',
      (current.configurationGeneration ?? 1) + 1,
      JSON.stringify(next.slackPresence ?? defaultAgentSlackPresence(next.id, next.name)),
      next.archivedAt ?? null,
      model,
      JSON.stringify(next.skills),
      JSON.stringify(next.mcpServers),
      JSON.stringify(next.apiConnections),
      JSON.stringify(next.repositories),
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

  deleteAgent(agentId: string, expectedRevision?: number): boolean {
    return this.db.transaction(() => {
      const current = this.getAgent(agentId);
      this.requireMutableUserAgent(current);
      const requiredRevision = expectedRevision ?? current.revision;
      if (requiredRevision !== current.revision) {
        throw new AgentRevisionConflictError(agentId, requiredRevision, current.revision);
      }
      this.requireAgentHasNoBlockingReferences(agentId);
      this.deleteRevokedAgentConnectionBindings(agentId);
      const deleted = this.db.run(
        'DELETE FROM config_agents WHERE id = ? AND revision = ?',
        agentId,
        requiredRevision,
      );
      if (deleted.changes === 1) return true;
      const actual = this.getAgent(agentId).revision;
      throw new AgentRevisionConflictError(agentId, requiredRevision, actual);
    });
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
      this.requireMutableUserAgent(this.getAgent(agentId));
      this.requireAgentHasNoBlockingReferences(agentId);
      this.deleteRevokedAgentConnectionBindings(agentId);
      const deleted = this.db.run('DELETE FROM config_agents WHERE id = ?', agentId);
      if (deleted.changes !== 1) return false;
      memory.deleteAgentMemory(agentId);
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

  putChannel(channel: ChannelConfig, expectedRevision?: number): ChannelConfig {
    this.putChannelRow(channel, expectedRevision);
    return this.getChannel(channel.workspaceId, channel.channelId) as ChannelConfig;
  }

  private putChannelRow(channel: ChannelConfig, expectedRevision?: number): void {
    const current = this.getChannel(channel.workspaceId, channel.channelId);
    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new ChannelRevisionConflictError(
          channel.workspaceId, channel.channelId, expectedRevision, 0,
        );
      }
      if (this.legacyChannelBehaviorColumns) {
        // Prelaunch disposable deployments may have received the Agent-first
        // marker just before Channel behavior columns were removed. Keep
        // their now-inert NOT NULL column satisfied without reintroducing it
        // to the current Channel model or fresh schema.
        this.db.run(
          `INSERT INTO config_channels (
            workspace_id, channel_id, revision, label, additional_instructions,
            participation_mode, lifecycle
          ) VALUES (?, ?, 1, ?, NULL, 'mention_only', ?)`,
          channel.workspaceId,
          channel.channelId,
          channel.label ?? null,
          channel.lifecycle,
        );
      } else {
        this.db.run(
          `INSERT INTO config_channels (
            workspace_id, channel_id, revision, label, lifecycle
          ) VALUES (?, ?, 1, ?, ?)`,
          channel.workspaceId,
          channel.channelId,
          channel.label ?? null,
          channel.lifecycle,
        );
      }
      return;
    }
    const actualRevision = current.revision ?? 1;
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
      throw new ChannelRevisionConflictError(
        channel.workspaceId, channel.channelId, expectedRevision, actualRevision,
      );
    }
    const updated = this.legacyChannelBehaviorColumns
      ? this.db.run(
          `UPDATE config_channels
           SET label = ?, additional_instructions = NULL,
               participation_mode = 'mention_only', lifecycle = ?,
               revision = revision + 1
           WHERE workspace_id = ? AND channel_id = ? AND revision = ?`,
          channel.label ?? null,
          channel.lifecycle,
          channel.workspaceId,
          channel.channelId,
          actualRevision,
        )
      : this.db.run(
          `UPDATE config_channels
           SET label = ?, lifecycle = ?,
               revision = revision + 1
           WHERE workspace_id = ? AND channel_id = ? AND revision = ?`,
          channel.label ?? null,
          channel.lifecycle,
          channel.workspaceId,
          channel.channelId,
          actualRevision,
        );
    if (updated.changes !== 1) {
      const latest = this.getChannel(channel.workspaceId, channel.channelId)?.revision ?? 0;
      throw new ChannelRevisionConflictError(
        channel.workspaceId, channel.channelId, actualRevision, latest,
      );
    }
  }

  getAgentReferences(agentId: string): AgentReferenceSummary {
    this.getAgent(agentId);
    const channels = new Map<string, AgentChannelReference>();
    for (const { workspaceId, channelId } of this.listAgentChannelGrants().filter(
      (grant) => grant.agentId === agentId,
    )) {
      channels.set(`${workspaceId}\u0000${channelId}`, { workspaceId, channelId });
    }
    return {
      agentId,
      channelGrants: [...channels.values()],
    };
  }

  private requireAgentHasNoBlockingReferences(agentId: string): void {
    const references = this.getAgentReferences(agentId);
    const blockers = [
      ...references.channelGrants.map((ref) => `${ref.workspaceId}/${ref.channelId}`),
    ];
    if (blockers.length > 0) {
      throw new AgentStillReferencedError(agentId, blockers.join(', '));
    }
  }

  private deleteRevokedAgentConnectionBindings(agentId: string): void {
    const active = this.db.get(
      `SELECT b.connection_account_id
       FROM config_agent_connection_bindings b
       JOIN config_connection_accounts a ON a.id = b.connection_account_id
       WHERE b.agent_id = ? AND a.lifecycle <> 'revoked'
       ORDER BY b.connection_account_id
       LIMIT 1`,
      agentId,
    );
    if (active) {
      throw new AgentStillReferencedError(
        agentId,
        `connection ${String(active.connection_account_id)}`,
      );
    }
    this.db.run('DELETE FROM config_agent_connection_bindings WHERE agent_id = ?', agentId);
  }

  private installAgentPlatformSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_workspace_installations (
        workspace_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        transport_mode TEXT NOT NULL,
        runtime_contract TEXT NOT NULL DEFAULT 'legacy'
          CHECK (runtime_contract IN ('legacy', 'chickpea-v1')),
        default_agent_id TEXT NOT NULL,
        team_id TEXT,
        app_id TEXT,
        bot_user_id TEXT,
        gateway_binding_id TEXT,
        health TEXT NOT NULL,
        health_detail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (default_agent_id) REFERENCES config_agents(id)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_agent_channel_grants (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_by_membership_id TEXT NOT NULL,
        channel_label TEXT,
        channel_is_private INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, channel_id, agent_id),
        FOREIGN KEY (agent_id) REFERENCES config_agents(id)
      )`,
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS config_agent_channel_grants_agent_idx ON config_agent_channel_grants(agent_id)',
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_agent_thread_routes (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_generation INTEGER NOT NULL,
        owner_incarnation INTEGER NOT NULL DEFAULT 1 CHECK (owner_incarnation > 0),
        transfer_message_ts TEXT,
        previous_agent_id TEXT,
        handoff_context_json TEXT,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, channel_id, thread_ts),
        FOREIGN KEY (agent_id) REFERENCES config_agents(id)
      )`,
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS config_agent_thread_routes_agent_idx ON config_agent_thread_routes(agent_id)',
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_connection_accounts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_membership_id TEXT,
        created_by_membership_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        label TEXT NOT NULL,
        purpose TEXT,
        identity_json TEXT,
        policy_json TEXT NOT NULL,
        secret_ref_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS config_connection_accounts_workspace_idx ON config_connection_accounts(workspace_id)',
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_agent_connection_bindings (
        agent_id TEXT NOT NULL,
        connection_account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        allowed_capabilities_json TEXT NOT NULL,
        resource_constraints_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, connection_account_id),
        FOREIGN KEY (agent_id) REFERENCES config_agents(id),
        FOREIGN KEY (connection_account_id) REFERENCES config_connection_accounts(id)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_agent_schedule_references (
        schedule_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        destination_kind TEXT NOT NULL DEFAULT 'channel',
        destination_binding_digest TEXT,
        created_by_membership_id TEXT NOT NULL,
        runs_as_membership_id TEXT NOT NULL,
        authority_receipt_id TEXT NOT NULL,
        required_connection_account_ids_json TEXT NOT NULL,
        connection_pause_account_ids_json TEXT NOT NULL DEFAULT '[]',
        connection_pause_preserves_state INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES config_agents(id)
      )`,
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS config_agent_schedule_references_agent_idx ON config_agent_schedule_references(agent_id)',
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_agent_archive_snapshots (
        agent_id TEXT PRIMARY KEY,
        channel_grants_json TEXT NOT NULL,
        paused_schedule_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES config_agents(id) ON DELETE CASCADE
      )`,
    );
  }

  private requireFirstActiveAgent(): CustomAgentConfig {
    const agent = this.listUserAgents().find(
      (candidate) => candidate.lifecycle !== 'archived' && candidate.enabled,
    );
    if (!agent) throw new Error('A workspace installation requires an active Agent');
    return agent;
  }

  private requireActiveAgent(agentId: string): CustomAgentConfig {
    const agent = this.getAgent(agentId);
    if (!agent.enabled || agent.lifecycle === 'archived') {
      throw new Error(`Agent ${agentId} is not active`);
    }
    return agent;
  }

  private requireActiveUserAgent(agentId: string): CustomAgentConfig {
    const agent = this.requireActiveAgent(agentId);
    if (agent.kind !== 'user') {
      throw new Error(`The ${agent.name} system Agent cannot receive user-configured capabilities`);
    }
    return agent;
  }

  private requireMutableUserAgent(agent: CustomAgentConfig): void {
    if (agent.kind === 'system') {
      throw new Error(`The ${agent.name} system Agent is product-owned and cannot be changed`);
    }
  }

  private insertWorkspaceModelDefault(
    input: WorkspaceModelDefaultInput,
    at: number,
  ): void {
    this.db.run(
      `INSERT INTO config_workspace_model_defaults (
        workspace_id, model_id, revision, provenance,
        last_changed_by_membership_id, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
      input.workspaceId,
      input.modelId ?? null,
      input.provenance,
      input.lastChangedByMembershipId ?? null,
      at,
      at,
    );
  }

  private cutoverRow(workspaceId: string): ChickpeaCutoverRow | undefined {
    return this.db.get(
      'SELECT * FROM config_chickpea_cutovers WHERE workspace_id = ?',
      workspaceId,
    ) as unknown as ChickpeaCutoverRow | undefined;
  }

  private requireCutoverRow(workspaceId: string): ChickpeaCutoverRow {
    const row = this.cutoverRow(workspaceId);
    if (!row) throw new Error(`Chickpea cutover is not prepared for ${workspaceId}`);
    return row;
  }

  private prepareCutoverRow(workspaceId: string, at: number): void {
    if (this.cutoverRow(workspaceId)) return;
    const installation = this.getWorkspaceInstallation(workspaceId);
    if (!installation) throw new Error(`Unknown workspace installation ${workspaceId}`);
    const defaultAgent = this.getAgent(installation.defaultAgentId);
    const workspaceDefault = this.getWorkspaceModelDefault(workspaceId);
    const untouchedStarter = this.isUntouchedCloudflareStarter(defaultAgent);
    const classification: ChickpeaCutoverModelClassification = untouchedStarter
      ? 'untouched_cloudflare_starter'
      : defaultAgent.model
        ? 'explicit_agent_pin'
        : workspaceDefault?.provenance === 'migrated_environment'
          ? 'environment_default'
          : 'model_missing';
    this.db.run(
      `INSERT OR IGNORE INTO config_chickpea_cutovers (
        workspace_id, state, model_classification, starter_agent_id,
        starter_agent_generation, prepared_default_revision, prepared_at,
        activated_at, rolled_back_at, route_backfill_count, starter_pin_cleared
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)`,
      workspaceId,
      installation.runtimeContract === 'chickpea-v1' ? 'activated' : 'prepared',
      classification,
      untouchedStarter ? defaultAgent.id : null,
      untouchedStarter ? Number(defaultAgent.configurationGeneration ?? 1) : null,
      workspaceDefault?.revision ?? 0,
      at,
      installation.runtimeContract === 'chickpea-v1' ? at : null,
    );
  }

  private isUntouchedCloudflareStarter(agent: CustomAgentConfig): boolean {
    return Boolean(this.db.get('SELECT 1 AS present FROM config_meta WHERE key = ?', SEED_META_KEY)) &&
      agent.kind === 'user' &&
      agent.id === 'agent_default' &&
      Number(agent.configurationGeneration ?? 1) === 1 &&
      isSeedCloudflareModelPin(agent.model);
  }

  private clearProvenStarterPin(workspaceId: string): boolean {
    const cutover = this.requireCutoverRow(workspaceId);
    if (!cutover.starter_agent_id || cutover.starter_agent_generation == null) return false;
    const agent = this.getAgent(cutover.starter_agent_id);
    const pinnedModel = agent.model;
    if (
      agent.kind !== 'user' ||
      pinnedModel === undefined ||
      !isSeedCloudflareModelPin(pinnedModel) ||
      Number(agent.configurationGeneration ?? 1) !== Number(cutover.starter_agent_generation)
    ) return false;
    const updated = this.db.run(
      `UPDATE config_agents
       SET model = NULL, revision = revision + 1,
           configuration_generation = configuration_generation + 1
       WHERE id = ? AND model = ? AND configuration_generation = ?`,
      agent.id,
      pinnedModel,
      Number(cutover.starter_agent_generation),
    );
    if (updated.changes !== 1) return false;
    this.db.run(
      `UPDATE config_chickpea_cutovers
       SET starter_agent_generation = starter_agent_generation + 1
       WHERE workspace_id = ?`,
      workspaceId,
    );
    return true;
  }

  private restoreCutoverStarterPin(workspaceId: string): boolean {
    const cutover = this.requireCutoverRow(workspaceId);
    if (
      !cutover.starter_pin_cleared ||
      !cutover.starter_agent_id ||
      cutover.starter_agent_generation == null
    ) return false;
    const agent = this.getAgent(cutover.starter_agent_id);
    if (
      agent.kind !== 'user' ||
      agent.model ||
      Number(agent.configurationGeneration ?? 1) !== Number(cutover.starter_agent_generation)
    ) return false;
    const updated = this.db.run(
      `UPDATE config_agents
       SET model = ?, revision = revision + 1,
           configuration_generation = configuration_generation + 1
       WHERE id = ? AND model IS NULL AND configuration_generation = ?`,
      SEED_CLOUDFLARE_MODEL_PIN,
      agent.id,
      Number(cutover.starter_agent_generation),
    );
    if (updated.changes !== 1) return false;
    this.db.run(
      `UPDATE config_chickpea_cutovers
       SET starter_agent_generation = starter_agent_generation + 1
       WHERE workspace_id = ?`,
      workspaceId,
    );
    return true;
  }

  private cutoverActivation(
    workspaceId: string,
    cutover: ChickpeaCutoverRow,
  ): ChickpeaCutoverActivation {
    const installation = this.getWorkspaceInstallation(workspaceId);
    const workspaceDefault = this.getWorkspaceModelDefault(workspaceId);
    if (!installation || !workspaceDefault || !cutover.activated_at) {
      throw new Error(`Chickpea cutover activation evidence is incomplete for ${workspaceId}`);
    }
    return {
      workspaceId,
      runtimeContract: installation.runtimeContract,
      installationRevision: installation.revision,
      defaultRevision: workspaceDefault.revision,
      systemAgentId: CHICKPEA_AGENT_ID,
      routeCount: Number(this.db.get(
        'SELECT COUNT(*) AS count FROM config_agent_thread_routes WHERE workspace_id = ?',
        workspaceId,
      )?.count ?? 0),
      routeBackfillCount: Number(cutover.route_backfill_count),
      starterPinCleared: Boolean(cutover.starter_pin_cleared),
      starterPinPreserved: Boolean(cutover.starter_agent_id) && !Boolean(cutover.starter_pin_cleared),
      activatedAt: Number(cutover.activated_at),
    };
  }

  private seedOnce(seed: ConfigSeed): void {
    const seeded = this.db.get('SELECT value FROM config_meta WHERE key = ?', SEED_META_KEY);
    if (seeded) return;

    // Seed rows and the seeded marker commit atomically: a crash mid-seed must
    // not leave a half-seeded DB that the marker then stamps as complete.
    this.db.transaction(() => {
      const agentCount = countRows(this.db, 'config_agents');
      const grantCount = countRows(this.db, 'config_agent_channel_grants');
      if (agentCount === 0 && grantCount === 0) {
        for (const agent of seed.agents) {
          this.insertAgent(agent);
        }
        for (const channel of seed.channels ?? []) {
          this.putChannelRow(channel);
        }
        for (const grant of seed.grants ?? []) {
          this.getAgent(grant.agentId);
          if (!this.getChannel(grant.workspaceId, grant.channelId)) {
            this.putChannelRow(channelFromSeedGrant(grant));
          }
          this.putAgentChannelGrant(grant);
        }
      }
      this.db.run(
        'INSERT INTO config_meta (key, value) VALUES (?, ?)',
        SEED_META_KEY,
        new Date().toISOString(),
      );
    });
  }

  private insertAgent(
    agent: AgentCreateInput,
    options: { allowSystem?: boolean } = {},
  ): { changes: number } {
    const kind = agent.kind ?? 'user';
    if (kind === 'system' && !options.allowSystem) {
      throw new Error('System Agents can only be materialized through the Stage 2 gate');
    }
    return this.db.run(
      `INSERT INTO config_agents (
        id, agent_kind, revision, name, description, instructions, enabled, lifecycle,
        creator_membership_id, edit_policy, configuration_generation,
        slack_presence_json, archived_at, model,
        skills_json, mcp_servers_json, api_connections_json, repositories_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agent.id,
      kind,
      1,
      agent.name,
      agent.description ?? null,
      agent.instructions,
      agent.enabled ? 1 : 0,
      agent.lifecycle ?? (agent.enabled ? 'active' : 'archived'),
      agent.creatorMembershipId ?? null,
      agent.editPolicy ?? 'creator_and_admins',
      agent.configurationGeneration ?? 1,
      kind === 'system'
        ? 'null'
        : JSON.stringify(agent.slackPresence ?? defaultAgentSlackPresence(agent.id, agent.name)),
      agent.archivedAt ?? null,
      agent.model ?? null,
      JSON.stringify(agent.skills ?? []),
      JSON.stringify(agent.mcpServers ?? []),
      JSON.stringify(agent.apiConnections ?? []),
      JSON.stringify(agent.repositories ?? []),
    );
  }

  private installConfigSchema(): void {
    // Check and install under the same write transaction. Besides making the
    // marker atomic with every table, this closes the two-process bootstrap
    // race: the process that acquires the lock second observes the first one's
    // completed marker instead of attempting a duplicate CREATE.
    this.db.transaction(() => {
      const metaExists = Boolean(this.db.get(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'config_meta'",
      ));
      const existingConfigTables = this.db.all(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'config_%'
         ORDER BY name`,
      );
      if (metaExists) {
        const version = this.db.get(
          'SELECT value FROM config_meta WHERE key = ?',
          SCHEMA_VERSION_KEY,
        )?.value;
        const marker = this.db.get(
          'SELECT value FROM config_meta WHERE key = ?',
          SCHEMA_MARKER_KEY,
        )?.value;
        if (
          String(version ?? '') !== String(CONFIG_SCHEMA_VERSION) ||
          marker !== CONFIG_SCHEMA_MARKER
        ) {
          throw incompatibleConfigSchemaError();
        }
        this.installChickpeaExtensions();
        return;
      }
      if (existingConfigTables.length > 0) throw incompatibleConfigSchemaError();

      this.db.exec(
        `CREATE TABLE config_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`,
      );
      this.db.exec(
        `CREATE TABLE config_agents (
        id TEXT PRIMARY KEY,
        agent_kind TEXT NOT NULL DEFAULT 'user' CHECK (agent_kind IN ('user', 'system')),
        revision INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        lifecycle TEXT NOT NULL,
        creator_membership_id TEXT,
        edit_policy TEXT NOT NULL,
        configuration_generation INTEGER NOT NULL,
        slack_presence_json TEXT NOT NULL,
        archived_at INTEGER,
        model TEXT,
        skills_json TEXT NOT NULL,
        mcp_servers_json TEXT NOT NULL,
        api_connections_json TEXT NOT NULL,
        repositories_json TEXT NOT NULL
        )`,
      );
      this.db.exec(
        `CREATE TABLE config_channels (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        label TEXT,
        lifecycle TEXT NOT NULL,
        PRIMARY KEY (workspace_id, channel_id)
        )`,
      );
      this.db.exec(
        `CREATE TABLE config_agent_deletion_receipts (
        idempotency_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
        )`,
      );
      this.installAgentPlatformSchema();
      this.installChickpeaExtensions();
      this.db.run(
        'INSERT INTO config_meta (key, value) VALUES (?, ?)',
        SCHEMA_VERSION_KEY,
        String(CONFIG_SCHEMA_VERSION),
      );
      this.db.run(
        'INSERT INTO config_meta (key, value) VALUES (?, ?)',
        SCHEMA_MARKER_KEY,
        CONFIG_SCHEMA_MARKER,
      );
    });
  }

  private installAgentConnectionBindingMigrations(): void {
    const bindingTable = this.db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_agent_connection_bindings'",
    );
    if (!bindingTable) return;
    const bindingColumns = new Set(
      this.db.all('PRAGMA table_info(config_agent_connection_bindings)')
        .map((column) => String(column.name)),
    );
    this.db.transaction(() => {
      if (!bindingColumns.has('resource_constraints_json')) {
        this.db.exec(
          "ALTER TABLE config_agent_connection_bindings ADD COLUMN resource_constraints_json TEXT NOT NULL DEFAULT '{}'",
        );
      }
      const duplicate = this.db.get(
        `SELECT connection_account_id, GROUP_CONCAT(agent_id) AS agent_ids,
                COUNT(*) AS binding_count
         FROM config_agent_connection_bindings
         GROUP BY connection_account_id
         HAVING COUNT(*) > 1
         ORDER BY connection_account_id
         LIMIT 1`,
      );
      if (duplicate) {
        throw new Error(
          `Connection binding ownership preflight failed: account ` +
          `${String(duplicate.connection_account_id)} is bound to multiple Agents ` +
          `(${String(duplicate.agent_ids)}). Remove the duplicate bindings before startup; ` +
          `Chickpea will not choose an owner automatically.`,
        );
      }
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS config_agent_connection_bindings_account_uidx
         ON config_agent_connection_bindings(connection_account_id)`,
      );
    });
  }

  private installAgentScheduleReferenceMigrations(): void {
    const scheduleTable = this.db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_agent_schedule_references'",
    );
    if (!scheduleTable) return;
    const scheduleColumns = new Set(
      this.db.all('PRAGMA table_info(config_agent_schedule_references)')
        .map((column) => String(column.name)),
    );
    if (!scheduleColumns.has('connection_pause_account_ids_json')) {
      this.db.exec(
        "ALTER TABLE config_agent_schedule_references ADD COLUMN connection_pause_account_ids_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    if (!scheduleColumns.has('connection_pause_preserves_state')) {
      this.db.exec(
        'ALTER TABLE config_agent_schedule_references ADD COLUMN connection_pause_preserves_state INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!scheduleColumns.has('destination_kind')) {
      this.db.exec(
        "ALTER TABLE config_agent_schedule_references ADD COLUMN destination_kind TEXT NOT NULL DEFAULT 'channel'",
      );
    }
    if (!scheduleColumns.has('destination_binding_digest')) {
      this.db.exec(
        'ALTER TABLE config_agent_schedule_references ADD COLUMN destination_binding_digest TEXT',
      );
    }
  }
  private installChickpeaExtensions(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    this.installChickpeaRoutingExtensions();
    if (this.db.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_CHICKPEA_EXTENSION_MIGRATION,
    )) {
      this.installChickpeaCutoverExtensions();
      return;
    }

    if (tableExists(this.db, 'config_agents')) {
      addColumnIfMissing(
        this.db,
        'config_agents',
        'agent_kind',
        `TEXT NOT NULL DEFAULT 'user'
         CHECK (agent_kind IN ('user', 'system'))`,
      );
    }
    if (tableExists(this.db, 'config_workspace_installations')) {
      addColumnIfMissing(
        this.db,
        'config_workspace_installations',
        'runtime_contract',
        `TEXT NOT NULL DEFAULT 'legacy'
         CHECK (runtime_contract IN ('legacy', 'chickpea-v1'))`,
      );
    }
    if (tableExists(this.db, 'config_agent_thread_routes')) {
      addColumnIfMissing(
        this.db,
        'config_agent_thread_routes',
        'owner_incarnation',
        `INTEGER NOT NULL DEFAULT 1
         CHECK (owner_incarnation > 0)`,
      );
    }

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_workspace_model_defaults (
        workspace_id TEXT PRIMARY KEY,
        model_id TEXT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        provenance TEXT NOT NULL,
        last_changed_by_membership_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_slack_public_context (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        root_ts TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('human', 'agent')),
        text TEXT NOT NULL,
        agent_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, channel_id, root_ts, message_ts)
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS config_slack_public_context_root_idx
       ON config_slack_public_context(workspace_id, channel_id, root_ts, updated_at)`,
    );

    if (tableExists(this.db, 'config_workspace_installations') &&
        tableExists(this.db, 'config_agents')) {
      const installations = this.db.all(
        `SELECT installation.workspace_id, installation.created_at,
                installation.updated_at, agent.model
         FROM config_workspace_installations installation
         LEFT JOIN config_agents agent ON agent.id = installation.default_agent_id
         ORDER BY installation.workspace_id`,
      );
      for (const installation of installations) {
        const modelId = typeof installation.model === 'string' && installation.model.trim()
          ? installation.model
          : null;
        this.db.run(
          `INSERT OR IGNORE INTO config_workspace_model_defaults (
            workspace_id, model_id, revision, provenance,
            last_changed_by_membership_id, created_at, updated_at
          ) VALUES (?, ?, 1, ?, NULL, ?, ?)`,
          String(installation.workspace_id),
          modelId,
          modelId ? 'migrated_agent' : 'migration_pending',
          Number(installation.created_at),
          Number(installation.updated_at),
        );
      }
    }
    this.db.run(
      'INSERT INTO config_migrations (id, applied_at) VALUES (?, ?)',
      CONFIG_CHICKPEA_EXTENSION_MIGRATION,
      Date.now(),
    );
    this.installChickpeaCutoverExtensions();
  }

  private installChickpeaRoutingExtensions(): void {
    if (this.db.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_CHICKPEA_ROUTING_MIGRATION,
    )) return;
    if (tableExists(this.db, 'config_agent_thread_routes')) {
      for (const [column, declaration] of [
        ['transfer_message_ts', 'TEXT'],
        ['previous_agent_id', 'TEXT'],
        ['handoff_context_json', 'TEXT'],
      ] as const) {
        addColumnIfMissing(this.db, 'config_agent_thread_routes', column, declaration);
      }
    }
    this.db.run(
      'INSERT INTO config_migrations (id, applied_at) VALUES (?, ?)',
      CONFIG_CHICKPEA_ROUTING_MIGRATION,
      Date.now(),
    );
  }

  private installChickpeaCutoverExtensions(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS config_chickpea_cutovers (
        workspace_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'activated', 'rolled_back')),
        model_classification TEXT NOT NULL CHECK (model_classification IN (
          'untouched_cloudflare_starter', 'explicit_agent_pin',
          'environment_default', 'model_missing'
        )),
        starter_agent_id TEXT,
        starter_agent_generation INTEGER,
        prepared_default_revision INTEGER NOT NULL,
        prepared_at INTEGER NOT NULL,
        activated_at INTEGER,
        rolled_back_at INTEGER,
        route_backfill_count INTEGER NOT NULL DEFAULT 0,
        starter_pin_cleared INTEGER NOT NULL DEFAULT 0 CHECK (starter_pin_cleared IN (0, 1))
      )`,
    );
    if (this.db.get(
      'SELECT 1 AS present FROM config_migrations WHERE id = ?',
      CONFIG_CHICKPEA_CUTOVER_MIGRATION,
    )) return;
    if (tableExists(this.db, 'config_workspace_installations')) {
      for (const installation of this.listWorkspaceInstallations()) {
        this.prepareCutoverRow(installation.workspaceId, Date.now());
      }
    }
    this.db.run(
      'INSERT INTO config_migrations (id, applied_at) VALUES (?, ?)',
      CONFIG_CHICKPEA_CUTOVER_MIGRATION,
      Date.now(),
    );
  }
}

function incompatibleConfigSchemaError(): Error {
  return new Error(
    'TAG_STATE contains incompatible pre-Agent config state; use a fresh deployment.',
  );
}

function parseArchiveChannelGrants(value: string, agentId: string): AgentChannelGrantRow[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw invalidArchiveSnapshotError(agentId);
  for (const grant of parsed) {
    if (
      !grant ||
      typeof grant !== 'object' ||
      (grant as { agent_id?: unknown }).agent_id !== agentId
    ) {
      throw invalidArchiveSnapshotError(agentId);
    }
  }
  return parsed as AgentChannelGrantRow[];
}

function parseArchiveScheduleIds(value: string, agentId: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw invalidArchiveSnapshotError(agentId);
  }
  return parsed;
}

function invalidArchiveSnapshotError(agentId: string): Error {
  return new Error(`Agent ${agentId} has an invalid archive snapshot`);
}

function validateUserAgent(agent: {
  id: string;
  name: string;
  kind?: 'user' | 'system';
  slackPresence?: AgentSlackPresence;
}): void {
  if (agent.kind === 'system') {
    throw new Error('System Agents can only be materialized through the Stage 2 gate');
  }
  const field = reservedAgentIdentityField({
    id: agent.id,
    name: agent.name,
    ...(agent.slackPresence
      ? { handle: agent.slackPresence.requestedHandle || agent.slackPresence.normalizedHandle }
      : {}),
  });
  if (field) throw new ReservedAgentIdentityError(field);
}

/**
 * Node backend: the target-neutral logic over a file-backed (or `:memory:`)
 * `node:sqlite` database, wrapped in the async public interface. Schema,
 * migrations, and seeding run synchronously in the constructor — a constructed
 * store is fully initialized, exactly as before the async refactor.
 */
export interface SqliteConfigStore extends ConfigStore {
  close(): void;
}

export class SqliteConfigStore {
  constructor(path: string = resolveStateDbPath(), seed: ConfigSeed = DEFAULT_SEED) {
    const db = openStateDb(path);
    try {
      // The Proxy facade drops the `implements` compile check, so this typed
      // binding is the conformance assertion that keeps it: a logic method that
      // stops matching ConfigStore fails typecheck here.
      const _conforms: ConfigStore = promisify(new ConfigStoreLogic(db, seed), {
        close: () => db.close(),
      });
      return _conforms as unknown as SqliteConfigStore;
    } catch (error) {
      db.close();
      throw error;
    }
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

function normalizedModelSpecifier(value: string | undefined): string | undefined {
  const model = value?.trim();
  if (!model || !/^[^/]+\/.+$/.test(model)) return undefined;
  return model;
}

function cutoverClassification(value: string): ChickpeaCutoverModelClassification {
  if (
    value === 'untouched_cloudflare_starter' ||
    value === 'explicit_agent_pin' ||
    value === 'environment_default'
  ) return value;
  return 'model_missing';
}

function cutoverState(value: string): ChickpeaCutoverPreflight['state'] {
  if (value === 'activated' || value === 'rolled_back') return value;
  return 'prepared';
}

function rowToAgent(row: AgentRow): CustomAgentConfig {
  const kind = row.agent_kind === 'system' ? 'system' : 'user';
  return {
    id: row.id,
    kind,
    revision: Number(row.revision ?? 1),
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    instructions: row.instructions,
    enabled: Boolean(row.enabled),
    lifecycle: (row.lifecycle === 'draft' ||
    row.lifecycle === 'needs_attention' ||
    row.lifecycle === 'archived'
      ? row.lifecycle
      : 'active'),
    ...(row.creator_membership_id ? { creatorMembershipId: row.creator_membership_id } : {}),
    editPolicy:
      row.edit_policy === 'all_workspace_members'
        ? 'all_workspace_members'
        : 'creator_and_admins',
    configurationGeneration: Number(row.configuration_generation ?? 1),
    ...(kind === 'user'
      ? { slackPresence: parseAgentSlackPresence(row.slack_presence_json, row.id, row.name) }
      : {}),
    ...(row.archived_at !== null && row.archived_at !== undefined
      ? { archivedAt: Number(row.archived_at) }
      : {}),
    ...(row.model ? { model: row.model } : {}),
    skills: JSON.parse(row.skills_json) as CustomAgentConfig['skills'],
    mcpServers: JSON.parse(row.mcp_servers_json) as CustomAgentConfig['mcpServers'],
    apiConnections: parseApiConnections(row.api_connections_json),
    repositories: parseRepositories(row.repositories_json),
  };
}

function defaultAgentSlackPresence(agentId: string, name: string): AgentSlackPresence {
  const normalizedHandle = normalizeAgentHandle(name || agentId);
  return {
    requestedHandle: normalizedHandle,
    normalizedHandle,
    desiredState: 'unpublished',
    health: 'unpublished',
    avatar: {
      kind: 'generated',
      revision: 1,
      seed: agentId,
    },
  };
}

function parseAgentSlackPresence(
  raw: string | null | undefined,
  agentId: string,
  name: string,
): AgentSlackPresence {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Partial<AgentSlackPresence>;
    const fallback = defaultAgentSlackPresence(agentId, name);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      ...fallback,
      ...parsed,
      avatar: {
        ...fallback.avatar,
        ...(parsed.avatar ?? {}),
      },
    };
  } catch {
    return defaultAgentSlackPresence(agentId, name);
  }
}

function rowToWorkspaceInstallation(row: WorkspaceInstallationRow): WorkspaceInstallation {
  return {
    workspaceId: row.workspace_id,
    revision: Number(row.revision),
    transportMode: row.transport_mode === 'gateway' ? 'gateway' : 'direct',
    runtimeContract: row.runtime_contract === 'chickpea-v1' ? 'chickpea-v1' : 'legacy',
    defaultAgentId: row.default_agent_id,
    ...(row.team_id ? { teamId: row.team_id } : {}),
    ...(row.app_id ? { appId: row.app_id } : {}),
    ...(row.bot_user_id ? { botUserId: row.bot_user_id } : {}),
    ...(row.gateway_binding_id ? { gatewayBindingId: row.gateway_binding_id } : {}),
    health:
      row.health === 'healthy' || row.health === 'needs_attention' || row.health === 'revoked'
        ? row.health
        : 'pending',
    ...(row.health_detail ? { healthDetail: row.health_detail } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToAgentChannelGrant(row: AgentChannelGrantRow): AgentChannelGrant {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    agentId: row.agent_id,
    revision: Number(row.revision),
    status:
      row.status === 'active' || row.status === 'needs_attention'
        ? row.status
        : 'pending',
    createdByMembershipId: row.created_by_membership_id,
    ...(row.channel_label ? { channelLabel: row.channel_label } : {}),
    ...(row.channel_is_private !== null
      ? { channelIsPrivate: Boolean(row.channel_is_private) }
      : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToAgentThreadRoute(row: AgentThreadRouteRow): AgentThreadRoute {
  const handoff = row.transfer_message_ts && row.previous_agent_id
    ? {
        transferMessageTs: row.transfer_message_ts,
        previousAgentId: row.previous_agent_id,
        ...(row.handoff_context_json
          ? { context: parseAgentThreadHandoffContext(row.handoff_context_json) }
          : {}),
      }
    : undefined;
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    agentId: row.agent_id,
    agentGeneration: Number(row.agent_generation),
    ownerIncarnation: Number(row.owner_incarnation ?? 1),
    ...(handoff ? { handoff } : {}),
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
  };
}

function parseAgentThreadHandoffContext(
  raw: string,
): NonNullable<NonNullable<AgentThreadRoute['handoff']>['context']> {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const entry = candidate as Record<string, unknown>;
      if (
        typeof entry.messageTs !== 'string' ||
        (entry.role !== 'human' && entry.role !== 'agent') ||
        typeof entry.text !== 'string' ||
        (entry.role === 'agent') !== (typeof entry.agentId === 'string')
      ) return [];
      return [{
        messageTs: entry.messageTs,
        role: entry.role,
        text: entry.text,
        ...(typeof entry.agentId === 'string' ? { agentId: entry.agentId } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function rowToWorkspaceModelDefault(row: WorkspaceModelDefaultRow): WorkspaceModelDefault {
  const provenance =
    row.provenance === 'installation_bootstrap' ||
    row.provenance === 'migrated_agent' ||
    row.provenance === 'migrated_environment' ||
    row.provenance === 'admin_selected'
      ? row.provenance
      : 'migration_pending';
  return {
    workspaceId: row.workspace_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    revision: Number(row.revision),
    provenance,
    ...(row.last_changed_by_membership_id
      ? { lastChangedByMembershipId: row.last_changed_by_membership_id }
      : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToSlackPublicContext(row: SlackPublicContextRow): SlackPublicContextEntry {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    rootTs: row.root_ts,
    messageTs: row.message_ts,
    role: row.role === 'agent' ? 'agent' : 'human',
    text: row.text,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    updatedAt: Number(row.updated_at),
  };
}

function validateConnectionAccountInput(input: ConnectionAccountInput): void {
  if (!input.id.trim() || !input.workspaceId.trim() || !input.providerId.trim()) {
    throw new Error('Connection account identity is incomplete');
  }
  if (!input.createdByMembershipId.trim() || !input.secretRefId.trim()) {
    throw new Error('Connection account authority is incomplete');
  }
  if (input.ownerKind === 'member' && !input.ownerMembershipId?.trim()) {
    throw new Error('Personal connection accounts require an owner membership');
  }
  if (input.ownerKind === 'team' && input.ownerMembershipId !== undefined) {
    throw new Error('Team connection accounts cannot have a personal owner');
  }
  if (!input.label.trim() || input.label.length > 160) {
    throw new Error('Connection account label is invalid');
  }
  const oauthAttemptId = 'oauthAttemptId' in input.policy
    ? input.policy.oauthAttemptId
    : undefined;
  if (oauthAttemptId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(oauthAttemptId)) {
    throw new Error('Connection account OAuth attempt is invalid');
  }
  if (input.policy.kind === 'api') {
    if (input.policy.allowedHosts.length === 0 || input.policy.allowedMethods.length === 0) {
      throw new Error('API connection account policy is incomplete');
    }
    if (input.policy.authMode === 'oauth' && !input.policy.oauthProvider) {
      throw new Error('OAuth API connection account requires a provider');
    }
  } else if (input.policy.kind === 'mcp' && !input.policy.url.trim()) {
    throw new Error('MCP connection account policy is incomplete');
  } else if (input.policy.kind === 'managed') {
    const idPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/;
    const capabilities = input.policy.allowedCapabilities;
    if (
      !idPattern.test(input.policy.adapterId) ||
      !idPattern.test(input.policy.toolkit) ||
      !input.policy.principalRef.trim() || input.policy.principalRef.length > 256 ||
      !input.policy.accountRef.trim() || input.policy.accountRef.length > 256 ||
      capabilities.length === 0 || capabilities.length > 128 ||
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) =>
        !capability.trim() || capability.length > 256 || capability !== capability.trim()
      )
    ) {
      throw new Error('Managed connection account policy is incomplete');
    }
    if (input.policy.resourceConstraints && Object.values(input.policy.resourceConstraints).some(
      (selections) => !Array.isArray(selections) ||
        selections.length > MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY ||
        selections.some((selection) => selection.currencyCode !== undefined &&
          !/^[A-Z]{3}$/.test(selection.currencyCode)),
    )) {
      throw new Error('Managed connection account resource constraints are invalid');
    }
    const grantSummary = input.policy.grantSummary;
    if (grantSummary && (
      typeof grantSummary.truncated !== 'boolean' ||
      !Array.isArray(grantSummary.items) || grantSummary.items.length > 20 ||
      grantSummary.items.some((item) =>
        !item || (item.type !== 'page' && item.type !== 'database') ||
        typeof item.label !== 'string' || !item.label.trim() || item.label.length > 240)
    )) {
      throw new Error('Managed connection grant summary is invalid');
    }
  }
}

function rowToConnectionAccount(row: ConnectionAccountRow): ConnectionAccount {
  let identity: ConnectionAccount['identity'];
  if (row.identity_json) {
    try {
      const parsed = JSON.parse(row.identity_json) as ConnectionAccount['identity'];
      if (parsed && typeof parsed === 'object') identity = parsed;
    } catch {
      // Invalid non-secret provider metadata is omitted; secret lookup stays fenced.
    }
  }
  const policy = JSON.parse(row.policy_json) as ConnectionAccount['policy'];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    revision: Number(row.revision),
    ownerKind: row.owner_kind === 'member' ? 'member' : 'team',
    ...(row.owner_membership_id ? { ownerMembershipId: row.owner_membership_id } : {}),
    createdByMembershipId: row.created_by_membership_id,
    providerId: row.provider_id,
    label: row.label,
    ...(row.purpose ? { purpose: row.purpose } : {}),
    ...(identity ? { identity } : {}),
    policy,
    secretRefId: row.secret_ref_id,
    lifecycle:
      row.lifecycle === 'ready' || row.lifecycle === 'needs_attention' || row.lifecycle === 'revoked'
        ? row.lifecycle
        : 'pending',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToAgentConnectionBinding(row: AgentConnectionBindingRow): AgentConnectionBinding {
  let allowedCapabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_capabilities_json) as unknown;
    if (Array.isArray(parsed)) {
      allowedCapabilities = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    allowedCapabilities = [];
  }
  const resourceConstraints = parseBindingResourceConstraints(row.resource_constraints_json);
  return {
    agentId: row.agent_id,
    connectionAccountId: row.connection_account_id,
    providerId: row.provider_id,
    allowedCapabilities,
    resourceConstraints,
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function normalizeBindingResourceConstraints(
  value: AgentConnectionBinding['resourceConstraints'],
): NonNullable<AgentConnectionBinding['resourceConstraints']> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length > 32) {
    throw new Error('Connection binding resource constraints are invalid');
  }
  const normalized: NonNullable<AgentConnectionBinding['resourceConstraints']> = {};
  for (const [key, handles] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z0-9]{0,127}$/.test(key) || !Array.isArray(handles) ||
        handles.length > 256 || new Set(handles).size !== handles.length ||
        handles.some((handle) =>
          typeof handle !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(handle)
        )) {
      throw new Error('Connection binding resource constraints are invalid');
    }
    normalized[key] = [...handles];
  }
  return normalized;
}

function parseBindingResourceConstraints(
  raw: string | null | undefined,
): NonNullable<AgentConnectionBinding['resourceConstraints']> {
  try {
    return normalizeBindingResourceConstraints(JSON.parse(raw ?? '{}') as never);
  } catch {
    return {};
  }
}

function rowToAgentScheduleReference(row: AgentScheduleReferenceRow): AgentScheduleReference {
  let requiredConnectionAccountIds: string[] = [];
  try {
    const parsed = JSON.parse(row.required_connection_account_ids_json) as unknown;
    if (Array.isArray(parsed)) {
      requiredConnectionAccountIds = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    requiredConnectionAccountIds = [];
  }
  let connectionPauseAccountIds: string[] = [];
  try {
    const parsed = JSON.parse(row.connection_pause_account_ids_json ?? '[]') as unknown;
    if (Array.isArray(parsed)) {
      connectionPauseAccountIds = parsed.filter(
        (value): value is string => typeof value === 'string',
      );
    }
  } catch {
    connectionPauseAccountIds = [];
  }
  return {
    scheduleId: row.schedule_id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    destinationKind: row.destination_kind === 'direct_thread' ? 'direct_thread' : 'channel',
    destinationBindingDigest: row.destination_binding_digest ?? null,
    createdByMembershipId: row.created_by_membership_id,
    runsAsMembershipId: row.runs_as_membership_id,
    authorityReceiptId: row.authority_receipt_id,
    requiredConnectionAccountIds,
    ...(connectionPauseAccountIds.length > 0 ? { connectionPauseAccountIds } : {}),
    ...(connectionPauseAccountIds.length > 0 && Number(row.connection_pause_preserves_state) === 1
      ? { connectionPausePreservesState: true }
      : {}),
    state:
      row.state === 'paused' || row.state === 'needs_attention' || row.state === 'archived'
        ? row.state
        : 'active',
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function normalizeScheduleReferenceDestination(input: AgentScheduleReferenceInput): {
  kind: AgentScheduleReference['destinationKind'];
  bindingDigest: string | null;
} {
  const kind = input.destinationKind ?? 'channel';
  const bindingDigest = input.destinationBindingDigest ?? null;
  if (kind === 'channel') {
    if (bindingDigest !== null) throw new Error('A Channel schedule cannot have a destination binding');
    return { kind, bindingDigest };
  }
  if (!/^[a-f0-9]{64}$/.test(bindingDigest ?? '')) {
    throw new Error('A direct schedule requires a valid destination binding');
  }
  return { kind, bindingDigest };
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

function rowToChannel(row: ChannelRow): ChannelConfig {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    revision: Number(row.revision ?? 1),
    ...(row.label ? { label: row.label } : {}),
    lifecycle: row.lifecycle === 'archived' ? 'archived' : 'active',
  };
}

function defaultChannelConfig(workspaceId: string, channelId: string): ChannelConfig {
  return {
    workspaceId,
    channelId,
    lifecycle: 'active',
  };
}

function channelFromSeedGrant(grant: AgentChannelGrantInput): ChannelConfig {
  return {
    ...defaultChannelConfig(grant.workspaceId, grant.channelId),
    ...(grant.channelLabel ? { label: grant.channelLabel } : {}),
  };
}

function countRows(db: StateDb, table: string): number {
  const row = db.get(`SELECT COUNT(*) AS count FROM ${table}`) as { count: number } | undefined;
  return row?.count ?? 0;
}
