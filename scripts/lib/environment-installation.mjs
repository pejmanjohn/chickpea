import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
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
import { readPrivateJson } from './upgrade-receipt.mjs';

/** The private evidence is an attended operator receipt, like verify:live:record.
 * It records exact fixture readbacks; live authority is checked independently. */
export async function reserveEnvironmentInstallation(target, specPath, options = {}) {
  const spec = readInstallationEvidence(specPath);
  const context = assertLiveEnvironmentClaim(target, options);
  assertEnvironmentReleaseAllowed(target, options);
  readInstallationEvidence(spec.databaseCreationReceipt);
  const databaseReceipt = readEnvironmentResourceCreationReceipt(spec.databaseCreationReceipt);
  if (databaseReceipt.target !== target || databaseReceipt.provider !== 'cloudflare'
    || databaseReceipt.kind !== 'd1' || databaseReceipt.id !== spec.authDatabaseId
    || databaseReceipt.providerImmutableId !== spec.authDatabaseId
    || databaseReceipt.claimNonce !== context.claim.leaseNonce
    || databaseReceipt.registryRevision > context.registry.revision) {
    throw new EnvironmentRegistryError('INSTALLATION_DATABASE_OWNERSHIP_REQUIRED');
  }
  const preflight = await preflightEnvironmentMutation(target, options);
  const before = readInstallationEvidence(spec.beforeEvidence);
  if (!before.slack || !before.admin || !before.fixtures || before.pendingWork !== false
    || before.independentAppsResolved !== true) throw new EnvironmentRegistryError('INSTALLATION_PREREQUISITES_REQUIRED');
  const installation = {
    runId: spec.runId,
    startedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
    workerName: spec.workerName, authDatabaseName: spec.authDatabaseName,
    authDatabaseId: spec.authDatabaseId, installerPath: realpathSync(spec.installerPath),
    baselineDigest: computeEnvironmentBaselineDigest(preflight.baseline),
    standingVersion: context.registration.servingVersion,
    beforeEvidence: realpathSync(spec.beforeEvidence),
    beforeDigest: evidenceDigest(before),
    databaseCreationReceipt: realpathSync(spec.databaseCreationReceipt),
    databaseReceiptDigest: databaseReceipt.receiptDigest,
  };
  if (installation.installerPath === context.worktree.path) throw new EnvironmentRegistryError('ISOLATED_INSTALLER_REQUIRED');
  return recordEnvironmentInstallation(target, installation, context.registry.revision, options);
}

export async function restoreEnvironmentInstallation(target, receiptPath, options = {}) {
  const context = assertLiveEnvironmentClaim(target, options);
  const installation = context.registration.installation;
  if (!installation) throw new EnvironmentRegistryError('INSTALLATION_RESERVATION_REQUIRED');
  const before = readInstallationEvidence(installation.beforeEvidence);
  const receipt = readInstallationEvidence(receiptPath);
  if (evidenceDigest(before) !== installation.beforeDigest || receipt.runId !== installation.runId
    || !isDeepStrictEqual(receipt.restored, before)
    || !isDeepStrictEqual(receipt.temporary, {
      workerName: installation.workerName, authDatabaseId: installation.authDatabaseId,
      workerPresent: false, databasePresent: false,
    }) || !receipt.slackEvidence || !receipt.adminEvidence || !receipt.cleanupEvidence) {
    throw new EnvironmentRegistryError('INSTALLATION_RESTORATION_UNPROVEN');
  }
  for (const evidence of [receipt.slackEvidence, receipt.adminEvidence, receipt.cleanupEvidence]) readInstallationEvidence(evidence);
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
  const registry = readEnvironmentRegistry(options);
  const registration = registry.targets[target];
  if (!registration?.installation || !registration.claim) throw new EnvironmentRegistryError('INSTALLATION_RESERVATION_REQUIRED');
  const context = assertLiveEnvironmentClaim(target, {
    ...options, worktreePath: registration.claim.canonicalWorktreePath,
  });
  const installation = context.registration.installation;
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
