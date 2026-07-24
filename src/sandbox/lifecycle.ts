export const CLOUDFLARE_SANDBOX_OPTIONS = {
  keepAlive: false,
  sleepAfter: '5m',
} as const;

export interface DestroyableSandbox {
  destroy(): Promise<void>;
}

interface ActivatableSandbox {
  exists(path: string): Promise<unknown>;
}

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
): T {
  let activation: Promise<unknown> | undefined;
  const ensureActive = (): Promise<unknown> => {
    activation ??= sandbox.exists(readyPath).catch((err) => {
      activation = undefined;
      throw err;
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
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/**
 * One in-flight provider setup per thread prevents concurrent requests from
 * racing the Sandbox SDK's create path. The active handle is also the
 * turn-completion teardown seam used by the agent route middleware.
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
