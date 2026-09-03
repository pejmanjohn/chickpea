import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AttestationError,
  attestLiveTarget,
  type LiveTargetObservation,
} from '../qa/live/attestation.ts';
import {
  PrivateConfigError,
  createDoctorTargetResolution,
  type PrivateLiveConfig,
  type PrivateTargetAliases,
} from '../qa/live/private-config.ts';
import { PHASE_ONE_SMOKE_VARIANTS } from '../qa/live/schema.ts';

const target: PrivateTargetAliases = {
  targetAlias: 'cobalt',
  transport: 'events',
  workerAlias: 'env-cobalt-worker',
  workspaceAlias: 'env-cobalt-workspace',
  slackAppAlias: 'env-cobalt-slack-app',
  providerProjectAlias: 'env-cobalt-provider-project',
  evidenceRootAlias: 'env-cobalt-evidence-root',
  timezoneAlias: 'env-cobalt-timezone',
  providerReadOnlyAuthConfigAlias: 'env-cobalt-provider-read-only-auth-config',
  bindingAliases: {
    AUTH_DB: 'env-cobalt-auth-db',
    TAG_STATE: 'env-cobalt-tag-state',
  },
  allowedSuites: ['case', 'smoke'],
  allowedVariants: [...PHASE_ONE_SMOKE_VARIANTS, 'LC02-V1-avatar-parity'],
};

const privateConfig: PrivateLiveConfig = {
  schemaVersion: 'chickpea-live-private-config/v1',
  qaTargetAllowlist: ['cobalt'],
  targets: { cobalt: target },
};

const overlay = {
  targetAlias: target.targetAlias,
  transport: target.transport,
  workerAlias: target.workerAlias,
  workspaceAlias: target.workspaceAlias,
  slackAppAlias: target.slackAppAlias,
  providerProjectAlias: target.providerProjectAlias,
  evidenceRootAlias: target.evidenceRootAlias,
  allowedSuites: target.allowedSuites,
  allowedVariants: target.allowedVariants,
};

const aliases: Record<string, string> = {
  'env-cobalt-worker': 'worker-cobalt',
  'env-cobalt-workspace': 'T_COBALT',
  'env-cobalt-slack-app': 'A_COBALT',
  'env-cobalt-provider-project': 'provider-cobalt',
  'env-cobalt-evidence-root': '/private/evidence/cobalt',
  'env-cobalt-timezone': 'America/Los_Angeles',
  'env-cobalt-provider-read-only-auth-config': 'ac_sheets_cobalt',
  'env-cobalt-auth-db': 'd1-auth-cobalt',
  'env-cobalt-tag-state': 'do-tag-state-cobalt',
};

const observed: LiveTargetObservation = {
  targetAlias: 'cobalt',
  transport: 'events',
  workerName: 'worker-cobalt',
  deployments: [{
    versionId: 'version-1', percentage: 100, activatedAt: '2026-09-01T11:59:00.000Z',
  }],
  bindingIdentities: { AUTH_DB: 'd1-auth-cobalt', TAG_STATE: 'do-tag-state-cobalt' },
  slack: { teamId: 'T_COBALT', appId: 'A_COBALT' },
  provider: { projectId: 'provider-cobalt', readOnlyAuthConfigId: 'ac_sheets_cobalt' },
  timezone: 'America/Los_Angeles',
  evidenceRoot: '/private/evidence/cobalt',
  events: {
    installationHealthy: true,
    signedEventReceiptFresh: true,
    signedEventReceiptVersionId: 'version-1',
    signedEventReceiptAt: '2026-09-01T12:00:00.000Z',
    installationRevision: 7,
  },
};

function resolution(config = privateConfig, targetOverlay = overlay) {
  let mutationCalls = 0;
  const value = createDoctorTargetResolution(targetOverlay, config, {
    readOnly: async (alias) => aliases[alias] ?? Promise.reject(new Error('missing alias')),
    mutation: async () => {
      mutationCalls += 1;
      return 'forbidden';
    },
  });
  return { value, mutationCalls: () => mutationCalls };
}

test('one-target config and env-<target>-<field> aliases attest lazily', async () => {
  const harness = resolution();
  const attestation = await attestLiveTarget(harness.value, observed);
  assert.deepEqual(
    {
      targetAlias: attestation.targetAlias,
      transport: attestation.transport,
      servingVersion: attestation.servingVersion,
    },
    { targetAlias: 'cobalt', transport: 'events', servingVersion: 'version-1' },
  );
  assert.match(attestation.targetFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(harness.mutationCalls(), 0);
  assert.equal(await harness.value.targetLockPath(), '/private/evidence/cobalt/target.lock');
  assert.equal(
    await harness.value.runJournalPath('run_20260901'),
    '/private/evidence/cobalt/runs/run_20260901.jsonl',
  );
});

test('multi-target config and non-environment aliases fail before resolution', () => {
  const multi = structuredClone(privateConfig);
  multi.qaTargetAllowlist.push('amber');
  multi.targets.amber = { ...target, targetAlias: 'amber' };
  assert.throws(
    () => resolution(multi),
    (error: unknown) => error instanceof PrivateConfigError
      && error.code === 'INVALID_PRIVATE_CONFIG',
  );

  const wrongAlias = structuredClone(privateConfig);
  wrongAlias.targets.cobalt = { ...wrongAlias.targets.cobalt!, workerAlias: 'qa-worker' };
  const wrongTargetAlias = structuredClone(privateConfig);
  wrongTargetAlias.targets.cobalt = {
    ...wrongTargetAlias.targets.cobalt!, workerAlias: 'env-amber-worker',
  };
  for (const invalid of [wrongAlias, wrongTargetAlias]) {
    assert.throws(
      () => resolution(invalid),
      (error: unknown) => error instanceof PrivateConfigError
        && error.code === 'INVALID_PRIVATE_CONFIG',
    );
  }
});

test('attestation is transport-aware and does not require a gateway for events', async () => {
  await assert.doesNotReject(() => attestLiveTarget(resolution().value, observed));
  await assert.rejects(
    () => attestLiveTarget(resolution().value, {
      ...observed,
      events: { ...observed.events!, signedEventReceiptFresh: false },
    }),
    (error: unknown) => error instanceof AttestationError
      && error.code === 'SIGNED_EVENT_RECEIPT_STALE',
  );

  const gatewayTarget: PrivateTargetAliases = { ...target, transport: 'gateway' };
  const gatewayOverlay = { ...overlay, transport: 'gateway' as const };
  const gatewayConfig: PrivateLiveConfig = {
    ...privateConfig,
    targets: { cobalt: gatewayTarget },
  };
  const { events: _events, ...base } = observed;
  await assert.doesNotReject(() => attestLiveTarget(
    resolution(gatewayConfig, gatewayOverlay).value,
    {
      ...base,
      transport: 'gateway',
      gateway: {
        healthy: true, phase: 'healthy', detail: null, generation: 1, versionId: 'version-1',
      },
    },
  ));
});

test('required alias identity drift changes no comparison logic and fails closed', async () => {
  await assert.rejects(
    () => attestLiveTarget(resolution().value, {
      ...observed,
      bindingIdentities: { ...observed.bindingIdentities, AUTH_DB: 'different-d1' },
    }),
    (error: unknown) => error instanceof AttestationError && error.code === 'BINDING_MISMATCH',
  );
});
