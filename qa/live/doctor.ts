import {
  LIVE_MANIFEST,
  LIVE_MANIFEST_DIGEST,
  resolveTargetSuiteVariants,
  validateTargetSuitePolicy,
  type TargetSuitePolicy,
} from './manifest.ts';
import { OBSERVER_REGISTRY, type ObserverId, type Suite } from './schema.ts';

export interface ComputerUseAvailability {
  bridgeAvailable: boolean;
  windowCaptureAvailable: boolean;
  slackVisible: boolean;
  adminVisible: boolean;
}

export interface DoctorSnapshot {
  schemaVersion: 'chickpea-live-doctor-snapshot/v1';
  manifestDigest: string;
  targetAlias: string;
  transport: 'gateway' | 'events';
  targetOverlayDigest?: string;
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
  computerUseSurfaces: ComputerUseAvailability;
  missingActorAliases: string[];
  workspaceMatches: boolean;
  unavailableObserverIds?: string[];
  evidenceRootSafe: boolean;
  targetMatches: boolean;
  lock: { status: 'clear' | 'live' | 'stale' | 'foreign'; ownerRunId?: string };
}

export interface DoctorSnapshotSource {
  read(): DoctorSnapshot;
}

export type DoctorDiagnosticCode =
  | 'manifest_drift'
  | 'missing_actor'
  | 'wrong_workspace'
  | 'computer_use_unavailable'
  | 'unavailable_observer'
  | 'unsafe_evidence_root'
  | 'target_drift'
  | 'live_lock'
  | 'stale_lock'
  | 'foreign_lock';

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
  variantIds: string[];
  diagnostics: DoctorDiagnostic[];
}

export function diagnoseLiveTarget(input: {
  policy: TargetSuitePolicy;
  suite: Suite;
  selectedVariantIds?: readonly string[];
  source: DoctorSnapshotSource;
}): DoctorResult {
  const policy = validateTargetSuitePolicy(input.policy);
  const variantIds = resolveTargetSuiteVariants(policy, input.suite, input.selectedVariantIds);
  const snapshot = parseDoctorSnapshot(input.source.read());
  const diagnostics: DoctorDiagnostic[] = [];
  if (snapshot.manifestDigest !== LIVE_MANIFEST_DIGEST) {
    diagnostics.push({ code: 'manifest_drift', severity: 'blocked' });
  }
  if (snapshot.missingActorAliases.length > 0) {
    diagnostics.push({
      code: 'missing_actor', severity: 'blocked', items: [...snapshot.missingActorAliases].sort(),
    });
  }
  if (!snapshot.workspaceMatches) {
    diagnostics.push({ code: 'wrong_workspace', severity: 'blocked' });
  }
  const unavailableComputerUse = unavailableComputerUseObservers(
    variantIds,
    snapshot.computerUseSurfaces,
  );
  if (unavailableComputerUse.length > 0) {
    diagnostics.push({
      code: 'computer_use_unavailable', severity: 'blocked', items: unavailableComputerUse,
    });
  }
  const explicitlyUnavailable = [...new Set(snapshot.unavailableObserverIds ?? [])].sort();
  if (explicitlyUnavailable.length > 0) {
    diagnostics.push({
      code: 'unavailable_observer', severity: 'blocked', items: explicitlyUnavailable,
    });
  }
  if (!snapshot.evidenceRootSafe) {
    diagnostics.push({ code: 'unsafe_evidence_root', severity: 'blocked' });
  }
  if (!snapshot.targetMatches || snapshot.targetAlias !== policy.targetAlias) {
    diagnostics.push({ code: 'target_drift', severity: 'blocked' });
  }
  if (snapshot.lock.status === 'live') {
    diagnostics.push({ code: 'live_lock', severity: 'blocked' });
  } else if (snapshot.lock.status === 'stale') {
    diagnostics.push({ code: 'stale_lock', severity: 'blocked' });
  } else if (snapshot.lock.status === 'foreign') {
    diagnostics.push({ code: 'foreign_lock', severity: 'blocked' });
  }
  return {
    kind: 'doctor',
    ready: diagnostics.length === 0,
    manifestDigest: LIVE_MANIFEST_DIGEST,
    targetFingerprint: snapshot.targetFingerprint,
    repositoryRevision: snapshot.repositoryRevision,
    servingVersion: snapshot.servingVersion,
    variantIds,
    diagnostics,
  };
}

export function parseDoctorSnapshot(input: unknown): DoctorSnapshot {
  if (!isRecord(input)
    || !onlyKeys(input, [
      'schemaVersion', 'manifestDigest', 'targetAlias', 'transport', 'targetFingerprint',
      'targetOverlayDigest',
      'repositoryRevision', 'servingVersion', 'computerUseSurfaces', 'missingActorAliases',
      'workspaceMatches', 'unavailableObserverIds', 'evidenceRootSafe', 'targetMatches', 'lock',
    ])
    || input.schemaVersion !== 'chickpea-live-doctor-snapshot/v1'
    || !digest(input.manifestDigest)
    || typeof input.targetAlias !== 'string'
    || (input.transport !== 'gateway' && input.transport !== 'events')
    || (input.targetOverlayDigest !== undefined && !digest(input.targetOverlayDigest))
    || !digest(input.targetFingerprint)
    || typeof input.repositoryRevision !== 'string'
    || !/^[0-9a-f]{7,64}(?:-dirty)?$/u.test(input.repositoryRevision)
    || typeof input.servingVersion !== 'string'
    || !/^(?:version-[A-Za-z0-9._-]{1,96}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(input.servingVersion)
    || !validComputerUse(input.computerUseSurfaces)
    || !stringArray(input.missingActorAliases)
    || (input.unavailableObserverIds !== undefined && !stringArray(input.unavailableObserverIds))
    || typeof input.workspaceMatches !== 'boolean'
    || typeof input.evidenceRootSafe !== 'boolean'
    || typeof input.targetMatches !== 'boolean'
    || !validLock(input.lock)) {
    throw new TypeError('INVALID_DOCTOR_SNAPSHOT');
  }
  return input as unknown as DoctorSnapshot;
}

function unavailableComputerUseObservers(
  variantIds: readonly string[],
  availability: ComputerUseAvailability,
): string[] {
  const selected = new Set(variantIds);
  const productObservers = new Set<ObserverId>();
  for (const contract of LIVE_MANIFEST.contracts) {
    for (const variant of contract.variants) {
      if (!selected.has(variant.id)) continue;
      for (const assertion of [...variant.expected, ...variant.forbidden]) {
        if (OBSERVER_REGISTRY[assertion.observerId].authority === 'product') {
          productObservers.add(assertion.observerId);
        }
      }
    }
  }
  const slackObservers = new Set<ObserverId>([
    'slack.messages.read', 'slack.persona.read', 'app_home.read', 'app_home.publication.read',
  ]);
  return [...productObservers].filter((observerId) => {
    if (!availability.bridgeAvailable || !availability.windowCaptureAvailable) return true;
    return slackObservers.has(observerId)
      ? !availability.slackVisible
      : !availability.adminVisible;
  }).sort();
}

function validComputerUse(input: unknown): input is ComputerUseAvailability {
  return isRecord(input)
    && exactKeys(input, [
      'bridgeAvailable', 'windowCaptureAvailable', 'slackVisible', 'adminVisible',
    ])
    && Object.values(input).every((value) => typeof value === 'boolean');
}

function validLock(input: unknown): boolean {
  return isRecord(input)
    && onlyKeys(input, ['status', 'ownerRunId'])
    && ['clear', 'live', 'stale', 'foreign'].includes(String(input.status))
    && (input.ownerRunId === undefined || (typeof input.ownerRunId === 'string'
      && input.ownerRunId.length > 0));
}

function digest(input: unknown): input is string {
  return typeof input === 'string' && /^sha256:[a-f0-9]{64}$/u.test(input);
}

function stringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((value) => typeof value === 'string'
    && value.length > 0 && value.length <= 512);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function onlyKeys(input: object, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(input).every((key) => accepted.has(key));
}

function exactKeys(input: object, expected: readonly string[]): boolean {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}
