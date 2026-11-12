import { emitRuntimeLatency } from '../observability/runtime-latency.ts';
import { isSandboxDisconnect } from '../sandbox/reconnect.ts';

/** Why a store call fell back, for logs only: the fallback rule never reads it. */
export type StoreFallbackReason = 'method_missing' | 'disconnected' | 'rejected';

/**
 * Call a store method added after the store's oldest code still in service,
 * and run `fallback` once when the call rejects or throws. A deploy leaves a
 * store on its old code for minutes, and workerd rejects a call to a method
 * that code lacks without running anything. Store methods answer failures as
 * envelopes, so any rejection means the method is missing or the store was
 * replaced or unreachable mid-call. An answer, `ok` or not, is returned as it
 * is and never falls back.
 */
export async function withStoreFallback<T>(
  method: string,
  call: () => Promise<T>,
  fallback: (reason: StoreFallbackReason) => Promise<T>,
): Promise<T> {
  let reason: StoreFallbackReason;
  try {
    return await call();
  } catch (error) {
    reason = storeFallbackReason(error);
  }
  emitRuntimeLatency('state_rpc_fallback', { method, reason });
  return fallback(reason);
}

function storeFallbackReason(error: unknown): StoreFallbackReason {
  if (isSandboxDisconnect(error)) return 'disconnected';
  const message = error instanceof Error ? error.message : '';
  return /does not implement|is not a function/i.test(message) ? 'method_missing' : 'rejected';
}
