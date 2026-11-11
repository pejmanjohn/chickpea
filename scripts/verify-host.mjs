#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { DEFAULT_STALL_MS, runWithStallStop, STALL_EXIT_CODE, stallWindowMs } from './lib/stall-stop.mjs';
import { HOST_CHECK_SLOTS, hostChecksHeldMs, hostChecksLiveness, readHostChecksOwners } from './lib/verification-host.mjs';
import { waitForSharedSlot } from './lib/verification-host-shared.mjs';
import { waitForHostChecks } from './lib/verification-host-wait.mjs';

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help') {
  console.log('Usage: npm run verify:host -- [--shared] [--wait-ms MS] [--poll-ms MS] [--stall-ms MS] [--] COMMAND [ARG ...]\n       npm run verify:host -- status\nReserve one of the host\'s two slots for a serial build, workerd, boot, test-database or full-suite group. Bounded waiting is opt-in; a hold over 15 minutes is reported to waiters once, never taken. No shell expansion or stealing. Timeout exits 3; cancellation exits 130. A command that cannot start releases its slot and exits 2; an interrupted command keeps it for reconciliation.\n--shared takes one of the host\'s shared CPU slots instead, for CPU-heavy work that starts no server, port or test database: test passes of plain unit tests, typecheck, mutation passes, the cards harness. There is one per six cores, at least one (CHICKPEA_SHARED_SLOTS overrides), and a live exclusive reservation counts as one. It waits up to two hours by default and prints a status when the owners change. A command under an exclusive reservation or a shared slot takes no second one. A shared slot guards only CPU: it is released however its command ends, and the next caller reclaims a slot whose PID has exited. run-tests.mjs and npm run typecheck take one themselves.\nStall stop: a --shared command, and so every run-tests.mjs pass, runs in its own process group and is stopped with that whole group when it prints nothing on stdout or stderr for 600000 ms (--stall-ms or CHICKPEA_STALL_MS sets the window; 0 turns it off), or when its caller exits. A stalled command exits ' + STALL_EXIT_CODE + ', and its slot is released once the group is gone. A reserved command, such as a build or a lane deploy, is watched only when --stall-ms or CHICKPEA_STALL_MS is given. A command under a watching verify:host stays in that group, and the outer window applies. SIGINT, SIGTERM and SIGHUP are passed to a watched group.\nstatus prints each exclusive slot\'s owner (PID, checkout, start, whether the PID is live), or null for a free slot, as JSON, and never reserves; it reports free while any slot is free. It wins over a command named status; to run one, put -- first: npm run verify:host -- -- status.');
} else if (args[0] === 'status') {
  try {
    if (args.length > 1) throw new Error('status takes no arguments. Use --help.');
    const owners = readHostChecksOwners();
    const slots = HOST_CHECK_SLOTS.map((file) => {
      const held = owners.find((owner) => owner.file === file);
      if (!held) return { file, owner: null, heldMs: null };
      const { pid, cwd, startedAt, liveness } = held;
      return { file, owner: { pid, cwd, startedAt, liveness }, heldMs: hostChecksHeldMs(held) };
    });
    console.log(JSON.stringify({ status: owners.length < slots.length ? 'free' : 'reserved', slots }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const options = { shared: false, waitMs: undefined, pollMs: 1000, stallMs: undefined };
    while (args[0]?.startsWith('--') && args[0] !== '--') {
      const flag = args.shift();
      if (flag === '--shared') { options.shared = true; continue; }
      if (!['--wait-ms', '--poll-ms', '--stall-ms'].includes(flag)) throw new Error('Unknown host-check option. Use --help.');
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error(`${flag} requires milliseconds.`);
      if (flag === '--stall-ms') options.stallMs = stallWindowMs(value);
      else options[flag === '--wait-ms' ? 'waitMs' : 'pollMs'] = Number(value);
    }
    if (args[0] === '--') args.shift();
    if (!args.length) throw new Error('A command is required.');
    // Reserved commands, which include builds and lane deploys, are watched only on request.
    const stallMs = options.stallMs ?? (process.env.CHICKPEA_STALL_MS ? stallWindowMs(process.env.CHICKPEA_STALL_MS) : options.shared ? DEFAULT_STALL_MS : 0);
    // Under a watching verify:host the command stays in that process group, so the outer stop reaches it.
    // A --shared command keeps its group and marker with the stall stop off: run-tests.mjs restarts itself under --shared until it sees the marker.
    const outer = hostChecksLiveness(Number(process.env.CHICKPEA_VERIFY_HOST_PID)) === 'live';
    const watched = (options.shared || stallMs > 0) && !outer;
    if (outer && options.stallMs !== undefined) console.error(`[verify:host] --stall-ms ignored: this command runs inside verify:host PID ${process.env.CHICKPEA_VERIFY_HOST_PID}, whose stall window applies.`);
    const command = args.join(' ');
    const label = command.length > 200 ? `${command.slice(0, 199)}…` : command;
    const wait = { pollMs: options.pollMs, signal: controller.signal, onWait: (event) => console.error(JSON.stringify(event)) };
    const lease = options.shared
      ? await waitForSharedSlot({ ...wait, waitMs: options.waitMs, command: label })
      : await waitForHostChecks({ ...wait, waitMs: options.waitMs ?? 0 });
    if (!options.shared && options.waitMs) console.error(JSON.stringify({ status: 'acquired', waitedMs: lease.waitedMs }));
    const env = { ...process.env, ...lease.env };
    let run;
    if (watched) {
      // CHICKPEA_VERIFY_HOST_PID tells nested run-tests.mjs and verify:host runs that this process already counts and watches them.
      run = await runWithStallStop(args[0], args.slice(1), { stallMs, env: { ...env, CHICKPEA_VERIFY_HOST_PID: String(process.pid) } });
      if (!run.error) run.interrupted = Boolean(run.signal);
    } else {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit', env });
      run = result.pid ? { status: result.status, interrupted: Boolean(result.signal || result.error) } : { error: result.error };
    }
    if (run.error) {
      lease.release();
      throw new Error(`Command could not start: ${args[0]} (${run.error.code}). It holds no host reservation.`);
    }
    if (run.stopped?.reason === 'stall') {
      console.error(`[verify:host] Stalled: no output for ${stallMs / 1000} s from \`${label}\`, so its process group was stopped (exit ${STALL_EXIT_CODE}). Last output: ${run.stopped.lastLine ?? '(none)'}`);
    } else if (run.stopped) {
      console.error(`[verify:host] Its caller exited, so the process group of \`${label}\` was stopped.`);
    }
    if (options.shared || (run.stopped ? run.stopped.groupStopped : !run.interrupted)) lease.release();
    else console.error(`Interrupted command: host reservation retained. Reconcile its processes before removing the exact ${lease.file}.`);
    process.exitCode = run.stopped?.reason === 'stall' ? STALL_EXIT_CODE : run.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === 'HOST_CHECKS_TIMEOUT' ? 3 : error.code === 'HOST_CHECKS_CANCELLED' ? 130 : 2;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
