import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Build tooling JavaScript helper.
import { measureStaticClosure } from '../scripts/worker-closure.mjs';

test('the static closure follows static imports from the Worker entry and skips import() targets', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-worker-closure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.vite'));
  mkdirSync(path.join(root, 'assets'));
  const files = { 'index.js': 100, 'assets/shared.js': 40, 'assets/leaf.js': 7, 'assets/lazy.js': 900 };
  for (const [file, bytes] of Object.entries(files)) writeFileSync(path.join(root, file), 'x'.repeat(bytes));
  writeFileSync(path.join(root, '.vite/manifest.json'), JSON.stringify({
    'virtual:cloudflare/worker-entry': {
      file: 'index.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/lazy.ts'],
    },
    '_shared.js': { file: 'assets/shared.js', imports: ['_leaf.js'] },
    '_leaf.js': { file: 'assets/leaf.js', imports: ['_shared.js'] },
    'src/lazy.ts': { file: 'assets/lazy.js', isDynamicEntry: true, imports: ['_leaf.js'] },
  }));
  const { chunks, bytes } = measureStaticClosure(root);
  assert.equal(bytes, 147);
  assert.deepEqual(chunks.map(({ file }: { file: string }) => file), ['index.js', 'assets/shared.js', 'assets/leaf.js']);
});
