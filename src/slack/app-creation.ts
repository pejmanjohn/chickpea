import { readBoundedText } from '../http/bounded-body.ts';
import { constantTimeEquals } from '../security/constant-time.ts';
import { sha256HexNode } from '../security/digest.ts';
import { digestSetupCapability } from '../auth/setup-capability.mjs';
import { safeSetupDestination } from '../auth/setup-handoff.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
import { IdentityStateError } from '../identity/errors.ts';
import type { IdentityStore, SlackSetupTransaction } from '../identity/types.ts';
import {
  prepareSlackCredentialBundle,
  type SlackCredentialDependencies,
} from './installation-credentials.ts';
import {
  slackManifestFingerprint,
  validateSlackAppManifest,
  type SlackAppManifest,
} from './app-manifest.ts';

export const SLACK_SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const SLACK_APP_CREATION_INTERRUPT_GRACE_MS = 60_000;
const SLACK_MANIFEST_CREATE_URL = 'https://slack.com/api/apps.manifest.create';
const MAX_SLACK_RESPONSE_BYTES = 64 * 1_024;
const MAX_CONFIGURATION_TOKEN_LENGTH = 512;
const MAX_SECRET_LENGTH = 4_096;

type SlackAppCreationErrorCode =
  | 'setup_invalid'
  | 'setup_expired'
  | 'setup_conflict'
  | 'invalid_configuration_token'
  | 'invalid_manifest'
  | 'ambiguous_external_effect'
  | 'slack_rejected';

export class SlackAppCreationError extends Error {
  readonly name = 'SlackAppCreationError';
  constructor(readonly code: SlackAppCreationErrorCode, message: string) { super(message); }
}

interface SlackSetupAuthority {
  digest: string;
  issuedAt: number;
}

export async function openSlackSetupTransaction(
  store: IdentityStore,
  input: {
    capability: string;
    authority: SlackSetupAuthority;
    destination?: string | null;
    canonicalAdminOrigin: string;
    now?: () => number;
  },
): Promise<SlackSetupTransaction> {
  const now = input.now?.() ?? Date.now();
  if (!Number.isSafeInteger(input.authority.issuedAt) ||
      input.authority.issuedAt > now + 5 * 60_000 ||
      now >= input.authority.issuedAt + SLACK_SETUP_TTL_MS) {
    throw new SlackAppCreationError('setup_expired', 'This private setup link expired. Create a new deployment setup link.');
  }
  let actualDigest: string;
  try { actualDigest = await digestSetupCapability(input.capability); } catch {
    throw new SlackAppCreationError('setup_invalid', 'This private setup link is invalid.');
  }
  if (!constantTimeEquals(actualDigest, input.authority.digest)) {
    throw new SlackAppCreationError('setup_invalid', 'This private setup link is invalid.');
  }
  try {
    const transaction = await store.reserveSlackSetupTransaction({
      locatorHash: sha256HexNode(input.capability),
      issuedAt: input.authority.issuedAt,
      expiresAt: input.authority.issuedAt + SLACK_SETUP_TTL_MS,
      destination: safeSetupDestination(input.destination),
      canonicalAdminOrigin: input.canonicalAdminOrigin,
    });
    if (transaction.expiresAt <= now) {
      throw new SlackAppCreationError('setup_expired', 'This private setup link expired. Create a new deployment setup link.');
    }
    return transaction;
  } catch (error) {
    if (error instanceof SlackAppCreationError) throw error;
    throw stateError(error);
  }
}

interface SlackAppCreationServiceDependencies {
  identity: IdentityStore;
  credentials: SlackCredentialDependencies;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => number;
}

export class SlackAppCreationService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly dependencies: SlackAppCreationServiceDependencies) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }

  async inspect(setupId: string): Promise<SlackSetupTransaction> {
    const current = await this.requiredSetup(setupId);
    if (current.state === 'app_creation_pending' &&
        this.now() - current.updatedAt >= SLACK_APP_CREATION_INTERRUPT_GRACE_MS) {
      return this.dependencies.identity.failSlackAppCreation({
        setupId: current.id,
        expectedRevision: current.revision,
        state: 'ambiguous_external_effect',
        errorCode: 'interrupted_app_creation',
      });
    }
    return current;
  }

  async create(input: {
    setupId: string;
    expectedRevision: number;
    configurationToken: string;
    manifest: SlackAppManifest;
  }): Promise<SlackSetupTransaction> {
    const token = configurationToken(input.configurationToken);
    const current = await this.requiredSetup(input.setupId);
    if (current.state === 'ambiguous_external_effect') {
      throw new SlackAppCreationError(
        'ambiguous_external_effect',
        'Slack may have created an app. Inspect Slack, then adopt the app or explicitly restart.',
      );
    }
    const fingerprint = slackManifestFingerprint(input.manifest);
    let pending: SlackSetupTransaction;
    try {
      pending = await this.dependencies.identity.beginSlackAppCreation({
        setupId: input.setupId,
        expectedRevision: input.expectedRevision,
        manifestFingerprint: fingerprint,
      });
    } catch (error) { throw stateError(error); }

    let response: Response;
    try {
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(slackApiMethodUrl(
        this.dependencies.apiBaseUrl,
        'apps.manifest.create',
        SLACK_MANIFEST_CREATE_URL,
      ), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ manifest: input.manifest }),
      });
    } catch {
      await this.markAmbiguous(pending, 'network_error');
      throw ambiguousError();
    }

    let payload: Record<string, unknown>;
    try { payload = await boundedJson(response); } catch {
      await this.markAmbiguous(pending, 'invalid_slack_response');
      throw ambiguousError();
    }
    if (!response.ok || payload.ok !== true) {
      const slackCode = safeSlackError(payload.error);
      if (response.status >= 500 || ['fatal_error', 'internal_error'].includes(slackCode)) {
        await this.markAmbiguous(pending, slackCode || 'slack_internal_error');
        throw ambiguousError();
      }
      await this.dependencies.identity.failSlackAppCreation({
        setupId: pending.id, expectedRevision: pending.revision,
        state: 'awaiting_app_creation', errorCode: slackCode || 'slack_rejected',
      });
      throw new SlackAppCreationError(
        slackCode === 'invalid_auth' || slackCode === 'token_expired'
          ? 'invalid_configuration_token' : 'slack_rejected',
        'Slack rejected the app creation request. Check the token and manifest, then retry.',
      );
    }

    let created: CreatedSlackApp;
    try { created = createdSlackApp(payload); } catch {
      await this.markAmbiguous(pending, 'incomplete_slack_success');
      throw ambiguousError();
    }
    try {
      return await this.recordSuccess(pending, fingerprint, created);
    } catch {
      await this.markAmbiguousIfPending(pending, 'local_persistence_error');
      throw ambiguousError();
    }
  }

  async adoptManual(input: {
    setupId: string;
    expectedRevision: number;
    appId: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    expectedManifest: SlackAppManifest;
    observedManifest: unknown;
  }): Promise<SlackSetupTransaction> {
    let fingerprint: string;
    try { fingerprint = validateSlackAppManifest(input.observedManifest, input.expectedManifest).fingerprint; } catch {
      throw new SlackAppCreationError('invalid_manifest', 'Slack app manifest does not match the expected callbacks, scopes, or events.');
    }
    const current = await this.requiredSetup(input.setupId);
    if (current.revision !== input.expectedRevision ||
        !['awaiting_app_creation', 'ambiguous_external_effect'].includes(current.state)) {
      throw new SlackAppCreationError('setup_conflict', 'Slack setup changed concurrently. Reload before continuing.');
    }
    return this.recordSuccess(current, fingerprint, {
      appId: bounded(input.appId, 'Slack app ID', 64),
      clientId: bounded(input.clientId, 'Slack client ID', 256),
      clientSecret: bounded(input.clientSecret, 'Slack client secret', MAX_SECRET_LENGTH),
      signingSecret: bounded(input.signingSecret, 'Slack signing secret', MAX_SECRET_LENGTH),
    });
  }

  async restart(input: { setupId: string; expectedRevision: number }): Promise<SlackSetupTransaction> {
    try { return await this.dependencies.identity.restartSlackAppCreation(input); }
    catch (error) { throw stateError(error); }
  }

  private async recordSuccess(
    setup: SlackSetupTransaction,
    fingerprint: string,
    created: CreatedSlackApp,
  ): Promise<SlackSetupTransaction> {
    const active = await this.dependencies.identity.getActiveSlackCredentialRevision(
      WORKSPACE_SLACK_INSTALLATION_ID,
    );
    const credential = await prepareSlackCredentialBundle(this.dependencies.credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      identityClass: 'workspace_installation',
      purpose: 'app_credentials',
      expectedActiveRevision: active?.revision ?? null,
      appId: created.appId,
      manifestFingerprint: fingerprint,
      secrets: {
        clientId: created.clientId,
        clientSecret: created.clientSecret,
        signingSecret: created.signingSecret,
      },
    });
    return this.dependencies.identity.recordSlackAppCreationSuccess({
      setupId: setup.id,
      expectedRevision: setup.revision,
      appId: created.appId,
      manifestFingerprint: fingerprint,
      credential,
    });
  }

  private async markAmbiguous(setup: SlackSetupTransaction, errorCode: string): Promise<void> {
    await this.dependencies.identity.failSlackAppCreation({
      setupId: setup.id, expectedRevision: setup.revision,
      state: 'ambiguous_external_effect', errorCode,
    });
  }

  private async markAmbiguousIfPending(setup: SlackSetupTransaction, errorCode: string): Promise<void> {
    const current = await this.dependencies.identity.getSlackSetupTransaction(setup.id);
    if (current?.state !== 'app_creation_pending') return;
    await this.markAmbiguous(current, errorCode);
  }

  private async requiredSetup(setupId: string): Promise<SlackSetupTransaction> {
    const setup = await this.dependencies.identity.getSlackSetupTransaction(setupId);
    if (!setup) throw new SlackAppCreationError('setup_invalid', 'Slack setup was not found.');
    if (setup.expiresAt <= this.now()) {
      throw new SlackAppCreationError('setup_expired', 'Slack setup expired. Create a new deployment setup link.');
    }
    return setup;
  }
}

function slackApiMethodUrl(baseUrl: string | undefined, method: string, fallback: string): string {
  const normalized = baseUrl?.trim().replace(/\/+$/, '');
  return normalized ? `${normalized}/${method}` : fallback;
}

interface CreatedSlackApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

function createdSlackApp(payload: Record<string, unknown>): CreatedSlackApp {
  const credentials = record(payload.credentials);
  return {
    appId: bounded(payload.app_id, 'Slack app ID', 64),
    clientId: bounded(credentials.client_id, 'Slack client ID', 256),
    clientSecret: bounded(credentials.client_secret, 'Slack client secret', MAX_SECRET_LENGTH),
    signingSecret: bounded(credentials.signing_secret, 'Slack signing secret', MAX_SECRET_LENGTH),
  };
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const text = await readBoundedText(response, {
    maxBytes: MAX_SLACK_RESPONSE_BYTES,
    onOversize: () => new Error('oversize'),
    onMissingBody: () => new Error('empty'),
    fatalDecoder: true,
  });
  return record(JSON.parse(text));
}

function configurationToken(value: string): string {
  const token = bounded(value, 'Slack configuration token', MAX_CONFIGURATION_TOKEN_LENGTH);
  if (!/^xoxe\.[A-Za-z0-9._-]{8,}$/.test(token)) {
    throw new SlackAppCreationError('invalid_configuration_token', 'Slack configuration token is invalid.');
  }
  return token;
}
function bounded(value: unknown, label: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SlackAppCreationError('slack_rejected', `${label} is invalid.`);
  }
  return normalized;
}
function safeSlackError(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_]{1,128}$/.test(value) ? value : '';
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function ambiguousError(): SlackAppCreationError {
  return new SlackAppCreationError(
    'ambiguous_external_effect',
    'Slack may have created an app. Inspect Slack, then adopt the app or explicitly restart.',
  );
}
function stateError(error: unknown): SlackAppCreationError {
  if (error instanceof SlackAppCreationError) return error;
  if (error instanceof IdentityStateError) {
    if (error.code === 'auth_operation_expired') {
      return new SlackAppCreationError('setup_expired', 'Slack setup expired. Create a new deployment setup link.');
    }
    if (error.code === 'auth_operation_conflict' || error.code === 'auth_control_conflict') {
      return new SlackAppCreationError('setup_conflict', 'Slack setup changed concurrently or is already in progress.');
    }
  }
  return new SlackAppCreationError('setup_invalid', 'Slack setup is invalid.');
}
