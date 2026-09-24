import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { claimEnvironment, environmentMarkerPath, readEnvironmentRegistry, withEnvironmentInstallationClaim, reclaimEnvironment, recordEnvironmentInstallation, recordEnvironmentAttestation, releaseEnvironment } from '../scripts/lib/environment-registry.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { adoptEnvironmentFromFile, beginEnvironmentDeployment, completeEnvironmentDeployment, environmentDeployReceiptPath, preflightEnvironmentMutation, readEnvironmentDeployReceipt, reconcileEnvironmentDeployment, recheckEnvironmentMutationAuthority, resumeEnvironmentDeployment, writeEnvironmentBaseline, writeEnvironmentSchemaAdvancementIntent, withEnvironmentReleaseFence } from '../scripts/lib/environment-preflight.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { reserveEnvironmentInstallation, restoreEnvironmentInstallation, assertInstallationDeployment, assertInstallationNodeRuntime } from '../scripts/lib/environment-installation.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { nodeInstallationEnvironment, nodeInstallationProcessPath, reconcileNodeInstallationProcess, runNodeInstallation } from '../scripts/lib/environment-installation-node.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { waitForEnvironmentClaim } from '../scripts/lib/environment-wait.mjs';
// @ts-expect-error Executable environment modules intentionally have no declarations.
import { runEnvironmentCli } from '../scripts/chickpea-environment.mjs';
import { NOW, DEAD_PID, git, fixture, fingerprints, baseline, localContract, authority, RUNTIME_SECRET_SOURCE_BINDINGS, rejects, installationDatabaseReceipt, nodeInstallationFixture, makeMutationLockStale } from './environment-preflight.fixture.ts';

test('borrowed installation retains its lane across expiry and refuses release until live restoration and exact cleanup', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const claim = claimEnvironment('amber', f.options);
  const installer = join(f.parent, 'installer');
  mkdirSync(installer);
  const before = { slack: { workspace: 'T_AMBER' }, admin: { owner: 'test-owner' },
    fixtures: { agent: 'smoke-amber' }, pendingWork: false, independentAppsResolved: true };
  const beforePath = join(f.parent, 'before.json');
  writeFileSync(beforePath, JSON.stringify(before), { mode: 0o600 });
  const spec = { runId: 'install-test', workerName: 'fresh-worker', authDatabaseName: 'fresh-auth',
    authDatabaseId: 'fresh-d1', installerPath: installer, beforeEvidence: beforePath,
    databaseCreationReceipt: installationDatabaseReceipt(f.parent, 'amber', f.options) };
  const specPath = join(f.parent, 'installation.json');
  writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  const options = { ...f.options, localContract: localContract(), observeAuthority: async () => authority() };
  writeFileSync(specPath, JSON.stringify({ ...spec, authDatabaseId: 'unrelated-d1' }));
  await assert.rejects(reserveEnvironmentInstallation('amber', specPath, options), { code: 'INSTALLATION_DATABASE_OWNERSHIP_REQUIRED' });
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.installation, undefined);
  writeFileSync(specPath, JSON.stringify(spec));
  let currentTime = NOW;
  await assert.rejects(reserveEnvironmentInstallation('amber', specPath, {
    ...options, now: () => currentTime,
    observeAuthority: async () => { currentTime = Date.parse(claim.expiresAt) + 1; return authority(); },
  }), { code: 'CLAIM_EXPIRED_RECLAIM_REQUIRED' });
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.installation, undefined);
  await reserveEnvironmentInstallation('amber', specPath, options);
  const saved = readEnvironmentRegistry(f.options).targets.amber;
  assert.equal(saved.workerName, 'chickpea-amber-live');
  assert.equal(saved.authDatabaseId, 'd1-amber');
  assert.equal(saved.installation.runId, 'install-test');
  assert.throws(() => releaseEnvironment('amber', f.options), { code: 'INSTALLATION_RESTORATION_REQUIRED' });
  await assert.rejects(preflightEnvironmentMutation('amber', options), { code: 'INSTALLATION_RESTORATION_REQUIRED' });
  assert.throws(() => assertInstallationDeployment('amber', installer, { ...spec, authDatabaseId: 'd1-cobalt' }, f.options),
    { code: 'INSTALLATION_TARGET_MISMATCH' });
  assert.equal(assertInstallationDeployment('amber', installer, spec, f.options).runId, spec.runId);
  assert.throws(() => assertInstallationNodeRuntime('amber', f.options), { code: 'INSTALLATION_RUNTIME_MISMATCH' });
  const later = { ...options, now: () => Date.parse(claim.expiresAt) + 1 };
  reclaimEnvironment('amber', later);
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.installation.runId, spec.runId);
  assert.equal(assertInstallationDeployment('amber', installer, spec, later).runId, spec.runId);
  assert.throws(() => releaseEnvironment('amber', later), { code: 'INSTALLATION_RESTORATION_REQUIRED' });
  const receiptPath = join(f.parent, 'restore.json');
  const receipt = { runId: spec.runId, restored: before, temporary: { workerName: spec.workerName,
    authDatabaseId: spec.authDatabaseId, workerPresent: true, databasePresent: false },
    slackEvidence: beforePath, adminEvidence: beforePath, cleanupEvidence: beforePath };
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  await assert.rejects(restoreEnvironmentInstallation('amber', receiptPath, later), { code: 'INSTALLATION_RESTORATION_UNPROVEN' });
  receipt.temporary.workerPresent = false;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  await assert.rejects(restoreEnvironmentInstallation('amber', receiptPath, {
    ...later, observeAuthority: async () => authority('amber', { slack: { ...authority().slack, teamId: 'T_OTHER' } }),
  }), { code: 'SLACK_TEAM_MISMATCH' });
  assert.ok(readEnvironmentRegistry(f.options).targets.amber.installation);
  await restoreEnvironmentInstallation('amber', receiptPath, later);
  // Older private registries have no runtime discriminator. Keep their guarded
  // deployment and restoration usable without rewriting the reservation.
  const legacy = { ...saved.installation };
  delete legacy.runtime;
  recordEnvironmentInstallation('amber', legacy, readEnvironmentRegistry(later).revision, later);
  assert.equal(assertInstallationDeployment('amber', installer, spec, later).runtime, undefined);
  await restoreEnvironmentInstallation('amber', receiptPath, later);
  releaseEnvironment('amber', later);
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.claim, null);
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.authDatabaseId, 'd1-amber');
});

test('a free lane supports a Node install, restart, expiry/reclaim and verified restoration without a temporary Worker or D1', async (context) => {
  const f = nodeInstallationFixture(context);
  // Exercise the real any-lane selector rather than permanently designating an installation lane.
  const acquired = await waitForEnvironmentClaim('any', { ...f.options, timeoutMs: 0, pollMs: 250 });
  assert.equal(acquired.target, 'amber');
  const result = await reserveEnvironmentInstallation('amber', f.specPath, f.options);
  const installation = result.installation;
  assert.equal(installation.runtime, 'node');
  assert.equal(installation.workerName, undefined);
  assert.equal(installation.databaseCreationReceipt, undefined);
  assert.deepEqual(readdirSync(installation.statePath), []);
  assert.equal(lstatSync(installation.statePath).mode & 0o777, 0o700);
  assert.throws(() => assertInstallationDeployment('amber', f.installer, undefined, f.options), { code: 'INSTALLATION_RUNTIME_MISMATCH' });
  const unrelated = join(f.parent, 'standing-local.sqlite');
  writeFileSync(unrelated, 'preserve standing local state');
  const withClaim = (start: (installation: any) => void) => withEnvironmentInstallationClaim('amber', f.options, start);
  writeFileSync(join(f.installer, 'dist', 'server.mjs'), `
    import { DatabaseSync } from 'node:sqlite';
    import { writeFileSync } from 'node:fs';
    for (const key of ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH']) {
      const db = new DatabaseSync(process.env[key]);
      db.exec('CREATE TABLE IF NOT EXISTS runs (value TEXT); INSERT INTO runs VALUES ("started");'.replaceAll('"', "'"));
      db.close();
    }
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH, '{}');
  `);
  assert.deepEqual(await runNodeInstallation(installation, f.envPath, withClaim), { code: 0, signal: null });
  assert.deepEqual(await runNodeInstallation(installation, f.envPath, withClaim), { code: 0, signal: null });
  assert.equal(readFileSync(unrelated, 'utf8'), 'preserve standing local state');
  assert.equal(existsSync(nodeInstallationProcessPath(installation)), false);
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.authDatabaseId, 'd1-amber');
  const env = nodeInstallationEnvironment(installation);
  for (const file of Object.values(env) as string[]) assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.throws(() => releaseEnvironment('amber', f.options), { code: 'INSTALLATION_RESTORATION_REQUIRED' });
  await assert.rejects(preflightEnvironmentMutation('amber', f.options), { code: 'INSTALLATION_RESTORATION_REQUIRED' });
  const later = { ...f.options, now: () => Date.parse(acquired.claim.expiresAt) + 1 };
  assert.throws(() => assertInstallationNodeRuntime('amber', later), { code: 'CLAIM_EXPIRED_RECLAIM_REQUIRED' });
  reclaimEnvironment('amber', later);
  assert.equal(assertInstallationNodeRuntime('amber', later).statePath, installation.statePath);
  const receiptPath = join(f.parent, 'node-restore.json');
  const receipt = { runId: installation.runId, restored: f.before,
    temporary: { runtime: 'node', statePath: installation.statePath, processPresent: false, statePresent: false },
    slackEvidence: f.beforePath, adminEvidence: f.beforePath, cleanupEvidence: f.beforePath };
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  await assert.rejects(restoreEnvironmentInstallation('amber', receiptPath, later), { code: 'INSTALLATION_LOCAL_STATE_REMAINS' });
  rmSync(installation.statePath, { recursive: true });
  // A process starting during the live readback must still block registry release.
  const processPath = nodeInstallationProcessPath(installation);
  await assert.rejects(restoreEnvironmentInstallation('amber', receiptPath, {
    ...later, observeAuthority: async () => {
      writeFileSync(processPath, JSON.stringify({ runId: installation.runId, launcherPid: process.pid, childPgid: process.pid }), { mode: 0o600 });
      return authority();
    },
  }), { code: 'INSTALLATION_PROCESS_RECONCILIATION_REQUIRED' });
  rmSync(processPath);
  await assert.rejects(restoreEnvironmentInstallation('amber', receiptPath, {
    ...later, observeAuthority: async () => authority('amber', { slack: { ...authority().slack, teamId: 'T_OTHER' } }),
  }), { code: 'SLACK_TEAM_MISMATCH' });
  await restoreEnvironmentInstallation('amber', receiptPath, later);
  releaseEnvironment('amber', later);
  assert.equal(readEnvironmentRegistry(f.options).targets.amber.claim, null);
  assert.equal(readFileSync(unrelated, 'utf8'), 'preserve standing local state');
});

test('Node reservations reject unsafe state, environment redirection, concurrent launch and changed authority', async (context) => {
  const f = nodeInstallationFixture(context);
  claimEnvironment('amber', f.options);
  writeFileSync(f.specPath, JSON.stringify({ ...f.spec, authDatabaseId: 'standing-d1' }));
  await assert.rejects(reserveEnvironmentInstallation('amber', f.specPath, f.options), { code: 'INVALID_INSTALLATION_RUNTIME' });
  writeFileSync(f.specPath, JSON.stringify({ ...f.spec, stateParent: f.worktree }));
  await assert.rejects(reserveEnvironmentInstallation('amber', f.specPath, f.options), /outside Git/);
  writeFileSync(f.specPath, JSON.stringify(f.spec));
  const { installation } = await reserveEnvironmentInstallation('amber', f.specPath, f.options);
  const check = () => assertInstallationNodeRuntime('amber', f.options);
  const withClaim = (start: (installation: any) => void) => withEnvironmentInstallationClaim('amber', f.options, start);
  const entry = join(f.installer, 'dist', 'server.mjs');
  writeFileSync(entry, 'process.exitCode = 0;');
  writeFileSync(f.envPath, JSON.stringify({ TAG_DB_PATH: join(f.parent, 'unrelated.sqlite') }));
  await assert.rejects(runNodeInstallation(installation, f.envPath, withClaim), { code: 'INSTALLATION_STATE_PATH_MISMATCH' });
  writeFileSync(f.envPath, JSON.stringify({ NODE_OPTIONS: '--require=unrelated.js' }));
  await assert.rejects(runNodeInstallation(installation, f.envPath, withClaim), { code: 'INVALID_INSTALLATION_ENVIRONMENT' });
  writeFileSync(f.envPath, '{}');
  const stateEnv = nodeInstallationEnvironment(installation);
  symlinkSync(join(f.parent, 'unrelated.sqlite'), stateEnv.TAG_DB_PATH);
  assert.throws(check, /private, owner-controlled/);
  rmSync(stateEnv.TAG_DB_PATH);
  chmodSync(installation.statePath, 0o755);
  assert.throws(check, /private, owner-controlled/);
  chmodSync(installation.statePath, 0o700);
  const processPath = nodeInstallationProcessPath(installation);
  writeFileSync(processPath, JSON.stringify({ runId: installation.runId, launcherPid: process.pid, childPgid: process.pid }), { mode: 0o600 });
  await assert.rejects(runNodeInstallation(installation, f.envPath, withClaim), { code: 'INSTALLATION_PROCESS_RECONCILIATION_REQUIRED' });
  assert.throws(() => reconcileNodeInstallationProcess(installation), { code: 'INSTALLATION_PROCESS_STILL_RUNNING' });
  writeFileSync(processPath, JSON.stringify({ runId: installation.runId, launcherPid: DEAD_PID, childPgid: null }));
  assert.throws(() => reconcileNodeInstallationProcess(installation), { code: 'INSTALLATION_PROCESS_START_UNRESOLVED' });
  writeFileSync(processPath, JSON.stringify({ runId: installation.runId, launcherPid: DEAD_PID, childPgid: DEAD_PID }));
  assert.equal(reconcileNodeInstallationProcess(installation).reconciled, true);
  await assert.rejects(runNodeInstallation(installation, f.envPath, (start: (value: any) => void) => start({ ...installation, runId: 'replacement' })), { code: 'INSTALLATION_RESERVATION_CHANGED' });
  assert.equal(existsSync(processPath), false);
});

test('a disconnected child keeps the Node reservation blocked until the owned process group has stopped', async (context) => {
  const f = nodeInstallationFixture(context);
  claimEnvironment('amber', f.options);
  const { installation } = await reserveEnvironmentInstallation('amber', f.specPath, f.options);
  const processPath = nodeInstallationProcessPath(installation);
  const readyPath = join(installation.statePath, 'child-ready');
  writeFileSync(join(f.installer, 'dist', 'server.mjs'), `
    import { spawn } from 'node:child_process';
    import { existsSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
    child.unref();
    while (!existsSync(${JSON.stringify(readyPath)})) await setTimeout(10);
  `);
  const moduleUrl = new URL('../scripts/lib/environment-installation-node.mjs', import.meta.url).href;
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runNodeInstallation } from ${JSON.stringify(moduleUrl)};
    const installation = ${JSON.stringify(installation)};
    try { await runNodeInstallation(installation, ${JSON.stringify(f.envPath)}, (start) => start(installation)); }
    catch (error) { process.stderr.write(error.code); process.exitCode = 2; }
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  launcher.stderr.on('data', (value) => { stderr += value; });
  context.after(() => {
    launcher.kill();
    if (existsSync(processPath)) {
      const record = JSON.parse(readFileSync(processPath, 'utf8'));
      try { process.kill(-record.childPgid, 'SIGTERM'); } catch { /* Already stopped. */ }
    }
  });
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture launcher did not finish')), 10000);
    launcher.once('exit', (code) => { clearTimeout(timeout); resolve(code); });
    launcher.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(status, 2, stderr);
  assert.match(stderr, /INSTALLATION_PROCESS_STILL_RUNNING/);
  assert.throws(() => reconcileNodeInstallationProcess(installation), { code: 'INSTALLATION_PROCESS_STILL_RUNNING' });
  const record = JSON.parse(readFileSync(processPath, 'utf8'));
  process.kill(-record.childPgid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  for (;;) {
    try { process.kill(-record.childPgid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
      throw error;
    }
    assert.ok(Date.now() < deadline, 'owned fixture descendants should stop');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(reconcileNodeInstallationProcess(installation).reconciled, true);
  assert.equal(existsSync(processPath), false);
  assert.throws(() => releaseEnvironment('amber', f.options), { code: 'INSTALLATION_RESTORATION_REQUIRED' });
});

test('any-lane selection skips an occupied workspace and Node reservations stay isolated from each other', async (context) => {
  const f = nodeInstallationFixture(context);
  claimEnvironment('amber', f.options);
  const first = (await reserveEnvironmentInstallation('amber', f.specPath, f.options)).installation;
  const holder = join(f.parent, 'other-operator');
  git(f.parent, 'clone', f.worktree, holder);
  const options = { ...f.options, worktreePath: holder, observeAuthority: async () => authority('cobalt') };
  const claim = await waitForEnvironmentClaim('any', { ...options, timeoutMs: 0, pollMs: 250 });
  assert.equal(claim.target, 'cobalt');
  writeEnvironmentBaseline(f.records[1]!.evidenceRoot, baseline('cobalt'));
  await assert.rejects(reserveEnvironmentInstallation('cobalt', f.specPath, options), { code: 'DUPLICATE_TARGET_IDENTITY' });
  const secondInstaller = join(f.parent, 'second-node-release');
  mkdirSync(secondInstaller);
  writeFileSync(f.specPath, JSON.stringify({ ...f.spec, runId: 'second-install', installerPath: secondInstaller }));
  const second = (await reserveEnvironmentInstallation('cobalt', f.specPath, options)).installation;
  assert.notEqual(second.statePath, first.statePath);
  assert.equal(readdirSync(f.parent).filter((name) => name.startsWith('node-install-')).length, 2);
  assert.throws(() => assertInstallationNodeRuntime('amber', options), { code: 'CLAIM_OWNER_MISMATCH' });
});

test('Node installation CLI validates arguments and launches the reserved release with isolated environment', async (context) => {
  for (const args of [
    ['install-start', 'amber'],
    ['install-start', 'amber', '--runtime-env', '/private/runtime.json', '--profile', 'unrelated'],
    ['install-reconcile', 'amber', '--runtime-env', '/private/runtime.json'],
  ]) {
    let error = '';
    const status = await runEnvironmentCli(args, { stderr: (value: string) => { error += value; } });
    assert.equal(status, 2);
    assert.match(error, /INVALID_ARGUMENT/);
  }
  const f = nodeInstallationFixture(context);
  f.options.now = () => Date.now();
  claimEnvironment('amber', f.options);
  const { installation } = await reserveEnvironmentInstallation('amber', f.specPath, f.options);
  writeFileSync(join(f.installer, 'dist', 'server.mjs'), `
    import { writeFileSync } from 'node:fs';
    if (process.env.CHICKPEA_TEST_AMBIENT_SECRET) throw new Error('Inherited ambient credentials');
    writeFileSync(process.env.TAG_DB_PATH, 'run-owned');
    process.exitCode = 7;
  `);
  const previous = process.env.CHICKPEA_TEST_AMBIENT_SECRET;
  process.env.CHICKPEA_TEST_AMBIENT_SECRET = 'synthetic-secret';
  let output = '';
  try {
    const status = await runEnvironmentCli(['install-start', 'amber', '--worktree', f.worktree,
      '--root', f.root, '--runtime-env', f.envPath], { hostFingerprint: 'host-fixture',
      stdout: (value: string) => { output += value; }, stderr: (value: string) => { output += value; } });
    assert.equal(status, 7, output);
  } finally {
    if (previous === undefined) delete process.env.CHICKPEA_TEST_AMBIENT_SECRET;
    else process.env.CHICKPEA_TEST_AMBIENT_SECRET = previous;
  }
  assert.equal(readFileSync(join(installation.statePath, 'transcripts.sqlite'), 'utf8'), 'run-owned');
  assert.equal(existsSync(nodeInstallationProcessPath(installation)), false);
});

test('adding Violet preserves older baselines while checking every prior fingerprint and new fingerprint isolation', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const fleet = { ...authority().fleetCredentialFingerprints, violet: fingerprints('violet') };
  const options = { ...f.options, localContract: localContract(), observeAuthority: async () => authority('amber', { fleetCredentialFingerprints: fleet }) };
  assert.equal((await preflightEnvironmentMutation('amber', options)).target, 'amber');
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...options, observeAuthority: async () => authority('amber', { fleetCredentialFingerprints: { ...fleet, violet: fingerprints('amber') } }),
  }), { code: 'CREDENTIAL_FINGERPRINT_REUSED' });
  await assert.rejects(preflightEnvironmentMutation('amber', {
    ...options, observeAuthority: async () => authority('amber', { fleetCredentialFingerprints: { ...fleet, cobalt: fingerprints('other') } }),
  }), { code: 'CREDENTIAL_FLEET_FINGERPRINT_MISMATCH' });
});

test('other lanes retain isolation checks while a borrowed workspace is disconnected', async (context) => {
  const f = fixture({ transport: 'gateway' });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const holder = join(f.parent, 'holder');
  git(f.parent, 'clone', f.worktree, holder);
  claimEnvironment('cobalt', { ...f.options, worktreePath: holder });
  writeEnvironmentBaseline(f.records[1]!.evidenceRoot, baseline('cobalt'));
  const installer = join(f.parent, 'installer');
  mkdirSync(installer);
  const beforePath = join(f.parent, 'before.json');
  writeFileSync(beforePath, JSON.stringify({ slack: {}, admin: {}, fixtures: {}, pendingWork: false, independentAppsResolved: true }), { mode: 0o600 });
  const specPath = join(f.parent, 'spec.json');
  writeFileSync(specPath, JSON.stringify({ runId: 'borrow-cobalt', workerName: 'fresh-cobalt', authDatabaseName: 'fresh-auth',
    authDatabaseId: 'fresh-d1', installerPath: installer, beforeEvidence: beforePath,
    databaseCreationReceipt: installationDatabaseReceipt(f.parent, 'cobalt', { ...f.options, worktreePath: holder }) }), { mode: 0o600 });
  const gatewayAuthority = (target: string) => authority(target, { transport: 'gateway',
    transportAuthority: { healthy: true, phase: 'healthy', detail: null, generation: 1, versionId: `version-${target}` } });
  await reserveEnvironmentInstallation('cobalt', specPath, { ...f.options, worktreePath: holder,
    localContract: localContract(), observeAuthority: async () => gatewayAuthority('cobalt') });
  let cobaltChanged = false;
  const reads: string[] = [];
  const options = { ...f.options, allowTestAuthorityObserver: false, localContract: localContract(),
    env: { CHICKPEA_ENV_AMBER_LIVE_AUTHORITY_URL: 'https://amber.test/authority', CHICKPEA_ENV_AMBER_LIVE_AUTHORITY_READ_TOKEN: 'a'.repeat(43) },
    runWrangler: (args: string[]) => {
      const target = args.includes('chickpea-cobalt-live') ? 'cobalt' : 'amber';
      if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: [{
        version_id: cobaltChanged && target === 'cobalt' ? 'version-changed' : `version-${target}`, percentage: 100,
      }] }) };
      if (args[0] === 'd1') return { status: 0, stdout: JSON.stringify([{ success: true, results: [{ name: '0002_mcp_oauth.sql' }] }]) };
      return { status: 0, stdout: JSON.stringify({ migrations: [{ tag: 'v9' }], resources: { bindings: [
        { name: 'AUTH_DB', type: 'd1', id: `d1-${target}` },
        { name: 'TAG_STATE', type: 'durable_object_namespace', class_name: 'TagStateStore', namespace_id: `tag-${target}` },
        { name: 'CHICKPEA_ENV_TARGET', type: 'plain_text', text: target },
      ] } }) };
    },
    fetchImpl: async (url: string) => {
      reads.push(String(url));
      assert.equal(String(url), 'https://amber.test/authority');
      return Response.json({ schemaVersion: 'chickpea-environment-runtime-authority/v2', target: 'amber',
        observedAt: new Date(NOW).toISOString(), slack: authority().slack,
        transportAuthority: gatewayAuthority('amber').transportAuthority,
        secretFingerprints: { schemaVersion: 'chickpea-environment-runtime-secret-fingerprints/v2',
          sourceBindings: { ...RUNTIME_SECRET_SOURCE_BINDINGS, cookie: 'CHICKPEA_AUTH_SECRET', signing: 'slack.gateway.deploymentIdentity.v1.deploymentId' },
          fingerprints: fingerprints('amber') },
      });
    },
  };
  assert.equal((await preflightEnvironmentMutation('amber', options)).target, 'amber');
  assert.deepEqual(reads, ['https://amber.test/authority']);
  cobaltChanged = true;
  await assert.rejects(preflightEnvironmentMutation('amber', options), { code: 'INSTALLATION_BASELINE_CHANGED' });
  assert.ok(readEnvironmentRegistry(f.options).targets.cobalt.installation);
});

test('Violet admission requires reachable distinct fleet authority before publishing registration', async (context) => {
  const f = fixture({ transport: 'gateway' });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const violet = JSON.parse(JSON.stringify(f.records[0]).replaceAll('amber', 'violet').replaceAll('AMBER', 'VIOLET'));
  mkdirSync(violet.evidenceRoot, { recursive: true, mode: 0o700 });
  const targets = ['amber', 'cobalt', 'violet'];
  writeEnvironmentBaseline(violet.evidenceRoot, { ...baseline('violet'),
    credentialFingerprintsByTarget: Object.fromEntries(targets.map((target) => [target, fingerprints(target)])) });
  const registrationPath = join(f.parent, 'registration.json');
  const prior = readEnvironmentRegistry(f.options);
  writeFileSync(registrationPath, JSON.stringify({ expectedRegistryRevision: prior.revision, registration: violet }), { mode: 0o600 });
  let reachable = false;
  let duplicate = false;
  const options = { ...f.options,
    env: Object.fromEntries(targets.flatMap((target) => [
      [`CHICKPEA_ENV_${target.toUpperCase()}_LIVE_AUTHORITY_URL`, `https://${target}.test/authority`],
      [`CHICKPEA_ENV_${target.toUpperCase()}_LIVE_AUTHORITY_READ_TOKEN`, target[0]!.repeat(43)],
    ])),
    runWrangler: (args: string[]) => {
      if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'version-violet', percentage: 100 }] }) };
      if (args[0] === 'd1') return { status: 0, stdout: JSON.stringify([{ success: true, results: [{ name: '0002_mcp_oauth.sql' }] }]) };
      return { status: 0, stdout: JSON.stringify({ migrations: [{ tag: 'v9' }], resources: { bindings: [
        { name: 'AUTH_DB', type: 'd1', id: 'd1-violet' },
        { name: 'TAG_STATE', type: 'durable_object_namespace', class_name: 'TagStateStore', namespace_id: 'tag-violet' },
        { name: 'CHICKPEA_ENV_TARGET', type: 'plain_text', text: 'violet' },
      ] } }) };
    },
    fetchImpl: async (url: string) => {
      const target = new URL(String(url)).hostname.split('.')[0]!;
      if (!reachable && target === 'violet') return new Response('', { status: 503 });
      return Response.json({ schemaVersion: 'chickpea-environment-runtime-authority/v2', target,
        observedAt: new Date(NOW).toISOString(), slack: authority(target).slack,
        transportAuthority: { healthy: true, phase: 'healthy', detail: null, generation: 1, versionId: `version-${target}` },
        secretFingerprints: { schemaVersion: 'chickpea-environment-runtime-secret-fingerprints/v2',
          sourceBindings: { ...RUNTIME_SECRET_SOURCE_BINDINGS, cookie: 'CHICKPEA_AUTH_SECRET', signing: 'slack.gateway.deploymentIdentity.v1.deploymentId' },
          fingerprints: fingerprints(duplicate && target === 'violet' ? 'amber' : target) },
      });
    },
  };
  await assert.rejects(adoptEnvironmentFromFile(registrationPath, options));
  assert.deepEqual(readEnvironmentRegistry(f.options), prior);
  reachable = true;
  duplicate = true;
  await assert.rejects(adoptEnvironmentFromFile(registrationPath, options), { code: 'CREDENTIAL_FINGERPRINT_REUSED' });
  assert.deepEqual(readEnvironmentRegistry(f.options), prior);
  duplicate = false;
  assert.equal((await adoptEnvironmentFromFile(registrationPath, options)).registered, 'violet');
  assert.deepEqual(readEnvironmentRegistry(f.options).targets.amber, prior.targets.amber);
  assert.deepEqual(readEnvironmentRegistry(f.options).targets.cobalt, prior.targets.cobalt);
});

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
    ['WORKER_MISMATCH', { workerName: 'chickpea-cobalt-live' }],
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
    {
      ...localContract(),
      manifestDigest: `sha256:${'3'.repeat(64)}`,
      existingInstallManifestDigest: `sha256:${'3'.repeat(64)}`,
    },
    {
      ...localContract(),
      requiredScopes: ['chat:write', 'users:read'],
      existingInstallScopes: ['chat:write', 'users:read'],
    },
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
