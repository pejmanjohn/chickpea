#!/usr/bin/env node
/**
 * Build the Cloudflare target from the same checkout as the Node target.
 *
 * Why this script exists: the flue CLI discovers `src/db.ts` purely by
 * filename convention (`discoverOptionalEntry(sourceRoot, 'db')`) and the
 * Cloudflare plugin hard-rejects the build when it is present ("Custom
 * persistence (db.ts) is not supported on the Cloudflare target"). The config
 * surface (@flue/cli 1.0.0-beta.8 and beta.9) is exactly {target, root,
 * output} — there is no per-target config, no function-form config, and no
 * db-path option. Building with an alternate `--root` is not viable either:
 * the Cloudflare vite root equals the flue root, so `.wrangler/deploy/config.json`
 * (the redirect that lets plain `npx wrangler deploy` work) would land inside
 * the alternate root instead of the project root.
 *
 * So: park src/db.ts under a non-discoverable name for the duration of the
 * build, and ALWAYS restore it (finally + signal handlers).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(projectRoot, 'src', 'db.ts');

// Preserve the operator's local dev secrets across rebuilds. The flue build
// wipes the output dir, which is where the documented `wrangler dev` loop keeps
// its `.dev.vars` (next to the emitted wrangler.json, at
// <output>/chickpea/.dev.vars). Snapshot it before the build and restore it
// after so a rebuild never deletes the secrets file. `--output` is parsed from
// the same argv forwarded to flue (defaults to the committed dist-cf).
const forwardedArgs = process.argv.slice(2);
const outputArgIndex = forwardedArgs.indexOf('--output');
const outputDir =
  outputArgIndex >= 0 && forwardedArgs[outputArgIndex + 1]
    ? forwardedArgs[outputArgIndex + 1]
    : 'dist-cf';
const devVarsFile = path.join(projectRoot, outputDir, 'chickpea', '.dev.vars');
const devVarsSnapshot = existsSync(devVarsFile) ? readFileSync(devVarsFile) : undefined;

function restoreDevVars() {
  // Only rewrite when the build removed it: never clobber a fresher file the
  // build (or the operator) just wrote.
  if (devVarsSnapshot !== undefined && !existsSync(devVarsFile)) {
    mkdirSync(path.dirname(devVarsFile), { recursive: true });
    writeFileSync(devVarsFile, devVarsSnapshot);
  }
}
// ".node-lane" is not one of the extensions flue discovers (ts|mts|js|mjs),
// is not compiled by tsc, and is not importable — invisible to the CF build.
const parkedFile = path.join(projectRoot, 'src', 'db.ts.node-lane');

if (existsSync(parkedFile) && existsSync(dbFile)) {
  console.error(
    '[flue-build-cf] Both src/db.ts and src/db.ts.node-lane exist. ' +
      'A previous run was interrupted mid-restore; reconcile manually.',
  );
  process.exit(1);
}

// Recover from a previously crashed run that left db.ts parked.
if (existsSync(parkedFile) && !existsSync(dbFile)) {
  renameSync(parkedFile, dbFile);
  console.error('[flue-build-cf] Restored src/db.ts from a previous interrupted run.');
}

let parked = false;
function park() {
  if (existsSync(dbFile)) {
    renameSync(dbFile, parkedFile);
    parked = true;
  }
}
function restore() {
  if (parked && existsSync(parkedFile)) {
    renameSync(parkedFile, dbFile);
    parked = false;
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    restoreDevVars();
    process.exit(1);
  });
}
process.on('exit', () => {
  restore();
  restoreDevVars();
});

// Invoke the flue CLI bin directly with the current node — works whether or
// not node_modules/.bin is on PATH (npm scripts vs. direct `node scripts/...`).
const flueBin = path.join(projectRoot, 'node_modules', '@flue', 'cli', 'bin', 'flue.mjs');

let status = 1;
try {
  park();
  const result = spawnSync(
    process.execPath,
    [flueBin, 'build', '--target', 'cloudflare', ...process.argv.slice(2)],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  if (result.error) console.error('[flue-build-cf]', result.error);
  status = result.status ?? 1;
} finally {
  restore();
  restoreDevVars();
}
process.exit(status);
