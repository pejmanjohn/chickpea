import type { SqlParam } from '../state/state-db.ts';
import type {
  NormalizedUsageQuery,
  UsageGroupBy,
  UsageRollupValues,
} from './types.ts';

export interface UsageWhereClause {
  sql: string;
  params: SqlParam[];
}

const FILTER_COLUMNS = {
  workspace: 'o.workspace_id',
  profile: 'o.profile_id',
  channel: 'o.channel_id',
  workKind: 'o.operation_kind',
  routine: 'o.routine_id',
  provider: 'COALESCE(m.returned_provider, m.provider_route, o.requested_provider)',
  credential: 'COALESCE(m.credential_ref_id, o.credential_ref_id)',
  model: 'COALESCE(m.returned_model, m.requested_model, o.requested_model)',
  status: 'o.status',
} as const;

export function usageWhere(query: NormalizedUsageQuery, includeCursor = false): UsageWhereClause {
  const clauses = ['o.started_at >= ?', 'o.started_at < ?'];
  const params: SqlParam[] = [query.from, query.to];
  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    const values = query.filters[key as keyof typeof FILTER_COLUMNS];
    if (!values || values.length === 0) continue;
    clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }
  if (includeCursor && query.cursor) {
    clauses.push('(o.started_at < ? OR (o.started_at = ? AND o.operation_id < ?))');
    params.push(query.cursor.startedAt, query.cursor.startedAt, query.cursor.operationId);
  }
  return { sql: clauses.join(' AND '), params };
}

export function usageGroupExpressions(groupBy: UsageGroupBy): {
  key: string;
  label: string;
} {
  switch (groupBy) {
    case 'profile':
      return {
        key: "COALESCE(o.profile_id, 'unknown')",
        label: "COALESCE(o.profile_label, o.profile_id, 'Unknown profile')",
      };
    case 'channel':
      return {
        key: "CASE WHEN o.conversation_kind = 'direct_message' THEN 'direct_message' ELSE COALESCE(o.channel_id, 'unknown') END",
        label: "CASE WHEN o.conversation_kind = 'direct_message' THEN 'Direct message' ELSE COALESCE(o.channel_label, o.channel_id, 'Unknown channel') END",
      };
    case 'work_kind':
      return { key: 'o.operation_kind', label: 'o.operation_kind' };
    case 'routine':
      return {
        key: "COALESCE(o.routine_id, 'not_routine')",
        label: "COALESCE(o.routine_label, o.routine_id, 'Not scheduled work')",
      };
    case 'provider':
      return {
        key: "COALESCE(m.returned_provider, m.provider_route, o.requested_provider, 'unknown')",
        label: "COALESCE(m.returned_provider, m.provider_route, o.requested_provider, 'Unknown provider')",
      };
    case 'credential':
      return {
        key: "COALESCE(m.credential_ref_id, o.credential_ref_id, 'unknown')",
        label: "COALESCE(m.credential_ref_id, o.credential_ref_id, 'Unknown credential')",
      };
    case 'model':
      return {
        key: "COALESCE(m.returned_model, m.requested_model, o.requested_model, 'unknown')",
        label: "COALESCE(m.returned_model, m.requested_model, o.requested_model, 'Unknown model')",
      };
    case 'status':
      return { key: 'o.status', label: 'o.status' };
  }
}

export function aggregateSelect(currency: string | null): { sql: string; params: SqlParam[] } {
  const compatibleEstimate = currency
    ? 'CASE WHEN m.estimate_completeness = \'complete\' AND m.estimate_currency = ? THEN m.estimate_amount_micros END'
    : 'CASE WHEN m.estimate_completeness = \'complete\' THEN m.estimate_amount_micros END';
  return {
    sql: `
      COUNT(*) AS operation_count,
      SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) AS completed_operation_count,
      SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END) AS failed_operation_count,
      SUM(CASE WHEN o.status IN ('interrupted', 'incomplete', 'admitted') THEN 1 ELSE 0 END) AS incomplete_operation_count,
      SUM(CASE WHEN m.usage_completeness IN ('complete', 'partial') THEN 1 ELSE 0 END) AS metered_operation_count,
      SUM(CASE WHEN m.estimate_completeness = 'complete' THEN 1 ELSE 0 END) AS priced_operation_count,
      SUM(CASE WHEN m.execution_id IS NULL OR m.usage_completeness = 'not_reported' THEN 1 ELSE 0 END) AS unknown_usage_operation_count,
      SUM(CASE WHEN m.execution_id IS NULL OR m.estimate_completeness != 'complete' THEN 1 ELSE 0 END) AS unknown_price_operation_count,
      SUM(m.input_tokens) AS input_tokens,
      SUM(m.output_tokens) AS output_tokens,
      SUM(m.total_tokens) AS total_tokens,
      SUM(${compatibleEstimate}) AS estimate_amount_micros`,
    params: currency ? [currency] : [],
  };
}

export function mapRollupRow(row: Record<string, unknown>): UsageRollupValues {
  return {
    operationCount: integer(row.operation_count),
    completedOperationCount: integer(row.completed_operation_count),
    failedOperationCount: integer(row.failed_operation_count),
    incompleteOperationCount: integer(row.incomplete_operation_count),
    meteredOperationCount: integer(row.metered_operation_count),
    pricedOperationCount: integer(row.priced_operation_count),
    unknownUsageOperationCount: integer(row.unknown_usage_operation_count),
    unknownPriceOperationCount: integer(row.unknown_price_operation_count),
    inputTokens: nullableInteger(row.input_tokens),
    outputTokens: nullableInteger(row.output_tokens),
    totalTokens: nullableInteger(row.total_tokens),
    estimateAmountMicros: nullableInteger(row.estimate_amount_micros),
  };
}

function integer(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
