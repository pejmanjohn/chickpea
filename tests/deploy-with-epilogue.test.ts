import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { digestSetupCapability } from '../src/auth/setup-capability.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { writePrivateJson } from '../scripts/lib/upgrade-receipt.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { migrationDigests } from '../scripts/lib/release-manifest.mjs';
// @ts-expect-error The dependency-free lane list is plain JavaScript.
import { QA_LANES } from '../scripts/lib/qa-lanes.mjs';
import { AUTH_MIGRATIONS, createHarness, runHarness, prepareUpgrade, commands, writeCutoverArtifact } from './deploy-with-epilogue.fixture.ts';

test('missing workers.dev registration stops before the app build and all resource work', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const result = runHarness(harness, [], { DEPLOY_TEST_SUBDOMAIN_MISSING: '1', DEPLOY_TEST_ACCOUNT_LOG: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Workers.dev registration/);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.length, 1);
  assert.match(invoked[0]!, /^account-preflight:/);
});

test('account readiness preserves offline dry-run and artifact-only preflight', (context) => {
  for (const mode of ['--dry-run', '--preflight-only']) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    const result = runHarness(harness, ['--skip-build', mode], { DEPLOY_TEST_SUBDOMAIN_MISSING: '1', DEPLOY_TEST_ACCOUNT_LOG: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((existsSync(harness.logPath) ? commands(harness.logPath) : []).some((line) => line.startsWith('account-preflight:')), false);
  }
});

test('live build checks account readiness first; reused artifacts check their verified config', (context) => {
  for (const reuse of [false, true]) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    const result = runHarness(harness, reuse ? ['--skip-build'] : [], { DEPLOY_TEST_ACCOUNT_LOG: '1' });
    assert.equal(result.status, 0, result.stderr);
    const invoked = commands(harness.logPath);
    assert.equal(invoked.filter((line) => line.startsWith('account-preflight:')).length, 1);
    assert.equal(invoked[0], `account-preflight:${path.join(realpathSync(harness.root), reuse ? 'dist-cf/chickpea/wrangler.json' : 'wrangler.jsonc')}`);
    assert.equal(invoked.some((line) => line.startsWith('npm:')), !reuse);
  }
});

test('Workers Builds and customer upgrades cannot bypass missing account registration', (context) => {
  for (const mode of ['workers-builds', 'upgrade']) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    const extra = mode === 'upgrade' ? prepareUpgrade(harness) : { WORKERS_CI: '1', WORKERS_CI_BUILD_UUID: 'test-build' };
    const result = runHarness(harness, mode === 'upgrade' ? ['--skip-build'] : [], {
      ...extra, DEPLOY_TEST_SUBDOMAIN_MISSING: '1', DEPLOY_TEST_ACCOUNT_LOG: '1',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(commands(harness.logPath), [`account-preflight:${path.join(realpathSync(harness.root), 'dist-cf/chickpea/wrangler.json')}`]);
    assert.equal(existsSync(harness.secretCapturePath), false);
  }
});

test('customer upgrade preserves authority through a transient empty secret list after upload', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const result = runHarness(harness, ['--skip-build'], { ...prepareUpgrade(harness), DEPLOY_TEST_EMPTY_SECRET_LIST_AFTER_UPLOAD: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /#setup=|mint|\/admin\/setup/);
  assert.equal(existsSync(harness.secretCapturePath), false);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.some((line) => /"create"|"apply"|"put"|"bulk"/.test(line)), false);
  const config = JSON.parse(readFileSync(path.join(harness.root, 'dist-cf/chickpea/wrangler.json'), 'utf8'));
  assert.equal(config.vars.CHICKPEA_SETUP_CAPABILITY_DIGEST, 'P'.repeat(43));
  assert.equal(config.vars.CHICKPEA_SETUP_CAPABILITY_ISSUED_AT, '1788289200000');
  assert.equal(config.vars.DO_NOT_TRACK, '1');
  const event = JSON.parse(readFileSync(path.join(harness.root, 'deployment.json'), 'utf8'));
  assert.equal(event.stage, 'ready');
  assert.equal(event.workerVersion, 'new-upgrade-version');
  assert.equal(invoked.some((line) => line.startsWith('[\"deploy\"')), false);
  assert.ok(invoked.some((line) => line.includes('\"versions\",\"upload\"')));
  assert.ok(invoked.some((line) => line.includes('\"versions\",\"deploy\",\"new-upgrade-version@100%\"')));
  const activation = JSON.parse(readFileSync(path.join(harness.root, 'activation-wrangler.json'), 'utf8'));
  assert.deepEqual(Object.keys(activation).sort(), ['account_id', 'compatibility_date', 'name']);
  assert.deepEqual(Object.keys(event).sort(), ['at', 'knownVersions', 'schema', 'stage', 'workerVersion']);
});

test('customer upgrade pins named authentication through every remote command and rejects overrides', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const environment = prepareUpgrade(harness);
  const upgrade = JSON.parse(readFileSync(environment.CHICKPEA_UPGRADE_CONTEXT, 'utf8'));
  upgrade.target.wranglerProfile = 'customer-login';
  writePrivateJson(environment.CHICKPEA_UPGRADE_CONTEXT, upgrade);
  for (const args of [[], ['--profile', 'other'], ['--profile', 'customer-login', '--env', 'other']]) {
    const rejected = runHarness(harness, ['--skip-build', ...args], environment);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Upgrade context does not match/);
    assert.equal(existsSync(harness.logPath), false);
  }
  const result = runHarness(harness, ['--skip-build', '--profile', 'customer-login'], environment);
  assert.equal(result.status, 0, result.stderr);
  const remote = commands(harness.logPath).filter((line) => line.startsWith('wrangler:')).map((line) => JSON.parse(line.slice('wrangler:'.length)));
  assert.ok(remote.some((args) => args[0] === 'versions' && args[1] === 'deploy'));
  for (const args of remote) assert.equal(args[args.indexOf('--profile') + 1], 'customer-login', JSON.stringify(args));
});

test('customer upgrade records the uploaded identity when activation fails', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const result = runHarness(harness, ['--skip-build'], { ...prepareUpgrade(harness), DEPLOY_TEST_ACTIVATION_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /activation was not verified/);
  const event = JSON.parse(readFileSync(path.join(harness.root, 'deployment.json'), 'utf8'));
  assert.equal(event.stage, 'uploaded');
  assert.deepEqual(event.knownVersions, [{ workerVersion: 'new-upgrade-version', version: '0.1.1', commit: 'b'.repeat(40) }]);
});

test('current wrapper recovers a verified older build without its wrapper or Wrangler installation', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const environment = prepareUpgrade(harness);
  const sourceRoot = path.join(realpathSync(harness.root), 'previous');
  mkdirSync(sourceRoot, { mode: 0o700 });
  for (const entry of ['wrangler.jsonc', 'slack-app-manifest.json', 'migrations', 'dist-cf', '.wrangler']) {
    cpSync(path.join(harness.root, entry), path.join(sourceRoot, entry), { recursive: true });
  }
  const put = (file: string, value: unknown) => {
    const target = path.join(sourceRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  put('.gitignore', 'dist-cf/\n.wrangler/\n');
  put('package.json', { version: '0.1.0' });
  put('package-lock.json', { version: '0.1.0', packages: { '': { version: '0.1.0' } } });
  put('scripts/deploy-with-epilogue.mjs', "throw new Error('Old wrapper must not execute');");
  for (const file of ['src/identity/migrations.ts', 'src/config/store.ts', 'src/work/migrations.ts']) put(file, '// legacy source');
  put('release.json', { formatVersion: 1, version: '0.1.0', storageGeneration: 1, supportedOrigins: [], recovery: 'previous-code-only', migrations: migrationDigests(sourceRoot) });
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Upgrade Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: sourceRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'legacy release');
  const commit = git('rev-parse', 'HEAD');
  const configPath = path.join(sourceRoot, 'dist-cf/chickpea/wrangler.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.vars.CHICKPEA_APP_VERSION = '0.1.0';
  config.vars.CHICKPEA_SOURCE_COMMIT = commit;
  config.d1_databases[0].migrations_dir = path.join(sourceRoot, 'migrations/better-auth');
  writeFileSync(configPath, JSON.stringify(config));
  const contextPath = environment.CHICKPEA_UPGRADE_CONTEXT;
  const upgrade = JSON.parse(readFileSync(contextPath, 'utf8'));
  writePrivateJson(contextPath, { ...upgrade, sourceRoot, source: { tag: 'v0.1.0', version: '0.1.0', commit } });
  assert.equal(existsSync(path.join(sourceRoot, 'node_modules')), false);
  const result = runHarness(harness, ['--skip-build'], { ...environment, DEPLOY_TEST_EMPTY_SECRET_LIST_AFTER_UPLOAD: '1' });
  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(readFileSync(path.join(harness.root, 'deployment.json'), 'utf8'));
  assert.equal(event.stage, 'ready');
  assert.equal(event.knownVersions[0].commit, commit);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(existsSync(harness.secretCapturePath), false);
  assert.ok(commands(harness.logPath).some((line) => line.includes('"versions","deploy","new-upgrade-version@100%"')));
  put('package.json', { version: '0.1.0', tampered: true });
  writeFileSync(harness.logPath, '');
  const refused = runHarness(harness, ['--skip-build'], environment);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /identity or clean-checkout/);
  assert.equal(readFileSync(harness.logPath, 'utf8'), '');
});

test('customer upgrade rejects changed inventory and schema before every mutation', (context) => {
  for (const overrides of [
    { DEPLOY_TEST_SECRET_LIST: '[]' },
    { DEPLOY_TEST_DEPLOYMENT_STATUS: JSON.stringify({ versions: [{ version_id: 'other', percentage: 100 }] }) },
    { DEPLOY_TEST_AUTH_SCHEMA: JSON.stringify([{ success: true, results: [] }]) },
  ]) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    const result = runHarness(harness, ['--skip-build'], { ...prepareUpgrade(harness), ...overrides });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(commands(harness.logPath).some((line) => /"deploy"|"create"|"apply"|"put"|"bulk"/.test(line)), false);
  }
});

test('successful deploy generates stable auth and prints the setup link after readiness', async (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });

  assert.equal(result.status, 0, result.stderr);
  const link = result.stdout.match(
    /https:\/\/chickpea\.example\.workers\.dev\/admin\/setup#setup=([A-Za-z0-9_-]{43})/,
  );
  assert.ok(link);
  assert.equal(result.stdout.match(/#setup=/g)?.length, 1);
  assert.doesNotMatch(result.stdout, /CHICKPEA_RECOVERY_TOKEN|recovery credential/);
  const config = JSON.parse(readFileSync(path.join(
    harness.root, 'dist-cf', 'chickpea', 'wrangler.json',
  ), 'utf8'));
  assert.match(config.vars.CHICKPEA_SETUP_CAPABILITY_DIGEST, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(config.vars.CHICKPEA_SETUP_CAPABILITY_DIGEST, await digestSetupCapability(link[1]!));
  assert.match(config.vars.CHICKPEA_SETUP_CAPABILITY_ISSUED_AT, /^\d{13}$/);
  assert.match(config.vars.CHICKPEA_DEPLOYMENT_ACTIVATION_DIGEST, /^[A-Za-z0-9_-]{43}$/);
  assert.match(config.vars.CHICKPEA_DEPLOYMENT_ACTIVATION_ISSUED_AT, /^\d{13}$/);
  assert.equal(JSON.stringify(config).includes(link[1]!), false);
  const capture = JSON.parse(readFileSync(harness.secretCapturePath, 'utf8'));
  assert.equal(capture.mode, 0o600);
  assert.match(capture.values.CHICKPEA_AUTH_SECRET, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(capture.values.CHICKPEA_CREDENTIAL_KEY_CURRENT_ID, 'key_v1');
  assert.match(capture.values.CHICKPEA_CREDENTIAL_KEY_KEY_V1, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(
    capture.values.CHICKPEA_CREDENTIAL_KEY_KEY_V1,
    capture.values.CHICKPEA_AUTH_SECRET,
  );
  assert.equal(existsSync(capture.path), false);
  assert.doesNotMatch(result.stdout, /Checking the public setup URL|setup is responding/);
  assert.match(result.stdout, /✔ Worker deployed/);
  assert.match(result.stdout, /Verified current-version deployment readiness/);
  assert.match(result.stdout, /🔐 PRIVATE SETUP LINK/);
  assert.match(result.stdout, /👉 https:\/\/chickpea\.example\.workers\.dev\/admin\/setup#setup=/);
  assert.equal(result.stdout.match(/[A-Za-z0-9_-]{43}/g)?.length, 1);
  const invoked = commands(harness.logPath);
  assert.match(invoked[0] ?? '', /^wrangler:\["secret","list","--format","json","--config",/);
  assert.match(
    invoked[1] ?? '',
    /^wrangler:\["d1","migrations","apply","AUTH_DB","--remote","--config",".*\/dist-cf\/chickpea\/wrangler\.json"\]$/,
  );
  assert.match(invoked[2] ?? '', /^wrangler:\["d1","execute","AUTH_DB","--remote","--json","--command",/);
  assert.match(invoked[3] ?? '', /^wrangler:\["deploy","--secrets-file",".*"\]$/);
});

test('deploy waits through stale Worker and gateway versions before announcing success', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_READINESS_STATUSES: '404,409,503,204',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Waiting for the current Worker and Slack gateway version/);
  assert.match(result.stdout, /Verified current-version deployment readiness/);
  assert.match(result.stdout, /✔ Worker deployed/);
});

test('deploy does not announce readiness when the Slack gateway stays on older code', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_READINESS_STATUSES: '503',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /current-version readiness was not confirmed/);
  assert.doesNotMatch(result.stdout, /✔ Worker deployed/);
});

test('successful custom-route deploy preserves the private setup path when Wrangler reports no origin', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configured Chickpea domain/);
  assert.match(result.stdout, /\/admin\/setup#setup=[A-Za-z0-9_-]{43}/);
  assert.equal(result.stdout.match(/#setup=/g)?.length, 1);
});

test('Worker name overrides fail before secret inspection or resource mutation', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  for (const args of [
    ['--skip-build', '--name', 'different-worker'],
    ['--skip-build', '--name=different-worker'],
  ]) {
    writeFileSync(harness.logPath, '');
    const result = runHarness(harness, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Do not override the Worker name/);
    assert.equal(readFileSync(harness.logPath, 'utf8'), '');
  }
});

test('existing auth authority is preserved and recovery never substitutes for it', (context) => {
  const current = createHarness();
  const legacy = createHarness();
  context.after(() => {
    rmSync(current.root, { recursive: true, force: true });
    rmSync(legacy.root, { recursive: true, force: true });
  });

  const currentResult = runHarness(current, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
  });
  const legacyResult = runHarness(legacy, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_RECOVERY_TOKEN' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
  });

  assert.equal(currentResult.status, 0, currentResult.stderr);
  assert.equal(legacyResult.status, 0, legacyResult.stderr);
  assert.equal(existsSync(current.secretCapturePath), false);
  assert.equal(existsSync(legacy.secretCapturePath), true);
  const legacySecrets = JSON.parse(readFileSync(legacy.secretCapturePath, 'utf8')).values;
  assert.match(legacySecrets.CHICKPEA_AUTH_SECRET, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(legacySecrets, 'CHICKPEA_RECOVERY_TOKEN'), false);
  assert.equal(commands(current.logPath).at(-1), 'wrangler:["deploy"]');
  assert.match(
    commands(legacy.logPath).at(-1) ?? '',
    /^wrangler:\["deploy","--secrets-file","[^"]+\/secrets\.json"\]$/,
  );
});

test('ordinary deploy preserves the existing versioned credential root', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V2' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(harness.secretCapturePath), false);
  const invoked = commands(harness.logPath);
  assert.match(invoked.at(-1) ?? '', /^wrangler:\["deploy"\]$/);
});

test('partially provisioned credential roots fail before deployment mutation', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
    ]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential encryption is only partially provisioned/);
  assert.equal(existsSync(harness.secretCapturePath), false);
  assert.doesNotMatch(readFileSync(harness.logPath, 'utf8'), /\["deploy"/);
  assert.doesNotMatch(readFileSync(harness.logPath, 'utf8'), /"migrations","apply"/);
});

test('new Worker not-found is fresh, but a denied secret inventory stops before mutation', (context) => {
  const fresh = createHarness();
  const denied = createHarness();
  context.after(() => {
    rmSync(fresh.root, { recursive: true, force: true });
    rmSync(denied.root, { recursive: true, force: true });
  });

  const freshResult = runHarness(fresh, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SECRET_LIST_NOT_FOUND: '1',
  });
  const deniedResult = runHarness(denied, ['--skip-build'], {
    DEPLOY_TEST_SECRET_LIST_DENIED: '1',
  });

  assert.equal(freshResult.status, 0, freshResult.stderr);
  assert.equal(existsSync(fresh.secretCapturePath), true);
  assert.doesNotMatch(freshResult.stdout, /Checking the public setup URL/);
  assert.match(freshResult.stdout, /PRIVATE SETUP LINK/);
  assert.equal(deniedResult.status, 1);
  assert.match(deniedResult.stderr, /must allow secret listing/);
  assert.equal(commands(denied.logPath).length, 1);
});

test('failed deploy removes its mode-0600 secret file and retry rotates only setup proof', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const failed = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_DEPLOY_STATUS: '1',
  });
  assert.equal(failed.status, 1);
  const capture = JSON.parse(readFileSync(harness.secretCapturePath, 'utf8'));
  assert.equal(capture.mode, 0o600);
  assert.equal(existsSync(capture.path), false);
  const failedConfig = JSON.parse(readFileSync(
    path.join(harness.root, 'dist-cf', 'chickpea', 'wrangler.json'), 'utf8',
  ));

  writeFileSync(harness.logPath, '');
  rmSync(harness.secretCapturePath, { force: true });
  const retried = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
  });
  assert.equal(retried.status, 0, retried.stderr);
  const retriedConfig = JSON.parse(readFileSync(
    path.join(harness.root, 'dist-cf', 'chickpea', 'wrangler.json'), 'utf8',
  ));
  assert.notEqual(
    retriedConfig.vars.CHICKPEA_SETUP_CAPABILITY_DIGEST,
    failedConfig.vars.CHICKPEA_SETUP_CAPABILITY_DIGEST,
  );
  assert.equal(existsSync(harness.secretCapturePath), false);
});

test('fresh deploy provisions AUTH_DB before migrations and rebuilds the binding', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { databaseId: '' });

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Provisioning the customer-owned AUTH_DB database/);
  const canonicalRoot = realpathSync(harness.root);
  const invoked = commands(harness.logPath);
  assert.match(invoked[0] ?? '', /^wrangler:\["secret","list",/);
  assert.deepEqual(invoked.slice(1, -2), [
    'wrangler:["d1","list","--json"]',
    `wrangler:["d1","create","chickpea-auth-db","--binding","AUTH_DB","--update-config","--config","${path.join(canonicalRoot, 'wrangler.jsonc')}"]`,
    'npm:["run","build"]',
    `wrangler:["d1","migrations","apply","AUTH_DB","--remote","--config","${path.join(canonicalRoot, 'dist-cf', 'chickpea', 'wrangler.json')}"]`,
  ]);
  assert.match(invoked.at(-2) ?? '', /^wrangler:\["d1","execute","AUTH_DB","--remote","--json","--command",/);
  assert.match(invoked.at(-1) ?? '', /^wrangler:\["deploy","--secrets-file",/);
});

test('a claimed target never provisions a disposable AUTH_DB', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'cobalt', databaseId: '' });

  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'cobalt',
    DEPLOY_TEST_URL: 'https://chickpea-cobalt-live.example.workers.dev',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires its registered immutable AUTH_DB.*disposable target mutation is refused/i);
  const invoked = commands(harness.logPath);
  assert.deepEqual(invoked, ['environment-preflight:1:cobalt']);
  assert.equal(invoked.some((command) => command.includes('"d1","create"')), false);
});

test('a claimed target refuses disposable coordinates before inspecting existing Worker state', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'cobalt', databaseId: '' });

  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'cobalt',
    DEPLOY_TEST_WORKER_EXISTS: '1',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires its registered immutable AUTH_DB.*disposable target mutation is refused/i);
  assert.deepEqual(commands(harness.logPath), ['environment-preflight:1:cobalt']);
});

test('a claimed target refuses disposable coordinates before D1 inventory or upload', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: '' });

  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    DEPLOY_TEST_D1_LIST: JSON.stringify([{
      name: 'chickpea-auth-db-amber-live',
      uuid: 'stale-amber-database-id',
    }]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires its registered immutable AUTH_DB.*disposable target mutation is refused/i);
  const invoked = commands(harness.logPath);
  assert.deepEqual(invoked, ['environment-preflight:1:amber']);
  assert.equal(invoked.some((command) => command.includes('"migrations","apply"')), false);
  assert.equal(invoked.some((command) => command.startsWith('wrangler:["deploy"')), false);
});

test('fresh source reuses an existing named AUTH_DB without creating another', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { databaseId: '' });

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_D1_LIST: JSON.stringify([{ name: 'chickpea-auth-db', uuid: 'existing-database-id' }]),
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reusing the customer-owned AUTH_DB database/);
  const canonicalRoot = realpathSync(harness.root);
  const invoked = commands(harness.logPath);
  assert.match(invoked[0] ?? '', /^wrangler:\["secret","list",/);
  assert.deepEqual(invoked.slice(1, -2), [
    'wrangler:["d1","list","--json"]',
    `wrangler:["d1","migrations","apply","AUTH_DB","--remote","--config","${path.join(canonicalRoot, 'dist-cf', 'chickpea', 'wrangler.json')}"]`,
  ]);
  assert.match(invoked.at(-2) ?? '', /^wrangler:\["d1","execute","AUTH_DB","--remote","--json","--command",/);
  assert.match(invoked.at(-1) ?? '', /^wrangler:\["deploy","--secrets-file",/);
  const config = JSON.parse(readFileSync(path.join(
    harness.root,
    'dist-cf',
    'chickpea',
    'wrangler.json',
  ), 'utf8'));
  assert.equal(config.d1_databases[0].database_id, 'existing-database-id');
});

test('an incompatible applied Better Auth schema blocks Worker upload', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_AUTH_SCHEMA: JSON.stringify([{
      success: true,
      results: [{
        type: 'table', name: 'legacy_user', tbl_name: 'legacy_user',
        sql: 'CREATE TABLE legacy_user (id text primary key, password text)',
      }],
    }]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /incompatible reviewed Better Auth migration-chain schema/);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.some((command) => command.includes('"migrations","apply"')), true);
  assert.equal(invoked.some((command) => command.includes('"d1","execute"')), true);
  assert.equal(invoked.some((command) => command.startsWith('wrangler:["deploy"')), false);
});

test('a remote schema missing the reviewed 0002 migration blocks Worker upload', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(AUTH_MIGRATIONS[0]!, 'utf8'));
  const results = database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' " +
      "AND name <> 'd1_migrations' ORDER BY type,name",
  ).all();
  database.close();

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_AUTH_SCHEMA: JSON.stringify([{ success: true, results }]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /incompatible reviewed Better Auth migration-chain schema/);
  assert.equal(
    commands(harness.logPath).some((command) => command.startsWith('wrangler:["deploy"')),
    false,
  );
});

test('the exact schema gate ignores only Cloudflare D1 internal KV metadata', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const database = new DatabaseSync(':memory:');
  for (const migrationPath of AUTH_MIGRATIONS) {
    database.exec(readFileSync(migrationPath, 'utf8'));
  }
  const results = database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' " +
      "AND name <> 'd1_migrations' ORDER BY type,name",
  ).all();
  database.close();
  results.push({
    type: 'table',
    name: '_cf_KV',
    tbl_name: '_cf_KV',
    sql: 'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)',
  });

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_AUTH_SCHEMA: JSON.stringify([{ success: true, results }]),
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });

  assert.equal(result.status, 0, result.stderr);
  const inspection = commands(harness.logPath).find((command) =>
    command.includes('"d1","execute"')
  );
  assert.match(inspection ?? '', /_cf_KV/);
  assert.equal(
    commands(harness.logPath).some((command) => command.startsWith('wrangler:["deploy"')),
    true,
  );
});

test('the exact schema gate accepts Cloudflare D1 parenthesis formatting', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const database = new DatabaseSync(':memory:');
  for (const migrationPath of AUTH_MIGRATIONS) {
    database.exec(readFileSync(migrationPath, 'utf8'));
  }
  const results = database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' " +
      "AND name NOT IN ('d1_migrations','_cf_KV') ORDER BY type,name",
  ).all().map((row) => {
    if (row.type !== 'table' || typeof row.sql !== 'string') return row;
    return {
      ...row,
      sql: row.sql.replace(/\((?=\")/, '( ').replace(/\)$/, ' )'),
    };
  });
  database.close();

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_AUTH_SCHEMA: JSON.stringify([{ success: true, results }]),
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    commands(harness.logPath).some((command) => command.startsWith('wrangler:["deploy"')),
    true,
  );
});

test('an unreadable remote AUTH_DB schema blocks Worker upload', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_AUTH_SCHEMA_INSPECTION_FAIL: '1',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to inspect the migrated AUTH_DB schema/);
  assert.equal(
    commands(harness.logPath).some((command) => command.startsWith('wrangler:["deploy"')),
    false,
  );
});

test('an existing Worker reuses its deployed AUTH_DB id instead of another same-named database', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { databaseId: '' });

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
    DEPLOY_TEST_DEPLOYED_AUTH_DB_ID: 'deployed-database-id',
    DEPLOY_TEST_D1_LIST: JSON.stringify([{
      name: 'chickpea-auth-db',
      uuid: 'different-same-named-database-id',
    }]),
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preserving the deployed AUTH_DB database/);
  const invoked = commands(harness.logPath);
  assert.match(invoked[0] ?? '', /^wrangler:\["secret","list",/);
  assert.match(invoked[1] ?? '', /^wrangler:\["deployments","status","--json",/);
  assert.match(invoked[2] ?? '', /^wrangler:\["versions","view","deployed-version","--json",/);
  assert.equal(invoked.some((command) => command === 'wrangler:["d1","list","--json"]'), false);
  const config = JSON.parse(readFileSync(path.join(
    harness.root,
    'dist-cf',
    'chickpea',
    'wrangler.json',
  ), 'utf8'));
  assert.equal(config.d1_databases[0].database_id, 'deployed-database-id');
});

test('an overlapping deploy aborts instead of replacing another task canary', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const statusSequence = [
    { versions: [{ version_id: 'starting-version', percentage: 100 }] },
    { versions: [{ version_id: 'competing-version', percentage: 100 }] },
  ];

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
    DEPLOY_TEST_DEPLOYMENT_STATUS_SEQUENCE: JSON.stringify(statusSequence),
    DEPLOY_TEST_VERSION_VIEWS: JSON.stringify({
      'starting-version': {
        resources: { bindings: [{
          name: 'AUTH_DB', type: 'd1', id: 'test-database-id',
        }] },
      },
    }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /active Worker deployment changed while this deploy was preparing/i);
  assert.match(result.stderr, /Another task is using the same deployment target/);
  assert.equal(
    commands(harness.logPath).some((command) => command.startsWith('wrangler:["deploy"')),
    false,
  );
});

test('an existing Worker refuses a generated AUTH_DB id that differs from production', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { databaseId: 'stale-database-id' });

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
    DEPLOY_TEST_DEPLOYED_AUTH_DB_ID: 'deployed-database-id',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /generated AUTH_DB.*differs from the deployed database/i);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.some((command) => command.includes('"migrations","apply"')), false);
  assert.equal(invoked.some((command) => command.startsWith('wrangler:["deploy"')), false);
});

test('an existing Worker refuses an active rollout split across AUTH_DB databases', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { databaseId: '' });
  const deploymentStatus = {
    versions: [
      { version_id: 'version-a', percentage: 50 },
      { version_id: 'version-b', percentage: 50 },
    ],
  };
  const versionViews = {
    'version-a': { resources: { bindings: [{ name: 'AUTH_DB', type: 'd1', id: 'database-a' }] } },
    'version-b': { resources: { bindings: [{ name: 'AUTH_DB', type: 'd1', id: 'database-b' }] } },
  };

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
    DEPLOY_TEST_DEPLOYMENT_STATUS: JSON.stringify(deploymentStatus),
    DEPLOY_TEST_VERSION_VIEWS: JSON.stringify(versionViews),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /active Worker versions use different AUTH_DB databases/i);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.some((command) => command.includes('"migrations","apply"')), false);
  assert.equal(invoked.some((command) => command.startsWith('wrangler:["deploy"')), false);
});

test('an existing Worker refuses serving versions that disagree about whether AUTH_DB is bound', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { databaseId: '' });
  const deploymentStatus = {
    versions: [
      { version_id: 'version-with-auth-db', percentage: 50 },
      { version_id: 'version-without-auth-db', percentage: 50 },
    ],
  };
  const versionViews = {
    'version-with-auth-db': {
      resources: { bindings: [{ name: 'AUTH_DB', type: 'd1', id: 'database-a' }] },
    },
    'version-without-auth-db': { resources: { bindings: [] } },
  };

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
    DEPLOY_TEST_DEPLOYMENT_STATUS: JSON.stringify(deploymentStatus),
    DEPLOY_TEST_VERSION_VIEWS: JSON.stringify(versionViews),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /active Worker versions disagree about whether AUTH_DB is bound/i);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.some((command) => command.includes('"migrations","apply"')), false);
  assert.equal(invoked.some((command) => command.startsWith('wrangler:["deploy"')), false);
});

for (const stalledInspection of ['status', 'version']) {
  test(`a timed-out ${stalledInspection} inspection aborts before AUTH_DB migration or Worker deploy`, (context) => {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    writeCutoverArtifact(harness, { databaseId: '' });

    const result = runHarness(harness, ['--skip-build'], {
      DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
      DEPLOY_TEST_TIMEOUT_INSPECTION: stalledInspection,
      CHICKPEA_DEPLOY_INSPECTION_TIMEOUT_MS: '30000',
    }, 20_000);

    assert.equal(result.status, 1, result.stderr);
    if (stalledInspection === 'status') {
      assert.match(result.stderr, /Unable to inspect the active Worker deployment.*Refusing an update/s);
    } else {
      assert.match(result.stderr, /Unable to inspect active Worker version deployed-version.*Refusing an update/s);
    }
    const invoked = commands(harness.logPath);
    assert.ok(invoked.some((command) => command.startsWith(stalledInspection === 'status'
      ? 'wrangler:["deployments","status"'
      : 'wrangler:["versions","view","deployed-version"')));
    assert.equal(invoked.some((command) => command.includes('"migrations","apply"')), false);
    assert.equal(invoked.some((command) => command.startsWith('wrangler:["deploy"')), false);
  });
}

test('fresh AUTH_DB provisioning revalidates the rebuilt database identity before migration or upload', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { databaseId: '' });

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_BUILD_DROP_DATABASE_ID: '1',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /resolved AUTH_DB database identity/);
  const invoked = commands(harness.logPath);
  assert.match(invoked[0] ?? '', /^wrangler:\["secret","list",/);
  assert.deepEqual(invoked.slice(1, 4), [
    'wrangler:["d1","list","--json"]',
    `wrangler:["d1","create","chickpea-auth-db","--binding","AUTH_DB","--update-config","--config","${path.join(realpathSync(harness.root), 'wrangler.jsonc')}"]`,
    'npm:["run","build"]',
  ]);
  assert.equal(invoked.some((command) => command.includes('"migrations","apply"')), false);
  assert.equal(invoked.some((command) => command === 'wrangler:["deploy"]'), false);
});

test('dry-run never provisions a missing AUTH_DB', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { databaseId: '' });

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Provisioning the customer-owned AUTH_DB database/);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('target dry-run prints one exact target tuple without Cloudflare mutation', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: '' });

  const result = runHarness(harness, ['--skip-build', '--dry-run'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
  });

  assert.equal(result.status, 0, result.stderr);
  const tuple =
    'Deployment target: target=amber worker=chickpea-amber-live ' +
    'auth_db=AUTH_DB/chickpea-auth-db-amber-live auth_db_id=disposable ' +
    'd1_schema=0002_mcp_oauth do_schema=v9 state=disposable';
  assert.equal(result.stdout.match(new RegExp(tuple, 'g'))?.length, 1);
  assert.doesNotMatch(result.stdout, /Provisioning|Applying reviewed Better Auth migrations/);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('target dry-run prints the selected immutable D1 and permanent generation', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'cobalt', databaseId: 'cobalt-database-id' });

  const result = runHarness(harness, ['--skip-build', '--dry-run'], {
    CHICKPEA_DEPLOY_TARGET: 'cobalt',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'cobalt-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /target=cobalt worker=chickpea-cobalt-live .*auth_db_id=cobalt-database-id .*state=permanent/,
  );
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('every QA target refuses CLI telemetry environment overrides before Wrangler runs', (context) => {
  for (const target of QA_LANES) for (const overrideArgs of [
    ['--var', 'CHICKPEA_TELEMETRY_ENVIRONMENT:production'],
    ['--var=CHICKPEA_TELEMETRY_ENVIRONMENT:production'],
  ]) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    writeCutoverArtifact(harness, { target, databaseId: '' });

    const result = runHarness(harness, ['--skip-build', '--dry-run', ...overrideArgs], {
      CHICKPEA_DEPLOY_TARGET: target,
    });

    assert.equal(result.status, 1, `${target} ${overrideArgs.join(' ')}`);
    assert.match(result.stderr, /Do not override CHICKPEA_TELEMETRY_ENVIRONMENT/);
    assert.equal(existsSync(harness.logPath), false);
  }
});

test('ordinary customer deploys may still pass a telemetry environment override', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, [
    '--skip-build',
    '--dry-run',
    '--var',
    'CHICKPEA_TELEMETRY_ENVIRONMENT:production',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(commands(harness.logPath), [
    'wrangler:["deploy","--dry-run","--var","CHICKPEA_TELEMETRY_ENVIRONMENT:production"]',
  ]);
});

test('deploy builds by default before forwarding dry-run to Wrangler', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Building the Cloudflare artifact from current source/);
  assert.deepEqual(commands(harness.logPath), [
    'npm:["run","build"]',
    'wrangler:["deploy","--dry-run"]',
  ]);
});

test('Workers Builds reuses its just-built artifact while retaining deploy preflight', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--dry-run'], {
    WORKERS_CI: '1',
    WORKERS_CI_BUILD_UUID: 'workers-build-uuid',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Building the Cloudflare artifact from current source/);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('sandbox deploy rebuilds by default and keeps the selector internal', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { profile: 'sandbox' });

  const result = runHarness(harness, ['--dry-run', '--containers-rollout=none'], {
    CHICKPEA_DEPLOY_PROFILE: 'sandbox',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Building the Cloudflare artifact from current source/);
  assert.deepEqual(commands(harness.logPath), [
    'npm:["run","build"]',
    'wrangler:["deploy","--dry-run","--containers-rollout=none"]',
  ]);
});

test('a claimed QA worktree cannot fall through to production or another lane', (context) => {
  for (const target of ['', 'cobalt']) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    writeFileSync(path.join(harness.root, '.chickpea-environment'), JSON.stringify({
      schemaVersion: 'chickpea-environment-claim/v1', target: 'amber',
    }));
    const result = runHarness(harness, [], { CHICKPEA_DEPLOY_TARGET: target });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /This worktree claims amber/);
    assert.equal(existsSync(harness.logPath), false, 'no build, inspection, migration, or upload');
  }
});

test('unreadable QA ownership and local lane state refuse a default deployment', (context) => {
  for (const kind of ['malformed', 'symlink', 'local']) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    const marker = path.join(harness.root, '.chickpea-environment');
    if (kind === 'malformed') writeFileSync(marker, '{');
    if (kind === 'symlink') symlinkSync(path.join(harness.root, 'absent'), marker);
    if (kind === 'local') mkdirSync(path.join(harness.root, '.chickpea-local-worker'));
    const result = runHarness(harness, [], { CHICKPEA_DEPLOY_TARGET: '' });
    assert.equal(result.status, 1);
    assert.equal(existsSync(harness.logPath), false, kind);
  }
});
