import type { ManagementChangeSetProposalRecord } from '../management/types.ts';
import { slackSessionGenerationFromTimestamp, type SlackStateStore } from '../slack/claim-store.ts';

/** Project only the retained turns admitted against this exact owned proposal. */
export async function readProposalApprovalStatus(
  state: Pick<SlackStateStore, 'listProposalApprovalTurns' | 'getRunPresentation'>,
  proposal: ManagementChangeSetProposalRecord,
  slackUserId: string | null,
) {
  const scope = /^slack:([A-Z0-9_]+):([A-Z0-9_]+):([0-9]+\.[0-9]{6}):agent:([a-zA-Z0-9_-]+)$/.exec(proposal.originKey);
  if (!scope || !slackUserId || !state.listProposalApprovalTurns || !state.getRunPresentation) return null;
  const readPresentation = state.getRunPresentation.bind(state);
  const query = { proposalId: proposal.proposalId, workspaceId: scope[1]!, channelId: scope[2]!,
    threadTs: scope[3]!, actingAgentId: scope[4]!, requesterUserId: slackUserId,
    requesterMembershipId: proposal.actorMembershipId };
  const turns = await state.listProposalApprovalTurns(query);
  if (turns.length > 2 || turns.some((turn) => (Object.keys(query) as Array<keyof typeof query>)
    .some((key) => turn[key] !== query[key]))) throw new Error('Unexpected approval turn scope.');
  return { ...query, turns: await Promise.all(turns.map(async (turn) => {
    const presentation = turn.runId ? await readPresentation(turn.runId) : undefined;
    const correlated = presentation?.schemaVersion === 3 && presentation.runId === turn.runId &&
      presentation.turnJobId === turn.turnJobId &&
      presentation.root.workspaceId === query.workspaceId && presentation.root.channelId === query.channelId &&
      presentation.root.threadTs === query.threadTs && presentation.root.requesterUserId === slackUserId &&
      presentation.sessionGeneration === slackSessionGenerationFromTimestamp(turn.messageTs);
    return {
      turnJobId: turn.turnJobId, runId: turn.runId, messageTs: turn.messageTs,
      status: turn.status, delivered: turn.delivered,
      activity: correlated ? { surface: presentation.activityProjection.surface,
        state: presentation.activityProjection.state, cleanup: presentation.cleanup.state,
        lifecycle: presentation.lifecyclePhase, sessionGeneration: presentation.sessionGeneration } : null,
    };
  })) };
}
