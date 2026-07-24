import type { RepositoryGrant } from '../config/types.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

export type SandboxSelection = 'bash' | 'cloudflare';

export interface SandboxSelectionInput {
  target: 'cloudflare' | 'node';
  enabled: boolean;
  appConnected: boolean;
  repositoryGrants: readonly RepositoryGrant[];
}

/**
 * Select only the Flue adapter. Provider construction stays at the agent seam,
 * after this pure decision, so tests never need a real container.
 */
export function selectSandbox(input: SandboxSelectionInput): SandboxSelection {
  if (input.target === 'node') return 'bash';
  if (!input.enabled) return 'bash';
  const repositoryAccessReady =
    input.appConnected &&
    validEnabledRepositoryGrants(input.repositoryGrants).length > 0;
  if (!repositoryAccessReady) return 'bash';
  return 'cloudflare';
}
