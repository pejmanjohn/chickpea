import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { outsideGit } from './private-evidence.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WRANGLER = join(PROJECT_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const WORKER_NAME = /^[a-z0-9_][a-z0-9_-]{0,127}$/u;
const ACCOUNT_ID = /^[a-f0-9]{32}$/iu;
const PROVIDER_CONTEXT_VALUE = /^[A-Za-z0-9._-]{1,128}$/u;
const VERSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/u;
const POLICY_BINDINGS = Object.freeze([
  'CHICKPEA_TELEMETRY_ENVIRONMENT',
  'DO_NOT_TRACK',
  'CHICKPEA_DISABLE_TELEMETRY',
]);
const MESSAGES = Object.freeze({
  INVALID_WORKER: 'Provide one explicit Cloudflare Worker name with --worker.',
  INVALID_ACCOUNT: 'When provided, --account-id must be a 32-character Cloudflare account ID.',
  INVALID_PROVIDER_CONTEXT: 'When provided, --profile and --env must be bounded Wrangler context names.',
  WRANGLER_READ_FAILED: 'Wrangler could not read the selected Worker. Check its account selection and login, then retry.',
  DEPLOYMENT_STATUS_INVALID: 'Wrangler returned an invalid serving deployment snapshot.',
  VERSION_RESPONSE_INVALID: 'Wrangler returned an invalid Worker version snapshot.',
  VERSION_ID_MISMATCH: 'Wrangler returned a different Worker version than the one requested.',
  SERVING_SNAPSHOT_CHANGED: 'The serving deployment changed during inspection. Retry against a stable deployment.',
  UNSAFE_SERVING_VERSION: 'At least one serving version lacks an explicit test environment or plain-text telemetry opt-out.',
});

export class ProductTelemetryPreflightError extends Error {
  constructor(code, receipt) {
    super(`${code}: ${MESSAGES[code] ?? 'Product telemetry preflight failed.'}`);
    this.name = 'ProductTelemetryPreflightError';
    this.code = code;
    this.receipt = receipt;
  }
}

/**
 * Read the exact versions currently serving one explicitly named Worker and
 * verify that every positive-traffic version is safe for product QA.
 */
export async function verifyProductTelemetry(options = {}) {
  const worker = validWorker(options.worker) ? options.worker : null;
  const accountId = options.accountId === undefined
    ? undefined
    : validAccount(options.accountId) ? options.accountId.toLowerCase() : null;
  const receipt = {
    schemaVersion: 'chickpea-product-telemetry-preflight/v1',
    worker,
    ...(accountId ? { accountId } : {}),
    observedAt: observationTime(options.now),
    status: 'failed',
    versions: [],
    recheck: 'not_run',
    failure: null,
  };

  try {
    if (!worker) throw failure('INVALID_WORKER', receipt);
    if (accountId === null) throw failure('INVALID_ACCOUNT', receipt);
    const providerContext = resolveProviderContext(options.providerContext);
    receipt.providerContext = providerContext;
    const runWrangler = options.runWrangler ?? defaultWranglerRunner(options);
    const before = readDeploymentSnapshot(runWrangler, worker, providerContext);
    receipt.versions = before.map(({ version, traffic }) => ({
      version,
      traffic,
      environment: 'not_checked',
      doNotTrack: 'not_checked',
      disableTelemetry: 'not_checked',
      policy: 'not_checked',
    }));

    for (const entry of receipt.versions) {
      const view = readCommandJson(runWrangler, [
        'versions', 'view', entry.version, '--json', '--name', worker,
        ...providerContext,
      ], 'VERSION_RESPONSE_INVALID');
      if (!isRecord(view) || view.id !== entry.version) {
        throw failure(view?.id === undefined ? 'VERSION_RESPONSE_INVALID' : 'VERSION_ID_MISMATCH', receipt);
      }
      if (!isRecord(view.resources) || !Array.isArray(view.resources.bindings)) {
        throw failure('VERSION_RESPONSE_INVALID', receipt);
      }
      Object.assign(entry, evaluateBindings(view.resources.bindings));
    }

    const after = readDeploymentSnapshot(runWrangler, worker, providerContext);
    receipt.recheck = sameSnapshot(before, after) ? 'stable' : 'changed';
    if (receipt.recheck !== 'stable') throw failure('SERVING_SNAPSHOT_CHANGED', receipt);
    if (receipt.versions.some(({ policy }) => !['test_environment', 'plain_text_opt_out'].includes(policy))) {
      throw failure('UNSAFE_SERVING_VERSION', receipt);
    }

    receipt.status = 'passed';
    return freezeReceipt(receipt);
  } catch (error) {
    const wrapped = error instanceof ProductTelemetryPreflightError
      ? error
      : failure('WRANGLER_READ_FAILED', receipt);
    receipt.status = 'failed';
    receipt.failure = Object.freeze({ code: wrapped.code, message: MESSAGES[wrapped.code] });
    wrapped.receipt = freezeReceipt(receipt);
    throw wrapped;
  }
}

/** Write one atomic, owner-only receipt outside every Git checkout. */
export function writeProductTelemetryReceipt(filePath, receipt, sourceRoot = PROJECT_ROOT) {
  let output;
  try {
    output = outsideGit(filePath, sourceRoot);
  } catch {
    throw new Error('Telemetry preflight output must be an absolute path outside every Git repository.');
  }
  if (existsSync(output)) throw new Error('Telemetry preflight output already exists. Choose a new private path.');

  const parent = dirname(output);
  const temporary = join(parent, `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, output);
    unlinkSync(temporary);
    const directory = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return output;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('Telemetry preflight output already exists. Choose a new private path.');
    }
    throw new Error('Unable to write the private telemetry preflight receipt.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function defaultWranglerRunner(options) {
  const env = {
    ...(options.env ?? process.env),
    ...(options.accountId ? { CLOUDFLARE_ACCOUNT_ID: options.accountId.toLowerCase() } : {}),
  };
  return (args) => spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: options.projectRoot ?? PROJECT_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

function readDeploymentSnapshot(runWrangler, worker, providerContext) {
  const body = readCommandJson(runWrangler, [
    'deployments', 'status', '--json', '--name', worker,
    ...providerContext,
  ], 'DEPLOYMENT_STATUS_INVALID');
  if (!isRecord(body) || !Array.isArray(body.versions) || body.versions.length === 0) {
    throw failure('DEPLOYMENT_STATUS_INVALID');
  }

  const seen = new Set();
  const parsed = [];
  let total = 0;
  for (const candidate of body.versions) {
    if (!isRecord(candidate) || !VERSION_ID.test(candidate.version_id ?? '')
      || typeof candidate.percentage !== 'number' || !Number.isFinite(candidate.percentage)
      || candidate.percentage < 0 || candidate.percentage > 100
      || seen.has(candidate.version_id)) {
      throw failure('DEPLOYMENT_STATUS_INVALID');
    }
    seen.add(candidate.version_id);
    total += candidate.percentage;
    if (candidate.percentage > 0) {
      parsed.push({ version: candidate.version_id, traffic: candidate.percentage });
    }
  }
  if (parsed.length === 0 || Math.abs(total - 100) > 1e-6) {
    throw failure('DEPLOYMENT_STATUS_INVALID');
  }
  return parsed.sort((left, right) => left.version.localeCompare(right.version));
}

function readCommandJson(runWrangler, args, invalidCode) {
  let result;
  try {
    result = runWrangler(args);
  } catch {
    throw failure('WRANGLER_READ_FAILED');
  }
  if (!isRecord(result) || result.error || result.status !== 0
    || typeof result.stdout !== 'string'
    || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) {
    throw failure('WRANGLER_READ_FAILED');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw failure(invalidCode);
  }
}

function evaluateBindings(bindings) {
  const environment = classifyBinding(bindings, POLICY_BINDINGS[0], 'environment');
  const doNotTrack = classifyBinding(bindings, POLICY_BINDINGS[1], 'optout');
  const disableTelemetry = classifyBinding(bindings, POLICY_BINDINGS[2], 'optout');
  let policy = 'telemetry_not_disabled';
  if (environment === 'test') policy = 'test_environment';
  else if (doNotTrack === 'truthy' || disableTelemetry === 'truthy') policy = 'plain_text_opt_out';
  else if ([environment, doNotTrack, disableTelemetry].includes('secret')) policy = 'secret_value_unknown';
  else if ([environment, doNotTrack, disableTelemetry].includes('ambiguous')) policy = 'ambiguous_binding';
  else if ([environment, doNotTrack, disableTelemetry].includes('invalid')) policy = 'invalid_binding';
  return { environment, doNotTrack, disableTelemetry, policy };
}

function classifyBinding(bindings, name, kind) {
  const matches = bindings.filter((binding) => isRecord(binding) && binding.name === name);
  if (matches.length === 0) return 'missing';
  if (matches.length !== 1) return 'ambiguous';
  const binding = matches[0];
  if (binding.type === 'secret_text') return 'secret';
  if (binding.type !== 'plain_text' || typeof binding.text !== 'string') return 'invalid';
  const value = binding.text.trim();
  if (kind === 'environment') return value === 'test' ? 'test' : 'non_test';
  return ['1', 'true', 'yes'].includes(value.toLowerCase()) ? 'truthy' : 'falsey';
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validWorker(value) {
  return typeof value === 'string' && WORKER_NAME.test(value);
}

function validAccount(value) {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

function resolveProviderContext(input) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length % 2 !== 0 || input.length > 4) {
    throw failure('INVALID_PROVIDER_CONTEXT');
  }
  const context = [];
  const seen = new Set();
  for (let index = 0; index < input.length; index += 2) {
    const flag = input[index];
    const value = input[index + 1];
    if (!['--profile', '--env'].includes(flag) || seen.has(flag)
      || typeof value !== 'string' || !PROVIDER_CONTEXT_VALUE.test(value)) {
      throw failure('INVALID_PROVIDER_CONTEXT');
    }
    seen.add(flag);
    context.push(flag, value);
  }
  return Object.freeze(context);
}

function observationTime(now) {
  const observed = new Date(now ? now() : Date.now());
  if (!Number.isFinite(observed.getTime())) {
    throw new Error('Invalid observation time.');
  }
  return observed.toISOString();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(code, receipt = undefined) {
  return new ProductTelemetryPreflightError(code, receipt);
}

function freezeReceipt(receipt) {
  receipt.versions = Object.freeze(receipt.versions.map((version) => Object.freeze({ ...version })));
  return Object.freeze({ ...receipt });
}
