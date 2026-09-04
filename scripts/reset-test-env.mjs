#!/usr/bin/env node
/**
 * Exact-resource cleanup for disposable Chickpea live acceptance runs.
 *
 * Dry-run is mandatory first. This script never discovers cleanup targets by
 * name or prefix: every target comes from an append-only run ledger. Slack UI
 * resources and Cloudflare/GitHub resources without a supported exact CLI
 * operation remain explicit manual actions and are not marked verified here.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupPlan, recordCleanupVerified } from './live-test-resource-ledger.mjs';
import { authorizeEnvironmentCleanupPlan } from './lib/environment-preflight.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function renderCleanupPlan(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return 'No pending owned resources.';
  return targets.map((target, index) => {
    const operation = target.action === 'archive' ? 'ARCHIVE' : 'DELETE';
    return `${index + 1}. ${operation} ${target.provider}/${target.kind} id=${target.id}`;
  }).join('\n');
}

export function automaticCleanupCommand(_target, _options = {}) {
  // Wrangler Worker and D1 deletion, GitHub repository deletion, and the
  // currently supported container commands all address a mutable name. None
  // exposes a provider-side immutable-version/etag precondition, so a local
  // readback can never close the final read/delete race. Keep these resources
  // explicit manual actions until the provider offers a genuine conditional
  // deletion primitive.
  return null;
}

export function resolveD1NameByExactId(target, rawList) {
  const parsed = typeof rawList === 'string' ? JSON.parse(rawList) : rawList;
  if (!Array.isArray(parsed)) throw new Error('Wrangler D1 inventory was not an array.');
  const matches = parsed.filter((row) => row && row.uuid === target.id && typeof row.name === 'string');
  if (matches.length !== 1) {
    throw new Error(`D1 exact ID ${target.id} resolved to ${matches.length} resources; refusing cleanup.`);
  }
  return matches[0].name;
}

export function isManualCleanupTarget(target) {
  return automaticCleanupCommand(target) === null;
}

export function readLiveCleanupResource(resource, {
  runCommand = run,
  providerContext = [],
  now = () => Date.now(),
} = {}) {
  const context = validateProviderContext(providerContext);
  if (!resource || typeof resource !== 'object'
    || typeof resource.target !== 'string'
    || typeof resource.provider !== 'string'
    || typeof resource.kind !== 'string'
    || typeof resource.id !== 'string'
    || typeof resource.immutableId !== 'string'
    || typeof resource.creationIntentDigest !== 'string') {
    throw new Error('Invalid provider cleanup readback request.');
  }
  let immutableId;
  let creationIntentDigest;
  if (resource.provider === 'cloudflare'
    && ['worker', 'capture_worker'].includes(resource.kind)) {
    const deployments = checkedJson(runCommand({
      command: 'node_modules/.bin/wrangler',
      args: ['deployments', 'status', '--json', '--name', resource.id, ...context],
    }), 'Unable to read Worker deployment identity before cleanup.');
    const active = Array.isArray(deployments?.versions)
      ? deployments.versions.filter((version) => Number(version?.percentage) > 0)
      : [];
    if (active.length !== 1 || active[0]?.percentage !== 100
      || typeof active[0]?.version_id !== 'string') {
      throw new Error('Worker does not have one exact 100% serving version; refusing cleanup.');
    }
    immutableId = active[0].version_id;
    const view = checkedJson(runCommand({
      command: 'node_modules/.bin/wrangler',
      args: ['versions', 'view', immutableId, '--json', '--name', resource.id, ...context],
    }), 'Unable to read Worker creation authority before cleanup.');
    const bindings = Array.isArray(view?.resources?.bindings) ? view.resources.bindings : [];
    const stamps = bindings.filter((binding) => binding?.name === 'CHICKPEA_RESOURCE_CREATION_INTENT_DIGEST')
      .map((binding) => binding?.text ?? binding?.value)
      .filter((value) => typeof value === 'string');
    if (stamps.length !== 1) throw new Error('Worker creation authority is missing or ambiguous.');
    [creationIntentDigest] = stamps;
  } else if (resource.provider === 'cloudflare'
    && ['d1', 'capture_store'].includes(resource.kind)) {
    immutableId = resource.id;
    const statement = checkedJson(runCommand({
      command: 'node_modules/.bin/wrangler',
      args: [
        'd1', 'execute', resource.id, '--remote', '--json', '--command',
        "SELECT value FROM chickpea_resource_authority WHERE key = 'creation_intent_digest'",
        ...context,
      ],
    }), 'Unable to read D1 creation authority before cleanup.');
    const results = Array.isArray(statement) ? statement : [];
    const rows = results.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
    if (rows.length !== 1 || typeof rows[0]?.value !== 'string') {
      throw new Error('D1 creation authority is missing or ambiguous.');
    }
    creationIntentDigest = rows[0].value;
  } else if (resource.provider === 'github' && resource.kind === 'generated_repository') {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(resource.id)) {
      throw new Error('Invalid exact GitHub repository coordinate.');
    }
    const repository = checkedJson(runCommand({
      command: 'gh', args: ['api', `repos/${resource.id}`],
    }), 'Unable to read GitHub repository identity before cleanup.');
    const stamp = checkedJson(runCommand({
      command: 'gh',
      args: ['api', `repos/${resource.id}/actions/variables/CHICKPEA_RESOURCE_CREATION_INTENT_DIGEST`],
    }), 'Unable to read GitHub repository creation authority before cleanup.');
    immutableId = repository?.node_id;
    creationIntentDigest = stamp?.value;
  } else {
    throw new Error(`No exact immutable provider readback for ${resource.provider}/${resource.kind}.`);
  }
  if (immutableId !== resource.immutableId
    || creationIntentDigest !== resource.creationIntentDigest) {
    throw new Error('Provider resource identity changed; refusing cleanup.');
  }
  return Object.freeze({
    target: resource.target,
    provider: resource.provider,
    kind: resource.kind,
    id: resource.id,
    immutableId,
    creationIntentDigest,
    observedAt: new Date(now()).toISOString(),
  });
}

export function executeCleanup({
  ledgerPath,
  apply = false,
  target,
  receiptPaths = [],
  environmentOptions = {},
  authorizeCleanup = authorizeEnvironmentCleanupPlan,
  runCommand = run,
  stdout = process.stdout,
}) {
  const targets = cleanupPlan(ledgerPath);
  stdout.write(`\nChickpea disposable cleanup${apply ? '' : ' (dry run)'}\n`);
  stdout.write(`${renderCleanupPlan(targets)}\n`);
  if (!apply || targets.length === 0) return { targets, completed: [], manual: targets.filter(isManualCleanupTarget) };

  const providerContext = validateProviderContext(environmentOptions.providerContext ?? []);

  // Validate the entire exact-ID plan before inventorying or deleting even
  // one resource. A single missing, forged, mixed-target, or protected receipt
  // leaves every provider untouched.
  const readProviderResource = environmentOptions.readProviderResource
    ?? ((resource) => readLiveCleanupResource(resource, { runCommand, providerContext }));
  const authorizedTargets = authorizeCleanup(targets, {
    ...environmentOptions,
    target,
    receiptPaths,
    readProviderResource,
  });
  if (!Array.isArray(authorizedTargets) || authorizedTargets.length !== targets.length
    || authorizedTargets.some((authorized, index) =>
      authorized?.provider !== targets[index]?.provider
      || authorized?.kind !== targets[index]?.kind
      || authorized?.id !== targets[index]?.id
      || typeof authorized?.immutableId !== 'string'
      || typeof authorized?.creationIntentDigest !== 'string'
    )) {
    throw new Error('Cleanup authorization returned an invalid immutable plan.');
  }
  if (environmentOptions.beforeCleanupCommandBoundary) {
    environmentOptions.beforeCleanupCommandBoundary();
  }
  // Re-read the entire immutable plan immediately at the provider command
  // boundary. A renamed/recreated resource prevents every delete, including
  // earlier otherwise-valid items in the same plan.
  for (const authorized of authorizedTargets) {
    const boundary = readProviderResource(authorized);
    if (!boundary || boundary.target !== target
      || boundary.provider !== authorized.provider
      || boundary.kind !== authorized.kind
      || boundary.id !== authorized.id
      || boundary.immutableId !== authorized.immutableId
      || boundary.creationIntentDigest !== authorized.creationIntentDigest) {
      throw new Error('Provider resource identity changed at cleanup command boundary; refusing deletion.');
    }
  }
  if (environmentOptions.afterCleanupBoundaryRead) {
    environmentOptions.afterCleanupBoundaryRead();
  }

  return { targets, completed: [], manual: authorizedTargets };
}

function checkedJson(result, message) {
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') throw new Error(message);
  try { return JSON.parse(result.stdout); } catch { throw new Error(message); }
}

function validateProviderContext(input) {
  if (!Array.isArray(input) || input.length % 2 !== 0 || input.length > 4) {
    throw new Error('Invalid Cloudflare provider context.');
  }
  const seen = new Set();
  for (let index = 0; index < input.length; index += 2) {
    const flag = input[index];
    const value = input[index + 1];
    if (!['--profile', '--env'].includes(flag) || seen.has(flag)
      || typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
      throw new Error('Invalid Cloudflare provider context.');
    }
    seen.add(flag);
  }
  return Object.freeze([...input]);
}

function run({ command, args, input }) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    ...(input ? { input } : {}),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function argument(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function argumentsFor(args, flag) {
  return args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]] : []);
}

async function cli() {
  const args = process.argv.slice(2);
  const ledgerPath = argument(args, '--ledger');
  if (!ledgerPath) throw new Error('Pass --ledger <path>. Cleanup targets never come from command-line names.');
  const apply = args.includes('--apply');
  const target = argument(args, '--target');
  const receiptPaths = argumentsFor(args, '--receipt');
  if (apply && !target) throw new Error('Pass --target <amber|cobalt> for receipt-backed cleanup.');
  const root = argument(args, '--root');
  const worktreePath = argument(args, '--worktree');
  const profile = argument(args, '--profile');
  const environment = argument(args, '--env');
  const result = executeCleanup({
    ledgerPath, apply, target, receiptPaths,
    environmentOptions: {
      ...(root ? { root } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...((profile || environment) ? {
        providerContext: [
          ...(profile ? ['--profile', profile] : []),
          ...(environment ? ['--env', environment] : []),
        ],
      } : {}),
    },
  });
  if (!apply) {
    console.log('\nDry run only. Review every exact ID, then re-run with --apply.');
  }
  if (result.manual.length > 0) {
    console.log('\nManual exact-ID cleanup still required:');
    console.log(renderCleanupPlan(result.manual));
  }
  if (result.completed.length > 0) {
    console.log('\nCommands completed but are NOT yet ledger-verified. Re-inventory each exact ID, then record cleanup_verified.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

export { recordCleanupVerified };
