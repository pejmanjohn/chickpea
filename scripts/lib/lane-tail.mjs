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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Open (or create) an owner-only file for appending and return its descriptor. */
function appendOnly(file) {
  return openSync(file, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600);
}

/**
 * Run `command args` until `durationMs` elapses, appending stdout to `out`
 * and stderr to `<out>.err`, and one line per attach, exit, stall restart and
 * stop to `<out>.events`. Returns counts for the caller's summary.
 */
export async function runTail({
  command, args, out, env = process.env, durationMs, stallMs, restartDelayMs = RESTART_DELAY_MS,
  spawnImpl = spawn, now = Date.now, signal,
}) {
  const deadline = now() + durationMs;
  const events = `${out}.events`;
  const note = (text) => appendFileSync(events, `${new Date(now()).toISOString()} ${text}\n`, { mode: 0o600 });
  const outDescriptor = appendOnly(out);
  const errDescriptor = appendOnly(`${out}.err`);
  const counts = { attaches: 0, exits: 0, stallRestarts: 0, bytes: 0 };
  let stopped = false;
  let current = null;
  const stop = () => { stopped = true; if (current && current.exitCode === null) current.kill('SIGTERM'); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    while (!stopped && now() < deadline) {
      counts.attaches += 1;
      note(`attach ${counts.attaches}`);
      const child = spawnImpl(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      current = child;
      let lastOutput = now();
      let stalled = false;
      child.stdout.on('data', (chunk) => { lastOutput = now(); counts.bytes += chunk.length; writeSync(outDescriptor, chunk); });
      child.stderr.on('data', (chunk) => { writeSync(errDescriptor, chunk); });
      const exited = new Promise((resolve) => {
        child.once('error', (error) => { note(`spawn error ${error.code ?? error.message}`); resolve({ code: null, signal: null }); });
        child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      });
      const watchdog = setInterval(() => {
        if (now() >= deadline || stopped) { child.kill('SIGTERM'); return; }
        if (now() - lastOutput >= stallMs) { stalled = true; child.kill('SIGTERM'); }
      }, Math.max(50, Math.min(1_000, Math.floor(stallMs / 4))));
      const result = await exited;
      clearInterval(watchdog);
      current = null;
      if (stopped || now() >= deadline) break;
      if (stalled) {
        counts.stallRestarts += 1;
        note(`no output for ${Math.round(stallMs / 1000)} s; restarting`);
      } else {
        counts.exits += 1;
        note(`exited ${result.code ?? result.signal ?? 'unknown'}; reattaching`);
      }
      await sleep(restartDelayMs);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    note(stopped ? 'stopped' : 'deadline reached');
    closeSync(outDescriptor);
    closeSync(errDescriptor);
  }
  return counts;
}
