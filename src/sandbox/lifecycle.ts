import { FlueError } from '@flue/runtime';

import { SandboxUnavailableError } from './errors.ts';

export const CLOUDFLARE_SANDBOX_OPTIONS = {
  keepAlive: false,
  sleepAfter: '5m',
  // This participates in the Durable Object identity. Keep the legacy value
  // explicit so an SDK default change cannot strand a thread's persisted retry
  // markers. Normalizing existing ids requires a deliberate state migration.
  normalizeId: false,
} as const;

// Rolling Worker deployments can briefly run an older Agent DO isolate beside
// a newer State DO isolate. The previous live revision normalized ids, so keep
// a rollout bridge that prepares/reconciles both identities for uppercase Slack
// keys. Only the agent isolate handling the turn activates a container.
const CLOUDFLARE_SANDBOX_NORMALIZED_COMPAT_OPTIONS = {
  ...CLOUDFLARE_SANDBOX_OPTIONS,
  normalizeId: true,
} as const;

export function cloudflareSandboxOptionVariants(id: string) {
  return /[A-Z]/.test(id)
    ? [CLOUDFLARE_SANDBOX_OPTIONS, CLOUDFLARE_SANDBOX_NORMALIZED_COMPAT_OPTIONS]
    : [CLOUDFLARE_SANDBOX_OPTIONS];
}

export interface DestroyableSandbox {
  destroy(): Promise<void>;
}

interface ActivatableSandbox {
  exists(path: string): Promise<unknown>;
}

type SandboxActivation = () => Promise<unknown>;

const SANDBOX_OPERATION_METHODS = new Set([
  'exec',
  'readFile',
  'writeFile',
  'exists',
  'mkdir',
  'deleteFile',
]);

/**
 * Keep the provider lazy while coalescing the first real file/exec operation
 * onto one readiness probe. That first operation is the SDK's container-create
 * boundary; later operations bypass the probe.
 */
export function serializeSandboxActivation<T extends ActivatableSandbox>(
  sandbox: T,
  readyPath = '/workspace',
  beforeActivate?: SandboxActivation,
): T {
  let activation: Promise<unknown> | undefined;
  const ensureActive = (): Promise<unknown> => {
    activation ??= (
      beforeActivate
        ? beforeActivate().then(() => sandbox.exists(readyPath))
        : sandbox.exists(readyPath)
    ).catch((err) => {
      activation = undefined;
      // Preserve deliberate, public-safe refusals (for example the monthly
      // session cap). Everything else at the readiness boundary is sandbox
      // infrastructure, not a model-provider failure. The original error is
      // retained only as the server-side cause.
      if (err instanceof FlueError) throw err;
      throw new SandboxUnavailableError(err);
    });
    return activation;
  };

  return new Proxy(sandbox, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof property !== 'string' ||
        !SANDBOX_OPERATION_METHODS.has(property) ||
        typeof value !== 'function'
      ) {
        return value;
      }
      return async (...args: unknown[]) => {
        await ensureActive();
        try {
          return await Reflect.apply(value, target, args);
        } catch (err) {
          if (err instanceof FlueError || !isSandboxInfrastructureFailure(err)) {
            throw err;
          }
          throw new SandboxUnavailableError(err);
        }
      };
    },
  });
}

function isSandboxInfrastructureFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof record.code === 'string' ? record.code.toUpperCase() : '';
  const name = typeof record.name === 'string' ? record.name : '';
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  return (
    code === 'CONTAINER_UNAVAILABLE' ||
    code === 'RPC_TRANSPORT_ERROR' ||
    code === 'OPERATION_INTERRUPTED' ||
    name === 'ContainerUnavailableError' ||
    name === 'RPCTransportError' ||
    message.includes('maximum number of running container instances') ||
    message.includes('container was unavailable')
  );
}

/**
 * One in-flight provider setup per thread prevents concurrent requests from
 * racing the Sandbox SDK's create path. Active handles stay reusable in this
 * isolate; container lifetime is bounded by keepAlive:false + sleepAfter.
 */
export class SandboxLifecycleRegistry<T extends DestroyableSandbox> {
  private readonly creating = new Map<string, Promise<T>>();
  private readonly active = new Map<string, T>();

  async create(threadId: string, factory: () => Promise<T>): Promise<T> {
    const active = this.active.get(threadId);
    if (active) return active;

    const existing = this.creating.get(threadId);
    if (existing) return existing;

    const pending = factory()
      .then((sandbox) => {
        this.active.set(threadId, sandbox);
        return sandbox;
      })
      .finally(() => {
        if (this.creating.get(threadId) === pending) {
          this.creating.delete(threadId);
        }
      });
    this.creating.set(threadId, pending);
    return pending;
  }

  /**
   * Reuse the per-thread stub while applying turn-scoped configuration on
   * every acquisition. The Sandbox DO can outlive both this agent request and
   * the Worker isolate, so policy must never be treated as create-only state.
   */
  async acquire(
    threadId: string,
    factory: () => Promise<T>,
    configure: (sandbox: T) => Promise<void>,
  ): Promise<T> {
    const sandbox = await this.create(threadId, factory);
    try {
      await configure(sandbox);
      return sandbox;
    } catch (err) {
      // This registry lives in the agent DO isolate. Invalidating here is a
      // same-isolate cleanup; sleepAfter remains the cross-isolate bound.
      await this.destroy(threadId);
      throw err;
    }
  }

  async destroy(threadId: string): Promise<boolean> {
    const pending = this.creating.get(threadId);
    const sandbox =
      this.active.get(threadId) ??
      (pending ? await pending.catch(() => undefined) : undefined);
    this.active.delete(threadId);
    if (!sandbox) return false;
    try {
      await sandbox.destroy();
      return true;
    } catch {
      // Teardown is best-effort. keepAlive:false + sleepAfter remains the
      // self-healing billing bound if the control-plane destroy call fails.
      return false;
    }
  }

  hasActive(threadId: string): boolean {
    return this.active.has(threadId);
  }
}
