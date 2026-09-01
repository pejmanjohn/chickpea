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
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
  formatCloudflareDeploymentTargetTuple,
  readCloudflareDeploymentTargetTuple,
  resolveCloudflareDeploymentProfile,
} from './cloudflare-deployment-profile.mjs';
import {
  mintSetupCapability,
  SETUP_CAPABILITY_DIGEST_BINDING,
  SETUP_CAPABILITY_ISSUED_AT_BINDING,
  setupCapabilityUrl,
} from '../src/auth/setup-capability.mjs';
import {
  DEPLOYMENT_ACTIVATION_DIGEST_BINDING,
  DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING,
  mintDeploymentActivation,
} from '../src/auth/deployment-activation.mjs';

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
const RETIRED_AUTH_CLASSES = Object.freeze(['AuthGuard']);
const EXPECTED_DELETED_CLASSES = Object.freeze([
  ...BETA_FLUE_CLASSES,
  ...RETIRED_AUTH_CLASSES,
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
const PROTECTED_CLASSES = new Set(['TagStateStore', 'Sandbox', 'ContainerProxy']);

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

function expectedWorkerName(targetTuple) {
  if (targetTuple) return targetTuple.workerName;
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
  const targetTuple = readCloudflareDeploymentTargetTuple(config);
  const expectedName = expectedWorkerName(targetTuple);
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
  const unexpected = destructive.filter((name) => !EXPECTED_DELETED_CLASSES.includes(name));
  if (unexpected.length) failures.push(`unexpected deleted/renamed classes: ${unexpected.join(', ')}`);
  const protectedDestruction = destructive.filter((name) => PROTECTED_CLASSES.has(name));
  if (protectedDestruction.length) {
    failures.push(`protected classes marked deleted/renamed: ${protectedDestruction.join(', ')}`);
  }
  if (!sameMembers(deleted, EXPECTED_DELETED_CLASSES) || renamed.length > 0) {
    failures.push('the exact beta and retired AuthGuard deletion set with no class renames');
  }
  const reset = migrations.find((migration) => migration.tag === 'v6');
  if (!reset || !sameMembers(reset.new_sqlite_classes ?? [], V2_AGENT_CLASSES)) {
    failures.push('v6 fresh Flue 2 SQLite agent classes');
  }
  const sandboxMigration = migrations.find((migration) => migration.tag === 'v3');
  if (!sandboxMigration || !sameMembers(sandboxMigration.new_sqlite_classes ?? [], ['Sandbox'])) {
    failures.push('v3 Sandbox SQLite class');
  }
  const authGuardMigration = migrations.find((migration) => migration.tag === 'v7');
  if (!authGuardMigration || !sameMembers(authGuardMigration.new_sqlite_classes ?? [], RETIRED_AUTH_CLASSES)) {
    failures.push('v7 AuthGuard SQLite class history');
  }
  const authGuardRetirement = migrations.find((migration) => migration.tag === 'v8');
  if (!authGuardRetirement || !sameMembers(authGuardRetirement.deleted_classes ?? [], RETIRED_AUTH_CLASSES)) {
    failures.push('v8 AuthGuard retirement');
  }
  const gatewaySessionMigration = migrations.find((migration) => migration.tag === 'v9');
  if (!gatewaySessionMigration || !sameMembers(gatewaySessionMigration.new_sqlite_classes ?? [], ['SlackGatewaySession'])) {
    failures.push('v9 SlackGatewaySession SQLite class');
  }

  const bindings = config.durable_objects?.bindings ?? [];
  const hasBinding = (name, className) => bindings.some(
    (binding) => binding.name === name && binding.class_name === className,
  );
  if (!hasBinding('TAG_STATE', 'TagStateStore')) failures.push('TAG_STATE/TagStateStore binding');
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
  if (!(config.compatibility_flags ?? []).includes('global_fetch_strictly_public')) {
    failures.push('global_fetch_strictly_public for the shared Slack gateway');
  }
  if (config.version_metadata?.binding !== 'CF_VERSION_METADATA') {
    failures.push('CF_VERSION_METADATA Worker version binding');
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
let deploymentTargetTuple;
try {
  const artifact = requireBuiltArtifact();
  builtArtifact = validateDeploymentArtifact(artifact);
  deploymentTargetTuple = readCloudflareDeploymentTargetTuple(builtArtifact.config);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (deploymentTargetTuple) {
  process.stdout.write(`${formatCloudflareDeploymentTargetTuple(deploymentTargetTuple)}\n`);
}

if (preflightOnly) {
  process.stdout.write('Permanent Cloudflare capability preflight passed. No deployment was attempted.\n');
  process.exit(0);
}

const AUTH_SECRET = 'CHICKPEA_AUTH_SECRET';
const CREDENTIAL_CURRENT_KEY = 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID';
const CREDENTIAL_KEY_PREFIX = 'CHICKPEA_CREDENTIAL_KEY_';
const INITIAL_CREDENTIAL_KEY_ID = 'key_v1';
const INITIAL_CREDENTIAL_KEY_SLOT = `${CREDENTIAL_KEY_PREFIX}KEY_V1`;
const DEFAULT_ACTIVE_WORKER_INSPECTION_TIMEOUT_MS = 30_000;
const configuredInspectionTimeout = Number(
  process.env.CHICKPEA_DEPLOY_INSPECTION_TIMEOUT_MS,
);
const activeWorkerInspectionTimeoutMs = Number.isFinite(configuredInspectionTimeout) &&
  configuredInspectionTimeout > 0
  ? Math.min(configuredInspectionTimeout, DEFAULT_ACTIVE_WORKER_INSPECTION_TIMEOUT_MS)
  : DEFAULT_ACTIVE_WORKER_INSPECTION_TIMEOUT_MS;

function inspectRemoteWorker(artifact) {
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
  if (result.status !== 0 && /Worker\s+"[^"]+"[^\n]*not found/i.test(detail)) {
    return { exists: false, names: new Set() };
  }
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
  return { exists: true, names: new Set(entries.map((entry) => entry.name)) };
}

function activeDeployment(artifact) {
  const status = spawnSync(
    process.execPath,
    [
      wranglerBin,
      'deployments',
      'status',
      '--json',
      '--config',
      artifact.configPath,
      ...deploymentResourceArgs(),
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: activeWorkerInspectionTimeoutMs,
    },
  );
  if (status.error) {
    throw new Error(
      'Unable to inspect the active Worker deployment. Refusing an update without its current AUTH_DB binding.',
    );
  }
  if (status.status !== 0) {
    throw new Error(
      'Unable to inspect the active Worker deployment. Refusing an update without its current AUTH_DB binding.',
    );
  }
  let deployment;
  try {
    deployment = JSON.parse(status.stdout);
  } catch {
    throw new Error('Active Worker deployment discovery returned an unreadable response.');
  }
  const versions = Array.isArray(deployment?.versions)
    ? deployment.versions.filter((version) => Number(version?.percentage) > 0)
    : [];
  if (versions.length === 0 || versions.some((version) =>
    typeof version?.version_id !== 'string' || !version.version_id.trim()
  )) {
    throw new Error('Active Worker deployment discovery returned no readable serving versions.');
  }
  return versions;
}

function deploymentFingerprint(versions) {
  return versions
    .map((version) => `${version.version_id.trim()}:${Number(version.percentage)}`)
    .sort()
    .join(',');
}

function assertActiveDeploymentUnchanged(artifact, expectedFingerprint) {
  const currentFingerprint = deploymentFingerprint(activeDeployment(artifact));
  if (currentFingerprint === expectedFingerprint) return;
  throw new Error(
    'The active Worker deployment changed while this deploy was preparing. ' +
    'Another task is using the same deployment target; refusing to replace its canary. ' +
    'Coordinate the live acceptance run, then rebuild and deploy again.',
  );
}

function deployedAuthDatabase(artifact) {
  const versions = activeDeployment(artifact);

  const databaseIds = [];
  let versionsWithoutAuthDatabase = 0;
  for (const version of versions) {
    const view = spawnSync(
      process.execPath,
      [
        wranglerBin,
        'versions',
        'view',
        version.version_id,
        '--json',
        '--config',
        artifact.configPath,
        ...deploymentResourceArgs(),
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: activeWorkerInspectionTimeoutMs,
      },
    );
    if (view.error) {
      throw new Error(
        `Unable to inspect active Worker version ${version.version_id}. ` +
        'Refusing an update without its current AUTH_DB binding.',
      );
    }
    if (view.status !== 0) {
      throw new Error(
        `Unable to inspect active Worker version ${version.version_id}. ` +
        'Refusing an update without its current AUTH_DB binding.',
      );
    }
    let details;
    try {
      details = JSON.parse(view.stdout);
    } catch {
      throw new Error(`Active Worker version ${version.version_id} returned unreadable binding details.`);
    }
    const bindings = (details?.resources?.bindings ?? []).filter(
      (binding) => binding?.name === 'AUTH_DB' && binding?.type === 'd1',
    );
    if (bindings.length > 1) {
      throw new Error(`Active Worker version ${version.version_id} has duplicate AUTH_DB bindings.`);
    }
    if (bindings.length === 0) {
      versionsWithoutAuthDatabase += 1;
      continue;
    }
    const databaseId = bindings[0].database_id ?? bindings[0].id;
    if (typeof databaseId !== 'string' || !databaseId.trim()) {
      throw new Error(`Active Worker version ${version.version_id} has an unreadable AUTH_DB binding.`);
    }
    databaseIds.push(databaseId.trim());
  }
  if (versionsWithoutAuthDatabase > 0 && databaseIds.length > 0) {
    throw new Error('Active Worker versions disagree about whether AUTH_DB is bound; refusing to guess.');
  }
  const uniqueIds = [...new Set(databaseIds)];
  if (uniqueIds.length > 1) {
    throw new Error('Active Worker versions use different AUTH_DB databases; refusing to update either one.');
  }
  return {
    databaseId: uniqueIds[0],
    fingerprint: deploymentFingerprint(versions),
  };
}

async function prepareDeploymentAuthority(artifact, secretNames) {
  const generatedSecrets = {};
  if (!secretNames.has(AUTH_SECRET)) {
    generatedSecrets[AUTH_SECRET] = (await mintSetupCapability()).capability;
  }
  const hasCredentialCurrent = secretNames.has(CREDENTIAL_CURRENT_KEY);
  const credentialSlots = [...secretNames].filter((name) =>
    name.startsWith(CREDENTIAL_KEY_PREFIX) && name !== CREDENTIAL_CURRENT_KEY
  );
  if (!hasCredentialCurrent && credentialSlots.length === 0) {
    generatedSecrets[CREDENTIAL_CURRENT_KEY] = INITIAL_CREDENTIAL_KEY_ID;
    generatedSecrets[INITIAL_CREDENTIAL_KEY_SLOT] = randomBytes(32).toString('base64url');
  } else if (!hasCredentialCurrent || credentialSlots.length === 0) {
    throw new Error(
      'Cloudflare Slack credential encryption is only partially provisioned. ' +
      'Restore CHICKPEA_CREDENTIAL_KEY_CURRENT_ID and its versioned ' +
      'CHICKPEA_CREDENTIAL_KEY_<ID> slot before deploying.',
    );
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

async function bindDeploymentActivation(artifact) {
  const activation = await mintDeploymentActivation();
  artifact.config.vars = {
    ...(artifact.config.vars ?? {}),
    [DEPLOYMENT_ACTIVATION_DIGEST_BINDING]: activation.digest,
    [DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING]: String(activation.issuedAt),
  };
  writeFileSync(artifact.configPath, `${JSON.stringify(artifact.config, null, 2)}\n`);
  return activation;
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

function ensureAuthDatabase(artifact, deployedDatabaseId) {
  const authDb = (artifact.config.d1_databases ?? []).find(
    (binding) => binding.binding === 'AUTH_DB',
  );
  const targetTuple = readCloudflareDeploymentTargetTuple(artifact.config);
  if (deployedDatabaseId) {
    const generatedId = typeof authDb?.database_id === 'string'
      ? authDb.database_id.trim()
      : '';
    if (generatedId && generatedId !== deployedDatabaseId) {
      throw new Error(
        `The generated AUTH_DB database (${generatedId}) differs from the deployed database ` +
        `(${deployedDatabaseId}); refusing to replace customer auth data.`,
      );
    }
    process.stdout.write('Preserving the deployed AUTH_DB database...\n');
    authDb.database_id = deployedDatabaseId;
    writeFileSync(artifact.configPath, `${JSON.stringify(artifact.config, null, 2)}\n`);
    return validateDeploymentArtifact(requireBuiltArtifact(), { requireDatabaseId: true });
  }
  if (typeof authDb?.database_id === 'string' && authDb.database_id.trim()) return artifact;
  const existingId = existingAuthDatabaseId(authDb?.database_name || 'chickpea-auth-db');
  if (existingId) {
    if (targetTuple?.stateMode === 'disposable') {
      throw new Error(
        `Cloudflare disposable target ${targetTuple.target} already has an existing AUTH_DB. ` +
        'Remove that disposable state or register its immutable ID and schema generation before deploying.',
      );
    }
    process.stdout.write('Reusing the customer-owned AUTH_DB database...\n');
    authDb.database_id = existingId;
    writeFileSync(artifact.configPath, `${JSON.stringify(artifact.config, null, 2)}\n`);
    return validateDeploymentArtifact(requireBuiltArtifact(), { requireDatabaseId: true });
  }
  const rootConfig = path.join(projectRoot, 'wrangler.jsonc');
  const provisionConfig = targetTuple ? artifact.configPath : rootConfig;
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
      provisionConfig,
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
  if (targetTuple) {
    return validateDeploymentArtifact(requireBuiltArtifact(), { requireDatabaseId: true });
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

const AUTH_SCHEMA_QUERY =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' " +
  "AND name NOT IN ('d1_migrations','_cf_KV') ORDER BY type,name";

function normalizeAuthSchemaRows(rows) {
  if (!Array.isArray(rows)) throw new Error('AUTH_DB schema inspection returned no rows.');
  return rows.filter((row) => row?.name !== '_cf_KV').map((row) => {
    if (!row || typeof row.type !== 'string' || typeof row.name !== 'string' ||
        typeof row.tbl_name !== 'string' || typeof row.sql !== 'string') {
      throw new Error('AUTH_DB schema inspection returned an unreadable row.');
    }
    return {
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      // Cloudflare D1 may serialize a table's outer parentheses as `( ... )`
      // while Node SQLite preserves the authored `(...)`. Both forms describe
      // the same schema, so normalize only that insignificant whitespace while
      // retaining every identifier, column, constraint, and index definition.
      sql: row.sql
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim()
        .toLowerCase(),
    };
  });
}

function expectedAuthSchema(artifact) {
  const binding = (artifact.config.d1_databases ?? []).find(
    (candidate) => candidate.binding === 'AUTH_DB',
  );
  const migrationsDirectory = path.resolve(
    path.dirname(artifact.configPath),
    binding?.migrations_dir ?? '',
  );
  let migrationPaths;
  try {
    migrationPaths = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => path.join(migrationsDirectory, name));
    if (migrationPaths.length === 0) throw new Error('no SQL migrations found');
  } catch (error) {
    throw new Error(
      `Unable to read the reviewed Better Auth migration chain: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const database = new DatabaseSync(':memory:');
  try {
    for (const migrationPath of migrationPaths) {
      database.exec(readFileSync(migrationPath, 'utf8'));
    }
    return normalizeAuthSchemaRows(database.prepare(AUTH_SCHEMA_QUERY).all());
  } finally {
    database.close();
  }
}

function verifyRemoteAuthSchema(artifact) {
  const expected = expectedAuthSchema(artifact);
  const inspection = spawnSync(
    process.execPath,
    [
      wranglerBin,
      'd1',
      'execute',
      'AUTH_DB',
      '--remote',
      '--json',
      '--command',
      AUTH_SCHEMA_QUERY,
      '--config',
      artifact.configPath,
      ...deploymentResourceArgs(),
    ],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  if (inspection.error || inspection.status !== 0) {
    throw new Error(
      'Unable to inspect the migrated AUTH_DB schema. Refusing to upload the Worker.',
    );
  }
  let payload;
  try {
    payload = JSON.parse(inspection.stdout);
  } catch {
    throw new Error('AUTH_DB schema inspection returned unreadable JSON.');
  }
  const statements = Array.isArray(payload) ? payload : [];
  const resultSets = statements.filter((statement) => Array.isArray(statement?.results));
  if (resultSets.length !== 1 || resultSets[0]?.success === false) {
    throw new Error('AUTH_DB schema inspection returned an unexpected result.');
  }
  const actual = normalizeAuthSchemaRows(resultSets[0].results);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      'AUTH_DB contains an incompatible reviewed Better Auth migration-chain schema. ' +
      'This Slack-only release supports a fresh empty AUTH_DB only; reset the disposable database ' +
      'or provision a new one with the exact preserved binding before deploying.',
    );
  }
  process.stdout.write('Verified the exact fresh Better Auth schema in AUTH_DB...\n');
}

let deploymentAuthority;
let remoteWorker;
let expectedActiveDeploymentFingerprint;
if (!deployArgs.includes('--dry-run')) {
  try {
    remoteWorker = inspectRemoteWorker(builtArtifact);
    if (deploymentTargetTuple?.stateMode === 'disposable' && remoteWorker.exists) {
      throw new Error(
        `Cloudflare disposable target ${deploymentTargetTuple.target} already has an existing Worker ` +
        'and Durable Object state. Remove that disposable state or register its immutable AUTH_DB ID ' +
        'and schema generation before deploying.',
      );
    }
    const deployed = remoteWorker.exists
      ? deployedAuthDatabase(builtArtifact)
      : undefined;
    expectedActiveDeploymentFingerprint = deployed?.fingerprint;
    builtArtifact = ensureAuthDatabase(builtArtifact, deployed?.databaseId);
    // This is the final gate immediately before the first mutation of an
    // existing customer resource. It intentionally reruns after both D1 reuse
    // injection and D1 provisioning/rebuild.
    builtArtifact = validateDeploymentArtifact(builtArtifact, { requireDatabaseId: true });
    deploymentAuthority = await prepareDeploymentAuthority(builtArtifact, remoteWorker.names);
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
  try {
    verifyRemoteAuthSchema(builtArtifact);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

let preparedSecrets;
try {
  if (deploymentAuthority) {
    deploymentAuthority.activation = await bindDeploymentActivation(builtArtifact);
  }
  preparedSecrets = deploymentAuthority
    ? createSecretsFile(deploymentAuthority.generatedSecrets)
    : undefined;
} catch (error) {
  console.error(`Unable to prepare the temporary Worker secrets file: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// The inspection above intentionally happens after the build, when this
// deploy knows the exact target and preserved bindings. A second task may
// still finish its own deploy while migrations/readiness preparation runs.
// Re-read the serving versions at the last safe boundary so overlapping
// disposable acceptance runs fail closed instead of silently replacing one
// another's Worker and interrupting their admitted Slack turns.
if (expectedActiveDeploymentFingerprint) {
  try {
    assertActiveDeploymentUnchanged(builtArtifact, expectedActiveDeploymentFingerprint);
  } catch (error) {
    removeSecretsFile(preparedSecrets);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
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
let deployedVersionId = '';
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
  const versionMatch = text.match(/Current Version ID:\s*([A-Za-z0-9-]+)/);
  if (versionMatch?.[1]) deployedVersionId = versionMatch[1];
  tail = text.slice(-256);
});

const DEFAULT_DEPLOYMENT_READINESS_TIMEOUT_MS = 6 * 60 * 1_000;
const MAX_DEPLOYMENT_READINESS_TIMEOUT_MS = 10 * 60 * 1_000;
const configuredReadinessTimeout = Number(process.env.CHICKPEA_DEPLOY_READINESS_TIMEOUT_MS);
const deploymentReadinessTimeoutMs = Number.isFinite(configuredReadinessTimeout) &&
  configuredReadinessTimeout > 0
  ? Math.min(configuredReadinessTimeout, MAX_DEPLOYMENT_READINESS_TIMEOUT_MS)
  : DEFAULT_DEPLOYMENT_READINESS_TIMEOUT_MS;
const testReadinessStatuses = process.env.DEPLOY_TEST_READINESS_STATUSES
  ?.split(',')
  .map((value) => Number(value.trim()))
  .filter(Number.isInteger);
let testReadinessIndex = 0;

function readinessBaseUrl() {
  if (deployedUrl) return deployedUrl;
  if (process.env.DEPLOY_TEST_READINESS_BASE_URL) {
    return process.env.DEPLOY_TEST_READINESS_BASE_URL;
  }
  const configured = builtArtifact.config.vars?.SLACK_TAG_PUBLIC_URL;
  return typeof configured === 'string' && configured.trim()
    ? configured.trim().replace(/\/+$/, '')
    : undefined;
}

async function requestDeploymentReadiness(baseUrl, versionId, activation) {
  if (testReadinessStatuses?.length) {
    const status = testReadinessStatuses[
      Math.min(testReadinessIndex, testReadinessStatuses.length - 1)
    ];
    testReadinessIndex += 1;
    return status;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(new URL('/internal/deployment/ready', baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${activation.capability}`,
        'X-Chickpea-Target-Version': versionId,
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    return response.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDeploymentReadiness(baseUrl, versionId, activation) {
  const deadline = Date.now() + deploymentReadinessTimeoutMs;
  process.stdout.write('Waiting for the current Worker and Slack gateway version...\n');
  while (Date.now() < deadline) {
    if (await requestDeploymentReadiness(baseUrl, versionId, activation) === 204) {
      process.stdout.write('Verified current-version deployment readiness.\n');
      return;
    }
    if (testReadinessStatuses?.length &&
        testReadinessIndex >= testReadinessStatuses.length) break;
    if (!testReadinessStatuses?.length) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(
    'Worker uploaded, but current-version readiness was not confirmed. ' +
    'The Slack gateway may still be serving older code.',
  );
}

const RULE = '────────────────────────────────────────────────────────';
function printPrivateSetupLink(baseUrl, setup) {
  const privateSetupUrl = setupCapabilityUrl(baseUrl, setup.capability);
  process.stdout.write(
    [
      '',
      RULE,
      '  ✔ Worker deployed.',
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
  const baseUrl = readinessBaseUrl();
  if (!baseUrl || !deployedVersionId || !deploymentAuthority) {
    console.error(
      'Worker uploaded, but its version or public origin was unavailable for readiness verification.',
    );
    process.exitCode = 1;
    return;
  }
  try {
    await waitForDeploymentReadiness(
      baseUrl,
      deployedVersionId,
      deploymentAuthority.activation,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (deployedUrl && deploymentAuthority) {
    printPrivateSetupLink(deployedUrl, deploymentAuthority.setup);
  } else if (deploymentAuthority) {
    printPrivateSetupPath(deploymentAuthority.setup);
  }
});
