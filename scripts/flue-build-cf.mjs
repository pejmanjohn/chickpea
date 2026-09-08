#!/usr/bin/env node
/**
 * Validate the Cloudflare Vite artifact after `vite build` completes.
 *
 * Flue 2 and @cloudflare/vite-plugin own the build and deploy redirect. This
 * script deliberately performs no source renames, dependency patching, or
 * build mutation; it only proves that Wrangler will consume a real artifact
 * inside dist-cf and that the Node-only database entry stayed out of the
 * Cloudflare discovery path.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { builtWorkerConfigPath } from './lib/built-worker-config.mjs';

import {
  classifyCloudflareDeploymentProfile,
  resolveCloudflareDeploymentProfile,
} from './cloudflare-deployment-profile.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.length !== 3 || process.argv[2] !== '--validate-only') {
  console.error('Usage: npm run flue:build:cf (this validator is not a build command)');
  process.exit(2);
}

const configPath = builtWorkerConfigPath(projectRoot);

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const expectedProfile = resolveCloudflareDeploymentProfile();
const actualProfile = classifyCloudflareDeploymentProfile(config);
if (actualProfile !== expectedProfile) {
  throw new Error(
    `Cloudflare artifact profile mismatch: expected ${expectedProfile}, generated ${actualProfile}.`,
  );
}
if (typeof config.main !== 'string' || !existsSync(path.resolve(path.dirname(configPath), config.main))) {
  throw new Error('Cloudflare deploy config does not point at a built Worker entry.');
}
if (!existsSync(path.join(projectRoot, 'src', 'db.node.ts'))) {
  throw new Error('Node persistence entry src/db.node.ts is missing.');
}
if (existsSync(path.join(projectRoot, 'src', 'db.ts'))) {
  throw new Error('src/db.ts would be auto-discovered by the Cloudflare target.');
}
const authDb = config.d1_databases?.find((binding) => binding.binding === 'AUTH_DB');
if (!authDb || !String(authDb.migrations_dir ?? '').endsWith('migrations/better-auth')) {
  throw new Error('Cloudflare deploy config is missing AUTH_DB reviewed migrations.');
}
console.log(
  `Validated ${actualProfile} Cloudflare Vite artifact: ${path.relative(projectRoot, configPath)}`,
);
