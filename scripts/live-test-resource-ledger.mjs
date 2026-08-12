#!/usr/bin/env node
/**
 * Exact-ID resource ledger for disposable Chickpea acceptance runs.
 *
 * The file is append-only JSONL. Cleanup tools must consume cleanupPlan() and
 * must record an exact provider verification after every deletion/archive.
 * Display names are evidence only and can never identify a cleanup target.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_SCHEMA = 'chickpea-live-resource-ledger/v1';
const RESOURCE_KINDS = new Set([
  'worker', 'd1', 'slack_app', 'slack_channel', 'capture_worker', 'capture_store',
  'build_connection', 'generated_repository', 'container_app', 'container_image',
]);
const PROVIDERS = new Set(['cloudflare', 'slack', 'github']);
const ID_PATTERNS = new Map([
  ['cloudflare:worker', /^[a-z0-9][a-z0-9_-]{0,62}$/],
  ['cloudflare:capture_worker', /^[a-z0-9][a-z0-9_-]{0,62}$/],
  ['cloudflare:d1', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i],
  ['cloudflare:capture_store', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i],
  ['cloudflare:container_app', /^[A-Za-z0-9][A-Za-z0-9._:-]{2,511}$/],
  ['cloudflare:container_image', /^[A-Za-z0-9][A-Za-z0-9._/@:-]{2,511}$/],
  ['slack:slack_app', /^A[A-Z0-9]+$/],
  ['slack:slack_channel', /^C[A-Z0-9]+$/],
  ['github:generated_repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/],
]);
const FORBIDDEN_KEY = /(secret|token|password|credential|authorization|cookie|raw(?:Body|Prompt)?)/i;
const CLEANUP_PRIORITY = new Map([
  ['cloudflare:worker', 10],
  ['cloudflare:capture_worker', 10],
  ['cloudflare:container_app', 20],
  ['cloudflare:container_image', 30],
  ['cloudflare:d1', 40],
  ['cloudflare:capture_store', 40],
  ['slack:slack_app', 50],
  ['slack:slack_channel', 60],
  ['cloudflare:build_connection', 70],
  ['github:generated_repository', 80],
]);

export function createLedger(pathInput, { runId = `agent-first-${randomUUID()}`, now = Date.now() } = {}) {
  const path = resolve(pathInput);
  if (existsSync(path)) throw new Error(`Ledger already exists: ${path}`);
  writeFileSync(path, `${JSON.stringify({ schema: LEDGER_SCHEMA, type: 'run', runId, at: now })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return { path, runId };
}

export function appendLedgerEvent(pathInput, event) {
  const path = resolve(pathInput);
  const ledger = readLedger(path);
  const normalized = validateEvent({ ...event, runId: ledger.runId });
  appendFileSync(path, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600 });
  return normalized;
}

export function readLedger(pathInput) {
  const path = resolve(pathInput);
  if (!existsSync(path)) throw new Error(`Ledger not found: ${path}`);
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('Ledger is empty.');
  const events = lines.map((line, index) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { throw new Error(`Invalid ledger JSON at line ${index + 1}.`); }
    rejectSecrets(parsed);
    return parsed;
  });
  const head = events[0];
  if (head?.schema !== LEDGER_SCHEMA || head.type !== 'run' || !isExactId(head.runId)) {
    throw new Error('Ledger header is invalid.');
  }
  if (events.some((event) => event.runId !== head.runId)) throw new Error('Ledger contains a foreign run event.');
  return { path, runId: head.runId, events };
}

export function cleanupPlan(pathInput) {
  const ledger = readLedger(pathInput);
  const resources = new Map();
  const verified = new Set();
  for (const event of ledger.events) {
    if (event.type === 'resource') resources.set(resourceKey(event), event);
    if (event.type === 'cleanup_verified') verified.add(resourceKey(event));
  }
  const targets = [];
  for (const resource of resources.values()) {
    if (verified.has(resourceKey(resource))) continue;
    assertCleanupEligible(resource);
    targets.push({
      provider: resource.provider,
      kind: resource.kind,
      id: resource.id,
      action: resource.kind === 'slack_channel' ? 'archive' : 'delete',
      ...(resource.name ? { name: resource.name } : {}),
    });
  }
  return targets.sort((a, b) =>
    (CLEANUP_PRIORITY.get(`${a.provider}:${a.kind}`) ?? 999) -
      (CLEANUP_PRIORITY.get(`${b.provider}:${b.kind}`) ?? 999) ||
    resourceKey(a).localeCompare(resourceKey(b)));
}

export function compareInventory(pathInput, finalInventory) {
  const ledger = readLedger(pathInput);
  const authorizedBaselineCleanup = new Set(
    ledger.events
      .filter((event) => event.type === 'resource' && event.ownedByRun === false &&
        event.baselineAuthorizedChickpeaCleanup === true)
      .map(resourceKey),
  );
  const baselines = ledger.events.filter((event) =>
    event.type === 'baseline' && !authorizedBaselineCleanup.has(resourceKey(event)));
  const actual = normalizeInventory(finalInventory);
  const expected = normalizeInventory(baselines.map(({ provider, kind, id }) => ({ provider, kind, id })));
  const missing = expected.filter((item) => !actual.some((candidate) => resourceKey(candidate) === resourceKey(item)));
  const unexpected = actual.filter((item) => !expected.some((candidate) => resourceKey(candidate) === resourceKey(item)));
  return { equal: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

export function recordResource(path, input) {
  return appendLedgerEvent(path, {
    type: 'resource', at: input.at ?? Date.now(), provider: input.provider, kind: input.kind,
    id: input.id, ownedByRun: input.ownedByRun === true,
    baselineAuthorizedChickpeaCleanup: input.baselineAuthorizedChickpeaCleanup === true,
    ...(input.name ? { name: input.name } : {}),
  });
}

export function recordBaseline(path, input) {
  return appendLedgerEvent(path, {
    type: 'baseline', at: input.at ?? Date.now(), provider: input.provider, kind: input.kind,
    id: input.id, ...(input.name ? { name: input.name } : {}),
  });
}

export function recordCleanupVerified(path, input) {
  const ledger = readLedger(path);
  const target = ledger.events.find((event) => event.type === 'resource' &&
    event.provider === input.provider && event.kind === input.kind && event.id === input.id);
  if (!target) throw new Error('Cleanup verification does not match a recorded resource.');
  return appendLedgerEvent(path, {
    type: 'cleanup_verified', at: input.at ?? Date.now(), provider: input.provider,
    kind: input.kind, id: input.id, outcome: 'absent',
  });
}

function validateEvent(event) {
  rejectSecrets(event);
  if (!isExactId(event.runId)) throw new Error('Event requires an exact run ID.');
  if (!['baseline', 'resource', 'cleanup_verified', 'note'].includes(event.type)) {
    throw new Error(`Unsupported ledger event: ${String(event.type)}`);
  }
  if (event.type === 'note') return event;
  validateCoordinate(event);
  if (event.type === 'resource' && typeof event.ownedByRun !== 'boolean') {
    throw new Error('Resource ownership must be explicit.');
  }
  if (event.type === 'cleanup_verified' && event.outcome !== 'absent') {
    throw new Error('Cleanup is verified only by exact absence.');
  }
  return event;
}

function validateCoordinate(value) {
  if (!PROVIDERS.has(value.provider)) throw new Error(`Unsupported provider: ${String(value.provider)}`);
  if (!RESOURCE_KINDS.has(value.kind)) throw new Error(`Unsupported resource kind: ${String(value.kind)}`);
  if (!isExactId(value.id)) throw new Error('Cleanup targets require an immutable exact provider ID.');
  const expected = ID_PATTERNS.get(`${value.provider}:${value.kind}`);
  if (expected && !expected.test(value.id)) {
    throw new Error('Cleanup targets require an immutable exact provider ID.');
  }
}

function assertCleanupEligible(resource) {
  validateCoordinate(resource);
  if (resource.ownedByRun === true) return;
  if (resource.provider === 'slack' && resource.kind === 'slack_app' &&
      resource.baselineAuthorizedChickpeaCleanup === true) return;
  throw new Error(`Refusing to clean baseline/unowned resource ${resourceKey(resource)}.`);
}

function normalizeInventory(items) {
  if (!Array.isArray(items)) throw new Error('Inventory must be an array.');
  return items.map((item) => {
    validateCoordinate(item);
    return { provider: item.provider, kind: item.kind, id: item.id };
  }).sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)));
}

function resourceKey(value) {
  return `${value.provider}:${value.kind}:${value.id}`;
}

function isExactId(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 512 &&
    !/[\s*?\[\]{}]/u.test(value) && !value.startsWith('-') && value !== '.' && value !== '..';
}

function rejectSecrets(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEY.test(key)) throw new Error(`Secret-bearing ledger field is forbidden: ${childPath}`);
    if (typeof child === 'string' && /^(?:xox[baprs]-|sk-|Bearer\s)/i.test(child)) {
      throw new Error(`Secret-like ledger value is forbidden: ${childPath}`);
    }
    rejectSecrets(child, childPath);
  }
}

function value(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];
  const path = value(args, '--ledger');
  if (!path) throw new Error('Pass --ledger <absolute-or-relative-path>.');
  if (command === 'create') {
    console.log(JSON.stringify(createLedger(path, { ...(value(args, '--run-id') ? { runId: value(args, '--run-id') } : {}) })));
    return;
  }
  if (command === 'plan') {
    console.log(JSON.stringify(cleanupPlan(path), null, 2));
    return;
  }
  throw new Error('Usage: live-test-resource-ledger.mjs <create|plan> --ledger <path> [--run-id <id>]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
