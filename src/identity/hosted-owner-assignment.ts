/**
 * The operator-assisted path for a live installation with no active Owner.
 * A Slack deactivation keeps a sole Owner's role and suspends their access,
 * so nobody can perform an Owner's actions (role changes, reinstall,
 * recovery). The host's operator then makes an existing, active member
 * Owner. The change is audited as the operator's, with their evidence; the
 * previous Owner is left exactly as it was.
 *
 * Verifying the requester is the host's job, done before it calls this:
 * they signed in with Slack, and the installation's own bot reports them as
 * the workspace's Primary Owner or an Admin (`users.info`). Core checks only
 * what it holds: that no active, unsuspended Owner remains, and that the
 * named Slack account (team, user) is bound to the member being made Owner.
 *
 * A host serving many installations calls this from an operator job with
 * the installation's scoped env. Standalone keeps its own recovery path and
 * is refused.
 */
import { withBetterAuthAccessRevoker } from '../auth/better-auth-environment.ts';
import { InstallationContextError, requireInstallationScope } from '../config/installation-scope.ts';
import { getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import type { IdentityStore, Membership } from './types.ts';

export interface OperatorOwnerAssignmentInput {
  readonly membershipId: string;
  /**
   * The Slack account the host verified with Slack before calling. Core
   * checks only that it is bound to this member.
   */
  readonly slackTeamId: string;
  readonly slackUserId: string;
  /** Why, as an audit code (letters, digits, `._:/-`). */
  readonly reasonCode: string;
  /** The operator's evidence reference (job ID, digest), as an audit code. */
  readonly evidence: string;
  readonly correlationId: string;
  /** A retried job replays rather than repeating the change. */
  readonly idempotencyKey: string;
}

export interface OperatorOwnerAssignment {
  readonly membership: Membership;
  /** False on a replay of the same job. */
  readonly changed: boolean;
  /** Every Owner after the change, whatever their access, for the operator's record. */
  readonly owners: readonly Membership[];
}

/**
 * Make an existing, active member Owner on an operator's authority. Refused
 * while an active, unsuspended Owner remains (`active_owner_present`), when
 * the membership is not active (or its access is suspended), when the named
 * Slack account is not bound to that member, and on standalone. As any role
 * change does, the member's personal tokens, browser sessions and Better
 * Auth sessions end, so they sign in again as Owner; where the installation
 * signs people in through Better Auth and no backend serves this call,
 * nothing is changed.
 */
export async function assignInstallationOwnerByOperator(
  env: PlatformEnv,
  input: OperatorOwnerAssignmentInput,
  options: { identity?: IdentityStore } = {},
): Promise<OperatorOwnerAssignment> {
  if (!requireInstallationScope(env)) {
    throw new InstallationContextError(
      'installation_context_missing',
      'An operator assigns an Owner for one installation of a deployment serving many.',
    );
  }
  const identity = options.identity ?? getIdentityStore(env);
  const binding = (await identity.listExternalIdentities())
    .find((candidate) => candidate.membershipId === input.membershipId);
  const result = await withBetterAuthAccessRevoker(
    { control: await identity.getAuthControl(), platformEnv: env },
    async (revoker) => {
      const updated = await identity.updateMembershipAuthority({
        membershipId: input.membershipId,
        role: 'owner',
        authenticationSurface: 'host_operator',
        operatorEvidence: input.evidence,
        reasonCode: input.reasonCode,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        slackTeamId: input.slackTeamId,
        slackUserId: input.slackUserId,
      });
      if (updated.changed && binding?.betterAuthUserId && revoker) {
        await revoker.deleteSessionsForUser(binding.betterAuthUserId);
      }
      return updated;
    },
  );
  const owners = (await identity.listMemberships()).filter((membership) => membership.role === 'owner');
  return { membership: result.membership, changed: result.changed, owners };
}
