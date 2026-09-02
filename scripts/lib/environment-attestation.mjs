import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

import { attestLiveTarget } from '../../qa/live/attestation.ts';
import { diagnoseLiveTarget, parseDoctorSnapshot } from '../../qa/live/doctor.ts';
import { LIVE_MANIFEST_DIGEST } from '../../qa/live/manifest.ts';
import { createDoctorTargetResolution } from '../../qa/live/private-config.ts';
import {
  assertLiveEnvironmentClaim,
  assertSafeEvidenceRoot,
  EnvironmentRegistryError,
  readEnvironmentTargetLockStatus,
  recordEnvironmentAttestation,
  resolveEnvironmentAlias,
} from './environment-registry.mjs';
import { createVerifierTargetInputs } from './environment-target.mjs';

/**
 * Convert one matching live claim into the verifier-owned attestation and
 * doctor contracts. The environment layer supplies observations and aliases;
 * it does not invent a second lock, journal, verdict, or evidence format.
 */
export async function attestEnvironment(target, observation, options = {}) {
  const { registry, registration, claim, worktree } = assertLiveEnvironmentClaim(target, options);
  const claimedSourceIdentity = `${claim.claimedRevision}${worktree.dirty ? '-dirty' : ''}`;
  const registeredSourceIdentity = `${registration.sourceRevision}${registration.sourceDirty ? '-dirty' : ''}`;
  if (claimedSourceIdentity !== registeredSourceIdentity) {
    throw environmentFailure('SOURCE_IDENTITY_MISMATCH');
  }
  const inputs = createVerifierTargetInputs(target, registration, Object.values(registry.targets));
  const resolution = createDoctorTargetResolution(
    inputs.targetOverlay,
    inputs.privateConfig,
    {
      readOnly: async (alias) => resolveEnvironmentAlias(alias, options),
    },
  );
  const liveObservation = options.observeLiveTarget
    ? await options.observeLiveTarget({
      target,
      claim: Object.freeze({ ...claim }),
      registration: Object.freeze({ ...registration }),
      providedObservation: observation,
    })
    : observation;
  const attestation = await attestLiveTarget(resolution, liveObservation);
  if (attestation.servingVersion !== registration.servingVersion) {
    throw environmentFailure('SERVING_VERSION_MISMATCH');
  }
  const evidenceRoot = await resolution.evidenceRoot();
  assertSafeEvidenceRoot(evidenceRoot);
  const evidenceRootSafe = path.isAbsolute(evidenceRoot) && path.resolve(evidenceRoot) === evidenceRoot;
  const lock = readEnvironmentTargetLockStatus(evidenceRoot, {
    host: options.lockHost ?? hostname(),
    ...(options.isPidActive ? { isPidActive: options.isPidActive } : {}),
  });
  const sourceRevision = claimedSourceIdentity;
  const doctorSnapshot = parseDoctorSnapshot({
    schemaVersion: 'chickpea-live-doctor-snapshot/v1',
    manifestDigest: LIVE_MANIFEST_DIGEST,
    targetAlias: target,
    transport: registration.transport,
    targetOverlayDigest: digest(inputs.targetOverlay),
    targetFingerprint: attestation.targetFingerprint,
    repositoryRevision: sourceRevision,
    servingVersion: attestation.servingVersion,
    computerUseSurfaces: registration.computerUseSurfaces,
    missingActorAliases: registration.missingActorAliases,
    workspaceMatches: true,
    evidenceRootSafe,
    targetMatches: true,
    lock: {
      status: lock.status,
      ...(lock.ownerRunId ? { ownerRunId: lock.ownerRunId } : {}),
    },
  });
  const doctor = diagnoseLiveTarget({
    policy: {
      targetAlias: inputs.targetOverlay.targetAlias,
      allowedSuites: inputs.targetOverlay.allowedSuites,
      allowedVariants: inputs.targetOverlay.allowedVariants,
    },
    suite: 'smoke',
    source: { read: () => doctorSnapshot },
  });
  const result = Object.freeze({
    targetOverlay: inputs.targetOverlay,
    privateConfig: inputs.privateConfig,
    attestation,
    doctorSnapshot,
    doctor,
  });
  if (options.beforeAttestationRecord) {
    await options.beforeAttestationRecord({ target, claim: Object.freeze({ ...claim }) });
  }
  recordEnvironmentAttestation(target, result, {
    ...options,
    expectedLeaseNonce: claim.leaseNonce,
  });
  return result;
}

function environmentFailure(code) {
  return new EnvironmentRegistryError(code);
}

function digest(input) {
  return `sha256:${createHash('sha256').update(stableJson(input)).digest('hex')}`;
}

function stableJson(input) {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(',')}]`;
  if (input !== null && typeof input === 'object') {
    return `{${Object.keys(input).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(input[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(input);
}
