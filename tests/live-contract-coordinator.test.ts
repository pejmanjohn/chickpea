import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AttendedLiveCoordinator, type ComputerUseDriver, type UiWindow } from '../qa/live/coordinator.ts';
import { type DoctorSnapshot } from '../qa/live/doctor.ts';
import { LIVE_MANIFEST, LIVE_MANIFEST_DIGEST } from '../qa/live/manifest.ts';
import { digestTargetOverlay, validateTargetOverlay } from '../qa/live/privacy.ts';
import { advanceLiveRun, type AdvanceLiveRunRequest } from '../qa/live/runner.ts';
import { clearTargetLock, readRunJournalStatus } from '../qa/live/safety/lock.ts';

const NOW = Date.parse('2026-09-03T01:00:00.000Z');
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function fixture(context: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-coordinator-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const example = JSON.parse(readFileSync(new URL('../qa/live/target.example.json', import.meta.url), 'utf8'));
  example.targetAlias = 'amber';
  const overlay = validateTargetOverlay(LIVE_MANIFEST, example);
  const identity = { targetFingerprint: digest('target'), repositoryRevision: 'abcdef0123456789', servingVersion: 'version-test' };
  const snapshot: DoctorSnapshot = {
    schemaVersion: 'chickpea-live-doctor-snapshot/v1', manifestDigest: LIVE_MANIFEST_DIGEST,
    targetAlias: 'amber', transport: 'gateway', targetOverlayDigest: digestTargetOverlay(overlay), ...identity,
    computerUseSurfaces: { bridgeAvailable: true, windowCaptureAvailable: true, slackVisible: true, adminVisible: true },
    missingActorAliases: [], workspaceMatches: true, evidenceRootSafe: true, targetMatches: true, lock: { status: 'clear' },
  };
  const request: Omit<AdvanceLiveRunRequest, 'signal' | 'now'> = {
    journalPath: join(root, 'evidence', 'runs', 'run-test.jsonl'), runId: 'run-test',
    suite: 'case', variantIds: ['LC01-V1-create-welcome'], overlay, identity, doctorSnapshot: snapshot,
  };
  let captures = 0;
  let actions = 0;
  let cleanups = 0;
  const capture = <Value>(ui: UiWindow, value: Value) => ui.capture({ transport: 'computer_use', observationScope: 'window',
    windowId: 'test-window', observedAt: new Date(NOW).toISOString(), captureDigest: digest(`capture-${++captures}`), value });
  const driver: ComputerUseDriver = {
    transport: 'computer_use', browserAlias: 'test-browser', actorAlias: 'owner-browser-profile',
    prepare: async (_action, ui) => capture(ui, { expectedRevision: 'absent', baselines: [] }),
    act: async (_action, _challenge, ui) => {
      actions += 1;
      return capture(ui, { outcome: 'completed', resource: {
        immutableId: 'agent-run-test', resourceKind: 'agent', beforeRevision: 'absent', revision: '1',
        beforeStateDigest: digest('absent'), stateDigest: digest('active'), expectedResidueStateDigest: digest('archived'),
      }, generatedEffects: [{
        immutableId: 'slack-message-run-test', resourceKind: 'attributed_residue', beforeRevision: 'absent', revision: '1',
        beforeStateDigest: digest('absent'), stateDigest: digest('welcome'), expectedResidueStateDigest: digest('welcome'),
      }] });
    },
    observe: async (record, ui) => capture(ui, [...new Set(record.tokens.map(({ observerId }) => observerId))]
      .map((observerId) => ({ observerId, observedTokens: record.tokens.filter((token) => token.observerId === observerId).map(({ token }) => token) }))),
    inspectCleanup: async (target, ui) => capture(ui, { revision: target.expectedRevision }),
    cleanup: async (target, _challenge, ui) => {
      cleanups += 1;
      return capture(ui, { immutableId: target.immutableId, priorRevision: target.expectedRevision,
        resultingRevision: target.resourceKind === 'agent' ? '2' : '1',
        resultingStateDigest: target.expectedResidueStateDigest!, outcome: 'retained' });
    },
    inventory: async (_variantId, ui) => capture(ui, { identity,
      declaredResourceKinds: ['agent', 'attributed_residue'], inventory: [
        { immutableId: 'agent-run-test', resourceKind: 'agent', revision: '2', stateDigest: digest('archived'), fixtureClass: 'attributed_residue' },
        { immutableId: 'slack-message-run-test', resourceKind: 'attributed_residue', revision: '1', stateDigest: digest('welcome'), fixtureClass: 'attributed_residue' },
      ],
    }),
  };
  const deps = { driver, uiMutexRoot: join(root, 'ui'), attest: async () => snapshot, now: () => NOW };
  return { root, request, deps, snapshot, capture, counts: () => ({ captures, actions, cleanups }) };
}

test('coordinator binds Computer Use actions, generated effects, exact cleanup and postflight to one journal', async (context) => {
  const f = fixture(context);
  const result = await new AttendedLiveCoordinator(f.request, f.deps).run();
  assert.equal(result.report.aggregate, 'pass');
  assert.equal(f.counts().actions, 1);
  assert.equal(f.counts().cleanups, 2);
  assert.equal(existsSync(join(f.root, 'evidence', 'target.lock')), false);
  assert.equal(existsSync(join(f.root, 'ui', 'interaction.lock')), false);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, true);
  const journal = readFileSync(f.request.journalPath, 'utf8');
  assert.match(journal, /computer_use_window/u);
  assert.match(journal, /operator_challenge_completed/u);
  assert.doesNotMatch(journal, /test-window|Create the run-marked/u);
});

test('API drivers, inactive targets and wrong actor aliases stop before creating a run', (context) => {
  const f = fixture(context);
  assert.throws(() => new AttendedLiveCoordinator(f.request, { ...f.deps,
    driver: { ...f.deps.driver, transport: 'api' as never } }), /COMPUTER_USE_REQUIRED/u);
  assert.throws(() => new AttendedLiveCoordinator({ ...f.request,
    overlay: { ...(f.request.overlay as object), targetAlias: 'fern' } }, f.deps), /UNSUPPORTED_VARIANT/u);
  assert.throws(() => new AttendedLiveCoordinator(f.request, { ...f.deps,
    driver: { ...f.deps.driver, actorAlias: 'another-actor' } }), /DOCTOR_BLOCKED/u);
  assert.equal(existsSync(f.request.journalPath), false);
});

test('coordinator refuses Git/package roots and symlinked evidence despite a ready snapshot', (context) => {
  const f = fixture(context);
  const repositoryRoot = new URL('../', import.meta.url).pathname;
  assert.throws(() => new AttendedLiveCoordinator({ ...f.request,
    journalPath: join(repositoryRoot, 'private-evidence', 'runs', 'run-test.jsonl') }, f.deps), /UNSAFE_EVIDENCE_ROOT/u);
  mkdirSync(join(f.root, 'actual-evidence'), { mode: 0o700 });
  symlinkSync(join(f.root, 'actual-evidence'), join(f.root, 'evidence'));
  assert.throws(() => new AttendedLiveCoordinator(f.request, f.deps), /UNSAFE_EVIDENCE_ROOT/u);
  assert.equal(existsSync(f.request.journalPath), false);
});

test('a thrown action preserves its ambiguous intent and never retries the product mutation', async (context) => {
  const f = fixture(context);
  let calls = 0;
  f.deps.driver.act = async () => { calls += 1; throw new Error('simulated interrupted browser'); };
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /simulated interrupted browser/u);
  assert.equal(calls, 1);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
  assert.equal(existsSync(join(f.root, 'evidence', 'target.lock')), true);
  assert.equal(existsSync(join(f.root, 'ui', 'interaction.lock')), false);
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /LOCK_ACTIVE/u);
  assert.equal(calls, 1);
});

test('uncertified, stale, and full-screen captures cannot produce action receipts', async (context) => {
  for (const mode of ['uncertified', 'stale', 'screen'] as const) {
    const f = fixture(context);
    f.deps.driver.act = async (_record, _challenge, ui) => {
      const result = { transport: 'computer_use' as const, observationScope: 'window' as const,
        windowId: 'test-window', captureDigest: digest(mode), observedAt: new Date(NOW).toISOString(),
        value: { outcome: 'completed' as const } };
      if (mode === 'uncertified') return result;
      if (mode === 'stale') result.observedAt = new Date(NOW - 61_000).toISOString();
      if (mode === 'screen') result.observationScope = 'screen' as never;
      return ui.capture(result);
    };
    await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /WINDOW_CAPTURE_REQUIRED/u);
    assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
  }
});

test('cleanup cannot substitute another exact resource or declare success without postflight', async (context) => {
  const f = fixture(context);
  f.deps.driver.cleanup = async (target, _challenge, ui) => f.capture(ui, {
    immutableId: 'agent-not-owned', priorRevision: target.expectedRevision, resultingRevision: '2',
    resultingStateDigest: target.expectedResidueStateDigest!, outcome: 'retained',
  });
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /EXACT_READBACK_REQUIRED/u);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
  assert.equal(existsSync(join(f.root, 'evidence', 'target.lock')), true);
});

test('fresh target drift stops before the next UI operation', async (context) => {
  const f = fixture(context);
  let reads = 0;
  f.deps.attest = async () => (++reads < 3 ? f.snapshot : { ...f.snapshot, servingVersion: 'version-changed' });
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /TARGET_DRIFT/u);
  assert.equal(f.counts().actions, 0);
});

test('a capture that ages before the operation returns cannot certify an action', async (context) => {
  const f = fixture(context);
  let now = NOW;
  f.deps.now = () => now;
  const act = f.deps.driver.act;
  f.deps.driver.act = async (record, challenge, ui) => {
    const captured = await act(record, challenge, ui);
    now += 61_000;
    return captured;
  };
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /WINDOW_CAPTURE_REQUIRED/u);
  assert.equal(readFileSync(f.request.journalPath, 'utf8').includes('"type":"mutation_receipt"'), false);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
});

test('target drift during a UI action cannot certify its resulting resource', async (context) => {
  const f = fixture(context);
  const act = f.deps.driver.act;
  f.deps.driver.act = async (record, challenge, ui) => {
    const captured = await act(record, challenge, ui);
    f.snapshot.servingVersion = 'version-changed';
    return captured;
  };
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /TARGET_DRIFT/u);
  const journal = readFileSync(f.request.journalPath, 'utf8');
  assert.equal(journal.includes('"type":"mutation_receipt"'), false);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
});

test('failed postflight keeps the target locked and unsafe to clear despite successful exact cleanup', async (context) => {
  const f = fixture(context);
  const inventory = f.deps.driver.inventory;
  f.deps.driver.inventory = async (variantId, ui) => {
    const captured = await inventory(variantId, ui);
    return f.capture(ui, { ...captured.value, inventory: [...captured.value.inventory,
      { immutableId: 'foreign-run-agent', resourceKind: 'agent' as const, revision: '1',
        stateDigest: digest('foreign'), fixtureClass: 'run_owned' as const }],
    });
  };
  const result = await new AttendedLiveCoordinator(f.request, f.deps).run();
  assert.equal(result.report.aggregate, 'cleanup_failed');
  assert.equal(existsSync(join(f.root, 'evidence', 'target.lock')), true);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
});

test('interrupted postflight remains unsafe to clear after all exact cleanup has completed', async (context) => {
  const f = fixture(context);
  f.deps.driver.inventory = async () => { throw new Error('postflight interrupted'); };
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /postflight interrupted/u);
  assert.equal(f.counts().cleanups, 2);
  assert.equal(existsSync(join(f.root, 'evidence', 'target.lock')), true);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
});

test('missing generated effects park a completed primary mutation in readback recovery', async (context) => {
  const f = fixture(context);
  const act = f.deps.driver.act;
  f.deps.driver.act = async (record, challenge, ui) => {
    const captured = await act(record, challenge, ui);
    return f.capture(ui, { ...captured.value, generatedEffects: [] });
  };
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /EXACT_READBACK_REQUIRED/u);
  const journal = readFileSync(f.request.journalPath, 'utf8');
  assert.equal(journal.includes('"type":"mutation_receipt"'), true);
  assert.equal(journal.includes('"outcome":"ambiguous"'), true);
  const next = advanceLiveRun({ ...f.request, now: new Date(NOW).toISOString() });
  assert.equal(next.kind, 'waiting');
  if (next.kind === 'waiting') assert.equal(next.waitingFor, 'authoritative_readback');
  assert.equal(f.counts().actions, 1);
});

test('invalid exact resource readback is rejected before challenge completion and enters recovery', async (context) => {
  const f = fixture(context);
  const act = f.deps.driver.act;
  f.deps.driver.act = async (record, challenge, ui) => {
    const captured = await act(record, challenge, ui);
    return f.capture(ui, { ...captured.value, resource: { ...captured.value.resource!, immutableId: 'agent/run-test' } });
  };
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /INVALID_EXACT_ID/u);
  const journal = readFileSync(f.request.journalPath, 'utf8');
  assert.equal(journal.includes('"type":"operator_challenge_completed"'), false);
  assert.equal(journal.includes('"type":"mutation_receipt"'), false);
  assert.equal(journal.includes('"outcome":"ambiguous"'), true);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
});

test('a durable header precedes the lock and startup failure releases only its safe owned lock', async (context) => {
  const f = fixture(context);
  let reads = 0;
  f.deps.attest = async () => {
    if (++reads === 2) throw new Error('startup attestation unavailable');
    return f.snapshot;
  };
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /startup attestation unavailable/u);
  assert.equal(f.counts().actions, 0);
  assert.equal(existsSync(f.request.journalPath), true);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, true);
  assert.equal(existsSync(join(f.root, 'evidence', 'target.lock')), false);
});

test('an explicit ambiguous action result is consumed once and cannot be replayed', async (context) => {
  const f = fixture(context);
  f.deps.driver.act = async (_record, _challenge, ui) => f.capture(ui, { outcome: 'ambiguous' });
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /EXACT_READBACK_REQUIRED/u);
  const journal = readFileSync(f.request.journalPath, 'utf8');
  assert.equal(journal.includes('"type":"operator_challenge_consumed"'), true);
  assert.equal(journal.includes('"outcome":"ambiguous"'), true);
  assert.equal(readRunJournalStatus(f.request.journalPath, 'run-test').safeToClear, false);
});

test('a process crash immediately after lock acquisition leaves a safe header for explicit recovery', (context) => {
  const f = fixture(context);
  const moduleUrl = new URL('../qa/live/coordinator.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { AttendedLiveCoordinator } from ${JSON.stringify(moduleUrl)};
     let reads = 0;
     await new AttendedLiveCoordinator(${JSON.stringify(f.request)}, {
       driver: { transport: 'computer_use', browserAlias: 'test-browser', actorAlias: 'owner-browser-profile' },
       uiMutexRoot: ${JSON.stringify(f.deps.uiMutexRoot)}, now: () => ${NOW},
       attest: async () => { if (++reads === 2) process.exit(42); return ${JSON.stringify(f.snapshot)}; }
     }).run();`], { encoding: 'utf8' });
  assert.equal(child.status, 42, child.stderr);
  const lockPath = join(f.root, 'evidence', 'target.lock');
  assert.equal(existsSync(lockPath), true);
  const journal = readRunJournalStatus(f.request.journalPath, 'run-test');
  assert.equal(journal.safeToClear, true);
  clearTargetLock(lockPath, { runId: 'run-test', host: hostname(), journal });
  assert.equal(existsSync(lockPath), false);
});

test('resuming a human gate reattests before another UI interaction', async (context) => {
  const f = fixture(context);
  let resumed = false;
  f.deps.driver.act = async (_record, _challenge, ui) => {
    ui.pause();
    f.snapshot.servingVersion = 'version-changed';
    await ui.resume();
    resumed = true;
    return f.capture(ui, { outcome: 'completed' });
  };
  await assert.rejects(new AttendedLiveCoordinator(f.request, f.deps).run(), /TARGET_DRIFT/u);
  assert.equal(resumed, false);
  assert.equal(existsSync(join(f.root, 'ui', 'interaction.lock')), false);
});
