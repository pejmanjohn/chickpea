import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { assertLiveEnvironmentClaim, claimEnvironment, migrateEnvironmentProviderAuthConfigs, readEnvironmentRegistry, reclaimEnvironment, releaseEnvironment } from '../scripts/lib/environment-registry.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { assertEnvironmentReleaseAllowed, beginEnvironmentDeployment, completeEnvironmentDeployment, environmentDeployReceiptPath, observeProductionEnvironmentAuthority, preflightEnvironmentMutation, reconcileEnvironmentDeployment, resumeEnvironmentDeployment, writeEnvironmentBaseline, writeEnvironmentSchemaAdvancementIntent, withEnvironmentReleaseFence } from '../scripts/lib/environment-preflight.mjs';
import { readTargetLock } from '../qa/live/safety/lock.ts';
import { NOW, DEAD_PID, TARGETS, fixture, fingerprints, baseline, localContract, OTHER_INSTALL_DIGEST, FLOW_DIGEST, OTHER_FLOW_DIGEST, OTHER_COMBINED_DIGEST, splitBaseline, splitLocalContract, optionalListsLocalContract, authority, RUNTIME_SECRET_SOURCE_BINDINGS, runtimeAuthorities, rejects, makeMutationLockStale, runNodeModule } from './environment-preflight.fixture.ts';

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
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify({ mode, results }));
    assert.equal(results.filter((result) => result.code === 'TARGET_LOCK_LIVE').length, 1, JSON.stringify({ mode, results }));
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

test('v1 deployment recovery retains the old schema until a fenced release and explicit migration', async (context) => {
  for (const completed of [false, true]) {
    const f = fixture();
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    claimEnvironment('amber', f.options);
    const preflight = await preflightEnvironmentMutation('amber', {
      ...f.options, baseline: baseline(), localContract: localContract(),
      observeAuthority: async () => authority(),
    });
    beginEnvironmentDeployment(preflight, { ...f.options, localContract: localContract() });
    makeMutationLockStale(f.records[0]!.evidenceRoot);
    const snapshots = readdirSync(join(f.root, 'revisions')).map((name) => join(f.root, 'revisions', name));
    const oldSnapshots = new Map<string, string>();
    for (const file of [...snapshots, join(f.root, 'registry.json')]) {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      state.schemaVersion = 'chickpea-environment-registry/v1';
      for (const target of TARGETS) {
        state.targets[target].providerReadOnlyAuthConfigId = state.targets[target].providerAuthConfigId;
        delete state.targets[target].providerAuthConfigId;
      }
      const bytes = JSON.stringify(state);
      writeFileSync(file, bytes);
      if (file !== join(f.root, 'registry.json')) oldSnapshots.set(file, bytes);
    }
    // New deploys still refuse v1 even if a caller supplies the recovery option.
    await assert.rejects(preflightEnvironmentMutation('amber', {
      ...f.options, allowLegacyRegistryRecovery: true,
    }), { code: 'PROVIDER_AUTH_CONFIG_MIGRATION_REQUIRED' });
    const result = await reconcileEnvironmentDeployment('amber', {
      ...f.options, localContract: localContract(),
      observeAuthority: async () => authority('amber', completed ? {
        activeVersion: 'version-recovered', deploymentMetadata: preflight.deploymentMetadata,
      } : {}),
    });
    assert.equal(completed ? result.activeVersion : result.aborted, completed ? 'version-recovered' : true);
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'target.lock')), false);
    assert.equal(existsSync(join(f.records[0]!.evidenceRoot, 'deploy-intent.json')), false);
    withEnvironmentReleaseFence('amber', f.options, (fence: { runId: string }) => releaseEnvironment('amber', {
      ...f.options, expectedTargetLockRunId: fence.runId,
    }));
    const released = JSON.parse(readFileSync(join(f.root, 'registry.json'), 'utf8'));
    assert.equal(released.schemaVersion, 'chickpea-environment-registry/v1');
    assert.equal(released.targets.amber.claim, null);
    for (const [file, bytes] of oldSnapshots) assert.equal(readFileSync(file, 'utf8'), bytes);
    migrateEnvironmentProviderAuthConfigs({
      expectedRegistryRevision: released.revision,
      targets: TARGETS.map((target) => ({ target, providerProjectId: `provider-${target}`,
        previousAuthConfigId: `provider-read-${target}`, providerAuthConfigId: `provider-standard-${target}` })),
    }, f.options);
    assert.equal(readEnvironmentRegistry(f.options).schemaVersion, 'chickpea-environment-registry/v2');
  }
});

test('reconciliation clears a safe post-release v1 lock without recreating a claim', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  let abandonedOwner;
  const lockPath = join(f.records[0]!.evidenceRoot, 'target.lock');
  withEnvironmentReleaseFence('amber', f.options, (fence: { runId: string }) => {
    releaseEnvironment('amber', { ...f.options, expectedTargetLockRunId: fence.runId });
    abandonedOwner = { ...readTargetLock(lockPath), pid: DEAD_PID };
  });
  // Exact durable state after a process dies between claim release and fence unlink.
  writeFileSync(lockPath, JSON.stringify(abandonedOwner), { mode: 0o600 });
  for (const file of [
    ...readdirSync(join(f.root, 'revisions')).map((name) => join(f.root, 'revisions', name)),
    join(f.root, 'registry.json'),
  ]) {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.schemaVersion = 'chickpea-environment-registry/v1';
    for (const target of TARGETS) {
      state.targets[target].providerReadOnlyAuthConfigId = state.targets[target].providerAuthConfigId;
      delete state.targets[target].providerAuthConfigId;
    }
    writeFileSync(file, JSON.stringify(state));
  }
  assert.equal(await reconcileEnvironmentDeployment('amber', f.options), null);
  assert.equal(existsSync(lockPath), false);
  const recovered = JSON.parse(readFileSync(join(f.root, 'registry.json'), 'utf8'));
  assert.equal(recovered.targets.amber.claim, null);
  assert.equal(recovered.schemaVersion, 'chickpea-environment-registry/v1');
  migrateEnvironmentProviderAuthConfigs({
    expectedRegistryRevision: recovered.revision,
    targets: TARGETS.map((target) => ({ target, providerProjectId: `provider-${target}`,
      previousAuthConfigId: `provider-read-${target}`, providerAuthConfigId: `provider-standard-${target}` })),
  }, f.options);
  assert.equal(readEnvironmentRegistry(f.options).schemaVersion, 'chickpea-environment-registry/v2');
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

test('a core-only lane admits only the exact whole-manifest optional Lists projection', async (context) => {
  const f = fixture({ baseline: splitBaseline() });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const contract = optionalListsLocalContract({
    setupContractDigest: OTHER_COMBINED_DIGEST,
    setupFlowDigest: OTHER_FLOW_DIGEST,
  });
  const preflight = await preflightEnvironmentMutation('amber', {
    ...f.options,
    baseline: splitBaseline(),
    localContract: contract,
    observeAuthority: async () => authority(),
  });
  assert.equal(preflight.deploymentMetadata.manifestDigest, baseline().manifestDigest);
  assert.deepEqual(preflight.baseline.requiredScopes, ['chat:write']);
  assert.deepEqual(preflight.setupFlow, {
    proven: false, baselineDigest: FLOW_DIGEST, localDigest: OTHER_FLOW_DIGEST,
  });

  const mutationLease = beginEnvironmentDeployment(preflight, {
    ...f.options, localContract: contract,
  });
  const receipt = await completeEnvironmentDeployment(preflight, {
    ...f.options,
    deployedVersion: 'version-next',
    mutationLease,
    observeAuthority: async () => authority('amber', {
      activeVersion: 'version-next', deploymentMetadata: preflight.deploymentMetadata,
    }),
  });
  assert.equal(receipt.manifestDigest, baseline().manifestDigest);
  assert.equal(receipt.setupFlowUnprovenSince, f.revision);
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.setupFlowUnprovenSince, f.revision);
});

test('optional Lists compatibility rejects cross-pairs, other manifest changes, and scope drift', async (context) => {
  const cases = [
    {
      name: 'full manifest with core-only baseline scopes',
      baseline: splitBaseline({ manifestDigest: `sha256:${'3'.repeat(64)}` }),
      local: optionalListsLocalContract(),
    },
    {
      name: 'stripped manifest with full baseline scopes',
      baseline: splitBaseline({ requiredScopes: ['chat:write', 'lists:read', 'lists:write'] }),
      local: optionalListsLocalContract(),
    },
    {
      name: 'unrelated whole-manifest change',
      baseline: splitBaseline(),
      local: optionalListsLocalContract({
        existingInstallManifestDigest: `sha256:${'4'.repeat(64)}`,
      }),
    },
    {
      name: 'unknown requested scope',
      baseline: splitBaseline(),
      local: optionalListsLocalContract({
        requiredScopes: ['chat:write', 'lists:read', 'lists:write', 'unknown:scope'],
        existingInstallScopes: ['chat:write', 'unknown:scope'],
      }),
    },
    {
      name: 'baseline missing a core scope',
      baseline: splitBaseline({ requiredScopes: ['channels:read'] }),
      local: optionalListsLocalContract(),
    },
    {
      name: 'changed install capability',
      baseline: splitBaseline(),
      local: optionalListsLocalContract({ installContractDigest: OTHER_INSTALL_DIGEST }),
    },
  ];
  for (const entry of cases) {
    const f = fixture({ baseline: entry.baseline });
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    claimEnvironment('amber', f.options);
    await assert.rejects(preflightEnvironmentMutation('amber', {
      ...f.options,
      baseline: entry.baseline,
      localContract: entry.local,
      observeAuthority: async () => authority('amber', {
        scopes: entry.baseline.requiredScopes,
      }),
    }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'INSTALL_CONTINUATION_REQUIRED', entry.name);
      return true;
    });
  }
});

test('optional Lists compatibility preserves exact full grants and exact live authority checks', async (context) => {
  const fullBaseline = splitBaseline({
    manifestDigest: `sha256:${'3'.repeat(64)}`,
    requiredScopes: ['chat:write', 'lists:read', 'lists:write'],
  });
  const f = fixture({ baseline: fullBaseline });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  await preflightEnvironmentMutation('amber', {
    ...f.options,
    baseline: fullBaseline,
    localContract: optionalListsLocalContract(),
    observeAuthority: async () => authority('amber', {
      slack: { ...authority().slack, scopes: fullBaseline.requiredScopes },
    }),
  });
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options,
    baseline: splitBaseline(),
    localContract: optionalListsLocalContract(),
    observeAuthority: async () => authority('amber', {
      slack: { ...authority().slack, scopes: fullBaseline.requiredScopes },
    }),
  }), rejects('SLACK_SCOPE_MISMATCH'));
});

test('legacy supplied local contracts retain exact matching behavior and partial projections fail closed', async (context) => {
  const f = fixture({ baseline: splitBaseline() });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const legacyContract = splitLocalContract() as Record<string, unknown>;
  delete legacyContract.existingInstallManifestDigest;
  delete legacyContract.existingInstallScopes;
  await preflightEnvironmentMutation('amber', {
    ...f.options,
    baseline: splitBaseline(),
    localContract: legacyContract,
    observeAuthority: async () => authority(),
  });

  const partialContract = splitLocalContract() as Record<string, unknown>;
  delete partialContract.existingInstallScopes;
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...f.options,
    baseline: splitBaseline(),
    localContract: partialContract,
    observeAuthority: async () => authority(),
  }), rejects('INVALID_LOCAL_CONTRACT'));
});

test('optional Lists compatibility is rechecked consistently on resume and reconciliation', async (context) => {
  for (const mode of ['resume', 'reconcile'] as const) {
    const f = fixture({ baseline: splitBaseline() });
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    claimEnvironment('amber', f.options);
    const contract = optionalListsLocalContract(mode === 'resume'
      ? { schemaGeneration: 'd1:0003_reviewed;do:v10' }
      : {});
    if (mode === 'resume') {
      writeEnvironmentSchemaAdvancementIntent('amber', contract.schemaGeneration, {
        ...f.options, localContract: contract,
      });
    }
    const preflight = await preflightEnvironmentMutation('amber', {
      ...f.options,
      baseline: splitBaseline(),
      localContract: contract,
      observeAuthority: async () => authority(),
    });
    beginEnvironmentDeployment(preflight, {
      ...f.options, localContract: contract,
    });
    makeMutationLockStale(f.records[0]!.evidenceRoot);

    if (mode === 'resume') {
      const resumed = await resumeEnvironmentDeployment('amber', {
        ...f.options,
        localContract: contract,
        observeAuthority: async () => authority('amber', {
          schemaGeneration: contract.schemaGeneration,
        }),
      });
      assert.equal(
        resumed.preflight.deploymentMetadata.manifestDigest,
        baseline().manifestDigest,
      );
      await completeEnvironmentDeployment(resumed.preflight, {
        ...f.options,
        deployedVersion: 'version-optional-resumed',
        mutationLease: resumed.mutationLease,
        observeAuthority: async () => authority('amber', {
          activeVersion: 'version-optional-resumed',
          schemaGeneration: contract.schemaGeneration,
          deploymentMetadata: resumed.preflight.deploymentMetadata,
        }),
      });
    } else {
      const receipt = await reconcileEnvironmentDeployment('amber', {
        ...f.options,
        localContract: contract,
        observeAuthority: async () => authority('amber', {
          activeVersion: 'version-optional-reconciled',
          deploymentMetadata: preflight.deploymentMetadata,
        }),
      });
      assert.equal(receipt.manifestDigest, baseline().manifestDigest);
    }
  }
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
      workerName: 'chickpea-amber-live', transport,
      authDatabaseName: 'chickpea-auth-db-amber-live', authDatabaseId: 'd1-amber',
      schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
      bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber-live:TagStateStore' },
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
          { name: 'CHICKPEA_ENV_TAG_STATE_ID', type: 'plain_text', text: 'chickpea-amber-live:TagStateStore' },
          { name: 'CHICKPEA_ENV_SCHEMA_GENERATION', type: 'plain_text', text: 'd1:0002_mcp_oauth;do:v9' },
          { name: 'CHICKPEA_ENV_TARGET', type: 'plain_text', text: 'amber' },
          { name: 'CHICKPEA_ENV_SOURCE_REVISION', type: 'plain_text', text: '1234567' },
          { name: 'CHICKPEA_ENV_SOURCE_DIRTY', type: 'plain_text', text: 'false' },
          { name: 'CHICKPEA_ENV_CLAIM_NONCE', type: 'plain_text', text: '00000000-0000-4000-8000-000000000000' },
          { name: 'CHICKPEA_ENV_REGISTRY_REVISION', type: 'plain_text', text: '1' },
          { name: 'CHICKPEA_ENV_WORKER', type: 'plain_text', text: 'chickpea-amber-live' },
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
    'deployments status --json --name chickpea-amber-live',
    'versions view version-amber --json --name chickpea-amber-live',
    'd1 execute chickpea-auth-db-amber-live --remote --json --command SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    ...(transport === 'events' ? ['https://slack.com/api/auth.test'] : []),
  ]);
  // Real Workers version responses expose no migrations array. Read the
  // service metadata with Wrangler's selected credential and bind it to the
  // exact version's script etag before trusting its migration tag.
  let serviceEtag = 'serving-script-etag';
  let serviceTag: string | undefined = 'v9';
  const providerOptions = {
    ...options,
    env: { ...options.env, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) },
    providerContext: ['--profile', 'lane-owner'],
    runWrangler: (args: string[]) => {
      if (args[0] === 'auth') {
        assert.deepEqual(args, ['auth', 'token', '--json', '--profile', 'lane-owner']);
        return { status: 0, stdout: JSON.stringify({ type: 'oauth', token: 'test-provider-read-token' }) };
      }
      const result = options.runWrangler(args);
      if (args[0] !== 'versions') return result;
      const view = JSON.parse(result.stdout);
      delete view.migrations;
      view.resources.script = { etag: 'serving-script-etag' };
      return { ...result, stdout: JSON.stringify(view) };
    },
    fetchImpl: async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith('https://api.cloudflare.com/')) return options.fetchImpl(String(url));
      assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/services/chickpea-amber-live`);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-provider-read-token');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      return Response.json({ success: true, result: { id: 'chickpea-amber-live',
        default_environment: { script: { etag: serviceEtag, migration_tag: serviceTag } } } });
    },
  };
  assert.equal((await observeProductionEnvironmentAuthority(context, providerOptions)).schemaGeneration, 'd1:0002_mcp_oauth;do:v9');
  serviceEtag = 'different-script';
  await assert.rejects(observeProductionEnvironmentAuthority(context, providerOptions), rejects('DURABLE_OBJECT_AUTHORITY_MISMATCH'));
  // A rollback changes active traffic without changing the service's latest
  // upload. Corroborate the selected version against current namespace state.
  let versionTag: unknown = 'v9';
  const rolledBackOptions = {
    ...providerOptions,
    runWrangler: (args: string[]) => {
      const result = providerOptions.runWrangler(args);
      if (args[0] !== 'versions') return result;
      const view = JSON.parse(result.stdout);
      view.resources.script_runtime = { migration_tag: versionTag };
      return { ...result, stdout: JSON.stringify(view) };
    },
  };
  assert.equal((await observeProductionEnvironmentAuthority(context, rolledBackOptions)).schemaGeneration,
    'd1:0002_mcp_oauth;do:v9');
  for (const invalid of [{}, 9, '', 'v8']) {
    versionTag = invalid;
    await assert.rejects(observeProductionEnvironmentAuthority(context, rolledBackOptions),
      rejects('DURABLE_OBJECT_AUTHORITY_MISMATCH'));
  }
  serviceEtag = 'serving-script-etag';
  versionTag = 'v8';
  await assert.rejects(observeProductionEnvironmentAuthority(context, rolledBackOptions),
    rejects('DURABLE_OBJECT_AUTHORITY_MISMATCH'));
  versionTag = 'v9';
  assert.equal((await observeProductionEnvironmentAuthority(context, rolledBackOptions)).schemaGeneration,
    'd1:0002_mcp_oauth;do:v9');
  // Even if provider version metadata reflected live namespace state, an
  // older version's immutable deployment stamp still refuses schema rollback.
  await assert.rejects(observeProductionEnvironmentAuthority(context, {
    ...rolledBackOptions,
    runWrangler: (args: string[]) => {
      const result = rolledBackOptions.runWrangler(args);
      if (args[0] !== 'versions') return result;
      const view = JSON.parse(result.stdout);
      view.resources.bindings.find((binding: { name: string }) =>
        binding.name === 'CHICKPEA_ENV_SCHEMA_GENERATION').text = 'd1:0002_mcp_oauth;do:v8';
      return { ...result, stdout: JSON.stringify(view) };
    },
  }), rejects('INCOMPATIBLE_SCHEMA_GENERATION'));
  serviceTag = undefined;
  await assert.rejects(observeProductionEnvironmentAuthority(context, providerOptions), rejects('DURABLE_OBJECT_AUTHORITY_MISMATCH'));

  // A registered installation predates its first claim stamp. It can enter
  // the ordinary deployment protocol, but never attest or excuse partial
  // metadata, a changed version, or a previously published deploy receipt.
  const fresh = fixture({ transport: transport as 'events' | 'gateway' });
  try {
    claimEnvironment('amber', fresh.options);
    serviceTag = 'v9';
    let bootstrapNow = NOW;
    let extraStamp: { name: string; type: string; text: string } | undefined;
    let servingVersion = 'version-amber';
    const bootstrapOptions = {
      ...providerOptions, ...fresh.options, localContract: localContract(),
      now: () => bootstrapNow,
      readFleetRuntimeAuthorities: async () => Object.fromEntries(Object.entries(
        transport === 'gateway' ? gatewayRuntime : runtime,
      ).map(([target, value]) => [target, {
        ...value, observedAt: new Date(bootstrapNow).toISOString(),
      }])),
      allowTestAuthorityObserver: false,
      runWrangler: (args: string[]) => {
        const result = providerOptions.runWrangler(args);
        if (args[0] === 'deployments') return { status: 0,
          stdout: JSON.stringify({ versions: [{ version_id: servingVersion, percentage: 100 }] }) };
        if (args[0] !== 'versions') return result;
        const view = JSON.parse(result.stdout);
        view.resources.bindings = view.resources.bindings.filter((binding: { name: string }) =>
          !binding.name.startsWith('CHICKPEA_ENV_') || binding.name === 'CHICKPEA_ENV_TARGET');
        view.resources.bindings.find((binding: { name: string }) => binding.name === 'TAG_STATE').namespace_id = 'tag-amber';
        if (extraStamp) view.resources.bindings.push(extraStamp);
        return { status: 0, stdout: JSON.stringify(view) };
      },
    };
    const claimContext = assertLiveEnvironmentClaim('amber', fresh.options);
    const freshContext = { target: 'amber', claim: claimContext.claim,
      registration: claimContext.registration, phase: 'before' };
    const initial = await preflightEnvironmentMutation('amber', bootstrapOptions);
    assert.equal(initial.registration.servingVersion, 'version-amber');
    assert.equal((await observeProductionEnvironmentAuthority(freshContext, bootstrapOptions)).deploymentMetadata, null);
    for (const phase of ['after', 'attest']) {
      await assert.rejects(observeProductionEnvironmentAuthority({ ...freshContext, phase }, bootstrapOptions), rejects('WORKER_METADATA_MISMATCH'));
    }
    extraStamp = { name: 'CHICKPEA_ENV_CLAIM_NONCE', type: 'plain_text', text: claimContext.claim.leaseNonce };
    await assert.rejects(preflightEnvironmentMutation('amber', bootstrapOptions), rejects('WORKER_METADATA_MISMATCH'));
    extraStamp = undefined;
    servingVersion = 'version-other';
    await assert.rejects(preflightEnvironmentMutation('amber', bootstrapOptions), rejects('WORKER_METADATA_MISMATCH'));
    servingVersion = 'version-amber';
    const receiptPath = environmentDeployReceiptPath(fresh.records[0]!.evidenceRoot);
    writeFileSync(receiptPath, '{}', { mode: 0o600 });
    await assert.rejects(preflightEnvironmentMutation('amber', bootstrapOptions), rejects('WORKER_METADATA_MISMATCH'));
    rmSync(receiptPath);

    // A crash before provider deployment must still reconcile the unchanged,
    // unstamped predecessor and release only the original mutation lease.
    const lease = beginEnvironmentDeployment(initial, bootstrapOptions);
    await assert.rejects(preflightEnvironmentMutation('amber', bootstrapOptions));
    bootstrapNow = Date.parse(claimContext.claim.expiresAt) + 1;
    const recovered = await reconcileEnvironmentDeployment('amber', {
      ...bootstrapOptions, isPidActive: () => false,
    });
    assert.equal(recovered.aborted, true);
    assert.equal(existsSync(lease.lockPath), false);
    assert.equal(existsSync(receiptPath), false);
    await assert.rejects(preflightEnvironmentMutation('amber', bootstrapOptions), { code: 'CLAIM_EXPIRED_RECLAIM_REQUIRED' });
    reclaimEnvironment('amber', bootstrapOptions);
    assert.equal((await preflightEnvironmentMutation('amber', bootstrapOptions)).registration.servingVersion, 'version-amber');
  } finally {
    rmSync(fresh.parent, { recursive: true, force: true });
  }
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
    let down = new Set<string>();
    const notices: string[] = [];
    // The real reader resolves the fleet from the registry; use a fixture so
    // the operator's own lane registrations never leak into the test.
    const fleet = fixture({ transport });
    const realBridgeOptions = { ...options, env: bridgeEnv, readFleetRuntimeAuthorities: undefined,
      root: fleet.root, hostFingerprint: 'host-fixture', authorityRetryDelayMs: 0,
      notice: (message: string) => { notices.push(message); },
      fetchImpl: async (url: URL, init: RequestInit) => {
        bridgeCalls += 1;
        const target = url.hostname.split('.')[0]!;
        if (down.has(target)) return new Response('{}', { status: 503 });
        assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${Buffer.alloc(32, target.charCodeAt(0)).toString('base64url')}`);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal);
        return oversized ? new Response('x'.repeat(65_537)) : Response.json(gatewayRuntime[target]);
      },
    };
    assert.equal((await observeProductionEnvironmentAuthority(context, realBridgeOptions)).slack.teamId, 'T_AMBER');
    assert.deepEqual(notices, []);
    // Another lane that is mid-deploy answers 503. It is retried once, then its
    // recorded fingerprints stand in; the deploy target must always answer.
    const sibling = TARGETS.find((lane) => lane !== 'amber')!;
    writeEnvironmentBaseline(fleet.records.find((record) => record.target === sibling)!.evidenceRoot, baseline(sibling));
    down = new Set([sibling]);
    bridgeCalls = 0;
    const withSiblingDown = await observeProductionEnvironmentAuthority(context, realBridgeOptions);
    assert.deepEqual(withSiblingDown.fleetCredentialFingerprints[sibling], fingerprints(sibling));
    assert.equal(bridgeCalls, TARGETS.length + 1, 'the unavailable lane is retried once');
    assert.match(notices.join('\n'), new RegExp(`Lane ${sibling} authority is unavailable`));
    down = new Set(['amber']);
    await assert.rejects(observeProductionEnvironmentAuthority(context, realBridgeOptions), rejects('LIVE_AUTHORITY_BRIDGE_UNAVAILABLE'));
    down = new Set();
    const tokenName = 'CHICKPEA_ENV_AMBER_LIVE_AUTHORITY_READ_TOKEN';
    const validToken = bridgeEnv[tokenName]!;
    bridgeEnv[tokenName] = 'a'.repeat(64);
    bridgeCalls = 0;
    await assert.rejects(observeProductionEnvironmentAuthority(context, realBridgeOptions), rejects('LIVE_AUTHORITY_READ_TOKEN_INVALID'));
    assert.equal(bridgeCalls, 0);
    bridgeEnv[tokenName] = validToken;
    oversized = true;
    await assert.rejects(observeProductionEnvironmentAuthority(context, realBridgeOptions), rejects('LIVE_AUTHORITY_BRIDGE_UNAVAILABLE'));
    rmSync(fleet.parent, { recursive: true, force: true });
  }
});

test('Cloudflare authority forwards the exact resolved profile and environment to every read', async () => {
  const calls: string[][] = [];
  await assert.rejects(observeProductionEnvironmentAuthority({
    target: 'amber', registration: {
      workerName: 'chickpea-amber-live', transport: 'events',
      authDatabaseName: 'chickpea-auth-db-amber-live', authDatabaseId: 'd1-amber',
      schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
      bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'chickpea-amber-live:TagStateStore' },
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
