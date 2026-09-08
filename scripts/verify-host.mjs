#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { acquireHostChecks } from './lib/verification-host.mjs';

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help') {
  console.log('Usage: npm run verify:host -- COMMAND [ARG ...]\nReserve one host slot for a serial full-suite/build/workerd group. No shell expansion, waiting, or process killing. verify:regression acquires this slot automatically.');
} else {
  try {
    const lease = acquireHostChecks();
    const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit', env: { ...process.env, ...lease.env } });
    if (!result.signal && !result.error) lease.release();
    else console.error('Interrupted command: host reservation retained. Reconcile its processes before removing the exact owner.json.');
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
