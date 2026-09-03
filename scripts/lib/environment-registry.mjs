import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  readTargetLock,
  readTargetLockStatus,
  targetLockPath,
} from '../../qa/live/safety/lock.ts';

export const activeEnvironmentTargets = Object.freeze(['amber', 'cobalt']);
export const inactiveEnvironmentTargets = Object.freeze([
  'fern', 'dedicated-qa', 'install', 'demo', 'spare', 'qualification', 'deep',
]);
export const ENVIRONMENT_REGISTRY_SCHEMA = 'chickpea-environment-registry/v2';
const LEGACY_ENVIRONMENT_REGISTRY_SCHEMA = 'chickpea-environment-registry/v1';
export const ENVIRONMENT_MARKER_SCHEMA = 'chickpea-environment-claim/v1';
export const ENVIRONMENT_STATUS_SCHEMA = 'chickpea-environment-status/v1';

const DEFAULT_LEASE_DURATION_MS = 8 * 60 * 60 * 1_000;
const MAX_AUDIT_EVENTS = 1_000;
const REGISTRY_FILE = 'registry.json';
const REGISTRY_LOCK = 'registry.lock';
const REGISTRY_REVISIONS = 'revisions';
const REGISTRY_SNAPSHOT_TEMPORARY = /^\.revision-[0-9]{16}\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const MARKER_FILE = '.chickpea-environment';
const MACHINE_IDENTITY_SCHEMA = 'chickpea-machine-identity/v1';
const SECRET_FIELD = /(?:^|_)(?:secret|token|password|credential|cookie|private[_-]?key|browser[_-]?profile|email)(?:$|_)/iu;
const SECRET_VALUE = /^(?:xox[abprs]-|xoxe[.-]|sk-[A-Za-z0-9]|gh[opusr]_|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/u;
const DEPLOY_PRIOR_STATE_FILE = 'deploy-prior-state.json';
const TARGET_KEYS = Object.freeze([
  'target', 'role', 'transport', 'workerName', 'authDatabaseBinding',
  'authDatabaseName', 'authDatabaseId', 'workspaceId', 'workspaceLabel',
  'slackAppId', 'slackAppLabel', 'botUserId', 'providerProjectId',
  'providerAuthConfigId', 'timezone', 'evidenceRoot', 'bindingIdentities',
  'schemaGeneration', 'servingVersion', 'sourceRevision', 'sourceDirty',
  'reachable', 'identityMatches', 'computerUseSurfaces', 'missingActorAliases',
  'claim', 'lastAttestation',
]);
const CLAIM_KEYS = Object.freeze([
  'schemaVersion', 'target', 'canonicalWorktreePath', 'branch', 'leaseNonce',
  'claimedRevision', 'registryRevision', 'hostFingerprint', 'claimedAt', 'expiresAt',
]);
const DEPLOY_RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'target', 'sourceRevision', 'sourceDirty', 'claimNonce',
  'registryRevision', 'schemaGeneration', 'workerName', 'authDatabaseBinding',
  'authDatabaseId', 'tagStateId', 'slackTeamId', 'slackAppId', 'slackBotUserId',
  'transport', 'activeVersion', 'manifestDigest', 'setupContractDigest',
  'baselineDigest', 'issuedAt', 'receiptDigest',
]);
const DEPLOY_INTENT_KEYS = Object.freeze([
  'schemaVersion', 'target', 'runId', 'intentId', 'claimNonce', 'claimedRevision',
  'sourceDirty', 'registryRevision', 'schemaGeneration', 'workerName',
  'authDatabaseId', 'tagStateId', 'priorServingVersion', 'priorSchemaGeneration', 'providerContext',
  'deploymentMetadata', 'createdAt', 'intentDigest',
]);
const DEPLOYMENT_METADATA_KEYS = Object.freeze([
  'target', 'sourceRevision', 'sourceDirty', 'claimNonce', 'registryRevision',
  'schemaGeneration', 'workerName', 'authDatabaseId', 'tagStateId',
  'slackTeamId', 'slackAppId', 'slackBotUserId', 'manifestDigest',
  'setupContractDigest', 'baselineDigest',
]);

export class EnvironmentRegistryError extends Error {
  constructor(code, details = undefined) {
    super(code);
    this.name = 'EnvironmentRegistryError';
    this.code = code;
    this.details = details;
  }
}

export function defaultEnvironmentRoot(env = process.env) {
  const configured = env.CHICKPEA_ENVIRONMENT_ROOT;
  return configured === undefined || configured === ''
    ? join(homedir(), '.chickpea', 'environments')
    : configured;
}

export function currentHostFingerprint(options = {}) {
  const identityPath = machineIdentityPath(options);
  const parent = dirname(identityPath);
  assertCreationPathNoSymlinks(identityPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
  assertSafeDirectory(parent);
  if (lstatIfPresent(identityPath)) return readMachineIdentityFingerprint(identityPath);
  const identity = { schemaVersion: MACHINE_IDENTITY_SCHEMA, machineId: randomUUID() };
  try {
    writeExclusiveOwnerOnlyJson(identityPath, identity);
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  return readMachineIdentityFingerprint(identityPath);
}

export function readCurrentHostFingerprint(options = {}) {
  const identityPath = machineIdentityPath(options);
  assertCreationPathNoSymlinks(identityPath);
  if (!lstatIfPresent(identityPath)) throw fail('MACHINE_IDENTITY_MISSING');
  assertSafeDirectory(dirname(identityPath));
  return readMachineIdentityFingerprint(identityPath);
}

function machineIdentityPath(options) {
  const identityPath = options.identityPath
    ?? join(homedir(), '.chickpea', 'machine-identity.json');
  if (typeof identityPath !== 'string' || !path.isAbsolute(identityPath)
    || resolve(identityPath) !== identityPath) {
    throw fail('NON_CANONICAL_MACHINE_IDENTITY');
  }
  return identityPath;
}

function readMachineIdentityFingerprint(identityPath) {
  const identity = readOwnerOnlyJson(identityPath, 'INVALID_MACHINE_IDENTITY');
  if (!isRecord(identity)
    || !exactKeys(identity, ['schemaVersion', 'machineId'])
    || identity.schemaVersion !== MACHINE_IDENTITY_SCHEMA
    || typeof identity.machineId !== 'string'
    || !/^[0-9a-f-]{36}$/u.test(identity.machineId)) {
    throw fail('INVALID_MACHINE_IDENTITY');
  }
  return `sha256:${createHash('sha256').update(identity.machineId).digest('hex')}`;
}

export function environmentMarkerPath(worktreePath) {
  return join(worktreePath, MARKER_FILE);
}

export function createEnvironmentRegistry(input) {
  rejectSecretLikeFields(input);
  const root = canonicalRoot(input.root ?? defaultEnvironmentRoot());
  assertCreationPathNoSymlinks(root);
  assertRegistryOutsideRepository(root);
  const targets = normalizeInitialTargets(input.targets);
  for (const registration of Object.values(targets)) {
    assertSafeEvidenceRoot(registration.evidenceRoot, input);
  }
  const sandbox = validateSandbox(input.sandbox);
  const registry = validateRegistry({
    schemaVersion: ENVIRONMENT_REGISTRY_SCHEMA,
    revision: 0,
    hostFingerprint: bounded(input.hostFingerprint ?? currentHostFingerprint(input), 'INVALID_HOST'),
    sandbox,
    targets,
    audit: [],
  });
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }
  assertSafeDirectory(root);
  return withRegistryLock(root, () => {
    if (registryStateExists(root)) throw fail('REGISTRY_EXISTS');
    for (const registration of Object.values(registry.targets)) {
      assertSafeEvidenceRoot(registration.evidenceRoot, input);
    }
    optionsHook(input.beforeInitializeCommit);
    writeRegistryRevision(root, registry, input);
    return registry;
  }, input);
}

export function readEnvironmentRegistry(options = {}) {
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
  assertRegistryHost(registry, options.hostFingerprint ?? readCurrentHostFingerprint(options));
  return registry;
}

/** Explicit metadata-only migration; never changes OAuth grants or lane resources. */
export function migrateEnvironmentProviderAuthConfigs(input, options = {}) {
  rejectSecretLikeFields(input);
  if (!isRecord(input)
    || !exactKeys(input, ['expectedRegistryRevision', 'targets'])
    || !Number.isSafeInteger(input.expectedRegistryRevision) || input.expectedRegistryRevision < 0
    || !Array.isArray(input.targets) || input.targets.length !== activeEnvironmentTargets.length
    || !sameArray(input.targets.map((target) => target?.target).sort(), [...activeEnvironmentTargets].sort())
    || input.targets.some((target) => !isRecord(target)
      || !exactKeys(target, ['target', 'providerProjectId', 'previousAuthConfigId', 'providerAuthConfigId'])
      || ![target.providerProjectId, target.previousAuthConfigId, target.providerAuthConfigId].every((value) => safeBounded(value)))) {
    throw fail('INVALID_PROVIDER_AUTH_MIGRATION');
  }
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const registry = readRegistryAt(root, false, true);
    assertRegistryHost(registry, options.hostFingerprint ?? readCurrentHostFingerprint(options));
    if (registry.schemaVersion !== LEGACY_ENVIRONMENT_REGISTRY_SCHEMA) {
      throw fail('REGISTRY_ALREADY_CURRENT');
    }
    if (registry.revision !== input.expectedRegistryRevision) throw fail('REGISTRY_REVISION_CONFLICT');
    for (const binding of input.targets) {
      const registration = registry.targets[binding.target];
      if (registration.claim !== null) throw fail('TARGET_CLAIMED');
      // A migration has no verifier/deploy lease authority, even if supplied by a caller.
      assertSafeEvidenceRoot(registration.evidenceRoot);
      if (lstatIfPresent(join(registration.evidenceRoot, 'deploy-intent.json'))) {
        throw fail('TARGET_MUTATION_LOCKED', { target: binding.target, status: 'intent' });
      }
      assertTargetMutationUnlocked(registration);
      if (registration.providerProjectId !== binding.providerProjectId
        || registration.providerReadOnlyAuthConfigId !== binding.previousAuthConfigId) {
        throw fail('PROVIDER_AUTH_MIGRATION_MISMATCH');
      }
    }
    const next = structuredClone(registry);
    next.schemaVersion = ENVIRONMENT_REGISTRY_SCHEMA;
    next.revision += 1;
    const now = nowMs(options);
    for (const binding of input.targets) {
      const registration = next.targets[binding.target];
      delete registration.providerReadOnlyAuthConfigId;
      registration.providerAuthConfigId = binding.providerAuthConfigId;
      registration.lastAttestation = null;
      next.audit.push(auditEvent('provider_auth_config_migrated', binding.target, now, next.revision));
    }
    trimAudit(next.audit);
    writeRegistryRevision(root, next, options);
    return { migrated: true, registryRevision: next.revision, targets: [...activeEnvironmentTargets] };
  }, options);
}

export function migrateEnvironmentProviderAuthConfigsFromFile(inputPath, options = {}) {
  return migrateEnvironmentProviderAuthConfigs(
    readOwnerOnlyJson(inputPath, 'INVALID_PROVIDER_AUTH_MIGRATION'), options,
  );
}

export function claimEnvironment(target, options = {}) {
  if (target !== undefined) assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
    const registry = readRegistryAt(root, false);
    assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
    const now = nowMs(options);
    repairOrphanMarker(registry, worktree, target);
    assertWorktreeClaimAvailable(registry, worktree, undefined, now);
    const selected = target ?? activeEnvironmentTargets.find((candidate) => !registry.targets[candidate].claim);
    if (!selected) throw fail('NO_TARGET_AVAILABLE');
    assertActiveTarget(selected);
    const registration = registry.targets[selected];
    if (registration.claim) {
      const code = Date.parse(registration.claim.expiresAt) <= now
        ? 'CLAIM_EXPIRED_RECLAIM_REQUIRED'
        : 'TARGET_CLAIMED';
      throw fail(code, publicClaim(registration.claim, now));
    }
    const nextRevision = registry.revision + 1;
    const claim = makeClaim(selected, worktree, nextRevision, now, options);
    const next = structuredClone(registry);
    next.revision = nextRevision;
    next.targets[selected].claim = claim;
    next.audit.push(auditEvent('claim_created', selected, now, nextRevision));
    trimAudit(next.audit);
    validateRegistry(next, options.allowLegacyRegistryRecovery === true);
    const markerPath = environmentMarkerPath(worktree.path);
    preflightClaimMarker(markerPath);
    writeClaimMarker(markerPath, claim, options);
    writeRegistryRevision(root, next, options);
    return Object.freeze({ ...claim });
  }, options);
}

export function reclaimEnvironment(target, options = {}) {
  options = { ...options, allowLegacyRegistryRecovery: true };
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
    const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
    assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
    assertTargetMutationUnlocked(registry.targets[target], options);
    const now = nowMs(options);
    assertWorktreeClaimAvailable(registry, worktree, target, now);
    const previous = registry.targets[target].claim;
    if (!previous) throw fail('CLAIM_REQUIRED');
    const sameWorktree = previous.canonicalWorktreePath === worktree.path;
    if (Date.parse(previous.expiresAt) > now && !sameWorktree) {
      throw fail('TARGET_CLAIMED', publicClaim(previous, now));
    }
    const nextRevision = registry.revision + 1;
    const claim = makeClaim(target, worktree, nextRevision, now, options);
    const next = structuredClone(registry);
    next.revision = nextRevision;
    next.targets[target].claim = claim;
    next.audit.push(auditEvent('claim_reclaimed', target, now, nextRevision));
    trimAudit(next.audit);
    validateRegistry(next, options.allowLegacyRegistryRecovery === true);
    const markerPath = environmentMarkerPath(worktree.path);
    preflightClaimMarker(markerPath, sameWorktree ? previous : undefined);
    writeClaimMarker(markerPath, claim, options);
    writeRegistryRevision(root, next, options);
    return Object.freeze({ ...claim });
  }, options);
}

export function releaseEnvironment(target, options = {}) {
  options = { ...options, allowLegacyRegistryRecovery: true };
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
    const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
    assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
    const claim = assertMatchingClaim(registry, target, worktree, options);
    assertTargetMutationUnlocked(registry.targets[target], options);
    const now = nowMs(options);
    const nextRevision = registry.revision + 1;
    const next = structuredClone(registry);
    next.revision = nextRevision;
    next.targets[target].claim = null;
    next.audit.push(auditEvent('claim_released', target, now, nextRevision));
    trimAudit(next.audit);
    validateRegistry(next, options.allowLegacyRegistryRecovery === true);
    writeRegistryRevision(root, next, options);
    optionsHook(options.beforeMarkerUnlink);
    const markerPath = environmentMarkerPath(worktree.path);
    const marker = readMarker(markerPath);
    if (!sameClaim(marker, claim)) throw fail('MARKER_MISMATCH');
    unlinkSync(markerPath);
    return { target, released: true, registryRevision: nextRevision };
  }, options);
}

export function recordEnvironmentDeploymentIntent(target, intent, options = {}) {
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
    const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
    assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
    const claim = assertMatchingClaim(registry, target, worktree, options);
    assertTargetMutationUnlocked(registry.targets[target], {
      ...options, expectedTargetLockRunId: intent?.runId,
    });
    const unsigned = isRecord(intent)
      ? Object.fromEntries(Object.entries(intent).filter(([key]) => key !== 'intentDigest'))
      : undefined;
    const registration = registry.targets[target];
    if (!isRecord(intent) || !exactKeys(intent, DEPLOY_INTENT_KEYS)
      || intent.schemaVersion !== 'chickpea-environment-deploy-intent/v1'
      || intent.target !== target || intent.claimNonce !== claim.leaseNonce
      || !/^[A-Za-z0-9._-]{1,128}$/u.test(intent.runId ?? '')
      || !/^[A-Za-z0-9._-]{1,128}$/u.test(intent.intentId ?? '')
      || intent.claimedRevision !== claim.claimedRevision
      || intent.sourceDirty !== worktree.dirty
      || !Number.isSafeInteger(intent.registryRevision)
      || intent.registryRevision < claim.registryRevision
      || intent.registryRevision > registry.revision
      || !/^d1:[A-Za-z0-9._-]{1,64};do:[A-Za-z0-9._-]{1,64}$/u.test(intent.schemaGeneration ?? '')
      || intent.workerName !== registration.workerName
      || intent.authDatabaseId !== registration.authDatabaseId
      || intent.tagStateId !== registration.bindingIdentities.TAG_STATE
      || intent.priorServingVersion !== registration.servingVersion
      || intent.priorSchemaGeneration !== registration.schemaGeneration
      || !validProviderContext(intent.providerContext)
      || !validDeploymentMetadata(intent.deploymentMetadata, intent, registration)
      || !timestamp(intent.createdAt) || new Date(intent.createdAt).toISOString() !== intent.createdAt
      || intent.intentDigest !== `sha256:${createHash('sha256')
        .update(stableEnvironmentJson(unsigned)).digest('hex')}`) {
      throw fail('INVALID_DEPLOY_INTENT');
    }
    validateMutationLeaseAuthority(registry, registration, claim, worktree, {
      runId: intent.runId,
      intentDigest: intent.intentDigest,
      claimNonce: intent.claimNonce,
    }, options);
    // Capture the exact health/attestation state while the registry lock is
    // held, immediately before the target_deploy_intent CAS. The earlier
    // preflight revision is source authority, not rollback authority: another
    // valid attestation may have landed between preflight and this boundary.
    atomicJsonWrite(
      join(registration.evidenceRoot, DEPLOY_PRIOR_STATE_FILE),
      makeDeploymentPriorState(target, claim, registration, registry.revision, intent.intentDigest),
    );
    optionsHook(options.afterDeploymentPriorStatePublished);
    const nextRevision = registry.revision + 1;
    const next = structuredClone(registry);
    next.revision = nextRevision;
    next.targets[target].reachable = false;
    next.targets[target].identityMatches = false;
    next.targets[target].lastAttestation = null;
    next.audit.push(auditEvent('target_deploy_intent', target, nowMs(options), nextRevision));
    trimAudit(next.audit);
    validateRegistry(next, options.allowLegacyRegistryRecovery === true);
    writeRegistryRevision(root, next, options);
    return Object.freeze({ target, registryRevision: nextRevision, intentDigest: intent.intentDigest });
  }, options);
}

export function assertLiveEnvironmentClaim(target, options = {}) {
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
  assertRegistryHost(registry, options.hostFingerprint ?? readCurrentHostFingerprint(options));
  const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
  const claim = assertMatchingClaim(registry, target, worktree, options);
  if (Date.parse(claim.expiresAt) <= nowMs(options)) throw fail('CLAIM_EXPIRED_RECLAIM_REQUIRED');
  return { registry, registration: registry.targets[target], claim, worktree };
}

export function assertEnvironmentMutationClaim(target, authority, options = {}) {
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
  const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
  assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
  const claim = assertMatchingClaim(registry, target, worktree, options);
  const registration = registry.targets[target];
  validateMutationLeaseAuthority(registry, registration, claim, worktree, authority, options);
  return Object.freeze({
    registry,
    registration: Object.freeze({ ...registration }),
    claim: Object.freeze({ ...claim }),
    worktree: Object.freeze({ revision: worktree.revision, dirty: worktree.dirty }),
  });
}

/**
 * Transfer one dead deployment lock to the recovering process. The registry
 * lock serializes contenders, while the target-lock inode check makes the
 * replacement conditional on the exact stale owner that was inspected.
 */
export function adoptEnvironmentMutationLock(target, authority, options = {}) {
  assertActiveTarget(target);
  if (!isRecord(authority)
    || !exactKeys(authority, ['runId', 'intentId', 'intentDigest', 'claimNonce'])
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(authority.intentId ?? '')) {
    throw fail('MUTATION_LEASE_AUTHORITY_REQUIRED');
  }
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
    const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
    assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
    const claim = assertMatchingClaim(registry, target, worktree, options);
    const registration = registry.targets[target];
    const intent = validateMutationLeaseAuthority(
      registry,
      registration,
      claim,
      worktree,
      {
        runId: authority.runId,
        intentDigest: authority.intentDigest,
        claimNonce: authority.claimNonce,
      },
      { ...options, allowMissingTargetLock: options.allowMissingTargetLock === true },
    );
    if (intent.intentId !== authority.intentId) {
      throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
    }

    const evidenceRoot = assertSafeEvidenceRoot(registration.evidenceRoot, options);
    const lockPath = targetLockPath(evidenceRoot);
    const host = options.lockHost ?? hostname();
    const currentStat = lstatIfPresent(lockPath);
    const currentOwner = currentStat ? readOwnedTargetLock(lockPath, currentStat) : undefined;
    if (currentOwner) {
      if (currentOwner.host !== host
        || currentOwner.runId !== authority.runId) {
        throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
      }
      if (pidIsActive(currentOwner.pid, options)) {
        throw fail('TARGET_LOCK_LIVE', { target, ownerRunId: currentOwner.runId });
      }
    } else if (options.allowMissingTargetLock !== true) {
      throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
    }

    const adoptedOwner = Object.freeze({
      runId: authority.runId,
      pid: process.pid,
      host,
      startedAt: new Date(nowMs(options)).toISOString(),
    });
    const temporary = join(
      evidenceRoot,
      `.target.lock.adopt.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      writeExclusiveOwnerOnlyJson(temporary, adoptedOwner);
      if (currentStat) {
        const recheckedStat = lstatIfPresent(lockPath);
        if (!recheckedStat || !sameInode(currentStat, recheckedStat)) {
          throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
        }
        const recheckedOwner = readOwnedTargetLock(lockPath, recheckedStat);
        if (recheckedOwner.runId !== currentOwner.runId
          || recheckedOwner.pid !== currentOwner.pid
          || recheckedOwner.host !== currentOwner.host
          || recheckedOwner.startedAt !== currentOwner.startedAt
          || pidIsActive(recheckedOwner.pid, options)) {
          throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
        }
        renameSync(temporary, lockPath);
      } else {
        try {
          linkSync(temporary, lockPath);
        } catch (error) {
          if (isNodeError(error, 'EEXIST')) throw fail('TARGET_LOCK_LIVE', { target });
          throw error;
        }
        unlinkSync(temporary);
      }
      fsyncDirectory(evidenceRoot);
    } finally {
      try { unlinkSync(temporary); } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    }

    const adoptedStat = lstatIfPresent(lockPath);
    const persisted = adoptedStat ? readOwnedTargetLock(lockPath, adoptedStat) : undefined;
    if (!adoptedStat || !persisted
      || persisted.runId !== adoptedOwner.runId
      || persisted.pid !== adoptedOwner.pid
      || persisted.host !== adoptedOwner.host) {
      throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
    }
    return Object.freeze({
      owner: adoptedOwner,
      lockPath,
      lockDev: adoptedStat.dev,
      lockIno: adoptedStat.ino,
      registryRevision: registry.revision,
    });
  }, options);
}

export function abortEnvironmentDeploymentIntent(target, intent, options = {}) {
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
    const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
    assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
    const claim = assertMatchingClaim(registry, target, worktree, options);
    const registration = registry.targets[target];
    const authority = {
      runId: intent?.runId,
      intentDigest: intent?.intentDigest,
      claimNonce: intent?.claimNonce,
    };
    validateMutationLeaseAuthority(registry, registration, claim, worktree, authority, {
      ...options,
      allowMissingTargetLock: options.allowMissingTargetLock === true,
    });
    if (!isRecord(intent)
      || intent.target !== target
      || intent.claimedRevision !== claim.claimedRevision
      || intent.sourceDirty !== worktree.dirty
      || !Number.isSafeInteger(intent.registryRevision)
      || intent.registryRevision < claim.registryRevision
      || intent.registryRevision > registry.revision) {
      throw fail('INVALID_DEPLOY_INTENT');
    }
    let priorState;
    try {
      priorState = readDeploymentPriorState(registration.evidenceRoot, intent);
    } catch (error) {
      if (!(error instanceof EnvironmentRegistryError)
        || error.code !== 'DEPLOY_PRIOR_STATE_MISSING') throw error;
      // The prior-state publication is ordered before the registry CAS. Its
      // absence therefore proves this intent stopped at an earlier begin
      // boundary and there is no central health state to roll back.
      if (registration.servingVersion !== intent.priorServingVersion
        || registration.schemaGeneration !== intent.priorSchemaGeneration
        || registration.sourceRevision !== intent.claimedRevision
        || registration.sourceDirty !== intent.sourceDirty) {
        throw fail('DEPLOY_ABORT_STATE_CHANGED');
      }
      return Object.freeze({
        target,
        aborted: true,
        registryRevision: registry.revision,
        servingVersion: intent.priorServingVersion,
      });
    }
    const prior = validateRegistry(readOwnerOnlyJson(
      snapshotPath(root, priorState.registryRevision),
      'INVALID_REGISTRY_REVISION_HISTORY',
    ), options.allowLegacyRegistryRecovery === true);
    const priorRegistration = prior.targets[target];
    if (!sameClaim(priorRegistration.claim, claim)
      || !deploymentPriorStateMatchesRegistration(priorState, priorRegistration)
      || registration.servingVersion !== intent.priorServingVersion
      || registration.schemaGeneration !== intent.priorSchemaGeneration
      || registration.sourceRevision !== priorRegistration.sourceRevision
      || registration.sourceDirty !== priorRegistration.sourceDirty) {
      throw fail('DEPLOY_ABORT_STATE_CHANGED');
    }
    // A crash after the abort registry CAS but before journal/lock cleanup is
    // idempotent, including when the exact prior state was unhealthy.
    if (deploymentPriorStateMatchesRegistration(priorState, registration)) {
      return Object.freeze({
        target,
        aborted: true,
        registryRevision: registry.revision,
        servingVersion: intent.priorServingVersion,
      });
    }
    if (registration.reachable !== false || registration.identityMatches !== false
      || registration.lastAttestation !== null) {
      throw fail('DEPLOY_ABORT_STATE_CHANGED');
    }
    const nextRevision = registry.revision + 1;
    const next = structuredClone(registry);
    next.revision = nextRevision;
    next.targets[target].reachable = priorState.reachable;
    next.targets[target].identityMatches = priorState.identityMatches;
    next.targets[target].lastAttestation = priorState.lastAttestation;
    next.audit.push(auditEvent('target_deploy_aborted', target, nowMs(options), nextRevision));
    trimAudit(next.audit);
    validateRegistry(next, options.allowLegacyRegistryRecovery === true);
    writeRegistryRevision(root, next, options);
    return Object.freeze({
      target,
      aborted: true,
      registryRevision: nextRevision,
      servingVersion: intent.priorServingVersion,
    });
  }, options);
}

export function isEnvironmentDeploymentAbortState(target, intent, options = {}) {
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
  const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
  assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
  const claim = assertMatchingClaim(registry, target, worktree, options);
  const registration = registry.targets[target];
  if (!isRecord(intent) || intent.target !== target || intent.claimNonce !== claim.leaseNonce) {
    throw fail('INVALID_DEPLOY_INTENT');
  }
  let priorState;
  try {
    priorState = readDeploymentPriorState(registration.evidenceRoot, intent);
  } catch (error) {
    if (error instanceof EnvironmentRegistryError
      && error.code === 'DEPLOY_PRIOR_STATE_MISSING') return false;
    throw error;
  }
  return deploymentPriorStateMatchesRegistration(priorState, registration);
}

function makeDeploymentPriorState(target, claim, registration, registryRevision, intentDigest) {
  const unsigned = {
    schemaVersion: 'chickpea-environment-deploy-prior-state/v1',
    target,
    claimNonce: claim.leaseNonce,
    intentDigest,
    registryRevision,
    sourceRevision: registration.sourceRevision,
    sourceDirty: registration.sourceDirty,
    servingVersion: registration.servingVersion,
    schemaGeneration: registration.schemaGeneration,
    reachable: registration.reachable,
    identityMatches: registration.identityMatches,
    lastAttestation: registration.lastAttestation,
  };
  return Object.freeze({
    ...unsigned,
    stateDigest: `sha256:${createHash('sha256')
      .update(stableEnvironmentJson(unsigned)).digest('hex')}`,
  });
}

function readDeploymentPriorState(evidenceRoot, intent) {
  const input = readOwnerOnlyJson(
    join(evidenceRoot, DEPLOY_PRIOR_STATE_FILE),
    'DEPLOY_PRIOR_STATE_MISSING',
  );
  const unsigned = isRecord(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'stateDigest'))
    : undefined;
  if (!isRecord(input)
    || !exactKeys(input, [
      'schemaVersion', 'target', 'claimNonce', 'intentDigest', 'registryRevision',
      'sourceRevision', 'sourceDirty', 'servingVersion', 'schemaGeneration',
      'reachable', 'identityMatches', 'lastAttestation', 'stateDigest',
    ])
    || input.schemaVersion !== 'chickpea-environment-deploy-prior-state/v1'
    || input.target !== intent?.target
    || input.claimNonce !== intent?.claimNonce
    || input.intentDigest !== intent?.intentDigest
    || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1
    || typeof input.sourceRevision !== 'string' || !/^[0-9a-f]{7,64}$/u.test(input.sourceRevision)
    || typeof input.sourceDirty !== 'boolean'
    || !validServingVersion(input.servingVersion)
    || typeof input.schemaGeneration !== 'string'
    || !/^d1:[A-Za-z0-9._-]{1,64};do:[A-Za-z0-9._-]{1,64}$/u.test(input.schemaGeneration)
    || typeof input.reachable !== 'boolean'
    || typeof input.identityMatches !== 'boolean'
    || !(input.lastAttestation === null
      || validateLastAttestation(input.lastAttestation) !== undefined)
    || input.stateDigest !== `sha256:${createHash('sha256')
      .update(stableEnvironmentJson(unsigned)).digest('hex')}`) {
    throw fail('INVALID_DEPLOY_PRIOR_STATE');
  }
  return input;
}

function deploymentPriorStateMatchesRegistration(priorState, registration) {
  return priorState.target === registration.target
    && priorState.sourceRevision === registration.sourceRevision
    && priorState.sourceDirty === registration.sourceDirty
    && priorState.servingVersion === registration.servingVersion
    && priorState.schemaGeneration === registration.schemaGeneration
    && priorState.reachable === registration.reachable
    && priorState.identityMatches === registration.identityMatches
    && stableEnvironmentJson(priorState.lastAttestation)
      === stableEnvironmentJson(registration.lastAttestation);
}

export function recordEnvironmentAttestation(target, result, options = {}) {
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
    const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
    assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
    const claim = assertMatchingClaim(registry, target, worktree, options);
    const now = nowMs(options);
    if (options.expectedLeaseNonce !== undefined
      && claim.leaseNonce !== options.expectedLeaseNonce) {
      throw fail('CLAIM_CHANGED');
    }
    if (Date.parse(claim.expiresAt) <= now) throw fail('CLAIM_EXPIRED_RECLAIM_REQUIRED');
    const registration = registry.targets[target];
    assertTargetMutationUnlocked(registration, options);
    const registeredSourceIdentity = `${registration.sourceRevision}${registration.sourceDirty ? '-dirty' : ''}`;
    const currentSourceIdentity = `${claim.claimedRevision}${worktree.dirty ? '-dirty' : ''}`;
    if (currentSourceIdentity !== registeredSourceIdentity
      || result?.doctorSnapshot?.repositoryRevision !== registeredSourceIdentity) {
      throw fail('SOURCE_IDENTITY_MISMATCH');
    }
    if (result?.attestation?.servingVersion !== registration.servingVersion
      || result?.doctorSnapshot?.servingVersion !== registration.servingVersion) {
      throw fail('SERVING_VERSION_MISMATCH');
    }
    const nextRevision = registry.revision + 1;
    const lastAttestation = validateLastAttestation({
      attestedAt: new Date(now).toISOString(),
      registryRevision: nextRevision,
      sourceRevision: result.doctorSnapshot.repositoryRevision,
      servingVersion: result.attestation.servingVersion,
      targetFingerprint: result.attestation.targetFingerprint,
      verifierLock: result.doctorSnapshot.lock,
    });
    const next = structuredClone(registry);
    next.revision = nextRevision;
    next.targets[target].lastAttestation = lastAttestation;
    next.audit.push(auditEvent('target_attested', target, now, nextRevision));
    trimAudit(next.audit);
    validateRegistry(next, options.allowLegacyRegistryRecovery === true);
    writeRegistryRevision(root, next, options);
    return lastAttestation;
  }, options);
}

export function recordEnvironmentDeployment(target, receipt, options = {}) {
  assertActiveTarget(target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  return withRegistryLock(root, () => {
    const worktree = resolveWorktree(options.worktreePath ?? process.cwd(), options);
    const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
    assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
    const claim = assertMatchingClaim(registry, target, worktree, options);
    const now = nowMs(options);
    const registration = registry.targets[target];
    assertTargetMutationUnlocked(registration, options);
    validateMutationLeaseAuthority(
      registry,
      registration,
      claim,
      worktree,
      options.mutationLeaseAuthority,
      options,
    );
    const unsignedReceipt = isRecord(receipt)
      ? Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'receiptDigest'))
      : undefined;
    if (!isRecord(receipt)
      || !exactKeys(receipt, DEPLOY_RECEIPT_KEYS)
      || receipt.schemaVersion !== 'chickpea-environment-deploy-receipt/v1'
      || receipt.receiptDigest !== `sha256:${createHash('sha256')
        .update(stableEnvironmentJson(unsignedReceipt)).digest('hex')}`
      || receipt.target !== target
      || receipt.claimNonce !== claim.leaseNonce
      || !Number.isSafeInteger(receipt.registryRevision)
      || receipt.registryRevision < claim.registryRevision
      || receipt.registryRevision > registry.revision
      || receipt.sourceRevision !== claim.claimedRevision
      || receipt.sourceDirty !== worktree.dirty
      || receipt.workerName !== registration.workerName
      || receipt.authDatabaseBinding !== registration.authDatabaseBinding
      || receipt.authDatabaseId !== registration.authDatabaseId
      || receipt.tagStateId !== registration.bindingIdentities.TAG_STATE
      || receipt.slackTeamId !== registration.workspaceId
      || receipt.slackAppId !== registration.slackAppId
      || receipt.slackBotUserId !== registration.botUserId
      || typeof receipt.schemaGeneration !== 'string'
      || !/^d1:[A-Za-z0-9._-]{1,64};do:[A-Za-z0-9._-]{1,64}$/u.test(receipt.schemaGeneration)
      || receipt.transport !== registration.transport
      || typeof receipt.issuedAt !== 'string'
      || !Number.isFinite(Date.parse(receipt.issuedAt))
      || new Date(receipt.issuedAt).toISOString() !== receipt.issuedAt
      || !/^sha256:[a-f0-9]{64}$/u.test(receipt.manifestDigest)
      || !/^sha256:[a-f0-9]{64}$/u.test(receipt.setupContractDigest)
      || !/^sha256:[a-f0-9]{64}$/u.test(receipt.baselineDigest)
      || !validServingVersion(receipt.activeVersion)) {
      throw fail('INVALID_DEPLOY_RECEIPT');
    }
    const baseline = readOwnerOnlyJson(
      join(registration.evidenceRoot, 'environment-baseline.json'),
      'INVALID_DEPLOY_RECEIPT',
    );
    if (!isRecord(baseline)
      || baseline.target !== target
      || baseline.manifestDigest !== receipt.manifestDigest
      || baseline.setupContractDigest !== receipt.setupContractDigest
      || receipt.baselineDigest !== `sha256:${createHash('sha256')
        .update(stableEnvironmentJson(baseline)).digest('hex')}`) {
      throw fail('INVALID_DEPLOY_RECEIPT');
    }
    if (receipt.schemaGeneration !== registration.schemaGeneration) {
      const schemaIntent = readOwnerOnlyJson(
        join(registration.evidenceRoot, 'schema-advancement-intent.json'),
        'INVALID_SCHEMA_ADVANCEMENT',
      );
      if (!isRecord(schemaIntent)
        || !exactKeys(schemaIntent, [
          'schemaVersion', 'target', 'claimNonce', 'registryRevision',
          'fromGeneration', 'toGeneration', 'successorOf', 'historyDigest', 'createdAt',
        ])
        || schemaIntent.schemaVersion !== 'chickpea-environment-schema-advancement-intent/v1'
        || schemaIntent.target !== target
        || schemaIntent.claimNonce !== claim.leaseNonce
        || schemaIntent.fromGeneration !== registration.schemaGeneration
        || schemaIntent.successorOf !== registration.schemaGeneration
        || schemaIntent.toGeneration !== receipt.schemaGeneration
        || typeof schemaIntent.historyDigest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(schemaIntent.historyDigest)
        || !Number.isSafeInteger(schemaIntent.registryRevision)
        || schemaIntent.registryRevision > registry.revision
        || !timestamp(schemaIntent.createdAt)) {
        throw fail('INVALID_SCHEMA_ADVANCEMENT');
      }
    }
    if (typeof options.publishPendingReceipt !== 'function'
      || typeof options.finalizeReceipt !== 'function') {
      throw fail('DEPLOY_RECEIPT_PUBLICATION_REQUIRED');
    }
    // Two registry snapshots make the cross-directory publication
    // crash-explicit. The first snapshot records the new identity as
    // unreachable; only after the pending receipt is atomically finalized can
    // the second snapshot make the lane ready.
    options.publishPendingReceipt();
    const pendingRevision = registry.revision + 1;
    const pending = structuredClone(registry);
    pending.revision = pendingRevision;
    pending.targets[target].sourceRevision = receipt.sourceRevision;
    pending.targets[target].sourceDirty = receipt.sourceDirty;
    pending.targets[target].servingVersion = receipt.activeVersion;
    pending.targets[target].schemaGeneration = receipt.schemaGeneration;
    pending.targets[target].reachable = false;
    pending.targets[target].identityMatches = false;
    pending.targets[target].lastAttestation = null;
    pending.audit.push(auditEvent('target_deploy_pending', target, now, pendingRevision));
    trimAudit(pending.audit);
    validateRegistry(pending, options.allowLegacyRegistryRecovery === true);
    writeRegistryRevision(root, pending, options);
    options.finalizeReceipt();
    const finalRevision = pendingRevision + 1;
    const final = structuredClone(pending);
    final.revision = finalRevision;
    final.targets[target].reachable = true;
    final.targets[target].identityMatches = true;
    final.audit.push(auditEvent('target_deployed', target, now, finalRevision));
    trimAudit(final.audit);
    validateRegistry(final, options.allowLegacyRegistryRecovery === true);
    writeRegistryRevision(root, final, options);
    return Object.freeze({ target, registryRevision: finalRevision, servingVersion: receipt.activeVersion });
  }, options);
}

export function resolveEnvironmentAlias(alias, options = {}) {
  const { target } = parseEnvironmentAlias(alias);
  const registry = readEnvironmentRegistry(options);
  return resolveEnvironmentRegistrationAlias(alias, registry.targets[target]);
}

export function resolveEnvironmentRegistrationAlias(alias, registration) {
  const { target, field } = parseEnvironmentAlias(alias);
  if (registration?.target !== target) throw fail('INVALID_ALIAS');
  const fields = {
    worker: registration.workerName,
    workspace: registration.workspaceId,
    'slack-app': registration.slackAppId,
    'provider-project': registration.providerProjectId,
    'provider-auth-config': registration.providerAuthConfigId,
    'evidence-root': registration.evidenceRoot,
    timezone: registration.timezone,
    'auth-db': registration.bindingIdentities.AUTH_DB,
    'tag-state': registration.bindingIdentities.TAG_STATE,
  };
  const value = fields[field];
  if (value === undefined) throw fail('INVALID_ALIAS');
  return value;
}

function parseEnvironmentAlias(alias) {
  const match = /^env-(amber|cobalt)-([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(alias);
  if (!match) throw fail('INVALID_ALIAS');
  return { target: match[1], field: match[2] };
}

/** Fleet-wide read-only projection. It never creates the root, a marker, or an attestation. */
export function readEnvironmentStatus(options = {}) {
  if (options.target !== undefined) assertActiveTarget(options.target);
  const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
  const now = nowMs(options);
  const registry = readRegistryAt(root, true, true);
  if (!registry) return unregisteredStatus(options.target, now);
  assertRegistryHost(registry, options.hostFingerprint ?? readCurrentHostFingerprint(options));
  const names = options.target ? [options.target] : activeEnvironmentTargets;
  const migrationRequired = registry.schemaVersion === LEGACY_ENVIRONMENT_REGISTRY_SCHEMA;
  const targets = names.map((target) => {
    const status = statusForTarget(registry.targets[target], now, options);
    return migrationRequired && status.health === 'ready'
      ? Object.freeze({ ...status, health: 'migration_required',
        recoveryAction: 'Finish existing claims and locks, then run env migrate-provider-auth with verified private bindings.' })
      : status;
  });
  return Object.freeze({
    schemaVersion: ENVIRONMENT_STATUS_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    registryRevision: registry.revision,
    ...(migrationRequired ? { registryMigrationRequired: true } : {}),
    selectedTarget: selectedTargetFor(registry, options.worktreePath),
    targets: Object.freeze(targets),
    sandbox: publicSandbox(registry.sandbox, now),
  });
}

export function reconcileEnvironment(target, options = {}) {
  options = { ...options, allowLegacyRegistryRecovery: true };
  if (target !== undefined) assertActiveTarget(target);
  let repairedOrphanMarker = false;
  const candidateWorktree = options.worktreePath ?? process.cwd();
  if (typeof candidateWorktree === 'string' && path.isAbsolute(candidateWorktree)
    && lstatIfPresent(environmentMarkerPath(candidateWorktree))) {
    const root = canonicalRoot(options.root ?? defaultEnvironmentRoot());
    repairedOrphanMarker = withRegistryLock(root, () => {
      const worktree = resolveWorktree(candidateWorktree, options);
      const registry = readRegistryAt(root, false, options.allowLegacyRegistryRecovery === true);
      assertRegistryHost(registry, options.hostFingerprint ?? currentHostFingerprint(options));
      return repairOrphanMarker(registry, worktree, target);
    }, options);
  }
  const status = readEnvironmentStatus({ ...options, ...(target ? { target } : {}) });
  return {
    kind: 'reconciliation',
    repairedOrphanMarker,
    ready: status.registryMigrationRequired !== true && status.targets.every(({ health }) => health === 'ready'),
    status,
    issues: status.targets
      .filter(({ health }) => health !== 'ready')
      .map(({ target: name, health, recoveryAction }) => ({ target: name, health, recoveryAction })),
  };
}

function normalizeInitialTargets(input) {
  if (!Array.isArray(input)) throw fail('INVALID_REGISTRY');
  const entries = input.map((target) => normalizeTarget(target));
  const names = entries.map(({ target }) => target).sort();
  if (!sameArray(names, [...activeEnvironmentTargets].sort())) throw fail('INVALID_TARGET_INVENTORY');
  return Object.fromEntries(entries.map((target) => [target.target, target]));
}

function normalizeTarget(input) {
  rejectSecretLikeFields(input);
  if (!isRecord(input)) throw fail('INVALID_TARGET_RECORD');
  if (Object.keys(input).some((key) => !TARGET_KEYS.includes(key))) throw fail('INVALID_TARGET_RECORD');
  assertActiveTarget(input.target);
  if (input.role !== 'branch') throw fail('INVALID_TARGET_ROLE');
  const target = input.target;
  const record = {
    ...input,
    claim: input.claim ?? null,
    lastAttestation: input.lastAttestation ?? null,
  };
  validateTarget(record, target);
  return record;
}

function validateRegistry(input, allowLegacy = false) {
  rejectSecretLikeFields(input);
  const legacy = allowLegacy && input?.schemaVersion === LEGACY_ENVIRONMENT_REGISTRY_SCHEMA;
  if (!isRecord(input)
    || !exactKeys(input, ['schemaVersion', 'revision', 'hostFingerprint', 'sandbox', 'targets', 'audit'])
    || (!legacy && input.schemaVersion !== ENVIRONMENT_REGISTRY_SCHEMA)
    || !Number.isSafeInteger(input.revision) || input.revision < 0
    || !safeBounded(input.hostFingerprint)
    || !isRecord(input.targets)
    || !sameArray(Object.keys(input.targets).sort(), [...activeEnvironmentTargets].sort())
    || !Array.isArray(input.audit) || input.audit.length > MAX_AUDIT_EVENTS) {
    throw fail('INVALID_REGISTRY');
  }
  validateSandbox(input.sandbox);
  let observedRevision = 0;
  const claimedWorktrees = new Set();
  for (const target of activeEnvironmentTargets) {
    validateTarget(input.targets[target], target, legacy);
    const claim = input.targets[target].claim;
    if (claim?.hostFingerprint !== undefined && claim.hostFingerprint !== input.hostFingerprint) {
      throw fail('HOST_MISMATCH');
    }
    if (claim && claimedWorktrees.has(claim.canonicalWorktreePath)) {
      throw fail('DUPLICATE_WORKTREE_CLAIM');
    }
    if (claim) claimedWorktrees.add(claim.canonicalWorktreePath);
    observedRevision = Math.max(
      observedRevision,
      input.targets[target].claim?.registryRevision ?? 0,
      input.targets[target].lastAttestation?.registryRevision ?? 0,
    );
  }
  assertUniqueTargetIdentities(input.targets, legacy);
  for (const event of input.audit) {
    validateAudit(event);
    observedRevision = Math.max(observedRevision, event.registryRevision);
  }
  if (input.revision < observedRevision) throw fail('REGISTRY_ROLLBACK');
  return input;
}

function assertUniqueTargetIdentities(targets, legacy = false) {
  const identities = [
    ['workerName', (target) => target.workerName],
    ['workspaceId', (target) => target.workspaceId],
    ['slackAppId', (target) => target.slackAppId],
    ['botUserId', (target) => target.botUserId],
    ['authDatabaseName', (target) => target.authDatabaseName],
    ['authDatabaseId', (target) => target.authDatabaseId],
    ['authDatabaseIdentity', (target) => target.bindingIdentities.AUTH_DB],
    ['providerProjectId', (target) => target.providerProjectId],
    ['providerAuthConfigId', (target) => legacy ? target.providerReadOnlyAuthConfigId : target.providerAuthConfigId],
    ['tagStateIdentity', (target) => target.bindingIdentities.TAG_STATE],
    ['evidenceRoot', (target) => target.evidenceRoot],
  ];
  for (const [field, select] of identities) {
    const seen = new Map();
    for (const target of activeEnvironmentTargets) {
      const value = select(targets[target]);
      const previous = seen.get(value);
      const sharedGatewayApp = field === 'slackAppId'
        && previous?.transport === 'gateway' && targets[target].transport === 'gateway';
      if (previous && !sharedGatewayApp) throw fail('DUPLICATE_TARGET_IDENTITY', { field });
      seen.set(value, targets[target]);
    }
  }
}

function validateTarget(input, target, legacy = false) {
  const authConfigField = legacy ? 'providerReadOnlyAuthConfigId' : 'providerAuthConfigId';
  const keys = legacy ? TARGET_KEYS.map((key) => key === 'providerAuthConfigId' ? authConfigField : key) : TARGET_KEYS;
  if (!isRecord(input) || !exactKeys(input, keys) || input.target !== target
    || input.role !== 'branch'
    || (input.transport !== 'gateway' && input.transport !== 'events')
    || input.workerName !== `chickpea-${target}-live`
    || input.authDatabaseBinding !== 'AUTH_DB'
    || input.authDatabaseName !== `chickpea-auth-db-${target}-live`
    || !safeBounded(input.authDatabaseId)
    || !safeBounded(input.workspaceId) || !safeLabel(input.workspaceLabel)
    || !safeBounded(input.slackAppId) || !safeLabel(input.slackAppLabel)
    || !safeBounded(input.botUserId)
    || !safeBounded(input.providerProjectId)
    || !safeBounded(input[authConfigField])
    || !safeBounded(input.timezone)
    || !safeBounded(input.evidenceRoot, 1_024) || !path.isAbsolute(input.evidenceRoot)
    || resolve(input.evidenceRoot) !== input.evidenceRoot
    || !validBindings(input.bindingIdentities, input.authDatabaseId)
    || typeof input.schemaGeneration !== 'string'
    || !/^d1:[A-Za-z0-9._-]{1,64};do:[A-Za-z0-9._-]{1,64}$/u.test(input.schemaGeneration)
    || !validServingVersion(input.servingVersion)
    || typeof input.sourceRevision !== 'string' || !/^[0-9a-f]{7,64}$/u.test(input.sourceRevision)
    || typeof input.sourceDirty !== 'boolean'
    || typeof input.reachable !== 'boolean'
    || typeof input.identityMatches !== 'boolean'
    || !validComputerUse(input.computerUseSurfaces)
    || !stringArray(input.missingActorAliases)
    || (input.claim !== null && validateClaim(input.claim, target) === undefined)
    || (input.lastAttestation !== null && validateLastAttestation(input.lastAttestation) === undefined)) {
    throw fail('INVALID_TARGET_RECORD');
  }
  return input;
}

function validateClaim(input, target) {
  if (!isRecord(input) || !exactKeys(input, CLAIM_KEYS)
    || input.schemaVersion !== ENVIRONMENT_MARKER_SCHEMA
    || input.target !== target
    || !safeBounded(input.canonicalWorktreePath, 1_024)
    || !path.isAbsolute(input.canonicalWorktreePath)
    || resolve(input.canonicalWorktreePath) !== input.canonicalWorktreePath
    || !safeBounded(input.branch, 256)
    || typeof input.leaseNonce !== 'string' || !/^[0-9a-f-]{36}$/u.test(input.leaseNonce)
    || typeof input.claimedRevision !== 'string' || !/^[0-9a-f]{7,64}$/u.test(input.claimedRevision)
    || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1
    || !safeBounded(input.hostFingerprint)
    || !timestamp(input.claimedAt) || !timestamp(input.expiresAt)
    || Date.parse(input.expiresAt) <= Date.parse(input.claimedAt)) {
    throw fail('INVALID_CLAIM');
  }
  return input;
}

function validateLastAttestation(input) {
  if (!isRecord(input)
    || !exactKeys(input, [
      'attestedAt', 'registryRevision', 'sourceRevision', 'servingVersion',
      'targetFingerprint', 'verifierLock',
    ])
    || !timestamp(input.attestedAt)
    || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1
    || typeof input.sourceRevision !== 'string' || !/^[0-9a-f]{7,64}(?:-dirty)?$/u.test(input.sourceRevision)
    || !validServingVersion(input.servingVersion)
    || typeof input.targetFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input.targetFingerprint)
    || !validVerifierLock(input.verifierLock)) {
    throw fail('INVALID_ATTESTATION_RECORD');
  }
  return input;
}

function validateSandbox(input) {
  // Standalone workspaces do not have a shared sandbox expiry or quota.
  if (input === null) return null;
  if (!isRecord(input)
    || !exactKeys(input, [
      'archiveDate', 'workspaceSlotsTotal', 'workspaceSlotsUsed', 'integrationHeadroom',
    ])
    || !timestamp(input.archiveDate)
    || input.workspaceSlotsTotal !== 5
    || !Number.isSafeInteger(input.workspaceSlotsUsed)
    || input.workspaceSlotsUsed < activeEnvironmentTargets.length
    || input.workspaceSlotsUsed > input.workspaceSlotsTotal
    || !Number.isSafeInteger(input.integrationHeadroom)
    || input.integrationHeadroom < 0 || input.integrationHeadroom > 10_000) {
    throw fail('INVALID_SANDBOX');
  }
  return input;
}

function assertMatchingClaim(registry, target, worktree, options) {
  const claim = registry.targets[target].claim;
  if (!claim) throw fail('CLAIM_REQUIRED');
  if (claim.hostFingerprint !== registry.hostFingerprint) throw fail('HOST_MISMATCH');
  if (claim.canonicalWorktreePath !== worktree.path || claim.branch !== worktree.branch) {
    throw fail('CLAIM_OWNER_MISMATCH');
  }
  if (claim.claimedRevision !== worktree.revision) {
    const rolledBack = gitIsAncestor(worktree.path, worktree.revision, claim.claimedRevision, options);
    throw fail(rolledBack ? 'ROLLBACK_REVISION' : 'CLAIM_REVISION_MISMATCH');
  }
  const marker = readMarker(environmentMarkerPath(worktree.path));
  if (!sameClaim(marker, claim)) throw fail('MARKER_MISMATCH');
  return claim;
}

function assertWorktreeClaimAvailable(registry, worktree, exceptTarget, now) {
  const existing = activeEnvironmentTargets.find((candidate) =>
    candidate !== exceptTarget
    && registry.targets[candidate].claim?.canonicalWorktreePath === worktree.path
  );
  if (existing) {
    throw fail('WORKTREE_ALREADY_CLAIMED', publicClaim(
      registry.targets[existing].claim,
      now,
    ));
  }
}

function makeClaim(target, worktree, registryRevision, now, options) {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 7 * 24 * 60 * 60 * 1_000) {
    throw fail('INVALID_LEASE_DURATION');
  }
  return validateClaim({
    schemaVersion: ENVIRONMENT_MARKER_SCHEMA,
    target,
    canonicalWorktreePath: worktree.path,
    branch: worktree.branch,
    leaseNonce: randomUUID(),
    claimedRevision: worktree.revision,
    registryRevision,
    hostFingerprint: options.hostFingerprint ?? currentHostFingerprint(options),
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseDurationMs).toISOString(),
  }, target);
}

function resolveWorktree(input, options = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || resolve(input) !== input) {
    throw fail('NON_CANONICAL_WORKTREE');
  }
  let real;
  try {
    real = realpathSync(input);
  } catch {
    throw fail('NON_CANONICAL_WORKTREE');
  }
  const worktreeStat = lstatSync(input);
  if (real !== input || worktreeStat.isSymbolicLink()) throw fail('NON_CANONICAL_WORKTREE');
  if (!worktreeStat.isDirectory()) throw fail('INVALID_WORKTREE');
  const expectedUid = options.expectedUid
    ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (expectedUid !== undefined && worktreeStat.uid !== expectedUid) throw fail('NON_OWNER_FILE');
  if ((worktreeStat.mode & 0o022) !== 0) throw fail('UNSAFE_PERMISSIONS');
  const top = gitOutput(real, ['rev-parse', '--show-toplevel']);
  if (!top || realpathSync(top) !== real) throw fail('NON_CANONICAL_WORKTREE');
  const branch = gitOutput(real, ['branch', '--show-current']);
  const revision = gitOutput(real, ['rev-parse', 'HEAD']);
  if (!safeBounded(branch, 256) || !/^[0-9a-f]{7,64}$/u.test(revision)) throw fail('INVALID_WORKTREE');
  const dirty = gitOutput(real, ['status', '--porcelain', '--untracked-files=normal']).length > 0;
  return { path: real, branch, revision, dirty };
}

function gitOutput(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw fail('INVALID_WORKTREE');
  return result.stdout.trim();
}

function gitIsAncestor(cwd, ancestor, descendant, options) {
  if (options.isGitAncestor) return options.isGitAncestor(ancestor, descendant);
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
  return result.status === 0;
}

function readRegistryAt(root, optional, allowLegacy = false) {
  assertRegistryOutsideRepository(root);
  const registryPath = join(root, REGISTRY_FILE);
  if (!existsSync(root)) {
    if (optional) return undefined;
    throw fail('REGISTRY_MISSING');
  }
  assertSafeDirectory(root);
  const latest = readLatestRegistrySnapshot(root);
  if (!existsSync(registryPath) && !latest) {
    if (optional) return undefined;
    throw fail('REGISTRY_MISSING');
  }
  if (!latest) throw fail('REGISTRY_REVISION_HISTORY_MISSING');
  if (!allowLegacy && latest.schemaVersion === LEGACY_ENVIRONMENT_REGISTRY_SCHEMA) {
    throw fail('PROVIDER_AUTH_CONFIG_MIGRATION_REQUIRED');
  }
  if (!existsSync(registryPath)) return latest;
  const current = validateRegistry(readOwnerOnlyJson(registryPath, 'INVALID_REGISTRY'), true);
  if (current.revision > latest.revision) throw fail('REGISTRY_REVISION_HISTORY_MISSING');
  if (current.revision < latest.revision) return latest;
  if (registryDigest(current) !== registryDigest(latest)) throw fail('REGISTRY_SNAPSHOT_MISMATCH');
  return current;
}

function readMarker(markerPath) {
  if (!existsSync(markerPath)) throw fail('MARKER_MISSING');
  const parsed = readOwnerOnlyJson(markerPath, 'INVALID_CLAIM');
  return validateClaim(parsed, parsed?.target);
}

function withRegistryLock(root, callback, options = {}) {
  assertSafeDirectory(root);
  const lockPath = join(root, REGISTRY_LOCK);
  const deadline = Date.now() + (options.lockTimeoutMs ?? 5_000);
  let descriptor;
  let candidateStat;
  let ownsLock = false;
  const hostFingerprint = options.hostFingerprint ?? currentHostFingerprint(options);
  const lockNonce = randomUUID();
  const candidatePath = join(root, `.registry-lock-${process.pid}-${lockNonce}.tmp`);
  try {
    descriptor = openSync(candidatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    candidateStat = fstatSync(descriptor);
    writeSync(descriptor, `${JSON.stringify({
      pid: process.pid,
      hostFingerprint,
      lockNonce,
      createdAt: new Date().toISOString(),
    })}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    optionsHook(options.beforeRegistryLockPublish);
    while (!ownsLock) {
      try {
        // Publish the complete owner atomically without replacing a contender.
        linkSync(candidatePath, lockPath);
        ownsLock = true;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        const existing = readRegistryLock(lockPath);
        if (!existing) continue; // The previous owner released between open attempts.
        if (existing.owner.hostFingerprint !== hostFingerprint) throw fail('REGISTRY_LOCK_FOREIGN');
        if (!pidIsActive(existing.owner.pid, options)) {
          const current = lstatIfPresent(lockPath);
          if (!current) continue;
          if (sameInode(existing.stat, current)) {
            unlinkSync(lockPath);
            continue;
          }
        }
        if (Date.now() >= deadline) throw fail('REGISTRY_BUSY');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    fsyncDirectory(root);
    return callback();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    const current = lstatIfPresent(lockPath);
    if (ownsLock && current && sameInode(candidateStat, current)) unlinkSync(lockPath);
    const candidate = lstatIfPresent(candidatePath);
    if (candidate) {
      if (!candidateStat || !sameInode(candidateStat, candidate)) throw fail('REGISTRY_LOCK_AMBIGUOUS');
      unlinkSync(candidatePath);
    }
  }
}

function readRegistryLock(lockPath) {
  let descriptor;
  try {
    descriptor = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw fail('REGISTRY_LOCK_AMBIGUOUS');
    assertOwnershipAndMode(stat, 0o600);
    const owner = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!isRecord(owner)
      || !exactKeys(owner, ['pid', 'hostFingerprint', 'lockNonce', 'createdAt'])
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || !safeBounded(owner.hostFingerprint)
      || typeof owner.lockNonce !== 'string' || !/^[0-9a-f-]{36}$/u.test(owner.lockNonce)
      || !timestamp(owner.createdAt)) {
      throw fail('REGISTRY_LOCK_AMBIGUOUS');
    }
    return { owner, stat };
  } catch (error) {
    if (error instanceof EnvironmentRegistryError) throw error;
    if (isNodeError(error, 'ELOOP')) throw fail('SYMLINK_REFUSED');
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw fail('REGISTRY_LOCK_AMBIGUOUS');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readOwnedTargetLock(lockPath, expectedStat) {
  const stat = lstatIfPresent(lockPath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
  }
  assertOwnershipAndMode(stat, 0o600);
  if (expectedStat && !sameInode(expectedStat, stat)) {
    throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
  }
  let owner;
  try {
    owner = readTargetLock(lockPath);
  } catch {
    throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
  }
  const rechecked = lstatIfPresent(lockPath);
  if (!rechecked || !sameInode(stat, rechecked)) {
    throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
  }
  return owner;
}

function pidIsActive(pid, options) {
  if (options.isPidActive) return options.isPidActive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function atomicJsonWrite(filePath, value, options = {}) {
  const parent = dirname(filePath);
  if (!existsSync(parent)) throw fail('PARENT_MISSING');
  if (options.privateDirectory === false) assertCanonicalOwnedDirectory(parent);
  else assertSafeDirectory(parent);
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  const temporary = join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error; }
  }
}

function writeExclusiveOwnerOnlyJson(filePath, value) {
  const parent = dirname(filePath);
  assertSafeDirectory(parent);
  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function assertSafeRegistrySnapshotTemporary(filePath) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  if (!stat.isFile()) throw fail('INVALID_REGISTRY_REVISION_HISTORY');
  assertOwnershipAndMode(stat, 0o600);
  return stat;
}

function cleanupRegistrySnapshotTemporaries(revisions) {
  let removed = false;
  for (const entry of readdirSync(revisions)) {
    if (!REGISTRY_SNAPSHOT_TEMPORARY.test(entry)) continue;
    const temporary = join(revisions, entry);
    const before = assertSafeRegistrySnapshotTemporary(temporary);
    const current = lstatSync(temporary);
    if (!sameInode(before, current)) throw fail('INVALID_REGISTRY_REVISION_HISTORY');
    unlinkSync(temporary);
    removed = true;
  }
  if (removed) fsyncDirectory(revisions);
}

function publishImmutableRegistrySnapshot(filePath, value, options) {
  const parent = dirname(filePath);
  assertSafeDirectory(parent);
  cleanupRegistrySnapshotTemporaries(parent);
  const temporary = join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  let temporaryStat;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
    temporaryStat = fstatSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    optionsHook(options.beforeRegistrySnapshotPublish);
    const currentTemporary = assertSafeRegistrySnapshotTemporary(temporary);
    if (!sameInode(temporaryStat, currentTemporary)) {
      throw fail('INVALID_REGISTRY_REVISION_HISTORY');
    }
    // A hard link publishes the fully synced inode atomically and, unlike
    // rename, fails with EEXIST instead of replacing an immutable revision.
    linkSync(temporary, filePath);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    const current = lstatIfPresent(temporary);
    if (current) {
      if (!temporaryStat || !sameInode(temporaryStat, current)) {
        throw fail('INVALID_REGISTRY_REVISION_HISTORY');
      }
      unlinkSync(temporary);
      fsyncDirectory(parent);
    }
  }
}

function registryStateExists(root) {
  if (existsSync(join(root, REGISTRY_FILE))) return true;
  const revisions = join(root, REGISTRY_REVISIONS);
  if (!existsSync(revisions)) return false;
  for (const entry of readdirSync(revisions)) {
    if (!REGISTRY_SNAPSHOT_TEMPORARY.test(entry)) return true;
    assertSafeRegistrySnapshotTemporary(join(revisions, entry));
  }
  return false;
}

function snapshotPath(root, revision) {
  return join(root, REGISTRY_REVISIONS, `revision-${String(revision).padStart(16, '0')}.json`);
}

function writeRegistryRevision(root, registry, options = {}) {
  validateRegistry(registry, options.allowLegacyRegistryRecovery === true);
  const revisions = join(root, REGISTRY_REVISIONS);
  if (!existsSync(revisions)) {
    mkdirSync(revisions, { mode: 0o700 });
    chmodSync(revisions, 0o700);
  }
  assertSafeDirectory(revisions);
  const immutablePath = snapshotPath(root, registry.revision);
  optionsHook(options.beforeRegistrySnapshotWrite);
  try {
    publishImmutableRegistrySnapshot(immutablePath, registry, options);
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
    const existing = validateRegistry(readOwnerOnlyJson(immutablePath, 'INVALID_REGISTRY'), options.allowLegacyRegistryRecovery === true);
    if (registryDigest(existing) !== registryDigest(registry)) {
      throw fail('REGISTRY_REVISION_CONFLICT');
    }
  }
  optionsHook(options.beforeRegistryCurrentWrite);
  atomicJsonWrite(join(root, REGISTRY_FILE), registry);
}

function readLatestRegistrySnapshot(root) {
  const revisions = join(root, REGISTRY_REVISIONS);
  if (!existsSync(revisions)) return undefined;
  assertSafeDirectory(revisions);
  const entries = readdirSync(revisions).sort();
  if (entries.length === 0) return undefined;
  let latest;
  let expectedPrevious = -1;
  for (const entry of entries) {
    if (REGISTRY_SNAPSHOT_TEMPORARY.test(entry)) {
      assertSafeRegistrySnapshotTemporary(join(revisions, entry));
      continue;
    }
    const match = /^revision-([0-9]{16})\.json$/u.exec(entry);
    if (!match) throw fail('INVALID_REGISTRY_REVISION_HISTORY');
    const revision = Number(match[1]);
    if (!Number.isSafeInteger(revision) || revision !== expectedPrevious + 1) {
      throw fail('INVALID_REGISTRY_REVISION_HISTORY');
    }
    const snapshot = validateRegistry(readOwnerOnlyJson(join(revisions, entry), 'INVALID_REGISTRY'), true);
    if (snapshot.revision !== revision) throw fail('INVALID_REGISTRY_REVISION_HISTORY');
    if (latest?.schemaVersion === ENVIRONMENT_REGISTRY_SCHEMA
      && snapshot.schemaVersion !== ENVIRONMENT_REGISTRY_SCHEMA) {
      throw fail('REGISTRY_SCHEMA_ROLLBACK');
    }
    latest = snapshot;
    expectedPrevious = revision;
  }
  return latest;
}

function registryDigest(registry) {
  return createHash('sha256').update(stableEnvironmentJson(registry)).digest('hex');
}

export function stableEnvironmentJson(input) {
  if (Array.isArray(input)) return `[${input.map(stableEnvironmentJson).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) =>
      `${JSON.stringify(key)}:${stableEnvironmentJson(input[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(input);
}

function preflightClaimMarker(markerPath, expectedPrevious) {
  assertCanonicalOwnedDirectory(dirname(markerPath));
  if (!existsSync(markerPath) && !lstatIfPresent(markerPath)) return;
  const stat = lstatSync(markerPath);
  if (stat.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  if (!expectedPrevious) throw fail('MARKER_ALREADY_EXISTS');
  const marker = readMarker(markerPath);
  if (!sameClaim(marker, expectedPrevious)) throw fail('MARKER_MISMATCH');
}

function repairOrphanMarker(registry, worktree, requestedTarget) {
  const markerPath = environmentMarkerPath(worktree.path);
  const before = lstatIfPresent(markerPath);
  if (!before) return false;
  if (before.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  const marker = readMarker(markerPath);
  if (!activeEnvironmentTargets.includes(marker.target)
    || marker.canonicalWorktreePath !== worktree.path
    || marker.branch !== worktree.branch
    || marker.hostFingerprint !== registry.hostFingerprint) {
    throw fail('MARKER_MISMATCH');
  }
  if (requestedTarget !== undefined && marker.target !== requestedTarget) return false;
  const centralClaim = registry.targets[marker.target].claim;
  if (centralClaim !== null) return false;
  const anotherCentralClaim = activeEnvironmentTargets.some((target) =>
    registry.targets[target].claim?.canonicalWorktreePath === worktree.path
  );
  if (anotherCentralClaim) throw fail('MARKER_MISMATCH');
  const current = lstatSync(markerPath);
  if (!sameInode(before, current)) throw fail('MARKER_MISMATCH');
  unlinkSync(markerPath);
  return true;
}

function writeClaimMarker(markerPath, claim, options) {
  optionsHook(options.beforeMarkerWrite);
  atomicJsonWrite(markerPath, claim, { privateDirectory: false });
  const persisted = readMarker(markerPath);
  if (!sameClaim(persisted, claim)) throw fail('MARKER_MISMATCH');
}

function lstatIfPresent(filePath) {
  try { return lstatSync(filePath); } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function optionsHook(hook) {
  if (hook !== undefined) hook();
}

function statusForTarget(registration, now, options) {
  let health = 'ready';
  let markerMatches = true;
  let claimIdentitySafe = true;
  if (registration.claim) {
    try {
      assertSafeClaimWorktreeDirectory(registration.claim.canonicalWorktreePath);
    } catch {
      claimIdentitySafe = false;
    }
    try {
      markerMatches = sameClaim(
        readMarker(environmentMarkerPath(registration.claim.canonicalWorktreePath)),
        registration.claim,
      );
    } catch {
      markerMatches = false;
    }
  }
  if (!registration.identityMatches || !claimIdentitySafe) health = 'identity_mismatch';
  else if (!registration.reachable) health = 'unreachable';
  else if (registration.claim && Date.parse(registration.claim.expiresAt) <= now) health = 'expired_claim';
  else if (registration.claim && !markerMatches) health = 'stale_claim';
  let verifierLock = { status: 'clear' };
  try {
    verifierLock = readEnvironmentTargetLockStatus(registration.evidenceRoot, {
      host: options.lockHost ?? hostname(),
      ...(options.isPidActive ? { isPidActive: options.isPidActive } : {}),
    });
    if (verifierLock.ownerRunId !== undefined && !safePublicRunId(verifierLock.ownerRunId)) {
      throw fail('SECRET_LIKE_FIELD');
    }
  } catch {
    verifierLock = { status: 'foreign' };
    if (health === 'ready') health = 'identity_mismatch';
  }
  return Object.freeze({
    target: registration.target,
    health,
    sourceSha: registration.sourceRevision,
    dirty: registration.sourceDirty,
    servingVersion: registration.servingVersion,
    transport: registration.transport,
    workspaceAlias: `env-${registration.target}-workspace`,
    workspaceLabel: registration.workspaceLabel,
    appAlias: `env-${registration.target}-slack-app`,
    appLabel: registration.slackAppLabel,
    claim: registration.claim ? publicClaim(registration.claim, now) : null,
    verifierLock: Object.freeze({
      status: verifierLock.status,
      ...(verifierLock.ownerRunId ? { ownerRunId: verifierLock.ownerRunId } : {}),
    }),
    schemaGeneration: registration.schemaGeneration,
    lastAttestedRevision: registration.lastAttestation?.sourceRevision ?? null,
    recoveryAction: recoveryAction(health, registration.target),
  });
}

export function readEnvironmentTargetLockStatus(evidenceRoot, options = {}) {
  assertSafeEvidenceRoot(evidenceRoot);
  const lockPath = targetLockPath(evidenceRoot);
  assertSafeOptionalOwnerFile(lockPath);
  return readTargetLockStatus(lockPath, options);
}

function assertTargetMutationUnlocked(registration, options = {}) {
  const pendingIntentPath = join(registration.evidenceRoot, 'deploy-intent.json');
  const pendingIntentStat = lstatIfPresent(pendingIntentPath);
  if (pendingIntentStat) {
    const pendingIntent = readOwnerOnlyJson(pendingIntentPath, 'MUTATION_LEASE_AUTHORITY_CHANGED');
    if (!isRecord(pendingIntent)
      || pendingIntent.target !== registration.target
      || pendingIntent.runId !== options.expectedTargetLockRunId) {
      throw fail('TARGET_MUTATION_LOCKED', {
        target: registration.target,
        status: 'intent',
        ...(safeBounded(pendingIntent?.runId, 128) ? { ownerRunId: pendingIntent.runId } : {}),
      });
    }
  }
  const status = readEnvironmentTargetLockStatus(registration.evidenceRoot, {
    host: options.lockHost ?? hostname(),
    ...(options.isPidActive ? { isPidActive: options.isPidActive } : {}),
  });
  if (status.status === 'clear') return;
  if (options.expectedTargetLockRunId !== undefined
    && status.ownerRunId === options.expectedTargetLockRunId
    && status.status !== 'foreign') return;
  throw fail('TARGET_MUTATION_LOCKED', {
    target: registration.target, status: status.status,
    ...(status.ownerRunId ? { ownerRunId: status.ownerRunId } : {}),
  });
}

function validateMutationLeaseAuthority(
  registry,
  registration,
  claim,
  worktree,
  authority,
  options = {},
) {
  if (!isRecord(authority)
    || !exactKeys(authority, ['runId', 'intentDigest', 'claimNonce'])
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(authority.runId ?? '')
    || !/^sha256:[a-f0-9]{64}$/u.test(authority.intentDigest ?? '')
    || authority.claimNonce !== claim.leaseNonce) {
    throw fail('MUTATION_LEASE_AUTHORITY_REQUIRED');
  }
  const intentPath = join(registration.evidenceRoot, 'deploy-intent.json');
  const intent = readOwnerOnlyJson(intentPath, 'MUTATION_LEASE_AUTHORITY_REQUIRED');
  const unsigned = isRecord(intent)
    ? Object.fromEntries(Object.entries(intent).filter(([key]) => key !== 'intentDigest'))
    : undefined;
  if (!isRecord(intent)
    || intent.schemaVersion !== 'chickpea-environment-deploy-intent/v1'
    || intent.target !== registration.target
    || intent.runId !== authority.runId
    || intent.claimNonce !== authority.claimNonce
    || intent.intentDigest !== authority.intentDigest
    || intent.claimedRevision !== claim.claimedRevision
    || intent.sourceDirty !== worktree.dirty
    || intent.workerName !== registration.workerName
    || intent.authDatabaseId !== registration.authDatabaseId
    || intent.tagStateId !== registration.bindingIdentities.TAG_STATE
    || intent.intentDigest !== `sha256:${createHash('sha256')
      .update(stableEnvironmentJson(unsigned)).digest('hex')}`) {
    throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
  }
  const status = readEnvironmentTargetLockStatus(registration.evidenceRoot, {
    host: options.lockHost ?? hostname(),
    ...(options.isPidActive ? { isPidActive: options.isPidActive } : {}),
  });
  if (status.status === 'clear') {
    if (options.allowMissingTargetLock !== true) {
      throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
    }
  } else if (status.status === 'foreign' || status.ownerRunId !== authority.runId) {
    throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
  }
  if (registry.targets[registration.target].claim?.leaseNonce !== authority.claimNonce) {
    throw fail('MUTATION_LEASE_AUTHORITY_CHANGED');
  }
  return intent;
}

function assertSafeClaimWorktreeDirectory(worktreePath) {
  const stat = lstatIfPresent(worktreePath);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()
    || realpathSync(worktreePath) !== worktreePath) {
    throw fail('NON_CANONICAL_WORKTREE');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw fail('NON_OWNER_FILE');
  }
  if ((stat.mode & 0o022) !== 0) throw fail('UNSAFE_PERMISSIONS');
}

function publicClaim(claim, now) {
  return Object.freeze({
    holderId: `holder-${createHash('sha256')
      .update(`${claim.hostFingerprint}\0${claim.canonicalWorktreePath}`)
      .digest('hex').slice(0, 16)}`,
    leaseAgeMs: Math.max(0, now - Date.parse(claim.claimedAt)),
    expiresAt: claim.expiresAt,
  });
}

export function assertSafeEvidenceRoot(evidenceRoot, options = {}) {
  if (typeof evidenceRoot !== 'string' || !path.isAbsolute(evidenceRoot)
    || resolve(evidenceRoot) !== evidenceRoot) {
    throw fail('UNSAFE_EVIDENCE_ROOT');
  }
  const stat = lstatIfPresent(evidenceRoot);
  if (!stat) throw fail('UNSAFE_EVIDENCE_ROOT');
  if (stat.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  if (!stat.isDirectory() || realpathSync(evidenceRoot) !== evidenceRoot) {
    throw fail('UNSAFE_EVIDENCE_ROOT');
  }
  const expectedUid = options.expectedUid
    ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (expectedUid !== undefined && stat.uid !== expectedUid) {
    throw fail('NON_OWNER_FILE');
  }
  if ((stat.mode & 0o077) !== 0) throw fail('UNSAFE_PERMISSIONS');
  return evidenceRoot;
}

function assertSafeOptionalOwnerFile(filePath) {
  const stat = lstatIfPresent(filePath);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  if (!stat.isFile()) throw fail('UNSAFE_EVIDENCE_ROOT');
  assertOwnershipAndMode(stat, 0o600);
}

function recoveryAction(health, target) {
  if (health === 'ready') return 'No recovery needed.';
  if (health === 'unreachable') return `Check ${target} Worker and Slack transport reachability.`;
  if (health === 'stale_claim') return `Run npm run env -- reclaim ${target} from the intended worktree.`;
  if (health === 'expired_claim') return `Run npm run env -- reclaim ${target}.`;
  return `Run npm run env -- reconciliation ${target}.`;
}

function unregisteredStatus(target, now) {
  const names = target ? [target] : activeEnvironmentTargets;
  return Object.freeze({
    schemaVersion: ENVIRONMENT_STATUS_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    registryRevision: null,
    selectedTarget: null,
    targets: Object.freeze(names.map((name) => Object.freeze({
      target: name,
      health: 'unreachable',
      sourceSha: null,
      dirty: false,
      servingVersion: null,
      transport: null,
      workspaceAlias: `env-${name}-workspace`,
      workspaceLabel: `${name} workspace`,
      appAlias: `env-${name}-slack-app`,
      appLabel: `${name} app`,
      claim: null,
      verifierLock: Object.freeze({ status: 'clear' }),
      schemaGeneration: null,
      lastAttestedRevision: null,
      recoveryAction: `Run npm run env -- reconciliation ${name}.`,
    }))),
    sandbox: null,
  });
}

function publicSandbox(sandbox, now) {
  if (sandbox === null) return null;
  const daysUntilArchive = Math.ceil((Date.parse(sandbox.archiveDate) - now) / 86_400_000);
  const warning = daysUntilArchive <= 14 ? '14_days'
    : daysUntilArchive <= 30 ? '30_days'
      : daysUntilArchive <= 45 ? '45_days' : 'none';
  return Object.freeze({
    archiveDate: sandbox.archiveDate,
    daysUntilArchive,
    warning,
    warningDays: Object.freeze([45, 30, 14]),
    unusedWorkspaceSlots: sandbox.workspaceSlotsTotal - sandbox.workspaceSlotsUsed,
    integrationHeadroom: sandbox.integrationHeadroom,
  });
}

function selectedTargetFor(registry, worktreePath) {
  if (!worktreePath || typeof worktreePath !== 'string') return null;
  let canonical;
  try { canonical = realpathSync(worktreePath); } catch { return null; }
  return activeEnvironmentTargets.find(
    (target) => registry.targets[target].claim?.canonicalWorktreePath === canonical,
  ) ?? null;
}

function validBindings(input, authDatabaseId) {
  return isRecord(input)
    && exactKeys(input, ['AUTH_DB', 'TAG_STATE'])
    && input.AUTH_DB === authDatabaseId
    && safeBounded(input.TAG_STATE);
}

function validComputerUse(input) {
  return isRecord(input)
    && exactKeys(input, ['bridgeAvailable', 'windowCaptureAvailable', 'slackVisible', 'adminVisible'])
    && Object.values(input).every((value) => typeof value === 'boolean');
}

function validVerifierLock(input) {
  return isRecord(input)
    && Object.keys(input).every((key) => ['status', 'ownerRunId'].includes(key))
    && ['clear', 'live', 'stale', 'foreign'].includes(input.status)
    && (input.ownerRunId === undefined || safeBounded(input.ownerRunId, 128));
}

function validProviderContext(input) {
  if (!Array.isArray(input) || input.length % 2 !== 0 || input.length > 4) return false;
  const seen = new Set();
  for (let index = 0; index < input.length; index += 2) {
    const flag = input[index];
    const value = input[index + 1];
    if (!['--profile', '--env'].includes(flag) || seen.has(flag)
      || typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) return false;
    seen.add(flag);
  }
  return true;
}

function validDeploymentMetadata(input, intent, registration) {
  return isRecord(input)
    && exactKeys(input, DEPLOYMENT_METADATA_KEYS)
    && input.target === intent.target
    && input.sourceRevision === intent.claimedRevision
    && input.sourceDirty === intent.sourceDirty
    && input.claimNonce === intent.claimNonce
    && input.registryRevision === intent.registryRevision
    && input.schemaGeneration === intent.schemaGeneration
    && input.workerName === registration.workerName
    && input.authDatabaseId === registration.authDatabaseId
    && input.tagStateId === registration.bindingIdentities.TAG_STATE
    && input.slackTeamId === registration.workspaceId
    && input.slackAppId === registration.slackAppId
    && input.slackBotUserId === registration.botUserId
    && [input.manifestDigest, input.setupContractDigest, input.baselineDigest]
      .every((value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value));
}

function validateAudit(input) {
  if (!isRecord(input)
    || !exactKeys(input, ['event', 'target', 'at', 'registryRevision'])
    || !['claim_created', 'claim_reclaimed', 'claim_released', 'target_attested', 'target_deploy_intent', 'target_deploy_aborted', 'target_deploy_pending', 'target_deployed', 'provider_auth_config_migrated'].includes(input.event)
    || !activeEnvironmentTargets.includes(input.target)
    || !timestamp(input.at)
    || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1) {
    throw fail('INVALID_AUDIT');
  }
  return input;
}

function auditEvent(event, target, now, registryRevision) {
  return Object.freeze({ event, target, at: new Date(now).toISOString(), registryRevision });
}

function trimAudit(audit) {
  if (audit.length > MAX_AUDIT_EVENTS) audit.splice(0, audit.length - MAX_AUDIT_EVENTS);
}

function assertRegistryHost(registry, expected) {
  if (registry.hostFingerprint !== expected) throw fail('HOST_MISMATCH');
}

function assertActiveTarget(target) {
  if (!activeEnvironmentTargets.includes(target)) throw fail('INACTIVE_TARGET');
  return target;
}

function canonicalRoot(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || resolve(input) !== input) {
    throw fail('NON_CANONICAL_REGISTRY_ROOT');
  }
  return input;
}

function assertSafeDirectory(directory) {
  const stat = assertCanonicalOwnedDirectory(directory);
  assertOwnershipAndMode(stat, 0o700);
}

function assertCanonicalOwnedDirectory(directory) {
  let stat;
  try { stat = lstatSync(directory); } catch { throw fail('REGISTRY_MISSING'); }
  if (stat.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  if (!stat.isDirectory() || realpathSync(directory) !== directory) throw fail('NON_CANONICAL_REGISTRY_ROOT');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw fail('NON_OWNER_FILE');
  }
  return stat;
}

function readOwnerOnlyJson(filePath, invalidCode) {
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) throw fail('SYMLINK_REFUSED');
    throw fail(invalidCode);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw fail(invalidCode);
    assertOwnershipAndMode(stat, 0o600);
    return JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error instanceof EnvironmentRegistryError) throw error;
    throw fail(invalidCode);
  } finally {
    closeSync(descriptor);
  }
}

function assertOwnershipAndMode(stat, expectedMode) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw fail('NON_OWNER_FILE');
  }
  if ((stat.mode & 0o777) !== expectedMode) throw fail('UNSAFE_PERMISSIONS');
}

function rejectSecretLikeFields(input, pathParts = []) {
  if (Array.isArray(input)) {
    input.forEach((value, index) => rejectSecretLikeFields(value, [...pathParts, String(index)]));
    return;
  }
  if (!isRecord(input)) {
    if (typeof input === 'string' && SECRET_VALUE.test(input)) throw fail('SECRET_LIKE_FIELD');
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
    if (SECRET_FIELD.test(normalizedKey)) {
      throw fail('SECRET_LIKE_FIELD', { field: [...pathParts, key].join('.') });
    }
    rejectSecretLikeFields(value, [...pathParts, key]);
  }
}

function assertRegistryOutsideRepository(root) {
  let existing = root;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const result = spawnSync('git', ['-C', existing, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (result.status === 0) throw fail('REGISTRY_INSIDE_REPOSITORY');
}

function assertCreationPathNoSymlinks(root) {
  let existing = root;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const stat = lstatSync(existing);
  if (stat.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  if (realpathSync(existing) !== existing) throw fail('NON_CANONICAL_REGISTRY_ROOT');
}

function sameClaim(left, right) {
  return CLAIM_KEYS.every((key) => left?.[key] === right?.[key]);
}

function nowMs(options) {
  const value = options.now ? options.now() : Date.now();
  if (!Number.isFinite(value)) throw fail('INVALID_CLOCK');
  return value;
}

function bounded(input, code, maximum = 255) {
  if (!safeBounded(input, maximum)) throw fail(code);
  return input;
}

function safeBounded(input, maximum = 512) {
  return typeof input === 'string' && input.length > 0 && input.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(input);
}

function safeLabel(input) {
  return safeBounded(input, 96)
    && /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,95}$/u.test(input)
    && !/^[ATUWCB][A-Z0-9]{7,}$/u.test(input)
    && !/(?:xox[abprs]-|xoxe[.-]|sk-[A-Za-z0-9]|\b(?:secret|token|password|credential|cookie|browser[ _-]?profile)\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu.test(input);
}

function safePublicRunId(input) {
  return typeof input === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input)
    && !/^[ATUWCB][A-Z0-9]{7,}$/u.test(input)
    && !/(?:xox[abprs]-|xoxe[.-]|sk-[A-Za-z0-9]|\b(?:secret|token|password|credential|cookie)\b|@)/iu.test(input);
}

function timestamp(input) {
  if (typeof input !== 'string' || input.length !== 24 || !Number.isFinite(Date.parse(input))) return false;
  try { return new Date(input).toISOString() === input; } catch { return false; }
}

function validServingVersion(input) {
  return typeof input === 'string' && (
    /^version-[A-Za-z0-9._-]{1,96}$/u.test(input)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input)
  );
}

function stringArray(input) {
  return Array.isArray(input) && input.length <= 64 && input.every((value) => safeBounded(value, 128));
}

function isRecord(input) {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function exactKeys(input, expected) {
  return sameArray(Object.keys(input).sort(), [...expected].sort());
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isNodeError(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

function fail(code, details) {
  return new EnvironmentRegistryError(code, details);
}
