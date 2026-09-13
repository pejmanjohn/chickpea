import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireHostChecks } from './verification-host.mjs';

function error(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }

/** Caller-side bounded polling. The underlying reservation remains fail-fast. */
export async function waitForHostChecks({ waitMs = 0, pollMs = 1000, signal, onWait, ...options } = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 7_200_000
    || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 30_000) {
    throw error('HOST_CHECKS_WAIT_INVALID', 'waitMs must be 0..7200000 and pollMs 10..30000.');
  }
  const started = performance.now();
  let previous;
  for (;;) {
    if (signal?.aborted) throw error('HOST_CHECKS_CANCELLED', 'Waiting cancelled; no reservation was acquired.');
    if (previous && performance.now() - started >= waitMs) throw error('HOST_CHECKS_TIMEOUT', 'Wait deadline reached. The current owner and pending work are unchanged.');
    try {
      const lease = acquireHostChecks(options);
      return { ...lease, waitedMs: Math.round(performance.now() - started) };
    } catch (cause) {
      if (cause.code !== 'HOST_CHECKS_BUSY' || waitMs === 0) throw cause;
      if (!Number.isSafeInteger(cause.owner?.pid) || cause.owner.pid < 1) throw error('HOST_CHECKS_OWNER_UNKNOWN', 'Inspect the existing reservation; its owner is not valid.');
      try { process.kill(cause.owner.pid, 0); } catch (probe) {
        if (probe.code === 'ESRCH') throw error('HOST_CHECKS_OWNER_STOPPED', 'Owner is no longer live. Reconcile its descendants and exact reservation per host-checks.md; never steal the slot.');
        throw error('HOST_CHECKS_OWNER_UNKNOWN', 'Cannot establish owner liveness; inspect the reservation.');
      }
      const identity = JSON.stringify(cause.owner);
      if (previous !== identity) onWait?.({ status: 'waiting', owner: cause.owner, waitedMs: Math.round(performance.now() - started) });
      previous = identity;
      try { await delay(Math.min(pollMs, Math.max(0, waitMs - (performance.now() - started))), undefined, { signal }); }
      catch (cause) { if (cause.name === 'AbortError') throw error('HOST_CHECKS_CANCELLED', 'Waiting cancelled; the owner is unchanged.'); throw cause; }
    }
  }
}
