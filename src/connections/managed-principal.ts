import type { AuthPrincipal } from '../auth/types.ts';
import { composioEnvironmentName } from '../config/composio-settings.ts';
import { deploymentTenancy, installationScopeOf } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';

const MAX_MANAGED_PRINCIPAL_REF_LENGTH = 256;

/**
 * The Composio user a Personal or Team authorization belongs to. Under
 * installation tenancy it also names the deployment's Composio environment and
 * the installation, so installations sharing one project never share a remote
 * principal; without either it is undefined. Standalone forms are unchanged.
 */
export function managedPrincipalRef(
  principal: AuthPrincipal,
  ownerKind: 'team' | 'member',
  env: PlatformEnv | undefined,
): string | undefined {
  const local = ownerKind === 'member'
    ? `membership:${principal.membershipId}`
    : `organization:${principal.organizationId}`;
  let value = `chickpea:${local}`;
  if (deploymentTenancy(env) === 'installation') {
    const environment = composioEnvironmentName(env);
    const installationId = installationScopeOf(env)?.installationId;
    if (!environment || !installationId) return undefined;
    value = `chickpea:${environment}:installation:${installationId}:${local}`;
  }
  return value.length <= MAX_MANAGED_PRINCIPAL_REF_LENGTH ? value : undefined;
}
