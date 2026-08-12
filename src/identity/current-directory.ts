import { BetterAuthDirectory } from '../auth/better-auth-principal.ts';
import { resolveBetterAuthEnvironment } from '../auth/better-auth-environment.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { HumanIdentityDirectory, IdentityStore } from './types.ts';

/** Resolve the canonical membership directory for the installation's active auth mode. */
export async function currentHumanIdentityDirectory(
  identity: IdentityStore,
  platformEnv: PlatformEnv | undefined,
): Promise<HumanIdentityDirectory | undefined> {
  const control = await identity.getAuthControl();
  if (control?.authMode !== 'password_active') return identity;
  const environment = await resolveBetterAuthEnvironment({ control, platformEnv });
  if (!environment || !control.betterAuthOrganizationId || !control.canonicalAdminOrigin) return undefined;
  return new BetterAuthDirectory({
    backend: environment.backend,
    access: identity,
    organizationId: control.betterAuthOrganizationId,
    canonicalAdminOrigin: control.canonicalAdminOrigin,
  });
}
