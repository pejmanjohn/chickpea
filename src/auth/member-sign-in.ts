import { createHash } from 'node:crypto';

import type { IdentityStore } from '../identity/types.ts';
import { IdentityStateError } from '../identity/errors.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import { installationBetterAuth } from './installation-better-auth.ts';
import { SLACK_OIDC_ATTEMPT_TTL_MS } from './slack-admission.ts';
import { SlackOidcError, type SlackOidcProof } from './slack-oidc.ts';

/**
 * Signs a person into the installation `identity` serves, for a host that
 * verified their Sign in with Slack with its own attempt (a discovery sign-in
 * kept in the host's registry, not an attempt in this store). Membership is
 * decided exactly as a standalone sign-in decides it: an active Owner, Admin
 * or Member who signed in before is signed in again, an active Member whom
 * Slack provisioned is bound to a browser identity on their first sign-in,
 * and anyone else is refused with `user_mismatch`; any other store failure
 * is thrown as it is. A proof the app's bot could not check
 * (`eligibility: 'install_grant'`) is refused.
 *
 * The host keeps `capability` (32+ random characters) with its own attempt;
 * the person's next sign-in replaces an unfinished one.
 */
export async function signInSlackMember(input: {
  identity: IdentityStore;
  environment: BetterAuthEnvironment;
  proof: SlackOidcProof;
  capability: string;
  request: Request;
  now?: () => number;
}): Promise<Response> {
  const { identity, proof } = input;
  if (proof.eligibility === 'install_grant') throw new SlackOidcError('inactive_user');
  if (input.capability.length < 32) throw new Error('The sign-in capability is too short.');
  const capabilityHash = createHash('sha256').update(input.capability).digest('hex');
  const auth = installationBetterAuth(identity, input.environment);
  const control = await identity.getAuthControl();
  if (!control?.canonicalAdminOrigin || control.canonicalAdminOrigin !== auth.origin ||
      !control.betterAuthOrganizationId) {
    throw new SlackOidcError('stale_revision');
  }
  let operation;
  try {
    operation = await identity.admitSlackLogin({
      capabilityHash,
      slackTeamId: proof.slackTeamId,
      slackUserId: proof.slackUserId,
      expiresAt: (input.now ?? Date.now)() + SLACK_OIDC_ATTEMPT_TTL_MS,
    });
  } catch (error) {
    // Not admissible here: no active membership, or no authority to sign in with.
    if (error instanceof IdentityStateError && error.code === 'auth_operation_unavailable') {
      throw new SlackOidcError('user_mismatch');
    }
    throw error;
  }
  if (operation.status !== 'active') {
    const organization = await identity.getOrganization();
    if (!organization || organization.id !== operation.organizationId) throw new SlackOidcError('invalid_state');
    // The installation's Better Auth organization, as activateInstallerOwner named it.
    const reconciled = await auth.reconcileSlackIdentity({
      slackTeamId: proof.slackTeamId,
      slackUserId: proof.slackUserId,
      displayName: proof.displayName,
      organization: {
        id: control.betterAuthOrganizationId,
        name: organization.displayName,
        slug: `chickpea-${organization.id}`,
      },
    });
    await identity.bindSlackLoginBrowserIdentity({
      operationId: operation.id,
      capabilityHash,
      slackTeamId: proof.slackTeamId,
      slackUserId: proof.slackUserId,
      betterAuthUserId: reconciled.userId,
      betterAuthOrganizationId: reconciled.organizationId,
      betterAuthMembershipId: reconciled.membershipId,
      ...(proof.contactEmail === undefined ? {} : { contactEmail: proof.contactEmail }),
    });
  }
  return auth.issueSession(operation.id, input.request);
}
