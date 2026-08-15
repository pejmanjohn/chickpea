import * as sqliteIdentityStoreModule from '../identity/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { IdentityStateError } from '../identity/errors.ts';
import { getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import type { IdentityStore, SlackCredentialRevision } from '../identity/types.ts';
import { generateCredentialKeyring, loadCredentialKeyring } from './credential-keyring.ts';
import {
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
  type CredentialKeyring,
  type SlackCredentialIdentityClass,
  type SlackCredentialPurpose,
  type SlackSecretEnvelopeContext,
} from './secret-envelope.ts';

export interface ResolvedSlackIdentityCredentials {
  botToken: string | undefined;
  signingSecret: string | undefined;
  botUserId: string | undefined;
  connectionRevision: string | null;
}

export interface ResolvedSlackControlPlaneAppCredentials {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  connectionRevision: string;
  appId: string;
  teamId: string | null;
}

export interface ActiveSlackCredentialMetadata {
  revision: string;
  identityClass: SlackCredentialIdentityClass;
  purpose: SlackCredentialPurpose;
  appId: string;
  teamId: string | null;
  botUserId: string | null;
  grantedScopes: string[];
  validatedAt: number | null;
  manifestFingerprint: string | null;
}

export interface SlackIdentityCredentialWrite {
  botToken: string;
  signingSecret: string;
  botUserId?: string;
  appId?: string;
  teamId?: string;
  grantedScopes?: string[];
  validatedAt?: number;
  manifestFingerprint?: string;
  /** U3 supplies this pair; without it, the bundle cannot authorize OIDC. */
  clientId?: string;
  clientSecret?: string;
}

/** Public pending-handshake metadata is the only per-identity settings seam. */
export function slackIdentityPendingMetadataSettingKey(identityId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(identityId) ||
      identityId === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) {
    throw new Error('Invalid dedicated Slack identity id');
  }
  return `slack.identity.${identityId}.pendingEnvelope`;
}

/**
 * @deprecated Compile-only U2 removal marker for pre-U2 tests. The returned
 * object contains only public pending metadata; removed plaintext locators are
 * typed `never` and do not exist at runtime.
 */
export function slackIdentityCredentialSettingKeys(identityId: string): {
  pendingEnvelope: string;
  connectionRevision: never;
  botToken: never;
  signingSecret: never;
  botUserId: never;
} {
  return { pendingEnvelope: slackIdentityPendingMetadataSettingKey(identityId) } as {
    pendingEnvelope: string;
    connectionRevision: never;
    botToken: never;
    signingSecret: never;
    botUserId: never;
  };
}

export interface SlackCredentialDependencies {
  state: IdentityStore;
  keyring: CredentialKeyring;
}

export interface SlackCredentialResolutionDependencies {
  state: IdentityStore;
  /** Lazy target loading lets missing Worker slots enter recovery_only first. */
  keyring?: CredentialKeyring | undefined;
  env?: PlatformEnv | undefined;
}

export interface StageSlackCredentialBundleInput {
  identityId: string;
  identityClass: SlackCredentialIdentityClass;
  purpose: SlackCredentialPurpose;
  expectedActiveRevision: string | null;
  appId: string;
  teamId?: string | null;
  botUserId?: string | null;
  grantedScopes?: string[];
  validatedAt?: number | null;
  manifestFingerprint?: string | null;
  secrets: Record<string, string>;
}

export interface PromoteSlackCredentialBundleInput {
  identityId: string;
  candidateRevision: string;
  expectedActiveRevision: string | null;
}

export interface RecoverMissingSlackCredentialBundleInput {
  expectedRevision: string;
  expectedAppId: string;
  expectedTeamId: string;
  correlationId: string;
  botUserId: string;
  grantedScopes: string[];
  validatedAt: number;
  manifestFingerprint?: string | null;
  secrets: {
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    botToken: string;
  };
}

export class SlackIdentityCredentialRevisionError extends Error {
  constructor(readonly identityId: string, message = `Slack identity ${identityId} credentials changed`) {
    super(message);
    this.name = 'SlackIdentityCredentialRevisionError';
  }
}

export class SlackCredentialRecoveryOnlyError extends Error {
  readonly name = 'SlackCredentialRecoveryOnlyError';
  constructor() {
    super('Slack credentials require deployment recovery.');
  }
}

interface CachedCredentialBundle {
  revision: string;
  keyId: string;
  keyMaterial: string;
  rotationEpoch: number;
  envelopeContextFingerprint: string;
  secrets: Record<string, string>;
}

let cacheByDeployment = new Map<string, Map<string, CachedCredentialBundle>>();
let deploymentIdByState = new WeakMap<IdentityStore, string>();
const testCompatibilityBySettings = new WeakMap<SettingsStore, SlackCredentialDependencies>();
const MAX_CACHED_IDENTITIES = 64;
const MAX_CACHED_DEPLOYMENTS = 8;

export async function stageSlackCredentialBundle(
  dependencies: SlackCredentialDependencies,
  input: StageSlackCredentialBundleInput,
): Promise<SlackCredentialRevision> {
  validateBundleShape(input.identityClass, input.purpose, input.secrets);
  const existingControl = await dependencies.state.getSlackCredentialControl();
  const control = existingControl ?? await dependencies.state.ensureSlackCredentialControl({
    currentKeyId: dependencies.keyring.currentKeyId,
  });
  if (control.currentKeyId !== dependencies.keyring.currentKeyId) {
    throw new SlackIdentityCredentialRevisionError(
      input.identityId,
      'Slack credential encryption epoch changed.',
    );
  }
  const revision = generateCredentialRevision();
  const envelope = await encryptSlackSecretEnvelope(
    dependencies.keyring,
    envelopeContext(control.deploymentId, input, revision),
    input.secrets,
  );
  try {
    return await dependencies.state.stageSlackCredentialRevision({
      expectedRotationEpoch: control.rotationEpoch,
      expectedActiveRevision: input.expectedActiveRevision,
      revision,
      identityId: input.identityId,
      identityClass: input.identityClass,
      purpose: input.purpose,
      appId: input.appId,
      teamId: input.teamId ?? null,
      botUserId: input.botUserId ?? null,
      grantedScopes: input.grantedScopes ?? [],
      validatedAt: input.validatedAt ?? null,
      manifestFingerprint: input.manifestFingerprint ?? null,
      envelope,
    });
  } catch (error) {
    throw credentialRevisionError(input.identityId, error);
  }
}

export async function promoteSlackCredentialBundle(
  dependencies: SlackCredentialDependencies,
  input: PromoteSlackCredentialBundleInput,
): Promise<SlackCredentialRevision> {
  const control = await requiredCredentialControl(dependencies.state);
  const candidate = await dependencies.state.getSlackCredentialRevision(
    input.identityId,
    input.candidateRevision,
  );
  if (!candidate?.envelope || candidate.status !== 'candidate') {
    throw new SlackIdentityCredentialRevisionError(input.identityId);
  }
  const secrets = await decryptRevisionOrRecover(dependencies, control.deploymentId, candidate);
  try {
    const promoted = await dependencies.state.promoteSlackCredentialRevision({
      identityId: input.identityId,
      candidateRevision: input.candidateRevision,
      expectedActiveRevision: input.expectedActiveRevision,
      expectedRotationEpoch: control.rotationEpoch,
    });
    primeCache(
      dependencies.state,
      control.deploymentId,
      dependencies.keyring,
      promoted,
      secrets,
    );
    return promoted;
  } catch (error) {
    throw credentialRevisionError(input.identityId, error);
  }
}

/**
 * Resolve one active encrypted revision. Environment credential variables are
 * never an execution source; setup must import a complete bundle into this
 * encrypted store before Slack traffic or control-plane auth can use it.
 */
export async function resolveSlackIdentityCredentials(
  identityId: string,
  env?: PlatformEnv,
  explicit?: SettingsStore | SlackCredentialResolutionDependencies,
): Promise<ResolvedSlackIdentityCredentials> {
  const state = isStateDependencies(explicit)
    ? explicit.state
    : explicit ? compatibilityDependencies(explicit).state : getIdentityStore(env);
  const [control, active] = await Promise.all([
    state.getSlackCredentialControl(),
    state.getActiveSlackCredentialRevision(identityId),
  ]);
  if (!active) {
    return missingCredentials();
  }
  if (!control || !active?.envelope) {
    await enterCredentialRecoveryOnly(state);
    throw new SlackCredentialRecoveryOnlyError();
  }
  deploymentIdByState.set(state, control.deploymentId);
  let dependencies: SlackCredentialDependencies;
  try {
    dependencies = isStateDependencies(explicit)
      ? {
          state: explicit.state,
          keyring: explicit.keyring ?? loadCredentialKeyring(explicit.env ?? env),
        }
      : explicit ? compatibilityDependencies(explicit) : { state, keyring: loadCredentialKeyring(env) };
  } catch {
    await enterCredentialRecoveryOnly(state);
    throw new SlackCredentialRecoveryOnlyError();
  }
  const cached = cacheByDeployment.get(control.deploymentId)?.get(identityId);
  let secrets: Record<string, string>;
  if (cached && cached.revision === active.revision &&
      cached.keyId === active.envelope.keyId &&
      cached.keyMaterial === dependencies.keyring.keys[active.envelope.keyId] &&
      cached.rotationEpoch === active.rotationEpoch &&
      cached.envelopeContextFingerprint === credentialEnvelopeContextFingerprint(
        control.deploymentId,
        active,
      )) {
    secrets = cached.secrets;
  } else {
    secrets = await decryptRevisionOrRecover(dependencies, control.deploymentId, active);
    primeCache(state, control.deploymentId, dependencies.keyring, active, secrets);
  }
  return {
    botToken: nonEmpty(secrets.botToken),
    signingSecret: nonEmpty(secrets.signingSecret),
    botUserId: active.botUserId ?? undefined,
    connectionRevision: active.revision,
  };
}

/** Read the public half of the canonical active revision without decrypting. */
export async function readActiveSlackCredentialMetadata(
  identityId: string,
  env?: PlatformEnv,
  explicit?: SettingsStore | SlackCredentialResolutionDependencies,
): Promise<ActiveSlackCredentialMetadata | undefined> {
  const state = isStateDependencies(explicit)
    ? explicit.state
    : explicit ? compatibilityDependencies(explicit).state : getIdentityStore(env);
  const active = await state.getActiveSlackCredentialRevision(identityId);
  if (!active) return undefined;
  return {
    revision: active.revision,
    identityClass: active.identityClass,
    purpose: active.purpose,
    appId: active.appId,
    teamId: active.teamId,
    botUserId: active.botUserId,
    grantedScopes: [...active.grantedScopes],
    validatedAt: active.validatedAt,
    manifestFingerprint: active.manifestFingerprint,
  };
}

export async function resolveSlackControlPlaneAppCredentials(
  dependencies: SlackCredentialDependencies,
  identityId = WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
): Promise<ResolvedSlackControlPlaneAppCredentials> {
  if (identityId !== WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) {
    throw new Error('Dedicated Slack identities cannot supply control-plane OIDC credentials.');
  }
  const control = await requiredCredentialControl(dependencies.state);
  const active = await dependencies.state.getActiveSlackCredentialRevision(identityId);
  if (!active?.envelope || active.identityClass !== 'workspace_default' ||
      !['app_credentials', 'connected_credentials'].includes(active.purpose)) {
    throw new Error('Control-plane Slack app credentials are unavailable.');
  }
  const secrets = await decryptRevisionOrRecover(dependencies, control.deploymentId, active);
  if (!secrets.clientId || !secrets.clientSecret || !secrets.signingSecret) {
    // Explicit U2-to-U3 seam: a legacy bot-only connection may exist but can
    // never authorize the new OIDC gateway.
    throw new Error('Control-plane Slack app credentials are incomplete.');
  }
  return {
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
    signingSecret: secrets.signingSecret,
    connectionRevision: active.revision,
    appId: active.appId,
    teamId: active.teamId,
  };
}

/** Revision-fenced replacement retained for existing bot connection callers. */
export async function writeSlackIdentityCredentials(
  target: SettingsStore | SlackCredentialDependencies,
  identityId: string,
  expectedRevision: string | null,
  values: SlackIdentityCredentialWrite,
): Promise<string> {
  if (!values.botToken.trim() || !values.signingSecret.trim()) {
    throw new Error('Slack identity bot token and signing secret are required');
  }
  if ((values.clientId && !values.clientSecret) || (!values.clientId && values.clientSecret)) {
    throw new Error('Slack app client credentials must be supplied as one complete pair');
  }
  const dependencies = isDependencies(target) ? target : compatibilityDependencies(target);
  const workspaceDefault = identityId === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
  const secrets = {
    ...(values.clientId ? { clientId: values.clientId, clientSecret: values.clientSecret! } : {}),
    signingSecret: values.signingSecret,
    botToken: values.botToken,
  };
  const candidate = await stageSlackCredentialBundle(dependencies, {
    identityId,
    identityClass: workspaceDefault ? 'workspace_default' : 'dedicated_bot',
    purpose: workspaceDefault ? 'connected_credentials' : 'bot_credentials',
    expectedActiveRevision: expectedRevision,
    appId: values.appId ?? (workspaceDefault ? 'AWORKSPACEDEFAULT' : syntheticSlackAppId(identityId)),
    teamId: values.teamId ?? (workspaceDefault ? 'TWORKSPACEDEFAULT' : null),
    botUserId: values.botUserId ?? null,
    grantedScopes: values.grantedScopes ?? [],
    validatedAt: values.validatedAt ?? null,
    manifestFingerprint: values.manifestFingerprint ?? null,
    secrets,
  });
  const promoted = await promoteSlackCredentialBundle(dependencies, {
    identityId,
    candidateRevision: candidate.revision,
    expectedActiveRevision: expectedRevision,
  });
  return promoted.revision;
}

/** Tombstone and scrub ciphertext; never restore an earlier active revision. */
export async function clearSlackIdentityCredentials(
  target: SettingsStore | SlackCredentialDependencies,
  identityId: string,
  expectedRevision: string | null,
  additionalDeletes: readonly string[] = [],
): Promise<string> {
  const dependencies = isDependencies(target) ? target : compatibilityDependencies(target);
  const [control, active] = await Promise.all([
    dependencies.state.getSlackCredentialControl(),
    dependencies.state.getActiveSlackCredentialRevision(identityId),
  ]);
  if ((active?.revision ?? null) !== expectedRevision) {
    throw new SlackIdentityCredentialRevisionError(identityId);
  }
  if (active && control) {
    try {
      await dependencies.state.tombstoneSlackCredentialRevision({
        identityId,
        revision: active.revision,
        expectedRotationEpoch: control.rotationEpoch,
      });
    } catch (error) {
      if (error instanceof IdentityStateError &&
          ['credential_revision_conflict', 'credential_rotation_conflict'].includes(error.code)) {
        throw credentialRevisionError(identityId, error);
      }
      throw error;
    }
  }
  if (!isDependencies(target)) {
    for (const key of additionalDeletes) await target.deleteSetting(key);
  }
  if (control) {
    deploymentIdByState.set(dependencies.state, control.deploymentId);
    cacheByDeployment.get(control.deploymentId)?.delete(identityId);
  }
  return active?.revision ?? generateCredentialRevision();
}

/**
 * Advance the epoch first, then rewrap every live revision. A crash is
 * resumable because old/new keys coexist and old-key writes are already
 * fenced. The caller may retire the prior slot only after the zero count.
 */
export async function rotateSlackCredentialEncryption(
  dependencies: SlackCredentialDependencies,
  input: { expectedEpoch: number; previousKeyId: string },
): Promise<{ rotationEpoch: number; rewrapped: number; remainingPreviousKey: number }> {
  let control = await requiredCredentialControl(dependencies.state);
  if (control.rotationEpoch === input.expectedEpoch &&
      control.currentKeyId === input.previousKeyId) {
    control = await dependencies.state.beginSlackCredentialRotation({
      expectedEpoch: input.expectedEpoch,
      expectedCurrentKeyId: input.previousKeyId,
      nextKeyId: dependencies.keyring.currentKeyId,
    });
  } else if (!(control.rotationEpoch === input.expectedEpoch + 1 &&
               control.currentKeyId === dependencies.keyring.currentKeyId)) {
    throw new SlackIdentityCredentialRevisionError(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      'Slack credential encryption epoch changed.',
    );
  }
  let rewrapped = 0;
  for (const revision of await dependencies.state.listLiveSlackCredentialRevisions()) {
    if (!revision.envelope || revision.envelope.keyId === control.currentKeyId) continue;
    const secrets = await decryptRevisionOrRecover(dependencies, control.deploymentId, revision);
    const envelope = await encryptSlackSecretEnvelope(
      dependencies.keyring,
      revisionContext(control.deploymentId, revision),
      secrets,
    );
    await dependencies.state.rewrapSlackCredentialRevision({
      identityId: revision.identityId,
      revision: revision.revision,
      expectedKeyId: revision.envelope.keyId,
      expectedRotationEpoch: control.rotationEpoch,
      envelope,
    });
    rewrapped += 1;
    deploymentIdByState.set(dependencies.state, control.deploymentId);
    cacheByDeployment.get(control.deploymentId)?.delete(revision.identityId);
  }
  const remainingPreviousKey = await dependencies.state.countLiveSlackCredentialRevisionsByKey(
    input.previousKeyId,
    control.rotationEpoch,
  );
  return { rotationEpoch: control.rotationEpoch, rewrapped, remainingPreviousKey };
}

/**
 * Deployment-authorized lost-root recovery. It can only replace the
 * workspace-default bundle with a freshly validated complete bot grant for the
 * exact prior app/team. No people, sessions, membership, or invitations are
 * read or mutated here.
 */
export async function recoverMissingSlackCredentialBundle(
  dependencies: SlackCredentialDependencies,
  input: RecoverMissingSlackCredentialBundleInput,
): Promise<SlackCredentialRevision> {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(input.correlationId)) {
    throw new Error('Slack credential recovery correlation is invalid.');
  }
  let control = await requiredCredentialControl(dependencies.state);
  const active = await dependencies.state.getActiveSlackCredentialRevision(
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  );
  const prior = active?.revision === input.expectedRevision
    ? active
    : await dependencies.state.getSlackCredentialRevision(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        input.expectedRevision,
      );
  if (!prior || prior.identityClass !== 'workspace_default' ||
      prior.purpose !== 'connected_credentials' ||
      prior.appId !== input.expectedAppId || prior.teamId !== input.expectedTeamId) {
    throw new SlackIdentityCredentialRevisionError(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      'Slack credential recovery must preserve the connected app and workspace.',
    );
  }
  // Reusing a lost key ID with different material makes the incident
  // indistinguishable from silent root substitution. Recovery must advance to
  // a new versioned slot so the epoch transition and old-key zero count remain
  // explicit and auditable.
  if (control.currentKeyId === dependencies.keyring.currentKeyId) {
    throw new SlackIdentityCredentialRevisionError(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      'Slack credential recovery requires a new encryption key version.',
    );
  }
  if (control.currentKeyId !== dependencies.keyring.currentKeyId) {
    const live = await dependencies.state.listLiveSlackCredentialRevisions();
    // Lost-root recovery is scoped to the workspace-default realm. A
    // dedicated live revision may still sit on any prior key after a partially
    // completed rotation; never mark the deployment healthy while that
    // isolated identity would remain undecryptable or outside the new root.
    if (live.some((revision) =>
      revision.identityId !== WORKSPACE_DEFAULT_SLACK_IDENTITY_ID
    )) {
      throw new SlackIdentityCredentialRevisionError(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        'Restore the prior key before repairing isolated dedicated Slack identities.',
      );
    }
    for (const revision of live) {
      if (revision.identityId !== WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) continue;
      await dependencies.state.tombstoneSlackCredentialRevision({
        identityId: revision.identityId,
        revision: revision.revision,
        expectedRotationEpoch: control.rotationEpoch,
      });
    }
    control = await dependencies.state.beginSlackCredentialRotation({
      expectedEpoch: control.rotationEpoch,
      expectedCurrentKeyId: control.currentKeyId,
      nextKeyId: dependencies.keyring.currentKeyId,
    });
  }
  if (control.currentKeyId !== dependencies.keyring.currentKeyId) {
    throw new SlackIdentityCredentialRevisionError(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
  }
  const candidate = await stageSlackCredentialBundle(dependencies, {
    identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    identityClass: 'workspace_default',
    purpose: 'connected_credentials',
    expectedActiveRevision: null,
    appId: prior.appId,
    teamId: prior.teamId,
    botUserId: input.botUserId,
    grantedScopes: input.grantedScopes,
    validatedAt: input.validatedAt,
    manifestFingerprint: input.manifestFingerprint ?? prior.manifestFingerprint,
    secrets: input.secrets,
  });
  const promoted = await promoteSlackCredentialBundle(dependencies, {
    identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    candidateRevision: candidate.revision,
    expectedActiveRevision: null,
  });
  await dependencies.state.recordAuthAudit({
    event: 'authorization',
    outcome: 'success',
    action: 'slack_credentials.missing_key_recovered',
    correlationId: input.correlationId,
    authenticatorKind: 'deployment_token',
    reasonCode: 'same_app_team_reauthorized',
  });
  await leaveCredentialRecoveryOnly(dependencies.state);
  return promoted;
}

export function invalidateSlackIdentityCredentialCache(
  state?: IdentityStore | SettingsStore,
  identityId?: string,
): void {
  if (!state) {
    cacheByDeployment = new Map();
    deploymentIdByState = new WeakMap();
    return;
  }
  const actual = isIdentityStore(state) ? state : testCompatibilityBySettings.get(state)?.state;
  if (!actual) return;
  const deploymentId = deploymentIdByState.get(actual);
  if (!deploymentId) return;
  if (!identityId) cacheByDeployment.delete(deploymentId);
  else cacheByDeployment.get(deploymentId)?.delete(identityId);
}

function compatibilityDependencies(store: SettingsStore): SlackCredentialDependencies {
  let dependencies = testCompatibilityBySettings.get(store);
  if (!dependencies) {
    // Test-only fixture seam for legacy unit harnesses that inject just a
    // SettingsStore. Production call sites must pass persistent state/keyring
    // dependencies; this adapter never writes plaintext to app_settings.
    dependencies = {
      state: new sqliteIdentityStoreModule.SqliteIdentityStore(':memory:'),
      keyring: generateCredentialKeyring(),
    };
    testCompatibilityBySettings.set(store, dependencies);
  }
  return dependencies;
}

function isDependencies(value: unknown): value is SlackCredentialDependencies {
  return Boolean(value && typeof value === 'object' && 'state' in value && 'keyring' in value);
}

function isStateDependencies(value: unknown): value is SlackCredentialResolutionDependencies {
  return Boolean(value && typeof value === 'object' && 'state' in value);
}

function isIdentityStore(value: IdentityStore | SettingsStore): value is IdentityStore {
  return 'getSlackCredentialControl' in value;
}

function missingCredentials(): ResolvedSlackIdentityCredentials {
  return { botToken: undefined, signingSecret: undefined, botUserId: undefined, connectionRevision: null };
}

function validateBundleShape(
  identityClass: SlackCredentialIdentityClass,
  purpose: SlackCredentialPurpose,
  secrets: Record<string, string>,
): void {
  const names = Object.keys(secrets).sort();
  const permitted = new Set(['botToken', 'clientId', 'clientSecret', 'signingSecret']);
  if (names.length === 0 || names.some((name) => !permitted.has(name))) {
    throw new Error('Slack credential bundle contains unsupported fields.');
  }
  for (const name of names) {
    const value = secrets[name];
    const max = name === 'botToken' ? 16_384 : 4_096;
    if (typeof value !== 'string' || !value.trim() ||
        new TextEncoder().encode(value).byteLength > max) {
      throw new Error('Slack credential bundle contains an invalid field.');
    }
  }
  if (new TextEncoder().encode(JSON.stringify(secrets)).byteLength > 32_768) {
    throw new Error('Slack credential bundle is too large.');
  }
  const allowed = identityClass === 'dedicated_bot'
    ? purpose === 'bot_credentials'
    : purpose === 'app_credentials' || purpose === 'connected_credentials';
  if (!allowed) throw new Error('Slack credential purpose does not match its identity class.');
  const hasApp = names.includes('clientId') && names.includes('clientSecret');
  const partialApp = names.includes('clientId') !== names.includes('clientSecret');
  if (partialApp || !names.includes('signingSecret')) {
    throw new Error('Slack credential bundle is incomplete.');
  }
  if (purpose === 'app_credentials' && (!hasApp || names.includes('botToken'))) {
    throw new Error('Slack app credential bundle is incomplete.');
  }
  if (purpose !== 'app_credentials' && !names.includes('botToken')) {
    throw new Error('Slack bot credential bundle is incomplete.');
  }
  if (identityClass === 'dedicated_bot' && hasApp) {
    throw new Error('Dedicated Slack identities cannot store control-plane app credentials.');
  }
}

async function decryptRevisionOrRecover(
  dependencies: SlackCredentialDependencies,
  deploymentId: string,
  revision: SlackCredentialRevision,
): Promise<Record<string, string>> {
  if (!revision.envelope || !dependencies.keyring.keys[revision.envelope.keyId]) {
    await enterCredentialRecoveryOnly(dependencies.state);
    throw new SlackCredentialRecoveryOnlyError();
  }
  try {
    return await decryptSlackSecretEnvelope(
      dependencies.keyring,
      revisionContext(deploymentId, revision),
      revision.envelope,
    );
  } catch {
    await enterCredentialRecoveryOnly(dependencies.state);
    throw new SlackCredentialRecoveryOnlyError();
  }
}

async function enterCredentialRecoveryOnly(state: IdentityStore): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const control = await state.ensureAuthControl();
    if (control.healthGate === 'recovery_only') return;
    try {
      await state.updateAuthControl({ expectedRevision: control.revision, healthGate: 'recovery_only' });
      return;
    } catch {
      if (attempt === 1) throw new SlackCredentialRecoveryOnlyError();
    }
  }
}

async function leaveCredentialRecoveryOnly(state: IdentityStore): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const control = await state.ensureAuthControl();
    if (control.healthGate === 'normal') return;
    try {
      await state.updateAuthControl({ expectedRevision: control.revision, healthGate: 'normal' });
      return;
    } catch {
      if (attempt === 2) throw new SlackCredentialRecoveryOnlyError();
    }
  }
}

async function requiredCredentialControl(state: IdentityStore) {
  const control = await state.getSlackCredentialControl();
  if (!control) throw new Error('Slack credential control is unavailable.');
  return control;
}

function envelopeContext(
  deploymentId: string,
  input: StageSlackCredentialBundleInput,
  revision: string,
): SlackSecretEnvelopeContext {
  return {
    deploymentId,
    identityId: input.identityId,
    identityClass: input.identityClass,
    appId: input.appId,
    teamId: input.teamId ?? null,
    purpose: input.purpose,
    revision,
  };
}

function revisionContext(
  deploymentId: string,
  revision: SlackCredentialRevision,
): SlackSecretEnvelopeContext {
  return {
    deploymentId,
    identityId: revision.identityId,
    identityClass: revision.identityClass,
    appId: revision.appId,
    teamId: revision.teamId,
    purpose: revision.purpose,
    revision: revision.revision,
  };
}

function primeCache(
  state: IdentityStore,
  deploymentId: string,
  keyring: CredentialKeyring,
  revision: SlackCredentialRevision,
  secrets: Record<string, string>,
): void {
  if (!revision.envelope) return;
  const keyMaterial = keyring.keys[revision.envelope.keyId];
  if (!keyMaterial) return;
  deploymentIdByState.set(state, deploymentId);
  let cache = cacheByDeployment.get(deploymentId);
  if (!cache) {
    cache = new Map();
    cacheByDeployment.set(deploymentId, cache);
  }
  cache.set(revision.identityId, {
    revision: revision.revision,
    keyId: revision.envelope.keyId,
    keyMaterial,
    rotationEpoch: revision.rotationEpoch,
    envelopeContextFingerprint: credentialEnvelopeContextFingerprint(deploymentId, revision),
    secrets,
  });
  while (cache.size > MAX_CACHED_IDENTITIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
  while (cacheByDeployment.size > MAX_CACHED_DEPLOYMENTS) {
    const oldest = cacheByDeployment.keys().next().value as string | undefined;
    if (!oldest) break;
    cacheByDeployment.delete(oldest);
  }
}

function credentialEnvelopeContextFingerprint(
  deploymentId: string,
  revision: SlackCredentialRevision,
): string {
  if (!revision.envelope) {
    throw new Error('Slack credential envelope is unavailable.');
  }
  return JSON.stringify([
    deploymentId,
    revision.identityId,
    revision.identityClass,
    revision.appId,
    revision.teamId,
    revision.purpose,
    revision.revision,
    revision.envelope.version,
    revision.envelope.algorithm,
    revision.envelope.keyId,
    revision.envelope.nonce,
    revision.envelope.ciphertext,
  ]);
}

function credentialRevisionError(identityId: string, error: unknown): Error {
  if (error instanceof SlackIdentityCredentialRevisionError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/credential encryption epoch changed/i.test(message)) {
    return new SlackIdentityCredentialRevisionError(identityId, 'Slack credential encryption epoch changed.');
  }
  return new SlackIdentityCredentialRevisionError(identityId);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function generateCredentialRevision(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function syntheticSlackAppId(identityId: string): string {
  const suffix = identityId.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 62);
  return `A${suffix || 'DEDICATED'}`;
}
