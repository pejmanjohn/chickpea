import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import {
  aggregateSelect,
  mapRollupRow,
  usageGroupExpressions,
  usageWhere,
} from './rollups.ts';
import { UsageStateError } from './store-error.ts';
import {
  USAGE_TELEMETRY_SCHEMA_VERSION,
  type AdmitUsageOperationInput,
  type NormalizedUsageQuery,
  type RecordUsageTerminalInput,
  type UsageMeasurement,
  type UsageOperation,
  type UsageOperationDetail,
  type UsageOperationPage,
  type UsageQuery,
  type UsageRpcRequest,
  type UsageRpcResponse,
  type UsageStore,
  type UsageSummary,
} from './types.ts';
import {
  normalizeAdmitUsageOperation,
  normalizeRecordUsageTerminal,
  normalizeUsageQuery,
} from './validation.ts';

export { UsageStateError } from './store-error.ts';

interface OperationRow {
  operation_id: string;
  operation_kind: UsageOperation['operationKind'];
  source_id: string;
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

const OPERATION_COLUMNS = `
  operation_id, operation_kind, source_id, status, started_at, finished_at,
  installation_id, workspace_id, profile_id, profile_label, channel_id,
  channel_label, conversation_kind, routine_id, routine_label, routine_run_id,
  requested_provider, requested_model, credential_ref_id, credential_version,
  coverage, telemetry_schema_version, created_at, updated_at`;

const MEASUREMENT_COLUMNS = `
  execution_id, operation_id, operation_status, observed_at, provider_route,
  requested_provider, requested_model, returned_provider, returned_model,
  credential_ref_id, credential_version, usage_completeness, input_tokens,
  output_tokens, total_tokens, usage_unknown_reason, estimate_completeness,
  estimate_amount_micros, estimate_currency, price_version_id,
  price_unknown_reason, recorded_at`;

export class UsageStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    this.initializeSchema();
  }

  admitOperation(raw: AdmitUsageOperationInput): UsageOperation {
    const input = normalizeAdmitUsageOperation(raw);
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
          ?, ?, ?, 'admitted', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'aggregate_only', ?, ?, ?
        )`,
        input.operationId,
        input.operationKind,
        input.sourceId,
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
      const existing = this.getMeasurementRowForOperation(input.operationId);
      if (existing) {
        const measurement = mapMeasurement(existing);
        if (!sameTerminal(measurement, input) || operation.status !== input.status) {
          throw new UsageStateError(
            'usage_measurement_conflict',
            'Usage operation already has a different terminal measurement.',
            { operationId: input.operationId, executionId: input.executionId },
          );
        }
        return { operation, measurement };
      }
      if (operation.status !== 'admitted' && operation.status !== input.status) {
        throw new UsageStateError(
          'usage_operation_terminal',
          'Usage operation is already terminal.',
          { operationId: input.operationId },
        );
      }
      const recordedAt = this.now();
      this.db.run(
        `INSERT INTO usage_measurements (${MEASUREMENT_COLUMNS}) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
        input.executionId,
        input.operationId,
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
        'UPDATE usage_operations SET status = ?, finished_at = ?, updated_at = ? WHERE operation_id = ?',
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
    const measurementRow = this.getMeasurementRowForOperation(operationId);
    return {
      operation: mapOperation(operationRow),
      measurement: measurementRow ? mapMeasurement(measurementRow) : null,
    };
  }

  listOperations(rawQuery: UsageQuery): UsageOperationPage {
    const query = normalizeUsageQuery(rawQuery);
    const where = usageWhere(query, true);
    const rows = this.db.all(
      `SELECT o.operation_id
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

  execute(request: UsageRpcRequest): UsageRpcResponse {
    switch (request.kind) {
      case 'admit_operation':
        return { kind: 'operation', operation: this.admitOperation(request.input) };
      case 'record_terminal':
        return { kind: 'detail', detail: this.recordTerminal(request.input) };
      case 'get_operation':
        return { kind: 'detail', detail: this.getOperation(request.operationId) ?? null };
      case 'list_operations':
        return { kind: 'operation_page', page: this.listOperations(request.query) };
      case 'summarize':
        return { kind: 'summary', summary: this.summarize(request.query) };
    }
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

  private getMeasurementRowForOperation(operationId: string): MeasurementRow | undefined {
    return this.db.get(
      `SELECT ${MEASUREMENT_COLUMNS} FROM usage_measurements WHERE operation_id = ?`,
      operationId,
    ) as unknown as MeasurementRow | undefined;
  }

  private initializeSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
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
        operation_id TEXT NOT NULL UNIQUE,
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
    ]) this.db.exec(sql);
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

  async listOperations(query: UsageQuery): Promise<UsageOperationPage> {
    return this.logic.listOperations(query);
  }

  async summarize(query: UsageQuery): Promise<UsageSummary> {
    return this.logic.summarize(query);
  }
}

function mapOperation(row: OperationRow): UsageOperation {
  return {
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    sourceId: row.source_id,
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

function sameAdmission(operation: UsageOperation, input: AdmitUsageOperationInput): boolean {
  return operation.operationId === input.operationId &&
    operation.operationKind === input.operationKind &&
    operation.sourceId === input.sourceId &&
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
