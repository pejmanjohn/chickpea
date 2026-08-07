#!/usr/bin/env node
/**
 * `npm run deploy` — build the current source, run wrangler deploy, then print
 * a next-steps epilogue. Pass `--skip-build` only when a caller has just run
 * `npm run build` and wants to reuse that exact artifact.
 *
 * Workers Builds streams the build and deploy steps into one log that ends,
 * without this, at wrangler's own output: a raw workers.dev URL and no hint
 * that /admin is the next stop. Wrangler 4.x has no command that reports the
 * account's workers.dev subdomain, but `wrangler deploy` prints the deployed
 * URL on success — so tee its stdout, grep the URL, and append instructions.
 *
 * The epilogue is additive: wrangler's output passes through untouched, a
 * non-zero exit propagates unchanged with no epilogue (never dress up a
 * failed deploy), and stdout is scanned line-by-line rather than buffered.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Invoke wrangler's bin with the current node (mirrors flue-build-cf.mjs):
// works whether or not node_modules/.bin is on PATH.
const wranglerBin = path.join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const cliArgs = process.argv.slice(2);
const deployArgs = cliArgs.filter((arg) => !['--skip-build', '--preflight-only'].includes(arg));
const skipBuild = cliArgs.includes('--skip-build');
const preflightOnly = cliArgs.includes('--preflight-only');

const BETA_FLUE_CLASSES = Object.freeze([
  'FlueRegistry',
  'FlueSlackThreadAgent',
  'FlueRoutineIntentAgent',
  'FlueRoutineWorkflow',
]);
const V2_AGENT_CLASSES = Object.freeze([
  'FlueChickpeaSlackV2Agent',
  'FlueChickpeaRoutineIntentV2Agent',
  'FlueChickpeaRoutineExecutionV2Agent',
]);
const V2_AGENT_BINDINGS = Object.freeze([
  ['FLUE_CHICKPEA_SLACK_V2_AGENT', 'FlueChickpeaSlackV2Agent'],
  ['FLUE_CHICKPEA_ROUTINE_INTENT_V2_AGENT', 'FlueChickpeaRoutineIntentV2Agent'],
  ['FLUE_CHICKPEA_ROUTINE_EXECUTION_V2_AGENT', 'FlueChickpeaRoutineExecutionV2Agent'],
]);
const PROTECTED_CLASSES = new Set(['TagStateStore', 'Sandbox', 'ContainerProxy', 'AuthGuard']);

function hasCustomConfigFlag(args) {
  return args.some((argument) =>
    argument === '--config' || argument === '-c' || argument.startsWith('--config=')
  );
}

if (hasCustomConfigFlag(deployArgs)) {
  console.error(
    'Do not pass a custom Wrangler config. Build the Vite artifact and use its generated deploy redirect.',
  );
  process.exit(1);
}

if (!skipBuild) {
  process.stdout.write('Building the Cloudflare artifact from current source...\n');
  const npmExecPath = process.env.npm_execpath;
  const buildCommand = npmExecPath
    ? [process.execPath, [npmExecPath, 'run', 'build']]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']];
  const build = spawnSync(buildCommand[0], buildCommand[1], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (build.error) {
    console.error(`Unable to start the Cloudflare build: ${build.error.message}`);
    process.exit(1);
  }
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

function builtConfigPath() {
  try {
    const redirectPath = path.join(projectRoot, '.wrangler', 'deploy', 'config.json');
    const redirect = readFileSync(redirectPath, 'utf8');
    const entry = redirect.match(/"configPath"\s*:\s*"([^"]+)"/);
    if (entry) return path.resolve(path.dirname(redirectPath), entry[1]);
  } catch {
    /* a disabled or not-yet-built capability has nothing to validate */
  }
  return undefined;
}

function cliEnablesRoutines() {
  return deployArgs.some((arg, index) => {
    const value = arg === '--var' ? deployArgs[index + 1] : arg.startsWith('--var=') ? arg.slice(6) : '';
    return /^TAG_ROUTINES_ENABLED[:=]1$/.test(value ?? '');
  });
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameMembers(actual, expected) {
  return actual.length === expected.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function renamedClassNames(migrations) {
  const names = [];
  for (const migration of migrations) {
    for (const rename of migration.renamed_classes ?? []) {
      if (typeof rename?.from === 'string') names.push(rename.from);
      if (typeof rename?.to === 'string') names.push(rename.to);
    }
  }
  return names;
}

function requireBuiltArtifact() {
  const configPath = builtConfigPath();
  if (!configPath) {
    throw new Error('Cloudflare preflight requires the generated Vite Wrangler artifact.');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const artifactRoot = path.dirname(configPath);
  const bundlePath = path.resolve(artifactRoot, config.main ?? 'index.js');
  const bundle = existsSync(bundlePath)
    ? readdirSync(artifactRoot, { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.js'))
      .sort()
      .map((entry) => readFileSync(path.join(artifactRoot, entry), 'utf8'))
      .join('\n')
    : '';
  return { configPath, config, bundle };
}

function validateFlue2CutoverArtifact(artifact) {
  const { config, bundle } = artifact;
  const failures = [];
  const migrations = config.migrations ?? [];
  const deleted = migrations.flatMap((migration) => migration.deleted_classes ?? []);
  const renamed = renamedClassNames(migrations);
  const destructive = sortedUnique([...deleted, ...renamed]);
  const unexpected = destructive.filter((name) => !BETA_FLUE_CLASSES.includes(name));
  if (unexpected.length) failures.push(`unexpected deleted/renamed classes: ${unexpected.join(', ')}`);
  const protectedDestruction = destructive.filter((name) => PROTECTED_CLASSES.has(name));
  if (protectedDestruction.length) {
    failures.push(`protected classes marked deleted/renamed: ${protectedDestruction.join(', ')}`);
  }
  if (!sameMembers(deleted, BETA_FLUE_CLASSES) || renamed.length > 0) {
    failures.push('the exact four-class beta deletion set with no class renames');
  }
  const reset = migrations.find((migration) => migration.tag === 'v6');
  if (!reset || !sameMembers(reset.new_sqlite_classes ?? [], V2_AGENT_CLASSES)) {
    failures.push('v6 fresh Flue 2 SQLite agent classes');
  }

  const bindings = config.durable_objects?.bindings ?? [];
  const hasBinding = (name, className) => bindings.some(
    (binding) => binding.name === name && binding.class_name === className,
  );
  if (!hasBinding('TAG_STATE', 'TagStateStore')) failures.push('TAG_STATE/TagStateStore binding');
  if (!hasBinding('SANDBOX', 'Sandbox')) failures.push('SANDBOX/Sandbox binding');
  if (!hasBinding('AUTH_GUARD', 'AuthGuard')) failures.push('AUTH_GUARD/AuthGuard binding');
  for (const [name, className] of V2_AGENT_BINDINGS) {
    if (!hasBinding(name, className)) failures.push(`${name}/${className} binding`);
  }
  const betaBindings = bindings.filter((binding) => BETA_FLUE_CLASSES.includes(binding.class_name));
  if (betaBindings.length) failures.push('no beta Flue Durable Object bindings');
  if ((config.workflows ?? []).length !== 0) failures.push('no Flue workflow bindings');
  const authDb = (config.d1_databases ?? []).find((binding) => binding.binding === 'AUTH_DB');
  if (!authDb || !String(authDb.migrations_dir ?? '').endsWith('migrations/better-auth')) {
    failures.push('AUTH_DB with reviewed Better Auth migrations');
  }
  const authMigration = migrations.find((migration) => migration.tag === 'v7');
  if (!authMigration || !sameMembers(authMigration.new_sqlite_classes ?? [], ['AuthGuard'])) {
    failures.push('v7 AuthGuard SQLite class');
  }

  if (config.observability?.traces?.enabled !== true) {
    failures.push('enabled Workers Traces for metadata-only Flue spans');
  }
  if (!bundle.includes('@flue/runtime/cloudflare-tracing')) {
    failures.push('explicit content-free Cloudflare tracing instrumentation');
  }
  if (!bundle.includes('FLUE_PRIVATE_SANDBOX_COMMAND_V1')) {
    failures.push('content-free Cloudflare Sandbox exec logging');
  }
  if (!bundle.includes('chickpea.response-metadata')) {
    failures.push('bounded metadata-only Chickpea instrumentation');
  }
  if (
    typeof config.compatibility_date !== 'string' ||
    config.compatibility_date < '2026-04-01'
  ) {
    failures.push('compatibility_date at or above 2026-04-01');
  }
  if (failures.length) {
    throw new Error(`Flue 2 cutover preflight failed; missing or unsafe ${failures.join(', ')}.`);
  }
}

function cliVariable(name) {
  for (let index = 0; index < deployArgs.length; index += 1) {
    const argument = deployArgs[index];
    const raw = argument === '--var'
      ? deployArgs[index + 1]
      : argument.startsWith('--var=')
        ? argument.slice(6)
        : undefined;
    if (typeof raw !== 'string') continue;
    const separator = raw.search(/[:=]/);
    if (separator < 1 || raw.slice(0, separator) !== name) continue;
    return raw.slice(separator + 1);
  }
  return undefined;
}

function validateEnabledRoutineArtifact(artifact) {
  const { config, bundle } = artifact;
  if (config.vars?.TAG_ROUTINES_ENABLED !== '1' && !cliEnablesRoutines()) return;
  const failures = [];
  const crons = config.triggers?.crons ?? [];
  if (crons.length !== 1 || crons[0] !== '* * * * *') failures.push('one * * * * * heartbeat Cron Trigger');
  const bindings = config.durable_objects?.bindings ?? [];
  if (!bindings.some((binding) => binding.name === 'TAG_STATE' && binding.class_name === 'TagStateStore')) {
    failures.push('TAG_STATE/TagStateStore binding');
  }
  for (const [name, className] of V2_AGENT_BINDINGS.slice(1)) {
    if (!bindings.some((binding) => binding.name === name && binding.class_name === className)) {
      failures.push(`${name}/${className} binding`);
    }
  }
  if (
    !bundle.includes('heartbeat: runRoutineHeartbeat') ||
    !bundle.includes('maintenance: runWorkMaintenance')
  ) {
    failures.push('composed heartbeat and maintenance handlers');
  }
  if (
    !bundle.includes('chickpea-routine-intent-v2') ||
    !bundle.includes('chickpea-routine-execution-v2')
  ) {
    failures.push('fresh Flue 2 routine agent registrations');
  }
  if (failures.length) {
    throw new Error(
      'TAG_ROUTINES_ENABLED=1 is unsafe for this artifact; missing ' + failures.join(', ') + '. ' +
      'Deploy with routines disabled, repair the artifact, and verify the heartbeat before enabling.',
    );
  }
}

function validateLedgerCanaryArtifact(artifact) {
  const { config, bundle } = artifact;
  const cliSelector = cliVariable('SLACK_TAG_LEDGER_CANARY_CHANNELS');
  const selector = cliSelector ?? config.vars?.SLACK_TAG_LEDGER_CANARY_CHANNELS ?? '';
  if (selector === '') return;
  if (typeof selector !== 'string') {
    throw new Error('SLACK_TAG_LEDGER_CANARY_CHANNELS must be a string.');
  }
  const entries = selector.split(',').map((entry) => entry.trim());
  const exactPair = /^[A-Za-z][A-Za-z0-9_-]{1,63}\/[A-Za-z][A-Za-z0-9_-]{1,63}$/;
  if (entries.length > 20 || entries.some((entry) => !exactPair.test(entry))) {
    throw new Error(
      'SLACK_TAG_LEDGER_CANARY_CHANNELS is unsafe: use 1-20 exact workspace/channel pairs ' +
      '(for example T123/C456), comma-separated with no wildcard or empty entry.',
    );
  }
  const requiredSeams = [
    'SLACK_TAG_LEDGER_CANARY_CHANNELS',
    'delivery_receipt_persist_unknown',
    'slack_agent_bindings',
  ];
  const missing = requiredSeams.filter((seam) => !bundle.includes(seam));
  if (missing.length) {
    throw new Error(
      'SLACK_TAG_LEDGER_CANARY_CHANNELS is unsafe for this artifact; missing durable driver seams: ' +
      missing.join(', ') + '. Deploy with the selector empty and repair the artifact.',
    );
  }
}

let builtArtifact;
try {
  const artifact = requireBuiltArtifact();
  validateFlue2CutoverArtifact(artifact);
  validateEnabledRoutineArtifact(artifact);
  validateLedgerCanaryArtifact(artifact);
  builtArtifact = artifact;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (preflightOnly) {
  process.stdout.write('Flue 2 generated cutover preflight passed. No deployment was attempted.\n');
  process.exit(0);
}

// D1 migrations are forward-only and idempotent. Apply them before the Worker
// starts serving a schema it expects. If deploy later fails, rerunning this
// command resumes from D1's migration ledger; never attempt schema rollback.
if (!deployArgs.includes('--dry-run')) {
  process.stdout.write('Applying reviewed Better Auth migrations to AUTH_DB...\n');
  const environmentArgs = [];
  for (let index = 0; index < deployArgs.length; index += 1) {
    const argument = deployArgs[index];
    if (argument === '--env' || argument === '-e') {
      environmentArgs.push(argument, deployArgs[index + 1]);
      index += 1;
    } else if (argument.startsWith('--env=')) {
      environmentArgs.push(argument);
    }
  }
  const migration = spawnSync(
    process.execPath,
    [
      wranglerBin,
      'd1',
      'migrations',
      'apply',
      'AUTH_DB',
      '--remote',
      '--config',
      builtArtifact.configPath,
      ...environmentArgs,
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  if (migration.error) {
    console.error(`Unable to start AUTH_DB migration: ${migration.error.message}`);
    process.exit(1);
  }
  if (migration.status !== 0) process.exit(migration.status ?? 1);
}

const child = spawn(
  process.execPath,
  [wranglerBin, 'deploy', ...deployArgs],
  { cwd: projectRoot, stdio: ['inherit', 'pipe', 'inherit'] },
);

let deployedUrl = '';
let tail = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  // Line-oriented scan without unbounded buffering: keep only a joining tail
  // in case the URL straddles a chunk boundary.
  const text = tail + chunk.toString('utf8');
  const match = text.match(/https?:\/\/[^\s]+\.workers\.dev\b/);
  if (match && !deployedUrl) {
    deployedUrl = match[0];
  }
  tail = text.slice(-256);
});

/** Worker name from the built (redirected) config, falling back to the root config. */
function workerName() {
  const candidates = ['dist-cf', 'dist'];
  for (const dist of candidates) {
    const distDir = path.join(projectRoot, dist);
    if (!existsSync(distDir)) continue;
    try {
      for (const entry of readFileSync(path.join(projectRoot, '.wrangler', 'deploy', 'config.json'), 'utf8').matchAll(/"configPath"\s*:\s*"([^"]+)"/g)) {
        const configPath = path.resolve(path.join(projectRoot, '.wrangler', 'deploy'), entry[1]);
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
        if (typeof parsed.name === 'string') return parsed.name;
      }
    } catch {
      /* fall through to wrangler.jsonc */
    }
  }
  try {
    const raw = readFileSync(path.join(projectRoot, 'wrangler.jsonc'), 'utf8');
    const match = raw.match(/"name"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
  } catch {
    /* unknown */
  }
  return 'chickpea';
}

const RULE = '────────────────────────────────────────────────────────';

child.on('close', (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  // A dry run deploys nothing — next-steps instructions would be a lie.
  if (deployArgs.includes('--dry-run')) {
    process.exit(0);
  }
  if (deployedUrl) {
    process.stdout.write(
      [
        '',
        RULE,
        '  ✔ Deployed. Chickpea is live.',
        '',
        '  Next steps:',
        `    1. Open  ${deployedUrl}/admin/setup`,
        '    2. Use CHICKPEA_RECOVERY_TOKEN once to create the first owner.',
        '    3. Choose the owner email and password, then continue to Slack setup.',
        '',
        '  Keep the recovery credential in a password manager after setup.',
        '  It is not an Admin login. Losing it and the owner password prevents recovery.',
        '  docs/authentication.md covers accounts and optional Access; SETUP_AGENT.md covers Slack.',
        RULE,
        '',
      ].join('\n'),
    );
  } else {
    process.stdout.write(
      [
        '',
        RULE,
        '  ✔ Deploy finished.',
        '',
        '  Your setup URL is:  https://<worker-name>.<your-subdomain>.workers.dev/admin/setup',
        `    (worker name: ${workerName()} — find <your-subdomain> in the Cloudflare`,
        '     dashboard → Workers & Pages → your account subdomain)',
        '',
        '  Then: create the first owner at /admin/setup and continue to Slack.',
        RULE,
        '',
      ].join('\n'),
    );
  }
  process.exit(0);
});
