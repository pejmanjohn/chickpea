import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { assertLiveEnvironmentClaim, claimEnvironment, createEnvironmentRegistry, readEnvironmentRegistry, reclaimEnvironment, releaseEnvironment } from '../scripts/lib/environment-registry.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { beginEnvironmentDeployment, classifySetupContractDrift, completeEnvironmentDeployment, environmentBaselinePath, environmentDeployReceiptPath, readLocalEnvironmentContract, observeProductionEnvironmentAuthority, observeReceiptBackedEnvironment, preflightEnvironmentMutation, readEnvironmentDeployReceipt, authorizeEnvironmentCleanupPlan, reconcileEnvironmentDeployment, recheckEnvironmentMutationAuthority, writeEnvironmentBaseline, writeEnvironmentResourceCreationIntent, writeEnvironmentResourceCreationReceipt, writeEnvironmentSchemaAdvancementIntent, withEnvironmentReleaseFence } from '../scripts/lib/environment-preflight.mjs';
import { acquireTargetLock } from '../qa/live/safety/lock.ts';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { attestEnvironment } from '../scripts/lib/environment-attestation.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { createPhaseOneBaselinePlan, projectProtectedProductInventory } from '../scripts/lib/environment-baseline.mjs';
import { NOW, TARGETS, git, fixture, fingerprints, baseline, localContract, INSTALL_DIGEST, OTHER_INSTALL_DIGEST, FLOW_DIGEST, OTHER_FLOW_DIGEST, OTHER_COMBINED_DIGEST, splitBaseline, splitLocalContract, authority, RUNTIME_SECRET_SOURCE_BINDINGS, runtimeAuthorities, protectedInventories, rejects, makeMutationLockStale } from './environment-preflight.fixture.ts';

test('production authority refuses unmarked test observer seams', async () => {
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration: {
      workerName: 'chickpea-amber-live', transport: 'events',
      authDatabaseName: 'chickpea-auth-db-amber-live', authDatabaseId: 'd1-amber',
      schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
      bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber-live:TagStateStore' },
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
    workerName: 'chickpea-amber-live', transport: 'events',
    authDatabaseName: 'chickpea-auth-db-amber-live', authDatabaseId: 'd1-amber',
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber-live:TagStateStore' },
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
    CHICKPEA_ENV_TAG_STATE_ID: 'chickpea-amber-live:TagStateStore', CHICKPEA_ENV_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    CHICKPEA_ENV_TARGET: 'amber', CHICKPEA_ENV_SOURCE_REVISION: '1234567',
    CHICKPEA_ENV_SOURCE_DIRTY: 'false', CHICKPEA_ENV_CLAIM_NONCE: '00000000-0000-4000-8000-000000000000',
    CHICKPEA_ENV_REGISTRY_REVISION: '1', CHICKPEA_ENV_WORKER: 'chickpea-amber-live',
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
    workerName: 'chickpea-amber-live', transport: 'events',
    authDatabaseName: 'chickpea-auth-db-amber-live', authDatabaseId: 'd1-amber',
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber-live:TagStateStore' },
  };
  const metadata = {
    CHICKPEA_ENV_TAG_STATE_ID: registration.bindingIdentities.TAG_STATE,
    CHICKPEA_ENV_SCHEMA_GENERATION: registration.schemaGeneration,
    CHICKPEA_ENV_TARGET: 'amber', CHICKPEA_ENV_SOURCE_REVISION: '1234567',
    CHICKPEA_ENV_SOURCE_DIRTY: 'false', CHICKPEA_ENV_CLAIM_NONCE: '00000000-0000-4000-8000-000000000000',
    CHICKPEA_ENV_REGISTRY_REVISION: '1', CHICKPEA_ENV_WORKER: 'chickpea-amber-live',
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

test('a new claim can attest the same deployment without rewriting its original receipt', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const original = claimEnvironment('amber', f.options);
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options, baseline: baseline(), localContract: localContract(), observeAuthority: async () => authority(),
  });
  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  const liveAuthority = () => authority('amber', {
    activeVersion: 'version-reused', deploymentMetadata: preflight.deploymentMetadata,
  });
  await completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-reused', mutationLease, observeAuthority: async () => liveAuthority(),
  });
  const receiptPath = environmentDeployReceiptPath(f.records[0]!.evidenceRoot);
  const originalReceipt = readFileSync(receiptPath, 'utf8');
  withEnvironmentReleaseFence('amber', f.options, (fence: { runId: string }) =>
    releaseEnvironment('amber', { ...f.options, expectedTargetLockRunId: fence.runId }));
  const current = claimEnvironment('amber', f.options);
  assert.notEqual(current.leaseNonce, original.leaseNonce);
  const observed = await observeReceiptBackedEnvironment('amber', {
    ...f.options, observeAuthority: async () => liveAuthority(),
  });
  assert.equal(observed.deployments[0].versionId, 'version-reused');
  assert.equal(readFileSync(receiptPath, 'utf8'), originalReceipt);
  const attested = await attestEnvironment('amber', undefined, {
    ...f.options, observeAuthority: async () => liveAuthority(),
  });
  assert.equal(attested.attestation.servingVersion, 'version-reused');
  assert.equal(readFileSync(receiptPath, 'utf8'), originalReceipt);
  // A fresh lease does not authorize changing the deployment's provenance.
  await assert.rejects(observeReceiptBackedEnvironment('amber', {
    ...f.options, observeAuthority: async () => ({ ...liveAuthority(),
      deploymentMetadata: { ...preflight.deploymentMetadata, claimNonce: current.leaseNonce } }),
  }), rejects('DEPLOY_RECEIPT_LIVE_MISMATCH'));
  withEnvironmentReleaseFence('amber', f.options, (fence: { runId: string }) =>
    releaseEnvironment('amber', { ...f.options, expectedTargetLockRunId: fence.runId }));
  writeFileSync(join(f.worktree, 'source.txt'), 'changed source\n');
  git(f.worktree, 'add', 'source.txt');
  git(f.worktree, 'commit', '-m', 'changed source');
  claimEnvironment('amber', f.options);
  let called = false;
  await assert.rejects(observeReceiptBackedEnvironment('amber', {
    ...f.options, observeAuthority: async () => { called = true; return liveAuthority(); },
  }), rejects('DEPLOY_RECEIPT_CLAIM_MISMATCH'));
  assert.equal(called, false);
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
  const protectedResource = writeChain('protected', 'chickpea-amber-live');
  let readbackCalls = 0;
  assert.throws(() => authorizeEnvironmentCleanupPlan([
    { provider: 'cloudflare', kind: 'worker', id: 'chickpea-amber-live' },
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
      cobalt: { productOwned: [{ provider: 'cloudflare', kind: 'worker', id: 'product-owned-worker' }] },
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

test('an install-contract change is refused while a setup-flow change deploys with an unproven marker', async (context) => {
  const f = fixture({ baseline: splitBaseline() });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);

  // The setup capability is what an already-installed lane relies on.
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options,
    baseline: splitBaseline(),
    localContract: splitLocalContract({
      installContractDigest: OTHER_INSTALL_DIGEST,
      setupContractDigest: OTHER_COMBINED_DIGEST,
    }),
    observeAuthority: async () => authority(),
  }), (error: unknown) => rejects('INSTALL_CONTINUATION_REQUIRED')(error)
    && /re-record the lane\s+baseline/i.test(
      String((error as { details?: { recoveryAction?: string } }).details?.recoveryAction ?? ''),
    )
    && !/install continuation module/i.test(
      String((error as { details?: { recoveryAction?: string } }).details?.recoveryAction ?? ''),
    ));

  // First-run UX cannot invalidate an installation that already happened.
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options,
    baseline: splitBaseline(),
    localContract: splitLocalContract({
      setupFlowDigest: OTHER_FLOW_DIGEST,
      setupContractDigest: OTHER_COMBINED_DIGEST,
    }),
    observeAuthority: async () => authority(),
  });
  assert.deepEqual(preflight.setupFlow, {
    proven: false, baselineDigest: FLOW_DIGEST, localDigest: OTHER_FLOW_DIGEST,
  });

  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: preflight.localContract,
  });
  const receipt = await completeEnvironmentDeployment(preflight, {
    ...f.options, deployedVersion: 'version-next', mutationLease,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-next', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  assert.equal(receipt.setupFlowUnprovenSince, f.revision);
  assert.equal(receipt.installContractDigest, INSTALL_DIGEST);
  assert.equal(receipt.setupFlowDigest, OTHER_FLOW_DIGEST);
  assert.deepEqual(readEnvironmentDeployReceipt(f.records[0]!.evidenceRoot), receipt);
  assert.equal(
    readEnvironmentRegistry(f.options).targets.amber.setupFlowUnprovenSince,
    f.revision,
  );

  // Re-recording the baseline after a proven fresh install clears the marker.
  rmSync(environmentBaselinePath(f.records[0]!.evidenceRoot));
  writeEnvironmentBaseline(
    f.records[0]!.evidenceRoot,
    splitBaseline({ setupFlowDigest: OTHER_FLOW_DIGEST }),
    { ...f.options, clearSetupFlowUnproven: true },
  );
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.setupFlowUnprovenSince, null);
});

test('a legacy baseline treats combined drift as setup-flow drift unless the install source itself changed', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const installSource = 'export const setupCapability = 1;\n';
  writeFileSync(join(f.worktree, 'setup-capability.mjs'), installSource);
  const legacyLocal = {
    ...localContract(),
    setupContractDigest: OTHER_COMBINED_DIGEST,
    installContractFiles: ['setup-capability.mjs'],
  };

  // Same install source at the lane's recorded revision: soft.
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options,
    projectRoot: f.worktree,
    showFileAtRevision: (revision: string) => {
      assert.equal(revision, f.revision);
      return installSource;
    },
    baseline: baseline(),
    localContract: legacyLocal,
    observeAuthority: async () => authority(),
  });
  assert.deepEqual(preflight.setupFlow, {
    proven: false,
    baselineDigest: `sha256:${'2'.repeat(64)}`,
    localDigest: OTHER_COMBINED_DIGEST,
  });

  // Changed install source at that revision: hard.
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options,
    projectRoot: f.worktree,
    showFileAtRevision: () => 'export const setupCapability = 2;\n',
    baseline: baseline(),
    localContract: legacyLocal,
    observeAuthority: async () => authority(),
  }), rejects('INSTALL_CONTINUATION_REQUIRED'));

  // Unresolvable recorded source: fail closed.
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options,
    projectRoot: f.worktree,
    showFileAtRevision: () => null,
    baseline: baseline(),
    localContract: legacyLocal,
    observeAuthority: async () => authority(),
  }), rejects('INSTALL_CONTINUATION_REQUIRED'));
});

test('the local contract splits the setup sources into an install contract and a setup flow', () => {
  const contract = readLocalEnvironmentContract({ projectRoot: process.cwd() });
  assert.equal(
    contract.manifestDigest,
    'sha256:7f18704b748f5c02253f493b2562bcf471097a237305776d277ceb463ab9ed0a',
  );
  assert.equal(
    contract.existingInstallManifestDigest,
    'sha256:ebb63684f95e53b72033bd3f1b709268e6ec6a73aeac8c8ba119e5c66366e248',
  );
  assert.deepEqual(
    contract.existingInstallScopes,
    contract.requiredScopes.filter((scope: string) => !['lists:read', 'lists:write'].includes(scope)),
  );
  assert.match(contract.installContractDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(contract.setupFlowDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(contract.installContractDigest, contract.setupFlowDigest);
  assert.deepEqual(contract.installContractFiles, ['src/auth/setup-capability.mjs']);
  assert.deepEqual(
    classifySetupContractDrift(contract, {
      ...baseline(),
      installContractDigest: contract.installContractDigest,
      setupFlowDigest: OTHER_FLOW_DIGEST,
      setupContractDigest: contract.setupContractDigest,
    }),
    {
      legacyBaseline: false,
      installChanged: false,
      setupFlowChanged: true,
      baselineDigest: OTHER_FLOW_DIGEST,
      localDigest: contract.setupFlowDigest,
    },
  );
});

test('a second host reads a lane through its recorded authority origin, and another host\'s lane must answer live', async (context) => {
  const f = fixture({ transport: 'gateway' });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  // This host's registry: amber is its own, cobalt belongs to another host.
  // Neither lane has a URL in the environment or a credential file; the
  // records carry the origins, the environment carries only the tokens.
  const cloudRoot = join(f.parent, 'cloud');
  const remoteEvidence = join(f.parent, 'cloud-cobalt', 'evidence');
  mkdirSync(remoteEvidence, { recursive: true, mode: 0o700 });
  createEnvironmentRegistry({
    root: cloudRoot, hostFingerprint: 'cloud-host',
    sandbox: { archiveDate: '2027-01-15T00:00:00.000Z', workspaceSlotsTotal: 5, workspaceSlotsUsed: 3, integrationHeadroom: 37 },
    targets: f.records.map((record) => record.target === 'cobalt'
      ? { ...record, evidenceRoot: remoteEvidence, ownership: 'remote', authorityOrigin: 'https://cobalt.test' }
      : { ...record, ownership: 'local', authorityOrigin: 'https://amber.test' }),
  });
  const cloud = { root: cloudRoot, hostFingerprint: 'cloud-host', worktreePath: f.worktree, now: () => NOW };
  claimEnvironment('amber', cloud);
  const { claim, registration } = assertLiveEnvironmentClaim('amber', cloud);
  const runtime = runtimeAuthorities();
  const gatewayRuntime: Record<string, any> = Object.fromEntries(TARGETS.map((target) => [target, {
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
  const token = (target: string) => Buffer.alloc(32, target.charCodeAt(0)).toString('base64url');
  const env: Record<string, string> = Object.fromEntries(TARGETS.map((target) => [
    `CHICKPEA_ENV_${target.toUpperCase()}_LIVE_AUTHORITY_READ_TOKEN`, token(target),
  ]));
  const requested: string[] = [];
  const notices: string[] = [];
  let down = new Set<string>();
  const options = {
    ...cloud, env, credentialsRoot: join(f.parent, 'absent'), authorityRetryDelayMs: 0,
    notice: (message: string) => { notices.push(message); },
    runWrangler: (args: string[]) => {
      if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'version-amber', percentage: 100 }] }) };
      if (args[0] === 'd1') return { status: 0, stdout: JSON.stringify([{ success: true, results: [{ name: '0002_mcp_oauth.sql' }] }]) };
      return { status: 0, stdout: JSON.stringify({ migrations: [{ tag: 'v9' }], resources: { bindings: [
        { name: 'AUTH_DB', type: 'd1', id: 'd1-amber' },
        { name: 'TAG_STATE', type: 'durable_object_namespace', class_name: 'TagStateStore', namespace_id: 'tag-amber' },
        { name: 'CHICKPEA_ENV_TARGET', type: 'plain_text', text: 'amber' },
      ] } }) };
    },
    fetchImpl: async (url: URL, init: RequestInit) => {
      requested.push(url.href);
      const target = url.hostname.split('.')[0]!;
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token(target)}`);
      if (down.has(target)) return new Response('{}', { status: 503 });
      return Response.json(gatewayRuntime[target]);
    },
  };
  const request = { target: 'amber', claim, registration, phase: 'before' };
  const observed = await observeProductionEnvironmentAuthority(request, options);
  assert.equal(observed.slack.teamId, 'T_AMBER');
  assert.deepEqual(observed.fleetCredentialFingerprints.cobalt, fingerprints('cobalt'));
  assert.deepEqual([...requested].sort(), [
    'https://amber.test/internal/environment/authority',
    'https://cobalt.test/internal/environment/authority',
  ]);
  assert.deepEqual(notices, []);
  // A host variable still wins over the recorded origin.
  requested.length = 0;
  await observeProductionEnvironmentAuthority(request, {
    ...options, env: { ...env, CHICKPEA_ENV_COBALT_LIVE_AUTHORITY_URL: 'https://cobalt.test/internal/environment/authority?via=env' },
  });
  assert.ok(requested.includes('https://cobalt.test/internal/environment/authority?via=env'));
  // The other host's lane keeps no baseline here, so nothing can stand in for
  // it while it is unreachable; the refusal names the lane and why.
  down = new Set(['cobalt']);
  await assert.rejects(observeProductionEnvironmentAuthority(request, options), (error: unknown) =>
    rejects('LIVE_AUTHORITY_BRIDGE_UNAVAILABLE')(error)
    && (error as { details?: { target?: string; ownership?: string } }).details?.target === 'cobalt'
    && (error as { details?: { ownership?: string } }).details?.ownership === 'remote');
  assert.deepEqual(notices, []);
  down = new Set();
  // The record supplies a URL, never a token.
  const { CHICKPEA_ENV_COBALT_LIVE_AUTHORITY_READ_TOKEN: _dropped, ...withoutCobaltToken } = env;
  void _dropped;
  await assert.rejects(observeProductionEnvironmentAuthority(request, { ...options, env: withoutCobaltToken }), (error: unknown) =>
    rejects('LIVE_AUTHORITY_READ_TOKEN_INVALID')(error) && (error as { details?: { target?: string } }).details?.target === 'cobalt');
  releaseEnvironment('amber', cloud);
});
