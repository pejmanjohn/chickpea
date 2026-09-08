import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

// @ts-expect-error Shared executable JavaScript helpers.
import { offlineProgress, offlineStepLabel } from '../scripts/lib/verification-offline.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { digest } from '../scripts/lib/verification-inputs.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { evidenceRefs, offlineEvent } from '../scripts/lib/verification-record.mjs';

const source = (tree = 'source-one') => ({ tree, head: 'a'.repeat(40), dirty: false });
const npm = (script: string) => ({ kind: 'npm', script });
const tests = (...files: string[]) => ({ kind: 'tests', files });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-offline-record-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run: any = { id: 'synthetic-run', events: [] };
  const event = (value: object) => offlineEvent(run, value);
  const plan = (steps: object[], extra: object = {}) => event({ type: 'offline_plan', mode: 'changed',
    steps, source: source(), node: 'v24.20.0', executionFingerprint: 'environment-one',
    fingerprint: digest({ steps, extra }), ...extra });
  const begin = (p: any, step = p.steps[0]) => event({ type: 'offline_begin', planId: p.id,
    label: offlineStepLabel(step), fingerprint: p.fingerprint, source: p.source, node: p.node });
  const finish = (p: any, attempt: any, result = 'pass') => {
    const log = join(directory, `${attempt.id}.log`);
    writeFileSync(log, `Synthetic ${attempt.label}: ${result}\n`);
    return event({ type: 'offline_finish', planId: p.id, attemptId: attempt.id, label: attempt.label,
      fingerprint: p.fingerprint, node: p.node, result, durationMs: 12, evidence: evidenceRefs([log]) });
  };
  const summary = (p: any, result = 'pass') => event({ type: 'offline_summary', planId: p.id, result });
  const check = (p: any, step = p.steps[0], result = 'pass') => finish(p, begin(p, step), result);
  const complete = (p: any) => { for (const step of p.steps) check(p, step); summary(p); };
  const checkpoint = (p: any) => event({ type: 'checkpoint', planId: p.id, result: 'pass', source: p.source,
    node: p.node, fingerprint: p.fingerprint,
    evidence: run.events.filter((e: any) => e.type === 'offline_finish' && e.planId === p.id).flatMap((e: any) => e.evidence) });
  const intact = (refs: any[]) => refs.every((ref) => {
    try { return digest(readFileSync(ref.path)) === ref.digest; } catch { return false; }
  });
  const view = (current = source()) => offlineProgress(run, current, intact);
  const results = (current = source()) => Object.fromEntries(view(current).offlineObligations.map((item: any) => [item.id, item.result]));
  return { directory, run, event, plan, begin, finish, summary, check, complete, checkpoint, view, results };
}

test('a narrower successful independent plan cannot hide failed or unexecuted requirements, and relevant reruns recover them', (t) => {
  const f = fixture(t), durability = npm('verify:durability'), providers = npm('verify:providers');
  const broad = f.plan([durability, providers]);
  const failure = f.check(broad, durability, 'fail'); f.summary(broad, 'fail');
  const independent = f.plan([npm('typecheck')]); f.complete(independent);
  assert.equal(f.view().offlinePlans[0].result, 'fail');
  assert.deepEqual(f.results(), { 'npm:verify:durability': 'fail', 'npm:verify:providers': 'not_run', 'npm:typecheck': 'pass' });
  const recovery = f.plan([durability]); f.complete(recovery);
  assert.equal(f.view().offlinePlans[0].result, 'not_run');
  const remaining = f.plan([providers]); f.complete(remaining);
  assert.equal(f.view().offlinePlans[0].result, 'pass');
  assert.equal(f.run.events.find((e: any) => e.id === failure.id).result, 'fail');
});

test('a newer failed check supersedes earlier success; summaries alone and open attempts never satisfy coverage', (t) => {
  const f = fixture(t), step = npm('verify:durability');
  const first = f.plan([step]); f.complete(first);
  const broken = f.plan([step]); f.check(broken, step, 'fail'); f.summary(broken, 'fail');
  const unrelated = f.plan([npm('typecheck')]); f.complete(unrelated);
  assert.equal(f.results()['npm:verify:durability'], 'fail');
  const fabricatedSummary = f.plan([step]); f.summary(fabricatedSummary);
  assert.equal(f.results()['npm:verify:durability'], 'not_run');
  const retry = f.plan([step]), attempt = f.begin(retry);
  assert.equal(f.results()['npm:verify:durability'], 'in_progress');
  f.finish(retry, attempt); f.summary(retry);
  assert.equal(f.view().offlinePlans[0].result, 'pass');
});

test('overlapping and superseding test groups retain every original test obligation', (t) => {
  const f = fixture(t), a = 'tests/one.test.ts', b = 'tests/two.test.ts', c = 'tests/three.test.ts';
  const failed = f.plan([tests(a, b)]); f.check(failed, failed.steps[0], 'fail'); f.summary(failed, 'fail');
  const partial = f.plan([tests(a)]); f.complete(partial);
  assert.deepEqual(f.results(), { [`test:${a}`]: 'pass', [`test:${b}`]: 'fail' });
  const superset = f.plan([tests(b, c)]); f.complete(superset);
  assert.deepEqual(f.results(), { [`test:${a}`]: 'pass', [`test:${b}`]: 'pass', [`test:${c}`]: 'pass' });
});

test('a full npm test run supersedes only its declared test inventory and typecheck', (t) => {
  const f = fixture(t), a = 'tests/one.test.ts', b = 'tests/usage/two.test.ts', c = 'tests/custom/three.test.ts';
  const focused = f.plan([tests(a, b, c), npm('typecheck')]);
  f.check(focused, focused.steps[0], 'fail'); f.summary(focused, 'fail');
  const full = f.plan([npm('test')], { testFiles: [a, b] }); f.complete(full);
  assert.deepEqual(f.results(), { [`test:${a}`]: 'pass', [`test:${b}`]: 'pass', [`test:${c}`]: 'fail', 'npm:typecheck': 'pass', 'npm:test': 'pass' });
  const custom = f.plan([tests(c)]); f.complete(custom);
  assert.equal(f.view().offlinePlans[0].result, 'pass');
});

test('a current clean export resolves its declared coverage, while historical or failed exports do not', (t) => {
  const f = fixture(t), a = 'tests/one.test.ts', custom = 'tests/custom/two.test.ts';
  const initial = f.plan([tests(a, custom), npm('typecheck'), npm('test'), npm('verify:durability'), npm('verify:providers'), { kind: 'node', file: 'scripts/verify-flue-offline-turn.mjs' }]);
  f.check(initial, initial.steps[0], 'fail'); f.summary(initial, 'fail');
  const historical = f.plan([npm('verify:oss-export')], { testFiles: [a] }); f.complete(historical);
  assert.equal(f.results()[`test:${a}`], 'fail');
  const failed = f.plan([npm('verify:oss-export')], { sourceExportCoverage: 1, testFiles: [a] });
  f.check(failed, failed.steps[0], 'fail'); f.summary(failed, 'fail');
  assert.equal(f.results()['npm:verify:durability'], 'fail');
  const final = f.plan([npm('verify:oss-export')], { sourceExportCoverage: 1, testFiles: [a] }); f.complete(final);
  for (const id of ['npm:test', 'npm:typecheck', 'npm:verify:durability', 'npm:verify:providers', 'scripts/verify-flue-offline-turn.mjs', `test:${a}`]) assert.equal(f.results()[id], 'pass', id);
  assert.equal(f.results()[`test:${custom}`], 'fail');
});

test('a Node 24 update carries unfinished obligations forward without requiring a second runtime sweep', (t) => {
  const f = fixture(t), a = npm('test'), b = npm('verify:durability');
  const old = f.plan([a, b], { node: 'v24.19.0' }); f.check(old, a, 'fail'); f.summary(old, 'fail');
  const partial = f.plan([b]); f.complete(partial);
  assert.equal(f.results()['npm:test'], 'stale');
  const final = f.plan([a, b], { mode: 'release' }); f.complete(final); f.checkpoint(final);
  assert.equal(f.view().offlinePlans.length, 1);
  assert.equal(f.view().offlinePlans[0].result, 'pass');
  assert.equal(f.view().checkpoints.length, 1);
});

test('a failed source-stability summary cannot be hidden by a later independent success', (t) => {
  const f = fixture(t), step = npm('verify:durability');
  const drifted = f.plan([step]); f.check(drifted); f.summary(drifted, 'fail');
  const independent = f.plan([npm('typecheck')]); f.complete(independent);
  assert.equal(f.results()['npm:verify:durability'], 'stale');
  const recovered = f.plan([step]); f.complete(recovered);
  assert.equal(f.view().offlinePlans[0].result, 'pass');
});

test('source and execution configuration changes invalidate old coverage without dropping it', (t) => {
  const f = fixture(t), durability = npm('verify:durability'), typecheck = npm('typecheck');
  const old = f.plan([durability, typecheck]); f.complete(old);
  const changed = source('source-two');
  const narrow = f.plan([typecheck], { source: changed }); f.complete(narrow);
  assert.deepEqual(f.results(changed), { 'npm:verify:durability': 'stale', 'npm:typecheck': 'pass' });
  const recovered = f.plan([durability], { source: changed }); f.complete(recovered);
  assert.equal(f.view(changed).offlinePlans[0].result, 'pass');
  const environment = f.plan([typecheck], { source: changed, executionFingerprint: 'environment-two' }); f.complete(environment);
  assert.equal(f.results(changed)['npm:verify:durability'], 'stale');
});

test('evidence integrity and Node runtime identity remain required for offline recovery', (t) => {
  const f = fixture(t), step = npm('verify:durability');
  const node24 = f.plan([step]); f.complete(node24);
  const node22 = f.plan([step], { node: 'v22.19.0' }); f.check(node22, step, 'fail'); f.summary(node22, 'fail');
  assert.deepEqual(f.view().offlinePlans.map((p: any) => [p.node, p.result]), [['v24.20.0', 'pass'], ['v22.19.0', 'fail']]);
  const receipt = f.run.events.find((e: any) => e.type === 'offline_finish' && e.planId === node24.id);
  writeFileSync(receipt.evidence[0].path, 'replaced evidence');
  assert.equal(f.view().offlinePlans[0].result, 'stale');
});

test('validated reuse satisfies the new plan but cannot reuse past an intervening failure', (t) => {
  const f = fixture(t), step = npm('typecheck');
  const first = f.plan([step]), receipt = f.check(first); f.summary(first);
  const reused = f.plan([step]);
  const reuse = (p: any) => f.event({ type: 'offline_reuse', planId: p.id, label: receipt.label,
    fingerprint: p.fingerprint, reusedId: receipt.id, evidence: receipt.evidence });
  reuse(reused); f.summary(reused);
  assert.equal(f.view().offlinePlans[0].result, 'pass');
  const failure = f.plan([step]); f.check(failure, step, 'fail'); f.summary(failure, 'fail');
  const invalid = f.plan([step]); reuse(invalid); f.summary(invalid);
  assert.equal(f.view().offlinePlans[0].result, 'stale');
});

test('a failed later full plan fences an older checkpoint even after all checks recover in narrower plans', (t) => {
  const f = fixture(t), steps = [npm('test'), npm('verify:oss-export')];
  const first = f.plan(steps, { mode: 'release' }); f.complete(first); const receipt = f.checkpoint(first);
  assert.deepEqual(f.view().checkpoints.map((e: any) => e.id), [receipt.id]);
  const failed = f.plan(steps, { mode: 'release' }); f.check(failed, steps[0], 'fail'); f.summary(failed, 'fail');
  assert.equal(f.view().checkpoints.length, 0);
  for (const step of steps) { const focused = f.plan([step]); f.complete(focused); }
  assert.equal(f.view().offlinePlans[0].result, 'pass');
  assert.equal(f.view().checkpoints.length, 0);
  const final = f.plan(steps, { mode: 'release' }); f.complete(final); const valid = f.checkpoint(final);
  assert.deepEqual(f.view().checkpoints.map((e: any) => e.id), [valid.id]);
});

test('a failure or stale log after the checkpoint requires a fresh full checkpoint, even after focused recovery', (t) => {
  const f = fixture(t), step = npm('verify:durability');
  const initial = f.plan([step], { mode: 'release' }); f.complete(initial); f.checkpoint(initial);
  const focused = f.plan([step]); f.check(focused, step, 'fail'); f.summary(focused, 'fail');
  assert.equal(f.view().checkpoints.length, 0);
  const recovery = f.plan([step]); f.complete(recovery);
  assert.equal(f.view().offlinePlans[0].result, 'pass');
  assert.equal(f.view().checkpoints.length, 0);
  const final = f.plan([step], { mode: 'release' }); f.complete(final); f.checkpoint(final);
  const later = f.plan([step]), log = f.check(later); f.summary(later);
  assert.equal(f.view().checkpoints.length, 1);
  writeFileSync(log.evidence[0].path, 'replaced after passing');
  assert.equal(f.view().checkpoints.length, 0);
});

test('an older Node 24 checkpoint cannot conceal a later failed full run on another Node 24 patch version', (t) => {
  const f = fixture(t), step = npm('test');
  const first = f.plan([step], { mode: 'release' }); f.complete(first); f.checkpoint(first);
  const later = f.plan([step], { mode: 'release', node: 'v24.20.1' }); f.check(later, step, 'fail'); f.summary(later, 'fail');
  assert.equal(f.view().checkpoints.length, 0);
  const focused = f.plan([step], { node: 'v24.20.1' }); f.complete(focused);
  assert.ok(f.view().offlinePlans.every((p: any) => p.result === 'pass'));
  assert.equal(f.view().checkpoints.length, 0);
  const full = f.plan([step], { mode: 'release', node: 'v24.20.1' }); f.complete(full); const checkpoint = f.checkpoint(full);
  assert.deepEqual(f.view().checkpoints.map((e: any) => e.id), [checkpoint.id]);
});

test('a release checkpoint needs intact completed full-plan receipts, current clean source and matching configuration', (t) => {
  const f = fixture(t), step = npm('test');
  f.event({ type: 'checkpoint', result: 'pass', source: source(), node: 'v24.20.0', evidence: [] });
  assert.equal(f.view().checkpoints.length, 0);
  const plan = f.plan([step], { mode: 'release' }); f.summary(plan); f.checkpoint(plan);
  assert.equal(f.view().checkpoints.length, 0);
  const complete = f.plan([step], { mode: 'release' }); f.complete(complete); f.checkpoint(complete);
  assert.equal(f.view().checkpoints.length, 1);
  assert.equal(f.view({ ...source(), dirty: true }).checkpoints.length, 0);
  assert.equal(f.view(source('different')).checkpoints.length, 0);
  const differentEnvironment = f.plan([npm('typecheck')], { executionFingerprint: 'changed' }); f.complete(differentEnvironment);
  assert.equal(f.view().checkpoints.length, 0);
});
