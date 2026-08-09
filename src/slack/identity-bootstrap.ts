import { SlackIdentityRevisionConflictError } from '../config/errors.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import type { SlackIdentity } from '../config/types.ts';
import {
  slackBotIdentityInfo,
  slackConversationsList,
  slackIdentityAuthTest,
  type SlackAuthTestResult,
  type SlackBotIdentityResult,
  type SlackConversationsListPage,
} from './credentials.ts';
import {
  resolveSlackIdentityCredentials,
  writeSlackIdentityCredentials,
} from './identity-credentials.ts';
import {
  cancelPendingSlackIdentitySecrets,
  purgePendingSlackChallenge,
  verifyPendingSlackChallenge,
} from './identity-handshake.ts';
import { missingRequiredSlackBotScopes } from './scopes.ts';

const SLACK_APP_ID_PATTERN = /^A[A-Z0-9]{2,}$/;

export type SlackIdentityBootstrapErrorCode =
  | 'identity_not_dedicated'
  | 'identity_not_connectable'
  | 'slack_auth_failed'
  | 'slack_missing_scopes'
  | 'slack_scope_unverified'
  | 'slack_channel_list_failed'
  | 'slack_unreachable'
  | 'bot_token_required'
  | 'workspace_unverified'
  | 'workspace_mismatch'
  | 'app_mismatch'
  | 'bot_identity_missing'
  | 'app_identity_missing'
  | 'app_already_connected'
  | 'identity_profile_unavailable'
  | 'credentials_missing'
  | 'challenge_missing'
  | 'challenge_expired'
  | 'challenge_invalid_signature'
  | 'signing_secret_change_requires_reconnect';

export class SlackIdentityBootstrapError extends Error {
  constructor(
    readonly code: SlackIdentityBootstrapErrorCode,
    message: string,
    readonly missingScopes?: readonly string[],
    readonly detail?: string,
    readonly consoleUrl?: string,
  ) {
    super(message);
    this.name = 'SlackIdentityBootstrapError';
  }
}

export interface ValidatedSlackIdentityInstallation {
  teamId: string;
  teamName?: string;
  appId: string;
  botUserId: string;
  botName?: string;
  displayName?: string;
  avatarUrl?: string;
  observedAt: number;
  consoleUrl: string;
}

export interface SlackIdentityHealthResult {
  identity: SlackIdentity;
  consoleUrl: string;
}

export interface SlackIdentityBootstrapDeps {
  authTest?: (botToken: string) => Promise<SlackAuthTestResult>;
  botIdentityInfo?: (
    botToken: string,
    botUserId: string,
  ) => Promise<SlackBotIdentityResult>;
  conversationsList?: (
    botToken: string,
    options?: { cursor?: string; limit?: number; timeoutMs?: number },
  ) => Promise<SlackConversationsListPage>;
  now?: () => number;
}

export async function validateSlackIdentityBotInstallation(
  input: {
    config: ConfigStore;
    identityId: string;
    expectedTeamId?: string;
    botToken: string;
    requireScopeEvidence?: boolean;
    requireChannelList?: boolean;
  },
  deps: SlackIdentityBootstrapDeps = {},
): Promise<ValidatedSlackIdentityInstallation> {
  const authTest = deps.authTest ?? slackIdentityAuthTest;
  const botIdentityInfo = deps.botIdentityInfo ?? slackBotIdentityInfo;
  const conversationsList = deps.conversationsList ?? slackConversationsList;
  let auth: SlackAuthTestResult;
  try {
    auth = await authTest(input.botToken);
  } catch {
    throw new SlackIdentityBootstrapError(
      'slack_unreachable',
      'Slack could not be reached while validating this identity',
    );
  }
  if (!auth.ok) {
    throw new SlackIdentityBootstrapError(
      'slack_auth_failed',
      `Slack rejected this bot token${auth.error ? ` (${auth.error})` : ''}`,
      undefined,
      auth.error,
    );
  }
  const missingScopes = missingRequiredSlackBotScopes(auth.grantedScopes);
  if (input.requireScopeEvidence && auth.grantedScopes === undefined) {
    throw new SlackIdentityBootstrapError(
      'slack_scope_unverified',
      'Slack did not return the installed permission scopes',
    );
  }
  if (missingScopes?.length) {
    throw new SlackIdentityBootstrapError(
      'slack_missing_scopes',
      `Reinstall this Slack app to grant the required permissions: ${missingScopes.join(', ')}`,
      missingScopes,
      undefined,
      slackIdentityOAuthUrl(auth.appId),
    );
  }
  if (!auth.botId) {
    throw new SlackIdentityBootstrapError(
      'bot_token_required',
      'Dedicated identities require a Slack bot installation token',
    );
  }
  if (!auth.teamId) {
    throw new SlackIdentityBootstrapError(
      'workspace_unverified',
      'Slack did not identify the installed workspace',
    );
  }
  if (input.expectedTeamId && auth.teamId !== input.expectedTeamId) {
    throw new SlackIdentityBootstrapError(
      'workspace_mismatch',
      'This Slack app is installed in a different workspace',
    );
  }
  if (!auth.botUserId) {
    throw new SlackIdentityBootstrapError(
      'bot_identity_missing',
      'Slack did not identify the bot user',
    );
  }

  let profile: SlackBotIdentityResult;
  try {
    profile = await botIdentityInfo(input.botToken, auth.botUserId);
  } catch {
    throw new SlackIdentityBootstrapError(
      'identity_profile_unavailable',
      'Slack could not load the bot profile',
    );
  }
  if (!profile.ok) {
    throw new SlackIdentityBootstrapError(
      'identity_profile_unavailable',
      `Slack could not load the bot profile${profile.error ? ` (${profile.error})` : ''}`,
    );
  }

  const appId = auth.appId ?? profile.appId;
  if (!appId || !SLACK_APP_ID_PATTERN.test(appId)) {
    throw new SlackIdentityBootstrapError(
      'app_identity_missing',
      'Slack did not identify the app behind this bot',
    );
  }
  const duplicate = (await input.config.listSlackIdentities()).find(
    (identity) => identity.id !== input.identityId && identity.appId === appId,
  );
  if (duplicate) {
    throw new SlackIdentityBootstrapError(
      'app_already_connected',
      'This Slack app is already connected to another identity',
    );
  }

  if (input.requireChannelList) {
    let page: SlackConversationsListPage;
    try {
      page = await conversationsList(input.botToken, { limit: 1 });
    } catch {
      throw new SlackIdentityBootstrapError(
        'slack_unreachable',
        'Slack could not be reached while checking channel access',
      );
    }
    if (!page.ok) {
      if (page.error === 'missing_scope') {
        throw new SlackIdentityBootstrapError(
          'slack_missing_scopes',
          'Reinstall this Slack app to grant channel-list access',
          undefined,
          undefined,
          slackIdentityOAuthUrl(appId),
        );
      }
      if (page.error === 'invalid_auth' || page.error === 'token_revoked') {
        throw new SlackIdentityBootstrapError(
          'slack_auth_failed',
          'Slack rejected this bot token while checking channel access',
          undefined,
          page.error,
        );
      }
      throw new SlackIdentityBootstrapError(
        'slack_channel_list_failed',
        'Slack could not list channels for this installation',
      );
    }
  }

  const avatarUrl = sanitizeHttpsUrl(profile.avatarUrl);
  return {
    teamId: auth.teamId,
    ...(auth.teamName ? { teamName: auth.teamName } : {}),
    appId,
    botUserId: auth.botUserId,
    ...(auth.botName ? { botName: auth.botName } : {}),
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    observedAt: (deps.now ?? Date.now)(),
    consoleUrl: slackIdentityConsoleUrl(appId),
  };
}

export async function beginSlackIdentityConnection(
  input: {
    config: ConfigStore;
    settings: SettingsStore;
    identityId: string;
    expectedRevision: number;
    expectedTeamId: string;
    botToken: string;
    signingSecret: string;
  },
  deps: SlackIdentityBootstrapDeps = {},
): Promise<SlackIdentity> {
  if (!input.expectedTeamId.trim()) {
    throw new SlackIdentityBootstrapError(
      'workspace_unverified',
      'The Slack workspace must be known before connecting a dedicated identity',
    );
  }
  const identity = await input.config.getSlackIdentity(input.identityId);
  requireConnectableIdentity(identity, input.expectedRevision);
  const previousCredentials = await resolveSlackIdentityCredentials(
    input.identityId,
    undefined,
    input.settings,
  );
  const validated = await validateSlackIdentityBotInstallation(
    {
      config: input.config,
      identityId: input.identityId,
      expectedTeamId: input.expectedTeamId,
      botToken: input.botToken,
    },
    deps,
  );

  // Network validation may take seconds. Re-read before the first mutation so
  // deletion, retirement, cancellation, or a newer rotation wins the race.
  const current = await input.config.getSlackIdentity(input.identityId);
  requireConnectableIdentity(current, input.expectedRevision);
  const reconnecting =
    current.setupIntent?.reconnecting === true ||
    current.lifecycle === 'connected' ||
    current.lifecycle === 'degraded';
  // Cross the ConfigStore boundary first: from this point the identity is
  // unassignable. A crash or credential-CAS failure leaves a resumable pending
  // row with the prior bundle, never a connected row with an unverified secret.
  const pending = await input.config.updateSlackIdentity(
    input.identityId,
    input.expectedRevision,
    {
      lifecycle: 'credentials_pending',
      teamId: validated.teamId,
      appId: validated.appId,
      botUserId: validated.botUserId,
      credentialProvenance: 'stored',
      observedDisplayName: validated.displayName ?? null,
      observedAvatarUrl: validated.avatarUrl ?? null,
      observedAt: validated.observedAt,
      health: 'healthy',
      healthDetail: null,
      setupIntent: {
        ...current.setupIntent,
        ...(reconnecting ? { reconnecting: true } : {}),
      },
    },
  );
  await writeSlackIdentityCredentials(
    input.settings,
    input.identityId,
    previousCredentials.connectionRevision,
    {
      botToken: input.botToken,
      signingSecret: input.signingSecret,
      botUserId: validated.botUserId,
    },
  );
  return pending;
}

export async function completeSlackIdentityConnection(input: {
  config: ConfigStore;
  settings: SettingsStore;
  identityId: string;
  expectedRevision: number;
  attachAgentId?: string;
  expectedAgentIdentityId?: string | null;
}): Promise<SlackIdentity> {
  const identity = await input.config.getSlackIdentity(input.identityId);
  requireRevision(identity, input.expectedRevision);
  if (identity.lifecycle !== 'credentials_pending') {
    throw new SlackIdentityBootstrapError(
      'identity_not_connectable',
      'This Slack identity is not waiting for signed verification',
    );
  }
  const credentials = await resolveSlackIdentityCredentials(
    input.identityId,
    undefined,
    input.settings,
  );
  if (!credentials.signingSecret || !credentials.botToken) {
    throw new SlackIdentityBootstrapError(
      'credentials_missing',
      'This Slack identity has no complete credential bundle',
    );
  }
  const verification = await verifyPendingSlackChallenge(
    input.settings,
    input.identityId,
    credentials.signingSecret,
  );
  if (!verification.verified) {
    const code =
      verification.reason === 'expired'
        ? 'challenge_expired'
        : verification.reason === 'invalid_signature'
          ? 'challenge_invalid_signature'
          : 'challenge_missing';
    throw new SlackIdentityBootstrapError(code, 'Slack Request URL verification did not match');
  }
  const connected = await input.config.completeSlackIdentitySetup(
    input.identityId,
    input.expectedRevision,
    input.attachAgentId,
    input.expectedAgentIdentityId,
  );
  await purgePendingSlackChallenge(
    input.settings,
    input.identityId,
    verification.purgeReceipt,
  );
  return connected;
}

export async function cancelSlackIdentityConnection(input: {
  config: ConfigStore;
  settings: SettingsStore;
  identityId: string;
  expectedRevision: number;
}): Promise<SlackIdentity> {
  const identity = await input.config.getSlackIdentity(input.identityId);
  requireRevision(identity, input.expectedRevision);
  if (
    identity.kind !== 'dedicated' ||
    (identity.lifecycle !== 'setup_incomplete' &&
      identity.lifecycle !== 'credentials_pending')
  ) {
    throw new SlackIdentityBootstrapError(
      'identity_not_connectable',
      'This Slack identity setup cannot be canceled',
    );
  }
  const credentials = await resolveSlackIdentityCredentials(
    input.identityId,
    undefined,
    input.settings,
  );
  await cancelPendingSlackIdentitySecrets(
    input.settings,
    input.identityId,
    credentials.connectionRevision,
  );
  return input.config.updateSlackIdentity(input.identityId, input.expectedRevision, {
    lifecycle: 'setup_incomplete',
    teamId: null,
    appId: null,
    botUserId: null,
    credentialProvenance: 'none',
    observedDisplayName: null,
    observedAvatarUrl: null,
    observedAt: null,
    health: 'disconnected',
    healthDetail: null,
  });
}

/** Refresh Slack-owned appearance and safe health without returning secrets. */
export async function refreshSlackIdentityHealth(
  input: {
    config: ConfigStore;
    settings: SettingsStore;
    identityId: string;
    expectedRevision: number;
  },
  deps: SlackIdentityBootstrapDeps = {},
): Promise<SlackIdentityHealthResult> {
  const identity = await input.config.getSlackIdentity(input.identityId);
  requireRevision(identity, input.expectedRevision);
  if (
    identity.lifecycle === 'retired' ||
    (identity.kind === 'dedicated' &&
      identity.lifecycle !== 'connected' &&
      identity.lifecycle !== 'degraded')
  ) {
    throw new SlackIdentityBootstrapError(
      'identity_not_connectable',
      'A retired Slack identity cannot be refreshed',
    );
  }
  const credentials = await resolveSlackIdentityCredentials(
    input.identityId,
    undefined,
    input.settings,
  );
  if (!credentials.botToken) {
    const degraded = await input.config.updateSlackIdentity(
      input.identityId,
      input.expectedRevision,
      { health: 'disconnected', healthDetail: 'credentials_missing' },
    );
    return { identity: degraded, consoleUrl: slackIdentityConsoleUrl(degraded.appId) };
  }
  try {
    const validated = await validateSlackIdentityBotInstallation(
      {
        config: input.config,
        identityId: input.identityId,
        ...(identity.teamId ? { expectedTeamId: identity.teamId } : {}),
        botToken: credentials.botToken,
      },
      deps,
    );
    const current = await input.config.getSlackIdentity(input.identityId);
    requireRevision(current, input.expectedRevision);
    const refreshed = await input.config.updateSlackIdentity(
      input.identityId,
      input.expectedRevision,
      {
        ...(identity.kind === 'workspace_default' ? { lifecycle: 'connected' as const } : {}),
        teamId: validated.teamId,
        appId: validated.appId,
        botUserId: validated.botUserId,
        observedDisplayName: validated.displayName ?? null,
        observedAvatarUrl: validated.avatarUrl ?? null,
        observedAt: validated.observedAt,
        health: 'healthy',
        healthDetail: null,
      },
    );
    return { identity: refreshed, consoleUrl: validated.consoleUrl };
  } catch (error) {
    if (!(error instanceof SlackIdentityBootstrapError)) throw error;
    const current = await input.config.getSlackIdentity(input.identityId);
    requireRevision(current, input.expectedRevision);
    const degraded = await input.config.updateSlackIdentity(
      input.identityId,
      input.expectedRevision,
      { health: 'degraded', healthDetail: error.code },
    );
    return { identity: degraded, consoleUrl: slackIdentityConsoleUrl(degraded.appId) };
  }
}

export function slackIdentityConsoleUrl(appId: string | undefined): string {
  return appId && SLACK_APP_ID_PATTERN.test(appId)
    ? `https://api.slack.com/apps/${appId}/general`
    : 'https://api.slack.com/apps';
}

function slackIdentityOAuthUrl(appId: string | undefined): string | undefined {
  return appId && SLACK_APP_ID_PATTERN.test(appId)
    ? `https://api.slack.com/apps/${appId}/oauth`
    : undefined;
}

function requireConnectableIdentity(identity: SlackIdentity, expectedRevision: number): void {
  requireRevision(identity, expectedRevision);
  if (identity.kind !== 'dedicated') {
    throw new SlackIdentityBootstrapError(
      'identity_not_dedicated',
      'The workspace-default identity uses the existing Slack connection flow',
    );
  }
  if (identity.lifecycle === 'retired') {
    throw new SlackIdentityBootstrapError(
      'identity_not_connectable',
      'A retired Slack identity cannot be reconnected',
    );
  }
}

function requireRevision(identity: SlackIdentity, expectedRevision: number): void {
  if (identity.connectionRevision !== expectedRevision) {
    throw new SlackIdentityRevisionConflictError(
      identity.id,
      expectedRevision,
      identity.connectionRevision,
    );
  }
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
