import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import type { SlackUserChangeEvent } from '../slack/types.ts';

const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;

export interface ApplySlackUserChangeInput {
  identity: IdentityStore;
  betterAuth?: Pick<BetterAuthDatabaseBackend, 'deleteSessionsForUser'>;
  credentialRevision: string;
  payloadTeamId: string;
  apiAppId: string;
  eventId: string;
  event: SlackUserChangeEvent;
}

export type SlackUserChangeResult = {
  outcome: 'suspended' | 'duplicate' | 'ignored';
};

/** Apply only a signed, exact-installation deactivation fact. Active payloads never reactivate authority. */
export async function applySlackUserChange(
  input: ApplySlackUserChangeInput,
): Promise<SlackUserChangeResult> {
  const user = input.event.user;
  if (!SLACK_ID.test(input.payloadTeamId) || !SLACK_ID.test(input.apiAppId) ||
      !SLACK_ID.test(user.id) || (user.team_id !== undefined && user.team_id !== input.payloadTeamId)) {
    return { outcome: 'ignored' };
  }
  if (user.deleted !== true && user.is_bot !== true && user.is_app_user !== true) {
    return { outcome: 'ignored' };
  }
  const active = await input.identity.getActiveSlackCredentialRevision(
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  );
  if (!active || active.status !== 'active' || active.purpose !== 'connected_credentials' ||
      active.revision !== input.credentialRevision || active.appId !== input.apiAppId ||
      active.teamId !== input.payloadTeamId) {
    return { outcome: 'ignored' };
  }
  const binding = await input.identity.resolveSlackIdentity(input.payloadTeamId, user.id);
  if (!binding) return { outcome: 'ignored' };
  const result = await input.identity.updateMembershipAuthority({
    membershipId: binding.membership.id,
    status: 'suspended',
    authenticationSurface: 'slack_event',
    correlationId: input.eventId,
    reasonCode: 'slack_user_deactivated',
    idempotencyKey: `slack-user-change:${input.eventId}`,
    slackTeamId: input.payloadTeamId,
    slackUserId: user.id,
    credentialRevision: active.revision,
  });
  if (!result.changed) return { outcome: 'duplicate' };
  await input.betterAuth?.deleteSessionsForUser(binding.binding.betterAuthUserId);
  return { outcome: 'suspended' };
}
