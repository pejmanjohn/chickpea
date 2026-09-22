import type { RepositoryGrant } from '../config/types.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

export type SandboxSelection = 'bash' | 'cloudflare';

interface SandboxSelectionInput {
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

export type SandboxContainerProbe = 'attached' | 'missing' | 'unknown';

/** Durable Object id used only to ask whether a Container is attached. */
export const SANDBOX_CONTAINER_PROBE_NAME = 'chickpea-container-probe';
const CONTAINER_NOT_ENABLED = /Containers have not been enabled for this Durable Object class/i;

interface SandboxProbeNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { probeContainerRuntime(): Promise<boolean> };
}

/**
 * A live SANDBOX binding is not proof of a coding sandbox. `wrangler deploy`
 * activates the Worker version before it creates the Container application,
 * so a failed deploy leaves the binding without a Container. Cloudflare only
 * gives the Sandbox Durable Object a `ctx.container` once an application is
 * linked, and the Containers SDK constructor throws without one. Waking one
 * dedicated probe object distinguishes the two without starting a container.
 * Any other failure is reported as unknown rather than guessed.
 */
export async function probeSandboxContainer(
  env: { SANDBOX?: unknown } | undefined,
  timeoutMs = 5_000,
): Promise<SandboxContainerProbe> {
  const namespace = env?.SANDBOX as Partial<SandboxProbeNamespace> | undefined;
  if (typeof namespace?.idFromName !== 'function' || typeof namespace.get !== 'function') return 'unknown';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stub = namespace.get(namespace.idFromName(SANDBOX_CONTAINER_PROBE_NAME));
    const attached = await Promise.race([
      stub.probeContainerRuntime(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), timeoutMs);
      }),
    ]);
    return attached === true ? 'attached' : 'missing';
  } catch (error) {
    return CONTAINER_NOT_ENABLED.test(error instanceof Error ? error.message : String(error))
      ? 'missing'
      : 'unknown';
  } finally {
    if (timer) clearTimeout(timer);
  }
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
