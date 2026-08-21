import {
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getMemoryStateStore,
  getRoutineStore,
  getSettingsStore,
  getUsageStore,
  getWorkStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  deleteProviderApiKey,
  describeProviderKeySources,
} from '../config/provider-keys.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { storedCredentialMetadata } from '../config/model-credential-refs.ts';
import { clearRepointedMcpCredentials } from '../config/mcp-connection-lifecycle.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { UsageStore } from '../usage/types.ts';
import { WorkspaceManagementService, type WorkspaceManagementServiceInput } from './service.ts';
import {
  discoverManagedSlackChannels,
  testManagedMcpConnection,
} from './discovery.ts';

export interface LiveWorkspaceManagementServiceOptions {
  identity?: IdentityStore;
  settings?: SettingsStore;
  usage?: UsageStore;
  overrides?: Partial<WorkspaceManagementServiceInput>;
}

/** Keep production MCP, Slack, and Admin management dependencies aligned. */
export function createLiveWorkspaceManagementService(
  env?: PlatformEnv,
  options: LiveWorkspaceManagementServiceOptions = {},
): WorkspaceManagementService {
  const overrides = options.overrides ?? {};
  const settings = options.settings ?? getSettingsStore(env);
  const identity = options.identity ?? getIdentityStore(env);
  const config = overrides.config ?? getConfigStore(env);
  return new WorkspaceManagementService({
    identity: overrides.identity ?? identity,
    config,
    management: getManagementStore(env),
    memory: getMemoryStateStore(env),
    routines: getRoutineStore(env),
    work: getWorkStore(env),
    routineSchedulingAvailable: isCloudflareTarget(),
    providerCredentialSource: async (providerId) =>
      (await describeProviderKeySources(env, settings))[providerId],
    providerCredentialRevision: async (providerId) =>
      (await storedCredentialMetadata(providerId, settings))?.version ?? 0,
    removeProviderCredential: async (providerId) =>
      (await deleteProviderApiKey(
        providerId,
        env,
        settings,
        options.usage ?? getUsageStore(env),
      )).source,
    prepareAgentUpdate: (agent, patch) => clearRepointedMcpCredentials({
      agentId: agent.id,
      current: agent.mcpServers,
      next: patch.mcpServers,
      settings,
      ...(env ? { env } : {}),
    }),
    discoverSlackChannels: (refresh) => discoverManagedSlackChannels(refresh, env, identity),
    testMcpConnection: (agentId, connectionId) => testManagedMcpConnection({
      agentId,
      connectionId,
      ...(env ? { env } : {}),
      config,
      settings,
    }),
    ...overrides,
  });
}
