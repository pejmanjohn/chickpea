import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { Bash, InMemoryFs } from 'just-bash';
// @ts-expect-error Release tooling JavaScript helper.
import { createPrivateNpmUserconfig, prepareNpmInstallPolicy, resolveNpmInstallPolicy } from '../scripts/lib/npm-install-policy.mjs';

const NPM = process.env.npm_execpath ?? path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const TOKEN = 'fixture-registry-credential';

async function npmFixture(t: any, policy?: Record<string, boolean>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-npm-policy-'));
  const checkout = path.join(directory, 'checkout');
  mkdirSync(checkout);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tarballs = new Map<string, Buffer>();
  for (const name of ['approved-hook', 'denied-hook']) {
    const pack = path.join(directory, name, 'package');
    mkdirSync(pack, { recursive: true });
    writeFileSync(path.join(pack, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { install: 'node hook.cjs' } }));
    writeFileSync(path.join(pack, 'hook.cjs'), "require('node:fs').writeFileSync('hook-ran', 'yes');");
    const tarball = path.join(directory, `${name}.tgz`);
    const tar = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(pack), 'package'], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    tarballs.set(name, readFileSync(tarball));
  }
  const authenticated: string[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401).end(); return; }
    const name = request.url?.split('/')[1] ?? '';
    const body = tarballs.get(name);
    if (!body) { response.writeHead(404).end(); return; }
    authenticated.push(name);
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const port = (server.address() as { port: number }).port;
  const registry = `http://127.0.0.1:${port}/`;
  const deps = { 'approved-hook': '1.0.0', 'denied-hook': '1.0.0' };
  const manifest = { name: 'install-fixture', version: '1.0.0', private: true, dependencies: deps,
    scripts: { preinstall: 'node scripts/lib/node-version.mjs' }, ...(policy ? { allowScripts: policy } : {}) };
  writeFileSync(path.join(checkout, 'package.json'), JSON.stringify(manifest));
  mkdirSync(path.join(checkout, 'scripts/lib'), { recursive: true });
  copyFileSync('scripts/lib/node-version.mjs', path.join(checkout, 'scripts/lib/node-version.mjs'));
  copyFileSync('.nvmrc', path.join(checkout, '.nvmrc'));
  writeFileSync(path.join(checkout, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { '': { name: manifest.name, version: manifest.version, dependencies: deps, hasInstallScript: true },
      ...Object.fromEntries([...tarballs].map(([name, bytes]) => [`node_modules/${name}`, { version: '1.0.0', hasInstallScript: true,
        resolved: `${registry}${name}/-/${name}-1.0.0.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }])) },
  }));
  const userconfig = path.join(directory, 'user.npmrc');
  const configText = `registry=${registry}\n//127.0.0.1:${port}/:_authToken=\${NPM_FIXTURE_TOKEN}\nfetch-retries=0\n`;
  writeFileSync(userconfig, configText, { mode: 0o600 });
  const globalconfig = path.join(directory, 'global.npmrc');
  writeFileSync(globalconfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  Object.assign(env, { npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_cache: path.join(directory, 'cache'), NPM_FIXTURE_TOKEN: TOKEN });
  const run = (args: string[], extraEnv = env) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [NPM, ...args], { cwd: checkout, env: extraEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
  return { directory, checkout, userconfig, configText, env, run, authenticated };
}

test('real npm enforces exact root approvals and denials while preserving registry authentication', async (t) => {
  const f = await npmFixture(t, { 'approved-hook@1.0.0': true, 'denied-hook@1.0.0': false });
  const before = ['package.json', 'package-lock.json'].map((file) => readFileSync(path.join(f.checkout, file), 'utf8'));
  const prepared = prepareNpmInstallPolicy({ checkout: f.checkout, env: f.env, npmExecPath: NPM });
  t.after(prepared.dispose);
  assert.equal(prepared.legacy, false);
  const result = await f.run(['ci', '--no-audit', '--no-fund', ...prepared.args], prepared.env);
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(path.join(f.checkout, 'node_modules/approved-hook/hook-ran')), true);
  assert.equal(existsSync(path.join(f.checkout, 'node_modules/denied-hook/hook-ran')), false);
  assert.deepEqual([...f.authenticated].sort(), ['approved-hook', 'denied-hook']);
  assert.deepEqual(['package.json', 'package-lock.json'].map((file) => readFileSync(path.join(f.checkout, file), 'utf8')), before);
  assert.equal(readFileSync(f.userconfig, 'utf8'), f.configText);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
});

test('real npm strict mode requires every legacy hook to be reviewed and rejects CLI or environment approvals', async (t) => {
  const f = await npmFixture(t);
  const makeConfig = (approved: string[]) => createPrivateNpmUserconfig({ userconfig: f.userconfig, approved, checkout: f.checkout, temporaryRoot: f.directory });
  const partial = makeConfig(['approved-hook@1.0.0']);
  const incomplete = await f.run(['ci', '--no-audit', '--no-fund', '--strict-allow-scripts', '--userconfig', partial.file]).finally(partial.dispose);
  assert.equal(existsSync(partial.file), false);
  assert.notEqual(incomplete.code, 0);
  assert.match(incomplete.output, /ESTRICTALLOWSCRIPTS/);
  assert.equal(existsSync(path.join(f.checkout, 'node_modules/approved-hook/hook-ran')), false);
  assert.equal(existsSync(path.join(f.checkout, 'node_modules/denied-hook/hook-ran')), false);
  const complete = makeConfig(['approved-hook@1.0.0', 'denied-hook@1.0.0']);
  assert.notEqual(complete.file, partial.file);
  assert.equal(statSync(complete.file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(complete.file)).mode & 0o777, 0o700);
  assert.ok(readFileSync(complete.file, 'utf8').startsWith(f.configText));
  const result = await f.run(['ci', '--no-audit', '--no-fund', '--strict-allow-scripts', '--userconfig', complete.file]).finally(complete.dispose);
  assert.equal(existsSync(complete.file), false);
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(path.join(f.checkout, 'node_modules/approved-hook/hook-ran')), true);
  assert.equal(existsSync(path.join(f.checkout, 'node_modules/denied-hook/hook-ran')), true);
  assert.equal(readFileSync(f.userconfig, 'utf8'), f.configText);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
  for (const [args, env] of [
    [['ci', '--allow-scripts=approved-hook@1.0.0'], f.env],
    [['ci'], { ...f.env, npm_config_allow_scripts: 'approved-hook@1.0.0' }],
  ] as [string[], NodeJS.ProcessEnv][]) {
    const rejected = await f.run(args, env);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.output, /EALLOWSCRIPTS/);
  }
});

test('policy validation rejects uncovered versions, non-exact decisions, and unknown historical source before npm', async (t) => {
  const f = await npmFixture(t, { 'approved-hook@1.0.0': true, 'denied-hook@1.0.0': false });
  const lockPath = path.join(f.checkout, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/approved-hook'].version = '1.0.1';
  lock.packages['node_modules/approved-hook'].resolved = lock.packages['node_modules/approved-hook'].resolved.replace('-1.0.0.tgz', '-1.0.1.tgz');
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.throws(() => resolveNpmInstallPolicy(f.checkout), /NPM_POLICY_INCOMPLETE/);
  const manifestPath = path.join(f.checkout, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.allowScripts = { 'approved-hook@*': true };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => resolveNpmInstallPolicy(f.checkout), /NPM_POLICY_INVALID/);
  delete manifest.allowScripts;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => prepareNpmInstallPolicy({ checkout: f.checkout, source: { version: '0.1.16', commit: '42d0bf4b1aa85cb9946bdd8b9d8dea8aae2ffdbf' }, npmExecPath: '/must-not-run' }), /NPM_POLICY_UNKNOWN/);
  assert.deepEqual(f.authenticated, []);
});

test('private config preserves npm configuration layers, substitutions, and certificate paths', async (t) => {
  const f = await npmFixture(t);
  const certificate = path.join(f.directory, 'certificate.pem');
  writeFileSync(certificate, '');
  writeFileSync(f.userconfig, `${f.configText}proxy=\${NPM_FIXTURE_PROXY}\ncafile=${certificate}\n`);
  writeFileSync(path.join(f.checkout, '.npmrc'), 'fund=false\n');
  writeFileSync(f.env.npm_config_globalconfig!, 'fetch-timeout=12345\n');
  const env = { ...f.env, NPM_FIXTURE_PROXY: 'http://127.0.0.1:9876' };
  const config = createPrivateNpmUserconfig({ userconfig: f.userconfig, approved: ['approved-hook@1.0.0', 'denied-hook@1.0.0'], checkout: f.checkout, temporaryRoot: f.directory });
  t.after(config.dispose);
  const before = await f.run(['config', 'list', '--json'], env);
  const after = await f.run(['config', 'list', '--json', '--userconfig', config.file], env);
  assert.equal(before.code, 0, before.output);
  assert.equal(after.code, 0, after.output);
  for (const key of ['registry', 'proxy', 'cafile', 'fund', 'fetch-timeout', 'globalconfig']) {
    assert.deepEqual(JSON.parse(after.output)[key], JSON.parse(before.output)[key], key);
  }
  assert.ok(readFileSync(config.file, 'utf8').includes('${NPM_FIXTURE_TOKEN}'));
});

test('preparation rejects conflicting npm policy or script suppression and remains reusable after interruption', async (t) => {
  const f = await npmFixture(t, { 'approved-hook@1.0.0': true, 'denied-hook@1.0.0': false });
  for (const extra of [{ npm_config_ignore_scripts: 'true' }, { npm_config_allow_scripts: 'approved-hook@1.0.0' }, { npm_config_dangerously_allow_all_scripts: 'true' }]) {
    assert.throws(() => prepareNpmInstallPolicy({ checkout: f.checkout, env: { ...f.env, ...extra }, npmExecPath: NPM }), /NPM_POLICY_CONFLICT/);
  }
  writeFileSync(f.userconfig, `${f.configText}allow-scripts[]=unreviewed@1.0.0\n`);
  assert.throws(() => prepareNpmInstallPolicy({ checkout: f.checkout, env: f.env, npmExecPath: NPM }), /NPM_POLICY_CONFLICT/);
  writeFileSync(f.userconfig, f.configText);
  const first = prepareNpmInstallPolicy({ checkout: f.checkout, env: f.env, npmExecPath: NPM });
  process.emit('SIGINT');
  assert.equal(first.signal.aborted, true);
  first.dispose();
  const retry = prepareNpmInstallPolicy({ checkout: f.checkout, env: f.env, npmExecPath: NPM });
  assert.equal(retry.signal.aborted, false);
  retry.dispose();
});

test('private config refuses source/receipt locations and oversized symlink targets without leftover files', async (t) => {
  const f = await npmFixture(t);
  const options = { userconfig: f.userconfig, approved: ['approved-hook@1.0.0'], checkout: f.checkout };
  assert.throws(() => createPrivateNpmUserconfig({ ...options, temporaryRoot: f.checkout }), /NPM_CONFIG_LOCATION_INVALID/);
  assert.throws(() => createPrivateNpmUserconfig({ ...options, temporaryRoot: f.directory, receiptRoot: f.directory }), /NPM_CONFIG_LOCATION_INVALID/);
  const large = path.join(f.directory, 'large.npmrc');
  const link = path.join(f.directory, 'link.npmrc');
  writeFileSync(large, 'x'.repeat(256 * 1024 + 1)); symlinkSync(large, link);
  assert.throws(() => createPrivateNpmUserconfig({ ...options, userconfig: link }), /NPM_CONFIG_UNAVAILABLE/);
});

test('the authored root policy covers all locked hooks with explicit decisions', () => {
  const result = resolveNpmInstallPolicy(process.cwd());
  assert.equal(result.legacy, false);
  assert.equal(result.policy['esbuild@0.28.1'], true);
  assert.equal(result.policy['workerd@1.20260815.1'], true);
  assert.equal(result.policy['node-liblzma@2.2.0'], false);
  assert.equal(result.policy['@mongodb-js/zstd@7.0.0'], false);
});

test('reviewed binary installers and denied-hook runtime dependencies remain usable', async () => {
  for (const [binary, expected] of [['esbuild', /0\.28\.1/], ['workerd', /2026-08-15/]] as const) {
    const result = spawnSync(path.join(process.cwd(), 'node_modules/.bin', binary), ['--version'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, expected);
  }
  const require = createRequire(import.meta.url);
  const protobuf = require('protobufjs');
  const message = new protobuf.Type('Smoke').add(new protobuf.Field('text', 1, 'string'));
  assert.equal(message.decode(message.encode({ text: 'ready' }).finish()).text, 'ready');
  assert.deepEqual(require('core-js-pure/features/array/from')('ok'), ['o', 'k']);
  assert.equal(typeof (await import('@google/genai')).GoogleGenAI, 'function');
  const bash = new Bash({ fs: new InMemoryFs() });
  const gzip = await bash.exec('echo ready > f; tar -czf a.tgz f; tar -xOzf a.tgz f');
  assert.equal(gzip.exitCode, 0, gzip.stderr);
  assert.equal(gzip.stdout, 'ready\n');
  for (const args of ['-cJf a.txz f', '--zstd -cf a.tar.zst f']) {
    const disabled = await bash.exec(`tar ${args}`);
    assert.notEqual(disabled.exitCode, 0);
    assert.match(disabled.stderr, /compression is disabled by default/);
    assert.doesNotMatch(disabled.stderr, /No native build|Cannot find module/);
  }
});
