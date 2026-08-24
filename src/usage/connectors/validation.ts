import { UsageStateError } from '../store-error.ts';
import { hasCredentialLikeContent } from '../../security/content-validation.ts';
import {
  CONNECTOR_RETRY_CLASSIFICATIONS,
  CONNECTOR_USAGE_OUTCOMES,
  type ConnectorUsageSummaryQuery,
  type RecordConnectorUsageInput,
  type ReserveConnectorQuotaInput,
} from './types.ts';

const EFFECT_CLASSES = new Set([
  'read', 'reversible_write', 'external_publish', 'spend_or_budget',
  'destructive', 'administrative',
]);

export function normalizeConnectorUsage(
  input: RecordConnectorUsageInput,
): RecordConnectorUsageInput {
  const startedAt = timestamp(input.startedAt, 'start time');
  const finishedAt = timestamp(input.finishedAt, 'finish time');
  if (finishedAt < startedAt) invalid('Connector finish time precedes its start.');
  if (input.latencyMs !== finishedAt - startedAt) {
    invalid('Connector latency does not match its timestamps.');
  }
  if (!CONNECTOR_USAGE_OUTCOMES.includes(input.outcome)) invalid('Connector outcome is invalid.');
  if (!CONNECTOR_RETRY_CLASSIFICATIONS.includes(input.retryClassification)) {
    invalid('Connector retry classification is invalid.');
  }
  if (!EFFECT_CLASSES.has(input.effectClass)) invalid('Connector effect class is invalid.');
  return {
    ...input,
    attemptId: opaque(input.attemptId, 'attempt ID'),
    workspaceId: opaque(input.workspaceId, 'workspace ID'),
    agentId: opaque(input.agentId, 'Agent ID'),
    connectionAccountId: opaque(input.connectionAccountId, 'connection account ID'),
    operationId: optionalOpaque(input.operationId, 'operation ID'),
    runId: optionalOpaque(input.runId, 'Run ID'),
    runExecutionId: optionalOpaque(input.runExecutionId, 'Run execution ID'),
    adapterId: slug(input.adapterId, 'adapter'),
    toolkit: slug(input.toolkit, 'toolkit'),
    capability: dotted(input.capability, 'capability'),
    providerTool: optionalProviderValue(input.providerTool, 'provider tool'),
    providerVersion: optionalVersion(input.providerVersion),
    startedAt,
    finishedAt,
    latencyMs: boundedInteger(input.latencyMs, 0, 3_600_000, 'latency'),
    remoteCallCount: boundedInteger(input.remoteCallCount, 0, 100, 'remote call count'),
    providerToolCallCount: boundedInteger(
      input.providerToolCallCount, 0, 100, 'provider tool call count',
    ),
    resultBytes: input.resultBytes === null
      ? null
      : boundedInteger(input.resultBytes, 0, 1_000_000_000, 'result size'),
    httpStatus: input.httpStatus === null
      ? null
      : boundedInteger(input.httpStatus, 100, 599, 'HTTP status'),
    rateLimitRemaining: input.rateLimitRemaining === null
      ? null
      : boundedInteger(input.rateLimitRemaining, 0, 10_000_000, 'rate limit'),
    retryAfterMs: input.retryAfterMs === null
      ? null
      : boundedInteger(input.retryAfterMs, 0, 86_400_000, 'retry delay'),
    providerLogId: optionalProviderValue(input.providerLogId, 'provider log ID'),
    priceVersionId: optionalProviderValue(input.priceVersionId, 'price version ID'),
    estimatedCostMicros: input.estimatedCostMicros === null
      ? null
      : boundedInteger(input.estimatedCostMicros, 0, 1_000_000_000, 'estimated cost'),
    estimateCurrency: input.estimateCurrency === null || input.estimateCurrency === 'USD'
      ? input.estimateCurrency
      : invalid('Connector estimate currency is invalid.'),
  };
}

export function normalizeConnectorQuotaReservation(
  input: ReserveConnectorQuotaInput,
): ReserveConnectorQuotaInput {
  const periodStart = timestamp(input.periodStart, 'quota period start');
  const periodEnd = timestamp(input.periodEnd, 'quota period end');
  if (periodEnd <= periodStart || periodEnd - periodStart > 26 * 60 * 60 * 1_000) {
    invalid('Connector quota period is invalid.');
  }
  return {
    reservationId: opaque(input.reservationId, 'quota reservation ID'),
    workspaceId: opaque(input.workspaceId, 'workspace ID'),
    adapterId: slug(input.adapterId, 'adapter'),
    toolkit: slug(input.toolkit, 'toolkit'),
    bucket: slug(input.bucket, 'quota bucket'),
    units: boundedInteger(input.units, 1, 1_000_000, 'quota units'),
    limit: boundedInteger(input.limit, 1, 1_000_000_000, 'quota limit'),
    periodStart,
    periodEnd,
  };
}

export function normalizeConnectorSummaryQuery(
  input: ConnectorUsageSummaryQuery,
): Required<Pick<ConnectorUsageSummaryQuery, 'from' | 'to'>> &
  Pick<ConnectorUsageSummaryQuery, 'workspaceId' | 'agentId' | 'toolkit'> {
  const from = timestamp(input.from, 'from');
  const to = timestamp(input.to, 'to');
  if (to <= from || to - from > 366 * 24 * 60 * 60 * 1_000) {
    invalid('Connector summary range is invalid.');
  }
  return {
    from,
    to,
    ...(input.workspaceId ? { workspaceId: opaque(input.workspaceId, 'workspace ID') } : {}),
    ...(input.agentId ? { agentId: opaque(input.agentId, 'Agent ID') } : {}),
    ...(input.toolkit ? { toolkit: slug(input.toolkit, 'toolkit') } : {}),
  };
}

function opaque(value: string, label: string): string {
  const normalized = value?.trim();
  if (hasCredentialLikeContent(normalized) ||
      !/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/.test(normalized)) {
    invalid(`Connector ${label} is invalid.`);
  }
  return normalized;
}

function optionalOpaque(value: string | null | undefined, label: string): string | null {
  return value == null ? null : opaque(value, label);
}

function slug(value: string, label: string): string {
  const normalized = value?.trim().toLowerCase();
  if (hasCredentialLikeContent(normalized) ||
      !/^[a-z][a-z0-9_-]{0,127}$/.test(normalized)) invalid(`Connector ${label} is invalid.`);
  return normalized;
}

function dotted(value: string, label: string): string {
  const normalized = value?.trim().toLowerCase();
  if (hasCredentialLikeContent(normalized) ||
      !/^[a-z][a-z0-9_.-]{0,191}$/.test(normalized)) invalid(`Connector ${label} is invalid.`);
  return normalized;
}

function optionalProviderValue(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (hasCredentialLikeContent(value) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) {
    invalid(`Connector ${label} is invalid.`);
  }
  return value;
}

function optionalVersion(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{8}_\d{2}$/.test(value)) invalid('Connector provider version is invalid.');
  return value;
}

function timestamp(value: number, label: string): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`Connector ${label} is invalid.`);
  }
  return value;
}

function invalid(message: string): never {
  throw new UsageStateError('usage_invalid_input', message);
}
