import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST_CHECK_LOCK = join(homedir(), '.chickpea', 'verification-host', 'owner.json');
/** A hold older than this is reported to waiters and the kickoff doctor. */
export const HOST_CHECKS_HOLD_WARN_MS = 15 * 60 * 1000;

/** How long an owner has held the slot, or null when its start time is unreadable. */
export function hostChecksHeldMs(owner, now = Date.now()) {
  const started = Date.parse(owner?.startedAt ?? '');
  return Number.isFinite(started) ? Math.max(0, now - started) : null;
}

/** The waiter-facing warning for a long hold, or null. */
export function hostChecksHoldWarning(owner, now = Date.now()) {
  const heldMs = hostChecksHeldMs(owner, now);
  if (heldMs === null || heldMs < HOST_CHECKS_HOLD_WARN_MS) return null;
  return `Held for ${Math.floor(heldMs / 60_000)} min, over the ${HOST_CHECKS_HOLD_WARN_MS / 60_000}-minute warning: ask its owner whether a check is hung. Never steal, stop or remove it (host-checks.md).`;
}

export class HostChecksBusyError extends Error {
  constructor(file, owner, now = Date.now()) {
    const warning = owner ? hostChecksHoldWarning(owner, now) : null;
    super(`Expensive checks are reserved: ${file}; owner PID ${owner?.pid ?? 'inspect file'}, checkout ${owner?.cwd ?? 'inspect file'}.${warning ? ` ${warning}` : ''} Continue lightweight work. Never steal the slot; after interruption reconcile the owner and descendants before removing its exact lock.`);
    this.code = 'HOST_CHECKS_BUSY';
    this.owner = owner ? { pid: owner.pid, cwd: owner.cwd, startedAt: owner.startedAt } : null;
    this.heldMs = owner ? hostChecksHeldMs(owner, now) : null;
  }
}

/** One local host slot, no waiting, stealing, process killing, or scheduler. */
export function acquireHostChecks({ file = HOST_CHECK_LOCK, env = process.env, cwd = process.cwd(), now = Date.now } = {}) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  let prior;
  try { prior = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior && env.CHICKPEA_CHECK_OWNER === prior.token) {
    process.kill(prior.pid, 0); // Nested commands may share only a living owner's slot.
    return { env: { CHICKPEA_CHECK_OWNER: prior.token }, release() {} };
  }
  const token = randomUUID();
  try { writeFileSync(file, JSON.stringify({ pid: process.pid, cwd, startedAt: new Date(now()).toISOString(), token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!prior) prior = JSON.parse(readFileSync(file, 'utf8'));
    throw new HostChecksBusyError(file, prior, now());
  }
  return { env: { CHICKPEA_CHECK_OWNER: token }, release() {
    if (JSON.parse(readFileSync(file, 'utf8')).token !== token) throw new Error('Host check ownership changed; lock retained.');
    unlinkSync(file);
  } };
}
