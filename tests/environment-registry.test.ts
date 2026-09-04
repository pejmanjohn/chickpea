import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

// @ts-expect-error The executable registry module intentionally has no declaration file.
import * as environmentRegistryModule from '../scripts/lib/environment-registry.mjs';
// @ts-expect-error The executable target module intentionally has no declaration file.
import * as environmentTargetModule from '../scripts/lib/environment-target.mjs';
// @ts-expect-error The executable attestation module intentionally has no declaration file.
import * as environmentAttestationModule from '../scripts/lib/environment-attestation.mjs';
import { validatePrivateConfig } from '../qa/live/private-config.ts';
import { resolveTargetSuiteVariants } from '../qa/live/manifest.ts';
import { PHASE_ONE_SMOKE_VARIANTS } from '../qa/live/schema.ts';
import { validateTargetOverlay } from '../qa/live/privacy.ts';
import { LIVE_MANIFEST } from '../qa/live/manifest.ts';
// @ts-expect-error The executable CLI module intentionally has no declaration file.
import * as environmentCliModule from '../scripts/chickpea-environment.mjs';

const {
  EnvironmentRegistryError,
  claimEnvironment,
  createEnvironmentRegistry,
  currentHostFingerprint,
  environmentMarkerPath,
  migrateEnvironmentProviderAuthConfigs,
  readEnvironmentRegistry,
  readEnvironmentStatus,
  reconcileEnvironment,
  recordEnvironmentAttestation,
  reclaimEnvironment,
  releaseEnvironment,
  resolveEnvironmentAlias,
} = environmentRegistryModule;
const { createVerifierTargetInputs, targetEnvironment } = environmentTargetModule;
const { attestEnvironment } = environmentAttestationModule;
const { runEnvironmentCli } = environmentCliModule;

const TARGETS = ['amber', 'cobalt'] as const;
const NOW = Date.parse('2026-09-01T12:00:00.000Z');

interface GitFixture {
  path: string;
  branch: string;
  revision: string;
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function worktree(parent: string, name: string): GitFixture {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', `feature/${name}`);
  git(path, 'config', 'user.email', 'fixture@example.test');
  git(path, 'config', 'user.name', 'Fixture');
  writeFileSync(join(path, '.gitignore'), '.chickpea-environment\n');
  writeFileSync(join(path, 'fixture.txt'), `${name}\n`);
  git(path, 'add', '.gitignore', 'fixture.txt');
  git(path, 'commit', '-m', 'fixture');
  return {
    path,
    branch: git(path, 'branch', '--show-current'),
    revision: git(path, 'rev-parse', 'HEAD'),
  };
}

function targetRecord(target: typeof TARGETS[number], revision: string, evidenceParent: string) {
  return {
    target,
    role: 'branch',
    transport: 'events',
    workerName: `chickpea-${target}-live`,
    authDatabaseBinding: 'AUTH_DB',
    authDatabaseName: `chickpea-auth-db-${target}-live`,
    authDatabaseId: `d1-${target}`,
    workspaceId: `T_${target.toUpperCase()}`,
    workspaceLabel: `${target} workspace`,
    slackAppId: `A_${target.toUpperCase()}`,
    slackAppLabel: `${target} app`,
    botUserId: `U_${target.toUpperCase()}_BOT`,
    providerProjectId: `provider-${target}`,
    providerAuthConfigId: `provider-read-${target}`,
    timezone: 'America/Los_Angeles',
    evidenceRoot: join(evidenceParent, target, 'evidence'),
    bindingIdentities: {
      AUTH_DB: `d1-${target}`,
      TAG_STATE: `tag-state-${target}`,
    },
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    servingVersion: `version-${target}`,
    sourceRevision: revision,
    sourceDirty: false,
    reachable: true,
    identityMatches: true,
    computerUseSurfaces: {
      bridgeAvailable: true,
      windowCaptureAvailable: true,
      slackVisible: true,
      adminVisible: true,
    },
    missingActorAliases: [],
  };
}

function fixture(mutateTargets?: (targets: Array<Record<string, any>>) => void) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-environment-test-')));
  const root = join(parent, 'registry');
  const first = worktree(parent, 'first');
  const targets = TARGETS.map((target) => targetRecord(target, first.revision, parent));
  mutateTargets?.(targets);
  for (const target of targets) mkdirSync(target.evidenceRoot, { recursive: true, mode: 0o700 });
  createEnvironmentRegistry({
    root,
    hostFingerprint: 'host-fixture',
    targets,
    sandbox: {
      archiveDate: '2027-01-15T00:00:00.000Z',
      workspaceSlotsTotal: 5,
      workspaceSlotsUsed: 3,
      integrationHeadroom: 37,
    },
  });
  return { parent, root, first, targets };
}

function registryOptions(root: string) {
  return {
    root,
    hostFingerprint: 'host-fixture',
    now: () => NOW,
  };
}

function rejectsCode(code: string) {
  return (error: unknown) => error instanceof EnvironmentRegistryError
    && (error as { code?: unknown }).code === code;
}

function legacyRegistryFixture(keepClaim = false) {
  const f = fixture();
  claimEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  if (!keepClaim) releaseEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  const current = readEnvironmentRegistry(registryOptions(f.root));
  const oldSnapshots = new Map<string, string>();
  for (const name of readdirSync(join(f.root, 'revisions'))) {
    const snapshotPath = join(f.root, 'revisions', name);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    snapshot.schemaVersion = 'chickpea-environment-registry/v1';
    for (const target of TARGETS) {
      const registration = snapshot.targets[target];
      registration.providerReadOnlyAuthConfigId = registration.providerAuthConfigId;
      delete registration.providerAuthConfigId;
      if (!keepClaim && snapshot.revision === current.revision) {
        registration.lastAttestation = {
          attestedAt: new Date(NOW).toISOString(), registryRevision: current.revision,
          sourceRevision: registration.sourceRevision, servingVersion: registration.servingVersion,
          targetFingerprint: `sha256:${'a'.repeat(64)}`, verifierLock: { status: 'clear' },
        };
      }
    }
    const bytes = `${JSON.stringify(snapshot)}\n`;
    writeFileSync(snapshotPath, bytes);
    oldSnapshots.set(snapshotPath, bytes);
    if (snapshot.revision === current.revision) writeFileSync(join(f.root, 'registry.json'), bytes);
  }
  const migration = {
    expectedRegistryRevision: current.revision,
    targets: TARGETS.map((target) => ({
      target, providerProjectId: `provider-${target}`,
      previousAuthConfigId: `provider-read-${target}`, providerAuthConfigId: `provider-standard-${target}`,
    })),
  };
  return { ...f, current, migration, oldSnapshots };
}

test('provider auth migration is explicit, append-only, and invalidates both attestations', (context) => {
  const f = legacyRegistryFixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  assert.throws(() => readEnvironmentRegistry(registryOptions(f.root)), rejectsCode('PROVIDER_AUTH_CONFIG_MIGRATION_REQUIRED'));
  const status = readEnvironmentStatus(registryOptions(f.root));
  assert.deepEqual(status.targets.map(({ health }: { health: string }) => health), ['migration_required', 'migration_required']);
  assert.equal(reconcileEnvironment(undefined, { ...registryOptions(f.root), worktreePath: f.first.path }).ready, false);
  assert.throws(() => claimEnvironment('cobalt', {
    ...registryOptions(f.root), worktreePath: f.first.path,
  }), rejectsCode('PROVIDER_AUTH_CONFIG_MIGRATION_REQUIRED'));
  const result = migrateEnvironmentProviderAuthConfigs(f.migration, registryOptions(f.root));
  assert.deepEqual(result, { migrated: true, registryRevision: 3, targets: [...TARGETS] });
  const migrated = readEnvironmentRegistry(registryOptions(f.root));
  for (const [snapshotPath, bytes] of f.oldSnapshots) assert.equal(readFileSync(snapshotPath, 'utf8'), bytes);
  for (const target of TARGETS) {
    assert.deepEqual(migrated.targets[target], {
      ...f.current.targets[target], providerAuthConfigId: `provider-standard-${target}`, lastAttestation: null,
    });
    assert.equal(migrated.audit.findLast((event: { target: string }) => event.target === target)?.event, 'provider_auth_config_migrated');
  }
  assert.deepEqual(migrated.sandbox, f.current.sandbox);
  assert.equal(migrated.hostFingerprint, f.current.hostFingerprint);
  const bytes = readFileSync(join(f.root, 'registry.json'), 'utf8');
  assert.throws(() => migrateEnvironmentProviderAuthConfigs(f.migration, registryOptions(f.root)), rejectsCode('REGISTRY_ALREADY_CURRENT'));
  assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), bytes);
  claimEnvironment('cobalt', { ...registryOptions(f.root), worktreePath: f.first.path });
  assert.equal(readEnvironmentRegistry(registryOptions(f.root)).targets.cobalt.claim.target, 'cobalt');
});

test('provider auth migration refuses stale authority, wrong identities, and broadened inputs without a write', (context) => {
  const f = legacyRegistryFixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const cases: Array<[string, (input: any) => void]> = [
    ['REGISTRY_REVISION_CONFLICT', (input) => { input.expectedRegistryRevision -= 1; }],
    ['PROVIDER_AUTH_MIGRATION_MISMATCH', (input) => { input.targets[0].providerProjectId = 'another-project'; }],
    ['PROVIDER_AUTH_MIGRATION_MISMATCH', (input) => { input.targets[0].previousAuthConfigId = 'another-config'; }],
    ['INVALID_PROVIDER_AUTH_MIGRATION', (input) => { input.targets[0].extra = true; }],
    ['INVALID_PROVIDER_AUTH_MIGRATION', (input) => { input.targets[0].target = 'cobalt'; }],
    ['INVALID_PROVIDER_AUTH_MIGRATION', (input) => { input.targets.pop(); }],
    ['DUPLICATE_TARGET_IDENTITY', (input) => { input.targets[0].providerAuthConfigId = input.targets[1].providerAuthConfigId; }],
  ];
  const before = readFileSync(join(f.root, 'registry.json'), 'utf8');
  for (const [code, mutate] of cases) {
    const input = structuredClone(f.migration);
    mutate(input);
    assert.throws(() => migrateEnvironmentProviderAuthConfigs(input, registryOptions(f.root)), rejectsCode(code));
    assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), before);
    assert.equal(readdirSync(join(f.root, 'revisions')).length, f.oldSnapshots.size);
  }
  assert.throws(() => migrateEnvironmentProviderAuthConfigs(f.migration, {
    ...registryOptions(f.root), hostFingerprint: 'another-host',
  }), rejectsCode('HOST_MISMATCH'));
});

test('provider auth migration refuses claims, target locks, and deploy intents even with supplied lease authority', (context) => {
  const claimed = legacyRegistryFixture(true);
  context.after(() => rmSync(claimed.parent, { recursive: true, force: true }));
  assert.throws(() => migrateEnvironmentProviderAuthConfigs(claimed.migration, registryOptions(claimed.root)), rejectsCode('TARGET_CLAIMED'));
  for (const filename of ['target.lock', 'deploy-intent.json']) {
    const f = legacyRegistryFixture();
    context.after(() => rmSync(f.parent, { recursive: true, force: true }));
    const owner = { runId: 'test-run', pid: process.pid, host: hostname(), startedAt: new Date(NOW).toISOString() };
    // A lock uses a strict shape, while the deploy-intent check reads only authority.
    const state = filename === 'target.lock' ? owner : { ...owner, target: 'cobalt' };
    writeFileSync(join(f.current.targets.cobalt.evidenceRoot, filename), JSON.stringify(state), { mode: 0o600 });
    assert.throws(() => migrateEnvironmentProviderAuthConfigs(f.migration, {
      ...registryOptions(f.root), expectedTargetLockRunId: owner.runId,
    }), rejectsCode('TARGET_MUTATION_LOCKED'));
    assert.equal(readdirSync(join(f.root, 'revisions')).length, f.oldSnapshots.size);
  }
});

test('a claimed v1 registry can recover and release through the CLI before migrating', async (context) => {
  const f = legacyRegistryFixture(true);
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  assert.equal(readEnvironmentStatus(registryOptions(f.root)).registryMigrationRequired, true);
  const output: string[] = [];
  const io = { hostFingerprint: 'host-fixture', stdout: (value: string) => output.push(value), stderr: (value: string) => output.push(value) };
  const flags = ['--root', f.root, '--worktree', f.first.path];
  assert.equal(await runEnvironmentCli(['claim', 'cobalt', ...flags], io), 2);
  // CLI reclaim renews the old expired lease without bypassing ownership checks.
  assert.equal(await runEnvironmentCli(['reclaim', 'amber', ...flags], io), 0, output.join(''));
  assert.equal(await runEnvironmentCli(['release', 'amber', ...flags], io), 0, output.join(''));
  const released = JSON.parse(readFileSync(join(f.root, 'registry.json'), 'utf8'));
  assert.equal(released.schemaVersion, 'chickpea-environment-registry/v1');
  assert.equal(released.targets.amber.claim, null);
  assert.equal(existsSync(environmentMarkerPath(f.first.path)), false);
  for (const [snapshotPath, bytes] of f.oldSnapshots) assert.equal(readFileSync(snapshotPath, 'utf8'), bytes);
  const result = migrateEnvironmentProviderAuthConfigs({
    ...f.migration, expectedRegistryRevision: released.revision,
  }, registryOptions(f.root));
  assert.equal(result.migrated, true);
});

test('provider auth migration recovers snapshot-first interruption without rewriting v1 history', (context) => {
  const f = legacyRegistryFixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  assert.throws(() => migrateEnvironmentProviderAuthConfigs(f.migration, {
    ...registryOptions(f.root), beforeRegistryCurrentWrite: () => { throw new Error('simulated migration crash'); },
  }), /simulated migration crash/u);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'registry.json'), 'utf8')).schemaVersion, 'chickpea-environment-registry/v1');
  assert.equal(readEnvironmentRegistry(registryOptions(f.root)).revision, 3);
  for (const [snapshotPath, bytes] of f.oldSnapshots) assert.equal(readFileSync(snapshotPath, 'utf8'), bytes);
  assert.throws(() => migrateEnvironmentProviderAuthConfigs(f.migration, registryOptions(f.root)), rejectsCode('REGISTRY_ALREADY_CURRENT'));
});

test('provider auth migration CLI requires a private bindings file and emits no provider IDs', async (context) => {
  const f = legacyRegistryFixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const bindingsPath = join(f.parent, 'migration.json');
  writeFileSync(bindingsPath, JSON.stringify(f.migration), { mode: 0o600 });
  const output: string[] = [];
  const io = { hostFingerprint: 'host-fixture', stdout: (value: string) => output.push(value), stderr: (value: string) => output.push(value) };
  assert.equal(await runEnvironmentCli(['migrate-provider-auth', '--root', f.root], io), 2);
  chmodSync(bindingsPath, 0o644);
  assert.equal(await runEnvironmentCli(['migrate-provider-auth', '--root', f.root, '--bindings', bindingsPath], io), 2);
  chmodSync(bindingsPath, 0o600);
  assert.equal(await runEnvironmentCli(['migrate-provider-auth', '--root', f.root, '--bindings', bindingsPath], io), 0);
  assert.doesNotMatch(output.join(''), /provider-standard-|provider-read-/u);
});

test('registry history cannot downgrade from v2 back to v1', (context) => {
  const f = legacyRegistryFixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  migrateEnvironmentProviderAuthConfigs(f.migration, registryOptions(f.root));
  const downgraded = JSON.parse([...f.oldSnapshots.values()].at(-1)!);
  downgraded.revision = 4;
  writeFileSync(join(f.root, 'revisions', 'revision-0000000000000004.json'), JSON.stringify(downgraded), { mode: 0o600 });
  assert.throws(() => readEnvironmentRegistry(registryOptions(f.root)), rejectsCode('REGISTRY_SCHEMA_ROLLBACK'));
});

test('two standalone lanes register without sandbox capacity or a hidden Fern dependency', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const root = join(f.parent, 'standalone');
  createEnvironmentRegistry({
    root,
    hostFingerprint: 'host-fixture',
    targets: f.targets,
    sandbox: null,
  });
  const status = readEnvironmentStatus(registryOptions(root));
  assert.deepEqual(status.targets.map(({ target }: { target: string }) => target), ['amber', 'cobalt']);
  assert.equal(status.sandbox, null);
  assert.throws(() => claimEnvironment('fern', {
    ...registryOptions(root), worktreePath: f.first.path,
  }), rejectsCode('INACTIVE_TARGET'));
});

test('a free claim writes matching owner-only central and local records', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));

  const claimed = claimEnvironment('amber', {
    ...registryOptions(f.root),
    worktreePath: f.first.path,
    leaseDurationMs: 60_000,
  });
  const registry = readEnvironmentRegistry(registryOptions(f.root));
  const marker = JSON.parse(readFileSync(environmentMarkerPath(f.first.path), 'utf8'));

  assert.equal(claimed.target, 'amber');
  assert.equal(registry.targets.amber.claim?.leaseNonce, claimed.leaseNonce);
  assert.deepEqual(marker, registry.targets.amber.claim);
  assert.equal(marker.canonicalWorktreePath, f.first.path);
  assert.equal(marker.branch, f.first.branch);
  assert.equal(marker.claimedRevision, f.first.revision);
  assert.equal(lstatSync(f.root).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.root, 'registry.json')).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(f.root, 'revisions')).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.root, 'revisions', 'revision-0000000000000001.json')).mode & 0o777, 0o600);
  assert.equal(lstatSync(environmentMarkerPath(f.first.path)).mode & 0o777, 0o600);
  const beforeDuplicate = readFileSync(join(f.root, 'registry.json'), 'utf8');
  assert.throws(
    () => claimEnvironment('cobalt', { ...registryOptions(f.root), worktreePath: f.first.path }),
    rejectsCode('WORKTREE_ALREADY_CLAIMED'),
  );
  assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), beforeDuplicate);
  const worktreeMode = lstatSync(f.first.path).mode & 0o777;
  chmodSync(f.first.path, 0o777);
  assert.equal(readEnvironmentStatus({ ...registryOptions(f.root), target: 'amber' })
    .targets[0]?.health, 'identity_mismatch');
  chmodSync(f.first.path, worktreeMode);
});

test('a second worktree sees the holder and an expired claim stays visible without mutation', (context) => {
  const f = fixture();
  const second = worktree(f.parent, 'second');
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path, leaseDurationMs: 1_000,
  });
  const beforeConflict = readFileSync(join(f.root, 'registry.json'), 'utf8');

  assert.throws(
    () => claimEnvironment('amber', {
      ...registryOptions(f.root), worktreePath: second.path, leaseDurationMs: 1_000,
    }),
    rejectsCode('TARGET_CLAIMED'),
  );
  const status = readEnvironmentStatus({
    ...registryOptions(f.root), target: 'amber', worktreePath: second.path,
  });
  assert.match(status.targets[0]?.claim?.holderId ?? '', /^holder-[0-9a-f]{16}$/u);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(f.first.path.replaceAll('/', '\\/')));
  assert.equal(status.targets[0]?.claim?.leaseAgeMs, 0);
  assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), beforeConflict);

  const expiredOptions = { ...registryOptions(f.root), now: () => NOW + 2_000 };
  const beforeExpired = readFileSync(join(f.root, 'registry.json'), 'utf8');
  assert.equal(readEnvironmentStatus({ ...expiredOptions, target: 'amber' }).targets[0]?.health, 'expired_claim');
  assert.throws(
    () => claimEnvironment('amber', {
      ...expiredOptions, worktreePath: second.path, leaseDurationMs: 1_000,
    }),
    rejectsCode('CLAIM_EXPIRED_RECLAIM_REQUIRED'),
  );
  assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), beforeExpired);
  assert.equal(existsSync(environmentMarkerPath(second.path)), false);
});

test('two concurrent processes cannot both claim one target', async (context) => {
  const f = fixture();
  const second = worktree(f.parent, 'second');
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const script = join(process.cwd(), 'scripts', 'chickpea-environment.mjs');
  const runner = `import { runEnvironmentCli } from ${JSON.stringify(`file://${script}`)};
process.exit(await runEnvironmentCli(process.argv.slice(1), { hostFingerprint: 'host-fixture' }));`;
  const run = (path: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', runner, 'claim', 'amber', '--worktree', path], {
      env: { ...process.env, CHICKPEA_ENVIRONMENT_ROOT: f.root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  const results = await Promise.all([run(f.first.path), run(second.path)]);
  assert.deepEqual(results.map(({ code }) => code).sort(), [0, 2]);
  const registry = readEnvironmentRegistry(registryOptions(f.root));
  assert.ok(registry.targets.amber.claim);
  assert.equal([
    existsSync(environmentMarkerPath(f.first.path)),
    existsSync(environmentMarkerPath(second.path)),
  ].filter(Boolean).length, 1);
});

test('explicit reclaim rotates the nonce and appends a content-free audit event', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const first = claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path, leaseDurationMs: 1_000,
  });
  const reclaimed = reclaimEnvironment('amber', {
    ...registryOptions(f.root), now: () => NOW + 2_000, worktreePath: f.first.path,
    leaseDurationMs: 60_000,
  });
  const registry = readEnvironmentRegistry({
    ...registryOptions(f.root), now: () => NOW + 2_000,
  });
  assert.notEqual(reclaimed.leaseNonce, first.leaseNonce);
  assert.deepEqual(registry.audit.at(-1), {
    event: 'claim_reclaimed',
    target: 'amber',
    at: new Date(NOW + 2_000).toISOString(),
    registryRevision: registry.revision,
  });
  assert.doesNotMatch(JSON.stringify(registry.audit), /first|feature\/|leaseNonce|@/);
});

test('an unexpired claim whose worktree is gone can be adopted only with an explicit opt-in', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const second = worktree(f.parent, 'second');
  claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path, leaseDurationMs: 60_000,
  });
  const gone = new Set<string>();
  const worktreeExists = (candidate: string) => !gone.has(candidate);
  const attempt = (extra: Record<string, unknown> = {}) => reclaimEnvironment('amber', {
    ...registryOptions(f.root), now: () => NOW + 2_000, worktreePath: second.path,
    leaseDurationMs: 60_000, worktreeExists, ...extra,
  });

  // A live holder is never displaced, with or without the flag.
  assert.throws(() => attempt(), (error: unknown) =>
    (error as { code: string; details: { orphaned: boolean } }).code === 'TARGET_CLAIMED'
    && (error as { details: { orphaned: boolean } }).details.orphaned === false);
  assert.throws(() => attempt({ adoptOrphan: true }), (error: unknown) =>
    (error as { code: string }).code === 'TARGET_CLAIMED');

  // An orphaned holder is reported as such, but still needs the explicit opt-in.
  gone.add(f.first.path);
  assert.throws(() => attempt(), (error: unknown) =>
    (error as { code: string; details: { orphaned: boolean } }).code === 'TARGET_CLAIMED'
    && (error as { details: { orphaned: boolean } }).details.orphaned === true);
  const adopted = attempt({ adoptOrphan: true });
  assert.equal(adopted.canonicalWorktreePath, second.path);
  const registry = readEnvironmentRegistry({ ...registryOptions(f.root), now: () => NOW + 2_000 });
  assert.equal(registry.targets.amber.claim?.canonicalWorktreePath, second.path);
  assert.deepEqual(registry.audit.at(-1), {
    event: 'claim_adopted_orphan',
    target: 'amber',
    at: new Date(NOW + 2_000).toISOString(),
    registryRevision: registry.revision,
  });
});

test('secret-like fields, symlinks, broad modes, noncanonical paths, wrong hosts, and rollback fail closed', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));

  const secretRoot = join(f.parent, 'secret-registry');
  assert.throws(() => createEnvironmentRegistry({
    root: secretRoot,
    hostFingerprint: 'host-fixture',
    targets: [{ ...f.targets[0], apiToken: 'xoxb-do-not-store' }],
    sandbox: { archiveDate: '2027-01-15T00:00:00.000Z', workspaceSlotsTotal: 5, workspaceSlotsUsed: 3, integrationHeadroom: 1 },
  }), rejectsCode('SECRET_LIKE_FIELD'));
  assert.equal(existsSync(secretRoot), false);
  assert.throws(() => createEnvironmentRegistry({
    root: join(f.parent, 'secret-key-registry'),
    hostFingerprint: 'host-fixture',
    targets: [{ ...f.targets[0], apiToken: 'looks-innocent' }],
    sandbox: { archiveDate: '2027-01-15T00:00:00.000Z', workspaceSlotsTotal: 5, workspaceSlotsUsed: 3, integrationHeadroom: 1 },
  }), rejectsCode('SECRET_LIKE_FIELD'));

  const inRepositoryRoot = join(f.first.path, 'machine-registry');
  assert.throws(() => createEnvironmentRegistry({
    root: inRepositoryRoot,
    hostFingerprint: 'host-fixture',
    targets: f.targets,
    sandbox: { archiveDate: '2027-01-15T00:00:00.000Z', workspaceSlotsTotal: 5, workspaceSlotsUsed: 3, integrationHeadroom: 1 },
  }), rejectsCode('REGISTRY_INSIDE_REPOSITORY'));
  assert.equal(existsSync(inRepositoryRoot), false);

  const linkedParentTarget = join(f.parent, 'linked-parent-target');
  const linkedParent = join(f.parent, 'linked-parent');
  mkdirSync(linkedParentTarget, { mode: 0o700 });
  symlinkSync(linkedParentTarget, linkedParent);
  assert.throws(() => createEnvironmentRegistry({
    root: join(linkedParent, 'registry'),
    hostFingerprint: 'host-fixture',
    targets: f.targets,
    sandbox: { archiveDate: '2027-01-15T00:00:00.000Z', workspaceSlotsTotal: 5, workspaceSlotsUsed: 3, integrationHeadroom: 1 },
  }), rejectsCode('SYMLINK_REFUSED'));
  assert.equal(existsSync(join(linkedParentTarget, 'registry')), false);

  assert.throws(
    () => readEnvironmentRegistry({ ...registryOptions(f.root), hostFingerprint: 'other-host' }),
    rejectsCode('HOST_MISMATCH'),
  );
  assert.throws(
    () => claimEnvironment('amber', {
      ...registryOptions(f.root),
      worktreePath: `${f.first.path}/../${basename(f.first.path)}`,
    }),
    rejectsCode('NON_CANONICAL_WORKTREE'),
  );

  const registryPath = join(f.root, 'registry.json');
  chmodSync(registryPath, 0o644);
  assert.throws(() => readEnvironmentRegistry(registryOptions(f.root)), rejectsCode('UNSAFE_PERMISSIONS'));
  chmodSync(registryPath, 0o600);
  renameSync(registryPath, `${registryPath}.real`);
  symlinkSync(`${registryPath}.real`, registryPath);
  assert.throws(() => readEnvironmentRegistry(registryOptions(f.root)), rejectsCode('SYMLINK_REFUSED'));
  rmSync(registryPath);
  renameSync(`${registryPath}.real`, registryPath);

  claimEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.revision = 0;
  writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  assert.throws(() => readEnvironmentRegistry(registryOptions(f.root)), rejectsCode('REGISTRY_ROLLBACK'));
});

test('two fixture worktrees hold the colors, a third auto-claim refuses, and release preserves targets', (context) => {
  const f = fixture();
  const holders = [f.first, worktree(f.parent, 'second')];
  const third = worktree(f.parent, 'third');
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  TARGETS.forEach((target, index) => claimEnvironment(target, {
    ...registryOptions(f.root), worktreePath: holders[index]!.path,
  }));
  assert.throws(
    () => claimEnvironment(undefined, { ...registryOptions(f.root), worktreePath: third.path }),
    rejectsCode('NO_TARGET_AVAILABLE'),
  );
  const beforeRelease = readEnvironmentRegistry(registryOptions(f.root)).targets.amber;
  releaseEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  const afterRelease = readEnvironmentRegistry(registryOptions(f.root)).targets.amber;
  assert.equal(afterRelease.claim, null);
  assert.equal(afterRelease.authDatabaseId, beforeRelease.authDatabaseId);
  assert.equal(afterRelease.workspaceId, beforeRelease.workspaceId);
});

test('fleet status is read-only and projects stale and unreachable states with recovery actions', (context) => {
  const emptyRoot = join(realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-status-empty-'))), 'registry');
  context.after(() => rmSync(join(emptyRoot, '..'), { recursive: true, force: true }));
  const emptyStatus = readEnvironmentStatus({ root: emptyRoot, hostFingerprint: 'host-fixture' });
  assert.equal(emptyStatus.targets.length, 2);
  assert.equal(emptyStatus.sandbox, null);
  assert.equal(existsSync(emptyRoot), false);

  const f = fixture((targets) => {
    targets[1]!.reachable = false;
  });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  const markerPath = environmentMarkerPath(f.first.path);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  marker.leaseNonce = 'mismatched-marker-nonce';
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  const registryPath = join(f.root, 'registry.json');
  const before = readFileSync(registryPath, 'utf8');
  const status = readEnvironmentStatus(registryOptions(f.root));
  assert.deepEqual(status.targets.map(({ health }: { health: string }) => health), [
    'stale_claim', 'unreachable',
  ]);
  assert.ok(status.targets.every(({ recoveryAction }: { recoveryAction: unknown }) =>
    typeof recoveryAction === 'string' && recoveryAction.length > 0));
  assert.equal(readFileSync(registryPath, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(status), /T_AMBER|A_AMBER|U_AMBER_BOT|provider-read|d1-amber/);
  assert.deepEqual(status.sandbox.warningDays, [45, 30, 14]);
  assert.equal(status.sandbox.unusedWorkspaceSlots, 2);
});

test('identity mismatch remains visible with only two active targets', (context) => {
  const f = fixture((targets) => { targets[1]!.identityMatches = false; });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const status = readEnvironmentStatus(registryOptions(f.root));
  assert.deepEqual(status.targets.map(({ health }: { health: string }) => health), ['ready', 'identity_mismatch']);
  assert.match(status.targets[1].recoveryAction, /reconciliation cobalt/);
});

test('unmanaged workspaces consume capacity without becoming claimable lanes', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  for (const used of [3, 4, 5]) {
    const root = join(f.parent, `capacity-${used}`);
    createEnvironmentRegistry({
      root,
      hostFingerprint: 'host-fixture',
      targets: f.targets,
      sandbox: {
        archiveDate: '2027-01-15T00:00:00.000Z',
        workspaceSlotsTotal: 5,
        workspaceSlotsUsed: used,
        integrationHeadroom: 37,
      },
    });
    const status = readEnvironmentStatus(registryOptions(root));
    assert.deepEqual(status.targets.map((target: { target: string }) => target.target), TARGETS);
    assert.equal(status.sandbox.unusedWorkspaceSlots, 5 - used);
    const claim = claimEnvironment('amber', {
      ...registryOptions(root), worktreePath: f.first.path,
    });
    assert.equal(claim.target, 'amber');
    releaseEnvironment('amber', { ...registryOptions(root), worktreePath: f.first.path });
    assert.throws(() => claimEnvironment('probe', {
      ...registryOptions(root), worktreePath: f.first.path,
    }), rejectsCode('INACTIVE_TARGET'));
  }
});

test('workspace capacity rejects malformed, undercounted, and over-limit inventories before writes', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const invalidUsed = [null, undefined, '4', 1, -1, 3.5, 6, Number.NaN, Infinity];
  invalidUsed.forEach((used, index) => {
    const root = join(f.parent, `invalid-capacity-${index}`);
    assert.throws(() => createEnvironmentRegistry({
      root,
      hostFingerprint: 'host-fixture',
      targets: f.targets,
      sandbox: {
        archiveDate: '2027-01-15T00:00:00.000Z',
        workspaceSlotsTotal: 5,
        workspaceSlotsUsed: used,
        integrationHeadroom: 37,
      },
    }), rejectsCode('INVALID_SANDBOX'));
    assert.equal(existsSync(root), false);
  });
});

test('target and private outputs validate for all colors and refuse deep and inactive roles', (context) => {
  const f = fixture();
  const worktrees = [f.first, worktree(f.parent, 'second')];
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  TARGETS.forEach((target, index) => {
    claimEnvironment(target, { ...registryOptions(f.root), worktreePath: worktrees[index]!.path });
    const output = targetEnvironment(target, {
      ...registryOptions(f.root), worktreePath: worktrees[index]!.path,
    });
    assert.equal(output.targetOverlay.schemaVersion, 'chickpea-live-target/v1');
    assert.doesNotThrow(() => validateTargetOverlay(LIVE_MANIFEST, output.targetOverlay));
    assert.deepEqual(output.targetOverlay.allowedVariants, [...PHASE_ONE_SMOKE_VARIANTS]);
    assert.equal(output.privateConfig.schemaVersion, 'chickpea-live-private-config/v2');
    const privateTarget = validatePrivateConfig(output.privateConfig);
    const suitePolicy = {
      targetAlias: privateTarget.targetAlias,
      allowedSuites: privateTarget.allowedSuites,
      allowedVariants: privateTarget.allowedVariants,
    };
    assert.deepEqual(resolveTargetSuiteVariants(suitePolicy, 'smoke'), [...PHASE_ONE_SMOKE_VARIANTS]);
    assert.throws(() => resolveTargetSuiteVariants(suitePolicy, 'deep'), /SUITE_NOT_ALLOWED/);
    assert.match(JSON.stringify(output), new RegExp(`env-${target}-`));
    assert.doesNotMatch(JSON.stringify(output), new RegExp(`T_${target.toUpperCase()}|A_${target.toUpperCase()}|d1-${target}`));
    assert.equal(resolveEnvironmentAlias(`env-${target}-workspace`, registryOptions(f.root)), `T_${target.toUpperCase()}`);
  });

  const absent = join(f.parent, 'inactive');
  for (const role of ['fern', 'dedicated-qa', 'install', 'demo', 'spare', 'qualification', 'deep']) {
    assert.throws(
      () => createVerifierTargetInputs(role, f.targets[0]),
      rejectsCode('INACTIVE_TARGET'),
    );
    assert.throws(
      () => claimEnvironment(role, { root: absent, hostFingerprint: 'host-fixture', worktreePath: f.first.path }),
      rejectsCode('INACTIVE_TARGET'),
    );
  }
  assert.equal(existsSync(absent), false);
});

test('attestation requires the matching live claim and composes verifier-owned contracts', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const observed = {
    targetAlias: 'amber',
    transport: 'events',
    workerName: 'chickpea-amber-live',
    deployments: [{
      versionId: 'version-amber',
      percentage: 100,
      activatedAt: new Date(NOW - 1_000).toISOString(),
    }],
    bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'tag-state-amber' },
    slack: { teamId: 'T_AMBER', appId: 'A_AMBER' },
    provider: { projectId: 'provider-amber', authConfigId: 'provider-read-amber' },
    timezone: 'America/Los_Angeles',
    evidenceRoot: join(f.parent, 'amber', 'evidence'),
    events: {
      installationHealthy: true,
      signedEventReceiptFresh: true,
      signedEventReceiptVersionId: 'version-amber',
      signedEventReceiptAt: new Date(NOW).toISOString(),
      installationRevision: 1,
    },
  } as const;
  await assert.rejects(
    attestEnvironment('amber', observed, {
      ...registryOptions(f.root), worktreePath: f.first.path, allowSuppliedObservation: true,
    }),
    rejectsCode('CLAIM_REQUIRED'),
  );
  claimEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  const result = await attestEnvironment('amber', observed, {
    ...registryOptions(f.root), worktreePath: f.first.path, allowSuppliedObservation: true,
  });
  assert.equal(result.attestation.schemaVersion, 'chickpea-live-attestation/v1');
  assert.equal(result.doctorSnapshot.schemaVersion, 'chickpea-live-doctor-snapshot/v1');
  assert.equal(result.doctorSnapshot.repositoryRevision, f.first.revision);
  assert.equal(result.doctorSnapshot.lock.status, 'clear');
  assert.equal(result.doctorSnapshot.computerUseSurfaces.adminVisible, true);
  assert.equal(result.doctor.ready, true);
  assert.deepEqual(result.doctor.variantIds, [...PHASE_ONE_SMOKE_VARIANTS]);

  const readiness = (binding: Record<string, unknown>) => ({
    ...binding,
    transport: 'computer_use', observationScope: 'window',
    verifiedActorAliases: ['env-amber-primary-actor'],
    computerUseSurfaces: {
      bridgeAvailable: true, windowCaptureAvailable: true, slackVisible: true, adminVisible: true,
    },
    captures: ['admin', 'slack'].map((surface, index) => ({
      surface, digest: `sha256:${String(index + 1).repeat(64)}`,
      observedAt: new Date(NOW).toISOString(),
    })),
  });
  const readOptions = {
    ...registryOptions(f.root), worktreePath: f.first.path, allowSuppliedObservation: true,
  };
  // A cached registration must not overrule the current browser's missing actor.
  const unavailable = await attestEnvironment('amber', observed, {
    ...readOptions,
    readComputerUseReadiness: async (binding: Record<string, unknown>) => ({
      ...readiness(binding), verifiedActorAliases: [],
    }),
  });
  assert.equal(unavailable.doctor.ready, false);
  assert.deepEqual(unavailable.doctorSnapshot.missingActorAliases, ['env-amber-primary-actor']);
  for (const mutate of [
    (proof: any) => { proof.captures[0].observedAt = new Date(NOW - 60_001).toISOString(); },
    (proof: any) => { proof.captures[0].observedAt = new Date(NOW + 1_001).toISOString(); },
    (proof: any) => { proof.workspaceId = 'T_OTHER'; },
    (proof: any) => { proof.claimNonce = 'another-claim'; },
    (proof: any) => { proof.repositoryRevision = 'abcdef0123'; },
    (proof: any) => { proof.observationScope = 'screen'; },
    (proof: any) => { proof.transport = 'api'; },
    (proof: any) => { proof.captures.pop(); },
    (proof: any) => { proof.captures[1].digest = proof.captures[0].digest; },
    (proof: any) => { proof.verifiedActorAliases.push('other-actor'); },
  ]) {
    await assert.rejects(attestEnvironment('amber', observed, {
      ...readOptions,
      readComputerUseReadiness: async (binding: Record<string, unknown>) => {
        const proof = readiness(binding); mutate(proof); return proof;
      },
    }), /INVALID_COMPUTER_USE_READINESS/u);
  }
  const refreshed = await attestEnvironment('amber', observed, {
    ...readOptions, readComputerUseReadiness: async (binding: Record<string, unknown>) => readiness(binding),
  });
  assert.equal(refreshed.doctor.ready, true);
  assert.deepEqual(readEnvironmentRegistry(registryOptions(f.root)).targets.amber.missingActorAliases, []);
});

test('CLI status defaults to its calling worktree without changing global registry status', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  assert.equal(readEnvironmentStatus(registryOptions(f.root)).selectedTarget, null);
  const script = new URL('../scripts/chickpea-environment.mjs', import.meta.url).href;
  const runner = `import { runEnvironmentCli } from ${JSON.stringify(script)};
process.exit(await runEnvironmentCli(process.argv.slice(1), { hostFingerprint: 'host-fixture' }));`;
  for (const flags of [[], ['--all']]) {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', runner,
      'status', '--root', f.root, ...flags], { cwd: f.first.path, encoding: 'utf8',
      env: { ...process.env, NODE_PATH: undefined } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).selectedTarget, 'amber');
  }
});

test('CLI dispatches claim, status, target, attest, reclaim, release, and reconciliation', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const invoke = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runEnvironmentCli(args, {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
      env: { CHICKPEA_HOST_FINGERPRINT: 'spoofed-host' },
      hostFingerprint: 'host-fixture',
      allowSuppliedObservation: true,
    });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  const base = ['--root', f.root, '--worktree', f.first.path];
  const claim = await invoke(['claim', 'amber', ...base]);
  const beforeStatus = readFileSync(join(f.root, 'registry.json'), 'utf8');
  const status = await invoke(['status', '--all', ...base]);
  assert.equal(status.selectedTarget, 'amber');
  assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), beforeStatus);
  const target = await invoke(['target', 'amber', ...base]);
  assert.equal(target.targetOverlay.schemaVersion, 'chickpea-live-target/v1');
  assert.doesNotMatch(JSON.stringify(target), /T_AMBER|A_AMBER|d1-amber/);
  const reclaimed = await invoke(['reclaim', 'amber', ...base]);
  assert.notEqual(reclaimed.leaseNonce, claim.leaseNonce);

  const instant = Date.now();
  const observationPath = join(f.parent, 'observation.json');
  writeFileSync(observationPath, JSON.stringify({
    targetAlias: 'amber',
    transport: 'events',
    workerName: 'chickpea-amber-live',
    deployments: [{
      versionId: 'version-amber',
      percentage: 100,
      activatedAt: new Date(instant - 1_000).toISOString(),
    }],
    bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'tag-state-amber' },
    slack: { teamId: 'T_AMBER', appId: 'A_AMBER' },
    provider: { projectId: 'provider-amber', authConfigId: 'provider-read-amber' },
    timezone: 'America/Los_Angeles',
    evidenceRoot: join(f.parent, 'amber', 'evidence'),
    events: {
      installationHealthy: true,
      signedEventReceiptFresh: true,
      signedEventReceiptVersionId: 'version-amber',
      signedEventReceiptAt: new Date(instant).toISOString(),
      installationRevision: 1,
    },
  }));
  let refusedError = '';
  const refused = await runEnvironmentCli(
    ['attest', 'amber', ...base, '--observation', observationPath],
    {
      hostFingerprint: 'host-fixture',
      stdout: () => {},
      stderr: (value: string) => { refusedError += value; },
    },
  );
  assert.equal(refused, 2);
  assert.match(refusedError, /CALLER_OBSERVATION_REFUSED/);
  const attested = await invoke(['attest', 'amber', ...base, '--observation', observationPath]);
  assert.equal(attested.doctor.ready, true);
  const beforeReconciliation = readFileSync(join(f.root, 'registry.json'), 'utf8');
  const reconciliation = await invoke(['reconciliation', 'amber', ...base]);
  assert.equal(reconciliation.kind, 'reconciliation');
  assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), beforeReconciliation);
  const released = await invoke(['release', 'amber', ...base]);
  assert.equal(released.released, true);
});

test('machine identity is persistent owner-only and refuses symlinks while CLI ignores host spoofing', async (context) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-machine-id-test-')));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const identityPath = join(parent, 'machine-identity.json');
  const first = currentHostFingerprint({ identityPath });
  const second = currentHostFingerprint({ identityPath });
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(lstatSync(identityPath).mode & 0o777, 0o600);

  chmodSync(identityPath, 0o644);
  assert.throws(() => currentHostFingerprint({ identityPath }), rejectsCode('UNSAFE_PERMISSIONS'));
  chmodSync(identityPath, 0o600);
  renameSync(identityPath, `${identityPath}.real`);
  symlinkSync(`${identityPath}.real`, identityPath);
  assert.throws(() => currentHostFingerprint({ identityPath }), rejectsCode('SYMLINK_REFUSED'));
  const linkedIdentityParentTarget = join(parent, 'identity-parent-target');
  const linkedIdentityParent = join(parent, 'identity-parent');
  mkdirSync(linkedIdentityParentTarget, { mode: 0o700 });
  symlinkSync(linkedIdentityParentTarget, linkedIdentityParent);
  assert.throws(
    () => currentHostFingerprint({ identityPath: join(linkedIdentityParent, 'machine.json') }),
    rejectsCode('SYMLINK_REFUSED'),
  );

  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  let stderr = '';
  const code = await runEnvironmentCli(
    ['status', '--all', '--root', f.root, '--worktree', f.first.path],
    {
      stdout: () => undefined,
      stderr: (value: string) => { stderr += value; },
      env: { CHICKPEA_HOST_FINGERPRINT: 'host-fixture' },
    },
  );
  assert.equal(code, 2);
  assert.match(stderr, /HOST_MISMATCH/u);
});

test('registry rejects duplicate immutable target identities across every independent class', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const cases: Array<[string, (targets: Array<Record<string, any>>) => void]> = [
    ['workspace', (targets) => { targets[1]!.workspaceId = targets[0]!.workspaceId; }],
    ['slack app', (targets) => { targets[1]!.slackAppId = targets[0]!.slackAppId; }],
    ['bot user', (targets) => { targets[1]!.botUserId = targets[0]!.botUserId; }],
    ['D1', (targets) => {
      targets[1]!.authDatabaseId = targets[0]!.authDatabaseId;
      targets[1]!.bindingIdentities.AUTH_DB = targets[0]!.bindingIdentities.AUTH_DB;
    }],
    ['provider project', (targets) => { targets[1]!.providerProjectId = targets[0]!.providerProjectId; }],
    ['provider read-only auth', (targets) => {
      targets[1]!.providerAuthConfigId = targets[0]!.providerAuthConfigId;
    }],
    ['TAG_STATE', (targets) => {
      targets[1]!.bindingIdentities.TAG_STATE = targets[0]!.bindingIdentities.TAG_STATE;
    }],
    ['evidence root', (targets) => { targets[1]!.evidenceRoot = targets[0]!.evidenceRoot; }],
  ];
  for (const [name, mutate] of cases) {
    const targets = structuredClone(f.targets) as Array<Record<string, any>>;
    mutate(targets);
    assert.throws(() => createEnvironmentRegistry({
      root: join(f.parent, `duplicate-${name.replaceAll(' ', '-')}`),
      hostFingerprint: 'host-fixture',
      targets,
      sandbox: {
        archiveDate: '2027-01-15T00:00:00.000Z',
        workspaceSlotsTotal: 5,
        workspaceSlotsUsed: 3,
        integrationHeadroom: 37,
      },
    }), rejectsCode('DUPLICATE_TARGET_IDENTITY'), name);
  }
});

test('gateway lanes may share the app while retaining separate workspace and deployment identities', (context) => {
  const f = fixture((targets) => {
    for (const target of targets) {
      target.transport = 'gateway';
      target.slackAppId = 'A_SHARED_CHICKPEA';
      target.slackAppLabel = 'Chickpea';
    }
  });
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const registry = readEnvironmentRegistry(registryOptions(f.root));
  assert.equal(new Set(Object.values(registry.targets).map((target: any) => target.slackAppId)).size, 1);
  assert.equal(new Set(Object.values(registry.targets).map((target: any) => target.workspaceId)).size, 2);
  const claimed = claimEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  assert.equal(claimed.target, 'amber');
});

test('an Events lane cannot share an app ID with a gateway lane in either order', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  for (const eventIndex of [0, 1]) {
    const targets = structuredClone(f.targets) as Array<Record<string, any>>;
    targets[0]!.transport = 'gateway';
    targets[1]!.transport = 'gateway';
    targets[eventIndex]!.transport = 'events';
    targets[1]!.slackAppId = targets[0]!.slackAppId;
    assert.throws(() => createEnvironmentRegistry({
      root: join(f.parent, `mixed-${eventIndex}`), hostFingerprint: 'host-fixture', targets,
      sandbox: { archiveDate: '2027-01-15T00:00:00.000Z', workspaceSlotsTotal: 5, workspaceSlotsUsed: 3, integrationHeadroom: 37 },
    }), rejectsCode('DUPLICATE_TARGET_IDENTITY'));
  }
});

test('claim marker and worktree safety are preflighted before central mutation', (context) => {
  const f = fixture();
  const unsafe = worktree(f.parent, 'unsafe');
  const linked = worktree(f.parent, 'linked-marker');
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const registryPath = join(f.root, 'registry.json');
  const before = readFileSync(registryPath, 'utf8');
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root),
    worktreePath: f.first.path,
    beforeMarkerWrite: () => { throw new Error('injected marker failure'); },
  }), /injected marker failure/u);
  assert.equal(readFileSync(registryPath, 'utf8'), before);
  assert.equal(existsSync(environmentMarkerPath(f.first.path)), false);

  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root),
    expectedUid: (typeof process.getuid === 'function' ? process.getuid() : 0) + 1,
    worktreePath: unsafe.path,
  }), rejectsCode('NON_OWNER_FILE'));
  assert.equal(readFileSync(registryPath, 'utf8'), before);

  chmodSync(unsafe.path, 0o777);
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: unsafe.path,
  }), rejectsCode('UNSAFE_PERMISSIONS'));
  assert.equal(readFileSync(registryPath, 'utf8'), before);

  writeFileSync(join(linked.path, 'marker-target'), '{}\n', { mode: 0o600 });
  symlinkSync(join(linked.path, 'marker-target'), environmentMarkerPath(linked.path));
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: linked.path,
  }), rejectsCode('SYMLINK_REFUSED'));
  assert.equal(readFileSync(registryPath, 'utf8'), before);
});

test('evidence roots refuse symlink leaves and parents before lock inspection', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const realEvidence = join(f.parent, 'real-evidence');
  mkdirSync(realEvidence, { mode: 0o700 });
  rmSync(join(f.parent, 'amber', 'evidence'), { recursive: true, force: true });
  symlinkSync(realEvidence, join(f.parent, 'amber', 'evidence'));
  assert.equal(
    readEnvironmentStatus({ ...registryOptions(f.root), target: 'amber' }).targets[0]?.health,
    'identity_mismatch',
  );

  rmSync(join(f.parent, 'amber', 'evidence'));
  mkdirSync(join(f.parent, 'amber', 'evidence'), { mode: 0o700 });
  writeFileSync(join(f.parent, 'lock-target'), '{}\n', { mode: 0o600 });
  symlinkSync(join(f.parent, 'lock-target'), join(f.parent, 'amber', 'evidence', 'target.lock'));
  assert.equal(
    readEnvironmentStatus({ ...registryOptions(f.root), target: 'amber' }).targets[0]?.health,
    'identity_mismatch',
  );

  rmSync(join(f.parent, 'amber'), { recursive: true, force: true });
  const linkedParentTarget = join(f.parent, 'linked-evidence-parent-target');
  mkdirSync(linkedParentTarget, { mode: 0o700 });
  symlinkSync(linkedParentTarget, join(f.parent, 'amber'));
  assert.equal(
    readEnvironmentStatus({ ...registryOptions(f.root), target: 'amber' }).targets[0]?.health,
    'identity_mismatch',
  );
});

test('registry lock recovers a SIGKILLed same-host owner but never steals a live, foreign, or ambiguous lock', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const lockPath = join(f.root, 'registry.lock');
  const lock = (pid: number, hostFingerprint = 'host-fixture') => {
    writeFileSync(lockPath, `${JSON.stringify({
      pid,
      hostFingerprint,
      lockNonce: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date(NOW).toISOString(),
    })}\n`, { mode: 0o600 });
  };
  const killedOwner = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.LOCK_PATH, JSON.stringify({
      pid: process.pid,
      hostFingerprint: 'host-fixture',
      lockNonce: '11111111-1111-4111-8111-111111111111',
      createdAt: ${JSON.stringify(new Date(NOW).toISOString())},
    }) + '\\n', { mode: 0o600 });
    process.stdout.write('locked\\n');
    setInterval(() => undefined, 1_000);
  `], {
    env: { ...process.env, LOCK_PATH: lockPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    killedOwner.stdout.once('data', () => resolve());
    killedOwner.once('error', reject);
  });
  killedOwner.kill('SIGKILL');
  await new Promise<void>((resolve) => killedOwner.once('exit', () => resolve()));
  assert.equal(claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path, lockTimeoutMs: 25,
  }).target, 'amber');
  releaseEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });

  lock(process.pid);
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path, lockTimeoutMs: 25,
    isPidActive: () => true,
  }), rejectsCode('REGISTRY_BUSY'));
  rmSync(lockPath);
  lock(99_999_999, 'another-host');
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path, lockTimeoutMs: 25,
    isPidActive: () => false,
  }), rejectsCode('REGISTRY_LOCK_FOREIGN'));
  rmSync(lockPath);
  writeFileSync(lockPath, '{}\n', { mode: 0o600 });
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path, lockTimeoutMs: 25,
    isPidActive: () => false,
  }), rejectsCode('REGISTRY_LOCK_AMBIGUOUS'));
});

test('immutable revision snapshots recover a whole older registry file', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const registryPath = join(f.root, 'registry.json');
  const initial = readFileSync(registryPath, 'utf8');
  claimEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  const claimedRevision = readEnvironmentRegistry(registryOptions(f.root)).revision;
  writeFileSync(registryPath, initial, { mode: 0o600 });
  const recovered = readEnvironmentRegistry(registryOptions(f.root));
  assert.equal(recovered.revision, claimedRevision);
  assert.ok(recovered.targets.amber.claim);
});

test('snapshot-first crash ordering recovers the committed claim authority', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root),
    worktreePath: f.first.path,
    beforeRegistryCurrentWrite: () => { throw new Error('simulated crash'); },
  }), /simulated crash/u);
  const recovered = readEnvironmentRegistry(registryOptions(f.root));
  assert.equal(recovered.revision, 1);
  assert.ok(recovered.targets.amber.claim);
  assert.deepEqual(
    JSON.parse(readFileSync(environmentMarkerPath(f.first.path), 'utf8')),
    recovered.targets.amber.claim,
  );
});

test('immutable snapshot publication leaves no partial final at the pre-publish crash boundary', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const revisions = join(f.root, 'revisions');
  const staleTemporary = join(
    revisions,
    '.revision-0000000000000001.json.99999999.11111111-1111-4111-8111-111111111111.tmp',
  );
  writeFileSync(staleTemporary, '{"revision":', { mode: 0o600 });

  // A killed writer may leave only its private temporary file. Readers ignore
  // that non-authoritative residue, while the next locked mutation removes it.
  assert.equal(readEnvironmentRegistry(registryOptions(f.root)).revision, 0);
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root),
    worktreePath: f.first.path,
    beforeRegistrySnapshotPublish: () => { throw new Error('snapshot publish crash'); },
  }), /snapshot publish crash/u);
  assert.equal(existsSync(join(revisions, 'revision-0000000000000001.json')), false);
  assert.deepEqual(
    readdirSync(revisions).filter((entry) => entry.startsWith('.revision-')),
    [],
  );
  assert.equal(readEnvironmentRegistry(registryOptions(f.root)).revision, 0);

  const recovered = claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path,
  });
  assert.equal(readEnvironmentRegistry(registryOptions(f.root)).targets.amber.claim?.leaseNonce,
    recovered.leaseNonce);
});

test('immutable snapshot publication never overwrites a concurrently published revision', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', { ...registryOptions(f.root), worktreePath: f.first.path });
  const registryBefore = readFileSync(join(f.root, 'registry.json'), 'utf8');
  const current = readEnvironmentRegistry(registryOptions(f.root));
  const conflicting = structuredClone(current);
  conflicting.revision = 2;
  conflicting.targets.amber.reachable = false;
  const conflictBytes = `${JSON.stringify(conflicting)}\n`;
  const conflictPath = join(f.root, 'revisions', 'revision-0000000000000002.json');

  assert.throws(() => releaseEnvironment('amber', {
    ...registryOptions(f.root),
    worktreePath: f.first.path,
    beforeRegistrySnapshotPublish: () => {
      writeFileSync(conflictPath, conflictBytes, { flag: 'wx', mode: 0o600 });
    },
  }), rejectsCode('REGISTRY_REVISION_CONFLICT'));
  assert.equal(readFileSync(conflictPath, 'utf8'), conflictBytes);
  assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), registryBefore);
  assert.equal(existsSync(environmentMarkerPath(f.first.path)), true);
});

test('claim and release crash leftovers are repaired without overwriting a live central claim', (context) => {
  const f = fixture();
  const second = worktree(f.parent, 'orphan-holder');
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const registryPath = join(f.root, 'registry.json');
  const initialRegistry = readFileSync(registryPath, 'utf8');

  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root),
    worktreePath: f.first.path,
    beforeRegistrySnapshotWrite: () => { throw new Error('marker-before-registry crash'); },
  }), /marker-before-registry crash/u);
  assert.equal(readFileSync(registryPath, 'utf8'), initialRegistry);
  assert.equal(readEnvironmentRegistry(registryOptions(f.root)).targets.amber.claim, null);
  assert.equal(existsSync(environmentMarkerPath(f.first.path)), true);

  const recoveredClaim = claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path,
  });
  assert.equal(readEnvironmentRegistry(registryOptions(f.root)).targets.amber.claim?.leaseNonce,
    recoveredClaim.leaseNonce);

  assert.throws(() => releaseEnvironment('amber', {
    ...registryOptions(f.root),
    worktreePath: f.first.path,
    beforeMarkerUnlink: () => { throw new Error('registry-before-unlink crash'); },
  }), /registry-before-unlink crash/u);
  assert.equal(readEnvironmentRegistry(registryOptions(f.root)).targets.amber.claim, null);
  assert.equal(existsSync(environmentMarkerPath(f.first.path)), true);
  const reconciled = reconcileEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path,
  });
  assert.equal(reconciled.repairedOrphanMarker, true);
  assert.equal(existsSync(environmentMarkerPath(f.first.path)), false);

  const live = claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path,
  });
  const conflictingMarker = {
    ...live,
    canonicalWorktreePath: second.path,
    branch: second.branch,
    claimedRevision: second.revision,
  };
  writeFileSync(environmentMarkerPath(second.path), `${JSON.stringify(conflictingMarker)}\n`, { mode: 0o600 });
  const beforeConflict = readFileSync(registryPath, 'utf8');
  assert.throws(() => claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: second.path,
  }), rejectsCode('TARGET_CLAIMED'));
  assert.equal(readFileSync(registryPath, 'utf8'), beforeConflict);
  assert.deepEqual(
    JSON.parse(readFileSync(environmentMarkerPath(second.path), 'utf8')),
    conflictingMarker,
  );
});

test('status reads an existing machine identity without creating or rewriting it', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const identityPath = join(f.parent, 'status-machine-identity.json');
  const hostFingerprint = currentHostFingerprint({ identityPath });
  const root = join(f.parent, 'status-identity-registry');
  createEnvironmentRegistry({
    root,
    hostFingerprint,
    targets: f.targets,
    sandbox: {
      archiveDate: '2027-01-15T00:00:00.000Z',
      workspaceSlotsTotal: 5,
      workspaceSlotsUsed: 3,
      integrationHeadroom: 37,
    },
  });
  const identityBefore = readFileSync(identityPath, 'utf8');
  const identityStatBefore = lstatSync(identityPath);
  assert.equal(readEnvironmentStatus({ root, identityPath }).registryRevision, 0);
  const identityStatAfter = lstatSync(identityPath);
  assert.equal(readFileSync(identityPath, 'utf8'), identityBefore);
  assert.equal(identityStatAfter.mtimeMs, identityStatBefore.mtimeMs);
  assert.equal(identityStatAfter.mode & 0o777, 0o600);

  rmSync(identityPath);
  const parentModeBefore = lstatSync(f.parent).mode & 0o777;
  assert.throws(
    () => readEnvironmentStatus({ root, identityPath }),
    rejectsCode('MACHINE_IDENTITY_MISSING'),
  );
  assert.equal(existsSync(identityPath), false);
  assert.equal(lstatSync(f.parent).mode & 0o777, parentModeBefore);
});

test('initialization refuses missing, linked, non-owner, and non-0700 evidence roots before commit', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const validEvidence = f.targets.map((target: { evidenceRoot: string }) => target.evidenceRoot);
  const missing = join(f.parent, 'missing-evidence');
  const unsafe = join(f.parent, 'unsafe-evidence');
  mkdirSync(unsafe, { mode: 0o755 });
  const leafTarget = join(f.parent, 'leaf-target');
  const leafLink = join(f.parent, 'leaf-link');
  mkdirSync(leafTarget, { mode: 0o700 });
  symlinkSync(leafTarget, leafLink);
  const parentTarget = join(f.parent, 'evidence-parent-target');
  const parentLink = join(f.parent, 'evidence-parent-link');
  mkdirSync(join(parentTarget, 'nested'), { recursive: true, mode: 0o700 });
  symlinkSync(parentTarget, parentLink);
  const cases = [
    { name: 'missing', evidenceRoot: missing, expectedUid: undefined },
    { name: 'unsafe-mode', evidenceRoot: unsafe, expectedUid: undefined },
    { name: 'leaf-symlink', evidenceRoot: leafLink, expectedUid: undefined },
    { name: 'parent-symlink', evidenceRoot: join(parentLink, 'nested'), expectedUid: undefined },
    {
      name: 'non-owner',
      evidenceRoot: validEvidence[0]!,
      expectedUid: (typeof process.getuid === 'function' ? process.getuid() : 0) + 1,
    },
  ];
  for (const { name, evidenceRoot, expectedUid } of cases) {
    const root = join(f.parent, `invalid-evidence-${name}`);
    const targets = structuredClone(f.targets);
    targets[0]!.evidenceRoot = evidenceRoot;
    assert.throws(() => createEnvironmentRegistry({
      root,
      hostFingerprint: 'host-fixture',
      targets,
      ...(expectedUid === undefined ? {} : { expectedUid }),
      sandbox: {
        archiveDate: '2027-01-15T00:00:00.000Z',
        workspaceSlotsTotal: 5,
        workspaceSlotsUsed: 3,
        integrationHeadroom: 37,
      },
    }), (error: unknown) => error instanceof EnvironmentRegistryError
      && ['UNSAFE_EVIDENCE_ROOT', 'SYMLINK_REFUSED', 'UNSAFE_PERMISSIONS', 'NON_OWNER_FILE']
        .includes((error as { code: string }).code), name);
    assert.equal(existsSync(root), false, name);
  }
});

test('two processes cannot initialize distinct inventories into one registry root', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const root = join(f.parent, 'concurrent-initialization');
  const inputPath = (name: string, label: string) => {
    const file = join(f.parent, `inventory-${name}.json`);
    const targets = structuredClone(f.targets);
    targets[0]!.workspaceLabel = label;
    writeFileSync(file, JSON.stringify({
      root,
      hostFingerprint: 'host-fixture',
      targets,
      sandbox: {
        archiveDate: '2027-01-15T00:00:00.000Z',
        workspaceSlotsTotal: 5,
        workspaceSlotsUsed: 3,
        integrationHeadroom: 37,
      },
    }));
    return file;
  };
  const moduleUrl = new URL('../scripts/lib/environment-registry.mjs', import.meta.url).href;
  const runner = `
    import { readFileSync } from 'node:fs';
    import { createEnvironmentRegistry } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(readFileSync(process.env.INVENTORY, 'utf8'));
    try {
      createEnvironmentRegistry({
        ...input,
        beforeInitializeCommit: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100),
      });
      process.stdout.write('CREATED');
    } catch (error) {
      process.stdout.write(error.code ?? error.message);
    }
  `;
  const run = (inventory: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', runner], {
      env: { ...process.env, INVENTORY: inventory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  const results = await Promise.all([
    run(inputPath('a', 'amber workspace A')),
    run(inputPath('b', 'amber workspace B')),
  ]);
  assert.deepEqual(results.sort(), ['CREATED', 'REGISTRY_EXISTS']);
  assert.match(readEnvironmentRegistry(registryOptions(root)).targets.amber.workspaceLabel, / A$| B$/u);
});

test('another process never observes an unpublished registry lock owner', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const second = worktree(f.parent, 'second');
  const moduleUrl = new URL('../scripts/lib/environment-registry.mjs', import.meta.url).href;
  let probed = false;
  claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path,
    beforeRegistryLockPublish: () => {
      probed = true;
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import { claimEnvironment } from ${JSON.stringify(moduleUrl)};
        try {
          claimEnvironment('cobalt', ${JSON.stringify({ root: f.root, hostFingerprint: 'host-fixture', worktreePath: second.path })});
          process.stdout.write('claimed');
        } catch (error) { process.stdout.write(error.code ?? error.message); }
      `], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'claimed');
    },
  });
  assert.equal(probed, true);
  const registered = readEnvironmentRegistry(registryOptions(f.root));
  assert.equal(registered.targets.amber.claim.canonicalWorktreePath, f.first.path);
  assert.equal(registered.targets.cobalt.claim.canonicalWorktreePath, second.path);
  assert.equal(existsSync(join(f.root, 'registry.lock')), false);
  assert.equal(readdirSync(f.root).some((name) => name.startsWith('.registry-lock-')), false);
});

test('attestation binds registration source and serving identity and rechecks expiry before record', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const observation = {
    targetAlias: 'amber', transport: 'events', workerName: 'chickpea-amber-live',
    deployments: [{ versionId: 'version-amber', percentage: 100, activatedAt: new Date(NOW - 1_000).toISOString() }],
    bindingIdentities: { AUTH_DB: 'd1-amber', TAG_STATE: 'tag-state-amber' },
    slack: { teamId: 'T_AMBER', appId: 'A_AMBER' },
    provider: { projectId: 'provider-amber', authConfigId: 'provider-read-amber' },
    timezone: 'America/Los_Angeles', evidenceRoot: join(f.parent, 'amber', 'evidence'),
    events: {
      installationHealthy: true, signedEventReceiptFresh: true,
      signedEventReceiptVersionId: 'version-amber', signedEventReceiptAt: new Date(NOW).toISOString(),
      installationRevision: 1,
    },
  };

  writeFileSync(join(f.first.path, 'dirty.txt'), 'uncommitted\n');
  claimEnvironment('amber', {
    ...registryOptions(f.root), worktreePath: f.first.path, leaseDurationMs: 1_000,
  });
  await assert.rejects(attestEnvironment('amber', observation, {
    ...registryOptions(f.root), worktreePath: f.first.path, allowSuppliedObservation: true,
  }), rejectsCode('SOURCE_IDENTITY_MISMATCH'));
  rmSync(join(f.first.path, 'dirty.txt'));

  const wrongVersion = structuredClone(observation);
  wrongVersion.deployments[0]!.versionId = 'version-unregistered';
  wrongVersion.events.signedEventReceiptVersionId = 'version-unregistered';
  await assert.rejects(attestEnvironment('amber', wrongVersion, {
    ...registryOptions(f.root), worktreePath: f.first.path, allowSuppliedObservation: true,
  }), rejectsCode('SERVING_VERSION_MISMATCH'));

  let calls = 0;
  await assert.rejects(attestEnvironment('amber', observation, {
    ...registryOptions(f.root),
    now: () => (calls++ === 0 ? NOW + 500 : NOW + 1_500),
    worktreePath: f.first.path, allowSuppliedObservation: true,
  }), rejectsCode('CLAIM_EXPIRED_RECLAIM_REQUIRED'));
  assert.equal(readEnvironmentRegistry({ ...registryOptions(f.root), now: () => NOW + 500 })
    .targets.amber.lastAttestation, null);

  reclaimEnvironment('amber', {
    ...registryOptions(f.root), now: () => NOW + 2_000,
    worktreePath: f.first.path, leaseDurationMs: 60_000,
  });
  await assert.rejects(attestEnvironment('amber', observation, {
    ...registryOptions(f.root), now: () => NOW + 2_500,
    worktreePath: f.first.path, allowSuppliedObservation: true,
    beforeAttestationRecord: () => reclaimEnvironment('amber', {
      ...registryOptions(f.root), now: () => NOW + 2_500,
      worktreePath: f.first.path, leaseDurationMs: 60_000,
    }),
  }), rejectsCode('CLAIM_CHANGED'));
  assert.equal(readEnvironmentRegistry({ ...registryOptions(f.root), now: () => NOW + 2_500 })
    .targets.amber.lastAttestation, null);

  const directResult = {
    doctorSnapshot: {
      repositoryRevision: f.first.revision,
      servingVersion: 'version-unregistered',
      lock: { status: 'clear' },
    },
    attestation: {
      servingVersion: 'version-unregistered',
      targetFingerprint: `sha256:${'0'.repeat(64)}`,
    },
  };
  assert.throws(() => recordEnvironmentAttestation('amber', directResult, {
    ...registryOptions(f.root), now: () => NOW + 2_500, worktreePath: f.first.path,
  }), rejectsCode('SERVING_VERSION_MISMATCH'));
  directResult.doctorSnapshot.repositoryRevision = 'abcdef0123456789';
  directResult.doctorSnapshot.servingVersion = 'version-amber';
  directResult.attestation.servingVersion = 'version-amber';
  assert.throws(() => recordEnvironmentAttestation('amber', directResult, {
    ...registryOptions(f.root), now: () => NOW + 2_500, worktreePath: f.first.path,
  }), rejectsCode('SOURCE_IDENTITY_MISMATCH'));
});
