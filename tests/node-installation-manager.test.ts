import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SETUP_CAPABILITY_TTL_MS,
  controlSocketPath,
  controlledChildEnvironment,
  initInstallation,
  launchAgentIdentity,
  readRuntimeEnvironment,
  renewSetup,
  renderLaunchAgentPlist,
  runStart,
  sendControlCommand,
// @ts-expect-error Installer runtime is plain JavaScript shipped in release archives.
} from '../scripts/lib/node-installation.mjs';
// @ts-expect-error Installer runtime is plain JavaScript shipped in release archives.
import { isMainModule } from '../scripts/chickpea-node.mjs';

const COMMIT = 'a'.repeat(40);

interface Fixture {
  root: string;
  home: string;
  release: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-manager-'));
  const home = path.join(root, 'home with spaces');
  const release = path.join(home, 'releases', COMMIT);
  mkdirSync(path.join(home, 'tools', 'node', 'bin'), { recursive: true });
  mkdirSync(path.join(release, 'scripts'), { recursive: true });
  writeFileSync(path.join(home, '.installer-home'), 'chickpea-node-v1\n', { mode: 0o600 });
  mkdirSync(path.join(home, '.install-lock'), { mode: 0o700 });
  writeFileSync(path.join(release, 'release-source.json'), JSON.stringify({ commit: COMMIT }));
  linkSync(process.execPath, path.join(home, 'tools', 'node', 'bin', 'node'));
  chmodSync(path.join(home, 'tools', 'node', 'bin', 'node'), 0o755);
  return { root, home, release };
}

function init(f: Fixture, extra: Record<string, unknown> = {}) {
  return initInstallation({
    home: f.home,
    releaseRoot: f.release,
    origin: 'https://chickpea.example.com',
    port: 31_337,
    ...extra,
  });
}

test('fresh init creates private durable state and exact reruns preserve authority', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  await init(f);
  const envBefore = readFileSync(path.join(f.home, 'runtime.env'), 'utf8');
  const setupBefore = readFileSync(path.join(f.home, 'setup-url.txt'), 'utf8');
  const secretBefore = readRuntimeEnvironment(path.join(f.home, 'runtime.env')).CHICKPEA_AUTH_SECRET;

  assert.equal(lstatSync(f.home).mode & 0o777, 0o700);
  for (const directory of ['state', 'logs', 'control']) {
    assert.equal(lstatSync(path.join(f.home, directory)).mode & 0o777, 0o700);
  }
  for (const file of ['installation.json', 'runtime.env', 'setup-url.txt', 'control/token']) {
    assert.equal(lstatSync(path.join(f.home, file)).mode & 0o777, 0o600);
  }
  assert.match(setupBefore, /^https:\/\/chickpea\.example\.com\/admin\/setup#setup=[A-Za-z0-9_-]{43}\n$/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.home, 'installation.json'), 'utf8')), {
    schemaVersion: 1,
    sourceCommit: COMMIT,
    origin: 'https://chickpea.example.com',
    port: 31_337,
    tunnelMode: 'external',
  });

  await init(f);
  assert.equal(readFileSync(path.join(f.home, 'runtime.env'), 'utf8'), envBefore);
  assert.equal(readFileSync(path.join(f.home, 'setup-url.txt'), 'utf8'), setupBefore);
  assert.equal(readRuntimeEnvironment(path.join(f.home, 'runtime.env')).CHICKPEA_AUTH_SECRET, secretBefore);
});

test('init rejects changed config, unmanaged homes, and a current link outside managed releases', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await init(f);

  await assert.rejects(() => init(f, { port: 31_338 }), /does not match the managed installation/);
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(f.home, 'current'));
  await assert.rejects(() => init(f), /current.*managed release/);

  const unmanaged = fixture();
  t.after(() => rmSync(unmanaged.root, { recursive: true, force: true }));
  writeFileSync(path.join(unmanaged.home, 'runtime.env'), 'UNMANAGED=1\n');
  await assert.rejects(() => init(unmanaged), /unmanaged installer state/);
});

test('init rejects HTTP, loopback, and quick-tunnel origins', async (t) => {
  const fixtures = [fixture(), fixture(), fixture()];
  t.after(() => fixtures.forEach((f) => rmSync(f.root, { recursive: true, force: true })));
  await assert.rejects(() => init(fixtures[0]!, { origin: 'http://chickpea.example.com' }), /HTTPS origin/);
  await assert.rejects(() => init(fixtures[1]!, { origin: 'https://127.0.0.1' }), /stable public HTTPS hostname/);
  await assert.rejects(() => init(fixtures[2]!, { origin: 'https://random.trycloudflare.com' }), /stable public HTTPS hostname/);
});

test('init resumes an interrupted matching transaction without rotating secrets', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  await assert.rejects(() => init(f, { failAfterPublish: 'runtime.env' }), /simulated init interruption/);
  const stagedEnv = readFileSync(path.join(f.home, '.init-staging', 'runtime.env'), 'utf8');
  assert.equal(readFileSync(path.join(f.home, 'runtime.env'), 'utf8'), stagedEnv);

  await init(f);
  assert.equal(readFileSync(path.join(f.home, 'runtime.env'), 'utf8'), stagedEnv);
  assert.equal(existsSync(path.join(f.home, '.init-staging')), false);
});

test('cloudflare init copies one canonical private token and records prompt-free rerun paths', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const source = path.join(f.home, 'prompt-token');
  const cloudflared = path.join(f.home, 'tools', 'cloudflared');
  writeFileSync(source, 'secret-token\n', { mode: 0o600 });
  writeFileSync(cloudflared, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  await init(f, {
    tunnelMode: 'cloudflare',
    tunnelTokenFile: source,
    cloudflared,
  });
  const installation = JSON.parse(readFileSync(path.join(f.home, 'installation.json'), 'utf8'));
  assert.equal(readFileSync(source, 'utf8'), 'secret-token\n');
  assert.equal(readFileSync(path.join(f.home, 'tunnel-token.txt'), 'utf8'), 'secret-token\n');
  assert.equal(lstatSync(path.join(f.home, 'tunnel-token.txt')).mode & 0o777, 0o600);
  assert.equal(installation.tunnelMode, 'cloudflare');
  assert.equal(installation.tunnel.mode, 'cloudflare');
  assert.equal(installation.tunnel.tokenFile, path.join(realpathSync(f.home), 'tunnel-token.txt'));
});

test('child environment excludes ambient credentials and Node injection options', () => {
  const environment = controlledChildEnvironment('/private/node/bin', {
    HOME: '/Users/test',
    USER: 'test',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/private/tmp',
    SLACK_BOT_TOKEN: 'xoxb-secret',
    ANTHROPIC_API_KEY: 'provider-secret',
    NODE_OPTIONS: '--import=/tmp/inject.mjs',
    PATH: '/ambient/bin',
  });
  assert.deepEqual(environment, {
    HOME: '/Users/test',
    LANG: 'en_US.UTF-8',
    PATH: '/private/node/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: '/private/tmp',
    USER: 'test',
  });
});

test('foreground start owns its children and authenticated stop cannot target an unrelated PID', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await init(f);
  symlinkSync(f.release, path.join(f.home, 'current'));
  writeFileSync(path.join(f.release, 'scripts', 'start-node.mjs'), `
    import http from 'node:http';
    import { writeFileSync } from 'node:fs';
    import { parseEnv } from 'node:util';
    const file = process.argv[process.argv.indexOf('--env-file') + 1];
    const env = parseEnv(await import('node:fs').then(m => m.readFileSync(file, 'utf8')));
    writeFileSync(${JSON.stringify(path.join(f.root, 'child-env.json'))}, JSON.stringify(process.env));
    const server = http.createServer((_request, response) => response.end('ok'));
    server.listen(Number(env.PORT), '127.0.0.1');
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', stop);
  `);

  const unrelated = spawn('/bin/sleep', ['30']);
  t.after(() => unrelated.kill('SIGKILL'));
  const start = runStart(f.home, { installSignalHandlers: false, readinessTimeoutMs: 5_000 });
  await eventually(async () => (await sendControlCommand(f.home, 'status')).appReady === true);
  const result = await sendControlCommand(f.home, 'stop');
  assert.equal(result.accepted, true);
  assert.equal(await start, 0);
  assert.equal(unrelated.exitCode, null);

  const childEnv = JSON.parse(readFileSync(path.join(f.root, 'child-env.json'), 'utf8')) as Record<string, string>;
  assert.equal(childEnv.SLACK_BOT_TOKEN, undefined);
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.PATH?.split(':')[0]?.endsWith(path.join('tools', 'node', 'bin')), true);
});

test('expired setup renewal preserves auth authority and refuses an owned installation', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await init(f);
  const envPath = path.join(f.home, 'runtime.env');
  const initial = readRuntimeEnvironment(envPath);
  const expired = readFileSync(envPath, 'utf8').replace(
    /^CHICKPEA_SETUP_CAPABILITY_ISSUED_AT=.*$/m,
    `CHICKPEA_SETUP_CAPABILITY_ISSUED_AT=${Date.now() - SETUP_CAPABILITY_TTL_MS - 1}`,
  );
  writeFileSync(envPath, expired, { mode: 0o600 });

  await renewSetup(f.home);
  const renewed = readRuntimeEnvironment(envPath);
  assert.equal(renewed.CHICKPEA_AUTH_SECRET, initial.CHICKPEA_AUTH_SECRET);
  assert.notEqual(renewed.CHICKPEA_SETUP_CAPABILITY_DIGEST, initial.CHICKPEA_SETUP_CAPABILITY_DIGEST);

  const database = new DatabaseSync(path.join(f.home, 'state', 'state.sqlite'));
  database.exec(`
    CREATE TABLE identity_owner_claims (claim_key TEXT, status TEXT);
    INSERT INTO identity_owner_claims VALUES ('first_owner', 'active');
  `);
  database.close();
  await assert.rejects(() => renewSetup(f.home), /already has an owner/);
});

test('launchd plist escapes paths and uses a stable per-home identity', () => {
  const left = launchAgentIdentity('/tmp/chickpea-test/Chickpea & One');
  const same = launchAgentIdentity('/tmp/chickpea-test/Chickpea & One');
  const right = launchAgentIdentity('/tmp/chickpea-test/Chickpea Two');
  assert.equal(left, same);
  assert.notEqual(left, right);
  assert.match(left, /^co\.chickpea\.node\.[a-f0-9]{24}$/);

  const plist = renderLaunchAgentPlist({
    home: '/tmp/chickpea-test/Chickpea & <One>',
    node: '/tmp/chickpea-test/Chickpea & <One>/tools/node/bin/node',
    label: left,
  });
  assert.match(plist, /Chickpea &amp; &lt;One&gt;/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>90<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
});

test('control sockets stay under the macOS Unix socket limit and CLI main detection follows symlinks', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-main-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const longHome = path.join(root, 'x'.repeat(180));
  assert.ok(Buffer.byteLength(controlSocketPath(longHome)) < 104);
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chickpea-node.mjs');
  const link = path.join(root, 'chickpea-node.mjs');
  symlinkSync(script, link);
  assert.equal(isMainModule(link, pathToFileURL(script).href), true);
});

async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch { /* startup races are expected */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('condition was not reached before timeout');
}
