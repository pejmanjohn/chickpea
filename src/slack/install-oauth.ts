import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { readBoundedBytes } from '../http/bounded-body.ts';
import { sha256HexNode } from '../security/digest.ts';
import { randomSecret } from '../security/random-secret.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
import { safeSetupDestination } from '../auth/setup-handoff.ts';
import { IdentityStateError } from '../identity/errors.ts';
import type { IdentityStore, SlackOAuthAttempt, SlackSetupTransaction } from '../identity/types.ts';
import {
  invalidateSlackInstallationCredentialCache,
  prepareSlackCredentialBundle,
  resolveSlackControlPlaneAppCredentials,
  type SlackCredentialDependencies,
} from './installation-credentials.ts';
import {
  SlackInstallationVerificationError,
  validateSlackBotInstallation,
  type SlackInstallationVerificationDeps,
} from './installation-verification.ts';
import { purgePendingSlackChallenge, verifyPendingSlackChallenge } from './installation-handshake.ts';
import {
  missingRequiredSlackBotScopes,
  REQUIRED_SLACK_BOT_SCOPES,
  unexpectedSlackBotScopes,
} from './scopes.ts';

export const SLACK_INSTALL_ATTEMPT_TTL_MS = 15 * 60_000;
export const SLACK_INSTALL_PROCESSING_LEASE_MS = 10 * 60_000;
const MAX_SLACK_INSTALL_RESPONSE_BYTES = 64 * 1_024;
const SLACK_BOT_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_BOT_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;

type SlackInstallOAuthErrorCode =
  | 'invalid_state'
  | 'expired_state'
  | 'wrong_browser'
  | 'wrong_callback'
  | 'processing'
  | 'stale_revision'
  | 'approval_denied'
  | 'approval_expired'
  | 'approval_cancelled'
  | 'slack_unreachable'
  | 'invalid_response'
  | 'wrong_token_type'
  | 'app_mismatch'
  | 'workspace_mismatch'
  | 'installer_mismatch'
  | 'bot_mismatch'
  | 'missing_scopes'
  | 'unexpected_scopes'
  | 'directory_unavailable'
  | 'channel_unavailable'
  | 'events_unverified';

export class SlackInstallOAuthError extends Error {
  constructor(readonly code: SlackInstallOAuthErrorCode, message = 'Slack installation could not continue.') {
    super(message);
    this.name = 'SlackInstallOAuthError';
  }
}

interface SlackInstallOAuthDependencies {
  identity: IdentityStore;
  credentials: SlackCredentialDependencies;
  config: ConfigStore;
  settings: SettingsStore;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  verification?: SlackInstallationVerificationDeps;
}

interface SlackInstallOAuthStartInput {
  setupId: string;
  expectedSetupRevision: number;
  browserBinding: string;
  redirectUri: string;
  destination?: string;
  expectedTeamId?: string;
  expectedInstallerSlackUserId?: string;
}

interface SlackInstallOAuthStartResult {
  attemptId: string;
  state: string;
  expiresAt: number;
  authorizationUrl: string;
}

export type SlackInstallOAuthResult =
  | { status: 'approval_pending'; destination: string }
  | { status: 'denied' | 'cancelled' | 'expired'; destination: string }
  | {
      status: 'waiting_events' | 'bot_installed';
      destination: string;
      teamId: string;
      installerUserId: string;
      botUserId: string;
      candidateRevision: string;
    };

export class SlackInstallOAuthService {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(private readonly dependencies: SlackInstallOAuthDependencies) {
    this.fetch = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.randomBytes = dependencies.randomBytes ?? ((length) => nodeRandomBytes(length));
  }

  async start(input: SlackInstallOAuthStartInput): Promise<SlackInstallOAuthStartResult> {
    requireBrowserBinding(input.browserBinding);
    const setup = await this.requiredSetup(input.setupId);
    if (setup.state !== 'app_created' || setup.revision !== input.expectedSetupRevision ||
        !setup.appId || !setup.credentialRevision) {
      throw new SlackInstallOAuthError('stale_revision');
    }
    const appCredentials = await this.requiredBoundAppCredentials(setup);
    const redirectUri = exactHttpsRedirect(input.redirectUri);
    const now = this.now();
    const expiresAt = Math.min(now + SLACK_INSTALL_ATTEMPT_TTL_MS, setup.expiresAt);
    if (expiresAt <= now) throw new SlackInstallOAuthError('expired_state');
    const state = randomSecret(this.randomBytes, 32);
    const attemptId = `slackoauth_${randomSecret(this.randomBytes, 18)}`;
    await this.dependencies.identity.createSlackOAuthAttempt({
      id: attemptId,
      kind: 'slack_bot_install',
      purpose: 'setup_bot_install',
      setupId: setup.id,
      setupRevision: setup.revision,
      stateHash: sha256HexNode(state),
      browserHash: sha256HexNode(input.browserBinding),
      appId: appCredentials.appId,
      clientId: appCredentials.clientId,
      credentialRevision: appCredentials.connectionRevision,
      baseRevision: appCredentials.connectionRevision,
      redirectUri,
      destination: safeSetupDestination(input.destination),
      expectedTeamId: input.expectedTeamId ?? null,
      expectedInstallerSlackUserId: input.expectedInstallerSlackUserId ?? null,
      expiresAt,
    });
    const authorizationUrl = new URL(SLACK_BOT_AUTHORIZE_URL);
    authorizationUrl.searchParams.set('client_id', appCredentials.clientId);
    authorizationUrl.searchParams.set('scope', REQUIRED_SLACK_BOT_SCOPES.join(','));
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    authorizationUrl.searchParams.set('state', state);
    return { attemptId, state, expiresAt, authorizationUrl: authorizationUrl.toString() };
  }

  async resume(input: SlackInstallOAuthStartInput): Promise<SlackInstallOAuthStartResult> {
    const pending = await this.requiredSetup(input.setupId);
    if (pending.state !== 'approval_pending' || pending.revision !== input.expectedSetupRevision) {
      throw new SlackInstallOAuthError('stale_revision');
    }
    const resumed = await this.dependencies.identity.resumeSlackSetupAfterApproval({
      setupId: pending.id,
      expectedRevision: pending.revision,
    });
    return this.start({ ...input, expectedSetupRevision: resumed.revision });
  }

  async callback(input: {
    state: string;
    browserBinding: string;
    redirectUri: string;
    code?: string;
    error?: string;
  }): Promise<SlackInstallOAuthResult> {
    requireBrowserBinding(input.browserBinding);
    if (!input.state || input.state.length > 512) throw new SlackInstallOAuthError('invalid_state');
    const redirectUri = exactHttpsRedirect(input.redirectUri);
    const attempt = await this.acquireAttempt(input.state, input.browserBinding, redirectUri);
    const providerError = input.error?.trim();
    if (providerError) return this.handleProviderError(attempt, providerError);
    const code = input.code?.trim() ?? '';
    if (!code || code.length > 2_048) {
      await this.failAttempt(attempt, 'invalid_response');
      throw new SlackInstallOAuthError('invalid_response');
    }

    let appCredentials;
    try {
      const setup = await this.requiredSetup(attempt.setupId);
      if (setup.state !== 'app_created' || setup.revision !== attempt.setupRevision) {
        throw new SlackInstallOAuthError('stale_revision');
      }
      appCredentials = await this.requiredBoundAppCredentials(setup, attempt);
    } catch (error) {
      await this.failAttempt(attempt, 'stale_revision');
      throw error;
    }

    let response: Response;
    try {
      const fetchImpl = this.fetch;
      response = await fetchImpl(slackApiMethodUrl(
        this.dependencies.apiBaseUrl,
        'oauth.v2.access',
        SLACK_BOT_TOKEN_URL,
      ), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: appCredentials.clientId,
          client_secret: appCredentials.clientSecret,
          code,
          redirect_uri: attempt.redirectUri,
        }).toString(),
      });
    } catch {
      // Keep the processing lease for one exact-browser reclaim. A transport
      // failure does not authorize a second concurrent exchange.
      throw new SlackInstallOAuthError('slack_unreachable');
    }
    let tokenResponse: SlackBotTokenResponse;
    try {
      if (!response.ok) throw new SlackInstallOAuthError('invalid_response');
      tokenResponse = parseTokenResponse(await boundedJson(response));
    } catch (error) {
      await this.failAttempt(attempt, 'invalid_response');
      throw error instanceof SlackInstallOAuthError
        ? error
        : new SlackInstallOAuthError('invalid_response');
    }
    if (tokenResponse.ok !== true) {
      if (tokenResponse.error && isApprovalPending(tokenResponse.error)) {
        return this.handleProviderError(attempt, tokenResponse.error);
      }
      await this.failAttempt(attempt, 'invalid_response');
      throw new SlackInstallOAuthError('invalid_response');
    }
    let grant;
    try {
      grant = validateTokenGrant(tokenResponse, attempt);
    } catch (error) {
      await this.failAttempt(
        attempt,
        error instanceof SlackInstallOAuthError ? error.code : 'invalid_response',
      );
      throw error;
    }

    let validated;
    try {
      validated = await validateSlackBotInstallation({
        expectedTeamId: grant.teamId,
        expectedAppId: attempt.appId,
        expectedBotUserId: grant.botUserId,
        botToken: grant.botToken,
        requireScopeEvidence: true,
        requireDirectoryList: true,
        requireChannelList: true,
      }, this.dependencies.verification);
    } catch (error) {
      await this.failAttempt(attempt, bootstrapResultCode(error));
      throw mapBootstrapError(error);
    }
    if (validated.teamId !== grant.teamId || validated.appId !== grant.appId ||
        validated.botUserId !== grant.botUserId) {
      await this.failAttempt(attempt, 'auth_test_mismatch');
      throw new SlackInstallOAuthError('bot_mismatch');
    }

    const active = await this.dependencies.identity.getActiveSlackCredentialRevision(
      WORKSPACE_SLACK_INSTALLATION_ID,
    );
    if (!active || active.revision !== attempt.baseRevision ||
        active.manifestFingerprint === null) {
      await this.failAttempt(attempt, 'stale_revision');
      throw new SlackInstallOAuthError('stale_revision');
    }
    const credential = await prepareSlackCredentialBundle(this.dependencies.credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      identityClass: 'workspace_installation',
      purpose: 'connected_credentials',
      expectedActiveRevision: attempt.baseRevision,
      appId: grant.appId,
      teamId: grant.teamId,
      botUserId: grant.botUserId,
      grantedScopes: grant.scopes,
      validatedAt: validated.observedAt,
      manifestFingerprint: active.manifestFingerprint,
      secrets: {
        clientId: appCredentials.clientId,
        clientSecret: appCredentials.clientSecret,
        signingSecret: appCredentials.signingSecret,
        botToken: grant.botToken,
      },
    });
    const waiting = await this.dependencies.identity.recordSlackBotInstallationCandidate({
      attemptId: attempt.id,
      expectedLeaseGeneration: attempt.leaseGeneration,
      teamId: grant.teamId,
      installerSlackUserId: grant.installerUserId,
      botUserId: grant.botUserId,
      credential,
    });
    await this.syncWorkspaceInstallation(
      waiting,
      'needs_attention',
      'events_verification_pending',
    );
    return this.finalizeWaitingInstallation(waiting.id);
  }

  async finalizeWaitingInstallation(setupId: string): Promise<SlackInstallOAuthResult> {
    const setup = await this.requiredSetup(setupId);
    if (setup.state === 'bot_installed') {
      await this.syncWorkspaceInstallation(setup);
      return setupResult('bot_installed', setup);
    }
    if (setup.state !== 'bot_install_pending' || !setup.botCredentialRevision ||
        !setup.appId || !setup.credentialRevision || !setup.slackTeamId) {
      throw new SlackInstallOAuthError('events_unverified');
    }
    let appCredentials;
    try {
      appCredentials = await this.requiredBoundAppCredentials(setup);
    } catch {
      await this.failWaiting(setup, 'stale_revision');
      throw new SlackInstallOAuthError('stale_revision');
    }
    let purgeReceipt: string | undefined;
    let proof = await this.dependencies.identity.getSlackEventsProof(setup.botCredentialRevision);
    if (!proof) {
      const verification = await verifyPendingSlackChallenge(
        this.dependencies.settings,
        appCredentials.signingSecret,
        { now: this.now(), expectedAppId: setup.appId, expectedTeamId: setup.slackTeamId },
      );
      if (!verification.verified) {
        if (['invalid_signature', 'app_mismatch', 'workspace_mismatch'].includes(verification.reason)) {
          await this.failWaiting(setup, `events_${verification.reason}`);
          throw new SlackInstallOAuthError('events_unverified');
        }
        return setupResult('waiting_events', setup);
      }
      purgeReceipt = verification.purgeReceipt;
      proof = await this.dependencies.identity.recordSlackEventsProof({
        setupId: setup.id,
        candidateRevision: setup.botCredentialRevision,
        identityId: WORKSPACE_SLACK_INSTALLATION_ID,
        appId: setup.appId,
        teamId: setup.slackTeamId,
        baseRevision: setup.credentialRevision,
        verifiedAt: this.now(),
      });
    }
    const control = await this.dependencies.identity.getSlackCredentialControl();
    if (!control) {
      await this.failWaiting(setup, 'stale_revision');
      throw new SlackInstallOAuthError('stale_revision');
    }
    let installed: SlackSetupTransaction;
    try {
      installed = await this.dependencies.identity.promoteSlackBotInstallation({
        setupId: setup.id,
        candidateRevision: proof.candidateRevision,
        identityId: proof.identityId,
        appId: proof.appId,
        teamId: proof.teamId,
        baseRevision: proof.baseRevision,
        verifiedAt: proof.verifiedAt,
        expectedRotationEpoch: control.rotationEpoch,
      });
    } catch (error) {
      await this.failWaiting(setup, 'stale_revision');
      throw new SlackInstallOAuthError('stale_revision');
    }
    invalidateSlackInstallationCredentialCache(this.dependencies.identity);
    if (purgeReceipt) {
      await purgePendingSlackChallenge(
        this.dependencies.settings,
        purgeReceipt,
      );
    }
    await this.syncWorkspaceInstallation(installed);
    return setupResult('bot_installed', installed);
  }

  private async acquireAttempt(
    state: string,
    browserBinding: string,
    redirectUri: string,
  ): Promise<SlackOAuthAttempt> {
    const now = this.now();
    try {
      return await this.dependencies.identity.acquireSlackOAuthAttempt({
        stateHash: sha256HexNode(state),
        browserHash: sha256HexNode(browserBinding),
        kind: 'slack_bot_install',
        purpose: 'setup_bot_install',
        redirectUri,
        leaseExpiresAt: now + SLACK_INSTALL_PROCESSING_LEASE_MS,
      });
    } catch (error) {
      if (error instanceof IdentityStateError) {
        if (error.code === 'auth_operation_expired') throw new SlackInstallOAuthError('expired_state');
        if (/browser/i.test(error.message)) throw new SlackInstallOAuthError('wrong_browser');
        if (/callback|binding|redirect/i.test(error.message)) throw new SlackInstallOAuthError('wrong_callback');
        if (/processing lease/i.test(error.message)) throw new SlackInstallOAuthError('processing');
      }
      throw new SlackInstallOAuthError('invalid_state');
    }
  }

  private async handleProviderError(
    attempt: SlackOAuthAttempt,
    providerError: string,
  ): Promise<SlackInstallOAuthResult> {
    if (isApprovalPending(providerError)) {
      await this.dependencies.identity.markSlackOAuthApprovalPending({
        attemptId: attempt.id,
        expectedLeaseGeneration: attempt.leaseGeneration,
      });
      return { status: 'approval_pending', destination: attempt.destination };
    }
    const status = /cancel/i.test(providerError) ? 'cancelled'
      : /expir/i.test(providerError) ? 'expired' : 'denied';
    const code = status === 'cancelled' ? 'approval_cancelled'
      : status === 'expired' ? 'approval_expired' : 'approval_denied';
    await this.dependencies.identity.settleSlackOAuthAttempt({
      attemptId: attempt.id,
      expectedLeaseGeneration: attempt.leaseGeneration,
      status: 'denied',
      resultCode: providerError.slice(0, 128) || code,
    });
    return { status, destination: attempt.destination };
  }

  private async failAttempt(attempt: SlackOAuthAttempt, code: string): Promise<void> {
    await this.dependencies.identity.settleSlackOAuthAttempt({
      attemptId: attempt.id,
      expectedLeaseGeneration: attempt.leaseGeneration,
      status: 'failed',
      resultCode: code,
    }).catch(() => undefined);
  }

  private async failWaiting(setup: SlackSetupTransaction, code: string): Promise<void> {
    if (!setup.botCredentialRevision) return;
    const control = await this.dependencies.identity.getSlackCredentialControl();
    if (!control) return;
    await this.dependencies.identity.failSlackBotInstallation({
      setupId: setup.id,
      candidateRevision: setup.botCredentialRevision,
      expectedRotationEpoch: control.rotationEpoch,
      errorCode: code,
    }).catch(() => undefined);
  }

  private async requiredSetup(setupId: string): Promise<SlackSetupTransaction> {
    const setup = await this.dependencies.identity.getSlackSetupTransaction(setupId);
    if (!setup) throw new SlackInstallOAuthError('invalid_state');
    if (setup.expiresAt <= this.now() && setup.state !== 'consumed') {
      throw new SlackInstallOAuthError('expired_state');
    }
    return setup;
  }

  private async requiredBoundAppCredentials(
    setup: SlackSetupTransaction,
    attempt?: SlackOAuthAttempt,
  ) {
    try {
      const credentials = await resolveSlackControlPlaneAppCredentials(this.dependencies.credentials);
      if (!setup.appId || !setup.credentialRevision || credentials.appId !== setup.appId ||
          credentials.connectionRevision !== setup.credentialRevision ||
          (attempt && (attempt.appId !== credentials.appId ||
            attempt.clientId !== credentials.clientId ||
            attempt.credentialRevision !== credentials.connectionRevision ||
            attempt.baseRevision !== credentials.connectionRevision))) {
        throw new SlackInstallOAuthError('stale_revision');
      }
      return credentials;
    } catch (error) {
      if (error instanceof SlackInstallOAuthError) throw error;
      throw new SlackInstallOAuthError('stale_revision');
    }
  }

  private async syncWorkspaceInstallation(
    setup: SlackSetupTransaction,
    health: 'healthy' | 'needs_attention' = 'healthy',
    healthDetail?: string,
  ): Promise<void> {
    if (!setup.appId || !setup.slackTeamId || !setup.botUserId) return;
    let installation = await this.dependencies.config.getWorkspaceInstallation(
      setup.slackTeamId,
    );
    if (!installation) {
      installation = await this.dependencies.config.ensureWorkspaceInstallation({
        workspaceId: setup.slackTeamId,
        transportMode: 'direct',
        teamId: setup.slackTeamId,
        appId: setup.appId,
        botUserId: setup.botUserId,
      });
    }
    if (
      installation.transportMode === 'direct' &&
      installation.teamId === setup.slackTeamId &&
      installation.appId === setup.appId &&
      installation.botUserId === setup.botUserId &&
      installation.health === health &&
      installation.healthDetail === healthDetail
    ) return;
    await this.dependencies.config.updateWorkspaceInstallation(
      setup.slackTeamId,
      {
        transportMode: 'direct',
        teamId: setup.slackTeamId,
        appId: setup.appId,
        botUserId: setup.botUserId,
        gatewayBindingId: null,
        health,
        healthDetail: healthDetail ?? null,
      },
      installation.revision,
    );
  }
}

interface SlackBotTokenResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string };
  authed_user?: { id?: string };
}

function validateTokenGrant(response: SlackBotTokenResponse, attempt: SlackOAuthAttempt) {
  if (response.token_type !== 'bot') throw new SlackInstallOAuthError('wrong_token_type');
  const botToken = requiredText(response.access_token, 16_384);
  const appId = requiredSlackId(response.app_id);
  const teamId = requiredSlackId(response.team?.id);
  const installerUserId = requiredSlackId(response.authed_user?.id);
  const botUserId = requiredSlackId(response.bot_user_id);
  if (appId !== attempt.appId) throw new SlackInstallOAuthError('app_mismatch');
  if (attempt.expectedTeamId && teamId !== attempt.expectedTeamId) {
    throw new SlackInstallOAuthError('workspace_mismatch');
  }
  if (attempt.expectedInstallerSlackUserId && installerUserId !== attempt.expectedInstallerSlackUserId) {
    throw new SlackInstallOAuthError('installer_mismatch');
  }
  const scopes = parseScopes(response.scope);
  const missing = missingRequiredSlackBotScopes(scopes);
  if (missing?.length) throw new SlackInstallOAuthError('missing_scopes');
  if (unexpectedSlackBotScopes(scopes)?.length) {
    throw new SlackInstallOAuthError('unexpected_scopes');
  }
  return { botToken, appId, teamId, installerUserId, botUserId, scopes };
}

function setupResult(
  status: 'waiting_events' | 'bot_installed',
  setup: SlackSetupTransaction,
): SlackInstallOAuthResult {
  if (!setup.slackTeamId || !setup.installerSlackUserId || !setup.botUserId ||
      !setup.botCredentialRevision) {
    throw new SlackInstallOAuthError('invalid_response');
  }
  return {
    status,
    destination: setup.destination,
    teamId: setup.slackTeamId,
    installerUserId: setup.installerSlackUserId,
    botUserId: setup.botUserId,
    candidateRevision: setup.botCredentialRevision,
  };
}

function parseScopes(value: string | undefined): string[] {
  if (typeof value !== 'string') return [];
  const scopes = [...new Set(value.split(',').map((scope) => scope.trim()).filter(Boolean))];
  if (scopes.length > 128 || scopes.some((scope) => !/^[a-z][a-z0-9._:-]{0,127}$/.test(scope))) {
    throw new SlackInstallOAuthError('invalid_response');
  }
  return scopes.sort();
}

function parseTokenResponse(value: unknown): SlackBotTokenResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SlackInstallOAuthError('invalid_response');
  }
  return value as SlackBotTokenResponse;
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await readBoundedBytes(response, {
    maxBytes: MAX_SLACK_INSTALL_RESPONSE_BYTES,
    onOversize: () => new SlackInstallOAuthError('invalid_response'),
    onMissingBody: () => new SlackInstallOAuthError('invalid_response'),
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new SlackInstallOAuthError('invalid_response');
  }
}

function exactHttpsRedirect(value: string): string {
  if (!value || value.length > 2_048) throw new SlackInstallOAuthError('wrong_callback');
  try {
    const url = new URL(value);
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.hash ||
        url.toString() !== value) {
      throw new Error();
    }
    return value;
  } catch {
    throw new SlackInstallOAuthError('wrong_callback');
  }
}

function slackApiMethodUrl(baseUrl: string | undefined, method: string, fallback: string): string {
  const normalized = baseUrl?.trim().replace(/\/+$/, '');
  return normalized ? `${normalized}/${method}` : fallback;
}

function requireBrowserBinding(value: string): void {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(value)) throw new SlackInstallOAuthError('wrong_browser');
}

function requiredSlackId(value: string | undefined): string {
  if (!value || !SLACK_ID.test(value)) throw new SlackInstallOAuthError('invalid_response');
  return value;
}

function requiredText(value: string | undefined, maximum: number): string {
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SlackInstallOAuthError('invalid_response');
  }
  return value;
}

function isApprovalPending(error: string): boolean {
  return ['app_approval_required', 'approval_required', 'app_requested', 'request_pending']
    .includes(error);
}

function bootstrapResultCode(error: unknown): string {
  return error instanceof SlackInstallationVerificationError ? error.code : 'verification_failed';
}

function mapBootstrapError(error: unknown): SlackInstallOAuthError {
  if (!(error instanceof SlackInstallationVerificationError)) {
    return new SlackInstallOAuthError('invalid_response');
  }
  if (['slack_missing_scopes', 'slack_scope_unverified'].includes(error.code)) {
    return new SlackInstallOAuthError('missing_scopes');
  }
  if (error.code === 'slack_directory_list_failed') {
    return new SlackInstallOAuthError('directory_unavailable');
  }
  if (error.code === 'slack_channel_list_failed') {
    return new SlackInstallOAuthError('channel_unavailable');
  }
  if (error.code === 'app_mismatch') return new SlackInstallOAuthError('app_mismatch');
  if (error.code === 'workspace_mismatch') return new SlackInstallOAuthError('workspace_mismatch');
  if (error.code === 'bot_identity_missing') return new SlackInstallOAuthError('bot_mismatch');
  if (error.code === 'slack_unreachable') return new SlackInstallOAuthError('slack_unreachable');
  return new SlackInstallOAuthError('invalid_response');
}
