import { telemetryPseudonym, type TelemetryIdentity } from './identity.ts';

export type ProductTelemetryEventName =
  | 'workspace_connected'
  | 'agent_created'
  | 'connection_ready'
  | 'schedule_created'
  | 'run_completed'
  | 'installation_active';

export type ProductTelemetryCountBucket = '0' | '1' | '2_4' | '5_plus';
export type ProductTelemetryProperty = boolean | number | string;

export interface ProductTelemetryEvent {
  event: ProductTelemetryEventName;
  properties: Record<string, ProductTelemetryProperty>;
}

export type ProductTelemetryEventInput =
  | {
      event: 'workspace_connected';
      workspaceId: string;
      transportMode: 'direct' | 'gateway';
    }
  | {
      event: 'agent_created';
      workspaceId: string;
      agentId: string;
      surface: 'admin' | 'slack' | 'mcp' | 'other';
    }
  | {
      event: 'connection_ready';
      workspaceId: string;
      agentId: string;
      connectionKind: 'managed' | 'mcp' | 'api';
      ownerKind: 'team' | 'member';
      surface: 'admin' | 'slack' | 'mcp' | 'other';
    }
  | {
      event: 'schedule_created';
      workspaceId: string;
      agentId: string;
      cadenceKind: 'one_time' | 'recurring';
      destinationKind: 'channel' | 'direct_thread';
    }
  | {
      event: 'run_completed';
      workspaceId: string;
      agentId: string;
      triggerKind: 'interactive' | 'scheduled';
      outcome: 'succeeded' | 'no_op' | 'failed';
    }
  | {
      event: 'installation_active';
      workspaceCount: number;
      userAgentCount: number;
      readyConnectionCount: number;
      enabledScheduleCount: number;
    };

const TRANSPORT_MODES = new Set(['direct', 'gateway'] as const);
const SURFACES = new Set(['admin', 'slack', 'mcp', 'other'] as const);
const CONNECTION_KINDS = new Set(['managed', 'mcp', 'api'] as const);
const OWNER_KINDS = new Set(['team', 'member'] as const);
const CADENCE_KINDS = new Set(['one_time', 'recurring'] as const);
const DESTINATION_KINDS = new Set(['channel', 'direct_thread'] as const);
const TRIGGER_KINDS = new Set(['interactive', 'scheduled'] as const);
const RUN_OUTCOMES = new Set(['succeeded', 'no_op', 'failed'] as const);

/**
 * Rebuild a product event from its event-specific allowlist. Callers are
 * intentionally treated as untrusted at runtime: unknown events, fields, and
 * arbitrary enum values never cross this boundary.
 */
export async function buildProductTelemetryEvent(
  value: ProductTelemetryEventInput,
  identity: TelemetryIdentity,
): Promise<ProductTelemetryEvent | undefined> {
  const input = value as unknown as Record<string, unknown>;
  switch (input.event) {
    case 'workspace_connected': {
      const workspaceKey = await workspacePseudonym(input.workspaceId, identity);
      if (!workspaceKey) return undefined;
      return {
        event: 'workspace_connected',
        properties: {
          workspace_key: workspaceKey,
          transport_mode: enumValue(input.transportMode, TRANSPORT_MODES, 'direct'),
        },
      };
    }
    case 'agent_created': {
      const keys = await entityPseudonyms(input.workspaceId, input.agentId, identity);
      if (!keys) return undefined;
      return {
        event: 'agent_created',
        properties: {
          workspace_key: keys.workspaceKey,
          agent_key: keys.agentKey,
          surface: enumValue(input.surface, SURFACES, 'other'),
        },
      };
    }
    case 'connection_ready': {
      const keys = await entityPseudonyms(input.workspaceId, input.agentId, identity);
      if (!keys) return undefined;
      return {
        event: 'connection_ready',
        properties: {
          workspace_key: keys.workspaceKey,
          agent_key: keys.agentKey,
          connection_kind: enumValue(input.connectionKind, CONNECTION_KINDS, 'api'),
          owner_kind: enumValue(input.ownerKind, OWNER_KINDS, 'team'),
          surface: enumValue(input.surface, SURFACES, 'other'),
        },
      };
    }
    case 'schedule_created': {
      const keys = await entityPseudonyms(input.workspaceId, input.agentId, identity);
      if (!keys) return undefined;
      return {
        event: 'schedule_created',
        properties: {
          workspace_key: keys.workspaceKey,
          agent_key: keys.agentKey,
          cadence_kind: enumValue(input.cadenceKind, CADENCE_KINDS, 'one_time'),
          destination_kind: enumValue(
            input.destinationKind,
            DESTINATION_KINDS,
            'channel',
          ),
        },
      };
    }
    case 'run_completed': {
      const keys = await entityPseudonyms(input.workspaceId, input.agentId, identity);
      if (!keys) return undefined;
      return {
        event: 'run_completed',
        properties: {
          workspace_key: keys.workspaceKey,
          agent_key: keys.agentKey,
          agent_origin: input.agentId === 'agent_default' ? 'seeded' : 'user_created',
          trigger_kind: enumValue(input.triggerKind, TRIGGER_KINDS, 'interactive'),
          outcome: enumValue(input.outcome, RUN_OUTCOMES, 'failed'),
        },
      };
    }
    case 'installation_active':
      return {
        event: 'installation_active',
        properties: {
          workspace_count: bucketTelemetryCount(input.workspaceCount),
          user_agent_count: bucketTelemetryCount(input.userAgentCount),
          ready_connection_count: bucketTelemetryCount(input.readyConnectionCount),
          enabled_schedule_count: bucketTelemetryCount(input.enabledScheduleCount),
        },
      };
    default:
      return undefined;
  }
}

export function bucketTelemetryCount(value: unknown): ProductTelemetryCountBucket {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
  const count = Math.floor(value);
  if (count === 1) return '1';
  if (count <= 4) return '2_4';
  return '5_plus';
}

async function workspacePseudonym(
  workspaceId: unknown,
  identity: TelemetryIdentity,
): Promise<string | undefined> {
  if (!validLocalId(workspaceId)) return undefined;
  return telemetryPseudonym(identity, 'workspace', workspaceId);
}

async function entityPseudonyms(
  workspaceId: unknown,
  agentId: unknown,
  identity: TelemetryIdentity,
): Promise<{ workspaceKey: string; agentKey: string } | undefined> {
  if (!validLocalId(workspaceId) || !validLocalId(agentId)) return undefined;
  const [workspaceKey, agentKey] = await Promise.all([
    telemetryPseudonym(identity, 'workspace', workspaceId),
    telemetryPseudonym(identity, 'agent', agentId),
  ]);
  return { workspaceKey, agentKey };
}

function validLocalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  fallback: T,
): T {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : fallback;
}

