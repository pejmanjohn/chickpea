import type { IdentityResolution, IdentityStore } from '../../src/identity/types.ts';

export async function createSlackOwner(
  identity: IdentityStore,
  options: {
    now?: number; teamId?: string; userId?: string; suffix?: string;
    betterAuthUserId?: string; betterAuthOrganizationId?: string;
    betterAuthMembershipId?: string;
  } = {},
): Promise<IdentityResolution> {
  const now = options.now ?? Date.now();
  const teamId = options.teamId ?? 'T12345678';
  const userId = options.userId ?? 'U12345678';
  const suffix = options.suffix ?? 'owner';
  const betterAuthUserId = options.betterAuthUserId ?? `ba_user_${suffix}`;
  const betterAuthOrganizationId = options.betterAuthOrganizationId ??
    '11111111-1111-4111-8111-111111111111';
  const betterAuthMembershipId = options.betterAuthMembershipId ?? `ba_member_${suffix}`;
  const capabilityHash = Buffer.from(`capability:${suffix}`).toString('hex').padEnd(64, '0').slice(0, 64);
  const operation = await identity.createAuthOperation({
    id: `first_owner_${suffix}`,
    kind: 'first_owner_claim',
    expectedSlackTeamId: teamId,
    expectedSlackUserId: userId,
    chickpeaRole: 'owner',
    capabilityHash,
    expiresAt: now + 60_000,
  });
  await identity.createOwnerClaim({ operationId: operation.id, slackTeamId: teamId, slackUserId: userId });
  await identity.advanceAuthOperation({
    operationId: operation.id,
    capabilityHash,
    step: 1,
    betterAuthUserId,
    betterAuthOrganizationId,
    betterAuthMembershipId,
  });
  return identity.claimOwner({
    operationId: operation.id,
    organizationId: 'org_oss',
    slackTeamId: teamId,
    slackUserId: userId,
    displayName: 'Owner',
    betterAuthUserId,
    betterAuthMembershipId,
  });
}
