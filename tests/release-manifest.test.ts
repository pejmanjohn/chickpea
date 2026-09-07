import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { migrationDigests, validateReleaseManifest } from '../scripts/lib/release-manifest.mjs';

test('release validation rejects changed migration contents and inconsistent versions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['migrations/better-auth', 'src/identity', 'src/config', 'src/work']) mkdirSync(join(root, dir), { recursive: true });
  const write = (name: string, text: string) => writeFileSync(join(root, name), text);
  write('migrations/better-auth/0001.sql', 'CREATE TABLE example (id TEXT);');
  write('wrangler.jsonc', '{"migrations":[{"tag":"v1","new_sqlite_classes":["State"]}]}');
  for (const file of ['src/identity/migrations.ts', 'src/config/store.ts', 'src/work/migrations.ts']) write(file, 'migration source');
  write('package.json', JSON.stringify({ version: '0.1.0' }));
  write('package-lock.json', JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }));
  const manifest = { formatVersion: 1, version: '0.1.0', storageGeneration: 1, supportedOrigins: [], recovery: 'previous-code-only', migrations: migrationDigests(root) };
  assert.deepEqual(validateReleaseManifest(root, manifest), manifest);
  assert.throws(() => validateReleaseManifest(root, { ...manifest, version: '0.1.1' }), /version/);
  assert.throws(() => validateReleaseManifest(root, { ...manifest, supportedOrigins: ['0.1.0'] }), /origin/);
  assert.throws(() => validateReleaseManifest(root, { ...manifest, recovery: 'snapshot' }), /recovery/);
  write('migrations/better-auth/0001.sql', 'DROP TABLE example;');
  assert.throws(() => validateReleaseManifest(root, manifest), /migration/);
});
