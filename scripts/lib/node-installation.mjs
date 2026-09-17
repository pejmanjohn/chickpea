import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import {
  mintSetupCapability,
  SETUP_CAPABILITY_CLOCK_SKEW_MS,
  SETUP_CAPABILITY_DIGEST_BINDING,
  SETUP_CAPABILITY_ISSUED_AT_BINDING,
  SETUP_CAPABILITY_TTL_MS,
  setupCapabilityUrl,
} from '../../src/auth/setup-capability.mjs';

export { SETUP_CAPABILITY_TTL_MS };

const HOME_MARKER = 'chickpea-node-v1\n';
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const CONTROL_LIMIT = 4 * 1024;
const SHUTDOWN_TIMEOUT_MS = 80_000;
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const PRIVATE_NODE_PATH_SUFFIX = path.join('tools', 'node', 'bin', 'node');
const INSTALLATION_FILE = 'installation.json';
const RUNTIME_FILE = 'runtime.env';
const SETUP_FILE = 'setup-url.txt';
const INIT_STAGING = '.init-staging';
// This public runtime route exists both before initial ownership and after
// setup completes. `/admin` intentionally returns 503 before authentication
// is configured, so it cannot serve as an installation readiness probe.
const READINESS_PATH = '/admin/setup/client.js';

export function defaultNodeInstallationHome(environment = process.env) {
  return path.join(environment.HOME || homedir(), '.chickpea-node');
}

export async function initInstallation(options) {
  const home = resolveManagedHome(options.home);
  return withOperationLock(home, () => initInstallationUnlocked(options), options);
}

async function initInstallationUnlocked(options) {
  const home = resolveManagedHome(options.home);
  assertMarker(home);
  chmodSync(home, 0o700);
  validateCurrentLink(home, { optional: true });
  const release = validateRelease(home, options.releaseRoot);
  const { installation, stagedTunnelToken } = validateInstallationInput(options, home, release.commit);
  const requested = { installation };
  const installationPath = path.join(home, INSTALLATION_FILE);
  const staging = path.join(home, INIT_STAGING);

  if (await supervisorRunning(home)) {
    throw new Error('Chickpea is running. Stop it before initializing the installation.');
  }

  if (existsSync(installationPath) && !existsSync(staging)) {
    const current = readInstallation(home);
    if (!sameJson(current, installation)) {
      throw new Error('The requested configuration does not match the managed installation.');
    }
    assertCompletedInstallation(home);
    ensurePrivateTree(home);
    return { changed: false, installation: current, sourceCommit: release.commit };
  }

  if (!existsSync(staging)) {
    refuseUnmanagedProductionFiles(home);
    await preparePrivateStage(staging, async (preparing) => {
      const minted = await mintSetupCapability();
      const authSecret = randomBytes(32).toString('base64url');
      writePrivate(path.join(preparing, 'request.json'), `${JSON.stringify(requested, null, 2)}\n`);
      failDuringPreparation(options, 'request.json');
      writePrivate(path.join(preparing, RUNTIME_FILE), runtimeEnvironment({
        home,
        installation,
        authSecret,
        setupDigest: minted.digest,
        setupIssuedAt: minted.issuedAt,
      }));
      failDuringPreparation(options, RUNTIME_FILE);
      writePrivate(path.join(preparing, SETUP_FILE), `${setupCapabilityUrl(installation.origin, minted.capability)}\n`);
      failDuringPreparation(options, SETUP_FILE);
      writePrivate(path.join(preparing, INSTALLATION_FILE), `${JSON.stringify(installation, null, 2)}\n`);
      if (stagedTunnelToken) writePrivate(path.join(preparing, 'tunnel-token.txt'), stagedTunnelToken);
    });
  } else {
    assertPrivateDirectory(staging);
    const staged = readJson(path.join(staging, 'request.json'), 'init transaction');
    if (!sameJson(staged, requested)) {
      throw new Error('The pending init transaction does not match the requested installation.');
    }
  }

  ensurePrivateTree(home);
  ensureControlToken(home);
  const publish = [
    ...(installation.tunnelMode === 'cloudflare' ? ['tunnel-token.txt'] : []),
    RUNTIME_FILE,
    SETUP_FILE,
    INSTALLATION_FILE,
  ];
  for (const relative of publish) {
    publishStagedFile(home, staging, relative);
    if (options.failAfterPublish === relative) {
      throw new Error('simulated init interruption');
    }
  }
  rmSync(staging, { recursive: true, force: true });
  return { changed: true, installation, sourceCommit: release.commit };
}

function validateInstallationInput(options, home, sourceCommit) {
  const origin = validatePublicOrigin(options.origin);
  const port = Number(options.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Port must be an integer from 1 through 65535.');
  }
  const tunnelMode = options.tunnelMode ?? 'external';
  if (!['external', 'cloudflare'].includes(tunnelMode)) {
    throw new Error('--tunnel must be external or cloudflare.');
  }
  const hasToken = options.tunnelTokenFile !== undefined;
  const hasCloudflared = options.cloudflared !== undefined;
  if (tunnelMode === 'cloudflare' && (!hasToken || !hasCloudflared)) {
    throw new Error('Cloudflare tunnel mode requires --tunnel-token-file and --cloudflared.');
  }
  if (tunnelMode === 'external' && (hasToken || hasCloudflared)) {
    throw new Error('Tunnel paths are accepted only with --tunnel cloudflare.');
  }
  const installation = { schemaVersion: 1, sourceCommit, origin, port, tunnelMode };
  let stagedTunnelToken;
  if (hasToken) {
    const sourceToken = validateTunnelToken(options.tunnelTokenFile);
    const tokenFile = path.join(home, 'tunnel-token.txt');
    stagedTunnelToken = readFileSync(sourceToken);
    const cloudflared = validateCloudflared(options.cloudflared);
    installation.tunnel = { mode: 'cloudflare', tokenFile, cloudflared };
  }
  return { installation, stagedTunnelToken };
}

function validatePublicOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Origin must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Origin must be an HTTPS origin without credentials, a path, query, or fragment.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.trycloudflare.com') ||
      privateIpLiteral(hostname)) {
    throw new Error('Origin must use a stable public HTTPS hostname.');
  }
  return url.origin;
}

function privateIpLiteral(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  return hostname === '::' || hostname === '::1' || /^f[cd]/i.test(hostname) || /^fe[89ab]/i.test(hostname);
}

function validateTunnelToken(value) {
  if (!path.isAbsolute(value)) throw new Error('Tunnel token file must be an absolute path.');
  const resolved = realpathRegularFile(value, 'Tunnel token file');
  if ((statSync(resolved).mode & 0o077) !== 0) throw new Error('Tunnel token file must not be readable by group or other users.');
  return resolved;
}

function validateCloudflared(value) {
  if (!path.isAbsolute(value)) throw new Error('cloudflared must be an absolute path.');
  const resolved = realpathRegularFile(value, 'cloudflared');
  try { statSync(resolved); } catch { throw new Error('cloudflared is unavailable.'); }
  try { closeSync(openSync(resolved, fsConstants.O_RDONLY)); } catch { throw new Error('cloudflared is unreadable.'); }
  if ((statSync(resolved).mode & 0o111) === 0) throw new Error('cloudflared must be executable.');
  return resolved;
}

function validateRelease(home, suppliedRoot) {
  if (!suppliedRoot) throw new Error('The installer could not identify its release root.');
  const releaseRoot = realpathSync(suppliedRoot);
  const releases = realpathSync(path.join(home, 'releases'));
  if (path.dirname(releaseRoot) !== releases || !SHA_PATTERN.test(path.basename(releaseRoot))) {
    throw new Error('The runtime manager must execute from HOME/releases/<full SHA>.');
  }
  const sourceFile = path.join(releaseRoot, 'release-source.json');
  if (!existsSync(sourceFile) || lstatSync(sourceFile).isSymbolicLink() || !lstatSync(sourceFile).isFile()) {
    throw new Error('release-source.json must be a real regular file.');
  }
  const source = readJson(sourceFile, 'release source identity');
  if (source?.commit !== path.basename(releaseRoot)) {
    throw new Error('release-source.json does not match the immutable release directory.');
  }
  return { root: releaseRoot, commit: source.commit };
}

function refuseUnmanagedProductionFiles(home) {
  const unmanaged = [INSTALLATION_FILE, RUNTIME_FILE, SETUP_FILE, 'tunnel-token.txt', 'state', 'logs', 'control']
    .filter((relative) => existsSync(path.join(home, relative)));
  if (unmanaged.length > 0) {
    throw new Error(`Found unmanaged installer state: ${unmanaged.join(', ')}.`);
  }
}

function assertCompletedInstallation(home) {
  for (const relative of [RUNTIME_FILE, path.join('control', 'token')]) {
    const file = path.join(home, relative);
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
      throw new Error(`Managed installation is incomplete: ${relative} is missing.`);
    }
  }
  const installation = readInstallation(home);
  const ownership = installationOwnership(home);
  if (!existsSync(path.join(home, SETUP_FILE)) && ownership !== 'active') {
    throw new Error(`Managed installation is incomplete: ${SETUP_FILE} is missing.`);
  }
  if (installation.tunnelMode === 'cloudflare') {
    assertPrivateRegularFile(installation.tunnel.tokenFile, 'tunnel token');
  }
}

function publishStagedFile(home, staging, relative) {
  const source = path.join(staging, relative);
  const destination = path.join(home, relative);
  const bytes = readFileSync(source);
  if (existsSync(destination)) {
    if (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink() ||
        !readFileSync(destination).equals(bytes)) {
      throw new Error(`Existing ${relative} does not match the pending init transaction.`);
    }
    chmodSync(destination, 0o600);
    return;
  }
  atomicPrivateWrite(destination, bytes);
}

function ensurePrivateTree(home) {
  for (const relative of ['state', 'logs', 'control']) mkdirPrivate(path.join(home, relative));
}

function ensureControlToken(home) {
  const file = path.join(home, 'control', 'token');
  if (existsSync(file)) {
    assertPrivateRegularFile(file, 'control token');
    return readFileSync(file, 'utf8').trim();
  }
  const token = randomBytes(32).toString('base64url');
  writePrivate(file, `${token}\n`, { exclusive: true });
  return token;
}

function runtimeEnvironment({ home, installation, authSecret, setupDigest, setupIssuedAt }) {
  const state = path.join(home, 'state');
  const values = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(installation.port),
    TAG_DB_PATH: path.join(state, 'transcripts.sqlite'),
    SLACK_STATE_DB_PATH: path.join(state, 'state.sqlite'),
    CHICKPEA_AUTH_DB_PATH: path.join(state, 'auth.sqlite'),
    CHICKPEA_CREDENTIAL_KEYRING_PATH: path.join(state, 'credential-keyring.json'),
    CHICKPEA_AUTH_SECRET: authSecret,
    [SETUP_CAPABILITY_DIGEST_BINDING]: setupDigest,
    [SETUP_CAPABILITY_ISSUED_AT_BINDING]: String(setupIssuedAt),
    SLACK_TAG_PUBLIC_URL: installation.origin,
    CHICKPEA_INSTALLATION_ID: `node-${createHash('sha256').update(home).digest('hex').slice(0, 20)}`,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`;
}

export function readRuntimeEnvironment(file) {
  return parseEnv(readFileSync(file, 'utf8'));
}

export function readInstallation(homeInput) {
  const home = resolveManagedHome(homeInput);
  const file = path.join(home, INSTALLATION_FILE);
  assertPrivateRegularFile(file, 'installation.json');
  const value = readJson(file, 'installation');
  if (value?.schemaVersion !== 1 || !SHA_PATTERN.test(value.sourceCommit ?? '') || typeof value.origin !== 'string' ||
      !Number.isSafeInteger(value.port)) throw new Error('installation.json is invalid.');
  validatePublicOrigin(value.origin);
  if (value.port < 1 || value.port > 65_535) throw new Error('installation.json has an invalid port.');
  if (!['external', 'cloudflare'].includes(value.tunnelMode)) throw new Error('installation.json has an invalid tunnel mode.');
  if (value.tunnelMode === 'cloudflare' && (value.tunnel?.mode !== 'cloudflare' ||
      typeof value.tunnel.tokenFile !== 'string' || typeof value.tunnel.cloudflared !== 'string')) {
    throw new Error('installation.json has an invalid tunnel configuration.');
  }
  if (value.tunnelMode === 'external' && value.tunnel !== undefined) throw new Error('installation.json has an unexpected tunnel configuration.');
  return value;
}

export function controlledChildEnvironment(privateNodeBin, ambient = process.env) {
  const result = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (typeof ambient[key] === 'string' && ambient[key]) result[key] = ambient[key];
  }
  for (const [key, value] of Object.entries(ambient)) {
    if (/^LC_[A-Z_]+$/.test(key) && typeof value === 'string' && value) result[key] = value;
  }
  result.PATH = `${privateNodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

export async function runStart(homeInput, options = {}) {
  const home = resolveManagedHome(homeInput);
  return withOperationLock(home, () => runStartUnlocked(home, options), options);
}

async function runStartUnlocked(homeInput, options = {}) {
  const home = resolveManagedHome(homeInput);
  assertMarker(home);
  if (existsSync(path.join(home, INIT_STAGING))) throw new Error('Initialization is incomplete. Run init again before starting.');
  if (existsSync(path.join(home, '.setup-renewal'))) throw new Error('Setup renewal is incomplete. Run setup --renew again before starting.');
  const installation = readInstallation(home);
  const release = validateCurrentLink(home);
  const privateNode = realpathRegularFile(path.join(home, PRIVATE_NODE_PATH_SUFFIX), 'Private Node runtime');
  const startScript = path.join(release, 'scripts', 'start-node.mjs');
  if (!existsSync(startScript)) throw new Error('The active release is missing scripts/start-node.mjs.');
  const childEnvironment = controlledChildEnvironment(path.dirname(privateNode));
  const children = [];
  let stopping = false;
  let requestedExitCode = 0;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  let server;
  let appLog;
  let tunnelLog;
  let appReady = false;

  const finishChild = (name, child, code, signal) => {
    if (child.runtimeExit !== undefined) return;
    child.runtimeExit = { code, signal };
    if (!stopping) {
      requestedExitCode = 1;
      process.stderr.write(`[chickpea] ${name} stopped unexpectedly; shutting down.\n`);
      void shutdown();
    }
  };

  const shutdown = async () => {
    if (stopping) return completion;
    stopping = true;
    for (const child of children) {
      if (child.runtimeExit === undefined) child.kill('SIGTERM');
    }
    await Promise.all(children.map((child) => waitForChild(
      child,
      options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS,
      options.forceKillImpl,
    )));
    if (server) await closeServer(server);
    if (appLog !== undefined) closeSync(appLog);
    if (tunnelLog !== undefined) closeSync(tunnelLog);
    resolveCompletion(requestedExitCode);
    return completion;
  };

  server = await createControlServer(home, async (command) => {
    if (command === 'status') return {
      running: true,
      stopping,
      appReady,
      tunnelRunning: Boolean(installation.tunnel && children.find((child) => child.name === 'tunnel')?.runtimeExit === undefined),
    };
    if (command === 'stop') {
      queueMicrotask(() => { void shutdown(); });
      return { accepted: true, stopping: true };
    }
    throw new Error('Unknown control command.');
  });

  const spawnOwned = (name, command, args, logFd) => {
    const detached = process.platform !== 'win32';
    const child = (options.spawnImpl ?? spawn)(command, args, {
      cwd: release,
      detached,
      env: childEnvironment,
      stdio: ['ignore', logFd, logFd],
    });
    child.name = name;
    child.runtimeDetached = detached;
    child.runtimeExit = undefined;
    child.once('error', (error) => {
      process.stderr.write(`[chickpea] ${name} could not start: ${error.message}\n`);
      finishChild(name, child, 1, null);
    });
    child.once('exit', (code, signal) => finishChild(name, child, code, signal));
    children.push(child);
    return child;
  };

  let app;
  try {
    appLog = openPrivateAppend(path.join(home, 'logs', 'app.log'));
    tunnelLog = installation.tunnel ? openPrivateAppend(path.join(home, 'logs', 'tunnel.log')) : undefined;
    app = spawnOwned('application', privateNode, [startScript, '--env-file', path.join(home, RUNTIME_FILE)], appLog);
    if (installation.tunnel) {
      spawnOwned('tunnel', installation.tunnel.cloudflared, [
        'tunnel', '--no-autoupdate', 'run', '--token-file', installation.tunnel.tokenFile,
      ], tunnelLog);
    }
  } catch (error) {
    requestedExitCode = 1;
    await shutdown();
    throw error;
  }

  const signalHandlers = new Map();
  if (options.installSignalHandlers !== false) {
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
      const handler = () => {
        if (!stopping) requestedExitCode = exitCode;
        void shutdown();
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  try {
    await waitForReadiness(installation.port, app, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    });
    appReady = true;
    process.stdout.write(`[chickpea] Running locally at http://127.0.0.1:${installation.port}. This does not verify Slack delivery.\n`);
    if (options.open) {
      try { await openSetup(home, { openImpl: options.openImpl }); }
      catch (error) {
        process.stderr.write(`[chickpea] Setup was not opened: ${error instanceof Error ? error.message : String(error)} Chickpea is still running.\n`);
      }
    }
    return await completion;
  } catch (error) {
    if (stopping) return await completion;
    process.stderr.write(`[chickpea] Startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    requestedExitCode = 1;
    await shutdown();
    return 1;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

async function waitForReadiness(port, child, options) {
  const deadline = Date.now() + options.timeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;
  while (Date.now() < deadline) {
    if (child.runtimeExit !== undefined) throw new Error('The application exited before it became ready.');
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}${READINESS_PATH}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1_000),
      });
      if (httpReachableStatus(response.status)) return;
    } catch { /* retry bounded local readiness only */ }
    await delay(100);
  }
  throw new Error('The application did not become reachable before the startup deadline.');
}

async function waitForChild(child, timeoutMs, forceKillImpl = process.kill.bind(process)) {
  if (child.runtimeExit !== undefined) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let timeout;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(true), timeoutMs);
    timeout.unref();
  });
  const timedOut = await Promise.race([exited.then(() => false), deadline]);
  clearTimeout(timeout);
  if (timedOut && child.runtimeExit === undefined) {
    if (child.runtimeDetached && process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 1) {
      try { forceKillImpl(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    } else {
      child.kill('SIGKILL');
    }
    await exited;
  }
}

export async function sendControlCommand(homeInput, command, options = {}) {
  const home = resolveManagedHome(homeInput);
  const socket = options.socketPath ?? controlSocketPath(home);
  const endpoint = validateControlEndpoint(socket);
  if (!endpoint) return { running: false, accepted: false };
  const tokenFile = path.join(home, 'control', 'token');
  if (!existsSync(tokenFile)) return { running: false, accepted: false };
  assertPrivateRegularFile(tokenFile, 'Control token');
  const token = readFileSync(tokenFile, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const client = createConnection(socket);
    let response = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('The Chickpea control socket timed out.'));
    }, options.timeoutMs ?? 2_000);
    timer.unref();
    client.setEncoding('utf8');
    client.once('connect', () => client.end(`${JSON.stringify({ token, command })}\n`));
    client.on('data', (chunk) => { response += chunk; });
    client.once('error', (error) => {
      clearTimeout(timer);
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve({ running: false, accepted: false });
      else reject(error);
    });
    client.once('end', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(response);
        if (!parsed.ok) reject(new Error(parsed.error || 'Control command failed.'));
        else resolve(parsed.result);
      } catch (error) { reject(error); }
    });
  });
}

function validateControlEndpoint(socket) {
  const directory = path.dirname(socket);
  const directoryInfo = lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryInfo) return false;
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Control socket directory ${directory} must be a private real directory.`);
  }
  if (typeof process.getuid === 'function' && directoryInfo.uid !== process.getuid()) {
    throw new Error(`Control socket directory ${directory} is owned by another user.`);
  }
  if ((directoryInfo.mode & 0o077) !== 0) {
    throw new Error(`Control socket directory ${directory} must not be accessible by other users.`);
  }
  const socketInfo = lstatSync(socket, { throwIfNoEntry: false });
  if (!socketInfo) return false;
  if (!socketInfo.isSocket() || socketInfo.isSymbolicLink()) {
    throw new Error(`Control socket ${socket} must be a Unix socket.`);
  }
  if (typeof process.getuid === 'function' && socketInfo.uid !== process.getuid()) {
    throw new Error(`Control socket ${socket} is owned by another user.`);
  }
  if ((socketInfo.mode & 0o077) !== 0) {
    throw new Error(`Control socket ${socket} must not be accessible by other users.`);
  }
  return true;
}

async function createControlServer(home, handle) {
  const socket = controlSocketPath(home);
  mkdirPrivate(path.dirname(socket));
  try {
    const active = await sendControlCommand(home, 'status', { timeoutMs: 400 });
    if (active.running) throw new Error('Chickpea is already running for this installer home.');
    if (existsSync(socket)) {
      if (!lstatSync(socket).isSocket()) throw new Error('The control socket path is occupied by an unexpected file.');
      const stale = `${socket}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
      try {
        renameSync(socket, stale);
        unlinkSync(stale);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    throw new Error(`Existing Chickpea control socket is not safely reclaimable: ${error.message}`, { cause: error });
  }
  const expectedToken = readFileSync(path.join(home, 'control', 'token'), 'utf8').trim();
  const server = createServer({ allowHalfOpen: true }, (connection) => {
    connection.setEncoding('utf8');
    let input = '';
    connection.on('data', (chunk) => {
      input += chunk;
      if (input.length > CONTROL_LIMIT) connection.destroy();
    });
    connection.on('end', async () => {
      try {
        const request = JSON.parse(input);
        if (!safeTokenEquals(request.token, expectedToken)) throw new Error('Control authentication failed.');
        const result = await handle(request.command);
        connection.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        connection.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.off('error', reject);
      chmodSync(socket, 0o600);
      resolve();
    });
  });
  return server;
}

function safeTokenEquals(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function controlSocketPath(homeInput) {
  const home = path.resolve(homeInput);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const digest = createHash('sha256').update(home).digest('hex').slice(0, 32);
  return path.join('/tmp', `chickpea-node-${uid}`, `${digest}.sock`);
}

export async function stopInstallation(homeInput) {
  const home = resolveManagedHome(homeInput);
  const response = await sendControlCommand(home, 'stop');
  const service = launchAgentState(home);
  if (response.accepted) {
    const deadline = Date.now() + 85_000;
    while (Date.now() < deadline && (await sendControlCommand(home, 'status')).running) await delay(100);
  }
  if (service.loaded) bootoutLaunchAgent(service);
  return { stopped: Boolean(response.accepted), serviceUnloaded: service.loaded, serviceInstalled: service.installed };
}

export async function installationStatus(homeInput, options = {}) {
  const home = resolveManagedHome(homeInput);
  const installation = readInstallation(home);
  const current = validateCurrentLink(home);
  let installedVersion = 'unknown';
  try { installedVersion = String(readJson(path.join(current, 'package.json'), 'release package').version ?? 'unknown'); }
  catch { /* Status remains useful for a damaged release. */ }
  const managed = await sendControlCommand(home, 'status');
  const localUrl = `http://127.0.0.1:${installation.port}${READINESS_PATH}`;
  const localReachable = await httpReachable(localUrl, options.fetchImpl);
  const publicReachable = await httpReachable(new URL(READINESS_PATH, installation.origin).href, options.fetchImpl);
  const service = launchAgentState(home);
  return {
    home,
    installedVersion,
    sourceCommit: installation.sourceCommit,
    managedProcess: Boolean(managed.running),
    appReady: Boolean(managed.appReady),
    localReachable,
    publicReachable,
    tunnelConfigured: Boolean(installation.tunnel),
    tunnelRunning: Boolean(managed.tunnelRunning),
    launchAgentInstalled: service.installed,
    launchAgentLoaded: service.loaded,
    slackVerified: false,
  };
}

async function httpReachable(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
    return httpReachableStatus(response.status);
  } catch { return false; }
}

function httpReachableStatus(status) {
  // Account recovery deliberately hides the setup asset with 404. Keep the
  // server available; this probe does not establish setup or authentication health.
  return status === 200 || status === 404;
}

export async function openSetup(homeInput, options = {}) {
  const home = resolveManagedHome(homeInput);
  if (existsSync(path.join(home, '.setup-renewal'))) {
    throw new Error('Setup renewal is incomplete. Run setup --renew before opening setup.');
  }
  const installation = readInstallation(home);
  let url;
  const ownership = installationOwnership(home);
  if (ownership === 'active') {
    rmSync(path.join(home, SETUP_FILE), { force: true });
    url = new URL('/admin', installation.origin).href;
  } else {
    if (ownership === 'reserved') {
      throw new Error('Initial ownership setup is already in progress. Start Chickpea and finish the existing setup instead of renewing it.');
    }
    const env = readRuntimeEnvironment(path.join(home, RUNTIME_FILE));
    const issuedAt = Number(env[SETUP_CAPABILITY_ISSUED_AT_BINDING]);
    const now = options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt - now > SETUP_CAPABILITY_CLOCK_SKEW_MS ||
        now - issuedAt >= SETUP_CAPABILITY_TTL_MS) {
      throw new Error('The setup link expired. Stop Chickpea, run `chickpea-node setup --renew`, then run setup again.');
    }
    url = readFileSync(path.join(home, SETUP_FILE), 'utf8').trim();
  }
  await (options.openImpl ?? openUrl)(url);
  return { opened: true, destination: ownership === 'active' ? 'admin' : 'setup' };
}

export async function renewSetup(homeInput, options = {}) {
  const home = resolveManagedHome(homeInput);
  return withOperationLock(home, () => renewSetupUnlocked(home, options), options);
}

async function renewSetupUnlocked(home, options) {
  if ((await sendControlCommand(home, 'status')).running) {
    throw new Error('Stop Chickpea before renewing the setup link.');
  }
  const ownership = installationOwnership(home);
  if (ownership === 'active') throw new Error('This installation already has an owner; setup renewal is refused.');
  if (ownership === 'reserved') throw new Error('Initial ownership setup is already in progress; setup renewal is refused.');
  const installation = readInstallation(home);
  const stage = path.join(home, '.setup-renewal');
  if (!existsSync(stage)) {
    await preparePrivateStage(stage, async (preparing) => {
      const minted = await mintSetupCapability({ now: options.now });
      const current = readFileSync(path.join(home, RUNTIME_FILE), 'utf8');
      const updated = replaceEnvironmentValues(current, {
        [SETUP_CAPABILITY_DIGEST_BINDING]: minted.digest,
        [SETUP_CAPABILITY_ISSUED_AT_BINDING]: String(minted.issuedAt),
      });
      writePrivate(path.join(preparing, RUNTIME_FILE), updated);
      failDuringPreparation(options, RUNTIME_FILE);
      writePrivate(path.join(preparing, SETUP_FILE), `${setupCapabilityUrl(installation.origin, minted.capability)}\n`);
    });
  } else {
    assertPrivateDirectory(stage);
  }
  for (const relative of [RUNTIME_FILE, SETUP_FILE]) {
    atomicPrivateWrite(path.join(home, relative), readFileSync(path.join(stage, relative)));
    if (options.failAfterPublish === relative) throw new Error('simulated setup renewal interruption');
  }
  rmSync(stage, { recursive: true, force: true });
  return { renewed: true };
}

async function withOperationLock(home, operation, options = {}) {
  const release = await acquireOperationLock(home, options);
  try { return await operation(); }
  finally { await release(); }
}

async function preparePrivateStage(stage, writer) {
  const preparing = `${stage}.prepare`;
  if (existsSync(preparing)) {
    assertPrivateDirectory(preparing);
    rmSync(preparing, { recursive: true, force: true });
  }
  mkdirPrivate(preparing);
  await writer(preparing);
  renameSync(preparing, stage);
}

function failDuringPreparation(options, relative) {
  if (options.failDuringPreparationAfter === relative) {
    throw new Error('simulated staging preparation interruption');
  }
}

export function currentBootSessionIdentity(options = {}) {
  if (options.bootIdentity !== undefined) {
    if (typeof options.bootIdentity !== 'string' || !options.bootIdentity.trim()) {
      throw new Error('Injected boot session identity must be a non-empty string.');
    }
    return options.bootIdentity.trim();
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' });
    const identity = result.status === 0 ? result.stdout.trim() : '';
    if (identity) return identity;
  } else if (process.platform === 'linux') {
    try {
      const identity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (identity) return identity;
    } catch { /* Fail closed below. */ }
  }
  throw new Error('Cannot determine the operating system boot session identity; runtime coordination is unavailable.');
}

export function runtimeOperationLockPath(homeInput, bootIdentity) {
  const digest = createHash('sha256').update(bootIdentity).digest('hex').slice(0, 24);
  return path.join(path.resolve(homeInput), `.runtime-operation-lock-${digest}`);
}

export class UnsafeRuntimeOperationLockError extends Error {
  constructor(lock, owner) {
    const ownerPath = path.join(lock, 'owner.json');
    super(`Another Chickpea runtime operation is active in this boot session, or a prior process stopped unexpectedly. Lock: ${lock}. Owner metadata: ${owner}. Inspect ${ownerPath} and running child processes; remove only ${lock} after confirming nothing is running.`);
    this.name = 'UnsafeRuntimeOperationLockError';
    this.code = 'CHICKPEA_UNSAFE_RUNTIME_LOCK';
    this.lockPath = lock;
  }
}

async function acquireOperationLock(home, options = {}) {
  const bootIdentity = currentBootSessionIdentity(options);
  const lock = runtimeOperationLockPath(home, bootIdentity);
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      let owner = 'unreadable';
      try {
        assertPrivateDirectory(lock);
        const ownerPath = path.join(lock, 'owner.json');
        assertPrivateRegularFile(ownerPath, 'Runtime operation owner metadata');
        const parsed = JSON.parse(readFileSync(ownerPath, 'utf8'));
        owner = JSON.stringify({ pid: parsed.pid, startedAt: parsed.startedAt, bootSessionIdentity: parsed.bootSessionIdentity });
      } catch { /* The refusal remains conservative when metadata is damaged. */ }
      throw new UnsafeRuntimeOperationLockError(lock, owner);
    }
    throw error;
  }
  try {
    writePrivate(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), bootSessionIdentity: bootIdentity })}\n`);
  } catch (error) {
    rmSync(lock, { recursive: true, force: true });
    throw error;
  }
  return async () => { rmSync(lock, { recursive: true, force: true }); };
}

function replaceEnvironmentValues(source, replacements) {
  const remaining = new Map(Object.entries(replacements));
  const lines = source.trimEnd().split('\n').map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${JSON.stringify(value)}`;
  });
  for (const [key, value] of remaining) lines.push(`${key}=${JSON.stringify(value)}`);
  return `${lines.join('\n')}\n`;
}

function installationOwnership(home) {
  const statePath = path.join(home, 'state', 'state.sqlite');
  if (!existsSync(statePath)) return 'none';
  let database;
  try {
    database = new DatabaseSync(statePath, { readOnly: true });
    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('identity_owner_claims','identity_auth_controls')",
    ).all().map((row) => String(row.name)));
    if (tables.has('identity_auth_controls')) {
      const active = database.prepare("SELECT 1 AS present FROM identity_auth_controls WHERE auth_mode='slack_active' LIMIT 1").get();
      if (active) return 'active';
    }
    if (!tables.has('identity_owner_claims')) return 'none';
    const claim = database.prepare("SELECT status FROM identity_owner_claims WHERE claim_key='first_owner' LIMIT 1").get();
    if (claim?.status === 'active') return 'active';
    if (claim?.status === 'reserved') return 'reserved';
    return 'none';
  } catch (error) {
    throw new Error(`Cannot safely inspect installation ownership: ${error.message}`, { cause: error });
  }
  finally { database?.close(); }
}

async function openUrl(url) {
  const command = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  await new Promise((resolve, reject) => {
    const child = spawn(command, [url], { stdio: 'ignore', env: controlledChildEnvironment('/usr/bin') });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Browser opener did not exit within 10 seconds.'));
    }, 10_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Browser opener failed: ${error.message}`, { cause: error }));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Browser opener exited ${signal ? `with ${signal}` : `with status ${code}`}.`));
    });
  });
}

export function launchAgentIdentity(homeInput) {
  return `co.chickpea.node.${createHash('sha256').update(path.resolve(homeInput)).digest('hex').slice(0, 24)}`;
}

export function renderLaunchAgentPlist({ home, node, label }) {
  const manager = path.join(home, 'current', 'scripts', 'chickpea-node.mjs');
  const environment = controlledChildEnvironment(path.dirname(node), {
    HOME: home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR || tmpdir(),
    LANG: process.env.LANG || 'en_US.UTF-8',
  });
  const args = [node, manager, '--home', home, 'start', '--service'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
  <key>StandardOutPath</key><string>${xml(path.join(home, 'logs', 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(home, 'logs', 'service.log'))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>90</integer>
  <key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

export async function installLaunchAgent(homeInput) {
  requireMacOsService();
  const home = resolveManagedHome(homeInput);
  if (await supervisorRunning(home)) throw new Error('Stop the foreground Chickpea process before installing the service.');
  const release = validateCurrentLink(home);
  void release;
  const node = realpathRegularFile(path.join(home, PRIVATE_NODE_PATH_SUFFIX), 'Private Node runtime');
  const label = launchAgentIdentity(home);
  const directory = path.join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const plistPath = path.join(directory, `${label}.plist`);
  const plist = renderLaunchAgentPlist({ home, node, label });
  if (existsSync(plistPath) && readFileSync(plistPath, 'utf8') !== plist) {
    throw new Error(`LaunchAgent ${label} already exists with different contents.`);
  }
  if (!existsSync(plistPath)) atomicPrivateWrite(plistPath, plist);
  const state = launchAgentState(home);
  if (state.loaded) runLaunchctl(['kickstart', state.domain]);
  else runLaunchctl(['bootstrap', `gui/${process.getuid()}`, plistPath]);
  return { label, plistPath };
}

export function uninstallLaunchAgent(homeInput) {
  requireMacOsService();
  const home = resolveManagedHome(homeInput);
  const state = launchAgentState(home);
  if (state.loaded) bootoutLaunchAgent(state);
  rmSync(state.plistPath, { force: true });
  return { removed: state.installed, label: state.label };
}

function launchAgentState(home) {
  const label = launchAgentIdentity(home);
  const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (process.platform !== 'darwin') return { label, plistPath, installed: existsSync(plistPath), loaded: false };
  const domain = `gui/${process.getuid()}/${label}`;
  const loaded = spawnSync('/bin/launchctl', ['print', domain], { stdio: 'ignore' }).status === 0;
  return { label, plistPath, domain, installed: existsSync(plistPath), loaded };
}

function bootoutLaunchAgent(state) {
  const result = spawnSync('/bin/launchctl', ['bootout', state.domain], { encoding: 'utf8' });
  if (result.status !== 0 && state.loaded) throw new Error('launchctl could not unload the Chickpea service.');
}

function runLaunchctl(args) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`launchctl failed: ${(result.stderr || result.stdout || '').trim()}`);
}

function requireMacOsService() {
  if (process.platform !== 'darwin') throw new Error('Service installation is supported on macOS only.');
}

function validateCurrentLink(home, options = {}) {
  const current = path.join(home, 'current');
  const link = lstatSync(current, { throwIfNoEntry: false });
  if (!link) {
    if (options.optional) return undefined;
    throw new Error('The installation has no active release.');
  }
  if (!link.isSymbolicLink()) throw new Error('current must be a symlink to a managed release.');
  const resolved = realpathSync(current);
  const releases = realpathSync(path.join(home, 'releases'));
  if (path.dirname(resolved) !== releases || !SHA_PATTERN.test(path.basename(resolved))) {
    throw new Error('current must point to a managed release under HOME/releases.');
  }
  validateRelease(home, resolved);
  return resolved;
}

function resolveManagedHome(homeInput) {
  if (!homeInput) throw new Error('--home is required.');
  const resolved = path.resolve(homeInput);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory() || lstatSync(resolved).isSymbolicLink()) {
    throw new Error('Installer home must be an existing real directory.');
  }
  return realpathSync(resolved);
}

function assertMarker(home) {
  const marker = path.join(home, '.installer-home');
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || !lstatSync(marker).isFile() ||
      readFileSync(marker, 'utf8') !== HOME_MARKER) {
    throw new Error('Installer home is missing the chickpea-node-v1 ownership marker.');
  }
}

function assertPrivateDirectory(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`${directory} must be a private real directory.`);
  }
}

function assertPrivateRegularFile(file, label) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private regular file.`);
  }
}

function realpathRegularFile(file, label) {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
    throw new Error(`${label} must be a real regular file.`);
  }
  return realpathSync(file);
}

function mkdirPrivate(directory) {
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${directory} must be a real directory.`);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`${directory} is owned by another user.`);
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  chmodSync(directory, 0o700);
}

function writePrivate(file, contents, options = {}) {
  writeFileSync(file, contents, { mode: 0o600, flag: options.exclusive ? 'wx' : 'w' });
  chmodSync(file, 0o600);
}

function atomicPrivateWrite(file, contents) {
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${file} must be a real regular file.`);
  }
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writePrivate(temporary, contents, { exclusive: true });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function openPrivateAppend(file) {
  mkdirPrivate(path.dirname(file));
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${file} must be a real log file.`);
  }
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(file, flags, 0o600);
  chmodSync(file, 0o600);
  return descriptor;
}

function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${label}: ${error.message}`, { cause: error }); }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function supervisorRunning(home) {
  try { return Boolean((await sendControlCommand(home, 'status', { timeoutMs: 400 })).running); }
  catch { return false; }
}
