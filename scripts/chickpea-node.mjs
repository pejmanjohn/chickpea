#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  defaultNodeInstallationHome,
  initInstallation,
  installLaunchAgent,
  installationStatus,
  openSetup,
  renewSetup,
  runStart,
  stopInstallation,
  uninstallLaunchAgent,
} from './lib/node-installation.mjs';

const RELEASE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArguments(argv, environment = process.env) {
  const args = [...argv];
  let home = defaultNodeInstallationHome(environment);
  if (args[0] === '--home') {
    if (!args[1] || args[1].startsWith('--')) throw new Error('--home requires a directory.');
    home = path.resolve(args[1]);
    args.splice(0, 2);
  }
  const command = args.shift();
  if (!command) throw new Error(usage());
  return { home, command, args };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', 'help'].includes(argv[0])) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const parsed = parseArguments(argv);
  if (parsed.command === 'init') {
    const options = parseInitOptions(parsed.args);
    const result = await initInstallation({ home: parsed.home, releaseRoot: RELEASE_ROOT, ...options });
    process.stdout.write(result.changed
      ? `[chickpea] Initialized ${result.sourceCommit.slice(0, 12)}.\n`
      : `[chickpea] Installation already initialized.\n`);
    return 0;
  }
  if (parsed.command === 'start') {
    const open = parseFlagOnly(parsed.args, '--open');
    return runStart(parsed.home, { open });
  }
  if (parsed.command === 'stop') {
    requireNoArguments(parsed.args, 'stop');
    const result = await stopInstallation(parsed.home);
    process.stdout.write(result.stopped
      ? '[chickpea] Stopped.\n'
      : result.serviceUnloaded
        ? '[chickpea] LaunchAgent unloaded; no managed process answered the control socket.\n'
        : '[chickpea] No managed process is running.\n');
    return 0;
  }
  if (parsed.command === 'status') {
    requireNoArguments(parsed.args, 'status');
    const status = await installationStatus(parsed.home);
    process.stdout.write([
      `Home: ${status.home}`,
      `Installed version: ${status.installedVersion}`,
      `Source commit: ${status.sourceCommit}`,
      `Managed process: ${yesNo(status.managedProcess)}`,
      `Local HTTP: ${yesNo(status.localReachable)}`,
      `Public HTTPS: ${yesNo(status.publicReachable)}`,
      `Tunnel configured: ${yesNo(status.tunnelConfigured)}`,
      `Tunnel process: ${status.tunnelConfigured ? yesNo(status.tunnelRunning) : 'not configured'}`,
      `Start-at-login service installed: ${yesNo(status.launchAgentInstalled)}`,
      `Start-at-login service loaded: ${yesNo(status.launchAgentLoaded)}`,
      'Slack delivery: not verified by this command',
      '',
    ].join('\n'));
    return status.managedProcess && status.localReachable ? 0 : 1;
  }
  if (parsed.command === 'setup') {
    const renew = parseFlagOnly(parsed.args, '--renew');
    if (renew) {
      await renewSetup(parsed.home);
      process.stdout.write('[chickpea] Setup access renewed. Run `chickpea-node setup` to open it.\n');
    } else {
      await openSetup(parsed.home);
      process.stdout.write('[chickpea] Opened setup in the browser.\n');
    }
    return 0;
  }
  if (parsed.command === 'service') {
    const action = parsed.args.shift();
    requireNoArguments(parsed.args, `service ${action ?? ''}`.trim());
    if (action === 'install') {
      const result = await installLaunchAgent(parsed.home);
      process.stdout.write(`[chickpea] Start-at-login service installed (${result.label}).\n`);
      return 0;
    }
    if (action === 'uninstall') {
      const result = uninstallLaunchAgent(parsed.home);
      process.stdout.write(result.removed
        ? `[chickpea] Start-at-login service removed (${result.label}).\n`
        : '[chickpea] No start-at-login service was installed.\n');
      return 0;
    }
    throw new Error('service requires install or uninstall.');
  }
  throw new Error(`Unknown command: ${parsed.command}\n${usage()}`);
}

function parseInitOptions(args) {
  const values = new Map();
  const allowed = new Set(['--origin', '--port', '--tunnel', '--tunnel-token-file', '--cloudflared']);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option)) throw new Error(`Unknown init option: ${option ?? '(missing)'}`);
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
    if (values.has(option)) throw new Error(`${option} may only be provided once.`);
    values.set(option, value);
  }
  if (!values.has('--origin') || !values.has('--port')) {
    throw new Error('init requires --origin and --port.');
  }
  return {
    origin: values.get('--origin'),
    port: Number(values.get('--port')),
    tunnelMode: values.get('--tunnel') ?? 'external',
    ...(values.has('--tunnel-token-file') ? { tunnelTokenFile: path.resolve(values.get('--tunnel-token-file')) } : {}),
    ...(values.has('--cloudflared') ? { cloudflared: path.resolve(values.get('--cloudflared')) } : {}),
  };
}

function parseFlagOnly(args, flag) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === flag) return true;
  throw new Error(`Only ${flag} is accepted for this command.`);
}

function requireNoArguments(args, command) {
  if (args.length > 0) throw new Error(`${command} does not accept arguments.`);
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function usage() {
  return `Usage: chickpea-node [--home DIR] <command>
  init --origin URL --port PORT [--tunnel external|cloudflare] [--tunnel-token-file FILE --cloudflared FILE]
  start [--open]
  stop
  status
  setup [--renew]
  service install|uninstall`;
}

export function isMainModule(argvEntry = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch { return false; }
}

if (isMainModule()) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`[chickpea] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
