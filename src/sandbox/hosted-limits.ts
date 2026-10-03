/**
 * The host's limits on an installation's coding workspaces, where the Sandbox
 * Durable Object, its egress and work maintenance apply them. Each is a no-op
 * on standalone, which keeps its operator's session cap and nothing more.
 *
 * - A suspended or ended installation opens no workspace turn.
 * - A container starts or is reused only under the host's running limit and
 *   monthly container-hours cap (container-lease.ts).
 * - The Sandbox holds its lease while its container runs and meters the run
 *   when it stops; maintenance closes leases whose renewal lapsed.
 * - A container that starts for an installation the host does not admit
 *   destroys itself, so a suspension's stop sticks.
 */
import { InstallationNotAdmittedError, installationRefusesWork } from '../config/installation-admission.ts';
import { deploymentTenancy, requireInstallationScope } from '../config/installation-scope.ts';
import type { SandboxContainerLimits } from '../config/sandbox-settings.ts';
import { getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';
import {
  admitSandboxContainer,
  closeLapsedSandboxContainerLeases,
  holdSandboxContainerLease,
  releaseSandboxContainerLease,
  type SandboxContainerAdmission,
} from './container-lease.ts';

type Env = Record<string, unknown> | undefined;
type LeaseStore = Parameters<typeof admitSandboxContainer>[0]['store'];

/** Refuses a workspace turn of an installation the host does not admit. */
export async function requireWorkspaceTurnAdmitted(env: Env): Promise<void> {
  if (await installationRefusesWork(env)) throw new InstallationNotAdmittedError();
}

/**
 * Admit the container of the Sandbox `key` for this activation. Standalone
 * always admits; an installation of many asks its own store.
 */
export async function admitWorkspaceContainer(
  env: Env,
  input: { key: string; running: boolean; limits: SandboxContainerLimits; now: number },
  store?: LeaseStore,
): Promise<SandboxContainerAdmission> {
  const leases = leaseStore(env, store);
  if (!leases) return 'admitted';
  return admitSandboxContainer({ store: leases, ...input });
}

/**
 * Hold the lease of a running container, or release the lease of a stopped
 * one and meter its run. Never throws: metering must not break the
 * container's own lifecycle, and maintenance closes what it misses.
 */
export async function meterWorkspaceContainer(
  env: Env,
  action: 'hold' | 'release',
  input: { key: string; now: number },
  store?: LeaseStore,
): Promise<void> {
  try {
    const leases = leaseStore(env, store);
    if (!leases) return;
    if (action === 'hold') await holdSandboxContainerLease({ store: leases, ...input });
    else await releaseSandboxContainerLease({ store: leases, ...input });
  } catch {
    // Content-free: names no installation or Sandbox.
    console.warn(JSON.stringify({ component: 'sandbox_container_lease', event: `${action}_failed` }));
  }
}

/** How long a started container's lease hold may take before its Sandbox stops waiting on it. */
export const CONTAINER_START_HOLD_DEADLINE_MS = 10_000;

/**
 * Hold the lease of a container that just started, beside the start rather
 * than in its way. The Containers SDK calls `onStart` inside
 * `blockConcurrencyWhile`, so awaiting the installation's store there would
 * stall every request to the Sandbox, egress lookups included. The returned
 * promise settles when the hold does or the deadline passes, whichever comes
 * first, and never rejects; a hold past its deadline still lands. Standalone
 * meters nothing and gets no promise.
 */
export function holdStartedWorkspaceContainer(
  env: Env,
  input: { key: string; now: number },
  options: { store?: LeaseStore; deadlineMs?: number } = {},
): Promise<void> | undefined {
  if (!hostLimitsApply(env)) return undefined;
  const hold = meterWorkspaceContainer(env, 'hold', input, options.store);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      // Content-free: names no installation or Sandbox.
      console.warn(JSON.stringify({ component: 'sandbox_container_lease', event: 'hold_deadline' }));
      resolve();
    }, options.deadlineMs ?? CONTAINER_START_HOLD_DEADLINE_MS);
  });
  return Promise.race([hold, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Destroy a container that started for an installation the host does not
 * admit, beside the start as its lease hold is. A suspension stops the
 * installation's containers, but a session admitted before it keeps its
 * activation, and its next operation starts the container again through the
 * SDK, past every admission; that start destroys itself here, so the host's
 * stop sticks. A container of a Sandbox that serves no installation is
 * destroyed too. The returned promise never rejects; standalone never asks
 * and gets none.
 */
export function refuseUnadmittedContainerStart(env: Env, destroy: () => Promise<void>): Promise<void> | undefined {
  if (!hostLimitsApply(env)) return undefined;
  return (async () => {
    // An env that names no installation throws: no installation admits it.
    if (!await installationRefusesWork(env).catch(() => true)) return;
    // Content-free: names no installation or Sandbox.
    console.warn(JSON.stringify({ component: 'sandbox_container_admission', event: 'start_refused' }));
    await destroy();
  })().catch(() => {
    console.warn(JSON.stringify({ component: 'sandbox_container_admission', event: 'start_refusal_failed' }));
  });
}

/** Lapsed leases are swept every five minutes. */
export function isContainerLeaseSweepMinute(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() % 5 === 0;
}

interface SandboxLeaseNamespace {
  idFromString(id: string): unknown;
  get(id: unknown): { isContainerRunning(): Promise<boolean> };
}

/**
 * Work maintenance for one installation: close the container leases whose
 * renewal lapsed and whose Sandbox says its container is not running. Each
 * key is a Sandbox's own ID, written by that Sandbox into this installation's
 * store, so only the installation's own Sandboxes are woken; none starts.
 */
export async function maintainWorkspaceContainerLeases(env: Env, now: number, store?: LeaseStore): Promise<void> {
  const leases = leaseStore(env, store);
  const binding = (env?.SANDBOX ?? env?.Sandbox) as Partial<SandboxLeaseNamespace> | undefined;
  if (!leases || typeof binding?.idFromString !== 'function' || typeof binding.get !== 'function') return;
  const namespace = binding as SandboxLeaseNamespace;
  await closeLapsedSandboxContainerLeases({
    store: leases,
    now,
    running: async (key) => {
      const stub = namespace.get(namespace.idFromString(key));
      return (await stub.isContainerRunning()) === true;
    },
  });
}

/**
 * Whether the host's limits apply to the env's containers. They do to an env
 * whose tenancy is malformed, so its hold reports it and its start is refused.
 */
function hostLimitsApply(env: Env): boolean {
  try {
    return deploymentTenancy(env) === 'installation';
  } catch {
    return true;
  }
}

/** The installation's store on a deployment serving many; standalone meters nothing. */
function leaseStore(env: Env, store: LeaseStore | undefined): LeaseStore | undefined {
  if (deploymentTenancy(env) !== 'installation') return undefined;
  requireInstallationScope(env);
  return store ?? getSettingsStore(env as PlatformEnv);
}
