import type { SemanticTargetFamily, TypedActivityStatus } from './semantic.ts';

export const SEMANTIC_ACTIVITY_TELEMETRY_SCHEMA_VERSION = 1;

export type SemanticActivityTelemetryPhase =
  | 'thinking'
  | 'working'
  | 'reviewing'
  | 'drafting'
  | 'reassessing';

export type SemanticActivityTelemetrySurface = 'assistant_status' | 'legacy_message';

export type SemanticActivityQueueDisposition =
  | 'enqueued'
  | 'coalesced'
  | 'duplicate'
  | 'superseded'
  | 'stale_dropped'
  | 'terminal_dropped'
  | 'throttled'
  | 'relay_failed';

export type SemanticActivityTransportOutcome =
  | 'acknowledged'
  | 'rejected'
  | 'ambiguous'
  | 'latched_off';

export type SemanticActivityClearOutcome =
  | 'acknowledged'
  | 'rejected'
  | 'ambiguous'
  | 'skipped';

export type SemanticActivityRefreshOutcome =
  | 'scheduled'
  | 'attempted'
  | 'canceled'
  | 'stale_dropped';

export type SemanticActivityRateOutcome =
  | 'reserved'
  | 'cooldown'
  | 'exhausted'
  | 'unavailable';

export interface SemanticActivityTelemetrySink {
  info(message: string): void;
}

export type SemanticActivityTelemetryEvent =
  | {
      event: 'activity.produced';
      family: SemanticTargetFamily;
      phase: SemanticActivityTelemetryPhase;
      observed: boolean;
    }
  | {
      event: 'activity.queue';
      layer: 'relay' | 'presentation';
      disposition: SemanticActivityQueueDisposition;
      observed: boolean;
      durationMs?: number;
    }
  | {
      event: 'activity.transport';
      surface: SemanticActivityTelemetrySurface;
      outcome: SemanticActivityTransportOutcome;
      durationMs?: number;
    }
  | {
      event: 'activity.clear';
      surface: SemanticActivityTelemetrySurface;
      outcome: SemanticActivityClearOutcome;
      late?: boolean;
      durationMs?: number;
    }
  | {
      event: 'activity.refresh';
      outcome: SemanticActivityRefreshOutcome;
      durationMs?: number;
    }
  | {
      event: 'activity.rate';
      outcome: SemanticActivityRateOutcome;
      durationMs?: number;
    };

const TARGET_FAMILIES = new Set<SemanticTargetFamily>([
  'managed_connector',
  'custom_connection',
  'skill',
  'repository',
  'memory',
  'scheduled_work',
  'workspace',
  'connection_setup',
  'agent_authoring',
  'artifact',
  'response',
  'unknown',
  'internal',
]);

const PHASES = new Set<SemanticActivityTelemetryPhase>([
  'thinking', 'working', 'reviewing', 'drafting', 'reassessing',
]);
const QUEUE_DISPOSITIONS = new Set<SemanticActivityQueueDisposition>([
  'enqueued', 'coalesced', 'duplicate', 'superseded', 'stale_dropped',
  'terminal_dropped', 'throttled', 'relay_failed',
]);
const TRANSPORT_OUTCOMES = new Set<SemanticActivityTransportOutcome>([
  'acknowledged', 'rejected', 'ambiguous', 'latched_off',
]);
const CLEAR_OUTCOMES = new Set<SemanticActivityClearOutcome>([
  'acknowledged', 'rejected', 'ambiguous', 'skipped',
]);
const REFRESH_OUTCOMES = new Set<SemanticActivityRefreshOutcome>([
  'scheduled', 'attempted', 'canceled', 'stale_dropped',
]);
const RATE_OUTCOMES = new Set<SemanticActivityRateOutcome>([
  'reserved', 'cooldown', 'exhausted', 'unavailable',
]);

const MAX_DURATION_MS = 300_000;

/**
 * Emit one content-free semantic-activity record. The event-specific copy
 * below is an intentional allowlist: unknown keys and arbitrary strings can
 * never enter the serialized payload, even if a caller defeats TypeScript.
 */
export function emitSemanticActivityTelemetry(
  value: SemanticActivityTelemetryEvent,
  sink: SemanticActivityTelemetrySink = console,
): void {
  const input = value as unknown as Record<string, unknown>;
  const event = typeof input.event === 'string' ? input.event : 'activity.unknown';
  let payload: Record<string, boolean | number | string>;

  switch (event) {
    case 'activity.produced':
      payload = {
        schemaVersion: SEMANTIC_ACTIVITY_TELEMETRY_SCHEMA_VERSION,
        event,
        family: enumValue(input.family, TARGET_FAMILIES, 'unknown'),
        phase: enumValue(input.phase, PHASES, 'working'),
        observed: input.observed === true,
      };
      break;
    case 'activity.queue':
      payload = {
        schemaVersion: SEMANTIC_ACTIVITY_TELEMETRY_SCHEMA_VERSION,
        event,
        layer: input.layer === 'relay' ? 'relay' : 'presentation',
        disposition: enumValue(input.disposition, QUEUE_DISPOSITIONS, 'stale_dropped'),
        observed: input.observed === true,
        ...boundedDuration(input.durationMs),
      };
      break;
    case 'activity.transport':
      payload = {
        schemaVersion: SEMANTIC_ACTIVITY_TELEMETRY_SCHEMA_VERSION,
        event,
        surface: telemetrySurface(input.surface),
        outcome: enumValue(input.outcome, TRANSPORT_OUTCOMES, 'rejected'),
        ...boundedDuration(input.durationMs),
      };
      break;
    case 'activity.clear':
      payload = {
        schemaVersion: SEMANTIC_ACTIVITY_TELEMETRY_SCHEMA_VERSION,
        event,
        surface: telemetrySurface(input.surface),
        outcome: enumValue(input.outcome, CLEAR_OUTCOMES, 'rejected'),
        ...(typeof input.late === 'boolean' ? { late: input.late } : {}),
        ...boundedDuration(input.durationMs),
      };
      break;
    case 'activity.refresh':
      payload = {
        schemaVersion: SEMANTIC_ACTIVITY_TELEMETRY_SCHEMA_VERSION,
        event,
        outcome: enumValue(input.outcome, REFRESH_OUTCOMES, 'stale_dropped'),
        ...boundedDuration(input.durationMs),
      };
      break;
    case 'activity.rate':
      payload = {
        schemaVersion: SEMANTIC_ACTIVITY_TELEMETRY_SCHEMA_VERSION,
        event,
        outcome: enumValue(input.outcome, RATE_OUTCOMES, 'unavailable'),
        ...boundedDuration(input.durationMs),
      };
      break;
    default:
      // Callers cannot introduce an open-ended event or field by casting.
      payload = {
        schemaVersion: SEMANTIC_ACTIVITY_TELEMETRY_SCHEMA_VERSION,
        event: 'activity.unknown',
      };
  }

  try {
    sink.info(`[chickpea:activity] ${JSON.stringify(payload)}`);
  } catch {
    // Cosmetic observability never changes the Slack or answer path.
  }
}

/**
 * Reduce canonical status structure to closed telemetry facts. Rendered copy
 * is inspected only to recognize product-owned phrases and is never emitted.
 */
export function semanticTelemetryForStatus(
  status: TypedActivityStatus,
): { family: SemanticTargetFamily; phase: SemanticActivityTelemetryPhase } {
  if (status.action === 'Thinking' && status.object === 'the request') {
    return { family: 'unknown', phase: 'thinking' };
  }
  if (status.action === 'Drafting' && status.object === 'the response') {
    return { family: 'response', phase: 'drafting' };
  }
  if (status.action === 'Reassessing') {
    return { family: 'unknown', phase: 'reassessing' };
  }

  const phase: SemanticActivityTelemetryPhase = status.action === 'Reviewing'
    ? 'reviewing'
    : 'working';
  return { family: statusFamily(status), phase };
}

function statusFamily(status: TypedActivityStatus): SemanticTargetFamily {
  const exact = `${status.action}\u0000${status.object}`;
  switch (exact) {
    case 'Checking\u0000a connected service':
    case 'Updating\u0000a connected service':
      return 'custom_connection';
    case 'Using\u0000a skill':
    case 'Reviewing\u0000skill results':
      return 'skill';
    case 'Inspecting\u0000the repository':
    case 'Running\u0000tests':
    case 'Editing\u0000files':
    case 'Reviewing\u0000repository results':
    case 'Reviewing\u0000test results':
    case 'Reviewing\u0000file changes':
      return 'repository';
    case 'Checking\u0000memory':
    case 'Updating\u0000memory':
    case 'Reviewing\u0000memory':
      return 'memory';
    case 'Checking\u0000scheduled work':
    case 'Updating\u0000scheduled work':
    case 'Reviewing\u0000scheduled work':
      return 'scheduled_work';
    case 'Inspecting\u0000workspace settings':
    case 'Reviewing\u0000workspace settings':
      return 'workspace';
    case 'Setting up\u0000a connection':
    case 'Checking\u0000the connection':
      return 'connection_setup';
    case 'Preparing\u0000Agent changes':
    case 'Applying\u0000Agent changes':
    case 'Inspecting\u0000Agent settings':
    case 'Reviewing\u0000Agent changes':
      return 'agent_authoring';
    case 'Creating\u0000an artifact':
    case 'Reviewing\u0000the artifact':
      return 'artifact';
    case 'Working on\u0000the request':
    case 'Reviewing\u0000the results':
      return 'unknown';
  }

  if (
    status.action === 'Checking' ||
    status.action === 'Sending with' ||
    status.action === 'Updating' ||
    status.action === 'Reviewing'
  ) {
    return 'managed_connector';
  }
  return 'unknown';
}

function telemetrySurface(value: unknown): SemanticActivityTelemetrySurface {
  return value === 'legacy_message' ? 'legacy_message' : 'assistant_status';
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  fallback: T,
): T {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : fallback;
}

function boundedDuration(value: unknown): { durationMs?: number } {
  if (typeof value !== 'number' || !Number.isFinite(value)) return {};
  return { durationMs: Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value))) };
}
