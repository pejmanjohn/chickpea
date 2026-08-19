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
import type { IdentityStore } from '../identity/types.ts';
import type { UsageStore } from '../usage/types.ts';
import { WorkspaceManagementService, type WorkspaceManagementServiceInput } from './service.ts';
import {
  cancelManagedSlackIdentitySetup,
  clearManagedSlackIdentityCredentials,
  countManagedSlackIdentityDeliveries,
} from './slack-identity-lifecycle.ts';
import { resolveEligibleSlackInvitee } from './slack-directory.ts';

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
  return new WorkspaceManagementService({
    identity: overrides.identity ?? identity,
    config: getConfigStore(env),
    management: getManagementStore(env),
    memory: getMemoryStateStore(env),
    routines: getRoutineStore(env),
    work: getWorkStore(env),
    routineSchedulingAvailable: isCloudflareTarget(),
    providerCredentialSource: async (providerId) =>
      (await describeProviderKeySources(env, settings))[providerId],
    removeProviderCredential: async (providerId) =>
      (await deleteProviderApiKey(
        providerId,
        env,
        settings,
        options.usage ?? getUsageStore(env),
      )).source,
    resolveSlackInvitee: (slackUserId) =>
      resolveEligibleSlackInvitee(slackUserId, env, identity),
    countPendingSlackIdentityDeliveries: (identityId) =>
      countManagedSlackIdentityDeliveries(identityId, env),
    clearSlackIdentityCredentials: (identityId) =>
      clearManagedSlackIdentityCredentials(identityId, env),
    cancelSlackIdentitySetup: (identityId, expectedRevision) =>
      cancelManagedSlackIdentitySetup(identityId, expectedRevision, env),
    ...overrides,
  });
}
