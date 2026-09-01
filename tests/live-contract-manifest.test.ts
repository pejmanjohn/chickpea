import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';

import {
  assertFeatureMapFresh,
  compileLiveCatalog,
  manifestJson,
  renderFeatureMap,
} from '../qa/live/compiler.ts';
import { PUBLIC_LIVE_CATALOG } from '../qa/live/cases/index.ts';
import { LIVE_MANIFEST } from '../qa/live/manifest.ts';

test('equivalent catalogs compile byte-for-byte while behavior changes alter the digest', () => {
  const reordered = structuredClone(PUBLIC_LIVE_CATALOG);
  reordered.contracts.reverse();
  for (const contract of reordered.contracts) contract.variants.reverse();

  const first = compileLiveCatalog(PUBLIC_LIVE_CATALOG);
  const second = compileLiveCatalog(reordered);
  assert.equal(manifestJson(first), manifestJson(second));
  assert.equal(first.digest, second.digest);

  const changed = structuredClone(PUBLIC_LIVE_CATALOG);
  changed.contracts[0]!.variants[0]!.actions[0]!.message += ' Confirm the final state.';
  assert.notEqual(compileLiveCatalog(changed).digest, first.digest);
});

test('the committed feature map is generated from the current manifest and detects drift', () => {
  const generated = readFileSync(new URL('../qa/live/generated/feature-map.md', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertFeatureMapFresh(generated, LIVE_MANIFEST));

  const changed = structuredClone(LIVE_MANIFEST);
  changed.contracts[0]!.title += ' changed';
  assert.throws(() => assertFeatureMapFresh(generated, changed), /FEATURE_MAP_STALE/);

  const rendered = renderFeatureMap(LIVE_MANIFEST);
  for (const contract of LIVE_MANIFEST.contracts) {
    assert.equal(rendered.split('\n').filter((line) => line.startsWith(`| ${contract.id} |`)).length, 1);
  }
  const entryPointRows = rendered.split('\n').filter((line) => line.startsWith('| `'));
  assert.equal(new Set(entryPointRows.map((line) => line.split('|')[1]?.trim())).size, entryPointRows.length);
});

test('the manifest is data-only, content-addressed, and declares exact suite denominators', () => {
  const compiled = compileLiveCatalog(PUBLIC_LIVE_CATALOG);
  assert.equal(manifestJson(LIVE_MANIFEST), manifestJson(compiled));
  assert.equal(Object.isFrozen(LIVE_MANIFEST), true);
  assert.equal(Object.isFrozen(LIVE_MANIFEST.contracts[0]?.variants[0]?.actions), true);
  const parsed = JSON.parse(manifestJson(LIVE_MANIFEST)) as typeof LIVE_MANIFEST;
  assert.equal(parsed.digest, LIVE_MANIFEST.digest);
  assert.deepEqual(parsed.requiredVariants.smoke, [
    'LC01-V1-create-welcome',
    'LC01-V2-update-approve',
    'LC04-V1-personal-read',
    'LC08-V1-create-due',
  ]);
  assert.equal(parsed.requiredVariants.case.length, parsed.requiredVariants.deep.length);
  assert.equal(containsFunction(parsed), false);
});

test('root typecheck covers qa/live and production sources cannot import the QA implementation', () => {
  const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8')) as { include?: string[] };
  assert.equal(tsconfig.include?.includes('qa/live/**/*.ts'), true);

  const repositoryRoot = join(import.meta.dirname, '..');
  const productionFiles = [
    ...walkTypeScript(join(repositoryRoot, 'src')),
    join(repositoryRoot, 'flue.config.ts'),
    join(repositoryRoot, 'vite.config.ts'),
    join(repositoryRoot, 'vite.node.config.ts'),
  ];
  for (const path of productionFiles) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'][^"']*qa\/live(?:\/|["'])/);
  }

  const manifestModule = readFileSync(new URL('../qa/live/manifest.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(manifestModule, /(?:compiler|cases\/index)/);
});

function walkTypeScript(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkTypeScript(path);
    return extname(entry.name) === '.ts' ? [path] : [];
  });
}

function containsFunction(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsFunction);
}
