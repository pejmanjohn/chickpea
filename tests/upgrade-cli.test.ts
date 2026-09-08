import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { migrationDigests } from '../scripts/lib/release-manifest.mjs';

// Run the real command and Git/source/schema/journal code. Only GitHub, the
// Cloudflare CLI, dependency installation, build, and deploy are offline doubles.
function fixture(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-upgrade-cli-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const launcher = join(base, 'launcher'); const origin = join(base, 'origin'); const home = join(base, 'home');
  const put = (file: string, value: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  for (const dir of [launcher, origin, home]) mkdirSync(dir);
  cpSync('scripts/lib', join(launcher, 'scripts/lib'), { recursive: true });
  cpSync('scripts/upgrade.mjs', join(launcher, 'scripts/upgrade.mjs'));
  cpSync('.nvmrc', join(launcher, '.nvmrc'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Upgrade Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: origin, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(['init', '--quiet']);
  put(join(origin, '.gitignore'), 'dist-cf/\n.wrangler/\nnode_modules/\n');
  put(join(origin, 'wrangler.jsonc'), '{}');
  put(join(origin, 'migrations/better-auth/0001.sql'), 'CREATE TABLE owners (id TEXT PRIMARY KEY);');
  for (const file of ['src/identity/migrations.ts', 'src/config/store.ts', 'src/work/migrations.ts']) put(join(origin, file), '// fixture');
  cpSync('scripts/lib/upgrade-receipt.mjs', join(origin, 'journal.mjs'));
  put(join(origin, 'scripts/deploy-with-epilogue.mjs'), `
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    import { writeDeploymentEvent } from '../journal.mjs';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    const redirect = JSON.parse(readFileSync('.wrangler/deploy/config.json', 'utf8'));
    const config = JSON.parse(readFileSync(path.resolve('.wrangler/deploy', redirect.configPath), 'utf8'));
    if (config.name !== 'customer-test-worker' || config.topLevelName !== config.name || process.env.WRANGLER_CI_OVERRIDE_NAME !== config.name || config.d1_databases[0].database_id !== 'existing-db') throw new Error('Installation overlay missed the generated customer artifact');
    const identity = { version: JSON.parse(readFileSync('package.json', 'utf8')).version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
    if (config.vars.CHICKPEA_APP_VERSION !== identity.version || config.vars.CHICKPEA_SOURCE_COMMIT !== identity.commit || readFileSync(path.resolve('.wrangler/deploy', redirect.configPath, '../index.js'), 'utf8') !== JSON.stringify(identity)) throw new Error('Retargeting changed compiled source identity');
    if (JSON.stringify(config.durable_objects.bindings) !== JSON.stringify([{name:'TAG_STATE',class_name:'TagStateStore'}])) throw new Error('Retargeting changed Durable Object ownership or class');
    appendFileSync(process.env.UPGRADE_FIXTURE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
    if (!process.argv.includes('--preflight-only')) {
      const context = JSON.parse(readFileSync(process.env.CHICKPEA_UPGRADE_CONTEXT, 'utf8'));
      writeDeploymentEvent(process.env.CHICKPEA_UPGRADE_CONTEXT, 'deploying');
      const remote = JSON.parse(readFileSync(process.env.UPGRADE_FIXTURE_REMOTE, 'utf8'));
      remote.version = context.source.version; remote.commit = context.source.commit; remote.id = 'uploaded-' + Date.now();
      writeFileSync(process.env.UPGRADE_FIXTURE_REMOTE, JSON.stringify(remote));
      writeDeploymentEvent(process.env.CHICKPEA_UPGRADE_CONTEXT, 'uploaded', remote.id);
      writeDeploymentEvent(process.env.CHICKPEA_UPGRADE_CONTEXT, 'ready', remote.id);
    }
  `);
  const commits: Record<string, string> = {};
  for (const version of ['0.1.0', '0.1.1']) {
    put(join(origin, 'package.json'), JSON.stringify({ type: 'module', version }));
    put(join(origin, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
    put(join(origin, 'release.json'), JSON.stringify({ formatVersion: 1, version, storageGeneration: 1, recovery: 'previous-code-only', supportedOrigins: version === '0.1.0' ? [] : ['0.1.0'], migrations: migrationDigests(origin) }));
    git(['add', '.']); git(['commit', '--quiet', '-m', version]);
    commits[version] = git(['rev-parse', 'HEAD']); git(['tag', `v${version}`]);
  }
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const shim = join(base, 'bin/git');
  put(shim, `#!/usr/bin/env node
    const {spawnSync}=require('node:child_process');
    const args=process.argv.slice(2).map(value=>value==='https://github.com/pejmanjohn/chickpea.git'?${JSON.stringify(origin)}:value==='protocol.file.allow=never'?'protocol.file.allow=always':value);
    const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);
  `);
  spawnSync('chmod', ['700', shim]);
  const preload = join(base, 'preload.mjs');
  put(preload, `
    const commits=${JSON.stringify(commits)};
    globalThis.fetch=async (url)=>{
      if (!url.startsWith('https://api.github.com/repos/pejmanjohn/chickpea/')) throw new Error('Unexpected external request');
      const tag=url.split('/').at(-1);const version=tag.slice(1);
      return Response.json(url.includes('/releases/')?{tag_name:tag,immutable:true,draft:false,prerelease:false,html_url:'https://github.com/pejmanjohn/chickpea/releases/tag/'+tag,published_at:'2026-09-07T00:00:00Z'}:{object:{type:'commit',sha:commits[version]}});
    };
    if (process.env.UPGRADE_FIXTURE_CONFIRM==='1') Object.defineProperty(process.stdin,'isTTY',{value:true});
  `);
  const remote = join(base, 'remote.json'); const log = join(base, 'commands.log');
  put(remote, JSON.stringify({ version: '0.1.0', commit: commits['0.1.0'], id: 'original' })); put(log, '');
  put(join(launcher, 'node_modules/wrangler/bin/wrangler.js'), `
    const {readFileSync,appendFileSync}=require('node:fs');const args=process.argv.slice(2);
    appendFileSync(process.env.UPGRADE_FIXTURE_LOG,JSON.stringify(args)+'\\n');
    if(process.env.WRANGLER_HOME!=='fixture-oauth-home') throw new Error('OAuth home was discarded');
    const remote=JSON.parse(readFileSync(process.env.UPGRADE_FIXTURE_REMOTE,'utf8'));
    const bindings=[...['CHICKPEA_AUTH_SECRET','CHICKPEA_CREDENTIAL_KEY_CURRENT_ID','CHICKPEA_CREDENTIAL_KEY_V1'].map(name=>({name,type:'secret_text'})),{name:'AUTH_DB',type:'d1',id:'existing-db'},{name:'TAG_STATE',type:'durable_object_namespace',namespace_id:'existing-state',class_name:'TagStateStore',script_name:'customer-test-worker'},...Object.entries({CHICKPEA_APP_VERSION:remote.version,CHICKPEA_SOURCE_COMMIT:remote.commit,CHICKPEA_SETUP_CAPABILITY_DIGEST:'a'.repeat(43),CHICKPEA_SETUP_CAPABILITY_ISSUED_AT:'1780000000000'}).map(([name,text])=>({name,text,type:'plain_text'}))];
    if(args[0]==='secret') console.log(JSON.stringify(['CHICKPEA_AUTH_SECRET','CHICKPEA_CREDENTIAL_KEY_CURRENT_ID','CHICKPEA_CREDENTIAL_KEY_V1'].map(name=>({name}))));
    else if(args[0]==='deployments') console.log(JSON.stringify({versions:[{version_id:remote.id,percentage:100}]}));
    else if(args[0]==='versions') console.log(JSON.stringify({resources:{bindings}}));
    else if(args[0]==='d1'&&args[1]==='execute'&&args.includes('--command')) console.log(JSON.stringify([{success:true,results:[{type:'table',name:'owners',tbl_name:'owners',sql:'CREATE TABLE owners (id TEXT PRIMARY KEY)'}]}]));
    else throw new Error('Unexpected mutation');
  `);
  const npm = join(base, 'npm.mjs');
  put(npm, `
    import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
    import {execFileSync} from 'node:child_process';
    const args=process.argv.slice(2);appendFileSync(process.env.UPGRADE_FIXTURE_LOG,JSON.stringify(args)+'\\n');
    if(args.includes('verify:host')) throw new Error('Maintainer lock entered customer path');
    if(args[0]==='run'&&args[1]==='build'){
      const version=JSON.parse(readFileSync('package.json','utf8')).version;
      if(version==='0.1.0' && process.env.WRANGLER_CI_OVERRIDE_NAME) throw new Error('Legacy size check cannot build a custom Worker name');
      const worker=process.env.WRANGLER_CI_OVERRIDE_NAME??'chickpea';
      const output='dist-cf/'+worker.replaceAll('-','_');
      mkdirSync(output,{recursive:true});
      mkdirSync('.wrangler/deploy',{recursive:true});
      writeFileSync('.wrangler/deploy/config.json',JSON.stringify({configPath:'../../'+output+'/wrangler.json'}));
      const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
      writeFileSync(output+'/wrangler.json',JSON.stringify({name:worker,topLevelName:worker,durable_objects:{bindings:[{name:'TAG_STATE',class_name:'TagStateStore'}]},vars:{CHICKPEA_APP_VERSION:version,CHICKPEA_SOURCE_COMMIT:commit},d1_databases:[{binding:'AUTH_DB',database_id:''}]}));
      writeFileSync(output+'/index.js',JSON.stringify({version,commit}));
    }
  `);
  // A stale maintainer reservation must not stop a customer build or recovery.
  put(join(home, '.chickpea/verification-host/owner.json'), JSON.stringify({ pid: 99999999, token: 'stale-fixture' }));
  const run = (args: string[], confirm = false) => spawnSync(process.execPath, ['--import', preload, join(launcher, 'scripts/upgrade.mjs'), ...args], {
    cwd: launcher, encoding: 'utf8', input: confirm ? 'customer-test-worker\n' : undefined, timeout: 30_000,
    env: { ...process.env, HOME: home, PATH: `${join(base, 'bin')}:${process.env.PATH}`, npm_execpath: npm, WRANGLER_HOME: 'fixture-oauth-home',
      UPGRADE_FIXTURE_LOG: log, UPGRADE_FIXTURE_REMOTE: remote, UPGRADE_FIXTURE_CONFIRM: confirm ? '1' : '0' },
  });
  const configure = () => { const result = run(['--configure', '--account', 'a'.repeat(32), '--worker', 'customer-test-worker', '--profile', 'core', '--url', 'https://customer.example']); assert.equal(result.status, 0, result.stderr); };
  return { base, home, remote, log, run, configure, receipts: () => join(home, '.chickpea/upgrades/receipts') };
}

test('custom-named Worker upgrades and recovers an immutable legacy release with authored-name builds', (t) => {
  const f = fixture(t); f.configure();
  const initial = readFileSync(f.remote, 'utf8');
  const preflight = f.run(['--to', 'v0.1.1', '--preflight']);
  assert.equal(preflight.status, 0, preflight.stderr); assert.match(preflight.stdout, /Preflight passed/);
  assert.equal(readFileSync(f.remote, 'utf8'), initial);
  const receipt = join(f.receipts(), readdirSync(f.receipts())[0]!, 'receipt.json');
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).stage, 'prepared');
  const resume = f.run(['--resume', receipt], true); assert.equal(resume.status, 0, resume.stderr);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.1');
  const recover = f.run(['--recover', receipt], true); assert.equal(recover.status, 0, recover.stderr);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.0');
  const again = f.run(['--resume', receipt]); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /recovered/);
});

test('CLI refuses altered retained source before dependency scripts or deployment', (t) => {
  const f = fixture(t); f.configure();
  const preflight = f.run(['--to', 'v0.1.1', '--preflight']); assert.equal(preflight.status, 0, preflight.stderr);
  const directory = join(f.receipts(), readdirSync(f.receipts())[0]!);
  writeFileSync(join(directory, 'destination/package.json'), '{"version":"9.0.0"}');
  writeFileSync(f.log, '');
  const resume = f.run(['--resume', join(directory, 'receipt.json')]);
  assert.equal(resume.status, 1); assert.match(resume.stderr, /identity or clean-checkout/);
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /"ci"|"build"|"--skip-build"/);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.0');
});

test('CLI rejects conflicting arguments and receipts outside its private directory', (t) => {
  const f = fixture(t);
  assert.match(f.run(['--to', 'v0.1.1', '--recover', '/tmp/receipt.json']).stderr, /exactly one/);
  assert.match(f.run(['--to', 'latest']).stderr, /exact stable/);
  assert.match(f.run(['--configure', '--account', 'a'.repeat(32), '--worker', 'customer', '--profile', 'sandbox', '--url', 'https://customer.example']).stderr, /Sandbox container images/);
  assert.equal(readFileSync(f.log, 'utf8'), '');
  const outside = join(f.base, 'outside'); mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, 'receipt.json'), '{}', { mode: 0o600 });
  assert.match(f.run(['--resume', join(outside, 'receipt.json')]).stderr, /different upgrade-state/);
  assert.equal(existsSync(join(f.home, '.chickpea/upgrades/installations/default.json')), false);
});
