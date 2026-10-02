import type { AuthOperation } from '../identity/types.ts';
import type { BetterAuthAdmissionOperation } from './better-auth.ts';

/** The admission a session may be issued for: an activated operation, fully reconciled. */
export function activeAdmission(operation: AuthOperation | undefined): BetterAuthAdmissionOperation | null {
  if (!operation || operation.status !== 'active' || !operation.chickpeaRole ||
      !operation.betterAuthUserId || !operation.betterAuthOrganizationId ||
      !operation.betterAuthMembershipId || !operation.chickpeaMembershipId) return null;
  return {
    operationId: operation.id,
    status: operation.status,
    chickpeaRole: operation.chickpeaRole,
    slackTeamId: operation.expectedSlackTeamId,
    slackUserId: operation.expectedSlackUserId,
    betterAuthUserId: operation.betterAuthUserId,
    betterAuthOrganizationId: operation.betterAuthOrganizationId,
    betterAuthMembershipId: operation.betterAuthMembershipId,
  };
}
