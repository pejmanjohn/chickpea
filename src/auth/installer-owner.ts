import { createHash } from 'node:crypto';

import type { IdentityStore } from '../identity/types.ts';
import { createBetterAuth } from './better-auth.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import { activeAdmission } from './slack-admission.ts';
import { SlackOidcError, type SlackOidcProof } from './slack-oidc.ts';

const OPERATION_TTL_MS = 15 * 60_000;

/** What a host verified from the app's install grant (`authed_user.id`). */
export interface SlackInstallGrant {
  slackTeamId: string;
  installerSlackUserId: string;
}

/**
 * A host serving many installations makes the person who installed the app
 * the installation's first Owner, then signs them in. It holds `capability`,
 * a secret it keeps with its install attempt, so a retry after a crash
 * resumes the same operation rather than starting a second claim.
 *
 * The Sign in with Slack proof and the install grant must name the same
 * person in the same workspace. A proof the app's bot could not check yet
 * (`eligibility: 'install_grant'`) is admitted only here, by that grant.
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
  const { identity, proof, installGrant } = input;
  if (proof.slackTeamId !== installGrant.slackTeamId ||
      proof.slackUserId !== installGrant.installerSlackUserId) {
    throw new SlackOidcError('user_mismatch');
  }
  if (input.capability.length < 32) throw new Error('The install capability is too short.');
  const capabilityHash = sha256(input.capability);
  const operationId = `authop_installer_${sha256(`installer-owner:${input.capability}`).slice(0, 32)}`;

  const control = await identity.ensureAuthControl();
  if (control.canonicalAdminOrigin && control.canonicalAdminOrigin !== input.environment.baseURL) {
    throw new Error('This installation is pinned to another Admin origin.');
  }
  if (!control.canonicalAdminOrigin) {
    await identity.updateAuthControl({
      expectedRevision: control.revision,
      canonicalAdminOrigin: input.environment.baseURL,
    });
  }

  const organization = await identity.ensureOrganization({
    displayName: 'Chickpea',
    slackTeamId: proof.slackTeamId,
  });
  const operation = await identity.getAuthOperation(operationId) ?? await identity.createAuthOperation({
    id: operationId,
    kind: 'first_owner_claim',
    organizationId: organization.id,
    expectedSlackTeamId: proof.slackTeamId,
    expectedSlackUserId: proof.slackUserId,
    chickpeaRole: 'owner',
    capabilityHash,
    expiresAt: (input.now ?? Date.now)() + OPERATION_TTL_MS,
  });
  const auth = createBetterAuth({
    ...input.environment,
    privateSeam: {
      resolveAdmissionOperation: async (id) => activeAdmission(await identity.getAuthOperation(id)),
    },
  });

  if (operation.status !== 'active') {
    await identity.createOwnerClaim({
      operationId,
      slackTeamId: proof.slackTeamId,
      slackUserId: proof.slackUserId,
      organizationId: organization.id,
    });
    const reconciled = await auth.chickpea.reconcileSlackIdentity({
      slackTeamId: proof.slackTeamId,
      slackUserId: proof.slackUserId,
      displayName: proof.displayName,
      organization: {
        name: organization.displayName,
        slug: `chickpea-${proof.slackTeamId.toLowerCase()}`,
      },
      ...(operation.betterAuthUserId ? { expectedUserId: operation.betterAuthUserId } : {}),
    });
    await identity.advanceAuthOperation({
      operationId,
      capabilityHash,
      step: operation.step + 1,
      betterAuthUserId: reconciled.userId,
      betterAuthOrganizationId: reconciled.organizationId,
      betterAuthMembershipId: reconciled.membershipId,
    });
    await identity.claimOwner({
      operationId,
      organizationId: organization.id,
      slackTeamId: proof.slackTeamId,
      slackUserId: proof.slackUserId,
      displayName: proof.displayName,
      betterAuthUserId: reconciled.userId,
      betterAuthMembershipId: reconciled.membershipId,
    });
  }
  const response = await auth.chickpea.issueSession(operationId, input.request);
  if (!response.ok) throw new SlackOidcError('session_unavailable');
  return response;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
