import type { AgentReferenceSummary, CustomAgentConfig } from '../config/types.ts';
import type { MembershipStatus, OrganizationRole } from '../identity/types.ts';
import type { LiveManagementActor, ManagementOperation, ManagementOrigin } from './types.ts';

/** Suspending or removing a membership ends the person's access. */
export function removesMemberAccess(status: MembershipStatus | undefined): boolean {
  return status === 'suspended' || status === 'removed';
}

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
  /**
   * Every API connection and MCP server the patch adds or changes is new to
   * the Agent, needs a key it cannot have yet, and sends only to URLs the
   * requester typed in this Slack message.
   */
  requesterTypedNewKeyedConnections?: boolean;
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
  website_login_removal: DESTRUCTIVE,
  disable_active_agent: DESTRUCTIVE,
  membership_role_change: REVIEWED_IN_SLACK,
  archive_agent_reach: REVIEWED_IN_SLACK,
  restore_agent_reach: REVIEWED_IN_SLACK,
  archive_channel: REVIEWED_IN_SLACK,
  expand_channel_reach: REVIEWED_IN_SLACK,
  revoke_channel_reach: REVIEWED_IN_SLACK,
  workspace_wide_agent_edit_authority: REVIEWED_IN_SLACK,
  workspace_model_change: REVIEWED_IN_SLACK,
  schedule_agent_reassignment: REVIEWED_IN_SLACK,
  schedule_runs_as_takeover: REVIEWED_IN_SLACK,
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
  typed_new_keyed_connection: IMMEDIATE,
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
    const removesAccess = removesMemberAccess(operation.status);
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
  if (operation.kind === 'disconnect_connection') {
    return { allowed: true, reason: 'connection_removal' };
  }
  if (operation.kind === 'remove_website_login') {
    return { allowed: true, reason: 'website_login_removal' };
  }
  if (operation.kind === 'set_workspace_model') {
    return { allowed: true, reason: 'workspace_model_change' };
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
  if (operation.kind === 'take_over_routine') {
    return { allowed: true, reason: 'schedule_runs_as_takeover' };
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
    const fields = Object.keys(operation.patch);
    // A new connection that needs a key does nothing until a key arrives, and
    // a pasted key must be the requester's own (save_connection_key), so the
    // hosts they typed are all the approval card would have shown. Once web
    // content entered the conversation, its guide may be that content's
    // words, which the card shows.
    if (facts.requesterTypedNewKeyedConnections && facts.currentAgent?.kind === 'user' &&
        !(actor.origin.kind === 'slack' && actor.origin.publicDocRead) &&
        fields.every((field) => field === 'apiConnections' || field === 'mcpServers')) {
      return { allowed: true, reason: 'typed_new_keyed_connection' };
    }
    if (facts.capabilityScopeExpanded) {
      return { allowed: true, reason: 'capability_scope_expansion' };
    }
    if (fields.some((field) => [
      'apiConnections', 'mcpServers', 'repositories', 'editPolicy', 'slackPresence',
    ].includes(field))) {
      return { allowed: true, reason: 'capability_or_authority_change' };
    }
    // A model change that restores or sets its effort is one change.
    const changes = fields.filter((field) => field !== 'modelEffort' || !fields.includes('model'));
    if (changes.length > 1) {
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
