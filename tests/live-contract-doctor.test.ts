import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  diagnoseLiveTarget,
  parseDoctorSnapshot,
  type DoctorSnapshot,
} from '../qa/live/doctor.ts';
import { LIVE_MANIFEST, LIVE_MANIFEST_DIGEST } from '../qa/live/manifest.ts';
import { digestTargetOverlay, validateTargetOverlay } from '../qa/live/privacy.ts';

const overlay = JSON.parse(readFileSync(new URL('../qa/live/target.example.json', import.meta.url), 'utf8')) as unknown;
const validatedOverlay = validateTargetOverlay(LIVE_MANIFEST, overlay);

const READY: DoctorSnapshot = {
  schemaVersion: 'chickpea-live-doctor-snapshot/v1',
  manifestDigest: LIVE_MANIFEST_DIGEST,
  targetAlias: validatedOverlay.targetAlias,
  transport: validatedOverlay.transport,
  targetOverlayDigest: digestTargetOverlay(validatedOverlay),
  targetFingerprint: 'sha256:target',
  repositoryRevision: '0123456789abcdef',
  servingVersion: 'version-1',
  computerUseSurfaces: { bridgeAvailable: true, slackVisible: true, adminVisible: true },
  missingActorAliases: [],
  workspaceMatches: true,
  unavailableObserverIds: [],
  evidenceRootSafe: true,
  targetMatches: true,
  lock: { status: 'clear' },
};

test('doctor core is injected and read-only', () => {
  let reads = 0;
  let mutations = 0;
  const result = diagnoseLiveTarget({
    overlay,
    variantIds: ['LC01-V1-create-welcome'],
    source: {
      read: () => {
        reads += 1;
        return READY;
      },
    },
  });
  assert.equal(result.ready, true);
  assert.equal(reads, 1);
  assert.equal(mutations, 0);
  assert.deepEqual(result.diagnostics, []);
});

test('doctor reports every supplied target blocker with short typed diagnostics', () => {
  const cases: Array<[Partial<DoctorSnapshot>, string]> = [
    [{ missingActorAliases: ['qa-member-two'] }, 'missing_actor'],
    [{ workspaceMatches: false }, 'wrong_workspace'],
    [{ unavailableObserverIds: ['provider.read'] }, 'unavailable_observer'],
    [{ evidenceRootSafe: false }, 'unsafe_evidence_root'],
    [{ targetMatches: false }, 'target_drift'],
    [{ lock: { status: 'live', ownerRunId: 'other-run' } }, 'live_lock'],
    [{ lock: { status: 'stale', ownerRunId: 'old-run' } }, 'stale_lock'],
  ];

  for (const [change, code] of cases) {
    const snapshot = { ...READY, ...change } as DoctorSnapshot;
    const result = diagnoseLiveTarget({
      overlay,
      variantIds: ['LC01-V1-create-welcome'],
      source: { read: () => snapshot },
    });
    assert.equal(result.ready, false, code);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === code), true, code);
    assert.equal(JSON.stringify(result).includes('Create the run-marked'), false);
  }
});

test('doctor rejects manifest drift before live adapter work', () => {
  const result = diagnoseLiveTarget({
    overlay,
    variantIds: ['LC01-V1-create-welcome'],
    source: { read: () => ({ ...READY, manifestDigest: 'sha256:wrong' }) },
  });
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0]?.code, 'manifest_drift');
});

test('doctor permits a valid dirty lane SHA and stays agnostic to environment roles', () => {
  const dirty = { ...READY, repositoryRevision: '0123456789abcdef-dirty' };
  assert.equal(diagnoseLiveTarget({
    overlay, variantIds: ['LC01-V1-create-welcome'], source: { read: () => dirty },
  }).ready, true);

  const featureOverlay = {
    ...(overlay as Record<string, unknown>),
    targetAlias: 'amber',
    allowedSuites: ['case', 'smoke'],
  };
  const validatedFeature = validateTargetOverlay(LIVE_MANIFEST, featureOverlay);
  const featureSnapshot = {
    ...dirty,
    targetAlias: validatedFeature.targetAlias,
    transport: validatedFeature.transport,
    targetOverlayDigest: digestTargetOverlay(validatedFeature),
  };
  assert.equal(diagnoseLiveTarget({
    overlay: featureOverlay,
    variantIds: ['LC01-V1-create-welcome'],
    source: { read: () => featureSnapshot },
  }).ready, true);

  const continuationOverlay = {
    ...(overlay as Record<string, unknown>),
    targetAlias: 'dedicated-qa',
    allowedSuites: ['case', 'smoke', 'deep'],
  };
  const validatedContinuation = validateTargetOverlay(LIVE_MANIFEST, continuationOverlay);
  const continuationSnapshot = {
    ...dirty,
    targetAlias: validatedContinuation.targetAlias,
    targetOverlayDigest: digestTargetOverlay(validatedContinuation),
  };
  assert.equal(diagnoseLiveTarget({
    overlay: continuationOverlay,
    variantIds: ['LC01-V1-create-welcome'],
    source: { read: () => continuationSnapshot },
  }).ready, true);
});

test('doctor snapshots accept only a source SHA with feature-lane dirty suffix', () => {
  assert.doesNotThrow(() => parseDoctorSnapshot({ ...READY, repositoryRevision: 'abcdef012345-dirty' }));
  assert.throws(() => parseDoctorSnapshot({ ...READY, repositoryRevision: 'working-tree-dirty' }), /INVALID_DOCTOR_SNAPSHOT/);
});

test('doctor binds its snapshot to the target and selected Computer Use surfaces', () => {
  for (const snapshot of [
    { ...READY, targetAlias: 'amber' },
    { ...READY, transport: 'events' as const },
    { ...READY, targetOverlayDigest: `sha256:${'f'.repeat(64)}` },
  ]) {
    const result = diagnoseLiveTarget({
      overlay,
      variantIds: ['LC01-V1-create-welcome'],
      source: { read: () => snapshot },
    });
    assert.equal(result.diagnostics.some(({ code }) => code === 'target_drift'), true);
  }

  const noAdmin = diagnoseLiveTarget({
    overlay,
    variantIds: ['LC01-V1-create-welcome'],
    source: { read: () => ({
      ...READY,
      computerUseSurfaces: { ...READY.computerUseSurfaces, adminVisible: false },
    }) },
  });
  assert.deepEqual(
    noAdmin.diagnostics.find(({ code }) => code === 'unavailable_observer')?.items,
    ['agent.read'],
  );
});

test('doctor derives unavailable deep observers from the catalog', () => {
  const result = diagnoseLiveTarget({
    overlay,
    variantIds: ['LC02-V1-avatar-parity'],
    source: { read: () => READY },
  });
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics.some(({ code, items }) =>
    code === 'unavailable_observer' && (items ?? []).includes('agent.avatar.read')
  ), true);
});

test('doctor snapshot grammar rejects forged fingerprints and serving versions', () => {
  assert.throws(
    () => parseDoctorSnapshot({ ...READY, targetFingerprint: 'sha256:../../private' }),
    /INVALID_DOCTOR_SNAPSHOT/,
  );
  assert.throws(
    () => parseDoctorSnapshot({ ...READY, servingVersion: 'https://private.example/version' }),
    /INVALID_DOCTOR_SNAPSHOT/,
  );
  assert.throws(
    () => parseDoctorSnapshot({ ...READY, computerUseSurfaces: { bridgeAvailable: true } }),
    /INVALID_DOCTOR_SNAPSHOT/,
  );
});
