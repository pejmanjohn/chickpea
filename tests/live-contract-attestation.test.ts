import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AttestationError,
  assertStableAttestation,
  attestLiveTarget,
  type LiveTargetObservation,
} from '../qa/live/attestation.ts';
import {
  PrivateConfigError,
  createDoctorTargetResolution,
  type PrivateLiveConfig,
} from '../qa/live/private-config.ts';
import { validateTargetOverlay } from '../qa/live/privacy.ts';
import { LIVE_MANIFEST } from '../qa/live/manifest.ts';

const overlay = validateTargetOverlay(
  LIVE_MANIFEST,
  JSON.parse(readFileSync(new URL('../qa/live/target.example.json', import.meta.url), 'utf8')),
);

const aliases = {
  'qa-worker': 'worker-qa',
  'qa-workspace': 'T_QA',
  'qa-slack-app': 'A_QA',
  'qa-provider-project': 'provider-qa',
  'private-evidence-root': '/private/evidence/qa',
  'qa-timezone': 'America/Los_Angeles',
  'binding-auth-db': 'd1-auth-qa',
  'binding-tag-state': 'do-tag-state-qa',
  'sheets-readonly-auth-config': 'ac_sheets_readonly_qa',
} as const;

const targetConfig = {
  transport: 'gateway' as const,
  workerAlias: 'qa-worker',
  workspaceAlias: 'qa-workspace',
  slackAppAlias: 'qa-slack-app',
  providerProjectAlias: 'qa-provider-project',
  evidenceRootAlias: 'private-evidence-root',
  timezoneAlias: 'qa-timezone',
  providerReadOnlyAuthConfigAlias: 'sheets-readonly-auth-config',
  allowedSuites: ['case', 'smoke'] as Array<'case' | 'smoke'>,
  allowedVariants: [...overlay.allowedVariants],
  bindingAliases: {
    AUTH_DB: 'binding-auth-db',
    TAG_STATE: 'binding-tag-state',
  },
};

const privateConfig: PrivateLiveConfig = {
  schemaVersion: 'chickpea-live-private-config/v1',
  qaTargetAllowlist: ['amber', 'cobalt', 'fern'],
  targets: {
    amber: { ...targetConfig, targetAlias: 'amber' },
    cobalt: { ...targetConfig, targetAlias: 'cobalt' },
    fern: { ...targetConfig, targetAlias: 'fern' },
  },
};

const observed: LiveTargetObservation = {
  targetAlias: 'fern',
  transport: 'gateway',
  workerName: 'worker-qa',
  deployments: [{ versionId: 'version-1', percentage: 100 }],
  bindingIdentities: { AUTH_DB: 'd1-auth-qa', TAG_STATE: 'do-tag-state-qa' },
  slack: { teamId: 'T_QA', appId: 'A_QA' },
  provider: {
    projectId: 'provider-qa',
    readOnlyAuthConfigId: 'ac_sheets_readonly_qa',
  },
  timezone: 'America/Los_Angeles',
  evidenceRoot: '/private/evidence/qa',
  gateway: {
    healthy: true,
    phase: 'healthy',
    detail: null,
    generation: 4,
    versionId: 'version-1',
  },
};

function resolutionHarness(config = privateConfig, targetOverlay = overlay) {
  const readAliases: string[] = [];
  let mutationResolutions = 0;
  const resolution = createDoctorTargetResolution(targetOverlay, config, {
    readOnly: async (alias) => {
      readAliases.push(alias);
      const value = aliases[alias as keyof typeof aliases];
      if (value === undefined) throw new Error('private resolver fixture missing');
      return value;
    },
    // This authority exists in the surrounding runtime but is intentionally
    // absent from the doctor resolver's callable interface.
    mutation: async () => {
      mutationResolutions += 1;
      return 'must-not-resolve';
    },
  });
  return { resolution, readAliases, mutationResolutions };
}

test('private QA aliases resolve lazily and attestation accepts one exact 100% deployment', async () => {
  const fixture = resolutionHarness();
  assert.deepEqual(fixture.readAliases, []);

  const attestation = await attestLiveTarget(fixture.resolution, observed);

  assert.equal(attestation.targetAlias, 'fern');
  assert.equal(attestation.servingVersion, 'version-1');
  assert.match(attestation.targetFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fixture.mutationResolutions, 0);
  assert.deepEqual(new Set(fixture.readAliases), new Set(Object.keys(aliases)));
  assert.equal(JSON.stringify(attestation).includes('/private/evidence/qa'), false);
  assert.equal(JSON.stringify(attestation).includes('T_QA'), false);
  assert.equal(await fixture.resolution.targetLockPath(), '/private/evidence/qa/target.lock');
  assert.equal(await fixture.resolution.runJournalPath('run_20260901'), '/private/evidence/qa/runs/run_20260901.jsonl');
  await assert.rejects(
    () => fixture.resolution.runJournalPath('../escape'),
    (error: unknown) => error instanceof PrivateConfigError && error.code === 'INVALID_RUN_ID',
  );
});

test('events transport attests installation health and a fresh signed event without a gateway', async () => {
  const eventsOverlay = { ...overlay, transport: 'events' as const };
  const config = structuredClone(privateConfig);
  config.targets.fern!.transport = 'events';
  const { gateway: _gateway, ...baseObservation } = observed;
  const eventsObservation: LiveTargetObservation = {
    ...baseObservation,
    transport: 'events',
    deployments: [{ ...baseObservation.deployments[0]!, activatedAt: '2026-09-01T11:59:00.000Z' }],
    events: {
      installationHealthy: true,
      signedEventReceiptFresh: true,
      signedEventReceiptVersionId: 'version-1',
      signedEventReceiptAt: '2026-09-01T12:00:00.000Z',
      installationRevision: 7,
    },
  };

  await assert.doesNotReject(() => attestLiveTarget(
    resolutionHarness(config, eventsOverlay).resolution,
    eventsObservation,
  ));
  await assert.rejects(
    () => attestLiveTarget(resolutionHarness(config, eventsOverlay).resolution, {
      ...eventsObservation,
      events: { ...eventsObservation.events!, signedEventReceiptFresh: false },
    }),
    (error: unknown) => error instanceof AttestationError && error.code === 'SIGNED_EVENT_RECEIPT_STALE',
  );
  await assert.rejects(
    () => attestLiveTarget(resolutionHarness(config, eventsOverlay).resolution, {
      ...eventsObservation,
      events: { ...eventsObservation.events!, signedEventReceiptVersionId: 'version-0' },
    }),
    (error: unknown) => error instanceof AttestationError
      && error.code === 'SIGNED_EVENT_RECEIPT_VERSION_MISMATCH',
  );
  await assert.rejects(
    () => attestLiveTarget(resolutionHarness(config, eventsOverlay).resolution, {
      ...eventsObservation,
      events: { ...eventsObservation.events!, signedEventReceiptAt: '2026-09-01T11:58:59.000Z' },
    }),
    (error: unknown) => error instanceof AttestationError && error.code === 'SIGNED_EVENT_RECEIPT_STALE',
  );
});

test('an incomplete Phase 1 target registry blocks before any private alias is resolved', () => {
  const config = structuredClone(privateConfig);
  config.qaTargetAllowlist = ['amber', 'cobalt'];
  delete config.targets.fern;
  let reads = 0;

  assert.throws(
    () => createDoctorTargetResolution(overlay, config, {
      readOnly: async () => {
        reads += 1;
        return 'never';
      },
    }),
    (error: unknown) => error instanceof PrivateConfigError
      && error.code === 'INVALID_PRIVATE_CONFIG',
  );
  assert.equal(reads, 0);
});

test('the Phase 1 registry rejects continuation roles, deep, and divergent smoke inventories', () => {
  for (const mutate of [
    (config: PrivateLiveConfig) => {
      config.qaTargetAllowlist = ['amber', 'cobalt', 'dedicated-qa'];
      config.targets['dedicated-qa'] = { ...config.targets.fern!, targetAlias: 'dedicated-qa' };
      delete config.targets.fern;
    },
    (config: PrivateLiveConfig) => {
      config.targets.amber!.allowedSuites = ['case', 'smoke', 'deep'];
    },
    (config: PrivateLiveConfig) => {
      config.targets.cobalt!.allowedVariants = ['LC01-V1-create-welcome'];
    },
  ]) {
    const config = structuredClone(privateConfig);
    mutate(config);
    assert.throws(
      () => createDoctorTargetResolution(overlay, config, { readOnly: async () => 'never' }),
      (error: unknown) => error instanceof PrivateConfigError
        && error.code === 'INVALID_PRIVATE_CONFIG',
    );
  }
});

test('the three-target registry still resolves exactly one selected color', () => {
  const config = structuredClone(privateConfig);
  const featureOverlay = {
    ...overlay,
    targetAlias: 'amber',
    allowedSuites: ['case', 'smoke'] as Array<'case' | 'smoke'>,
  };
  const resolution = createDoctorTargetResolution(featureOverlay, config, {
    readOnly: async (alias) => aliases[alias as keyof typeof aliases],
  });
  assert.equal(resolution.targetAlias, 'amber');
});

test('a missing read-only Sheets auth-config alias blocks before resolution', () => {
  const config = structuredClone(privateConfig) as unknown as Record<string, any>;
  delete config.targets.fern.providerReadOnlyAuthConfigAlias;
  let reads = 0;
  assert.throws(
    () => createDoctorTargetResolution(overlay, config as PrivateLiveConfig, {
      readOnly: async () => {
        reads += 1;
        return 'never';
      },
    }),
    (error: unknown) => error instanceof PrivateConfigError
      && error.code === 'INVALID_PRIVATE_CONFIG',
  );
  assert.equal(reads, 0);
});

test('split traffic and every exact identity drift fail with content-free codes', async () => {
  const cases: Array<[Partial<LiveTargetObservation>, AttestationError['code']]> = [
    [{ deployments: [
      { versionId: 'version-1', percentage: 90 },
      { versionId: 'version-2', percentage: 10 },
    ] }, 'DEPLOYMENT_VECTOR_MISMATCH'],
    [{ workerName: 'other-worker' }, 'WORKER_MISMATCH'],
    [{ bindingIdentities: { AUTH_DB: 'other', TAG_STATE: 'do-tag-state-qa' } }, 'BINDING_MISMATCH'],
    [{ slack: { ...observed.slack, teamId: 'T_OTHER' } }, 'SLACK_TEAM_MISMATCH'],
    [{ slack: { ...observed.slack, appId: 'A_OTHER' } }, 'SLACK_APP_MISMATCH'],
    [{ provider: { ...observed.provider, projectId: 'other-project' } }, 'PROVIDER_PROJECT_MISMATCH'],
    [{ provider: { ...observed.provider, readOnlyAuthConfigId: 'other-auth-config' } }, 'PROVIDER_AUTH_CONFIG_MISMATCH'],
    [{ timezone: 'UTC' }, 'TIMEZONE_MISMATCH'],
    [{ evidenceRoot: '/other/evidence' }, 'EVIDENCE_ROOT_MISMATCH'],
    [{ gateway: { ...observed.gateway!, versionId: 'version-0' } }, 'GATEWAY_VERSION_MISMATCH'],
  ];

  for (const [change, code] of cases) {
    const fixture = resolutionHarness();
    const candidate = { ...observed, ...change } as LiveTargetObservation;
    await assert.rejects(
      () => attestLiveTarget(fixture.resolution, candidate),
      (error: unknown) => error instanceof AttestationError
        && error.code === code
        && error.message === code,
      code,
    );
    assert.equal(fixture.mutationResolutions, 0, code);
  }
});

test('serving deployment drift between cases blocks the next action', async () => {
  const first = await attestLiveTarget(resolutionHarness().resolution, observed);
  const restartedGateway = await attestLiveTarget(resolutionHarness().resolution, {
    ...observed,
    gateway: { ...observed.gateway!, generation: 5 },
  });
  assert.doesNotThrow(() => assertStableAttestation(first, restartedGateway));
  const next = await attestLiveTarget(resolutionHarness().resolution, {
    ...observed,
    deployments: [{ versionId: 'version-2', percentage: 100 }],
    gateway: { ...observed.gateway!, versionId: 'version-2' },
  });

  assert.throws(
    () => assertStableAttestation(first, next),
    (error: unknown) => error instanceof AttestationError && error.code === 'TARGET_DRIFT',
  );
});
