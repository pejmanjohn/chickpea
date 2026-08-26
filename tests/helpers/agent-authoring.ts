import {
  AGENT_AUTHORING_GUIDE_VERSION,
  type AgentAuthoringReason,
} from '../../src/management/agent-authoring/index.ts';

export function authoringProposalMetadata(
  idempotencyKey: string,
  authoringReason: AgentAuthoringReason = 'agent_edit',
) {
  return {
    idempotencyKey,
    guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
    authoringReason,
  } as const;
}
