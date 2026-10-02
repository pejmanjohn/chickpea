import * as sqliteIdentityStoreModule from '../identity/store.ts';
import {
  deploymentServesManyInstallations,
  InstallationContextError,
  requireInstallationScope,
} from '../config/installation-scope.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { IdentityStateError } from '../identity/errors.ts';
import { getIdentityStore, type PlatformEnv } from '../config/state-backend.ts';
import { HOSTED_SLACK_INSTALLATION_ID, WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
import type {
  IdentityStore,
  SlackCredentialRevision,
  StageSlackCredentialRevisionInput,
} from '../identity/types.ts';
import {
  CREDENTIAL_KEYRING_UNAVAILABLE,
  generateCredentialKeyring,
  loadCredentialKeyring,
} from './credential-keyring.ts';
import { assertSlackInstallationCredentialId } from './hosted-slack-app.ts';
import {
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
  type CredentialKeyring,
  type SlackCredentialIdentityClass,
  type SlackCredentialPurpose,
  type SlackSecretEnvelopeContext,
} from './secret-envelope.ts';

export interface ResolvedSlackInstallationCredentials {
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

export interface SlackInstallationCredentialWrite {
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

export type StageMissingSlackCredentialBundleInput = RecoverMissingSlackCredentialBundleInput;

export class SlackInstallationCredentialRevisionError extends Error {
  constructor(readonly identityId: string, message = `Slack installation ${identityId} credentials changed`) {
    super(message);
    this.name = 'SlackInstallationCredentialRevisionError';
  }
}

export class SlackCredentialRecoveryOnlyError extends Error {
  readonly name = 'SlackCredentialRecoveryOnlyError';
  constructor() {
    super('Slack credentials require deployment recovery.');
  }
}

/**
 * The deployment's keyring did not load, so no installation's Slack
 * credentials can be read until it does; no installation is put into
 * recovery for it.
 */
export class SlackCredentialUnavailableError extends Error {
  readonly name = 'SlackCredentialUnavailableError';
  readonly code = CREDENTIAL_KEYRING_UNAVAILABLE;
  readonly retryable = true;
  constructor() {
    super('Slack credentials are unavailable until the deployment keyring loads (keyring_unavailable).');
  }
}

export interface ReplaceUnreadableHostedSlackBotBundleInput {
  expectedAppId: string;
  expectedTeamId: string;
  /** The installer the host's verified install grant names: an active Owner of this installation. */
  installerSlackUserId: string;
  botToken: string;
  botUserId: string;
  grantedScopes: string[];
  validatedAt: number;
  correlationId: string;
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
// One "deployment" per store: a standalone deployment has one, and a host
// serving many installations has one per installation it recently served.
const MAX_CACHED_DEPLOYMENTS = 64;

export async function stageSlackCredentialBundle(
  dependencies: SlackCredentialDependencies,
  input: StageSlackCredentialBundleInput,
): Promise<SlackCredentialRevision> {
  const prepared = await prepareSlackCredentialBundle(dependencies, input);
  try {
    return await dependencies.state.stageSlackCredentialRevision(prepared);
  } catch (error) {
    throw credentialRevisionError(input.identityId, error);
  }
}

/** Encrypt a candidate without persisting it, for a caller-owned atomic transaction. */
export async function prepareSlackCredentialBundle(
  dependencies: SlackCredentialDependencies,
  input: StageSlackCredentialBundleInput,
): Promise<StageSlackCredentialRevisionInput> {
  validateBundleShape(input.identityId, input.identityClass, input.purpose, input.secrets);
  const existingControl = await dependencies.state.getSlackCredentialControl();
  const control = existingControl ?? await dependencies.state.ensureSlackCredentialControl({
    currentKeyId: dependencies.keyring.currentKeyId,
  });
  if (control.currentKeyId !== dependencies.keyring.currentKeyId) {
    throw new SlackInstallationCredentialRevisionError(
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
  return {
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
  };
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
    throw new SlackInstallationCredentialRevisionError(input.identityId);
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
 * Asking for the other deployment mode's slot throws (see
 * slackInstallationCredentialId).
 */
export async function resolveSlackInstallationCredentials(
  identityId: string,
  env?: PlatformEnv,
  explicit?: SettingsStore | SlackCredentialResolutionDependencies,
): Promise<ResolvedSlackInstallationCredentials> {
  assertSlackInstallationCredentialId(identityId, isStateDependencies(explicit) ? explicit.env ?? env : env);
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
    // A deployment serving many installations shares one keyring: one that
    // does not load says nothing about this installation's data, so service
    // stops without locking every installation it touches into recovery.
    const resolutionEnv = isStateDependencies(explicit) ? explicit.env ?? env : env;
    if (deploymentServesManyInstallations(resolutionEnv)) throw new SlackCredentialUnavailableError();
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
  assertSlackInstallationCredentialId(identityId, isStateDependencies(explicit) ? explicit.env ?? env : env);
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
  identityId = WORKSPACE_SLACK_INSTALLATION_ID,
): Promise<ResolvedSlackControlPlaneAppCredentials> {
  if (identityId !== WORKSPACE_SLACK_INSTALLATION_ID) throw new Error('Unknown Slack installation.');
  const control = await requiredCredentialControl(dependencies.state);
  const active = await dependencies.state.getActiveSlackCredentialRevision(identityId);
  if (!active?.envelope || active.identityClass !== 'workspace_installation' ||
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
export async function writeSlackInstallationCredentials(
  target: SettingsStore | SlackCredentialDependencies,
  identityId: string,
  expectedRevision: string | null,
  values: SlackInstallationCredentialWrite,
): Promise<string> {
  if (identityId !== WORKSPACE_SLACK_INSTALLATION_ID) throw new Error('Unknown Slack installation.');
  if (!values.botToken.trim() || !values.signingSecret.trim()) {
    throw new Error('Slack installation bot token and signing secret are required');
  }
  if ((values.clientId && !values.clientSecret) || (!values.clientId && values.clientSecret)) {
    throw new Error('Slack app client credentials must be supplied as one complete pair');
  }
  const dependencies = isDependencies(target) ? target : compatibilityDependencies(target);
  const secrets = {
    ...(values.clientId ? { clientId: values.clientId, clientSecret: values.clientSecret! } : {}),
    signingSecret: values.signingSecret,
    botToken: values.botToken,
  };
  const candidate = await stageSlackCredentialBundle(dependencies, {
    identityId,
    identityClass: 'workspace_installation',
    purpose: 'connected_credentials',
    expectedActiveRevision: expectedRevision,
    appId: values.appId ?? 'AWORKSPACEDEFAULT',
    teamId: values.teamId ?? 'TWORKSPACEDEFAULT',
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

/** An installation's granted bot token, with the app, team and bot user it was granted for. */
export async function writeHostedSlackBotCredentials(
  dependencies: SlackCredentialDependencies,
  expectedRevision: string | null,
  values: Required<Pick<SlackInstallationCredentialWrite,
    'botToken' | 'botUserId' | 'appId' | 'teamId' | 'grantedScopes' | 'validatedAt'>>,
): Promise<string> {
  const candidate = await stageSlackCredentialBundle(dependencies, {
    identityId: HOSTED_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation',
    purpose: 'connected_credentials',
    expectedActiveRevision: expectedRevision,
    appId: values.appId,
    teamId: values.teamId,
    botUserId: values.botUserId,
    grantedScopes: values.grantedScopes,
    validatedAt: values.validatedAt,
    manifestFingerprint: null,
    secrets: { botToken: values.botToken },
  });
  const promoted = await promoteSlackCredentialBundle(dependencies, {
    identityId: HOSTED_SLACK_INSTALLATION_ID,
    candidateRevision: candidate.revision,
    expectedActiveRevision: expectedRevision,
  });
  return promoted.revision;
}

/** Tombstone and scrub ciphertext; never restore an earlier active revision. */
export async function clearSlackInstallationCredentials(
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
    throw new SlackInstallationCredentialRevisionError(identityId);
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
 * fenced. The caller may retire the prior slot only after the zero count,
 * and only once the settings store's encrypted revisions, which this neither
 * rewraps nor counts, are under the current key as well.
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
    throw new SlackInstallationCredentialRevisionError(
      WORKSPACE_SLACK_INSTALLATION_ID,
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
  const candidate = await stageMissingSlackCredentialBundle(dependencies, input);
  const promoted = await promoteSlackCredentialBundle(dependencies, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
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

/**
 * Lost-root recovery stages the same-app/team replacement but deliberately
 * leaves it inactive and keeps recovery_only closed until signed Events proof.
 */
export async function stageMissingSlackCredentialBundle(
  dependencies: SlackCredentialDependencies,
  input: StageMissingSlackCredentialBundleInput,
): Promise<SlackCredentialRevision> {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(input.correlationId)) {
    throw new Error('Slack credential recovery correlation is invalid.');
  }
  let control = await requiredCredentialControl(dependencies.state);
  const active = await dependencies.state.getActiveSlackCredentialRevision(
    WORKSPACE_SLACK_INSTALLATION_ID,
  );
  const prior = active?.revision === input.expectedRevision
    ? active
    : await dependencies.state.getSlackCredentialRevision(
        WORKSPACE_SLACK_INSTALLATION_ID,
        input.expectedRevision,
      );
  if (!prior || prior.identityClass !== 'workspace_installation' ||
      prior.purpose !== 'connected_credentials' ||
      prior.appId !== input.expectedAppId || prior.teamId !== input.expectedTeamId) {
    throw new SlackInstallationCredentialRevisionError(
      WORKSPACE_SLACK_INSTALLATION_ID,
      'Slack credential recovery must preserve the connected app and workspace.',
    );
  }
  // Reusing a lost key ID with different material makes the incident
  // indistinguishable from silent root substitution. Recovery must advance to
  // a new versioned slot so the epoch transition and old-key zero count remain
  // explicit and auditable.
  if (control.currentKeyId === dependencies.keyring.currentKeyId) {
    throw new SlackInstallationCredentialRevisionError(
      WORKSPACE_SLACK_INSTALLATION_ID,
      'Slack credential recovery requires a new encryption key version.',
    );
  }
  if (control.currentKeyId !== dependencies.keyring.currentKeyId) {
    const live = await dependencies.state.listLiveSlackCredentialRevisions();
    // This clean-slate store contains only the one workspace installation.
    if (live.some((revision) =>
      revision.identityId !== WORKSPACE_SLACK_INSTALLATION_ID
    )) {
      throw new SlackInstallationCredentialRevisionError(
        WORKSPACE_SLACK_INSTALLATION_ID,
        'Restore the prior key before repairing this Slack installation.',
      );
    }
    for (const revision of live) {
      if (revision.identityId !== WORKSPACE_SLACK_INSTALLATION_ID) continue;
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
    throw new SlackInstallationCredentialRevisionError(WORKSPACE_SLACK_INSTALLATION_ID);
  }
  return stageSlackCredentialBundle(dependencies, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation',
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
}

/**
 * The way out of recovery_only for a hosted installation whose bot-only
 * bundle cannot be read (its key slot is gone or it does not decrypt).
 * Standalone recovery needs a deployment recovery token, a new key version
 * and a signed events proof; a hosted installation has none of those, and
 * its keyring is the deployment's, shared by every installation. Its
 * authority is instead a bot grant the host verified live, for this
 * installation's app and team, naming as installer a person who is an active
 * Owner here.
 *
 * Every live revision must be this installation's bot for that app and
 * team. An unreadable active revision is replaced in one promotion, which
 * tombstones and scrubs it, so the installation always has an active bundle;
 * when the deployment's key changed, the epoch first moves to its current
 * key and the other live revisions are tombstoned. The replacement is
 * audited (key_missing or decrypt_failed) and the gate cleared. An active
 * bundle that already reads (a replacement interrupted after its promotion,
 * or a key slot restored) is kept, and the gate is cleared with the audit
 * replacement_completed; an ordinary reinstall of a readable bundle goes
 * through writeHostedSlackBotCredentials.
 */
export async function replaceUnreadableHostedSlackBotBundle(
  dependencies: SlackCredentialDependencies & { env: PlatformEnv },
  input: ReplaceUnreadableHostedSlackBotBundleInput,
): Promise<SlackCredentialRevision> {
  const { state, keyring } = dependencies;
  if (!requireInstallationScope(dependencies.env)) {
    throw new InstallationContextError(
      'installation_context_invalid',
      'Only an installation of a deployment serving many has a hosted Slack bundle.',
    );
  }
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(input.correlationId)) {
    throw new Error('Slack credential recovery correlation is invalid.');
  }
  const refuse = (message: string) => new SlackInstallationCredentialRevisionError(HOSTED_SLACK_INSTALLATION_ID, message);
  if ((await state.getAuthControl())?.healthGate !== 'recovery_only') {
    throw refuse('This installation is not waiting for Slack recovery.');
  }
  const owner = await state.resolveSlackIdentity(input.expectedTeamId, input.installerSlackUserId);
  const access = owner ? await state.getMembershipAccessOverlay(owner.membership.id) : undefined;
  if (!owner || owner.membership.role !== 'owner' || owner.membership.status !== 'active' ||
      access?.accessStatus === 'suspended') {
    throw refuse('Only an active Owner of this installation can reconnect it to Slack.');
  }
  let control = await requiredCredentialControl(state);
  const live = await state.listLiveSlackCredentialRevisions();
  if (live.some((revision) => revision.identityId !== HOSTED_SLACK_INSTALLATION_ID ||
      revision.appId !== input.expectedAppId || revision.teamId !== input.expectedTeamId)) {
    throw refuse('This installation holds credentials for another Slack app or workspace.');
  }
  const active = await state.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID);
  if (!active) throw refuse('This installation has no Slack bot credentials to replace.');
  const unreadable = await unreadableRevisionReason(dependencies, control.deploymentId, active);
  const audit = (reasonCode: string) => state.recordAuthAudit({
    event: 'authorization',
    outcome: 'success',
    action: 'slack_credentials.hosted_bundle_replaced',
    correlationId: input.correlationId,
    authenticatorKind: 'slack_install_grant',
    userId: owner.user.id,
    membershipId: owner.membership.id,
    reasonCode,
  });
  if (!unreadable) {
    await audit('replacement_completed');
    await leaveCredentialRecoveryOnly(state);
    return active;
  }
  if (control.currentKeyId !== keyring.currentKeyId) {
    for (const revision of live) {
      if (revision.revision === active.revision) continue;
      await state.tombstoneSlackCredentialRevision({
        identityId: revision.identityId,
        revision: revision.revision,
        expectedRotationEpoch: control.rotationEpoch,
      });
    }
    control = await state.beginSlackCredentialRotation({
      expectedEpoch: control.rotationEpoch,
      expectedCurrentKeyId: control.currentKeyId,
      nextKeyId: keyring.currentKeyId,
    });
  }
  deploymentIdByState.set(state, control.deploymentId);
  cacheByDeployment.get(control.deploymentId)?.delete(HOSTED_SLACK_INSTALLATION_ID);
  const candidate = await stageSlackCredentialBundle(dependencies, {
    identityId: HOSTED_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation',
    purpose: 'connected_credentials',
    expectedActiveRevision: active.revision,
    appId: input.expectedAppId,
    teamId: input.expectedTeamId,
    botUserId: input.botUserId,
    grantedScopes: input.grantedScopes,
    validatedAt: input.validatedAt,
    manifestFingerprint: null,
    secrets: { botToken: input.botToken },
  });
  const promoted = await promoteSlackCredentialBundle(dependencies, {
    identityId: HOSTED_SLACK_INSTALLATION_ID,
    candidateRevision: candidate.revision,
    expectedActiveRevision: active.revision,
  });
  await audit(unreadable);
  await leaveCredentialRecoveryOnly(state);
  return promoted;
}

/** Why the current keyring cannot read `revision`, or undefined when it can. Never latches recovery. */
async function unreadableRevisionReason(
  dependencies: SlackCredentialDependencies,
  deploymentId: string,
  revision: SlackCredentialRevision,
): Promise<'key_missing' | 'decrypt_failed' | undefined> {
  if (!revision.envelope) return 'decrypt_failed';
  if (!dependencies.keyring.keys[revision.envelope.keyId]) return 'key_missing';
  try {
    await decryptSlackSecretEnvelope(dependencies.keyring, revisionContext(deploymentId, revision), revision.envelope);
    return undefined;
  } catch {
    return 'decrypt_failed';
  }
}

export function invalidateSlackInstallationCredentialCache(
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

function missingCredentials(): ResolvedSlackInstallationCredentials {
  return { botToken: undefined, signingSecret: undefined, botUserId: undefined, connectionRevision: null };
}

function validateBundleShape(
  identityId: string,
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
  const allowed = identityClass === 'workspace_installation' &&
    (purpose === 'app_credentials' || purpose === 'connected_credentials');
  if (!allowed) throw new Error('Slack credential purpose does not match its identity class.');
  if (identityId === HOSTED_SLACK_INSTALLATION_ID) {
    if (purpose !== 'connected_credentials' || names.join() !== 'botToken') {
      throw new Error('A hosted Slack installation bundle holds only its bot token.');
    }
    return;
  }
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
  if (error instanceof SlackInstallationCredentialRevisionError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/credential encryption epoch changed/i.test(message)) {
    return new SlackInstallationCredentialRevisionError(identityId, 'Slack credential encryption epoch changed.');
  }
  return new SlackInstallationCredentialRevisionError(identityId);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function generateCredentialRevision(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
