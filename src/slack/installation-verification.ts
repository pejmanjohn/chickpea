import {
  isTransientSlackApiError,
  slackBotIdentityInfo,
  slackConversationsList,
  slackIdentityAuthTest,
  slackUsersList,
  type SlackAuthTestResult,
  type SlackBotIdentityResult,
  type SlackConversationsListPage,
  type SlackUsersListPage,
} from './credentials.ts';
import { missingRequiredSlackBotScopes } from './scopes.ts';

const SLACK_APP_ID_PATTERN = /^A[A-Z0-9]{2,}$/;

export type SlackInstallationVerificationErrorCode =
  | 'slack_auth_failed'
  | 'slack_missing_scopes'
  | 'slack_scope_unverified'
  | 'slack_channel_list_failed'
  | 'slack_directory_list_failed'
  | 'slack_unreachable'
  | 'bot_token_required'
  | 'workspace_unverified'
  | 'workspace_mismatch'
  | 'app_mismatch'
  | 'bot_identity_missing'
  | 'app_identity_missing'
  | 'app_profile_unavailable';

export class SlackInstallationVerificationError extends Error {
  constructor(
    readonly code: SlackInstallationVerificationErrorCode,
    message: string,
    readonly missingScopes?: readonly string[],
    readonly detail?: string,
    readonly consoleUrl?: string,
  ) {
    super(message);
    this.name = 'SlackInstallationVerificationError';
  }
}

export interface ValidatedSlackInstallation {
  teamId: string;
  teamName?: string;
  appId: string;
  botUserId: string;
  grantedScopes: string[];
  botName?: string;
  displayName?: string;
  avatarUrl?: string;
  observedAt: number;
  consoleUrl: string;
}

export interface SlackInstallationVerificationDeps {
  authTest?: (botToken: string) => Promise<SlackAuthTestResult>;
  botIdentityInfo?: (
    botToken: string,
    botUserId: string,
  ) => Promise<SlackBotIdentityResult>;
  conversationsList?: (
    botToken: string,
    options?: { cursor?: string; limit?: number; timeoutMs?: number },
  ) => Promise<SlackConversationsListPage>;
  usersList?: (
    botToken: string,
    options?: { cursor?: string; limit?: number; timeoutMs?: number },
  ) => Promise<SlackUsersListPage>;
  now?: () => number;
}

export async function validateSlackBotInstallation(
  input: {
    expectedTeamId?: string;
    expectedAppId?: string;
    expectedBotUserId?: string;
    botToken: string;
    requireScopeEvidence?: boolean;
    requireChannelList?: boolean;
    requireDirectoryList?: boolean;
  },
  deps: SlackInstallationVerificationDeps = {},
): Promise<ValidatedSlackInstallation> {
  const authTest = deps.authTest ?? slackIdentityAuthTest;
  const botIdentityInfo = deps.botIdentityInfo ?? slackBotIdentityInfo;
  const conversationsList = deps.conversationsList ?? slackConversationsList;
  const usersList = deps.usersList ?? slackUsersList;
  let auth: SlackAuthTestResult;
  try {
    auth = await authTest(input.botToken);
  } catch {
    throw unavailable('Slack could not be reached while validating this installation');
  }
  if (!auth.ok) {
    if (isTransientSlackApiError(auth.error)) {
      throw unavailable('Slack could not be reached while validating this installation');
    }
    throw new SlackInstallationVerificationError(
      'slack_auth_failed',
      `Slack rejected this bot token${auth.error ? ` (${auth.error})` : ''}`,
      undefined,
      auth.error,
    );
  }
  const missingScopes = missingRequiredSlackBotScopes(auth.grantedScopes);
  if (input.requireScopeEvidence && auth.grantedScopes === undefined) {
    throw new SlackInstallationVerificationError(
      'slack_scope_unverified',
      'Slack did not return the installed permission scopes',
    );
  }
  if (missingScopes?.length) {
    throw new SlackInstallationVerificationError(
      'slack_missing_scopes',
      `Reinstall this Slack app to grant the required permissions: ${missingScopes.join(', ')}`,
      missingScopes,
      undefined,
      slackAppOAuthUrl(auth.appId),
    );
  }
  if (!auth.botId) {
    throw new SlackInstallationVerificationError(
      'bot_token_required',
      'The Slack connection requires a bot installation token',
    );
  }
  if (!auth.teamId) {
    throw new SlackInstallationVerificationError(
      'workspace_unverified',
      'Slack did not identify the installed workspace',
    );
  }
  if (input.expectedTeamId && auth.teamId !== input.expectedTeamId) {
    throw new SlackInstallationVerificationError(
      'workspace_mismatch',
      'This Slack app is installed in a different workspace',
    );
  }
  if (!auth.botUserId ||
      (input.expectedBotUserId && auth.botUserId !== input.expectedBotUserId)) {
    throw new SlackInstallationVerificationError(
      'bot_identity_missing',
      'Slack did not return the expected bot user',
    );
  }

  let profile: SlackBotIdentityResult;
  try {
    profile = await botIdentityInfo(input.botToken, auth.botUserId);
  } catch {
    throw unavailable('Slack could not be reached while loading the app profile');
  }
  if (!profile.ok) {
    if (isTransientSlackApiError(profile.error)) {
      throw unavailable('Slack could not be reached while loading the app profile');
    }
    throw new SlackInstallationVerificationError(
      'app_profile_unavailable',
      `Slack could not load the app profile${profile.error ? ` (${profile.error})` : ''}`,
    );
  }
  const appId = auth.appId ?? profile.appId;
  if (!appId || !SLACK_APP_ID_PATTERN.test(appId)) {
    throw new SlackInstallationVerificationError(
      'app_identity_missing',
      'Slack did not identify the installed app',
    );
  }
  if (input.expectedAppId && appId !== input.expectedAppId) {
    throw new SlackInstallationVerificationError(
      'app_mismatch',
      'Slack returned a different app than the installation being completed',
    );
  }

  if (input.requireChannelList) {
    await requireSlackList(
      () => conversationsList(input.botToken, { limit: 1 }),
      'channel',
      appId,
    );
  }
  if (input.requireDirectoryList) {
    await requireSlackList(
      () => usersList(input.botToken, { limit: 1 }),
      'directory',
      appId,
    );
  }

  const avatarUrl = sanitizeHttpsUrl(profile.avatarUrl);
  return {
    teamId: auth.teamId,
    ...(auth.teamName ? { teamName: auth.teamName } : {}),
    appId,
    botUserId: auth.botUserId,
    grantedScopes: auth.grantedScopes ?? [],
    ...(auth.botName ? { botName: auth.botName } : {}),
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    observedAt: (deps.now ?? Date.now)(),
    consoleUrl: slackAppConsoleUrl(appId),
  };
}

export function slackAppConsoleUrl(appId: string | undefined): string {
  return appId && SLACK_APP_ID_PATTERN.test(appId)
    ? `https://api.slack.com/apps/${appId}/general`
    : 'https://api.slack.com/apps';
}

export function slackAppOAuthUrl(appId: string | undefined): string | undefined {
  return appId && SLACK_APP_ID_PATTERN.test(appId)
    ? `https://api.slack.com/apps/${appId}/oauth`
    : undefined;
}

async function requireSlackList(
  load: () => Promise<SlackConversationsListPage | SlackUsersListPage>,
  kind: 'channel' | 'directory',
  appId: string,
): Promise<void> {
  let page: SlackConversationsListPage | SlackUsersListPage;
  try {
    page = await load();
  } catch {
    throw unavailable(`Slack could not be reached while checking ${kind} access`);
  }
  if (page.ok) return;
  if (isTransientSlackApiError(page.error)) {
    throw unavailable(`Slack could not be reached while checking ${kind} access`);
  }
  if (page.error === 'missing_scope') {
    throw new SlackInstallationVerificationError(
      'slack_missing_scopes',
      `Reinstall this Slack app to grant ${kind} access`,
      undefined,
      undefined,
      slackAppOAuthUrl(appId),
    );
  }
  if (page.error === 'invalid_auth' || page.error === 'token_revoked') {
    throw new SlackInstallationVerificationError(
      'slack_auth_failed',
      `Slack rejected this bot token while checking ${kind} access`,
      undefined,
      page.error,
    );
  }
  throw new SlackInstallationVerificationError(
    kind === 'channel' ? 'slack_channel_list_failed' : 'slack_directory_list_failed',
    `Slack could not list ${kind === 'channel' ? 'channels' : 'members'} for this installation`,
  );
}

function unavailable(message: string): SlackInstallationVerificationError {
  return new SlackInstallationVerificationError('slack_unreachable', message);
}

function sanitizeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
