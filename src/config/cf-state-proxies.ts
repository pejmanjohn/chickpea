import {
  AgentRevisionConflictError,
  AgentExistsError,
  AgentStillAssignedError,
  AgentStillReferencedError,
  ChannelRevisionConflictError,
  ConnectionAccountRevisionConflictError,
  ReservedAgentIdentityError,
  UnknownAgentError,
  WorkspaceModelDefaultRevisionConflictError,
} from './errors.ts';
import type {
  EncryptedCredentialStore,
  ReplaceEncryptedCredentialRevisionInput,
  SettingsPatch,
  SettingsStore,
} from './settings-store.ts';
import type { AgentSnapshotStore } from './snapshot-store.ts';
import type { AgentIdentityField } from './agent-id.ts';
import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';
import type { StateRpcResult, TagStateRpc } from './state-rpc.ts';
import type {
  ConfigAgentPatch,
  ConfigStore,
  OAuthReauthorizationTarget,
} from './store.ts';
import type {
  ActivateChickpeaCutoverInput,
  AgentCreateInput,
  AgentChannelGrant,
  AgentChannelGrantInput,
  AgentConnectionBinding,
  AgentConnectionBindingInput,
  AgentScheduleReference,
  AgentScheduleReferenceInput,
  AgentSnapshot,
  AgentSnapshotRootReference,
  AgentReferenceSummary,
  AgentThreadRoute,
  AgentThreadRouteInput,
  ChannelConfig,
  ChickpeaCutoverActivation,
  ChickpeaCutoverPreflight,
  CustomAgentConfig,
  ConnectionAccount,
  ConnectionAccountInput,
  EnsureWorkspaceInstallationInput,
  PrepareChickpeaCutoverInput,
  RollbackChickpeaCutoverInput,
  SlackPublicContextEntry,
  SlackPublicContextEntryInput,
  WorkspaceModelDefault,
  WorkspaceModelDefaultInput,
  WorkspaceInstallation,
  WorkspaceInstallationPatch,
} from './types.ts';
import { IdentityStateError } from '../identity/errors.ts';
import { ManagementError, type ManagementRpcRequest, type ManagementRpcResponse } from '../management/types.ts';
import type { ManagementStore } from '../management/store.ts';
import type {
  AdvanceAuthOperationInput,
  ActivateInvitationInput,
  ActivateFirstOwnerInput,
  AdmitSlackOidcAttemptInput,
  BeginSlackAppCreationInput,
  BeginSlackCredentialRotationInput,
  BindSlackMemberBrowserIdentityInput,
  AuthOperationKind,
  ClaimOwnerInput,
  ConsumeAuthOperationInput,
  ConsumeInvitationInput,
  CreateBrowserSessionRecordInput,
  CreateAuthOperationInput,
  CreateInvitationInput,
  CreateOwnerClaimInput,
  CreatePersonalTokenRecordInput,
  CreateSlackOAuthAttemptInput,
  CreateSlackOidcAttemptInput,
  CreateSlackRecoverySessionInput,
  AcquireSlackOAuthAttemptInput,
  AcquireSlackRecoveryOAuthInput,
  EnsureOrganizationInput,
  EnsureAuthControlInput,
  EnsureSlackCredentialControlInput,
  IdentityRpcRequest,
  IdentityRpcResponse,
  IdentityStore,
  RecordIdentityAuthAuditInput,
  RecordSlackAppCreationSuccessInput,
  PromoteSlackCredentialRevisionInput,
  PromoteSlackRecoveryCandidateInput,
  RewrapSlackCredentialRevisionInput,
  ResendInvitationInput,
  SetMembershipAccessOverlayInput,
  SlackSetupTransitionInput,
  ReserveSlackSetupTransactionInput,
  FailSlackAppCreationInput,
  MarkSlackSetupApprovalPendingInput,
  MarkSlackOAuthApprovalPendingInput,
  RecordSlackBotInstallationCandidateInput,
  RecordSharedSlackInstallationInput,
  RecordSlackEventsProofInput,
  RecordSlackRecoveryCandidateInput,
  PromoteSlackBotInstallationInput,
  ProvisionSlackMemberInput,
  FailSlackBotInstallationInput,
  SettleSlackOAuthAttemptInput,
  SettleSlackOidcAttemptInput,
  AcquireSlackOidcAttemptInput,
  StageSlackCredentialRevisionInput,
  StageSlackRecoveryAppCredentialsInput,
  StartSlackRecoveryOAuthInput,
  TombstoneSlackCredentialRevisionInput,
  UpdateMembershipAuthorityInput,
  UpdateSlackRecoveryManifestInput,
  UpdateAuthControlInput,
  UpdateOrganizationAuthInput,
} from '../identity/types.ts';
import type {
  SlackCanonicalAdmissionInput,
  SlackStateStore,
} from '../slack/claim-store.ts';
import {
  SlackPresentationStateError,
  type SlackPresentationStateErrorCode,
  type SlackPresentationTransitionInput,
} from '../slack/run-presentations.ts';
import {
  WorkStateError,
  type BindingId,
  type ClaimNextInteractiveRunInput,
  type AdmitShadowRunInput,
  type CreateRunExecutionInput,
  type CreateWorkGraphInput,
  type EffectiveConfigRevisionId,
  type LedgerContentRef,
  type ListWorkRunsInput,
  type PutLedgerContentInput,
  type PrepareRunInput,
  type QuarantineRunInput,
  type ReleaseRunLeaseInput,
  type RecordRunResponseInput,
  type RecordWorkActionInput,
  type RequireRunRecoveryInput,
  type RenewRunLeaseInput,
  type MarkRunExecutionInvokedInput,
  type SettleRunExecutionInput,
  type StartRunDeliveryInput,
  type FinalizeRunDeliveryInput,
  type SettleRunWithoutDeliveryInput,
  type RunExecutionId,
  type RunExecutionRouteInput,
  type RunId,
  type SafeEffectiveConfigInput,
  type WorkId,
  type WorkRpcRequest,
  type WorkRpcResponse,
  type WorkStore,
} from '../work/types.ts';
import {
  MemoryStateError,
  type AgentMemory,
  type MemoryRpcRequest,
  type MemoryRpcResponse,
  type MemoryStateStore,
  type PutAgentMemoryInput,
} from '../memory/types.ts';
import {
  UsageStateError,
  type AdmitUsageOperationInput,
  type ConnectorUsageRecord,
  type ConnectorQuotaReservation,
  type ConnectorUsageSummary,
  type ConnectorUsageSummaryQuery,
  type ModelCredentialRecord,
  type PutModelCredentialInput,
  type RecordConnectorUsageInput,
  type ReleaseConnectorQuotaInput,
  type ReserveConnectorQuotaInput,
  type RecordUsageTerminalInput,
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
} from '../usage/index.ts';
import {
  RoutineStateError,
  type BeginRoutineOccurrenceInput,
  type CancelRoutineConfirmationInput,
  type ClaimRoutineDeliveryInput,
  type ClaimDueRoutinesInput,
  type ConfirmRoutineInput,
  type ControlRoutineInput,
  type CreateRoutineOccurrenceInput,
  type PutRoutineConfirmationInput,
  type PrepareRoutineAgentDispatchInput,
  type RecordRoutineAgentReceiptInput,
  type RecordRoutineAgentSettlementInput,
  type RecordRoutineDeliveryInput,
  type RoutineAdmissionAttempt,
  type RoutineAdminPage,
  type RoutineAdminPageInput,
  type RoutineConfirmation,
  type RoutineDefinition,
  type RoutineDueClaimBatch,
  type RoutineRevision,
  type RoutineRpcRequest,
  type RoutineRpcResponse,
  type RoutineRun,
  type RoutineRunFilter,
  type RoutineMaintenanceResult,
  type RoutineStore,
  type SaveRoutineInput,
  type ResolveRoutineAdmissionInput,
  type StartRoutineAdmissionInput,
  type TransitionRoutineRunInput,
} from '../routines/types.ts';

/**
 * Cloudflare backends for the four public store interfaces: thin async proxies
 * that forward every call to the TagStateStore Durable Object (which runs the
 * SAME target-neutral store logic the node backend runs — see src/cloudflare.ts)
 * and re-throw domain failures as the typed errors from src/config/errors.ts,
 * so consumers cannot tell the two backends apart.
 *
 * No Cloudflare imports here: the stub is purely structural (state-rpc.ts), so
 * this module compiles and bundles inert on the node lane.
 */

/**
 * Unwrap an RPC envelope: return the value or re-throw the domain error the DO
 * classified. Unknown codes degrade to a plain Error with the DO's message —
 * fail loudly, never silently coerce a failure into a value.
 */
function unwrap<T>(result: StateRpcResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  const { code, message, details } = result.error;
  switch (code) {
    case 'unknown_agent':
      throw new UnknownAgentError(details?.agentId ?? 'unknown');
    case 'agent_exists':
      throw new AgentExistsError(details?.agentId ?? 'unknown');
    case 'agent_revision_conflict':
      throw new AgentRevisionConflictError(
        details?.agentId ?? 'unknown',
        Number(details?.expectedRevision ?? 0),
        Number(details?.actualRevision ?? 0),
      );
    case 'reserved_agent_identity':
      throw new ReservedAgentIdentityError(
        (details?.field ?? 'id') as AgentIdentityField,
      );
    case 'workspace_model_default_revision_conflict':
      throw new WorkspaceModelDefaultRevisionConflictError(
        details?.workspaceId ?? 'unknown',
        Number(details?.expectedRevision ?? 0),
        Number(details?.actualRevision ?? 0),
      );
    case 'agent_still_assigned':
      throw new AgentStillAssignedError(details?.agentId ?? 'unknown', details?.keys ?? '');
    case 'agent_still_referenced':
      throw new AgentStillReferencedError(
        details?.agentId ?? 'unknown',
        details?.references ?? '',
      );
    case 'channel_revision_conflict':
      throw new ChannelRevisionConflictError(
        details?.workspaceId ?? 'unknown',
        details?.channelId ?? 'unknown',
        Number(details?.expectedRevision ?? 0),
        Number(details?.actualRevision ?? 0),
      );
    case 'connection_account_revision_conflict':
      throw new ConnectionAccountRevisionConflictError(
        details?.accountId ?? 'unknown',
        Number(details?.expectedRevision ?? 0),
        Number(details?.actualRevision ?? 0),
      );
    case 'identity': {
      const identityDetails = { ...(details ?? {}) };
      const identityCode = identityDetails.identityCode ?? 'identity_invalid';
      delete identityDetails.identityCode;
      throw new IdentityStateError(
        identityCode as ConstructorParameters<typeof IdentityStateError>[0],
        message,
        identityDetails,
      );
    }
    case 'management': {
      const managementCode = details?.managementCode ?? 'invalid_request';
      throw new ManagementError(
        managementCode as ConstructorParameters<typeof ManagementError>[0],
        message,
      );
    }
    case 'memory': {
      const memoryCode = details?.memoryCode ?? 'memory_state_error';
      const memoryDetails = { ...(details ?? {}) };
      delete memoryDetails.memoryCode;
      throw new MemoryStateError(memoryCode, message, memoryDetails);
    }
    case 'routine': {
      const routineDetails = { ...(details ?? {}) };
      const routineCode = routineDetails.routineCode ?? 'routine_state_error';
      delete routineDetails.routineCode;
      throw new RoutineStateError(routineCode, message, routineDetails);
    }
    case 'usage': {
      const usageDetails = { ...(details ?? {}) };
      const usageCode = usageDetails.usageCode ?? 'usage_state_error';
      delete usageDetails.usageCode;
      throw new UsageStateError(usageCode, message, usageDetails);
    }
    case 'work': {
      const workDetails = { ...(details ?? {}) };
      const workCode = workDetails.workCode ?? 'work_state_error';
      delete workDetails.workCode;
      throw new WorkStateError(workCode, message, workDetails);
    }
    case 'slack_presentation':
      throw new SlackPresentationStateError(
        (details?.presentationCode ?? 'invalid_input') as SlackPresentationStateErrorCode,
        message,
      );
    default:
      throw new Error(message);
  }
}

export class CfIdentityStore implements IdentityStore {
  constructor(private readonly stub: TagStateRpc) {}

  async ensureAuthControl(input: EnsureAuthControlInput = {}) {
    const response = await this.execute({ kind: 'ensure_auth_control', input });
    if (response.kind !== 'auth_control' || !response.control) throw unexpectedIdentityResponse();
    return response.control;
  }
  async getAuthControl(installationId?: string) {
    const response = await this.execute({
      kind: 'get_auth_control',
      ...(installationId === undefined ? {} : { installationId }),
    });
    if (response.kind !== 'auth_control') throw unexpectedIdentityResponse();
    return orUndefined(response.control);
  }
  async updateAuthControl(input: UpdateAuthControlInput) {
    const response = await this.execute({ kind: 'update_auth_control', input });
    if (response.kind !== 'auth_control' || !response.control) throw unexpectedIdentityResponse();
    return response.control;
  }
  async ensureSlackCredentialControl(input: EnsureSlackCredentialControlInput) {
    const response = await this.execute({ kind: 'ensure_slack_credential_control', input });
    if (response.kind !== 'slack_credential_control' || !response.control) {
      throw unexpectedIdentityResponse();
    }
    return response.control;
  }
  async getSlackCredentialControl(installationId?: string) {
    const response = await this.execute({
      kind: 'get_slack_credential_control',
      ...(installationId === undefined ? {} : { installationId }),
    });
    if (response.kind !== 'slack_credential_control') throw unexpectedIdentityResponse();
    return orUndefined(response.control);
  }
  async beginSlackCredentialRotation(input: BeginSlackCredentialRotationInput) {
    const response = await this.execute({ kind: 'begin_slack_credential_rotation', input });
    if (response.kind !== 'slack_credential_control' || !response.control) {
      throw unexpectedIdentityResponse();
    }
    return response.control;
  }
  async stageSlackCredentialRevision(input: StageSlackCredentialRevisionInput) {
    const response = await this.execute({ kind: 'stage_slack_credential_revision', input });
    if (response.kind !== 'slack_credential_revision' || !response.revision) {
      throw unexpectedIdentityResponse();
    }
    return response.revision;
  }
  async getActiveSlackCredentialRevision(identityId: string) {
    const response = await this.execute({ kind: 'get_active_slack_credential_revision', identityId });
    if (response.kind !== 'slack_credential_revision') throw unexpectedIdentityResponse();
    return orUndefined(response.revision);
  }
  async getSlackCredentialRevision(identityId: string, revision: string) {
    const response = await this.execute({ kind: 'get_slack_credential_revision', identityId, revision });
    if (response.kind !== 'slack_credential_revision') throw unexpectedIdentityResponse();
    return orUndefined(response.revision);
  }
  async hasSlackCredentialHistory(identityId: string) {
    const response = await this.execute({ kind: 'has_slack_credential_history', identityId });
    if (response.kind !== 'slack_credential_presence') throw unexpectedIdentityResponse();
    return response.present;
  }
  async listLiveSlackCredentialRevisions() {
    const response = await this.execute({ kind: 'list_live_slack_credential_revisions' });
    if (response.kind !== 'slack_credential_revisions') throw unexpectedIdentityResponse();
    return response.revisions;
  }
  async promoteSlackCredentialRevision(input: PromoteSlackCredentialRevisionInput) {
    const response = await this.execute({ kind: 'promote_slack_credential_revision', input });
    if (response.kind !== 'slack_credential_revision' || !response.revision) {
      throw unexpectedIdentityResponse();
    }
    return response.revision;
  }
  async tombstoneSlackCredentialRevision(input: TombstoneSlackCredentialRevisionInput) {
    const response = await this.execute({ kind: 'tombstone_slack_credential_revision', input });
    if (response.kind !== 'slack_credential_revision' || !response.revision) {
      throw unexpectedIdentityResponse();
    }
    return response.revision;
  }
  async rewrapSlackCredentialRevision(input: RewrapSlackCredentialRevisionInput) {
    const response = await this.execute({ kind: 'rewrap_slack_credential_revision', input });
    if (response.kind !== 'slack_credential_revision' || !response.revision) {
      throw unexpectedIdentityResponse();
    }
    return response.revision;
  }
  async countLiveSlackCredentialRevisionsByKey(keyId: string, expectedRotationEpoch: number) {
    const response = await this.execute({
      kind: 'count_live_slack_credential_revisions_by_key', keyId, expectedRotationEpoch,
    });
    if (response.kind !== 'slack_credential_count') throw unexpectedIdentityResponse();
    return response.count;
  }
  async sweepSlackIdentityRetention(at: number, candidateMaxAgeMs: number) {
    const response = await this.execute({ kind: 'sweep_slack_identity_retention', at, candidateMaxAgeMs });
    if (response.kind !== 'slack_credential_retention') throw unexpectedIdentityResponse();
    return response.result;
  }
  async createSlackRecoverySession(input: CreateSlackRecoverySessionInput) {
    const response = await this.execute({ kind: 'create_slack_recovery_session', input });
    if (response.kind !== 'slack_recovery_session' || !response.session) throw unexpectedIdentityResponse();
    return response.session;
  }
  async getSlackRecoverySession(recoveryId: string) {
    const response = await this.execute({ kind: 'get_slack_recovery_session', recoveryId });
    if (response.kind !== 'slack_recovery_session') throw unexpectedIdentityResponse();
    return orUndefined(response.session);
  }
  async stageSlackRecoveryAppCredentials(input: StageSlackRecoveryAppCredentialsInput) {
    const response = await this.execute({ kind: 'stage_slack_recovery_app_credentials', input });
    if (response.kind !== 'slack_recovery_session' || !response.session) throw unexpectedIdentityResponse();
    return response.session;
  }
  async startSlackRecoveryOAuth(input: StartSlackRecoveryOAuthInput) {
    const response = await this.execute({ kind: 'start_slack_recovery_oauth', input });
    if (response.kind !== 'slack_recovery_session' || !response.session) throw unexpectedIdentityResponse();
    return response.session;
  }
  async updateSlackRecoveryManifest(input: UpdateSlackRecoveryManifestInput) {
    const response = await this.execute({ kind: 'update_slack_recovery_manifest', input });
    if (response.kind !== 'slack_recovery_session' || !response.session) throw unexpectedIdentityResponse();
    return response.session;
  }
  async acquireSlackRecoveryOAuth(input: AcquireSlackRecoveryOAuthInput) {
    const response = await this.execute({ kind: 'acquire_slack_recovery_oauth', input });
    if (response.kind !== 'slack_recovery_session' || !response.session) throw unexpectedIdentityResponse();
    return response.session;
  }
  async recordSlackRecoveryCandidate(input: RecordSlackRecoveryCandidateInput) {
    const response = await this.execute({ kind: 'record_slack_recovery_candidate', input });
    if (response.kind !== 'slack_recovery_session' || !response.session) throw unexpectedIdentityResponse();
    return response.session;
  }
  async promoteSlackRecoveryCandidate(input: PromoteSlackRecoveryCandidateInput) {
    const response = await this.execute({ kind: 'promote_slack_recovery_candidate', input });
    if (response.kind !== 'slack_recovery_session' || !response.session) throw unexpectedIdentityResponse();
    return response.session;
  }
  async reserveSlackSetupTransaction(input: ReserveSlackSetupTransactionInput) {
    const response = await this.execute({ kind: 'reserve_slack_setup_transaction', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async getSlackSetupTransaction(setupId: string) {
    const response = await this.execute({ kind: 'get_slack_setup_transaction', setupId });
    if (response.kind !== 'slack_setup_transaction') throw unexpectedIdentityResponse();
    return orUndefined(response.transaction);
  }
  async findSlackSetupTransaction(locatorHash: string) {
    const response = await this.execute({ kind: 'find_slack_setup_transaction', locatorHash });
    if (response.kind !== 'slack_setup_transaction') throw unexpectedIdentityResponse();
    return orUndefined(response.transaction);
  }
  async beginSlackAppCreation(input: BeginSlackAppCreationInput) {
    const response = await this.execute({ kind: 'begin_slack_app_creation', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async failSlackAppCreation(input: FailSlackAppCreationInput) {
    const response = await this.execute({ kind: 'fail_slack_app_creation', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async recordSlackAppCreationSuccess(input: RecordSlackAppCreationSuccessInput) {
    const response = await this.execute({ kind: 'record_slack_app_creation_success', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async restartSlackAppCreation(input: SlackSetupTransitionInput) {
    const response = await this.execute({ kind: 'restart_slack_app_creation', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async markSlackSetupApprovalPending(input: MarkSlackSetupApprovalPendingInput) {
    const response = await this.execute({ kind: 'mark_slack_setup_approval_pending', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async resumeSlackSetupAfterApproval(input: SlackSetupTransitionInput) {
    const response = await this.execute({ kind: 'resume_slack_setup_after_approval', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async createSlackOAuthAttempt(input: CreateSlackOAuthAttemptInput) {
    const response = await this.execute({ kind: 'create_slack_oauth_attempt', input });
    if (response.kind !== 'slack_oauth_attempt' || !response.attempt) throw unexpectedIdentityResponse();
    return response.attempt;
  }
  async getSlackOAuthAttempt(attemptId: string) {
    const response = await this.execute({ kind: 'get_slack_oauth_attempt', attemptId });
    if (response.kind !== 'slack_oauth_attempt') throw unexpectedIdentityResponse();
    return orUndefined(response.attempt);
  }
  async acquireSlackOAuthAttempt(input: AcquireSlackOAuthAttemptInput) {
    const response = await this.execute({ kind: 'acquire_slack_oauth_attempt', input });
    if (response.kind !== 'slack_oauth_attempt' || !response.attempt) throw unexpectedIdentityResponse();
    return response.attempt;
  }
  async settleSlackOAuthAttempt(input: SettleSlackOAuthAttemptInput) {
    const response = await this.execute({ kind: 'settle_slack_oauth_attempt', input });
    if (response.kind !== 'slack_oauth_attempt' || !response.attempt) throw unexpectedIdentityResponse();
    return response.attempt;
  }
  async markSlackOAuthApprovalPending(input: MarkSlackOAuthApprovalPendingInput) {
    const response = await this.execute({ kind: 'mark_slack_oauth_approval_pending', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async recordSlackBotInstallationCandidate(input: RecordSlackBotInstallationCandidateInput) {
    const response = await this.execute({ kind: 'record_slack_bot_installation_candidate', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async getSlackEventsProof(candidateRevision: string) {
    const response = await this.execute({ kind: 'get_slack_events_proof', candidateRevision });
    if (response.kind !== 'slack_events_proof') throw unexpectedIdentityResponse();
    return orUndefined(response.proof);
  }
  async recordSlackEventsProof(input: RecordSlackEventsProofInput) {
    const response = await this.execute({ kind: 'record_slack_events_proof', input });
    if (response.kind !== 'slack_events_proof' || !response.proof) throw unexpectedIdentityResponse();
    return response.proof;
  }
  async promoteSlackBotInstallation(input: PromoteSlackBotInstallationInput) {
    const response = await this.execute({ kind: 'promote_slack_bot_installation', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async recordSharedSlackInstallation(input: RecordSharedSlackInstallationInput) {
    const response = await this.execute({ kind: 'record_shared_slack_installation', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) {
      throw unexpectedIdentityResponse();
    }
    return response.transaction;
  }
  async failSlackBotInstallation(input: FailSlackBotInstallationInput) {
    const response = await this.execute({ kind: 'fail_slack_bot_installation', input });
    if (response.kind !== 'slack_setup_transaction' || !response.transaction) throw unexpectedIdentityResponse();
    return response.transaction;
  }
  async createSlackOidcAttempt(input: CreateSlackOidcAttemptInput) {
    const response = await this.execute({ kind: 'create_slack_oidc_attempt', input });
    if (response.kind !== 'slack_oidc_attempt' || !response.attempt) throw unexpectedIdentityResponse();
    return response.attempt;
  }
  async getSlackOidcAttempt(attemptId: string) {
    const response = await this.execute({ kind: 'get_slack_oidc_attempt', attemptId });
    if (response.kind !== 'slack_oidc_attempt') throw unexpectedIdentityResponse();
    return orUndefined(response.attempt);
  }
  async acquireSlackOidcAttempt(input: AcquireSlackOidcAttemptInput) {
    const response = await this.execute({ kind: 'acquire_slack_oidc_attempt', input });
    if (response.kind !== 'slack_oidc_attempt' || !response.attempt) throw unexpectedIdentityResponse();
    return response.attempt;
  }
  async admitSlackOidcAttempt(input: AdmitSlackOidcAttemptInput) {
    const response = await this.execute({ kind: 'admit_slack_oidc_attempt', input });
    if (response.kind !== 'auth_operation' || !response.operation) throw unexpectedIdentityResponse();
    return response.operation;
  }
  async settleSlackOidcAttempt(input: SettleSlackOidcAttemptInput) {
    const response = await this.execute({ kind: 'settle_slack_oidc_attempt', input });
    if (response.kind !== 'slack_oidc_attempt' || !response.attempt) throw unexpectedIdentityResponse();
    return response.attempt;
  }
  async createAuthOperation(input: CreateAuthOperationInput) {
    const response = await this.execute({ kind: 'create_auth_operation', input });
    if (response.kind !== 'auth_operation' || !response.operation) throw unexpectedIdentityResponse();
    return response.operation;
  }
  async reservePendingAuthOperation(input: CreateAuthOperationInput) {
    const response = await this.execute({ kind: 'reserve_pending_auth_operation', input });
    if (response.kind !== 'auth_operation_reservation') throw unexpectedIdentityResponse();
    return { operation: response.operation, created: response.created };
  }
  async getAuthOperation(operationId: string) {
    const response = await this.execute({ kind: 'get_auth_operation', operationId });
    if (response.kind !== 'auth_operation') throw unexpectedIdentityResponse();
    return orUndefined(response.operation);
  }
  async findAuthOperation(kind: AuthOperationKind, capabilityHash: string) {
    const response = await this.execute({
      kind: 'find_auth_operation', operationKind: kind, capabilityHash,
    });
    if (response.kind !== 'auth_operation') throw unexpectedIdentityResponse();
    return orUndefined(response.operation);
  }
  async listAuthOperations(kind?: AuthOperationKind, organizationId?: string) {
    const response = await this.execute({
      kind: 'list_auth_operations',
      ...(kind === undefined ? {} : { operationKind: kind }),
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    if (response.kind !== 'auth_operations') throw unexpectedIdentityResponse();
    return response.operations;
  }
  async advanceAuthOperation(input: AdvanceAuthOperationInput) {
    const response = await this.execute({ kind: 'advance_auth_operation', input });
    if (response.kind !== 'auth_operation' || !response.operation) throw unexpectedIdentityResponse();
    return response.operation;
  }
  async consumeAuthOperation(input: ConsumeAuthOperationInput) {
    const response = await this.execute({ kind: 'consume_auth_operation', input });
    if (response.kind !== 'auth_operation' || !response.operation) throw unexpectedIdentityResponse();
    return response.operation;
  }
  async revokeAuthOperation(operationId: string) {
    const response = await this.execute({ kind: 'revoke_auth_operation', operationId });
    if (response.kind !== 'auth_operation' || !response.operation) throw unexpectedIdentityResponse();
    return response.operation;
  }
  async getMembershipAccessOverlay(membershipId: string) {
    const response = await this.execute({ kind: 'get_membership_access_overlay', membershipId });
    if (response.kind !== 'membership_access_overlay') throw unexpectedIdentityResponse();
    return orUndefined(response.overlay);
  }
  async setMembershipAccessOverlay(input: SetMembershipAccessOverlayInput) {
    const response = await this.execute({ kind: 'set_membership_access_overlay', input });
    if (response.kind !== 'membership_access_overlay' || !response.overlay) {
      throw unexpectedIdentityResponse();
    }
    return response.overlay;
  }
  async ensureOrganization(input: EnsureOrganizationInput) {
    const response = await this.execute({ kind: 'ensure_organization', input });
    if (response.kind !== 'organization' || !response.organization) throw unexpectedIdentityResponse();
    return response.organization;
  }
  async getOrganization() {
    const response = await this.execute({ kind: 'get_organization' });
    if (response.kind !== 'organization') throw unexpectedIdentityResponse();
    return orUndefined(response.organization);
  }
  async createOwnerClaim(input: CreateOwnerClaimInput) {
    const response = await this.execute({ kind: 'create_owner_claim', input });
    if (response.kind !== 'owner_claim' || !response.ownerClaim) throw unexpectedIdentityResponse();
    return response.ownerClaim;
  }
  async getOwnerClaim() {
    const response = await this.execute({ kind: 'get_owner_claim' });
    if (response.kind !== 'owner_claim') throw unexpectedIdentityResponse();
    return orUndefined(response.ownerClaim);
  }
  async claimOwner(input: ClaimOwnerInput) {
    const response = await this.execute({ kind: 'claim_owner', input });
    if (response.kind !== 'identity_resolution' || !response.resolution) throw unexpectedIdentityResponse();
    return response.resolution;
  }
  async activateFirstOwner(input: ActivateFirstOwnerInput) {
    const response = await this.execute({ kind: 'activate_first_owner', input });
    if (response.kind !== 'identity_resolution' || !response.resolution) throw unexpectedIdentityResponse();
    return response.resolution;
  }
  async activateInvitation(input: ActivateInvitationInput) {
    const response = await this.execute({ kind: 'activate_invitation', input });
    if (response.kind !== 'identity_resolution' || !response.resolution) throw unexpectedIdentityResponse();
    return response.resolution;
  }
  async provisionSlackMember(input: ProvisionSlackMemberInput) {
    const response = await this.execute({ kind: 'provision_slack_member', input });
    if (response.kind !== 'slack_member_provisioning') throw unexpectedIdentityResponse();
    return response.result;
  }
  async bindSlackMemberBrowserIdentity(input: BindSlackMemberBrowserIdentityInput) {
    const response = await this.execute({ kind: 'bind_slack_member_browser_identity', input });
    if (response.kind !== 'identity_resolution' || !response.resolution) {
      throw unexpectedIdentityResponse();
    }
    return response.resolution;
  }
  async resolveSlackIdentity(slackTeamId: string, slackUserId: string, organizationId?: string) {
    const response = await this.execute({
      kind: 'resolve_slack_identity', slackTeamId, slackUserId,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    if (response.kind !== 'identity_resolution') throw unexpectedIdentityResponse();
    return orUndefined(response.resolution);
  }
  async resolveBetterAuthIdentity(betterAuthUserId: string, organizationId?: string) {
    const response = await this.execute({
      kind: 'resolve_better_auth_identity', betterAuthUserId,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    if (response.kind !== 'identity_resolution') throw unexpectedIdentityResponse();
    return orUndefined(response.resolution);
  }
  async listExternalIdentities() {
    const response = await this.execute({ kind: 'list_external_identities' });
    if (response.kind !== 'external_identities') throw unexpectedIdentityResponse();
    return response.externalIdentities;
  }
  async listMemberships() {
    const response = await this.execute({ kind: 'list_memberships' });
    if (response.kind !== 'memberships') throw unexpectedIdentityResponse();
    return response.memberships;
  }
  async getUser(userId: string) {
    const response = await this.execute({ kind: 'get_user', userId });
    if (response.kind !== 'user') throw unexpectedIdentityResponse();
    return orUndefined(response.user);
  }
  async getMembership(membershipId: string) {
    const response = await this.execute({ kind: 'get_membership', membershipId });
    if (response.kind !== 'membership') throw unexpectedIdentityResponse();
    return orUndefined(response.membership);
  }
  async getMembershipForUser(userId: string, organizationId?: string) {
    const response = await this.execute({
      kind: 'get_membership_for_user', userId,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    if (response.kind !== 'memberships') throw unexpectedIdentityResponse();
    return response.memberships[0];
  }
  async updateMembershipAuthority(input: UpdateMembershipAuthorityInput) {
    const response = await this.execute({ kind: 'update_membership_authority', input });
    if (response.kind !== 'membership_authority_mutation') throw unexpectedIdentityResponse();
    return response.result;
  }
  async createInvitation(input: CreateInvitationInput) {
    const response = await this.execute({ kind: 'create_invitation', input });
    if (response.kind !== 'invitation') throw unexpectedIdentityResponse();
    return response.invitation;
  }
  async findInvitation(locatorHash: string) {
    const response = await this.execute({ kind: 'find_invitation', locatorHash });
    if (response.kind === 'invitations') return response.invitations[0];
    if (response.kind !== 'invitation') throw unexpectedIdentityResponse();
    return response.invitation;
  }
  async resendInvitation(input: ResendInvitationInput) {
    const response = await this.execute({ kind: 'resend_invitation', input });
    if (response.kind !== 'invitation') throw unexpectedIdentityResponse();
    return response.invitation;
  }
  async revokeInvitation(invitationId: string) {
    const response = await this.execute({ kind: 'revoke_invitation', invitationId });
    if (response.kind !== 'invitation') throw unexpectedIdentityResponse();
    return response.invitation;
  }
  async consumeInvitation(input: ConsumeInvitationInput) {
    const response = await this.execute({ kind: 'consume_invitation', input });
    if (response.kind !== 'identity_resolution' || !response.resolution) throw unexpectedIdentityResponse();
    return response.resolution;
  }
  async listInvitations() {
    const response = await this.execute({ kind: 'list_invitations' });
    if (response.kind !== 'invitations') throw unexpectedIdentityResponse();
    return response.invitations;
  }
  async createPersonalToken(input: CreatePersonalTokenRecordInput) {
    const response = await this.execute({ kind: 'create_personal_token', input });
    if (response.kind !== 'personal_token') throw unexpectedIdentityResponse();
    return response.personalToken;
  }
  async rotatePersonalToken(input: CreatePersonalTokenRecordInput) {
    const response = await this.execute({ kind: 'rotate_personal_token', input });
    if (response.kind !== 'personal_token_rotation') throw unexpectedIdentityResponse();
    return response.result;
  }
  async findPersonalTokens(prefix: string) {
    const response = await this.execute({ kind: 'find_personal_tokens', prefix });
    if (response.kind !== 'personal_tokens') throw unexpectedIdentityResponse();
    return response.personalTokens;
  }
  async getPersonalToken(tokenId: string) {
    const response = await this.execute({ kind: 'get_personal_token', tokenId });
    if (response.kind !== 'personal_tokens') throw unexpectedIdentityResponse();
    return response.personalTokens[0];
  }
  async revokePersonalToken(tokenId: string) {
    const response = await this.execute({ kind: 'revoke_personal_token', tokenId });
    if (response.kind !== 'personal_token') throw unexpectedIdentityResponse();
    return response.personalToken;
  }
  async touchPersonalToken(tokenId: string) {
    const response = await this.execute({ kind: 'touch_personal_token', tokenId });
    if (response.kind !== 'personal_token') throw unexpectedIdentityResponse();
    return response.personalToken;
  }
  async createBrowserSession(input: CreateBrowserSessionRecordInput) {
    const response = await this.execute({ kind: 'create_browser_session', input });
    if (response.kind !== 'browser_session') throw unexpectedIdentityResponse();
    return response.browserSession;
  }
  async findBrowserSessions(prefix: string) {
    const response = await this.execute({ kind: 'find_browser_sessions', prefix });
    if (response.kind !== 'browser_sessions') throw unexpectedIdentityResponse();
    return response.browserSessions;
  }
  async revokeBrowserSession(sessionId: string) {
    const response = await this.execute({ kind: 'revoke_browser_session', sessionId });
    if (response.kind !== 'browser_session') throw unexpectedIdentityResponse();
    return response.browserSession;
  }
  async updateOrganizationAuth(input: UpdateOrganizationAuthInput) {
    const response = await this.execute({ kind: 'update_organization_auth', input });
    if (response.kind !== 'organization' || !response.organization) throw unexpectedIdentityResponse();
    return response.organization;
  }
  async getAuthRateLimit(bucket: string, keyHash: string) {
    const response = await this.execute({ kind: 'get_auth_rate_limit', bucket, keyHash });
    if (response.kind !== 'auth_rate_limit') throw unexpectedIdentityResponse();
    return orUndefined(response.state);
  }
  async recordAuthRateFailure(bucket: string, keyHash: string, windowStart: number) {
    const response = await this.execute({ kind: 'record_auth_rate_failure', bucket, keyHash, windowStart });
    if (response.kind !== 'auth_rate_limit' || !response.state) throw unexpectedIdentityResponse();
    return response.state;
  }
  async clearAuthRateLimit(bucket: string, keyHash: string) {
    const response = await this.execute({ kind: 'clear_auth_rate_limit', bucket, keyHash });
    if (response.kind !== 'ok') throw unexpectedIdentityResponse();
  }
  async recordAuthAudit(input: RecordIdentityAuthAuditInput) {
    const response = await this.execute({ kind: 'record_identity_auth_audit', input });
    if (response.kind !== 'ok') throw unexpectedIdentityResponse();
  }
  async exportSummary() {
    const response = await this.execute({ kind: 'export_summary' });
    if (response.kind !== 'identity_export') throw unexpectedIdentityResponse();
    return response.summary;
  }
  async listAuditEvents(limit?: number) {
    const response = await this.execute({
      kind: 'list_identity_audit_events', ...(limit === undefined ? {} : { limit }),
    });
    if (response.kind !== 'audit_events') throw unexpectedIdentityResponse();
    return response.events;
  }
  private async execute(request: IdentityRpcRequest): Promise<IdentityRpcResponse> {
    return unwrap(await this.stub.identityExecute(request));
  }
}

/** `null` travels the wire; consumers expect `undefined` for "no row". */
function orUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export class CfManagementStore implements ManagementStore {
  constructor(private readonly stub: TagStateRpc) {}

  async execute(request: ManagementRpcRequest): Promise<ManagementRpcResponse> {
    return unwrap(await this.stub.managementExecute(request));
  }

  async reserveRequest(input: Parameters<ManagementStore['reserveRequest']>[0]) {
    const response = await this.execute({ kind: 'reserve_request', input });
    if (response.kind !== 'request_reservation') throw unexpectedManagementResponse();
    return { request: response.request, created: response.created };
  }

  async getRequest(operationId: string) {
    const response = await this.execute({ kind: 'get_request', operationId });
    if (response.kind !== 'request') throw unexpectedManagementResponse();
    return orUndefined(response.request);
  }

  async markRequestApplying(operationId: string, at: number) {
    const response = await this.execute({ kind: 'mark_request_applying', operationId, at });
    if (response.kind !== 'request' || !response.request) throw unexpectedManagementResponse();
    return response.request;
  }

  async saveRequestProgress(
    operationId: string,
    progress: Parameters<ManagementStore['saveRequestProgress']>[1],
    at: number,
  ) {
    const response = await this.execute({ kind: 'save_request_progress', operationId, progress, at });
    if (response.kind !== 'request' || !response.request) throw unexpectedManagementResponse();
    return response.request;
  }

  async completeRequest(
    operationId: string,
    result: Parameters<ManagementStore['completeRequest']>[1],
    at: number,
  ) {
    const response = await this.execute({ kind: 'complete_request', operationId, result, at });
    if (response.kind !== 'request' || !response.request) throw unexpectedManagementResponse();
    return response.request;
  }

  async putProposal(input: Parameters<ManagementStore['putProposal']>[0]) {
    const response = await this.execute({ kind: 'put_proposal', input });
    if (response.kind !== 'proposal' || !response.proposal) throw unexpectedManagementResponse();
    return response.proposal;
  }

  async getProposal(proposalId: string) {
    const response = await this.execute({ kind: 'get_proposal', proposalId });
    if (response.kind !== 'proposal') throw unexpectedManagementResponse();
    return orUndefined(response.proposal);
  }

  async claimProposal(input: Parameters<ManagementStore['claimProposal']>[0]) {
    const response = await this.execute({ kind: 'claim_proposal', input });
    if (response.kind !== 'proposal' || !response.proposal) throw unexpectedManagementResponse();
    return response.proposal;
  }

  async completeProposal(
    proposalId: string,
    result: Parameters<ManagementStore['completeProposal']>[1],
    at: number,
  ) {
    const response = await this.execute({ kind: 'complete_proposal', proposalId, result, at });
    if (response.kind !== 'proposal' || !response.proposal) throw unexpectedManagementResponse();
    return response.proposal;
  }

  async markProposalStale(proposalId: string, at: number) {
    const response = await this.execute({ kind: 'mark_proposal_stale', proposalId, at });
    if (response.kind !== 'proposal' || !response.proposal) throw unexpectedManagementResponse();
    return response.proposal;
  }

  async putChangeSetProposal(input: Parameters<ManagementStore['putChangeSetProposal']>[0]) {
    const response = await this.execute({ kind: 'put_change_set_proposal', input });
    if (response.kind !== 'change_set_proposal' || !response.proposal) {
      throw unexpectedManagementResponse();
    }
    return response.proposal;
  }

  async getChangeSetProposal(proposalId: string) {
    const response = await this.execute({ kind: 'get_change_set_proposal', proposalId });
    if (response.kind !== 'change_set_proposal') throw unexpectedManagementResponse();
    return orUndefined(response.proposal);
  }

  async claimChangeSetProposal(
    input: Parameters<ManagementStore['claimChangeSetProposal']>[0],
  ) {
    const response = await this.execute({ kind: 'claim_change_set_proposal', input });
    if (response.kind !== 'change_set_proposal' || !response.proposal) {
      throw unexpectedManagementResponse();
    }
    return response.proposal;
  }

  async completeChangeSetProposal(
    proposalId: string,
    result: Parameters<ManagementStore['completeChangeSetProposal']>[1],
    at: number,
  ) {
    const response = await this.execute({
      kind: 'complete_change_set_proposal', proposalId, result, at,
    });
    if (response.kind !== 'change_set_proposal' || !response.proposal) {
      throw unexpectedManagementResponse();
    }
    return response.proposal;
  }

  async markChangeSetProposalStale(proposalId: string, at: number) {
    const response = await this.execute({ kind: 'mark_change_set_proposal_stale', proposalId, at });
    if (response.kind !== 'change_set_proposal' || !response.proposal) {
      throw unexpectedManagementResponse();
    }
    return response.proposal;
  }

  async putUndo(record: Parameters<ManagementStore['putUndo']>[0]) {
    const response = await this.execute({ kind: 'put_undo', record });
    if (response.kind !== 'undo' || !response.undo) throw unexpectedManagementResponse();
    return response.undo;
  }

  async getUndo(operationId: string) {
    const response = await this.execute({ kind: 'get_undo', operationId });
    if (response.kind !== 'undo') throw unexpectedManagementResponse();
    return orUndefined(response.undo);
  }

  async consumeUndo(operationId: string, at: number) {
    const response = await this.execute({ kind: 'consume_undo', operationId, at });
    if (response.kind !== 'undo' || !response.undo) throw unexpectedManagementResponse();
    return response.undo;
  }

  async putSetup(input: Parameters<ManagementStore['putSetup']>[0]) {
    const response = await this.execute({ kind: 'put_setup', input });
    if (response.kind !== 'setup' || !response.setup) throw unexpectedManagementResponse();
    return response.setup;
  }

  async getSetup(setupOperationId: string, at?: number) {
    const response = await this.execute({
      kind: 'get_setup',
      setupOperationId,
      ...(at === undefined ? {} : { at }),
    });
    if (response.kind !== 'setup') throw unexpectedManagementResponse();
    return orUndefined(response.setup);
  }

  async exchangeSetup(input: Parameters<ManagementStore['exchangeSetup']>[0]) {
    const response = await this.execute({ kind: 'exchange_setup', input });
    if (response.kind !== 'setup' || !response.setup) throw unexpectedManagementResponse();
    return response.setup;
  }

  async authorizeSetup(input: Parameters<ManagementStore['authorizeSetup']>[0]) {
    const response = await this.execute({ kind: 'authorize_setup', input });
    if (response.kind !== 'setup' || !response.setup) throw unexpectedManagementResponse();
    return response.setup;
  }

  async failSetup(
    setupOperationId: string,
    browserSessionDigest: string,
    failureCode: string,
    at: number,
  ) {
    const response = await this.execute({
      kind: 'fail_setup', setupOperationId, browserSessionDigest, failureCode, at,
    });
    if (response.kind !== 'setup' || !response.setup) throw unexpectedManagementResponse();
    return response.setup;
  }

  async completeSetup(input: Parameters<ManagementStore['completeSetup']>[0]) {
    const response = await this.execute({ kind: 'complete_setup', input });
    if (response.kind !== 'setup' || !response.setup) throw unexpectedManagementResponse();
    return response.setup;
  }

  async revokeSetup(input: Parameters<ManagementStore['revokeSetup']>[0]) {
    const response = await this.execute({ kind: 'revoke_setup', input });
    if (response.kind !== 'setup' || !response.setup) throw unexpectedManagementResponse();
    return response.setup;
  }

  async getOutboxForOperation(operationId: string) {
    const response = await this.execute({ kind: 'get_outbox_for_operation', operationId });
    if (response.kind !== 'outbox') throw unexpectedManagementResponse();
    return orUndefined(response.outbox);
  }

  async claimDueOutbox(at: number, limit: number, leaseUntil: number) {
    const response = await this.execute({ kind: 'claim_due_outbox', at, limit, leaseUntil });
    if (response.kind !== 'outbox_batch') throw unexpectedManagementResponse();
    return response.outbox;
  }

  async settleOutbox(input: Parameters<ManagementStore['settleOutbox']>[0]) {
    const response = await this.execute({ kind: 'settle_outbox', ...input });
    if (response.kind !== 'outbox' || !response.outbox) throw unexpectedManagementResponse();
    return response.outbox;
  }

  async cleanupRetention(at: number, limit = 250) {
    const response = await this.execute({ kind: 'cleanup_retention', at, limit });
    if (response.kind !== 'retention') throw unexpectedManagementResponse();
    return response.deleted;
  }
}

export class CfConfigStore implements ConfigStore {
  constructor(private readonly stub: TagStateRpc) {}

  async listAgents(): Promise<CustomAgentConfig[]> {
    return unwrap(await this.stub.configListAgents());
  }

  async listUserAgents(): Promise<CustomAgentConfig[]> {
    return unwrap(await this.stub.configListUserAgents());
  }

  async getAgent(agentId: string): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configGetAgent(agentId));
  }

  async materializeChickpeaAgent(): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configMaterializeChickpeaAgent());
  }

  async createAgent(agent: AgentCreateInput): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configCreateAgent(agent));
  }

  async updateAgent(agentId: string, patch: ConfigAgentPatch, expectedRevision?: number): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configUpdateAgent(agentId, patch, expectedRevision));
  }

  async markOAuthReauthorizationRequired(target: OAuthReauthorizationTarget): Promise<boolean> {
    return unwrap(await this.stub.configMarkOAuthReauthorizationRequired(target));
  }

  async deleteAgent(agentId: string, expectedRevision?: number): Promise<boolean> {
    return unwrap(await this.stub.configDeleteAgent(agentId, expectedRevision));
  }

  async deleteAgentWithMemory(
    agentId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    return unwrap(await this.stub.configDeleteAgentWithMemory(agentId, idempotencyKey));
  }

  async archiveAgent(
    agentId: string,
    options?: { replacementDefaultAgentId?: string; expectedRevision?: number },
  ): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configArchiveAgent(agentId, options));
  }

  async restoreAgent(agentId: string, expectedRevision?: number): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configRestoreAgent(agentId, expectedRevision));
  }

  async ensureWorkspaceInstallation(
    input: EnsureWorkspaceInstallationInput,
  ): Promise<WorkspaceInstallation> {
    return unwrap(await this.stub.configEnsureWorkspaceInstallation(input));
  }

  async getWorkspaceInstallation(workspaceId: string): Promise<WorkspaceInstallation | undefined> {
    return orUndefined(unwrap(await this.stub.configGetWorkspaceInstallation(workspaceId)));
  }

  async listWorkspaceInstallations(): Promise<WorkspaceInstallation[]> {
    return unwrap(await this.stub.configListWorkspaceInstallations());
  }

  async updateWorkspaceInstallation(
    workspaceId: string,
    patch: WorkspaceInstallationPatch,
    expectedRevision?: number,
  ): Promise<WorkspaceInstallation> {
    return unwrap(
      await this.stub.configUpdateWorkspaceInstallation(workspaceId, patch, expectedRevision),
    );
  }

  async setWorkspaceDefaultAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision?: number,
  ): Promise<WorkspaceInstallation> {
    return unwrap(
      await this.stub.configSetWorkspaceDefaultAgent(workspaceId, agentId, expectedRevision),
    );
  }

  async getWorkspaceModelDefault(
    workspaceId: string,
  ): Promise<WorkspaceModelDefault | undefined> {
    return orUndefined(unwrap(await this.stub.configGetWorkspaceModelDefault(workspaceId)));
  }

  async putWorkspaceModelDefault(
    input: WorkspaceModelDefaultInput,
    expectedRevision?: number,
  ): Promise<WorkspaceModelDefault> {
    return unwrap(await this.stub.configPutWorkspaceModelDefault(input, expectedRevision));
  }

  async prepareChickpeaCutover(
    input: PrepareChickpeaCutoverInput,
  ): Promise<ChickpeaCutoverPreflight> {
    return unwrap(await this.stub.configPrepareChickpeaCutover(input));
  }

  async preflightChickpeaCutover(workspaceId: string): Promise<ChickpeaCutoverPreflight> {
    return unwrap(await this.stub.configPreflightChickpeaCutover(workspaceId));
  }

  async activateChickpeaCutover(
    input: ActivateChickpeaCutoverInput,
  ): Promise<ChickpeaCutoverActivation> {
    return unwrap(await this.stub.configActivateChickpeaCutover(input));
  }

  async rollbackChickpeaCutover(
    input: RollbackChickpeaCutoverInput,
  ): Promise<ChickpeaCutoverPreflight> {
    return unwrap(await this.stub.configRollbackChickpeaCutover(input));
  }

  async listAgentChannelGrants(
    workspaceId?: string,
    channelId?: string,
  ): Promise<AgentChannelGrant[]> {
    return unwrap(await this.stub.configListAgentChannelGrants(workspaceId, channelId));
  }

  async putAgentChannelGrant(
    input: AgentChannelGrantInput,
    expectedRevision?: number,
  ): Promise<AgentChannelGrant> {
    return unwrap(await this.stub.configPutAgentChannelGrant(input, expectedRevision));
  }

  async deleteAgentChannelGrant(
    workspaceId: string,
    channelId: string,
    agentId: string,
  ): Promise<boolean> {
    return unwrap(await this.stub.configDeleteAgentChannelGrant(workspaceId, channelId, agentId));
  }

  async getAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<AgentThreadRoute | undefined> {
    return orUndefined(
      unwrap(await this.stub.configGetAgentThreadRoute(workspaceId, channelId, threadTs)),
    );
  }

  async putAgentThreadRoute(
    input: AgentThreadRouteInput,
    expectedRevision?: number,
  ): Promise<AgentThreadRoute> {
    return unwrap(await this.stub.configPutAgentThreadRoute(input, expectedRevision));
  }

  async deleteAgentThreadRoute(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<boolean> {
    return unwrap(await this.stub.configDeleteAgentThreadRoute(
      workspaceId,
      channelId,
      threadTs,
    ));
  }

  async listSlackPublicContext(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): Promise<SlackPublicContextEntry[]> {
    return unwrap(await this.stub.configListSlackPublicContext(workspaceId, channelId, rootTs));
  }

  async putSlackPublicContext(
    input: SlackPublicContextEntryInput,
  ): Promise<SlackPublicContextEntry> {
    return unwrap(await this.stub.configPutSlackPublicContext(input));
  }

  async deleteSlackPublicContextMessage(
    workspaceId: string,
    channelId: string,
    rootTs: string,
    messageTs: string,
  ): Promise<boolean> {
    return unwrap(await this.stub.configDeleteSlackPublicContextMessage(
      workspaceId,
      channelId,
      rootTs,
      messageTs,
    ));
  }

  async deleteSlackPublicContextRoot(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): Promise<number> {
    return unwrap(await this.stub.configDeleteSlackPublicContextRoot(
      workspaceId,
      channelId,
      rootTs,
    ));
  }

  async listConnectionAccounts(workspaceId: string): Promise<ConnectionAccount[]> {
    return unwrap(await this.stub.configListConnectionAccounts(workspaceId));
  }

  async putConnectionAccount(
    input: ConnectionAccountInput,
    expectedRevision?: number,
  ): Promise<ConnectionAccount> {
    return unwrap(await this.stub.configPutConnectionAccount(input, expectedRevision));
  }

  async listAgentConnectionBindings(agentId: string): Promise<AgentConnectionBinding[]> {
    return unwrap(await this.stub.configListAgentConnectionBindings(agentId));
  }

  async putAgentConnectionBinding(
    input: AgentConnectionBindingInput,
  ): Promise<AgentConnectionBinding> {
    return unwrap(await this.stub.configPutAgentConnectionBinding(input));
  }

  async listAgentScheduleReferences(agentId: string): Promise<AgentScheduleReference[]> {
    return unwrap(await this.stub.configListAgentScheduleReferences(agentId));
  }

  async getAgentScheduleReference(scheduleId: string): Promise<AgentScheduleReference | undefined> {
    return orUndefined(unwrap(await this.stub.configGetAgentScheduleReference(scheduleId)));
  }

  async putAgentScheduleReference(
    input: AgentScheduleReferenceInput,
    expectedRevision?: number,
  ): Promise<AgentScheduleReference> {
    return unwrap(await this.stub.configPutAgentScheduleReference(input, expectedRevision));
  }

  async listChannels(): Promise<ChannelConfig[]> {
    return unwrap(await this.stub.configListChannels());
  }

  async getChannel(workspaceId: string, channelId: string): Promise<ChannelConfig | undefined> {
    return orUndefined(unwrap(await this.stub.configGetChannel(workspaceId, channelId)));
  }

  async putChannel(channel: ChannelConfig, expectedRevision?: number): Promise<ChannelConfig> {
    return unwrap(await this.stub.configPutChannel(channel, expectedRevision));
  }

  async getAgentReferences(agentId: string): Promise<AgentReferenceSummary> {
    return unwrap(await this.stub.configGetAgentReferences(agentId));
  }
}

export class CfAgentSnapshotStore implements AgentSnapshotStore {
  constructor(private readonly stub: TagStateRpc) {}

  async get(threadKey: string): Promise<AgentSnapshot | undefined> {
    return orUndefined(unwrap(await this.stub.snapshotGet(threadKey)));
  }

  async putIfAbsent(threadKey: string, snapshot: AgentSnapshot): Promise<AgentSnapshot> {
    return unwrap(await this.stub.snapshotPutIfAbsent(threadKey, snapshot));
  }

  async replace(threadKey: string, snapshot: AgentSnapshot): Promise<AgentSnapshot> {
    return unwrap(await this.stub.snapshotReplace(threadKey, snapshot));
  }

  async listLiveRootsByAgent(agentId: string): Promise<AgentSnapshotRootReference[]> {
    return unwrap(await this.stub.snapshotListLiveRootsByAgent(agentId));
  }
}

export class CfSlackStateStore implements SlackStateStore {
  constructor(private readonly stub: TagStateRpc) {}

  async claim(key: string): Promise<boolean> {
    return unwrap(await this.stub.claim(key));
  }

  async release(key: string): Promise<void> {
    unwrap(await this.stub.release(key));
  }

  async start(key: string): Promise<void> {
    unwrap(await this.stub.threadStart(key));
  }

  async has(key: string): Promise<boolean> {
    return unwrap(await this.stub.threadHas(key));
  }

  async isActiveWork(key: string) {
    return unwrap(await this.stub.threadActiveWorkGet(key));
  }

  async setActiveWork(key: string, generation: string, active: boolean) {
    unwrap(await this.stub.threadActiveWorkSet(key, generation, active));
  }

  async admitCanonical(input: SlackCanonicalAdmissionInput) {
    return unwrap(await this.stub.admitSlackTurn(input));
  }

  async resumeTurnAfterOAuth(originalTaskId: string, continuationId: string) {
    return unwrap(await this.stub.resumeTurnAfterOAuth(originalTaskId, continuationId));
  }

  async pinAgentBinding(
    input: Parameters<SlackStateStore['pinAgentBinding']>[0],
    expected?: Parameters<SlackStateStore['pinAgentBinding']>[1],
  ) {
    return unwrap(await this.stub.slackAgentBindingPin(input, expected));
  }

  async getAgentBinding(continuityKey: string) {
    return orUndefined(unwrap(await this.stub.slackAgentBindingGet(continuityKey)));
  }

  async prepareFlueDispatch(
    id: string,
    message: string,
    observation: Parameters<TagStateRpc['slackFlueDispatchPrepare']>[2],
  ) {
    return unwrap(await this.stub.slackFlueDispatchPrepare(id, message, observation));
  }

  async reconcileFlueExistingInstance(id: string, uid: string) {
    return unwrap(await this.stub.slackFlueExistingInstanceReconcile(id, uid));
  }

  async recordFlueReceipt(
    id: string,
    receipt: Parameters<TagStateRpc['slackFlueReceiptRecord']>[1],
  ) {
    return unwrap(await this.stub.slackFlueReceiptRecord(id, receipt));
  }

  async recordFlueSettlement(
    id: string,
    settlement: Parameters<TagStateRpc['slackFlueSettlementRecord']>[1],
  ) {
    return unwrap(await this.stub.slackFlueSettlementRecord(id, settlement));
  }

  async matchFlueObservation(instanceId: string, submissionId?: string) {
    return orUndefined(
      unwrap(await this.stub.slackFlueObservationMatch(instanceId, submissionId)),
    );
  }

  async markTurnRecoveryRequired(id: string, reason: string): Promise<void> {
    unwrap(await this.stub.slackTurnRecoveryRequired(id, reason));
  }

  async listTurnRecoveryRequired(limit = 50) {
    return unwrap(await this.stub.slackTurnRecoveryList(limit));
  }

  async retrySlackInstallationRecovery(workspaceId: string) {
    return unwrap(await this.stub.slackInstallationRecoveryRetry(workspaceId));
  }

  async resolveTurnRecoveryRequired(id: string) {
    return unwrap(await this.stub.slackTurnRecoveryResolve(id));
  }

  async runtimeDrainCounts() {
    const status = unwrap(await this.stub.runtimeDrainStatus());
    return {
      pendingLegacyTurnJobs: status.categories.pendingLegacyTurnJobs,
      pendingLedgerTurnJobs: status.categories.pendingLedgerTurnJobs,
      pendingSlackInteractionCleanups: status.categories.pendingSlackInteractionCleanups,
      recoveryRequiredTurnJobs: status.categories.recoveryRequiredTurnJobs,
    };
  }

  async countPendingDeliveriesForWorkspace(workspaceId: string) {
    return unwrap(await this.stub.slackInstallationPendingDeliveryCount(workspaceId));
  }

  async recordSlackInteractionProgress(
    id: string,
    patch: Parameters<TagStateRpc['slackInteractionProgressRecord']>[1],
  ): Promise<void> {
    unwrap(await this.stub.slackInteractionProgressRecord(id, patch));
  }

  async getRunPresentation(runId: string) {
    return orUndefined(unwrap(await this.stub.slackPresentationGet(runId)));
  }

  async transitionRunPresentation(input: SlackPresentationTransitionInput) {
    return unwrap(await this.stub.slackPresentationTransition(input));
  }

  async reserveSlackAppend(workspaceId: string) {
    return unwrap(await this.stub.slackPresentationReserveAppend(workspaceId));
  }

  async applySlackAppendCooldown(workspaceId: string, retryAfterMs: number) {
    return unwrap(await this.stub.slackPresentationApplyCooldown(workspaceId, retryAfterMs));
  }

  async listRunPresentationsForRepair(limit = 50) {
    return unwrap(await this.stub.slackPresentationRepairList(limit));
  }

  async maintainRunPresentations(limit = 100) {
    return unwrap(await this.stub.slackPresentationMaintain(limit));
  }

  async summarizeRunPresentations(workspaceId: string) {
    return unwrap(await this.stub.slackPresentationSummary(workspaceId));
  }
}

export class CfSettingsStore implements SettingsStore, EncryptedCredentialStore {
  constructor(private readonly stub: TagStateRpc) {}

  async getSetting(key: string): Promise<string | undefined> {
    return orUndefined(unwrap(await this.stub.settingGet(key)));
  }

  async getSettings(keys: readonly string[]): Promise<(string | undefined)[]> {
    return unwrap(await this.stub.settingGetMany(keys)).map(orUndefined);
  }

  async setSetting(key: string, value: string): Promise<void> {
    unwrap(await this.stub.settingSet(key, value));
  }

  async deleteSetting(key: string): Promise<void> {
    unwrap(await this.stub.settingDelete(key));
  }

  async applySettingsPatch(patch: SettingsPatch): Promise<boolean> {
    return unwrap(await this.stub.settingApplyPatch(patch));
  }

  async mergeSettingStringSet(key: string, values: readonly string[]): Promise<string[]> {
    return unwrap(await this.stub.settingMergeStringSet(key, values));
  }

  async getEncryptedCredentialRevision(key: string) {
    return orUndefined(unwrap(await this.stub.encryptedCredentialGet(key)));
  }

  async replaceEncryptedCredentialRevision(input: ReplaceEncryptedCredentialRevisionInput) {
    return orUndefined(unwrap(await this.stub.encryptedCredentialReplace(input)));
  }

  async deleteEncryptedCredentialRevision(key: string, expectedRevision: string) {
    return unwrap(await this.stub.encryptedCredentialDelete(key, expectedRevision));
  }
}

export class CfMemoryStateStore implements MemoryStateStore {
  constructor(private readonly stub: TagStateRpc) {}

  async getAgentMemory(agentId: string): Promise<AgentMemory> {
    const response = await this.execute({ kind: 'get_agent_memory', agentId });
    return response.memory;
  }

  async putAgentMemory(input: PutAgentMemoryInput): Promise<AgentMemory> {
    const response = await this.execute({ kind: 'put_agent_memory', input });
    return response.memory;
  }

  private async execute(request: MemoryRpcRequest): Promise<MemoryRpcResponse> {
    return unwrap(await this.stub.memoryExecute(request));
  }
}

export class CfRoutineStore implements RoutineStore {
  constructor(private readonly stub: TagStateRpc) {}

  async putConfirmation(input: PutRoutineConfirmationInput): Promise<RoutineConfirmation> {
    const response = await this.execute({ kind: 'put_confirmation', input });
    if (response.kind !== 'confirmation' || !response.confirmation) throw unexpectedRoutineResponse();
    return response.confirmation;
  }
  async getConfirmation(tokenHash: string): Promise<RoutineConfirmation | undefined> {
    const response = await this.execute({ kind: 'get_confirmation', tokenHash });
    if (response.kind !== 'confirmation') throw unexpectedRoutineResponse();
    return orUndefined(response.confirmation);
  }
  async cancelConfirmation(input: CancelRoutineConfirmationInput): Promise<boolean> {
    const response = await this.execute({ kind: 'cancel_confirmation', input });
    if (response.kind !== 'boolean') throw unexpectedRoutineResponse();
    return response.value;
  }
  async confirm(input: ConfirmRoutineInput): Promise<RoutineDefinition> {
    return this.requiredRoutine(await this.execute({ kind: 'confirm', input }));
  }
  async save(input: SaveRoutineInput): Promise<RoutineDefinition> {
    return this.requiredRoutine(await this.execute({ kind: 'save', input }));
  }
  async purgeConfirmations(): Promise<number> {
    const response = await this.execute({ kind: 'purge_confirmations' });
    if (response.kind !== 'purged') throw unexpectedRoutineResponse();
    return response.count;
  }
  async cleanupRetention(): Promise<RoutineMaintenanceResult> {
    const response = await this.execute({ kind: 'cleanup_retention' });
    if (response.kind !== 'maintenance') throw unexpectedRoutineResponse();
    return response.result;
  }
  async getRoutine(routineId: string): Promise<RoutineDefinition | undefined> {
    const response = await this.execute({ kind: 'get_routine', routineId });
    if (response.kind !== 'routine') throw unexpectedRoutineResponse();
    return orUndefined(response.routine);
  }
  async listRoutines(workspaceId?: string, channelId?: string): Promise<RoutineDefinition[]> {
    const response = await this.execute({
      kind: 'list_routines',
      ...(workspaceId ? { workspaceId } : {}),
      ...(channelId ? { channelId } : {}),
    });
    if (response.kind !== 'routines') throw unexpectedRoutineResponse();
    return response.routines;
  }
  async listAdminRoutinePage(input: RoutineAdminPageInput): Promise<RoutineAdminPage> {
    const response = await this.execute({ kind: 'list_admin_routine_page', input });
    if (response.kind !== 'admin_routine_page') throw unexpectedRoutineResponse();
    return response.page;
  }
  async listRevisions(routineId: string): Promise<RoutineRevision[]> {
    const response = await this.execute({ kind: 'list_revisions', routineId });
    if (response.kind !== 'revisions') throw unexpectedRoutineResponse();
    return response.revisions;
  }
  async control(input: ControlRoutineInput): Promise<RoutineDefinition> {
    return this.requiredRoutine(await this.execute({ kind: 'control', input }));
  }
  async createOccurrence(input: CreateRoutineOccurrenceInput): Promise<RoutineRun> {
    return this.requiredRun(await this.execute({ kind: 'create_occurrence', input }));
  }
  async getRun(occurrenceId: string): Promise<RoutineRun | undefined> {
    const response = await this.execute({ kind: 'get_run', occurrenceId });
    if (response.kind !== 'run') throw unexpectedRoutineResponse();
    return orUndefined(response.run);
  }
  async listRuns(filter: RoutineRunFilter = {}): Promise<RoutineRun[]> {
    const response = await this.execute({ kind: 'list_runs', filter });
    if (response.kind !== 'runs') throw unexpectedRoutineResponse();
    return response.runs;
  }
  async countAdmittingOrRunningOccurrences(): Promise<number> {
    const response = await this.execute({ kind: 'count_admitting_or_running_occurrences' });
    if (response.kind !== 'count') throw unexpectedRoutineResponse();
    return response.count;
  }
  async claimDueSchedules(input: ClaimDueRoutinesInput): Promise<RoutineDueClaimBatch> {
    const response = await this.execute({ kind: 'claim_due_schedules', input });
    if (response.kind !== 'due_claims') throw unexpectedRoutineResponse();
    return response.batch;
  }
  async startAdmissionAttempt(input: StartRoutineAdmissionInput): Promise<RoutineAdmissionAttempt> {
    const response = await this.execute({ kind: 'start_admission', input });
    if (response.kind !== 'admission') throw unexpectedRoutineResponse();
    return response.admission;
  }
  async recordAdmissionReceipt(
    occurrenceId: string,
    attempt: number,
    flueRunId: string,
    receiptAt: number,
  ): Promise<RoutineAdmissionAttempt> {
    const response = await this.execute({
      kind: 'record_admission_receipt', occurrenceId, attempt, flueRunId, receiptAt,
    });
    if (response.kind !== 'admission') throw unexpectedRoutineResponse();
    return response.admission;
  }
  async resolveAdmission(input: ResolveRoutineAdmissionInput): Promise<RoutineRun> {
    return this.requiredRun(await this.execute({ kind: 'resolve_admission', input }));
  }
  async beginOccurrence(input: BeginRoutineOccurrenceInput): Promise<'started' | 'superseded'> {
    const response = await this.execute({ kind: 'begin_occurrence', input });
    if (response.kind !== 'begin') throw unexpectedRoutineResponse();
    return response.outcome;
  }
  async prepareAgentDispatch(
    input: PrepareRoutineAgentDispatchInput,
  ): Promise<'started' | 'superseded'> {
    const response = await this.execute({ kind: 'prepare_agent_dispatch', input });
    if (response.kind !== 'begin') throw unexpectedRoutineResponse();
    return response.outcome;
  }
  async recordAgentReceipt(
    input: RecordRoutineAgentReceiptInput,
  ): Promise<RoutineAdmissionAttempt> {
    const response = await this.execute({ kind: 'record_agent_receipt', input });
    if (response.kind !== 'admission') throw unexpectedRoutineResponse();
    return response.admission;
  }
  async recordAgentSettlement(input: RecordRoutineAgentSettlementInput): Promise<RoutineRun> {
    return this.requiredRun(await this.execute({ kind: 'record_agent_settlement', input }));
  }
  async transitionRun(input: TransitionRoutineRunInput): Promise<RoutineRun> {
    return this.requiredRun(await this.execute({ kind: 'transition_run', input }));
  }
  async claimDelivery(input: ClaimRoutineDeliveryInput): Promise<'claimed' | 'superseded'> {
    const response = await this.execute({ kind: 'claim_delivery', input });
    if (response.kind !== 'delivery_claim') throw unexpectedRoutineResponse();
    return response.outcome;
  }
  async recordDelivery(input: RecordRoutineDeliveryInput): Promise<RoutineRun> {
    return this.requiredRun(await this.execute({ kind: 'record_delivery', input }));
  }
  async listAdmissions(occurrenceId: string): Promise<RoutineAdmissionAttempt[]> {
    const response = await this.execute({ kind: 'list_admissions', occurrenceId });
    if (response.kind !== 'admissions') throw unexpectedRoutineResponse();
    return response.admissions;
  }
  async listAuditEvents(filter: AuditEventFilter = {}): Promise<AuditEvent[]> {
    const response = await this.execute({ kind: 'list_audit_events', filter });
    if (response.kind !== 'audit_events') throw unexpectedRoutineResponse();
    return response.events;
  }

  private async execute(request: RoutineRpcRequest): Promise<RoutineRpcResponse> {
    return unwrap(await this.stub.routinesExecute(request));
  }
  private requiredRoutine(response: RoutineRpcResponse): RoutineDefinition {
    if (response.kind !== 'routine' || !response.routine) throw unexpectedRoutineResponse();
    return response.routine;
  }
  private requiredRun(response: RoutineRpcResponse): RoutineRun {
    if (response.kind !== 'run' || !response.run) throw unexpectedRoutineResponse();
    return response.run;
  }
}

export class CfUsageStore implements UsageStore {
  constructor(private readonly stub: TagStateRpc) {}

  async admitOperation(input: AdmitUsageOperationInput): Promise<UsageOperation> {
    const response = await this.execute({ kind: 'admit_operation', input });
    if (response.kind !== 'operation') throw unexpectedUsageResponse();
    return response.operation;
  }

  async recordTerminal(input: RecordUsageTerminalInput): Promise<UsageOperationDetail> {
    const response = await this.execute({ kind: 'record_terminal', input });
    if (response.kind !== 'detail' || !response.detail) throw unexpectedUsageResponse();
    return response.detail;
  }

  async recordConnectorUsage(input: RecordConnectorUsageInput): Promise<ConnectorUsageRecord> {
    const response = await this.execute({ kind: 'record_connector_usage', input });
    if (response.kind !== 'connector_usage') throw unexpectedUsageResponse();
    return response.usage;
  }

  async reserveConnectorQuota(
    input: ReserveConnectorQuotaInput,
  ): Promise<ConnectorQuotaReservation> {
    const response = await this.execute({ kind: 'reserve_connector_quota', input });
    if (response.kind !== 'connector_quota') throw unexpectedUsageResponse();
    return response.reservation;
  }

  async releaseConnectorQuota(input: ReleaseConnectorQuotaInput): Promise<boolean> {
    const response = await this.execute({ kind: 'release_connector_quota', input });
    if (response.kind !== 'connector_quota_released') throw unexpectedUsageResponse();
    return response.released;
  }

  async summarizeConnectorUsage(
    query: ConnectorUsageSummaryQuery,
  ): Promise<ConnectorUsageSummary> {
    const response = await this.execute({ kind: 'summarize_connector_usage', query });
    if (response.kind !== 'connector_usage_summary') throw unexpectedUsageResponse();
    return response.summary;
  }

  async getOperation(operationId: string): Promise<UsageOperationDetail | undefined> {
    const response = await this.execute({ kind: 'get_operation', operationId });
    if (response.kind !== 'detail') throw unexpectedUsageResponse();
    return orUndefined(response.detail);
  }

  async getOperationByRunId(runId: string): Promise<UsageOperationDetail | undefined> {
    const response = await this.execute({ kind: 'get_operation_by_run', runId });
    if (response.kind !== 'detail') throw unexpectedUsageResponse();
    return orUndefined(response.detail);
  }

  async listOperations(query: UsageQuery): Promise<UsageOperationPage> {
    const response = await this.execute({ kind: 'list_operations', query });
    if (response.kind !== 'operation_page') throw unexpectedUsageResponse();
    return response.page;
  }

  async summarize(query: UsageQuery): Promise<UsageSummary> {
    const response = await this.execute({ kind: 'summarize', query });
    if (response.kind !== 'summary') throw unexpectedUsageResponse();
    return response.summary;
  }

  async putCredential(input: PutModelCredentialInput): Promise<ModelCredentialRecord> {
    const response = await this.execute({ kind: 'put_credential', input });
    if (response.kind !== 'credential') throw unexpectedUsageResponse();
    return response.credential;
  }

  async retireCredential(
    credentialRefId: string,
    version: number,
    retiredAt: number,
  ): Promise<ModelCredentialRecord> {
    const response = await this.execute({
      kind: 'retire_credential',
      credentialRefId,
      version,
      retiredAt,
    });
    if (response.kind !== 'credential') throw unexpectedUsageResponse();
    return response.credential;
  }

  async listCredentials(providerId?: string): Promise<ModelCredentialRecord[]> {
    const response = await this.execute({
      kind: 'list_credentials',
      ...(providerId ? { providerId } : {}),
    });
    if (response.kind !== 'credentials') throw unexpectedUsageResponse();
    return response.credentials;
  }

  async cleanupRetention(at?: number): Promise<UsageRetentionResult> {
    const response = await this.execute({
      kind: 'cleanup_retention',
      ...(at === undefined ? {} : { at }),
    });
    if (response.kind !== 'retention') throw unexpectedUsageResponse();
    return response.result;
  }

  async getRetentionStatus(): Promise<UsageRetentionStatus> {
    const response = await this.execute({ kind: 'retention_status' });
    if (response.kind !== 'retention_status') throw unexpectedUsageResponse();
    return response.status;
  }

  async listUsageAuditEvents(limit?: number): Promise<AuditEvent[]> {
    const response = await this.execute({
      kind: 'list_usage_audit_events',
      ...(limit === undefined ? {} : { limit }),
    });
    if (response.kind !== 'audit_events') throw unexpectedUsageResponse();
    return response.events;
  }

  private async execute(request: UsageRpcRequest): Promise<UsageRpcResponse> {
    return unwrap(await this.stub.usageExecute(request));
  }
}

export class CfWorkStore implements WorkStore {
  constructor(private readonly stub: TagStateRpc) {}

  async putConfigRevision(input: SafeEffectiveConfigInput, createdAt?: number) {
    const response = await this.execute({
      kind: 'put_config_revision',
      input,
      ...(createdAt === undefined ? {} : { createdAt }),
    });
    if (response.kind !== 'config_revision' || !response.revision) {
      throw unexpectedWorkResponse();
    }
    return response.revision;
  }

  async getConfigRevision(revisionId: EffectiveConfigRevisionId) {
    const response = await this.execute({ kind: 'get_config_revision', revisionId });
    if (response.kind !== 'config_revision') throw unexpectedWorkResponse();
    return orUndefined(response.revision);
  }

  async putContent(input: PutLedgerContentInput) {
    const response = await this.execute({ kind: 'put_content', input });
    if (response.kind !== 'content' || !response.content) throw unexpectedWorkResponse();
    return response.content;
  }

  async getContent(ref: LedgerContentRef, at?: number) {
    const response = await this.execute({
      kind: 'get_content',
      ref,
      ...(at === undefined ? {} : { at }),
    });
    if (response.kind !== 'content') throw unexpectedWorkResponse();
    return orUndefined(response.content);
  }

  async purgeContent(at?: number, limit?: number) {
    const response = await this.execute({
      kind: 'purge_content',
      ...(at === undefined ? {} : { at }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (response.kind !== 'purge') throw unexpectedWorkResponse();
    return response.result;
  }

  async createGraph(input: CreateWorkGraphInput) {
    const response = await this.execute({ kind: 'create_graph', input });
    if (response.kind !== 'graph') throw unexpectedWorkResponse();
    return { work: response.work, binding: response.binding, run: response.run };
  }

  async admitShadowRun(input: AdmitShadowRunInput) {
    const response = await this.execute({ kind: 'admit_shadow_run', input });
    if (response.kind !== 'shadow_admission') throw unexpectedWorkResponse();
    return response.admission;
  }

  async getWork(workId: WorkId) {
    const response = await this.execute({ kind: 'get_work', workId });
    if (response.kind !== 'work') throw unexpectedWorkResponse();
    return orUndefined(response.work);
  }

  async getBinding(bindingId: BindingId) {
    const response = await this.execute({ kind: 'get_binding', bindingId });
    if (response.kind !== 'binding') throw unexpectedWorkResponse();
    return orUndefined(response.binding);
  }

  async getRun(runId: RunId) {
    const response = await this.execute({ kind: 'get_run', runId });
    if (response.kind !== 'run') throw unexpectedWorkResponse();
    return orUndefined(response.run);
  }

  async getRunVisibilities(runIds: RunId[]) {
    const response = await this.execute({ kind: 'get_run_visibilities', runIds });
    if (response.kind !== 'run_visibilities') throw unexpectedWorkResponse();
    return response.visibilities;
  }

  async claimNextInteractiveRun(input: ClaimNextInteractiveRunInput) {
    const response = await this.execute({ kind: 'claim_next_interactive_run', input });
    if (response.kind !== 'run_claim') throw unexpectedWorkResponse();
    return orUndefined(response.claim);
  }

  async renewRunLease(input: RenewRunLeaseInput) {
    const response = await this.execute({ kind: 'renew_run_lease', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async releaseRunLease(input: ReleaseRunLeaseInput) {
    const response = await this.execute({ kind: 'release_run_lease', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async listRuns(input: ListWorkRunsInput) {
    const response = await this.execute({ kind: 'list_runs', input });
    if (response.kind !== 'run_page') throw unexpectedWorkResponse();
    return response.page;
  }

  async countExecutingRuns() {
    const response = await this.execute({ kind: 'count_executing_runs' });
    if (response.kind !== 'count') throw unexpectedWorkResponse();
    return response.count;
  }

  async listRunExecutions(runId: RunId, limit?: number) {
    const response = await this.execute({
      kind: 'list_run_executions',
      runId,
      ...(limit === undefined ? {} : { limit }),
    });
    if (response.kind !== 'executions') throw unexpectedWorkResponse();
    return response.executions;
  }

  async createRunExecution(input: CreateRunExecutionInput) {
    const response = await this.execute({ kind: 'create_execution', input });
    if (response.kind !== 'execution' || !response.execution) {
      throw unexpectedWorkResponse();
    }
    return response.execution;
  }

  async recordRunExecutionRoute(input: RunExecutionRouteInput) {
    const response = await this.execute({ kind: 'record_execution_route', input });
    if (response.kind !== 'execution' || !response.execution) {
      throw unexpectedWorkResponse();
    }
    return response.execution;
  }

  async prepareRunInput(input: PrepareRunInput) {
    const response = await this.execute({ kind: 'prepare_run_input', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async markRunExecutionInvoked(input: MarkRunExecutionInvokedInput) {
    const response = await this.execute({ kind: 'mark_execution_invoked', input });
    if (response.kind !== 'execution' || !response.execution) {
      throw unexpectedWorkResponse();
    }
    return response.execution;
  }

  async settleRunExecution(input: SettleRunExecutionInput) {
    const response = await this.execute({ kind: 'settle_execution', input });
    if (response.kind !== 'execution' || !response.execution) {
      throw unexpectedWorkResponse();
    }
    return response.execution;
  }

  async recordRunResponse(input: RecordRunResponseInput) {
    const response = await this.execute({ kind: 'record_run_response', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async startRunDelivery(input: StartRunDeliveryInput) {
    const response = await this.execute({ kind: 'start_run_delivery', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async finalizeRunDelivery(input: FinalizeRunDeliveryInput) {
    const response = await this.execute({ kind: 'finalize_run_delivery', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async settleRunWithoutDelivery(input: SettleRunWithoutDeliveryInput) {
    const response = await this.execute({ kind: 'settle_run_without_delivery', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async recordWorkAction(input: RecordWorkActionInput) {
    const response = await this.execute({ kind: 'record_work_action', input });
    if (response.kind !== 'audit_events' || response.events.length !== 1) {
      throw unexpectedWorkResponse();
    }
    return response.events[0]!;
  }

  async getRunExecution(executionId: RunExecutionId) {
    const response = await this.execute({ kind: 'get_execution', executionId });
    if (response.kind !== 'execution') throw unexpectedWorkResponse();
    return orUndefined(response.execution);
  }

  async requireRecovery(input: RequireRunRecoveryInput) {
    const response = await this.execute({ kind: 'require_recovery', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async quarantineRun(input: QuarantineRunInput) {
    const response = await this.execute({ kind: 'quarantine_run', input });
    if (response.kind !== 'run' || !response.run) throw unexpectedWorkResponse();
    return response.run;
  }

  async listAuditEvents(runId: RunId, limit?: number) {
    const response = await this.execute({
      kind: 'list_audit_events',
      runId,
      ...(limit === undefined ? {} : { limit }),
    });
    if (response.kind !== 'audit_events') throw unexpectedWorkResponse();
    return response.events;
  }

  async verifyIntegrity() {
    const response = await this.execute({ kind: 'verify_integrity' });
    if (response.kind !== 'integrity') throw unexpectedWorkResponse();
    return response.report;
  }

  private async execute(request: WorkRpcRequest): Promise<WorkRpcResponse> {
    return unwrap(await this.stub.workExecute(request));
  }
}

function unexpectedManagementResponse(): Error {
  return new Error('Unexpected management state RPC response');
}

function unexpectedIdentityResponse(): Error {
  return new Error('Unexpected identity state response');
}

function unexpectedRoutineResponse(): Error {
  return new Error('Unexpected routine state response');
}

function unexpectedUsageResponse(): Error {
  return new Error('Unexpected usage state response');
}

function unexpectedWorkResponse(): Error {
  return new Error('Unexpected Work state response');
}
