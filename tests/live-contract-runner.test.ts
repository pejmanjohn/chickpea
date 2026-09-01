import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LIVE_MANIFEST_DIGEST } from '../qa/live/manifest.ts';
import { advanceLiveRun, type AdvanceLiveRunRequest } from '../qa/live/runner.ts';
import { appendRunJournal, createRunJournal, readRunJournal } from '../qa/live/safety/journal.ts';

const overlay = JSON.parse(readFileSync(new URL('../qa/live/target.example.json', import.meta.url), 'utf8')) as unknown;
const identity = {
  targetFingerprint: 'sha256:target',
  repositoryRevision: '0123456789abcdef',
  servingVersion: 'version-1',
};
const doctorSnapshot = {
  schemaVersion: 'chickpea-live-doctor-snapshot/v1' as const,
  manifestDigest: LIVE_MANIFEST_DIGEST,
  ...identity,
  missingActorAliases: [],
  workspaceMatches: true,
  unavailableObserverIds: [],
  evidenceRootSafe: true,
  targetMatches: true,
  lock: { status: 'clear' as const },
};

function setup(context: test.TestContext, variants = ['LC01-V1-create-welcome']): AdvanceLiveRunRequest {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-live-runner-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    journalPath: join(directory, 'run.jsonl'),
    runId: `run-${directory.split('-').at(-1)}`,
    suite: 'case',
    variantIds: variants,
    overlay,
    doctorSnapshot,
    identity,
    now: '2026-09-01T12:00:00.000Z',
  };
}

function cleanupProgress(status: 'pass' | 'failed' = 'pass') {
  return {
    progressCleanup: () => ({
      status: 'complete' as const,
      postflight: {
        status,
        targetIdentityMatches: true,
        missingAliases: status === 'pass' ? [] : ['agent:baseline:1'],
        unexpectedAliases: [],
        unresolvedAliases: [],
      },
    }),
  };
}

test('suite policy rejects feature-lane deep before creating a journal', (context) => {
  const request = setup(context);
  const featureOverlay = structuredClone(overlay) as Record<string, unknown>;
  featureOverlay.targetAlias = 'feature-lane-one';
  featureOverlay.allowedSuites = ['case', 'smoke'];
  assert.throws(
    () => {
      const { variantIds: _variantIds, ...withoutVariants } = request;
      return advanceLiveRun({ ...withoutVariants, suite: 'deep', overlay: featureOverlay });
    },
    /SUITE_NOT_ALLOWED/,
  );
  assert.equal(existsSync(request.journalPath), false);
});

test('target variant policy admits only selected cases and exact contained suite inventories', (context) => {
  const request = setup(context);
  const subsetOverlay = structuredClone(overlay) as Record<string, any>;
  const allowedVariant = 'LC01-V1-create-welcome';
  subsetOverlay.allowedSuites = ['case', 'smoke'];
  subsetOverlay.allowedVariants = [allowedVariant];
  subsetOverlay.bindings = { [allowedVariant]: subsetOverlay.bindings[allowedVariant] };

  assert.equal(advanceLiveRun({ ...request, overlay: subsetOverlay }).kind, 'action_required');

  const denied = setup(context, ['LC01-V2-update-approve']);
  assert.throws(
    () => advanceLiveRun({ ...denied, overlay: subsetOverlay }),
    /SUITE_NOT_ALLOWED/,
  );
  assert.equal(existsSync(denied.journalPath), false);

  const smoke = setup(context);
  const { variantIds: _variantIds, ...withoutVariants } = smoke;
  assert.throws(
    () => advanceLiveRun({ ...withoutVariants, suite: 'smoke', overlay: subsetOverlay }),
    /SUITE_NOT_ALLOWED/,
  );
  assert.equal(existsSync(smoke.journalPath), false);
});

test('proof-first state machine flushes intent before exposing the first action', (context) => {
  const request = setup(context);
  const record = advanceLiveRun(request);
  assert.equal(record.kind, 'action_required');

  const journal = readRunJournal(request.journalPath, {
    runId: request.runId,
    manifestDigest: LIVE_MANIFEST_DIGEST,
  });
  assert.deepEqual(journal.events.map((event) => event.event.type), [
    'doctor', 'intent', 'transition',
  ]);
  assert.equal(journal.events[1]?.event.type, 'intent');
  assert.equal(journal.events[2]?.event.type, 'transition');
});

test('an interrupted action resumes exactly and a durable receipt prevents replay', (context) => {
  const request = setup(context);
  const first = advanceLiveRun(request);
  assert.equal(first.kind, 'action_required');
  if (first.kind !== 'action_required') return;

  const resumed = advanceLiveRun(request);
  assert.deepEqual(resumed, first);

  const assertion = advanceLiveRun({
    ...request,
    signal: { type: 'action_receipt', actionRef: first.actionRef, outcome: 'completed' },
  });
  assert.equal(assertion.kind, 'assertion');
  assert.throws(() => advanceLiveRun({
    ...request,
    signal: { type: 'action_receipt', actionRef: first.actionRef, outcome: 'completed' },
  }), /receipt|state|replay/i);
});

test('an ambiguous action receipt pauses for authoritative readback before cleanup or scoring', (context) => {
  const request = setup(context);
  const action = advanceLiveRun(request);
  assert.equal(action.kind, 'action_required');
  if (action.kind !== 'action_required') return;

  const recovery = advanceLiveRun({ ...request, signal: {
    type: 'action_receipt', actionRef: action.actionRef, outcome: 'ambiguous',
  } });
  assert.equal(recovery.kind, 'waiting');
  if (recovery.kind !== 'waiting') return;
  assert.equal(recovery.waitingFor, 'authoritative_readback');
  let journal = readRunJournal(request.journalPath, {
    runId: request.runId, manifestDigest: LIVE_MANIFEST_DIGEST,
  });
  assert.equal(journal.events.some(({ event }) => event.type === 'case_result'), false);
  assert.equal(journal.events.some(({ event }) => event.type === 'cleanup_result'), false);

  const retry = advanceLiveRun({ ...request, signal: {
    type: 'readback_result', intentId: `intent:${action.actionRef}`, outcome: 'absent',
  } });
  assert.equal(retry.kind, 'action_required');
  if (retry.kind === 'action_required') {
    assert.notEqual(retry.actionRef, action.actionRef);
    assert.match(retry.actionRef, /:2$/);
  }
  journal = readRunJournal(request.journalPath, {
    runId: request.runId, manifestDigest: LIVE_MANIFEST_DIGEST,
  });
  assert.equal(journal.events.some(({ event }) => event.type === 'case_result'), false);
});

test('resume adopts a completed receipt flushed before its transition without re-exposing the action', (context) => {
  const request = setup(context);
  const action = advanceLiveRun(request);
  assert.equal(action.kind, 'action_required');
  if (action.kind !== 'action_required') return;
  assert.throws(() => advanceLiveRun({ ...request, signal: {
    type: 'action_receipt', actionRef: action.actionRef, outcome: 'completed',
  } }, {
    afterReceiptFlushed: () => { throw new Error('receipt crash'); },
  }), /receipt crash/);

  const resumed = advanceLiveRun(request);
  assert.equal(resumed.kind, 'assertion');
  assert.notEqual(resumed.kind, 'action_required');
});

test('resume adopts a terminal human-gate receipt flushed before transition and proceeds to cleanup', (context) => {
  const request = setup(context, ['LC01-V2-update-approve']);
  const action = advanceLiveRun(request);
  assert.equal(action.kind, 'action_required');
  if (action.kind !== 'action_required') return;
  assert.throws(() => advanceLiveRun({ ...request, signal: {
    type: 'action_receipt', actionRef: action.actionRef, outcome: 'denied',
  } }, {
    afterReceiptFlushed: () => { throw new Error('receipt crash'); },
  }), /receipt crash/);

  const cleanup = advanceLiveRun(request);
  assert.equal(cleanup.kind, 'waiting');
  if (cleanup.kind === 'waiting') assert.equal(cleanup.waitingFor, 'cleanup');
  const terminal = advanceLiveRun(request, cleanupProgress());
  assert.equal(terminal.kind, 'terminal');
  if (terminal.kind === 'terminal') {
    assert.deepEqual(terminal.report.cases[0]?.primary, {
      result: 'blocked', reason: 'human_gate_denied',
    });
  }
});

test('resume after header and doctor but before first intent exposes the first action', (context) => {
  const request = setup(context);
  createRunJournal(request.journalPath, {
    runId: request.runId,
    manifestDigest: LIVE_MANIFEST_DIGEST,
    ...identity,
    suite: 'case',
    variantIds: ['LC01-V1-create-welcome'],
    createdAt: request.now as string,
  });
  appendRunJournal(request.journalPath, {
    type: 'doctor', ready: true, diagnosticCodes: [],
  }, { runId: request.runId, manifestDigest: LIVE_MANIFEST_DIGEST, at: request.now as string });

  const action = advanceLiveRun(request);
  assert.equal(action.kind, 'action_required');
  if (action.kind === 'action_required') assert.equal(action.variantId, 'LC01-V1-create-welcome');
});

test('a crash after intent enters readback recovery and never exposes the mutation', (context) => {
  const request = setup(context);
  assert.throws(() => advanceLiveRun(request, {
    afterIntentFlushed: () => { throw new Error('simulated crash'); },
  }), /simulated crash/);

  const resumed = advanceLiveRun(request);
  assert.equal(resumed.kind, 'waiting');
  if (resumed.kind === 'waiting') {
    assert.equal(resumed.waitingFor, 'authoritative_readback');
  }
  assert.equal(JSON.stringify(resumed).includes('Create the run-marked'), false);
});

test('authoritative readback of an applied crash intent enters cleanup-only recovery', (context) => {
  const request = setup(context);
  assert.throws(() => advanceLiveRun(request, {
    afterIntentFlushed: () => { throw new Error('simulated crash'); },
  }), /simulated crash/);
  const waiting = advanceLiveRun(request);
  assert.equal(waiting.kind, 'waiting');
  if (waiting.kind !== 'waiting' || waiting.actionRef === undefined) return;

  const cleanup = advanceLiveRun({ ...request, signal: {
    type: 'readback_result',
    intentId: `intent:${waiting.actionRef}`,
    outcome: 'applied',
  } });
  assert.equal(cleanup.kind, 'waiting');
  if (cleanup.kind === 'waiting') assert.equal(cleanup.waitingFor, 'cleanup');
  const terminal = advanceLiveRun(request, cleanupProgress());
  assert.equal(terminal.kind, 'terminal');
  if (terminal.kind === 'terminal') {
    assert.deepEqual(terminal.report.cases[0]?.primary, {
      result: 'ambiguous', reason: 'ambiguous_mutation',
    });
  }
});

test('serial suite does not expose the next mutation until assertion and cleanup finish', (context) => {
  const request = setup(context, ['LC01-V1-create-welcome', 'LC04-V1-personal-read']);
  const first = advanceLiveRun(request);
  assert.equal(first.kind, 'action_required');
  if (first.kind !== 'action_required') return;

  const assertion = advanceLiveRun({ ...request, signal: {
    type: 'action_receipt', actionRef: first.actionRef, outcome: 'completed',
  } });
  assert.equal(assertion.kind, 'assertion');
  const cleanup = advanceLiveRun({ ...request, signal: {
    type: 'assertion_result', variantId: first.variantId, result: 'pass',
  } });
  assert.equal(cleanup.kind, 'waiting');
  const second = advanceLiveRun(request, cleanupProgress());
  assert.equal(second.kind, 'action_required');
  if (second.kind === 'action_required') assert.equal(second.variantId, 'LC04-V1-personal-read');
});

test('a declared observation window keeps the suite serial until its due time', (context) => {
  const request = setup(context, ['LC08-V1-create-due', 'LC04-V1-personal-read']);
  const action = advanceLiveRun(request);
  assert.equal(action.kind, 'action_required');
  if (action.kind !== 'action_required') return;
  const notBefore = '2026-09-01T12:05:00.000Z';
  const waiting = advanceLiveRun({ ...request, signal: {
    type: 'action_receipt', actionRef: action.actionRef, outcome: 'completed',
  } }, { observationNotBefore: () => notBefore });
  assert.equal(waiting.kind, 'waiting');
  if (waiting.kind === 'waiting') {
    assert.equal(waiting.waitingFor, 'observation_window');
    assert.equal(waiting.notBefore, notBefore);
  }
  const stillWaiting = advanceLiveRun({ ...request, now: '2026-09-01T12:04:59.000Z' });
  assert.equal(stillWaiting.kind, 'waiting');
  const assertion = advanceLiveRun({ ...request, now: notBefore });
  assert.equal(assertion.kind, 'assertion');
});

test('primary and cleanup results remain orthogonal in the final report', (context) => {
  for (const [primary, cleanup, aggregate] of [
    ['fail', 'pass', 'fail'],
    ['pass', 'failed', 'cleanup_failed'],
  ] as const) {
    const request = setup(context);
    const action = advanceLiveRun(request);
    assert.equal(action.kind, 'action_required');
    if (action.kind !== 'action_required') continue;
    advanceLiveRun({ ...request, signal: {
      type: 'action_receipt', actionRef: action.actionRef, outcome: 'completed',
    } });
    advanceLiveRun({ ...request, signal: primary === 'fail'
      ? { type: 'assertion_result', variantId: action.variantId, result: primary, reason: 'assertion_failed' }
      : { type: 'assertion_result', variantId: action.variantId, result: primary } });
    const terminal = advanceLiveRun(request, cleanupProgress(cleanup === 'failed' ? 'failed' : 'pass'));
    assert.equal(terminal.kind, 'terminal');
    if (terminal.kind !== 'terminal') continue;
    assert.equal(terminal.report.cases[0]?.primary.result, primary);
    assert.equal(terminal.report.cases[0]?.cleanup, cleanup);
    assert.equal(terminal.report.aggregate, aggregate);
    assert.equal(JSON.stringify(terminal.report).includes('Create the run-marked'), false);
  }
});

test('cleanup rejects asserted verdicts and waits for dependency-driven postflight proof', (context) => {
  const request = setup(context);
  const action = advanceLiveRun(request);
  assert.equal(action.kind, 'action_required');
  if (action.kind !== 'action_required') return;
  advanceLiveRun({ ...request, signal: {
    type: 'action_receipt', actionRef: action.actionRef, outcome: 'completed',
  } });
  advanceLiveRun({ ...request, signal: {
    type: 'assertion_result', variantId: action.variantId, result: 'pass',
  } });

  assert.throws(() => advanceLiveRun({
    ...request,
    signal: { type: 'cleanup_result', variantId: action.variantId, result: 'pass' } as never,
  }), /does not accept an asserted result/);
  const waiting = advanceLiveRun(request, { progressCleanup: () => ({ status: 'waiting' }) });
  assert.equal(waiting.kind, 'waiting');
  const terminal = advanceLiveRun(request, cleanupProgress('failed'));
  assert.equal(terminal.kind, 'terminal');
  if (terminal.kind === 'terminal') assert.equal(terminal.report.aggregate, 'cleanup_failed');
});

test('human gate terminal outcomes become typed results and proceed to cleanup without replay', (context) => {
  const outcomes = [
    ['denied', 'blocked', 'human_gate_denied'],
    ['cancelled', 'blocked', 'human_gate_cancelled'],
    ['expired', 'blocked', 'human_gate_expired'],
    ['wrong_session', 'blocked', 'wrong_session'],
    ['provider_error', 'infrastructure_error', 'provider_error'],
  ] as const;

  for (const [outcome, primary, reason] of outcomes) {
    const request = setup(context, ['LC01-V2-update-approve']);
    const action = advanceLiveRun(request);
    assert.equal(action.kind, 'action_required');
    if (action.kind !== 'action_required') continue;
    const waiting = advanceLiveRun({ ...request, signal: {
      type: 'action_receipt', actionRef: action.actionRef, outcome,
    } });
    assert.equal(waiting.kind, 'waiting');
    const terminal = advanceLiveRun(request, cleanupProgress());
    assert.equal(terminal.kind, 'terminal');
    if (terminal.kind !== 'terminal') continue;
    assert.deepEqual(terminal.report.cases[0]?.primary, { result: primary, reason });
  }
});

test('resume rejects target, source, or serving-version drift before advancing', (context) => {
  const request = setup(context);
  advanceLiveRun(request);
  assert.throws(() => advanceLiveRun({
    ...request,
    identity: { ...identity, servingVersion: 'version-2' },
    doctorSnapshot: { ...doctorSnapshot, servingVersion: 'version-2' },
  }), /serving|identity|drift/i);
});

test('resume rejects a structurally valid but out-of-order state transition', (context) => {
  const request = setup(context);
  advanceLiveRun(request);
  appendRunJournal(request.journalPath, {
    type: 'transition', from: 'preflight', to: 'complete', output: 'terminal',
  }, { runId: request.runId, manifestDigest: LIVE_MANIFEST_DIGEST });
  assert.throws(() => advanceLiveRun(request), /INVALID_TRANSITION/);
});
