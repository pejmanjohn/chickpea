import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// @ts-expect-error Executable environment modules intentionally have no declarations.
import { claimEnvironment, createEnvironmentRegistry, environmentMarkerPath, readEnvironmentRegistry, reclaimEnvironment, recordEnvironmentAttestation } from '../scripts/lib/environment-registry.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { EnvironmentPreflightError, assertEnvironmentReleaseAllowed, beginEnvironmentDeployment, completeEnvironmentDeployment, environmentDeployReceiptPath, observeProductionEnvironmentAuthority, observeReceiptBackedEnvironment, preflightEnvironmentMutation, readEnvironmentDeployReceipt, authorizeEnvironmentCleanupPlan, reconcileEnvironmentDeployment, recheckEnvironmentMutationAuthority, resumeEnvironmentDeployment, writeEnvironmentBaseline, writeEnvironmentResourceCreationIntent, writeEnvironmentResourceCreationReceipt, writeEnvironmentSchemaAdvancementIntent, withEnvironmentReleaseFence } from '../scripts/lib/environment-preflight.mjs';
import { acquireTargetLock, readTargetLock } from '../qa/live/safety/lock.ts';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { attestEnvironment } from '../scripts/lib/environment-attestation.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { createPhaseOneBaselinePlan, projectProtectedProductInventory } from '../scripts/lib/environment-baseline.mjs';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const DEAD_PID = 2_147_483_647;
const TARGETS = ['amber', 'cobalt', 'fern'] as const;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(input: {
  schemaGeneration?: string;
  reachable?: boolean;
  identityMatches?: boolean;
} = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-preflight-')));
  const worktree = join(parent, 'worktree');
  const root = join(parent, 'registry');
  mkdirSync(worktree);
  git(worktree, 'init', '-b', 'feature/preflight');
  git(worktree, 'config', 'user.email', 'fixture@example.test');
  git(worktree, 'config', 'user.name', 'Fixture');
  writeFileSync(join(worktree, '.gitignore'), '.chickpea-environment\n');
  writeFileSync(join(worktree, 'source.txt'), 'fixture\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'fixture');
  const revision = git(worktree, 'rev-parse', 'HEAD');
  const records = TARGETS.map((target) => {
    const evidenceRoot = join(parent, target, 'evidence');
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    return {
      target, role: 'branch', transport: 'events', workerName: `chickpea-${target}`,
      authDatabaseBinding: 'AUTH_DB', authDatabaseName: `chickpea-auth-db-${target}`,
      authDatabaseId: `d1-${target}`, workspaceId: `T_${target.toUpperCase()}`,
      workspaceLabel: `${target} workspace`, slackAppId: `A_${target.toUpperCase()}`,
      slackAppLabel: `${target} app`, botUserId: `U_${target.toUpperCase()}_BOT`,
      providerProjectId: `provider-${target}`,
      providerReadOnlyAuthConfigId: `provider-read-${target}`,
      timezone: 'America/Los_Angeles', evidenceRoot,
      bindingIdentities: { AUTH_DB: `d1-${target}`, TAG_STATE: `tag-${target}` },
      schemaGeneration: input.schemaGeneration ?? 'd1:0002_mcp_oauth;do:v9',
      servingVersion: `version-${target}`,
      sourceRevision: revision, sourceDirty: false,
      reachable: input.reachable ?? true,
      identityMatches: input.identityMatches ?? true,
      computerUseSurfaces: {
        bridgeAvailable: true, windowCaptureAvailable: true, slackVisible: true, adminVisible: true,
      },
      missingActorAliases: [],
    };
  });
  createEnvironmentRegistry({
    root, hostFingerprint: 'host-fixture', targets: records,
    sandbox: {
      archiveDate: '2027-01-15T00:00:00.000Z', workspaceSlotsTotal: 5,
      workspaceSlotsUsed: 3, integrationHeadroom: 37,
    },
  });
  writeEnvironmentBaseline(records[0]!.evidenceRoot, baseline());
  const options = {
    root, hostFingerprint: 'host-fixture', worktreePath: worktree, now: () => NOW,
    allowTestAuthorityObserver: true,
  };
  return { parent, root, worktree, revision, records, options };
}

function fingerprints(target: string) {
  return Object.fromEntries(['auth', 'cookie', 'signing', 'recovery', 'setup', 'encryption']
    .map((name, index) => [name, `sha256:${target.charCodeAt(0).toString(16)}${index}`.padEnd(71, '0')]));
}

function baseline(target = 'amber') {
  return {
    schemaVersion: 'chickpea-environment-baseline/v1', target,
    manifestDigest: `sha256:${'1'.repeat(64)}`, requiredScopes: ['chat:write'],
    setupContractDigest: `sha256:${'2'.repeat(64)}`,
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    credentialFingerprintsByTarget: Object.fromEntries(TARGETS.map((name) => [name, fingerprints(name)])),
  };
}

function localContract() {
  return {
    manifestDigest: `sha256:${'1'.repeat(64)}`, requiredScopes: ['chat:write'],
    setupContractDigest: `sha256:${'2'.repeat(64)}`,
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    schemaHistory: {
      d1: ['0001_old', '0002_mcp_oauth', '0003_reviewed'],
      durableObject: ['v8', 'v9', 'v10'],
    },
  };
}

function authority(target = 'amber', overrides: Record<string, unknown> = {}) {
  const activeVersion = typeof overrides.activeVersion === 'string'
    ? overrides.activeVersion
    : `version-${target}`;
  return {
    target, observedAt: new Date(NOW).toISOString(), workerName: `chickpea-${target}`,
    activeVersion, activePercentage: 100,
    bindingIdentities: { AUTH_DB: `d1-${target}`, TAG_STATE: `tag-${target}` },
    slack: {
      teamId: `T_${target.toUpperCase()}`, appId: `A_${target.toUpperCase()}`,
      botUserId: `U_${target.toUpperCase()}_BOT`, replySenderId: `U_${target.toUpperCase()}_BOT`,
      scopes: ['chat:write'],
    },
    transport: 'events',
    transportAuthority: {
      installationHealthy: true, signedEventReceiptFresh: true,
      signedEventReceiptVersionId: activeVersion,
      signedEventReceiptAt: new Date(NOW).toISOString(), installationRevision: 1,
      eventsVerified: true,
    },
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    credentialFingerprints: fingerprints(target),
    fleetCredentialFingerprints: Object.fromEntries(TARGETS.map((name) => [name, fingerprints(name)])),
    deploymentMetadata: null,
    ...overrides,
  };
}

const RUNTIME_SECRET_SOURCE_BINDINGS = {
  auth: 'CHICKPEA_AUTH_SECRET', cookie: 'hkdf(CHICKPEA_AUTH_SECRET,chickpea/cookie/v1)',
  signing: 'SLACK_SIGNING_SECRET', recovery: 'CHICKPEA_RECOVERY_TOKEN',
  setup: 'CHICKPEA_SETUP_CAPABILITY_DIGEST',
  encryption: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID+CHICKPEA_CREDENTIAL_KEY_<ID>',
};

function runtimeAuthorities(fingerprintFor = (target: string) => fingerprints(target)) {
  return Object.fromEntries(TARGETS.map((target) => [target, {
    schemaVersion: 'chickpea-environment-runtime-authority/v1', target,
    observedAt: new Date(NOW).toISOString(),
    secretFingerprints: {
      schemaVersion: 'chickpea-environment-runtime-secret-fingerprints/v1',
      sourceBindings: RUNTIME_SECRET_SOURCE_BINDINGS,
      fingerprints: fingerprintFor(target),
    },
    transportAuthority: {
      installationHealthy: true, signedEventReceiptFresh: true,
      signedEventReceiptVersionId: `version-${target}`,
      signedEventReceiptAt: new Date(NOW).toISOString(), installationRevision: 1,
      eventsVerified: true,
    },
  }]));
}

function protectedInventories(
  additions: Partial<Record<(typeof TARGETS)[number], {
    baseline?: Array<{ provider: string; kind: string; id: string }>;
    productOwned?: Array<{ provider: string; kind: string; id: string }>;
  }>> = {},
) {
  return TARGETS.map((target) => ({
    schemaVersion: 'chickpea-environment-protected-resource-inventory/v1',
    target,
    baseline: additions[target]?.baseline ?? [],
    productOwned: additions[target]?.productOwned ?? [],
  }));
}

function rejects(code: string) {
  return (error: unknown) => error instanceof EnvironmentPreflightError
    && (error as { code?: unknown }).code === code;
}

function makeMutationLockStale(evidenceRoot: string) {
  const lockPath = join(evidenceRoot, 'target.lock');
  const owner = readTargetLock(lockPath);
  assert.ok(owner);
  writeFileSync(lockPath, `${JSON.stringify({ ...owner, pid: DEAD_PID })}\n`, { mode: 0o600 });
}

function runNodeModule(source: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', source,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('preflight requires the registry, marker, matching nonce, and every live identity before mutation', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options, root: join(f.parent, 'missing'), baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority(),
  }));
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
  }));
  claimEnvironment('amber', f.options);
  const markerPath = environmentMarkerPath(f.worktree);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  writeFileSync(markerPath, `${JSON.stringify({ ...marker, leaseNonce: '00000000-0000-4000-8000-000000000000' })}\n`);
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
  }));
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

  const mismatches = [
    ['SLACK_TEAM_MISMATCH', { slack: { ...authority().slack, teamId: 'T_WRONG' } }],
    ['SLACK_APP_MISMATCH', { slack: { ...authority().slack, appId: 'A_WRONG' } }],
    ['SLACK_BOT_MISMATCH', { slack: { ...authority().slack, botUserId: 'U_WRONG' } }],
    ['SLACK_SCOPE_MISMATCH', { slack: { ...authority().slack, scopes: [] } }],
    ['WORKER_MISMATCH', { workerName: 'chickpea-cobalt' }],
    ['D1_MISMATCH', { bindingIdentities: { AUTH_DB: 'd1-cobalt', TAG_STATE: 'tag-amber' } }],
  ] as const;
  for (const [code, override] of mismatches) {
    await assert.rejects(preflightEnvironmentMutation('amber', {
      ...f.options, baseline: baseline(), localContract: localContract(),
      observeAuthority: async () => authority('amber', override),
    }), rejects(code));
  }
});

test('preflight refuses baseline, scope, credential, and migration drift with no mutation authority', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  for (const local of [
    { ...localContract(), manifestDigest: `sha256:${'3'.repeat(64)}` },
    { ...localContract(), requiredScopes: ['chat:write', 'users:read'] },
    { ...localContract(), setupContractDigest: `sha256:${'4'.repeat(64)}` },
  ]) {
    await assert.rejects(preflightEnvironmentMutation('amber', {
      ...f.options, baseline: baseline(), localContract: local, observeAuthority: async () => authority(),
    }), rejects('INSTALL_CONTINUATION_REQUIRED'));
  }
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(),
    localContract: { ...localContract(), schemaGeneration: 'd1:0003_new;do:v10' },
    observeAuthority: async () => authority(),
  }), rejects('SCHEMA_ROLLBACK_REFUSED'));
  const duplicate = baseline();
  duplicate.credentialFingerprintsByTarget.cobalt = duplicate.credentialFingerprintsByTarget.amber!;
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options, baseline: duplicate, localContract: localContract(), observeAuthority: async () => authority(),
  }), rejects('CREDENTIAL_FINGERPRINT_REUSED'));
});

test('forward-only schema rejects local rollback and backward intents before authority or D1', async (context) => {
  const f = fixture({ schemaGeneration: 'd1:0003_reviewed;do:v10' });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  let authorityCalls = 0;
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => {
      authorityCalls += 1;
      return authority('amber', { schemaGeneration: 'd1:0003_reviewed;do:v10' });
    },
  }), rejects('SCHEMA_ROLLBACK_REFUSED'));
  assert.equal(authorityCalls, 0);
  for (const generation of ['d1:0001_old;do:v8', 'd1:0002_mcp_oauth;do:v9']) {
    assert.throws(() => writeEnvironmentSchemaAdvancementIntent('amber', generation, f.options),
      rejects('SCHEMA_ROLLBACK_REFUSED'));
  }
});

test('post-deploy reconciliation writes one owner-only receipt and refuses version drift', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
  });
  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  await assert.rejects(completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-next', mutationLease,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-other', deploymentMetadata: preflight.deploymentMetadata,
    }),
  }), rejects('POST_DEPLOY_VERSION_DRIFT'));
  assert.equal(existsSync(environmentDeployReceiptPath(f.records[0]!.evidenceRoot)), false);

  const receipt = await completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-next', mutationLease,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-next', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  const receiptPath = environmentDeployReceiptPath(f.records[0]!.evidenceRoot);
  assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
  assert.deepEqual(readEnvironmentDeployReceipt(receiptPath), receipt);
  assert.doesNotMatch(JSON.stringify(receipt), /feature\/|xox|token|secret|credential/i);
});

test('persisted deploy intent makes the lane unreachable before mutation and live reconciliation resolves a crashed upload', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority(),
  });
  beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  const pending = readEnvironmentRegistry(f.options).targets.amber;
  assert.equal(pending.reachable, false);
  assert.equal(pending.identityMatches, false);
  assert.throws(() => reclaimEnvironment('amber', f.options),
    (error: unknown) => (error as { code?: unknown })?.code === 'TARGET_MUTATION_LOCKED');
  assert.throws(() => withEnvironmentReleaseFence('amber', f.options, () => 'released'),
    rejects('TARGET_LOCK_LIVE'));
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  const receipt = await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-recovered', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  assert.equal(receipt.activeVersion, 'version-recovered');
  const recovered = readEnvironmentRegistry(f.options).targets.amber;
  assert.equal(recovered.reachable, true);
  assert.equal(recovered.identityMatches, true);
  assert.equal(recovered.servingVersion, 'version-recovered');
  assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), false);
  assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'deploy-intent.json')), false);
});

test('resume and reconciliation refuse a live matching mutation-lock owner before authority reads', async (context) => {
  for (const entrypoint of ['resume', 'reconcile'] as const) {
    const f = fixture();
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    claimEnvironment('amber', f.options);
    const preflight = await preflightEnvironmentMutation('amber', {
      ...f.options, baseline: baseline(), localContract: localContract(),
      observeAuthority: async () => authority(),
    });
    beginEnvironmentDeployment(preflight, {
      ...f.options, localContract: preflight.localContract,
    });
    let authorityCalls = 0;
    const recoveryOptions = {
      ...f.options, localContract: preflight.localContract,
      observeAuthority: async () => {
        authorityCalls += 1;
        return authority('amber', { activeVersion: 'version-amber' });
      },
    };
    const operation = entrypoint === 'resume'
      ? resumeEnvironmentDeployment('amber', recoveryOptions)
      : reconcileEnvironmentDeployment('amber', recoveryOptions);
    await assert.rejects(operation, rejects('TARGET_LOCK_LIVE'));
    assert.equal(authorityCalls, 0);
  }
});

test('every deploy-begin crash boundary has a durable no-effect recovery path', async (context) => {
  const boundaries = [
    'afterDeployIntentPublished',
    'afterMutationJournalPublished',
    'afterMutationLockAcquired',
    'afterDeploymentPriorStatePublished',
    'afterDeploymentRegistryIntentRecorded',
  ] as const;
  for (const boundary of boundaries) {
    const f = fixture();
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    claimEnvironment('amber', f.options);
    const preflight = await preflightEnvironmentMutation('amber', {
      ...f.options, baseline: baseline(), localContract: localContract(),
      observeAuthority: async () => authority(),
    });
    assert.throws(() => beginEnvironmentDeployment(preflight, {
      ...f.options,
      localContract: preflight.localContract,
      [boundary]: () => { throw new Error(`crash:${boundary}`); },
    }), new RegExp(`crash:${boundary}`));
    if (boundary === 'afterDeployIntentPublished') {
      assert.throws(() => reclaimEnvironment('amber', f.options),
        (error: unknown) => (error as { code?: unknown })?.code === 'TARGET_MUTATION_LOCKED');
      assert.throws(() => withEnvironmentReleaseFence('amber', f.options, () => 'released'),
        rejects('UNRESOLVED_VERIFIER_INTENT'));
    }
    if (existsSync(join(f.records[0]!.evidenceRoot, 'target.lock'))) {
      makeMutationLockStale(f.records[0]!.evidenceRoot);
    }
    const recovered = await reconcileEnvironmentDeployment('amber', {
      ...f.options, localContract: preflight.localContract,
      observeAuthority: async () => authority('amber', { activeVersion: 'version-amber' }),
    });
    assert.equal(recovered.aborted, true, boundary);
    assert.equal(readEnvironmentRegistry(f.options).targets.amber.reachable, true, boundary);
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), false, boundary);
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'deploy-intent.json')), false, boundary);
  }
});

test('the exact mutation lease completes and reconciles after claim expiry', async (context) => {
  for (const phase of ['before-upload', 'after-upload'] as const) {
    const f = fixture();
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    let clock = NOW;
    const timed = { ...f.options, now: () => clock, leaseDurationMs: 1_000 };
    claimEnvironment('amber', timed);
    const preflight = await preflightEnvironmentMutation('amber', {
      ...timed, baseline: baseline(), localContract: localContract(),
      observeAuthority: async () => authority(),
    });
    const mutationLease = beginEnvironmentDeployment(preflight, {
      ...timed, localContract: preflight.localContract,
    });
    clock = NOW + 1_001;
    assert.doesNotThrow(() => recheckEnvironmentMutationAuthority(preflight, {
      ...timed, localContract: preflight.localContract, mutationLease,
    }));
    if (phase === 'before-upload') {
      await completeEnvironmentDeployment(preflight, {
        ...timed, deployedVersion: 'version-expired-owner', mutationLease,
        observeAuthority: async () => authority('amber', {
          activeVersion: 'version-expired-owner', deploymentMetadata: preflight.deploymentMetadata,
        }),
      });
    } else {
      makeMutationLockStale(f.records[0]!.evidenceRoot);
      await reconcileEnvironmentDeployment('amber', {
        ...timed, localContract: preflight.localContract,
        observeAuthority: async () => authority('amber', {
          activeVersion: 'version-expired-recovered', deploymentMetadata: preflight.deploymentMetadata,
        }),
      });
    }
    assert.equal(readEnvironmentRegistry(timed).targets.amber.reachable, true);
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), false);
    assert.doesNotThrow(() => reclaimEnvironment('amber', timed));
  }
});

test('a pre-upload provider failure can abort after no-effect readback and retry safely', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority(),
  });
  beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  const aborted = await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    observeAuthority: async () => authority('amber', { activeVersion: 'version-amber' }),
  });
  assert.equal(aborted.aborted, true);
  const retryPreflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority(),
  });
  const retryLease = beginEnvironmentDeployment(retryPreflight, {
    ...f.options, localContract: retryPreflight.localContract,
  });
  assert.equal(typeof retryLease.intentDigest, 'string');
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: retryPreflight.localContract,
    observeAuthority: async () => authority('amber', { activeVersion: 'version-amber' }),
  });
});

test('no-effect abort restores the exact prior unhealthy registry state', async (context) => {
  const f = fixture({ reachable: false, identityMatches: true });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority(),
  });
  beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    observeAuthority: async () => authority('amber', { activeVersion: 'version-amber' }),
  });
  const restored = readEnvironmentRegistry(f.options).targets.amber;
  assert.equal(restored.reachable, false);
  assert.equal(restored.identityMatches, true);
});

test('an unhealthy abort finishes idempotently after crashing with its journal resolved', async (context) => {
  const f = fixture({ reachable: false, identityMatches: true });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority(),
  });
  beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  await assert.rejects(reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    afterMutationJournalResolved: () => { throw new Error('crash:aborted-journal-resolved'); },
    observeAuthority: async () => authority('amber', { activeVersion: 'version-amber' }),
  }), /crash:aborted-journal-resolved/);
  const restored = readEnvironmentRegistry(f.options).targets.amber;
  assert.equal(restored.reachable, false);
  assert.equal(restored.identityMatches, true);
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  const recovered = await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    observeAuthority: async () => authority('amber', { activeVersion: 'version-amber' }),
  });
  assert.equal(recovered.aborted, true);
  assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), false);
  assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'deploy-intent.json')), false);
});

test('no-effect abort preserves the attestation present immediately before intent CAS', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority(),
  });
  const attestation = recordEnvironmentAttestation('amber', {
    doctorSnapshot: {
      repositoryRevision: f.revision,
      servingVersion: 'version-amber',
      lock: { status: 'clear' },
    },
    attestation: {
      servingVersion: 'version-amber',
      targetFingerprint: `sha256:${'a'.repeat(64)}`,
    },
  }, f.options);
  beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    observeAuthority: async () => authority('amber', { activeVersion: 'version-amber' }),
  });
  assert.deepEqual(readEnvironmentRegistry(f.options).targets.amber.lastAttestation, attestation);
});

test('a partial schema advancement adopts the exact existing intent and resumes upload', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const nextContract = { ...localContract(), schemaGeneration: 'd1:0003_reviewed;do:v10' };
  writeEnvironmentSchemaAdvancementIntent('amber', nextContract.schemaGeneration, {
    ...f.options, localContract: nextContract,
  });
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: nextContract,
    observeAuthority: async () => authority(),
  });
  const originalLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
    providerContext: ['--profile', 'lane-owner', '--env', 'amber'],
  });
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  const resumed = await resumeEnvironmentDeployment('amber', {
    ...f.options, localContract: nextContract,
    providerContext: ['--profile', 'lane-owner', '--env', 'amber'],
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-amber', schemaGeneration: nextContract.schemaGeneration,
    }),
  });
  assert.equal(resumed.mutationLease.intentDigest, originalLease.intentDigest);
  assert.equal(resumed.preflight.deploymentMetadata.schemaGeneration, nextContract.schemaGeneration);
  await completeEnvironmentDeployment(resumed.preflight, {
    ...f.options, deployedVersion: 'version-schema-resumed',
    mutationLease: resumed.mutationLease,
    providerContext: ['--profile', 'lane-owner', '--env', 'amber'],
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-schema-resumed', schemaGeneration: nextContract.schemaGeneration,
      deploymentMetadata: resumed.preflight.deploymentMetadata,
    }),
  });
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.servingVersion, 'version-schema-resumed');
});

test('two simultaneous stale resumptions produce exactly one adopted mutation owner', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const nextContract = { ...localContract(), schemaGeneration: 'd1:0003_reviewed;do:v10' };
  writeEnvironmentSchemaAdvancementIntent('amber', nextContract.schemaGeneration, {
    ...f.options, localContract: nextContract,
  });
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: nextContract,
    observeAuthority: async () => authority(),
  });
  beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  let authorityCalls = 0;
  const recover = () => resumeEnvironmentDeployment('amber', {
    ...f.options, localContract: nextContract,
    observeAuthority: async () => {
      authorityCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return authority('amber', {
        activeVersion: 'version-amber', schemaGeneration: nextContract.schemaGeneration,
      });
    },
  });
  const results = await Promise.allSettled([recover(), recover()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected'
    && (result.reason as { code?: unknown })?.code === 'TARGET_LOCK_LIVE').length, 1);
  assert.equal(authorityCalls, 1);
});

test('cross-process stale resume and reconciliation races have one mutation owner', async (context) => {
  const preflightModule = pathToFileURL(
    join(process.cwd(), 'scripts/lib/environment-preflight.mjs'),
  ).href;

  const runRace = async (mode: 'resume' | 'reconcile') => {
    const f = fixture();
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    claimEnvironment('amber', f.options);
    const contract = mode === 'resume'
      ? { ...localContract(), schemaGeneration: 'd1:0003_reviewed;do:v10' }
      : localContract();
    if (mode === 'resume') {
      writeEnvironmentSchemaAdvancementIntent('amber', contract.schemaGeneration, {
        ...f.options, localContract: contract,
      });
    }
    const preflight = await preflightEnvironmentMutation('amber', {
      ...f.options, baseline: baseline(), localContract: contract,
      observeAuthority: async () => authority(),
    });
    beginEnvironmentDeployment(preflight, {
      ...f.options, localContract: contract,
    });
    makeMutationLockStale(f.records[0]!.evidenceRoot);

    const barrierPath = join(f.parent, `${mode}.start`);
    const winnerPath = join(f.parent, `${mode}.winner`);
    const observed = authority('amber', mode === 'resume'
      ? { activeVersion: 'version-amber', schemaGeneration: contract.schemaGeneration }
      : { activeVersion: 'version-amber' });
    const childOptions = {
      root: f.root,
      hostFingerprint: 'host-fixture',
      worktreePath: f.worktree,
      allowTestAuthorityObserver: true,
    };
    const source = `
      const { appendFileSync, existsSync } = await import('node:fs');
      const { ${mode === 'resume' ? 'resumeEnvironmentDeployment' : 'reconcileEnvironmentDeployment'}: recover } = await import(${JSON.stringify(preflightModule)});
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      while (!existsSync(${JSON.stringify(barrierPath)})) await delay(5);
      try {
        const result = await recover('amber', {
          ...${JSON.stringify(childOptions)},
          now: () => ${NOW},
          localContract: ${JSON.stringify(contract)},
          observeAuthority: async () => {
            await delay(1000);
            return ${JSON.stringify(observed)};
          },
        });
        appendFileSync(${JSON.stringify(winnerPath)}, ${JSON.stringify(`${mode}\n`)});
        process.stdout.write(JSON.stringify({ ok: true, kind: result?.aborted === true ? 'aborted' : 'resumed' }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? error?.message }));
      }
    `;
    const children = [runNodeModule(source), runNodeModule(source)];
    writeFileSync(barrierPath, 'go\n');
    const outputs = await Promise.all(children);
    outputs.forEach((output) => assert.equal(output.status, 0, output.stderr));
    const results = outputs.map((output) => JSON.parse(output.stdout) as {
      ok: boolean; code?: string; kind?: string;
    });
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.code === 'TARGET_LOCK_LIVE').length, 1);
    assert.equal(readFileSync(winnerPath, 'utf8'), `${mode}\n`);

    if (mode === 'resume') {
      const receipt = await reconcileEnvironmentDeployment('amber', {
        ...f.options, localContract: contract,
        observeAuthority: async () => authority('amber', {
          activeVersion: 'version-cross-process',
          schemaGeneration: contract.schemaGeneration,
          deploymentMetadata: preflight.deploymentMetadata,
        }),
      });
      assert.equal(receipt.activeVersion, 'version-cross-process');
    } else {
      assert.equal(results.find((result) => result.ok)?.kind, 'aborted');
    }
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), false);
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'deploy-intent.json')), false);
  };

  await runRace('resume');
  await runRace('reconcile');
});

test('reconciliation reuses the nonce-bound provider context and rejects a conflicting override', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority(),
  });
  beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
    providerContext: ['--profile', 'lane-owner', '--env', 'amber'],
  });
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  await assert.rejects(reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    providerContext: ['--profile', 'other-owner', '--env', 'amber'],
    observeAuthority: async () => authority(),
  }), rejects('PROVIDER_CONTEXT_CONFLICT'));
  let observedContext: unknown;
  await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    observeAuthority: async (_request: unknown, observerOptions: { providerContext?: unknown }) => {
      observedContext = observerOptions.providerContext;
      return authority('amber', { activeVersion: 'version-amber' });
    },
  });
  assert.deepEqual(observedContext, ['--profile', 'lane-owner', '--env', 'amber']);
});

test('release fencing is target-local and rejects live locks or unresolved verifier intent', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const evidenceRoot = f.records[0]!.evidenceRoot;
  writeFileSync(join(evidenceRoot, 'target.lock'), `${JSON.stringify({
    runId: 'run-amber', pid: process.pid, host: 'test-host', startedAt: new Date(NOW).toISOString(),
  })}\n`, { mode: 0o600 });
  assert.throws(() => assertEnvironmentReleaseAllowed('amber', {
    ...f.options, lockHost: 'test-host', isPidActive: () => true,
  }), rejects('TARGET_LOCK_LIVE'));
  rmSync(join(evidenceRoot, 'target.lock'));
  mkdirSync(join(evidenceRoot, 'runs'), { mode: 0o700 });
  writeFileSync(join(evidenceRoot, 'target.lock'), `${JSON.stringify({
    runId: 'run-amber', pid: 999999, host: 'test-host', startedAt: new Date(NOW).toISOString(),
  })}\n`, { mode: 0o600 });
  writeFileSync(join(evidenceRoot, 'runs', 'run-amber.jsonl'), [
    JSON.stringify({ record: 'header', schemaVersion: 'chickpea-live-journal/v1', seq: 0, runId: 'run-amber' }),
    JSON.stringify({ record: 'event', runId: 'run-amber', event: { type: 'intent', intentId: 'intent-1' } }),
  ].join('\n') + '\n', { mode: 0o600 });
  assert.throws(() => assertEnvironmentReleaseAllowed('amber', {
    ...f.options, lockHost: 'test-host', isPidActive: () => false,
  }), rejects('UNRESOLVED_VERIFIER_INTENT'));
  assert.doesNotThrow(() => assertEnvironmentReleaseAllowed('cobalt', {
    ...f.options, worktreePath: f.worktree, skipClaimCheck: true,
  }));
});

test('reclaim respects the shared target mutation lock and stale release locks recover from journals', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const evidenceRoot = f.records[0]!.evidenceRoot;
  mkdirSync(join(evidenceRoot, 'runs'), { mode: 0o700 });
  writeFileSync(join(evidenceRoot, 'target.lock'), `${JSON.stringify({
    runId: 'environment-deploy-amber-active', pid: process.pid, host: 'test-host',
    startedAt: new Date(NOW).toISOString(),
  })}\n`, { mode: 0o600 });
  writeFileSync(join(evidenceRoot, 'runs', 'environment-deploy-amber-active.jsonl'), [
    JSON.stringify({
      record: 'header', schemaVersion: 'chickpea-live-journal/v1', seq: 0,
      runId: 'environment-deploy-amber-active',
    }),
    JSON.stringify({
      record: 'event', seq: 1, runId: 'environment-deploy-amber-active',
      event: { type: 'intent', intentId: 'deploy-intent-active' },
    }),
    '',
  ].join('\n'), { mode: 0o600 });
  assert.throws(() => reclaimEnvironment('amber', {
    ...f.options, lockHost: 'test-host', isPidActive: () => true,
  }));

  rmSync(join(evidenceRoot, 'target.lock'));
  const preflightModule = pathToFileURL(join(process.cwd(), 'scripts/lib/environment-preflight.mjs')).href;
  const childOptions = JSON.stringify({
    root: f.root, hostFingerprint: 'host-fixture', worktreePath: f.worktree,
    lockHost: 'test-host',
  });
  const killed = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    const { withEnvironmentReleaseFence } = await import(${JSON.stringify(preflightModule)});
    withEnvironmentReleaseFence('amber', { ...${childOptions},
      now: () => ${NOW},
      afterReleaseFenceAcquired: () => process.kill(process.pid, 'SIGKILL'),
    }, () => 'unreachable');
  `]);
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(existsSync(join(evidenceRoot, 'target.lock')), true);
  assert.equal(withEnvironmentReleaseFence('amber', {
    ...f.options, lockHost: 'test-host', isPidActive: () => false,
  }, () => 'released-after-recovery'), 'released-after-recovery');
});

for (const transport of ['events', 'gateway']) test(`production ${transport} authority uses live reads without shadow credentials`, async () => {
  const calls: string[] = [];
  const context = {
    target: 'amber',
    registration: {
      workerName: 'chickpea-amber', transport,
      authDatabaseName: 'chickpea-auth-db-amber', authDatabaseId: 'd1-amber',
      schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
      bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber:TagStateStore' },
    },
    phase: 'before',
  };
  const runtime = runtimeAuthorities();
  const gatewayRuntime = Object.fromEntries(TARGETS.map((target) => [target, {
    ...runtime[target], schemaVersion: 'chickpea-environment-runtime-authority/v2',
    secretFingerprints: {
      ...runtime[target]!.secretFingerprints,
      schemaVersion: 'chickpea-environment-runtime-secret-fingerprints/v2',
      sourceBindings: { ...RUNTIME_SECRET_SOURCE_BINDINGS, cookie: 'CHICKPEA_AUTH_SECRET',
        signing: 'slack.gateway.deploymentIdentity.v1.deploymentId' },
    },
    slack: authority(target).slack,
    transportAuthority: { healthy: true, phase: 'healthy', detail: null, generation: 1, versionId: `version-${target}` },
  }]));
  const options = {
    env: {
      ...(transport === 'events' ? { CHICKPEA_ENV_AMBER_SLACK_BOT_TOKEN: 'test-only-token' } : {}),
      // Legacy shadow values are deliberately identical. Live runtime authority,
      // derived from the actual Worker bindings, is the only fingerprint source.
      CHICKPEA_ENV_AMBER_AUTH_SECRET: 'ignored-shadow-value',
      CHICKPEA_ENV_COBALT_AUTH_SECRET: 'ignored-shadow-value',
    },
    now: () => NOW,
    fetchImpl: async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        headers: { get: (name: string) => name.toLowerCase() === 'x-oauth-scopes' ? 'chat:write' : null },
        json: async () => ({ ok: true, team_id: 'T_AMBER', app_id: 'A_AMBER', user_id: 'U_AMBER_BOT' }),
      };
    },
    runWrangler: (args: string[]) => {
      calls.push(args.join(' '));
      if (args[0] === 'deployments') return {
        status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'version-amber', percentage: 100 }] }),
      };
      if (args[0] === 'd1') return {
        status: 0, stdout: JSON.stringify([{
          success: true, results: [{ name: '0002_mcp_oauth.sql' }],
        }]),
      };
      return {
        status: 0, stdout: JSON.stringify({ migrations: [{ tag: 'v9' }], resources: { bindings: [
          { name: 'AUTH_DB', type: 'd1', id: 'd1-amber' },
          { name: 'TAG_STATE', type: 'durable_object_namespace', class_name: 'TagStateStore' },
          { name: 'CHICKPEA_ENV_TAG_STATE_ID', type: 'plain_text', text: 'chickpea-amber:TagStateStore' },
          { name: 'CHICKPEA_ENV_SCHEMA_GENERATION', type: 'plain_text', text: 'd1:0002_mcp_oauth;do:v9' },
          { name: 'CHICKPEA_ENV_TARGET', type: 'plain_text', text: 'amber' },
          { name: 'CHICKPEA_ENV_SOURCE_REVISION', type: 'plain_text', text: '1234567' },
          { name: 'CHICKPEA_ENV_SOURCE_DIRTY', type: 'plain_text', text: 'false' },
          { name: 'CHICKPEA_ENV_CLAIM_NONCE', type: 'plain_text', text: '00000000-0000-4000-8000-000000000000' },
          { name: 'CHICKPEA_ENV_REGISTRY_REVISION', type: 'plain_text', text: '1' },
          { name: 'CHICKPEA_ENV_WORKER', type: 'plain_text', text: 'chickpea-amber' },
          { name: 'CHICKPEA_ENV_AUTH_DB_ID', type: 'plain_text', text: 'd1-amber' },
          { name: 'CHICKPEA_ENV_SLACK_TEAM', type: 'plain_text', text: 'T_AMBER' },
          { name: 'CHICKPEA_ENV_SLACK_APP', type: 'plain_text', text: 'A_AMBER' },
          { name: 'CHICKPEA_ENV_SLACK_BOT', type: 'plain_text', text: 'U_AMBER_BOT' },
          { name: 'CHICKPEA_ENV_MANIFEST_DIGEST', type: 'plain_text', text: `sha256:${'1'.repeat(64)}` },
          { name: 'CHICKPEA_ENV_SETUP_CONTRACT_DIGEST', type: 'plain_text', text: `sha256:${'2'.repeat(64)}` },
          { name: 'CHICKPEA_ENV_BASELINE_DIGEST', type: 'plain_text', text: `sha256:${'3'.repeat(64)}` },
          ...Object.entries(fingerprints('amber')).map(([name, value]) => ({
            name: `CHICKPEA_ENV_FINGERPRINT_${name.toUpperCase()}`, type: 'plain_text', text: value,
          })),
        ] } }),
      };
    },
    allowTestRuntimeAuthorityReader: true,
    readFleetRuntimeAuthorities: async () => transport === 'gateway' ? gatewayRuntime : runtime,
  };
  const result = await observeProductionEnvironmentAuthority(context, options);
  assert.equal(result.slack.botUserId, 'U_AMBER_BOT');
  assert.equal(result.bindingIdentities.AUTH_DB, 'd1-amber');
  assert.equal(result.activeVersion, 'version-amber');
  assert.deepEqual(calls, [
    'deployments status --json --name chickpea-amber',
    'versions view version-amber --json --name chickpea-amber',
    'd1 execute chickpea-auth-db-amber --remote --json --command SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    ...(transport === 'events' ? ['https://slack.com/api/auth.test'] : []),
  ]);
  if (transport === 'gateway') {
    const valid = structuredClone(gatewayRuntime);
    for (const [mutate, code] of [
      [() => { gatewayRuntime.amber!.observedAt = new Date(NOW - 60_001).toISOString(); }, 'RUNTIME_AUTHORITY_INVALID'],
      [() => { gatewayRuntime.amber!.slack.teamId = 'OTHER'; }, 'SLACK_AUTHORITY_MISMATCH'],
      [() => { gatewayRuntime.amber!.transportAuthority.versionId = 'old'; }, 'RUNTIME_AUTHORITY_INVALID'],
      [() => { gatewayRuntime.cobalt!.secretFingerprints.fingerprints = fingerprints('amber'); }, 'CREDENTIAL_FINGERPRINT_REUSED'],
    ] as const) {
      mutate();
      await assert.rejects(observeProductionEnvironmentAuthority(context, options), rejects(code));
      Object.assign(gatewayRuntime, structuredClone(valid));
    }
    const bridgeEnv = Object.fromEntries(TARGETS.flatMap((target) => [
      [`CHICKPEA_ENV_${target.toUpperCase()}_LIVE_AUTHORITY_URL`, `https://${target}.test/internal/environment/authority`],
      [`CHICKPEA_ENV_${target.toUpperCase()}_LIVE_AUTHORITY_READ_TOKEN`, Buffer.alloc(32, target.charCodeAt(0)).toString('base64url')],
    ]));
    let oversized = false;
    let bridgeCalls = 0;
    const realBridgeOptions = { ...options, env: bridgeEnv, readFleetRuntimeAuthorities: undefined,
      fetchImpl: async (url: URL, init: RequestInit) => {
        bridgeCalls += 1;
        const target = url.hostname.split('.')[0]!;
        assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${Buffer.alloc(32, target.charCodeAt(0)).toString('base64url')}`);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal);
        return oversized ? new Response('x'.repeat(65_537)) : Response.json(gatewayRuntime[target]);
      },
    };
    assert.equal((await observeProductionEnvironmentAuthority(context, realBridgeOptions)).slack.teamId, 'T_AMBER');
    const tokenName = 'CHICKPEA_ENV_AMBER_LIVE_AUTHORITY_READ_TOKEN';
    const validToken = bridgeEnv[tokenName]!;
    bridgeEnv[tokenName] = 'a'.repeat(64);
    bridgeCalls = 0;
    await assert.rejects(observeProductionEnvironmentAuthority(context, realBridgeOptions), rejects('LIVE_AUTHORITY_READ_TOKEN_INVALID'));
    assert.equal(bridgeCalls, 0);
    bridgeEnv[tokenName] = validToken;
    oversized = true;
    await assert.rejects(observeProductionEnvironmentAuthority(context, realBridgeOptions), rejects('LIVE_AUTHORITY_BRIDGE_UNAVAILABLE'));
  }
});

test('Cloudflare authority forwards the exact resolved profile and environment to every read', async () => {
  const calls: string[][] = [];
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration: {
      workerName: 'chickpea-amber', transport: 'events',
      authDatabaseName: 'chickpea-auth-db-amber', authDatabaseId: 'd1-amber',
      schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
      bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber:TagStateStore' },
    }, phase: 'before',
  }, {
    providerContext: ['--profile', 'lane-account', '--env', 'amber'],
    runWrangler: (args: string[]) => {
      calls.push(args);
      return { status: 1, stdout: '' };
    },
  }), rejects('WORKER_AUTHORITY_UNAVAILABLE'));
  assert.deepEqual(calls[0]?.slice(-4), ['--profile', 'lane-account', '--env', 'amber']);
});

test('production authority refuses unmarked test observer seams', async () => {
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration: {
      workerName: 'chickpea-amber', transport: 'events',
      authDatabaseName: 'chickpea-auth-db-amber', authDatabaseId: 'd1-amber',
      schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
      bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber:TagStateStore' },
    }, phase: 'before',
  }, {
    readFleetRuntimeAuthorities: async () => runtimeAuthorities(),
    runWrangler: () => ({ status: 1, stdout: '' }),
  }), rejects('TEST_RUNTIME_AUTHORITY_READER_REFUSED'));
  const f = fixture();
  try {
    claimEnvironment('amber', f.options);
    await assert.rejects(preflightEnvironmentMutation('amber', {
      ...f.options, allowTestAuthorityObserver: false,
      baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
    }), rejects('TEST_AUTHORITY_OBSERVER_REFUSED'));
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test('production authority rejects split traffic, wrong D1, and reused runtime secrets', async () => {
  const registration = {
    workerName: 'chickpea-amber', transport: 'events',
    authDatabaseName: 'chickpea-auth-db-amber', authDatabaseId: 'd1-amber',
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber:TagStateStore' },
  };
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration, phase: 'before',
  }, {
    runWrangler: () => ({ status: 0, stdout: JSON.stringify({ versions: [
      { version_id: 'version-amber', percentage: 50 },
      { version_id: 'version-other', percentage: 50 },
    ] }) }),
  }), rejects('DEPLOYMENT_VECTOR_MISMATCH'));

  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration, phase: 'before',
  }, {
    runWrangler: (args: string[]) => args[0] === 'deployments'
      ? ({ status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'version-amber', percentage: 100 }] }) })
      : ({ status: 0, stdout: JSON.stringify({ resources: { bindings: [
        { name: 'AUTH_DB', type: 'd1', id: 'd1-other' },
      ] } }) }),
  }), rejects('D1_MISMATCH'));

  const metadata = {
    CHICKPEA_ENV_TAG_STATE_ID: 'chickpea-amber:TagStateStore', CHICKPEA_ENV_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    CHICKPEA_ENV_TARGET: 'amber', CHICKPEA_ENV_SOURCE_REVISION: '1234567',
    CHICKPEA_ENV_SOURCE_DIRTY: 'false', CHICKPEA_ENV_CLAIM_NONCE: '00000000-0000-4000-8000-000000000000',
    CHICKPEA_ENV_REGISTRY_REVISION: '1', CHICKPEA_ENV_WORKER: 'chickpea-amber',
    CHICKPEA_ENV_AUTH_DB_ID: 'd1-amber', CHICKPEA_ENV_SLACK_TEAM: 'T_AMBER',
    CHICKPEA_ENV_SLACK_APP: 'A_AMBER', CHICKPEA_ENV_SLACK_BOT: 'U_AMBER_BOT',
    CHICKPEA_ENV_MANIFEST_DIGEST: `sha256:${'1'.repeat(64)}`,
    CHICKPEA_ENV_SETUP_CONTRACT_DIGEST: `sha256:${'2'.repeat(64)}`,
    CHICKPEA_ENV_BASELINE_DIGEST: `sha256:${'3'.repeat(64)}`,
  };
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration, phase: 'before',
  }, {
    runWrangler: (args: string[]) => {
      if (args[0] === 'deployments') return {
        status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'version-amber', percentage: 100 }] }),
      };
      if (args[0] === 'd1') return {
        status: 0, stdout: JSON.stringify([{
          success: true, results: [{ name: '0002_mcp_oauth.sql' }],
        }]),
      };
      return { status: 0, stdout: JSON.stringify({ migrations: [{ tag: 'v9' }], resources: { bindings: [
        { name: 'AUTH_DB', type: 'd1', id: 'd1-amber' },
        { name: 'TAG_STATE', type: 'durable_object_namespace', class_name: 'TagStateStore' },
        ...Object.entries(metadata).map(([name, text]) => ({ name, type: 'plain_text', text })),
      ] } }) };
    },
    allowTestRuntimeAuthorityReader: true,
    readFleetRuntimeAuthorities: async () => runtimeAuthorities(() => fingerprints('amber')),
  }), rejects('CREDENTIAL_FINGERPRINT_REUSED'));
});

test('matching metadata stamps cannot hide wrong Durable Object or D1 schema authority', async () => {
  const registration = {
    workerName: 'chickpea-amber', transport: 'events',
    authDatabaseName: 'chickpea-auth-db-amber', authDatabaseId: 'd1-amber',
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber:TagStateStore' },
  };
  const metadata = {
    CHICKPEA_ENV_TAG_STATE_ID: registration.bindingIdentities.TAG_STATE,
    CHICKPEA_ENV_SCHEMA_GENERATION: registration.schemaGeneration,
    CHICKPEA_ENV_TARGET: 'amber', CHICKPEA_ENV_SOURCE_REVISION: '1234567',
    CHICKPEA_ENV_SOURCE_DIRTY: 'false', CHICKPEA_ENV_CLAIM_NONCE: '00000000-0000-4000-8000-000000000000',
    CHICKPEA_ENV_REGISTRY_REVISION: '1', CHICKPEA_ENV_WORKER: 'chickpea-amber',
    CHICKPEA_ENV_AUTH_DB_ID: 'd1-amber', CHICKPEA_ENV_SLACK_TEAM: 'T_AMBER',
    CHICKPEA_ENV_SLACK_APP: 'A_AMBER', CHICKPEA_ENV_SLACK_BOT: 'U_AMBER_BOT',
    CHICKPEA_ENV_MANIFEST_DIGEST: `sha256:${'1'.repeat(64)}`,
    CHICKPEA_ENV_SETUP_CONTRACT_DIGEST: `sha256:${'2'.repeat(64)}`,
    CHICKPEA_ENV_BASELINE_DIGEST: `sha256:${'3'.repeat(64)}`,
  };
  const runWrangler = (actualClass: string, d1Migration: string, doMigration: string) =>
    (args: string[]) => {
      if (args[0] === 'deployments') return {
        status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'version-amber', percentage: 100 }] }),
      };
      if (args[0] === 'd1') return {
        status: 0, stdout: JSON.stringify([{
          success: true, results: [{ name: `${d1Migration}.sql` }],
        }]),
      };
      return { status: 0, stdout: JSON.stringify({
        migrations: [{ tag: doMigration }],
        resources: { bindings: [
          { name: 'AUTH_DB', type: 'd1', id: 'd1-amber' },
          { name: 'TAG_STATE', type: 'durable_object_namespace', class_name: actualClass },
          ...Object.entries(metadata).map(([name, text]) => ({ name, type: 'plain_text', text })),
        ] },
      }) };
    };
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration, phase: 'before',
  }, {
    runWrangler: runWrangler('ForgedTagStateStore', '0002_mcp_oauth', 'v9'),
  }), rejects('DURABLE_OBJECT_AUTHORITY_MISMATCH'));
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration, phase: 'before',
  }, {
    runWrangler: runWrangler('TagStateStore', '0001_initial', 'v9'),
  }), rejects('INCOMPATIBLE_SCHEMA_GENERATION'));
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration, phase: 'before',
  }, {
    runWrangler: runWrangler('TagStateStore', '0002_mcp_oauth', 'v8'),
  }), rejects('INCOMPATIBLE_SCHEMA_GENERATION'));
});

test('expired claim fails before authority observation and release holds the verifier lock across mutation', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', { ...f.options, leaseDurationMs: 1_000 });
  let observations = 0;
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options, now: () => NOW + 1_001, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => { observations += 1; return authority(); },
  }), (error: unknown) => (error as { code?: unknown })?.code === 'CLAIM_EXPIRED_RECLAIM_REQUIRED');
  assert.equal(observations, 0);

  const fenced = withEnvironmentReleaseFence('amber', f.options, () => 'released');
  assert.equal(fenced, 'released');
  let raceBlocked = false;
  withEnvironmentReleaseFence('amber', {
    ...f.options,
    afterReleaseFenceAcquired: ({ lockPath }: { lockPath: string }) => {
      assert.throws(() => acquireTargetLock(lockPath, {
        runId: 'verifier-race', pid: process.pid, host: 'test-host',
        startedAt: new Date(NOW).toISOString(),
      }));
      raceBlocked = true;
    },
  }, () => 'released');
  assert.equal(raceBlocked, true);
});

test('receipt publication is crash-explicit and receipt-backed observation rejects live drift', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
  });
  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  await assert.rejects(completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-next', mutationLease,
    beforeReceiptFinalize: () => { throw new Error('crash'); },
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-next', deploymentMetadata: preflight.deploymentMetadata,
    }),
  }), /crash/);
  const pending = readEnvironmentRegistry(f.options).targets.amber;
  assert.equal(pending.servingVersion, 'version-next');
  assert.equal(pending.reachable, false);
  assert.equal(existsSync(environmentDeployReceiptPath(f.records[0]!.evidenceRoot)), false);

  // Supported live-authority reconciliation finalizes the same exact claim
  // and content-free receipt without trusting the crashed process's stdout.
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-next', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  const observed = await observeReceiptBackedEnvironment('amber', {
    ...f.options,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-next', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  assert.equal(observed.deployments[0].versionId, 'version-next');
  const attested = await attestEnvironment('amber', undefined, {
    ...f.options,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-next', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  assert.equal(attested.attestation.servingVersion, 'version-next');
  await assert.rejects(observeReceiptBackedEnvironment('amber', {
    ...f.options,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-other', deploymentMetadata: preflight.deploymentMetadata,
    }),
  }), rejects('DEPLOY_RECEIPT_LIVE_MISMATCH'));
});

test('cleanup authorization validates every receipt and independently denies permanent IDs', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const writeChain = (name: string, id: string) => {
    const intentPath = join(f.parent, `${name}-intent.json`);
    const receiptPath = join(f.parent, `${name}-receipt.json`);
    const intent = writeEnvironmentResourceCreationIntent(intentPath, {
      target: 'amber', provider: 'cloudflare', kind: 'worker',
    }, f.options);
    const readback = {
      target: 'amber', provider: 'cloudflare', kind: 'worker', id,
      immutableId: `version-${name}`,
      creationIntentDigest: intent.intentDigest, observedAt: new Date(NOW).toISOString(),
    };
    writeEnvironmentResourceCreationReceipt(receiptPath, {
      target: 'amber', provider: 'cloudflare', kind: 'worker', id,
      intentPath, providerReadback: readback,
    }, { ...f.options, allowSuppliedProviderReadback: true });
    return { receiptPath, readback };
  };
  const disposable = writeChain('disposable', 'disposable-worker-1');
  assert.equal(authorizeEnvironmentCleanupPlan([
    { provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-1' },
  ], {
    ...f.options, target: 'amber', receiptPaths: [disposable.receiptPath],
    allowSuppliedProtectedInventories: true, protectedInventories: protectedInventories(),
    readProviderResource: () => disposable.readback,
  }).length, 1);
  const protectedResource = writeChain('protected', 'chickpea-amber');
  let readbackCalls = 0;
  assert.throws(() => authorizeEnvironmentCleanupPlan([
    { provider: 'cloudflare', kind: 'worker', id: 'chickpea-amber' },
  ], {
    ...f.options, target: 'amber', receiptPaths: [protectedResource.receiptPath],
    allowSuppliedProtectedInventories: true, protectedInventories: protectedInventories(),
    readProviderResource: () => { readbackCalls += 1; return protectedResource.readback; },
  }),
  rejects('PROTECTED_PERMANENT_RESOURCE'));
  assert.equal(readbackCalls, 0);
  const protectedByProductInventory = writeChain('protected-product', 'product-owned-worker');
  assert.throws(() => authorizeEnvironmentCleanupPlan([
    { provider: 'cloudflare', kind: 'worker', id: 'product-owned-worker' },
  ], {
    ...f.options, target: 'amber', receiptPaths: [protectedByProductInventory.receiptPath],
    allowSuppliedProtectedInventories: true,
    protectedInventories: protectedInventories({
      fern: { productOwned: [{ provider: 'cloudflare', kind: 'worker', id: 'product-owned-worker' }] },
    }),
    readProviderResource: () => { readbackCalls += 1; return protectedByProductInventory.readback; },
  }), rejects('PROTECTED_PERMANENT_RESOURCE'));
  assert.equal(readbackCalls, 0);
  const projectedInventories = TARGETS.map((target) => {
    const plan = createPhaseOneBaselinePlan(target);
    return projectProtectedProductInventory(plan, Object.fromEntries(
      plan.resources.map(({ key }: { key: string }) => [key, `${target}-${key}`]),
    ));
  });
  for (const inventory of projectedInventories) {
    for (const resource of [...inventory.baseline, ...inventory.productOwned]) {
      const chain = writeChain(resource.id, resource.id);
      assert.throws(() => authorizeEnvironmentCleanupPlan([
        { provider: 'cloudflare', kind: 'worker', id: resource.id },
      ], {
        ...f.options, target: 'amber', receiptPaths: [chain.receiptPath],
        allowSuppliedProtectedInventories: true, protectedInventories: projectedInventories,
        readProviderResource: () => { readbackCalls += 1; return chain.readback; },
      }), rejects('PROTECTED_PERMANENT_RESOURCE'));
    }
  }
  assert.equal(readbackCalls, 0);
  const forged = JSON.parse(readFileSync(disposable.receiptPath, 'utf8'));
  forged.id = 'mixed-worker';
  writeFileSync(disposable.receiptPath, JSON.stringify(forged), { mode: 0o600 });
  assert.throws(() => authorizeEnvironmentCleanupPlan([
    { provider: 'cloudflare', kind: 'worker', id: 'mixed-worker' },
  ], {
    ...f.options, target: 'amber', receiptPaths: [disposable.receiptPath],
    allowSuppliedProtectedInventories: true, protectedInventories: protectedInventories(),
    readProviderResource: () => { readbackCalls += 1; return disposable.readback; },
  }),
  rejects('INVALID_RESOURCE_RECEIPT'));
  assert.equal(readbackCalls, 0);
});

test('final receipt publication cannot make a registry lane ready before final CAS', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
  });
  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  let snapshots = 0;
  await assert.rejects(completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-finalized-before-crash', mutationLease,
    beforeRegistrySnapshotWrite: () => {
      snapshots += 1;
      if (snapshots === 2) throw new Error('final registry crash');
    },
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-finalized-before-crash', deploymentMetadata: preflight.deploymentMetadata,
    }),
  }), /final registry crash/);
  assert.equal(readEnvironmentDeployReceipt(f.records[0]!.evidenceRoot).activeVersion,
    'version-finalized-before-crash');
  const pending = readEnvironmentRegistry(f.options).targets.amber;
  assert.equal(pending.servingVersion, 'version-finalized-before-crash');
  assert.equal(pending.reachable, false);
  assert.equal(pending.identityMatches, false);
  await assert.rejects(completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-finalized-before-crash', mutationLease,
    beforeMutationLeaseResolve: () => { throw new Error('lease resolve crash'); },
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-finalized-before-crash', deploymentMetadata: preflight.deploymentMetadata,
    }),
  }), /lease resolve crash/);
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.reachable, true);
  assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), true);
  makeMutationLockStale(f.records[0]!.evidenceRoot);
  await reconcileEnvironmentDeployment('amber', {
    ...f.options, localContract: preflight.localContract,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-finalized-before-crash', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), false);
});

test('mutation resolution is idempotent across journal-completed and lock-unlinked crashes', async (context) => {
  for (const boundary of ['afterMutationJournalResolved', 'afterMutationLockUnlinked'] as const) {
    const f = fixture();
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    claimEnvironment('amber', f.options);
    const preflight = await preflightEnvironmentMutation('amber', {
      ...f.options, baseline: baseline(), localContract: localContract(),
      observeAuthority: async () => authority(),
    });
    const mutationLease = beginEnvironmentDeployment(preflight, {
      ...f.options, localContract: preflight.localContract,
    });
    await assert.rejects(completeEnvironmentDeployment(preflight, {
      ...f.options,
      deployedVersion: `version-${boundary}`,
      mutationLease,
      [boundary]: () => { throw new Error(`crash:${boundary}`); },
      observeAuthority: async () => authority('amber', {
        activeVersion: `version-${boundary}`,
        deploymentMetadata: preflight.deploymentMetadata,
      }),
    }), new RegExp(`crash:${boundary}`));
    assert.equal(readEnvironmentRegistry(f.options).targets.amber.reachable, true);
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'deploy-intent.json')), true);
    if (existsSync(join(f.records[0]!.evidenceRoot, 'target.lock'))) {
      makeMutationLockStale(f.records[0]!.evidenceRoot);
    }
    await reconcileEnvironmentDeployment('amber', {
      ...f.options, localContract: preflight.localContract,
      observeAuthority: async () => authority('amber', {
        activeVersion: `version-${boundary}`,
        deploymentMetadata: preflight.deploymentMetadata,
      }),
    });
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), false);
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'deploy-intent.json')), false);
  }
});

test('schema advancement requires a nonce-bound intent and clears it only after ready completion', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const nextContract = { ...localContract(), schemaGeneration: 'd1:0003_reviewed;do:v10' };
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: nextContract,
    observeAuthority: async () => authority(),
  }), rejects('INCOMPATIBLE_SCHEMA_GENERATION'));
  writeEnvironmentSchemaAdvancementIntent('amber', nextContract.schemaGeneration, {
    ...f.options, localContract: nextContract,
  });
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: nextContract,
    observeAuthority: async () => authority(),
  });
  assert.equal(preflight.schemaAdvancement, true);
  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  await completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-schema-next', mutationLease,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-schema-next', schemaGeneration: nextContract.schemaGeneration,
      deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.schemaGeneration, nextContract.schemaGeneration);
  assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'schema-advancement-intent.json')), false);
});

test('completion tolerates unrelated registry CAS progress and the shared lease rejects same-target rotation', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
  });
  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  const second = join(f.parent, 'second-worktree');
  mkdirSync(second);
  git(second, 'init', '-b', 'feature/second');
  git(second, 'config', 'user.email', 'fixture@example.test');
  git(second, 'config', 'user.name', 'Fixture');
  writeFileSync(join(second, '.gitignore'), '.chickpea-environment\n');
  writeFileSync(join(second, 'source.txt'), 'fixture\n');
  git(second, 'add', '.');
  git(second, 'commit', '-m', 'fixture');
  claimEnvironment('cobalt', { ...f.options, worktreePath: second });
  await completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-next', mutationLease,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-next', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });

  const rotatedPreflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(),
    observeAuthority: async () => authority('amber', { activeVersion: 'version-next' }),
  });
  const rotatedLease = beginEnvironmentDeployment(rotatedPreflight, {
    ...f.options, localContract: rotatedPreflight.localContract,
  });
  assert.throws(() => reclaimEnvironment('amber', f.options),
    (error: unknown) => (error as { code?: unknown })?.code === 'TARGET_MUTATION_LOCKED');
  await completeEnvironmentDeployment(rotatedPreflight, {
    ...f.options, deployedVersion: 'version-after-rotation', mutationLease: rotatedLease,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-after-rotation', deploymentMetadata: rotatedPreflight.deploymentMetadata,
    }),
  });
});

test('local mutation recheck catches expiry, nonce rotation, and HEAD drift without external authority calls', async (context) => {
  for (const drift of ['expiry', 'nonce', 'head'] as const) {
    const f = fixture();
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    claimEnvironment('amber', { ...f.options, leaseDurationMs: 1_000 });
    const preflight = await preflightEnvironmentMutation('amber', {
      ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
    });
    const options = { ...f.options };
    if (drift === 'expiry') Object.assign(options, { now: () => NOW + 1_001 });
    if (drift === 'nonce') reclaimEnvironment('amber', f.options);
    if (drift === 'head') {
      writeFileSync(join(f.worktree, 'head-drift.txt'), 'changed\n');
      git(f.worktree, 'add', '.');
      git(f.worktree, 'commit', '-m', 'head drift');
    }
    let authorityCalls = 0;
    assert.throws(() => recheckEnvironmentMutationAuthority(preflight, {
      ...options,
      localContract: localContract(),
      observeAuthority: () => { authorityCalls += 1; },
    }));
    assert.equal(authorityCalls, 0);
  }
});

test('receipt-backed observation reruns scopes, reply sender, health, and fleet-secret comparisons', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
  });
  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  await completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-receipt-full', mutationLease,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-receipt-full', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  const failures = [
    authority('amber', {
      activeVersion: 'version-receipt-full', deploymentMetadata: preflight.deploymentMetadata,
      slack: { ...authority().slack, scopes: [] },
    }),
    authority('amber', {
      activeVersion: 'version-receipt-full', deploymentMetadata: preflight.deploymentMetadata,
      slack: { ...authority().slack, replySenderId: 'U_WRONG' },
    }),
    authority('amber', {
      activeVersion: 'version-receipt-full', deploymentMetadata: preflight.deploymentMetadata,
      transportAuthority: {
        ...authority('amber', { activeVersion: 'version-receipt-full' }).transportAuthority,
        installationHealthy: false,
      },
    }),
    authority('amber', {
      activeVersion: 'version-receipt-full', deploymentMetadata: preflight.deploymentMetadata,
      fleetCredentialFingerprints: {
        ...authority().fleetCredentialFingerprints,
        cobalt: fingerprints('amber'),
      },
    }),
  ];
  for (const observed of failures) {
    await assert.rejects(observeReceiptBackedEnvironment('amber', {
      ...f.options, observeAuthority: async () => observed,
    }));
  }
});

test('attestation rejects an unmarked observeLiveTarget seam without recording forged state', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  let calls = 0;
  await assert.rejects(attestEnvironment('amber', undefined, {
    ...f.options,
    observeLiveTarget: async () => { calls += 1; return undefined; },
  }), (error: unknown) => (error as { code?: unknown })?.code === 'TEST_LIVE_OBSERVER_REFUSED');
  assert.equal(calls, 0);
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.lastAttestation, null);
});

test('resource cleanup requires a prior intent and provider readback stamp', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const intentPath = join(f.parent, 'resource-intent.json');
  const receiptPath = join(f.parent, 'resource-receipt-chain.json');
  assert.throws(() => writeEnvironmentResourceCreationReceipt(receiptPath, {
    target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-chain',
  }, f.options), rejects('INVALID_RESOURCE_INTENT'));
  const intent = writeEnvironmentResourceCreationIntent(intentPath, {
    target: 'amber', provider: 'cloudflare', kind: 'worker',
  }, f.options);
  const providerReadback = {
    target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-chain',
    immutableId: 'version-disposable-worker-chain',
    creationIntentDigest: intent.intentDigest, observedAt: new Date(NOW).toISOString(),
  };
  assert.throws(() => writeEnvironmentResourceCreationReceipt(receiptPath, {
    target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-chain',
    intentPath, providerReadback,
  }, f.options), rejects('INVALID_PROVIDER_RESOURCE_READBACK'));
  writeEnvironmentResourceCreationReceipt(receiptPath, {
    target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-chain',
    intentPath, providerReadback,
  }, { ...f.options, allowSuppliedProviderReadback: true });
  const secondReceiptPath = join(f.parent, 'resource-receipt-chain-second.json');
  assert.throws(() => writeEnvironmentResourceCreationReceipt(secondReceiptPath, {
    target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-second',
    intentPath, providerReadback: {
      ...providerReadback, id: 'disposable-worker-second', immutableId: 'version-disposable-worker-second',
    },
  }, { ...f.options, allowSuppliedProviderReadback: true }), rejects('RESOURCE_INTENT_CONSUMED'));
  assert.throws(() => authorizeEnvironmentCleanupPlan([
    { provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-chain' },
  ], {
    ...f.options, target: 'amber', receiptPaths: [receiptPath],
    allowSuppliedProtectedInventories: true, protectedInventories: protectedInventories(),
  }), rejects('PROVIDER_READBACK_REQUIRED'));
  assert.throws(() => authorizeEnvironmentCleanupPlan([
    { provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-chain' },
  ], {
    ...f.options, target: 'amber', receiptPaths: [receiptPath],
    allowSuppliedProtectedInventories: true, protectedInventories: protectedInventories(),
    readProviderResource: () => ({ ...providerReadback, creationIntentDigest: `sha256:${'f'.repeat(64)}` }),
  }));
});
