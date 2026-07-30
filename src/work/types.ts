import type { AuditEvent } from '../audit/types.ts';
import type { ProviderAuthRoute } from '../config/runtime-model.ts';

declare const workIdBrand: unique symbol;
declare const bindingIdBrand: unique symbol;
declare const runIdBrand: unique symbol;
declare const runExecutionIdBrand: unique symbol;
declare const configRevisionIdBrand: unique symbol;
declare const ledgerContentRefBrand: unique symbol;

export type WorkId = string & { readonly [workIdBrand]: true };
export type BindingId = string & { readonly [bindingIdBrand]: true };
export type RunId = string & { readonly [runIdBrand]: true };
export type RunExecutionId = string & { readonly [runExecutionIdBrand]: true };
export type EffectiveConfigRevisionId = string & { readonly [configRevisionIdBrand]: true };
export type LedgerContentRef = string & { readonly [ledgerContentRefBrand]: true };

export type WorkKind = 'conversation' | 'routine' | 'web_admin';
export type WorkLifecycle = 'open' | 'closed' | 'expired';
export type WorkSensitivity = 'public' | 'private';
export type BindingAdapterKind = 'slack' | 'routine' | 'web_admin' | 'conformance';
export type BindingLifecycle = 'active' | 'closed' | 'expired';
export type SourceVisibility = 'public' | 'private' | 'unknown';
export type BindingConfigMode = 'frozen_on_open' | 'resolve_each_run';
export type RunKind = 'interactive' | 'routine' | 'operator';
export type RunStatus =
  | 'admitted'
  | 'queued'
  | 'preparing_input'
  | 'input_ready'
  | 'executing'
  | 'response_ready'
  | 'settled'
  | 'recovery_required';
export type RunDisposition =
  | 'succeeded'
  | 'no_op'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'superseded'
  | 'quarantined';
export type RunDeliveryStatus =
  | 'not_ready'
  | 'pending'
  | 'delivered'
  | 'failed'
  | 'unknown'
  | 'not_applicable';
export type RunExecutionAuthority = 'legacy' | 'ledger';
export type RunCoordinatorKind = 'interactive' | 'flue_workflow';
export type ActorTrustTier = 'member' | 'operator' | 'system' | 'unknown';
export type RunExecutionOutcome =
  | 'pending'
  | 'not_submitted'
  | 'succeeded'
  | 'failed'
  | 'ambiguous';
export type ModelInvocationStatus = 'not_invoked' | 'ready' | 'invoked' | 'settled';
export type ContentSensitivity = 'public' | 'private';

export interface WorkRecord {
  id: WorkId;
  kind: WorkKind;
  lifecycle: WorkLifecycle;
  maximumSensitivity: WorkSensitivity;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface BindingRecord {
  id: BindingId;
  workId: WorkId;
  adapterKind: BindingAdapterKind;
  externalAccountId: string;
  externalConversationId: string;
  generation: number;
  lifecycle: BindingLifecycle;
  sourceVisibility: SourceVisibility;
  configMode: BindingConfigMode;
  pinnedConfigRevisionId: EffectiveConfigRevisionId | null;
  orderingKey: string;
  createdAt: number;
  expiredAt: number | null;
}

export interface RunRecord {
  id: RunId;
  workId: WorkId;
  bindingId: BindingId;
  kind: RunKind;
  admissionSequence: number;
  triggerKind: string;
  triggerRef: string;
  dedupeKey: string;
  actorRef: string | null;
  actorTrustTier: ActorTrustTier;
  sourceContextWatermark: string | null;
  triggerContentRef: LedgerContentRef | null;
  preparedInputRef: LedgerContentRef | null;
  configRevisionId: EffectiveConfigRevisionId;
  effectiveCapabilityDigest: string;
  executionAuthority: RunExecutionAuthority;
  coordinatorKind: RunCoordinatorKind;
  authorityEpoch: number;
  policyApprovedOutputRef: LedgerContentRef | null;
  renderedPayloadRef: LedgerContentRef | null;
  status: RunStatus;
  terminalDisposition: RunDisposition | null;
  deliveryStatus: RunDeliveryStatus;
  deliveryMethod: string | null;
  deliveryAttemptId: string | null;
  deliveryRef: string | null;
  deliveryFinalizedAt: number | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  fencingToken: number;
  safeFailureCode: string | null;
  recoveryResolutionKind: 'authoritative_reconciliation' | 'quarantine' | null;
  recoveryAdminCredentialId: string | null;
  recoveryOperatorLabel: string | null;
  recoveryAuthOrigin: string | null;
  recoveryReasonCode: string | null;
  recoveryRequestId: string | null;
  recoveryResolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface RunExecutionRecord {
  id: RunExecutionId;
  runId: RunId;
  attemptNumber: number;
  fencingToken: number;
  executorKind: 'agent' | 'workflow';
  agentName: string;
  flueInstanceRef: string | null;
  flueSubmissionRef: string | null;
  canonicalModel: string;
  providerAuthRoute: ProviderAuthRoute | null;
  catalogSource: string | null;
  catalogRevision: string | null;
  catalogDigest: string | null;
  compiledProfile: string | null;
  modelCredentialRef: string | null;
  modelCredentialVersion: number | null;
  modelInvocationStatus: ModelInvocationStatus;
  startedAt: number;
  finishedAt: number | null;
  rawSettlementRef: string | null;
  rawSettlementStatus: string | null;
  outcome: RunExecutionOutcome;
  safeDisagreementCode: string | null;
  safeFailureCode: string | null;
}

export interface EffectiveConfigRevision {
  id: EffectiveConfigRevisionId;
  canonicalJson: string;
  digest: string;
  schemaVersion: 1;
  createdAt: number;
}

export interface SafeEffectiveConfigInput {
  schemaVersion: 1;
  profileId: string;
  configuredModel: string;
  snapshotDigest: string;
  capabilityDigest: string;
  skillNames: string[];
  connectionIds: string[];
  repositoryIds: string[];
  memoryMode: 'disabled' | 'public' | 'private' | 'mixed';
  ceilings: {
    maxModelAttempts: number;
    maxToolCalls: number;
    maxActionAttempts: number;
    timeoutMs: number;
  };
}

export interface LedgerContentRecord {
  ref: LedgerContentRef;
  schemaVersion: 1;
  sensitivity: ContentSensitivity;
  expiresAt: number;
  body: string | null;
  byteSize: number;
  createdAt: number;
  purgedAt: number | null;
}

export interface PutLedgerContentInput {
  sensitivity: ContentSensitivity;
  body: string;
  createdAt?: number;
}

export interface CreateWorkInput {
  id: WorkId;
  kind: WorkKind;
  maximumSensitivity: WorkSensitivity;
  createdAt: number;
}

export interface CreateBindingInput {
  id: BindingId;
  workId: WorkId;
  adapterKind: BindingAdapterKind;
  externalAccountId: string;
  externalConversationId: string;
  generation: number;
  sourceVisibility: SourceVisibility;
  configMode: BindingConfigMode;
  pinnedConfigRevisionId?: EffectiveConfigRevisionId | null;
  orderingKey: string;
  createdAt: number;
}

export interface AdmitRunInput {
  id: RunId;
  workId: WorkId;
  bindingId: BindingId;
  kind: RunKind;
  admissionSequence: number;
  triggerKind: string;
  triggerRef: string;
  dedupeKey: string;
  actorRef?: string | null;
  actorTrustTier: ActorTrustTier;
  sourceContextWatermark?: string | null;
  triggerContentRef?: LedgerContentRef | null;
  configRevisionId: EffectiveConfigRevisionId;
  effectiveCapabilityDigest: string;
  executionAuthority: RunExecutionAuthority;
  coordinatorKind: RunCoordinatorKind;
  authorityEpoch: number;
  createdAt: number;
}

export interface CreateWorkGraphInput {
  work: CreateWorkInput;
  binding: CreateBindingInput;
  run: AdmitRunInput;
  auditEventId: string;
  auditIdempotencyKey: string;
}

/**
 * Target-neutral composite admission used by channel and schedule adapters.
 * Adapter code prepares opaque external identities and a safe configuration;
 * the Work store owns revision dedupe, Binding reuse, content retention, Run
 * sequencing, and the initial audit event in one database transaction.
 */
export interface AdmitShadowRunInput {
  work: CreateWorkInput;
  binding: CreateBindingInput;
  run: Omit<AdmitRunInput, 'admissionSequence' | 'triggerContentRef' | 'configRevisionId'>;
  safeConfig: SafeEffectiveConfigInput;
  triggerContent?: {
    sensitivity: ContentSensitivity;
    body: string;
  } | null;
  auditEventId: string;
  auditIdempotencyKey: string;
}

export interface ShadowRunAdmission {
  work: WorkRecord;
  binding: BindingRecord;
  run: RunRecord;
  replayed: boolean;
}

export interface EnsureWorkBindingInput {
  work: CreateWorkInput;
  binding: CreateBindingInput;
}

export interface CreateRunExecutionInput {
  id: RunExecutionId;
  runId: RunId;
  attemptNumber: number;
  fencingToken: number;
  executorKind: 'agent' | 'workflow';
  agentName: string;
  canonicalModel: string;
  startedAt: number;
}

export interface RunExecutionRouteInput {
  executionId: RunExecutionId;
  providerAuthRoute?: ProviderAuthRoute | null;
  catalogSource?: string | null;
  catalogRevision?: string | null;
  catalogDigest?: string | null;
  compiledProfile?: string | null;
  modelCredentialRef?: string | null;
  modelCredentialVersion?: number | null;
}

export interface QuarantineRunInput {
  runId: RunId;
  adminCredentialId: string;
  operatorLabel: string;
  authOrigin: string;
  safeReasonCode: 'effect_reconciled_externally' | 'delivery_reconciled_externally' | 'accepted_unknown';
  requestId: string;
  idempotencyKey: string;
  resolvedAt: number;
}

export interface RequireRunRecoveryInput {
  runId: RunId;
  safeFailureCode: string;
  at: number;
  auditEventId: string;
  auditIdempotencyKey: string;
}

export interface WorkIntegrityReport {
  foreignKeysEnabled: boolean;
  foreignKeyViolationCount: number;
  invariantViolationCount: number;
}

export interface WorkPurgeResult {
  purgedCount: number;
  remainingExpiredCount: number;
}

export type WorkRpcRequest =
  | { kind: 'put_config_revision'; input: SafeEffectiveConfigInput; createdAt?: number }
  | { kind: 'get_config_revision'; revisionId: EffectiveConfigRevisionId }
  | { kind: 'put_content'; input: PutLedgerContentInput }
  | { kind: 'get_content'; ref: LedgerContentRef; at?: number }
  | { kind: 'purge_content'; at?: number; limit?: number }
  | { kind: 'create_graph'; input: CreateWorkGraphInput }
  | { kind: 'admit_shadow_run'; input: AdmitShadowRunInput }
  | { kind: 'get_work'; workId: WorkId }
  | { kind: 'get_binding'; bindingId: BindingId }
  | { kind: 'get_run'; runId: RunId }
  | { kind: 'create_execution'; input: CreateRunExecutionInput }
  | { kind: 'record_execution_route'; input: RunExecutionRouteInput }
  | { kind: 'get_execution'; executionId: RunExecutionId }
  | { kind: 'require_recovery'; input: RequireRunRecoveryInput }
  | { kind: 'quarantine_run'; input: QuarantineRunInput }
  | { kind: 'list_audit_events'; runId: RunId; limit?: number }
  | { kind: 'verify_integrity' };

export type WorkRpcResponse =
  | { kind: 'config_revision'; revision: EffectiveConfigRevision | null }
  | { kind: 'content'; content: LedgerContentRecord | null }
  | { kind: 'purge'; result: WorkPurgeResult }
  | { kind: 'graph'; work: WorkRecord; binding: BindingRecord; run: RunRecord }
  | { kind: 'shadow_admission'; admission: ShadowRunAdmission }
  | { kind: 'work'; work: WorkRecord | null }
  | { kind: 'binding'; binding: BindingRecord | null }
  | { kind: 'run'; run: RunRecord | null }
  | { kind: 'execution'; execution: RunExecutionRecord | null }
  | { kind: 'audit_events'; events: AuditEvent[] }
  | { kind: 'integrity'; report: WorkIntegrityReport };

export interface WorkStore {
  putConfigRevision(input: SafeEffectiveConfigInput, createdAt?: number): Promise<EffectiveConfigRevision>;
  getConfigRevision(id: EffectiveConfigRevisionId): Promise<EffectiveConfigRevision | undefined>;
  putContent(input: PutLedgerContentInput): Promise<LedgerContentRecord>;
  getContent(ref: LedgerContentRef, at?: number): Promise<LedgerContentRecord | undefined>;
  purgeContent(at?: number, limit?: number): Promise<WorkPurgeResult>;
  createGraph(input: CreateWorkGraphInput): Promise<{
    work: WorkRecord;
    binding: BindingRecord;
    run: RunRecord;
  }>;
  admitShadowRun(input: AdmitShadowRunInput): Promise<ShadowRunAdmission>;
  getWork(id: WorkId): Promise<WorkRecord | undefined>;
  getBinding(id: BindingId): Promise<BindingRecord | undefined>;
  getRun(id: RunId): Promise<RunRecord | undefined>;
  createRunExecution(input: CreateRunExecutionInput): Promise<RunExecutionRecord>;
  recordRunExecutionRoute(input: RunExecutionRouteInput): Promise<RunExecutionRecord>;
  getRunExecution(id: RunExecutionId): Promise<RunExecutionRecord | undefined>;
  requireRecovery(input: RequireRunRecoveryInput): Promise<RunRecord>;
  quarantineRun(input: QuarantineRunInput): Promise<RunRecord>;
  listAuditEvents(runId: RunId, limit?: number): Promise<AuditEvent[]>;
  verifyIntegrity(): Promise<WorkIntegrityReport>;
  close?(): void;
}

export class WorkStateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'WorkStateError';
  }
}
