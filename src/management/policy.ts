import type { AgentReferenceSummary, CustomAgentConfig } from '../config/types.ts';
import type { LiveManagementActor, ManagementOperation } from './types.ts';

export interface ManagementPolicyFacts {
  actor: LiveManagementActor;
  operation: ManagementOperation;
  currentAgent?: CustomAgentConfig;
  agentReferences?: AgentReferenceSummary;
  currentChannelLifecycle?: 'active' | 'archived';
  capabilityScopeExpanded?: boolean;
  credentialReplacement?: boolean;
  agentEditable?: boolean;
  adminRequired?: boolean;
}

export type ManagementPolicyDecision =
  | { allowed: false; reason: 'owner_required' | 'operational_access_required' }
  | { allowed: true; posture: 'immediate' | 'confirmation'; reason: string };

export function classifyManagementOperation(
  facts: ManagementPolicyFacts,
): ManagementPolicyDecision {
  const { actor, operation } = facts;
  if (facts.adminRequired && actor.role !== 'admin' && actor.role !== 'owner') {
    return { allowed: false, reason: 'operational_access_required' };
  }
  if (facts.agentEditable === false) {
    return { allowed: false, reason: 'operational_access_required' };
  }
  if (operation.kind === 'update_member') {
    if (actor.role !== 'owner') return { allowed: false, reason: 'owner_required' };
    return {
      allowed: true,
      posture: 'confirmation',
      reason: 'membership_authority_change',
    };
  }
  if (operation.kind === 'remove_provider_credential') {
    return { allowed: true, posture: 'confirmation', reason: 'provider_credential_removal' };
  }
  if (operation.kind === 'delete_routine') {
    return { allowed: true, posture: 'confirmation', reason: 'irreversible_routine_delete' };
  }
  if (operation.kind === 'create_agent') {
    return { allowed: true, posture: 'confirmation', reason: 'agent_creation' };
  }
  if (operation.kind === 'save_routine') {
    return { allowed: true, posture: 'immediate', reason: 'safe_reversible_schedule_change' };
  }
  if (operation.kind === 'reassign_routine_agent') {
    return { allowed: true, posture: 'confirmation', reason: 'schedule_agent_reassignment' };
  }
  if (operation.kind === 'delete_agent') {
    return { allowed: true, posture: 'confirmation', reason: 'agent_deletion' };
  }
  if (operation.kind === 'archive_agent') {
    return { allowed: true, posture: 'confirmation', reason: 'archive_agent_reach' };
  }
  if (operation.kind === 'restore_agent') {
    return { allowed: true, posture: 'confirmation', reason: 'restore_agent_reach' };
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
      Boolean(facts.agentReferences?.channelGrants.length);
    if (disablingActive) {
      return { allowed: true, posture: 'confirmation', reason: 'disable_active_agent' };
    }
    if (facts.capabilityScopeExpanded) {
      return { allowed: true, posture: 'confirmation', reason: 'capability_scope_expansion' };
    }
    const fields = Object.keys(operation.patch);
    if (fields.includes('skills')) {
      return { allowed: true, posture: 'confirmation', reason: 'skill_change' };
    }
    if (fields.some((field) => [
      'apiConnections', 'mcpServers', 'repositories', 'editPolicy', 'slackPresence',
    ].includes(field))) {
      return { allowed: true, posture: 'confirmation', reason: 'capability_or_authority_change' };
    }
    if (fields.length > 1) {
      return { allowed: true, posture: 'confirmation', reason: 'compound_agent_change' };
    }
  }
  if (operation.kind === 'put_channel' &&
      facts.currentChannelLifecycle === 'active' && operation.channel.lifecycle === 'archived') {
    return { allowed: true, posture: 'confirmation', reason: 'archive_channel' };
  }
  if (operation.kind === 'grant_agent_channel') {
    return {
      allowed: true,
      posture: 'confirmation',
      reason: 'expand_channel_reach',
    };
  }
  if (operation.kind === 'revoke_agent_channel') {
    return { allowed: true, posture: 'confirmation', reason: 'revoke_channel_reach' };
  }
  return { allowed: true, posture: 'immediate', reason: 'safe_reversible_change' };
}
