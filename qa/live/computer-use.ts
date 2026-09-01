import { CAPABILITY_INVENTORY } from './observers/capabilities.ts';
import type { LiveManifest, ObserverId } from './schema.ts';

export interface ComputerUseSurfaceSnapshot {
  bridgeAvailable: boolean;
  slackVisible: boolean;
  adminVisible: boolean;
}

export type ComputerUseSurface = 'bridge' | 'slack' | 'admin';

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
    if (!input.surfaces.bridgeAvailable) return true;
    return SLACK_SURFACE_OBSERVERS.has(observerId)
      ? !input.surfaces.slackVisible
      : !input.surfaces.adminVisible;
  }).sort();
}

export function validComputerUseSurfaceSnapshot(input: unknown): input is ComputerUseSurfaceSnapshot {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 3
    && keys[0] === 'adminVisible'
    && keys[1] === 'bridgeAvailable'
    && keys[2] === 'slackVisible'
    && typeof record.bridgeAvailable === 'boolean'
    && typeof record.slackVisible === 'boolean'
    && typeof record.adminVisible === 'boolean';
}
