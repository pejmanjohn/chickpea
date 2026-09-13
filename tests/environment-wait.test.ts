import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Executable JavaScript modules intentionally have no declarations.
import * as environmentRegistryModule from '../scripts/lib/environment-registry.mjs';
// @ts-expect-error Executable JavaScript modules intentionally have no declarations.
import { EnvironmentWaitError, waitForEnvironmentClaim } from '../scripts/lib/environment-wait.mjs';
// @ts-expect-error Executable JavaScript modules intentionally have no declarations.
import { runEnvironmentCli } from '../scripts/chickpea-environment.mjs';

const {
  createEnvironmentRegistry,
  claimEnvironment,
  readEnvironmentRegistry,
  releaseEnvironment,
} = environmentRegistryModule;

function rejectsWaitCode(code: string) {
  return (error: unknown) => error instanceof EnvironmentWaitError
    && (error as { code?: unknown }).code === code;
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function worktree(parent: string, name: string) {
  const directory = realpathSync(mkdtempSync(join(parent, `${name}-`)));
  git(directory, 'init', '-b', `feature/${name}`);
  git(directory, 'config', 'user.email', 'fixture@example.test');
  git(directory, 'config', 'user.name', 'Fixture');
  writeFileSync(join(directory, '.gitignore'), '.chickpea-environment\n');
  writeFileSync(join(directory, 'fixture.txt'), `${name}\n`);
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'fixture');
  return directory;
}

function target(target: 'amber' | 'cobalt', revision: string, parent: string) {
  const evidenceRoot = join(parent, target, 'evidence');
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
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
    providerAuthConfigId: `provider-${target}-auth`,
    timezone: 'America/Los_Angeles',
    evidenceRoot,
    bindingIdentities: { AUTH_DB: `d1-${target}`, TAG_STATE: `tag-${target}` },
    schemaGeneration: 'd1:0002;do:v9',
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

function fixture(mutate?: (targets: any[]) => void) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-wait-test-')));
  const first = worktree(parent, 'first');
  const second = worktree(parent, 'second');
  const third = worktree(parent, 'third');
  const root = join(parent, 'registry');
  const targets = [target('amber', git(first, 'rev-parse', 'HEAD'), parent),
    target('cobalt', git(first, 'rev-parse', 'HEAD'), parent)];
  mutate?.(targets);
  createEnvironmentRegistry({
    root,
    hostFingerprint: 'wait-test-host',
    targets,
    sandbox: null,
  });
  return { parent, root, first, second, third };
}

function options(root: string, worktreePath: string) {
  return { root, worktreePath, hostFingerprint: 'wait-test-host' };
}

test('wait-claim acquires a healthy free lane and reuses only its exact matching claim', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const acquired = await waitForEnvironmentClaim('any', {
    ...options(f.root, f.first), timeoutMs: 100, pollMs: 250,
  });
  assert.equal(acquired.kind, 'acquired');
  assert.equal(acquired.target, 'amber');
  assert.equal(acquired.reused, false);
  const reused = await waitForEnvironmentClaim('amber', {
    ...options(f.root, f.first), timeoutMs: 0, pollMs: 250,
  });
  assert.equal(reused.kind, 'acquired');
  assert.equal(reused.reused, true);
  await assert.rejects(waitForEnvironmentClaim('cobalt', {
    ...options(f.root, f.first), timeoutMs: 0, pollMs: 250,
  }), rejectsWaitCode('WAIT_WORKTREE_ALREADY_CLAIMED'));
});

test('wait-claim observes contention changes and acquires after the holder releases', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', options(f.root, f.first));
  const changes: unknown[] = [];
  setTimeout(() => releaseEnvironment('amber', options(f.root, f.first)), 15);
  const result = await waitForEnvironmentClaim('amber', {
    ...options(f.root, f.second), timeoutMs: 500, pollMs: 250,
    onStatusChange: (status: unknown) => changes.push(status),
  });
  assert.equal(result.kind, 'acquired');
  assert.equal(result.target, 'amber');
  assert.ok(result.waitedMs >= 0);
  assert.ok(changes.length >= 2);
});

test('wait-claim timeout has its own CLI exit and never changes held claims', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const amber = claimEnvironment('amber', options(f.root, f.first));
  claimEnvironment('cobalt', options(f.root, f.second));
  const before = readFileSync(join(f.root, 'registry.json'), 'utf8');
  let stdout = '';
  let stderr = '';
  const code = await runEnvironmentCli([
    'wait-claim', 'any', '--root', f.root, '--worktree', f.third,
    '--timeout-ms', '10', '--poll-ms', '250',
  ], {
    hostFingerprint: 'wait-test-host',
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
  });
  assert.equal(code, 3, stderr);
  assert.equal(JSON.parse(stdout).kind, 'timeout');
  assert.match(stderr, /amber=claimed cobalt=claimed/u);
  assert.equal(readFileSync(join(f.root, 'registry.json'), 'utf8'), before);
  assert.equal(readEnvironmentRegistry(options(f.root, f.third)).targets.amber.claim.leaseNonce,
    amber.leaseNonce);
});

test('wait-claim treats a live verifier lock as contention without claiming the lane', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  writeFileSync(join(f.parent, 'amber', 'evidence', 'target.lock'), `${JSON.stringify({
    runId: 'fixture-run',
    pid: 1234,
    host: 'fixture-host',
    startedAt: '2026-09-13T12:00:00.000Z',
  })}\n`, { mode: 0o600 });
  const result = await waitForEnvironmentClaim('amber', {
    ...options(f.root, f.first), timeoutMs: 10, pollMs: 250,
    lockHost: 'fixture-host',
    isPidActive: () => true,
  });
  assert.equal(result.kind, 'timeout');
  assert.equal(readEnvironmentRegistry(options(f.root, f.first)).targets.amber.claim, null);
});

test('wait-claim stops on cancellation and source drift without leaking a claim', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', options(f.root, f.first));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(waitForEnvironmentClaim('amber', {
    ...options(f.root, f.second), timeoutMs: 500, pollMs: 250, signal: controller.signal,
  }), rejectsWaitCode('WAIT_CANCELLED'));
  assert.equal(readEnvironmentRegistry(options(f.root, f.second)).targets.amber.claim
    .canonicalWorktreePath, f.first);

  let reads = 0;
  await assert.rejects(waitForEnvironmentClaim('amber', {
    ...options(f.root, f.second), timeoutMs: 500, pollMs: 250,
    readHead: () => (++reads < 3 ? 'a'.repeat(40) : 'b'.repeat(40)),
  }), rejectsWaitCode('WAIT_SOURCE_HEAD_CHANGED'));
  assert.equal(readEnvironmentRegistry(options(f.root, f.second)).targets.amber.claim
    .canonicalWorktreePath, f.first);
});

test('wait-claim releases a claim when cancellation lands during its atomic acquisition', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const controller = new AbortController();
  await assert.rejects(waitForEnvironmentClaim('amber', {
    ...options(f.root, f.first), timeoutMs: 100, pollMs: 250,
    signal: controller.signal,
    beforeRegistryCurrentWrite: () => controller.abort(),
  }), rejectsWaitCode('WAIT_CANCELLED'));
  assert.equal(readEnvironmentRegistry(options(f.root, f.first)).targets.amber.claim, null);
  assert.equal(readEnvironmentRegistry(options(f.root, f.first)).targets.cobalt.claim, null);
});

test('wait-claim does not acquire on a later poll after its deadline', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', options(f.root, f.first));
  let monotonicMs = 0;
  const result = await waitForEnvironmentClaim('amber', {
    ...options(f.root, f.second), timeoutMs: 10, pollMs: 250,
    monotonicNow: () => monotonicMs,
    sleep: async () => {
      releaseEnvironment('amber', options(f.root, f.first));
      monotonicMs = 11;
    },
  });
  assert.equal(result.kind, 'timeout');
  assert.equal(result.waitedMs, 11);
  assert.equal(readEnvironmentRegistry(options(f.root, f.second)).targets.amber.claim, null);
});

test('wait-claim does not retry an unhealthy free lane', async (t) => {
  const f = fixture((targets) => { targets[0].reachable = false; });
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  await assert.rejects(waitForEnvironmentClaim('amber', {
    ...options(f.root, f.first), timeoutMs: 100, pollMs: 250,
  }), rejectsWaitCode('WAIT_ENVIRONMENT_NOT_RETRYABLE'));
  assert.equal(readEnvironmentRegistry(options(f.root, f.first)).targets.amber.claim, null);
});

test('wait-claim leaves orphan marker evidence for explicit reconciliation', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const marker = join(f.first, '.chickpea-environment');
  writeFileSync(marker, '{"orphaned":true}\n', { mode: 0o600 });
  await assert.rejects(waitForEnvironmentClaim('amber', {
    ...options(f.root, f.first), timeoutMs: 100, pollMs: 250,
  }), rejectsWaitCode('WAIT_ORPHAN_MARKER_REQUIRES_RECONCILIATION'));
  assert.equal(readFileSync(marker, 'utf8'), '{"orphaned":true}\n');
  assert.equal(readEnvironmentRegistry(options(f.root, f.first)).targets.amber.claim, null);
});

test('wait-claim enforces production timeout and polling bounds', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  await assert.rejects(waitForEnvironmentClaim('amber', {
    ...options(f.root, f.first), timeoutMs: 100, pollMs: 249,
  }), rejectsWaitCode('INVALID_WAIT_POLL'));
  await assert.rejects(waitForEnvironmentClaim('amber', {
    ...options(f.root, f.first), timeoutMs: 7_200_001, pollMs: 250,
  }), rejectsWaitCode('INVALID_WAIT_TIMEOUT'));
  assert.equal(readEnvironmentRegistry(options(f.root, f.first)).targets.amber.claim, null);
});

test('two waiters cannot both acquire the same free lane', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const results = await Promise.all([
    waitForEnvironmentClaim('amber', {
      ...options(f.root, f.first), timeoutMs: 40, pollMs: 250,
    }),
    waitForEnvironmentClaim('amber', {
      ...options(f.root, f.second), timeoutMs: 40, pollMs: 250,
    }),
  ]);
  assert.deepEqual(results.map(({ kind }: { kind: string }) => kind).sort(), ['acquired', 'timeout']);
  const registry = readEnvironmentRegistry(options(f.root, f.third));
  assert.ok([f.first, f.second].includes(registry.targets.amber.claim.canonicalWorktreePath));
});
