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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  classifyCloudflareDeploymentProfile,
  resolveCloudflareDeploymentProfile,
} from './cloudflare-deployment-profile.mjs';
import {
  mintSetupCapability,
  SETUP_CAPABILITY_DIGEST_BINDING,
  SETUP_CAPABILITY_ISSUED_AT_BINDING,
  setupCapabilityUrl,
} from '../src/auth/setup-capability.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Invoke wrangler's bin with the current node (mirrors flue-build-cf.mjs):
// works whether or not node_modules/.bin is on PATH.
const wranglerBin = path.join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const cliArgs = process.argv.slice(2);
const deployArgs = cliArgs.filter((arg) => !['--skip-build', '--preflight-only'].includes(arg));
const skipBuild = cliArgs.includes('--skip-build');
const preflightOnly = cliArgs.includes('--preflight-only');
// Workers Builds runs its configured build command immediately before its
// configured deploy command in the same build workspace. Reuse that exact
// artifact, but only when both Workers-specific markers are present; local
// deploys and generic CI retain the build-before-deploy safety boundary.
const reuseWorkersBuildArtifact =
  process.env.WORKERS_CI === '1' &&
  typeof process.env.WORKERS_CI_BUILD_UUID === 'string' &&
  process.env.WORKERS_CI_BUILD_UUID.trim().length > 0;
let deploymentProfile;
try {
  // Resolve once so build, preflight, D1 setup, and deploy cannot disagree if
  // a caller mutates process.env later in this process.
  deploymentProfile = resolveCloudflareDeploymentProfile();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

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

function hasWorkerNameOverride(args) {
  return args.some((argument) => argument === '--name' || argument.startsWith('--name='));
}

if (hasCustomConfigFlag(deployArgs)) {
  console.error(
    'Do not pass a custom Wrangler config. Build the Vite artifact and use its generated deploy redirect.',
  );
  process.exit(1);
}

if (hasWorkerNameOverride(deployArgs)) {
  console.error(
    'Do not override the Worker name. Chickpea must inspect and mutate the same Worker it deploys.',
  );
  process.exit(1);
}

function validateAgentViewManifest() {
  const manifestPath = path.join(projectRoot, 'slack-app-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to validate the Slack manifest before deployment: ${detail}`);
  }
  const hasAgentView = Boolean(manifest?.features?.agent_view);
  const hasAssistantView = Boolean(manifest?.features?.assistant_view);
  if (hasAgentView && hasAssistantView) {
    throw new Error(
      'Slack manifest is invalid for deployment: agent_view and assistant_view cannot coexist.',
    );
  }
  if (!hasAgentView) {
    throw new Error(
      'Slack manifest requires features.agent_view as the permanent app-home contract.',
    );
  }
}

try {
  validateAgentViewManifest();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function buildCloudflareArtifact() {
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

if (!skipBuild && !reuseWorkersBuildArtifact) buildCloudflareArtifact();

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

function expectedWorkerName() {
  const override = process.env.WRANGLER_CI_OVERRIDE_NAME?.trim();
  if (override) return override;
  try {
    const source = readFileSync(path.join(projectRoot, 'wrangler.jsonc'), 'utf8');
    const match = source.match(/"name"\s*:\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  } catch {
    /* the generated artifact validation below will report the missing identity */
  }
  return undefined;
}

function validateArtifactIdentity(artifact, { requireDatabaseId = false } = {}) {
  const { config, configPath } = artifact;
  const failures = [];
  const expectedName = expectedWorkerName();
  if (typeof config.name !== 'string' || !config.name.trim()) {
    failures.push('a generated Worker name');
  } else if (expectedName && config.name !== expectedName) {
    failures.push(`Worker identity ${expectedName} (found ${config.name})`);
  }
  if (
    typeof config.topLevelName === 'string' &&
    config.topLevelName !== config.name
  ) {
    failures.push(`one Worker identity (name=${config.name}, topLevelName=${config.topLevelName})`);
  }
  const main = typeof config.main === 'string'
    ? path.resolve(path.dirname(configPath), config.main)
    : undefined;
  if (!main || !existsSync(main)) failures.push('a real generated Worker entry');

  const authDatabases = (config.d1_databases ?? []).filter(
    (binding) => binding?.binding === 'AUTH_DB',
  );
  if (authDatabases.length !== 1) {
    failures.push('exactly one AUTH_DB binding');
  } else {
    const authDb = authDatabases[0];
    if (typeof authDb.database_name !== 'string' || !authDb.database_name.trim()) {
      failures.push('an AUTH_DB database name');
    }
    if (!String(authDb.migrations_dir ?? '').endsWith('migrations/better-auth')) {
      failures.push('AUTH_DB with reviewed Better Auth migrations');
    }
    if (
      requireDatabaseId &&
      (typeof authDb.database_id !== 'string' || !authDb.database_id.trim())
    ) {
      failures.push('the resolved AUTH_DB database identity');
    }
  }
  if (failures.length) {
    throw new Error(`Cloudflare deployment identity preflight failed; missing or unsafe ${failures.join(', ')}.`);
  }
}

function validateDeploymentProfile(artifact) {
  let actualProfile;
  try {
    actualProfile = classifyCloudflareDeploymentProfile(artifact.config);
  } catch (error) {
    throw new Error(
      `Cloudflare ${deploymentProfile} profile preflight failed: ` +
      (error instanceof Error ? error.message : String(error)),
    );
  }
  if (actualProfile !== deploymentProfile) {
    throw new Error(
      `Cloudflare deployment profile mismatch: requested ${deploymentProfile}, generated ${actualProfile}.`,
    );
  }
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
  const sandboxMigration = migrations.find((migration) => migration.tag === 'v3');
  if (!sandboxMigration || !sameMembers(sandboxMigration.new_sqlite_classes ?? [], ['Sandbox'])) {
    failures.push('v3 Sandbox SQLite class');
  }

  const bindings = config.durable_objects?.bindings ?? [];
  const hasBinding = (name, className) => bindings.some(
    (binding) => binding.name === name && binding.class_name === className,
  );
  if (!hasBinding('TAG_STATE', 'TagStateStore')) failures.push('TAG_STATE/TagStateStore binding');
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

function validateRoutineArtifact(artifact) {
  const { config, bundle } = artifact;
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
      'Routine scheduling artifact is unsafe; missing ' + failures.join(', ') + '. ' +
      'Repair the artifact and verify the heartbeat before deployment.',
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

function validateAgentViewArtifact(artifact) {
  if (!artifact.bundle.includes('agent_view') || !artifact.bundle.includes('agent_description')) {
    throw new Error(
      'Generated Cloudflare artifact is missing the permanent Agent View contract.',
    );
  }
}

function validateDeploymentArtifact(artifact, options = {}) {
  validateArtifactIdentity(artifact, options);
  validateDeploymentProfile(artifact);
  validateAgentViewArtifact(artifact);
  validateFlue2CutoverArtifact(artifact);
  validateRoutineArtifact(artifact);
  validateLedgerCanaryArtifact(artifact);
  return artifact;
}

let builtArtifact;
try {
  const artifact = requireBuiltArtifact();
  builtArtifact = validateDeploymentArtifact(artifact);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (preflightOnly) {
  process.stdout.write('Permanent Cloudflare capability preflight passed. No deployment was attempted.\n');
  process.exit(0);
}

const AUTH_SECRET = 'CHICKPEA_AUTH_SECRET';
const LEGACY_AUTH_SECRET = 'CHICKPEA_RECOVERY_TOKEN';

function remoteWorkerSecretNames(artifact) {
  const result = spawnSync(
    process.execPath,
    [
      wranglerBin,
      'secret',
      'list',
      '--format',
      'json',
      '--config',
      artifact.configPath,
      ...deploymentResourceArgs(),
    ],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  if (result.error) {
    throw new Error(`Unable to inspect Worker secrets: ${result.error.message}`);
  }
  const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 && /Worker\s+"[^"]+"[^\n]*not found/i.test(detail)) return new Set();
  if (result.status !== 0) {
    throw new Error(
      'Unable to inspect Worker secrets. The deploy credential must allow secret listing before Chickpea can deploy safely.',
    );
  }
  let entries;
  try {
    entries = JSON.parse(result.stdout);
  } catch {
    throw new Error('Worker secret discovery returned an unreadable response.');
  }
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry?.name !== 'string')) {
    throw new Error('Worker secret discovery returned an unexpected response.');
  }
  return new Set(entries.map((entry) => entry.name));
}

async function prepareDeploymentAuthority(artifact, secretNames) {
  const generatedSecrets = {};
  if (!secretNames.has(AUTH_SECRET) && !secretNames.has(LEGACY_AUTH_SECRET)) {
    generatedSecrets[AUTH_SECRET] = (await mintSetupCapability()).capability;
  }
  const setup = await mintSetupCapability();
  artifact.config.vars = {
    ...(artifact.config.vars ?? {}),
    [SETUP_CAPABILITY_DIGEST_BINDING]: setup.digest,
    [SETUP_CAPABILITY_ISSUED_AT_BINDING]: String(setup.issuedAt),
  };
  writeFileSync(artifact.configPath, `${JSON.stringify(artifact.config, null, 2)}\n`);
  return { generatedSecrets, setup };
}

function createSecretsFile(secrets) {
  if (Object.keys(secrets).length === 0) return undefined;
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-deploy-secrets-'));
  const file = path.join(directory, 'secrets.json');
  try {
    writeFileSync(file, `${JSON.stringify(secrets)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, file };
}

function removeSecretsFile(prepared) {
  if (prepared) rmSync(prepared.directory, { recursive: true, force: true });
}

function deploymentResourceArgs() {
  const args = [];
  for (let index = 0; index < deployArgs.length; index += 1) {
    const argument = deployArgs[index];
    if (['--env', '-e', '--profile'].includes(argument)) {
      args.push(argument, deployArgs[index + 1]);
      index += 1;
    } else if (argument.startsWith('--env=') || argument.startsWith('--profile=')) {
      args.push(argument);
    }
  }
  return args;
}

function ensureAuthDatabase(artifact) {
  const authDb = (artifact.config.d1_databases ?? []).find(
    (binding) => binding.binding === 'AUTH_DB',
  );
  if (typeof authDb?.database_id === 'string' && authDb.database_id.trim()) return artifact;
  const existingId = existingAuthDatabaseId(authDb?.database_name || 'chickpea-auth-db');
  if (existingId) {
    process.stdout.write('Reusing the customer-owned AUTH_DB database...\n');
    authDb.database_id = existingId;
    writeFileSync(artifact.configPath, `${JSON.stringify(artifact.config, null, 2)}\n`);
    return validateDeploymentArtifact(requireBuiltArtifact(), { requireDatabaseId: true });
  }
  const rootConfig = path.join(projectRoot, 'wrangler.jsonc');
  process.stdout.write('Provisioning the customer-owned AUTH_DB database...\n');
  const provision = spawnSync(
    process.execPath,
    [
      wranglerBin,
      'd1',
      'create',
      authDb?.database_name || 'chickpea-auth-db',
      '--binding',
      'AUTH_DB',
      '--update-config',
      '--config',
      rootConfig,
      ...deploymentResourceArgs(),
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  if (provision.error) {
    console.error(`Unable to start AUTH_DB provisioning: ${provision.error.message}`);
    process.exit(1);
  }
  if (provision.status !== 0) {
    console.error(
      'AUTH_DB provisioning failed. If the database already exists, copy its ID into ' +
      'wrangler.jsonc and rerun npm run deploy.',
    );
    process.exit(provision.status ?? 1);
  }
  buildCloudflareArtifact();
  const rebuilt = requireBuiltArtifact();
  return validateDeploymentArtifact(rebuilt, { requireDatabaseId: true });
}

function existingAuthDatabaseId(databaseName) {
  const list = spawnSync(
    process.execPath,
    [wranglerBin, 'd1', 'list', '--json', ...deploymentResourceArgs()],
    { cwd: projectRoot, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
  );
  if (list.error) {
    console.error(`Unable to inspect AUTH_DB resources: ${list.error.message}`);
    process.exit(1);
  }
  if (list.status !== 0) process.exit(list.status ?? 1);
  let databases;
  try {
    databases = JSON.parse(list.stdout);
  } catch {
    console.error('AUTH_DB discovery returned an unreadable response.');
    process.exit(1);
  }
  if (!Array.isArray(databases)) {
    console.error('AUTH_DB discovery returned an unexpected response.');
    process.exit(1);
  }
  const matches = databases.filter((database) => database?.name === databaseName);
  if (matches.length > 1) {
    console.error(`Multiple D1 databases are named ${databaseName}; refusing to guess.`);
    process.exit(1);
  }
  const id = matches[0]?.uuid ?? matches[0]?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

let deploymentAuthority;
let remoteSecretNames;
if (!deployArgs.includes('--dry-run')) {
  try {
    remoteSecretNames = remoteWorkerSecretNames(builtArtifact);
    builtArtifact = ensureAuthDatabase(builtArtifact);
    // This is the final gate immediately before the first mutation of an
    // existing customer resource. It intentionally reruns after both D1 reuse
    // injection and D1 provisioning/rebuild.
    builtArtifact = validateDeploymentArtifact(builtArtifact, { requireDatabaseId: true });
    deploymentAuthority = await prepareDeploymentAuthority(builtArtifact, remoteSecretNames);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// D1 migrations are forward-only and idempotent. Apply them before the Worker
// starts serving a schema it expects. If deploy later fails, rerunning this
// command resumes from D1's migration ledger; never attempt schema rollback.
if (!deployArgs.includes('--dry-run')) {
  process.stdout.write('Applying reviewed Better Auth migrations to AUTH_DB...\n');
  const environmentArgs = deploymentResourceArgs();
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

let preparedSecrets;
try {
  preparedSecrets = deploymentAuthority
    ? createSecretsFile(deploymentAuthority.generatedSecrets)
    : undefined;
} catch (error) {
  console.error(`Unable to prepare the temporary Worker secrets file: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    wranglerBin,
    'deploy',
    ...deployArgs,
    ...(preparedSecrets ? ['--secrets-file', preparedSecrets.file] : []),
  ],
  { cwd: projectRoot, stdio: ['inherit', 'pipe', 'inherit'] },
);

let cleanedSecrets = false;
function cleanupSecrets() {
  if (cleanedSecrets) return;
  cleanedSecrets = true;
  removeSecretsFile(preparedSecrets);
}
process.once('exit', cleanupSecrets);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    cleanupSecrets();
    child.kill(signal);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

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

const RULE = '────────────────────────────────────────────────────────';
const READINESS_MAX_ATTEMPTS = 2;
const READINESS_REQUEST_TIMEOUT_MS = 2_000;
const READINESS_INTERVAL_MS = (() => {
  // This is only a quick handoff check, not a deployment gate. Cloudflare can
  // keep propagating after the build completes, so never make the customer
  // wait here for full convergence.
  const testOverride = process.env.DEPLOY_TEST_READINESS_INTERVAL_MS;
  if (testOverride === undefined) return 500;
  const parsed = Number(testOverride);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 500;
})();

async function setupSurfaceReadiness(baseUrl) {
  const url = new URL('/admin/setup', baseUrl);
  for (let attempt = 0; attempt < READINESS_MAX_ATTEMPTS; attempt += 1) {
    url.searchParams.set('readiness', `${Date.now()}-${attempt}`);
    const controller = new AbortController();
    let timeout;
    try {
      const response = await Promise.race([
        fetch(url, {
          method: 'HEAD',
          redirect: 'manual',
          cache: 'no-store',
          headers: { accept: 'text/html', 'cache-control': 'no-cache' },
          signal: controller.signal,
        }).catch(() => undefined),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(undefined), READINESS_REQUEST_TIMEOUT_MS);
        }),
      ]);
      if (response?.status === 200) return 'ready';
      if (response?.status >= 300 && response.status < 400) return 'configured';
    } catch {
      // Deployment propagation is eventually consistent; retry below.
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    }
    if (attempt < READINESS_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, READINESS_INTERVAL_MS));
    }
  }
  return 'unavailable';
}

function printPrivateSetupLink(baseUrl, setup, readiness) {
  const privateSetupUrl = setupCapabilityUrl(baseUrl, setup.capability);
  const status = readiness === 'ready'
    ? '  ✔ Worker deployed. Chickpea setup is responding.'
    : '  ✔ Worker deployed. Cloudflare is still activating its public URL.';
  process.stdout.write(
    [
      '',
      RULE,
      status,
      '',
      '  Cloudflare may take another 1–2 minutes to make this URL available to you.',
      '',
      '  🔐 PRIVATE SETUP LINK — COPY AND OPEN THIS',
      RULE,
      `👉 ${privateSetupUrl}`,
    ].join('\n'),
  );
}

function printPrivateSetupPath(setup) {
  const privatePath = new URL(setupCapabilityUrl('https://chickpea.invalid', setup.capability));
  process.stdout.write(
    [
      '',
      RULE,
      '  ✔ Worker deployed.',
      '',
      '  🔐 PRIVATE SETUP PATH — copy and open this on your configured Chickpea domain',
      RULE,
      `👉 ${privatePath.pathname}${privatePath.hash}`,
    ].join('\n'),
  );
}

// Workers Builds receives stdout through a pipe. Let Node exit naturally after
// this callback so the final setup link and Cloudflare's completion event can
// flush; process.exit() can truncate asynchronous pipe writes.
child.on('close', async (code) => {
  cleanupSecrets();
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  // A dry run deploys nothing — next-steps instructions would be a lie.
  if (deployArgs.includes('--dry-run')) {
    return;
  }
  if (deployedUrl && deploymentAuthority) {
    process.stdout.write('\nChecking the public setup URL (up to 5 seconds)...\n');
    const readiness = await setupSurfaceReadiness(deployedUrl);
    if (readiness === 'configured') {
      process.stdout.write(
        `\n${RULE}\n  ✔ Worker deployed. Chickpea Admin is responding.\n\n` +
        '  Cloudflare may take another 1–2 minutes to make this URL available to you.\n\n' +
        `  Open ${deployedUrl}/admin\n${RULE}\n`,
      );
      return;
    }
    printPrivateSetupLink(deployedUrl, deploymentAuthority.setup, readiness);
  } else if (deploymentAuthority) {
    printPrivateSetupPath(deploymentAuthority.setup);
  }
});
