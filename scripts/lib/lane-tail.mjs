/**
 * A bounded `wrangler tail` that survives deploys. Wrangler drops the tail
 * when a new version takes over and can also stall silently; verifiers used
 * to restart it by hand after every deploy and lost measurements when they
 * did not notice. This runner appends every event to one owner-only file,
 * reattaches after an exit, restarts after a long silence, and always stops at
 * its deadline, so it can never outlive the run that started it.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, constants, openSync, writeSync } from 'node:fs';

export const DEFAULT_TAIL_MINUTES = 60;
export const MAX_TAIL_MINUTES = 240;
export const DEFAULT_STALL_MINUTES = 10;
const RESTART_DELAY_MS = 2_000;
const KILL_GRACE_MS = 5_000;
/** An attach that exits this soon with no output did not really attach. */
const QUICK_EXIT_MS = 10_000;
const MAX_QUICK_EXITS = 3;

export class LaneTailError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Open (or create) an owner-only file for appending and return its descriptor. */
function appendOnly(file) {
  return openSync(file, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600);
}

/**
 * Run `command args` until `durationMs` elapses, appending stdout to `out`
 * and stderr to `<out>.err`, and one line per attach, exit, stall restart and
 * stop to `<out>.events`. A child that ignores SIGTERM is killed after a grace
 * period. A command that cannot start, or exits three times in a row without
 * printing anything but whitespace, is fatal (`TAIL_NOT_ATTACHING`) rather than retried for the window.
 */
export async function runTail({
  command, args, out, env = process.env, durationMs, stallMs, restartDelayMs = RESTART_DELAY_MS,
  killGraceMs = KILL_GRACE_MS, quickExitMs = QUICK_EXIT_MS, spawnImpl = spawn, now = Date.now, signal,
}) {
  const deadline = now() + durationMs;
  const events = `${out}.events`;
  const note = (text) => appendFileSync(events, `${new Date(now()).toISOString()} ${text}\n`, { mode: 0o600 });
  const outDescriptor = appendOnly(out);
  const errDescriptor = appendOnly(`${out}.err`);
  const counts = { attaches: 0, exits: 0, stallRestarts: 0, bytes: 0 };
  let stopped = signal?.aborted === true;
  let current = null;
  let quickExits = 0;
  let killedAt = null;
  let forced = false;
  const terminate = (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (killedAt === null) { killedAt = now(); child.kill('SIGTERM'); }
    else if (!forced && now() - killedAt >= killGraceMs) {
      forced = true;
      note(`no exit ${Math.round(killGraceMs / 1000)} s after SIGTERM; sent SIGKILL`);
      child.kill('SIGKILL');
    }
  };
  const stop = () => { stopped = true; terminate(current); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    while (!stopped && now() < deadline) {
      counts.attaches += 1;
      note(`attach ${counts.attaches}`);
      const startedAt = now();
      let sawOutput = false;
      killedAt = null;
      forced = false;
      const child = spawnImpl(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      current = child;
      let lastOutput = now();
      let stalled = false;
      let spawnError = null;
      child.stdout.on('data', (chunk) => {
        lastOutput = now(); counts.bytes += chunk.length; writeSync(outDescriptor, chunk);
        // Wrangler prints a bare newline to stdout when an attach fails, so only real text counts as attached.
        if (!sawOutput && chunk.toString('utf8').trim() !== '') sawOutput = true;
      });
      child.stderr.on('data', (chunk) => { writeSync(errDescriptor, chunk); });
      // `close` fires after the child's streams end, so no write can follow the
      // descriptors closing. If something the child left behind still holds the
      // pipes, stop reading them a grace period after the exit instead of
      // waiting past the deadline.
      let pipeGrace;
      const closed = new Promise((resolve) => {
        child.once('error', (error) => { spawnError = error; resolve({ code: null, signal: null }); });
        child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
        child.once('exit', (code, exitSignal) => {
          pipeGrace = setTimeout(() => {
            child.stdout.destroy(); child.stderr.destroy();
            resolve({ code, signal: exitSignal });
          }, killGraceMs);
        });
      });
      const watchdog = setInterval(() => {
        if (now() >= deadline || stopped || killedAt !== null) { terminate(child); return; }
        if (now() - lastOutput >= stallMs) { stalled = true; terminate(child); }
      }, Math.max(50, Math.min(1_000, Math.floor(stallMs / 4))));
      const result = await closed;
      clearInterval(watchdog);
      clearTimeout(pipeGrace);
      current = null;
      if (spawnError) {
        note(`spawn error ${spawnError.code ?? spawnError.message}`);
        throw new LaneTailError('TAIL_NOT_ATTACHING', `could not start ${command}: ${spawnError.code ?? spawnError.message}`);
      }
      if (stopped || now() >= deadline) break;
      if (stalled) {
        counts.stallRestarts += 1;
        note(`no output for ${Math.round(stallMs / 1000)} s; restarting`);
      } else {
        counts.exits += 1;
        quickExits = !sawOutput && now() - startedAt < quickExitMs ? quickExits + 1 : 0;
        const giveUp = quickExits >= MAX_QUICK_EXITS;
        note(`exited ${result.code ?? result.signal ?? 'unknown'}; ${giveUp ? 'not attaching, giving up' : 'reattaching'}`);
        if (giveUp) {
          throw new LaneTailError('TAIL_NOT_ATTACHING', `${MAX_QUICK_EXITS} attaches in a row exited within ${Math.round(quickExitMs / 1000)} s ` +
            `with no output (last exit ${result.code ?? result.signal ?? 'unknown'}); see ${out}.err`);
        }
      }
      await sleep(restartDelayMs);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    note(stopped ? 'stopped' : now() >= deadline ? 'deadline reached' : 'ended');
    closeSync(outDescriptor);
    closeSync(errDescriptor);
  }
  return counts;
}
