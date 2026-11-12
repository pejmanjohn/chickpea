#!/usr/bin/env node
/**
 * Fail when one change grows the built Worker's static closure too much.
 *
 * The static closure is every chunk the Worker entry imports without
 * `import()`, followed transitively. A Durable Object activation that starts
 * an isolate loads all of it before its constructor runs, at roughly 0.1 s per
 * MiB, so this is a latency budget; the upload budget in verify-worker-size.mjs
 * is a platform limit. There is no ceiling on the total.
 *
 * A change may add GROWTH_ALLOWANCE_BYTES over its merge base
 * (scripts/lib/budget-growth.mjs), measured by building that commit in a
 * temporary export with this checkout's node_modules. So a dependency
 * upgrade's own growth is not counted. A base that does not build fails the
 * check with the build's output; when it cannot build with these
 * dependencies, CHICKPEA_BUDGET_UNBUILDABLE_BASE=1 skips the changes that
 * cannot be measured and checks the rest.
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
import { compareSizes, exportCommit, growthFailure, growthLine, growthPlan, short } from './lib/budget-growth.mjs';

const MIB = 1024 * 1024;
export const UNBUILDABLE_BASE_ENV = 'CHICKPEA_BUDGET_UNBUILDABLE_BASE';
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
    if (built.status !== 0) {
      const lockfile = spawnSync('git', ['-C', projectRoot, 'diff', '--quiet', commit, '--', 'package-lock.json']).status === 0
        ? 'the same as' : 'not';
      throw new Error(`Building ${short(commit)} to measure its closure failed. Its package-lock.json is ${lockfile} ` +
        `this checkout's, whose node_modules it built with.\n${built.stdout}${built.stderr}`);
    }
    return measureStaticClosure(path.dirname(builtWorkerConfigPath(directory)), BASE_REPORT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const mib = (bytes) => `${(bytes / MIB).toFixed(2)} MiB`;
const rowsBetween = (before, after) => before.modules && after.modules ? compareSizes(before.modules, after.modules).rows : undefined;

/**
 * Why the closure fails its budget, as messages: each change over its
 * allowance, and each change that could not be measured unless
 * `unbuildableBaseAllowed`. `plan` is growthPlan's. `at(commit)` measures a
 * commit, or the working tree when it is undefined, and throws when it
 * cannot. Each change's growth goes to `log`.
 */
export function closureFailures({ plan, at, unbuildableBaseAllowed = false, log = console.log }) {
  const failures = [];
  if (plan.skip) log(plan.skip);
  if (plan.error) failures.push(plan.error);
  if (plan.changes) log(`The merge base with ${plan.ref} is ${short(plan.base)}.`);
  for (const change of plan.changes ?? []) {
    let before;
    let after;
    try {
      before = at(change.from);
      after = at(change.to);
    } catch (error) {
      if (unbuildableBaseAllowed) {
        log(`Growth in ${change.label} is not checked, as ${UNBUILDABLE_BASE_ENV} is set. ${error.message}`);
      } else {
        failures.push(`Growth in ${change.label} could not be measured. ${error.message}\n` +
          `When that commit cannot build with this checkout's dependencies, as after a dependency upgrade, ` +
          `set ${UNBUILDABLE_BASE_ENV}=1 to check only the changes that can be measured.`);
      }
      continue;
    }
    const growth = after.bytes - before.bytes;
    log(growthLine(change, growth));
    if (growth > change.allowance) {
      failures.push(growthFailure({ what: 'The Worker static closure', change, ref: plan.ref, growth, rows: rowsBetween(before, after) }));
    }
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const stale = staleBuildReason(projectRoot);
  if (stale) {
    console.error(stale);
    process.exit(2);
  }
  const head = measureStaticClosure(path.dirname(builtWorkerConfigPath(projectRoot)));
  console.log(`Worker static closure: ${head.chunks.length} chunks, ${mib(head.bytes)}`);
  for (const chunk of head.chunks.slice(0, 8)) console.log(`  ${mib(chunk.bytes).padStart(10)}  ${chunk.file}`);

  // Each commit builds once, and a build that failed is not retried.
  const measured = new Map();
  const at = (commit) => {
    if (commit === undefined) return head;
    if (!measured.has(commit)) {
      try {
        measured.set(commit, { closure: measureCommit(projectRoot, commit) });
      } catch (error) {
        measured.set(commit, { error });
      }
    }
    const { closure, error } = measured.get(commit);
    if (error) throw error;
    return closure;
  };
  const failures = closureFailures({
    plan: growthPlan(projectRoot), at, unbuildableBaseAllowed: process.env[UNBUILDABLE_BASE_ENV] === '1',
  });
  for (const failure of failures) console.error(`\n${failure}`);
  if (failures.length > 0) process.exit(1);
}
