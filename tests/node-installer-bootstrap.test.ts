import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-node.sh');
const REAL_NODE = process.execPath;

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o700 });
  chmodSync(file, 0o700);
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Installer Test', '-c', 'user.email=test@example.invalid', '-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function createSource(root: string): { directory: string; sha: string } {
  const directory = path.join(root, 'source checkout');
  mkdirSync(path.join(directory, 'scripts'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'chickpea-test', private: true, version: '0.1.20' }));
  writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '0.1.20', lockfileVersion: 3, packages: { '': { version: '0.1.20' } } }));
  writeFileSync(path.join(directory, 'release.json'), JSON.stringify({ formatVersion: 1, version: '0.1.20' }));
  writeFileSync(path.join(directory, '.nvmrc'), '24.20.0\n');
  writeFileSync(path.join(directory, '.gitattributes'), 'release-source.json export-subst\n');
  writeFileSync(path.join(directory, 'release-source.json'), '{"commit":"$Format:%H$"}\n');
  writeFileSync(path.join(directory, 'scripts', 'install-node.sh'), '#!/bin/bash\n');
  writeFileSync(path.join(directory, 'scripts', 'chickpea-node.mjs'), `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const home = args[args.indexOf('--home') + 1];
const command = args[args.indexOf('--home') + 2];
if (command !== 'init') process.exit(0);
if (process.env.BOOTSTRAP_TEST_INIT_FAIL === '1') {
  console.error('simulated runtime init failure');
  process.exit(73);
}
const origin = args[args.indexOf('--origin') + 1];
const port = Number(args[args.indexOf('--port') + 1]);
const tunnelMode = args[args.indexOf('--tunnel') + 1];
const cloudflaredIndex = args.indexOf('--cloudflared');
const tokenIndex = args.indexOf('--tunnel-token-file');
const sourceCommit = JSON.parse(readFileSync(new URL('../release-source.json', import.meta.url), 'utf8')).commit;
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'installation.json'), JSON.stringify({ sourceCommit, origin, port, tunnelMode, ...(tunnelMode === 'cloudflare' ? { tunnel: { mode: 'cloudflare', cloudflared: args[cloudflaredIndex + 1], tokenFile: args[tokenIndex + 1] } } : {}) }));
writeFileSync(path.join(home, 'runtime-args.json'), JSON.stringify(args));
writeFileSync(path.join(home, 'runtime.env'), 'PRIVATE=1\\n', { mode: 0o600 });
writeFileSync(path.join(home, 'setup-url.txt'), 'https://example.test/admin/setup#setup=secret\\n', { mode: 0o600 });
`);
  git(directory, 'init', '--quiet');
  git(directory, 'add', '.');
  git(directory, 'commit', '--quiet', '-m', 'fixture');
  return { directory, sha: git(directory, 'rev-parse', 'HEAD') };
}

function seedPrivateNode(home: string, log: string): void {
  const bin = path.join(home, 'tools', 'node', 'bin');
  mkdirSync(bin, { recursive: true });
  writeExecutable(path.join(bin, 'node'), `#!/bin/bash
if [[ \${1-} == --version ]]; then echo v24.20.0; exit 0; fi
exec ${JSON.stringify(REAL_NODE)} "$@"
`);
  writeExecutable(path.join(bin, 'npm'), `#!/bin/bash
set -eu
test "\${npm_config_userconfig}" != "\${npm_config_globalconfig}"
test -f "\${npm_config_userconfig}" && test ! -s "\${npm_config_userconfig}"
test -f "\${npm_config_globalconfig}" && test ! -s "\${npm_config_globalconfig}"
printf '%s|%s|%s|%s\\n' "$*" "\${OPENAI_API_KEY-unset}" "\${npm_config_userconfig-unset}" "\${npm_config_globalconfig-unset}" >> ${JSON.stringify(log)}
prefix=''
previous=''
for argument in "$@"; do
  if [[ $previous == --prefix ]]; then prefix=$argument; fi
  previous=$argument
done
if [[ "$*" == *'run flue:build'* ]]; then mkdir -p "$prefix/dist"; : > "$prefix/dist/app.mjs"; : > "$prefix/dist/node-background.mjs"; fi
`);
}

function createManagedHome(root: string): { home: string; log: string } {
  const home = path.join(root, 'install home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, '.installer-home'), 'chickpea-node-v1\n');
  const log = path.join(root, 'npm.log');
  seedPrivateNode(home, log);
  return { home, log };
}

function runInstaller(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('/bin/bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHICKPEA_INSTALL_NONINTERACTIVE: '1', ...env },
  });
}

test('bootstrap archives only clean tracked source, builds in an isolated environment, and activates atomically', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-bootstrap-'));
  try {
    const source = createSource(root);
    writeFileSync(path.join(source.directory, 'untracked-secret.txt'), 'must not copy');
    const { home, log } = createManagedHome(root);
    const injected = path.join(root, 'node-options-ran');
    const injection = path.join(root, 'inject.cjs');
    writeFileSync(injection, `require('fs').writeFileSync(${JSON.stringify(injected)}, 'ran')\n`);
    const result = runInstaller([
      '--home', home,
      '--source', source.directory,
      '--origin', 'https://chickpea.example.test',
      '--tunnel', 'external',
      '--no-start',
      '--no-open',
    ], {
      OPENAI_API_KEY: 'ambient-secret',
      npm_config_registry: 'https://evil.invalid',
      NODE_OPTIONS: `--require=${injection}`,
      NODE_PATH: path.join(root, 'host-node-path'),
    });
    assert.equal(result.status, 0, result.stderr);
    const release = path.join(home, 'releases', source.sha);
    assert.equal(readlinkSync(path.join(home, 'current')), `releases/${source.sha}`);
    assert.equal(readFileSync(path.join(release, 'release-source.json'), 'utf8'), `{"commit":"${source.sha}"}\n`);
    assert.equal(existsSync(path.join(release, 'untracked-secret.txt')), false);
    assert.equal(existsSync(injected), false);
    assert.equal(readFileSync(path.join(release, '.installer-complete'), 'utf8'), `${source.sha}\n`);
    const npmCalls = readFileSync(log, 'utf8');
    assert.match(npmCalls, /ci --strict-allow-scripts/);
    assert.match(npmCalls, /run flue:build/);
    assert.doesNotMatch(npmCalls, /ambient-secret|evil\.invalid/);
    assert.match(npmCalls, /unset\|.*npm-user\.conf\|.*npm-global\.conf/);
    assert.doesNotMatch(npmCalls, /\/dev\/null/);
    assert.equal(lstatSync(path.join(home, 'bin', 'chickpea-node')).mode & 0o777, 0o700);
    assert.match(readFileSync(path.join(home, 'bin', 'chickpea-node'), 'utf8'), /unset NODE_OPTIONS NODE_PATH/);
    const runtimeArgs = JSON.parse(readFileSync(path.join(home, 'runtime-args.json'), 'utf8')) as string[];
    assert.deepEqual(runtimeArgs.slice(0, 7), ['--home', home, 'init', '--origin', 'https://chickpea.example.test', '--port', '3000']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rerun without a selector reuses the installed release without rebuilding or fetching latest', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-rerun-'));
  try {
    const source = createSource(root);
    const { home, log } = createManagedHome(root);
    const first = runInstaller(['--home', home, '--source', source.directory, '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start', '--no-open']);
    assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(log, 'utf8');
    const fakeBin = path.join(root, 'fake-bin');
    mkdirSync(fakeBin);
    writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/bash\necho unexpected curl >&2\nexit 91\n');
    const second = runInstaller(['--home', home, '--no-start', '--no-open'], { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(log, 'utf8'), before);
    assert.equal(readlinkSync(path.join(home, 'current')), `releases/${source.sha}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectors are exclusive and an existing installation refuses a different commit', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-selectors-'));
  try {
    const source = createSource(root);
    const { home } = createManagedHome(root);
    const mixed = runInstaller(['--home', home, '--source', source.directory, '--ref', 'a'.repeat(40), '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start']);
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /mutually exclusive/);
    const first = runInstaller(['--home', home, '--source', source.directory, '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start']);
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(path.join(source.directory, 'new.txt'), 'new');
    git(source.directory, 'add', '.');
    git(source.directory, 'commit', '--quiet', '-m', 'new source');
    const changed = runInstaller(['--home', home, '--source', source.directory, '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start']);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /back up the stopped installation.*manual Node upgrade/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Node checksum mismatch fails safely and a later rerun can recover', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-checksum-'));
  try {
    const home = path.join(root, 'new home');
    const fakeBin = path.join(root, 'fake-bin');
    mkdirSync(fakeBin);
    writeExecutable(path.join(fakeBin, 'curl'), `#!/bin/bash
set -eu
output=''
previous=''
for argument in "$@"; do if [[ $previous == --output ]]; then output=$argument; fi; previous=$argument; done
printf '%064d  node-v24.20.0-darwin-%s.tar.gz\\n' 0 "$([[ $(uname -m) == arm64 ]] && echo arm64 || echo x64)" > "$output"
`);
    const failed = runInstaller(['--home', home, '--ref', 'a'.repeat(40), '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start'], { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /pinned digest/);
    assert.equal(existsSync(path.join(home, '.install-lock')), false);
    assert.equal(readFileSync(path.join(home, '.installer-home'), 'utf8'), 'chickpea-node-v1\n');
    const source = createSource(root);
    const log = path.join(root, 'npm.log');
    seedPrivateNode(home, log);
    const recovered = runInstaller(['--home', home, '--source', source.directory, '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start']);
    assert.equal(recovered.status, 0, recovered.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source download failure leaves no active or partial release', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-download-'));
  try {
    const { home } = createManagedHome(root);
    const fakeBin = path.join(root, 'fake-bin');
    mkdirSync(fakeBin);
    writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/bash\necho download failed >&2\nexit 22\n');
    const result = runInstaller(['--home', home, '--ref', 'a'.repeat(40), '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start'], { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /download failed/);
    assert.equal(existsSync(path.join(home, 'current')), false);
    assert.equal(existsSync(path.join(home, 'releases')), false);
    assert.equal(existsSync(path.join(home, '.install-lock')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a downloaded cloudflared survives init failure and is verified and reused without downloading again', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-cloudflared-retry-'));
  try {
    const source = createSource(root);
    const { home } = createManagedHome(root);
    const token = path.join(root, 'tunnel-token.txt');
    writeFileSync(token, 'private-token\n', { mode: 0o600 });
    const archiveRoot = path.join(root, 'cloudflared-archive');
    const archiveBinary = path.join(archiveRoot, 'cloudflared');
    const archive = path.join(root, 'cloudflared.tgz');
    mkdirSync(archiveRoot);
    writeExecutable(archiveBinary, '#!/bin/bash\necho "cloudflared version 2026.8.1"\n');
    execFileSync('tar', ['-czf', archive, '-C', archiveRoot, 'cloudflared']);
    const archiveDigest = execFileSync('shasum', ['-a', '256', archive], { encoding: 'utf8' }).split(/\s+/)[0];
    const fakeBin = path.join(root, 'fake-bin');
    mkdirSync(fakeBin);
    const curlLog = path.join(root, 'curl.log');
    writeExecutable(path.join(fakeBin, 'curl'), `#!/bin/bash
set -eu
output=''
url=''
previous=''
for argument in "$@"; do
  if [[ $previous == --output ]]; then output=$argument; fi
  previous=$argument
  case "$argument" in https://*) url=$argument ;; esac
done
printf '%s\\n' "$url" >> ${JSON.stringify(curlLog)}
case "$url" in
  https://api.github.com/repos/cloudflare/cloudflared/releases/latest)
    printf '%s' ${JSON.stringify(JSON.stringify({ assets: [{ name: process.arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz', browser_download_url: 'https://downloads.example.test/cloudflared.tgz', digest: `sha256:${archiveDigest}` }] }))} > "$output" ;;
  https://downloads.example.test/cloudflared.tgz) cp ${JSON.stringify(archive)} "$output" ;;
  *) echo unexpected download >&2; exit 92 ;;
esac
`);
    const args = [
      '--home', home,
      '--source', source.directory,
      '--origin', 'https://chickpea.example.test',
      '--tunnel', 'cloudflare',
      '--tunnel-token-file', token,
      '--no-start',
      '--no-open',
    ];
    const failed = runInstaller(args, { PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_TEST_INIT_FAIL: '1' });
    assert.equal(failed.status, 73, failed.stderr);
    assert.match(failed.stderr, /simulated runtime init failure/);
    const cloudflared = path.join(home, 'tools', 'cloudflared', 'cloudflared');
    const receipt = readFileSync(path.join(home, 'tools', 'cloudflared', '.installer-cloudflared'), 'utf8');
    const binaryDigest = execFileSync('shasum', ['-a', '256', cloudflared], { encoding: 'utf8' }).split(/\s+/)[0];
    assert.match(receipt, new RegExp(`^sha256 ${binaryDigest}\\narchive-sha256 ${archiveDigest}\\nversion 2026\\.8\\.1\\n$`));
    assert.equal(existsSync(path.join(home, 'installation.json')), false);
    assert.equal(existsSync(path.join(home, 'current')), false);
    const rejectingCurlBin = path.join(root, 'rejecting-curl-bin');
    mkdirSync(rejectingCurlBin);
    writeExecutable(path.join(rejectingCurlBin, 'curl'), '#!/bin/bash\necho unexpected retry download >&2\nexit 92\n');
    const result = runInstaller(args, { PATH: `${rejectingCurlBin}:${process.env.PATH}` });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /unexpected retry download/);
    const runtimeArgs = JSON.parse(readFileSync(path.join(home, 'runtime-args.json'), 'utf8')) as string[];
    assert.equal(runtimeArgs[runtimeArgs.indexOf('--cloudflared') + 1], realpathSync(cloudflared));
    rmSync(path.dirname(cloudflared), { recursive: true });
    const reacquired = runInstaller(args, { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.equal(reacquired.status, 0, reacquired.stderr);
    assert.equal(existsSync(cloudflared), true);
    assert.equal(readFileSync(curlLog, 'utf8').trim().split('\n').length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a truncated piped installer cannot execute its parsed prefix', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-truncated-'));
  try {
    const home = path.join(root, 'must-not-exist');
    const source = readFileSync(INSTALLER, 'utf8');
    const truncated = source.slice(0, source.indexOf('package_version='));
    const result = spawnSync('/bin/bash', ['-s', '--', '--home', home], { input: truncated, encoding: 'utf8', env: process.env });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed current activation removes only its own temporary symlink', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-current-cleanup-'));
  try {
    const source = createSource(root);
    const { home } = createManagedHome(root);
    symlinkSync('releases/unmanaged', path.join(home, 'current'));
    const result = runInstaller(['--home', home, '--source', source.directory, '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /current release pointer is not a managed installer symlink/);
    assert.equal(readlinkSync(path.join(home, 'current')), 'releases/unmanaged');
    assert.deepEqual(readdirSync(home).filter((name) => /^\.current\..*\.tmp$/.test(name)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the isolated npm environment accepts distinct empty user and global configs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-npm-config-'));
  try {
    const userConfig = path.join(root, 'user.conf');
    const globalConfig = path.join(root, 'global.conf');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    const npm = execFileSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).trim();
    const result = spawnSync('/usr/bin/env', [
      '-i',
      `HOME=${root}`,
      `PATH=${path.dirname(REAL_NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      `npm_config_userconfig=${userConfig}`,
      `npm_config_globalconfig=${globalConfig}`,
      npm,
      '--version',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('platform, root, path, lock, and noninteractive input checks happen before unsafe work', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-guards-'));
  try {
    const { directory } = createSource(root);
    const relative = runInstaller(['--home', 'relative', '--source', directory, '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start']);
    assert.notEqual(relative.status, 0);
    assert.equal(existsSync(path.join(ROOT, 'relative')), false);
    const { home } = createManagedHome(root);
    mkdirSync(path.join(home, '.install-lock'));
    const locked = runInstaller(['--home', home, '--source', directory, '--origin', 'https://chickpea.example.test', '--tunnel', 'external', '--no-start']);
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /verify no installer process or descendants remain/);
    rmSync(path.join(home, '.install-lock'), { recursive: true });
    const privateSentinel = 'PRIVATE_SETUP_TOKEN_MUST_NOT_PRINT';
    const invalidOrigin = runInstaller(['--home', home, '--source', directory, '--origin', `not a url ${privateSentinel}`, '--tunnel', 'external', '--no-start']);
    assert.notEqual(invalidOrigin.status, 0);
    assert.match(invalidOrigin.stderr, /--origin must be a bare HTTPS origin/);
    assert.doesNotMatch(invalidOrigin.stderr, new RegExp(privateSentinel));
    const missing = runInstaller(['--home', home, '--source', directory, '--no-start'], { CI: '1' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--tunnel is required|--origin is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported operating systems are rejected before the installation home is created', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-node-platform-'));
  try {
    const fakeBin = path.join(root, 'fake-bin');
    const home = path.join(root, 'must-not-exist');
    mkdirSync(fakeBin);
    writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/bash\necho Linux\n');
    const result = runInstaller(['--home', home, '--no-start'], { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /supports macOS only/);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
