import type { PlatformEnv } from '../config/state-backend.ts';
import type { HumanIdentityDirectory, IdentityStore } from './types.ts';

/** Resolve the canonical membership directory for the installation's active auth mode. */
export async function currentHumanIdentityDirectory(
  identity: IdentityStore,
  platformEnv: PlatformEnv | undefined,
): Promise<HumanIdentityDirectory | undefined> {
  void platformEnv;
  const control = await identity.getAuthControl();
  if (control?.authMode !== 'slack_active' || control.healthGate !== 'normal') return undefined;
  return identity;
}
