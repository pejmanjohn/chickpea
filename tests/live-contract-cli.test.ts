import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { renderHumanRecord, runLiveCli, serializeCliRecord } from '../qa/live/cli.ts';
import { aggregateRunReport } from '../qa/live/report.ts';
import { assertStrictDeepInventory, selectSuiteVariants } from '../qa/live/suites.ts';
import { LIVE_MANIFEST } from '../qa/live/manifest.ts';

test('package exposes doctor, case, smoke, and deep live entrypoints', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts['verify:live:doctor'] ?? '', /qa\/live\/cli\.ts doctor$/);
  assert.match(packageJson.scripts['verify:live:case'] ?? '', /qa\/live\/cli\.ts case$/);
  assert.match(packageJson.scripts['verify:live:smoke'] ?? '', /qa\/live\/cli\.ts smoke$/);
  assert.match(packageJson.scripts['verify:live:deep'] ?? '', /qa\/live\/cli\.ts deep$/);
});

test('suite selection is manifest-owned and smoke inventory is exact', () => {
  assert.deepEqual(selectSuiteVariants('smoke'), LIVE_MANIFEST.requiredVariants.smoke);
  assert.deepEqual(selectSuiteVariants('case', ['LC04-V1-personal-read']), ['LC04-V1-personal-read']);
  assert.throws(() => selectSuiteVariants('case', ['LC99-V1-invented']), /manifest/i);
  assert.throws(() => selectSuiteVariants('smoke', ['LC01-V1-create-welcome']), /exact|select/i);
});

test('strict deep inventory accepts v1.1 and still rejects an incomplete manifest', () => {
  assert.doesNotThrow(() => assertStrictDeepInventory(LIVE_MANIFEST));
  const incomplete = {
    ...LIVE_MANIFEST,
    contracts: LIVE_MANIFEST.contracts.filter(({ id }) => id !== 'LC-02'),
  };
  assert.throws(() => assertStrictDeepInventory(incomplete), /LC-02|complete deep inventory/i);
});

test('JSON and human views derive from the same safe record', () => {
  const report = aggregateRunReport({
    suite: 'case',
    manifestDigest: LIVE_MANIFEST.digest,
    targetFingerprint: 'sha256:target',
    repositoryRevision: '0123456789abcdef',
    servingVersion: 'version-1',
    declaredVariantIds: ['LC01-V1-create-welcome'],
    cases: [{
      variantId: 'LC01-V1-create-welcome',
      primary: { result: 'pass' },
      cleanup: 'failed',
    }],
  });
  const record = { kind: 'terminal' as const, runId: 'run-safe', report };
  const json = serializeCliRecord(record);
  const human = renderHumanRecord(record);
  assert.deepEqual(JSON.parse(json), record);
  assert.match(human, /cleanup_failed/);
  assert.match(human, /LC01-V1-create-welcome/);
  assert.equal(`${json}\n${human}`.includes('Create the run-marked'), false);
  assert.equal(`${json}\n${human}`.includes('message'), false);
});

test('runner source imports the frozen manifest but not authoring cases or compiler', () => {
  const source = readFileSync(new URL('../qa/live/runner.ts', import.meta.url), 'utf8');
  assert.match(source, /from ['"]\.\/manifest\.ts['"]/);
  assert.doesNotMatch(source, /cases\/index|compiler\.ts|defineLiveCase/);
});

test('CLI refuses hand-authored cleanup verdicts before reading private inputs', () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let privateReadAttempted = false;
  const exitCode = runLiveCli(['case', '--cleanup-result', 'pass'], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    readJson: () => {
      privateReadAttempted = true;
      throw new Error('PRIVATE_INPUT_READ');
    },
  });

  assert.equal(exitCode, 64);
  assert.equal(privateReadAttempted, false);
  assert.deepEqual(JSON.parse(stdout.join('')), {
    kind: 'error',
    code: 'CLEANUP_RECEIPT_REQUIRED',
  });
  assert.match(stderr.join(''), /CLEANUP_RECEIPT_REQUIRED/);
});
