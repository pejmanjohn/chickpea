import { getBrowserAction, resolveBrowserActionReply } from '../../browser/actions.ts';
import type { SettingsStore } from '../../config/settings-store.ts';
import type { ResolvedAssignment } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import { resolveHostSlackManagementApproval } from '../../management/slack-approval.ts';
import type { ManagementStore } from '../../management/store.ts';
import { conversationThreadTs } from '../thread-key.ts';
import type { NormalizedSlackTurn } from '../types.ts';
import { approvalChoice } from './render.ts';
import type { UiSurfaceRecord } from './surface.ts';

/** Why a click did not become a turn; each maps to one private notice. */
export type UiRefusal = 'unavailable' | 'wrong_user' | 'not_current' | 'answered' | 'closed';

/**
 * A click travelling through ordinary Slack admission. The ingress starts
 * `outcome` at `unavailable`, so every early return in admission is a refusal;
 * admission sets a more specific refusal or `admitted`.
 */
export interface SlackUiAdmission {
  surface: UiSurfaceRecord;
  choice: number;
  /** Chosen option indexes, person/channel ids, or a date (questions). */
  values?: string[];
  outcome: 'admitted' | UiRefusal;
}

/**
 * Click-time authorization, after the clicker passed the same actor, route and
 * access gate as a typed message and before anything is consumed. Host
 * approvals re-run the exact rule the typed "approve" uses against the live
 * record, then stamp the approval; a `ui` surface can never stamp one.
 */
export async function authorizeUiResponse(input: {
  admission: SlackUiAdmission;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  actorMembershipId: string | undefined;
  stores: {
    identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
    management: Pick<ManagementStore, 'getActiveChangeSetProposal'>;
    settings: SettingsStore;
  };
}): Promise<UiRefusal | undefined> {
  const { admission, turn, assignment } = input;
  const { surface } = admission;
  if (assignment.agent.id !== surface.agentId) return 'closed';
  const spec = surface.spec;
  if (spec.kind === 'question' || spec.kind === 'actions' || spec.kind === 'cards') {
    // A model-chosen surface answers a question or asks for a next step; it
    // never stamps an approval, whatever its labels say.
    if (surface.namespace !== 'ui') return 'unavailable';
    const answerFrom = spec.kind === 'question' ? spec.question.answerFrom : 'thread';
    if (answerFrom === 'requester' && turn.userId !== surface.requesterUserId) return 'wrong_user';
    return undefined;
  }
  if (spec.kind !== 'approval' || surface.namespace !== 'host') return 'unavailable';
  if (turn.userId !== surface.requesterUserId) return 'wrong_user';
  const decision = approvalChoice(admission.choice);
  if (!decision) return 'unavailable';

  if (spec.approval === 'workspace_change') {
    if (!input.actorMembershipId) return 'unavailable';
    const proposalId = await resolveHostSlackManagementApproval({
      turn,
      assignment,
      actorMembershipId: input.actorMembershipId,
      identity: input.stores.identity,
      management: input.stores.management,
    });
    if (proposalId !== spec.proposalId) return 'not_current';
    if (decision === 'approve') turn.managementApprovalProposalId = proposalId;
    return undefined;
  }

  const record = await getBrowserAction(input.stores.settings, spec.browserActionId);
  if (!record || record.status !== 'pending' || record.expiresAt <= Date.now()) return 'not_current';
  if (record.actorSlackUserId !== turn.userId) return 'wrong_user';
  const answer = await resolveBrowserActionReply({
    settings: input.stores.settings,
    word: decision === 'approve' ? 'approve' : 'stop',
    scope: {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadTs: conversationThreadTs(turn, assignment.runtimeContract),
      agentId: assignment.agent.id,
      actorSlackUserId: turn.userId,
      ...(input.actorMembershipId ? { actorMembershipId: input.actorMembershipId } : {}),
    },
    messageTs: turn.messageTs,
  });
  if (answer.kind === 'none' || answer.id !== spec.browserActionId) return 'not_current';
  if (answer.kind === 'approved') turn.approvedBrowserActionId = answer.id;
  return undefined;
}

/** The private notice for a refused click. Mentions render names, never ping. */
export function uiRefusalText(refusal: UiRefusal, surface?: UiSurfaceRecord): string {
  switch (refusal) {
    case 'wrong_user':
      return surface
        ? `Only <@${surface.requesterUserId}> can answer this. You can reply in the thread.`
        : 'This isn\'t yours to answer. You can reply in the thread.';
    case 'answered': {
      const verb = surface?.spec.kind === 'actions' || surface?.spec.kind === 'cards' ? 'requested' : 'answered';
      return surface?.resolution
        ? `Already ${verb} by <@${surface.resolution.byUserId}>.`
        : `This was already ${verb}.`;
    }
    case 'not_current':
      return 'This is no longer current. Reply in the thread if you still need it.';
    case 'closed':
      return 'This has closed. Reply in the thread instead.';
    case 'unavailable':
      return 'This button isn\'t available right now. Reply in the thread instead.';
  }
}
