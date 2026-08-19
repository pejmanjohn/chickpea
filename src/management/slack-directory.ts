import type { PlatformEnv } from '../config/state-backend.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import { slackDirectoryUserInfo } from '../slack/credentials.ts';
import { resolveSlackIdentityCredentials } from '../slack/identity-credentials.ts';
import { classifySlackUserForAdmission } from '../slack/user-classification.ts';
import { ManagementError } from './types.ts';

/** Resolve one verified, eligible Slack human without exposing bot credentials. */
export async function resolveEligibleSlackInvitee(
  slackUserId: string,
  env: PlatformEnv | undefined,
  identity: IdentityStore,
): Promise<{ slackTeamId: string; displayName: string | null }> {
  const organization = await identity.getOrganization();
  if (!organization?.slackTeamId) throw unavailable();
  let credentials;
  try {
    credentials = await resolveSlackIdentityCredentials(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      env,
      { state: identity, ...(env ? { env } : {}) },
    );
  } catch {
    throw unavailable();
  }
  if (!credentials.botToken || !credentials.botUserId) throw unavailable();
  const result = await slackDirectoryUserInfo(credentials.botToken, slackUserId, {
    timeoutMs: 10_000,
  }).catch(() => undefined);
  if (!result?.ok || !result.member ||
      classifySlackUserForAdmission(
        result.member,
        organization.slackTeamId,
        credentials.botUserId,
      ) !== 'eligible_human') {
    throw unavailable();
  }
  return {
    slackTeamId: organization.slackTeamId,
    displayName: result.member.displayName || result.member.realName || null,
  };
}

function unavailable(): ManagementError {
  return new ManagementError('invalid_request', 'The Slack member is unavailable.');
}
