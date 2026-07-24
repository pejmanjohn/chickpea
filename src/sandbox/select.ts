import type { RepositoryGrant } from '../config/types.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

export type SandboxSelection = 'bash' | 'cloudflare' | 'local';

export interface SandboxSelectionInput {
  target: 'cloudflare' | 'node';
  enabled: boolean;
  localEnabled: boolean;
  repositoryGrants: readonly RepositoryGrant[];
}

/**
 * Select only the Flue adapter. Provider construction stays at the agent seam,
 * after this pure decision, so tests never need a real container or host shell.
 */
export function selectSandbox(input: SandboxSelectionInput): SandboxSelection {
  if (!input.enabled) return 'bash';
  if (input.target === 'node') {
    return input.localEnabled ? 'local' : 'bash';
  }
  return validEnabledRepositoryGrants(input.repositoryGrants).length > 0
    ? 'cloudflare'
    : 'bash';
}

/** A declined Cloudflare reservation falls back before getSandbox is called. */
export function applySandboxSessionCap(
  selection: SandboxSelection,
  sessionAllowed: boolean | undefined,
): SandboxSelection {
  return selection === 'cloudflare' && sessionAllowed === false ? 'bash' : selection;
}
