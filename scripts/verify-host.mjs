#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { HOST_CHECK_LOCK, hostChecksHeldMs, readHostChecksOwner } from './lib/verification-host.mjs';
import { waitForHostChecks } from './lib/verification-host-wait.mjs';

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help') {
  console.log('Usage: npm run verify:host -- [--wait-ms MS] [--poll-ms MS] [--] COMMAND [ARG ...]\n       npm run verify:host -- status\nReserve one host slot for a serial build, workerd, boot, test-database or full-suite group. Typecheck, plain unit tests and mutation passes that start no server, port or test database run without it. Bounded waiting is opt-in; a hold over 15 minutes is reported to waiters once, never taken. No shell expansion, stealing or process killing. Timeout exits 3; cancellation exits 130. A command that cannot start releases the slot and exits 2; an interrupted command keeps it for reconciliation.\nstatus prints the owner (PID, checkout, start, whether the PID is live) or that the slot is free, as JSON, and never reserves. It wins over a command named status; to run one, put -- first: npm run verify:host -- -- status.');
} else if (args[0] === 'status') {
  try {
    if (args.length > 1) throw new Error('status takes no arguments. Use --help.');
    const owner = readHostChecksOwner();
    console.log(JSON.stringify(owner ? { status: 'reserved', file: HOST_CHECK_LOCK, owner, heldMs: hostChecksHeldMs(owner) } : { status: 'free', file: HOST_CHECK_LOCK }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
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
    if (!result.pid) {
      lease.release();
      throw new Error(`Command could not start: ${args[0]} (${result.error.code}). It holds no host reservation.`);
    }
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
