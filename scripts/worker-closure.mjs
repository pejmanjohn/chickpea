#!/usr/bin/env node
/**
 * Fail when the built Worker's static closure outgrows its ceiling.
 *
 * The static closure is every chunk the Worker entry imports without
 * `import()`, followed transitively. A Durable Object activation that starts
 * an isolate loads all of it before its constructor runs, at roughly 0.1 s per
 * MiB, so this ceiling is a latency budget; the upload budget in
 * verify-worker-size.mjs is a platform limit. Lower the ceiling when a change
 * moves code behind `import()`; raise it only deliberately.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { builtWorkerConfigPath } from './lib/built-worker-config.mjs';

const MIB = 1024 * 1024;
export const WORKER_STATIC_CLOSURE_CEILING_BYTES = Math.round(10.3 * MIB);
const ENTRY = 'virtual:cloudflare/worker-entry';

/** The entry's static chunks, largest first, from the build's Vite manifest. */
export function measureStaticClosure(directory) {
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
  return { chunks, bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) };
}

const mib = (bytes) => `${(bytes / MIB).toFixed(2)} MiB`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { chunks, bytes } = measureStaticClosure(path.dirname(builtWorkerConfigPath(projectRoot)));
  console.log(`Worker static closure: ${chunks.length} chunks, ${mib(bytes)} (ceiling ${mib(WORKER_STATIC_CLOSURE_CEILING_BYTES)})`);
  for (const chunk of chunks.slice(0, 8)) console.log(`  ${mib(chunk.bytes).padStart(10)}  ${chunk.file}`);
  if (bytes > WORKER_STATIC_CLOSURE_CEILING_BYTES) {
    console.error(
      `The static closure is ${mib(bytes - WORKER_STATIC_CLOSURE_CEILING_BYTES)} over its ceiling. ` +
      'Load the new code with import() where it is used, or raise the ceiling in scripts/worker-closure.mjs deliberately.',
    );
    process.exit(1);
  }
}
