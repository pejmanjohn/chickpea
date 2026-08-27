import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import { installLedgerLinks } from '../state/schema-links.ts';
import { promisify } from '../state/async-facade.ts';
import type { StateDb } from '../state/state-db.ts';
import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent } from '../audit/types.ts';
import {
  aggregateSelect,
  mapRollupRow,
  usageGroupExpressions,
  usageWhere,
} from './rollups.ts';
import { UsageStateError } from './store-error.ts';
import { installReleasePriceCatalogs } from './pricing/catalog.ts';
import { estimateUsage } from './pricing/estimate.ts';
import type {
  ConnectorUsageRecord,
  ConnectorUsageSummary,
  ConnectorUsageSummaryQuery,
  ConnectorQuotaReservation,
  ReleaseConnectorQuotaInput,
  RecordConnectorUsageInput,
  ReserveConnectorQuotaInput,
} from './connectors/types.ts';
import {
  normalizeConnectorSummaryQuery,
  normalizeConnectorQuotaReservation,
  normalizeConnectorUsage,
} from './connectors/validation.ts';
import {
  USAGE_AGGREGATE_RETENTION_MONTHS,
  USAGE_RAW_RETENTION_DAYS,
  USAGE_RETENTION_CHECK_INTERVAL_MS,
  usageRetentionCutoffs,
} from './retention.ts';
import {
  USAGE_TELEMETRY_SCHEMA_VERSION,
  type AdmitUsageOperationInput,
  type ModelCredentialRecord,
  type NormalizedUsageQuery,
  type RecordUsageTerminalInput,
  type PutModelCredentialInput,
  type UsageMeasurement,
  type UsageOperation,
  type UsageOperationDetail,
  type UsageOperationPage,
  type UsageQuery,
  type UsageRetentionResult,
  type UsageRetentionStatus,
  type UsageRpcRequest,
  type UsageRpcResponse,
  type UsageStore,
  type UsageSummary,
} from './types.ts';
import {
  normalizeAdmitUsageOperation,
  normalizeCredentialRetirement,
  normalizeModelCredential,
  normalizeRecordUsageTerminal,
  normalizeUsageQuery,
} from './validation.ts';

export { UsageStateError } from './store-error.ts';

interface OperationRow {
  operation_id: string;
  operation_kind: UsageOperation['operationKind'];
  source_id: string;
  run_id: string | null;
  status: UsageOperation['status'];
  started_at: number;
  finished_at: number | null;
  installation_id: string;
  workspace_id: string | null;
  profile_id: string | null;
  profile_label: string | null;
  channel_id: string | null;
  channel_label: string | null;
  conversation_kind: UsageOperation['conversationKind'];
  routine_id: string | null;
  routine_label: string | null;
  routine_run_id: string | null;
  requester_membership_id: string | null;
  execution_principal_id: string | null;
  model_source: UsageOperation['modelSource'];
  workspace_default_revision: number | null;
  catalog_revision: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  credential_ref_id: string | null;
  credential_version: number | null;
  coverage: 'aggregate_only';
  telemetry_schema_version: number;
  created_at: number;
  updated_at: number;
}

interface MeasurementRow {
  execution_id: string;
  operation_id: string;
  run_execution_id: string | null;
  operation_status: UsageMeasurement['operationStatus'];
  observed_at: number;
  provider_route: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  returned_provider: string | null;
  returned_model: string | null;
  credential_ref_id: string | null;
  credential_version: number | null;
  usage_completeness: UsageMeasurement['usageCompleteness'];
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  usage_unknown_reason: UsageMeasurement['usageUnknownReason'];
  estimate_completeness: UsageMeasurement['estimateCompleteness'];
  estimate_amount_micros: number | null;
  estimate_currency: string | null;
  price_version_id: string | null;
  price_unknown_reason: UsageMeasurement['priceUnknownReason'];
  recorded_at: number;
}

interface CredentialRow {
  credential_ref_id: string;
  version: number;
  provider_id: string;
  source_kind: ModelCredentialRecord['sourceKind'];
  label: string;
  scope_label: string | null;
  unknown_rotation: number;
  active_from: number;
  retired_at: number | null;
}

interface ConnectorUsageRow {
  attempt_id: string;
  workspace_id: string;
  profile_id: string;
  connection_account_id: string;
  operation_id: string | null;
  run_id: string | null;
  run_execution_id: string | null;
  adapter_id: string;
  toolkit: string;
  capability: string;
  provider_tool: string | null;
  provider_version: string | null;
  effect_class: ConnectorUsageRecord['effectClass'];
  outcome: ConnectorUsageRecord['outcome'];
  retry_classification: ConnectorUsageRecord['retryClassification'];
  started_at: number;
  finished_at: number;
  latency_ms: number;
  remote_call_count: number;
  provider_tool_call_count: number;
  result_bytes: number | null;
  http_status: number | null;
  rate_limit_remaining: number | null;
  retry_after_ms: number | null;
  provider_log_id: string | null;
  price_version_id: string | null;
  estimated_cost_micros: number | null;
  estimate_currency: 'USD' | null;
  recorded_at: number;
}

const OPERATION_COLUMNS = `
  operation_id, operation_kind, source_id, run_id, status, started_at, finished_at,
  installation_id, workspace_id, profile_id, profile_label, channel_id,
  channel_label, conversation_kind, routine_id, routine_label, routine_run_id,
  requester_membership_id, execution_principal_id, model_source,
  workspace_default_revision, catalog_revision,
  requested_provider, requested_model, credential_ref_id, credential_version,
  coverage, telemetry_schema_version, created_at, updated_at`;

const MEASUREMENT_COLUMNS = `
  execution_id, operation_id, run_execution_id, operation_status, observed_at, provider_route,
  requested_provider, requested_model, returned_provider, returned_model,
  credential_ref_id, credential_version, usage_completeness, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
  usage_unknown_reason, estimate_completeness,
  estimate_amount_micros, estimate_currency, price_version_id,
  price_unknown_reason, recorded_at`;

export class UsageStoreLogic {
  private readonly audit: AuditStoreLogic;

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    this.audit = new AuditStoreLogic(db);
    this.initializeSchema();
  }

  admitOperation(raw: AdmitUsageOperationInput): UsageOperation {
    const input = normalizeAdmitUsageOperation(raw);
    this.maybeCleanupRetention();
    return this.db.transaction(() => {
      const existing = this.getOperationRow(input.operationId);
      if (existing) {
        const operation = mapOperation(existing);
        if (!sameAdmission(operation, input)) {
          throw new UsageStateError(
            'usage_operation_conflict',
            'Usage operation ID already belongs to different work.',
            { operationId: input.operationId },
          );
        }
        return operation;
      }
      const recordedAt = this.now();
      this.db.run(
        `INSERT INTO usage_operations (${OPERATION_COLUMNS}) VALUES (
          ?, ?, ?, ?, 'admitted', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'aggregate_only', ?, ?, ?
        )`,
        input.operationId,
        input.operationKind,
        input.sourceId,
        input.runId ?? null,
        input.startedAt,
        input.installationId,
        input.workspaceId,
        input.agentId,
        input.agentLabel,
        input.channelId,
        input.channelLabel,
        input.conversationKind,
        input.routineId ?? null,
        input.routineLabel ?? null,
        input.routineRunId ?? null,
        input.requesterMembershipId ?? null,
        input.executionPrincipalId ?? null,
        input.modelSource ?? null,
        input.workspaceDefaultRevision ?? null,
        input.catalogRevision ?? null,
        input.requestedProvider,
        input.requestedModel,
        input.credentialRefId,
        input.credentialVersion,
        USAGE_TELEMETRY_SCHEMA_VERSION,
        recordedAt,
        recordedAt,
      );
      return requiredOperation(this.getOperationRow(input.operationId));
    });
  }

  recordTerminal(raw: RecordUsageTerminalInput): UsageOperationDetail {
    const input = normalizeRecordUsageTerminal(raw);
    return this.db.transaction(() => {
      const operationRow = this.getOperationRow(input.operationId);
      if (!operationRow) {
        throw new UsageStateError(
          'usage_operation_not_found',
          'Usage operation was not admitted.',
          { operationId: input.operationId },
        );
      }
      const operation = mapOperation(operationRow);
      if (input.finishedAt < operation.startedAt) {
        throw new UsageStateError('usage_invalid_input', 'Finish time precedes admission.');
      }
      const existing = this.getMeasurementRow(input.executionId);
      if (existing) {
        const measurement = mapMeasurement(existing);
        if (!sameTerminal(measurement, input)) {
          throw new UsageStateError(
            'usage_measurement_conflict',
            'Usage operation already has a different terminal measurement.',
            { operationId: input.operationId, executionId: input.executionId },
          );
        }
        return requiredDetail(this.getOperation(input.operationId));
      }
      const recordedAt = this.now();
      this.db.run(
        `INSERT INTO usage_measurements (${MEASUREMENT_COLUMNS}) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
        input.executionId,
        input.operationId,
        input.runExecutionId ?? null,
        input.status,
        input.observedAt,
        input.providerRoute,
        input.requestedProvider,
        input.requestedModel,
        input.returnedProvider,
        input.returnedModel,
        input.credentialRefId,
        input.credentialVersion,
        input.usageCompleteness,
        input.inputTokens,
        input.outputTokens,
        input.cacheReadTokens ?? null,
        input.cacheWriteTokens ?? null,
        input.totalTokens,
        input.usageUnknownReason,
        input.estimateCompleteness,
        input.estimateAmountMicros,
        input.estimateCurrency,
        input.priceVersionId,
        input.priceUnknownReason,
        recordedAt,
      );
      this.db.run(
        `UPDATE usage_operations
         SET status = ?, finished_at = MAX(COALESCE(finished_at, 0), ?), updated_at = ?
         WHERE operation_id = ?`,
        input.status,
        input.finishedAt,
        recordedAt,
        input.operationId,
      );
      return requiredDetail(this.getOperation(input.operationId));
    });
  }

  recordConnectorUsage(raw: RecordConnectorUsageInput): ConnectorUsageRecord {
    const input = normalizeConnectorUsage(raw);
    return this.db.transaction(() => {
      const existing = this.getConnectorUsageRow(input.attemptId);
      if (existing) {
        const record = mapConnectorUsage(existing);
        if (!sameConnectorUsage(record, input)) {
          throw new UsageStateError(
            'usage_measurement_conflict',
            'Connector attempt ID already belongs to different work.',
            { executionId: input.attemptId },
          );
        }
        return record;
      }
      const recordedAt = this.now();
      this.db.run(
        `INSERT INTO usage_connector_attempts (
          attempt_id, workspace_id, profile_id, connection_account_id,
          operation_id, run_id, run_execution_id, adapter_id, toolkit,
          capability, provider_tool, provider_version, effect_class, outcome,
          retry_classification, started_at, finished_at, latency_ms,
          remote_call_count, provider_tool_call_count, result_bytes, http_status,
          rate_limit_remaining, retry_after_ms, provider_log_id,
          price_version_id, estimated_cost_micros, estimate_currency, recorded_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
        input.attemptId,
        input.workspaceId,
        input.agentId,
        input.connectionAccountId,
        input.operationId ?? null,
        input.runId ?? null,
        input.runExecutionId ?? null,
        input.adapterId,
        input.toolkit,
        input.capability,
        input.providerTool,
        input.providerVersion,
        input.effectClass,
        input.outcome,
        input.retryClassification,
        input.startedAt,
        input.finishedAt,
        input.latencyMs,
        input.remoteCallCount,
        input.providerToolCallCount,
        input.resultBytes,
        input.httpStatus,
        input.rateLimitRemaining,
        input.retryAfterMs,
        input.providerLogId,
        input.priceVersionId,
        input.estimatedCostMicros,
        input.estimateCurrency,
        recordedAt,
      );
      const dayStart = Math.floor(input.finishedAt / 86_400_000) * 86_400_000;
      this.db.run(
        `INSERT INTO usage_connector_daily_rollups (
          day_start, workspace_id, adapter_id, toolkit, capability, outcome,
          attempt_count, success_count, throttled_count, ambiguous_count,
          latency_ms_total, remote_call_count, provider_tool_call_count,
          result_bytes_total, estimated_cost_micros, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day_start, workspace_id, adapter_id, toolkit, capability, outcome)
        DO UPDATE SET
          attempt_count = attempt_count + 1,
          success_count = success_count + excluded.success_count,
          throttled_count = throttled_count + excluded.throttled_count,
          ambiguous_count = ambiguous_count + excluded.ambiguous_count,
          latency_ms_total = latency_ms_total + excluded.latency_ms_total,
          remote_call_count = remote_call_count + excluded.remote_call_count,
          provider_tool_call_count = provider_tool_call_count + excluded.provider_tool_call_count,
          result_bytes_total = result_bytes_total + excluded.result_bytes_total,
          estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
          updated_at = excluded.updated_at`,
        dayStart,
        input.workspaceId,
        input.adapterId,
        input.toolkit,
        input.capability,
        input.outcome,
        input.outcome === 'success' ? 1 : 0,
        input.outcome === 'throttled' ? 1 : 0,
        input.outcome === 'ambiguous' ? 1 : 0,
        input.latencyMs,
        input.remoteCallCount,
        input.providerToolCallCount,
        input.resultBytes ?? 0,
        input.estimatedCostMicros ?? 0,
        recordedAt,
      );
      return mapConnectorUsage(this.getConnectorUsageRow(input.attemptId)!);
    });
  }

  summarizeConnectorUsage(raw: ConnectorUsageSummaryQuery): ConnectorUsageSummary {
    const query = normalizeConnectorSummaryQuery(raw);
    const retention = this.db.get(
      'SELECT raw_retained_from FROM usage_retention_state WHERE singleton = 1',
    );
    const retainedFrom = retention ? Number(retention.raw_retained_from) : null;
    const clauses = ['finished_at >= ?', 'finished_at < ?'];
    const parameters: Array<string | number> = [query.from, query.to];
    if (query.workspaceId) {
      clauses.push('workspace_id = ?');
      parameters.push(query.workspaceId);
    }
    if (query.agentId) {
      clauses.push('profile_id = ?');
      parameters.push(query.agentId);
    }
    if (query.toolkit) {
      clauses.push('toolkit = ?');
      parameters.push(query.toolkit);
    }
    if (query.excludePrivateRoutines) {
      clauses.push(`NOT EXISTS (
        SELECT 1 FROM usage_operations private_operation
        WHERE private_operation.operation_id = usage_connector_attempts.operation_id
          AND private_operation.operation_kind = 'routine_run'
          AND private_operation.conversation_kind = 'direct_message'
      )`);
    }
    const rows = this.db.all(
      `SELECT workspace_id, profile_id, toolkit, capability, outcome,
              COUNT(*) AS attempt_count,
              COUNT(DISTINCT connection_account_id) AS measured_connection_account_count,
              SUM(remote_call_count) AS remote_call_count,
              SUM(provider_tool_call_count) AS provider_tool_call_count,
              COALESCE(SUM(result_bytes), 0) AS total_result_bytes,
              SUM(estimated_cost_micros) AS estimated_cost_micros,
              AVG(latency_ms) AS average_latency_ms,
              MIN(rate_limit_remaining) AS minimum_rate_limit_remaining,
              MAX(retry_after_ms) AS maximum_retry_after_ms
       FROM usage_connector_attempts
       WHERE ${clauses.join(' AND ')}
       GROUP BY workspace_id, profile_id, toolkit, capability, outcome
       ORDER BY workspace_id, profile_id, toolkit, capability, outcome`,
      ...parameters,
    );
    const groups = rows.map((row) => ({
      workspaceId: String(row.workspace_id),
      agentId: String(row.profile_id),
      toolkit: String(row.toolkit),
      capability: String(row.capability),
      outcome: row.outcome as ConnectorUsageRecord['outcome'],
      attemptCount: Number(row.attempt_count),
      measuredConnectionAccountCount: Number(row.measured_connection_account_count),
      remoteCallCount: Number(row.remote_call_count),
      providerToolCallCount: Number(row.provider_tool_call_count),
      totalResultBytes: Number(row.total_result_bytes),
      estimatedCostMicros: row.estimated_cost_micros === null
        ? null
        : Number(row.estimated_cost_micros),
      averageLatencyMs: Math.round(Number(row.average_latency_ms)),
      minimumRateLimitRemaining: row.minimum_rate_limit_remaining === null
        ? null
        : Number(row.minimum_rate_limit_remaining),
      maximumRetryAfterMs: row.maximum_retry_after_ms === null
        ? null
        : Number(row.maximum_retry_after_ms),
    }));
    const totals = this.db.get(
      `SELECT COUNT(DISTINCT connection_account_id) AS measured_connection_account_count,
              SUM(latency_ms) AS latency_ms_total,
              MIN(rate_limit_remaining) AS minimum_rate_limit_remaining,
              MAX(retry_after_ms) AS maximum_retry_after_ms
       FROM usage_connector_attempts
       WHERE ${clauses.join(' AND ')}`,
      ...parameters,
    );
    const attemptCount = groups.reduce((sum, group) => sum + group.attemptCount, 0);
    const successCount = groups.filter(({ outcome }) => outcome === 'success')
      .reduce((sum, group) => sum + group.attemptCount, 0);
    return {
      from: query.from,
      to: query.to,
      retainedFrom,
      isComplete: retainedFrom === null || query.from >= retainedFrom,
      attemptCount,
      successCount,
      errorCount: attemptCount - successCount,
      throttledCount: groups.filter(({ outcome }) => outcome === 'throttled')
        .reduce((sum, group) => sum + group.attemptCount, 0),
      ambiguousCount: groups.filter(({ outcome }) => outcome === 'ambiguous')
        .reduce((sum, group) => sum + group.attemptCount, 0),
      measuredConnectionAccountCount: Number(totals?.measured_connection_account_count ?? 0),
      remoteCallCount: groups.reduce((sum, group) => sum + group.remoteCallCount, 0),
      providerToolCallCount: groups.reduce(
        (sum, group) => sum + group.providerToolCallCount, 0,
      ),
      totalResultBytes: groups.reduce((sum, group) => sum + group.totalResultBytes, 0),
      estimatedCostMicros: groups.length === 0
        ? null
        : groups.reduce((sum, group) => sum + (group.estimatedCostMicros ?? 0), 0),
      averageLatencyMs: attemptCount === 0
        ? 0
        : Math.round(Number(totals?.latency_ms_total ?? 0) / attemptCount),
      minimumRateLimitRemaining: totals?.minimum_rate_limit_remaining === null ||
          totals?.minimum_rate_limit_remaining === undefined
        ? null
        : Number(totals.minimum_rate_limit_remaining),
      maximumRetryAfterMs: totals?.maximum_retry_after_ms === null ||
          totals?.maximum_retry_after_ms === undefined
        ? null
        : Number(totals.maximum_retry_after_ms),
      groups,
    };
  }

  reserveConnectorQuota(raw: ReserveConnectorQuotaInput): ConnectorQuotaReservation {
    const input = normalizeConnectorQuotaReservation(raw);
    return this.db.transaction(() => {
      const existing = this.db.get(
        'SELECT * FROM usage_connector_quota_reservations WHERE reservation_id = ?',
        input.reservationId,
      );
      if (existing) {
        const used = connectorQuotaUsed(this.db, existing);
        const reservation = mapConnectorQuotaReservation(existing, used);
        if (!sameConnectorQuotaReservation(reservation, input)) {
          throw new UsageStateError(
            'usage_measurement_conflict',
            'Connector quota reservation ID already belongs to different work.',
            { executionId: input.reservationId },
          );
        }
        return reservation;
      }
      const used = Number(this.db.get(
        `SELECT COALESCE(SUM(units), 0) AS used
         FROM usage_connector_quota_reservations
         WHERE adapter_id = ? AND toolkit = ? AND bucket = ? AND period_start = ?`,
        input.adapterId,
        input.toolkit,
        input.bucket,
        input.periodStart,
      )?.used ?? 0);
      if (used + input.units > input.limit) {
        throw new UsageStateError(
          'usage_connector_quota_exceeded',
          'Connector provider quota budget is exhausted for this period.',
          {
            adapterId: input.adapterId,
            toolkit: input.toolkit,
            bucket: input.bucket,
            retryAt: String(input.periodEnd),
          },
        );
      }
      const recordedAt = this.now();
      this.db.run(
        `INSERT INTO usage_connector_quota_reservations (
          reservation_id, workspace_id, adapter_id, toolkit, bucket, units,
          quota_limit, period_start, period_end, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.reservationId,
        input.workspaceId,
        input.adapterId,
        input.toolkit,
        input.bucket,
        input.units,
        input.limit,
        input.periodStart,
        input.periodEnd,
        recordedAt,
      );
      return {
        ...input,
        used: used + input.units,
        remaining: input.limit - used - input.units,
        recordedAt,
      };
    });
  }

  releaseConnectorQuota(raw: ReleaseConnectorQuotaInput): boolean {
    const input = normalizeConnectorQuotaReservation(raw);
    return this.db.transaction(() => {
      const existing = this.db.get(
        'SELECT * FROM usage_connector_quota_reservations WHERE reservation_id = ?',
        input.reservationId,
      );
      if (!existing) return false;
      const reservation = mapConnectorQuotaReservation(
        existing,
        connectorQuotaUsed(this.db, existing),
      );
      if (!sameConnectorQuotaReservation(reservation, input)) {
        throw new UsageStateError(
          'usage_measurement_conflict',
          'Connector quota reservation ID already belongs to different work.',
          { executionId: input.reservationId },
        );
      }
      this.db.run(
        'DELETE FROM usage_connector_quota_reservations WHERE reservation_id = ?',
        input.reservationId,
      );
      return true;
    });
  }

  getOperation(operationId: string): UsageOperationDetail | undefined {
    const operationRow = this.getOperationRow(operationId);
    if (!operationRow) return undefined;
    return {
      operation: mapOperation(operationRow),
      measurements: this.getMeasurementRowsForOperation(operationId).map(mapMeasurement),
    };
  }

  getOperationByRunId(runId: string): UsageOperationDetail | undefined {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(runId)) {
      throw new UsageStateError('usage_invalid_input', 'Run identifier is invalid.');
    }
    const row = this.db.get(
      `SELECT operation_id FROM usage_operations WHERE run_id = ?
       ORDER BY started_at DESC, operation_id DESC LIMIT 1`,
      runId,
    );
    return row ? this.getOperation(String(row.operation_id)) : undefined;
  }

  listOperations(rawQuery: UsageQuery): UsageOperationPage {
    const query = normalizeUsageQuery(rawQuery);
    const where = usageWhere(query, true);
    const rows = this.db.all(
      `SELECT DISTINCT o.operation_id, o.started_at
       FROM usage_operations o
       LEFT JOIN usage_measurements m ON m.operation_id = o.operation_id
       WHERE ${where.sql}
       ORDER BY o.started_at DESC, o.operation_id DESC
       LIMIT ?`,
      ...where.params,
      query.limit + 1,
    );
    const pageRows = rows.slice(0, query.limit);
    const items = pageRows.map((row) => requiredDetail(this.getOperation(String(row.operation_id))));
    const last = items.at(-1)?.operation;
    return {
      items,
      nextCursor: rows.length > query.limit && last
        ? { startedAt: last.startedAt, operationId: last.operationId }
        : null,
    };
  }

  summarize(rawQuery: UsageQuery): UsageSummary {
    const query = normalizeUsageQuery(rawQuery);
    const where = usageWhere(query);
    const availableCurrencies = this.db.all(
      `SELECT DISTINCT m.estimate_currency AS currency
       FROM usage_operations o
       JOIN usage_measurements m ON m.operation_id = o.operation_id
       WHERE ${where.sql} AND m.estimate_completeness = 'complete'
         AND m.estimate_currency IS NOT NULL
       ORDER BY m.estimate_currency`,
      ...where.params,
    ).map((row) => String(row.currency));
    const mixedCurrency = !query.currency && availableCurrencies.length > 1;
    const activeCurrency = query.currency ?? (availableCurrencies.length === 1 ? availableCurrencies[0]! : null);
    const aggregate = aggregateSelect(mixedCurrency ? '__MIXED__' : activeCurrency);
    const totalRow = this.db.get(
      `SELECT ${aggregate.sql}
       FROM usage_operations o
       LEFT JOIN usage_measurements m ON m.operation_id = o.operation_id
       WHERE ${where.sql}`,
      ...aggregate.params,
      ...where.params,
    ) ?? {};
    const groups = query.groupBy
      ? this.groupedSummary(query, where, activeCurrency, mixedCurrency)
      : [];
    return {
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      currency: activeCurrency,
      mixedCurrency,
      availableCurrencies,
      totals: mapRollupRow(totalRow),
      groups,
    };
  }

  putCredential(raw: PutModelCredentialInput): ModelCredentialRecord {
    const input = normalizeModelCredential(raw);
    return this.db.transaction(() => {
      const existing = this.getCredentialRow(input.credentialRefId, input.version);
      if (existing) {
        const credential = mapCredential(existing);
        if (!sameCredential(credential, input)) {
          throw new UsageStateError(
            'usage_credential_conflict',
            'Credential reference epoch already has different metadata.',
            { credentialRefId: input.credentialRefId, version: String(input.version) },
          );
        }
        return credential;
      }
      this.db.run(
        `INSERT INTO usage_credentials (
          credential_ref_id, version, provider_id, source_kind, label, scope_label,
          unknown_rotation, active_from, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        input.credentialRefId,
        input.version,
        input.providerId,
        input.sourceKind,
        input.label,
        input.scopeLabel,
        input.unknownRotation ? 1 : 0,
        input.activeFrom,
      );
      const credential = requiredCredential(this.getCredentialRow(input.credentialRefId, input.version));
      this.appendUsageAudit({
        eventId: `usage:credential:${input.credentialRefId}:${input.version}:created`,
        eventType: 'usage.credential_created',
        subjectId: input.credentialRefId,
        subjectVersion: input.version,
        createdAt: input.activeFrom,
        metadata: {
          providerId: input.providerId,
          sourceKind: input.sourceKind,
          unknownRotation: input.unknownRotation,
        },
      });
      return credential;
    });
  }

  retireCredential(
    credentialRefId: string,
    version: number,
    retiredAt: number,
  ): ModelCredentialRecord {
    const retirement = normalizeCredentialRetirement(credentialRefId, version, retiredAt);
    return this.db.transaction(() => {
      const existing = this.getCredentialRow(
        retirement.credentialRefId,
        retirement.version,
      );
      if (!existing) {
        throw new UsageStateError(
          'usage_credential_not_found',
          'Credential reference epoch was not found.',
          {
            credentialRefId: retirement.credentialRefId,
            version: String(retirement.version),
          },
        );
      }
      if (retirement.retiredAt < existing.active_from) {
        throw new UsageStateError(
          'usage_invalid_input',
          'Credential retirement time precedes activation.',
        );
      }
      if (existing.retired_at === null) {
        this.db.run(
          `UPDATE usage_credentials SET retired_at = ?
           WHERE credential_ref_id = ? AND version = ? AND retired_at IS NULL`,
          retirement.retiredAt,
          retirement.credentialRefId,
          retirement.version,
        );
        this.appendUsageAudit({
          eventId: `usage:credential:${retirement.credentialRefId}:${retirement.version}:retired`,
          eventType: 'usage.credential_retired',
          subjectId: retirement.credentialRefId,
          subjectVersion: retirement.version,
          createdAt: retirement.retiredAt,
          metadata: {},
        });
      }
      return requiredCredential(this.getCredentialRow(
        retirement.credentialRefId,
        retirement.version,
      ));
    });
  }

  listCredentials(providerId?: string): ModelCredentialRecord[] {
    const rows = providerId
      ? this.db.all(
          `SELECT credential_ref_id, version, provider_id, source_kind, label,
                  scope_label, unknown_rotation, active_from, retired_at
           FROM usage_credentials WHERE provider_id = ?
           ORDER BY credential_ref_id, version`,
          providerId,
        )
      : this.db.all(
          `SELECT credential_ref_id, version, provider_id, source_kind, label,
                  scope_label, unknown_rotation, active_from, retired_at
           FROM usage_credentials ORDER BY provider_id, credential_ref_id, version`,
        );
    return rows.map((row) => mapCredential(row as unknown as CredentialRow));
  }

  cleanupRetention(at: number = this.now()): UsageRetentionResult {
    const cutoffs = usageRetentionCutoffs(at);
    return this.db.transaction(() => {
      const expiringOperations = Number(this.db.get(
        'SELECT COUNT(*) AS count FROM usage_operations WHERE started_at < ?',
        cutoffs.rawBefore,
      )?.count ?? 0);
      let measurementsDeleted = 0;
      let operationsDeleted = 0;
      if (expiringOperations > 0) {
        this.db.run(
          `INSERT INTO usage_daily_rollups (
            day_start, operation_count, completed_operation_count,
            failed_operation_count, incomplete_operation_count,
            metered_operation_count, priced_operation_count, completed_priced_operation_count,
            unknown_usage_operation_count, unknown_price_operation_count,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
            estimate_amount_micros_usd, updated_at
          )
          SELECT CAST(o.started_at / 86400000 AS INTEGER) * 86400000,
            COUNT(DISTINCT o.operation_id),
            COUNT(DISTINCT CASE WHEN o.status = 'completed' THEN o.operation_id END),
            COUNT(DISTINCT CASE WHEN o.status = 'failed' THEN o.operation_id END),
            COUNT(DISTINCT CASE WHEN o.status IN ('interrupted', 'incomplete', 'admitted') THEN o.operation_id END),
            COUNT(DISTINCT CASE WHEN m.usage_completeness IN ('complete', 'partial') THEN o.operation_id END),
            COUNT(DISTINCT CASE WHEN m.estimate_completeness = 'complete' AND m.estimate_currency = 'USD' THEN o.operation_id END),
            COUNT(DISTINCT CASE WHEN o.status = 'completed' AND m.estimate_completeness = 'complete' AND m.estimate_currency = 'USD' THEN o.operation_id END),
            COUNT(DISTINCT o.operation_id) - COUNT(DISTINCT CASE WHEN m.usage_completeness IN ('complete', 'partial') THEN o.operation_id END),
            COUNT(DISTINCT o.operation_id) - COUNT(DISTINCT CASE WHEN m.estimate_completeness = 'complete' AND m.estimate_currency = 'USD' THEN o.operation_id END),
            COALESCE(SUM(m.input_tokens), 0), COALESCE(SUM(m.output_tokens), 0),
            COALESCE(SUM(m.cache_read_tokens), 0), COALESCE(SUM(m.cache_write_tokens), 0),
            COALESCE(SUM(m.total_tokens), 0),
            COALESCE(SUM(CASE WHEN m.estimate_completeness = 'complete' AND m.estimate_currency = 'USD' THEN m.estimate_amount_micros END), 0),
            ?
          FROM usage_operations o
          LEFT JOIN usage_measurements m ON m.operation_id = o.operation_id
          WHERE o.started_at < ?
          GROUP BY CAST(o.started_at / 86400000 AS INTEGER) * 86400000
          ON CONFLICT(day_start) DO UPDATE SET
            operation_count = operation_count + excluded.operation_count,
            completed_operation_count = completed_operation_count + excluded.completed_operation_count,
            failed_operation_count = failed_operation_count + excluded.failed_operation_count,
            incomplete_operation_count = incomplete_operation_count + excluded.incomplete_operation_count,
            metered_operation_count = metered_operation_count + excluded.metered_operation_count,
            priced_operation_count = priced_operation_count + excluded.priced_operation_count,
            completed_priced_operation_count = completed_priced_operation_count + excluded.completed_priced_operation_count,
            unknown_usage_operation_count = unknown_usage_operation_count + excluded.unknown_usage_operation_count,
            unknown_price_operation_count = unknown_price_operation_count + excluded.unknown_price_operation_count,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens,
            cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
            cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
            total_tokens = total_tokens + excluded.total_tokens,
            estimate_amount_micros_usd = estimate_amount_micros_usd + excluded.estimate_amount_micros_usd,
            updated_at = excluded.updated_at`,
          at,
          cutoffs.rawBefore,
        );
        measurementsDeleted = this.db.run(
          `DELETE FROM usage_measurements WHERE operation_id IN (
            SELECT operation_id FROM usage_operations WHERE started_at < ?
          )`,
          cutoffs.rawBefore,
        ).changes;
        operationsDeleted = this.db.run(
          'DELETE FROM usage_operations WHERE started_at < ?',
          cutoffs.rawBefore,
        ).changes;
      }
      const aggregateDaysDeleted = this.db.run(
        'DELETE FROM usage_daily_rollups WHERE day_start < ?',
        cutoffs.aggregatesBefore,
      ).changes;
      // Connector rollups are updated atomically when each attempt is
      // recorded, so retention only deletes raw detail here; re-aggregating
      // expiring attempts would double-count them.
      const connectorAttemptsDeleted = this.db.run(
        'DELETE FROM usage_connector_attempts WHERE finished_at < ?',
        cutoffs.rawBefore,
      ).changes;
      const connectorAggregateDaysDeleted = this.db.run(
        'DELETE FROM usage_connector_daily_rollups WHERE day_start < ?',
        cutoffs.aggregatesBefore,
      ).changes;
      const connectorQuotaReservationsDeleted = this.db.run(
        'DELETE FROM usage_connector_quota_reservations WHERE period_end <= ?',
        at,
      ).changes;
      this.db.run(
        `INSERT INTO usage_retention_state (
          singleton, last_run_at, raw_retained_from, aggregate_retained_from
        ) VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          last_run_at = excluded.last_run_at,
          raw_retained_from = excluded.raw_retained_from,
          aggregate_retained_from = excluded.aggregate_retained_from`,
        at,
        cutoffs.rawBefore,
        cutoffs.aggregatesBefore,
      );
      if (operationsDeleted > 0 || aggregateDaysDeleted > 0 ||
          connectorAttemptsDeleted > 0 || connectorAggregateDaysDeleted > 0 ||
          connectorQuotaReservationsDeleted > 0) {
        this.appendUsageAudit({
          eventId: `usage:retention:${at}`,
          eventType: 'usage.retention_applied',
          subjectId: 'usage-ledger',
          subjectVersion: 1,
          createdAt: at,
          metadata: {
            operationsDeleted,
            measurementsDeleted,
            aggregateDaysDeleted,
            connectorAttemptsDeleted,
            connectorAggregateDaysDeleted,
            connectorQuotaReservationsDeleted,
          },
        });
      }
      return {
        ...this.getRetentionStatus(),
        operationsDeleted,
        measurementsDeleted,
        aggregateDaysDeleted,
        connectorAttemptsDeleted,
        connectorAggregateDaysDeleted,
        connectorQuotaReservationsDeleted,
      };
    });
  }

  getRetentionStatus(): UsageRetentionStatus {
    const row = this.db.get(
      `SELECT last_run_at, raw_retained_from, aggregate_retained_from
       FROM usage_retention_state WHERE singleton = 1`,
    );
    return {
      rawRetentionDays: USAGE_RAW_RETENTION_DAYS,
      aggregateRetentionMonths: USAGE_AGGREGATE_RETENTION_MONTHS,
      lastRunAt: row ? Number(row.last_run_at) : null,
      rawRetainedFrom: row ? Number(row.raw_retained_from) : null,
      aggregateRetainedFrom: row ? Number(row.aggregate_retained_from) : null,
    };
  }

  listUsageAuditEvents(limit = 100): AuditEvent[] {
    return this.audit.list({ domain: 'usage', limit });
  }

  execute(request: UsageRpcRequest): UsageRpcResponse {
    switch (request.kind) {
      case 'admit_operation':
        return { kind: 'operation', operation: this.admitOperation(request.input) };
      case 'record_terminal':
        return { kind: 'detail', detail: this.recordTerminal(request.input) };
      case 'record_connector_usage':
        return { kind: 'connector_usage', usage: this.recordConnectorUsage(request.input) };
      case 'reserve_connector_quota':
        return {
          kind: 'connector_quota',
          reservation: this.reserveConnectorQuota(request.input),
        };
      case 'release_connector_quota':
        return {
          kind: 'connector_quota_released',
          released: this.releaseConnectorQuota(request.input),
        };
      case 'summarize_connector_usage':
        return {
          kind: 'connector_usage_summary',
          summary: this.summarizeConnectorUsage(request.query),
        };
      case 'get_operation':
        return { kind: 'detail', detail: this.getOperation(request.operationId) ?? null };
      case 'get_operation_by_run':
        return { kind: 'detail', detail: this.getOperationByRunId(request.runId) ?? null };
      case 'list_operations':
        return { kind: 'operation_page', page: this.listOperations(request.query) };
      case 'summarize':
        return { kind: 'summary', summary: this.summarize(request.query) };
      case 'put_credential':
        return { kind: 'credential', credential: this.putCredential(request.input) };
      case 'retire_credential':
        return {
          kind: 'credential',
          credential: this.retireCredential(
            request.credentialRefId,
            request.version,
            request.retiredAt,
          ),
        };
      case 'list_credentials':
        return { kind: 'credentials', credentials: this.listCredentials(request.providerId) };
      case 'cleanup_retention':
        return { kind: 'retention', result: this.cleanupRetention(request.at) };
      case 'retention_status':
        return { kind: 'retention_status', status: this.getRetentionStatus() };
      case 'list_usage_audit_events':
        return { kind: 'audit_events', events: this.listUsageAuditEvents(request.limit) };
    }
  }

  private maybeCleanupRetention(): void {
    const lastRunAt = this.getRetentionStatus().lastRunAt;
    if (lastRunAt !== null && this.now() - lastRunAt < USAGE_RETENTION_CHECK_INTERVAL_MS) return;
    try {
      this.cleanupRetention(this.now());
    } catch (error) {
      console.warn('[usage] retention cleanup failed; usage admission will continue');
    }
  }

  private appendUsageAudit(input: {
    eventId: string;
    eventType: string;
    subjectId: string;
    subjectVersion: number;
    createdAt: number;
    metadata: Record<string, unknown>;
  }): void {
    const idempotencyKey = input.eventId;
    if (this.audit.findByIdempotencyKey(idempotencyKey)) return;
    this.audit.append({
      eventId: input.eventId,
      domain: 'usage',
      eventType: input.eventType,
      outcome: 'success',
      actorClass: 'system',
      subjectId: input.subjectId,
      subjectVersion: input.subjectVersion,
      createdAt: input.createdAt,
      metadataJson: JSON.stringify(input.metadata),
      idempotencyKey,
    });
  }

  private groupedSummary(
    query: NormalizedUsageQuery,
    where: ReturnType<typeof usageWhere>,
    activeCurrency: string | null,
    mixedCurrency: boolean,
  ) {
    const expressions = usageGroupExpressions(query.groupBy!);
    const aggregate = aggregateSelect(mixedCurrency ? '__MIXED__' : activeCurrency);
    const rows = this.db.all(
      `SELECT ${expressions.key} AS group_key, ${expressions.label} AS group_label,
              ${aggregate.sql}
       FROM usage_operations o
       LEFT JOIN usage_measurements m ON m.operation_id = o.operation_id
       WHERE ${where.sql}
       GROUP BY group_key, group_label
       ORDER BY estimate_amount_micros IS NULL, estimate_amount_micros DESC,
                operation_count DESC, group_key
       LIMIT 100`,
      ...aggregate.params,
      ...where.params,
    );
    return rows.map((row) => ({
      key: String(row.group_key),
      label: String(row.group_label),
      ...mapRollupRow(row),
    }));
  }

  private getOperationRow(operationId: string): OperationRow | undefined {
    return this.db.get(
      `SELECT ${OPERATION_COLUMNS} FROM usage_operations WHERE operation_id = ?`,
      operationId,
    ) as unknown as OperationRow | undefined;
  }

  private getMeasurementRow(executionId: string): MeasurementRow | undefined {
    return this.db.get(
      `SELECT ${MEASUREMENT_COLUMNS} FROM usage_measurements WHERE execution_id = ?`,
      executionId,
    ) as unknown as MeasurementRow | undefined;
  }

  private getMeasurementRowsForOperation(operationId: string): MeasurementRow[] {
    return this.db.all(
      `SELECT ${MEASUREMENT_COLUMNS} FROM usage_measurements
       WHERE operation_id = ? ORDER BY observed_at, execution_id`,
      operationId,
    ) as unknown as MeasurementRow[];
  }

  private getCredentialRow(credentialRefId: string, version: number): CredentialRow | undefined {
    return this.db.get(
      `SELECT credential_ref_id, version, provider_id, source_kind, label,
              scope_label, unknown_rotation, active_from, retired_at
       FROM usage_credentials WHERE credential_ref_id = ? AND version = ?`,
      credentialRefId,
      version,
    ) as unknown as CredentialRow | undefined;
  }

  private getConnectorUsageRow(attemptId: string): ConnectorUsageRow | undefined {
    return this.db.get(
      'SELECT * FROM usage_connector_attempts WHERE attempt_id = ?',
      attemptId,
    ) as unknown as ConnectorUsageRow | undefined;
  }

  private initializeSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        installation_id TEXT NOT NULL,
        workspace_id TEXT,
        profile_id TEXT,
        profile_label TEXT,
        channel_id TEXT,
        channel_label TEXT,
        conversation_kind TEXT NOT NULL,
        routine_id TEXT,
        routine_label TEXT,
        routine_run_id TEXT,
        requester_membership_id TEXT,
        execution_principal_id TEXT,
        model_source TEXT,
        workspace_default_revision INTEGER,
        catalog_revision TEXT,
        requested_provider TEXT,
        requested_model TEXT,
        credential_ref_id TEXT,
        credential_version INTEGER,
        coverage TEXT NOT NULL,
        telemetry_schema_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_measurements (
        execution_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        run_execution_id TEXT,
        operation_status TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        provider_route TEXT,
        requested_provider TEXT,
        requested_model TEXT,
        returned_provider TEXT,
        returned_model TEXT,
        credential_ref_id TEXT,
        credential_version INTEGER,
        usage_completeness TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        usage_unknown_reason TEXT,
        estimate_completeness TEXT NOT NULL,
        estimate_amount_micros INTEGER,
        estimate_currency TEXT,
        price_version_id TEXT,
        price_unknown_reason TEXT,
        recorded_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_credentials (
        credential_ref_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        label TEXT NOT NULL,
        scope_label TEXT,
        unknown_rotation INTEGER NOT NULL,
        active_from INTEGER NOT NULL,
        retired_at INTEGER,
        PRIMARY KEY (credential_ref_id, version)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_connector_attempts (
        attempt_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        connection_account_id TEXT NOT NULL,
        operation_id TEXT,
        run_id TEXT,
        run_execution_id TEXT,
        adapter_id TEXT NOT NULL,
        toolkit TEXT NOT NULL,
        capability TEXT NOT NULL,
        provider_tool TEXT,
        provider_version TEXT,
        effect_class TEXT NOT NULL,
        outcome TEXT NOT NULL,
        retry_classification TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        remote_call_count INTEGER NOT NULL,
        provider_tool_call_count INTEGER NOT NULL,
        result_bytes INTEGER,
        http_status INTEGER,
        rate_limit_remaining INTEGER,
        retry_after_ms INTEGER,
        provider_log_id TEXT,
        price_version_id TEXT,
        estimated_cost_micros INTEGER,
        estimate_currency TEXT,
        recorded_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_connector_daily_rollups (
        day_start INTEGER NOT NULL,
        workspace_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        toolkit TEXT NOT NULL,
        capability TEXT NOT NULL,
        outcome TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        throttled_count INTEGER NOT NULL,
        ambiguous_count INTEGER NOT NULL,
        latency_ms_total INTEGER NOT NULL,
        remote_call_count INTEGER NOT NULL,
        provider_tool_call_count INTEGER NOT NULL,
        result_bytes_total INTEGER NOT NULL,
        estimated_cost_micros INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day_start, workspace_id, adapter_id, toolkit, capability, outcome)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_connector_quota_reservations (
        reservation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        toolkit TEXT NOT NULL,
        bucket TEXT NOT NULL,
        units INTEGER NOT NULL,
        quota_limit INTEGER NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_daily_rollups (
        day_start INTEGER PRIMARY KEY,
        operation_count INTEGER NOT NULL,
        completed_operation_count INTEGER NOT NULL,
        failed_operation_count INTEGER NOT NULL,
        incomplete_operation_count INTEGER NOT NULL,
        metered_operation_count INTEGER NOT NULL,
        priced_operation_count INTEGER NOT NULL,
        completed_priced_operation_count INTEGER NOT NULL,
        unknown_usage_operation_count INTEGER NOT NULL,
        unknown_price_operation_count INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        estimate_amount_micros_usd INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_retention_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_run_at INTEGER NOT NULL,
        raw_retained_from INTEGER NOT NULL,
        aggregate_retained_from INTEGER NOT NULL
      )`,
    );
    for (const sql of [
      'CREATE INDEX IF NOT EXISTS usage_operations_time_idx ON usage_operations (started_at DESC, operation_id DESC)',
      'CREATE INDEX IF NOT EXISTS usage_operations_workspace_idx ON usage_operations (workspace_id, started_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_operations_profile_idx ON usage_operations (profile_id, started_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_operations_channel_idx ON usage_operations (channel_id, started_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_operations_routine_idx ON usage_operations (routine_id, started_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_operations_status_idx ON usage_operations (status, started_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_measurements_provider_idx ON usage_measurements (returned_provider, observed_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_measurements_model_idx ON usage_measurements (returned_model, observed_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_measurements_credential_idx ON usage_measurements (credential_ref_id, observed_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_measurements_operation_idx ON usage_measurements (operation_id, observed_at, execution_id)',
      "CREATE INDEX IF NOT EXISTS usage_measurements_unknown_price_idx ON usage_measurements (observed_at, execution_id) WHERE estimate_completeness = 'unknown'",
      'CREATE INDEX IF NOT EXISTS usage_credentials_provider_idx ON usage_credentials (provider_id, retired_at, credential_ref_id, version)',
      'CREATE INDEX IF NOT EXISTS usage_connector_attempts_time_idx ON usage_connector_attempts (finished_at DESC, attempt_id)',
      'CREATE INDEX IF NOT EXISTS usage_connector_attempts_workspace_idx ON usage_connector_attempts (workspace_id, finished_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_connector_attempts_toolkit_idx ON usage_connector_attempts (toolkit, capability, finished_at DESC)',
      'CREATE INDEX IF NOT EXISTS usage_connector_attempts_operation_idx ON usage_connector_attempts (operation_id, run_id, run_execution_id)',
      'CREATE INDEX IF NOT EXISTS usage_connector_quota_period_idx ON usage_connector_quota_reservations (adapter_id, toolkit, bucket, period_start)',
    ]) this.db.exec(sql);
    const measurementColumns = this.db.all('PRAGMA table_info(usage_measurements)');
    if (!measurementColumns.some((row) => row.name === 'cache_read_tokens')) {
      this.db.exec('ALTER TABLE usage_measurements ADD COLUMN cache_read_tokens INTEGER');
    }
    if (!measurementColumns.some((row) => row.name === 'cache_write_tokens')) {
      this.db.exec('ALTER TABLE usage_measurements ADD COLUMN cache_write_tokens INTEGER');
    }
    const operationColumns = new Set(
      this.db.all('PRAGMA table_info(usage_operations)').map((row) => String(row.name)),
    );
    for (const [name, definition] of [
      ['requester_membership_id', 'TEXT'],
      ['execution_principal_id', 'TEXT'],
      ['model_source', 'TEXT'],
      ['workspace_default_revision', 'INTEGER'],
      ['catalog_revision', 'TEXT'],
    ] as const) {
      if (!operationColumns.has(name)) {
        this.db.exec(`ALTER TABLE usage_operations ADD COLUMN ${name} ${definition}`);
      }
    }
    const rollupColumns = this.db.all('PRAGMA table_info(usage_daily_rollups)');
    if (!rollupColumns.some((row) => row.name === 'cache_read_tokens')) {
      this.db.exec('ALTER TABLE usage_daily_rollups ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0');
    }
    if (!rollupColumns.some((row) => row.name === 'cache_write_tokens')) {
      this.db.exec('ALTER TABLE usage_daily_rollups ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0');
    }
    const connectorColumns = this.db.all('PRAGMA table_info(usage_connector_attempts)');
    if (!connectorColumns.some((row) => row.name === 'result_bytes')) {
      this.db.exec('ALTER TABLE usage_connector_attempts ADD COLUMN result_bytes INTEGER');
    }
    const connectorRollupColumns = this.db.all('PRAGMA table_info(usage_connector_daily_rollups)');
    if (!connectorRollupColumns.some((row) => row.name === 'result_bytes_total')) {
      this.db.exec(
        'ALTER TABLE usage_connector_daily_rollups ADD COLUMN result_bytes_total INTEGER NOT NULL DEFAULT 0',
      );
    }
    // The pointers into the Work ledger (usage_operations.run_id,
    // usage_measurements.run_execution_id) and their partial indexes are
    // installed by whichever store gets here first — see installLedgerLinks.
    // The tables above must already exist.
    installLedgerLinks(this.db);
    const installedCatalogs = installReleasePriceCatalogs(this.db);
    for (const catalog of installedCatalogs) {
      this.appendUsageAudit({
        eventId: `usage:catalog:${catalog.id}:installed`,
        eventType: 'usage.catalog_installed',
        subjectId: catalog.id,
        subjectVersion: 1,
        createdAt: catalog.reviewedAt,
        metadata: { providerId: catalog.providerId, contentHash: catalog.contentHash },
      });
    }
    this.backfillUnknownEstimates();
  }

  /**
   * Price catalogs are immutable, but missing price coverage can improve in a
   * later release. Enrich only measurements that already have complete usage
   * and an explicitly unknown/stale price; never replace a prior estimate or
   * manufacture tokens. Raw detail is retained for only 30 days, so the
   * candidate scan remains bounded. The update and its audit commit together;
   * a crash retries safely on the next store initialization.
   */
  private backfillUnknownEstimates(): number {
    const rows = this.db.all(
      `SELECT ${MEASUREMENT_COLUMNS} FROM usage_measurements
       WHERE usage_completeness = 'complete'
         AND estimate_completeness = 'unknown'
         AND estimate_amount_micros IS NULL
         AND estimate_currency IS NULL
         AND price_version_id IS NULL
         AND price_unknown_reason IN ('price_unknown', 'price_stale')`,
    ) as unknown as MeasurementRow[];
    return this.db.transaction(() => {
      let changed = 0;
      const catalogIds = new Set<string>();
      for (const row of rows) {
        const estimate = estimateUsage({
          observedAt: row.observed_at,
          providerRoute: row.provider_route,
          requestedProvider: row.requested_provider,
          requestedModel: row.requested_model,
          returnedProvider: row.returned_provider,
          returnedModel: row.returned_model,
          usageCompleteness: row.usage_completeness,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheReadTokens: row.cache_read_tokens,
          cacheWriteTokens: row.cache_write_tokens,
          totalTokens: row.total_tokens,
        });
        if (estimate.estimateCompleteness !== 'complete') continue;
        const updated = this.db.run(
          `UPDATE usage_measurements
           SET estimate_completeness = 'complete', estimate_amount_micros = ?,
               estimate_currency = ?, price_version_id = ?, price_unknown_reason = NULL
           WHERE execution_id = ?
             AND estimate_completeness = 'unknown'
             AND estimate_amount_micros IS NULL
             AND estimate_currency IS NULL
             AND price_version_id IS NULL
             AND price_unknown_reason IN ('price_unknown', 'price_stale')`,
          estimate.estimateAmountMicros,
          estimate.estimateCurrency,
          estimate.priceVersionId,
          row.execution_id,
        ).changes;
        changed += updated;
        if (updated > 0 && estimate.priceVersionId) catalogIds.add(estimate.priceVersionId);
      }
      if (changed > 0) {
        const ids = [...catalogIds].sort();
        this.appendUsageAudit({
          eventId: `usage:estimates:${ids.join('+')}:backfilled`,
          eventType: 'usage.estimates_backfilled',
          subjectId: ids.join(','),
          subjectVersion: 1,
          createdAt: this.now(),
          metadata: { catalogIds: ids, measurementCount: changed },
        });
      }
      return changed;
    });
  }
}

export interface SqliteUsageStore extends UsageStore {
  close(): void;
}

export class SqliteUsageStore {
  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    const db = openStateDb(path);
    // The Proxy facade drops the `implements` compile check, so this typed
    // binding is the conformance assertion that keeps it: a logic method that
    // stops matching UsageStore fails typecheck here.
    const _conforms: UsageStore = promisify(new UsageStoreLogic(db, now), {
      close: () => db.close(),
    });
    return _conforms as unknown as SqliteUsageStore;
  }
}

function mapOperation(row: OperationRow): UsageOperation {
  return {
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    sourceId: row.source_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    status: row.status,
    startedAt: Number(row.started_at),
    finishedAt: nullableNumber(row.finished_at),
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    agentId: row.profile_id,
    agentLabel: row.profile_label,
    channelId: row.channel_id,
    channelLabel: row.channel_label,
    conversationKind: row.conversation_kind,
    routineId: row.routine_id,
    routineLabel: row.routine_label,
    routineRunId: row.routine_run_id,
    requesterMembershipId: row.requester_membership_id,
    executionPrincipalId: row.execution_principal_id,
    modelSource: row.model_source,
    workspaceDefaultRevision: nullableNumber(row.workspace_default_revision),
    catalogRevision: row.catalog_revision,
    requestedProvider: row.requested_provider,
    requestedModel: row.requested_model,
    credentialRefId: row.credential_ref_id,
    credentialVersion: nullableNumber(row.credential_version),
    coverage: row.coverage,
    telemetrySchemaVersion: Number(row.telemetry_schema_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapMeasurement(row: MeasurementRow): UsageMeasurement {
  return {
    executionId: row.execution_id,
    operationId: row.operation_id,
    ...(row.run_execution_id ? { runExecutionId: row.run_execution_id } : {}),
    operationStatus: row.operation_status,
    observedAt: Number(row.observed_at),
    providerRoute: row.provider_route,
    requestedProvider: row.requested_provider,
    requestedModel: row.requested_model,
    returnedProvider: row.returned_provider,
    returnedModel: row.returned_model,
    credentialRefId: row.credential_ref_id,
    credentialVersion: nullableNumber(row.credential_version),
    usageCompleteness: row.usage_completeness,
    inputTokens: nullableNumber(row.input_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    cacheReadTokens: nullableNumber(row.cache_read_tokens),
    cacheWriteTokens: nullableNumber(row.cache_write_tokens),
    totalTokens: nullableNumber(row.total_tokens),
    usageUnknownReason: row.usage_unknown_reason,
    estimateCompleteness: row.estimate_completeness,
    estimateAmountMicros: nullableNumber(row.estimate_amount_micros),
    estimateCurrency: row.estimate_currency,
    priceVersionId: row.price_version_id,
    priceUnknownReason: row.price_unknown_reason,
    recordedAt: Number(row.recorded_at),
  };
}

function mapCredential(row: CredentialRow): ModelCredentialRecord {
  return {
    credentialRefId: row.credential_ref_id,
    version: Number(row.version),
    providerId: row.provider_id,
    sourceKind: row.source_kind,
    label: row.label,
    scopeLabel: row.scope_label,
    unknownRotation: Boolean(row.unknown_rotation),
    activeFrom: Number(row.active_from),
    retiredAt: nullableNumber(row.retired_at),
  };
}

function mapConnectorUsage(row: ConnectorUsageRow): ConnectorUsageRecord {
  return {
    attemptId: row.attempt_id,
    workspaceId: row.workspace_id,
    agentId: row.profile_id,
    connectionAccountId: row.connection_account_id,
    operationId: row.operation_id,
    runId: row.run_id,
    runExecutionId: row.run_execution_id,
    adapterId: row.adapter_id,
    toolkit: row.toolkit,
    capability: row.capability,
    providerTool: row.provider_tool,
    providerVersion: row.provider_version,
    effectClass: row.effect_class,
    outcome: row.outcome,
    retryClassification: row.retry_classification,
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    latencyMs: Number(row.latency_ms),
    remoteCallCount: Number(row.remote_call_count),
    providerToolCallCount: Number(row.provider_tool_call_count),
    resultBytes: nullableNumber(row.result_bytes),
    httpStatus: nullableNumber(row.http_status),
    rateLimitRemaining: nullableNumber(row.rate_limit_remaining),
    retryAfterMs: nullableNumber(row.retry_after_ms),
    providerLogId: row.provider_log_id,
    priceVersionId: row.price_version_id,
    estimatedCostMicros: nullableNumber(row.estimated_cost_micros),
    estimateCurrency: row.estimate_currency,
    recordedAt: Number(row.recorded_at),
  };
}

function mapConnectorQuotaReservation(
  row: Record<string, unknown>,
  used: number,
): ConnectorQuotaReservation {
  const limit = Number(row.quota_limit);
  return {
    reservationId: String(row.reservation_id),
    workspaceId: String(row.workspace_id),
    adapterId: String(row.adapter_id),
    toolkit: String(row.toolkit),
    bucket: String(row.bucket),
    units: Number(row.units),
    limit,
    periodStart: Number(row.period_start),
    periodEnd: Number(row.period_end),
    used,
    remaining: Math.max(0, limit - used),
    recordedAt: Number(row.recorded_at),
  };
}

function connectorQuotaUsed(db: StateDb, row: Record<string, unknown>): number {
  return Number(db.get(
    `SELECT COALESCE(SUM(units), 0) AS used
     FROM usage_connector_quota_reservations
     WHERE adapter_id = ? AND toolkit = ? AND bucket = ? AND period_start = ?`,
    String(row.adapter_id),
    String(row.toolkit),
    String(row.bucket),
    Number(row.period_start),
  )?.used ?? 0);
}

function sameAdmission(operation: UsageOperation, input: AdmitUsageOperationInput): boolean {
  return operation.operationId === input.operationId &&
    operation.operationKind === input.operationKind &&
    operation.sourceId === input.sourceId &&
    (operation.runId ?? null) === (input.runId ?? null) &&
    operation.startedAt === input.startedAt &&
    operation.installationId === input.installationId &&
    operation.workspaceId === input.workspaceId &&
    operation.agentId === input.agentId &&
    operation.agentLabel === input.agentLabel &&
    operation.channelId === input.channelId &&
    operation.channelLabel === input.channelLabel &&
    operation.conversationKind === input.conversationKind &&
    operation.routineId === (input.routineId ?? null) &&
    operation.routineLabel === (input.routineLabel ?? null) &&
    operation.routineRunId === (input.routineRunId ?? null) &&
    operation.requesterMembershipId === (input.requesterMembershipId ?? null) &&
    operation.executionPrincipalId === (input.executionPrincipalId ?? null) &&
    operation.modelSource === (input.modelSource ?? null) &&
    operation.workspaceDefaultRevision === (input.workspaceDefaultRevision ?? null) &&
    operation.catalogRevision === (input.catalogRevision ?? null) &&
    operation.requestedProvider === input.requestedProvider &&
    operation.requestedModel === input.requestedModel &&
    operation.credentialRefId === input.credentialRefId &&
    operation.credentialVersion === input.credentialVersion;
}

function sameTerminal(measurement: UsageMeasurement, input: RecordUsageTerminalInput): boolean {
  return measurement.executionId === input.executionId &&
    measurement.operationId === input.operationId &&
    (measurement.runExecutionId ?? null) === (input.runExecutionId ?? null) &&
    measurement.operationStatus === input.status &&
    measurement.observedAt === input.observedAt &&
    measurement.providerRoute === input.providerRoute &&
    measurement.requestedProvider === input.requestedProvider &&
    measurement.requestedModel === input.requestedModel &&
    measurement.returnedProvider === input.returnedProvider &&
    measurement.returnedModel === input.returnedModel &&
    measurement.credentialRefId === input.credentialRefId &&
    measurement.credentialVersion === input.credentialVersion &&
    measurement.usageCompleteness === input.usageCompleteness &&
    measurement.inputTokens === input.inputTokens &&
    measurement.outputTokens === input.outputTokens &&
    measurement.cacheReadTokens === (input.cacheReadTokens ?? null) &&
    measurement.cacheWriteTokens === (input.cacheWriteTokens ?? null) &&
    measurement.totalTokens === input.totalTokens &&
    measurement.usageUnknownReason === input.usageUnknownReason &&
    sameEstimate(measurement, input);
}

function sameEstimate(
  measurement: UsageMeasurement,
  input: RecordUsageTerminalInput,
): boolean {
  if (
    measurement.estimateCompleteness === input.estimateCompleteness &&
    measurement.estimateAmountMicros === input.estimateAmountMicros &&
    measurement.estimateCurrency === input.estimateCurrency &&
    measurement.priceVersionId === input.priceVersionId &&
    measurement.priceUnknownReason === input.priceUnknownReason
  ) return true;
  if (
    input.estimateCompleteness !== 'unknown' ||
    input.estimateAmountMicros !== null ||
    input.estimateCurrency !== null ||
    input.priceVersionId !== null ||
    (input.priceUnknownReason !== 'price_unknown' && input.priceUnknownReason !== 'price_stale')
  ) return false;
  const enriched = estimateUsage(input);
  return enriched.estimateCompleteness === 'complete' &&
    measurement.estimateCompleteness === enriched.estimateCompleteness &&
    measurement.estimateAmountMicros === enriched.estimateAmountMicros &&
    measurement.estimateCurrency === enriched.estimateCurrency &&
    measurement.priceVersionId === enriched.priceVersionId &&
    measurement.priceUnknownReason === enriched.priceUnknownReason;
}

function sameCredential(
  credential: ModelCredentialRecord,
  input: PutModelCredentialInput,
): boolean {
  return credential.credentialRefId === input.credentialRefId &&
    credential.version === input.version &&
    credential.providerId === input.providerId &&
    credential.sourceKind === input.sourceKind &&
    credential.label === input.label &&
    credential.scopeLabel === input.scopeLabel &&
    credential.unknownRotation === input.unknownRotation &&
    credential.activeFrom === input.activeFrom;
}

function sameConnectorUsage(
  record: ConnectorUsageRecord,
  input: RecordConnectorUsageInput,
): boolean {
  return record.attemptId === input.attemptId &&
    record.workspaceId === input.workspaceId &&
    record.agentId === input.agentId &&
    record.connectionAccountId === input.connectionAccountId &&
    (record.operationId ?? null) === (input.operationId ?? null) &&
    (record.runId ?? null) === (input.runId ?? null) &&
    (record.runExecutionId ?? null) === (input.runExecutionId ?? null) &&
    record.adapterId === input.adapterId &&
    record.toolkit === input.toolkit &&
    record.capability === input.capability &&
    record.providerTool === input.providerTool &&
    record.providerVersion === input.providerVersion &&
    record.effectClass === input.effectClass &&
    record.outcome === input.outcome &&
    record.retryClassification === input.retryClassification &&
    record.startedAt === input.startedAt &&
    record.finishedAt === input.finishedAt &&
    record.latencyMs === input.latencyMs &&
    record.remoteCallCount === input.remoteCallCount &&
    record.providerToolCallCount === input.providerToolCallCount &&
    record.resultBytes === input.resultBytes &&
    record.httpStatus === input.httpStatus &&
    record.rateLimitRemaining === input.rateLimitRemaining &&
    record.retryAfterMs === input.retryAfterMs &&
    record.providerLogId === input.providerLogId &&
    record.priceVersionId === input.priceVersionId &&
    record.estimatedCostMicros === input.estimatedCostMicros &&
    record.estimateCurrency === input.estimateCurrency;
}

function sameConnectorQuotaReservation(
  record: ConnectorQuotaReservation,
  input: ReserveConnectorQuotaInput,
): boolean {
  return record.reservationId === input.reservationId &&
    record.workspaceId === input.workspaceId &&
    record.adapterId === input.adapterId &&
    record.toolkit === input.toolkit &&
    record.bucket === input.bucket &&
    record.units === input.units &&
    record.limit === input.limit &&
    record.periodStart === input.periodStart &&
    record.periodEnd === input.periodEnd;
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function requiredOperation(row: OperationRow | undefined): UsageOperation {
  if (!row) throw new Error('Usage operation write did not materialize.');
  return mapOperation(row);
}

function requiredDetail(detail: UsageOperationDetail | undefined): UsageOperationDetail {
  if (!detail) throw new Error('Usage terminal write did not materialize.');
  return detail;
}

function requiredCredential(row: CredentialRow | undefined): ModelCredentialRecord {
  if (!row) throw new Error('Usage credential write did not materialize.');
  return mapCredential(row);
}
