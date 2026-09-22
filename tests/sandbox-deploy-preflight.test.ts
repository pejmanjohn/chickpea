import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  boundProfile,
  checkDockerDaemon,
  classifyContainersAccess,
  containersReauthInstruction,
  parseListedScopes,
  prebuildSandboxImage,
  pullBaseImage,
  rerunCommand,
  resolveWranglerAuth,
  sandboxApplicationName,
  sandboxBaseImage,
  uploadedBeforeFailure,
  useSandboxImage,
  verifySandboxContainerApplication,
  // @ts-expect-error Release tooling JavaScript helper.
} from '../scripts/lib/sandbox-deploy-preflight.mjs';

type Run = { status: number | null; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException };

// The exact output shape Wrangler 4.124 printed for the acme profile.
const MISSING_SCOPE_OUTPUT = [
  "✘ [ERROR] You don't have 'containers:write' in your list of scopes",
  '┌──────────────────────┬─────────────┐',
  '│ Scope                │ Description │',
  '├──────────────────────┼─────────────┤',
  ...['user:read', 'account:read', 'workers:write', 'workers_scripts:write', 'workers_tail:read', 'd1:write', 'ai:write', 'offline_access']
    .map((scope) => `│ ${scope.padEnd(20)} │ something   │`),
  '└──────────────────────┴─────────────┘',
  "✘ [ERROR] You need 'containers:write', try logging in again or creating an appropiate API token",
].join('\n');

test('missing containers:write keeps existing scopes, drops offline_access, and uses auth create', () => {
  const access = classifyContainersAccess({ status: 1, stdout: '', stderr: MISSING_SCOPE_OUTPUT });
  assert.equal(access.reason, 'scope');
  assert.deepEqual(access.scopes, ['user:read', 'account:read', 'workers:write', 'workers_scripts:write', 'workers_tail:read', 'd1:write', 'ai:write']);
  const instruction = containersReauthInstruction({ kind: 'profile', profile: 'acme' }, access.scopes, '/srv/install');
  assert.match(instruction, /From \/srv\/install, run:/);
  assert.match(instruction, /\n {4}npx wrangler auth create acme --scopes user:read account:read workers:write workers_scripts:write workers_tail:read d1:write ai:write containers:write\n/);
  assert.doesNotMatch(instruction.split('\n').find((line: string) => line.includes('npx')) ?? '', /offline_access|--profile|login/);
});

test('the global login and unknown scopes get commands Wrangler accepts', () => {
  assert.match(containersReauthInstruction({ kind: 'global' }, ['account:read', 'offline_access']), /\n {4}npx wrangler login --scopes account:read containers:write\n/);
  const fallback = containersReauthInstruction({ kind: 'profile', profile: 'acme' }, []);
  assert.match(fallback, /\n {4}npx wrangler auth create acme\n/);
  assert.match(fallback, /default scope set, which includes containers:write/);
  assert.match(containersReauthInstruction({ kind: 'api-token' }), /Containers: Edit/);
});

test('auth mode follows the flags, the directory binding, then the global login', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-auth-mode-'));
  try {
    const listing = `│ Profile │ Bound Directories │\n│ outer │ ${path.dirname(root)} │\n│ inner │ ${root} │\n`;
    assert.equal(boundProfile(listing, path.join(root, 'nested')), 'inner');
    assert.deepEqual(resolveWranglerAuth({ env: {}, providerContext: ['--profile', 'acme'], projectRoot: root, listProfiles: () => listing }),
      { kind: 'profile', profile: 'acme', explicit: true });
    assert.deepEqual(resolveWranglerAuth({ env: {}, projectRoot: root, listProfiles: () => listing }),
      { kind: 'profile', profile: 'inner', explicit: false });
    assert.deepEqual(resolveWranglerAuth({ env: {}, projectRoot: root, listProfiles: () => 'No profiles found.' }), { kind: 'global' });
    assert.deepEqual(resolveWranglerAuth({ env: { CLOUDFLARE_API_TOKEN: 't' }, providerContext: ['--profile', 'x'] }), { kind: 'api-token' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('containers access failures are classified without echoing Wrangler output', () => {
  assert.deepEqual(classifyContainersAccess({ status: 0, stdout: '[]' }), { ok: true, apps: [] });
  assert.equal(classifyContainersAccess({ status: 1, stderr: 'Authentication error [code: 10000]' }).reason, 'denied');
  assert.equal(classifyContainersAccess({ status: 1, stderr: 'Your account is not entitled to use Containers' }).reason, 'plan');
  assert.equal(classifyContainersAccess({ status: 1, stderr: 'socket hang up' }).reason, 'unknown');
  assert.deepEqual(parseListedScopes('│ offline_access │ x │\n│ zone:read │ y │'), ['zone:read']);
});

test('Docker checks distinguish a missing binary from a stopped daemon and retry pulls', () => {
  const missing = checkDockerDaemon({ env: {}, run: (): Run => ({ status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) });
  assert.match(missing, /not installed or not on PATH/);
  const stopped = checkDockerDaemon({ env: {}, run: (): Run => ({ status: 1, stderr: 'Cannot connect to the Docker daemon' }) });
  assert.match(stopped, /daemon is not reachable/);
  assert.equal(checkDockerDaemon({ env: { WRANGLER_DOCKER_BIN: '/opt/docker' }, run: (command: string): Run => {
    assert.equal(command, '/opt/docker');
    return { status: 0, stdout: '28.0.0' };
  } }), undefined);

  let pulls = 0;
  const sleeps: number[] = [];
  const pulled = pullBaseImage({ env: {}, image: 'docker.io/cloudflare/sandbox:0.12.4', sleep: (ms: number) => sleeps.push(ms),
    run: (_: string, args: string[]): Run => {
      pulls += 1;
      assert.deepEqual(args, ['pull', '--platform', 'linux/amd64', 'docker.io/cloudflare/sandbox:0.12.4']);
      return { status: pulls < 3 ? 1 : 0 };
    } });
  assert.equal(pulled, undefined);
  assert.deepEqual(sleeps, [5_000, 10_000]);
  const failed = pullBaseImage({ env: {}, image: 'img:1', sleep: () => {}, run: (): Run => ({ status: 1 }) });
  assert.match(failed, /after 3 attempts.*Nothing was uploaded/s);
});

test('the base image comes from the Dockerfile and the application name from the artifact', () => {
  assert.equal(sandboxBaseImage('# comment\nFROM docker.io/cloudflare/sandbox:0.12.4\nRUN x'), 'docker.io/cloudflare/sandbox:0.12.4');
  assert.throws(() => sandboxBaseImage('FROM ${BASE}'), /no literal base image/);
  assert.equal(sandboxApplicationName({ name: 'chickpea-acme', containers: [{ class_name: 'Sandbox' }] }), 'chickpea-acme-sandbox');
  assert.equal(sandboxApplicationName({ name: 'x', containers: [{ class_name: 'Sandbox', name: 'custom' }] }), 'custom');
  const config = useSandboxImage({ containers: [{ class_name: 'Sandbox', image: '/abs/Dockerfile' }] }, 'app:tag');
  assert.equal(config.containers[0].image, 'app:tag');
});

test('the prebuild pushes from a Dockerfile-only context and retries before anything is live', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-prebuild-'));
  try {
    const dockerfilePath = path.join(root, 'Dockerfile');
    writeFileSync(dockerfilePath, 'FROM docker.io/cloudflare/sandbox:0.12.4\n');
    const calls: string[][] = [];
    const image = await prebuildSandboxImage({
      wranglerBin: '/w.js', projectRoot: root, configPath: '/cfg.json', providerContext: ['--profile', 'p'],
      dockerfilePath, applicationName: 'chickpea-x-sandbox', now: () => 36 ** 3, log: () => {}, sleepAsync: async () => {},
      stream: async (_: string, args: string[]) => {
        calls.push(args);
        return calls.length === 1
          ? { status: 1, output: 'DeadlineExceeded: context deadline exceeded' }
          : { status: 0, output: `pushing: registry.cloudflare.com/${'b'.repeat(32)}/${args[args.indexOf('--tag') + 1]}\n` };
      },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.slice(0, 3), ['/w.js', 'containers', 'build']);
    assert.ok(calls[0]!.includes('--push'));
    assert.deepEqual(calls[0]!.slice(-4), ['--config', '/cfg.json', '--profile', 'p']);
    assert.notEqual(calls[0]![3], root, 'the build context is a temporary Dockerfile-only directory');
    assert.match(image, new RegExp(`^registry\\.cloudflare\\.com/${'b'.repeat(32)}/chickpea-x-sandbox:[a-f0-9]{12}-1000$`));
    await assert.rejects(prebuildSandboxImage({
      wranglerBin: '/w.js', projectRoot: root, configPath: '/cfg.json', dockerfilePath, applicationName: 'a',
      log: () => {}, sleepAsync: async () => {}, stream: async () => ({ status: 1, output: '' }),
    }), /after 3 attempts\. Nothing was uploaded and the live Worker is unchanged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial-deploy detection and verification read Wrangler output honestly', () => {
  assert.equal(uploadedBeforeFailure('Total Upload: 1 KiB\nUploaded chickpea-acme (3.21 sec)\n'), true);
  assert.equal(uploadedBeforeFailure('Building image...\n'), false);
  assert.equal(rerunCommand({ explicitProductionTarget: true, deployArgs: ['--skip-build', '--profile', 'acme'] }),
    'CHICKPEA_DEPLOY_TARGET=production npm run deploy:sandbox -- --profile acme');
  assert.match(rerunCommand({ workersBuilds: true }), /Workers Builds.*CHICKPEA_DEPLOY_PROFILE=sandbox/);
  const verify = (stdout: string) => verifySandboxContainerApplication({
    wranglerBin: '/w.js', configPath: '/c', applicationName: 'chickpea-sandbox', run: (): Run => ({ status: 0, stdout }),
  });
  assert.equal(verify('[{"name":"chickpea-sandbox","state":"provisioning"}]').state, 'provisioning');
  assert.equal(verify('[{"name":"other","state":"active"}]').missing, true);
  assert.equal(verify('[{"name":"chickpea-sandbox","state":"<script>"}]').state, 'unknown');
});
