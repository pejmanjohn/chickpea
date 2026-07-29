export const USAGE_TELEMETRY_SCHEMA_VERSION = 1;

export const USAGE_OPERATION_KINDS = ['interactive_turn', 'routine_run'] as const;
export type UsageOperationKind = (typeof USAGE_OPERATION_KINDS)[number];

export const USAGE_OPERATION_STATUSES = [
  'admitted',
  'completed',
  'failed',
  'interrupted',
  'incomplete',
] as const;
export type UsageOperationStatus = (typeof USAGE_OPERATION_STATUSES)[number];
export type UsageTerminalStatus = Exclude<UsageOperationStatus, 'admitted'>;

export const USAGE_COMPLETENESS_VALUES = ['complete', 'partial', 'not_reported'] as const;
export type UsageCompleteness = (typeof USAGE_COMPLETENESS_VALUES)[number];

export const USAGE_UNKNOWN_REASONS = [
  'usage_not_reported',
  'usage_partial',
  'stream_interrupted',
  'provider_request_unknown',
  'unsupported_auth',
] as const;
export type UsageUnknownReason = (typeof USAGE_UNKNOWN_REASONS)[number];

export const ESTIMATE_COMPLETENESS_VALUES = [
  'not_priced',
  'complete',
  'partial',
  'unknown',
] as const;
export type EstimateCompleteness = (typeof ESTIMATE_COMPLETENESS_VALUES)[number];

export const PRICE_UNKNOWN_REASONS = [
  'price_unknown',
  'price_stale',
  'pricing_dimension_unknown',
] as const;
export type PriceUnknownReason = (typeof PRICE_UNKNOWN_REASONS)[number];

export const USAGE_CONVERSATION_KINDS = [
  'named_channel',
  'direct_message',
  'unknown',
] as const;
export type UsageConversationKind = (typeof USAGE_CONVERSATION_KINDS)[number];

export interface AdmitUsageOperationInput {
  operationId: string;
  operationKind: UsageOperationKind;
  sourceId: string;
  startedAt: number;
  installationId: string;
  workspaceId: string | null;
  profileId: string | null;
  profileLabel: string | null;
  channelId: string | null;
  channelLabel: string | null;
  conversationKind: UsageConversationKind;
  routineId?: string | null;
  routineLabel?: string | null;
  routineRunId?: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
  credentialRefId: string | null;
  credentialVersion: number | null;
}

export interface UsageOperation {
  operationId: string;
  operationKind: UsageOperationKind;
  sourceId: string;
  status: UsageOperationStatus;
  startedAt: number;
  finishedAt: number | null;
  installationId: string;
  workspaceId: string | null;
  profileId: string | null;
  profileLabel: string | null;
  channelId: string | null;
  channelLabel: string | null;
  conversationKind: UsageConversationKind;
  routineId: string | null;
  routineLabel: string | null;
  routineRunId: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
  credentialRefId: string | null;
  credentialVersion: number | null;
  coverage: 'aggregate_only';
  telemetrySchemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface RecordUsageTerminalInput {
  operationId: string;
  executionId: string;
  status: UsageTerminalStatus;
  finishedAt: number;
  observedAt: number;
  providerRoute: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
  returnedProvider: string | null;
  returnedModel: string | null;
  credentialRefId: string | null;
  credentialVersion: number | null;
  usageCompleteness: UsageCompleteness;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageUnknownReason: UsageUnknownReason | null;
  estimateCompleteness: EstimateCompleteness;
  estimateAmountMicros: number | null;
  estimateCurrency: string | null;
  priceVersionId: string | null;
  priceUnknownReason: PriceUnknownReason | null;
}

export interface UsageMeasurement extends Omit<RecordUsageTerminalInput, 'status' | 'finishedAt'> {
  operationStatus: UsageTerminalStatus;
  recordedAt: number;
}

export interface UsageOperationDetail {
  operation: UsageOperation;
  measurements: UsageMeasurement[];
}

export const USAGE_GROUP_BY_VALUES = [
  'profile',
  'channel',
  'work_kind',
  'routine',
  'provider',
  'credential',
  'model',
  'status',
] as const;
export type UsageGroupBy = (typeof USAGE_GROUP_BY_VALUES)[number];

export interface UsageFilters {
  workspace?: string[];
  profile?: string[];
  channel?: string[];
  workKind?: UsageOperationKind[];
  routine?: string[];
  provider?: string[];
  credential?: string[];
  model?: string[];
  status?: UsageOperationStatus[];
}

export interface UsageCursor {
  startedAt: number;
  operationId: string;
}

export interface UsageQuery {
  from: number;
  to: number;
  filters?: UsageFilters;
  groupBy?: UsageGroupBy;
  currency?: string;
  limit?: number;
  cursor?: UsageCursor;
}

export interface NormalizedUsageQuery {
  from: number;
  to: number;
  filters: UsageFilters;
  groupBy: UsageGroupBy | null;
  currency: string | null;
  limit: number;
  cursor: UsageCursor | null;
}

export interface UsageRollupValues {
  operationCount: number;
  completedOperationCount: number;
  failedOperationCount: number;
  incompleteOperationCount: number;
  meteredOperationCount: number;
  pricedOperationCount: number;
  unknownUsageOperationCount: number;
  unknownPriceOperationCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimateAmountMicros: number | null;
}

export interface UsageRollupGroup extends UsageRollupValues {
  key: string;
  label: string;
}

export interface UsageSummary {
  from: number;
  to: number;
  groupBy: UsageGroupBy | null;
  currency: string | null;
  mixedCurrency: boolean;
  availableCurrencies: string[];
  totals: UsageRollupValues;
  groups: UsageRollupGroup[];
}

export interface UsageOperationPage {
  items: UsageOperationDetail[];
  nextCursor: UsageCursor | null;
}

export const MODEL_CREDENTIAL_SOURCE_KINDS = [
  'stored',
  'environment',
  'cloudflare_binding',
  'custom',
] as const;
export type ModelCredentialSourceKind = (typeof MODEL_CREDENTIAL_SOURCE_KINDS)[number];

export interface PutModelCredentialInput {
  credentialRefId: string;
  version: number;
  providerId: string;
  sourceKind: ModelCredentialSourceKind;
  label: string;
  scopeLabel: string | null;
  unknownRotation: boolean;
  activeFrom: number;
}

export interface ModelCredentialRecord extends PutModelCredentialInput {
  retiredAt: number | null;
}

export type UsageRpcRequest =
  | { kind: 'admit_operation'; input: AdmitUsageOperationInput }
  | { kind: 'record_terminal'; input: RecordUsageTerminalInput }
  | { kind: 'get_operation'; operationId: string }
  | { kind: 'list_operations'; query: UsageQuery }
  | { kind: 'summarize'; query: UsageQuery }
  | { kind: 'put_credential'; input: PutModelCredentialInput }
  | { kind: 'retire_credential'; credentialRefId: string; version: number; retiredAt: number }
  | { kind: 'list_credentials'; providerId?: string };

export type UsageRpcResponse =
  | { kind: 'operation'; operation: UsageOperation }
  | { kind: 'detail'; detail: UsageOperationDetail | null }
  | { kind: 'operation_page'; page: UsageOperationPage }
  | { kind: 'summary'; summary: UsageSummary }
  | { kind: 'credential'; credential: ModelCredentialRecord }
  | { kind: 'credentials'; credentials: ModelCredentialRecord[] };

export interface UsageStore {
  admitOperation(input: AdmitUsageOperationInput): Promise<UsageOperation>;
  recordTerminal(input: RecordUsageTerminalInput): Promise<UsageOperationDetail>;
  getOperation(operationId: string): Promise<UsageOperationDetail | undefined>;
  listOperations(query: UsageQuery): Promise<UsageOperationPage>;
  summarize(query: UsageQuery): Promise<UsageSummary>;
  putCredential(input: PutModelCredentialInput): Promise<ModelCredentialRecord>;
  retireCredential(
    credentialRefId: string,
    version: number,
    retiredAt: number,
  ): Promise<ModelCredentialRecord>;
  listCredentials(providerId?: string): Promise<ModelCredentialRecord[]>;
  close?(): void;
}
