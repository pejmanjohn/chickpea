import type { RepositoryGrant } from '../config/types.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

export type SandboxSelection = 'bash' | 'cloudflare' | 'local';

export interface SandboxSelectionInput {
  target: 'cloudflare' | 'node';
  enabled: boolean;
  localEnabled: boolean;
  appConnected: boolean;
  repositoryGrants: readonly RepositoryGrant[];
}

/**
 * Select only the Flue adapter. Provider construction stays at the agent seam,
 * after this pure decision, so tests never need a real container or host shell.
 *
 * The Node `local()` adapter is not isolated: it uses the host filesystem and
 * the process user's git/SSH credentials. It is trusted-operator-only and must
 * never become available without the same App connection and valid repository
 * grant prerequisites as the Cloudflare container.
 */
export function selectSandbox(input: SandboxSelectionInput): SandboxSelection {
  if (!input.enabled) return 'bash';
  const repositoryAccessReady =
    input.appConnected &&
    validEnabledRepositoryGrants(input.repositoryGrants).length > 0;
  if (!repositoryAccessReady) return 'bash';
  if (input.target === 'node') return input.localEnabled ? 'local' : 'bash';
  return 'cloudflare';
}
