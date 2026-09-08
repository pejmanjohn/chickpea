import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diagnoseLiveTarget,
  parseDoctorSnapshot,
  type DoctorSnapshot,
} from '../qa/live/doctor.ts';
import { LIVE_MANIFEST_DIGEST } from '../qa/live/manifest.ts';
import { PHASE_ONE_SMOKE_VARIANTS } from '../qa/live/schema.ts';

const policy = {
  targetAlias: 'amber' as const,
  allowedSuites: ['case', 'smoke'] as const,
  allowedVariants: [...PHASE_ONE_SMOKE_VARIANTS],
};

const ready: DoctorSnapshot = {
  schemaVersion: 'chickpea-live-doctor-snapshot/v1',
  manifestDigest: LIVE_MANIFEST_DIGEST,
  targetAlias: 'amber',
  transport: 'events',
  targetFingerprint: `sha256:${'a'.repeat(64)}`,
  repositoryRevision: '0123456789abcdef',
  servingVersion: 'version-1',
  computerUseSurfaces: {
    bridgeAvailable: true,
    windowCaptureAvailable: true,
    slackVisible: true,
    adminVisible: true,
  },
  missingActorAliases: [],
  workspaceMatches: true,
  evidenceRootSafe: true,
  targetMatches: true,
  lock: { status: 'clear' },
};

test('doctor maps a ready one-target smoke without mutating product state', () => {
  let reads = 0;
  const result = diagnoseLiveTarget({
    policy,
    suite: 'smoke',
    source: { read: () => { reads += 1; return ready; } },
  });
  assert.equal(reads, 1);
  assert.equal(result.ready, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.variantIds, [...PHASE_ONE_SMOKE_VARIANTS]);
});

test('doctor accepts Cloudflare version UUIDs but rejects malformed deployment identifiers', () => {
  const servingVersion = '12345678-1234-1234-abcd-123456789abc';
  const result = diagnoseLiveTarget({
    policy,
    suite: 'smoke',
    source: { read: () => ({ ...ready, servingVersion }) },
  });
  assert.equal(result.ready, true);
  assert.equal(result.servingVersion, servingVersion);
  for (const invalid of [
    '', '12345678-1234-1234-abcd-123456789ab',
    '12345678-1234-1234-abcd-123456789abg', ` ${servingVersion}`,
    `${servingVersion}\n`, 'deployment-current', 'version-',
  ]) {
    assert.throws(() => parseDoctorSnapshot({ ...ready, servingVersion: invalid }),
      /INVALID_DOCTOR_SNAPSHOT/u);
  }
});

test('Computer Use bridge, windows, and window-scoped capture are required', () => {
  for (const [field, expectedObserver] of [
    ['bridgeAvailable', 'agent.read'],
    ['windowCaptureAvailable', 'agent.read'],
    ['slackVisible', 'slack.messages.read'],
    ['adminVisible', 'agent.read'],
  ] as const) {
    const snapshot: DoctorSnapshot = {
      ...ready,
      computerUseSurfaces: { ...ready.computerUseSurfaces, [field]: false },
    };
    const result = diagnoseLiveTarget({ policy, suite: 'smoke', source: { read: () => snapshot } });
    assert.equal(result.ready, false, field);
    assert.equal(
      result.diagnostics.find(({ code }) => code === 'computer_use_unavailable')
        ?.items?.includes(expectedObserver),
      true,
      field,
    );
  }
});

test('doctor maps deterministic target and lock failures to typed diagnostics', () => {
  const result = diagnoseLiveTarget({
    policy,
    suite: 'case',
    selectedVariantIds: ['LC01-V1-create-welcome'],
    source: { read: () => ({
      ...ready,
      targetAlias: 'fern',
      workspaceMatches: false,
      targetMatches: false,
      evidenceRootSafe: false,
      lock: { status: 'stale', ownerRunId: 'old-run' },
    }) },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [
    'wrong_workspace',
    'unsafe_evidence_root',
    'target_drift',
    'stale_lock',
  ]);
});
