import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
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

const OPERATION_COLUMNS = `
  operation_id, operation_kind, source_id, run_id, status, started_at, finished_at,
  installation_id, workspace_id, profile_id, profile_label, channel_id,
  channel_label, conversation_kind, routine_id, routine_label, routine_run_id,
  requested_provider, requested_model, credential_ref_id, credential_version,
  coverage, telemetry_schema_version, created_at, updated_at`;

const MEASUREMENT_COLUMNS = `
  execution_id, operation_id, run_execution_id, operation_status, observed_at, provider_route,
  requested_provider, requested_model, returned_provider, returned_model,
  credential_ref_id, credential_version, usage_completeness, input_tokens,
  output_tokens, total_tokens, usage_unknown_reason, estimate_completeness,
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
          ?, ?, ?, ?, 'admitted', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'aggregate_only', ?, ?, ?
        )`,
        input.operationId,
        input.operationKind,
        input.sourceId,
        input.runId ?? null,
        input.startedAt,
        input.installationId,
        input.workspaceId,
        input.profileId,
        input.profileLabel,
        input.channelId,
        input.channelLabel,
        input.conversationKind,
        input.routineId ?? null,
        input.routineLabel ?? null,
        input.routineRunId ?? null,
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
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
            input_tokens, output_tokens, total_tokens,
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
      if (operationsDeleted > 0 || aggregateDaysDeleted > 0) {
        this.appendUsageAudit({
          eventId: `usage:retention:${at}`,
          eventType: 'usage.retention_applied',
          subjectId: 'usage-ledger',
          subjectVersion: 1,
          createdAt: at,
          metadata: { operationsDeleted, measurementsDeleted, aggregateDaysDeleted },
        });
      }
      return {
        ...this.getRetentionStatus(),
        operationsDeleted,
        measurementsDeleted,
        aggregateDaysDeleted,
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
      'CREATE INDEX IF NOT EXISTS usage_credentials_provider_idx ON usage_credentials (provider_id, retired_at, credential_ref_id, version)',
    ]) this.db.exec(sql);
    const operationColumns = this.db.all('PRAGMA table_info(usage_operations)');
    if (!operationColumns.some((row) => row.name === 'run_id')) {
      this.db.exec('ALTER TABLE usage_operations ADD COLUMN run_id TEXT');
    }
    const measurementColumns = this.db.all('PRAGMA table_info(usage_measurements)');
    if (!measurementColumns.some((row) => row.name === 'run_execution_id')) {
      this.db.exec('ALTER TABLE usage_measurements ADD COLUMN run_execution_id TEXT');
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS usage_operations_run_idx ON usage_operations (run_id) WHERE run_id IS NOT NULL',
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS usage_measurements_run_execution_idx ON usage_measurements (run_execution_id) WHERE run_execution_id IS NOT NULL',
    );
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
  }
}

export class SqliteUsageStore implements UsageStore {
  private readonly db: NodeStateDb;
  private readonly logic: UsageStoreLogic;

  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.logic = new UsageStoreLogic(this.db, now);
  }

  close(): void {
    this.db.close();
  }

  async admitOperation(input: AdmitUsageOperationInput): Promise<UsageOperation> {
    return this.logic.admitOperation(input);
  }

  async recordTerminal(input: RecordUsageTerminalInput): Promise<UsageOperationDetail> {
    return this.logic.recordTerminal(input);
  }

  async getOperation(operationId: string): Promise<UsageOperationDetail | undefined> {
    return this.logic.getOperation(operationId);
  }

  async getOperationByRunId(runId: string): Promise<UsageOperationDetail | undefined> {
    return this.logic.getOperationByRunId(runId);
  }

  async listOperations(query: UsageQuery): Promise<UsageOperationPage> {
    return this.logic.listOperations(query);
  }

  async summarize(query: UsageQuery): Promise<UsageSummary> {
    return this.logic.summarize(query);
  }

  async putCredential(input: PutModelCredentialInput): Promise<ModelCredentialRecord> {
    return this.logic.putCredential(input);
  }

  async retireCredential(
    credentialRefId: string,
    version: number,
    retiredAt: number,
  ): Promise<ModelCredentialRecord> {
    return this.logic.retireCredential(credentialRefId, version, retiredAt);
  }

  async listCredentials(providerId?: string): Promise<ModelCredentialRecord[]> {
    return this.logic.listCredentials(providerId);
  }

  async cleanupRetention(at?: number): Promise<UsageRetentionResult> {
    return this.logic.cleanupRetention(at);
  }

  async getRetentionStatus(): Promise<UsageRetentionStatus> {
    return this.logic.getRetentionStatus();
  }

  async listUsageAuditEvents(limit?: number): Promise<AuditEvent[]> {
    return this.logic.listUsageAuditEvents(limit);
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
    profileId: row.profile_id,
    profileLabel: row.profile_label,
    channelId: row.channel_id,
    channelLabel: row.channel_label,
    conversationKind: row.conversation_kind,
    routineId: row.routine_id,
    routineLabel: row.routine_label,
    routineRunId: row.routine_run_id,
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

function sameAdmission(operation: UsageOperation, input: AdmitUsageOperationInput): boolean {
  return operation.operationId === input.operationId &&
    operation.operationKind === input.operationKind &&
    operation.sourceId === input.sourceId &&
    (operation.runId ?? null) === (input.runId ?? null) &&
    operation.startedAt === input.startedAt &&
    operation.installationId === input.installationId &&
    operation.workspaceId === input.workspaceId &&
    operation.profileId === input.profileId &&
    operation.profileLabel === input.profileLabel &&
    operation.channelId === input.channelId &&
    operation.channelLabel === input.channelLabel &&
    operation.conversationKind === input.conversationKind &&
    operation.routineId === (input.routineId ?? null) &&
    operation.routineLabel === (input.routineLabel ?? null) &&
    operation.routineRunId === (input.routineRunId ?? null) &&
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
    measurement.totalTokens === input.totalTokens &&
    measurement.usageUnknownReason === input.usageUnknownReason &&
    measurement.estimateCompleteness === input.estimateCompleteness &&
    measurement.estimateAmountMicros === input.estimateAmountMicros &&
    measurement.estimateCurrency === input.estimateCurrency &&
    measurement.priceVersionId === input.priceVersionId &&
    measurement.priceUnknownReason === input.priceUnknownReason;
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
