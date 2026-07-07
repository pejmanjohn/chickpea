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
import { existsSync } from 'node:fs';
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
