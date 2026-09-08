import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

// @ts-expect-error Shared executable JavaScript helpers.
import { appendEvent, createRun, evidenceRefs, status } from '../scripts/lib/verification-record.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { caseInputs, changedInputs, digest } from '../scripts/lib/verification-inputs.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { recordTransition, transitionInputs } from '../scripts/lib/verification-transition.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { REGRESSION_AREAS } from '../scripts/lib/regression-plan.mjs';
// @ts-expect-error Shared executable JavaScript helpers.
import { contextScope } from '../scripts/lib/verification-scope.mjs';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const source = () => ({ head: 'a'.repeat(40), dirty: false, tree: 'tree-one', areas: Object.fromEntries(Object.keys(REGRESSION_AREAS).map((area) => [area, 'one'])) });
const intact = (refs: any[]) => refs.every((ref) => {
  try { return digest(readFileSync(ref.path)) === ref.digest; } catch { return false; }
});

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-transition-test-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const evidence = join(directory, 'readback.json'), proof = join(directory, 'transition.json');
  writeFileSync(evidence, '{"fixture":"synthetic"}');
  writeFileSync(proof, '{"candidateMapping":"synthetic deployed version and source readback"}');
  const spec: any = {
    mode: 'changed', purpose: 'verification',
    contexts: { candidate: { grade: 'deployed', target: 'synthetic-worker', servingVersion: 'worker-version-one', model: 'synthetic-model', actor: 'owner-one', fixtures: 'fixture-one', state: 'state-one', config: 'config-one' } },
    capabilities: { owner: { kind: 'actor', available: true, identity: 'owner-one', role: 'owner', observedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 120000).toISOString(), evidence: [evidence] } },
    cases: [['routine', 'routines'], ['memory', 'memory'], ['connection', 'connections']].map(([id, area]) => ({ id, title: `Synthetic ${id}`, context: 'candidate', areas: [area], requires: ['owner'], proof: ['slack'], maxAttempts: 3, maxWaitMs: 120000 })),
  };
  spec.capabilities.owner.scope = contextScope('candidate', spec.contexts.candidate);
  const run = createRun(join(directory, 'run.json'), spec, source(), NOW);
  let tick = 0;
  const append = (event: any, inputs = source()) => appendEvent(run, event, inputs, NOW + ++tick);
  const passes = Object.fromEntries(spec.cases.map((selected: any) => {
    const attempt = append({ type: 'begin', caseId: selected.id });
    const outcome = append({ type: 'finish', attemptId: attempt.id, result: 'pass', summary: 'Read back the expected synthetic result.', evidence: [evidence], proof: { slack: [evidence] } });
    return [selected.id, { attempt, outcome }];
  }));
  const refresh = (nextSpec: any, inputs: any) => append({ type: 'refresh', spec: nextSpec, reason: 'Read back the actual candidate and prerequisites.' }, inputs);
  const transition = (nextSpec: any, inputs: any, extra: any = {}) => {
    const value = recordTransition(run, nextSpec, { type: 'candidate_transition', fromId: passes.memory.attempt.id, context: 'candidate', impactAreas: ['routines'], summary: 'Candidate readbacks map both serving versions to exact source; reviewed changed areas.', evidence: [proof], ...extra }, inputs, evidenceRefs, intact, NOW + tick + 1);
    const event = { ...value, id: `transition-${++tick}`, sequence: run.events.length + 1, at: new Date(NOW + tick).toISOString(), runId: run.id };
    run.events.push(event);
    return event;
  };
  const project = (id: string, nextSpec: any, inputs: any) => {
    const current = caseInputs(nextSpec, nextSpec.cases.find((selected: any) => selected.id === id), inputs);
    const projected = transitionInputs(run, passes[id].attempt, passes[id].outcome, current, intact);
    return { ...projected, invalidation: changedInputs(projected.inputs, current) };
  };
  const nextSource = source(); nextSource.head = 'b'.repeat(40); nextSource.tree = 'tree-two'; nextSource.areas.routines = 'two';
  const nextSpec = structuredClone(spec); nextSpec.contexts.candidate.servingVersion = 'worker-version-two';
  return { run, spec, source: source(), nextSource, nextSpec, passes, append, refresh, transition, project, directory, evidence, proof };
}

test('actual deployed serving-version change carries only unaffected passes and preserves provenance', (t) => {
  const f = fixture(t), originals = structuredClone(f.passes);
  f.refresh(f.nextSpec, f.nextSource);
  assert.deepEqual(f.project('memory', f.nextSpec, f.nextSource).invalidation, ['context']);
  const receipt = f.transition(f.nextSpec, f.nextSource);
  assert.deepEqual(receipt.changedAreas, ['routines']);
  assert.deepEqual(receipt.carried.map((entry: any) => entry.caseId), ['memory', 'connection']);
  assert.deepEqual(receipt.beforeSource, f.source);
  assert.deepEqual(receipt.afterSource, f.nextSource);
  assert.equal(receipt.beforeContext.servingVersion, 'worker-version-one');
  assert.equal(receipt.afterContext.servingVersion, 'worker-version-two');
  for (const id of ['memory', 'connection']) {
    const projected = f.project(id, f.nextSpec, f.nextSource);
    assert.deepEqual(projected.invalidation, []);
    assert.deepEqual(projected.transitionIds, [receipt.id]);
    assert.equal(projected.inputs.context.servingVersion, 'worker-version-two');
  }
  assert.deepEqual(f.project('routine', f.nextSpec, f.nextSource).invalidation, ['source', 'context']);
  assert.deepEqual(f.passes, originals, 'Original begin/outcome provenance must remain unchanged.');
});

test('candidate transitions cannot reuse capabilities from another target or unscoped historical observations', (t) => {
  for (const missing of [false, true]) {
    const f = fixture(t);
    if (missing) {
      delete f.spec.capabilities.owner.scope;
      delete f.nextSpec.capabilities.owner.scope;
      for (const { attempt } of Object.values(f.passes) as any[]) delete attempt.inputs.prerequisites;
    } else f.nextSpec.capabilities.owner.scope.target = 'synthetic-other-worker';
    f.refresh(f.nextSpec, f.nextSource);
    assert.deepEqual(f.transition(f.nextSpec, f.nextSource).carried, []);
    assert.ok(f.project('memory', f.nextSpec, f.nextSource).invalidation.includes('context'));
  }
});

test('legacy passing records carry across a real upgrade using their saved prerequisite contract', (t) => {
  const f = fixture(t);
  for (const { attempt } of Object.values(f.passes) as any[]) delete attempt.inputs.prerequisites;
  const originals = structuredClone(f.passes);
  f.refresh(f.nextSpec, f.nextSource);
  const receipt = f.append({ type: 'candidate_transition', fromId: f.passes.memory.attempt.id, context: 'candidate', impactAreas: ['routines'],
    summary: 'Current candidate and impact readbacks also support the older recorded contract.', evidence: [f.proof] }, f.nextSource);
  assert.deepEqual(receipt.carried.map((entry: any) => entry.caseId), ['memory', 'connection']);
  const view = status(f.run, f.nextSource, NOW + 1000);
  assert.equal(view.cases.find((c: any) => c.id === 'memory').result, 'pass');
  assert.deepEqual(view.cases.find((c: any) => c.id === 'memory').transitionIds, [receipt.id]);
  assert.equal(view.cases.find((c: any) => c.id === 'routine').result, 'stale');
  assert.deepEqual(f.passes, originals);
});

test('legacy attempts after the anchor keep the prerequisite snapshot from their own begin', (t) => {
  const f = fixture(t), stronger = structuredClone(f.spec);
  stronger.capabilities.owner.expectedRole = 'owner';
  f.refresh(stronger, f.source);
  const attempt = f.append({ type: 'begin', caseId: 'connection', reason: 'Fresh proof under the strengthened actor contract.' });
  const outcome = f.append({ type: 'finish', attemptId: attempt.id, result: 'pass', summary: 'Observed the stronger required role.', evidence: [f.evidence], proof: { slack: [f.evidence] } });
  delete attempt.inputs.prerequisites;
  const upgraded = structuredClone(stronger); upgraded.contexts.candidate.servingVersion = 'worker-version-two';
  f.refresh(upgraded, f.nextSource);
  const receipt = f.transition(upgraded, f.nextSource);
  assert.deepEqual(receipt.carried.map((entry: any) => entry.caseId), ['connection']);
  assert.equal(receipt.carried[0].outcomeId, outcome.id);
  assert.equal(status(f.run, f.nextSource, NOW + 1000).cases.find((c: any) => c.id === 'connection').result, 'pass');
  assert.equal(attempt.inputs.prerequisites, undefined);
});

test('a newly unavailable prerequisite cannot carry old acceptance onto a new candidate', (t) => {
  const f = fixture(t), missing = structuredClone(f.nextSpec);
  missing.capabilities.owner.available = false; missing.capabilities.owner.reason = 'The actor is no longer available.';
  f.refresh(missing, f.nextSource);
  assert.deepEqual(f.transition(missing, f.nextSource).carried, []);
  assert.equal(status(f.run, f.nextSource, NOW + 1000).cases.find((c: any) => c.id === 'memory').result, 'stale');
  f.refresh(f.nextSpec, f.nextSource);
  assert.deepEqual(f.transition(f.nextSpec, f.nextSource).carried, [], 'Restoring availability cannot erase the intervening loss.');
});

test('carried evidence stops applying after a prerequisite is reported unavailable', (t) => {
  const f = fixture(t);
  f.refresh(f.nextSpec, f.nextSource); f.transition(f.nextSpec, f.nextSource);
  assert.equal(status(f.run, f.nextSource, NOW + 1000).cases.find((c: any) => c.id === 'memory').result, 'pass');
  const missing = structuredClone(f.nextSpec); missing.capabilities.owner.available = false; missing.capabilities.owner.reason = 'Actor access was removed.';
  f.refresh(missing, f.nextSource); f.refresh(f.nextSpec, f.nextSource);
  assert.equal(status(f.run, f.nextSource, NOW + 1000).cases.find((c: any) => c.id === 'memory').result, 'stale');
});

test('successive candidate upgrades retain every transition and reject replaced proof anywhere in the chain', (t) => {
  const f = fixture(t);
  f.refresh(f.nextSpec, f.nextSource);
  const first = f.transition(f.nextSpec, f.nextSource);
  const thirdSource = structuredClone(f.nextSource); thirdSource.head = 'c'.repeat(40); thirdSource.tree = 'tree-three'; thirdSource.areas.connections = 'three';
  const thirdSpec = structuredClone(f.nextSpec); thirdSpec.contexts.candidate.servingVersion = 'worker-version-three';
  const nextProof = join(f.directory, 'transition-three.json'); writeFileSync(nextProof, 'synthetic next candidate source and serving proof');
  f.refresh(thirdSpec, thirdSource);
  const second = f.transition(thirdSpec, thirdSource, { fromId: first.id, impactAreas: ['connections'], evidence: [nextProof] });
  assert.deepEqual(second.carried.map((entry: any) => entry.caseId), ['memory']);
  assert.deepEqual(second.carried[0].priorTransitionIds, [first.id]);
  assert.deepEqual(f.project('memory', thirdSpec, thirdSource).transitionIds, [first.id, second.id]);
  assert.deepEqual(f.project('memory', thirdSpec, thirdSource).invalidation, []);
  writeFileSync(f.proof, 'replaced first transition proof');
  assert.deepEqual(f.project('memory', thirdSpec, thirdSource).transitionIds, []);
  assert.deepEqual(f.project('memory', thirdSpec, thirdSource).invalidation, ['context']);
});

test('transition refuses incomplete or dirty sources, unmapped changes, undeclared impact and stale refresh', (t) => {
  const f = fixture(t);
  f.refresh(f.nextSpec, f.nextSource);
  assert.throws(() => f.transition(f.nextSpec, f.nextSource, { impactAreas: [] }), /every changed source area/);
  assert.throws(() => f.transition(f.spec, f.nextSource), /different serving version/);
  const unknown = structuredClone(f.nextSource); delete unknown.areas.memory;
  assert.throws(() => f.transition(f.nextSpec, unknown), /complete recorded source/);
  assert.throws(() => f.transition(f.nextSpec, { ...f.nextSource, dirty: true }), /clean complete/);
  assert.throws(() => f.transition(f.nextSpec, { ...f.nextSource, tree: 'not-the-refreshed-source' }), /current refresh/);
  const unmapped = { ...f.source, tree: 'unmapped-change' };
  f.refresh(f.nextSpec, unmapped);
  assert.throws(() => f.transition(f.nextSpec, unmapped), /Unmapped source change/);
});

test('all other runtime changes and unproven intermediate versions require fresh evidence', (t) => {
  const f = fixture(t);
  for (const field of ['grade', 'target', 'model', 'actor', 'fixtures', 'state', 'config']) {
    const changed = structuredClone(f.nextSpec); changed.contexts.candidate[field] = field === 'grade' ? 'local' : 'changed';
    assert.throws(() => f.transition(changed, f.nextSource), /Changed runtime/);
  }
  const third = structuredClone(f.nextSpec); third.contexts.candidate.servingVersion = 'unproven-third-version';
  f.refresh(third, f.nextSource); f.refresh(f.nextSpec, f.nextSource);
  assert.throws(() => f.transition(f.nextSpec, f.nextSource), /Unproven intermediate/);
});

test('changed actor identity, contract, or repaired case cannot silently inherit a carried pass', (t) => {
  const f = fixture(t);
  f.refresh(f.nextSpec, f.nextSource);
  const receipt = f.transition(f.nextSpec, f.nextSource);
  const actor = structuredClone(f.nextSpec); actor.capabilities.owner.identity = 'different-owner';
  assert.deepEqual(f.project('memory', actor, f.nextSource).transitionIds, []);
  const contract = structuredClone(f.nextSpec); contract.cases.find((selected: any) => selected.id === 'memory').proof.push('admin');
  assert.deepEqual(f.project('memory', contract, f.nextSource).transitionIds, []);
  const current = caseInputs(f.nextSpec, f.nextSpec.cases[1], f.nextSource);
  const projected = transitionInputs(f.run, f.passes.memory.attempt, f.passes.memory.outcome, { ...current, repairBatches: ['newly-integrated-repair'] }, intact);
  assert.deepEqual(projected.transitionIds, []);
  assert.equal(receipt.carried.length, 2);
  writeFileSync(f.evidence, 'replaced original live proof');
  assert.deepEqual(f.project('memory', f.nextSpec, f.nextSource).transitionIds, []);
});

test('an actor change later reversed still breaks continuity and cannot gain a new carry receipt', (t) => {
  const f = fixture(t), other = structuredClone(f.nextSpec);
  other.capabilities.owner.identity = 'different-owner';
  f.refresh(other, f.nextSource); f.refresh(f.nextSpec, f.nextSource);
  assert.deepEqual(f.transition(f.nextSpec, f.nextSource).carried, []);
});

test('candidate switches never finish an open attempt or erase an ambiguous scenario', (t) => {
  const f = fixture(t);
  const started = f.append({ type: 'begin', caseId: 'routine', reason: 'Diagnosed routine follow-up.' });
  f.refresh(f.nextSpec, f.nextSource);
  assert.throws(() => f.transition(f.nextSpec, f.nextSource), /Finish\/reconcile open/);
  assert.throws(() => f.append({ type: 'finish', attemptId: started.id, result: 'pass', summary: 'Attempt crossed candidate upgrade.', evidence: [f.evidence], proof: { slack: [f.evidence] } }, f.nextSource), /inputs changed/);
  f.append({ type: 'finish', attemptId: started.id, result: 'ambiguous', category: 'tool', summary: 'Observed uncertain mutation before candidate upgrade.', evidence: [f.evidence], proof: { slack: [f.evidence] } }, f.nextSource);
  assert.throws(() => f.transition(f.nextSpec, f.nextSource), /Finish\/reconcile open/);
  f.append({ type: 'reconcile', attemptId: started.id, outcome: 'not_applied', summary: 'Exact authoritative readback confirms no mutation.', evidence: [f.evidence] }, f.nextSource);
  assert.deepEqual(f.transition(f.nextSpec, f.nextSource).carried.map((entry: any) => entry.caseId), ['memory', 'connection']);
});

test('later runtime changes cannot be hidden by reverting values after a carry receipt', (t) => {
  const f = fixture(t);
  f.refresh(f.nextSpec, f.nextSource); f.transition(f.nextSpec, f.nextSource);
  const changed = structuredClone(f.nextSpec); changed.contexts.candidate.config = 'unrelated-new-config';
  f.refresh(changed, f.nextSource); f.refresh(f.nextSpec, f.nextSource);
  assert.deepEqual(f.project('memory', f.nextSpec, f.nextSource).transitionIds, []);
  assert.deepEqual(f.project('memory', f.nextSpec, f.nextSource).invalidation, ['context']);
});

test('pending target resources require exact verified cleanup before candidate carry-forward', (t) => {
  const f = fixture(t);
  const resource = f.append({ type: 'resource', caseId: 'routine', target: 'synthetic-worker', provider: 'synthetic', kind: 'sheet', immutableId: 'synthetic-sheet', ownership: 'owned', expected: { present: false }, evidence: [f.evidence] });
  f.refresh(f.nextSpec, f.nextSource);
  assert.throws(() => f.transition(f.nextSpec, f.nextSource), /exact cleanup/);
  f.append({ type: 'cleanup', resourceId: resource.id, outcome: 'verified', observed: { present: false }, evidence: [f.evidence] }, f.nextSource);
  assert.equal(f.transition(f.nextSpec, f.nextSource).carried.length, 2);
});
