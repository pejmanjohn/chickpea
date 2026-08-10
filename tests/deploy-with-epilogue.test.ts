import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { digestSetupCapability } from '../src/auth/setup-capability.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'deploy-with-epilogue.mjs');
const PROFILE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'cloudflare-deployment-profile.mjs');
const CAPABILITY_SCRIPT = path.join(PROJECT_ROOT, 'src', 'auth', 'setup-capability.mjs');

function createHarness() {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-deploy-wrapper-'));
  const scriptsDir = path.join(root, 'scripts');
  const authDir = path.join(root, 'src', 'auth');
  const wranglerDir = path.join(root, 'node_modules', 'wrangler', 'bin');
  const logPath = path.join(root, 'commands.log');
  const secretCapturePath = path.join(root, 'secret-capture.json');
  const npmStub = path.join(root, 'fake-npm.mjs');
  const wranglerStub = path.join(wranglerDir, 'wrangler.js');
  const fetchStub = path.join(root, 'fake-fetch.mjs');

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  mkdirSync(wranglerDir, { recursive: true });
  copyFileSync(DEPLOY_SCRIPT, path.join(scriptsDir, 'deploy-with-epilogue.mjs'));
  copyFileSync(PROFILE_SCRIPT, path.join(scriptsDir, 'cloudflare-deployment-profile.mjs'));
  copyFileSync(CAPABILITY_SCRIPT, path.join(authDir, 'setup-capability.mjs'));

  const commandLogger = (label: string) => `
    import { appendFileSync } from 'node:fs';
    appendFileSync(
      process.env.DEPLOY_TEST_LOG,
      ${JSON.stringify(label)} + ':' + JSON.stringify(process.argv.slice(2)) + '\\n',
    );
  `;
  writeFileSync(
    npmStub,
    commandLogger('npm') + `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      if (process.argv[2] === 'run' && process.argv[3] === 'build') {
        const rootConfig = path.join(process.cwd(), 'wrangler.jsonc');
        const builtConfig = path.join(process.cwd(), 'dist-cf', 'chickpea', 'wrangler.json');
        if (existsSync(rootConfig) && existsSync(builtConfig)) {
          const config = JSON.parse(readFileSync(rootConfig, 'utf8'));
          if (process.env.DEPLOY_TEST_BUILD_DROP_DATABASE_ID === '1') {
            delete config.d1_databases.find((entry) => entry.binding === 'AUTH_DB').database_id;
          }
          writeFileSync(builtConfig, JSON.stringify(config));
        }
      }
    `,
  );
  writeFileSync(
    wranglerStub,
    commandLogger('wrangler') + `
      import { readFileSync, statSync, writeFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      if (args[0] === 'secret' && args[1] === 'list') {
        if (process.env.DEPLOY_TEST_SECRET_LIST_NOT_FOUND === '1') {
          process.stderr.write('Worker "chickpea" not found.');
          process.exit(1);
        }
        if (process.env.DEPLOY_TEST_SECRET_LIST_DENIED === '1') {
          process.stderr.write('Authentication error [code: 10000]');
          process.exit(1);
        }
        process.stdout.write(process.env.DEPLOY_TEST_SECRET_LIST || '[]');
        process.exit(0);
      }
      if (args[0] === 'd1' && args[1] === 'list' && args.includes('--json')) {
        process.stdout.write(process.env.DEPLOY_TEST_D1_LIST || '[]');
        process.exit(0);
      }
      if (args[0] === 'd1' && args[1] === 'create' && args.includes('--update-config')) {
        const configPath = args[args.indexOf('--config') + 1];
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const authDb = config.d1_databases.find((entry) => entry.binding === 'AUTH_DB');
        authDb.database_id = 'provisioned-database-id';
        writeFileSync(configPath, JSON.stringify(config));
      }
      if (args[0] === 'deploy' && args.includes('--secrets-file')) {
        const secretPath = args[args.indexOf('--secrets-file') + 1];
        writeFileSync(process.env.DEPLOY_TEST_SECRET_CAPTURE, JSON.stringify({
          path: secretPath,
          mode: statSync(secretPath).mode & 0o777,
          values: JSON.parse(readFileSync(secretPath, 'utf8')),
        }));
      }
      if (process.env.DEPLOY_TEST_URL) process.stdout.write(process.env.DEPLOY_TEST_URL + '\\n');
      if (args[0] === 'deploy' && process.env.DEPLOY_TEST_DEPLOY_STATUS) {
        process.exit(Number(process.env.DEPLOY_TEST_DEPLOY_STATUS));
      }
    `,
  );
  writeFileSync(fetchStub, `
    let fetchCount = 0;
    globalThis.fetch = async (input, init) => {
      const statuses = (process.env.DEPLOY_TEST_SETUP_STATUSES
        || process.env.DEPLOY_TEST_SETUP_STATUS
        || '200').split(',').map(Number);
      const status = statuses[Math.min(fetchCount, statuses.length - 1)];
      fetchCount += 1;
      const headers = status >= 300 && status < 400 ? { location: '/admin' } : undefined;
      if (process.env.DEPLOY_TEST_FETCH_LOG) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(process.env.DEPLOY_TEST_FETCH_LOG, JSON.stringify({
          url: String(input), method: init?.method, redirect: init?.redirect,
        }) + '\\n');
      }
      if (process.env.DEPLOY_TEST_FETCH_BODY_NEVER_SETTLES === '1') {
        return {
          status,
          body: { cancel: () => new Promise(() => {}) },
        };
      }
      return new Response('', { status, headers });
    };
  `);
  writeFileSync(
    path.join(root, 'slack-app-manifest.json'),
    JSON.stringify({ features: { agent_view: { agent_description: 'Test agent' } } }),
  );

  const harness = {
    root,
    logPath,
    secretCapturePath,
    fetchStub,
    npmStub,
    script: path.join(scriptsDir, 'deploy-with-epilogue.mjs'),
  };
  writeCutoverArtifact(harness);
  return harness;
}

function runHarness(
  harness: ReturnType<typeof createHarness>,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  timeout?: number,
) {
  const env = { ...process.env };
  Object.assign(env, envOverrides);
  return spawnSync(process.execPath, [harness.script, ...args], {
    cwd: harness.root,
    encoding: 'utf8',
    timeout,
    env: {
      ...env,
      DEPLOY_TEST_LOG: harness.logPath,
      DEPLOY_TEST_SECRET_CAPTURE: harness.secretCapturePath,
      DEPLOY_TEST_FETCH_LOG: path.join(harness.root, 'fetch.log'),
      DEPLOY_TEST_READINESS_INTERVAL_MS: '0',
      npm_execpath: harness.npmStub,
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${harness.fetchStub}`.trim(),
    },
  });
}

test('setup readiness cannot hold a completed deploy open on an unreadable response body', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_FETCH_BODY_NEVER_SETTLES: '1',
  }, 2_000);

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /Chickpea setup is responding/);
});

test('successful deploy generates stable auth after a quick setup-route check', async (context) => {
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
  assert.equal(JSON.stringify(config).includes(link[1]!), false);
  const capture = JSON.parse(readFileSync(harness.secretCapturePath, 'utf8'));
  assert.equal(capture.mode, 0o600);
  assert.match(capture.values.CHICKPEA_AUTH_SECRET, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(existsSync(capture.path), false);
  const fetches = readFileSync(path.join(harness.root, 'fetch.log'), 'utf8').trim().split('\n');
  assert.equal(fetches.length, 1);
  for (const fetch of fetches) {
    const parsed = JSON.parse(fetch);
    assert.match(parsed.url, /^https:\/\/chickpea\.example\.workers\.dev\/admin\/setup\?readiness=\d+-\d+$/);
    assert.equal(parsed.method, 'HEAD');
    assert.equal(parsed.redirect, 'manual');
  }
  assert.match(result.stdout, /Chickpea setup is responding/);
  assert.match(result.stdout, /may take another 1–2 minutes/);
  assert.match(result.stdout, /🔐 PRIVATE SETUP LINK/);
  assert.match(result.stdout, /👉 https:\/\/chickpea\.example\.workers\.dev\/admin\/setup#setup=/);
  const invoked = commands(harness.logPath);
  assert.match(invoked[0] ?? '', /^wrangler:\["secret","list","--format","json","--config",/);
  assert.match(
    invoked[1] ?? '',
    /^wrangler:\["d1","migrations","apply","AUTH_DB","--remote","--config",".*\/dist-cf\/chickpea\/wrangler\.json"\]$/,
  );
  assert.match(invoked[2] ?? '', /^wrangler:\["deploy","--secrets-file",".*"\]$/);
});

test('a quick retry can observe the setup route after initial propagation', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SETUP_STATUSES: '404,200',
  });

  assert.equal(result.status, 0, result.stderr);
  const fetches = readFileSync(path.join(harness.root, 'fetch.log'), 'utf8').trim().split('\n');
  assert.equal(fetches.length, 2);
  assert.match(result.stdout, /Chickpea setup is responding/);
  assert.doesNotMatch(result.stdout, /still activating/);
});

test('an unsettled public route is reported honestly without claiming readiness', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SETUP_STATUS: '404',
  });

  assert.equal(result.status, 0, result.stderr);
  const fetches = readFileSync(path.join(harness.root, 'fetch.log'), 'utf8').trim().split('\n');
  assert.equal(fetches.length, 2);
  assert.match(result.stdout, /Worker deployed\. Cloudflare is still activating its public URL/);
  assert.match(result.stdout, /may take another 1–2 minutes/);
  assert.doesNotMatch(result.stdout, /Chickpea (?:setup|Admin) is (?:ready|responding)|Chickpea is live/);
  assert.match(result.stdout, /\/admin\/setup#setup=[A-Za-z0-9_-]{43}/);
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

test('existing auth or legacy recovery authority is preserved across deploys', (context) => {
  const current = createHarness();
  const legacy = createHarness();
  context.after(() => {
    rmSync(current.root, { recursive: true, force: true });
    rmSync(legacy.root, { recursive: true, force: true });
  });

  const currentResult = runHarness(current, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
  });
  const legacyResult = runHarness(legacy, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_RECOVERY_TOKEN' }]),
  });

  assert.equal(currentResult.status, 0, currentResult.stderr);
  assert.equal(legacyResult.status, 0, legacyResult.stderr);
  assert.equal(existsSync(current.secretCapturePath), false);
  assert.equal(existsSync(legacy.secretCapturePath), false);
  assert.equal(commands(current.logPath).at(-1), 'wrangler:["deploy"]');
  assert.equal(commands(legacy.logPath).at(-1), 'wrangler:["deploy"]');
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
  assert.match(freshResult.stdout, /Checking the public setup URL \(up to 5 seconds\)/);
  const freshFetches = readFileSync(path.join(fresh.root, 'fetch.log'), 'utf8').trim().split('\n');
  assert.equal(freshFetches.length, 1);
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
    DEPLOY_TEST_SECRET_LIST: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]),
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

test('redirected setup surface does not print a private link', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    DEPLOY_TEST_SETUP_STATUS: '303',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /#setup=/);
  assert.match(result.stdout, /Chickpea Admin is responding/);
  assert.match(result.stdout, /may take another 1–2 minutes/);
  const fetches = readFileSync(path.join(harness.root, 'fetch.log'), 'utf8').trim().split('\n');
  assert.equal(fetches.length, 1);
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
  assert.deepEqual(invoked.slice(1, -1), [
    'wrangler:["d1","list","--json"]',
    `wrangler:["d1","create","chickpea-auth-db","--binding","AUTH_DB","--update-config","--config","${path.join(canonicalRoot, 'wrangler.jsonc')}"]`,
    'npm:["run","build"]',
    `wrangler:["d1","migrations","apply","AUTH_DB","--remote","--config","${path.join(canonicalRoot, 'dist-cf', 'chickpea', 'wrangler.json')}"]`,
  ]);
  assert.match(invoked.at(-1) ?? '', /^wrangler:\["deploy","--secrets-file",/);
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
  assert.deepEqual(invoked.slice(1, -1), [
    'wrangler:["d1","list","--json"]',
    `wrangler:["d1","migrations","apply","AUTH_DB","--remote","--config","${path.join(canonicalRoot, 'dist-cf', 'chickpea', 'wrangler.json')}"]`,
  ]);
  assert.match(invoked.at(-1) ?? '', /^wrangler:\["deploy","--secrets-file",/);
  const config = JSON.parse(readFileSync(path.join(
    harness.root,
    'dist-cf',
    'chickpea',
    'wrangler.json',
  ), 'utf8'));
  assert.equal(config.d1_databases[0].database_id, 'existing-database-id');
});

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

function commands(logPath: string): string[] {
  return readFileSync(logPath, 'utf8').trim().split('\n');
}

function writeCutoverArtifact(
  harness: ReturnType<typeof createHarness>,
  options: {
    cron?: boolean;
    routineAgents?: boolean;
    selector?: string;
    completeCanary?: boolean;
    missingBinding?: string;
    deletedClasses?: string[];
    compatibilityDate?: string;
    tracing?: boolean;
    cloudflareTracer?: boolean;
    sandboxCommandRedaction?: boolean;
    agentViewArtifact?: boolean;
    databaseId?: string;
    profile?: 'core' | 'sandbox';
    workerName?: string;
    sandboxBinding?: { name: string; class_name: string };
    sandboxContainer?: {
      class_name: string;
      image: string;
      instance_type: string;
      max_instances: number;
    };
  } = {},
) {
  const builtDir = path.join(harness.root, 'dist-cf', 'chickpea');
  const redirectDir = path.join(harness.root, '.wrangler', 'deploy');
  mkdirSync(builtDir, { recursive: true });
  mkdirSync(redirectDir, { recursive: true });
  writeFileSync(path.join(redirectDir, 'config.json'), JSON.stringify({
    configPath: '../../dist-cf/chickpea/wrangler.json',
  }));
  const profile = options.profile ?? 'core';
  const sandboxBinding = options.sandboxBinding ?? { name: 'SANDBOX', class_name: 'Sandbox' };
  const sandboxContainer = options.sandboxContainer ?? {
    class_name: 'Sandbox',
    image: path.join(realpathSync(harness.root), 'Dockerfile'),
    instance_type: 'standard-1',
    max_instances: 25,
  };
  const config = {
    name: options.workerName ?? 'chickpea',
    main: 'index.js',
    compatibility_date: options.compatibilityDate ?? '2026-06-01',
    observability: { enabled: true, traces: { enabled: options.tracing ?? true } },
    vars: {
      SLACK_TAG_LEDGER_CANARY_CHANNELS: options.selector ?? '',
    },
    triggers: { crons: options.cron === false ? [] : ['* * * * *'] },
    durable_objects: { bindings: [
      { name: 'TAG_STATE', class_name: 'TagStateStore' },
      ...(profile === 'sandbox' ? [sandboxBinding] : []),
      { name: 'AUTH_GUARD', class_name: 'AuthGuard' },
      { name: 'FLUE_CHICKPEA_SLACK_V2_AGENT', class_name: 'FlueChickpeaSlackV2Agent' },
      ...(options.routineAgents === false ? [] : [
        {
          name: 'FLUE_CHICKPEA_ROUTINE_INTENT_V2_AGENT',
          class_name: 'FlueChickpeaRoutineIntentV2Agent',
        },
        {
          name: 'FLUE_CHICKPEA_ROUTINE_EXECUTION_V2_AGENT',
          class_name: 'FlueChickpeaRoutineExecutionV2Agent',
        },
      ]),
    ].filter((binding) => binding.name !== options.missingBinding) },
    d1_databases: [{
      binding: 'AUTH_DB',
      database_name: 'chickpea-auth-db',
      database_id: options.databaseId ?? 'test-database-id',
      migrations_dir: '../../migrations/better-auth',
    }],
    workflows: [],
    ...(profile === 'sandbox' ? { containers: [sandboxContainer] } : {}),
    migrations: [
      { tag: 'v3', new_sqlite_classes: ['Sandbox'] },
      {
        tag: 'v6',
        new_sqlite_classes: [
          'FlueChickpeaSlackV2Agent',
          'FlueChickpeaRoutineIntentV2Agent',
          'FlueChickpeaRoutineExecutionV2Agent',
        ],
        deleted_classes: options.deletedClasses ?? [
          'FlueRegistry',
          'FlueSlackThreadAgent',
          'FlueRoutineIntentAgent',
          'FlueRoutineWorkflow',
        ],
      },
      { tag: 'v7', new_sqlite_classes: ['AuthGuard'] },
    ],
  };
  writeFileSync(path.join(builtDir, 'wrangler.json'), JSON.stringify(config));
  writeFileSync(path.join(harness.root, 'wrangler.jsonc'), JSON.stringify(config));
  const canarySeams = options.completeCanary === false
    ? 'SLACK_TAG_LEDGER_CANARY_CHANNELS'
    : 'SLACK_TAG_LEDGER_CANARY_CHANNELS delivery_receipt_persist_unknown slack_agent_bindings';
  writeFileSync(
    path.join(builtDir, 'index.js'),
    `heartbeat: runRoutineHeartbeat maintenance: runWorkMaintenance ` +
      `chickpea.response-metadata chickpea-slack-v2 ` +
      `${options.cloudflareTracer === false ? '' : '@flue/runtime/cloudflare-tracing '} ` +
      `${options.sandboxCommandRedaction === false ? '' : 'FLUE_PRIVATE_SANDBOX_COMMAND_V1 '} ` +
      `${options.routineAgents === false ? '' : 'chickpea-routine-intent-v2 chickpea-routine-execution-v2 '} ` +
      `${options.agentViewArtifact === false ? '' : 'agent_view agent_description '} ` +
      canarySeams,
  );
}

function writeRoutineArtifact(
  harness: ReturnType<typeof createHarness>,
  options: { cron?: boolean; routineAgents?: boolean } = {},
) {
  writeCutoverArtifact(harness, options);
}

function writeCanaryArtifact(
  harness: ReturnType<typeof createHarness>,
  options: { selector?: string; complete?: boolean } = {},
) {
  writeCutoverArtifact(harness, {
    selector: options.selector ?? 'T_ACME/C_AGENT_TEST',
    ...(options.complete === undefined ? {} : { completeCanary: options.complete }),
  });
}

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
  assert.match(invoked[2] ?? '', /^wrangler:\["deploy","--secrets-file",/);
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
  const tracingDisabled = createHarness();
  const missingTracer = createHarness();
  const missingSandboxRedaction = createHarness();
  const stale = createHarness();
  context.after(() => {
    rmSync(missingState.root, { recursive: true, force: true });
    rmSync(tracingDisabled.root, { recursive: true, force: true });
    rmSync(missingTracer.root, { recursive: true, force: true });
    rmSync(missingSandboxRedaction.root, { recursive: true, force: true });
    rmSync(stale.root, { recursive: true, force: true });
  });
  writeCutoverArtifact(missingState, { missingBinding: 'TAG_STATE' });
  writeCutoverArtifact(tracingDisabled, { tracing: false });
  writeCutoverArtifact(missingTracer, { cloudflareTracer: false });
  writeCutoverArtifact(missingSandboxRedaction, { sandboxCommandRedaction: false });
  writeCutoverArtifact(stale, { compatibilityDate: '2026-03-31' });

  const stateResult = runHarness(missingState, ['--skip-build', '--preflight-only']);
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

  assert.equal(stateResult.status, 1);
  assert.match(stateResult.stderr, /TAG_STATE\/TagStateStore binding/);
  assert.equal(tracingDisabledResult.status, 1);
  assert.match(tracingDisabledResult.stderr, /enabled Workers Traces/);
  assert.equal(missingTracerResult.status, 1);
  assert.match(missingTracerResult.stderr, /content-free Cloudflare tracing/);
  assert.equal(missingSandboxRedactionResult.status, 1);
  assert.match(missingSandboxRedactionResult.stderr, /content-free Cloudflare Sandbox exec/);
  assert.equal(staleResult.status, 1);
  assert.match(staleResult.stderr, /compatibility_date at or above 2026-04-01/);
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
