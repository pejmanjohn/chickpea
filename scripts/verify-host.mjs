#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { waitForHostChecks } from './lib/verification-host-wait.mjs';

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help') {
  console.log('Usage: npm run verify:host -- [--wait-ms MS] [--poll-ms MS] [--] COMMAND [ARG ...]\nReserve one host slot for a serial full-suite/build/workerd group. Bounded waiting is opt-in; no shell expansion, stealing or process killing. Timeout exits 3; cancellation exits 130.');
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const options = { waitMs: 0, pollMs: 1000 };
    while (args[0]?.startsWith('--') && args[0] !== '--') {
      const flag = args.shift();
      if (!['--wait-ms', '--poll-ms'].includes(flag)) throw new Error('Unknown host-check option. Use --help.');
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error(`${flag} requires milliseconds.`);
      options[flag === '--wait-ms' ? 'waitMs' : 'pollMs'] = Number(value);
    }
    if (args[0] === '--') args.shift();
    if (!args.length) throw new Error('A command is required.');
    const lease = await waitForHostChecks({ ...options, signal: controller.signal,
      onWait: (event) => console.error(JSON.stringify(event)) });
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    if (options.waitMs) console.error(JSON.stringify({ status: 'acquired', waitedMs: lease.waitedMs }));
    const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit', env: { ...process.env, ...lease.env } });
    if (!result.signal && !result.error) lease.release();
    else console.error('Interrupted command: host reservation retained. Reconcile its processes before removing the exact owner.json.');
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === 'HOST_CHECKS_TIMEOUT' ? 3 : error.code === 'HOST_CHECKS_CANCELLED' ? 130 : 2;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
