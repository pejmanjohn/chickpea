import type { AgentReferenceSummary, CustomAgentConfig } from '../config/types.ts';
import type { OrganizationRole } from '../identity/types.ts';
import type { LiveManagementActor, ManagementOperation, ManagementOrigin } from './types.ts';

interface ManagementPolicyFacts {
  actor: LiveManagementActor;
  operation: ManagementOperation;
  currentAgent?: CustomAgentConfig;
  /** The role the target membership holds now, for an update_member. */
  currentMemberRole?: OrganizationRole;
  agentReferences?: AgentReferenceSummary;
  currentChannelLifecycle?: 'active' | 'archived';
  capabilityScopeExpanded?: boolean;
  /** The patch drops an existing MCP server or API connection entry. */
  connectionRemoved?: boolean;
  credentialReplacement?: boolean;
  agentEditable?: boolean;
  adminRequired?: boolean;
  /** The current tool contract represents an exact command from the requester. */
  approvalBasis?: 'explicit_requester_command';
  /** The service proved the operation is local and can be reversed exactly. */
  reversibleLocalChange?: boolean;
  /** The service derived this grant from the Slack Channel where it created the Agent. */
  trustedSlackOriginGrant?: boolean;
}

type ManagementPosture = 'immediate' | 'confirmation';
type ManagementDoor = ManagementOrigin['kind'];

/**
 * The changes the Admin UI asks "Are you sure?" about, and Agent deletion,
 * which it has no button for. Every door that lets a model act asks too; the
 * Admin UI asks in the browser before it calls the service.
 */
const DESTRUCTIVE = { slack: 'confirmation', mcp: 'confirmation', admin: 'immediate' } as const;
/** Slack's approval policy reviews these; MCP acts with the person's Admin authority. */
const REVIEWED_IN_SLACK = { slack: 'confirmation', mcp: 'immediate', admin: 'immediate' } as const;
const IMMEDIATE = { slack: 'immediate', mcp: 'immediate', admin: 'immediate' } as const;

const POSTURE = {
  agent_deletion: DESTRUCTIVE,
  irreversible_routine_delete: DESTRUCTIVE,
  membership_authority_change: DESTRUCTIVE,
  provider_credential_removal: DESTRUCTIVE,
  connection_removal: DESTRUCTIVE,
  disable_active_agent: DESTRUCTIVE,
  membership_role_change: REVIEWED_IN_SLACK,
  archive_agent_reach: REVIEWED_IN_SLACK,
  restore_agent_reach: REVIEWED_IN_SLACK,
  archive_channel: REVIEWED_IN_SLACK,
  expand_channel_reach: REVIEWED_IN_SLACK,
  revoke_channel_reach: REVIEWED_IN_SLACK,
  workspace_wide_agent_edit_authority: REVIEWED_IN_SLACK,
  schedule_agent_reassignment: REVIEWED_IN_SLACK,
  credential_replacement: REVIEWED_IN_SLACK,
  recipe_overwrite: REVIEWED_IN_SLACK,
  capability_scope_expansion: REVIEWED_IN_SLACK,
  capability_or_authority_change: REVIEWED_IN_SLACK,
  compound_agent_change: REVIEWED_IN_SLACK,
  skill_change: REVIEWED_IN_SLACK,
  base_agent_creation: IMMEDIATE,
  safe_reversible_schedule_change: IMMEDIATE,
  explicit_reversible_change: IMMEDIATE,
  source_channel_for_created_agent: IMMEDIATE,
  safe_reversible_change: IMMEDIATE,
} satisfies Record<string, Readonly<Record<ManagementDoor, ManagementPosture>>>;

type ManagementPolicyReason = keyof typeof POSTURE;

type ManagementPolicyDecision =
  | { allowed: false; reason: 'owner_required' | 'operational_access_required' }
  | { allowed: true; posture: ManagementPosture; reason: ManagementPolicyReason };

export function classifyManagementOperation(
  facts: ManagementPolicyFacts,
): ManagementPolicyDecision {
  const decision = managementPolicyReason(facts);
  if (!decision.allowed) return decision;
  return {
    allowed: true,
    posture: POSTURE[decision.reason][facts.actor.origin.kind],
    reason: decision.reason,
  };
}

function managementPolicyReason(
  facts: ManagementPolicyFacts,
):
  | Extract<ManagementPolicyDecision, { allowed: false }>
  | { allowed: true; reason: ManagementPolicyReason } {
  const { actor, operation } = facts;
  if (facts.adminRequired && actor.role !== 'admin' && actor.role !== 'owner') {
    return { allowed: false, reason: 'operational_access_required' };
  }
  if (facts.agentEditable === false) {
    return { allowed: false, reason: 'operational_access_required' };
  }
  if (operation.kind === 'update_member') {
    if (actor.role !== 'owner') return { allowed: false, reason: 'owner_required' };
    const removesAccess = operation.status === 'suspended' || operation.status === 'removed';
    const changesOwnership = operation.role !== undefined &&
      (operation.role === 'owner' || facts.currentMemberRole === 'owner');
    return {
      allowed: true,
      reason: removesAccess || changesOwnership ? 'membership_authority_change' : 'membership_role_change',
    };
  }
  if (operation.kind === 'remove_provider_credential') {
    return { allowed: true, reason: 'provider_credential_removal' };
  }
  if (operation.kind === 'delete_routine') {
    return { allowed: true, reason: 'irreversible_routine_delete' };
  }
  if (operation.kind === 'create_agent') {
    if (operation.agent.editPolicy === 'all_workspace_members') {
      return { allowed: true, reason: 'workspace_wide_agent_edit_authority' };
    }
    return { allowed: true, reason: 'base_agent_creation' };
  }
  if (operation.kind === 'save_routine' || operation.kind === 'run_routine') {
    return { allowed: true, reason: 'safe_reversible_schedule_change' };
  }
  if (operation.kind === 'reassign_routine_agent') {
    return { allowed: true, reason: 'schedule_agent_reassignment' };
  }
  if (operation.kind === 'delete_agent') {
    return { allowed: true, reason: 'agent_deletion' };
  }
  if (operation.kind === 'archive_agent') {
    return { allowed: true, reason: 'archive_agent_reach' };
  }
  if (operation.kind === 'restore_agent') {
    return { allowed: true, reason: 'restore_agent_reach' };
  }
  if (operation.kind === 'request_setup' && facts.credentialReplacement) {
    return { allowed: true, reason: 'credential_replacement' };
  }
  if (operation.kind === 'update_agent') {
    // A destructive edit keeps its confirmation even inside a recipe overwrite.
    if (facts.connectionRemoved) {
      return { allowed: true, reason: 'connection_removal' };
    }
    const disablingActive = facts.currentAgent?.enabled === true &&
      operation.patch.enabled === false &&
      Boolean(facts.agentReferences?.channelGrants.length);
    if (disablingActive) {
      return { allowed: true, reason: 'disable_active_agent' };
    }
    if (operation.confirmationReason === 'recipe_overwrite') {
      return { allowed: true, reason: 'recipe_overwrite' };
    }
    if (facts.capabilityScopeExpanded) {
      return { allowed: true, reason: 'capability_scope_expansion' };
    }
    const fields = Object.keys(operation.patch);
    if (fields.some((field) => [
      'apiConnections', 'mcpServers', 'repositories', 'editPolicy', 'slackPresence',
    ].includes(field))) {
      return { allowed: true, reason: 'capability_or_authority_change' };
    }
    if (fields.length > 1) {
      return { allowed: true, reason: 'compound_agent_change' };
    }
    if (fields.includes('skills')) {
      if (facts.approvalBasis === 'explicit_requester_command' &&
          facts.reversibleLocalChange === true) {
        return { allowed: true, reason: 'explicit_reversible_change' };
      }
      return { allowed: true, reason: 'skill_change' };
    }
  }
  if (operation.kind === 'put_channel' &&
      facts.currentChannelLifecycle === 'active' && operation.channel.lifecycle === 'archived') {
    return { allowed: true, reason: 'archive_channel' };
  }
  if (operation.kind === 'grant_agent_channel') {
    if (facts.trustedSlackOriginGrant) {
      return { allowed: true, reason: 'source_channel_for_created_agent' };
    }
    return { allowed: true, reason: 'expand_channel_reach' };
  }
  if (operation.kind === 'revoke_agent_channel') {
    return { allowed: true, reason: 'revoke_channel_reach' };
  }
  return { allowed: true, reason: 'safe_reversible_change' };
}
