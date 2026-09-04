import { createHash, randomUUID } from 'node:crypto';
import {
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
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  acquireTargetLock,
  clearTargetLock,
  readRunJournalStatus,
  readTargetLock,
  targetLockPath,
} from '../../qa/live/safety/lock.ts';
import {
  activeEnvironmentTargets,
  adoptEnvironmentMutationLock,
  abortEnvironmentDeploymentIntent,
  EnvironmentRegistryError,
  assertEnvironmentMutationClaim,
  assertLiveEnvironmentClaim,
  assertSafeEvidenceRoot,
  isEnvironmentDeploymentAbortState,
  recordEnvironmentDeploymentIntent,
  recordEnvironmentDeployment,
  readEnvironmentRegistry,
  readEnvironmentTargetLockStatus,
  stableEnvironmentJson,
} from './environment-registry.mjs';

export const ENVIRONMENT_BASELINE_SCHEMA = 'chickpea-environment-baseline/v1';
export const ENVIRONMENT_DEPLOY_RECEIPT_SCHEMA = 'chickpea-environment-deploy-receipt/v1';
export const ENVIRONMENT_RESOURCE_INTENT_SCHEMA = 'chickpea-environment-resource-creation-intent/v1';
export const ENVIRONMENT_RESOURCE_RECEIPT_SCHEMA = 'chickpea-environment-resource-creation-receipt/v1';
export const ENVIRONMENT_PROTECTED_INVENTORY_SCHEMA = 'chickpea-environment-protected-resource-inventory/v1';
const BASELINE_FILE = 'environment-baseline.json';
const DEPLOY_RECEIPT_FILE = 'deploy-receipt.json';
const DEPLOY_RECEIPT_PENDING_FILE = 'deploy-receipt.pending.json';
const DEPLOY_INTENT_FILE = 'deploy-intent.json';
const SCHEMA_INTENT_FILE = 'schema-advancement-intent.json';
const D1_MIGRATION_AUTHORITY_QUERY =
  'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1';
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^(?:version-[A-Za-z0-9._-]{1,96}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const CREDENTIAL_CLASSES = Object.freeze([
  'auth', 'cookie', 'signing', 'recovery', 'setup', 'encryption',
]);
const RUNTIME_SECRET_SOURCE_BINDINGS = Object.freeze({
  auth: 'CHICKPEA_AUTH_SECRET',
  cookie: 'hkdf(CHICKPEA_AUTH_SECRET,chickpea/cookie/v1)',
  signing: 'SLACK_SIGNING_SECRET',
  recovery: 'CHICKPEA_RECOVERY_TOKEN',
  setup: 'CHICKPEA_SETUP_CAPABILITY_DIGEST',
  encryption: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID+CHICKPEA_CREDENTIAL_KEY_<ID>',
});
const GATEWAY_RUNTIME_SECRET_SOURCE_BINDINGS = Object.freeze({
  ...RUNTIME_SECRET_SOURCE_BINDINGS,
  cookie: 'CHICKPEA_AUTH_SECRET',
  signing: 'slack.gateway.deploymentIdentity.v1.deploymentId',
});

export class EnvironmentPreflightError extends Error {
  constructor(code, details = undefined) {
    super(code);
    this.name = 'EnvironmentPreflightError';
    this.code = code;
    this.details = details;
  }
}

export function environmentBaselinePath(evidenceRoot) {
  return join(assertSafeEvidenceRoot(evidenceRoot), BASELINE_FILE);
}

export function environmentDeployReceiptPath(evidenceRoot) {
  return join(assertSafeEvidenceRoot(evidenceRoot), DEPLOY_RECEIPT_FILE);
}

export function readEnvironmentBaseline(evidenceRoot) {
  return validateBaseline(readOwnerOnlyJson(environmentBaselinePath(evidenceRoot), 'BASELINE_MISSING'));
}

export function writeEnvironmentBaseline(evidenceRoot, input) {
  const baseline = validateBaseline(input);
  exclusiveOwnerOnlyJson(environmentBaselinePath(evidenceRoot), baseline);
  return baseline;
}

export function readEnvironmentDeployReceipt(pathOrEvidenceRoot) {
  const receiptPath = path.basename(pathOrEvidenceRoot) === DEPLOY_RECEIPT_FILE
    ? pathOrEvidenceRoot
    : environmentDeployReceiptPath(pathOrEvidenceRoot);
  return validateDeployReceipt(readOwnerOnlyJson(receiptPath, 'DEPLOY_RECEIPT_MISSING'));
}

export function writeEnvironmentResourceCreationIntent(filePath, input, options = {}) {
  const context = assertLiveEnvironmentClaim(input?.target, options);
  assertSafeAuthorityOutputPath(filePath, 'INVALID_RESOURCE_INTENT');
  const unsigned = {
    schemaVersion: ENVIRONMENT_RESOURCE_INTENT_SCHEMA,
    target: input.target,
    provider: input.provider,
    kind: input.kind,
    claimNonce: context.claim.leaseNonce,
    registryRevision: context.registry.revision,
    createdAt: canonicalTimestamp(options.now ? options.now() : Date.now()),
  };
  const intent = validateResourceIntent({ ...unsigned, intentDigest: digest(unsigned) });
  exclusiveOwnerOnlyJson(filePath, intent);
  return intent;
}

export function writeEnvironmentResourceCreationReceipt(filePath, input, options = {}) {
  const context = assertLiveEnvironmentClaim(input?.target, options);
  assertSafeAuthorityOutputPath(filePath, 'INVALID_RESOURCE_RECEIPT');
  if (typeof input?.intentPath !== 'string' || !path.isAbsolute(input.intentPath)
    || resolve(input.intentPath) !== input.intentPath) throw fail('INVALID_RESOURCE_INTENT');
  assertSafeEvidenceRoot(dirname(input.intentPath));
  const intent = validateResourceIntent(readOwnerOnlyJson(input.intentPath, 'RESOURCE_INTENT_REQUIRED'));
  if (intent.target !== input.target || intent.provider !== input.provider || intent.kind !== input.kind
    || intent.claimNonce !== context.claim.leaseNonce
    || intent.registryRevision > context.registry.revision) {
    throw fail('RESOURCE_INTENT_MISMATCH');
  }
  const providerReadback = options.allowSuppliedProviderReadback === true
    ? input.providerReadback
    : options.readProviderResource?.({
      target: input.target, provider: input.provider, kind: input.kind,
      id: input.id, creationIntentDigest: intent.intentDigest,
    });
  const readback = validateProviderResourceReadback(providerReadback);
  if (readback.target !== input.target || readback.provider !== input.provider
    || readback.kind !== input.kind || readback.id !== input.id
    || readback.creationIntentDigest !== intent.intentDigest) {
    throw fail('PROVIDER_RESOURCE_READBACK_MISMATCH');
  }
  const unsigned = {
    schemaVersion: ENVIRONMENT_RESOURCE_RECEIPT_SCHEMA,
    target: input.target,
    provider: input.provider,
    kind: input.kind,
    id: input.id,
    claimNonce: context.claim.leaseNonce,
    registryRevision: context.registry.revision,
    intentDigest: intent.intentDigest,
    providerImmutableId: readback.immutableId,
    providerReadbackDigest: providerResourceIdentityDigest(readback),
    providerObservedAt: readback.observedAt,
    createdAt: canonicalTimestamp(options.now ? options.now() : Date.now()),
  };
  const receipt = validateResourceReceipt({ ...unsigned, receiptDigest: digest(unsigned) });
  consumeResourceIntent(input.intentPath, filePath, receipt);
  exclusiveOwnerOnlyJson(filePath, receipt);
  return receipt;
}

function consumeResourceIntent(intentPath, receiptPath, receipt) {
  const consumedPath = `${intentPath}.consumed.json`;
  const consumed = Object.freeze({
    schemaVersion: 'chickpea-environment-resource-intent-consumption/v1',
    intentDigest: receipt.intentDigest,
    receiptPath,
    provider: receipt.provider,
    kind: receipt.kind,
    id: receipt.id,
  });
  const existing = lstatIfPresent(consumedPath);
  if (!existing) {
    try {
      exclusiveOwnerOnlyJson(consumedPath, consumed);
      return;
    } catch (error) {
      if (!(error instanceof EnvironmentPreflightError)
        || error.code !== 'AUTHORITY_FILE_EXISTS') throw error;
    }
  }
  const recorded = readOwnerOnlyJson(consumedPath, 'RESOURCE_INTENT_CONSUMED');
  if (stableEnvironmentJson(recorded) !== stableEnvironmentJson(consumed)
    || lstatIfPresent(receiptPath)) {
    throw fail('RESOURCE_INTENT_CONSUMED');
  }
}

export function authorizeEnvironmentCleanupPlan(targets, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return Object.freeze([]);
  const context = assertLiveEnvironmentClaim(options.target, options);
  const protectedIds = protectedEnvironmentResourceIds(context.registry);
  const inventories = options.allowSuppliedProtectedInventories === true
    ? options.protectedInventories
    : readProtectedEnvironmentInventories(context.registry);
  for (const inventory of validateProtectedInventories(inventories)) {
    for (const resource of [...inventory.baseline, ...inventory.productOwned]) {
      protectedIds.add(resource.id);
    }
  }
  const receiptPaths = options.receiptPaths ?? [];
  if (!Array.isArray(receiptPaths) || receiptPaths.length !== targets.length) {
    throw fail('CLEANUP_RECEIPT_REQUIRED');
  }
  const receipts = receiptPaths.map((receiptPath) => {
    if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)
      || resolve(receiptPath) !== receiptPath) throw fail('INVALID_RESOURCE_RECEIPT');
    assertSafeEvidenceRoot(dirname(receiptPath));
    return validateResourceReceipt(readOwnerOnlyJson(receiptPath, 'CLEANUP_RECEIPT_REQUIRED'));
  });
  const authorizedWithReceipts = targets.map((resource) => {
    if (!isRecord(resource) || !bounded(resource.provider) || !bounded(resource.kind)
      || !bounded(resource.id) || /[*?\[\]]/u.test(resource.id)) {
      throw fail('INVALID_CLEANUP_PLAN');
    }
    if (protectedIds.has(resource.id)) throw fail('PROTECTED_PERMANENT_RESOURCE');
    const matches = receipts.filter((receipt) => receipt.provider === resource.provider
      && receipt.kind === resource.kind && receipt.id === resource.id);
    if (matches.length !== 1
      || matches[0].target !== options.target
      || matches[0].claimNonce !== context.claim.leaseNonce
      || matches[0].registryRevision > context.registry.revision) {
      throw fail('CLEANUP_RECEIPT_MISMATCH');
    }
    return Object.freeze({ resource: Object.freeze({ ...resource }), receipt: matches[0] });
  });
  if (typeof options.readProviderResource !== 'function') throw fail('PROVIDER_READBACK_REQUIRED');
  const currentReadbacks = authorizedWithReceipts.map(({ resource, receipt }) => {
    const readback = validateProviderResourceReadback(options.readProviderResource({
      ...resource, target: options.target, creationIntentDigest: receipt.intentDigest,
      immutableId: receipt.providerImmutableId,
    }));
    if (readback.target !== options.target || readback.provider !== resource.provider
      || readback.kind !== resource.kind || readback.id !== resource.id
      || readback.immutableId !== receipt.providerImmutableId
      || readback.creationIntentDigest !== receipt.intentDigest
      || providerResourceIdentityDigest(readback) !== receipt.providerReadbackDigest) {
      throw fail('PROVIDER_RESOURCE_READBACK_MISMATCH');
    }
    return readback;
  });
  if (currentReadbacks.length !== authorizedWithReceipts.length) {
    throw fail('PROVIDER_READBACK_REQUIRED');
  }
  return Object.freeze(authorizedWithReceipts.map(({ resource, receipt }) => Object.freeze({
    ...resource,
    immutableId: receipt.providerImmutableId,
    creationIntentDigest: receipt.intentDigest,
  })));
}

function readProtectedEnvironmentInventories(registry) {
  return activeEnvironmentTargets.map((target) => readOwnerOnlyJson(
    join(assertSafeEvidenceRoot(registry.targets[target].evidenceRoot),
      'protected-resource-inventory.json'),
    'PROTECTED_INVENTORY_REQUIRED',
  ));
}

function validateProtectedInventories(input) {
  if (!Array.isArray(input) || input.length !== activeEnvironmentTargets.length) {
    throw fail('INVALID_PROTECTED_INVENTORY');
  }
  const inventories = input.map((inventory) => {
    if (!isRecord(inventory)
      || !exactKeys(inventory, ['schemaVersion', 'target', 'baseline', 'productOwned'])
      || inventory.schemaVersion !== ENVIRONMENT_PROTECTED_INVENTORY_SCHEMA
      || !activeEnvironmentTargets.includes(inventory.target)
      || !Array.isArray(inventory.baseline) || !Array.isArray(inventory.productOwned)) {
      throw fail('INVALID_PROTECTED_INVENTORY');
    }
    for (const resource of [...inventory.baseline, ...inventory.productOwned]) {
      validateCleanupResource(resource, 'INVALID_PROTECTED_INVENTORY');
    }
    return inventory;
  });
  if (new Set(inventories.map(({ target }) => target)).size !== activeEnvironmentTargets.length) {
    throw fail('INVALID_PROTECTED_INVENTORY');
  }
  return inventories;
}

function protectedEnvironmentResourceIds(registry) {
  const ids = new Set();
  for (const registration of Object.values(registry.targets)) {
    for (const value of [
      registration.workerName, registration.authDatabaseName, registration.authDatabaseId,
      registration.workspaceId, registration.slackAppId, registration.botUserId,
      registration.providerProjectId, registration.providerAuthConfigId,
      registration.evidenceRoot, ...Object.values(registration.bindingIdentities),
    ]) ids.add(value);
  }
  return ids;
}

function validateResourceReceipt(input) {
  const fields = [
    'schemaVersion', 'target', 'provider', 'kind', 'id', 'claimNonce',
    'registryRevision', 'intentDigest', 'providerImmutableId',
    'providerReadbackDigest', 'providerObservedAt',
    'createdAt', 'receiptDigest',
  ];
  if (!isRecord(input) || !exactKeys(input, fields)
    || input.schemaVersion !== ENVIRONMENT_RESOURCE_RECEIPT_SCHEMA
    || !activeEnvironmentTargets.includes(input.target)
    || !bounded(input.provider) || !bounded(input.kind) || !bounded(input.id)
    || !bounded(input.providerImmutableId)
    || !/^[0-9a-f-]{36}$/u.test(input.claimNonce)
    || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1
    || !DIGEST.test(input.intentDigest) || !DIGEST.test(input.providerReadbackDigest)
    || canonicalTimestamp(input.providerObservedAt) !== input.providerObservedAt
    || canonicalTimestamp(input.createdAt) !== input.createdAt
    || !DIGEST.test(input.receiptDigest)) throw fail('INVALID_RESOURCE_RECEIPT');
  const { receiptDigest, ...unsigned } = input;
  if (digest(unsigned) !== receiptDigest
    || providerResourceIdentityDigest({
      target: input.target, provider: input.provider, kind: input.kind, id: input.id,
      immutableId: input.providerImmutableId, creationIntentDigest: input.intentDigest,
    }) !== input.providerReadbackDigest) throw fail('INVALID_RESOURCE_RECEIPT');
  return input;
}

function validateResourceIntent(input) {
  const fields = [
    'schemaVersion', 'target', 'provider', 'kind', 'claimNonce',
    'registryRevision', 'createdAt', 'intentDigest',
  ];
  if (!isRecord(input) || !exactKeys(input, fields)
    || input.schemaVersion !== ENVIRONMENT_RESOURCE_INTENT_SCHEMA
    || !activeEnvironmentTargets.includes(input.target)
    || !bounded(input.provider) || !bounded(input.kind)
    || !/^[0-9a-f-]{36}$/u.test(input.claimNonce)
    || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1
    || canonicalTimestamp(input.createdAt) !== input.createdAt
    || !DIGEST.test(input.intentDigest)) throw fail('INVALID_RESOURCE_INTENT');
  const { intentDigest, ...unsigned } = input;
  if (digest(unsigned) !== intentDigest) throw fail('INVALID_RESOURCE_INTENT');
  return input;
}

function validateProviderResourceReadback(input) {
  if (!isRecord(input)
    || !exactKeys(input, [
      'target', 'provider', 'kind', 'id', 'creationIntentDigest', 'observedAt',
      'immutableId',
    ])
    || !activeEnvironmentTargets.includes(input.target)
    || !bounded(input.provider) || !bounded(input.kind) || !bounded(input.id)
    || !bounded(input.immutableId)
    || /[*?\[\]]/u.test(input.id)
    || !DIGEST.test(input.creationIntentDigest)
    || canonicalTimestamp(input.observedAt) !== input.observedAt) {
    throw fail('INVALID_PROVIDER_RESOURCE_READBACK');
  }
  return input;
}

function providerResourceIdentityDigest(readback) {
  return digest({
    target: readback.target, provider: readback.provider, kind: readback.kind,
    id: readback.id, immutableId: readback.immutableId,
    creationIntentDigest: readback.creationIntentDigest,
  });
}

function validateCleanupResource(resource, code = 'INVALID_CLEANUP_PLAN') {
  if (!isRecord(resource) || !exactKeys(resource, ['provider', 'kind', 'id'])
    || !bounded(resource.provider) || !bounded(resource.kind) || !bounded(resource.id)
    || /[*?\[\]]/u.test(resource.id)) throw fail(code);
  return resource;
}

function assertSafeAuthorityOutputPath(filePath, code) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
    || resolve(filePath) !== filePath) throw fail(code);
  assertSafeEvidenceRoot(dirname(filePath));
}

export function computeEnvironmentBaselineDigest(input) {
  return digest(validateBaseline(input));
}

export function writeEnvironmentSchemaAdvancementIntent(target, toGeneration, options = {}) {
  const context = assertLiveEnvironmentClaim(target, options);
  if (!validSchemaGeneration(toGeneration)) {
    throw fail('INVALID_SCHEMA_ADVANCEMENT');
  }
  const localContract = validateLocalContract(
    options.localContract ?? readLocalEnvironmentContract(options),
  );
  const relation = schemaRelation(
    context.registration.schemaGeneration,
    toGeneration,
    localContract.schemaHistory,
  );
  if (relation < 0) throw fail('SCHEMA_ROLLBACK_REFUSED');
  if (relation !== 1 || localContract.schemaGeneration !== toGeneration
    || !isRecordedSchemaSuccessor(
      context.registration.schemaGeneration,
      toGeneration,
      localContract.schemaHistory,
    )) {
    throw fail('INVALID_SCHEMA_ADVANCEMENT');
  }
  const intent = Object.freeze({
    schemaVersion: 'chickpea-environment-schema-advancement-intent/v1',
    target,
    claimNonce: context.claim.leaseNonce,
    registryRevision: context.registry.revision,
    fromGeneration: context.registration.schemaGeneration,
    toGeneration,
    successorOf: context.registration.schemaGeneration,
    historyDigest: digest(localContract.schemaHistory),
    createdAt: canonicalTimestamp(options.now ? options.now() : Date.now()),
  });
  atomicOwnerOnlyJson(join(context.registration.evidenceRoot, SCHEMA_INTENT_FILE), intent);
  return intent;
}

export function recoverEnvironmentSchemaAdvancement(target, options = {}) {
  const context = assertLiveEnvironmentClaim(target, options);
  const intentPath = join(context.registration.evidenceRoot, SCHEMA_INTENT_FILE);
  const intent = readSchemaIntent(intentPath);
  if (intent.target !== target || intent.claimNonce !== context.claim.leaseNonce
    || intent.toGeneration !== context.registration.schemaGeneration
    || context.registration.reachable !== true || context.registration.identityMatches !== true) {
    throw fail('SCHEMA_ADVANCEMENT_NOT_RECOVERABLE');
  }
  unlinkSchemaIntentIfUnchanged(intentPath, intent);
  return Object.freeze({ target, recovered: true, schemaGeneration: intent.toGeneration });
}

export async function preflightEnvironmentMutation(target, options = {}) {
  // Legacy compatibility is only for finishing/releasing existing authority.
  options = { ...options, allowLegacyRegistryRecovery: false };
  const context = assertLiveEnvironmentClaim(target, options);
  const baseline = validateBaseline(options.baseline ?? readEnvironmentBaseline(
    context.registration.evidenceRoot,
  ));
  if (baseline.target !== target) throw fail('BASELINE_TARGET_MISMATCH');
  const localContract = validateLocalContract(
    options.localContract ?? readLocalEnvironmentContract(options),
  );
  const schemaAdvancement = assertLocalContractMatchesBaseline(
    localContract,
    baseline,
    context,
  );
  assertUniqueCredentialFingerprints(baseline.credentialFingerprintsByTarget);
  const observe = selectAuthorityObserver(options);
  const authority = validateAuthority(await observe({
    target,
    claim: Object.freeze({ ...context.claim }),
    registration: Object.freeze({ ...context.registration }),
    phase: 'before',
  }, options));
  assertAuthorityMatches(context.registration, baseline, authority, {
    expectedVersion: context.registration.servingVersion,
    expectedSchema: context.registration.schemaGeneration,
  });
  if (options.targetTuple) assertTargetTuple(context.registration, options.targetTuple);
  const baselineDigest = computeEnvironmentBaselineDigest(baseline);
  const deploymentMetadata = Object.freeze({
    target,
    sourceRevision: context.claim.claimedRevision,
    sourceDirty: context.worktree.dirty,
    claimNonce: context.claim.leaseNonce,
    registryRevision: context.registry.revision,
    schemaGeneration: localContract.schemaGeneration,
    workerName: context.registration.workerName,
    authDatabaseId: context.registration.authDatabaseId,
    tagStateId: context.registration.bindingIdentities.TAG_STATE,
    slackTeamId: context.registration.workspaceId,
    slackAppId: context.registration.slackAppId,
    slackBotUserId: context.registration.botUserId,
    manifestDigest: baseline.manifestDigest,
    setupContractDigest: baseline.setupContractDigest,
    baselineDigest,
  });
  return Object.freeze({
    schemaVersion: 'chickpea-environment-mutation-preflight/v1',
    target,
    claim: Object.freeze({ ...context.claim }),
    registration: Object.freeze({ ...context.registration }),
    baseline,
    localContract,
    deploymentMetadata,
    schemaAdvancement,
  });
}

export function beginEnvironmentDeployment(preflight, options = {}) {
  if (!isRecord(preflight)
    || preflight.schemaVersion !== 'chickpea-environment-mutation-preflight/v1'
    || !activeEnvironmentTargets.includes(preflight.target)) {
    throw fail('INVALID_MUTATION_AUTHORITY');
  }
  recheckEnvironmentMutationAuthority(preflight, options);
  const evidenceRoot = assertSafeEvidenceRoot(preflight.registration.evidenceRoot);
  const runId = `environment-deploy-${preflight.target}-${randomUUID()}`;
  const intentId = `deploy-${randomUUID()}`;
  const owner = Object.freeze({
    runId,
    pid: process.pid,
    host: options.lockHost ?? hostname(),
    startedAt: canonicalTimestamp(options.now ? options.now() : Date.now()),
  });
  const intentPath = join(evidenceRoot, DEPLOY_INTENT_FILE);
  const providerContext = validateProviderContext(options.providerContext);
  const unsignedIntent = {
    schemaVersion: 'chickpea-environment-deploy-intent/v1',
    target: preflight.target,
    runId,
    intentId,
    claimNonce: preflight.claim.leaseNonce,
    claimedRevision: preflight.claim.claimedRevision,
    sourceDirty: preflight.deploymentMetadata.sourceDirty,
    registryRevision: preflight.deploymentMetadata.registryRevision,
    schemaGeneration: preflight.deploymentMetadata.schemaGeneration,
    workerName: preflight.registration.workerName,
    authDatabaseId: preflight.registration.authDatabaseId,
    tagStateId: preflight.registration.bindingIdentities.TAG_STATE,
    priorServingVersion: preflight.registration.servingVersion,
    priorSchemaGeneration: preflight.registration.schemaGeneration,
    providerContext,
    deploymentMetadata: preflight.deploymentMetadata,
    createdAt: owner.startedAt,
  };
  const intent = Object.freeze({ ...unsignedIntent, intentDigest: digest(unsignedIntent) });
  // The full recovery authority is durable before either the journal records
  // an unresolved intent or the target lock can become visible.
  exclusiveOwnerOnlyJson(intentPath, intent);
  if (options.afterDeployIntentPublished) options.afterDeployIntentPublished();
  const journalPath = join(evidenceRoot, 'runs', `${runId}.jsonl`);
  writeV0Journal(journalPath, runId, intentId);
  if (options.afterMutationJournalPublished) options.afterMutationJournalPublished();
  const lockPath = targetLockPath(evidenceRoot);
  try {
    acquireTargetLock(lockPath, owner);
  } catch {
    appendV0JournalEvent(journalPath, runId, 2, {
      type: 'receipt', intentId, outcome: 'refused',
    });
    unlinkOwnedAuthorityFile(intentPath, intent.intentDigest);
    throw fail('TARGET_MUTATION_LOCKED');
  }
  const lockStat = lstatSync(lockPath);
  if (options.afterMutationLockAcquired) options.afterMutationLockAcquired();
  try {
    const recorded = recordEnvironmentDeploymentIntent(preflight.target, intent, {
      ...options, expectedTargetLockRunId: runId,
    });
    if (options.afterDeploymentRegistryIntentRecorded) {
      options.afterDeploymentRegistryIntentRecorded();
    }
    return Object.freeze({
      schemaVersion: 'chickpea-environment-mutation-lease/v1',
      target: preflight.target,
      runId,
      intentId,
      claimNonce: preflight.claim.leaseNonce,
      intentDigest: intent.intentDigest,
      intentPath,
      journalPath,
      lockPath,
      lockPid: owner.pid,
      lockDev: lockStat.dev,
      lockIno: lockStat.ino,
      registryRevision: recorded.registryRevision,
    });
  } catch (error) {
    // The unresolved V0 intent and owned lock deliberately remain. No provider
    // mutation may start until reconciliation proves whether this boundary ran.
    throw error;
  }
}

/**
 * Adopt the one existing deployment after its forward-only D1 advancement is
 * live but before the old Worker version has been replaced. This never creates
 * a second intent: the original nonce, digest, journal, lock inode, provider
 * context, and local contract remain the complete mutation authority.
 */
export async function resumeEnvironmentDeployment(target, options = {}) {
  const registry = readEnvironmentRegistry(options);
  const registration = registry.targets[target];
  if (!registration) throw fail('INVALID_TARGET');
  const evidenceRoot = assertSafeEvidenceRoot(registration.evidenceRoot);
  const intentPath = join(evidenceRoot, DEPLOY_INTENT_FILE);
  if (!lstatIfPresent(intentPath)) return null;
  const intent = readDeployIntent(intentPath);
  const suppliedProviderContext = validateProviderContext(options.providerContext);
  if (suppliedProviderContext.length > 0
    && stableEnvironmentJson(suppliedProviderContext)
      !== stableEnvironmentJson(intent.providerContext)) {
    throw fail('PROVIDER_CONTEXT_CONFLICT');
  }
  const recoveryOptions = Object.freeze({ ...options, providerContext: intent.providerContext });
  const adopted = adoptMutationLock(target, intent, recoveryOptions, false);
  const lockPath = adopted.lockPath;
  const context = assertEnvironmentMutationClaim(
    target,
    { runId: intent.runId, intentDigest: intent.intentDigest, claimNonce: intent.claimNonce },
    recoveryOptions,
  );
  if (intent.target !== target
    || intent.claimNonce !== context.claim.leaseNonce
    || intent.claimedRevision !== context.claim.claimedRevision
    || intent.sourceDirty !== context.worktree.dirty
    || intent.workerName !== context.registration.workerName
    || intent.authDatabaseId !== context.registration.authDatabaseId
    || intent.tagStateId !== context.registration.bindingIdentities.TAG_STATE) {
    throw fail('DEPLOY_INTENT_CHANGED');
  }
  const baseline = readEnvironmentBaseline(evidenceRoot);
  if (computeEnvironmentBaselineDigest(baseline) !== intent.deploymentMetadata.baselineDigest) {
    throw fail('DEPLOY_INTENT_CHANGED');
  }
  const localContract = validateLocalContract(
    options.localContract ?? readLocalEnvironmentContract(options),
  );
  if (localContract.schemaGeneration !== intent.schemaGeneration
    || localContract.manifestDigest !== intent.deploymentMetadata.manifestDigest
    || localContract.setupContractDigest !== intent.deploymentMetadata.setupContractDigest
    || stableEnvironmentJson(localContract.requiredScopes)
      !== stableEnvironmentJson(baseline.requiredScopes)
    || assertLocalContractMatchesBaseline(localContract, baseline, context) !== true) {
    throw fail('MUTATION_AUTHORITY_CHANGED');
  }
  const journalPath = join(evidenceRoot, 'runs', `${intent.runId}.jsonl`);
  const lease = Object.freeze({
    schemaVersion: 'chickpea-environment-mutation-lease/v1', target,
    runId: intent.runId, intentId: intent.intentId,
    claimNonce: intent.claimNonce, intentDigest: intent.intentDigest,
    intentPath, journalPath, lockPath,
    lockPid: adopted.owner.pid,
    lockDev: adopted.lockDev, lockIno: adopted.lockIno,
    registryRevision: context.registry.revision,
  });
  const preflight = Object.freeze({
    schemaVersion: 'chickpea-environment-mutation-preflight/v1',
    target,
    claim: Object.freeze({ ...context.claim }),
    registration: Object.freeze({ ...context.registration }),
    baseline,
    localContract,
    deploymentMetadata: Object.freeze({ ...intent.deploymentMetadata }),
    schemaAdvancement: true,
  });
  assertEnvironmentMutationLease(preflight, lease, recoveryOptions);
  const observe = selectAuthorityObserver(recoveryOptions);
  const authority = validateAuthority(await observe({
    target,
    claim: Object.freeze({ ...context.claim }),
    registration: Object.freeze({ ...context.registration }),
    phase: 'resume',
    expectedVersion: intent.priorServingVersion,
    expectedSchemaGeneration: intent.schemaGeneration,
  }, recoveryOptions));
  assertAuthorityMatches(context.registration, baseline, authority, {
    expectedVersion: intent.priorServingVersion,
    expectedSchema: intent.schemaGeneration,
    versionError: 'DEPLOYMENT_RESUME_LIVE_MISMATCH',
  });
  return Object.freeze({
    schemaVersion: 'chickpea-environment-deployment-resume/v1',
    preflight,
    mutationLease: lease,
  });
}

function adoptMutationLock(target, intent, options, allowMissingTargetLock) {
  try {
    return adoptEnvironmentMutationLock(target, {
      runId: intent.runId,
      intentId: intent.intentId,
      intentDigest: intent.intentDigest,
      claimNonce: intent.claimNonce,
    }, { ...options, allowMissingTargetLock });
  } catch (error) {
    if (error instanceof EnvironmentRegistryError) {
      throw fail(error.code, error.details);
    }
    throw error;
  }
}

/** Recheck a resume already adopted by this process without re-adopting it. */
export async function recheckResumedEnvironmentDeployment(resumed, options = {}) {
  if (!isRecord(resumed)
    || resumed.schemaVersion !== 'chickpea-environment-deployment-resume/v1') {
    throw fail('MUTATION_LEASE_REQUIRED');
  }
  const preflight = resumed.preflight;
  const lease = assertEnvironmentMutationLease(preflight, resumed.mutationLease, options);
  recheckEnvironmentMutationAuthority(preflight, { ...options, mutationLease: lease });
  const observe = selectAuthorityObserver(options);
  const authority = validateAuthority(await observe({
    target: preflight.target,
    claim: Object.freeze({ ...preflight.claim }),
    registration: Object.freeze({ ...preflight.registration }),
    phase: 'resume',
    expectedVersion: preflight.registration.servingVersion,
    expectedSchemaGeneration: preflight.deploymentMetadata.schemaGeneration,
  }, options));
  assertAuthorityMatches(preflight.registration, preflight.baseline, authority, {
    expectedVersion: preflight.registration.servingVersion,
    expectedSchema: preflight.deploymentMetadata.schemaGeneration,
    versionError: 'DEPLOYMENT_RESUME_LIVE_MISMATCH',
  });
  return resumed;
}

/**
 * Recover a deploy whose provider effect may have completed after the local
 * process died. This never guesses from CLI output: it re-reads the same live
 * Slack/Worker/D1 authority used by preflight, then resumes the nonce-bound
 * receipt and registry CAS under the original target lease.
 */
export async function reconcileEnvironmentDeployment(target, options = {}) {
  options = { ...options, allowLegacyRegistryRecovery: true };
  const registry = readEnvironmentRegistry(options);
  const registration = registry.targets[target];
  if (!registration) throw fail('INVALID_TARGET');
  const evidenceRoot = assertSafeEvidenceRoot(registration.evidenceRoot);
  const intentPath = join(evidenceRoot, DEPLOY_INTENT_FILE);
  if (!lstatIfPresent(intentPath)) {
    // A release can commit before its process dies with the safe fence still held.
    recoverSafeStaleTargetLock(evidenceRoot, options);
    return null;
  }
  const intent = readDeployIntent(intentPath);
  const suppliedProviderContext = validateProviderContext(options.providerContext);
  if (suppliedProviderContext.length > 0
    && stableEnvironmentJson(suppliedProviderContext)
      !== stableEnvironmentJson(intent.providerContext)) {
    throw fail('PROVIDER_CONTEXT_CONFLICT');
  }
  const recoveryOptions = Object.freeze({
    ...options,
    providerContext: intent.providerContext,
  });
  const adopted = adoptMutationLock(target, intent, recoveryOptions, true);
  const lockPath = adopted.lockPath;
  const journalPath = join(evidenceRoot, 'runs', `${intent.runId}.jsonl`);
  if (!lstatIfPresent(journalPath)) writeV0Journal(journalPath, intent.runId, intent.intentId);
  const context = assertEnvironmentMutationClaim(
    target,
    { runId: intent.runId, intentDigest: intent.intentDigest, claimNonce: intent.claimNonce },
    recoveryOptions,
  );
  if (intent.target !== target
    || intent.claimNonce !== context.claim.leaseNonce
    || intent.claimedRevision !== context.claim.claimedRevision
    || intent.sourceDirty !== context.worktree.dirty
    || intent.workerName !== context.registration.workerName
    || intent.authDatabaseId !== context.registration.authDatabaseId
    || intent.tagStateId !== context.registration.bindingIdentities.TAG_STATE) {
    throw fail('DEPLOY_INTENT_CHANGED');
  }
  const baseline = readEnvironmentBaseline(evidenceRoot);
  if (computeEnvironmentBaselineDigest(baseline) !== intent.deploymentMetadata.baselineDigest) {
    throw fail('DEPLOY_INTENT_CHANGED');
  }
  const localContract = validateLocalContract(
    options.localContract ?? readLocalEnvironmentContract(options),
  );
  if (localContract.schemaGeneration !== intent.schemaGeneration
    || localContract.manifestDigest !== intent.deploymentMetadata.manifestDigest
    || localContract.setupContractDigest !== intent.deploymentMetadata.setupContractDigest
    || stableEnvironmentJson(localContract.requiredScopes)
      !== stableEnvironmentJson(baseline.requiredScopes)) {
    throw fail('MUTATION_AUTHORITY_CHANGED');
  }
  const lease = Object.freeze({
    schemaVersion: 'chickpea-environment-mutation-lease/v1', target,
    runId: intent.runId, intentId: intent.intentId,
    claimNonce: intent.claimNonce, intentDigest: intent.intentDigest,
    intentPath, journalPath, lockPath,
    lockPid: adopted.owner.pid,
    lockDev: adopted.lockDev, lockIno: adopted.lockIno,
    registryRevision: context.registry.revision,
  });
  const preflight = Object.freeze({
    schemaVersion: 'chickpea-environment-mutation-preflight/v1',
    target,
    claim: Object.freeze({ ...context.claim }),
    registration: Object.freeze({ ...context.registration }),
    baseline,
    localContract,
    deploymentMetadata: Object.freeze({ ...intent.deploymentMetadata }),
    schemaAdvancement: intent.schemaGeneration !== intent.priorSchemaGeneration,
  });
  const allowAbortedRegistryRecovery = isEnvironmentDeploymentAbortState(
    target, intent, recoveryOptions,
  );
  assertEnvironmentMutationLease(preflight, lease, {
    ...recoveryOptions,
    allowCompletedRegistryRecovery: context.registration.reachable === true
      && context.registration.identityMatches === true,
    allowAbortedRegistryRecovery,
  });
  const observe = selectAuthorityObserver(recoveryOptions);
  const authority = validateAuthority(await observe({
    target,
    claim: Object.freeze({ ...context.claim }),
    registration: Object.freeze({ ...context.registration }),
    phase: 'reconcile',
    expectedSchemaGenerations: [...new Set([
      intent.priorSchemaGeneration,
      intent.schemaGeneration,
    ])],
  }, recoveryOptions));
  if (authority.activeVersion === intent.priorServingVersion) {
    assertAuthorityMatches(context.registration, baseline, authority, {
      expectedVersion: intent.priorServingVersion,
      expectedSchema: intent.priorSchemaGeneration,
      versionError: 'DEPLOY_ABORT_LIVE_MISMATCH',
    });
    const aborted = abortEnvironmentDeploymentIntent(target, intent, {
      ...recoveryOptions,
      expectedTargetLockRunId: intent.runId,
    });
    finishEnvironmentMutationAuthority({
      runId: intent.runId,
      intentId: intent.intentId,
      intentDigest: intent.intentDigest,
      intentPath,
      journalPath,
      lockPath,
      lockPid: adopted.owner.pid,
      lockDev: adopted.lockDev,
      lockIno: adopted.lockIno,
    }, 'aborted', recoveryOptions);
    return aborted;
  }
  assertAuthorityMatches(context.registration, baseline, authority, {
    expectedVersion: authority.activeVersion,
    expectedSchema: intent.schemaGeneration,
    versionError: 'DEPLOY_RECEIPT_LIVE_MISMATCH',
  });
  if (stableEnvironmentJson(authority.deploymentMetadata)
    !== stableEnvironmentJson(intent.deploymentMetadata)) {
    throw fail('DEPLOYMENT_METADATA_MISMATCH');
  }
  if (context.registration.reachable === true
    && context.registration.identityMatches === true) {
    const receipt = readEnvironmentDeployReceipt(evidenceRoot);
    assertReceiptMatchesClaim(receipt, context);
    if (receipt.activeVersion !== authority.activeVersion
      || stableEnvironmentJson(deploymentMetadataFromReceipt(receipt))
        !== stableEnvironmentJson(intent.deploymentMetadata)) {
      throw fail('DEPLOY_RECEIPT_LIVE_MISMATCH');
    }
    if (intent.schemaGeneration !== intent.priorSchemaGeneration) {
      const schemaIntentPath = join(evidenceRoot, SCHEMA_INTENT_FILE);
      const schemaIntent = readSchemaIntent(schemaIntentPath);
      if (schemaIntent.claimNonce !== intent.claimNonce
        || schemaIntent.toGeneration !== intent.schemaGeneration) {
        throw fail('SCHEMA_ADVANCEMENT_INTENT_CHANGED');
      }
      unlinkSchemaIntentIfUnchanged(schemaIntentPath, schemaIntent);
    }
    finishEnvironmentMutationAuthority({
      runId: intent.runId,
      intentId: intent.intentId,
      intentDigest: intent.intentDigest,
      intentPath,
      journalPath,
      lockPath,
      lockPid: adopted.owner.pid,
      lockDev: adopted.lockDev,
      lockIno: adopted.lockIno,
    }, 'completed', recoveryOptions);
    return receipt;
  }
  return completeEnvironmentDeployment(preflight, {
    ...recoveryOptions,
    deployedVersion: authority.activeVersion,
    mutationLease: lease,
  });
}

export async function completeEnvironmentDeployment(preflight, options = {}) {
  if (!isRecord(preflight)
    || preflight.schemaVersion !== 'chickpea-environment-mutation-preflight/v1'
    || !activeEnvironmentTargets.includes(preflight.target)
    || !VERSION.test(options.deployedVersion ?? '')) {
    throw fail('INVALID_DEPLOYMENT_COMPLETION');
  }
  const mutationLease = assertEnvironmentMutationLease(
    preflight,
    options.mutationLease,
    options,
  );
  const current = assertEnvironmentMutationClaim(
    preflight.target,
    mutationLeaseAuthority(mutationLease),
    options,
  );
  if (current.claim.leaseNonce !== preflight.claim.leaseNonce
    || current.claim.claimedRevision !== preflight.claim.claimedRevision
    || current.worktree.dirty !== preflight.deploymentMetadata.sourceDirty) {
    throw fail('CLAIM_CHANGED');
  }
  const observe = selectAuthorityObserver(options);
  const authority = validateAuthority(await observe({
    target: preflight.target,
    claim: Object.freeze({ ...current.claim }),
    registration: Object.freeze({ ...current.registration }),
    phase: 'after',
    deployedVersion: options.deployedVersion,
    expectedSchemaGeneration: preflight.deploymentMetadata.schemaGeneration,
  }, options));
  assertAuthorityMatches(current.registration, preflight.baseline, authority, {
    expectedVersion: options.deployedVersion,
    versionError: 'POST_DEPLOY_VERSION_DRIFT',
    expectedSchema: preflight.deploymentMetadata.schemaGeneration,
  });
  if (stableEnvironmentJson(authority.deploymentMetadata) !== stableEnvironmentJson(
    preflight.deploymentMetadata,
  )) throw fail('DEPLOYMENT_METADATA_MISMATCH');
  const issuedAt = canonicalTimestamp(options.now ? options.now() : Date.now());
  const unsigned = {
    schemaVersion: ENVIRONMENT_DEPLOY_RECEIPT_SCHEMA,
    target: preflight.target,
    sourceRevision: preflight.deploymentMetadata.sourceRevision,
    sourceDirty: preflight.deploymentMetadata.sourceDirty,
    claimNonce: preflight.deploymentMetadata.claimNonce,
    registryRevision: preflight.deploymentMetadata.registryRevision,
    schemaGeneration: preflight.deploymentMetadata.schemaGeneration,
    workerName: preflight.registration.workerName,
    authDatabaseBinding: preflight.registration.authDatabaseBinding,
    authDatabaseId: preflight.registration.authDatabaseId,
    tagStateId: preflight.registration.bindingIdentities.TAG_STATE,
    slackTeamId: preflight.registration.workspaceId,
    slackAppId: preflight.registration.slackAppId,
    slackBotUserId: preflight.registration.botUserId,
    transport: preflight.registration.transport,
    activeVersion: options.deployedVersion,
    manifestDigest: preflight.baseline.manifestDigest,
    setupContractDigest: preflight.baseline.setupContractDigest,
    baselineDigest: preflight.deploymentMetadata.baselineDigest,
    issuedAt,
  };
  const receipt = Object.freeze({ ...unsigned, receiptDigest: digest(unsigned) });
  const receiptPath = environmentDeployReceiptPath(preflight.registration.evidenceRoot);
  const pendingReceiptPath = join(preflight.registration.evidenceRoot, DEPLOY_RECEIPT_PENDING_FILE);
  recordEnvironmentDeployment(preflight.target, receipt, {
    ...options,
    expectedTargetLockRunId: mutationLease.runId,
    mutationLeaseAuthority: mutationLeaseAuthority(mutationLease),
    publishPendingReceipt: () => atomicOwnerOnlyJson(pendingReceiptPath, receipt),
    finalizeReceipt: () => {
      if (options.beforeReceiptFinalize) options.beforeReceiptFinalize();
      publishPendingReceipt(pendingReceiptPath, receiptPath);
    },
  });
  if (preflight.schemaAdvancement) {
    const intentPath = join(preflight.registration.evidenceRoot, SCHEMA_INTENT_FILE);
    const intent = readSchemaIntent(intentPath);
    if (intent.claimNonce !== preflight.claim.leaseNonce
      || intent.toGeneration !== receipt.schemaGeneration) throw fail('SCHEMA_ADVANCEMENT_INTENT_CHANGED');
    unlinkSchemaIntentIfUnchanged(intentPath, intent);
  }
  if (options.beforeMutationLeaseResolve) options.beforeMutationLeaseResolve();
  resolveEnvironmentMutationLease(mutationLease, options);
  return receipt;
}

function publishPendingReceipt(pendingPath, finalPath) {
  assertSafeEvidenceRoot(dirname(pendingPath));
  const pending = lstatIfPresent(pendingPath);
  if (!pending || pending.isSymbolicLink()) throw fail('UNSAFE_AUTHORITY_FILE');
  assertOwnerOnly(pending);
  const existing = lstatIfPresent(finalPath);
  if (existing?.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  if (existing) assertOwnerOnly(existing);
  renameSync(pendingPath, finalPath);
  const directory = openSync(dirname(finalPath), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export async function observeReceiptBackedEnvironment(target, options = {}) {
  const context = assertLiveEnvironmentClaim(target, options);
  const receipt = readEnvironmentDeployReceipt(context.registration.evidenceRoot);
  const baseline = readEnvironmentBaseline(context.registration.evidenceRoot);
  // The current claim authorizes this observation. The receipt preserves the
  // original deployment claim, which is checked against live metadata below.
  assertReceiptMatchesDeployment(receipt, context);
  const observe = selectAuthorityObserver(options);
  const authority = validateAuthority(await observe({
    target,
    claim: Object.freeze({ ...context.claim }),
    registration: Object.freeze({ ...context.registration }),
    phase: 'attest',
  }, options));
  assertAuthorityMatches(context.registration, baseline, authority, {
    expectedVersion: receipt.activeVersion,
    expectedSchema: receipt.schemaGeneration,
    versionError: 'DEPLOY_RECEIPT_LIVE_MISMATCH',
  });
  if (authority.activeVersion !== receipt.activeVersion
    || authority.workerName !== receipt.workerName
    || authority.bindingIdentities.AUTH_DB !== receipt.authDatabaseId
    || authority.slack.teamId !== receipt.slackTeamId
    || authority.slack.appId !== receipt.slackAppId
    || authority.slack.botUserId !== receipt.slackBotUserId
    || authority.transport !== receipt.transport
    || authority.schemaGeneration !== receipt.schemaGeneration
    || stableEnvironmentJson(authority.deploymentMetadata)
      !== stableEnvironmentJson(deploymentMetadataFromReceipt(receipt))) {
    throw fail('DEPLOY_RECEIPT_LIVE_MISMATCH');
  }
  const activatedAt = receipt.issuedAt;
  return Object.freeze({
    targetAlias: target,
    transport: receipt.transport,
    workerName: receipt.workerName,
    deployments: Object.freeze([{ versionId: receipt.activeVersion, percentage: 100, activatedAt }]),
    bindingIdentities: Object.freeze({ ...authority.bindingIdentities }),
    slack: Object.freeze({ teamId: receipt.slackTeamId, appId: receipt.slackAppId }),
    provider: Object.freeze({
      projectId: context.registration.providerProjectId,
      authConfigId: context.registration.providerAuthConfigId,
    }),
    timezone: context.registration.timezone,
    evidenceRoot: context.registration.evidenceRoot,
    ...(receipt.transport === 'gateway'
      ? { gateway: Object.freeze({ ...authority.transportAuthority }) }
      : { events: Object.freeze({
        installationHealthy: authority.transportAuthority.installationHealthy,
        signedEventReceiptFresh: authority.transportAuthority.signedEventReceiptFresh,
        signedEventReceiptVersionId: authority.transportAuthority.signedEventReceiptVersionId,
        signedEventReceiptAt: authority.transportAuthority.signedEventReceiptAt,
        installationRevision: authority.transportAuthority.installationRevision,
      }) }),
  });
}

function assertReceiptMatchesClaim(receipt, context) {
  if (receipt.claimNonce !== context.claim.leaseNonce) {
    throw fail('DEPLOY_RECEIPT_CLAIM_MISMATCH');
  }
  assertReceiptMatchesDeployment(receipt, context);
}

function assertReceiptMatchesDeployment(receipt, context) {
  if (receipt.target !== context.registration.target
    || receipt.sourceRevision !== context.claim.claimedRevision
    || receipt.sourceDirty !== context.worktree.dirty
    || receipt.activeVersion !== context.registration.servingVersion
    || receipt.schemaGeneration !== context.registration.schemaGeneration
    || receipt.workerName !== context.registration.workerName
    || receipt.authDatabaseId !== context.registration.authDatabaseId
    || receipt.tagStateId !== context.registration.bindingIdentities.TAG_STATE
    || receipt.slackTeamId !== context.registration.workspaceId
    || receipt.slackAppId !== context.registration.slackAppId
    || receipt.slackBotUserId !== context.registration.botUserId) {
    throw fail('DEPLOY_RECEIPT_CLAIM_MISMATCH');
  }
}

function deploymentMetadataFromReceipt(receipt) {
  return Object.freeze({
    target: receipt.target,
    sourceRevision: receipt.sourceRevision,
    sourceDirty: receipt.sourceDirty,
    claimNonce: receipt.claimNonce,
    registryRevision: receipt.registryRevision,
    schemaGeneration: receipt.schemaGeneration,
    workerName: receipt.workerName,
    authDatabaseId: receipt.authDatabaseId,
    tagStateId: receipt.tagStateId,
    slackTeamId: receipt.slackTeamId,
    slackAppId: receipt.slackAppId,
    slackBotUserId: receipt.slackBotUserId,
    manifestDigest: receipt.manifestDigest,
    setupContractDigest: receipt.setupContractDigest,
    baselineDigest: receipt.baselineDigest,
  });
}

export function assertSameEnvironmentMutationAuthority(before, after) {
  if (!isRecord(before) || !isRecord(after)
    || before.schemaVersion !== 'chickpea-environment-mutation-preflight/v1'
    || after.schemaVersion !== before.schemaVersion
    || before.target !== after.target
    || before.claim.leaseNonce !== after.claim.leaseNonce
    || before.claim.claimedRevision !== after.claim.claimedRevision
    || before.deploymentMetadata.sourceDirty !== after.deploymentMetadata.sourceDirty
    || before.registration.workerName !== after.registration.workerName
    || before.registration.authDatabaseId !== after.registration.authDatabaseId
    || before.registration.workspaceId !== after.registration.workspaceId
    || before.registration.slackAppId !== after.registration.slackAppId
    || before.registration.botUserId !== after.registration.botUserId
    || before.deploymentMetadata.baselineDigest !== after.deploymentMetadata.baselineDigest) {
    throw fail('MUTATION_AUTHORITY_CHANGED');
  }
  return after;
}

export function recheckEnvironmentMutationAuthority(preflight, options = {}) {
  if (!isRecord(preflight)
    || preflight.schemaVersion !== 'chickpea-environment-mutation-preflight/v1'
    || !activeEnvironmentTargets.includes(preflight.target)) {
    throw fail('INVALID_MUTATION_AUTHORITY');
  }
  const current = options.mutationLease !== undefined
    ? assertEnvironmentMutationClaim(
      preflight.target,
      mutationLeaseAuthority(options.mutationLease),
      options,
    )
    : assertLiveEnvironmentClaim(preflight.target, options);
  const baseline = readEnvironmentBaseline(current.registration.evidenceRoot);
  const localContract = validateLocalContract(
    options.localContract ?? readLocalEnvironmentContract(options),
  );
  if (current.claim.leaseNonce !== preflight.claim.leaseNonce
    || current.claim.claimedRevision !== preflight.claim.claimedRevision
    || current.worktree.dirty !== preflight.deploymentMetadata.sourceDirty
    || computeEnvironmentBaselineDigest(baseline) !== preflight.deploymentMetadata.baselineDigest
    || stableEnvironmentJson(localContract) !== stableEnvironmentJson(preflight.localContract)
    || current.registration.workerName !== preflight.registration.workerName
    || current.registration.authDatabaseId !== preflight.registration.authDatabaseId
    || current.registration.bindingIdentities.TAG_STATE
      !== preflight.registration.bindingIdentities.TAG_STATE
    || current.registration.workspaceId !== preflight.registration.workspaceId
    || current.registration.slackAppId !== preflight.registration.slackAppId
    || current.registration.botUserId !== preflight.registration.botUserId) {
    throw fail('MUTATION_AUTHORITY_CHANGED');
  }
  if (options.targetTuple) assertTargetTuple(current.registration, options.targetTuple);
  if (options.mutationLease !== undefined) {
    assertEnvironmentMutationLease(preflight, options.mutationLease, options);
  }
  return Object.freeze({ target: preflight.target, claim: Object.freeze({ ...current.claim }) });
}

function assertEnvironmentMutationLease(preflight, lease, options = {}) {
  const fields = [
    'schemaVersion', 'target', 'runId', 'intentId', 'claimNonce', 'intentDigest',
    'intentPath', 'journalPath', 'lockPath', 'lockPid', 'lockDev', 'lockIno',
    'registryRevision',
  ];
  if (!isRecord(lease) || !exactKeys(lease, fields)
    || lease.schemaVersion !== 'chickpea-environment-mutation-lease/v1'
    || lease.target !== preflight.target
    || lease.claimNonce !== preflight.claim.leaseNonce
    || !DIGEST.test(lease.intentDigest)
    || !Number.isSafeInteger(lease.lockPid) || lease.lockPid < 1
    || !Number.isSafeInteger(lease.lockDev) || !Number.isSafeInteger(lease.lockIno)
    || !Number.isSafeInteger(lease.registryRevision)) {
    throw fail('MUTATION_LEASE_REQUIRED');
  }
  const intent = readDeployIntent(lease.intentPath);
  const owner = readTargetLock(lease.lockPath);
  const lockStat = lstatIfPresent(lease.lockPath);
  const journal = readRunJournalStatus(lease.journalPath, lease.runId);
  const current = readEnvironmentRegistry(options).targets[preflight.target];
  if (!owner || !lockStat || owner.runId !== lease.runId
    || owner.pid !== lease.lockPid || lease.lockPid !== process.pid
    || lockStat.dev !== lease.lockDev || lockStat.ino !== lease.lockIno
    || intent.runId !== lease.runId || intent.intentId !== lease.intentId
    || intent.claimNonce !== lease.claimNonce || intent.intentDigest !== lease.intentDigest
    || intent.claimedRevision !== preflight.claim.claimedRevision
    || intent.sourceDirty !== preflight.deploymentMetadata.sourceDirty
    || intent.schemaGeneration !== preflight.deploymentMetadata.schemaGeneration
    || stableEnvironmentJson(intent.deploymentMetadata)
      !== stableEnvironmentJson(preflight.deploymentMetadata)
    || stableEnvironmentJson(intent.providerContext)
      !== stableEnvironmentJson(validateProviderContext(options.providerContext))
    || !(journal.unresolvedIntentIds.includes(lease.intentId)
      || ((options.allowCompletedRegistryRecovery === true
          || options.allowAbortedRegistryRecovery === true)
        && journal.safeToClear === true
        && journal.unresolvedIntentIds.length === 0))
    || !((current.reachable === false && current.identityMatches === false)
      || (options.allowCompletedRegistryRecovery === true
        && current.reachable === true && current.identityMatches === true)
      || options.allowAbortedRegistryRecovery === true)
    || current.claim?.leaseNonce !== lease.claimNonce) {
    throw fail('MUTATION_LEASE_CHANGED');
  }
  return lease;
}

function mutationLeaseAuthority(lease) {
  if (!isRecord(lease)) throw fail('MUTATION_LEASE_REQUIRED');
  return Object.freeze({
    runId: lease.runId,
    intentDigest: lease.intentDigest,
    claimNonce: lease.claimNonce,
  });
}

function readDeployIntent(intentPath) {
  const input = readOwnerOnlyJson(intentPath, 'DEPLOY_INTENT_MISSING');
  const fields = [
    'schemaVersion', 'target', 'runId', 'intentId', 'claimNonce', 'claimedRevision',
    'sourceDirty', 'registryRevision', 'schemaGeneration', 'workerName',
    'authDatabaseId', 'tagStateId', 'priorServingVersion', 'priorSchemaGeneration', 'providerContext',
    'deploymentMetadata', 'createdAt', 'intentDigest',
  ];
  if (!isRecord(input) || !exactKeys(input, fields)
    || input.schemaVersion !== 'chickpea-environment-deploy-intent/v1'
    || !activeEnvironmentTargets.includes(input.target)
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.runId)
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.intentId)
    || !/^[0-9a-f-]{36}$/u.test(input.claimNonce)
    || !/^[0-9a-f]{7,64}$/u.test(input.claimedRevision)
    || typeof input.sourceDirty !== 'boolean'
    || !Number.isSafeInteger(input.registryRevision)
    || !validSchemaGeneration(input.schemaGeneration)
    || !bounded(input.workerName) || !bounded(input.authDatabaseId) || !bounded(input.tagStateId)
    || !VERSION.test(input.priorServingVersion)
    || !validSchemaGeneration(input.priorSchemaGeneration)
    || stableEnvironmentJson(validateProviderContext(input.providerContext))
      !== stableEnvironmentJson(input.providerContext)
    || !validDeployIntentMetadata(input.deploymentMetadata, input)
    || canonicalTimestamp(input.createdAt) !== input.createdAt
    || !DIGEST.test(input.intentDigest)) throw fail('INVALID_DEPLOY_INTENT');
  const { intentDigest, ...unsigned } = input;
  if (digest(unsigned) !== intentDigest) throw fail('INVALID_DEPLOY_INTENT');
  return input;
}

function validDeployIntentMetadata(input, intent) {
  const fields = [
    'target', 'sourceRevision', 'sourceDirty', 'claimNonce', 'registryRevision',
    'schemaGeneration', 'workerName', 'authDatabaseId', 'tagStateId',
    'slackTeamId', 'slackAppId', 'slackBotUserId', 'manifestDigest',
    'setupContractDigest', 'baselineDigest',
  ];
  return isRecord(input) && exactKeys(input, fields)
    && input.target === intent.target
    && input.sourceRevision === intent.claimedRevision
    && input.sourceDirty === intent.sourceDirty
    && input.claimNonce === intent.claimNonce
    && input.registryRevision === intent.registryRevision
    && input.schemaGeneration === intent.schemaGeneration
    && input.workerName === intent.workerName
    && input.authDatabaseId === intent.authDatabaseId
    && input.tagStateId === intent.tagStateId
    && [input.manifestDigest, input.setupContractDigest, input.baselineDigest]
      .every((value) => typeof value === 'string' && DIGEST.test(value))
    && [input.slackTeamId, input.slackAppId, input.slackBotUserId].every(bounded);
}

function resolveEnvironmentMutationLease(lease, options = {}) {
  finishEnvironmentMutationAuthority(lease, 'completed', options);
}

function finishEnvironmentMutationAuthority(authority, outcome, options = {}) {
  if (!['completed', 'aborted'].includes(outcome)) throw fail('INVALID_MUTATION_AUTHORITY');
  const journalStat = lstatIfPresent(authority.journalPath);
  if (journalStat) {
    const journal = readRunJournalStatus(authority.journalPath, authority.runId);
    if (journal.unresolvedIntentIds.includes(authority.intentId)) {
      appendV0JournalEvent(authority.journalPath, authority.runId, 2, {
        type: 'receipt', intentId: authority.intentId, outcome,
      });
    } else if (!journal.safeToClear || journal.unresolvedIntentIds.length > 0) {
      throw fail('MUTATION_LEASE_CHANGED');
    }
  }
  if (options.afterMutationJournalResolved) options.afterMutationJournalResolved();
  const lockStat = lstatIfPresent(authority.lockPath);
  if (lockStat) {
    const owner = readTargetLock(authority.lockPath);
    if (!owner || owner.runId !== authority.runId
      || (authority.lockPid !== undefined && owner.pid !== authority.lockPid)
      || (authority.lockPid !== undefined && authority.lockPid !== process.pid)
      || (authority.lockDev !== undefined && lockStat.dev !== authority.lockDev)
      || (authority.lockIno !== undefined && lockStat.ino !== authority.lockIno)) {
      throw fail('MUTATION_LEASE_CHANGED');
    }
    unlinkSync(authority.lockPath);
    fsyncAuthorityDirectory(dirname(authority.lockPath));
  }
  if (options.afterMutationLockUnlinked) options.afterMutationLockUnlinked();
  if (lstatIfPresent(authority.intentPath)) {
    unlinkOwnedAuthorityFile(authority.intentPath, authority.intentDigest);
    fsyncAuthorityDirectory(dirname(authority.intentPath));
  }
  if (options.afterMutationIntentUnlinked) options.afterMutationIntentUnlinked();
}

function fsyncAuthorityDirectory(directoryPath) {
  const descriptor = openSync(directoryPath, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function environmentDeploymentMetadataBindings(metadata) {
  if (!isRecord(metadata)) throw fail('INVALID_DEPLOYMENT_METADATA');
  return Object.freeze(Object.fromEntries(Object.entries({
    CHICKPEA_ENV_TARGET: metadata.target,
    CHICKPEA_ENV_SOURCE_REVISION: metadata.sourceRevision,
    CHICKPEA_ENV_SOURCE_DIRTY: String(metadata.sourceDirty),
    CHICKPEA_ENV_CLAIM_NONCE: metadata.claimNonce,
    CHICKPEA_ENV_REGISTRY_REVISION: String(metadata.registryRevision),
    CHICKPEA_ENV_SCHEMA_GENERATION: metadata.schemaGeneration,
    CHICKPEA_ENV_WORKER: metadata.workerName,
    CHICKPEA_ENV_AUTH_DB_ID: metadata.authDatabaseId,
    CHICKPEA_ENV_TAG_STATE_ID: metadata.tagStateId,
    CHICKPEA_ENV_SLACK_TEAM: metadata.slackTeamId,
    CHICKPEA_ENV_SLACK_APP: metadata.slackAppId,
    CHICKPEA_ENV_SLACK_BOT: metadata.slackBotUserId,
    CHICKPEA_ENV_MANIFEST_DIGEST: metadata.manifestDigest,
    CHICKPEA_ENV_SETUP_CONTRACT_DIGEST: metadata.setupContractDigest,
    CHICKPEA_ENV_BASELINE_DIGEST: metadata.baselineDigest,
  })));
}

export function readLocalEnvironmentContract(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? fileURLToPath(new URL('../..', import.meta.url)));
  const manifestPath = join(projectRoot, 'slack-app-manifest.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { throw fail('INVALID_LOCAL_CONTRACT'); }
  const requiredScopes = [...new Set(manifest?.oauth_config?.scopes?.bot ?? [])].sort();
  if (!validScopes(requiredScopes)) throw fail('INVALID_LOCAL_CONTRACT');
  const setupFiles = options.setupContractFiles ?? [
    'src/auth/setup-capability.mjs',
    'src/auth/setup-handoff.ts',
    'src/management/setup-routes.ts',
    'src/config/onboarding-state.ts',
    'src/admin/onboarding-proof.ts',
  ];
  let setupSources;
  try {
    setupSources = setupFiles.map((relativePath) => ({
      path: relativePath,
      source: readFileSync(join(projectRoot, relativePath), 'utf8'),
    }));
  } catch {
    throw fail('INVALID_LOCAL_CONTRACT');
  }
  const config = options.config;
  const authDatabase = isRecord(config)
    ? (config.d1_databases ?? []).find((binding) => binding?.binding === 'AUTH_DB')
    : undefined;
  const migrationsDirectory = isRecord(config)
    ? resolve(dirname(options.configPath ?? join(projectRoot, 'wrangler.jsonc')),
      authDatabase?.migrations_dir ?? '')
    : join(projectRoot, 'migrations', 'better-auth');
  let d1History;
  try {
    d1History = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort()
      .map((name) => name.replace(/\.sql$/u, ''));
  } catch {
    throw fail('INVALID_LOCAL_CONTRACT');
  }
  let durableObjectHistory;
  if (isRecord(config) && Array.isArray(config.migrations)) {
    durableObjectHistory = config.migrations.map((migration) => migration?.tag)
      .filter((tag) => typeof tag === 'string');
  } else {
    const source = readFileSync(join(projectRoot, 'wrangler.jsonc'), 'utf8');
    durableObjectHistory = [...source.matchAll(/"tag"\s*:\s*"([A-Za-z0-9._-]+)"/gu)]
      .map((match) => match[1]);
  }
  return validateLocalContract({
    manifestDigest: digest(manifest),
    requiredScopes,
    setupContractDigest: digest(setupSources),
    schemaGeneration: `d1:${d1History.at(-1)};do:${durableObjectHistory.at(-1)}`,
    schemaHistory: { d1: d1History, durableObject: durableObjectHistory },
  });
}

export function assertEnvironmentReleaseAllowed(target, options = {}) {
  const registration = options.skipClaimCheck
    ? readEnvironmentRegistry(options).targets[target]
    : assertLiveEnvironmentClaim(target, options).registration;
  if (!registration) throw fail('INVALID_TARGET');
  const evidenceRoot = assertSafeEvidenceRoot(registration.evidenceRoot);
  const status = readEnvironmentTargetLockStatus(registration.evidenceRoot, {
    host: options.lockHost ?? hostname(),
    ...(options.isPidActive ? { isPidActive: options.isPidActive } : {}),
  });
  if (status.status === 'live') throw fail('TARGET_LOCK_LIVE', { target });
  if (status.ownerRunId) {
    const journalPath = join(evidenceRoot, 'runs', `${status.ownerRunId}.jsonl`);
    const journal = readRunJournalStatus(journalPath, status.ownerRunId);
    if (journal.unresolvedIntentIds.length > 0
      || journal.unresolvedCleanupIds.length > 0
      || !journal.safeToClear) {
      throw fail('UNRESOLVED_VERIFIER_INTENT', { target });
    }
  }
  const pendingDeployIntent = join(evidenceRoot, DEPLOY_INTENT_FILE);
  if (lstatIfPresent(pendingDeployIntent)) {
    readDeployIntent(pendingDeployIntent);
    throw fail('UNRESOLVED_VERIFIER_INTENT', { target });
  }
  return Object.freeze({ target, lockStatus: status.status, safeToRelease: true });
}

export function withEnvironmentReleaseFence(target, options = {}, release) {
  options = { ...options, allowLegacyRegistryRecovery: true };
  if (typeof release !== 'function') throw fail('INVALID_RELEASE_CALLBACK');
  const context = assertLiveEnvironmentClaim(target, options);
  assertEnvironmentReleaseAllowed(target, options);
  const lockPath = targetLockPath(context.registration.evidenceRoot);
  const host = options.lockHost ?? hostname();
  recoverSafeStaleTargetLock(context.registration.evidenceRoot, { ...options, lockHost: host });
  const owner = Object.freeze({
    runId: `environment-release-${target}-${randomUUID()}`,
    pid: process.pid,
    host,
    startedAt: canonicalTimestamp(options.now ? options.now() : Date.now()),
  });
  const journalPath = join(context.registration.evidenceRoot, 'runs', `${owner.runId}.jsonl`);
  writeV0Journal(journalPath, owner.runId);
  try {
    acquireTargetLock(lockPath, owner);
  } catch {
    throw fail('TARGET_LOCK_RACE', { target });
  }
  const ownedStat = lstatSync(lockPath);
  try {
    if (options.afterReleaseFenceAcquired) options.afterReleaseFenceAcquired({ lockPath, owner });
    const rechecked = assertLiveEnvironmentClaim(target, options);
    if (rechecked.claim.leaseNonce !== context.claim.leaseNonce) throw fail('CLAIM_CHANGED');
    return release(Object.freeze({ runId: owner.runId, journalPath, lockPath }));
  } finally {
    const currentOwner = readTargetLock(lockPath);
    const currentStat = lstatIfPresent(lockPath);
    if (currentOwner
      && currentStat
      && currentOwner.runId === owner.runId
      && currentOwner.pid === owner.pid
      && currentStat.dev === ownedStat.dev
      && currentStat.ino === ownedStat.ino) {
      unlinkSync(lockPath);
    }
  }
}

function recoverSafeStaleTargetLock(evidenceRoot, options = {}) {
  const lockPath = targetLockPath(evidenceRoot);
  const status = readEnvironmentTargetLockStatus(evidenceRoot, {
    host: options.lockHost ?? hostname(),
    ...(options.isPidActive ? { isPidActive: options.isPidActive } : {}),
  });
  if (status.status === 'clear') return false;
  if (status.status !== 'stale' || !status.ownerRunId) return false;
  const journalPath = join(evidenceRoot, 'runs', `${status.ownerRunId}.jsonl`);
  const journal = readRunJournalStatus(journalPath, status.ownerRunId);
  if (!journal.safeToClear) return false;
  clearTargetLock(lockPath, {
    runId: status.ownerRunId,
    host: options.lockHost ?? hostname(),
    journal,
    ...(options.isPidActive ? { isPidActive: options.isPidActive } : {}),
  });
  return true;
}

export async function observeProductionEnvironmentAuthority(context, options = {}) {
  if (options.readFleetRuntimeAuthorities && options.allowTestRuntimeAuthorityReader !== true) {
    throw fail('TEST_RUNTIME_AUTHORITY_READER_REFUSED');
  }
  if (!isRecord(context) || !activeEnvironmentTargets.includes(context.target)
    || !isRecord(context.registration) || !bounded(context.registration.workerName)) {
    throw fail('INVALID_LIVE_AUTHORITY_REQUEST');
  }
  const target = context.target;
  const workerName = context.registration.workerName;
  const providerContext = validateProviderContext(options.providerContext);
  const runWrangler = options.runWrangler ?? ((args) => spawnSync(
    process.execPath,
    [
      join(resolve(fileURLToPath(new URL('../..', import.meta.url))), 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      ...args,
    ],
    { encoding: 'utf8' },
  ));
  const deployment = parseCommandJson(
    runWrangler(['deployments', 'status', '--json', '--name', workerName, ...providerContext]),
    'WORKER_AUTHORITY_UNAVAILABLE',
  );
  const versions = Array.isArray(deployment?.versions)
    ? deployment.versions.filter((version) => Number(version?.percentage) > 0)
    : [];
  if (versions.length !== 1 || versions[0]?.percentage !== 100
    || !VERSION.test(versions[0]?.version_id ?? '')) {
    throw fail('DEPLOYMENT_VECTOR_MISMATCH');
  }
  const activeVersion = versions[0].version_id;
  const view = parseCommandJson(
    runWrangler([
      'versions', 'view', activeVersion, '--json', '--name', workerName, ...providerContext,
    ]),
    'WORKER_AUTHORITY_UNAVAILABLE',
  );
  const bindings = Array.isArray(view?.resources?.bindings) ? view.resources.bindings : [];
  const authDatabases = bindings.filter((binding) =>
    binding?.name === 'AUTH_DB' && binding?.type === 'd1'
  );
  if (authDatabases.length !== 1) throw fail('D1_MISMATCH');
  const authDatabaseId = authDatabases[0].database_id ?? authDatabases[0].id;
  if (!bounded(authDatabaseId)) throw fail('D1_MISMATCH');
  if (authDatabaseId !== context.registration.authDatabaseId) throw fail('D1_MISMATCH');
  const tagStateBindings = bindings.filter((binding) =>
    binding?.name === 'TAG_STATE'
      && ['durable_object_namespace', 'durable_object'].includes(binding?.type)
      && binding?.class_name === 'TagStateStore'
  );
  if (tagStateBindings.length !== 1) throw fail('DURABLE_OBJECT_AUTHORITY_MISMATCH');
  const actualTagStateId = tagStateBindings[0].namespace_id
    ?? tagStateBindings[0].id
    ?? `${workerName}:TagStateStore`;
  if (actualTagStateId !== context.registration.bindingIdentities.TAG_STATE) {
    throw fail('DURABLE_OBJECT_AUTHORITY_MISMATCH');
  }
  const deployedMigrations = Array.isArray(view?.migrations)
    ? view.migrations
    : Array.isArray(view?.metadata?.migrations) ? view.metadata.migrations : [];
  const actualDoGeneration = deployedMigrations.map((migration) => migration?.tag)
    .filter((tag) => typeof tag === 'string').at(-1)
    ?? await readCloudflareDoGeneration({ view, workerName, runWrangler, providerContext, options });
  if (!bounded(actualDoGeneration)) throw fail('DURABLE_OBJECT_AUTHORITY_MISMATCH');
  const authDatabaseCoordinate = context.registration.authDatabaseName ?? authDatabaseId;
  if (!bounded(authDatabaseCoordinate)) throw fail('D1_SCHEMA_AUTHORITY_UNAVAILABLE');
  const d1MigrationReadback = parseCommandJson(
    runWrangler([
      'd1', 'execute', authDatabaseCoordinate, '--remote', '--json',
      '--command', D1_MIGRATION_AUTHORITY_QUERY, ...providerContext,
    ]),
    'D1_SCHEMA_AUTHORITY_UNAVAILABLE',
  );
  const resultSets = Array.isArray(d1MigrationReadback) ? d1MigrationReadback : [];
  const successfulResults = resultSets.filter((statement) => statement?.success !== false
    && Array.isArray(statement?.results));
  if (successfulResults.length !== 1 || successfulResults[0].results.length !== 1) {
    throw fail('D1_SCHEMA_AUTHORITY_UNAVAILABLE');
  }
  const actualD1Generation = successfulResults[0].results[0]?.name?.replace(/\.sql$/u, '');
  if (!bounded(actualD1Generation)) throw fail('D1_SCHEMA_AUTHORITY_UNAVAILABLE');
  const actualSchemaGeneration = `d1:${actualD1Generation};do:${actualDoGeneration}`;
  const textBindings = Object.fromEntries(bindings.flatMap((binding) => {
    const value = binding?.text ?? binding?.value;
    return typeof binding?.name === 'string' && typeof value === 'string'
      ? [[binding.name, value]]
      : [];
  }));
  const stampedMetadata = deploymentMetadataFromBindings(textBindings);
  if (!stampedMetadata) {
    assertUnstampedRegisteredPredecessor(context, activeVersion, textBindings, options);
  }
  const schemaGeneration = stampedMetadata?.schemaGeneration ?? actualSchemaGeneration;
  const tagStateId = stampedMetadata?.tagStateId ?? actualTagStateId;
  const expectedSchemaGenerations = Array.isArray(context.expectedSchemaGenerations)
    ? context.expectedSchemaGenerations
    : [context.expectedSchemaGeneration ?? context.registration.schemaGeneration];
  if (schemaGeneration !== actualSchemaGeneration
    || !expectedSchemaGenerations.includes(actualSchemaGeneration)) {
    throw fail('INCOMPATIBLE_SCHEMA_GENERATION');
  }
  if (stampedMetadata && (stampedMetadata.target !== target
    || stampedMetadata.workerName !== workerName
    || stampedMetadata.authDatabaseId !== authDatabaseId
    || stampedMetadata.tagStateId !== actualTagStateId)) {
    throw fail('WORKER_METADATA_MISMATCH');
  }
  const env = options.env ?? process.env;
  const readFleetRuntimeAuthorities = options.readFleetRuntimeAuthorities
    ?? ((request) => readProductionFleetRuntimeAuthorities(request, {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      ...(options.credentialsRoot ? { credentialsRoot: options.credentialsRoot } : {}),
    }));
  const runtimeAuthorities = await readFleetRuntimeAuthorities({
    target,
    workerName,
    activeVersion,
    transport: context.registration.transport,
  });
  const validatedRuntimeAuthorities = Object.fromEntries(activeEnvironmentTargets.map((lane) => [
    lane,
    validateRuntimeAuthority(runtimeAuthorities?.[lane], lane, options.now ? options.now() : Date.now()),
  ]));
  const fleetCredentialFingerprints = Object.fromEntries(activeEnvironmentTargets.map((lane) => [
    lane,
    validatedRuntimeAuthorities[lane].secretFingerprints.fingerprints,
  ]));
  assertUniqueCredentialFingerprints(fleetCredentialFingerprints);
  const credentialFingerprints = fleetCredentialFingerprints[target];
  const runtimeAuthority = validatedRuntimeAuthorities[target];
  const transportAuthority = runtimeAuthority.transportAuthority;
  let slackAuthority;
  if (context.registration.transport === 'gateway') {
    if (runtimeAuthority.schemaVersion !== 'chickpea-environment-runtime-authority/v2'
      || !validTransportAuthority('gateway', transportAuthority, activeVersion)) {
      throw fail('RUNTIME_AUTHORITY_INVALID', { target });
    }
    slackAuthority = runtimeAuthority.slack;
    if (slackAuthority.teamId !== (stampedMetadata?.slackTeamId ?? context.registration.workspaceId)
      || slackAuthority.appId !== (stampedMetadata?.slackAppId ?? context.registration.slackAppId)
      || slackAuthority.botUserId !== (stampedMetadata?.slackBotUserId ?? context.registration.botUserId)) {
      throw fail('SLACK_AUTHORITY_MISMATCH');
    }
  } else {
    if (runtimeAuthority.schemaVersion !== 'chickpea-environment-runtime-authority/v1') {
      throw fail('RUNTIME_AUTHORITY_INVALID', { target });
    }
    slackAuthority = await readDirectSlackAuthority(target, env, options.fetchImpl ?? fetch);
  }
  return Object.freeze({
    target,
    observedAt: canonicalTimestamp(options.now ? options.now() : Date.now()),
    workerName,
    activeVersion,
    activePercentage: 100,
    bindingIdentities: Object.freeze({ AUTH_DB: authDatabaseId, TAG_STATE: tagStateId }),
    slack: Object.freeze(slackAuthority),
    transport: context.registration.transport,
    transportAuthority,
    schemaGeneration,
    credentialFingerprints: Object.freeze(credentialFingerprints),
    fleetCredentialFingerprints: Object.freeze(fleetCredentialFingerprints),
    deploymentMetadata: stampedMetadata,
  });
}

/** Registration precedes the first nonce-stamped deployment. Cloudflare
 * versions are immutable: only the exact registered predecessor can lack a
 * stamp, and only before deployment or while recovering that same intent.
 * The after/attest paths always require the complete stamp and deploy receipt.
 */
function assertUnstampedRegisteredPredecessor(context, activeVersion, bindings, options) {
  const code = 'WORKER_METADATA_MISMATCH';
  if (!['before', 'resume', 'reconcile'].includes(context.phase)
    || bindings.CHICKPEA_ENV_TARGET !== context.target
    || Object.keys(bindings).some((name) => name.startsWith('CHICKPEA_ENV_')
      && name !== 'CHICKPEA_ENV_TARGET')
    || activeVersion !== context.registration.servingVersion
    || context.registration.lastAttestation !== null) throw fail(code);
  const root = assertSafeEvidenceRoot(context.registration.evidenceRoot);
  const intentPath = join(root, DEPLOY_INTENT_FILE);
  const intent = context.phase === 'before' ? null : readDeployIntent(intentPath);
  // Recovery retains the original nonce-bound mutation authority even after
  // the ordinary claim expires. A new deployment must still hold a live claim.
  const current = intent
    ? assertEnvironmentMutationClaim(context.target, {
      runId: intent.runId, intentDigest: intent.intentDigest, claimNonce: intent.claimNonce,
    }, options)
    : assertLiveEnvironmentClaim(context.target, options);
  if (current.claim.leaseNonce !== context.claim?.leaseNonce
    || stableEnvironmentJson(current.registration) !== stableEnvironmentJson(context.registration)) {
    throw fail(code);
  }
  if ([DEPLOY_RECEIPT_FILE, DEPLOY_RECEIPT_PENDING_FILE].some((name) =>
    lstatIfPresent(join(root, name)))) throw fail(code);
  if (context.phase === 'before') {
    if (lstatIfPresent(intentPath)
      || readEnvironmentTargetLockStatus(root).status !== 'clear') throw fail(code);
    return;
  }
  if (intent.priorServingVersion !== activeVersion) throw fail(code);
}

async function readCloudflareDoGeneration({ view, workerName, runWrangler, providerContext, options }) {
  const code = 'DURABLE_OBJECT_AUTHORITY_MISMATCH';
  const etag = view?.resources?.script?.etag;
  if (!bounded(etag) || !/^[A-Za-z0-9_-]{1,128}$/u.test(workerName)) throw fail(code);
  const env = options.env ?? process.env;
  let accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const identity = parseCommandJson(runWrangler(['whoami', '--json', ...providerContext]), code);
    if (!Array.isArray(identity.accounts) || identity.accounts.length !== 1) throw fail(code);
    accountId = identity.accounts[0]?.id;
  }
  if (!/^[a-f0-9]{32}$/iu.test(accountId ?? '')) throw fail(code);
  // Keep credentials in memory. Never forward them to a configurable URL or
  // include provider bodies/CLI output in a failure message.
  const auth = parseCommandJson(runWrangler(['auth', 'token', '--json', ...providerContext]), code);
  let headers;
  if (['oauth', 'api_token'].includes(auth?.type) && bounded(auth.token)) {
    headers = { Authorization: `Bearer ${auth.token}` };
  } else if (auth?.type === 'api_key' && bounded(auth.key) && bounded(auth.email)) {
    headers = { 'X-Auth-Key': auth.key, 'X-Auth-Email': auth.email };
  } else {
    throw fail(code);
  }
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/services/${workerName}`,
      { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok) throw fail(code);
    const body = await readBoundedAuthorityJson(response);
    const script = body?.result?.default_environment?.script;
    if (body?.success !== true || body?.result?.id !== workerName
      || script?.etag !== etag || !bounded(script?.migration_tag)) throw fail(code);
    return script.migration_tag;
  } catch {
    throw fail(code);
  }
}

async function readDirectSlackAuthority(target, env, fetchImpl) {
  const tokenName = `CHICKPEA_ENV_${target.toUpperCase()}_SLACK_BOT_TOKEN`;
  const token = env[tokenName];
  if (typeof token !== 'string' || token.length < 8 || token.length > 512) {
    throw fail('SLACK_AUTHORITY_UNAVAILABLE');
  }
  let response;
  let slack;
  try {
    response = await fetchImpl('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
    });
    slack = await response.json();
  } catch {
    throw fail('SLACK_AUTHORITY_UNAVAILABLE');
  }
  const scopesHeader = response.headers?.get?.('x-oauth-scopes');
  const scopes = typeof scopesHeader === 'string'
    ? [...new Set(scopesHeader.split(',').map((value) => value.trim()).filter(Boolean))].sort()
    : undefined;
  if (!response.ok || slack?.ok !== true || !bounded(slack.team_id)
    || !bounded(slack.app_id ?? slack.api_app_id) || !bounded(slack.user_id)
    || !validObservedScopes(scopes)) {
    throw fail('SLACK_AUTHORITY_UNAVAILABLE');
  }
  return {
      teamId: slack.team_id,
      appId: slack.app_id ?? slack.api_app_id,
      botUserId: slack.user_id,
      replySenderId: slack.user_id,
      scopes: Object.freeze(scopes),
  };
}

function selectAuthorityObserver(options) {
  if (options.observeAuthority === undefined) return observeProductionEnvironmentAuthority;
  if (options.allowTestAuthorityObserver !== true || typeof options.observeAuthority !== 'function') {
    throw fail('TEST_AUTHORITY_OBSERVER_REFUSED');
  }
  return options.observeAuthority;
}

function validateProviderContext(input) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length % 2 !== 0 || input.length > 4) {
    throw fail('INVALID_PROVIDER_CONTEXT');
  }
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < input.length; index += 2) {
    const flag = input[index];
    const value = input[index + 1];
    if (!['--profile', '--env'].includes(flag) || seen.has(flag)
      || typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
      throw fail('INVALID_PROVIDER_CONTEXT');
    }
    seen.add(flag);
    normalized.push(flag, value);
  }
  return Object.freeze(normalized);
}

/**
 * Resolve one lane's live-authority read credential. Host environment
 * variables win; otherwise the owner-only lane credential file
 * `<credentialsRoot>/<target>-live.json` (`~/.chickpea/lane-credentials` by
 * default) supplies `authorityReadToken` and `origin`, with the authority path
 * appended. The token never leaves this process and is never logged.
 */
export function resolveLaneAuthorityCredentials(target, options = {}) {
  const env = options.env ?? process.env;
  const prefix = `CHICKPEA_ENV_${target.toUpperCase()}_LIVE_AUTHORITY`;
  let url = env[`${prefix}_URL`];
  let token = env[`${prefix}_READ_TOKEN`];
  if (typeof token === 'string' && token.trim() && typeof url === 'string' && url.trim()) {
    return { url, token, source: 'environment' };
  }
  const root = options.credentialsRoot ?? join(homedir(), '.chickpea', 'lane-credentials');
  let file;
  try {
    file = JSON.parse(readFileSync(join(root, `${target}-live.json`), 'utf8'));
  } catch {
    return { url, token, source: 'environment' };
  }
  const fileToken = typeof file?.authorityReadToken === 'string' ? file.authorityReadToken : undefined;
  const fileOrigin = typeof file?.origin === 'string' ? file.origin.replace(/\/+$/u, '') : undefined;
  if (typeof token !== 'string' || !token.trim()) token = fileToken;
  if (typeof url !== 'string' || !url.trim()) {
    url = fileOrigin ? `${fileOrigin}/internal/environment/authority` : undefined;
  }
  return { url, token, source: 'lane-credentials' };
}

async function readProductionFleetRuntimeAuthorities(_request, { env, fetchImpl, credentialsRoot }) {
  const endpoints = activeEnvironmentTargets.map((target) => {
    const { url, token } = resolveLaneAuthorityCredentials(target, {
      env,
      ...(credentialsRoot ? { credentialsRoot } : {}),
    });
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      throw fail('LIVE_AUTHORITY_READ_TOKEN_INVALID', { target });
    }
    if (typeof url !== 'string' || url.length > 2_048) {
      throw fail('LIVE_AUTHORITY_BRIDGE_UNAVAILABLE', { target });
    }
    try {
      const endpoint = new URL(url);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('unsafe');
      return { target, endpoint, token };
    } catch {
      throw fail('LIVE_AUTHORITY_BRIDGE_UNAVAILABLE', { target });
    }
  });
  return Object.fromEntries(await Promise.all(endpoints.map(async ({ target, endpoint, token }) => {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error('unavailable');
      return [target, await readBoundedAuthorityJson(response)];
    } catch {
      throw fail('LIVE_AUTHORITY_BRIDGE_UNAVAILABLE', { target });
    }
  })));
}

async function readBoundedAuthorityJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing authority body');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error('authority body too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}

function validateRuntimeAuthority(input, target, now) {
  const gateway = input?.schemaVersion === 'chickpea-environment-runtime-authority/v2';
  const version = gateway ? 'v2' : 'v1';
  if (!isRecord(input)
    || !exactKeys(input, [
      'schemaVersion', 'target', 'observedAt', 'secretFingerprints', 'transportAuthority',
      ...(gateway ? ['slack'] : []),
    ])
    || input.schemaVersion !== `chickpea-environment-runtime-authority/${version}`
    || input.target !== target
    || canonicalTimestamp(input.observedAt) !== input.observedAt
    || (gateway && Math.abs(Date.parse(input.observedAt) - now) > 60_000)
    || !isRecord(input.secretFingerprints)
    || !exactKeys(input.secretFingerprints, [
      'schemaVersion', 'sourceBindings', 'fingerprints',
    ])
    || input.secretFingerprints.schemaVersion
      !== `chickpea-environment-runtime-secret-fingerprints/${version}`
    || stableEnvironmentJson(input.secretFingerprints.sourceBindings)
      !== stableEnvironmentJson(gateway ? GATEWAY_RUNTIME_SECRET_SOURCE_BINDINGS : RUNTIME_SECRET_SOURCE_BINDINGS)
    || !validFingerprints(input.secretFingerprints.fingerprints)
    || (gateway && (!isRecord(input.slack)
      || !exactKeys(input.slack, ['teamId', 'appId', 'botUserId', 'replySenderId', 'scopes'])
      || !bounded(input.slack.teamId) || !bounded(input.slack.appId) || !bounded(input.slack.botUserId)
      || input.slack.replySenderId !== input.slack.botUserId || !validObservedScopes(input.slack.scopes)))) {
    throw fail('RUNTIME_AUTHORITY_INVALID', { target });
  }
  return input;
}

function parseCommandJson(result, code) {
  if (result?.error || result?.status !== 0 || typeof result?.stdout !== 'string') throw fail(code);
  try { return JSON.parse(result.stdout); } catch { throw fail(code); }
}

function deploymentMetadataFromBindings(bindings) {
  const fields = {
    target: 'CHICKPEA_ENV_TARGET',
    sourceRevision: 'CHICKPEA_ENV_SOURCE_REVISION',
    sourceDirty: 'CHICKPEA_ENV_SOURCE_DIRTY',
    claimNonce: 'CHICKPEA_ENV_CLAIM_NONCE',
    registryRevision: 'CHICKPEA_ENV_REGISTRY_REVISION',
    schemaGeneration: 'CHICKPEA_ENV_SCHEMA_GENERATION',
    workerName: 'CHICKPEA_ENV_WORKER',
    authDatabaseId: 'CHICKPEA_ENV_AUTH_DB_ID',
    tagStateId: 'CHICKPEA_ENV_TAG_STATE_ID',
    slackTeamId: 'CHICKPEA_ENV_SLACK_TEAM',
    slackAppId: 'CHICKPEA_ENV_SLACK_APP',
    slackBotUserId: 'CHICKPEA_ENV_SLACK_BOT',
    manifestDigest: 'CHICKPEA_ENV_MANIFEST_DIGEST',
    setupContractDigest: 'CHICKPEA_ENV_SETUP_CONTRACT_DIGEST',
    baselineDigest: 'CHICKPEA_ENV_BASELINE_DIGEST',
  };
  if (Object.values(fields).some((binding) => bindings[binding] === undefined)) return null;
  const metadata = Object.fromEntries(Object.entries(fields).map(([field, binding]) => [
    field,
    field === 'sourceDirty' ? bindings[binding] === 'true'
      : field === 'registryRevision' ? Number(bindings[binding]) : bindings[binding],
  ]));
  return Object.freeze(metadata);
}

function validateBaseline(input) {
  if (!isRecord(input)
    || !exactKeys(input, [
      'schemaVersion', 'target', 'manifestDigest', 'requiredScopes',
      'setupContractDigest', 'schemaGeneration', 'credentialFingerprintsByTarget',
    ])
    || input.schemaVersion !== ENVIRONMENT_BASELINE_SCHEMA
    || !activeEnvironmentTargets.includes(input.target)
    || !DIGEST.test(input.manifestDigest)
    || !validScopes(input.requiredScopes)
    || !DIGEST.test(input.setupContractDigest)
    || !validSchemaGeneration(input.schemaGeneration)
    || !isRecord(input.credentialFingerprintsByTarget)
    || !exactKeys(input.credentialFingerprintsByTarget, activeEnvironmentTargets)
    || Object.values(input.credentialFingerprintsByTarget).some((value) => !validFingerprints(value))) {
    throw fail('INVALID_BASELINE');
  }
  return input;
}

function validateLocalContract(input) {
  if (!isRecord(input)
    || !exactKeys(input, [
      'manifestDigest', 'requiredScopes', 'setupContractDigest', 'schemaGeneration',
      'schemaHistory',
    ])
    || !DIGEST.test(input.manifestDigest)
    || !validScopes(input.requiredScopes)
    || !DIGEST.test(input.setupContractDigest)
    || !validSchemaGeneration(input.schemaGeneration)
    || !validSchemaHistory(input.schemaHistory)) {
    throw fail('INVALID_LOCAL_CONTRACT');
  }
  return input;
}

function assertLocalContractMatchesBaseline(local, baseline, context) {
  if (local.manifestDigest !== baseline.manifestDigest
    || stableEnvironmentJson(local.requiredScopes) !== stableEnvironmentJson(baseline.requiredScopes)
    || local.setupContractDigest !== baseline.setupContractDigest) {
    throw fail('INSTALL_CONTINUATION_REQUIRED', {
      recoveryAction: 'Activate the install continuation module before changing the permanent lane app.',
    });
  }
  const relation = schemaRelation(
    context.registration.schemaGeneration,
    local.schemaGeneration,
    local.schemaHistory,
  );
  if (relation < 0) throw fail('SCHEMA_ROLLBACK_REFUSED');
  if (relation === 0) return false;
  const intent = readSchemaIntent(join(context.registration.evidenceRoot, SCHEMA_INTENT_FILE));
  if (intent.target !== context.registration.target
    || intent.claimNonce !== context.claim.leaseNonce
    || intent.fromGeneration !== context.registration.schemaGeneration
    || intent.successorOf !== context.registration.schemaGeneration
    || intent.toGeneration !== local.schemaGeneration
    || intent.historyDigest !== digest(local.schemaHistory)
    || !isRecordedSchemaSuccessor(
      context.registration.schemaGeneration,
      local.schemaGeneration,
      local.schemaHistory,
    )
    || intent.registryRevision > context.registry.revision) {
    throw fail('INCOMPATIBLE_SCHEMA_GENERATION');
  }
  return true;
}

function assertUniqueCredentialFingerprints(byTarget) {
  for (const credentialClass of CREDENTIAL_CLASSES) {
    const observed = activeEnvironmentTargets.map((target) => byTarget[target][credentialClass]);
    if (new Set(observed).size !== activeEnvironmentTargets.length) {
      throw fail('CREDENTIAL_FINGERPRINT_REUSED', { credentialClass });
    }
  }
}

function validateAuthority(input) {
  if (!isRecord(input)
    || !activeEnvironmentTargets.includes(input.target)
    || typeof input.observedAt !== 'string' || canonicalTimestamp(input.observedAt) !== input.observedAt
    || !bounded(input.workerName)
    || !VERSION.test(input.activeVersion)
    || input.activePercentage !== 100
    || !isRecord(input.bindingIdentities)
    || !exactKeys(input.bindingIdentities, ['AUTH_DB', 'TAG_STATE'])
    || !Object.values(input.bindingIdentities).every(bounded)
    || !isRecord(input.slack)
    || !exactKeys(input.slack, ['teamId', 'appId', 'botUserId', 'replySenderId', 'scopes'])
    || !bounded(input.slack.teamId) || !bounded(input.slack.appId)
    || !bounded(input.slack.botUserId) || !bounded(input.slack.replySenderId)
    || !validObservedScopes(input.slack.scopes)
    || !['gateway', 'events'].includes(input.transport)
    || !validTransportAuthority(input.transport, input.transportAuthority, input.activeVersion)
    || !validSchemaGeneration(input.schemaGeneration)
    || !validFingerprints(input.credentialFingerprints)
    || !isRecord(input.fleetCredentialFingerprints)
    || !exactKeys(input.fleetCredentialFingerprints, activeEnvironmentTargets)
    || Object.values(input.fleetCredentialFingerprints).some((value) => !validFingerprints(value))
    || !(input.deploymentMetadata === null || isRecord(input.deploymentMetadata))) {
    throw fail('INVALID_LIVE_AUTHORITY');
  }
  return input;
}

function assertAuthorityMatches(registration, baseline, authority, options) {
  if (authority.target !== registration.target) throw fail('TARGET_MISMATCH');
  if (authority.workerName !== registration.workerName) throw fail('WORKER_MISMATCH');
  if (authority.activeVersion !== options.expectedVersion) {
    throw fail(options.versionError ?? 'SERVING_VERSION_MISMATCH');
  }
  if (authority.bindingIdentities.AUTH_DB !== registration.authDatabaseId) throw fail('D1_MISMATCH');
  if (authority.bindingIdentities.TAG_STATE !== registration.bindingIdentities.TAG_STATE) {
    throw fail('WORKER_METADATA_MISMATCH');
  }
  if (authority.slack.teamId !== registration.workspaceId) throw fail('SLACK_TEAM_MISMATCH');
  if (authority.slack.appId !== registration.slackAppId) throw fail('SLACK_APP_MISMATCH');
  if (authority.slack.botUserId !== registration.botUserId) throw fail('SLACK_BOT_MISMATCH');
  if (authority.slack.replySenderId !== registration.botUserId) throw fail('SLACK_REPLY_SENDER_MISMATCH');
  if (authority.transport !== registration.transport) throw fail('TRANSPORT_MISMATCH');
  if (stableEnvironmentJson(authority.slack.scopes) !== stableEnvironmentJson(baseline.requiredScopes)) {
    throw fail('SLACK_SCOPE_MISMATCH');
  }
  if (authority.schemaGeneration !== options.expectedSchema) {
    throw fail('INCOMPATIBLE_SCHEMA_GENERATION');
  }
  if (stableEnvironmentJson(authority.credentialFingerprints)
    !== stableEnvironmentJson(baseline.credentialFingerprintsByTarget[registration.target])) {
    throw fail('CREDENTIAL_FINGERPRINT_MISMATCH');
  }
  if (stableEnvironmentJson(authority.fleetCredentialFingerprints)
    !== stableEnvironmentJson(baseline.credentialFingerprintsByTarget)) {
    throw fail('CREDENTIAL_FLEET_FINGERPRINT_MISMATCH');
  }
}

function readSchemaIntent(intentPath) {
  const input = readOwnerOnlyJson(intentPath, 'INCOMPATIBLE_SCHEMA_GENERATION');
  const fields = [
    'schemaVersion', 'target', 'claimNonce', 'registryRevision',
    'fromGeneration', 'toGeneration', 'successorOf', 'historyDigest', 'createdAt',
  ];
  if (!isRecord(input) || !exactKeys(input, fields)
    || input.schemaVersion !== 'chickpea-environment-schema-advancement-intent/v1'
    || !activeEnvironmentTargets.includes(input.target)
    || !/^[0-9a-f-]{36}$/u.test(input.claimNonce)
    || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1
    || !validSchemaGeneration(input.fromGeneration)
    || !validSchemaGeneration(input.toGeneration)
    || input.successorOf !== input.fromGeneration
    || !DIGEST.test(input.historyDigest)
    || input.fromGeneration === input.toGeneration
    || canonicalTimestamp(input.createdAt) !== input.createdAt) {
    throw fail('INVALID_SCHEMA_ADVANCEMENT');
  }
  return input;
}

function unlinkSchemaIntentIfUnchanged(intentPath, expected) {
  const before = lstatSync(intentPath);
  if (before.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  assertOwnerOnly(before);
  const current = readSchemaIntent(intentPath);
  const after = lstatSync(intentPath);
  if (before.dev !== after.dev || before.ino !== after.ino
    || stableEnvironmentJson(current) !== stableEnvironmentJson(expected)) {
    throw fail('SCHEMA_ADVANCEMENT_INTENT_CHANGED');
  }
  unlinkSync(intentPath);
}

function validTransportAuthority(transport, input, activeVersion) {
  if (!isRecord(input)) return false;
  if (transport === 'gateway') {
    return exactKeys(input, ['healthy', 'phase', 'detail', 'generation', 'versionId'])
      && input.healthy === true && bounded(input.phase)
      && (input.detail === null || bounded(input.detail))
      && (input.generation === null || Number.isSafeInteger(input.generation))
      && input.versionId === activeVersion;
  }
  return exactKeys(input, [
    'installationHealthy', 'signedEventReceiptFresh', 'signedEventReceiptVersionId',
    'signedEventReceiptAt', 'installationRevision', 'eventsVerified',
  ]) && input.installationHealthy === true
    && input.signedEventReceiptFresh === true
    && input.eventsVerified === true
    && input.signedEventReceiptVersionId === activeVersion
    && canonicalTimestamp(input.signedEventReceiptAt) === input.signedEventReceiptAt
    && Number.isSafeInteger(input.installationRevision) && input.installationRevision >= 0;
}

function assertTargetTuple(registration, tuple) {
  if (!isRecord(tuple)
    || tuple.target !== registration.target
    || tuple.workerName !== registration.workerName
    || tuple.authDatabaseBinding !== registration.authDatabaseBinding
    || tuple.authDatabaseName !== registration.authDatabaseName
    || tuple.authDatabaseId !== registration.authDatabaseId) {
    throw fail('TARGET_TUPLE_MISMATCH');
  }
}

function validateDeployReceipt(input) {
  const fields = [
    'schemaVersion', 'target', 'sourceRevision', 'sourceDirty', 'claimNonce',
    'registryRevision', 'schemaGeneration', 'workerName', 'authDatabaseBinding',
    'authDatabaseId', 'slackTeamId', 'slackAppId', 'slackBotUserId', 'transport',
    'activeVersion', 'manifestDigest', 'setupContractDigest', 'baselineDigest', 'tagStateId',
    'issuedAt', 'receiptDigest',
  ];
  if (!isRecord(input) || !exactKeys(input, fields)
    || input.schemaVersion !== ENVIRONMENT_DEPLOY_RECEIPT_SCHEMA
    || !activeEnvironmentTargets.includes(input.target)
    || !/^[0-9a-f]{7,64}$/u.test(input.sourceRevision)
    || typeof input.sourceDirty !== 'boolean'
    || !/^[0-9a-f-]{36}$/u.test(input.claimNonce)
    || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1
    || !validSchemaGeneration(input.schemaGeneration)
    || !bounded(input.workerName) || input.authDatabaseBinding !== 'AUTH_DB'
    || !bounded(input.authDatabaseId) || !bounded(input.tagStateId) || !bounded(input.slackTeamId)
    || !bounded(input.slackAppId) || !bounded(input.slackBotUserId)
    || !['gateway', 'events'].includes(input.transport)
    || !VERSION.test(input.activeVersion)
    || !DIGEST.test(input.manifestDigest) || !DIGEST.test(input.setupContractDigest)
    || !DIGEST.test(input.baselineDigest)
    || canonicalTimestamp(input.issuedAt) !== input.issuedAt
    || !DIGEST.test(input.receiptDigest)) throw fail('INVALID_DEPLOY_RECEIPT');
  const { receiptDigest, ...unsigned } = input;
  if (digest(unsigned) !== receiptDigest) throw fail('INVALID_DEPLOY_RECEIPT');
  return input;
}

function validFingerprints(input) {
  return isRecord(input)
    && exactKeys(input, CREDENTIAL_CLASSES)
    && Object.values(input).every((value) => typeof value === 'string' && DIGEST.test(value));
}

function validScopes(input) {
  return Array.isArray(input) && input.length > 0 && input.length <= 128
    && input.every((scope) => typeof scope === 'string' && /^[a-z][a-z0-9:._-]{0,127}$/u.test(scope))
    && new Set(input).size === input.length
    && [...input].sort().every((scope, index) => scope === input[index]);
}

function validObservedScopes(input) {
  return Array.isArray(input) && input.length <= 128
    && input.every((scope) => typeof scope === 'string' && /^[a-z][a-z0-9:._-]{0,127}$/u.test(scope))
    && new Set(input).size === input.length
    && [...input].sort().every((scope, index) => scope === input[index]);
}

function validSchemaGeneration(input) {
  return typeof input === 'string'
    && /^d1:[A-Za-z0-9._-]{1,64};do:[A-Za-z0-9._-]{1,64}$/u.test(input);
}

function validSchemaHistory(input) {
  return isRecord(input)
    && exactKeys(input, ['d1', 'durableObject'])
    && [input.d1, input.durableObject].every((history) =>
      Array.isArray(history) && history.length > 0 && history.length <= 256
      && history.every((value) => typeof value === 'string'
        && /^[A-Za-z0-9._-]{1,64}$/u.test(value))
      && new Set(history).size === history.length
    );
}

function schemaParts(generation) {
  const match = /^d1:([A-Za-z0-9._-]{1,64});do:([A-Za-z0-9._-]{1,64})$/u.exec(generation);
  if (!match) throw fail('INVALID_SCHEMA_ADVANCEMENT');
  return { d1: match[1], durableObject: match[2] };
}

function schemaRelation(fromGeneration, toGeneration, history) {
  if (!validSchemaHistory(history)) throw fail('INVALID_LOCAL_CONTRACT');
  const from = schemaParts(fromGeneration);
  const to = schemaParts(toGeneration);
  const differences = ['d1', 'durableObject'].map((field) => {
    const fromIndex = history[field].indexOf(from[field]);
    const toIndex = history[field].indexOf(to[field]);
    if (fromIndex < 0 || toIndex < 0) throw fail('SCHEMA_ROLLBACK_REFUSED');
    return Math.sign(toIndex - fromIndex);
  });
  if (differences.includes(-1)) return -1;
  return differences.includes(1) ? 1 : 0;
}

function isRecordedSchemaSuccessor(fromGeneration, toGeneration, history) {
  const from = schemaParts(fromGeneration);
  const to = schemaParts(toGeneration);
  let advanced = false;
  for (const field of ['d1', 'durableObject']) {
    const delta = history[field].indexOf(to[field]) - history[field].indexOf(from[field]);
    if (delta < 0 || delta > 1) return false;
    if (delta === 1) advanced = true;
  }
  return advanced;
}

function readOwnerOnlyJson(filePath, missingCode) {
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw fail('UNSAFE_AUTHORITY_FILE');
    assertOwnerOnly(stat);
    return JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error instanceof EnvironmentPreflightError) throw error;
    if (isNodeError(error, 'ENOENT')) throw fail(missingCode);
    if (isNodeError(error, 'ELOOP')) throw fail('SYMLINK_REFUSED');
    throw fail('UNSAFE_AUTHORITY_FILE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicOwnerOnlyJson(filePath, value) {
  const parent = dirname(filePath);
  assertSafeEvidenceRoot(parent);
  const existing = lstatIfPresent(filePath);
  if (existing?.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  if (existing) assertOwnerOnly(existing);
  const temporary = join(parent, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
    const directory = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error; }
  }
}

function exclusiveOwnerOnlyJson(filePath, value) {
  const parent = dirname(filePath);
  assertSafeEvidenceRoot(parent);
  if (lstatIfPresent(filePath)) throw fail('AUTHORITY_FILE_EXISTS');
  const temporary = join(parent, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, filePath);
    unlinkSync(temporary);
    const directory = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error; }
  }
}

function writeV0Journal(journalPath, runId, intentId = undefined) {
  const runsDirectory = dirname(journalPath);
  if (!existsSync(runsDirectory)) mkdirSync(runsDirectory, { recursive: true, mode: 0o700 });
  assertSafeEvidenceRoot(runsDirectory);
  const records = [{
    record: 'header', schemaVersion: 'chickpea-live-journal/v1', seq: 0, runId,
  }];
  if (intentId) records.push({
    record: 'event', seq: 1, runId, event: { type: 'intent', intentId },
  });
  const temporary = join(runsDirectory,
    `.${path.basename(journalPath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600);
    writeSync(descriptor, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, journalPath);
    unlinkSync(temporary);
    const directory = openSync(runsDirectory, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error; }
  }
}

function appendV0JournalEvent(journalPath, runId, seq, event) {
  let descriptor;
  try {
    descriptor = openSync(journalPath,
      constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw fail('INVALID_MUTATION_JOURNAL');
    assertOwnerOnly(stat);
    writeSync(descriptor, `${JSON.stringify({ record: 'event', seq, runId, event })}\n`);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function unlinkOwnedAuthorityFile(filePath, expectedDigest) {
  const before = lstatSync(filePath);
  if (before.isSymbolicLink()) throw fail('SYMLINK_REFUSED');
  assertOwnerOnly(before);
  const current = readDeployIntent(filePath);
  const after = lstatSync(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino
    || current.intentDigest !== expectedDigest) throw fail('MUTATION_LEASE_CHANGED');
  unlinkSync(filePath);
}

function assertOwnerOnly(stat) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw fail('NON_OWNER_FILE');
  if ((stat.mode & 0o777) !== 0o600) throw fail('UNSAFE_PERMISSIONS');
}

function canonicalTimestamp(input) {
  const value = typeof input === 'number' ? new Date(input).toISOString() : input;
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))) {
    throw fail('INVALID_TIMESTAMP');
  }
  if (new Date(value).toISOString() !== value) throw fail('INVALID_TIMESTAMP');
  return value;
}

function digest(input) {
  return `sha256:${createHash('sha256').update(stableEnvironmentJson(input)).digest('hex')}`;
}

function bounded(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function exactKeys(input, expected) {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((value, index) => value === wanted[index]);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lstatIfPresent(filePath) {
  try { return lstatSync(filePath); } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function isNodeError(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

function fail(code, details) {
  return new EnvironmentPreflightError(code, details);
}
