/**
 * `npm run env -- capabilities <lane|all> [--json] [--write]`
 *
 * Verifiers pick a QA lane by capability: deploy profile, provider keys,
 * model roles, registered actors, transport. The private lane matrix used to
 * be maintained by hand and went stale. This module fills each lane's row from
 * read-only readbacks:
 *
 * - the environment registry and its public status (transport, workspace
 *   label, missing actor aliases, setup-flow marker, claim, serving version);
 * - Wrangler reads of the live Worker (`deployments status`, `versions view`
 *   for the SANDBOX binding, `secret list` for secret names; never values);
 * - whether the operator holds the lane's seed token file (existence only).
 *
 * The default chat model and image role live in the lane's database, and no
 * read-only authenticated host path exposes them, so they are reported as
 * unknown. Every lane is read independently: one unreachable Worker marks its
 * own row and never fails the others.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import {
  EnvironmentRegistryError,
  activeEnvironmentTargets,
  defaultEnvironmentRoot,
  readEnvironmentRegistry,
  readEnvironmentStatus,
} from './environment-registry.mjs';
import { laneCredentialsDirectory } from './lane-secrets.mjs';

export const ENVIRONMENT_CAPABILITIES_SCHEMA = 'chickpea-environment-capabilities/v1';
export const CAPABILITY_MATRIX_FILE = 'lane-capabilities.md';
export const CAPABILITY_SECTION_BEGIN = '<!-- BEGIN GENERATED: npm run env -- capabilities all --write. Edits inside this section are replaced. -->';
export const CAPABILITY_SECTION_END = '<!-- END GENERATED: npm run env -- capabilities -->';
export const MODEL_ROLES_UNKNOWN = 'unknown (check Admin)';

/** Worker secret names that change what a verifier can test on a lane. */
export const CAPABILITY_SECRET_NAMES = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'BROWSERBASE_API_KEY',
  'COMPOSIO_API_KEY',
  'CHICKPEA_ENV_SEED_TOKEN',
]);
const PROVIDER_KEY_NAMES = CAPABILITY_SECRET_NAMES.filter((name) => name !== 'CHICKPEA_ENV_SEED_TOKEN');

const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DEFAULT_WRANGLER_TIMEOUT_MS = 60_000;

function fail(code, details) {
  return new EnvironmentRegistryError(code, details);
}

/**
 * Read every requested lane's capability row. `target` is a registered lane
 * or `all`. Injectable for tests: `readLanes`, `runWrangler`, `now`, `env`.
 */
export async function readEnvironmentCapabilities(target, options = {}) {
  if (target !== 'all' && !activeEnvironmentTargets.includes(target)) throw fail('INVALID_TARGET');
  const providerContext = validateCapabilityProviderContext(options.providerContext);
  const readLanes = options.readLanes ?? readRegisteredLanes;
  const lanes = readLanes(target === 'all' ? undefined : target, options);
  const runWrangler = options.runWrangler ?? defaultWranglerRunner(options);
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const rows = await Promise.all(lanes.map((lane) => readLaneRow(lane, {
    runWrangler, providerContext, env, now,
  })));
  return Object.freeze({
    schemaVersion: ENVIRONMENT_CAPABILITIES_SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    lanes: Object.freeze(rows),
  });
}

/** Registry fields plus the public status view, one entry per lane. */
export function readRegisteredLanes(target, options = {}) {
  const status = readEnvironmentStatus({ ...options, ...(target ? { target } : {}) });
  const registry = readEnvironmentRegistry(options);
  return status.targets.map((entry) => {
    const registration = registry.targets[entry.target];
    if (!registration) throw fail('TARGET_NOT_REGISTERED');
    return {
      target: entry.target,
      health: entry.health,
      workerName: registration.workerName,
      transport: entry.transport,
      workspaceLabel: entry.workspaceLabel,
      missingActorAliases: Array.isArray(registration.missingActorAliases)
        ? [...registration.missingActorAliases] : [],
      setupFlowUnprovenSince: entry.setupFlowUnprovenSince ?? null,
      servingVersion: entry.servingVersion ?? null,
      sourceSha: entry.sourceSha ?? null,
      claim: entry.claim
        ? {
          holderId: entry.claim.holderId,
          ...(typeof registration.claim?.branch === 'string' ? { branch: registration.claim.branch } : {}),
          expiresAt: entry.claim.expiresAt,
        }
        : null,
      verifierLock: entry.verifierLock?.status ?? 'clear',
    };
  });
}

async function readLaneRow(lane, { runWrangler, providerContext, env, now }) {
  const errors = [];
  const worker = await readLiveWorker(lane.workerName, runWrangler, providerContext, errors);
  const secrets = worker.secretNames
    ? Object.fromEntries(CAPABILITY_SECRET_NAMES.map((name) => [name, worker.secretNames.has(name)]))
    : null;
  return Object.freeze({
    target: lane.target,
    health: lane.health,
    workerName: lane.workerName,
    reachable: errors.length === 0,
    profile: worker.profile,
    liveVersion: worker.liveVersion,
    servingVersion: lane.servingVersion,
    versionMatchesRegistry: worker.liveVersion && lane.servingVersion
      ? worker.liveVersion === lane.servingVersion : null,
    sourceSha: lane.sourceSha,
    secrets,
    seedTokenFile: seedTokenFileExists(lane.target, env),
    defaultChatModel: null,
    imageRole: null,
    modelRoles: MODEL_ROLES_UNKNOWN,
    transport: lane.transport,
    workspaceLabel: lane.workspaceLabel,
    missingActorAliases: Object.freeze([...lane.missingActorAliases]),
    setupFlowUnprovenSince: lane.setupFlowUnprovenSince,
    claim: lane.claim,
    verifierLock: lane.verifierLock,
    observedAt: new Date(now()).toISOString(),
    errors: Object.freeze(errors),
  });
}

/**
 * Deploy profile and secret names for one Worker. Each read records its own
 * bounded error code; no Wrangler output text leaves this function.
 */
async function readLiveWorker(workerName, runWrangler, providerContext, errors) {
  const result = { profile: 'unknown', liveVersion: null, secretNames: null };
  if (typeof workerName !== 'string' || !WORKER_NAME.test(workerName)) {
    errors.push('WORKER_NAME_INVALID');
    return result;
  }
  const scope = ['--name', workerName, ...providerContext];
  const [secretRead, deploymentRead] = await Promise.all([
    safeRun(runWrangler, ['secret', 'list', '--format', 'json', ...scope]),
    safeRun(runWrangler, ['deployments', 'status', '--json', ...scope]),
  ]);
  if (workerMissing(secretRead) || workerMissing(deploymentRead)) {
    errors.push('WORKER_NOT_FOUND');
    return result;
  }
  const secretEntries = parseJson(secretRead);
  if (Array.isArray(secretEntries) && secretEntries.every((entry) => typeof entry?.name === 'string')) {
    result.secretNames = new Set(secretEntries.map((entry) => entry.name));
  } else {
    errors.push('WORKER_SECRETS_UNAVAILABLE');
  }
  const deployment = parseJson(deploymentRead);
  const versions = Array.isArray(deployment?.versions)
    ? deployment.versions.filter((version) => Number(version?.percentage) > 0)
    : [];
  if (!versions.length || versions.some((version) => !VERSION_ID.test(version?.version_id ?? ''))) {
    errors.push('WORKER_DEPLOYMENT_UNAVAILABLE');
    return result;
  }
  if (versions.length === 1) result.liveVersion = versions[0].version_id;
  const views = await Promise.all(versions.map((version) => safeRun(runWrangler, [
    'versions', 'view', version.version_id, '--json', ...scope,
  ])));
  const bindingSets = views.map((view) => parseJson(view)?.resources?.bindings);
  if (bindingSets.some((bindings) => !Array.isArray(bindings))) {
    errors.push('WORKER_VERSION_UNAVAILABLE');
    return result;
  }
  const sandboxed = bindingSets.map((bindings) => bindings.some(isSandboxBinding));
  // A split deployment serving both profiles is reported as such rather than
  // guessed: a core deploy over a sandbox Worker is refused either way.
  result.profile = sandboxed.every(Boolean) ? 'sandbox' : sandboxed.some(Boolean) ? 'mixed' : 'core';
  return result;
}

/** Same test as the guarded deploy's "The live Worker has the coding sandbox". */
export function isSandboxBinding(binding) {
  return binding?.type === 'durable_object_namespace'
    && (binding.name === 'SANDBOX' || binding.class_name === 'Sandbox');
}

async function safeRun(runWrangler, args) {
  try {
    return await runWrangler(args);
  } catch {
    return { status: 1, stdout: '', stderr: '', error: new Error('runner failed') };
  }
}

function workerMissing(run) {
  return !run?.error && run?.status !== 0
    && /Worker\s+"[^"]+"[^\n]*not found|\[code:\s*10007\]/iu.test(`${run?.stdout ?? ''}\n${run?.stderr ?? ''}`);
}

function parseJson(run) {
  if (!run || run.error || run.status !== 0 || typeof run.stdout !== 'string') return undefined;
  try { return JSON.parse(run.stdout); } catch { return undefined; }
}

function seedTokenFileExists(target, env) {
  try {
    return existsSync(path.join(laneCredentialsDirectory(env), `${target}-seed.json`));
  } catch {
    return false;
  }
}

export function validateCapabilityProviderContext(input) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length % 2 !== 0 || input.length > 4) throw fail('INVALID_PROVIDER_CONTEXT');
  const seen = new Set();
  for (let index = 0; index < input.length; index += 2) {
    const flag = input[index];
    const value = input[index + 1];
    if (!['--profile', '--env'].includes(flag) || seen.has(flag)
      || typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
      throw fail('INVALID_PROVIDER_CONTEXT');
    }
    seen.add(flag);
  }
  return Object.freeze([...input]);
}

function defaultWranglerRunner(options) {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const timeout = options.wranglerTimeoutMs ?? DEFAULT_WRANGLER_TIMEOUT_MS;
  return (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = 2 * 1024 * 1024;
    child.stdout.on('data', (chunk) => { if (stdout.length < limit) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < limit) stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, stdout, stderr, error }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

// --- Rendering -------------------------------------------------------------

const COLUMNS = Object.freeze([
  'Lane', 'Health', 'Profile', 'Live version', 'Provider keys (Worker secrets)', 'Seed token (Worker / file)',
  'Default chat model / image role', 'Missing actors', 'Slack workspace', 'Transport',
  'Setup flow unproven', 'Claim', 'Observed',
]);

export function renderCapabilityTable(report) {
  const lines = [
    `| ${COLUMNS.join(' | ')} |`,
    `| ${COLUMNS.map(() => '---').join(' | ')} |`,
    ...report.lanes.map((lane) => `| ${capabilityCells(lane).map(cell).join(' | ')} |`),
  ];
  return `${lines.join('\n')}\n`;
}

function capabilityCells(lane) {
  const secretsKnown = lane.secrets !== null;
  const keys = secretsKnown
    ? PROVIDER_KEY_NAMES.filter((name) => lane.secrets[name]).join(', ') || 'none'
    : 'unknown';
  const seedWorker = secretsKnown ? (lane.secrets.CHICKPEA_ENV_SEED_TOKEN ? 'yes' : 'no') : 'unknown';
  let version = lane.liveVersion ? lane.liveVersion.slice(0, 8) : 'unknown';
  if (lane.versionMatchesRegistry === false) {
    version += ` (registry ${String(lane.servingVersion).slice(0, 8)})`;
  }
  const claim = lane.claim
    ? `claimed${lane.claim.branch ? ` by ${lane.claim.branch}` : ` (${lane.claim.holderId})`} until ${lane.claim.expiresAt}`
    : 'free';
  return [
    capitalize(lane.target),
    lane.errors.length ? `${lane.health}; read errors: ${lane.errors.join(', ')}` : lane.health,
    lane.profile,
    version,
    keys,
    `${seedWorker} / ${lane.seedTokenFile ? 'yes' : 'no'}`,
    lane.modelRoles,
    lane.missingActorAliases.length ? lane.missingActorAliases.join(', ') : 'none',
    lane.workspaceLabel ?? 'unknown',
    lane.transport ?? 'unknown',
    lane.setupFlowUnprovenSince ? lane.setupFlowUnprovenSince.slice(0, 8) : 'no',
    `${claim}${lane.verifierLock && lane.verifierLock !== 'clear' ? `; verifier lock ${lane.verifierLock}` : ''}`,
    lane.observedAt,
  ];
}

function cell(value) {
  return String(value).replace(/\|/gu, '\\|').replace(/\s+/gu, ' ').trim();
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function renderCapabilitySection(report) {
  return [
    CAPABILITY_SECTION_BEGIN,
    '',
    `Generated ${report.generatedAt} from read-only readbacks: the environment registry, Wrangler`,
    '(live deployment, SANDBOX binding, Worker secret names only), and the lane seed token file',
    '(existence only). The default chat model and image role have no read-only host path yet;',
    'read them in Admin Settings > Model providers. Keep hand-written notes outside this section.',
    '',
    renderCapabilityTable(report).trimEnd(),
    '',
    CAPABILITY_SECTION_END,
  ].join('\n');
}

/**
 * Replace the generated section of the matrix text, keeping everything
 * outside it. Without a section, insert one after the first heading block.
 */
export function mergeCapabilitySection(existing, section) {
  if (existing === undefined || existing === '') {
    return `# Lane capability matrix (private)\n\n${section}\n`;
  }
  const begins = countOccurrences(existing, CAPABILITY_SECTION_BEGIN);
  const ends = countOccurrences(existing, CAPABILITY_SECTION_END);
  if (begins !== ends || begins > 1) throw fail('CAPABILITY_MATRIX_SECTION_INVALID');
  if (begins === 1) {
    const start = existing.indexOf(CAPABILITY_SECTION_BEGIN);
    const end = existing.indexOf(CAPABILITY_SECTION_END);
    if (end < start) throw fail('CAPABILITY_MATRIX_SECTION_INVALID');
    return `${existing.slice(0, start)}${section}${existing.slice(end + CAPABILITY_SECTION_END.length)}`;
  }
  const lines = existing.split('\n');
  if (lines[0]?.startsWith('# ')) {
    const rest = lines.slice(1).join('\n').replace(/^\n+/u, '');
    return `${lines[0]}\n\n${section}\n\n${rest}`;
  }
  return `${section}\n\n${existing}`;
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

export function defaultCapabilityMatrixPath(options = {}) {
  return path.join(options.root ?? defaultEnvironmentRoot(), CAPABILITY_MATRIX_FILE);
}

/** Rewrite the generated section of the private matrix atomically (0600). */
export function writeCapabilityMatrix(report, options = {}) {
  const file = options.matrixPath ?? defaultCapabilityMatrixPath(options);
  let existing;
  const stat = lstatIfPresent(file);
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail('CAPABILITY_MATRIX_UNSAFE');
    existing = readFileSync(file, 'utf8');
  }
  const next = mergeCapabilitySection(existing, renderCapabilitySection(report));
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  return { path: file, created: !stat };
}

function lstatIfPresent(file) {
  try { return lstatSync(file); } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}
