import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** The exit status of a command stopped for a stall, as timeout(1) uses. */
export const STALL_EXIT_CODE = 124;
export const DEFAULT_STALL_MS = 600_000;
const STOP_GRACE_MS = 5_000;
const DRAIN_MS = 1_000;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** A stall window from --stall-ms or CHICKPEA_STALL_MS: whole milliseconds, 0 turns the stop off. */
export function stallWindowMs(value) {
  const ms = Number(value);
  if (value === '' || !Number.isSafeInteger(ms) || ms < 0 || ms > 86_400_000) throw new Error('The stall window must be 0..86400000 ms; 0 turns the stall stop off.');
  return ms;
}

function groupLive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (cause) { return cause.code !== 'ESRCH'; }
}

/** SIGTERM, then SIGKILL, to the whole group; true once no process in it is left. */
async function stopGroup(pgid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-pgid, signal); } catch (cause) { if (cause.code === 'ESRCH') return true; }
    for (let waited = 0; waited < STOP_GRACE_MS; waited += 50) {
      await delay(50);
      if (!groupLive(pgid)) return true;
    }
  }
  return false;
}

const lastLine = (text) => text.split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 300);

/**
 * Runs a command in its own process group and passes its output through.
 * The whole group, and nothing outside it, is stopped when the command prints
 * nothing on stdout or stderr for stallMs, or when this process's parent
 * exits, so a killed caller leaves no pass running on. SIGINT, SIGTERM and
 * SIGHUP sent to this process are passed to the group. A stallMs of 0 turns
 * only the stall stop off. Resolves { error } for a command that could not
 * start, else { status, signal, stopped }, where stopped is
 * { reason: 'stall' | 'parent', lastLine, groupStopped }.
 */
export async function runWithStallStop(command, args, { env = process.env, stallMs = DEFAULT_STALL_MS } = {}) {
  let child;
  // spawn() throws some failures (ENOTDIR, E2BIG) instead of emitting them.
  try { child = spawn(command, args, { env, stdio: ['inherit', 'pipe', 'pipe'], detached: true }); } catch (error) { return { error }; }
  const forward = (signal) => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  // A reader that goes away (`| head`) must not end this process while it owns the group and its slot.
  // pipe() leaves the source paused when its destination fails; keep draining so the command never blocks on a full pipe.
  const ignore = () => { child.stdout?.resume(); child.stderr?.resume(); };
  process.stdout.on('error', ignore); process.stderr.on('error', ignore);
  const parent = process.ppid;
  let tail = '';
  let stopped;
  const stop = (reason) => { stopped ??= { reason, lastLine: lastLine(tail), groupStopped: stopGroup(child.pid) }; };
  let timer;
  let orphaned;
  try {
    const failed = await new Promise((resolve) => { child.once('spawn', () => resolve(undefined)); child.once('error', resolve); });
    if (failed) return { error: failed };
    if (stallMs > 0) timer = setTimeout(() => stop('stall'), stallMs);
    orphaned = setInterval(() => { if (process.ppid !== parent) stop('parent'); }, 1000);
    const closed = [[child.stdout, process.stdout], [child.stderr, process.stderr]].map(([stream, sink]) => {
      stream.on('data', (chunk) => {
        if (stopped) return;
        timer?.refresh();
        tail = (tail + chunk).slice(-4096);
      });
      stream.pipe(sink, { end: false });
      return new Promise((resolve) => stream.once('close', resolve));
    });
    const [status, signal] = await new Promise((resolve) => child.once('exit', (...result) => resolve(result)));
    clearTimeout(timer); clearInterval(orphaned);
    // A descendant that left the group can hold the pipes open; it does not hold this run.
    await Promise.race([Promise.all(closed), delay(DRAIN_MS, undefined, { ref: false })]);
    return { status, signal, stopped: stopped && { ...stopped, groupStopped: await stopped.groupStopped } };
  } finally {
    clearTimeout(timer); clearInterval(orphaned);
    child.stdout?.destroy(); child.stderr?.destroy();
    for (const name of FORWARDED_SIGNALS) process.removeListener(name, forward);
    process.stdout.removeListener('error', ignore); process.stderr.removeListener('error', ignore);
  }
}
