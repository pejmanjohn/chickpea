import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Build tooling JavaScript helper.
import { closureFailures, measureStaticClosure } from '../scripts/worker-closure.mjs';

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
  const { chunks, bytes, modules } = measureStaticClosure(root);
  assert.equal(bytes, 147);
  assert.deepEqual(chunks.map(({ file }: { file: string }) => file), ['index.js', 'assets/shared.js', 'assets/leaf.js']);
  assert.equal(modules, undefined, 'no module report, so no per-module sizes');

  // The report names each module's chunk; only the closure's chunks count.
  writeFileSync(path.join(root, 'bundle-modules.json'), JSON.stringify([
    { id: 'src/app.ts', renderedLength: 90, chunk: 'index.js' },
    { id: 'node_modules/pkg/index.js', renderedLength: 30, chunk: 'assets/shared.js' },
    { id: 'src/lazy.ts', renderedLength: 800, chunk: 'assets/lazy.js' },
  ]));
  assert.deepEqual([...measureStaticClosure(root).modules], [['src/app.ts', 90], ['node_modules/pkg/index.js', 30]]);
  // A report written before modules named their chunk cannot say which load at startup.
  writeFileSync(path.join(root, 'bundle-modules.json'), JSON.stringify([{ id: 'src/app.ts', renderedLength: 90 }]));
  assert.equal(measureStaticClosure(root).modules, undefined);
});

type Closure = { bytes: number; modules?: Map<string, number> };
const KIB = 1024;
const BASE = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const closure = (modules: Record<string, number>): Closure =>
  ({ bytes: Object.values(modules).reduce((sum, bytes) => sum + bytes, 0), modules: new Map(Object.entries(modules)) });
// A train of two merges: the first adds 20 KiB with no note; the second, HEAD, adds 30 KiB under a 40 KiB note.
const measured = new Map<string | undefined, Closure>([
  [BASE, closure({ 'src/app.ts': 100 * KIB })],
  [MERGE, closure({ 'src/app.ts': 100 * KIB, 'src/first.ts': 20 * KIB })],
  [undefined, closure({ 'src/app.ts': 100 * KIB, 'src/first.ts': 20 * KIB, 'src/second.ts': 30 * KIB })],
]);
const plan = {
  base: BASE, ref: 'origin/main', changes: [
    { from: BASE, to: MERGE, label: 'merge bbbbbbbbb (Merge pull request #1)', notes: [], allowance: 16 * KIB },
    { from: MERGE, to: undefined, label: 'merge ccccccccc (Merge pull request #2)', notes: ['40 KiB, the connect route'], allowance: 40 * KIB },
  ],
};
function check(options: { at?: (commit?: string) => Closure; unbuildableBaseAllowed?: boolean; plan?: object } = {}) {
  const logged: string[] = [];
  const failures: string[] = closureFailures({
    plan, at: (commit?: string) => measured.get(commit), ...options, log: (line: string) => logged.push(line),
  });
  return { failures, logged };
}

test('the closure fails a change over its allowance, names its modules, and passes one within its note', () => {
  const { failures, logged } = check();
  const [failure = ''] = failures;
  assert.equal(failures.length, 1);
  assert.match(failure, /^The Worker static closure grew 20\.0 KiB in merge bbbbbbbbb \(Merge pull request #1\) \(aaaaaaaaa\.\.bbbbbbbbb\), over the 16\.0 KiB/);
  assert.match(failure, /\+20\.0 KiB {2}src\/first\.ts \(new\)/);
  assert.doesNotMatch(failure, /second\.ts/);
  assert.deepEqual(logged, [
    'The merge base with origin/main is aaaaaaaaa.',
    'Growth in merge bbbbbbbbb (Merge pull request #1) since aaaaaaaaa: 20.0 KiB, allowed 16.0 KiB.',
    'Growth in merge ccccccccc (Merge pull request #2) since bbbbbbbbb: 30.0 KiB, allowed 40.0 KiB. Worker-Startup-Growth: 40 KiB, the connect route.',
  ]);
});

test('a base that cannot be measured fails unless CHICKPEA_BUDGET_UNBUILDABLE_BASE is set', () => {
  const at = (commit?: string) => {
    if (commit === BASE) throw new Error('Building aaaaaaaaa to measure its closure failed. Its package-lock.json is not this checkout\'s.');
    return measured.get(commit)!;
  };
  const failed = check({ at });
  assert.equal(failed.failures.length, 1);
  assert.match(failed.failures.join('\n'), /^Growth in merge bbbbbbbbb \(Merge pull request #1\) could not be measured\. Building aaaaaaaaa to measure its closure failed\. Its package-lock\.json is not this checkout's\.\nWhen that commit cannot build with this checkout's dependencies, as after a dependency upgrade, set CHICKPEA_BUDGET_UNBUILDABLE_BASE=1 to check only the changes that can be measured\.$/);

  const allowed = check({ at, unbuildableBaseAllowed: true });
  assert.deepEqual(allowed.failures, []);
  const [, unmeasured = '', measuredMerge = ''] = allowed.logged;
  assert.match(unmeasured, /^Growth in merge bbbbbbbbb .* is not checked, as CHICKPEA_BUDGET_UNBUILDABLE_BASE is set\. Building aaaaaaaaa/);
  // The merge it could measure is still checked.
  assert.match(measuredMerge, /^Growth in merge ccccccccc .*: 30\.0 KiB, allowed 40\.0 KiB/);
});

test('a skipped plan is printed and a failed one fails', () => {
  const skipped = check({ plan: { skip: 'This checkout has no Git history.' } });
  assert.deepEqual(skipped, { failures: [], logged: ['This checkout has no Git history.'] });
  assert.deepEqual(check({ plan: { error: 'CHICKPEA_BUDGET_BASE=lowr has no merge base with HEAD.' } }).failures,
    ['CHICKPEA_BUDGET_BASE=lowr has no merge base with HEAD.']);
});
