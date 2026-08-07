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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedOutputRoot = path.join(projectRoot, 'dist-cf');
const redirectPath = path.join(projectRoot, '.wrangler', 'deploy', 'config.json');

if (process.argv.length !== 3 || process.argv[2] !== '--validate-only') {
  console.error('Usage: npm run flue:build:cf (this validator is not a build command)');
  process.exit(2);
}

if (!existsSync(redirectPath)) {
  throw new Error('Cloudflare build did not emit .wrangler/deploy/config.json.');
}

const redirect = JSON.parse(readFileSync(redirectPath, 'utf8'));
if (typeof redirect.configPath !== 'string' || redirect.configPath.length === 0) {
  throw new Error('Cloudflare deploy redirect has no configPath.');
}

const configPath = path.resolve(path.dirname(redirectPath), redirect.configPath);
const relativeConfig = path.relative(expectedOutputRoot, configPath);
if (
  relativeConfig === '..' ||
  relativeConfig.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativeConfig)
) {
  throw new Error(`Cloudflare deploy config escaped dist-cf: ${configPath}`);
}
if (!existsSync(configPath)) {
  throw new Error(`Cloudflare deploy config is missing: ${configPath}`);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (typeof config.main !== 'string' || !existsSync(path.resolve(path.dirname(configPath), config.main))) {
  throw new Error('Cloudflare deploy config does not point at a built Worker entry.');
}
if (!existsSync(path.join(projectRoot, 'src', 'db.node.ts'))) {
  throw new Error('Node persistence entry src/db.node.ts is missing.');
}
if (existsSync(path.join(projectRoot, 'src', 'db.ts'))) {
  throw new Error('src/db.ts would be auto-discovered by the Cloudflare target.');
}
const authGuard = config.durable_objects?.bindings?.find(
  (binding) => binding.name === 'AUTH_GUARD' && binding.class_name === 'AuthGuard',
);
if (!authGuard) throw new Error('Cloudflare deploy config is missing AUTH_GUARD/AuthGuard.');
const authDb = config.d1_databases?.find((binding) => binding.binding === 'AUTH_DB');
if (!authDb || !String(authDb.migrations_dir ?? '').endsWith('migrations/better-auth')) {
  throw new Error('Cloudflare deploy config is missing AUTH_DB reviewed migrations.');
}
const authMigration = config.migrations?.find((migration) => migration.tag === 'v7');
if (!authMigration?.new_sqlite_classes?.includes('AuthGuard')) {
  throw new Error('Cloudflare deploy config is missing the v7 AuthGuard migration.');
}

console.log(`Validated Cloudflare Vite artifact: ${path.relative(projectRoot, configPath)}`);
