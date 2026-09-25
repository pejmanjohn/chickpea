#!/usr/bin/env node
/**
 * Serve, seed, or export one QA lane's browser profile.
 *
 *   npm run lane:browser -- serve <lane> [--root DIR] [--executable PATH] [--headless|--no-headless] [--no-seed] [--dry-run]
 *   npm run lane:browser -- import <lane> [--root DIR] [--executable PATH] [--from-file PATH] [--replace]
 *   npm run lane:browser -- export <lane> --to-file PATH [--root DIR] [--executable PATH] [--host HOST]... [--replace]
 *
 * `serve` is what the repository's .mcp.json runs for `chrome-<lane>`: it seeds
 * the profile from CHICKPEA_LANE_COOKIES_<LANE> when that payload is new, then
 * runs chrome-devtools-mcp on stdio. Lane browsers are opt-in: the root comes
 * from --root or CHICKPEA_LANE_CHROME_ROOT, an owner-only directory outside the
 * repository holding one profile per lane. Everything this script says goes to
 * stderr, because stdout is the MCP channel, and no cookie value is ever
 * printed. See qa/live/operator/hosts.md, "Cloud sessions".
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  childEnvironment, DEFAULT_COOKIE_HOSTS, ensureOwnerOnlyDirectory, exportCookies, LaneBrowserError, normalizeHost,
  resolveChromiumExecutable, resolveProfileRoot, seedProfile, serverPlan, writeOwnerOnlyFile,
} from './lib/lane-browser.mjs';

const COMMANDS = new Set(['serve', 'import', 'export']);
const USAGE = 'Usage: npm run lane:browser -- (serve|import|export) <amber|cobalt|violet> [options]\n' +
  '  serve   [--root DIR] [--executable PATH] [--headless|--no-headless] [--no-seed] [--dry-run]\n' +
  '  import  [--root DIR] [--executable PATH] [--from-file PATH] [--replace]\n' +
  '  export  --to-file PATH [--root DIR] [--executable PATH] [--host HOST]... [--replace]\n';

export function parseArguments(argv) {
  const [command, lane, ...rest] = argv;
  if (!COMMANDS.has(command)) throw new Error(`Choose a command: ${[...COMMANDS].join(', ')}.`);
  const options = { command, lane, root: undefined, executable: undefined, headless: undefined, seed: true, dryRun: false, fromFile: undefined, toFile: undefined, hosts: [], replace: false };
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
    else if (flag === '--from-file') options.fromFile = value(flag, index++);
    else if (flag === '--to-file') options.toFile = value(flag, index++);
    else if (flag === '--host') options.hosts.push(normalizeHost(value(flag, index++)));
    else if (flag === '--replace') options.replace = true;
    else throw new Error(`Unknown argument "${flag}".`);
  }
  if (command === 'export' && !options.toFile) throw new Error('export needs --to-file PATH; the payload is never printed.');
  for (const file of [options.fromFile, options.toFile]) {
    if (file !== undefined && !path.isAbsolute(file)) throw new Error('--from-file and --to-file must be absolute paths.');
  }
  return options;
}

function describeSeed(result) {
  if (result.status === 'no_payload') return `no cookie payload (${result.variable} unset)`;
  if (result.status === 'skipped') return 'seeding skipped (--no-seed)';
  const { marker } = result;
  const skipped = marker.skipped ? `; skipped ${marker.skipped.expired} expired, ${marker.skipped.sessionOnly} session-only` : '';
  return `${result.status.replace('_', ' ')}: ${marker.cookieCount} cookies for ${marker.domains.join(', ')} (${marker.names.join(', ')})${skipped}; digest ${marker.payloadDigest}`;
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
    const root = ensureOwnerOnlyDirectory(resolveProfileRoot({ root: options.root, env }));
    const profile = path.join(root, options.lane);
    if (options.command !== 'export') ensureOwnerOnlyDirectory(profile);
    const label = `chrome-${options.lane}`;
    if (options.command === 'import') {
      const payloadText = options.fromFile === undefined ? undefined : readFileSync(options.fromFile, 'utf8');
      const executable = resolveChromiumExecutable({ executable: options.executable, env, required: true });
      const result = await seedProfile({ lane: options.lane, profile, env, replace: options.replace, payloadText, executable });
      if (result.status === 'no_payload') throw new LaneBrowserError(`No cookie payload: set ${result.variable} or pass --from-file PATH.`);
      stderr.write(`${label}: ${describeSeed(result)}\n`);
      return 0;
    }
    if (options.command === 'export') {
      if (!options.replace && existsSync(options.toFile)) throw new LaneBrowserError(`${options.toFile} exists; pass --replace to overwrite it.`);
      const executable = resolveChromiumExecutable({ executable: options.executable, env, required: true });
      const hosts = [...new Set([...DEFAULT_COOKIE_HOSTS, ...options.hosts])];
      const { text, summary } = await exportCookies({ lane: options.lane, profile, hosts, executable, env });
      writeOwnerOnlyFile(options.toFile, `${text}\n`);
      stderr.write(`${label}: exported ${summary.cookieCount} cookies (${summary.persistent} persistent) for ${summary.domains.join(', ')} ` +
        `(${summary.names.join(', ')}) to ${options.toFile}; ${summary.bytes} base64 bytes; digest ${summary.digest}\n` +
        `Paste the file's content into the cloud environment variable CHICKPEA_LANE_COOKIES_${options.lane.toUpperCase()}, then delete the file.\n`);
      return 0;
    }
    const seed = options.seed ? await seedProfile({
      lane: options.lane, profile, env, executable: resolveChromiumExecutable({ executable: options.executable, env, required: true }),
    }) : { status: 'skipped' };
    const plan = serverPlan({ lane: options.lane, root, env, executable: options.executable, headless: options.headless });
    if (options.dryRun) {
      stdout.write(`${JSON.stringify({ ...plan, seed: seed.status, marker: seed.marker ?? null }, null, 2)}\n`);
      return 0;
    }
    stderr.write(`${label}: profile ${plan.profile}; ${plan.executable ? `executable ${plan.executable}` : 'stable Chrome'}; ` +
      `${plan.headless ? 'headless' : 'windowed'}; ${describeSeed(seed)}\n`);
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
