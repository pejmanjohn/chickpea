import { AgentExistsError, AgentStillAssignedError, UnknownAgentError } from './errors.ts';
import type { AssignmentLookupOptions } from './resolver.ts';
import type { SettingsPatch, SettingsStore } from './settings-store.ts';
import type { AgentSnapshotStore } from './snapshot-store.ts';
import type { StateRpcResult, TagStateRpc } from './state-rpc.ts';
import type { ConfigAgentPatch, ConfigStore, OAuthReauthorizationTarget } from './store.ts';
import type { AgentSnapshot, ChannelAssignment, CustomAgentConfig } from './types.ts';
import type { SlackStateStore } from '../slack/claim-store.ts';
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
  type RoutineConfirmation,
  type RoutineDefinition,
  type RoutineDueClaimBatch,
  type RoutineRevision,
  type RoutineRpcRequest,
  type RoutineRpcResponse,
  type RoutineRun,
  type RoutineRunFilter,
  type RoutineStore,
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
  async purgeConfirmations(): Promise<number> {
    const response = await this.execute({ kind: 'purge_confirmations' });
    if (response.kind !== 'purged') throw unexpectedRoutineResponse();
    return response.count;
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

function unexpectedMemoryResponse(): Error {
  return new Error('Unexpected memory state response');
}

function unexpectedRoutineResponse(): Error {
  return new Error('Unexpected routine state response');
}
