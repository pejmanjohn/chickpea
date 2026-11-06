import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOST_CHECK_DIR = join(homedir(), '.chickpea', 'verification-host');
/** Slot 1 keeps its original path: older checkouts know only owner.json and contend for it alone. */
export const HOST_CHECK_SLOTS = Object.freeze([join(HOST_CHECK_DIR, 'owner.json'), join(HOST_CHECK_DIR, 'owner-2.json')]);
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

export function hostChecksLiveness(pid) {
  // kill(0) and kill(-1) probe our own process group, so only a real PID can read as live or stopped.
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'live'; } catch (error) { return error.code === 'ESRCH' ? 'stopped' : 'unknown'; }
}

function readSlot(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function readHostChecksOwners({ files = HOST_CHECK_SLOTS } = {}) {
  return files.flatMap((file) => {
    const owner = readSlot(file);
    return owner ? [{ file, pid: owner.pid, cwd: owner.cwd, startedAt: owner.startedAt, liveness: hostChecksLiveness(owner.pid) }] : [];
  });
}

export class HostChecksBusyError extends Error {
  constructor(owners, now = Date.now()) {
    const held = owners.map((owner) => {
      const warning = hostChecksHoldWarning(owner, now);
      return `${owner.file}; owner PID ${owner.pid ?? 'inspect file'}, checkout ${owner.cwd ?? 'inspect file'}.${warning ? ` ${warning}` : ''}`;
    });
    super(`Expensive checks are reserved in every host slot: ${held.join(' ')} Continue lightweight work. Never steal a slot; after interruption reconcile the owner and descendants before removing its exact lock.`);
    this.code = 'HOST_CHECKS_BUSY';
    this.owners = owners;
  }
}

/** One of the host's slots, no waiting, stealing, process killing, or scheduler. */
export function acquireHostChecks({ files = HOST_CHECK_SLOTS, env = process.env, cwd = process.cwd(), now = Date.now } = {}) {
  for (const file of files) mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const priors = files.map(readSlot);
  const shared = priors.findIndex((prior) => prior && env.CHICKPEA_CHECK_OWNER === prior.token);
  if (shared >= 0) {
    process.kill(priors[shared].pid, 0); // Nested commands may share only a living owner's slot.
    return { file: files[shared], env: { CHICKPEA_CHECK_OWNER: priors[shared].token }, release() {} };
  }
  const token = randomUUID();
  const record = JSON.stringify({ pid: process.pid, cwd, startedAt: new Date(now()).toISOString(), token });
  for (const file of files) {
    try { writeFileSync(file, record, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    return { file, env: { CHICKPEA_CHECK_OWNER: token }, release() {
      if (JSON.parse(readFileSync(file, 'utf8')).token !== token) throw new Error('Host check ownership changed; lock retained.');
      unlinkSync(file);
    } };
  }
  throw new HostChecksBusyError(files.map((file, index) => {
    const { pid, cwd: checkout, startedAt } = priors[index] ?? JSON.parse(readFileSync(file, 'utf8'));
    return { file, pid, cwd: checkout, startedAt };
  }), now());
}
