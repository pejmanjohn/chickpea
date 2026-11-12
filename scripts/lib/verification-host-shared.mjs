import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { HOST_CHECK_SLOTS, hostChecksLiveness, inheritedHostChecks, readHostChecksOwners } from './verification-host.mjs';

/**
 * Shared CPU slots: a counted limit on CPU-heavy work that needs no exclusive
 * reservation, such as a test pass of plain unit tests, a typecheck or a
 * mutation pass. A slot guards only CPU, never a port, a database or build
 * output, so a slot whose PID has exited is simply free again and the next
 * caller reclaims it. The exclusive reservation's slots are never reclaimed.
 */
const SHARED_SLOT_DIR = join(homedir(), '.chickpea', 'verification-host', 'shared');
const SLOT_FILE = /^slot-\d+\.json$/;

function error(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }

/** CHICKPEA_SHARED_SLOTS, else one slot per six cores and at least one. */
export function sharedSlotCount(env = process.env, cores = availableParallelism()) {
  const value = env.CHICKPEA_SHARED_SLOTS;
  if (value === undefined || value === '') return Math.max(1, Math.floor(cores / 6));
  const slots = Number(value);
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > 64) throw error('HOST_CHECKS_SHARED_INVALID', 'CHICKPEA_SHARED_SLOTS must be a whole number from 1 to 64.');
  return slots;
}

function readHolders(dir) {
  let names;
  try { names = readdirSync(dir); } catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
  return names.filter((name) => SLOT_FILE.test(name)).flatMap((name) => {
    const file = join(dir, name);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
    let record = {};
    // A claim between its exclusive create and its write is held by an owner not yet readable.
    try { record = JSON.parse(text) ?? {}; } catch {}
    const { pid, cwd, command, startedAt, token } = record;
    return [{ file, text, pid, cwd, command, startedAt, token, liveness: hostChecksLiveness(pid) }];
  });
}

/** Removes a stopped holder's claim unless the file changed since it was read. */
function reclaim(holder) {
  try {
    if (readFileSync(holder.file, 'utf8') !== holder.text) return false;
    unlinkSync(holder.file);
    return true;
  } catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
}

const describe = ({ file, pid, cwd, command, startedAt }) => ({ file, pid, cwd, command, startedAt });

/**
 * One shared slot, or none when the caller already runs under one (its
 * CHICKPEA_SHARED_CHECK_OWNER) or under a live exclusive owner (its
 * CHICKPEA_CHECK_OWNER), so nesting never waits on itself. A live exclusive
 * owner counts as one taken slot; the exclusive reservation never waits for
 * these. Throws HOST_CHECKS_SHARED_BUSY when every slot is taken.
 */
export function acquireSharedSlot({ dir = SHARED_SLOT_DIR, exclusive = HOST_CHECK_SLOTS, slots = sharedSlotCount(), env = process.env, cwd = process.cwd(), command = '', now = Date.now } = {}) {
  const reservation = inheritedHostChecks({ files: exclusive, env });
  if (reservation) return { inherited: reservation, reclaimed: [], env: {}, release() {} };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const reclaimed = [];
  for (;;) {
    const holders = readHolders(dir);
    const parent = holders.find((holder) => holder.token && holder.token === env.CHICKPEA_SHARED_CHECK_OWNER && holder.liveness === 'live');
    if (parent) return { inherited: parent.file, reclaimed, env: { CHICKPEA_SHARED_CHECK_OWNER: parent.token }, release() {} };
    for (const holder of holders) if (holder.liveness === 'stopped' && reclaim(holder)) reclaimed.push(describe(holder));
    const held = holders.filter((holder) => holder.liveness !== 'stopped');
    const owners = [
      ...readHostChecksOwners({ files: exclusive }).filter((owner) => owner.liveness === 'live').map((owner) => ({ kind: 'exclusive', ...describe(owner) })),
      ...held.map((holder) => ({ kind: 'shared', ...describe(holder) })),
    ];
    if (owners.length >= slots) {
      throw Object.assign(error('HOST_CHECKS_SHARED_BUSY', `All ${slots} shared CPU slots are taken; a live exclusive reservation counts as one.`), { slots, owners, reclaimed });
    }
    // Always the lowest free file from a fresh read: two callers racing for the last slot create the same file, and one gets EEXIST.
    const taken = new Set(held.map((holder) => holder.file));
    let index = 0;
    while (taken.has(join(dir, `slot-${index}.json`))) index += 1;
    const file = join(dir, `slot-${index}.json`);
    const token = randomUUID();
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, cwd, command, startedAt: new Date(now()).toISOString(), token }), { flag: 'wx', mode: 0o600 });
    } catch (cause) { if (cause.code === 'EEXIST') continue; throw cause; }
    return { file, reclaimed, env: { CHICKPEA_SHARED_CHECK_OWNER: token }, release() {
      try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file); } catch (cause) { if (cause.code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw cause; }
    } };
  }
}

/**
 * Waits for a shared slot. It reports each reclaimed slot, a status whenever
 * the owners change, and `acquired` once it took a slot after waiting.
 */
export async function waitForSharedSlot({ waitMs = 7_200_000, pollMs = 1000, signal, onWait, ...options } = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 7_200_000
    || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 30_000) {
    throw error('HOST_CHECKS_WAIT_INVALID', 'waitMs must be 0..7200000 and pollMs 10..30000.');
  }
  const started = performance.now();
  let previous;
  for (;;) {
    if (signal?.aborted) throw error('HOST_CHECKS_CANCELLED', 'Waiting cancelled; no shared slot was taken.');
    let lease;
    try { lease = acquireSharedSlot(options); } catch (cause) {
      for (const owner of cause.reclaimed ?? []) onWait?.({ status: 'reclaimed', slot: 'shared', ...owner });
      if (cause.code !== 'HOST_CHECKS_SHARED_BUSY' || waitMs === 0) throw cause;
      const waitedMs = Math.round(performance.now() - started);
      const identity = JSON.stringify(cause.owners);
      if (identity !== previous) onWait?.({ status: 'waiting', slot: 'shared', slots: cause.slots, owners: cause.owners, waitedMs });
      previous = identity;
      if (waitedMs >= waitMs) throw error('HOST_CHECKS_TIMEOUT', 'Wait deadline reached for a shared slot. The owners are unchanged.');
      try { await delay(Math.min(pollMs, Math.max(0, waitMs - waitedMs)), undefined, { signal }); }
      catch (cause) { if (cause.name === 'AbortError') throw error('HOST_CHECKS_CANCELLED', 'Waiting cancelled; no shared slot was taken.'); throw cause; }
      continue;
    }
    for (const owner of lease.reclaimed) onWait?.({ status: 'reclaimed', slot: 'shared', ...owner });
    const waitedMs = Math.round(performance.now() - started);
    if (previous) onWait?.({ status: 'acquired', slot: 'shared', waitedMs });
    return { ...lease, waitedMs };
  }
}
