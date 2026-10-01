/**
 * Lane browsers. One persistent Chromium profile per QA lane lives under an
 * owner-only root outside the repository and runs as a daemon on a fixed local
 * debugging port; `scripts/lane-browser.mjs` starts it, attaches
 * `chrome-devtools-mcp` to it with the flags qa/live/operator/hosts.md
 * requires, and, in a cloud session, first seeds a fresh profile from a cookie
 * payload the maintainer exported from a signed-in lane profile.
 *
 * Cookie values travel only from the payload to Chromium over the DevTools
 * pipe. They never reach argv, a child environment, stdout, stderr, the seed
 * marker, or an error message: validation failures name a cookie position and
 * field, and readback checks compare names and domains.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { homedir, platform as hostPlatform, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isQaLane, QA_LANES } from './qa-lanes.mjs';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT_VARIABLE = 'CHICKPEA_LANE_CHROME_ROOT';
export const EXECUTABLE_VARIABLE = 'CHICKPEA_LANE_CHROME_EXECUTABLE';
export const HEADLESS_VARIABLE = 'CHICKPEA_LANE_CHROME_HEADLESS';
export const SERVER_VARIABLE = 'CHICKPEA_LANE_CHROME_SERVER';
export const DEFAULT_SERVER_SPEC = 'chrome-devtools-mcp@1.10.1';
export const DEFAULT_LINUX_EXECUTABLE = '/opt/pw-browsers/chromium';
export const DEFAULT_DARWIN_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const COOKIE_PAYLOAD_SCHEMA = 'chickpea-lane-cookies/v1';
export const SEED_MARKER_SCHEMA = 'chickpea-lane-seed/v1';
export const SEED_MARKER_FILE = 'chickpea-lane-seed.json';
export const DEFAULT_COOKIE_HOSTS = Object.freeze(['slack.com']);
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_COOKIES = 500;
const COOKIE_VARIABLE_PATTERN = /^CHICKPEA_LANE_COOKIES_/;
const HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
const CDP_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 10_000;

export class LaneBrowserError extends Error {}

export function cookieVariable(lane) {
  return `CHICKPEA_LANE_COOKIES_${assertLane(lane).toUpperCase()}`;
}

export function assertLane(lane) {
  if (!isQaLane(lane)) throw new LaneBrowserError(`Choose a lane: ${QA_LANES.join(', ')}.`);
  return lane;
}

/** What a browser or server child inherits: every cookie payload variable is removed. */
export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !COOKIE_VARIABLE_PATTERN.test(name)));
}

/**
 * The opt-in profile root: `--root`, else the environment variable. It must be
 * absolute (a leading `~/` expands) and outside the repository, so a profile
 * can never be committed.
 */
export function resolveProfileRoot({ root, env = process.env, home = homedir(), repositoryRoot = REPOSITORY_ROOT } = {}) {
  const raw = (root ?? env[ROOT_VARIABLE] ?? '').trim();
  if (!raw) {
    throw new LaneBrowserError(`${ROOT_VARIABLE} is not set. Lane browsers are opt-in: point it at an owner-only directory ` +
      'outside the repository (for example ~/.chickpea/browsers) or pass --root.');
  }
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw new LaneBrowserError(`${ROOT_VARIABLE} must be an absolute path, not ${raw}.`);
  const resolved = path.resolve(expanded);
  const candidates = new Set([resolved, existsSync(resolved) ? realpathSync(resolved) : resolved]);
  const repositories = new Set([repositoryRoot, existsSync(repositoryRoot) ? realpathSync(repositoryRoot) : repositoryRoot]);
  for (const candidate of candidates) {
    for (const repository of repositories) {
      if (candidate === repository || candidate.startsWith(`${repository}${path.sep}`)) {
        throw new LaneBrowserError(`The lane browser root must be outside the repository: ${resolved}`);
      }
    }
  }
  return resolved;
}

export function ensureOwnerOnlyDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = statSync(directory);
  if (!stat.isDirectory()) throw new LaneBrowserError(`${directory} is not a directory.`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) chmodSync(directory, 0o700);
  return directory;
}

/** Create-or-replace an owner-only file; the temporary is exclusive so no other file mode ever applies. */
export function writeOwnerOnlyFile(file, text, { replace = true } = {}) {
  if (!replace && existsSync(file)) throw new LaneBrowserError(`${file} exists; pass --replace to overwrite it.`);
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(descriptor, text);
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(descriptor);
  renameSync(temporary, file);
  return file;
}

const EXECUTABLE_LAYOUTS = [
  'chrome-linux/chrome',
  'chrome-linux64/chrome',
  'chrome',
  'Contents/MacOS/Google Chrome',
  'Contents/MacOS/Google Chrome for Testing',
  'Contents/MacOS/Chromium',
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
];

/**
 * The Chromium binary: `--executable`, else the environment variable, else the
 * platform default. A directory is searched in Playwright's layouts, including
 * a browsers root holding `chromium-<build>` directories (newest first) and a
 * macOS `.app` bundle. Without any setting on macOS, `required` picks stable
 * Chrome for a direct launch and `undefined` lets chrome-devtools-mcp find it.
 */
export function resolveChromiumExecutable({ executable, env = process.env, platform = hostPlatform(), required = false } = {}) {
  const configured = (executable ?? env[EXECUTABLE_VARIABLE] ?? '').trim();
  const candidate = configured || (platform === 'linux' ? DEFAULT_LINUX_EXECUTABLE : platform === 'darwin' && required ? DEFAULT_DARWIN_EXECUTABLE : '');
  if (!candidate) return undefined;
  if (!existsSync(candidate)) {
    throw new LaneBrowserError(`No Chromium at ${candidate}. Set ${EXECUTABLE_VARIABLE} or pass --executable.`);
  }
  if (!statSync(candidate).isDirectory()) return candidate;
  const builds = readdirSync(candidate)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((left, right) => Number(right.slice('chromium-'.length)) - Number(left.slice('chromium-'.length)))
    .map((name) => path.join(candidate, name));
  for (const root of [candidate, ...builds]) {
    for (const layout of EXECUTABLE_LAYOUTS) {
      const file = path.join(root, layout);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
  }
  throw new LaneBrowserError(`${candidate} holds no Chromium binary in a known Playwright or .app layout; point ${EXECUTABLE_VARIABLE} at the binary.`);
}

/** Headless unless the variable says otherwise; Linux without a display defaults to headless. */
export function headlessDefault({ env = process.env, platform = hostPlatform() } = {}) {
  const setting = (env[HEADLESS_VARIABLE] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(setting)) return true;
  if (['0', 'false', 'no', 'off'].includes(setting)) return false;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * How to run chrome-devtools-mcp: an absolute path in the variable is a
 * checked-out entry point, a package spec goes through npx, and with nothing
 * set a copy installed in the repository's node_modules wins over npx.
 */
export function serverCommand({ env = process.env, repositoryRoot = REPOSITORY_ROOT, execPath = process.execPath } = {}) {
  const spec = (env[SERVER_VARIABLE] ?? '').trim();
  if (spec && path.isAbsolute(spec)) return { command: execPath, args: [spec] };
  const local = path.join(repositoryRoot, 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
  if (!spec && existsSync(local)) return { command: execPath, args: [local] };
  return { command: 'npx', args: ['-y', spec || DEFAULT_SERVER_SPEC] };
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** Chromium flags every lane launch carries; root on Linux cannot use the SUID sandbox. */
export function chromiumArguments({ platform = hostPlatform(), uid = currentUid() } = {}) {
  return [
    '--hide-crash-restore-bubble',
    '--no-first-run',
    ...(platform === 'linux' ? ['--disable-dev-shm-usage', ...(uid === 0 ? ['--no-sandbox'] : [])] : []),
  ];
}

/**
 * Cookie encryption must agree between every launch of a profile. macOS lane
 * profiles use the keychain (hosts.md); Linux keeps Puppeteer's basic store,
 * the only one there, so a profile seeded by one launch decrypts in the next.
 */
export function keychainLaunchArguments(platform = hostPlatform()) {
  return platform === 'darwin' ? [] : ['--password-store=basic', '--use-mock-keychain'];
}

/** A direct headless launch of one lane profile, for seeding and export. */
export function profileLaunchArguments({ profile, platform = hostPlatform(), uid = currentUid() }) {
  return [
    '--headless',
    `--user-data-dir=${profile}`,
    '--no-default-browser-check',
    ...chromiumArguments({ platform, uid }),
    ...keychainLaunchArguments(platform),
    'about:blank',
  ];
}

/*
 * Lane browser daemons. On a maintainer's Mac each lane's Chrome runs as one
 * long-lived process on a fixed local debugging port, and every session's
 * `chrome-<lane>` server attaches to it with `--browserUrl`. Nothing holds
 * the profile lock on a session's behalf, so two sessions can drive the same
 * lane (in their own tabs) and a finished session leaves nothing to quit.
 */
export const DAEMON_PORTS = Object.freeze({ amber: 9331, cobalt: 9332, violet: 9333 });
/** Private evidence folders under the root's parent that a lane server may write screenshots and snapshots into. */
export const EVIDENCE_DIRECTORIES = Object.freeze(['verification', 'qa-runs', 'reviews']);
const DAEMON_RECORD_SCHEMA = 'chickpea-lane-daemon/v1';
const PORT_VARIABLE_PREFIX = 'CHICKPEA_LANE_CHROME_PORT_';
const DAEMON_START_TIMEOUT_MS = 20_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
const DAEMON_POLL_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lane's debugging port: `CHICKPEA_LANE_CHROME_PORT_<LANE>` overrides the fixed table. */
export function daemonPort(lane, env = process.env) {
  assertLane(lane);
  const variable = `${PORT_VARIABLE_PREFIX}${lane.toUpperCase()}`;
  const raw = (env[variable] ?? '').trim();
  if (!raw) return DAEMON_PORTS[lane];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new LaneBrowserError(`${variable} must be a port between 1024 and 65535, not ${raw}.`);
  return port;
}

const daemonUrl = (port) => `http://127.0.0.1:${port}`;

export function daemonRecordPath(root, lane) {
  return path.join(root, `${assertLane(lane)}.daemon.json`);
}

export function daemonLogPath(root, lane) {
  return path.join(root, `${assertLane(lane)}.daemon.log`);
}

function readDaemonRecord(root, lane) {
  const file = daemonRecordPath(root, lane);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record?.schemaVersion === DAEMON_RECORD_SCHEMA && Number.isInteger(record.pid) ? record : null;
  } catch {
    return null;
  }
}

/** Chrome's own launch arguments for a lane daemon (windowed unless headless); the keychain rule matches `profileLaunchArguments`. */
export function daemonLaunchArguments({ profile, port, headless = false, platform = hostPlatform(), uid = currentUid() }) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-default-browser-check',
    '--window-size=1440,900',
    ...(headless ? ['--headless'] : []),
    ...chromiumArguments({ platform, uid }),
    ...keychainLaunchArguments(platform),
    'about:blank',
  ];
}

/**
 * Where a lane server may write files: the private evidence folders beside
 * the profile root (never the root's parent itself, which holds the lane
 * secrets and exported cookie payloads), the temp directories, and extras.
 */
export function evidenceWorkspaces({ root, workspaces = [], platform = hostPlatform(), temp = tmpdir() }) {
  const parent = path.dirname(root);
  return [...new Set([
    ...EVIDENCE_DIRECTORIES.map((name) => path.join(parent, name)), temp, ...(platform === 'darwin' ? ['/private/tmp'] : []), ...workspaces,
  ])];
}

/** The chrome-devtools-mcp invocation that attaches to a running lane daemon; this is what the host MCP entries run. */
export function attachPlan({
  lane, root, env = process.env, platform = hostPlatform(), workspaces = [], repositoryRoot = REPOSITORY_ROOT, execPath = process.execPath,
} = {}) {
  assertLane(lane);
  const port = daemonPort(lane, env);
  const server = serverCommand({ env, repositoryRoot, execPath });
  return {
    lane,
    port,
    url: daemonUrl(port),
    profile: path.join(root, lane),
    command: server.command,
    args: [
      ...server.args,
      '--browserUrl', daemonUrl(port),
      ...evidenceWorkspaces({ root, workspaces, platform }).flatMap((workspace) => ['--workspace', workspace]),
      '--screenshotFormat', 'jpeg',
      '--screenshotMaxWidth', '1400',
      '--redactNetworkHeaders',
      '--no-usage-statistics',
    ],
  };
}

/** `/json/version` of a running Chrome on the port, or null when nothing answers. */
async function fetchDaemonVersion(port, { fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${daemonUrl(port)}/json/version`, { signal: controller.signal });
    if (!response.ok) return null;
    const version = await response.json();
    return typeof version?.Browser === 'string' ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function processCommand(pid) {
  if (process.platform === 'win32' || !processAlive(pid)) return '';
  const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout).trim() : '';
}

/** True when a command line launched Chrome on exactly this profile (not a sibling such as `amber-old`). */
function usesProfile(command, profile) {
  const flag = `--user-data-dir=${profile}`;
  const at = command.indexOf(flag);
  if (at < 0) return false;
  const next = command.charAt(at + flag.length);
  return next === '' || /\s/.test(next);
}

/**
 * Who holds a profile: the pid in Chrome's `SingletonLock` symlink (`host-pid`)
 * when that process really runs Chrome on this profile, else any running
 * process launched with this `--user-data-dir`. A lock left by a crash or a
 * reboot, whose pid now belongs to something else, holds nothing.
 */
function profileHolder(profile) {
  try {
    const target = readlinkSync(path.join(profile, 'SingletonLock'));
    const pid = Number(target.split('-').pop());
    const command = processCommand(pid);
    if (usesProfile(command, profile)) return { pid, command };
  } catch { /* no lock, or not a symlink */ }
  if (process.platform === 'win32') return null;
  const listing = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of String(listing.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && usesProfile(match[2], profile) && !/Helper/.test(match[2])) return { pid: Number(match[1]), command: match[2] };
  }
  return null;
}

function lastLogLine(file) {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).pop() ?? ''; } catch { return ''; }
}

/**
 * Start the lane daemon unless one already answers. Refuses a profile a
 * per-session Chrome still holds. When two sessions start the same lane at
 * once, the second Chrome hands off to the first and exits; that start
 * reports the running daemon and never overwrites its record.
 */
export async function startDaemon({
  lane, root, env = process.env, executable, headless, platform = hostPlatform(), uid = currentUid(), spawnImpl = spawn, fetchImpl,
  now = Date.now, timeoutMs = DAEMON_START_TIMEOUT_MS, pollMs = DAEMON_POLL_MS,
}) {
  assertLane(lane);
  const profile = ensureOwnerOnlyDirectory(path.join(root, lane));
  const port = daemonPort(lane, env);
  const headlessMode = headless ?? headlessDefault({ env, platform });
  const running = await fetchDaemonVersion(port, { fetchImpl });
  if (running) return { status: 'running', lane, port, url: daemonUrl(port), browser: running.Browser, headless: headlessMode, record: readDaemonRecord(root, lane) };
  const holder = profileHolder(profile);
  if (holder) {
    throw new LaneBrowserError(`The ${lane} profile is held by pid ${holder.pid} (${holder.command.slice(0, 160) || 'unknown command'}), ` +
      `which does not answer on port ${port}. That is a per-session browser from the launch-per-server mode: ask its session to quit it, ` +
      'then start again.');
  }
  const chromium = resolveChromiumExecutable({ executable, env, platform, required: true });
  const log = daemonLogPath(root, lane);
  const logDescriptor = openSync(log, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC, 0o600);
  let child;
  let spawnError = null;
  try {
    child = spawnImpl(chromium, daemonLaunchArguments({ profile, port, headless: headlessMode, platform, uid }), {
      detached: true, stdio: ['ignore', logDescriptor, logDescriptor], env: childEnvironment(env),
    });
  } finally {
    closeSync(logDescriptor);
  }
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  const deadline = now() + timeoutMs;
  let version = null;
  while (!version && !spawnError && child.exitCode === null && now() < deadline) {
    await sleep(pollMs);
    version = await fetchDaemonVersion(port, { fetchImpl });
  }
  if (spawnError) throw new LaneBrowserError(`Chrome could not start from ${chromium}: ${spawnError.code ?? spawnError.message}.`);
  if (!version && child.exitCode !== null) version = await fetchDaemonVersion(port, { fetchImpl });
  if (!version) {
    const detail = lastLogLine(log);
    throw new LaneBrowserError(`Chrome did not answer on ${daemonUrl(port)} within ${timeoutMs} ms` +
      `${child.exitCode !== null ? ` (it exited with ${child.exitCode})` : ` (pid ${child.pid} is still starting or the port is taken)`}.` +
      `${detail ? ` Last log line: ${detail.slice(0, 200)}` : ''} Log: ${log}`);
  }
  const owner = profileHolder(profile);
  if (child.exitCode !== null || owner?.pid !== child.pid) {
    return { status: 'running', lane, port, url: daemonUrl(port), browser: version.Browser, headless: headlessMode, record: readDaemonRecord(root, lane) };
  }
  const record = {
    schemaVersion: DAEMON_RECORD_SCHEMA, lane, port, pid: child.pid, executable: chromium, headless: headlessMode, browser: version.Browser,
    startedAt: new Date(now()).toISOString(),
  };
  writeOwnerOnlyFile(daemonRecordPath(root, lane), `${JSON.stringify(record, null, 2)}\n`);
  return { status: 'started', lane, port, url: daemonUrl(port), browser: version.Browser, headless: headlessMode, record };
}

export async function daemonStatus({ lane, root, env = process.env, fetchImpl } = {}) {
  assertLane(lane);
  const profile = path.join(root, lane);
  const port = daemonPort(lane, env);
  const version = await fetchDaemonVersion(port, { fetchImpl });
  const holder = existsSync(profile) ? profileHolder(profile) : null;
  return {
    lane, port, url: daemonUrl(port), profile,
    state: version ? 'running' : holder ? 'held' : 'stopped',
    browser: version?.Browser ?? null,
    record: readDaemonRecord(root, lane), holder,
  };
}

/** Stop the daemon this root started; a browser the record does not name is never touched. */
export async function stopDaemon({
  lane, root, env = process.env, killImpl = (pid, signal) => process.kill(pid, signal), now = Date.now,
  timeoutMs = DAEMON_STOP_TIMEOUT_MS, pollMs = DAEMON_POLL_MS,
}) {
  assertLane(lane);
  const profile = path.join(root, lane);
  const port = daemonPort(lane, env);
  const record = readDaemonRecord(root, lane);
  if (!record) {
    throw new LaneBrowserError(`No ${lane} daemon record at ${daemonRecordPath(root, lane)}. ` +
      'A browser on that profile without a record belongs to the session that launched it.');
  }
  if (!processAlive(record.pid)) {
    rmSync(daemonRecordPath(root, lane), { force: true });
    return { status: 'not_running', lane, port, pid: record.pid };
  }
  const command = processCommand(record.pid);
  if (!usesProfile(command, profile)) {
    throw new LaneBrowserError(`pid ${record.pid} is not the ${lane} daemon (${command.slice(0, 160) || 'unknown command'}); refusing to stop it. ` +
      `Remove ${daemonRecordPath(root, lane)} if the daemon is gone.`);
  }
  killImpl(record.pid, 'SIGTERM');
  const deadline = now() + timeoutMs;
  while (processAlive(record.pid) && now() < deadline) await sleep(pollMs);
  if (processAlive(record.pid)) {
    killImpl(record.pid, 'SIGKILL');
    await sleep(pollMs);
  }
  rmSync(daemonRecordPath(root, lane), { force: true });
  return { status: 'stopped', lane, port, pid: record.pid };
}

/** Refuse a second Chromium on a profile a daemon or another browser has open; Chrome would hand off and exit. */
export async function assertProfileFree({ lane, root, env = process.env, fetchImpl } = {}) {
  const status = await daemonStatus({ lane, root, env, fetchImpl });
  if (status.state === 'running') {
    throw new LaneBrowserError(`The ${lane} daemon is running on ${status.url}. Stop it first (npm run lane:browser -- stop ${lane}), then retry.`);
  }
  if (status.state === 'held') {
    throw new LaneBrowserError(`The ${lane} profile is open in pid ${status.holder.pid}; quit that browser first, then retry.`);
  }
}

function rejected(message) {
  return new LaneBrowserError(`Cookie payload rejected: ${message}`);
}

function normalizeCookie(cookie, position) {
  const reject = (field) => rejected(`cookie ${position} has an invalid ${field}.`);
  if (typeof cookie !== 'object' || cookie === null || Array.isArray(cookie)) throw rejected(`cookie ${position} is not an object.`);
  if (typeof cookie.name !== 'string' || !cookie.name || cookie.name.length > 256 || /[\s;=,]/.test(cookie.name)) throw reject('name');
  if (typeof cookie.value !== 'string' || cookie.value.length > 8192 || /[\s;,]/.test(cookie.value)) throw reject('value');
  if (typeof cookie.domain !== 'string' || !HOSTNAME.test(cookie.domain.replace(/^\./, '').toLowerCase())) throw reject('domain');
  const cookiePath = cookie.path ?? '/';
  if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/') || /[\s;,]/.test(cookiePath)) throw reject('path');
  let expires = null;
  if (cookie.expires !== undefined && cookie.expires !== null) {
    if (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires) || cookie.expires <= 0) throw reject('expires');
    expires = Math.floor(cookie.expires);
  }
  for (const flag of ['httpOnly', 'secure']) if (cookie[flag] !== undefined && typeof cookie[flag] !== 'boolean') throw reject(flag);
  if (cookie.sameSite !== undefined && cookie.sameSite !== null && !SAME_SITE.has(cookie.sameSite)) throw reject('sameSite');
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain.toLowerCase(),
    path: cookiePath,
    expires,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: cookie.sameSite ?? null,
  };
}

/** Base64 of a `chickpea-lane-cookies/v1` document; failures name a position and field, never content. */
export function decodeCookiePayload(text, { lane } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw rejected('it is empty.');
  const compact = text.replace(/\s+/g, '');
  if (compact.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4) throw rejected(`it is larger than ${MAX_PAYLOAD_BYTES} bytes.`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw rejected('it is not base64.');
  let document;
  try { document = JSON.parse(Buffer.from(compact, 'base64').toString('utf8')); } catch { throw rejected('it does not decode to JSON.'); }
  if (typeof document !== 'object' || document === null || document.schemaVersion !== COOKIE_PAYLOAD_SCHEMA) {
    throw rejected(`it needs schemaVersion "${COOKIE_PAYLOAD_SCHEMA}".`);
  }
  if (!isQaLane(document.lane)) throw rejected('it names no lane.');
  if (lane && document.lane !== lane) throw rejected(`it was exported for the ${document.lane} lane, not ${lane}.`);
  if (!Array.isArray(document.cookies) || document.cookies.length === 0) throw rejected('it holds no cookies.');
  if (document.cookies.length > MAX_COOKIES) throw rejected(`it holds more than ${MAX_COOKIES} cookies.`);
  return {
    schemaVersion: COOKIE_PAYLOAD_SCHEMA,
    lane: document.lane,
    exportedAt: typeof document.exportedAt === 'string' ? document.exportedAt : null,
    cookies: document.cookies.map((cookie, index) => normalizeCookie(cookie, index + 1)),
  };
}

export function encodeCookiePayload({ lane, cookies, exportedAt = new Date().toISOString() }) {
  assertLane(lane);
  return Buffer.from(JSON.stringify({ schemaVersion: COOKIE_PAYLOAD_SCHEMA, lane, exportedAt, cookies }), 'utf8').toString('base64');
}

/** A fingerprint of the payload for the seed marker; whitespace does not change it. */
export function payloadDigest(text) {
  return `sha256:${createHash('sha256').update(text.replace(/\s+/g, '')).digest('hex')}`;
}

/**
 * Launch Chromium with `--remote-debugging-pipe` and speak DevTools over fds
 * 3 and 4 (NUL-terminated JSON), so no WebSocket client or proxy setting is
 * involved. `close()` asks the browser to quit so the profile is flushed.
 */
export function launchChromium({ executable, args, env = process.env, spawnImpl = spawn, timeoutMs = CDP_TIMEOUT_MS } = {}) {
  if (!executable) throw new LaneBrowserError(`No Chromium to launch. Set ${EXECUTABLE_VARIABLE} or pass --executable.`);
  const child = spawnImpl(executable, ['--remote-debugging-pipe', ...args], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: childEnvironment(env),
  });
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let stderr = '';
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  const failAll = (message) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new LaneBrowserError(message)); }
    pending.clear();
  };
  child.once('error', (error) => failAll(`Chromium could not start: ${error.message}`));
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
  child.stdio[3].on('error', () => { /* the browser went away; the exit handler reports it */ });
  child.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      const entry = message.id === undefined ? undefined : pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new LaneBrowserError(`${entry.method} failed: ${message.error.message ?? 'DevTools error'}`));
      else entry.resolve(message.result ?? {});
    }
  });
  exited.then(() => {
    const lastLine = stderr.trim().split('\n').filter(Boolean).pop();
    failAll(`Chromium exited before answering.${lastLine ? ` ${lastLine}` : ''}`);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new LaneBrowserError(`${method} timed out after ${timeoutMs} ms.`)); }, timeoutMs);
    pending.set(id, { method, resolve, reject, timer });
    child.stdio[3].write(`${JSON.stringify({ id, method, params })}\0`, (error) => {
      if (!error || !pending.has(id)) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(new LaneBrowserError(`Chromium pipe write failed: ${error.message}`));
    });
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    try { await send('Browser.close'); } catch { /* the exit below decides */ }
    let timer;
    const result = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS, null); })]);
    clearTimeout(timer);
    if (result) return result;
    child.kill('SIGKILL');
    return exited;
  };
  return { send, close, exited, stderr: () => stderr, pid: child.pid };
}

function toDevToolsCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires: cookie.expires,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
  };
}

const cookieKey = (cookie) => `${cookie.name}@${String(cookie.domain).replace(/^\./, '').toLowerCase()}`;
const unique = (values) => [...new Set(values)].sort();

export function readSeedMarker(profile) {
  const file = path.join(profile, SEED_MARKER_FILE);
  if (!existsSync(file)) return null;
  try {
    const marker = JSON.parse(readFileSync(file, 'utf8'));
    return marker?.schemaVersion === SEED_MARKER_SCHEMA ? marker : null;
  } catch {
    return null;
  }
}

/**
 * Import a decoded payload into one profile: launch it headless, set the
 * cookies, read them back by name and domain, quit so Chromium persists them,
 * and write the seed marker (digest, names, domains; no values).
 */
export async function importCookies({
  lane, profile, payload, payloadText, executable, env = process.env, platform = hostPlatform(), uid = currentUid(),
  launch = launchChromium, now = Date.now(),
}) {
  assertLane(lane);
  const persistent = payload.cookies.filter((cookie) => cookie.expires !== null);
  const usable = persistent.filter((cookie) => cookie.expires * 1000 > now);
  const skipped = { expired: persistent.length - usable.length, sessionOnly: payload.cookies.length - persistent.length };
  if (usable.length === 0) throw rejected('every cookie is expired or session-only; export a fresh payload.');
  ensureOwnerOnlyDirectory(profile);
  const browser = launch({ executable, args: profileLaunchArguments({ profile, platform, uid }), env });
  try {
    await browser.send('Storage.setCookies', { cookies: usable.map(toDevToolsCookie) });
    const { cookies: stored = [] } = await browser.send('Storage.getCookies');
    const storedKeys = new Set(stored.map(cookieKey));
    const missing = usable.filter((cookie) => !storedKeys.has(cookieKey(cookie)));
    if (missing.length > 0) {
      throw new LaneBrowserError(`Chromium did not store ${missing.length} of ${usable.length} cookies (${unique(missing.map((cookie) => cookie.name)).join(', ')}).`);
    }
  } finally {
    await browser.close();
  }
  const marker = {
    schemaVersion: SEED_MARKER_SCHEMA,
    lane,
    seededAt: new Date(now).toISOString(),
    exportedAt: payload.exportedAt,
    payloadDigest: payloadDigest(payloadText),
    cookieCount: usable.length,
    names: unique(usable.map((cookie) => cookie.name)),
    domains: unique(usable.map((cookie) => cookie.domain)),
    skipped,
  };
  writeOwnerOnlyFile(path.join(profile, SEED_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/**
 * Seed a lane profile from `CHICKPEA_LANE_COOKIES_<LANE>` (or a given payload
 * text). A profile whose marker already carries the payload's digest is left
 * alone unless `replace` is set, so a rotated payload reseeds on its own.
 */
export async function seedProfile({ lane, profile, env = process.env, replace = false, payloadText, ...launchOptions }) {
  const variable = cookieVariable(lane);
  const text = payloadText ?? env[variable];
  if (typeof text !== 'string' || !text.trim()) return { status: 'no_payload', variable };
  const payload = decodeCookiePayload(text, { lane });
  const digest = payloadDigest(text);
  const existing = readSeedMarker(profile);
  if (!replace && existing?.payloadDigest === digest) return { status: 'already_seeded', marker: existing };
  const marker = await importCookies({ lane, profile, payload, payloadText: text, env, ...launchOptions });
  return { status: existing ? 'reseeded' : 'seeded', marker };
}

export function normalizeHost(host) {
  const normalized = String(host ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!HOSTNAME.test(normalized)) throw new LaneBrowserError(`--host needs a hostname such as slack.com, not ${host}.`);
  return normalized;
}

export function cookieMatchesHosts(cookie, hosts) {
  const domain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
  return hosts.some((host) => domain === host || domain.endsWith(`.${host}`));
}

/** Export a signed-in profile's cookies for the given hosts as a payload text plus a value-free summary. */
export async function exportCookies({
  lane, profile, hosts = DEFAULT_COOKIE_HOSTS, executable, env = process.env, platform = hostPlatform(), uid = currentUid(),
  launch = launchChromium, now = Date.now(),
}) {
  assertLane(lane);
  if (!existsSync(profile)) throw new LaneBrowserError(`No ${lane} profile at ${profile}.`);
  const browser = launch({ executable, args: profileLaunchArguments({ profile, platform, uid }), env });
  let cookies = [];
  try {
    ({ cookies = [] } = await browser.send('Storage.getCookies'));
  } finally {
    await browser.close();
  }
  const selected = cookies.filter((cookie) => cookieMatchesHosts(cookie, hosts)).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? '/',
    ...(typeof cookie.expires === 'number' && cookie.expires > 0 ? { expires: Math.floor(cookie.expires) } : {}),
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
  }));
  if (selected.length === 0) throw new LaneBrowserError(`The ${lane} profile holds no cookies for ${hosts.join(', ')}; sign that profile in first.`);
  const exportedAt = new Date(now).toISOString();
  const text = encodeCookiePayload({ lane, cookies: selected, exportedAt });
  return {
    text,
    summary: {
      lane,
      exportedAt,
      cookieCount: selected.length,
      persistent: selected.filter((cookie) => cookie.expires !== undefined).length,
      names: unique(selected.map((cookie) => cookie.name)),
      domains: unique(selected.map((cookie) => cookie.domain)),
      digest: payloadDigest(text),
      bytes: text.length,
    },
  };
}

/**
 * The daemon root a verifier's own commands use on this host: the
 * conventional ~/.chickpea/browsers when it exists and no root variable is
 * set, otherwise the opt-in root variable.
 */
export function verifierRoot({ env = process.env, home = homedir(), create = true } = {}) {
  const conventional = path.join(home, '.chickpea', 'browsers');
  const rootOption = !env[ROOT_VARIABLE]?.trim() && existsSync(conventional) ? conventional : undefined;
  const root = resolveProfileRoot({ root: rootOption, env });
  return create ? ensureOwnerOnlyDirectory(root) : root;
}

/**
 * Make sure a lane's daemon answers: start it when it is stopped, so no person
 * has to. A profile another browser holds is reported, never taken.
 */
export async function ensureDaemon({
  lane, env = process.env, root, start = startDaemon, status = daemonStatus,
  settleMs = 5_000, pollMs = 250, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const daemonRoot = root ?? verifierRoot({ env });
  const read = () => status({ lane, root: daemonRoot, env });
  // A daemon another session is starting locks its profile a moment before
  // its port answers, so `held` is provisional until it persists.
  const settle = async (current) => {
    let state = current;
    for (let waited = 0; state.state === 'held' && waited < settleMs; waited += pollMs) {
      await sleep(pollMs);
      state = await read();
    }
    return state;
  };
  const before = await settle(await read());
  // A cloud session seeds the profile through `serve`; starting it here first would skip the seed.
  if (before.state !== 'stopped' || env[cookieVariable(lane)]?.trim()) return { ...before, started: false };
  let result;
  try { result = await start({ lane, root: daemonRoot, env }); }
  catch (error) {
    const after = await settle(await read());
    if (after.state === 'running') return { ...after, started: false };
    throw error;
  }
  const after = await settle(await read());
  return { ...after, started: result?.status === 'started' && after.state === 'running' };
}
