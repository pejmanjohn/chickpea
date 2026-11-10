#!/usr/bin/env node
/**
 * Fail when the built Worker's static closure grows too much.
 *
 * The static closure is every chunk the Worker entry imports without
 * `import()`, followed transitively. A Durable Object activation that starts
 * an isolate loads all of it before its constructor runs, at roughly 0.1 s per
 * MiB, so this is a latency budget; the upload budget in verify-worker-size.mjs
 * is a platform limit.
 *
 * Two checks. A change may add GROWTH_ALLOWANCE_BYTES over its merge base
 * (scripts/lib/budget-growth.mjs), measured by building that commit in a
 * temporary export. The ceiling backstops the total: set it to the measured
 * size plus 64 KiB once per merge train, and lower it when a change moves
 * code behind `import()`.
 *
 * Reads the build in dist-cf, which must be of this checkout. Its builds run
 * inside verify:regression's host reservation; standalone, wrap it in
 * `npm run verify:host --`.
 */
import { existsSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { builtWorkerConfigPath, staleBuildReason } from './lib/built-worker-config.mjs';
import { compareSizes, exportCommit, formatGrowth, growthFailure, growthPlan, kib, short } from './lib/budget-growth.mjs';

const MIB = 1024 * 1024;
export const WORKER_STATIC_CLOSURE_CEILING_BYTES = Math.round(7.75 * MIB);
const ENTRY = 'virtual:cloudflare/worker-entry';
const BASE_REPORT = 'budget-modules.json';

/**
 * The entry's static chunks, largest first, from the build's Vite manifest,
 * and the modules in them by rendered length when `report` records each
 * module's chunk.
 */
export function measureStaticClosure(directory, report = 'bundle-modules.json') {
  const manifest = JSON.parse(readFileSync(path.join(directory, '.vite', 'manifest.json'), 'utf8'));
  if (!manifest[ENTRY]) throw new Error(`The Vite manifest in ${directory} has no ${ENTRY} entry.`);
  const seen = new Set();
  const pending = [ENTRY];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(...(manifest[key].imports ?? []));
  }
  const chunks = [...seen]
    .map((key) => ({ file: manifest[key].file, bytes: statSync(path.join(directory, manifest[key].file)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  return { chunks, bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), modules: closureModules(directory, report, chunks) };
}

function closureModules(directory, report, chunks) {
  const file = path.join(directory, report);
  if (!existsSync(file)) return undefined;
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  if (entries.some((entry) => entry.chunk === undefined)) return undefined;
  const files = new Set(chunks.map((chunk) => chunk.file));
  const modules = new Map();
  for (const { id, renderedLength, chunk } of entries) {
    if (files.has(chunk)) modules.set(id, (modules.get(id) ?? 0) + renderedLength);
  }
  return modules;
}

/** Builds `commit` in a temporary export with this checkout's dependencies and measures its closure. */
export function measureCommit(projectRoot, commit) {
  const directory = exportCommit(projectRoot, commit);
  try {
    symlinkSync(path.join(projectRoot, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    const built = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/lib/build-worker-report.mjs'), BASE_REPORT], {
      cwd: directory, encoding: 'utf8', maxBuffer: 64 * MIB,
    });
    if (built.status !== 0) throw new Error(`Building ${short(commit)} to measure its closure failed:\n${built.stdout}${built.stderr}`);
    return measureStaticClosure(path.dirname(builtWorkerConfigPath(directory)), BASE_REPORT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const mib = (bytes) => `${(bytes / MIB).toFixed(2)} MiB`;
const rowsBetween = (before, after) => before.modules && after.modules ? compareSizes(before.modules, after.modules).rows : undefined;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const stale = staleBuildReason(projectRoot);
  if (stale) {
    console.error(stale);
    process.exit(2);
  }
  const head = measureStaticClosure(path.dirname(builtWorkerConfigPath(projectRoot)));
  console.log(`Worker static closure: ${head.chunks.length} chunks, ${mib(head.bytes)} (ceiling ${mib(WORKER_STATIC_CLOSURE_CEILING_BYTES)})`);
  for (const chunk of head.chunks.slice(0, 8)) console.log(`  ${mib(chunk.bytes).padStart(10)}  ${chunk.file}`);

  const failures = [];
  const plan = growthPlan(projectRoot);
  let sinceBase;
  if (plan.skip) {
    console.log(plan.skip);
  } else {
    const measured = new Map();
    const at = (commit) => {
      if (commit === undefined) return head;
      if (!measured.has(commit)) measured.set(commit, measureCommit(projectRoot, commit));
      return measured.get(commit);
    };
    for (const change of plan.changes) {
      const before = at(change.from);
      const after = at(change.to);
      const growth = after.bytes - before.bytes;
      const rows = rowsBetween(before, after);
      console.log(`Growth in ${change.label} since ${short(change.from)}: ${kib(growth)} (allowed ${kib(change.allowance)})`);
      if (growth > change.allowance) {
        failures.push(growthFailure({ what: 'The Worker static closure', change, ref: plan.ref, growth, rows }));
      }
    }
    sinceBase = rowsBetween(at(plan.base), head);
  }
  if (head.bytes > WORKER_STATIC_CLOSURE_CEILING_BYTES) {
    failures.push(
      `The static closure is ${mib(head.bytes - WORKER_STATIC_CLOSURE_CEILING_BYTES)} over its ceiling.` +
      (sinceBase ? `\nModules that grew since the merge base:\n${formatGrowth(sinceBase)}` : '') +
      '\nLoad the new code with import() where it is used. Once per merge train, the ceiling in ' +
      'scripts/worker-closure.mjs may be set to the measured size plus 64 KiB.',
    );
  }
  for (const failure of failures) console.error(`\n${failure}`);
  if (failures.length > 0) process.exit(1);
}
