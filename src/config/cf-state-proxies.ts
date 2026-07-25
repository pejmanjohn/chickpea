import { AgentExistsError, AgentStillAssignedError, UnknownAgentError } from './errors.ts';
import type { AssignmentLookupOptions } from './resolver.ts';
import type { SettingsPatch, SettingsStore } from './settings-store.ts';
import type { AgentSnapshotStore } from './snapshot-store.ts';
import type { StateRpcResult, TagStateRpc } from './state-rpc.ts';
import type { ConfigAgentPatch, ConfigStore } from './store.ts';
import type { AgentSnapshot, ChannelAssignment, CustomAgentConfig } from './types.ts';
import type { SlackStateStore } from '../slack/claim-store.ts';
import {
  MemoryStateError,
  MemoryVersionConflictError,
  type CreateMemoryEntryInput,
  type CreateForgetChallengeInput,
  type ForgetMemoryEntryInput,
  type MemoryConversationContext,
  type MemoryChannelScopeState,
  type MemoryEntry,
  type MemoryEntryFilter,
  type MergeMemoryEntriesInput,
  type MemoryMutationCounts,
  type MemoryRevision,
  type MemoryRpcRequest,
  type MemoryRpcResponse,
  type MemoryStateStore,
  type MemoryStoreDescriptor,
  type ObserveMemoryChannelScopeInput,
  type RecordMemoryReviewInput,
  type ResolveMemoryConversationContextInput,
  type SetMemoryEnabledInput,
  type TransitionMemoryEntryInput,
  type UpdateMemoryEntryInput,
} from '../memory/types.ts';
import type { AuditEvent, AuditEventFilter } from '../audit/types.ts';

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
      const memoryDetails = { ...(details ?? {}) };
      delete memoryDetails.memoryCode;
      throw new MemoryStateError(memoryCode, message, memoryDetails);
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

  async observeChannelScope(
    input: ObserveMemoryChannelScopeInput,
  ): Promise<MemoryChannelScopeState> {
    const response = await this.execute({ kind: 'observe_channel_scope', input });
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

  async cleanupRetention(): Promise<{
    actorIdsCleared: number;
    rateWindowsDeleted: number;
    contextsDeleted: number;
  }> {
    const response = await this.execute({ kind: 'cleanup_retention' });
    if (response.kind !== 'cleanup') throw unexpectedMemoryResponse();
    return {
      actorIdsCleared: response.actorIdsCleared,
      rateWindowsDeleted: response.rateWindowsDeleted,
      contextsDeleted: response.contextsDeleted,
    };
  }

  async getMemoryEnabled(): Promise<boolean> {
    const response = await this.execute({ kind: 'get_memory_enabled' });
    if (response.kind !== 'memory_enabled') throw unexpectedMemoryResponse();
    return response.enabled;
  }

  async setMemoryEnabled(input: SetMemoryEnabledInput): Promise<boolean> {
    const response = await this.execute({ kind: 'set_memory_enabled', input });
    if (response.kind !== 'memory_enabled') throw unexpectedMemoryResponse();
    return response.enabled;
  }

  private async execute(request: MemoryRpcRequest): Promise<MemoryRpcResponse> {
    return unwrap(await this.stub.memoryExecute(request));
  }

  private requiredEntry(response: MemoryRpcResponse): MemoryEntry {
    if (response.kind !== 'entry' || !response.entry) throw unexpectedMemoryResponse();
    return response.entry;
  }
}

function unexpectedMemoryResponse(): Error {
  return new Error('Unexpected memory state response');
}
