import {
  ESTIMATE_COMPLETENESS_VALUES,
  MODEL_CREDENTIAL_SOURCE_KINDS,
  PRICE_UNKNOWN_REASONS,
  USAGE_COMPLETENESS_VALUES,
  USAGE_CONVERSATION_KINDS,
  USAGE_GROUP_BY_VALUES,
  USAGE_OPERATION_KINDS,
  USAGE_OPERATION_STATUSES,
  USAGE_UNKNOWN_REASONS,
  type AdmitUsageOperationInput,
  type NormalizedUsageQuery,
  type PutModelCredentialInput,
  type RecordUsageTerminalInput,
  type UsageFilters,
  type UsageQuery,
  type UsageTerminalStatus,
} from './types.ts';
import { UsageStateError } from './store-error.ts';
import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
} from '../security/content-validation.ts';

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/;
const MAX_QUERY_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_FILTER_VALUES = 10;
const MAX_LABEL_BYTES = 160;
const MAX_MODEL_BYTES = 320;

export function normalizeAdmitUsageOperation(input: AdmitUsageOperationInput): AdmitUsageOperationInput {
  const operationKind = enumValue(input.operationKind, USAGE_OPERATION_KINDS, 'operation kind');
  const conversationKind = enumValue(
    input.conversationKind,
    USAGE_CONVERSATION_KINDS,
    'conversation kind',
  );
  const channelLabel = conversationKind === 'direct_message'
    ? null
    : optionalLabel(input.channelLabel, 'channel label');
  const credentialVersion = optionalPositiveInteger(input.credentialVersion, 'credential version');
  const normalized: AdmitUsageOperationInput = {
    operationId: opaqueId(input.operationId, 'operation ID'),
    operationKind,
    sourceId: opaqueId(input.sourceId, 'source ID'),
    ...(input.runId ? { runId: opaqueId(input.runId, 'Run ID') } : {}),
    startedAt: timestamp(input.startedAt, 'started time'),
    installationId: opaqueId(input.installationId, 'installation ID'),
    workspaceId: optionalId(input.workspaceId, 'workspace ID'),
    profileId: optionalId(input.profileId, 'profile ID'),
    profileLabel: optionalLabel(input.profileLabel, 'profile label'),
    channelId: optionalId(input.channelId, 'channel ID'),
    channelLabel,
    conversationKind,
    routineId: optionalId(input.routineId ?? null, 'routine ID'),
    routineLabel: optionalLabel(input.routineLabel ?? null, 'routine label'),
    routineRunId: optionalId(input.routineRunId ?? null, 'routine run ID'),
    requestedProvider: optionalId(input.requestedProvider, 'requested provider'),
    requestedModel: optionalModel(input.requestedModel, 'requested model'),
    credentialRefId: optionalId(input.credentialRefId, 'credential reference'),
    credentialVersion,
  };
  if (operationKind === 'routine_run' && !normalized.routineRunId) {
    invalid('A routine operation requires a routine run ID.');
  }
  if (operationKind !== 'routine_run' && normalized.routineRunId) {
    invalid('A non-routine operation cannot carry a routine run ID.');
  }
  if ((normalized.credentialRefId === null) !== (normalized.credentialVersion === null)) {
    invalid('Credential reference and version must be recorded together.');
  }
  return normalized;
}

export function normalizeRecordUsageTerminal(
  input: RecordUsageTerminalInput,
): RecordUsageTerminalInput {
  const usageCompleteness = enumValue(
    input.usageCompleteness,
    USAGE_COMPLETENESS_VALUES,
    'usage completeness',
  );
  const estimateCompleteness = enumValue(
    input.estimateCompleteness,
    ESTIMATE_COMPLETENESS_VALUES,
    'estimate completeness',
  );
  const normalized: RecordUsageTerminalInput = {
    operationId: opaqueId(input.operationId, 'operation ID'),
    executionId: opaqueId(input.executionId, 'execution ID'),
    ...(input.runExecutionId
      ? { runExecutionId: opaqueId(input.runExecutionId, 'Run execution ID') }
      : {}),
    status: terminalStatus(input.status),
    finishedAt: timestamp(input.finishedAt, 'finished time'),
    observedAt: timestamp(input.observedAt, 'observed time'),
    providerRoute: optionalId(input.providerRoute, 'provider route'),
    requestedProvider: optionalId(input.requestedProvider, 'requested provider'),
    requestedModel: optionalModel(input.requestedModel, 'requested model'),
    returnedProvider: optionalId(input.returnedProvider, 'returned provider'),
    returnedModel: optionalModel(input.returnedModel, 'returned model'),
    credentialRefId: optionalId(input.credentialRefId, 'credential reference'),
    credentialVersion: optionalPositiveInteger(input.credentialVersion, 'credential version'),
    usageCompleteness,
    inputTokens: optionalTokenCount(input.inputTokens, 'input tokens'),
    outputTokens: optionalTokenCount(input.outputTokens, 'output tokens'),
    totalTokens: optionalTokenCount(input.totalTokens, 'total tokens'),
    usageUnknownReason: optionalEnum(
      input.usageUnknownReason,
      USAGE_UNKNOWN_REASONS,
      'usage unknown reason',
    ),
    estimateCompleteness,
    estimateAmountMicros: optionalMoney(input.estimateAmountMicros),
    estimateCurrency: optionalCurrency(input.estimateCurrency),
    priceVersionId: optionalId(input.priceVersionId, 'price version ID'),
    priceUnknownReason: optionalEnum(
      input.priceUnknownReason,
      PRICE_UNKNOWN_REASONS,
      'price unknown reason',
    ),
  };
  validateCredentialPair(normalized.credentialRefId, normalized.credentialVersion);
  validateUsage(normalized);
  validateEstimate(normalized);
  return normalized;
}

export function normalizeModelCredential(
  input: PutModelCredentialInput,
): PutModelCredentialInput {
  return {
    credentialRefId: opaqueId(input.credentialRefId, 'credential reference'),
    version: positiveInteger(input.version, 'credential version'),
    providerId: opaqueId(input.providerId, 'credential provider'),
    sourceKind: enumValue(input.sourceKind, MODEL_CREDENTIAL_SOURCE_KINDS, 'credential source'),
    label: requiredLabel(input.label, 'credential label'),
    scopeLabel: optionalLabel(input.scopeLabel, 'credential scope'),
    unknownRotation: Boolean(input.unknownRotation),
    activeFrom: timestamp(input.activeFrom, 'credential activation time'),
  };
}

export function normalizeCredentialRetirement(
  credentialRefId: string,
  version: number,
  retiredAt: number,
): { credentialRefId: string; version: number; retiredAt: number } {
  return {
    credentialRefId: opaqueId(credentialRefId, 'credential reference'),
    version: positiveInteger(version, 'credential version'),
    retiredAt: timestamp(retiredAt, 'credential retirement time'),
  };
}

export function normalizeUsageQuery(input: UsageQuery): NormalizedUsageQuery {
  const from = timestamp(input.from, 'query start');
  const to = timestamp(input.to, 'query end');
  if (to <= from || to - from > MAX_QUERY_RANGE_MS) {
    queryInvalid('Usage query range must be positive and at most 366 days.');
  }
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    queryInvalid('Usage query limit must be between 1 and 100.');
  }
  const filters = normalizeFilters(input.filters ?? {});
  const groupBy = input.groupBy === undefined
    ? null
    : enumValue(input.groupBy, USAGE_GROUP_BY_VALUES, 'grouping', true);
  const currency = input.currency === undefined ? null : optionalCurrency(input.currency);
  const cursor = input.cursor === undefined
    ? null
    : {
        startedAt: timestamp(input.cursor.startedAt, 'cursor time', true),
        operationId: opaqueId(input.cursor.operationId, 'cursor operation ID', true),
      };
  return { from, to, filters, groupBy, currency, limit, cursor };
}

function normalizeFilters(filters: UsageFilters): UsageFilters {
  const normalized: UsageFilters = {};
  assignFilter(normalized, 'workspace', filters.workspace, (value) => opaqueId(value, 'workspace filter', true));
  assignFilter(normalized, 'profile', filters.profile, (value) => opaqueId(value, 'profile filter', true));
  assignFilter(normalized, 'channel', filters.channel, (value) => opaqueId(value, 'channel filter', true));
  assignFilter(normalized, 'routine', filters.routine, (value) => opaqueId(value, 'routine filter', true));
  assignFilter(normalized, 'provider', filters.provider, (value) => opaqueId(value, 'provider filter', true));
  assignFilter(normalized, 'credential', filters.credential, (value) => opaqueId(value, 'credential filter', true));
  assignFilter(normalized, 'model', filters.model, (value) => model(value, 'model filter', true));
  assignFilter(normalized, 'workKind', filters.workKind, (value) =>
    enumValue(value, USAGE_OPERATION_KINDS, 'work kind filter', true));
  assignFilter(normalized, 'status', filters.status, (value) =>
    enumValue(value, USAGE_OPERATION_STATUSES, 'status filter', true));
  return normalized;
}

function assignFilter<K extends keyof UsageFilters>(
  target: UsageFilters,
  key: K,
  values: UsageFilters[K] | undefined,
  normalize: (value: NonNullable<UsageFilters[K]>[number]) => NonNullable<UsageFilters[K]>[number],
): void {
  if (values === undefined) return;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_FILTER_VALUES) {
    queryInvalid(`Usage ${String(key)} filter must contain 1-${MAX_FILTER_VALUES} values.`);
  }
  const unique = [...new Set(values.map((value) => normalize(value as never)))] as NonNullable<UsageFilters[K]>;
  Object.assign(target, { [key]: unique });
}

function validateUsage(input: RecordUsageTerminalInput): void {
  const values = [input.inputTokens, input.outputTokens, input.totalTokens];
  const known = values.filter((value) => value !== null).length;
  if (input.usageCompleteness === 'complete') {
    if (known !== 3 || input.usageUnknownReason !== null) {
      invalid('Complete usage requires all aggregate token fields and no unknown reason.');
    }
    return;
  }
  if (input.usageCompleteness === 'partial') {
    if (known === 0 || known === 3 || input.usageUnknownReason !== 'usage_partial') {
      invalid('Partial usage requires some aggregate token fields and usage_partial.');
    }
    return;
  }
  if (known !== 0 || input.usageUnknownReason === null) {
    invalid('Unreported usage requires null token fields and an unknown reason.');
  }
}

function validateEstimate(input: RecordUsageTerminalInput): void {
  if (input.estimateCompleteness === 'complete') {
    if (
      input.estimateAmountMicros === null ||
      input.estimateCurrency === null ||
      input.priceVersionId === null ||
      input.priceUnknownReason !== null
    ) {
      invalid('A complete estimate requires amount, currency, price version, and no unknown reason.');
    }
    return;
  }
  if (
    input.estimateAmountMicros !== null ||
    input.estimateCurrency !== null ||
    input.priceVersionId !== null ||
    input.priceUnknownReason === null
  ) {
    invalid('An incomplete estimate must remain null with an explicit reason.');
  }
}

function validateCredentialPair(ref: string | null, version: number | null): void {
  if ((ref === null) !== (version === null)) {
    invalid('Credential reference and version must be recorded together.');
  }
}

function terminalStatus(value: UsageTerminalStatus): UsageTerminalStatus {
  const status = enumValue(value, USAGE_OPERATION_STATUSES, 'terminal status');
  if (status === 'admitted') invalid('Terminal status cannot be admitted.');
  return status as UsageTerminalStatus;
}

function opaqueId(value: unknown, label: string, query = false): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) fail(`${label} is invalid.`, query);
  return value as string;
}

function optionalId(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : opaqueId(value, label);
}

function model(value: unknown, label: string, query = false): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is invalid.`, query);
  const result = value as string;
  if (byteLength(result) > MAX_MODEL_BYTES || hasDisallowedControlCharacter(result) || hasCredentialLikeContent(result)) {
    fail(`${label} is invalid.`, query);
  }
  return result;
}

function optionalModel(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : model(value, label);
}

function optionalLabel(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') invalid(`${label} is invalid.`);
  const result = (value as string).trim();
  if (
    result.length === 0 ||
    byteLength(result) > MAX_LABEL_BYTES ||
    hasDisallowedControlCharacter(result) ||
    hasCredentialLikeContent(result)
  ) {
    invalid(`${label} is invalid.`);
  }
  return result;
}

function requiredLabel(value: unknown, label: string): string {
  const normalized = optionalLabel(value, label);
  if (normalized === null) invalid(`${label} is required.`);
  return normalized;
}

function timestamp(value: unknown, label: string, query = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is invalid.`, query);
  return value as number;
}

function optionalPositiveInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} is invalid.`);
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = optionalPositiveInteger(value, label);
  if (normalized === null) invalid(`${label} is required.`);
  return normalized;
}

function optionalTokenCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} is invalid.`);
  return value as number;
}

function optionalMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('Estimate amount is invalid.');
  return value as number;
}

function optionalCurrency(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    invalid('Estimate currency is invalid.');
  }
  return value as string;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | null {
  return value === null || value === undefined ? null : enumValue(value, allowed, label);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  query = false,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(`${label} is invalid.`, query);
  return value as T;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function fail(message: string, query: boolean): never {
  if (query) queryInvalid(message);
  return invalid(message);
}

function invalid(message: string): never {
  throw new UsageStateError('usage_invalid_input', message);
}

function queryInvalid(message: string): never {
  throw new UsageStateError('usage_query_invalid', message);
}
