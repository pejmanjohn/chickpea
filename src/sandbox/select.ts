import type { RepositoryGrant } from '../config/types.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

/**
 * The environment a sandbox-reading tool addresses: the virtual sandbox, or a
 * coding workspace container. New plans always give the Agent `bash`;
 * `cloudflare` remains for plans admitted with an attached container.
 */
export type SandboxSelection = 'bash' | 'cloudflare';

interface SandboxSelectionInput {
  target: 'cloudflare' | 'node';
  /** Live binding availability, never a persisted proxy for installation. */
  installed: boolean;
  enabled: boolean;
  appConnected: boolean;
  repositoryGrants: readonly RepositoryGrant[];
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

/** Whether a turn may use a coding workspace through the workspace tools. */
export type CodingWorkspaceCapability = 'available' | 'unavailable';

export interface CodingWorkspaceCapabilityDecision {
  capability: CodingWorkspaceCapability;
  /** The configured coding workspace was eligible except for its live binding. */
  unavailableFallback: boolean;
}

/**
 * Whether the coding workspace is available this turn. The Agent itself always
 * runs in the virtual sandbox; this only decides whether the workspace tools
 * are mounted. Pure, so tests never need a real container.
 */
export function codingWorkspaceCapability(input: SandboxSelectionInput): CodingWorkspaceCapability {
  if (input.target === 'node') return 'unavailable';
  if (!input.installed) return 'unavailable';
  if (!input.enabled) return 'unavailable';
  const repositoryAccessReady =
    input.appConnected &&
    validEnabledRepositoryGrants(input.repositoryGrants).length > 0;
  return repositoryAccessReady ? 'available' : 'unavailable';
}

/** Distinguish an unconfigured workspace from a missing-binding fallback. */
export function resolveCodingWorkspaceCapability(
  input: SandboxSelectionInput,
): CodingWorkspaceCapabilityDecision {
  const capability = codingWorkspaceCapability(input);
  const unavailableFallback =
    input.target === 'cloudflare' &&
    !input.installed &&
    codingWorkspaceCapability({ ...input, installed: true }) === 'available';
  return { capability, unavailableFallback };
}
