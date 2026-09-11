import { DisabledAgentError, NoAssignmentError } from './errors.ts';
import {
  resolveAgentModelRoleFromStore,
  resolveModelPolicyForAssignment,
  type ModelRoleResolution,
} from './model-policy.ts';
import {
  type AgentChannelGrant,
  type AgentModelRole,
  type ChannelConfig,
  type CustomAgentConfig,
  type NonChatModelRole,
  type ResolvedAssignment,
  type WorkspaceInstallation,
  type WorkspaceModelDefault,
  type WorkspaceModelRole,
} from './types.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';

// Store readers are async — the Cloudflare backend answers over Durable
// Object RPC — and the Node SQLite stores resolve immediately.
interface AgentReader {
  getAgent(agentId: string): Promise<CustomAgentConfig>;
}

// A turn's surface. The global '*,*' wildcard assignment is the default for
// DIRECT conversations only: a direct message is a separate
// surface, not a channel that access attaches to. CHANNELS are fail-closed —
// they resolve only via an explicit (exact / workspace / channel) assignment
// and never fall through to the global wildcard.
export type AssignmentSurface = 'channel' | 'direct';

interface AssignmentLookupOptions {
  surface?: AssignmentSurface;
  env?: NodeJS.ProcessEnv;
}

// Infer the surface from a channel id, for the paths that resolve from a thread
// key rather than a live turn (the durable agent and admin). Prefer the live
// turn's authoritative source/channel_type when available (see turnSurface in
// the Slack channel) — this id heuristic is the fallback.
//
// Slack 1:1 DM channel ids are 'D…'; public channels are 'C…'.
// A 'G…' id is ambiguous — legacy private channel vs group DM (mpim) — and the
// app_mention event carries no channel_type to disambiguate, so it is treated
// as a channel: the fail-closed default (better to require an explicit
// assignment than to let a private channel answer via the DM wildcard). The
// literal '*' key is the direct-message default row itself.
export function surfaceForChannelId(channelId: string): AssignmentSurface {
  if (channelId === '*') {
    return 'direct';
  }
  return channelId.startsWith('D') ? 'direct' : 'channel';
}

interface GrantReader {
  listAgentChannelGrants(
    workspaceId?: string,
    channelId?: string,
  ): Promise<AgentChannelGrant[]>;
  getWorkspaceInstallation(workspaceId: string): Promise<WorkspaceInstallation | undefined>;
  getWorkspaceModelDefault?(workspaceId: string): Promise<WorkspaceModelDefault | undefined>;
  getWorkspaceModelRole?(
    workspaceId: string,
    role: NonChatModelRole,
  ): Promise<WorkspaceModelRole | undefined>;
  getAgentModelRole?(
    agentId: string,
    role: NonChatModelRole,
  ): Promise<AgentModelRole | undefined>;
}

export interface ConfigStores {
  agents: AgentReader;
  grants: GrantReader;
  channels?: ChannelReader;
}

interface ChannelReader {
  getChannel(workspaceId: string, channelId: string): Promise<ChannelConfig | undefined>;
}

export async function resolveAssignment(
  workspaceId: string,
  channelId: string,
  stores: ConfigStores,
  options: AssignmentLookupOptions & { agentId?: string } = {},
): Promise<ResolvedAssignment> {
  const surface = options.surface ?? surfaceForChannelId(channelId);
  const installation = await stores.grants.getWorkspaceInstallation(workspaceId);
  const activeGrants = surface === 'channel'
    ? (await stores.grants.listAgentChannelGrants(workspaceId, channelId))
      .filter(({ status }) => status === 'active')
    : [];
  const agentId = options.agentId ?? (
    surface === 'direct'
      ? installation?.defaultAgentId
      : activeGrants.length === 1 ? activeGrants[0]?.agentId : undefined
  );
  if (!agentId || (surface === 'channel' && !activeGrants.some((grant) => grant.agentId === agentId))) {
    throw new NoAssignmentError(`No active Agent grant for ${workspaceId}/${channelId}`);
  }

  const agent = await stores.agents.getAgent(agentId);
  if (!agent.enabled) {
    throw new DisabledAgentError(agent.id);
  }

  const channelReader = stores.channels ?? channelReaderFromGrants(stores.grants);
  const channel = channelReader ? await channelReader.getChannel(workspaceId, channelId) : undefined;
  if (channel?.lifecycle === 'archived') {
    throw new NoAssignmentError(`Channel ${workspaceId}/${channelId} is archived`);
  }

  const assignment: ResolvedAssignment = {
    workspaceId,
    channelId,
    agentId: agent.id,
    ...(channel?.label ? { channelLabel: channel.label } : {}),
    ...(channel?.revision ? { channelRevision: channel.revision } : {}),
    agent,
  };
  return resolveModelPolicyForAssignment(assignment, {
    getWorkspaceInstallation: (id) => stores.grants.getWorkspaceInstallation(id),
    getWorkspaceModelDefault: (id) =>
      stores.grants.getWorkspaceModelDefault?.(id) ?? Promise.resolve(undefined),
  }, options.env, installation);
}

function channelReaderFromGrants(grants: GrantReader): ChannelReader | undefined {
  const candidate = grants as GrantReader & Partial<ChannelReader>;
  return typeof candidate.getChannel === 'function' ? candidate as ChannelReader : undefined;
}

/**
 * Resolve one non-chat model role for an already-resolved assignment. Kept
 * beside assignment resolution so the compile path and the tool's call-time
 * lookup read the same rows through the same seam; a store that predates the
 * role tables (a narrow test double) resolves to unset rather than throwing.
 */
export async function resolveAssignmentModelRole(
  assignment: Pick<ResolvedAssignment, 'workspaceId' | 'agent'>,
  stores: ConfigStores,
  role: NonChatModelRole,
  options: { env?: PlatformEnv; settings?: SettingsStore } = {},
): Promise<ModelRoleResolution> {
  const { getWorkspaceModelRole, getAgentModelRole } = stores.grants;
  if (!getWorkspaceModelRole || !getAgentModelRole) {
    return { unset: true, reason: 'role_unset' };
  }
  return resolveAgentModelRoleFromStore({
    role,
    workspaceId: assignment.workspaceId,
    agent: assignment.agent,
    reader: {
      getWorkspaceModelRole: (id, wanted) => getWorkspaceModelRole.call(stores.grants, id, wanted),
      getAgentModelRole: (id, wanted) => getAgentModelRole.call(stores.grants, id, wanted),
    },
    ...(options.env ? { env: options.env } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
  });
}
