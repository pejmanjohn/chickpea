#!/usr/bin/env node
/**
 * Run, attach to, seed, or export one QA lane's browser profile.
 *
 *   npm run lane:browser -- start  <lane> [--root DIR] [--executable PATH] [--wait-ms MS]
 *   npm run lane:browser -- status <lane|all> [--root DIR] [--json]
 *   npm run lane:browser -- stop   <lane> [--root DIR]
 *   npm run lane:browser -- attach <lane> [--root DIR] [--workspace DIR]... [--dry-run]
 *   npm run lane:browser -- serve  <lane> [--root DIR] [--executable PATH] [--headless|--no-headless] [--no-seed] [--dry-run]
 *   npm run lane:browser -- import <lane> [--root DIR] [--executable PATH] [--from-file PATH] [--replace]
 *   npm run lane:browser -- export <lane> --to-file PATH [--root DIR] [--executable PATH] [--host HOST]... [--replace]
 *
 * On a maintainer's machine each lane's Chrome is a daemon: `start` launches
 * the lane profile once on its fixed local debugging port (amber 9331, cobalt
 * 9332, violet 9333) and every session's `chrome-<lane>` server attaches to
 * it with `--browserUrl`, so no session holds the profile and there is
 * nothing to quit when a run ends. `attach` runs that server (or prints its
 * plan with --dry-run, which is the reference for the host MCP entries).
 *
 * `serve` is what the repository's .mcp.json runs for `chrome-<lane>`: it
 * seeds the profile from CHICKPEA_LANE_COOKIES_<LANE> when that payload is
 * new (cloud sessions), starts the lane daemon unless one already answers
 * (headless where Linux has no display), and attaches. A profile a browser
 * from the old launch-per-server mode still holds is reported, and the
 * server still attaches so the failure names the holder. Lane browsers are
 * opt-in: the root comes from --root or CHICKPEA_LANE_CHROME_ROOT, an
 * owner-only directory outside the repository holding one profile per lane.
 * Everything this script says goes to stderr, because stdout is the MCP
 * channel (status and dry-run JSON excepted), and no cookie value is ever
 * printed. See qa/live/operator/hosts.md.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertProfileFree, attachPlan, childEnvironment, daemonLaunchArguments, daemonStatus, DEFAULT_COOKIE_HOSTS, ensureOwnerOnlyDirectory,
  exportCookies, headlessDefault, LaneBrowserError, normalizeHost, resolveChromiumExecutable, resolveProfileRoot, ROOT_VARIABLE, seedProfile,
  startDaemon, stopDaemon, writeOwnerOnlyFile,
} from './lib/lane-browser.mjs';
import { QA_LANES } from './lib/qa-lanes.mjs';

const COMMANDS = new Set(['start', 'status', 'stop', 'attach', 'serve', 'import', 'export']);
// The daemon commands run from a verifier's shell, which may not export the
// root variable; on a host that has the conventional root they default to it.
// `serve`, `import` and `export` stay strictly opt-in.
const DEFAULT_ROOT_COMMANDS = new Set(['start', 'status', 'stop', 'attach']);
const USAGE = 'Usage: npm run lane:browser -- (start|status|stop|attach|serve|import|export) <amber|cobalt|violet> [options]\n' +
  '  start   [--root DIR] [--executable PATH] [--wait-ms MS]   launch the lane daemon on its fixed port, or report it running\n' +
  '  status  <lane|all> [--root DIR] [--json]                  running, held by a per-session browser, or stopped\n' +
  '  stop    [--root DIR]                                      stop the daemon this root started; never another browser\n' +
  '  attach  [--root DIR] [--workspace DIR]... [--dry-run]     run chrome-devtools-mcp against the daemon (host MCP entries)\n' +
  '  serve   [--root DIR] [--executable PATH] [--headless|--no-headless] [--no-seed] [--dry-run]   cloud: seed, then launch\n' +
  '  import  [--root DIR] [--executable PATH] [--from-file PATH] [--replace]\n' +
  '  export  --to-file PATH [--root DIR] [--executable PATH] [--host HOST]... [--replace]\n';

export function parseArguments(argv) {
  const [command, lane, ...rest] = argv;
  if (!COMMANDS.has(command)) throw new Error(`Choose a command: ${[...COMMANDS].join(', ')}.`);
  const options = {
    command, lane, root: undefined, executable: undefined, headless: undefined, seed: true, dryRun: false, fromFile: undefined,
    toFile: undefined, hosts: [], replace: false, workspaces: [], json: false, waitMs: undefined,
  };
  const value = (flag, index) => {
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return next;
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--root') options.root = value(flag, index++);
    else if (flag === '--executable') options.executable = value(flag, index++);
    else if (flag === '--headless') options.headless = true;
    else if (flag === '--no-headless') options.headless = false;
    else if (flag === '--no-seed') options.seed = false;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--from-file') options.fromFile = value(flag, index++);
    else if (flag === '--to-file') options.toFile = value(flag, index++);
    else if (flag === '--host') options.hosts.push(normalizeHost(value(flag, index++)));
    else if (flag === '--workspace') options.workspaces.push(value(flag, index++));
    else if (flag === '--wait-ms') {
      const ms = Number(value(flag, index++));
      if (!Number.isInteger(ms) || ms < 1000 || ms > 120_000) throw new Error('--wait-ms must be 1000..120000.');
      options.waitMs = ms;
    }
    else if (flag === '--replace') options.replace = true;
    else throw new Error(`Unknown argument "${flag}".`);
  }
  if (command === 'status' && lane !== 'all' && !QA_LANES.includes(lane)) throw new Error(`Choose a lane: ${QA_LANES.join(', ')}, or all.`);
  if (command === 'export' && !options.toFile) throw new Error('export needs --to-file PATH; the payload is never printed.');
  for (const file of [options.fromFile, options.toFile, ...options.workspaces]) {
    if (file !== undefined && !path.isAbsolute(file)) throw new Error('--from-file, --to-file and --workspace must be absolute paths.');
  }
  return options;
}

function describeSeed(result) {
  if (result.status === 'no_payload') return `no cookie payload (${result.variable} unset)`;
  if (result.status === 'skipped') return 'seeding skipped (--no-seed)';
  if (result.status.startsWith('profile_')) return `seeding skipped: the profile is ${result.status.slice('profile_'.length)}`;
  const { marker } = result;
  const skipped = marker.skipped ? `; skipped ${marker.skipped.expired} expired, ${marker.skipped.sessionOnly} session-only` : '';
  return `${result.status.replace('_', ' ')}: ${marker.cookieCount} cookies for ${marker.domains.join(', ')} (${marker.names.join(', ')})${skipped}; digest ${marker.payloadDigest}`;
}

function describeStatus(status) {
  if (status.state === 'running') {
    const since = status.record?.startedAt ? ` since ${status.record.startedAt} (pid ${status.record.pid})` : ' (started outside this tool)';
    return `running: ${status.browser} on ${status.url}${since}`;
  }
  if (status.state === 'held') {
    return `held by pid ${status.holder.pid} (${status.holder.command.slice(0, 120) || 'unknown command'}), not answering on ${status.url}; ` +
      'that browser belongs to the session that launched it';
  }
  return `stopped; run \`npm run lane:browser -- start ${status.lane}\` to launch it on ${status.url}`;
}

function runServer(plan, env) {
  return new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, { stdio: 'inherit', env: childEnvironment(env) });
    const forward = (signal) => () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, forward(signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    child.once('error', (error) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      process.stderr.write(`chrome-${plan.lane}: could not start ${plan.command}: ${error.message}\n`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length === 0 || argv.includes('--help')) { stderr.write(USAGE); return argv.length === 0 ? 2 : 0; }
  let options;
  try { options = parseArguments(argv); } catch (error) { stderr.write(`${error.message}\n${USAGE}`); return 2; }
  try {
    const conventionalRoot = path.join(homedir(), '.chickpea', 'browsers');
    const rootOption = options.root ?? (DEFAULT_ROOT_COMMANDS.has(options.command) && !env[ROOT_VARIABLE]?.trim() && existsSync(conventionalRoot)
      ? conventionalRoot : undefined);
    const root = ensureOwnerOnlyDirectory(resolveProfileRoot({ root: rootOption, env }));
    const label = `chrome-${options.lane}`;
    if (options.command === 'status') {
      const lanes = options.lane === 'all' ? [...QA_LANES] : [options.lane];
      const statuses = [];
      for (const lane of lanes) statuses.push(await daemonStatus({ lane, root, env }));
      if (options.json) stdout.write(`${JSON.stringify(options.lane === 'all' ? statuses : statuses[0], null, 2)}\n`);
      else for (const status of statuses) stdout.write(`chrome-${status.lane}: ${describeStatus(status)}\n`);
      return 0;
    }
    if (options.command === 'start') {
      const result = await startDaemon({ lane: options.lane, root, env, executable: options.executable, timeoutMs: options.waitMs });
      stderr.write(`${label}: ${result.status === 'running' ? 'already running' : 'started'}: ${result.browser} on ${result.url}` +
        `${result.record?.pid ? ` (pid ${result.record.pid})` : ''}\n`);
      return 0;
    }
    if (options.command === 'stop') {
      const result = await stopDaemon({ lane: options.lane, root, env });
      stderr.write(`${label}: ${result.status === 'stopped' ? `stopped pid ${result.pid}` : `pid ${result.pid} was not running; record removed`}\n`);
      return 0;
    }
    if (options.command === 'attach') {
      const plan = attachPlan({ lane: options.lane, root, env, workspaces: options.workspaces });
      if (options.dryRun) { stdout.write(`${JSON.stringify(plan, null, 2)}\n`); return 0; }
      const status = await daemonStatus({ lane: options.lane, root, env });
      stderr.write(`${label}: attaching to ${plan.url} (${describeStatus(status)})\n`);
      return await runServer(plan, env);
    }
    const profile = path.join(root, options.lane);
    if (options.command !== 'export') ensureOwnerOnlyDirectory(profile);
    if (options.command === 'import') {
      await assertProfileFree({ lane: options.lane, root, env });
      const payloadText = options.fromFile === undefined ? undefined : readFileSync(options.fromFile, 'utf8');
      const executable = resolveChromiumExecutable({ executable: options.executable, env, required: true });
      const result = await seedProfile({ lane: options.lane, profile, env, replace: options.replace, payloadText, executable });
      if (result.status === 'no_payload') throw new LaneBrowserError(`No cookie payload: set ${result.variable} or pass --from-file PATH.`);
      stderr.write(`${label}: ${describeSeed(result)}\n`);
      return 0;
    }
    if (options.command === 'export') {
      if (!options.replace && existsSync(options.toFile)) throw new LaneBrowserError(`${options.toFile} exists; pass --replace to overwrite it.`);
      await assertProfileFree({ lane: options.lane, root, env });
      const executable = resolveChromiumExecutable({ executable: options.executable, env, required: true });
      const hosts = [...new Set([...DEFAULT_COOKIE_HOSTS, ...options.hosts])];
      const { text, summary } = await exportCookies({ lane: options.lane, profile, hosts, executable, env });
      writeOwnerOnlyFile(options.toFile, `${text}\n`);
      stderr.write(`${label}: exported ${summary.cookieCount} cookies (${summary.persistent} persistent) for ${summary.domains.join(', ')} ` +
        `(${summary.names.join(', ')}) to ${options.toFile}; ${summary.bytes} base64 bytes; digest ${summary.digest}\n` +
        `Paste the file's content into the cloud environment variable CHICKPEA_LANE_COOKIES_${options.lane.toUpperCase()}, then delete the file.\n`);
      return 0;
    }
    // serve: seed when a payload is new and the profile is free, make sure the lane daemon runs, then attach.
    const executable = resolveChromiumExecutable({ executable: options.executable, env, required: true });
    const before = await daemonStatus({ lane: options.lane, root, env });
    const seed = !options.seed ? { status: 'skipped' }
      : before.state === 'stopped' ? await seedProfile({ lane: options.lane, profile, env, executable })
        : { status: `profile_${before.state}` };
    const headless = options.headless ?? headlessDefault({ env });
    const plan = attachPlan({ lane: options.lane, root, env, workspaces: options.workspaces });
    if (options.dryRun) {
      const status = await daemonStatus({ lane: options.lane, root, env });
      stdout.write(`${JSON.stringify({
        ...plan, executable, headless, daemon: { state: status.state, launchArgs: daemonLaunchArguments({ profile, port: plan.port, headless }) },
        seed: seed.status, marker: seed.marker ?? null,
      }, null, 2)}\n`);
      return 0;
    }
    let daemon;
    try {
      daemon = await startDaemon({ lane: options.lane, root, env, executable, headless: options.headless });
    } catch (error) {
      if (!(error instanceof LaneBrowserError)) throw error;
      daemon = { status: 'unavailable', message: error.message };
    }
    stderr.write(`${label}: ${daemon.status === 'unavailable' ? daemon.message : `daemon ${daemon.status}: ${daemon.browser} on ${daemon.url}`}; ` +
      `${describeSeed(seed)}; attaching\n`);
    return await runServer(plan, env);
  } catch (error) {
    if (error instanceof LaneBrowserError) { stderr.write(`${error.message}\n`); return 1; }
    if (error?.code === 'ENOENT' && options.fromFile !== undefined) { stderr.write(`No payload file at ${options.fromFile}.\n`); return 1; }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
