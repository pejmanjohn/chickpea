#!/usr/bin/env node
/**
 * Fail the Cloudflare build when the compressed Worker outgrows its budget.
 *
 * Cloudflare enforces the limit on the gzip size of every uploaded module
 * (JavaScript chunks and wasm) — Static Assets are not counted. Workers Free
 * allows 3 MiB. The budget below keeps headroom so an ordinary feature does
 * not silently push a fresh install onto Workers Paid; raise it only with a
 * matching README change.
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const KIB = 1024;
export const WORKERS_FREE_LIMIT_BYTES = 3 * KIB * KIB;
export const WORKER_SIZE_BUDGET_BYTES = 2_800 * KIB;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = path.join(projectRoot, 'dist-cf', 'chickpea');

export function measureWorkerModules(directory = workerDir) {
  const modules = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!/\.(m?js|wasm)$/.test(entry.name)) continue;
      const bytes = readFileSync(absolute);
      modules.push({
        path: path.relative(directory, absolute),
        raw: statSync(absolute).size,
        gzip: gzipSync(bytes, { level: 9 }).length,
      });
    }
  };
  visit(directory);
  modules.sort((a, b) => b.gzip - a.gzip);
  return {
    modules,
    gzip: modules.reduce((sum, module) => sum + module.gzip, 0),
    raw: modules.reduce((sum, module) => sum + module.raw, 0),
  };
}

const kib = (bytes) => `${(bytes / KIB).toFixed(0)} KiB`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { modules, gzip, raw } = measureWorkerModules();
  if (modules.length === 0) {
    console.error(`No Worker modules found under ${path.relative(projectRoot, workerDir)}; run the build first.`);
    process.exit(2);
  }
  console.log(`Worker upload: ${modules.length} modules, ${kib(raw)} raw, ${kib(gzip)} gzip`);
  console.log(`Budget ${kib(WORKER_SIZE_BUDGET_BYTES)} (Workers Free limit ${kib(WORKERS_FREE_LIMIT_BYTES)})`);
  for (const module of modules.slice(0, 8)) {
    console.log(`  ${kib(module.gzip).padStart(9)}  ${module.path}`);
  }
  if (gzip > WORKER_SIZE_BUDGET_BYTES) {
    console.error(
      `Compressed Worker is ${kib(gzip - WORKER_SIZE_BUDGET_BYTES)} over budget. ` +
      'Move browser code to Static Assets, drop the dependency, or raise the budget deliberately.',
    );
    process.exit(1);
  }
}
