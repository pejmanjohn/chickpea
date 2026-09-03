import { CAPABILITY_INVENTORY } from './observers/capabilities.ts';
import type { LiveManifest, ObserverId } from './schema.ts';

export interface ComputerUseSurfaceSnapshot {
  bridgeAvailable: boolean;
  windowCaptureAvailable: boolean;
  slackVisible: boolean;
  adminVisible: boolean;
}

export interface ComputerUseReadinessBinding {
  targetAlias: string;
  workspaceId: string;
  repositoryRevision: string;
  claimNonce: string;
  requiredActorAliases: readonly string[];
}

/** A private Computer Use reader supplies fresh UI facts, never product verdicts. */
export function validateComputerUseReadiness(input: unknown, expected: ComputerUseReadinessBinding,
  now: number): { computerUseSurfaces: ComputerUseSurfaceSnapshot; missingActorAliases: string[] } {
  const fail = (): never => { throw new TypeError('INVALID_COMPUTER_USE_READINESS'); };
  if (!record(input) || !keys(input, [...Object.keys(expected), 'transport', 'observationScope',
    'verifiedActorAliases', 'computerUseSurfaces', 'captures'])
    || input.transport !== 'computer_use' || input.observationScope !== 'window'
    || input.targetAlias !== expected.targetAlias || input.workspaceId !== expected.workspaceId
    || input.repositoryRevision !== expected.repositoryRevision || input.claimNonce !== expected.claimNonce
    || JSON.stringify(input.requiredActorAliases) !== JSON.stringify(expected.requiredActorAliases)
    || !validComputerUseSurfaceSnapshot(input.computerUseSurfaces)
    || !Array.isArray(input.verifiedActorAliases) || !Array.isArray(input.captures)
    || input.captures.length !== 2) return fail();
  const actors = input.verifiedActorAliases;
  if (new Set(actors).size !== actors.length
    || actors.some((alias) => typeof alias !== 'string' || !expected.requiredActorAliases.includes(alias))) return fail();
  const seen = new Set<string>();
  const digests = new Set<string>();
  for (const capture of input.captures) {
    if (!record(capture) || !keys(capture, ['surface', 'digest', 'observedAt'])
      || (capture.surface !== 'admin' && capture.surface !== 'slack')
      || typeof capture.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(capture.digest)
      || typeof capture.observedAt !== 'string') return fail();
    const timestamp = Date.parse(capture.observedAt);
    if (!Number.isFinite(timestamp) || timestamp > now + 1_000 || now - timestamp > 60_000
      || seen.has(capture.surface) || digests.has(capture.digest)) return fail();
    seen.add(capture.surface); digests.add(capture.digest);
  }
  return {
    computerUseSurfaces: { ...input.computerUseSurfaces },
    missingActorAliases: expected.requiredActorAliases.filter((alias) => !actors.includes(alias)),
  };
}

function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function keys(input: object, expected: readonly string[]): boolean {
  return Object.keys(input).length === expected.length && Object.keys(input).every((key) => expected.includes(key));
}

export type ComputerUseSurface = 'bridge' | 'window_capture' | 'slack' | 'admin';

export interface ComputerUseSurfaceAssessment {
  ready: boolean;
  missing: ComputerUseSurface[];
}

const SLACK_SURFACE_OBSERVERS = new Set<ObserverId>([
  'slack.messages.read',
  'app_home.read',
  'slack.persona.read',
  'app_home.publication.read',
]);

export function assessComputerUseSurfaces(
  snapshot: ComputerUseSurfaceSnapshot,
): ComputerUseSurfaceAssessment {
  const missing: ComputerUseSurface[] = [];
  if (!snapshot.bridgeAvailable) missing.push('bridge');
  if (!snapshot.windowCaptureAvailable) missing.push('window_capture');
  if (!snapshot.slackVisible) missing.push('slack');
  if (!snapshot.adminVisible) missing.push('admin');
  return { ready: missing.length === 0, missing };
}

export function unavailableComputerUseObservers(input: {
  manifest: LiveManifest;
  variantIds: readonly string[];
  surfaces: ComputerUseSurfaceSnapshot;
}): ObserverId[] {
  const selected = new Set(input.variantIds);
  const observers = new Set<ObserverId>();
  for (const contract of input.manifest.contracts) {
    for (const variant of contract.variants) {
      if (!selected.has(variant.id)) continue;
      for (const assertion of [...variant.expected, ...variant.forbidden]) {
        if (CAPABILITY_INVENTORY[assertion.observerId].source === 'computer_use_ui') {
          observers.add(assertion.observerId);
        }
      }
    }
  }
  return [...observers].filter((observerId) => {
    if (!input.surfaces.bridgeAvailable || !input.surfaces.windowCaptureAvailable) return true;
    return SLACK_SURFACE_OBSERVERS.has(observerId)
      ? !input.surfaces.slackVisible
      : !input.surfaces.adminVisible;
  }).sort();
}

export function validComputerUseSurfaceSnapshot(input: unknown): input is ComputerUseSurfaceSnapshot {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 4
    && keys[0] === 'adminVisible'
    && keys[1] === 'bridgeAvailable'
    && keys[2] === 'slackVisible'
    && keys[3] === 'windowCaptureAvailable'
    && typeof record.bridgeAvailable === 'boolean'
    && typeof record.slackVisible === 'boolean'
    && typeof record.windowCaptureAvailable === 'boolean'
    && typeof record.adminVisible === 'boolean';
}
