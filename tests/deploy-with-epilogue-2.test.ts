import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness, runHarness, commands, writeCutoverArtifact, writeRoutineArtifact, writeCanaryArtifact, sandboxHarness, sandboxEnv } from './deploy-with-epilogue.fixture.ts';

test('a machine that operates claimed lanes refuses an unnamed deploy until production is named', (context) => {
  const refused = createHarness();
  const named = createHarness();
  const dryRun = createHarness();
  const claimed = createHarness();
  context.after(() => {
    for (const harness of [refused, named, dryRun, claimed]) rmSync(harness.root, { recursive: true, force: true });
  });
  const registry = path.join(refused.root, 'lane-registry');
  mkdirSync(registry, { recursive: true });

  const unnamed = runHarness(refused, [], { CHICKPEA_DEPLOY_TARGET: '', CHICKPEA_ENVIRONMENT_ROOT: registry });
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stderr, /operates claimed QA lanes, so an unnamed deploy is refused/);
  assert.match(unnamed.stderr, /CHICKPEA_DEPLOY_TARGET=production/);
  assert.equal(existsSync(refused.logPath), false, 'no build, inspection, migration, or upload');

  const production = runHarness(named, [], {
    CHICKPEA_DEPLOY_TARGET: 'production', CHICKPEA_ENVIRONMENT_ROOT: registry,
  });
  assert.equal(production.status, 0, production.stderr);
  assert.match(production.stdout, /Current Version ID: deployed-version/);
  assert.ok(commands(named.logPath).some((entry) => entry.startsWith('wrangler:["deploy"')));
  assert.ok(!commands(named.logPath).some((entry) => entry.startsWith('environment-preflight')), 'no lane preflight for the ordinary Worker');
  const config = JSON.parse(readFileSync(path.join(named.root, 'dist-cf', 'chickpea', 'wrangler.json'), 'utf8'));
  assert.equal(config.vars?.CHICKPEA_DEPLOY_TARGET, undefined);

  const dry = runHarness(dryRun, ['--dry-run'], { CHICKPEA_DEPLOY_TARGET: '', CHICKPEA_ENVIRONMENT_ROOT: registry });
  assert.equal(dry.status, 0, dry.stderr);

  writeFileSync(path.join(claimed.root, '.chickpea-environment'), JSON.stringify({
    schemaVersion: 'chickpea-environment-claim/v1', target: 'amber',
  }));
  const wrongLane = runHarness(claimed, [], { CHICKPEA_DEPLOY_TARGET: 'production', CHICKPEA_ENVIRONMENT_ROOT: registry });
  assert.equal(wrongLane.status, 1);
  assert.match(wrongLane.stderr, /This worktree claims amber/);
  assert.equal(existsSync(claimed.logPath), false);
});

test('borrowed installation deployment requires its explicit target and rechecks reservation before mutation', (context) => {
  for (const scenario of ['implicit', 'expired', 'changed', 'existing']) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    writeFileSync(path.join(harness.root, 'scripts/lib/environment-installation.mjs'), `
      import { appendFileSync } from 'node:fs';
      let calls = 0;
      export function assertInstallationDeployment(target, root, tuple) {
        appendFileSync(process.env.DEPLOY_TEST_LOG, 'installation-fence:' + (++calls) + '\\n');
        if (process.env.DEPLOY_TEST_INSTALLATION_FAILURE === 'expired'
          || (tuple && process.env.DEPLOY_TEST_INSTALLATION_FAILURE === 'changed')) throw new Error('installation reservation changed');
      }
    `);
    const result = runHarness(harness, [], {
      CHICKPEA_INSTALLATION_LANE: 'violet',
      CHICKPEA_DEPLOY_TARGET: scenario === 'implicit' ? '' : 'production',
      DEPLOY_TEST_INSTALLATION_FAILURE: scenario,
      DEPLOY_TEST_WORKER_EXISTS: scenario === 'existing' ? '1' : '',
    });
    assert.equal(result.status, 1, scenario);
    if (scenario === 'implicit') {
      assert.match(result.stderr, /explicitly selected Worker/);
      assert.equal(existsSync(harness.logPath), false);
    } else {
      const log = commands(harness.logPath);
      assert.ok(!log.some((entry) => /wrangler:\["deploy"|wrangler:\["d1","(?:create|execute|migrations)"|wrangler:\["secret","(?:put|bulk|delete)"/.test(entry)), 'no database mutation, secret change, or upload');
      if (scenario === 'expired') assert.deepEqual(log, ['installation-fence:1']);
      if (scenario === 'existing') assert.match(result.stderr, /fresh-install Worker already exists/);
      else assert.match(result.stderr, /installation reservation changed/);
    }
  }
});

test('a matching QA target still reaches the existing claim fence before building', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeFileSync(path.join(harness.root, '.chickpea-environment'), JSON.stringify({
    schemaVersion: 'chickpea-environment-claim/v1', target: 'amber',
  }));
  const result = runHarness(harness, [], {
    CHICKPEA_DEPLOY_TARGET: 'amber', DEPLOY_TEST_ENV_PREFLIGHT_FAIL_AT: '1',
  });
  assert.equal(result.status, 1);
  assert.deepEqual(commands(harness.logPath), ['environment-preflight:1:amber']);
});

test('QA source admission refuses stale new and resumed uploads before any build or lane access', (context) => {
  for (const resumed of [false, true]) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    const result = runHarness(harness, [], {
      CHICKPEA_DEPLOY_TARGET: 'amber', DEPLOY_TEST_SOURCE_REFUSED: '1',
      DEPLOY_TEST_SOURCE_LOG: '1', DEPLOY_TEST_ENV_RESUME: resumed ? '1' : '0',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /QA_SOURCE_BEHIND_MAIN/);
    assert.deepEqual(commands(harness.logPath), ['source-admission']);
  }
});

test('QA contents are rechecked after awaited preparation, before D1 and before upload', (context) => {
  for (const resumed of [false, true]) for (const changedAt of [1, 2, 3, 4]) {
    const harness = createHarness();
    context.after(() => rmSync(harness.root, { recursive: true, force: true }));
    writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
    const result = runHarness(harness, ['--skip-build'], {
      CHICKPEA_DEPLOY_TARGET: 'amber', CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
      CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9', DEPLOY_TEST_WORKER_EXISTS: '1',
      DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }, { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' }, { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' }]),
      DEPLOY_TEST_SOURCE_CHANGE_AT: String(changedAt), DEPLOY_TEST_SOURCE_LOG: '1',
      DEPLOY_TEST_ENV_RESUME: resumed ? '1' : '0',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /QA_SOURCE_CHANGED/);
    const invoked = commands(harness.logPath);
    assert.ok(invoked.includes(`source-recheck:${changedAt}`));
    assert.equal(invoked.some((line) => line.startsWith('wrangler:["deploy"')), false);
    if (changedAt <= 3) assert.equal(invoked.some((line) => line.includes('"migrations","apply"')), false);
  }
});

test('Phase 1 deploy fences claim authority before build and again before D1 or upload', (context) => {
  const beforeBuild = createHarness();
  const beforeMutation = createHarness();
  context.after(() => {
    rmSync(beforeBuild.root, { recursive: true, force: true });
    rmSync(beforeMutation.root, { recursive: true, force: true });
  });
  writeCutoverArtifact(beforeBuild, { target: 'amber', databaseId: 'test-database-id' });
  writeCutoverArtifact(beforeMutation, { target: 'amber', databaseId: 'test-database-id' });
  const environment = {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
  };
  const first = runHarness(beforeBuild, [], {
    ...environment, DEPLOY_TEST_ENV_PREFLIGHT_FAIL_AT: '1',
  });
  const second = runHarness(beforeMutation, ['--skip-build'], {
    ...environment, DEPLOY_TEST_ENV_PREFLIGHT_FAIL_AT: '2',
  });
  assert.equal(first.status, 1);
  assert.deepEqual(commands(beforeBuild.logPath), ['environment-preflight:1:amber']);
  assert.equal(second.status, 1);
  const invoked = commands(beforeMutation.logPath);
  assert.equal(invoked.filter((entry) => entry.startsWith('environment-preflight')).length, 2);
  assert.equal(invoked.some((entry) => /"migrations","apply"|wrangler:\["deploy"/.test(entry)), false);
});

test('claimed lanes refuse a missing credential-encryption root before lease or provider mutation', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential encryption.*missing|missing.*credential encryption/i);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.some((entry) => entry.startsWith('environment-begin:')), false);
  assert.equal(invoked.some((entry) => entry.includes('"migrations","apply"')), false);
  assert.equal(invoked.some((entry) => entry.startsWith('wrangler:["deploy"')), false);
});

test('Phase 1 deploy reconciles live version before receipt and suppresses setup capability output', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
  const initialRedirect = JSON.parse(readFileSync(path.join(harness.root, '.wrangler/deploy/config.json'), 'utf8'));
  const initialArtifactPath = path.resolve(harness.root, '.wrangler/deploy', initialRedirect.configPath);
  const initialArtifact = JSON.parse(readFileSync(initialArtifactPath, 'utf8'));
  initialArtifact.vars = { ...initialArtifact.vars, COMPOSIO_SHEETS_READ_AUTH_CONFIG_ID: 'legacy-read-only' };
  writeFileSync(initialArtifactPath, JSON.stringify(initialArtifact));
  const receiptPath = path.join(harness.root, 'receipt.txt');
  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
    DEPLOY_TEST_ENV_RECEIPT: receiptPath,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(receiptPath), true);
  assert.match(commands(harness.logPath).at(-1) ?? '', /^environment-complete:deployed-version$/);
  assert.doesNotMatch(result.stdout, /#setup=|PRIVATE SETUP LINK|PRIVATE SETUP PATH/);
  const redirect = JSON.parse(readFileSync(path.join(harness.root, '.wrangler/deploy/config.json'), 'utf8'));
  const artifact = JSON.parse(readFileSync(path.resolve(harness.root, '.wrangler/deploy', redirect.configPath), 'utf8'));
  assert.equal(artifact.vars.COMPOSIO_SHEETS_WRITE_AUTH_CONFIG_ID, 'standard-amber');
  assert.equal(artifact.vars.COMPOSIO_SHEETS_READ_AUTH_CONFIG_ID, 'standard-amber');
});

test('Phase 1 post-upload serving drift fails without publishing a receipt', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
  const receiptPath = path.join(harness.root, 'receipt.txt');
  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
    DEPLOY_TEST_ENV_RECEIPT: receiptPath,
    DEPLOY_TEST_ENV_POST_DRIFT: '1',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POST_DEPLOY_VERSION_DRIFT/);
  assert.equal(existsSync(receiptPath), false);
});

test('Phase 1 rechecks claim authority after migration and before Worker upload', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
    DEPLOY_TEST_ENV_PREFLIGHT_FAIL_AT: '3',
  });
  assert.equal(result.status, 1);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.some((entry) => entry.includes('"migrations","apply"')), true);
  assert.equal(invoked.filter((entry) => entry.startsWith('environment-preflight')).length, 3);
  assert.equal(invoked.some((entry) => entry.startsWith('wrangler:["deploy"')), false);
});

test('Phase 1 holds one mutation lease from before D1 through receipt completion', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
    DEPLOY_TEST_LOG_MUTATION_LEASE: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  const invoked = commands(harness.logPath);
  const begin = invoked.indexOf('environment-begin:amber');
  const d1 = invoked.findIndex((entry) => entry.includes('"migrations","apply"'));
  const upload = invoked.findIndex((entry) => entry.startsWith('wrangler:["deploy"'));
  const complete = invoked.indexOf('environment-complete-lease:true');
  assert.ok(begin >= 0 && begin < d1 && d1 < upload && upload < complete, invoked.join('\n'));
});

test('Phase 1 retry adopts the existing partial-schema lease instead of creating another intent', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
  const result = runHarness(harness, ['--skip-build', '--profile', 'lane-owner', '--env', 'amber'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_ENV_RESUME: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
    DEPLOY_TEST_LOG_MUTATION_LEASE: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.filter((entry) => entry.startsWith('environment-resume:amber')).length, 1);
  assert.equal(invoked.filter((entry) => entry.startsWith('environment-resume-recheck:amber')).length, 1);
  assert.equal(invoked.some((entry) => entry.startsWith('environment-begin:')), false);
  assert.equal(invoked.some((entry) => entry.includes('environment-complete-lease:true')), true);
  assert.equal(invoked.some((entry) => entry.includes('"migrations","apply"')), true);
  assert.equal(invoked.some((entry) => entry.startsWith('wrangler:["deploy"')), true);
});

test('claimed deploy preserves setup authority and forwards exact provider context', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
  const setupDigest = 'A'.repeat(43);
  const setupIssuedAt = '1788289200000';
  const versionViews = {
    'deployed-version': { resources: { bindings: [
      { name: 'AUTH_DB', type: 'd1', id: 'test-database-id', database_id: 'test-database-id' },
      { name: 'CHICKPEA_SETUP_CAPABILITY_DIGEST', type: 'plain_text', text: setupDigest },
      { name: 'CHICKPEA_SETUP_CAPABILITY_ISSUED_AT', type: 'plain_text', text: setupIssuedAt },
    ] } },
  };
  const result = runHarness(harness, [
    '--skip-build', '--profile', 'lane-account', '--env', 'amber',
  ], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    DEPLOY_TEST_WORKER_EXISTS: '1', DEPLOY_TEST_VERSION_VIEWS: JSON.stringify(versionViews),
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
    DEPLOY_TEST_LOG_PROVIDER_CONTEXT: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(path.join(harness.root, 'dist-cf', 'chickpea', 'wrangler.json'), 'utf8'));
  assert.equal(config.vars.CHICKPEA_SETUP_CAPABILITY_DIGEST, setupDigest);
  assert.equal(config.vars.CHICKPEA_SETUP_CAPABILITY_ISSUED_AT, setupIssuedAt);
  const providerLogs = commands(harness.logPath).filter((entry) => entry.startsWith('environment-provider:'));
  assert.ok(providerLogs.length >= 2);
  assert.ok(providerLogs.every((entry) => entry ===
    'environment-provider:["--profile","lane-account","--env","amber"]'));
});

test('claimed deploy carries lane secrets file provider keys under operator and wrapper secrets', (context) => {
  const harness = createHarness();
  const privateDirectory = mkdtempSync(path.join(tmpdir(), 'chickpea-lane-secrets-'));
  context.after(() => {
    rmSync(harness.root, { recursive: true, force: true });
    rmSync(privateDirectory, { recursive: true, force: true });
  });
  writeCutoverArtifact(harness, { target: 'amber', databaseId: 'test-database-id' });
  const laneFile = path.join(privateDirectory, 'qa-secrets.env');
  writeFileSync(laneFile, [
    'OPENAI_API_KEY=sk-shared',
    'AMBER__BROWSERBASE_API_KEY=bb-amber',
    'COBALT__ANTHROPIC_API_KEY=sk-ant-cobalt',
    'ASANA_QA_TOKEN=asana-held',
    'CHICKPEA_AUTH_SECRET=never-used',
  ].join('\n'), { mode: 0o600 });
  const operatorFile = path.join(privateDirectory, 'operator.json');
  writeFileSync(operatorFile, JSON.stringify({ OPENAI_API_KEY: 'sk-operator' }), { mode: 0o600 });
  const versionViews = {
    'deployed-version': { resources: { bindings: [
      { name: 'AUTH_DB', type: 'd1', id: 'test-database-id', database_id: 'test-database-id' },
      { name: 'CHICKPEA_SETUP_CAPABILITY_DIGEST', type: 'plain_text', text: 'A'.repeat(43) },
      { name: 'CHICKPEA_SETUP_CAPABILITY_ISSUED_AT', type: 'plain_text', text: '1788289200000' },
    ] } },
  };
  const result = runHarness(harness, ['--skip-build'], {
    CHICKPEA_DEPLOY_TARGET: 'amber',
    CHICKPEA_DEPLOY_AUTH_DB_ID: 'test-database-id',
    CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
    CHICKPEA_LANE_SECRETS: '',
    CHICKPEA_LANE_SECRETS_FILE: laneFile,
    CHICKPEA_LANE_CREDENTIALS_DIR: path.join(privateDirectory, 'lane-credentials'),
    CHICKPEA_DEPLOY_SECRETS_FILE: operatorFile,
    DEPLOY_TEST_WORKER_EXISTS: '1', DEPLOY_TEST_VERSION_VIEWS: JSON.stringify(versionViews),
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
  });
  assert.equal(result.status, 0, result.stderr);
  const values = JSON.parse(readFileSync(harness.secretCapturePath, 'utf8')).values;
  assert.equal(values.OPENAI_API_KEY, 'sk-operator', 'an explicit operator secrets file wins');
  assert.equal(values.BROWSERBASE_API_KEY, 'bb-amber');
  assert.equal('ANTHROPIC_API_KEY' in values, false, 'another lane override is not applied');
  assert.equal('ASANA_QA_TOKEN' in values, false, 'database credentials are not Worker secrets');
  assert.notEqual(values.CHICKPEA_AUTH_SECRET, 'never-used');
  const seedFile = JSON.parse(readFileSync(path.join(privateDirectory, 'lane-credentials', 'amber-seed.json'), 'utf8'));
  assert.equal(seedFile.target, 'amber');
  assert.equal(values.CHICKPEA_ENV_SEED_TOKEN, seedFile.seedToken, 'the lane seed token rides the same secrets file');
  assert.match(result.stdout, /Lane seed token: installed \(CHICKPEA_ENV_SEED_TOKEN\)/);
  assert.equal(result.stdout.includes(seedFile.seedToken), false);
  assert.match(result.stdout, /Lane secrets from .*BROWSERBASE_API_KEY \(amber override, sha256:[0-9a-f]{8}\)/);
  assert.doesNotMatch(result.stdout, /sk-shared|bb-amber|asana-held|sk-operator/);
});

test('Worker identity mismatch fails before D1 or deploy mutation', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  const configPath = path.join(harness.root, 'dist-cf', 'chickpea', 'wrangler.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.name = 'other-worker';
  writeFileSync(configPath, JSON.stringify(config));

  const result = runHarness(harness, ['--skip-build']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Worker identity chickpea.*other-worker/);
  assert.equal(existsSync(harness.logPath), false);
});

test('deploy resolves one profile and rejects a stale artifact before Wrangler mutation', (context) => {
  const core = createHarness();
  const sandbox = createHarness();
  const unknown = createHarness();
  context.after(() => {
    rmSync(core.root, { recursive: true, force: true });
    rmSync(sandbox.root, { recursive: true, force: true });
    rmSync(unknown.root, { recursive: true, force: true });
  });
  writeCutoverArtifact(sandbox, { profile: 'sandbox' });

  const coreAsSandbox = runHarness(core, ['--skip-build', '--dry-run'], {
    CHICKPEA_DEPLOY_PROFILE: 'sandbox',
  });
  const sandboxAsCore = runHarness(sandbox, ['--skip-build', '--dry-run']);
  const unknownResult = runHarness(unknown, ['--dry-run'], {
    CHICKPEA_DEPLOY_PROFILE: 'experimental',
  });

  assert.equal(coreAsSandbox.status, 1);
  assert.match(coreAsSandbox.stderr, /profile mismatch.*sandbox.*core/i);
  assert.equal(sandboxAsCore.status, 1);
  assert.match(sandboxAsCore.stderr, /profile mismatch.*core.*sandbox/i);
  assert.equal(unknownResult.status, 1);
  assert.match(unknownResult.stderr, /Invalid CHICKPEA_DEPLOY_PROFILE/);
  assert.equal(existsSync(core.logPath), false);
  assert.equal(existsSync(sandbox.logPath), false);
  assert.equal(existsSync(unknown.logPath), false);
});

test('sandbox preflight requires the exact reviewed binding and container shape', (context) => {
  const missingContainer = createHarness();
  const wrongBinding = createHarness();
  const wrongCapacity = createHarness();
  context.after(() => {
    rmSync(missingContainer.root, { recursive: true, force: true });
    rmSync(wrongBinding.root, { recursive: true, force: true });
    rmSync(wrongCapacity.root, { recursive: true, force: true });
  });
  writeCutoverArtifact(missingContainer, { profile: 'sandbox' });
  const missingConfig = path.join(missingContainer.root, 'dist-cf', 'chickpea', 'wrangler.json');
  const missingBody = JSON.parse(readFileSync(missingConfig, 'utf8'));
  delete missingBody.containers;
  writeFileSync(missingConfig, JSON.stringify(missingBody));
  writeCutoverArtifact(wrongBinding, {
    profile: 'sandbox',
    sandboxBinding: { name: 'SANDBOX', class_name: 'WrongSandbox' },
  });
  writeCutoverArtifact(wrongCapacity, {
    profile: 'sandbox',
    sandboxContainer: {
      class_name: 'Sandbox',
      image: path.join(realpathSync(wrongCapacity.root), 'Dockerfile'),
      instance_type: 'standard-1',
      max_instances: 1,
    },
  });

  for (const harness of [missingContainer, wrongBinding, wrongCapacity]) {
    const result = runHarness(harness, ['--skip-build', '--preflight-only'], {
      CHICKPEA_DEPLOY_PROFILE: 'sandbox',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /partial or duplicate Sandbox infrastructure/i);
    assert.equal(existsSync(harness.logPath), false);
  }
});

test('preflight preserves the v3 Sandbox class migration in both profiles', (context) => {
  const core = createHarness();
  const sandbox = createHarness();
  context.after(() => {
    rmSync(core.root, { recursive: true, force: true });
    rmSync(sandbox.root, { recursive: true, force: true });
  });
  writeCutoverArtifact(sandbox, { profile: 'sandbox' });
  for (const [harness, profile] of [[core, 'core'], [sandbox, 'sandbox']] as const) {
    const configPath = path.join(harness.root, 'dist-cf', 'chickpea', 'wrangler.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.migrations.find((migration: { tag: string }) => migration.tag === 'v3').new_sqlite_classes = [];
    writeFileSync(configPath, JSON.stringify(config));
    const result = runHarness(harness, ['--skip-build', '--preflight-only'], {
      CHICKPEA_DEPLOY_PROFILE: profile,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /v3 Sandbox SQLite class/);
  }
});

test('preflight preserves the applied AuthGuard creation and exact retirement', (context) => {
  const missingHistory = createHarness();
  const unsafeRetirement = createHarness();
  context.after(() => {
    rmSync(missingHistory.root, { recursive: true, force: true });
    rmSync(unsafeRetirement.root, { recursive: true, force: true });
  });

  const missingPath = path.join(missingHistory.root, 'dist-cf', 'chickpea', 'wrangler.json');
  const missingConfig = JSON.parse(readFileSync(missingPath, 'utf8'));
  missingConfig.migrations = missingConfig.migrations.filter(
    (migration: { tag: string }) => migration.tag !== 'v7',
  );
  writeFileSync(missingPath, JSON.stringify(missingConfig));

  const unsafePath = path.join(unsafeRetirement.root, 'dist-cf', 'chickpea', 'wrangler.json');
  const unsafeConfig = JSON.parse(readFileSync(unsafePath, 'utf8'));
  unsafeConfig.migrations.find(
    (migration: { tag: string }) => migration.tag === 'v8',
  ).deleted_classes.push('TagStateStore');
  writeFileSync(unsafePath, JSON.stringify(unsafeConfig));

  const missingResult = runHarness(missingHistory, ['--skip-build', '--preflight-only']);
  const unsafeResult = runHarness(unsafeRetirement, ['--skip-build', '--preflight-only']);

  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /v7 AuthGuard SQLite class history/);
  assert.equal(unsafeResult.status, 1);
  assert.match(unsafeResult.stderr, /protected classes.*TagStateStore/);
});

test('deploy skip-build flag stays private while dry-run still reaches Wrangler', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Building the Cloudflare artifact from current source/);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('preflight-only validates the permanent generated artifact without invoking Wrangler', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build', '--preflight-only']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Permanent Cloudflare capability preflight passed/);
  assert.equal(existsSync(harness.logPath), false);
});

test('Agent View is the permanent manifest contract and deploys without a cutover latch', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });

  assert.equal(result.status, 0, result.stderr);
  const invoked = commands(harness.logPath);
  assert.match(
    invoked[1] ?? '',
    /^wrangler:\["d1","migrations","apply","AUTH_DB","--remote","--config",".*\/dist-cf\/chickpea\/wrangler\.json"\]$/,
  );
  assert.match(invoked[2] ?? '', /^wrangler:\["d1","execute","AUTH_DB","--remote","--json","--command",/);
  assert.match(invoked[3] ?? '', /^wrangler:\["deploy","--secrets-file",/);
});

test('Agent View manifest validation fails closed for unreadable, malformed, dual-view, and legacy manifests', (context) => {
  const missing = createHarness();
  const malformed = createHarness();
  const dualView = createHarness();
  const legacy = createHarness();
  context.after(() => {
    rmSync(missing.root, { recursive: true, force: true });
    rmSync(malformed.root, { recursive: true, force: true });
    rmSync(dualView.root, { recursive: true, force: true });
    rmSync(legacy.root, { recursive: true, force: true });
  });
  rmSync(path.join(missing.root, 'slack-app-manifest.json'));
  writeFileSync(path.join(malformed.root, 'slack-app-manifest.json'), '{not-json');
  writeFileSync(
    path.join(dualView.root, 'slack-app-manifest.json'),
    JSON.stringify({ features: { agent_view: {}, assistant_view: {} } }),
  );
  writeFileSync(
    path.join(legacy.root, 'slack-app-manifest.json'),
    JSON.stringify({ features: { assistant_view: { assistant_description: 'Legacy source' } } }),
  );

  const missingResult = runHarness(missing, ['--skip-build']);
  const malformedResult = runHarness(malformed, ['--skip-build']);
  const dualViewResult = runHarness(dualView, ['--skip-build']);
  const legacyResult = runHarness(legacy, ['--skip-build']);

  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /Unable to validate the Slack manifest/);
  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /Unable to validate the Slack manifest/);
  assert.equal(dualViewResult.status, 1);
  assert.match(dualViewResult.stderr, /agent_view and assistant_view cannot coexist/);
  assert.equal(legacyResult.status, 1);
  assert.match(legacyResult.stderr, /requires features\.agent_view/);
  assert.equal(existsSync(missing.logPath), false);
  assert.equal(existsSync(malformed.logPath), false);
  assert.equal(existsSync(dualView.logPath), false);
  assert.equal(existsSync(legacy.logPath), false);
});

test('Agent View validation fails closed when the generated artifact omits the permanent contract', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { agentViewArtifact: false });

  const result = runHarness(harness, ['--skip-build', '--preflight-only']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing the permanent Agent View contract/);
  assert.equal(existsSync(harness.logPath), false);
});

test('preflight rejects unexpected or protected destructive class operations', (context) => {
  const unexpected = createHarness();
  const protectedState = createHarness();
  context.after(() => {
    rmSync(unexpected.root, { recursive: true, force: true });
    rmSync(protectedState.root, { recursive: true, force: true });
  });
  writeCutoverArtifact(unexpected, {
    deletedClasses: [
      'FlueRegistry', 'FlueSlackThreadAgent', 'FlueRoutineIntentAgent',
      'FlueRoutineWorkflow', 'UnexpectedClass',
    ],
  });
  writeCutoverArtifact(protectedState, {
    deletedClasses: [
      'FlueRegistry', 'FlueSlackThreadAgent', 'FlueRoutineIntentAgent',
      'FlueRoutineWorkflow', 'TagStateStore',
    ],
  });

  const unexpectedResult = runHarness(unexpected, ['--skip-build', '--preflight-only']);
  const protectedResult = runHarness(protectedState, ['--skip-build', '--preflight-only']);

  assert.equal(unexpectedResult.status, 1);
  assert.match(unexpectedResult.stderr, /UnexpectedClass/);
  assert.equal(protectedResult.status, 1);
  assert.match(protectedResult.stderr, /protected classes.*TagStateStore/);
});

test('preflight rejects missing bindings, missing content-free tracing, and stale dates', (context) => {
  const missingState = createHarness();
  const missingRunner = createHarness();
  const missingVersionMetadata = createHarness();
  const tracingDisabled = createHarness();
  const missingTracer = createHarness();
  const missingSandboxRedaction = createHarness();
  const stale = createHarness();
  const privateGlobalFetch = createHarness();
  context.after(() => {
    rmSync(missingState.root, { recursive: true, force: true });
    rmSync(missingRunner.root, { recursive: true, force: true });
    rmSync(missingVersionMetadata.root, { recursive: true, force: true });
    rmSync(tracingDisabled.root, { recursive: true, force: true });
    rmSync(missingTracer.root, { recursive: true, force: true });
    rmSync(missingSandboxRedaction.root, { recursive: true, force: true });
    rmSync(stale.root, { recursive: true, force: true });
    rmSync(privateGlobalFetch.root, { recursive: true, force: true });
  });
  writeCutoverArtifact(missingState, { missingBinding: 'TAG_STATE' });
  writeCutoverArtifact(missingRunner, { missingBinding: 'SLACK_THREAD_RUNNER' });
  writeCutoverArtifact(missingVersionMetadata, { versionMetadata: false });
  writeCutoverArtifact(tracingDisabled, { tracing: false });
  writeCutoverArtifact(missingTracer, { cloudflareTracer: false });
  writeCutoverArtifact(missingSandboxRedaction, { sandboxCommandRedaction: false });
  writeCutoverArtifact(stale, { compatibilityDate: '2026-03-31' });
  writeCutoverArtifact(privateGlobalFetch, { publicGlobalFetch: false });

  const stateResult = runHarness(missingState, ['--skip-build', '--preflight-only']);
  const runnerResult = runHarness(missingRunner, ['--skip-build', '--preflight-only']);
  const versionMetadataResult = runHarness(
    missingVersionMetadata,
    ['--skip-build', '--preflight-only'],
  );
  const tracingDisabledResult = runHarness(
    tracingDisabled,
    ['--skip-build', '--preflight-only'],
  );
  const missingTracerResult = runHarness(missingTracer, ['--skip-build', '--preflight-only']);
  const missingSandboxRedactionResult = runHarness(
    missingSandboxRedaction,
    ['--skip-build', '--preflight-only'],
  );
  const staleResult = runHarness(stale, ['--skip-build', '--preflight-only']);
  const privateGlobalFetchResult = runHarness(
    privateGlobalFetch,
    ['--skip-build', '--preflight-only'],
  );

  assert.equal(stateResult.status, 1);
  assert.match(stateResult.stderr, /TAG_STATE\/TagStateStore binding/);
  assert.equal(runnerResult.status, 1);
  assert.match(runnerResult.stderr, /SLACK_THREAD_RUNNER\/SlackThreadRunner binding/);
  assert.equal(versionMetadataResult.status, 1);
  assert.match(versionMetadataResult.stderr, /CF_VERSION_METADATA Worker version binding/);
  assert.equal(tracingDisabledResult.status, 1);
  assert.match(tracingDisabledResult.stderr, /enabled Workers Traces/);
  assert.equal(missingTracerResult.status, 1);
  assert.match(missingTracerResult.stderr, /content-free Cloudflare tracing/);
  assert.equal(missingSandboxRedactionResult.status, 1);
  assert.match(missingSandboxRedactionResult.stderr, /content-free Cloudflare Sandbox exec/);
  assert.equal(staleResult.status, 1);
  assert.match(staleResult.stderr, /compatibility_date at or above 2026-04-01/);
  assert.equal(privateGlobalFetchResult.status, 1);
  assert.match(privateGlobalFetchResult.stderr, /global_fetch_strictly_public/);
});

test('deploy rejects stale custom Wrangler config flags before any command runs', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build', '--config', 'wrangler.jsonc']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Do not pass a custom Wrangler config/);
  assert.equal(existsSync(harness.logPath), false);
});

test('permanent routines require Cron, state, and both fresh Flue 2 routine agents', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeRoutineArtifact(harness);

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('deploy refuses the permanent routines artifact with a missing heartbeat', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeRoutineArtifact(harness, { cron: false });

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Routine scheduling artifact is unsafe/);
  assert.match(result.stderr, /heartbeat Cron Trigger/);
  assert.equal(existsSync(harness.logPath), false);
});

test('deploy refuses permanent routines without both generated Flue 2 agents', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeRoutineArtifact(harness, { routineAgents: false });

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Flue 2 cutover preflight failed/);
  assert.match(result.stderr, /ROUTINE_INTENT_V2_AGENT/);
  assert.equal(existsSync(harness.logPath), false);
});

test('deploy accepts an exact-channel ledger canary only with durable driver seams', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCanaryArtifact(harness);

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('deploy refuses malformed or oversized ledger canary selectors', (context) => {
  const malformed = createHarness();
  const oversized = createHarness();
  context.after(() => {
    rmSync(malformed.root, { recursive: true, force: true });
    rmSync(oversized.root, { recursive: true, force: true });
  });
  writeCanaryArtifact(malformed, { selector: 'T_ACME/*' });
  writeCanaryArtifact(oversized, {
    selector: Array.from({ length: 21 }, (_, index) => `T_ACME/C_${index}`).join(','),
  });

  const malformedResult = runHarness(malformed, ['--skip-build', '--dry-run']);
  const oversizedResult = runHarness(oversized, ['--skip-build', '--dry-run']);

  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /1-20 exact workspace\/channel pairs/);
  assert.equal(oversizedResult.status, 1);
  assert.match(oversizedResult.stderr, /1-20 exact workspace\/channel pairs/);
  assert.equal(existsSync(malformed.logPath), false);
  assert.equal(existsSync(oversized.logPath), false);
});

test('deploy refuses a ledger canary override on an artifact without driver seams', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCanaryArtifact(harness, { selector: '', complete: false });

  const result = runHarness(harness, [
    '--skip-build',
    '--dry-run',
    '--var',
    'SLACK_TAG_LEDGER_CANARY_CHANNELS:T_ACME/C_AGENT_TEST',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing durable driver seams/);
  assert.equal(existsSync(harness.logPath), false);
});

test('deploy accepts the thread runner executor only on an artifact that carries it', (context) => {
  const accepted = createHarness();
  const configured = createHarness();
  const malformed = createHarness();
  const incomplete = createHarness();
  context.after(() => {
    for (const harness of [accepted, configured, malformed, incomplete]) {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
  writeCutoverArtifact(accepted);
  writeCutoverArtifact(configured, { turnExecutor: 'alarm' });
  writeCutoverArtifact(malformed);
  writeCutoverArtifact(incomplete, { runnerSeams: false });

  const acceptedResult = runHarness(accepted, [
    '--skip-build', '--dry-run', '--var', 'SLACK_TAG_TURN_EXECUTOR:runner',
  ]);
  const configuredResult = runHarness(configured, ['--skip-build', '--dry-run']);
  const malformedResult = runHarness(malformed, [
    '--skip-build', '--dry-run', '--var=SLACK_TAG_TURN_EXECUTOR:thread',
  ]);
  const incompleteResult = runHarness(incomplete, [
    '--skip-build', '--dry-run', '--var', 'SLACK_TAG_TURN_EXECUTOR:runner',
  ]);

  assert.equal(acceptedResult.status, 0, acceptedResult.stderr);
  assert.equal(configuredResult.status, 0, configuredResult.stderr);
  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /must be runner or alarm/);
  assert.equal(existsSync(malformed.logPath), false);
  assert.equal(incompleteResult.status, 1);
  assert.match(incompleteResult.stderr, /missing thread runner seams: SLACK_TAG_TURN_EXECUTOR/);
  assert.equal(existsSync(incomplete.logPath), false);
});

test('sandbox preflight reports every blocking problem before build, D1, or upload', (context) => {
  const harness = sandboxHarness(context);
  const result = runHarness(harness, ['--profile', 'acme'], sandboxEnv(harness, {
    DEPLOY_TEST_DOCKER_DOWN: '1',
    DEPLOY_TEST_CONTAINERS_ACCESS: 'scope',
  }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /found 2 problems\. Nothing was built, migrated, or uploaded/);
  assert.match(result.stderr, /Docker daemon is not reachable/);
  assert.match(result.stderr, /auth profile "acme" does not include containers:write/);
  assert.match(
    result.stderr,
    /npx wrangler auth create acme --scopes account:read user:read workers:write d1:write containers:write\n/,
  );
  assert.doesNotMatch(result.stderr, /--scopes[^\n]*offline_access/);
  assert.doesNotMatch(result.stderr, /\n\s+npx wrangler login --profile/);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.some((line) => line.startsWith('npm:') || /"(d1|deploy)"/.test(line)), false, invoked.join('\n'));
  assert.equal(invoked.some((line) => line.startsWith('docker:["pull"')), false, 'no pull without a daemon');
});

test('a sandbox deploy on an account without R2 goes ahead with workspace checkpoints off', (context) => {
  const harness = sandboxHarness(context);
  // The prepared sandbox artifact carries the BACKUP_BUCKET binding.
  const result = runHarness(harness, ['--skip-build', '--profile', 'acme'], sandboxEnv(harness, {
    DEPLOY_TEST_R2_ACCESS: 'disabled',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  }));
  assert.equal(result.status, 0, result.stderr);
  const invoked = commands(harness.logPath);
  const probe = invoked.findIndex((line) => line.startsWith('wrangler:["r2","bucket","list"'));
  const deploy = invoked.findIndex((line) => line.startsWith('wrangler:["deploy"'));
  assert.ok(probe >= 0 && probe < deploy, invoked.join('\n'));
  assert.match(invoked[probe]!, /"--profile","acme"/);
  // `r2 bucket list` ignores the config's account_id, so the probe pins it.
  assert.ok(invoked.includes(`r2-account:${'a'.repeat(32)}`), invoked.join('\n'));
  // Wrangler never sees the binding, so it never tries to create a bucket.
  assert.ok(invoked.includes('deploy-r2:[]'), invoked.join('\n'));
  assert.match(result.stdout, /deploying with coding workspace checkpoints off/);
  assert.match(result.stdout, new RegExp(`! R2 is not enabled on Cloudflare account ${'a'.repeat(32)}, so this deploy leaves coding workspace checkpoints off`));
  assert.match(result.stdout, /open R2 Object Storage in the Cloudflare dashboard, enable R2 \(the free tier is enough; do not create a bucket\), and rerun the same command/);
  assert.match(result.stdout, /Container application chickpea-sandbox exists/);
  assert.doesNotMatch(result.stderr, /PARTIAL SANDBOX DEPLOY|10042/);
});

test('sandbox re-auth guidance matches global logins, bound profiles, and API tokens', (context) => {
  const global = sandboxHarness(context);
  const globalResult = runHarness(global, [], sandboxEnv(global, { DEPLOY_TEST_CONTAINERS_ACCESS: 'scope' }));
  assert.equal(globalResult.status, 1);
  assert.match(globalResult.stderr, /npx wrangler login --scopes account:read user:read workers:write d1:write containers:write\n/);

  const bound = sandboxHarness(context);
  const boundResult = runHarness(bound, [], sandboxEnv(bound, {
    DEPLOY_TEST_CONTAINERS_ACCESS: 'scope',
    DEPLOY_TEST_AUTH_LIST: `│ Profile │ Bound Directories │\n│ customer │ ${realpathSync(bound.root)} │\n`,
  }));
  assert.equal(boundResult.status, 1);
  assert.match(boundResult.stderr, /npx wrangler auth create customer --scopes /);

  const token = sandboxHarness(context);
  const tokenResult = runHarness(token, [], sandboxEnv(token, {
    DEPLOY_TEST_CONTAINERS_ACCESS: 'denied',
    CLOUDFLARE_API_TOKEN: 'test-token',
  }));
  assert.equal(tokenResult.status, 1);
  assert.match(tokenResult.stderr, /API token in the environment cannot manage Containers.*Containers: Edit/s);
  assert.doesNotMatch(tokenResult.stderr, /test-token/);
});

test('sandbox deploy retries the base image pull and prebuilds the image before the upload', (context) => {
  const harness = sandboxHarness(context);
  const result = runHarness(harness, ['--skip-build', '--profile', 'acme'], sandboxEnv(harness, {
    DEPLOY_TEST_DOCKER_PULL_FAILS: '1',
    DEPLOY_TEST_CONTAINER_BUILD_FAILS: '1',
  }));
  assert.equal(result.status, 0, result.stderr);
  const invoked = commands(harness.logPath);
  assert.equal(invoked.filter((line) => line.startsWith('docker:["pull","--platform","linux/amd64","docker.io/cloudflare/sandbox:0.12.4"]')).length, 2);
  const builds = invoked.flatMap((line, index) => /^wrangler:\["containers","build"/.test(line) ? [index] : []);
  assert.equal(builds.length, 2, 'a failed image build is retried before anything is live');
  assert.match(invoked[builds[0]!]!, /"--push".*"--profile","acme"/);
  const migration = invoked.findIndex((line) => line.startsWith('wrangler:["d1","migrations","apply"'));
  const deploy = invoked.findIndex((line) => line.startsWith('wrangler:["deploy"'));
  assert.ok(builds[1]! < migration && migration < deploy, invoked.join('\n'));
  const image = invoked.find((line) => line.startsWith('deploy-image:'));
  assert.match(image ?? '', new RegExp(`^deploy-image:registry\\.cloudflare\\.com/${'a'.repeat(32)}/chickpea-sandbox:[a-f0-9]{12}-[a-z0-9]+$`));
  assert.ok(invoked.includes('deploy-r2:["BACKUP_BUCKET"]'), 'R2 enabled keeps the checkpoint bucket binding');
  assert.doesNotMatch(result.stdout, /checkpoints off/);
  assert.match(result.stdout, /Container application chickpea-sandbox exists \(state: active\)/);
  assert.match(result.stdout, /Coding sandbox, choose Check again, and choose Enable coding sandbox/);
});

test('an image that never builds leaves the live Worker untouched', (context) => {
  const harness = sandboxHarness(context);
  const result = runHarness(harness, ['--skip-build'], sandboxEnv(harness, { DEPLOY_TEST_CONTAINER_BUILD_FAILS: '9' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not build and push after 3 attempts\. Nothing was uploaded/);
  assert.equal(commands(harness.logPath).some((line) => /"(d1|deploy)"/.test(line)), false);
});

test('a sandbox deploy that fails after the upload prints rerun and rollback recovery', (context) => {
  const harness = sandboxHarness(context);
  const result = runHarness(harness, ['--skip-build', '--profile', 'acme'], sandboxEnv(harness, {
    CHICKPEA_DEPLOY_TARGET: 'production',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
    DEPLOY_TEST_DEPLOYMENT_STATUS: JSON.stringify({ versions: [{ version_id: 'previous-core-version', percentage: 100 }] }),
    DEPLOY_TEST_DEPLOY_UPLOADED: '1',
    DEPLOY_TEST_DEPLOY_STATUS: '1',
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PARTIAL SANDBOX DEPLOY/);
  assert.match(result.stderr, /CHICKPEA_DEPLOY_TARGET=production npm run deploy:sandbox -- --profile acme\n/);
  assert.match(result.stderr, /npx wrangler rollback previous-core-version --name chickpea --profile acme/);
  assert.doesNotMatch(result.stdout, /Worker deployed|SETUP LINK/);
});

test('a sandbox deploy that fails before the script upload says the live version is unchanged', (context) => {
  const harness = sandboxHarness(context);
  const result = runHarness(harness, ['--skip-build', '--profile', 'acme'], sandboxEnv(harness, {
    CHICKPEA_DEPLOY_TARGET: 'production',
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([
      { name: 'CHICKPEA_AUTH_SECRET' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID' },
      { name: 'CHICKPEA_CREDENTIAL_KEY_KEY_V1' },
    ]),
    DEPLOY_TEST_DEPLOYMENT_STATUS: JSON.stringify({ versions: [{ version_id: 'previous-core-version', percentage: 100 }] }),
    // The asset upload prints `Uploaded 3 of 3 assets`; that is not the Worker upload.
    DEPLOY_TEST_DEPLOY_R2_DISABLED: '1',
  }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Uploaded 3 of 3 assets/);
  assert.doesNotMatch(result.stderr, /PARTIAL SANDBOX DEPLOY|new Worker version is live|wrangler rollback/);
  assert.match(result.stderr, /STOPPED BEFORE THE WORKER UPLOAD: no new Worker version was uploaded, and the live version is\nunchanged/);
  assert.match(result.stderr, /CHICKPEA_DEPLOY_TARGET=production npm run deploy:sandbox -- --profile acme\n/);
  assert.doesNotMatch(result.stdout, /Worker deployed|SETUP LINK/);
});

test('a finished sandbox deploy without its Container application is not reported as success', (context) => {
  const harness = sandboxHarness(context);
  const result = runHarness(harness, ['--skip-build'], sandboxEnv(harness, {
    DEPLOY_TEST_CONTAINER_APPS_SEQUENCE: JSON.stringify([[], []]),
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Container application named chickpea-sandbox exists/);
  assert.match(result.stderr, /PARTIAL SANDBOX DEPLOY/);
  assert.doesNotMatch(result.stdout, /SETUP LINK/);
});

test('a core deploy refuses to silently remove a live coding sandbox', (context) => {
  const existingSandbox = {
    DEPLOY_TEST_WORKER_EXISTS: '1',
    DEPLOY_TEST_VERSION_VIEWS: JSON.stringify({ 'deployed-version': { resources: { bindings: [
      { name: 'AUTH_DB', type: 'd1', id: 'test-database-id', database_id: 'test-database-id' },
      { name: 'SANDBOX', type: 'durable_object_namespace', class_name: 'Sandbox', namespace_id: 'ns' },
    ] } } }),
  };
  const implicit = createHarness();
  const explicit = createHarness();
  context.after(() => {
    rmSync(implicit.root, { recursive: true, force: true });
    rmSync(explicit.root, { recursive: true, force: true });
  });
  const refused = runHarness(implicit, ['--skip-build', '--profile', 'acme'], existingSandbox);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /live Worker has the coding sandbox.*npm run deploy:sandbox.*CHICKPEA_DEPLOY_PROFILE=core/s);
  assert.equal(commands(implicit.logPath).some((line) => /"(d1","migrations|deploy)"/.test(line)), false);

  const removed = runHarness(explicit, ['--skip-build'], {
    ...existingSandbox,
    CHICKPEA_DEPLOY_PROFILE: 'core',
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });
  assert.equal(removed.status, 0, removed.stderr);
});
