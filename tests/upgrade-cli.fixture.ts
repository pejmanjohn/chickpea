// Shared by tests/upgrade-cli*.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
// @ts-expect-error Release tooling JavaScript helper.
import { migrationDigests } from '../scripts/lib/release-manifest.mjs';

// Run the real command and Git/source/schema/journal code. Only GitHub, the
// Cloudflare CLI, dependency installation, build, and deploy are offline doubles.
export function fixture(t: any, wranglerProfile?: string, authoredPolicy = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-upgrade-cli-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const launcher = join(base, 'launcher'); const origin = join(base, 'origin'); const home = join(base, 'home');
  const put = (file: string, value: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  for (const dir of [launcher, origin, home]) mkdirSync(dir);
  cpSync('scripts/lib', join(launcher, 'scripts/lib'), { recursive: true });
  cpSync('scripts/upgrade.mjs', join(launcher, 'scripts/upgrade.mjs'));
  cpSync('src/release/upgrade-compatibility.mjs', join(launcher, 'src/release/upgrade-compatibility.mjs'));
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
  cpSync('scripts/lib/upgrade-receipt.mjs', join(launcher, 'journal.mjs'));
  put(join(origin, 'scripts/deploy-with-epilogue.mjs'), `throw new Error('Retained release wrapper must never execute');`);
  put(join(launcher, 'scripts/deploy-with-epilogue.mjs'), `
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    import { writeDeploymentEvent } from '../journal.mjs';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    const expectedProfile = process.env.UPGRADE_FIXTURE_PROFILE;
    if (expectedProfile && process.argv[process.argv.indexOf('--profile') + 1] !== expectedProfile) throw new Error('Wrapper lost named login');
    const context = JSON.parse(readFileSync(process.env.CHICKPEA_UPGRADE_CONTEXT, 'utf8'));
    if (context.sourceRoot !== process.cwd()) throw new Error('Runner did not receive the retained build root');
    const redirect = JSON.parse(readFileSync('.wrangler/deploy/config.json', 'utf8'));
    const config = JSON.parse(readFileSync(path.resolve('.wrangler/deploy', redirect.configPath), 'utf8'));
    if (config.name !== 'customer-test-worker' || config.topLevelName !== config.name || process.env.WRANGLER_CI_OVERRIDE_NAME !== config.name || config.d1_databases[0].database_id !== 'existing-db') throw new Error('Installation overlay missed the generated customer artifact');
    const identity = { version: JSON.parse(readFileSync('package.json', 'utf8')).version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
    if (config.vars.CHICKPEA_APP_VERSION !== identity.version || config.vars.CHICKPEA_SOURCE_COMMIT !== identity.commit || readFileSync(path.resolve('.wrangler/deploy', redirect.configPath, '../index.js'), 'utf8') !== JSON.stringify(identity)) throw new Error('Retargeting changed compiled source identity');
    if (JSON.stringify(config.durable_objects.bindings) !== JSON.stringify([{name:'TAG_STATE',class_name:'TagStateStore'}])) throw new Error('Retargeting changed Durable Object ownership or class');
    appendFileSync(process.env.UPGRADE_FIXTURE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
    if (!process.argv.includes('--preflight-only')) {
      writeDeploymentEvent(process.env.CHICKPEA_UPGRADE_CONTEXT, 'deploying');
      const remote = JSON.parse(readFileSync(process.env.UPGRADE_FIXTURE_REMOTE, 'utf8'));
      remote.version = context.source.version; remote.commit = context.source.commit; remote.id = 'uploaded-' + Date.now();
      writeFileSync(process.env.UPGRADE_FIXTURE_REMOTE, JSON.stringify(remote));
      writeDeploymentEvent(process.env.CHICKPEA_UPGRADE_CONTEXT, 'uploaded', remote.id);
      if (process.env.UPGRADE_FIXTURE_AFTER_UPLOAD==='1') throw new Error('Fixture interruption after upload');
      writeDeploymentEvent(process.env.CHICKPEA_UPGRADE_CONTEXT, 'ready', remote.id);
    }
  `);
  const commits: Record<string, string> = {};
  for (const version of ['0.1.0', '0.1.1']) {
    put(join(origin, 'package.json'), JSON.stringify({ type: 'module', version, ...(authoredPolicy ? { allowScripts: { 'fixture-unused@1.0.0': false } } : {}) }));
    put(join(origin, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
    put(join(origin, 'release.json'), JSON.stringify({ formatVersion: 1, version, storageGeneration: 1, recovery: 'gateway-transport-then-previous-code', supportedOrigins: version === '0.1.0' ? [] : ['0.1.0'], migrations: migrationDigests(origin) }));
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
    import {appendFileSync} from 'node:fs';
    const commits=${JSON.stringify(commits)};
    globalThis.fetch=async (input,options)=>{
      const url=String(input);
      if(url==='https://customer.example/internal/deployment/recover-delivery'){
        const authorization=new Headers(options?.headers).get('authorization');
        const targetVersion=new Headers(options?.headers).get('x-chickpea-target-version');
        if(options?.method!=='POST'||!authorization?.startsWith('Bearer ')||!targetVersion) throw new Error('Invalid transport recovery request');
        appendFileSync(process.env.UPGRADE_FIXTURE_LOG,JSON.stringify({method:'POST',path:'/internal/deployment/recover-delivery',targetVersion,authorized:true})+'\\n');
        return new Response(null,{status:204});
      }
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
    if(process.env.UPGRADE_FIXTURE_PROFILE && args[args.indexOf('--profile')+1]!==process.env.UPGRADE_FIXTURE_PROFILE) throw new Error('Inspection lost named login');
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
    const args=process.argv.slice(2);
    if(args[0]==='--version'){console.log('11.19.0');process.exit(0);}
    if(args[0]==='config'){console.log(JSON.stringify({'ignore-scripts':false,'allow-scripts':[]}));process.exit(0);}
    appendFileSync(process.env.UPGRADE_FIXTURE_LOG,JSON.stringify(args)+'\\n');
    if(args[0]==='ci' && process.env.UPGRADE_FIXTURE_DIRTY_SOURCE==='1') writeFileSync('package.json',JSON.stringify({...JSON.parse(readFileSync('package.json','utf8')),changed:true}));
    if(args[0]==='ci' && process.env.UPGRADE_FIXTURE_CI_FAIL==='1') {
      process.stderr.write('npm error code E401\\nprivate-registry-token-do-not-print\\nnpm error code PRIVATE_SECRET\\n');
      process.exit(1);
    }
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
  const run = (args: string[], confirm = false, afterUpload = false, extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', preload, join(launcher, 'scripts/upgrade.mjs'), ...args], {
    cwd: launcher, encoding: 'utf8', input: confirm ? 'customer-test-worker\n' : undefined, timeout: 30_000,
    env: { ...process.env, HOME: home, PATH: `${join(base, 'bin')}:${process.env.PATH}`, npm_execpath: npm, WRANGLER_HOME: 'fixture-oauth-home',
      ...(wranglerProfile ? { UPGRADE_FIXTURE_PROFILE: wranglerProfile } : {}), UPGRADE_FIXTURE_LOG: log, UPGRADE_FIXTURE_REMOTE: remote, UPGRADE_FIXTURE_CONFIRM: confirm ? '1' : '0', UPGRADE_FIXTURE_AFTER_UPLOAD: afterUpload ? '1' : '0', ...extraEnv },
  });
  const configure = () => { const result = run(['--configure', '--account', 'a'.repeat(32), '--worker', 'customer-test-worker', '--profile', 'core', '--url', 'https://customer.example', ...(wranglerProfile ? ['--wrangler-profile', wranglerProfile] : [])]); assert.equal(result.status, 0, result.stderr); };
  return { base, home, remote, log, run, configure, receipts: () => join(home, '.chickpea/upgrades/receipts') };
}
