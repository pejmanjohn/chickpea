import { LIVE_MANIFEST, LIVE_MANIFEST_DIGEST } from './manifest.ts';
import { validateTargetOverlay } from './privacy.ts';

export interface DoctorLockSnapshot {
  status: 'clear' | 'live' | 'stale';
  ownerRunId?: string;
}

export interface DoctorSnapshot {
  schemaVersion: 'chickpea-live-doctor-snapshot/v1';
  manifestDigest: string;
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
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

export function diagnoseLiveTarget(input: { overlay: unknown; source: DoctorSnapshotSource }): DoctorResult {
  const snapshot = input.source.read();
  validateDoctorSnapshot(snapshot);
  const diagnostics: DoctorDiagnostic[] = [];
  try {
    validateTargetOverlay(LIVE_MANIFEST, input.overlay);
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
  if (snapshot.unavailableObserverIds.length > 0) {
    diagnostics.push({
      code: 'unavailable_observer',
      severity: 'blocked',
      items: [...snapshot.unavailableObserverIds].sort(),
    });
  }
  if (!snapshot.evidenceRootSafe) diagnostics.push({ code: 'unsafe_evidence_root', severity: 'blocked' });
  if (!snapshot.targetMatches) diagnostics.push({ code: 'target_drift', severity: 'blocked' });
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
    'schemaVersion', 'manifestDigest', 'targetFingerprint', 'repositoryRevision', 'servingVersion',
    'missingActorAliases', 'workspaceMatches', 'unavailableObserverIds', 'evidenceRootSafe',
    'targetMatches', 'lock',
  ]);
  if (input.schemaVersion !== 'chickpea-live-doctor-snapshot/v1'
    || !nonEmpty(input.manifestDigest)
    || !nonEmpty(input.targetFingerprint)
    || !nonEmpty(input.repositoryRevision)
    || !nonEmpty(input.servingVersion)
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

function stringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every(nonEmpty);
}

function exactKeys(input: object, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(input).some((key) => !accepted.has(key))) throw new TypeError('INVALID_DOCTOR_SNAPSHOT');
}
