// Loopback ports for local verification servers, without the probe-then-bind
// race.
//
// `listen(0)` hands out a port from the kernel's ephemeral range, which macOS
// (49152-65535) and Linux (32768-60999) also use for the source port of every
// outgoing connection. Probing a port, closing it, and binding it again in a
// child leaves a window in which the harness's own readiness polls and fake
// service calls can take the port back, and in which a sibling harness or a
// concurrently running test can probe the same number. Ports here come from a
// fixed range outside every ephemeral range, are claimed with a per-port lock
// file shared by every Chickpea verification process on this host, and are
// bind-probed once claimed. A lock is released when the owning process exits;
// a lock left by a dead process is reclaimed by liveness.
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERIFICATION_PORT_RANGE = Object.freeze({ first: 20100, last: 20999 });
export const VERIFICATION_PORT_LOCK_DIR = join(homedir(), '.chickpea', 'verification-host', 'ports');
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

const held = new Set();
process.once('exit', () => {
  for (const file of held) { try { unlinkSync(file); } catch { /* already gone */ } }
});

function ownerIsLive(lock) {
  if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1) return false;
  if (lock.pid === process.pid) return true;
  const age = Date.now() - Date.parse(lock.startedAt ?? '');
  if (!Number.isFinite(age) || age > STALE_LOCK_MS) return false;
  try { process.kill(lock.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function claim(file) {
  const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { writeFileSync(file, record, { flag: 'wx', mode: 0o600 }); held.add(file); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { existing = null; }
      if (existing && ownerIsLive(existing)) return false;
      try { unlinkSync(file); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
  }
  return false;
}

function bindable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Reserve one loopback port for the rest of this process's life. */
export async function reserveVerificationPort({ range = VERIFICATION_PORT_RANGE, lockDir = VERIFICATION_PORT_LOCK_DIR } = {}) {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const count = range.last - range.first + 1;
  const start = Math.floor(Math.random() * count);
  for (let index = 0; index < count; index += 1) {
    const port = range.first + ((start + index) % count);
    const file = join(lockDir, `${port}.json`);
    if (!claim(file)) continue;
    if (await bindable(port)) return port;
    releaseVerificationPort(port, { lockDir });
  }
  throw new Error(`No free verification port in ${range.first}-${range.last}; inspect ${lockDir} for stale reservations.`);
}

/** Release a reservation early; exit releases whatever remains. */
export function releaseVerificationPort(port, { lockDir = VERIFICATION_PORT_LOCK_DIR } = {}) {
  const file = join(lockDir, `${port}.json`);
  if (!held.delete(file)) return;
  try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
