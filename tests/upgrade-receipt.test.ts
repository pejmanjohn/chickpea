import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Release tooling JavaScript helper.
import { writePrivateJson, readPrivateJson } from '../scripts/lib/upgrade-receipt.mjs';

test('receipt writes are private, atomic, and reject unsafe file types', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-receipt-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'receipt.json');
  writePrivateJson(file, { stage: 'prepared' });
  writePrivateJson(file, { stage: 'confirmed' });
  assert.deepEqual(readPrivateJson(file), { stage: 'confirmed' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  symlinkSync(file, join(root, 'link.json'));
  assert.throws(() => readPrivateJson(join(root, 'link.json')), /private/);
  assert.throws(() => writePrivateJson(join(root, 'link.json'), {}), /private/);
  writeFileSync(file, '{');
  assert.throws(() => readPrivateJson(file), /readable/);
});
