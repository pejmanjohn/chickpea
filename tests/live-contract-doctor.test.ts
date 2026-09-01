import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  diagnoseLiveTarget,
  parseDoctorSnapshot,
  type DoctorSnapshot,
} from '../qa/live/doctor.ts';
import { LIVE_MANIFEST_DIGEST } from '../qa/live/manifest.ts';

const overlay = JSON.parse(readFileSync(new URL('../qa/live/target.example.json', import.meta.url), 'utf8')) as unknown;

const READY: DoctorSnapshot = {
  schemaVersion: 'chickpea-live-doctor-snapshot/v1',
  manifestDigest: LIVE_MANIFEST_DIGEST,
  targetFingerprint: 'sha256:target',
  repositoryRevision: '0123456789abcdef',
  servingVersion: 'version-1',
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
    const result = diagnoseLiveTarget({ overlay, source: { read: () => snapshot } });
    assert.equal(result.ready, false, code);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === code), true, code);
    assert.equal(JSON.stringify(result).includes('Create the run-marked'), false);
  }
});

test('doctor rejects manifest drift before live adapter work', () => {
  const result = diagnoseLiveTarget({
    overlay,
    source: { read: () => ({ ...READY, manifestDigest: 'sha256:wrong' }) },
  });
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0]?.code, 'manifest_drift');
});

test('doctor permits dirty feature revisions but blocks dedicated QA and demo', () => {
  const dirty = { ...READY, repositoryRevision: '0123456789abcdef-dirty' };
  assert.equal(diagnoseLiveTarget({ overlay, source: { read: () => dirty } }).ready, false);

  const featureOverlay = {
    ...(overlay as Record<string, unknown>),
    targetAlias: 'feature-lane-one',
    allowedSuites: ['case', 'smoke'],
  };
  assert.equal(diagnoseLiveTarget({ overlay: featureOverlay, source: { read: () => dirty } }).ready, true);

  const demoOverlay = { ...(overlay as Record<string, unknown>), targetAlias: 'demo', allowedSuites: ['case', 'smoke'] };
  assert.equal(diagnoseLiveTarget({ overlay: demoOverlay, source: { read: () => dirty } }).ready, false);
});

test('doctor snapshots accept only a source SHA with feature-lane dirty suffix', () => {
  assert.doesNotThrow(() => parseDoctorSnapshot({ ...READY, repositoryRevision: 'abcdef012345-dirty' }));
  assert.throws(() => parseDoctorSnapshot({ ...READY, repositoryRevision: 'working-tree-dirty' }), /INVALID_DOCTOR_SNAPSHOT/);
});
