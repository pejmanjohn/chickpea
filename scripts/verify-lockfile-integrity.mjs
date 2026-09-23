#!/usr/bin/env node
/**
 * Fail when any package-lock entry lacks a Subresource Integrity hash.
 *
 * `npm ci` only verifies a downloaded tarball against `integrity`. An entry
 * without one is fetched and installed on trust: a republished version, a
 * compromised registry, or a substituting proxy produces different bytes and
 * nothing notices. For a project whose whole proposition is "you self-host it
 * in your own account", every byte that reaches the deployed Worker should be
 * pinned by hash. `verify:hygiene` runs the same check; this command remains
 * for standalone use.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { lockfileIntegrityReport } from './lib/lockfile-integrity.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let report;
try {
  report = lockfileIntegrityReport(path.join(projectRoot, 'package-lock.json'));
} catch (error) {
  console.error(`Unable to verify package-lock.json: ${error.message}`);
  process.exit(1);
}

if (report.unverified.length === 0) {
  process.stdout.write(`All ${report.total} package-lock entries carry an integrity hash.\n`);
  process.exit(0);
}

console.error(
  `${report.unverified.length} of ${report.total} package-lock entries have no ` +
  'integrity hash, so `npm ci` installs them without verifying what it downloaded:\n',
);
for (const name of report.unverified.slice(0, 20)) console.error(`  ${name}`);
if (report.unverified.length > 20) console.error(`  ... and ${report.unverified.length - 20} more`);
console.error(
  '\nRegenerate the lockfile (rm package-lock.json && npm install --package-lock-only),\n' +
  'review the resulting dependency version changes deliberately, then re-run the suite.\n',
);
process.exit(1);
