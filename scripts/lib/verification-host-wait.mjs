import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireHostChecks, hostChecksHeldMs, hostChecksHoldWarning, hostChecksLiveness } from './verification-host.mjs';

function error(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }

function slotWarning(owner, now) {
  if (owner.liveness === 'live') return ['HOST_CHECKS_HELD_LONG', hostChecksHoldWarning(owner, now)];
  const state = owner.liveness === 'stopped' ? 'is no longer live' : 'cannot be inspected';
  return [`HOST_CHECKS_SLOT_${owner.liveness.toUpperCase()}`, `${owner.file} names PID ${owner.pid}, which ${state}. Waiting for a live owner; a person reconciles this slot's descendants and exact file per host-checks.md. Never steal, stop or remove it.`];
}

/**
 * Caller-side bounded polling. The underlying reservation remains fail-fast.
 * It waits while any owner is live. A status prints when the owners change,
 * plus one warning per owner once its hold passes HOST_CHECKS_HOLD_WARN_MS and
 * one per stopped or uninspectable slot.
 */
export async function waitForHostChecks({ waitMs = 0, pollMs = 1000, signal, onWait, now = Date.now, ...options } = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 7_200_000
    || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 30_000) {
    throw error('HOST_CHECKS_WAIT_INVALID', 'waitMs must be 0..7200000 and pollMs 10..30000.');
  }
  const started = performance.now();
  const warned = new Set();
  let previous;
  for (;;) {
    if (signal?.aborted) throw error('HOST_CHECKS_CANCELLED', 'Waiting cancelled; no reservation was acquired.');
    if (previous && performance.now() - started >= waitMs) throw error('HOST_CHECKS_TIMEOUT', 'Wait deadline reached. The current owner and pending work are unchanged.');
    try {
      const lease = acquireHostChecks({ ...options, now });
      return { ...lease, waitedMs: Math.round(performance.now() - started) };
    } catch (cause) {
      if (cause.code !== 'HOST_CHECKS_BUSY' || waitMs === 0) throw cause;
      const owners = cause.owners.map((owner) => ({ ...owner, liveness: hostChecksLiveness(owner.pid), heldMs: hostChecksHeldMs(owner, now()) }));
      if (!owners.some((owner) => owner.liveness === 'live')) {
        if (owners.some((owner) => owner.liveness === 'stopped')) throw error('HOST_CHECKS_OWNER_STOPPED', 'Owner is no longer live. Reconcile its descendants and exact reservation per host-checks.md; never steal the slot.');
        if (owners.some(({ pid }) => Number.isSafeInteger(pid) && pid > 0)) throw error('HOST_CHECKS_OWNER_UNKNOWN', 'Cannot establish owner liveness; inspect the reservation.');
        throw error('HOST_CHECKS_OWNER_UNKNOWN', 'Inspect the existing reservation; its owner is not valid.');
      }
      const identity = JSON.stringify(cause.owners);
      const waitedMs = Math.round(performance.now() - started);
      if (previous !== identity) onWait?.({ status: 'waiting', owners, waitedMs });
      previous = identity;
      for (const [index, owner] of owners.entries()) {
        const [warning, message] = slotWarning(owner, now());
        const key = `${warning} ${JSON.stringify(cause.owners[index])}`;
        if (!message || warned.has(key)) continue;
        warned.add(key);
        onWait?.({ status: 'waiting', warning, file: owner.file, owners, waitedMs, message });
      }
      try { await delay(Math.min(pollMs, Math.max(0, waitMs - (performance.now() - started))), undefined, { signal }); }
      catch (cause) { if (cause.name === 'AbortError') throw error('HOST_CHECKS_CANCELLED', 'Waiting cancelled; the owner is unchanged.'); throw cause; }
    }
  }
}
