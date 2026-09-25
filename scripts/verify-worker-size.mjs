#!/usr/bin/env node
/**
 * Fail the Cloudflare build when the Worker upload outgrows its budget.
 *
 * Cloudflare enforces the limit on the uncompressed ("Total Upload") size of
 * every uploaded module (JavaScript chunks and wasm) — Static Assets are not
 * counted. The platform-wide limit is 64 MiB across all plans (raised from
 * the older 3 MiB Free / 10 MiB Paid gzip limits; see the Cloudflare
 * changelog, 2026-09-04). The budget below keeps deliberate headroom so an
 * ordinary feature does not silently push a build toward the platform
 * ceiling; raise it only with a matching README change. Gzip size is still
 * printed for information, since it is a useful proxy for download/parse
 * cost, but it is no longer what Cloudflare gates on.
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { builtWorkerConfigPath } from './lib/built-worker-config.mjs';

const KIB = 1024;
const MIB = 1024 * KIB;
export const WORKER_UPLOAD_LIMIT_BYTES = 64 * MIB;
export const WORKER_SIZE_BUDGET_BYTES = 32 * MIB;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function measureWorkerModules(directory = path.dirname(builtWorkerConfigPath(projectRoot))) {
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
  const workerDir = path.dirname(builtWorkerConfigPath(projectRoot));
  const { modules, gzip, raw } = measureWorkerModules(workerDir);
  if (modules.length === 0) {
    console.error(`No Worker modules found under ${path.relative(projectRoot, workerDir)}; run the build first.`);
    process.exit(2);
  }
  console.log(`Worker upload: ${modules.length} modules, ${kib(raw)} raw, ${kib(gzip)} gzip`);
  console.log(`Budget ${kib(WORKER_SIZE_BUDGET_BYTES)} (Cloudflare upload limit ${kib(WORKER_UPLOAD_LIMIT_BYTES)})`);
  for (const module of modules.slice(0, 8)) {
    console.log(`  ${kib(module.gzip).padStart(9)}  ${module.path}`);
  }
  if (raw > WORKER_SIZE_BUDGET_BYTES) {
    console.error(
      `Worker upload is ${kib(raw - WORKER_SIZE_BUDGET_BYTES)} over budget. ` +
      'Move browser code to Static Assets, drop the dependency, or raise the budget deliberately.',
    );
    process.exit(1);
  }
}
