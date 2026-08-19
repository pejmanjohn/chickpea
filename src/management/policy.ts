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
  if (operation.kind === 'update_member') {
    return actor.role === 'owner'
      ? { allowed: true, posture: 'confirmation', reason: 'membership_authority_change' }
      : { allowed: false, reason: 'owner_required' };
  }
  if (operation.kind === 'delete_agent') {
    return { allowed: true, posture: 'confirmation', reason: 'agent_deletion' };
  }
  if (operation.kind === 'update_agent') {
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
