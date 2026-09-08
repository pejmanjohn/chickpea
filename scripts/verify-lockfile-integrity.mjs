#!/usr/bin/env node
/**
 * Fail when any package-lock entry lacks a Subresource Integrity hash.
 *
 * `npm ci` only verifies a downloaded tarball against `integrity`. An entry
 * without one is fetched and installed on trust: a republished version, a
 * compromised registry, or a substituting proxy produces different bytes and
 * nothing notices. For a project whose whole proposition is "you self-host it
 * in your own account", every byte that reaches the deployed Worker should be
 * pinned by hash.
 *
 * Entries legitimately without a resolved tarball are exempt: the root project,
 * workspace links, and anything npm marked as shipping inside a parent's
 * tarball (`inBundle`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(projectRoot, 'package-lock.json');

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, 'utf8'));
} catch (error) {
  console.error(`Unable to read package-lock.json: ${error.message}`);
  process.exit(1);
}

if (lock.lockfileVersion < 2) {
  console.error(
    `package-lock.json is lockfileVersion ${lock.lockfileVersion}; ` +
    'integrity verification needs version 2 or newer.',
  );
  process.exit(1);
}

const packages = lock.packages ?? {};
const unverified = [];
for (const [name, meta] of Object.entries(packages)) {
  if (name === '') continue;
  if (meta.link || meta.inBundle) continue;
  // A workspace package's own entry (e.g. `packages/cli`) is local source,
  // not a downloaded tarball; its `node_modules/<name>` link is exempt above.
  if (!name.startsWith('node_modules/') && !name.includes('/node_modules/')) continue;
  if (typeof meta.integrity === 'string' && meta.integrity.length > 0) continue;
  unverified.push(name);
}

if (unverified.length === 0) {
  const total = Object.keys(packages).length - 1;
  process.stdout.write(`All ${total} package-lock entries carry an integrity hash.\n`);
  process.exit(0);
}

unverified.sort();
console.error(
  `${unverified.length} of ${Object.keys(packages).length - 1} package-lock entries have no ` +
  'integrity hash, so `npm ci` installs them without verifying what it downloaded:\n',
);
for (const name of unverified.slice(0, 20)) console.error(`  ${name}`);
if (unverified.length > 20) console.error(`  ... and ${unverified.length - 20} more`);
console.error(
  '\nRegenerate the lockfile (rm package-lock.json && npm install --package-lock-only),\n' +
  'review the resulting dependency version changes deliberately, then re-run the suite.\n',
);
process.exit(1);
