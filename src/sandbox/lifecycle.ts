import { FlueError } from '@flue/runtime';

import { SandboxUnavailableError } from './errors.ts';

export const CLOUDFLARE_SANDBOX_OPTIONS = {
  transport: 'rpc',
  keepAlive: false,
  // The thread's workspace stays warm this long after its last turn, so a
  // follow-up reuses the checkout. Sleep wipes the disk and stops all billing.
  sleepAfter: '30m',
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

const PRIVATE_SANDBOX_COMMAND_ENV = 'FLUE_PRIVATE_SANDBOX_COMMAND_V1';
const CONTENT_FREE_SANDBOX_COMMAND = `sh -lc "$${PRIVATE_SANDBOX_COMMAND_ENV}"`;

interface OperationallyPrivateSandbox {
  exec(
    command: string,
    options?: {
      env?: Record<string, string>;
      [key: string]: unknown;
    },
  ): unknown;
}

/**
 * Keep model-authored shell text out of the Cloudflare Sandbox SDK's canonical
 * `sandbox.exec` log. The SDK logs its command argument on both success and
 * failure, independently of Flue tracing, so send a fixed wrapper command and
 * carry the real command in the execution environment instead. `origin` also
 * demotes the content-free success event below the production log threshold.
 */
export function contentFreeSandboxExec<T extends OperationallyPrivateSandbox>(sandbox: T): T {
  return new Proxy(sandbox, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'exec' || typeof value !== 'function') return value;

      return (command: string, options?: Record<string, unknown>) => {
        const env =
          options?.env && typeof options.env === 'object'
            ? (options.env as Record<string, string>)
            : undefined;
        return Reflect.apply(value, target, [
          CONTENT_FREE_SANDBOX_COMMAND,
          {
            ...options,
            env: {
              ...env,
              [PRIVATE_SANDBOX_COMMAND_ENV]: command,
            },
            origin: 'internal',
          },
        ]);
      };
    },
  });
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
 * Acquire a sandbox handle for one agent turn. The handle is a Durable Object
 * RPC stub, and Workers binds every stub to the I/O context (the Durable
 * Object or request) that minted it. The module-level caller is shared by
 * every agent DO in the isolate, so a stub cached from one thread's turn can
 * later be reached from a different DO and fail with "Cannot perform I/O on
 * behalf of a different Durable Object". Mint a fresh stub on every
 * acquisition instead: getSandbox is cheap and lazy, and the Sandbox DO (the
 * container, its files, and its persisted turn context) outlives any stub.
 *
 * Turn-scoped configuration is applied on every acquisition because the
 * Sandbox DO can outlive both this agent request and the Worker isolate, so
 * policy must never be treated as create-only state. If configuration fails,
 * the handle minted for this acquisition is torn down in the same context;
 * keepAlive:false + sleepAfter remains the bound for everything else.
 */
export async function acquireSandbox<T extends DestroyableSandbox>(
  factory: () => Promise<T>,
  configure: (sandbox: T) => Promise<void>,
): Promise<T> {
  const sandbox = await factory();
  try {
    await configure(sandbox);
    return sandbox;
  } catch (err) {
    await destroySandbox(sandbox);
    throw err;
  }
}

export async function destroySandbox(sandbox: DestroyableSandbox): Promise<boolean> {
  try {
    await sandbox.destroy();
    return true;
  } catch {
    // Teardown is best-effort. keepAlive:false + sleepAfter remains the
    // self-healing billing bound if the control-plane destroy call fails.
    return false;
  }
}
