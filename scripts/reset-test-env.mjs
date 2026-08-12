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

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function renderCleanupPlan(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return 'No pending owned resources.';
  return targets.map((target, index) => {
    const operation = target.action === 'archive' ? 'ARCHIVE' : 'DELETE';
    return `${index + 1}. ${operation} ${target.provider}/${target.kind} id=${target.id}`;
  }).join('\n');
}

export function automaticCleanupCommand(target, { d1Name } = {}) {
  switch (`${target.provider}:${target.kind}`) {
    case 'cloudflare:worker':
    case 'cloudflare:capture_worker':
      return { command: 'node_modules/.bin/wrangler', args: ['delete', target.id, '--force'], input: 'y\n' };
    case 'cloudflare:d1':
    case 'cloudflare:capture_store':
      if (!d1Name) return null;
      return { command: 'node_modules/.bin/wrangler', args: ['d1', 'delete', d1Name, '--skip-confirmation'] };
    case 'cloudflare:container_app':
      return { command: 'node_modules/.bin/wrangler', args: ['containers', 'delete', target.id], input: 'y\n' };
    case 'cloudflare:container_image':
      return { command: 'node_modules/.bin/wrangler', args: ['containers', 'images', 'delete', target.id, '--skip-confirmation'] };
    case 'github:generated_repository':
      return { command: 'gh', args: ['repo', 'delete', target.id, '--yes'] };
    default:
      return null;
  }
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
  return automaticCleanupCommand(target) === null &&
    !['cloudflare:d1', 'cloudflare:capture_store'].includes(`${target.provider}:${target.kind}`);
}

export function executeCleanup({ ledgerPath, apply = false, runCommand = run, stdout = process.stdout }) {
  const targets = cleanupPlan(ledgerPath);
  stdout.write(`\nChickpea disposable cleanup${apply ? '' : ' (dry run)'}\n`);
  stdout.write(`${renderCleanupPlan(targets)}\n`);
  if (!apply || targets.length === 0) return { targets, completed: [], manual: targets.filter(isManualCleanupTarget) };

  const completed = [];
  const manual = [];
  let d1Inventory;
  for (const target of targets) {
    let d1Name;
    if (target.provider === 'cloudflare' && ['d1', 'capture_store'].includes(target.kind)) {
      if (d1Inventory === undefined) {
        const listed = runCommand({ command: 'node_modules/.bin/wrangler', args: ['d1', 'list', '--json'] });
        if (listed.status !== 0) throw new Error('Unable to inventory D1 before exact cleanup.');
        d1Inventory = listed.stdout;
      }
      d1Name = resolveD1NameByExactId(target, d1Inventory);
    }
    const command = automaticCleanupCommand(target, { d1Name });
    if (!command) {
      manual.push(target);
      continue;
    }
    const result = runCommand(command);
    if (result.status !== 0) {
      throw new Error(`Cleanup failed for ${target.provider}/${target.kind}/${target.id}.`);
    }
    // Verification is deliberately a separate inventory pass. The executor
    // cannot mark absence merely because a destructive command returned zero.
    completed.push(target);
  }
  return { targets, completed, manual };
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

async function cli() {
  const args = process.argv.slice(2);
  const ledgerPath = argument(args, '--ledger');
  if (!ledgerPath) throw new Error('Pass --ledger <path>. Cleanup targets never come from command-line names.');
  const apply = args.includes('--apply');
  const result = executeCleanup({ ledgerPath, apply });
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
