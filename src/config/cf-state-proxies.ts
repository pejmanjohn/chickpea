import { AgentExistsError, AgentStillAssignedError, UnknownAgentError } from './errors.ts';
import type { AssignmentLookupOptions } from './resolver.ts';
import type { SettingsPatch, SettingsStore } from './settings-store.ts';
import type { AgentSnapshotStore } from './snapshot-store.ts';
import type { StateRpcResult, TagStateRpc } from './state-rpc.ts';
import type { ConfigAgentPatch, ConfigStore } from './store.ts';
import type { AgentSnapshot, ChannelAssignment, CustomAgentConfig } from './types.ts';
import type { SlackStateStore } from '../slack/claim-store.ts';

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
