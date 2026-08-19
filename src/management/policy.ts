import type { AgentReferenceSummary, CustomAgentConfig } from '../config/types.ts';
import type { LiveManagementActor, ManagementOperation } from './types.ts';

export interface ManagementPolicyFacts {
  actor: LiveManagementActor;
  operation: ManagementOperation;
  currentAgent?: CustomAgentConfig;
  agentReferences?: AgentReferenceSummary;
  currentChannelLifecycle?: 'active' | 'archived';
  initialAgentBundle?: boolean;
  capabilityScopeExpanded?: boolean;
  credentialReplacement?: boolean;
}

export type ManagementPolicyDecision =
  | { allowed: false; reason: 'owner_required' | 'operational_access_required' }
  | { allowed: true; posture: 'immediate' | 'confirmation'; reason: string };

export function classifyManagementOperation(
  facts: ManagementPolicyFacts,
): ManagementPolicyDecision {
  const { actor, operation } = facts;
  if (actor.role !== 'admin' && actor.role !== 'owner') {
    return { allowed: false, reason: 'operational_access_required' };
  }
  if (operation.kind === 'update_member' || operation.kind === 'invite_member' ||
      operation.kind === 'revoke_invitation') {
    if (actor.role !== 'owner') return { allowed: false, reason: 'owner_required' };
    if (operation.kind === 'invite_member') {
      return { allowed: true, posture: 'immediate', reason: 'member_invitation' };
    }
    return {
      allowed: true,
      posture: 'confirmation',
      reason: operation.kind === 'revoke_invitation'
        ? 'invitation_revocation'
        : 'membership_authority_change',
    };
  }
  if (operation.kind === 'remove_provider_credential') {
    return { allowed: true, posture: 'confirmation', reason: 'provider_credential_removal' };
  }
  if (operation.kind === 'retire_slack_identity' ||
      operation.kind === 'cancel_slack_identity_setup') {
    return {
      allowed: true,
      posture: 'confirmation',
      reason: operation.kind === 'retire_slack_identity'
        ? 'slack_identity_retirement'
        : 'slack_identity_setup_cancellation',
    };
  }
  if (operation.kind === 'forget_memory_entry') {
    return { allowed: true, posture: 'confirmation', reason: 'irreversible_memory_forget' };
  }
  if (operation.kind === 'delete_routine') {
    return { allowed: true, posture: 'confirmation', reason: 'irreversible_routine_delete' };
  }
  if (operation.kind === 'delete_agent') {
    return { allowed: true, posture: 'confirmation', reason: 'agent_deletion' };
  }
  if (operation.kind === 'request_setup' && facts.credentialReplacement) {
    return { allowed: true, posture: 'confirmation', reason: 'credential_replacement' };
  }
  if (operation.kind === 'update_agent') {
    if (operation.confirmationReason === 'recipe_overwrite') {
      return { allowed: true, posture: 'confirmation', reason: 'recipe_overwrite' };
    }
    const disablingActive = facts.currentAgent?.enabled === true &&
      operation.patch.enabled === false &&
      Boolean(facts.agentReferences?.channelAssignments.length ||
        facts.agentReferences?.dmIdentityIds.length);
    if (disablingActive) {
      return { allowed: true, posture: 'confirmation', reason: 'disable_active_agent' };
    }
    if (facts.capabilityScopeExpanded) {
      return { allowed: true, posture: 'confirmation', reason: 'capability_scope_expansion' };
    }
  }
  if (operation.kind === 'put_channel' &&
      facts.currentChannelLifecycle === 'active' && operation.channel.lifecycle === 'archived') {
    return { allowed: true, posture: 'confirmation', reason: 'archive_channel' };
  }
  if (operation.kind === 'place_agent') {
    const removing = operation.agentId === null;
    if (removing || !facts.initialAgentBundle) {
      return {
        allowed: true,
        posture: 'confirmation',
        reason: removing ? 'remove_channel_placement' : 'expand_channel_placement',
      };
    }
  }
  return { allowed: true, posture: 'immediate', reason: 'safe_reversible_change' };
}
