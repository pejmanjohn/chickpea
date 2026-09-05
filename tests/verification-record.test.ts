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

function offlinePlan(f: ReturnType<typeof fixture>, scripts: string[], results: string[], options: { node?: string; mode?: string; inputs?: ReturnType<typeof source>; config?: string } = {}) {
  const node = options.node ?? 'v24.16.0', mode = options.mode ?? 'changed', inputs = options.inputs ?? source();
  const steps = scripts.map((script) => ({ kind: 'npm', script }));
  const executionFingerprint = digest({ node, config: options.config ?? 'synthetic-config' });
  const fingerprint = digest({ executionFingerprint, source: inputs.tree, steps });
  const plan = offlineEvent(f.run, { type: 'offline_plan', node, mode, source: inputs, steps, fingerprint, executionFingerprint });
  const evidence = evidenceRefs([f.evidence]);
  for (const [index, result] of results.entries()) {
    const label = `npm:${scripts[index]}`;
    const started = offlineEvent(f.run, { type: 'offline_begin', planId: plan.id, label, node, source: inputs, fingerprint, ownerPid: process.pid });
    offlineEvent(f.run, { type: 'offline_finish', planId: plan.id, attemptId: started.id, label, node, fingerprint, result, durationMs: 1, evidence });
  }
  const pass = results.length === scripts.length && results.every((r) => r === 'pass');
  offlineEvent(f.run, { type: 'offline_summary', planId: plan.id, result: pass ? 'pass' : 'fail' });
  if (pass && mode === 'release') offlineEvent(f.run, { type: 'checkpoint', planId: plan.id, result: 'pass', source: inputs, node, fingerprint, evidence });
  return plan;
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

test('refresh preserves deployed acceptance even when a case moves contexts', (t) => {
  const f = fixture(t);
  f.spec.mode = 'release'; f.spec.contexts.local.grade = 'deployed';
  const selected = structuredClone(f.spec) as any;
  selected.contexts.installation = { ...selected.contexts.local, target: 'synthetic-installation' };
  selected.cases.push({ ...selected.cases[0], id: 'installation', context: 'installation' });
  f.append({ type: 'refresh', spec: selected, reason: 'Select independent deployed installation acceptance.' });
  const downgraded = structuredClone(selected); downgraded.contexts.local.grade = 'local';
  assert.throws(() => f.append({ type: 'refresh', spec: downgraded, reason: 'Local repair cannot replace deployed acceptance.' }), /acceptance grade/);
  const moved = structuredClone(selected);
  moved.contexts.repair = { ...selected.contexts.local, grade: 'local', target: 'synthetic-local-repair' };
  moved.cases[0].context = 'repair';
  assert.throws(() => f.append({ type: 'refresh', spec: moved, reason: 'Moving the context cannot bypass the grade.' }), /acceptance grade/);
  moved.cases[0].context = 'local';
  moved.cases.push({ ...moved.cases[0], id: 'local-repair', context: 'repair' });
  f.append({ type: 'refresh', spec: moved, reason: 'Local repair gets its own acceptance case.' });
  const local = f.append({ type: 'begin', caseId: 'local-repair' }); f.append(f.finish(local.id));
  const view = status(f.run, source(), NOW + 2000);
  assert.equal(view.cases.find((c: any) => c.id === 'local-repair').result, 'pass');
  assert.equal(view.cases.find((c: any) => c.id === 'schedule').grade, 'deployed');
  assert.equal(view.cases.find((c: any) => c.id === 'schedule').result, 'not_run');
  assert.equal(view.complete, false);
});

test('refresh cannot weaken required capability kinds or expected member roles', (t) => {
  const f = fixture(t), spec = structuredClone(f.spec) as any;
  spec.capabilities.member = { ...spec.capabilities.owner, identity: 'synthetic-member', role: 'member', expectedRole: 'member' };
  spec.cases[0].requires.push('member');
  f.append({ type: 'refresh', spec, reason: 'Select a real member denial prerequisite.' });
  for (const change of [
    (next: any) => { delete next.capabilities.member.expectedRole; },
    (next: any) => { next.capabilities.member.expectedRole = 'owner'; },
    (next: any) => { next.capabilities.member.kind = 'fixture'; },
    (next: any) => { delete next.capabilities.member; },
  ]) {
    const weakened = structuredClone(spec); change(weakened);
    assert.throws(() => f.append({ type: 'refresh', spec: weakened, reason: 'Cannot erase the required member contract.' }), /required capability contract/);
  }
  spec.capabilities.member.identity = 'replacement-member';
  f.append({ type: 'refresh', spec, reason: 'A newly observed member can retain the same contract.' });
  assert.equal(preflight(f.run, NOW + 2000).ready, true);
});

test('stronger actor requirements invalidate prior proof while unchanged legacy contracts keep their provenance', (t) => {
  const f = fixture(t), attempt = f.append({ type: 'begin', caseId: 'schedule' }); f.append(f.finish(attempt.id));
  delete attempt.inputs.prerequisites; // A persisted record from before explicit prerequisite fingerprints.
  assert.equal(status(f.run, source(), NOW + 2000).cases[0].result, 'pass');
  const spec = structuredClone(f.spec) as any; spec.capabilities.owner.expectedRole = 'member';
  f.append({ type: 'refresh', spec, reason: 'New acceptance requires an actual member.' });
  const view = status(f.run, source(), NOW + 2000);
  assert.equal(view.cases[0].result, 'stale');
  assert.ok(view.cases[0].invalidation.includes('prerequisites'));
  assert.equal(view.complete, false);
  assert.throws(() => f.append({ type: 'begin', caseId: 'schedule', reason: 'Owner cannot substitute for member.' }), /blocked/);
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
  offlinePlan(f, ['test'], ['pass'], { mode: 'release' });
  assert.equal(status(f.run, source(), NOW).releasePending, true);
  offlinePlan(f, ['test'], ['pass'], { mode: 'release', node: 'v22.19.0' });
  assert.equal(status(f.run, source(), NOW).releasePending, false);
  assert.equal(status(f.run, { ...source(), dirty: true }, NOW).releasePending, true);
  assert.equal(status(f.run, { ...source(), tree: 'new-tree' }, NOW).releasePending, true);
  writeFileSync(f.evidence, 'changed');
  assert.equal(status(f.run, source(), NOW).releasePending, true);
});

test('independent offline plans cannot hide failed required coverage and a relevant rerun resolves it', (t) => {
  const f = fixture(t), live = f.append({ type: 'begin', caseId: 'schedule' }); f.append(f.finish(live.id));
  const failed = offlinePlan(f, ['typecheck', 'verify:durability'], ['pass', 'fail']);
  assert.equal(status(f.run, source(), NOW).complete, false);
  offlinePlan(f, ['typecheck'], ['pass']);
  assert.equal(status(f.run, source(), NOW).complete, false, 'The earlier durability obligation remains failed.');
  offlinePlan(f, ['verify:durability'], ['pass']);
  assert.equal(status(f.run, source(), NOW).complete, true);
  assert.ok(f.run.events.some((e: any) => e.planId === failed.id && e.type === 'offline_finish' && e.result === 'fail'));
});

test('a failed full release cannot reuse its older checkpoint or be cleared by narrower recovery', (t) => {
  const f = fixture(t); f.run.spec.mode = 'release'; f.run.spec.contexts.local.grade = 'deployed';
  const live = f.append({ type: 'begin', caseId: 'schedule' }); f.append(f.finish(live.id));
  for (const node of ['v22.19.0', 'v24.16.0']) offlinePlan(f, ['test', 'verify:durability'], ['pass', 'pass'], { node, mode: 'release' });
  assert.equal(status(f.run, source(), NOW).complete, true);
  offlinePlan(f, ['test', 'verify:durability'], ['pass', 'fail'], { mode: 'release' });
  offlinePlan(f, ['verify:durability'], ['pass']);
  assert.equal(status(f.run, source(), NOW).releasePending, true);
  assert.equal(status(f.run, source(), NOW).complete, false);
  offlinePlan(f, ['test', 'verify:durability'], ['pass', 'pass'], { mode: 'release' });
  assert.equal(status(f.run, source(), NOW).complete, true);
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

function repairFixture(t: TestContext) {
  const f = fixture(t);
  for (const [id, area] of [['other-schedule', 'routines'], ['connection', 'connections'], ['memory', 'memory']]) {
    f.run.spec.cases.push({ ...f.spec.cases[0], id, areas: [area] });
  }
  const fail = (caseId: string) => {
    const attempt = f.append({ type: 'begin', caseId });
    return f.append(f.finish(attempt.id, { result: 'fail', category: 'product', summary: `Preserved ${caseId} failure.` }));
  };
  const repair = (id: string, failureId: string, area: string, extra: object = {}) => ({
    type: 'repair', repairId: id, failureIds: [failureId], priority: 'isolated', owner: `agent-${id}`,
    state: 'diagnosing', areas: [area], blocks: [], summary: 'Diagnose from the retained boundary.', ...extra,
  });
  const ready = (value: object, extra: object = {}) => ({
    ...value, state: 'ready', commits: ['b'.repeat(40)], reviewer: 'verifier', evidence: [f.evidence], ...extra,
  });
  const refresh = (at = NOW + 3500, inputs = source(), servingVersion?: string) => {
    const spec = structuredClone(f.run.events.findLast((e: any) => e.type === 'refresh')?.spec ?? f.run.spec);
    for (const cap of Object.values(spec.capabilities) as any[]) {
      cap.observedAt = new Date(at).toISOString(); cap.expiresAt = new Date(at + 60000).toISOString();
    }
    if (servingVersion) spec.contexts.local.servingVersion = servingVersion;
    f.append({ type: 'refresh', spec, reason: 'Read back restored prerequisites and actual serving candidate.' }, at, inputs);
  };
  return { ...f, fail, repair, ready, refresh };
}

test('isolated delegated repairs preserve failures while independent verification continues', (t) => {
  const f = repairFixture(t), failure = f.fail('schedule');
  f.append(f.repair('destination', failure.id, 'routines', { blocks: ['schedule'], paths: ['src/routines'] }));
  assert.throws(() => f.append({ type: 'begin', caseId: 'schedule', reason: 'Retry unchanged.' }), /preflight is blocked/);
  const independent = f.append({ type: 'begin', caseId: 'memory' }); f.append(f.finish(independent.id));
  const before = JSON.stringify(f.run);
  const view = status(f.run, source(), NOW + 2000);
  assert.equal(view.cases.find((c: any) => c.id === 'memory').result, 'pass');
  assert.equal(view.cases.find((c: any) => c.id === 'schedule').firstFailure.id, failure.id);
  assert.deepEqual(view.nextActions, [{ action: 'continue_independent_cases', caseIds: ['other-schedule', 'connection'] }]);
  assert.equal(JSON.stringify(f.run), before, 'Status must not rewrite original journal events.');
  assert.match(renderReport(view), /destination.*agent-destination.*isolated.*diagnosing/);
  assert.equal(view.complete, false);
});

test('urgent blockers suspend their dependencies, including earlier passes and active attempts', (t) => {
  const f = repairFixture(t), failure = f.fail('schedule');
  const memory = f.append({ type: 'begin', caseId: 'memory' }); f.append(f.finish(memory.id));
  const running = f.append({ type: 'begin', caseId: 'other-schedule' });
  f.append(f.repair('isolation', failure.id, 'auth', { priority: 'urgent', blocks: ['schedule', 'other-schedule', 'memory'] }));
  assert.throws(() => f.append(f.finish(running.id)), /suspended by a repair/);
  f.append(f.finish(running.id, { result: 'blocked', category: 'infrastructure' }));
  const view = status(f.run, source(), NOW + 2000);
  assert.equal(view.cases.find((c: any) => c.id === 'memory').result, 'blocked');
  assert.deepEqual(view.nextActions[0], { action: 'prioritize_repair', repairIds: ['isolation'] });
  assert.deepEqual(view.nextActions[1], { action: 'continue_independent_cases', caseIds: ['connection'] });
  assert.ok(f.append({ type: 'begin', caseId: 'connection' }));
});

test('batch checkpoints integrate ready compatible work without waiting for an arbitrary repair count', (t) => {
  const f = repairFixture(t), first = f.fail('schedule'), second = f.fail('connection');
  const ready = f.repair('destination', first.id, 'routines', { paths: ['src/routines/scheduler.ts'] });
  const unfinished = f.repair('connector', second.id, 'connections', { paths: ['src/routines', 'src/connections'] });
  f.append(f.ready(ready)); f.append(unfinished);
  const plan = { type: 'batch', batchId: 'checkpoint', repairIds: ['destination', 'connector'], state: 'planned', reason: 'Finish independent memory coverage, then unblock schedule retests.', reviewAt: new Date(NOW + 5000).toISOString() };
  assert.throws(() => f.append({ ...plan, reviewAt: new Date(NOW + 90_000_000).toISOString() }), /bounded review/);
  f.append(plan);
  assert.deepEqual(status(f.run, source(), NOW + 6000).nextActions[0], { action: 'review_batch_boundary', batchId: 'checkpoint', readyRepairIds: ['destination'] });
  assert.deepEqual(status(f.run, source(), NOW + 2000).repairs[0].overlapWith, ['connector']);
  assert.throws(() => f.append({ type: 'batch', batchId: 'other', repairIds: ['destination'], state: 'integrated', reason: 'Duplicate membership.', evidence: [f.evidence] }), /another planned batch/);
  assert.throws(() => f.append({ type: 'batch', batchId: 'checkpoint', repairIds: ['destination', 'connector'], state: 'integrated', reason: 'Too early.', evidence: [f.evidence] }), /ready repairs/);
  f.append({ type: 'batch', batchId: 'checkpoint', repairIds: ['destination'], state: 'integrated', reason: 'Ready subset unlocks two schedule cases; connector stays with its owner.', evidence: [f.evidence] });
  const view = status(f.run, source(), NOW + 6000);
  assert.deepEqual(view.batches[0].areas, ['routines']);
  assert.deepEqual(view.batches[0].pendingRetests, ['other-schedule', 'schedule']);
  assert.equal(view.repairs.find((r: any) => r.repairId === 'connector').state, 'diagnosing');
  assert.equal(view.repairs.find((r: any) => r.repairId === 'destination').state, 'retest');
  f.append(f.ready(unfinished));
  assert.ok(status(f.run, source(), NOW + 7000).nextActions.some((a: any) => a.action === 'choose_batch_boundary' && a.repairIds.includes('connector')));
});

test('combined repairs require all original failures and union impact to pass on the integrated candidate', (t) => {
  const f = repairFixture(t), first = f.fail('schedule'), second = f.fail('connection');
  const earlier = f.append({ type: 'begin', caseId: 'other-schedule' }); f.append(f.finish(earlier.id));
  const memory = f.append({ type: 'begin', caseId: 'memory' }); f.append(f.finish(memory.id));
  f.append(f.ready(f.repair('destination', first.id, 'routines')));
  f.append(f.ready(f.repair('connector', second.id, 'connections'), { commits: ['c'.repeat(40)] }));
  const candidate = source(); candidate.areas.routines = 'two'; candidate.areas.connections = 'two'; candidate.tree = 'combined'; candidate.head = 'b'.repeat(40);
  const integrated = f.append({ type: 'batch', batchId: 'combined', repairIds: ['destination', 'connector'], state: 'integrated', reason: 'Reviewed interaction and checked the combined impact once.', evidence: [f.evidence] }, NOW + 3000, candidate);
  assert.deepEqual(integrated.areas, ['connections', 'routines']);
  assert.deepEqual(integrated.commits, ['b'.repeat(40), 'c'.repeat(40)]);
  assert.throws(() => f.append({ type: 'begin', caseId: 'schedule', reason: 'Integration without fresh readbacks.' }, NOW + 3500, candidate), /blocked/);
  f.refresh(NOW + 3500, candidate, 'version-two');
  assert.equal(status(f.run, candidate, NOW + 3600).cases.find((c: any) => c.id === 'memory').result, 'stale', 'An actual version change needs explicit transition proof.');
  const transition = f.append({ type: 'candidate_transition', fromId: memory.id, context: 'local', impactAreas: ['routines', 'connections'],
    summary: 'Read back version two serving the reviewed source; memory inputs and state are unchanged.', evidence: [f.evidence] }, NOW + 3700, candidate);
  let view = status(f.run, candidate, NOW + 4000);
  assert.equal(view.cases.find((c: any) => c.id === 'memory').result, 'pass');
  assert.equal(view.cases.find((c: any) => c.id === 'memory').originalServingVersion, 'version-one');
  assert.equal(view.cases.find((c: any) => c.id === 'memory').effectiveServingVersion, 'version-two');
  assert.deepEqual(view.cases.find((c: any) => c.id === 'memory').transitionIds, [transition.id]);
  assert.equal(view.cases.find((c: any) => c.id === 'other-schedule').result, 'stale');
  assert.equal(view.complete, false);
  for (const caseId of ['schedule', 'connection']) {
    const attempt = f.append({ type: 'begin', caseId, reason: 'Original failed boundary on integrated candidate.' }, NOW + 5000, candidate);
    f.append(f.finish(attempt.id), NOW + 6000, candidate);
  }
  assert.deepEqual(status(f.run, candidate, NOW + 7000).batches[0].pendingRetests, ['other-schedule']);
  const impact = f.append({ type: 'begin', caseId: 'other-schedule', reason: 'Combined impact beyond the original failures.' }, NOW + 8000, candidate);
  f.append(f.finish(impact.id), NOW + 9000, candidate);
  const journal = JSON.stringify(f.run);
  view = status(f.run, candidate, NOW + 10000);
  assert.equal(view.complete, true);
  assert.ok(view.repairs.every((r: any) => r.state === 'verified'));
  assert.equal(view.cases.find((c: any) => c.id === 'schedule').firstFailure.id, first.id);
  assert.equal(JSON.stringify(f.run), journal);
  assert.match(renderReport(view), /Batch combined: retests verified/);
  assert.match(renderReport(view), /memory evidence originally observed on version-one; carried to version-two/);
  const unrelated = structuredClone(candidate); unrelated.areas.verification = 'new-workflow';
  assert.equal(status(f.run, unrelated, NOW + 10000).batches[0].complete, true);
  const changed = structuredClone(candidate); changed.areas.routines = 'three'; changed.tree = 'additional-routine-change'; changed.head = 'c'.repeat(40);
  assert.equal(status(f.run, changed, NOW + 10000).batches[0].checksStale, true);
  f.refresh(NOW + 10500, changed, 'version-three');
  f.append({ type: 'candidate_transition', fromId: transition.id, context: 'local', impactAreas: ['routines'],
    summary: 'Read back version three and unchanged memory/connection inputs after the routine-only correction.', evidence: [f.evidence] }, NOW + 10700, changed);
  for (const caseId of ['schedule', 'other-schedule']) {
    const attempt = f.append({ type: 'begin', caseId, reason: 'Additional routine change.' }, NOW + 11000, changed);
    f.append(f.finish(attempt.id), NOW + 12000, changed);
  }
  assert.equal(status(f.run, changed, NOW + 13000).complete, false, 'Passing cases do not refresh combined check evidence.');
  assert.ok(status(f.run, changed, NOW + 13000).nextActions.some((a: any) => a.action === 'refresh_batch_check_evidence'));
  f.append({ type: 'batch_check', batchId: 'combined', reviewer: 'verifier', summary: 'Reviewed changed union and reran its focused checks.', evidence: [f.evidence] }, NOW + 14000, changed);
  assert.equal(status(f.run, changed, NOW + 15000).complete, true);
});

test('candidate integration waits for open or unreconciled scenarios even through a target alias', (t) => {
  const f = repairFixture(t), failed = f.fail('schedule');
  f.run.spec.contexts.alias = { ...f.run.spec.contexts.local };
  f.run.spec.cases.find((c: any) => c.id === 'memory').context = 'alias';
  f.append(f.ready(f.repair('destination', failed.id, 'routines')));
  const batch = { type: 'batch', batchId: 'one', repairIds: ['destination'], state: 'integrated', reason: 'Unblock schedule coverage.', evidence: [f.evidence] };
  const running = f.append({ type: 'begin', caseId: 'memory' });
  assert.throws(() => f.append(batch), /Finish\/reconcile/);
  const moved = structuredClone(f.run.spec); moved.contexts.alias.target = 'another-synthetic-target';
  f.append({ type: 'refresh', spec: moved, reason: 'Context refresh cannot hide an open scenario on its original target.' });
  assert.throws(() => f.append(batch), /Finish\/reconcile/);
  f.append({ type: 'refresh', spec: f.run.spec, reason: 'Return to the original observed target.' });
  f.append(f.finish(running.id, { result: 'ambiguous', category: 'tool' }));
  assert.throws(() => f.append(batch), /Finish\/reconcile/);
  f.append({ type: 'reconcile', attemptId: running.id, outcome: 'applied', summary: 'Exact saved mutation is present.', evidence: [f.evidence] });
  assert.throws(() => f.append(batch), /Finish\/reconcile/);
  f.append({ ...f.finish(running.id), type: 'resolve' });
  assert.ok(f.append(batch));
});

test('repair readiness keeps independent review, evidence integrity, and accumulated failure scope', (t) => {
  const f = repairFixture(t), failure = f.fail('schedule');
  const repair = f.repair('destination', failure.id, 'routines', { blocks: ['schedule'] });
  assert.throws(() => f.append(f.ready(repair, { reviewer: repair.owner })), /separate reviewer/);
  assert.throws(() => f.append(f.ready(repair, { commits: ['short-sha'] })), /individual commit/);
  assert.throws(() => f.append(f.ready(repair, { evidence: [] })), /Evidence references/);
  assert.throws(() => f.append({ ...repair, failureIds: ['missing-failure'] }), /preserved/);
  f.append(repair);
  assert.throws(() => f.append({ ...repair, blocks: [] }), /cannot discard/);
  const reviewed = join(f.directory, 'review.json'); writeFileSync(reviewed, 'initial reviewed patch');
  f.append(f.ready(repair, { evidence: [reviewed] }));
  f.append({ type: 'batch', batchId: 'one', repairIds: ['destination'], state: 'planned', reason: 'Wait for independent checks to finish.', reviewAt: new Date(NOW + 5000).toISOString() });
  writeFileSync(reviewed, 'replaced review');
  const view = status(f.run, source(), NOW + 6000);
  assert.equal(view.repairs[0].state, 'evidence_stale');
  assert.deepEqual(view.batches[0].readyRepairIds, []);
  const integrated = { type: 'batch', batchId: 'one', repairIds: ['destination'], state: 'integrated', reason: 'Ready checkpoint.', evidence: [f.evidence] };
  assert.throws(() => f.append(integrated), /intact evidence/);
  f.append(f.ready(repair, { evidence: [reviewed] }));
  f.append(integrated);
  assert.throws(() => f.append(integrated), /immutable/);
  assert.throws(() => f.append(f.ready(repair)), /immutable/);
  assert.throws(() => f.append({ type: 'batch_check', batchId: 'one', reviewer: repair.owner, summary: 'Self review.', evidence: [f.evidence] }), /separate from/);
});

test('urgent fixture recovery needs no code commit but keeps dependents blocked until fresh readback', (t) => {
  const f = repairFixture(t), failure = f.fail('schedule');
  const repair = f.repair('fixture', failure.id, 'routines', { kind: 'recovery', priority: 'urgent', blocks: ['schedule'] });
  f.append(repair);
  f.append({ ...repair, state: 'ready', reviewer: 'verifier', evidence: [f.evidence], summary: 'Restored the exact before-value and reviewed its readback.' });
  const batch = f.append({ type: 'batch', batchId: 'restored', repairIds: ['fixture'], state: 'integrated', reason: 'Fixture restored without a source change.', evidence: [f.evidence] });
  assert.deepEqual(batch.commits, []);
  assert.throws(() => f.append({ type: 'begin', caseId: 'schedule', reason: 'Too early.' }), /blocked/);
  f.append({ type: 'refresh', spec: f.spec, reason: 'Old observations are insufficient.' }, NOW + 2000);
  assert.throws(() => f.append({ type: 'begin', caseId: 'schedule', reason: 'Still too early.' }, NOW + 2500), /blocked/);
  f.refresh();
  for (const caseId of ['schedule', 'other-schedule', 'connection', 'memory']) {
    const attempt = f.append({ type: 'begin', caseId, reason: 'Verify observed restoration.' }, NOW + 4000);
    f.append(f.finish(attempt.id), NOW + 5000);
  }
  const view = status(f.run, source(), NOW + 6000);
  assert.equal(view.repairs[0].state, 'verified');
  assert.equal(view.complete, true);
  assert.equal(view.cases[0].firstFailure.id, failure.id);
});
