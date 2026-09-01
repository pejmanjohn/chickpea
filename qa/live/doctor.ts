import {
  unavailableComputerUseObservers,
  validComputerUseSurfaceSnapshot,
  type ComputerUseSurfaceSnapshot,
} from './computer-use.ts';
import { LIVE_MANIFEST, LIVE_MANIFEST_DIGEST } from './manifest.ts';
import { inventoryManifestCapabilities } from './observers/capabilities.ts';
import {
  digestTargetOverlay,
  validateTargetOverlay,
  type LiveTargetOverlay,
} from './privacy.ts';

export interface DoctorLockSnapshot {
  status: 'clear' | 'live' | 'stale';
  ownerRunId?: string;
}

export interface DoctorSnapshot {
  schemaVersion: 'chickpea-live-doctor-snapshot/v1';
  manifestDigest: string;
  targetAlias: string;
  transport: 'gateway' | 'events';
  targetOverlayDigest: string;
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
  computerUseSurfaces: ComputerUseSurfaceSnapshot;
  missingActorAliases: string[];
  workspaceMatches: boolean;
  unavailableObserverIds: string[];
  evidenceRootSafe: boolean;
  targetMatches: boolean;
  lock: DoctorLockSnapshot;
}

export interface DoctorSnapshotSource {
  read(): DoctorSnapshot;
}

export type DoctorDiagnosticCode =
  | 'invalid_target_overlay'
  | 'manifest_drift'
  | 'missing_actor'
  | 'wrong_workspace'
  | 'unavailable_observer'
  | 'unsafe_evidence_root'
  | 'target_drift'
  | 'live_lock'
  | 'stale_lock';

export interface DoctorDiagnostic {
  code: DoctorDiagnosticCode;
  severity: 'blocked';
  items?: string[];
}

export interface DoctorResult {
  kind: 'doctor';
  ready: boolean;
  manifestDigest: string;
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
  diagnostics: DoctorDiagnostic[];
}

export function diagnoseLiveTarget(input: {
  overlay: unknown;
  source: DoctorSnapshotSource;
  variantIds?: readonly string[];
}): DoctorResult {
  const snapshot = input.source.read();
  validateDoctorSnapshot(snapshot);
  const diagnostics: DoctorDiagnostic[] = [];
  let target: LiveTargetOverlay | undefined;
  try {
    target = validateTargetOverlay(LIVE_MANIFEST, input.overlay);
  } catch {
    diagnostics.push({ code: 'invalid_target_overlay', severity: 'blocked' });
  }
  if (snapshot.manifestDigest !== LIVE_MANIFEST_DIGEST) {
    diagnostics.push({ code: 'manifest_drift', severity: 'blocked' });
  }
  if (snapshot.missingActorAliases.length > 0) {
    diagnostics.push({
      code: 'missing_actor',
      severity: 'blocked',
      items: [...snapshot.missingActorAliases].sort(),
    });
  }
  if (!snapshot.workspaceMatches) diagnostics.push({ code: 'wrong_workspace', severity: 'blocked' });
  const selectedVariants = new Set(input.variantIds ?? target?.allowedVariants ?? []);
  const catalogBlockedObserverIds = target === undefined ? [] : inventoryManifestCapabilities(LIVE_MANIFEST).blocked
    .filter(({ variantId }) => selectedVariants.has(variantId))
    .map(({ observerId }) => observerId);
  const surfaceBlockedObserverIds = unavailableComputerUseObservers({
    manifest: LIVE_MANIFEST,
    variantIds: [...selectedVariants],
    surfaces: snapshot.computerUseSurfaces,
  });
  const unavailableObserverIds = [...new Set([
    ...snapshot.unavailableObserverIds,
    ...catalogBlockedObserverIds,
    ...surfaceBlockedObserverIds,
  ])].sort();
  if (unavailableObserverIds.length > 0) {
    diagnostics.push({
      code: 'unavailable_observer',
      severity: 'blocked',
      items: unavailableObserverIds,
    });
  }
  if (!snapshot.evidenceRootSafe) diagnostics.push({ code: 'unsafe_evidence_root', severity: 'blocked' });
  if (!snapshot.targetMatches || (target !== undefined && (
    snapshot.targetAlias !== target.targetAlias
    || snapshot.transport !== target.transport
    || snapshot.targetOverlayDigest !== digestTargetOverlay(target)
  ))) diagnostics.push({ code: 'target_drift', severity: 'blocked' });
  if (snapshot.lock.status === 'live') diagnostics.push({ code: 'live_lock', severity: 'blocked' });
  if (snapshot.lock.status === 'stale') diagnostics.push({ code: 'stale_lock', severity: 'blocked' });

  return {
    kind: 'doctor',
    ready: diagnostics.length === 0,
    manifestDigest: LIVE_MANIFEST_DIGEST,
    targetFingerprint: snapshot.targetFingerprint,
    repositoryRevision: snapshot.repositoryRevision,
    servingVersion: snapshot.servingVersion,
    diagnostics,
  };
}

export function parseDoctorSnapshot(input: unknown): DoctorSnapshot {
  if (!isRecord(input)) throw new TypeError('INVALID_DOCTOR_SNAPSHOT');
  exactKeys(input, [
    'schemaVersion', 'manifestDigest', 'targetAlias', 'transport', 'targetOverlayDigest',
    'targetFingerprint', 'repositoryRevision', 'servingVersion',
    'computerUseSurfaces',
    'missingActorAliases', 'workspaceMatches', 'unavailableObserverIds', 'evidenceRootSafe',
    'targetMatches', 'lock',
  ]);
  if (input.schemaVersion !== 'chickpea-live-doctor-snapshot/v1'
    || !nonEmpty(input.manifestDigest)
    || !alias(input.targetAlias)
    || (input.transport !== 'gateway' && input.transport !== 'events')
    || !digest(input.targetOverlayDigest)
    || !digest(input.targetFingerprint)
    || !validRepositoryRevision(input.repositoryRevision)
    || !validServingVersion(input.servingVersion)
    || !validComputerUseSurfaceSnapshot(input.computerUseSurfaces)
    || !stringArray(input.missingActorAliases)
    || typeof input.workspaceMatches !== 'boolean'
    || !stringArray(input.unavailableObserverIds)
    || typeof input.evidenceRootSafe !== 'boolean'
    || typeof input.targetMatches !== 'boolean'
    || !isRecord(input.lock)
    || !['clear', 'live', 'stale'].includes(String(input.lock.status))
    || (input.lock.ownerRunId !== undefined && !nonEmpty(input.lock.ownerRunId))) {
    throw new TypeError('INVALID_DOCTOR_SNAPSHOT');
  }
  exactKeys(input.lock, ['status', 'ownerRunId']);
  return input as unknown as DoctorSnapshot;
}

function validateDoctorSnapshot(snapshot: DoctorSnapshot): void {
  parseDoctorSnapshot(snapshot);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function nonEmpty(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 512;
}

function validRepositoryRevision(input: unknown): input is string {
  return typeof input === 'string' && /^[0-9a-f]{7,64}(?:-dirty)?$/u.test(input);
}

function alias(input: unknown): input is string {
  return typeof input === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input);
}

function digest(input: unknown): input is string {
  return typeof input === 'string' && /^sha256:[a-z0-9-]{3,128}$/u.test(input);
}

function validServingVersion(input: unknown): input is string {
  return typeof input === 'string' && (/^version-[A-Za-z0-9._-]{1,96}$/u.test(input)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/u.test(input));
}

function stringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every(nonEmpty);
}

function exactKeys(input: object, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(input).some((key) => !accepted.has(key))) throw new TypeError('INVALID_DOCTOR_SNAPSHOT');
}
