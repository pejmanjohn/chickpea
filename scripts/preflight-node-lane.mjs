#!/usr/bin/env node
/**
 * Node-lane preflight shared by `npm test` (via `pretest`) and
 * `npm run flue:build`.
 *
 * The Cloudflare build (scripts/flue-build-cf.mjs) PARKS src/db.ts as
 * src/db.ts.node-lane for the duration of the build and restores it in a
 * finally + signal handlers. If that build is interrupted uncleanly (a `kill
 * -9`, an OOM, a crashed CI runner), db.ts stays parked — and then the node
 * lane fails with a confusing "cannot find module ./db.ts" deep in the flue
 * build or the tsc run. This guard turns that into ONE loud line with the
 * recovery command, before either the build or the test suite starts.
 *
 * `--root <dir>` overrides the project root (used by the regression test); it
 * defaults to this script's parent, the repo root.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArgIndex = process.argv.indexOf('--root');
const projectRoot =
  rootArgIndex >= 0 && process.argv[rootArgIndex + 1]
    ? path.resolve(process.argv[rootArgIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const parkedFile = path.join(projectRoot, 'src', 'db.ts.node-lane');

if (existsSync(parkedFile)) {
  console.error(
    '[preflight] src/db.ts is parked as src/db.ts.node-lane (an interrupted Cloudflare build). ' +
      'Recover: `mv src/db.ts.node-lane src/db.ts` (delete whichever copy is stale if both exist), then re-run.',
  );
  process.exit(1);
}

const packagePath = path.join(projectRoot, 'package.json');
const lockPath = path.join(projectRoot, 'package-lock.json');
if (existsSync(packagePath) && existsSync(lockPath)) {
  verifyPiDependencyBoundary(packagePath, lockPath);
}

function verifyPiDependencyBoundary(packagePath, lockPath) {
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const dependencyName = '@earendil-works/pi-ai';
  const directPin = manifest.dependencies?.[dependencyName];
  if (!isExactVersion(directPin)) {
    fail(`package.json must pin ${dependencyName} to one exact version; found ${String(directPin)}.`);
  }
  if (manifest.overrides?.[dependencyName] !== undefined) {
    fail(`${dependencyName} must not use an npm override; Flue owns the qualified version range.`);
  }

  const installed = Object.entries(lock.packages ?? {})
    .filter(([packageKey]) => packageKey.endsWith(`node_modules/${dependencyName}`))
    .map(([packageKey, value]) => ({ packageKey, version: value?.version }));
  if (installed.length !== 1) {
    fail(`expected one installed Pi copy, found ${installed.length}.`);
  }
  const resolvedVersion = installed[0]?.version;
  if (directPin !== resolvedVersion) {
    fail(`direct pin ${directPin} does not match the resolved version ${String(resolvedVersion)}.`);
  }

  const flueRange = lock.packages?.['node_modules/@flue/runtime']?.dependencies?.[dependencyName];
  if (!isSupportedByRange(directPin, flueRange)) {
    fail(`direct Pi pin ${directPin} is outside Flue's declared range ${String(flueRange)}.`);
  }
}

function isExactVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function isSupportedByRange(version, range) {
  if (typeof range !== 'string') return false;
  if (range === version) return true;
  const match = range.match(/^([~^])(\d+)\.(\d+)\.(\d+)$/);
  const parsed = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match || !parsed) return false;
  const [, operator, rangeMajorText, rangeMinorText, rangePatchText] = match;
  const [, majorText, minorText, patchText] = parsed;
  const candidate = [Number(majorText), Number(minorText), Number(patchText)];
  const floor = [Number(rangeMajorText), Number(rangeMinorText), Number(rangePatchText)];
  if (compareVersions(candidate, floor) < 0) return false;
  if (operator === '~') return candidate[0] === floor[0] && candidate[1] === floor[1];
  if (floor[0] > 0) return candidate[0] === floor[0];
  if (floor[1] > 0) return candidate[0] === 0 && candidate[1] === floor[1];
  return candidate[0] === 0 && candidate[1] === 0 && candidate[2] === floor[2];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function fail(message) {
  console.error(`[preflight] ${message}`);
  process.exit(1);
}
