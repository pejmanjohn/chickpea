import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  assertLiveEnvironmentClaim, readEnvironmentRegistry, recordEnvironmentInstallation,
  EnvironmentRegistryError,
} from './environment-registry.mjs';
import {
  assertEnvironmentReleaseAllowed, computeEnvironmentBaselineDigest, preflightEnvironmentMutation,
  readEnvironmentResourceCreationReceipt,
} from './environment-preflight.mjs';
import { outsideGit } from './private-evidence.mjs';
import { assertPrivatePath, readPrivateJson } from './upgrade-receipt.mjs';
import { assertNodeInstallationClean, nodeInstallationEnvironment } from './environment-installation-node.mjs';

/** The private evidence is an attended operator receipt, like verify:live:record.
 * It records exact fixture readbacks; live authority is checked independently. */
export async function reserveEnvironmentInstallation(target, specPath, options = {}) {
  const spec = readInstallationEvidence(specPath);
  const runtime = spec.runtime ?? 'cloudflare';
  if (!['cloudflare', 'node'].includes(runtime)) throw new EnvironmentRegistryError('INVALID_INSTALLATION_RUNTIME');
  const context = assertLiveEnvironmentClaim(target, options);
  assertEnvironmentReleaseAllowed(target, options);
  let databaseReceipt;
  if (runtime === 'cloudflare') {
    readInstallationEvidence(spec.databaseCreationReceipt);
    databaseReceipt = readEnvironmentResourceCreationReceipt(spec.databaseCreationReceipt);
    if (databaseReceipt.target !== target || databaseReceipt.provider !== 'cloudflare'
      || databaseReceipt.kind !== 'd1' || databaseReceipt.id !== spec.authDatabaseId
      || databaseReceipt.providerImmutableId !== spec.authDatabaseId
      || databaseReceipt.claimNonce !== context.claim.leaseNonce
      || databaseReceipt.registryRevision > context.registry.revision) {
      throw new EnvironmentRegistryError('INSTALLATION_DATABASE_OWNERSHIP_REQUIRED');
    }
  } else {
    if (['workerName', 'authDatabaseName', 'authDatabaseId', 'databaseCreationReceipt'].some((key) => key in spec)) {
      throw new EnvironmentRegistryError('INVALID_INSTALLATION_RUNTIME');
    }
    outsideGit(spec.stateParent);
    assertPrivatePath(spec.stateParent, { directory: true });
    if (realpathSync(spec.stateParent) !== spec.stateParent) throw new EnvironmentRegistryError('INSTALLATION_STATE_PATH_UNSAFE');
  }
  const preflight = await preflightEnvironmentMutation(target, options);
  const before = readInstallationEvidence(spec.beforeEvidence);
  if (!before.slack || !before.admin || !before.fixtures || before.pendingWork !== false
    || before.independentAppsResolved !== true) throw new EnvironmentRegistryError('INSTALLATION_PREREQUISITES_REQUIRED');
  const installation = {
    runtime,
    runId: spec.runId,
    startedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
    installerPath: realpathSync(spec.installerPath),
    baselineDigest: computeEnvironmentBaselineDigest(preflight.baseline),
    standingVersion: context.registration.servingVersion,
    beforeEvidence: realpathSync(spec.beforeEvidence),
    beforeDigest: evidenceDigest(before),
    ...(runtime === 'cloudflare' ? {
      workerName: spec.workerName, authDatabaseName: spec.authDatabaseName,
      authDatabaseId: spec.authDatabaseId,
      databaseCreationReceipt: realpathSync(spec.databaseCreationReceipt),
      databaseReceiptDigest: databaseReceipt.receiptDigest,
    } : {}),
  };
  if (installation.installerPath === context.worktree.path) throw new EnvironmentRegistryError('ISOLATED_INSTALLER_REQUIRED');
  // Allocate new state ourselves. Accepting an existing directory could silently
  // reuse a standing local installation or another run's databases.
  if (runtime === 'node') installation.statePath = mkdtempSync(path.join(spec.stateParent, 'node-install-'));
  try {
    return recordEnvironmentInstallation(target, installation, context.registry.revision, options);
  } catch (error) {
    // Only remove our still-empty allocation, never recursively delete state.
    if (installation.statePath) {
      try { rmdirSync(installation.statePath); } catch { /* Preserve unexpected state for recovery. */ }
    }
    throw error;
  }
}

export async function restoreEnvironmentInstallation(target, receiptPath, options = {}) {
  const context = assertLiveEnvironmentClaim(target, options);
  const installation = context.registration.installation;
  if (!installation) throw new EnvironmentRegistryError('INSTALLATION_RESERVATION_REQUIRED');
  const before = readInstallationEvidence(installation.beforeEvidence);
  const receipt = readInstallationEvidence(receiptPath);
  const temporary = installation.runtime === 'node'
    ? { runtime: 'node', statePath: installation.statePath, processPresent: false, statePresent: false }
    : { workerName: installation.workerName, authDatabaseId: installation.authDatabaseId,
      workerPresent: false, databasePresent: false };
  if (evidenceDigest(before) !== installation.beforeDigest || receipt.runId !== installation.runId
    || !isDeepStrictEqual(receipt.restored, before)
    || !isDeepStrictEqual(receipt.temporary, temporary)
    || !receipt.slackEvidence || !receipt.adminEvidence || !receipt.cleanupEvidence) {
    throw new EnvironmentRegistryError('INSTALLATION_RESTORATION_UNPROVEN');
  }
  for (const evidence of [receipt.slackEvidence, receipt.adminEvidence, receipt.cleanupEvidence]) readInstallationEvidence(evidence);
  if (installation.runtime === 'node') assertNodeInstallationClean(installation);
  const preflight = await preflightEnvironmentMutation(target, { ...options, restoringInstallation: true });
  if (computeEnvironmentBaselineDigest(preflight.baseline) !== installation.baselineDigest
    || preflight.registration.servingVersion !== installation.standingVersion) {
    throw new EnvironmentRegistryError('INSTALLATION_BASELINE_CHANGED');
  }
  return recordEnvironmentInstallation(target, null, context.registry.revision, options);
}

/** A clean customer installation checkout uses its ordinary guarded deploy,
 * while this fence pins it to the claimed run's temporary resources. */
export function assertInstallationDeployment(target, installerPath, tuple, options = {}) {
  const installation = claimedInstallation(target, options);
  if ((installation.runtime ?? 'cloudflare') !== 'cloudflare') throw new EnvironmentRegistryError('INSTALLATION_RUNTIME_MISMATCH');
  const databaseReceipt = readEnvironmentResourceCreationReceipt(installation.databaseCreationReceipt);
  if (databaseReceipt.receiptDigest !== installation.databaseReceiptDigest) {
    throw new EnvironmentRegistryError('INSTALLATION_DATABASE_OWNERSHIP_REQUIRED');
  }
  if (realpathSync(installerPath) !== installation.installerPath
    || (tuple && (tuple.workerName !== installation.workerName
      || tuple.authDatabaseName !== installation.authDatabaseName
      || tuple.authDatabaseId !== installation.authDatabaseId))) {
    throw new EnvironmentRegistryError('INSTALLATION_TARGET_MISMATCH');
  }
  return installation;
}

export function assertInstallationNodeRuntime(target, options = {}) {
  const installation = assertLiveEnvironmentClaim(target, options).registration.installation;
  if (!installation) throw new EnvironmentRegistryError('INSTALLATION_RESERVATION_REQUIRED');
  if (installation.runtime !== 'node') throw new EnvironmentRegistryError('INSTALLATION_RUNTIME_MISMATCH');
  nodeInstallationEnvironment(installation); // Check canonical private paths on every start/restart.
  return installation;
}

function claimedInstallation(target, options) {
  const registry = readEnvironmentRegistry(options);
  const registration = registry.targets[target];
  if (!registration?.installation || !registration.claim) throw new EnvironmentRegistryError('INSTALLATION_RESERVATION_REQUIRED');
  const context = assertLiveEnvironmentClaim(target, {
    ...options, worktreePath: registration.claim.canonicalWorktreePath,
  });
  return context.registration.installation;
}

function evidenceDigest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function readInstallationEvidence(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new EnvironmentRegistryError('PRIVATE_EVIDENCE_REQUIRED');
  try {
    outsideGit(file);
    return readPrivateJson(file);
  } catch {
    throw new EnvironmentRegistryError('PRIVATE_EVIDENCE_REQUIRED');
  }
}
