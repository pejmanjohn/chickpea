import {
  ASSERTION_TOKENS,
  type AssertionToken,
  type LiveManifest,
  type ObserverId,
} from '../schema.ts';

export type CapabilityStatus = 'present' | 'blocked';
export type MinimumObserverAuthority =
  | 'admin_read'
  | 'cloudflare_deployments_read'
  | 'provider_account_read'
  | 'slack_app_home_read'
  | 'slack_history_read'
  | 'none';

export interface ObserverCapability {
  observerId: ObserverId;
  status: CapabilityStatus;
  source: 'chickpea_admin' | 'cloudflare_control_plane' | 'provider_api' | 'slack_api' | 'none';
  minimumAuthority: MinimumObserverAuthority;
  allowedTokens: readonly AssertionToken[];
  reason?: 'non_authoritative_context_only';
}

export const CAPABILITY_INVENTORY: Readonly<Record<ObserverId, ObserverCapability>> = Object.freeze({
  'agent.read': capability('agent.read', 'chickpea_admin', 'admin_read', [
    'agent.exists', 'agent.instructions_equal', 'forbidden.no_early_mutation',
  ]),
  'connection.read': capability('connection.read', 'chickpea_admin', 'admin_read', [
    'connection.owner_personal', 'connection.owner_team', 'connection.editor_attributed',
    'forbidden.no_cross_agent_reuse', 'forbidden.no_duplicate',
  ]),
  'routine.read': capability('routine.read', 'chickpea_admin', 'admin_read', [
    'routine.exists', 'routine.paused', 'routine.active', 'routine.run_once',
    'forbidden.no_duplicate',
  ]),
  'slack.messages.read': capability('slack.messages.read', 'slack_api', 'slack_history_read', [
    'slack.message_matches', 'routine.due_delivery', 'forbidden.no_duplicate',
  ]),
  'app_home.read': capability('app_home.read', 'slack_api', 'slack_app_home_read', [
    'slack.message_matches', 'forbidden.no_duplicate',
  ]),
  'provider.read': capability('provider.read', 'provider_api', 'provider_account_read', [
    'forbidden.no_duplicate', 'forbidden.no_cross_agent_reuse',
  ]),
  'cloudflare.version.read': capability(
    'cloudflare.version.read',
    'cloudflare_control_plane',
    'cloudflare_deployments_read',
    [],
  ),
  'browser.screenshot': {
    observerId: 'browser.screenshot',
    status: 'blocked',
    source: 'none',
    minimumAuthority: 'none',
    allowedTokens: [],
    reason: 'non_authoritative_context_only',
  },
});

/** LC-02 remains deliberately blocked until an authoritative source projection exists. */
export const LC02_AVATAR_SOURCE_CAPABILITY = Object.freeze({
  contractId: 'LC-02' as const,
  fact: 'avatar_source_identity' as const,
  status: 'blocked' as const,
  reason: 'authoritative_projection_missing' as const,
});

export interface CapabilityResolution {
  variantId: string;
  token: AssertionToken;
  observerId: ObserverId;
  status: CapabilityStatus;
  reason?: 'capability_blocked' | 'token_not_supported';
}

export function inventoryManifestCapabilities(manifest: LiveManifest): {
  resolved: CapabilityResolution[];
  blocked: CapabilityResolution[];
} {
  const entries = manifest.contracts.flatMap((contract) => contract.variants.flatMap((variant) =>
    [...variant.expected, ...variant.forbidden].map((assertion): CapabilityResolution => {
      const capability = CAPABILITY_INVENTORY[assertion.observerId];
      if (capability.status === 'blocked') {
        return { ...assertion, variantId: variant.id, status: 'blocked', reason: 'capability_blocked' };
      }
      if (!capability.allowedTokens.includes(assertion.token)) {
        return { ...assertion, variantId: variant.id, status: 'blocked', reason: 'token_not_supported' };
      }
      return { ...assertion, variantId: variant.id, status: 'present' };
    })
  ));
  return {
    resolved: entries.filter((entry) => entry.status === 'present'),
    blocked: entries.filter((entry) => entry.status === 'blocked'),
  };
}

export type ObservationStatus = 'observed' | 'blocked' | 'rate_limited' | 'unavailable';
export type ObserverMetadataKey =
  | 'attempts'
  | 'count'
  | 'deadlineMs'
  | 'generation'
  | 'identityMatch'
  | 'phase'
  | 'retryAfterSeconds'
  | 'revision'
  | 'state'
  | 'versionId';
export type ObserverMetadata = Partial<Record<ObserverMetadataKey, string | number | boolean | null>>;

export interface ClosedObservation {
  observerId: ObserverId;
  status: ObservationStatus;
  tokens: AssertionToken[];
  metadata: ObserverMetadata;
}

export class ObserverOutputError extends Error {
  constructor() {
    super('INVALID_OBSERVER_OUTPUT');
    this.name = 'ObserverOutputError';
  }
}

export function closedObservation(input: ClosedObservation): ClosedObservation {
  const capability = CAPABILITY_INVENTORY[input.observerId];
  if (capability.status === 'blocked' && input.status === 'observed') throw new ObserverOutputError();
  if (!Array.isArray(input.tokens)
    || input.tokens.some((token) => !(ASSERTION_TOKENS as readonly string[]).includes(token)
      || !capability.allowedTokens.includes(token))
    || new Set(input.tokens).size !== input.tokens.length
    || !validMetadata(input.metadata)) {
    throw new ObserverOutputError();
  }
  return Object.freeze({
    observerId: input.observerId,
    status: input.status,
    tokens: [...input.tokens],
    metadata: Object.freeze({ ...input.metadata }),
  });
}

export function blockedObservation(observerId: ObserverId): ClosedObservation {
  return closedObservation({ observerId, status: 'blocked', tokens: [], metadata: {} });
}

export function observerRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function hasOnlyObserverKeys(input: object, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(input).every((key) => accepted.has(key));
}

export function hasExactObserverKeys(input: object, expected: readonly string[]): boolean {
  const keys = Object.keys(input).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

export function boundedObserverString(input: unknown, maximum = 128): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= maximum;
}

export function nonNegativeObserverInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && Number(input) >= 0;
}

export function validObserverDeadline(input: unknown, maximum: number): input is number {
  return Number.isSafeInteger(input) && Number(input) > 0 && Number(input) <= maximum;
}

function capability(
  observerId: ObserverId,
  source: ObserverCapability['source'],
  minimumAuthority: MinimumObserverAuthority,
  allowedTokens: readonly AssertionToken[],
): ObserverCapability {
  return { observerId, status: 'present', source, minimumAuthority, allowedTokens };
}

function validMetadata(metadata: ObserverMetadata): boolean {
  if (!isRecord(metadata)) return false;
  const keys: readonly ObserverMetadataKey[] = [
    'attempts', 'count', 'deadlineMs', 'generation', 'identityMatch', 'phase',
    'retryAfterSeconds', 'revision', 'state', 'versionId',
  ];
  return Object.entries(metadata).every(([key, value]) => keys.includes(key as ObserverMetadataKey)
    && (value === null
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.length <= 128)));
}

const isRecord = observerRecord;
