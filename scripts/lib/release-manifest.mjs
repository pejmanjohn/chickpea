import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const CONFIG_STORAGE_CONTRACT = 'src/config/storage-contract.json';

const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value);

/**
 * The config store's explicit storage contract, as data: whitespace, key order
 * and every code-only edit to `store.ts` leave it unchanged. A source tree from
 * before the contract existed declared the whole of `store.ts` instead.
 */
function configurationDigest(root) {
  const contract = join(root, CONFIG_STORAGE_CONTRACT);
  if (!existsSync(contract)) return hash(readFileSync(join(root, 'src/config/store.ts')));
  return hash(JSON.stringify(canonical(JSON.parse(readFileSync(contract, 'utf8')))));
}

export function migrationDigests(root) {
  const fileHash = (name) => hash(readFileSync(join(root, name)));
  const directory = 'migrations/better-auth';
  const files = readdirSync(join(root, directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!files.length) throw new Error('Missing D1 migration chain.');
  return {
    d1: hash(JSON.stringify(files.map((name) => [name, fileHash(`${directory}/${name}`)]))),
    // Include all authored configuration, conservatively requiring review even
    // when a non-migration configuration edit changes the digest.
    workerConfiguration: fileHash('wrangler.jsonc'),
    identity: fileHash('src/identity/migrations.ts'),
    configuration: configurationDigest(root),
    work: fileHash('src/work/migrations.ts'),
  };
}

export function validateReleaseManifest(root, supplied) {
  const manifest = supplied ?? JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (!manifest || manifest.formatVersion !== 1 || !Number.isSafeInteger(manifest.storageGeneration) || manifest.storageGeneration < 1) {
    throw new Error('Invalid release manifest format or storage generation.');
  }
  if (!STABLE_VERSION.test(manifest.version) || [pkg.version, lock.version, lock.packages?.['']?.version].some((version) => version !== manifest.version)) {
    throw new Error('Release, package, and lockfile version must match.');
  }
  if (!Array.isArray(manifest.supportedOrigins) || new Set(manifest.supportedOrigins).size !== manifest.supportedOrigins.length ||
      manifest.supportedOrigins.some((origin) => typeof origin !== 'string' || !STABLE_VERSION.test(origin) || compareVersions(origin, manifest.version) >= 0)) {
    throw new Error('Invalid supported release origin.');
  }
  const expected = migrationDigests(root);
  if (!manifest.migrations || Object.keys(manifest.migrations).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([name, digest]) => manifest.migrations[name] !== digest)) {
    throw new Error('Release migration digests do not match source. Review compatibility before updating them.');
  }
  return manifest;
}

export function compareVersions(left, right) {
  if (!STABLE_VERSION.test(left) || !STABLE_VERSION.test(right)) throw new Error('Invalid stable version.');
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
