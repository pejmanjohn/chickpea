import { createHash } from 'node:crypto';

import type { IdentityStore } from '../identity/types.ts';
import { IdentityStateError } from '../identity/errors.ts';
import { activeAdmission } from './admission-operation.ts';
import { createBetterAuth, requireSupportedOrigin } from './better-auth.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import { SLACK_OIDC_ATTEMPT_TTL_MS } from './slack-admission.ts';
import { SlackOidcError, type SlackOidcProof } from './slack-oidc.ts';

/** What a host verified from the app's install grant (`team.id`, `authed_user.id`). */
export interface SlackInstallGrant {
  slackTeamId: string;
  installerSlackUserId: string;
}

/**
 * Makes the person who installed the app the installation's first Owner and
 * signs them in, for a host serving many installations. The Sign in with Slack
 * proof and the install grant must name the same person in the same
 * workspace; a proof the app's bot could not check yet
 * (`eligibility: 'install_grant'`) is admitted only here.
 *
 * The host keeps `capability` (32+ random characters) with its install
 * attempt: a retry with it resumes the same reservation, and the same
 * person's new attempt replaces it. An installation that already has this
 * Owner signs them in again; anyone else is refused (`owner_already_claimed`,
 * or `owner_claim_conflict` while another person's reservation stands).
 */
export async function activateInstallerOwner(input: {
  identity: IdentityStore;
  environment: BetterAuthEnvironment;
  proof: SlackOidcProof;
  installGrant: SlackInstallGrant;
  capability: string;
  request: Request;
  now?: () => number;
}): Promise<Response> {
  const { identity, proof } = input;
  if (proof.slackTeamId !== input.installGrant.slackTeamId ||
      proof.slackUserId !== input.installGrant.installerSlackUserId) {
    throw new SlackOidcError('user_mismatch');
  }
  if (input.capability.length < 32) throw new Error('The install capability is too short.');
  const capabilityHash = createHash('sha256').update(input.capability).digest('hex');
  const origin = requireSupportedOrigin(input.environment.baseURL);
  const claim = await identity.getOwnerClaim();
  if (claim?.status === 'active' &&
      (claim.slackTeamId !== proof.slackTeamId || claim.slackUserId !== proof.slackUserId)) {
    throw new IdentityStateError('owner_already_claimed', 'The first Owner has already been claimed.');
  }
  // Built only once a session or reconcile needs it, so a refusal starts nothing.
  let auth: ReturnType<typeof createBetterAuth> | undefined;
  const betterAuth = () => auth ??= createBetterAuth({
    ...input.environment,
    baseURL: origin,
    privateSeam: {
      resolveAdmissionOperation: async (id) => activeAdmission(await identity.getAuthOperation(id)),
    },
  });
  const issue = async (operationId: string) => {
    const response = await betterAuth().chickpea.issueSession(operationId, input.request);
    if (!response.ok) throw new SlackOidcError('session_unavailable');
    return response;
  };
  const control = await identity.ensureAuthControl();
  if (control.canonicalAdminOrigin && control.canonicalAdminOrigin !== origin) {
    throw new Error('This installation is pinned to another Admin origin.');
  }
  if (claim?.status === 'active') {
    const membership = claim.membershipId ? await identity.getMembership(claim.membershipId) : undefined;
    if (membership?.status !== 'active') throw new SlackOidcError('inactive_user');
    return issue(claim.operationId);
  }
  if (!control.canonicalAdminOrigin) {
    await identity.updateAuthControl({ expectedRevision: control.revision, canonicalAdminOrigin: origin });
  }
  const organization = await identity.ensureOrganization({
    displayName: 'Chickpea',
    slackTeamId: proof.slackTeamId,
  });
  const operation = await identity.reserveInstallerOwner({
    kind: 'first_owner_claim',
    organizationId: organization.id,
    expectedSlackTeamId: proof.slackTeamId,
    expectedSlackUserId: proof.slackUserId,
    chickpeaRole: 'owner',
    capabilityHash,
    expiresAt: (input.now ?? Date.now)() + SLACK_OIDC_ATTEMPT_TTL_MS,
  });
  // Named after the installation's organization, not the Slack team, so a
  // workspace that reinstalls into a new installation gets a new one.
  const reconciled = await betterAuth().chickpea.reconcileSlackIdentity({
    slackTeamId: proof.slackTeamId,
    slackUserId: proof.slackUserId,
    displayName: proof.displayName,
    organization: { name: organization.displayName, slug: `chickpea-${organization.id}` },
    ...(operation.betterAuthUserId ? { expectedUserId: operation.betterAuthUserId } : {}),
  });
  await identity.advanceAuthOperation({
    operationId: operation.id,
    capabilityHash,
    step: operation.step + 1,
    betterAuthUserId: reconciled.userId,
    betterAuthOrganizationId: reconciled.organizationId,
    betterAuthMembershipId: reconciled.membershipId,
  });
  await identity.claimOwner({
    operationId: operation.id,
    organizationId: organization.id,
    slackTeamId: proof.slackTeamId,
    slackUserId: proof.slackUserId,
    displayName: proof.displayName,
    betterAuthUserId: reconciled.userId,
    betterAuthMembershipId: reconciled.membershipId,
  });
  return issue(operation.id);
}
