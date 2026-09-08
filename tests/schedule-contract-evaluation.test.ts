import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error Shared executable JavaScript helper.
import { deterministicScheduleEvaluation, sampleScheduleModel, summarizeModelSamples } from '../scripts/lib/schedule-contract-evaluation.mjs';

const corpus = JSON.parse(readFileSync(new URL('../evals/schedule-contract/cases.json', import.meta.url), 'utf8'));
test('real active schema, converter and pre-admission guards distinguish schema acceptance from authorized scheduling', async () => {
  const report = await deterministicScheduleEvaluation(corpus);
  assert.equal(report.passed, true, JSON.stringify(report.results.filter((r: any) => !r.passed)));
  assert.ok(report.results.some((r: any) => r.schema === 'accepted' && r.admission === 'rejected'));
  assert.ok(report.results.some((r: any) => r.admission === 'accepted'));
  assert.ok(report.results.every((r: any) => r.persistence === 'not_run' && r.dueDelivery === 'not_run'));
});

test('transport failure has zero evaluable samples; schema-valid paraphrases remain model failures', async () => {
  const entry = corpus.cases[0];
  const transport = await sampleScheduleModel(entry, async () => { throw new Error('synthetic transport fault'); });
  assert.equal(transport.evaluable, false);
  assert.equal(transport.category, 'transport');
  const payloadError = await sampleScheduleModel(entry, async () => ({ stopReason: 'error', content: [] }));
  assert.equal(payloadError.evaluable, false);
  const invalid = await sampleScheduleModel(entry, async () => ({ model: 'adapter-only', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'manage_scheduled_work', arguments: { ...entry.arguments, taskText: 'Paraphrased synthetic task.' } }] }));
  assert.equal(invalid.evaluable, true);
  assert.equal(invalid.passed, false);
  assert.equal(invalid.calls[0].result.schema, 'accepted');
  assert.equal(invalid.calls[0].result.typedResult.code, 'invalid_request');
  assert.equal(invalid.routedModel, null);
  const absent = await sampleScheduleModel(entry, async () => ({ stopReason: 'stop', content: [] }));
  assert.equal(absent.evaluable, true);
  assert.equal(absent.passed, false);
});

test('model CLI refuses missing, insufficient or oversized call budgets before creating a report or calling a provider', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-model-budget-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'result.json');
  for (const budget of [[], ['--max-calls', '1'], ['--max-calls', '25']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/evaluate-schedule-contract.mjs', '--live', '--model', 'synthetic/unavailable', '--output', output, ...budget], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /explicit 1\.\.24 call budget/);
    assert.equal(existsSync(output), false);
  }
});

test('comparison counts interrupted and transport attempts without treating their latency or missing tokens as evaluable', () => {
  const [summary] = summarizeModelSamples([
    { configuredModel: 'synthetic', state: 'attempted' },
    { configuredModel: 'synthetic', state: 'finished', evaluable: false, category: 'transport', elapsedMs: 1 },
    { configuredModel: 'synthetic', state: 'finished', evaluable: true, passed: true, elapsedMs: 100, usage: { input: 3, cacheRead: 90, cacheWrite: 2, output: 10, reasoning: 7 } },
  ]);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.evaluable, 1);
  assert.equal(summary.unfinished, 1);
  assert.equal(summary.transportFailures, 1);
  assert.equal(summary.evaluableLatencyMs.median, 100);
  assert.deepEqual(summary.tokens.output, { reported: 10, unmeasuredSamples: 2 });
  assert.deepEqual(summary.tokens.cacheRead, { reported: 90, unmeasuredSamples: 2 });
});
