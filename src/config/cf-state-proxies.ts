import { AgentExistsError, AgentStillAssignedError, UnknownAgentError } from './errors.ts';
import type { AssignmentLookupOptions } from './resolver.ts';
import type { SettingsPatch, SettingsStore } from './settings-store.ts';
import type { AgentSnapshotStore } from './snapshot-store.ts';
import type { StateRpcResult, TagStateRpc } from './state-rpc.ts';
import type { ConfigAgentPatch, ConfigStore, OAuthReauthorizationTarget } from './store.ts';
import type { AgentSnapshot, ChannelAssignment, CustomAgentConfig } from './types.ts';
import type {
  SlackCanonicalAdmissionInput,
  SlackStateStore,
} from '../slack/claim-store.ts';
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
  MemoryRateLimitError,
  MemoryVersionConflictError,
  type ApplyMemoryImportInput,
  type CreateMemoryEntryInput,
  type CreateForgetChallengeInput,
  type ConfirmMemoryConversationContextInput,
  type ForgetMemoryEntryInput,
  type MemoryConversationContext,
  type MemoryChannelScopeState,
  type MemoryEntry,
  type MemoryEntryFilter,
  type MemoryEntryScopeSummary,
  type MemoryForgetChallenge,
  type MergeMemoryEntriesInput,
  type MemoryMutationCounts,
  type MemoryRevision,
  type MemoryRpcRequest,
  type MemoryRpcResponse,
  type MemoryStateStore,
  type MemoryStoreDescriptor,
  type ObserveMemoryChannelScopeInput,
  type RecordMemoryReviewInput,
  type RecordMemoryAdminViewInput,
  type RecordMemoryAdminEventInput,
  type ReplayMemoryImportInput,
  type RetainMemoryChannelScopeInput,
  type ResolveMemoryConversationContextInput,
  type TransitionMemoryEntryInput,
  type UpdateMemoryEntryInput,
} from '../memory/types.ts';
import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';
import {
  UsageStateError,
  type AdmitUsageOperationInput,
  type ModelCredentialRecord,
  type PutModelCredentialInput,
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
    case 'agent_still_assigned':
      throw new AgentStillAssignedError(details?.agentId ?? 'unknown', details?.keys ?? '');
    case 'memory': {
      const memoryCode = details?.memoryCode ?? 'memory_state_error';
      if (memoryCode === 'memory_version_conflict') {
        throw new MemoryVersionConflictError(
          details?.entryId ?? 'unknown',
          Number(details?.currentVersion ?? 0),
        );
      }
      if (memoryCode === 'memory_rate_limited') {
        const retryAt = Number(details?.retryAt);
        if (Number.isSafeInteger(retryAt) && retryAt > 0) {
          throw new MemoryRateLimitError(retryAt);
        }
      }
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
    default:
      throw new Error(message);
  }
}

/** `null` travels the wire; consumers expect `undefined` for "no row". */
function orUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export class CfConfigStore implements ConfigStore {
  constructor(private readonly stub: TagStateRpc) {}

  async listAgents(): Promise<CustomAgentConfig[]> {
    return unwrap(await this.stub.configListAgents());
  }

  async getAgent(agentId: string): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configGetAgent(agentId));
  }

  async createAgent(agent: CustomAgentConfig): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configCreateAgent(agent));
  }

  async updateAgent(agentId: string, patch: ConfigAgentPatch): Promise<CustomAgentConfig> {
    return unwrap(await this.stub.configUpdateAgent(agentId, patch));
  }

  async markOAuthReauthorizationRequired(target: OAuthReauthorizationTarget): Promise<boolean> {
    return unwrap(await this.stub.configMarkOAuthReauthorizationRequired(target));
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    return unwrap(await this.stub.configDeleteAgent(agentId));
  }

  async listAssignments(): Promise<ChannelAssignment[]> {
    return unwrap(await this.stub.configListAssignments());
  }

  async getAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<ChannelAssignment | undefined> {
    return orUndefined(unwrap(await this.stub.configGetAssignment(workspaceId, channelId)));
  }

  async listAssignmentsForAgent(agentId: string): Promise<ChannelAssignment[]> {
    return unwrap(await this.stub.configListAssignmentsForAgent(agentId));
  }

  async putAssignment(assignment: ChannelAssignment): Promise<ChannelAssignment> {
    return unwrap(await this.stub.configPutAssignment(assignment));
  }

  async deleteAssignment(workspaceId: string, channelId: string): Promise<boolean> {
    return unwrap(await this.stub.configDeleteAssignment(workspaceId, channelId));
  }

  async find(
    workspaceId: string,
    channelId: string,
    options: AssignmentLookupOptions = {},
  ): Promise<ChannelAssignment | undefined> {
    return orUndefined(unwrap(await this.stub.configFind(workspaceId, channelId, options)));
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

  async admitCanonical(input: SlackCanonicalAdmissionInput) {
    return unwrap(await this.stub.admitSlackTurn(input));
  }

  async putAgentExecutionContext(input: Parameters<SlackStateStore['putAgentExecutionContext']>[0]) {
    return unwrap(await this.stub.slackAgentExecutionContextPut(input));
  }

  async getAgentExecutionContext(continuityKey: string) {
    return orUndefined(unwrap(await this.stub.slackAgentExecutionContextGet(continuityKey)));
  }
}

export class CfSettingsStore implements SettingsStore {
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
}

export class CfMemoryStateStore implements MemoryStateStore {
  constructor(private readonly stub: TagStateRpc) {}

  async ensurePublicStore(workspaceId: string): Promise<MemoryStoreDescriptor> {
    const response = await this.execute({ kind: 'ensure_public_store', workspaceId });
    if (response.kind !== 'store' || !response.store) throw unexpectedMemoryResponse();
    return response.store;
  }

  async ensurePrivateStore(
    workspaceId: string,
    channelId: string,
    generation: number,
  ): Promise<MemoryStoreDescriptor> {
    const response = await this.execute({
      kind: 'ensure_private_store',
      workspaceId,
      channelId,
      generation,
    });
    if (response.kind !== 'store' || !response.store) throw unexpectedMemoryResponse();
    return response.store;
  }

  async getStore(storeId: string): Promise<MemoryStoreDescriptor | undefined> {
    const response = await this.execute({ kind: 'get_store', storeId });
    if (response.kind !== 'store') throw unexpectedMemoryResponse();
    return orUndefined(response.store);
  }

  async listStores(workspaceId?: string): Promise<MemoryStoreDescriptor[]> {
    const response = await this.execute({
      kind: 'list_stores',
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (response.kind !== 'stores') throw unexpectedMemoryResponse();
    return response.stores;
  }

  async createEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    return this.requiredEntry(await this.execute({ kind: 'create_entry', input }));
  }

  async getEntry(entryId: string): Promise<MemoryEntry | undefined> {
    const response = await this.execute({ kind: 'get_entry', entryId });
    if (response.kind !== 'entry') throw unexpectedMemoryResponse();
    return orUndefined(response.entry);
  }

  async listEntries(filter: MemoryEntryFilter = {}): Promise<MemoryEntry[]> {
    const response = await this.execute({ kind: 'list_entries', filter });
    if (response.kind !== 'entries') throw unexpectedMemoryResponse();
    return response.entries;
  }

  async listEntryScopeSummaries(workspaceId?: string): Promise<MemoryEntryScopeSummary[]> {
    const response = await this.execute({
      kind: 'list_entry_scope_summaries',
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (response.kind !== 'entry_scope_summaries') throw unexpectedMemoryResponse();
    return response.summaries;
  }

  async replayImport(input: ReplayMemoryImportInput): Promise<MemoryEntry[] | undefined> {
    const response = await this.execute({ kind: 'replay_import', input });
    if (response.kind !== 'import_replay') throw unexpectedMemoryResponse();
    return orUndefined(response.entries);
  }

  async applyImport(input: ApplyMemoryImportInput): Promise<MemoryEntry[]> {
    const response = await this.execute({ kind: 'apply_import', input });
    if (response.kind !== 'entries') throw unexpectedMemoryResponse();
    return response.entries;
  }

  async recordAdminView(input: RecordMemoryAdminViewInput): Promise<void> {
    const response = await this.execute({ kind: 'record_admin_view', input });
    if (response.kind !== 'ok') throw unexpectedMemoryResponse();
  }

  async recordAdminEvent(input: RecordMemoryAdminEventInput): Promise<void> {
    const response = await this.execute({ kind: 'record_admin_event', input });
    if (response.kind !== 'ok') throw unexpectedMemoryResponse();
  }

  async updateEntry(input: UpdateMemoryEntryInput): Promise<MemoryEntry> {
    return this.requiredEntry(await this.execute({ kind: 'update_entry', input }));
  }

  async forgetEntry(input: ForgetMemoryEntryInput): Promise<MemoryEntry> {
    return this.requiredEntry(await this.execute({ kind: 'forget_entry', input }));
  }

  async transitionEntry(input: TransitionMemoryEntryInput): Promise<MemoryEntry> {
    return this.requiredEntry(await this.execute({ kind: 'transition_entry', input }));
  }

  async mergeEntries(input: MergeMemoryEntriesInput): Promise<MemoryEntry> {
    return this.requiredEntry(await this.execute({ kind: 'merge_entries', input }));
  }

  async recordReview(input: RecordMemoryReviewInput): Promise<void> {
    const response = await this.execute({ kind: 'record_review', input });
    if (response.kind !== 'ok') throw unexpectedMemoryResponse();
  }

  async createForgetChallenge(input: CreateForgetChallengeInput): Promise<void> {
    const response = await this.execute({ kind: 'create_forget_challenge', input });
    if (response.kind !== 'ok') throw unexpectedMemoryResponse();
  }

  async getForgetChallenge(
    tokenHash: string,
    actorId: string,
  ): Promise<MemoryForgetChallenge | undefined> {
    const response = await this.execute({ kind: 'get_forget_challenge', tokenHash, actorId });
    if (response.kind !== 'forget_challenge') throw unexpectedMemoryResponse();
    return orUndefined(response.challenge);
  }

  async listRevisions(entryId: string): Promise<MemoryRevision[]> {
    const response = await this.execute({ kind: 'list_revisions', entryId });
    if (response.kind !== 'revisions') throw unexpectedMemoryResponse();
    return response.revisions;
  }

  async listAuditEvents(filter: AuditEventFilter = {}): Promise<AuditEvent[]> {
    const response = await this.execute({ kind: 'list_audit_events', filter });
    if (response.kind !== 'audit_events') throw unexpectedMemoryResponse();
    return response.events;
  }

  async getMutationCounts(
    workspaceId: string,
    channelId: string,
    actorId: string,
  ): Promise<MemoryMutationCounts> {
    const response = await this.execute({
      kind: 'get_mutation_counts',
      workspaceId,
      channelId,
      actorId,
    });
    if (response.kind !== 'mutation_counts') throw unexpectedMemoryResponse();
    return response.counts;
  }

  async resolveConversationContext(
    input: ResolveMemoryConversationContextInput,
  ): Promise<MemoryConversationContext> {
    const response = await this.execute({ kind: 'resolve_conversation_context', input });
    if (response.kind !== 'conversation_context') throw unexpectedMemoryResponse();
    return response.context;
  }

  async confirmConversationContext(
    input: ConfirmMemoryConversationContextInput,
  ): Promise<boolean> {
    const response = await this.execute({ kind: 'confirm_conversation_context', input });
    if (response.kind !== 'conversation_context_confirmed') {
      throw unexpectedMemoryResponse();
    }
    return response.confirmed;
  }

  async observeChannelScope(
    input: ObserveMemoryChannelScopeInput,
  ): Promise<MemoryChannelScopeState> {
    const response = await this.execute({ kind: 'observe_channel_scope', input });
    if (response.kind !== 'channel_scope' || !response.state) {
      throw unexpectedMemoryResponse();
    }
    return response.state;
  }

  async retainChannelScope(
    input: RetainMemoryChannelScopeInput,
  ): Promise<MemoryChannelScopeState> {
    const response = await this.execute({ kind: 'retain_channel_scope', input });
    if (response.kind !== 'channel_scope' || !response.state) {
      throw unexpectedMemoryResponse();
    }
    return response.state;
  }

  async getChannelScope(
    workspaceId: string,
    channelId: string,
  ): Promise<MemoryChannelScopeState | undefined> {
    const response = await this.execute({ kind: 'get_channel_scope', workspaceId, channelId });
    if (response.kind !== 'channel_scope') throw unexpectedMemoryResponse();
    return orUndefined(response.state);
  }

  async listChannelScopes(workspaceId?: string): Promise<MemoryChannelScopeState[]> {
    const response = await this.execute({
      kind: 'list_channel_scopes',
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (response.kind !== 'channel_scopes') throw unexpectedMemoryResponse();
    return response.states;
  }

  async cleanupRetention(): Promise<{
    actorIdsCleared: number;
    rateWindowsDeleted: number;
    contextsDeleted: number;
    forgetChallengesDeleted: number;
  }> {
    const response = await this.execute({ kind: 'cleanup_retention' });
    if (response.kind !== 'cleanup') throw unexpectedMemoryResponse();
    return {
      actorIdsCleared: response.actorIdsCleared,
      rateWindowsDeleted: response.rateWindowsDeleted,
      contextsDeleted: response.contextsDeleted,
      forgetChallengesDeleted: response.forgetChallengesDeleted,
    };
  }

  private async execute(request: MemoryRpcRequest): Promise<MemoryRpcResponse> {
    return unwrap(await this.stub.memoryExecute(request));
  }

  private requiredEntry(response: MemoryRpcResponse): MemoryEntry {
    if (response.kind !== 'entry' || !response.entry) throw unexpectedMemoryResponse();
    return response.entry;
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

function unexpectedMemoryResponse(): Error {
  return new Error('Unexpected memory state response');
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
