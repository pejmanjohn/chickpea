import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
import { IdentityStateError } from '../identity/errors.ts';
import type { IdentityStore, SlackRecoverySession } from '../identity/types.ts';
import {
  invalidateSlackInstallationCredentialCache,
  stageMissingSlackCredentialBundle,
  stageSlackCredentialBundle,
  type SlackCredentialDependencies,
} from '../slack/installation-credentials.ts';
import {
  SlackInstallationVerificationError,
  validateSlackBotInstallation,
  type SlackInstallationVerificationDeps,
} from '../slack/installation-verification.ts';
import { purgePendingSlackChallenge, verifyPendingSlackChallenge } from '../slack/installation-handshake.ts';
import {
  slackManifestFingerprint,
  validateSlackAppManifest,
  validateSlackAppManifestUrlRepair,
  type SlackAppManifest,
} from '../slack/app-manifest.ts';
import { missingRequiredSlackBotScopes, REQUIRED_SLACK_BOT_SCOPES } from '../slack/scopes.ts';
import {
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
  type SlackSecretEnvelopeContext,
} from '../slack/secret-envelope.ts';
import { decodeRecoverySecret, digestSlackRecoveryGrant } from './recovery-secret.ts';

export const SLACK_RECOVERY_TTL_MS = 15 * 60_000;
export const SLACK_RECOVERY_PROCESSING_LEASE_MS = 10 * 60_000;
const SLACK_BOT_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_BOT_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const SLACK_MANIFEST_EXPORT_URL = 'https://slack.com/api/apps.manifest.export';
const SLACK_MANIFEST_UPDATE_URL = 'https://slack.com/api/apps.manifest.update';
const MAX_SLACK_RESPONSE_BYTES = 64 * 1_024;
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;

export type SlackCredentialRecoveryErrorCode =
  | 'invalid_grant'
  | 'grant_reused'
  | 'parallel_recovery'
  | 'invalid_session'
  | 'wrong_browser'
  | 'session_expired'
  | 'session_consumed'
  | 'invalid_state'
  | 'processing'
  | 'wrong_callback'
  | 'app_mismatch'
  | 'workspace_mismatch'
  | 'manifest_mismatch'
  | 'missing_scopes'
  | 'invalid_response'
  | 'slack_unreachable'
  | 'events_unverified'
  | 'stale_revision';

export class SlackCredentialRecoveryError extends Error {
  readonly name = 'SlackCredentialRecoveryError';
  constructor(readonly code: SlackCredentialRecoveryErrorCode) {
    super('Slack credential recovery could not continue.');
  }
}

interface RecoveryAuthority {
  recoveryId: string;
  sessionSecret: string;
  browserBinding: string;
}

export interface SlackCredentialRecoveryDependencies {
  identity: IdentityStore;
  credentials: SlackCredentialDependencies;
  config: ConfigStore;
  settings: SettingsStore;
  expectedRecoveryToken: string;
  fetch?: typeof fetch;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  verification?: SlackInstallationVerificationDeps;
}

export class SlackCredentialRecoveryService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly expectedRecoveryToken: Uint8Array;

  constructor(private readonly dependencies: SlackCredentialRecoveryDependencies) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.randomBytes = dependencies.randomBytes ?? ((length) => nodeRandomBytes(length));
    this.expectedRecoveryToken = decodeRecoverySecret(dependencies.expectedRecoveryToken);
  }

  async begin(input: { recoveryToken: string; browserBinding: string }) {
    requireBrowserBinding(input.browserBinding);
    if (!matchesRecoveryToken(input.recoveryToken, this.expectedRecoveryToken)) {
      throw new SlackCredentialRecoveryError('invalid_grant');
    }
    const [control, active] = await Promise.all([
      this.dependencies.identity.getSlackCredentialControl(),
      this.dependencies.identity.getActiveSlackCredentialRevision(WORKSPACE_SLACK_INSTALLATION_ID),
    ]);
    if (!control || !active || active.purpose !== 'connected_credentials' ||
        !active.teamId || !active.manifestFingerprint) {
      throw new SlackCredentialRecoveryError('stale_revision');
    }
    const sessionSecret = randomSecret(this.randomBytes, 32);
    const recoveryId = `recovery_${randomSecret(this.randomBytes, 18)}`;
    const expiresAt = this.now() + SLACK_RECOVERY_TTL_MS;
    try {
      const session = await this.dependencies.identity.createSlackRecoverySession({
        id: recoveryId,
        deploymentId: control.deploymentId,
        grantHash: digestSlackRecoveryGrant(control.deploymentId, input.recoveryToken),
        sessionHash: hashSecret(sessionSecret),
        browserHash: hashSecret(input.browserBinding),
        allowedActions: ['credential_repair', 'url_repair'],
        expectedAppId: active.appId,
        expectedTeamId: active.teamId,
        baseRevision: active.revision,
        manifestFingerprint: active.manifestFingerprint,
        expiresAt,
      });
      await this.audit('slack_recovery.begin', session.id, 'success', 'session_minted');
      return recoveryResult(session, sessionSecret);
    } catch (error) {
      if (error instanceof IdentityStateError && /already used/i.test(error.message)) {
        throw new SlackCredentialRecoveryError('grant_reused');
      }
      if (error instanceof IdentityStateError && /already active/i.test(error.message)) {
        throw new SlackCredentialRecoveryError('parallel_recovery');
      }
      throw new SlackCredentialRecoveryError('stale_revision');
    }
  }

  async inspect(input: RecoveryAuthority): Promise<SlackRecoverySession> {
    const session = await this.dependencies.identity.getSlackRecoverySession(input.recoveryId);
    return this.requireAuthority(session, input);
  }

  async stageAppCredentials(input: RecoveryAuthority & {
    appId: string;
    teamId: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    manifest: SlackAppManifest;
  }) {
    const session = await this.inspect(input);
    if (session.status !== 'active') throw terminalCode(session);
    if (input.appId !== session.expectedAppId) throw new SlackCredentialRecoveryError('app_mismatch');
    if (input.teamId !== session.expectedTeamId) throw new SlackCredentialRecoveryError('workspace_mismatch');
    try {
      validateSlackAppManifest(input.manifest, input.manifest);
    } catch {
      throw new SlackCredentialRecoveryError('manifest_mismatch');
    }
    if (slackManifestFingerprint(input.manifest) !== session.manifestFingerprint) {
      throw new SlackCredentialRecoveryError('manifest_mismatch');
    }
    const revision = `recoveryapp_${randomSecret(this.randomBytes, 18)}`;
    const context = recoveryEnvelopeContext(session, revision);
    const envelope = await encryptSlackSecretEnvelope(this.dependencies.credentials.keyring, context, {
      clientId: requiredText(input.clientId, 256),
      clientSecret: requiredText(input.clientSecret, 16_384),
      signingSecret: requiredText(input.signingSecret, 16_384),
    });
    const staged = await this.dependencies.identity.stageSlackRecoveryAppCredentials({
      recoveryId: session.id,
      sessionHash: hashSecret(input.sessionSecret),
      browserHash: hashSecret(input.browserBinding),
      appCredentialRevision: revision,
      appCredentialClientId: requiredText(input.clientId, 256),
      appCredentialEnvelope: envelope,
    }).catch((error) => { throw mapStateError(error); });
    await this.audit('slack_recovery.credentials_staged', session.id, 'success', 'inactive_envelope');
    return { candidateRevision: staged.appCredentialRevision! };
  }

  async repairUrls(input: RecoveryAuthority & {
    configurationToken: string;
    expectedManifest: SlackAppManifest;
  }): Promise<void> {
    const session = await this.inspect(input);
    if (session.status !== 'active') throw terminalCode(session);
    const token = configurationToken(input.configurationToken);
    const exported = await this.manifestRequest(
      SLACK_MANIFEST_EXPORT_URL,
      token,
      new URLSearchParams({ app_id: session.expectedAppId }).toString(),
      'application/x-www-form-urlencoded',
    );
    try {
      validateSlackAppManifestUrlRepair(exported.manifest, input.expectedManifest);
    } catch {
      throw new SlackCredentialRecoveryError('manifest_mismatch');
    }
    const updated = await this.manifestRequest(
      SLACK_MANIFEST_UPDATE_URL,
      token,
      JSON.stringify({ app_id: session.expectedAppId, manifest: input.expectedManifest }),
      'application/json; charset=utf-8',
    );
    if (updated.app_id !== undefined && updated.app_id !== session.expectedAppId) {
      throw new SlackCredentialRecoveryError('app_mismatch');
    }
    const verified = await this.manifestRequest(
      SLACK_MANIFEST_EXPORT_URL,
      token,
      new URLSearchParams({ app_id: session.expectedAppId }).toString(),
      'application/x-www-form-urlencoded',
    );
    try {
      validateSlackAppManifest(verified.manifest, input.expectedManifest);
    } catch {
      throw new SlackCredentialRecoveryError('manifest_mismatch');
    }
    await this.dependencies.identity.updateSlackRecoveryManifest({
      recoveryId: session.id,
      sessionHash: hashSecret(input.sessionSecret),
      browserHash: hashSecret(input.browserBinding),
      manifestFingerprint: slackManifestFingerprint(input.expectedManifest),
    }).catch((error) => { throw mapStateError(error); });
    await this.audit('slack_recovery.urls_repaired', session.id, 'success', 'same_app_urls_only');
  }

  async startBotOAuth(input: RecoveryAuthority & { redirectUri: string }) {
    const session = await this.inspect(input);
    if (session.status !== 'credentials_staged' || !session.appCredentialClientId) {
      throw terminalCode(session);
    }
    const redirectUri = exactHttpsRedirect(input.redirectUri);
    const state = randomSecret(this.randomBytes, 32);
    await this.dependencies.identity.startSlackRecoveryOAuth({
      recoveryId: session.id,
      sessionHash: hashSecret(input.sessionSecret),
      browserHash: hashSecret(input.browserBinding),
      stateHash: hashSecret(state),
      redirectUri,
    }).catch((error) => { throw mapStateError(error); });
    const authorization = new URL(SLACK_BOT_AUTHORIZE_URL);
    authorization.searchParams.set('client_id', session.appCredentialClientId);
    authorization.searchParams.set('scope', REQUIRED_SLACK_BOT_SCOPES.join(','));
    authorization.searchParams.set('redirect_uri', redirectUri);
    authorization.searchParams.set('state', state);
    return { state, expiresAt: session.expiresAt, authorizationUrl: authorization.toString() };
  }

  async callback(input: RecoveryAuthority & {
    state: string;
    redirectUri: string;
    code: string;
  }): Promise<{ status: 'waiting_events'; candidateRevision: string }> {
    if (!input.state || input.state.length > 512) throw new SlackCredentialRecoveryError('invalid_state');
    const redirectUri = exactHttpsRedirect(input.redirectUri);
    let session: SlackRecoverySession;
    try {
      session = await this.dependencies.identity.acquireSlackRecoveryOAuth({
        stateHash: hashSecret(input.state),
        sessionHash: hashSecret(input.sessionSecret),
        browserHash: hashSecret(input.browserBinding),
        redirectUri,
        leaseExpiresAt: this.now() + SLACK_RECOVERY_PROCESSING_LEASE_MS,
      });
    } catch (error) { throw mapStateError(error); }
    const appSecrets = await this.decryptStagedAppCredentials(session);
    let response: Response;
    try {
      response = await this.fetchImpl(SLACK_BOT_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: appSecrets.clientId,
          client_secret: appSecrets.clientSecret,
          code: requiredText(input.code, 2_048),
          redirect_uri: redirectUri,
        }).toString(),
      });
    } catch {
      throw new SlackCredentialRecoveryError('slack_unreachable');
    }
    let grant: ReturnType<typeof tokenGrant>;
    try {
      if (!response.ok) throw new Error('http');
      grant = tokenGrant(await boundedJson(response), session);
    } catch (error) {
      if (error instanceof SlackCredentialRecoveryError) throw error;
      throw new SlackCredentialRecoveryError('invalid_response');
    }
    let validated;
    try {
      validated = await validateSlackBotInstallation({
        expectedTeamId: session.expectedTeamId,
        expectedAppId: session.expectedAppId,
        expectedBotUserId: grant.botUserId,
        botToken: grant.botToken,
        requireScopeEvidence: true,
        requireDirectoryList: true,
        requireChannelList: true,
      }, this.dependencies.verification);
    } catch (error) {
      throw mapBootstrapError(error);
    }
    const active = await this.dependencies.identity.getActiveSlackCredentialRevision(
      WORKSPACE_SLACK_INSTALLATION_ID,
    );
    if (!active || active.revision !== session.baseRevision ||
        active.appId !== session.expectedAppId || active.teamId !== session.expectedTeamId) {
      throw new SlackCredentialRecoveryError('stale_revision');
    }
    const connectedInput = {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      identityClass: 'workspace_installation' as const,
      purpose: 'connected_credentials' as const,
      expectedActiveRevision: session.baseRevision,
      appId: session.expectedAppId,
      teamId: session.expectedTeamId,
      botUserId: grant.botUserId,
      grantedScopes: grant.scopes,
      validatedAt: validated.observedAt,
      manifestFingerprint: active.manifestFingerprint,
      secrets: {
        clientId: appSecrets.clientId,
        clientSecret: appSecrets.clientSecret,
        signingSecret: appSecrets.signingSecret,
        botToken: grant.botToken,
      },
    };
    const control = await this.dependencies.identity.getSlackCredentialControl();
    if (!control) throw new SlackCredentialRecoveryError('stale_revision');
    const candidate = control.currentKeyId === this.dependencies.credentials.keyring.currentKeyId
      ? await stageSlackCredentialBundle(this.dependencies.credentials, connectedInput)
        .catch(() => { throw new SlackCredentialRecoveryError('stale_revision'); })
      : await stageMissingSlackCredentialBundle(this.dependencies.credentials, {
          expectedRevision: session.baseRevision,
          expectedAppId: session.expectedAppId,
          expectedTeamId: session.expectedTeamId,
          correlationId: session.id,
          botUserId: grant.botUserId,
          grantedScopes: grant.scopes,
          validatedAt: validated.observedAt,
          manifestFingerprint: session.manifestFingerprint,
          secrets: connectedInput.secrets,
        }).catch(() => { throw new SlackCredentialRecoveryError('stale_revision'); });
    const waiting = await this.dependencies.identity.recordSlackRecoveryCandidate({
      recoveryId: session.id,
      expectedLeaseGeneration: session.leaseGeneration,
      candidateRevision: candidate.revision,
    }).catch((error) => { throw mapStateError(error); });
    await this.audit('slack_recovery.bot_validated', session.id, 'success', 'waiting_events');
    return { status: 'waiting_events', candidateRevision: waiting.connectedCandidateRevision! };
  }

  async finalize(input: RecoveryAuthority): Promise<{ status: 'repaired' }> {
    const session = await this.inspect(input);
    if (session.status !== 'waiting_events' || !session.connectedCandidateRevision) {
      throw terminalCode(session);
    }
    const appSecrets = await this.decryptStagedAppCredentials(session);
    const verification = await verifyPendingSlackChallenge(
      this.dependencies.settings,
      appSecrets.signingSecret,
      { now: this.now(), expectedAppId: session.expectedAppId, expectedTeamId: session.expectedTeamId },
    );
    if (!verification.verified) throw new SlackCredentialRecoveryError('events_unverified');
    const control = await this.dependencies.identity.getSlackCredentialControl();
    if (!control) throw new SlackCredentialRecoveryError('stale_revision');
    const candidate = await this.dependencies.identity.getSlackCredentialRevision(
      WORKSPACE_SLACK_INSTALLATION_ID,
      session.connectedCandidateRevision,
    );
    if (!candidate) throw new SlackCredentialRecoveryError('stale_revision');
    await this.dependencies.identity.promoteSlackRecoveryCandidate({
      recoveryId: session.id,
      sessionHash: hashSecret(input.sessionSecret),
      browserHash: hashSecret(input.browserBinding),
      candidateRevision: session.connectedCandidateRevision,
      expectedActiveRevision: candidate.baseRevision,
      expectedRotationEpoch: control.rotationEpoch,
    }).catch((error) => { throw mapStateError(error); });
    invalidateSlackInstallationCredentialCache(this.dependencies.identity);
    await purgePendingSlackChallenge(
      this.dependencies.settings,
      verification.purgeReceipt,
    );
    await this.audit('slack_recovery.promoted', session.id, 'success', 'same_app_team_repaired');
    return { status: 'repaired' };
  }

  private async decryptStagedAppCredentials(session: SlackRecoverySession) {
    if (!session.appCredentialEnvelope || !session.appCredentialRevision) {
      throw new SlackCredentialRecoveryError('invalid_session');
    }
    try {
      return await decryptSlackSecretEnvelope<{
        clientId: string; clientSecret: string; signingSecret: string;
      }>(
        this.dependencies.credentials.keyring,
        recoveryEnvelopeContext(session, session.appCredentialRevision),
        session.appCredentialEnvelope,
      );
    } catch {
      throw new SlackCredentialRecoveryError('stale_revision');
    }
  }

  private async manifestRequest(
    url: string,
    token: string,
    body: string,
    contentType: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        body,
      });
    } catch { throw new SlackCredentialRecoveryError('slack_unreachable'); }
    let payload: Record<string, unknown>;
    try { payload = record(await boundedJson(response)); } catch {
      throw new SlackCredentialRecoveryError('invalid_response');
    }
    if (!response.ok || payload.ok !== true) {
      throw new SlackCredentialRecoveryError('invalid_response');
    }
    return payload;
  }

  private requireAuthority(
    session: SlackRecoverySession | undefined,
    input: RecoveryAuthority,
  ): SlackRecoverySession {
    if (!session || session.sessionHash !== hashSecret(input.sessionSecret)) {
      throw new SlackCredentialRecoveryError('invalid_session');
    }
    if (session.browserHash !== hashSecret(input.browserBinding)) {
      throw new SlackCredentialRecoveryError('wrong_browser');
    }
    if (session.expiresAt <= this.now() || session.status === 'expired') {
      throw new SlackCredentialRecoveryError('session_expired');
    }
    if (session.status === 'consumed') throw new SlackCredentialRecoveryError('session_consumed');
    if (session.status === 'failed') throw new SlackCredentialRecoveryError('invalid_session');
    return session;
  }

  private async audit(
    action: string,
    correlationId: string,
    outcome: 'success' | 'denied',
    reasonCode: string,
  ): Promise<void> {
    await this.dependencies.identity.recordAuthAudit({
      event: 'authorization', outcome, action, correlationId,
      authenticatorKind: 'deployment_token', reasonCode,
    });
  }
}

function recoveryResult(session: SlackRecoverySession, sessionSecret: string) {
  return {
    recoveryId: session.id,
    sessionSecret,
    expiresAt: session.expiresAt,
    expectedAppId: session.expectedAppId,
    expectedTeamId: session.expectedTeamId,
  };
}

function recoveryEnvelopeContext(
  session: SlackRecoverySession,
  revision: string,
): SlackSecretEnvelopeContext {
  return {
    deploymentId: session.deploymentId,
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation',
    appId: session.expectedAppId,
    teamId: session.expectedTeamId,
    purpose: 'app_credentials',
    revision,
  };
}

function tokenGrant(value: unknown, session: SlackRecoverySession) {
  const payload = record(value);
  if (payload.ok !== true || payload.token_type !== 'bot') {
    throw new SlackCredentialRecoveryError('invalid_response');
  }
  const appId = requiredSlackId(payload.app_id);
  const teamId = requiredSlackId(record(payload.team).id);
  const botUserId = requiredSlackId(payload.bot_user_id);
  requiredSlackId(record(payload.authed_user).id);
  if (appId !== session.expectedAppId) throw new SlackCredentialRecoveryError('app_mismatch');
  if (teamId !== session.expectedTeamId) throw new SlackCredentialRecoveryError('workspace_mismatch');
  const scopes = parseScopes(payload.scope);
  if (missingRequiredSlackBotScopes(scopes)?.length) {
    throw new SlackCredentialRecoveryError('missing_scopes');
  }
  return { appId, teamId, botUserId, scopes, botToken: requiredText(payload.access_token, 16_384) };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SLACK_RESPONSE_BYTES) throw new Error('oversize');
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_SLACK_RESPONSE_BYTES) throw new Error('oversize');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function mapBootstrapError(error: unknown): SlackCredentialRecoveryError {
  if (!(error instanceof SlackInstallationVerificationError)) {
    return new SlackCredentialRecoveryError('invalid_response');
  }
  if (['slack_missing_scopes', 'slack_scope_unverified'].includes(error.code)) {
    return new SlackCredentialRecoveryError('missing_scopes');
  }
  if (error.code === 'app_mismatch') return new SlackCredentialRecoveryError('app_mismatch');
  if (error.code === 'workspace_mismatch') return new SlackCredentialRecoveryError('workspace_mismatch');
  if (error.code === 'slack_unreachable') return new SlackCredentialRecoveryError('slack_unreachable');
  return new SlackCredentialRecoveryError('invalid_response');
}

function mapStateError(error: unknown): SlackCredentialRecoveryError {
  if (!(error instanceof IdentityStateError)) return new SlackCredentialRecoveryError('invalid_session');
  if (error.code === 'auth_operation_expired') return new SlackCredentialRecoveryError('session_expired');
  if (/browser/i.test(error.message)) return new SlackCredentialRecoveryError('wrong_browser');
  if (/processing lease/i.test(error.message)) return new SlackCredentialRecoveryError('processing');
  if (/callback/i.test(error.message)) return new SlackCredentialRecoveryError('wrong_callback');
  if (/terminal/i.test(error.message)) return new SlackCredentialRecoveryError('invalid_state');
  if (/credential|revision|concurrent/i.test(error.message)) return new SlackCredentialRecoveryError('stale_revision');
  return new SlackCredentialRecoveryError('invalid_session');
}

function terminalCode(session: SlackRecoverySession): SlackCredentialRecoveryError {
  if (session.status === 'consumed') return new SlackCredentialRecoveryError('session_consumed');
  if (session.status === 'expired') return new SlackCredentialRecoveryError('session_expired');
  return new SlackCredentialRecoveryError('invalid_session');
}

function matchesRecoveryToken(value: string, expected: Uint8Array): boolean {
  try {
    const actual = decodeRecoverySecret(value);
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  } catch { return false; }
}

function hashSecret(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function randomSecret(randomBytes: (length: number) => Uint8Array, length: number): string {
  return Buffer.from(randomBytes(length)).toString('base64url');
}
function requireBrowserBinding(value: string): void {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(value)) throw new SlackCredentialRecoveryError('wrong_browser');
}
function exactHttpsRedirect(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.toString() !== value) throw new Error();
    return value;
  } catch { throw new SlackCredentialRecoveryError('wrong_callback'); }
}
function requiredSlackId(value: unknown): string {
  if (typeof value !== 'string' || !SLACK_ID.test(value)) throw new SlackCredentialRecoveryError('invalid_response');
  return value;
}
function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SlackCredentialRecoveryError('invalid_response');
  }
  return value;
}
function configurationToken(value: string): string {
  if (!/^xoxe\.[A-Za-z0-9._-]{8,512}$/.test(value)) {
    throw new SlackCredentialRecoveryError('invalid_grant');
  }
  return value;
}
function parseScopes(value: unknown): string[] {
  if (typeof value !== 'string') throw new SlackCredentialRecoveryError('invalid_response');
  const scopes = [...new Set(value.split(',').map((scope) => scope.trim()).filter(Boolean))].sort();
  if (scopes.length > 128 || scopes.some((scope) => !/^[a-z][a-z0-9._:-]{0,127}$/.test(scope))) {
    throw new SlackCredentialRecoveryError('invalid_response');
  }
  return scopes;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
