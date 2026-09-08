import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST_CHECK_LOCK = join(homedir(), '.chickpea', 'verification-host', 'owner.json');

/** One local host slot, no waiting, stealing, process killing, or scheduler. */
export function acquireHostChecks({ file = HOST_CHECK_LOCK, env = process.env, cwd = process.cwd() } = {}) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  let prior;
  try { prior = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior && env.CHICKPEA_CHECK_OWNER === prior.token) {
    process.kill(prior.pid, 0); // Nested commands may share only a living owner's slot.
    return { env: { CHICKPEA_CHECK_OWNER: prior.token }, release() {} };
  }
  const token = randomUUID();
  try { writeFileSync(file, JSON.stringify({ pid: process.pid, cwd, startedAt: new Date().toISOString(), token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Expensive checks are reserved: ${file}; owner PID ${prior?.pid ?? 'inspect file'}, checkout ${prior?.cwd ?? 'inspect file'}. Continue lightweight work. Never steal the slot; after interruption reconcile the owner and descendants before removing its exact lock.`);
  }
  return { env: { CHICKPEA_CHECK_OWNER: token }, release() {
    if (JSON.parse(readFileSync(file, 'utf8')).token !== token) throw new Error('Host check ownership changed; lock retained.');
    unlinkSync(file);
  } };
}
