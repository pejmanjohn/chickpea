import { SandboxConnectionDroppedError, SandboxUnavailableError } from './errors.ts';

/**
 * Sandbox Durable Object methods whose replay after a dropped connection is
 * safe: reads, and writes that converge on the same state when repeated with
 * the same arguments (a whole-file write, the turn's own id and egress policy,
 * the Git identity, revoking egress, destroying the container). Everything
 * else (commands above all) reports an unknown outcome instead of replaying.
 */
export const RETRY_SAFE_SANDBOX_METHODS: ReadonlySet<string> = new Set([
  // Reads.
  'exists',
  'readFile',
  'listFiles',
  'getState',
  'getTurnId',
  'getTurnProgress',
  'getEgressPolicy',
  'describeWorkspace',
  'probeContainerRuntime',
  'listProcesses',
  'getProcess',
  'getProcessLogs',
  // Convergent writes. A replayed whole-file write could land after a later
  // parallel write to the same path; nothing in Chickpea writes one path
  // concurrently, and the SDK offers no conditional write to guard it.
  'writeFile',
  'prepareTurn',
  'configureEgress',
  'applyGitIdentity',
  'endTurn',
  'destroy',
  'discardWorkspace',
]);

/** Pauses before each retry; its length bounds the retries. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [100, 500];

export interface ReconnectingSandboxOptions {
  /** Methods replayed on a fresh stub after a disconnect. */
  retrySafe?: ReadonlySet<string>;
  /** One pause per retry; an empty list disables retries. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const DISCONNECT_MESSAGES = [
  'durable object instance is no longer active',
  'durable object reset',
  'reset because its code was updated',
  'this script has been upgraded',
  'caused object to be reset',
  'network connection lost',
  'broken.outputgatebroken',
  'broken.inputgatebroken',
];

/** Bounded, like the SDK's own cause walk. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Whether an error means the connection to the Durable Object instance was
 * lost, not that the operation itself failed. Cloudflare can replace a live
 * Durable Object instance (the container keeps running); calls in flight on the
 * old stub then reject, and so does every later call on that stub. The runtime
 * marks such transient failures `retryable`, and `overloaded` ones must not be
 * retried. `@cloudflare/sandbox` wraps most stub methods and turns these into
 * an `OperationInterruptedError` (code `OPERATION_INTERRUPTED`, reason
 * `runtime_replaced`) with the platform error only as its `cause`, so the
 * cause chain is walked. Anything thrown by the Sandbox's own code (a failed
 * command, a missing file) matches none of this and is never reclassified.
 */
export function isSandboxDisconnect(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth += 1) {
    const record = current as {
      retryable?: unknown;
      overloaded?: unknown;
      message?: unknown;
      name?: unknown;
      code?: unknown;
      context?: { reason?: unknown };
      errorResponse?: { context?: { reason?: unknown } };
      cause?: unknown;
    };
    if (record.overloaded === true || record.name === 'AbortError') return false;
    if (record.retryable === true) return true;
    const interrupted = record.code === 'OPERATION_INTERRUPTED' || record.name === 'OperationInterruptedError';
    const reason = record.context?.reason ?? record.errorResponse?.context?.reason;
    if (interrupted && reason === 'runtime_replaced') return true;
    const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
    if (DISCONNECT_MESSAGES.some((pattern) => message.includes(pattern))) return true;
    current = record.cause;
  }
  return false;
}

/**
 * A Sandbox stub that survives a Durable Object instance replacement. Each
 * call goes to the current stub; a call that fails with a disconnect drops it,
 * so the next call mints a fresh one with the same id and options (the
 * Sandbox DO's turn, egress, and workspace records live in its storage, and
 * the container keeps running, so a fresh stub reaches the same workspace).
 * Retry-safe calls are replayed on the fresh stub a bounded number of times;
 * any other call fails with {@link SandboxConnectionDroppedError}, whose
 * message tells the model the outcome is unknown and how to check it.
 *
 * Minting is lazy, happens in the caller's current I/O context, and starts no
 * container. Activation (session cap, checkpoint restore) wraps this proxy
 * one layer up and runs once, so a reconnect never counts a second session.
 */
export function reconnectingSandboxStub<T extends object>(
  mint: () => T | Promise<T>,
  options: ReconnectingSandboxOptions = {},
): T {
  const retrySafe = options.retrySafe ?? RETRY_SAFE_SANDBOX_METHODS;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let pending: Promise<T> | undefined;
  let latest: T | undefined;
  let generation = 0;

  const acquire = (): { stub: Promise<T>; generation: number } => {
    if (!pending) {
      const minted = Promise.resolve().then(mint);
      pending = minted;
      const mintedGeneration = generation;
      minted.then(
        (stub) => {
          if (generation === mintedGeneration) latest = stub;
        },
        () => {
          if (pending === minted) pending = undefined;
        },
      );
    }
    return { stub: pending, generation };
  };

  // Only the first caller to see a stub fail drops it; a concurrent failure
  // on the same dead stub must not discard the replacement.
  const discard = (failedGeneration: number) => {
    if (failedGeneration !== generation) return;
    generation += 1;
    pending = undefined;
    latest = undefined;
  };

  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    for (let attempt = 0; ; attempt += 1) {
      const current = acquire();
      const stub = await current.stub;
      const fn = Reflect.get(stub, method) as unknown;
      if (typeof fn !== 'function') {
        throw new TypeError(`Sandbox method ${method} is unavailable`);
      }
      try {
        return await Reflect.apply(fn, stub, args);
      } catch (err) {
        if (!isSandboxDisconnect(err)) throw err;
        discard(current.generation);
        if (!retrySafe.has(method)) throw new SandboxConnectionDroppedError(err);
        if (attempt >= delays.length) throw new SandboxUnavailableError(err);
        await sleep(delays[attempt]!);
      }
    }
  };

  return new Proxy({} as T, {
    get(_target, property) {
      // Never look like a thenable: callers await factories that return this.
      if (typeof property !== 'string' || property === 'then') return undefined;
      // A stub already minted answers optional-method checks truthfully.
      if (latest && typeof Reflect.get(latest, property) !== 'function') {
        return Reflect.get(latest, property);
      }
      return (...args: unknown[]) => call(property, args);
    },
  });
}
