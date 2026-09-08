#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

import {
  bindLocalLaneSlack,
  createLocalTimingObserver,
  ensureWorktreeDevVarsLink,
  initializeLocalLane,
  localLaneLockPath,
  readLocalLaneManifest,
  relocateUnboundLocalLane,
  renewLocalLaneSetup,
  resolveLocalLanePaths,
  validateLocalLaneName,
  worktreeDevVarsLinkStatus,
} from './lib/local-worker-lane.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(PROJECT_ROOT, 'node_modules', '.bin', 'wrangler');
const VITE = join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');

const [command = 'help', ...rawArgs] = process.argv.slice(2);
let args;

try {
  args = parseArgs(rawArgs);
  if (command === 'init') await init();
  else if (command === 'bind-slack') bindSlack();
  else if (command === 'status') status();
  else if (command === 'renew-setup') await renewSetup();
  else if (command === 'relocate-unbound') await relocateUnbound();
  else if (command === 'setup-link') setupLink();
  else if (command === 'start') await start();
  else if (command === 'schedule') await schedule();
  else if (command === 'help' || command === '--help' || command === '-h') usage(0);
  else throw new Error(`Unknown command ${JSON.stringify(command)}.`);
} catch (error) {
  console.error(`local-worker: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function init() {
  const result = await initializeLocalLane({
    projectRoot: PROJECT_ROOT,
    lane: option('lane'),
    publicUrl: option('public-url'),
    tunnelName: option('tunnel'),
    port: args.get('port') ?? 8787,
  });
  console.log(result.created ? `Initialized local Worker lane ${result.manifest.lane}.` : `Local Worker lane ${result.manifest.lane} was already initialized.`);
  printManifest(result.manifest);
  console.log(`Private setup link: npm run dev:cf -- setup-link --lane ${result.manifest.lane}`);
}

function bindSlack() {
  const lane = option('lane');
  const manifest = bindLocalLaneSlack(PROJECT_ROOT, lane, {
    workspaceId: option('workspace-id'),
    workspaceLabel: option('workspace-label'),
    appId: option('app-id'),
    appLabel: args.get('app-label') ?? 'Chickpea',
  });
  console.log(`Bound ${manifest.lane} to its immutable Slack workspace/app pair.`);
  printManifest(manifest);
}

function status() {
  const manifest = laneManifest();
  const paths = resolveLocalLanePaths(PROJECT_ROOT, manifest.lane);
  const lock = readLock(localLaneLockPath(manifest.publicUrl));
  const live = lock ? pidIsLive(lock.pid) : false;
  const owner = lock ? {
    ...lock,
    live,
    status: live ? 'running' : 'stale-lock',
  } : null;
  printManifest(manifest, owner, worktreeDevVarsLinkStatus(paths));
}

async function renewSetup() {
  const lane = option('lane');
  const result = await renewLocalLaneSetup(PROJECT_ROOT, lane);
  console.log(`Renewed the 24-hour setup capability for ${result.manifest.lane}.`);
  console.log('Restart the local Worker before opening the new private setup link.');
  console.log(`Private setup link: npm run dev:cf -- setup-link --lane ${result.manifest.lane}`);
}

async function relocateUnbound() {
  const result = await relocateUnboundLocalLane(PROJECT_ROOT, option('lane'), {
    publicUrl: option('public-url'),
    tunnelName: args.get('tunnel'),
  });
  console.log(`Relocated unbound local Worker lane ${result.manifest.lane}.`);
  printManifest(result.manifest);
  console.log('Restart the local Worker before opening its rotated private setup link.');
}

function setupLink() {
  const manifest = laneManifest();
  const paths = resolveLocalLanePaths(PROJECT_ROOT, manifest.lane);
  console.log(readFileSync(paths.setupLink, 'utf8').trim());
}

async function start() {
  const manifest = laneManifest();
  const paths = resolveLocalLanePaths(PROJECT_ROOT, manifest.lane);
  ensureWorktreeDevVarsLink(paths);
  const sourceSha = gitValue(['rev-parse', 'HEAD']);
  const dirty = gitValue(['status', '--porcelain']).length > 0;
  const lockPath = localLaneLockPath(manifest.publicUrl);
  acquireLock(lockPath, manifest, sourceSha);
  process.once('exit', () => releaseOwnedLock(lockPath));
  const startedAt = Date.now();

  try {
    console.log('Preparing local AUTH_DB migrations…');
    const { rawConfig } = await experimental_readRawConfig({
      config: join(PROJECT_ROOT, 'wrangler.jsonc'),
    });
    const localConfig = structuredClone(rawConfig);
    const authDb = localConfig.d1_databases?.find((database) => database.binding === 'AUTH_DB');
    if (!authDb) throw new Error('root Cloudflare config does not define AUTH_DB.');
    authDb.database_id = manifest.d1DatabaseId;
    authDb.migrations_dir = resolve(PROJECT_ROOT, authDb.migrations_dir ?? 'migrations');
    writeFileSync(paths.wranglerConfig, `${JSON.stringify(localConfig, null, 2)}\n`, { mode: 0o600 });
    const migration = spawnSync(WRANGLER, [
      'd1', 'migrations', 'apply', 'AUTH_DB', '--local',
      '--persist-to', manifest.statePath,
      '--config', paths.wranglerConfig,
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CI: '1' },
      stdio: 'inherit',
    });
    if (migration.status !== 0) throw new Error(`local AUTH_DB migrations failed (exit ${migration.status}).`);

    console.log('\nLocal Worker identity');
    printManifest(manifest, { pid: process.pid, sourceSha, dirty });
    console.log('Slack delivery uses normal HTTP Events and interactivity through the named tunnel.');
    console.log('Cloudflare dashboard telemetry does not contain this local run; inspect this terminal and local state.\n');

    const child = spawn(VITE, ['dev', '--config', 'vite.config.ts'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CHICKPEA_LOCAL_LANE: manifest.lane,
        CHICKPEA_LOCAL_PUBLIC_URL: manifest.publicUrl,
        CHICKPEA_LOCAL_TUNNEL_NAME: manifest.tunnelName,
        CHICKPEA_LOCAL_STATE_PATH: manifest.statePath,
        CHICKPEA_LOCAL_D1_DATABASE_ID: manifest.d1DatabaseId,
        CHICKPEA_LOCAL_PORT: String(manifest.port),
        CHICKPEA_LOCAL_SOURCE_SHA: sourceSha,
      },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const observeOutput = createLocalTimingObserver(paths.metrics, manifest.lane, sourceSha, startedAt);
    const sourceWatchers = ['src', 'agents', 'skills']
      .map((directory) => join(PROJECT_ROOT, directory))
      .filter(existsSync)
      .map((directory) => watch(directory, { recursive: true }, () => observeOutput.noteSourceChange()));
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      observeOutput(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      observeOutput(chunk);
    });
    const forward = (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));
    const code = await new Promise((resolveExit) => child.once('exit', (exitCode) => resolveExit(exitCode ?? 1)));
    for (const watcher of sourceWatchers) watcher.close();
    appendMetric(paths.metrics, {
      kind: 'session',
      lane: manifest.lane,
      sourceSha,
      dirty,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      exitCode: code,
    });
    process.exitCode = code;
  } finally {
    releaseOwnedLock(lockPath);
  }
}

async function schedule() {
  const manifest = laneManifest();
  const url = new URL('/cdn-cgi/local/scheduled', `http://127.0.0.1:${manifest.port}`);
  url.searchParams.set('cron', '* * * * *');
  const startedAt = Date.now();
  const response = await fetch(url, { method: 'POST' });
  const elapsedMs = Date.now() - startedAt;
  if (!response.ok) throw new Error(`simulated scheduled trigger returned HTTP ${response.status}.`);
  appendMetric(resolveLocalLanePaths(PROJECT_ROOT, manifest.lane).metrics, {
    kind: 'simulated-schedule',
    lane: manifest.lane,
    at: new Date().toISOString(),
    elapsedMs,
  });
  console.log(`Simulated local cron dispatch completed in ${elapsedMs} ms.`);
  console.log('This exercises schedule logic only; it is not deployed due-time delivery evidence.');
}

function laneManifest() {
  return readLocalLaneManifest(PROJECT_ROOT, option('lane'));
}

function printManifest(manifest, lock = null, devVarsLink = undefined) {
  console.log(JSON.stringify({
    lane: manifest.lane,
    runtime: manifest.runtime,
    transport: manifest.transport,
    publicUrl: manifest.publicUrl,
    tunnelName: manifest.tunnelName,
    port: manifest.port,
    owningWorktree: manifest.owningWorktree,
    statePath: manifest.statePath,
    d1DatabaseId: manifest.d1DatabaseId,
    model: manifest.model,
    slack: manifest.slack ?? 'not-bound',
    ...(devVarsLink === undefined ? {} : { devVarsLink }),
    process: lock ?? 'stopped',
  }, null, 2));
}

function acquireLock(lockPath, manifest, sourceSha) {
  if (existsSync(lockPath)) {
    const current = readLock(lockPath);
    if (current && pidIsLive(current.pid)) {
      throw new Error(`local endpoint ${manifest.publicUrl} is already owned by PID ${current.pid} in ${current.owningWorktree}.`);
    }
    unlinkSync(lockPath);
  }
  const fd = openSync(lockPath, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({
      schemaVersion: 'chickpea-local-worker-lock/v1',
      pid: process.pid,
      lane: manifest.lane,
      publicUrl: manifest.publicUrl,
      owningWorktree: PROJECT_ROOT,
      sourceSha,
      worktreeFingerprint: createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 12),
      acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

function releaseOwnedLock(lockPath) {
  const lock = readLock(lockPath);
  if (lock?.pid === process.pid) unlinkSync(lockPath);
}

function readLock(lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    throw new Error(`Local endpoint lock is unreadable: ${lockPath}`);
  }
}

function pidIsLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function appendMetric(file, value) {
  writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'a', mode: 0o600 });
}

function gitValue(gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: PROJECT_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed.`);
  return result.stdout.trim();
}

function option(name) {
  const value = args.get(name);
  if (value === undefined) throw new Error(`--${name} is required.`);
  return value;
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw?.startsWith('--')) throw new Error(`Unexpected argument ${JSON.stringify(raw)}.`);
    const name = raw.slice(2);
    const value = values[index + 1];
    if (!name || !value || value.startsWith('--')) throw new Error(`${raw} requires a value.`);
    if (parsed.has(name)) throw new Error(`${raw} may be provided only once.`);
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}

function usage(exitCode) {
  console.log(`Usage:
  npm run dev:cf -- init --lane local-a --public-url https://HOST --tunnel TUNNEL [--port 8787]
  npm run dev:cf -- bind-slack --lane local-a --workspace-id T... --workspace-label "Chickpea Local A" --app-id A... [--app-label Chickpea]
  npm run dev:cf -- status --lane local-a
  npm run dev:cf -- renew-setup --lane local-a
  npm run dev:cf -- relocate-unbound --lane local-a --public-url https://HOST [--tunnel TUNNEL]
  npm run dev:cf -- setup-link --lane local-a
  npm run dev:cf -- start --lane local-a
  npm run dev:cf -- schedule --lane local-a`);
  process.exit(exitCode);
}
