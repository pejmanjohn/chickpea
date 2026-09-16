import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// @ts-expect-error Shared executable JavaScript helper.
import { applyEnvironmentFile, assertProductionArtifact, parseStartArguments, resolveServerOptions } from '../scripts/start-node.mjs';

test('production Node startup requires one explicitly named environment file', () => {
  assert.deepEqual(parseStartArguments(['--env-file', './runtime.env']), {
    envFile: './runtime.env',
  });
  assert.throws(() => parseStartArguments([]), /--env-file <path> is required/);
  assert.throws(() => parseStartArguments(['--env-file']), /requires a file path/);
  assert.throws(() => parseStartArguments(['--unknown']), /Unknown option/);
});

test('production Node startup defaults to loopback and validates explicit host and port', () => {
  assert.deepEqual(resolveServerOptions({}), { hostname: '127.0.0.1', port: 3000 });
  assert.deepEqual(resolveServerOptions({ HOST: '::1', PORT: '4321' }), {
    hostname: '::1',
    port: 4321,
  });
  for (const port of ['0', '65536', '3.5', 'invalid']) {
    assert.throws(() => resolveServerOptions({ PORT: port }), /PORT must be an integer/);
  }
  for (const host of ['', '127.0.0.1/path', 'https://localhost', 'local host']) {
    assert.throws(() => resolveServerOptions({ HOST: host }), /HOST must be a hostname or IP address/);
  }
});

test('the production CLI rejects an invalid port without exposing environment-file secrets', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'runtime.env');
  writeFileSync(file, 'PORT=invalid\nCHICKPEA_AUTH_SECRET=do-not-print-this-secret\n');
  const result = spawnSync(process.execPath, [
    '--',
    fileURLToPath(new URL('../scripts/start-node.mjs', import.meta.url)),
    '--env-file',
    file,
  ], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PORT must be an integer/);
  assert.doesNotMatch(result.stderr, /do-not-print-this-secret/);
});

test('explicit environment file fills missing values without replacing the standard environment', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-start-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'runtime.env');
  writeFileSync(file, 'PORT=4555\nHOST=127.0.0.1\nNODE_ENV=production\n');
  const target: NodeJS.ProcessEnv = { PORT: '4666' };
  applyEnvironmentFile(file, target);
  assert.deepEqual(target, {
    PORT: '4666',
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
  });
});

test('missing production environment and application artifacts fail with actionable paths', () => {
  assert.throws(
    () => applyEnvironmentFile('/definitely/missing/chickpea-runtime.env', {}),
    /Cannot load production environment file .*chickpea-runtime\.env/,
  );
  assert.throws(
    () => assertProductionArtifact('/definitely/missing/dist/app.mjs'),
    /Production Node artifact is missing .*npm run flue:build/,
  );
});
