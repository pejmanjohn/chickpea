import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { migrationDigests, validateReleaseManifest } from '../scripts/lib/release-manifest.mjs';

function sourceTree(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['migrations/better-auth', 'src/identity', 'src/config', 'src/work']) mkdirSync(join(root, dir), { recursive: true });
  const write = (name: string, text: string) => writeFileSync(join(root, name), text);
  write('migrations/better-auth/0001.sql', 'CREATE TABLE example (id TEXT);');
  write('wrangler.jsonc', '{"migrations":[{"tag":"v1","new_sqlite_classes":["State"]}]}');
  for (const file of ['src/identity/migrations.ts', 'src/config/store.ts', 'src/work/migrations.ts']) write(file, 'migration source');
  return { root, write };
}

test('release validation rejects changed migration contents and inconsistent versions', (t) => {
  const { root, write } = sourceTree(t);
  write('package.json', JSON.stringify({ version: '0.1.0' }));
  write('package-lock.json', JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }));
  const manifest = { formatVersion: 1, version: '0.1.0', storageGeneration: 1, supportedOrigins: [], migrations: migrationDigests(root) };
  assert.deepEqual(validateReleaseManifest(root, manifest), manifest);
  assert.throws(() => validateReleaseManifest(root, { ...manifest, version: '0.1.1' }), /version/);
  assert.throws(() => validateReleaseManifest(root, { ...manifest, supportedOrigins: ['0.1.0'] }), /origin/);
  write('migrations/better-auth/0001.sql', 'DROP TABLE example;');
  assert.throws(() => validateReleaseManifest(root, manifest), /migration/);
});

test('code-only store.ts edits leave the configuration digest; a contract version moves it', (t) => {
  const { root, write } = sourceTree(t);
  const store = readFileSync('src/config/store.ts', 'utf8');
  const contract = JSON.parse(readFileSync('src/config/storage-contract.json', 'utf8'));
  const configuration = () => migrationDigests(root).configuration;
  write('src/config/store.ts', store);
  write('src/config/storage-contract.json', JSON.stringify(contract, null, 2));
  const declared = configuration();
  assert.equal(declared, migrationDigests(process.cwd()).configuration);

  write('src/config/store.ts', `${store.replaceAll('\n\n', '\n\n\n')}\nexport const logicOnly = () => 1;\n`);
  assert.equal(configuration(), declared, 'whitespace and logic edits');
  write('src/config/storage-contract.json', JSON.stringify(Object.fromEntries(Object.entries(contract).reverse())));
  assert.equal(configuration(), declared, 'contract formatting and key order');
  const presence = 'config_agents.slack_presence_json';
  write('src/config/storage-contract.json', JSON.stringify({ ...contract, columns: { ...contract.columns, [presence]: contract.columns[presence] + 1 } }));
  assert.notEqual(configuration(), declared, 'a version bump');

  rmSync(join(root, 'src/config/storage-contract.json'));
  assert.equal(configuration(), createHash('sha256').update(readFileSync(join(root, 'src/config/store.ts'))).digest('hex'),
    'a release from before the contract declared all of store.ts');
});
