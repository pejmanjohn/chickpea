#!/usr/bin/env node
/**
 * Immutable source export gate: proves that an archive of HEAD is what users
 * install from. Runs the same hygiene checks as `verify:hygiene` on the exact
 * commit (manifest policy, leak scan, archive bytes, release manifest,
 * lockfile, package metadata, authentication contract, npm pack manifest),
 * then, inside the extracted archive with no `.git` and an empty npm cache:
 * a strict lockfile install, the build, the full root/CLI suite, the offline
 * turn/durability/provider checks, and a deployment dry run. The full suite
 * runs exactly once per release, here.
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';
import { regressionEnvironment } from './verify-regression.mjs';
import { readBuildIdentity } from './lib/build-identity.mjs';
import { inspectSource } from './lib/source-export-policy.mjs';
import { formatHygieneReport } from './verify-hygiene.mjs';

assertNodeVersion(process.version, { baseline: true });

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const offlineVerificationEnv = {
  ...regressionEnvironment(),
  // This verifier proves the exported package works without external traffic.
  // Exercise the same public opt-out contract users can select at runtime.
  DO_NOT_TRACK: '1',
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? offlineVerificationEnv,
    stdio: 'inherit',
  });
  console.log(`# ${[command, ...args].join(' ')}: ${Math.round((Date.now() - started) / 1000)} s`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result;
}

let scratch;
let passed = false;
try {
  const inspection = inspectSource({ root: REPO_ROOT, revision: 'HEAD', keepScratch: true });
  console.log(formatHygieneReport(inspection, { revision: 'HEAD', workingTree: false }));
  if (!inspection.ok) fail('OSS export hygiene failed; fix the findings above (verify:hygiene reproduces them in seconds).');
  scratch = inspection.scratch;
  const { sourceCommit } = inspection;
  console.log(`SCRATCH=${scratch}`);
  if (readBuildIdentity(scratch).sourceCommit !== sourceCommit) {
    fail('Export must retain the exact verified source commit.');
  }

  run('npm', ['ci', '--strict-allow-scripts'], { cwd: scratch });
  // Artifact contracts must inspect a build of this archive, not skip because
  // dist-cf is absent in a fresh source checkout.
  run('npm', ['run', 'build'], { cwd: scratch });
  run('npm', ['run', 'test:ci'], {
    cwd: scratch,
    env: {
      ...offlineVerificationEnv,
      TAG_DB_PATH: ':memory:',
      SLACK_STATE_DB_PATH: ':memory:',
      CHICKPEA_AUTH_DB_PATH: ':memory:',
    },
  });
  run('node', ['scripts/verify-flue-offline-turn.mjs'], { cwd: scratch, env: offlineVerificationEnv });
  run('npm', ['run', 'verify:durability'], { cwd: scratch, env: offlineVerificationEnv });
  run('npm', ['run', 'verify:providers'], { cwd: scratch, env: offlineVerificationEnv });
  // The default source export is the slim core profile, so its full build and
  // Wrangler dry run must succeed without a Docker-specific escape hatch.
  run('npm', ['run', 'deploy', '--', '--dry-run'], { cwd: scratch });

  console.log('OSS export verification passed');
  passed = true;
} finally {
  if (!scratch) {
    // Hygiene failed before an archive was kept; nothing to preserve.
  } else if (passed && process.env.KEEP_EXPORT_SCRATCH !== '1') {
    rmSync(scratch, { recursive: true, force: true });
    console.log(`Cleaned SCRATCH=${scratch}`);
  } else {
    console.log(`Export scratch preserved at ${scratch}`);
  }
}
