import type { ManagedEffectClass } from '../../connections/catalog/index.ts';

export const CONNECTOR_USAGE_OUTCOMES = [
  'success',
  'validation_failed',
  'authorization_expired',
  'throttled',
  'provider_unavailable',
  'ambiguous',
] as const;

export type ConnectorUsageOutcome = (typeof CONNECTOR_USAGE_OUTCOMES)[number];

export const CONNECTOR_RETRY_CLASSIFICATIONS = [
  'none',
  'safe_retry_available',
  'retry_after',
  'verify_before_retry',
  'reconnect_required',
] as const;

export type ConnectorRetryClassification =
  (typeof CONNECTOR_RETRY_CLASSIFICATIONS)[number];

export interface RecordConnectorUsageInput {
  attemptId: string;
  workspaceId: string;
  agentId: string;
  connectionAccountId: string;
  operationId?: string | null;
  runId?: string | null;
  runExecutionId?: string | null;
  adapterId: string;
  toolkit: string;
  capability: string;
  providerTool: string | null;
  providerVersion: string | null;
  effectClass: ManagedEffectClass;
  outcome: ConnectorUsageOutcome;
  retryClassification: ConnectorRetryClassification;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
  remoteCallCount: number;
  providerToolCallCount: number;
  resultBytes: number | null;
  httpStatus: number | null;
  rateLimitRemaining: number | null;
  retryAfterMs: number | null;
  providerLogId: string | null;
  priceVersionId: string | null;
  estimatedCostMicros: number | null;
  estimateCurrency: 'USD' | null;
}

export interface ConnectorUsageRecord extends RecordConnectorUsageInput {
  recordedAt: number;
}

export interface ConnectorUsageSummaryQuery {
  from: number;
  to: number;
  /** Internal shared-surface privacy boundary; never derived from a customer query parameter. */
  excludePrivateRoutines?: boolean;
  workspaceId?: string;
  agentId?: string;
  toolkit?: string;
}

export interface ConnectorUsageSummaryGroup {
  workspaceId: string;
  agentId: string;
  toolkit: string;
  capability: string;
  outcome: ConnectorUsageOutcome;
  attemptCount: number;
  measuredConnectionAccountCount: number;
  remoteCallCount: number;
  providerToolCallCount: number;
  totalResultBytes: number;
  estimatedCostMicros: number | null;
  averageLatencyMs: number;
  minimumRateLimitRemaining: number | null;
  maximumRetryAfterMs: number | null;
}

export interface ConnectorUsageSummary {
  from: number;
  to: number;
  /** Oldest timestamp for which raw connector attempts remain queryable after retention. */
  retainedFrom: number | null;
  /** False when the requested range begins before retainedFrom and is therefore truncated. */
  isComplete: boolean;
  attemptCount: number;
  successCount: number;
  errorCount: number;
  throttledCount: number;
  ambiguousCount: number;
  measuredConnectionAccountCount: number;
  remoteCallCount: number;
  providerToolCallCount: number;
  totalResultBytes: number;
  estimatedCostMicros: number | null;
  averageLatencyMs: number;
  minimumRateLimitRemaining: number | null;
  maximumRetryAfterMs: number | null;
  groups: ConnectorUsageSummaryGroup[];
}

export interface ReserveConnectorQuotaInput {
  reservationId: string;
  workspaceId: string;
  adapterId: string;
  toolkit: string;
  bucket: string;
  units: number;
  limit: number;
  periodStart: number;
  periodEnd: number;
}

export interface ConnectorQuotaReservation extends ReserveConnectorQuotaInput {
  used: number;
  remaining: number;
  recordedAt: number;
}

/** Exact reservation identity used for idempotent rollback before dispatch. */
export type ReleaseConnectorQuotaInput = ReserveConnectorQuotaInput;
