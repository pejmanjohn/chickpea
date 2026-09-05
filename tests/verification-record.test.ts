import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

// @ts-expect-error Shared executable JavaScript helpers.
import { appendEvent, createRun, evidenceRefs, offlineEvent, preflight, readRun, renderReport, reusableOffline, status, updateRun } from '../scripts/lib/verification-record.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { digest, sourceInputs } from '../scripts/lib/verification-inputs.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { templateSpec } from '../scripts/lib/verification-spec.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { runRecordCli } from '../scripts/verification-record.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { REGRESSION_AREAS } from '../scripts/lib/regression-plan.mjs';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const source = () => ({ head: 'a'.repeat(40), dirty: false, tree: 'tree-one', areas: Object.fromEntries(Object.keys(REGRESSION_AREAS).map((a) => [a, 'one'])) });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-record-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidence = join(directory, 'readback.json');
  writeFileSync(evidence, '{"synthetic":true}');
  const spec = {
    mode: 'changed', purpose: 'verification',
    contexts: { local: { grade: 'local', target: 'synthetic-local', servingVersion: 'version-one', model: 'test-model', actor: 'synthetic-owner', fixtures: 'fixture-v1', state: 'state-v1', config: 'config-v1' } },
    capabilities: {
      owner: { kind: 'actor', available: true, identity: 'synthetic-owner', role: 'owner', registered: false, observedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), evidence: [evidence] },
    },
    cases: [{ id: 'schedule', title: 'Synthetic schedule', context: 'local', areas: ['routines'], requires: ['owner'], proof: ['slack', 'admin'], maxAttempts: 3, maxWaitMs: 120_000, minObservationMs: 0 }],
  };
  const file = join(directory, 'run.json');
  const run = createRun(file, spec, source(), NOW);
  const append = (event: object, at = NOW + 1000, inputs = source()) => appendEvent(run, event, inputs, at);
  const finish = (id: string, extra: object = {}) => ({ type: 'finish', attemptId: id, result: 'pass', summary: 'Synthetic expected and observed state agree.', evidence: [evidence], proof: { slack: [evidence], admin: [evidence] }, ...extra });
  return { directory, evidence, spec, file, run, append, finish };
}

test('preflight separates observed actor registry drift from unavailable dependent fixtures', (t) => {
  const f = fixture(t);
  f.run.spec.cases.push({ ...f.spec.cases[0], id: 'fresh-install', requires: ['disposable-install'] });
  const result = preflight(f.run, NOW);
  assert.equal(result.ready, false);
  assert.deepEqual(result.runnable, ['schedule']);
  assert.match(result.cases[0].warnings[0], /registry warning/);
  assert.match(result.cases[1].blockers[0], /not inventoried/);
  assert.throws(() => f.append({ type: 'begin', caseId: 'fresh-install' }), /preflight is blocked/);
  assert.equal(preflight(f.run, NOW + 60_000).runnable.length, 0);
  writeFileSync(f.evidence, 'replaced readback');
  assert.equal(preflight(f.run, NOW).runnable.length, 0);
});

test('release template exposes disposable installation, actual member, private channel and connector fixtures', () => {
  const spec = templateSpec('release', [], NOW);
  assert.ok(spec.cases.some((c: { id: string; context: string }) => c.id === 'fresh-install' && c.context === 'installation'));
  for (const capability of ['candidate.member', 'candidate.private-channel', 'candidate.empty-connector-agent', 'installation.disposable-install-target']) assert.equal(spec.capabilities[capability].available, false);
  assert.throws(() => templateSpec('changed'), /needs --area/);
  assert.equal(templateSpec('changed', ['verification'], NOW).cases.length, 0);
});

test('preflight rejects wrong member roles and reusing the owner identity as a second actor', (t) => {
  const f = fixture(t);
  const spec = structuredClone(f.spec) as any;
  spec.capabilities.member = { ...spec.capabilities.owner, expectedRole: 'member', identity: 'synthetic-member' };
  spec.cases[0].requires.push('member');
  f.append({ type: 'refresh', spec, reason: 'Registered denial case.' });
  assert.match(preflight(f.run, NOW).cases[0].blockers.join(), /expected member/);
  spec.capabilities.member.role = 'member'; spec.capabilities.member.identity = 'synthetic-owner';
  f.append({ type: 'refresh', spec, reason: 'Observed member session.' });
  assert.match(preflight(f.run, NOW).cases[0].blockers.join(), /distinct actor/);
});

test('interrupted attended attempt resumes without replay and preserves ambiguous first outcome after readback', (t) => {
  const f = fixture(t);
  const started = updateRun(f.file, (run: object) => appendEvent(run, { type: 'begin', caseId: 'schedule' }, source(), NOW));
  assert.equal(status(readRun(f.file), source(), NOW + 120_001).cases[0].result, 'observe_overdue');
  assert.throws(() => updateRun(f.file, (run: object) => appendEvent(run, { type: 'begin', caseId: 'schedule', reason: 'retry' }, source(), NOW + 1)), /still open/);
  const ended = f.finish(started.id, { result: 'ambiguous', category: 'tool', summary: 'UI timed out; action outcome unknown.' });
  updateRun(f.file, (run: object) => appendEvent(run, ended, source(), NOW + 2000));
  assert.throws(() => updateRun(f.file, (run: object) => appendEvent(run, { type: 'begin', caseId: 'schedule', reason: 'try again' }, source(), NOW + 3000)), /not_applied/);
  updateRun(f.file, (run: object) => appendEvent(run, { type: 'reconcile', attemptId: started.id, outcome: 'applied', summary: 'Exact saved object read back.', evidence: [f.evidence] }, source(), NOW + 4000));
  updateRun(f.file, (run: object) => appendEvent(run, { ...f.finish(started.id), type: 'resolve', timing: { browserMs: 3000 }, costUsd: 0.02 }, source(), NOW + 5000));
  const current = status(readRun(f.file), source(), NOW + 6000);
  assert.equal(current.cases[0].result, 'pass');
  assert.equal(current.cases[0].firstFailure.result, 'ambiguous');
  assert.match(renderReport(current), /UI timed out/);
  assert.equal(current.complete, true);
  assert.equal(current.timing.measured.browserMs, 3000);
  assert.equal(current.timing.unknownByCategory.browserMs, 0);
  assert.equal(current.timing.unknownByCategory.modelMs, 1);
  assert.equal(current.timing.knownCostUsd, 0.02);
});

test('not_applied reconciliation permits a bounded retest; unknown and applied do not permit replay', (t) => {
  const f = fixture(t), first = f.append({ type: 'begin', caseId: 'schedule' });
  f.append(f.finish(first.id, { result: 'ambiguous', category: 'tool' }));
  for (const outcome of ['unknown', 'applied']) {
    f.append({ type: 'reconcile', attemptId: first.id, outcome, summary: 'Synthetic observation.', evidence: [f.evidence] });
    assert.throws(() => f.append({ type: 'begin', caseId: 'schedule', reason: 'retry' }), /not_applied/);
  }
  f.append({ type: 'reconcile', attemptId: first.id, outcome: 'not_applied', summary: 'Exact operation absent.', evidence: [f.evidence] });
  const second = f.append({ type: 'begin', caseId: 'schedule', reason: 'Reacquired tool after confirmed absence.' });
  assert.notEqual(first.id, second.id);
  f.append(f.finish(second.id, { result: 'fail', category: 'product' }));
  assert.throws(() => f.append(f.finish(second.id)), /first outcome is immutable/);
  const third = f.append({ type: 'begin', caseId: 'schedule', reason: 'Fixed diagnosed boundary.' });
  f.append(f.finish(third.id, { result: 'fail', category: 'model' }));
  assert.throws(() => f.append({ type: 'begin', caseId: 'schedule', reason: 'another' }), /budget exhausted/);
});

test('required real readbacks and declared observation windows cannot be replaced by a log or shortened wait', (t) => {
  const f = fixture(t);
  f.run.spec.cases[0].minObservationMs = 30000;
  const attempt = f.append({ type: 'begin', caseId: 'schedule' }, NOW);
  assert.throws(() => f.append(f.finish(attempt.id, { proof: {}, timing: { observationMs: 30000 } }), NOW + 30_000), /required.*readback/);
  assert.throws(() => f.append(f.finish(attempt.id), NOW + 30_000), /window is incomplete/);
  assert.throws(() => f.append(f.finish(attempt.id, { timing: { observationMs: 30000 } }), NOW + 10_000), /fit the elapsed/);
  f.append(f.finish(attempt.id, { timing: { observationMs: 30000, browserMs: 5000 }, costUsd: null }), NOW + 30_000);
  const view = status(f.run, source(), NOW + 31_000);
  assert.equal(view.timing.knownCostUsd, 0);
  assert.equal(view.timing.unknownCostAttempts, 1);
  assert.equal(view.timing.measured.observationMs, 30000);
});

test('refresh cannot hide selected coverage; workflow changes preserve product proof, relevant inputs invalidate it', (t) => {
  const f = fixture(t), attempt = f.append({ type: 'begin', caseId: 'schedule' });
  f.append(f.finish(attempt.id));
  const workflow = source(); workflow.areas.verification = 'changed'; workflow.tree = 'workflow-new';
  assert.equal(status(f.run, workflow, NOW + 2000).cases[0].result, 'pass');
  const product = source(); product.areas.routines = 'changed';
  assert.equal(status(f.run, product, NOW + 2000).cases[0].result, 'stale');
  assert.throws(() => f.append({ type: 'refresh', spec: { ...f.spec, cases: [] }, reason: 'skip it' }), /cannot drop/);
  const spec = structuredClone(f.spec); spec.contexts.local.servingVersion = 'version-two';
  f.append({ type: 'refresh', spec, reason: 'Candidate restarted.' });
  assert.deepEqual(status(f.run, source(), NOW + 2000).cases[0].invalidation, ['context']);
  const second = f.append({ type: 'begin', caseId: 'schedule', reason: 'Verify new serving version.' });
  assert.throws(() => f.append(f.finish(second.id), NOW + 2000, product), /inputs changed/);
});

test('exact cleanup restoration, failed cleanup recovery, and a reused immutable ID keep distinct obligations', (t) => {
  const f = fixture(t);
  const input = { type: 'resource', caseId: 'schedule', target: 'synthetic-local', provider: 'synthetic', kind: 'sheet', immutableId: 'exact-sheet', ownership: 'restore', before: { rows: [['a', '1']] }, expected: { rows: [['a', '1']] }, evidence: [f.evidence] };
  assert.throws(() => f.append({ ...input, expected: { rows: [] } }), /before-value/);
  assert.throws(() => f.append({ ...input, immutableId: '*' }), /immutable ID/);
  const resource = f.append(input);
  assert.throws(() => f.append({ type: 'cleanup', resourceId: resource.id, outcome: 'verified', observed: { rows: [['a', 1]] }, evidence: [f.evidence] }), /differs/);
  f.append({ type: 'cleanup', resourceId: resource.id, outcome: 'failed', evidence: [f.evidence] });
  assert.equal(status(f.run, source(), NOW).resources[0].cleanup, 'failed');
  f.append({ type: 'cleanup', resourceId: resource.id, outcome: 'verified', observed: input.before, evidence: [f.evidence] });
  const second = f.append(input);
  assert.notEqual(second.id, resource.id);
  assert.deepEqual(status(f.run, source(), NOW).resources.map((r: { cleanup: string }) => r.cleanup), ['verified', 'pending']);
  assert.throws(() => f.append({ type: 'cleanup', resourceId: 'foreign-resource', outcome: 'verified', observed: {}, evidence: [f.evidence] }), /exact resource/);
});

test('ordinary recurring schedules stop at count or deadline; duplicate receipts count once', (t) => {
  const f = fixture(t);
  const resource = { type: 'resource', caseId: 'schedule', target: 'synthetic-local', provider: 'chickpea', kind: 'schedule', immutableId: 'synthetic-routine', ownership: 'owned', expected: { present: false }, evidence: [f.evidence], stopAt: new Date(NOW + 20000).toISOString(), maxOccurrences: 2 };
  assert.throws(() => f.append({ ...resource, maxOccurrences: 94 }), /budget/);
  const saved = f.append(resource);
  for (const occurrenceId of ['one-occurrence', 'one-occurrence', 'two-occurrence']) f.append({ type: 'occurrence', resourceId: saved.id, occurrenceId, evidence: [f.evidence] });
  assert.equal(status(f.run, source(), NOW + 1000).resources[0].occurrences, 2);
  assert.throws(() => f.append({ type: 'begin', caseId: 'schedule' }), /stop condition/);
  f.append({ type: 'cleanup', resourceId: saved.id, outcome: 'verified', observed: { present: false }, evidence: [f.evidence] });
  assert.equal(status(f.run, source(), NOW + 30000).resources[0].stopDue, false);
  const second = f.append({ ...resource, maxOccurrences: 3 });
  assert.equal(status(f.run, source(), NOW + 20000).resources.find((r: { id: string }) => r.id === second.id).stopDue, true);
});

test('offline reuse rejects changed input, missing/replaced log, build, and newer failure/open attempt', (t) => {
  const f = fixture(t), fp = 'same';
  const receipt = offlineEvent(f.run, { type: 'offline_finish', label: 'npm:test', result: 'pass', fingerprint: fp, evidence: evidenceRefs([f.evidence]) });
  assert.equal(reusableOffline(f.run, 'npm:test', fp)?.id, receipt.id);
  assert.equal(reusableOffline(f.run, 'npm:test', 'changed'), undefined);
  assert.equal(reusableOffline(f.run, 'npm:build', fp), undefined);
  offlineEvent(f.run, { type: 'offline_begin', label: 'npm:test', fingerprint: fp });
  assert.equal(reusableOffline(f.run, 'npm:test', fp), undefined);
  offlineEvent(f.run, { ...receipt, type: 'offline_finish', result: 'fail' });
  assert.equal(reusableOffline(f.run, 'npm:test', fp), undefined);
  offlineEvent(f.run, { ...receipt, type: 'offline_finish' });
  writeFileSync(f.evidence, 'new log');
  assert.equal(reusableOffline(f.run, 'npm:test', fp), undefined);
});

test('release checkpoints require both Node versions, current clean content and intact logs', (t) => {
  const f = fixture(t); f.run.spec.mode = 'release'; f.run.spec.contexts.local.grade = 'deployed';
  const attempt = f.append({ type: 'begin', caseId: 'schedule' }); f.append(f.finish(attempt.id));
  const checkpoint = { type: 'checkpoint', result: 'pass', source: source(), node: 'v24.16.0', evidence: evidenceRefs([f.evidence]) };
  offlineEvent(f.run, checkpoint);
  assert.equal(status(f.run, source(), NOW).releasePending, true);
  offlineEvent(f.run, { ...checkpoint, node: 'v22.19.0' });
  assert.equal(status(f.run, source(), NOW).releasePending, false);
  assert.equal(status(f.run, { ...source(), dirty: true }, NOW).releasePending, true);
  assert.equal(status(f.run, { ...source(), tree: 'new-tree' }, NOW).releasePending, true);
  writeFileSync(f.evidence, 'changed');
  assert.equal(status(f.run, source(), NOW).releasePending, true);
});

test('interrupted offline process cannot be cleared while alive, then closes as a retained infrastructure failure', (t) => {
  const f = fixture(t);
  const started = offlineEvent(f.run, { type: 'offline_begin', label: 'npm:test', ownerPid: process.pid, fingerprint: 'one', node: process.version, planId: 'plan-one' }, NOW);
  const event = { type: 'offline_interrupted', attemptId: started.id, processesStopped: true, summary: 'Operator inspected partial log and descendants.', evidence: [f.evidence] };
  assert.throws(() => f.append(event), /still exists/);
  // A finished child is a real dead PID; no arbitrary host process is touched.
  const child = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  started.ownerPid = Number(child.trim());
  f.append(event);
  const view = status(f.run, source(), NOW + 2000);
  assert.equal(view.openOffline.length, 0);
  assert.equal(view.offline.at(-1).category, 'infrastructure');
  assert.equal(view.offline.at(-1).result, 'fail');
});

test('private writes refuse Git/symlink destinations, preserve restrictive permissions and reject concurrent record writes', (t) => {
  const f = fixture(t);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.throws(() => createRun(resolve('private-test-record.json'), f.spec, source(), NOW), /outside Git/);
  const link = join(f.directory, 'checkout'); symlinkSync(process.cwd(), link);
  assert.throws(() => createRun(join(link, 'private-test-record.json'), f.spec, source(), NOW), /outside Git/);
  writeFileSync(`${f.file}.lock`, '{}');
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => updateRun(f.file, () => {}), /locked/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.throws(() => createRun(join(f.directory, 'secret.json'), { ...f.spec, credential: 'hidden' }, source()), /Unexpected|Secret/);
});

test('working-content fingerprints include dirty/untracked source, ignore workflow for product areas and broaden unknown runtime', (t) => {
  const f = fixture(t), repo = join(f.directory, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  mkdirSync(join(repo, 'src/routines'), { recursive: true });
  writeFileSync(join(repo, 'src/routines/example.ts'), 'one');
  git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture');
  const first = sourceInputs(repo);
  mkdirSync(join(repo, 'qa/live/operator'), { recursive: true });
  writeFileSync(join(repo, 'qa/live/operator/SKILL.md'), 'workflow');
  const workflow = sourceInputs(repo);
  assert.notEqual(workflow.tree, first.tree);
  assert.equal(workflow.areas.routines, first.areas.routines);
  writeFileSync(join(repo, 'src/routines/example.ts'), 'two');
  const routines = sourceInputs(repo);
  assert.notEqual(routines.areas.routines, workflow.areas.routines);
  assert.equal(routines.areas.connections, workflow.areas.connections);
  writeFileSync(join(repo, 'src/unknown.ts'), 'boundary');
  const unknown = sourceInputs(repo);
  assert.notEqual(unknown.areas.connections, routines.areas.connections);
  assert.equal(unknown.dirty, true);
});

test('actual CLI init, resume, refresh, finish and generated report use the same private record', (t) => {
  const f = fixture(t), specFile = join(f.directory, 'spec.json'), runFile = join(f.directory, 'cli-run.json');
  // Run in a real synthetic checkout, including when these tests run in an
  // exported source archive with no .git directory of its own.
  const repo = join(f.directory, 'cli-source'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), 'Synthetic CLI source.');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture'], { cwd: repo });
  const actual = structuredClone(f.spec);
  actual.capabilities.owner.observedAt = new Date(Date.now() - 1000).toISOString();
  actual.capabilities.owner.expiresAt = new Date(Date.now() + 60_000).toISOString();
  writeFileSync(specFile, JSON.stringify(actual));
  let output = '', error = '';
  const cli = (...args: string[]) => {
    output = ''; error = '';
    return runRecordCli(args, repo, { stdout: (v: string) => { output += v; }, stderr: (v: string) => { error += v; } });
  };
  assert.equal(cli('init', '--spec', specFile, '--run', runFile), 0, error);
  assert.equal(cli('preflight', '--run', runFile), 0, error);
  assert.equal(cli('begin', '--case', 'schedule', '--run', runFile), 0, error);
  const attemptId = JSON.parse(output).id;
  assert.equal(cli('status', '--run', runFile), 0, error);
  assert.equal(JSON.parse(output).cases[0].result, 'in_progress');
  const event = join(f.directory, 'finish.json'); writeFileSync(event, JSON.stringify(f.finish(attemptId)));
  assert.equal(cli('record', '--event', event, '--run', runFile), 0, error);
  assert.equal(cli('refresh', '--spec', specFile, '--reason', 'Reobserved after resume.', '--run', runFile), 0, error);
  const report = join(f.directory, 'report.md');
  assert.equal(cli('report', '--run', runFile, '--output', report), 0, error);
  assert.match(readFileSync(report, 'utf8'), /local.*synthetic-local.*pass/);
  assert.equal(cli('report', '--run', runFile, '--output', runFile), 2);
  assert.ok(readRun(runFile).events.length > 0);
});
