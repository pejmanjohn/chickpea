import {
  getConfigStore,
  getSettingsStore,
  getSlackCredentialDependencies,
  getSlackCredentialResolutionDependencies,
  getSlackStateStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  clearSlackIdentityCredentials,
  resolveSlackIdentityCredentials,
} from '../slack/identity-credentials.ts';
import { cancelSlackIdentityConnection } from '../slack/identity-bootstrap.ts';
import type { SlackIdentity } from '../config/types.ts';

/** Secret-bound Slack identity operations shared by MCP and Slack adapters. */
export async function clearManagedSlackIdentityCredentials(
  identityId: string,
  env?: PlatformEnv,
): Promise<void> {
  const current = await resolveSlackIdentityCredentials(
    identityId,
    env,
    getSlackCredentialResolutionDependencies(env),
  );
  await clearSlackIdentityCredentials(
    getSlackCredentialDependencies(env),
    identityId,
    current.connectionRevision,
  );
}

export async function countManagedSlackIdentityDeliveries(
  identityId: string,
  env?: PlatformEnv,
): Promise<number> {
  return getSlackStateStore(env).countPendingDeliveriesForSlackIdentity(identityId);
}

export async function cancelManagedSlackIdentitySetup(
  identityId: string,
  expectedRevision: number,
  env?: PlatformEnv,
): Promise<SlackIdentity> {
  return cancelSlackIdentityConnection({
    config: getConfigStore(env),
    settings: getSettingsStore(env),
    identityId,
    expectedRevision,
    credentialDependencies: getSlackCredentialDependencies(env),
  });
}
