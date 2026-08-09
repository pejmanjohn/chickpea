import type { RepositoryGrant } from '../config/types.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

export type SandboxSelection = 'bash' | 'cloudflare';

export interface SandboxSelectionInput {
  target: 'cloudflare' | 'node';
  /** Live binding availability, never a persisted proxy for installation. */
  installed: boolean;
  enabled: boolean;
  appConnected: boolean;
  repositoryGrants: readonly RepositoryGrant[];
}

export interface SandboxSelectionDecision {
  selection: SandboxSelection;
  /** The configured Cloudflare path was eligible except for its live binding. */
  unavailableFallback: boolean;
}

export function sandboxBindingInstalled(
  env: { SANDBOX?: unknown; Sandbox?: unknown } | undefined,
): boolean {
  return env?.SANDBOX !== undefined || env?.Sandbox !== undefined;
}

/**
 * Select only the Flue adapter. Provider construction stays at the agent seam,
 * after this pure decision, so tests never need a real container.
 */
export function selectSandbox(input: SandboxSelectionInput): SandboxSelection {
  if (input.target === 'node') return 'bash';
  if (!input.installed) return 'bash';
  if (!input.enabled) return 'bash';
  const repositoryAccessReady =
    input.appConnected &&
    validEnabledRepositoryGrants(input.repositoryGrants).length > 0;
  if (!repositoryAccessReady) return 'bash';
  return 'cloudflare';
}

/** Distinguish an intentional bash selection from a missing-binding fallback. */
export function resolveSandboxSelection(
  input: SandboxSelectionInput,
): SandboxSelectionDecision {
  const selection = selectSandbox(input);
  const unavailableFallback =
    input.target === 'cloudflare' &&
    !input.installed &&
    selectSandbox({ ...input, installed: true }) === 'cloudflare';
  return {
    selection,
    unavailableFallback,
  };
}
