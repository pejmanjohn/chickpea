import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'deploy-with-epilogue.mjs');

function createHarness() {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-deploy-wrapper-'));
  const scriptsDir = path.join(root, 'scripts');
  const wranglerDir = path.join(root, 'node_modules', 'wrangler', 'bin');
  const logPath = path.join(root, 'commands.log');
  const npmStub = path.join(root, 'fake-npm.mjs');
  const wranglerStub = path.join(wranglerDir, 'wrangler.js');

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(wranglerDir, { recursive: true });
  copyFileSync(DEPLOY_SCRIPT, path.join(scriptsDir, 'deploy-with-epilogue.mjs'));

  const commandLogger = (label: string) => `
    import { appendFileSync } from 'node:fs';
    appendFileSync(
      process.env.DEPLOY_TEST_LOG,
      ${JSON.stringify(label)} + ':' + JSON.stringify(process.argv.slice(2)) + '\\n',
    );
  `;
  writeFileSync(npmStub, commandLogger('npm'));
  writeFileSync(
    wranglerStub,
    commandLogger('wrangler') +
      `if (process.env.DEPLOY_TEST_URL) process.stdout.write(process.env.DEPLOY_TEST_URL + '\\n');\n`,
  );

  const harness = {
    root,
    logPath,
    npmStub,
    script: path.join(scriptsDir, 'deploy-with-epilogue.mjs'),
  };
  writeCutoverArtifact(harness);
  return harness;
}

function runHarness(
  harness: ReturnType<typeof createHarness>,
  args: string[],
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [harness.script, ...args], {
    cwd: harness.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_TEST_LOG: harness.logPath,
      npm_execpath: harness.npmStub,
      ...env,
    },
  });
}

test('successful deploy hands a fresh install to recovery-backed Access setup', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build'], {
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/chickpea\.example\.workers\.dev\/admin\/setup/);
  assert.match(result.stdout, /CHICKPEA_RECOVERY_TOKEN once/);
  assert.match(result.stdout, /protect both \/admin and \/admin\/\*/);
  assert.match(result.stdout, /not an Admin login/);
  assert.doesNotMatch(result.stdout, /Sign in with the TAG_ADMIN_TOKEN/);
});

function commands(logPath: string): string[] {
  return readFileSync(logPath, 'utf8').trim().split('\n');
}

function writeCutoverArtifact(
  harness: ReturnType<typeof createHarness>,
  options: {
    cron?: boolean;
    routinesEnabled?: boolean;
    routineAgents?: boolean;
    selector?: string;
    completeCanary?: boolean;
    missingBinding?: string;
    deletedClasses?: string[];
    compatibilityDate?: string;
    tracing?: boolean;
    cloudflareTracer?: boolean;
    sandboxCommandRedaction?: boolean;
  } = {},
) {
  const builtDir = path.join(harness.root, 'dist-cf', 'chickpea');
  const redirectDir = path.join(harness.root, '.wrangler', 'deploy');
  mkdirSync(builtDir, { recursive: true });
  mkdirSync(redirectDir, { recursive: true });
  writeFileSync(path.join(redirectDir, 'config.json'), JSON.stringify({
    configPath: '../../dist-cf/chickpea/wrangler.json',
  }));
  writeFileSync(path.join(builtDir, 'wrangler.json'), JSON.stringify({
    name: 'chickpea',
    main: 'index.js',
    compatibility_date: options.compatibilityDate ?? '2026-06-01',
    observability: { enabled: true, traces: { enabled: options.tracing ?? true } },
    vars: {
      TAG_ROUTINES_ENABLED: options.routinesEnabled ? '1' : '0',
      SLACK_TAG_LEDGER_CANARY_CHANNELS: options.selector ?? '',
    },
    triggers: { crons: options.cron === false ? [] : ['* * * * *'] },
    durable_objects: { bindings: [
      { name: 'TAG_STATE', class_name: 'TagStateStore' },
      { name: 'SANDBOX', class_name: 'Sandbox' },
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
    workflows: [],
    migrations: [{
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
    }],
  }));
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
      canarySeams,
  );
}

function writeRoutineArtifact(
  harness: ReturnType<typeof createHarness>,
  options: { cron?: boolean; routineAgents?: boolean } = {},
) {
  writeCutoverArtifact(harness, { ...options, routinesEnabled: true });
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

test('deploy skip-build flag stays private while dry-run still reaches Wrangler', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Building the Cloudflare artifact from current source/);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('preflight-only validates the generated cutover artifact without invoking Wrangler', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));

  const result = runHarness(harness, ['--skip-build', '--preflight-only']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cutover preflight passed/);
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
  const missingSandbox = createHarness();
  const tracingDisabled = createHarness();
  const missingTracer = createHarness();
  const missingSandboxRedaction = createHarness();
  const stale = createHarness();
  context.after(() => {
    rmSync(missingSandbox.root, { recursive: true, force: true });
    rmSync(tracingDisabled.root, { recursive: true, force: true });
    rmSync(missingTracer.root, { recursive: true, force: true });
    rmSync(missingSandboxRedaction.root, { recursive: true, force: true });
    rmSync(stale.root, { recursive: true, force: true });
  });
  writeCutoverArtifact(missingSandbox, { missingBinding: 'SANDBOX' });
  writeCutoverArtifact(tracingDisabled, { tracing: false });
  writeCutoverArtifact(missingTracer, { cloudflareTracer: false });
  writeCutoverArtifact(missingSandboxRedaction, { sandboxCommandRedaction: false });
  writeCutoverArtifact(stale, { compatibilityDate: '2026-03-31' });

  const sandboxResult = runHarness(missingSandbox, ['--skip-build', '--preflight-only']);
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

  assert.equal(sandboxResult.status, 1);
  assert.match(sandboxResult.stderr, /SANDBOX\/Sandbox binding/);
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

test('enabled routines require Cron, state, and both fresh Flue 2 routine agents', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeRoutineArtifact(harness);

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(commands(harness.logPath), ['wrangler:["deploy","--dry-run"]']);
});

test('deploy refuses an enabled routines artifact with a missing heartbeat', (context) => {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeRoutineArtifact(harness, { cron: false });

  const result = runHarness(harness, ['--skip-build', '--dry-run']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TAG_ROUTINES_ENABLED=1 is unsafe/);
  assert.match(result.stderr, /heartbeat Cron Trigger/);
  assert.equal(existsSync(harness.logPath), false);
});

test('deploy refuses enabled routines without both generated Flue 2 agents', (context) => {
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
