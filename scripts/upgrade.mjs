#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { assertNodeVersion } from './lib/node-version.mjs';
import { wranglerInspector } from './lib/inspect-deployment.mjs';
import { assertCompatibleRelease, inventoryDigest, overlayInstallation, validateInstallation, validateTarget, wranglerProfileArgs } from './lib/upgrade-installation.mjs';
import { assertPrivatePath, readPrivateJson, writePrivateJson, createRecoveryAuthority, validateRecoveryAuthority } from './lib/upgrade-receipt.mjs';
import { fetchReleaseSource, releaseTag, resolveOfficialRelease, verifyReleaseSource } from './lib/upgrade-source.mjs';
import { executePreparedUpgrade, requestDeliveryRecovery } from './lib/upgrade-execution.mjs';
import { AUTH_SCHEMA_QUERY, expectedAuthSchema, normalizeAuthSchemaRows } from './lib/auth-schema.mjs';
import { builtWorkerConfigPath } from './lib/built-worker-config.mjs';

import { TRANSPORT_RECOVERY } from './lib/release-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Chickpea guided upgrades (Cloudflare)

Select an existing installation once, after Cloudflare login:
  npm run upgrade -- --configure --account ACCOUNT_ID --worker WORKER_NAME --profile core --url https://YOUR_CHICKPEA_HOST

Inspect an exact release, without deploying:
  npm run upgrade -- --to v0.1.1 --preflight
Upgrade after reviewing and confirming the selected Worker:
  npm run upgrade -- --to v0.1.1
Resume or recover using the private receipt printed by the command:
  npm run upgrade -- --resume /absolute/path/to/receipt.json
  npm run upgrade -- --recover /absolute/path/to/receipt.json

Use --wrangler-profile NAME during --configure to retain a named Wrangler login
across inspection, deployment, resume, and recovery. This is separate from --profile core.
Use --installation NAME for multiple installations (default: default).
Recovery restores eligible previous code, not a data backup.
Unversioned installations require the evidence described in docs/runbooks/upgrading.md.
`;

function parseArgs(args) {
  const result = {};
  const flags = new Set(['help', 'configure', 'preflight']);
  const values = new Set(['account', 'worker', 'profile', 'wrangler-profile', 'url', 'to', 'installation', 'resume', 'recover']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if ((!flags.has(key) && !values.has(key)) || Object.hasOwn(result, key)) throw new Error('Unknown or repeated upgrade argument. Run npm run upgrade -- --help.');
    if (flags.has(key)) result[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('An upgrade argument is missing its value.');
      result[key] = args[++i];
    }
  }
  if (result.help) return result;
  if ([result.configure, result.to, result.resume, result.recover].filter(Boolean).length !== 1) throw new Error('Choose exactly one operation: --configure, --to, --resume, or --recover.');
  if (!result.configure && (result.account || result.worker || result.profile || result['wrangler-profile'] || result.url)) throw new Error('Target overrides are accepted only during --configure.');
  if (result.preflight && !result.to) throw new Error('--preflight requires --to.');
  if (result.to) releaseTag(result.to);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(result.installation ?? 'default')) throw new Error('Installation names use lowercase letters, digits, and hyphens.');
  return result;
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivatePath(directory, { directory: true });
  return realpathSync(directory);
}

function targetEnvironment(target, { deploy = false, build = false } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CHICKPEA_DEPLOY_') || key.startsWith('CHICKPEA_LOCAL_') || key.startsWith('DEPLOY_TEST_') ||
        (key.startsWith('WRANGLER_') && key !== 'WRANGLER_HOME') || key === 'CHICKPEA_UPGRADE_CONTEXT' || key === 'CLOUDFLARE_ENV') delete env[key];
  }
  Object.assign(env, { CLOUDFLARE_ACCOUNT_ID: target.account, CHICKPEA_DEPLOY_PROFILE: target.profile });
  if (!build) env.WRANGLER_CI_OVERRIDE_NAME = target.worker;
  if (deploy) env.CHICKPEA_DEPLOY_TARGET = 'production';
  return env;
}

function subprocess(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', () => reject(new Error('Unable to start the required local command.')));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('A local build or guarded deployment failed. Use the receipt to inspect and retry.')));
  });
}
function npm(args, cwd, env) {
  const executable = process.env.npm_execpath;
  return executable ? subprocess(process.execPath, [executable, ...args], cwd, env) : subprocess('npm', args, cwd, env);
}

function readEvent(directory) {
  const file = path.join(directory, 'deployment.json');
  return existsSync(file) ? readPrivateJson(file) : undefined;
}

function lockTarget(directory) {
  const file = path.join(directory, 'operation.json');
  if (existsSync(file)) {
    const previous = readPrivateJson(file);
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('Unreadable upgrade lock. Preserve it and inspect the prior operation.');
    try { process.kill(previous.pid, 0); throw new Error('Another upgrade process holds this installation.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(file);
  }
  try { writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' }); }
  catch { throw new Error('Another upgrade process acquired this installation.'); }
  return () => unlinkSync(file);
}

function schemaInspection(sourceRoot, configPath, target) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const expected = expectedAuthSchema({ config, configPath });
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'AUTH_DB', '--remote', '--json', '--command', AUTH_SCHEMA_QUERY, '--config', configPath, ...wranglerProfileArgs(target)],
    { cwd: sourceRoot, env: targetEnvironment(target), encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Unable to inspect the existing AUTH_DB schema. No deployment was attempted.');
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { throw new Error('Unreadable AUTH_DB schema response.'); }
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success === false ||
      JSON.stringify(normalizeAuthSchemaRows(payload[0]?.results)) !== JSON.stringify(expected)) {
    throw new Error('The existing AUTH_DB schema differs from the verified release. Preserve the database and investigate before upgrading.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  assertNodeVersion();
  const stateRoot = privateDirectory(path.join(homedir(), '.chickpea', 'upgrades'));
  const installations = privateDirectory(path.join(stateRoot, 'installations'));
  const receipts = privateDirectory(path.join(stateRoot, 'receipts'));
  const installationFile = path.join(installations, `${options.installation ?? 'default'}.json`);
  let receipt; let directory;
  if (options.resume || options.recover) {
    const file = options.resume ?? options.recover;
    if (!path.isAbsolute(file) || path.basename(file) !== 'receipt.json') throw new Error('Use the exact absolute receipt path printed by the original command.');
    directory = path.dirname(file);
    assertPrivatePath(directory, { directory: true });
    if (path.dirname(realpathSync(directory)) !== receipts) throw new Error('Receipt belongs to a different upgrade-state directory.');
    receipt = readPrivateJson(file);
    if (receipt.schema !== 1 || receipt.id !== path.basename(directory)) throw new Error('Unknown or malformed upgrade receipt.');
  }
  const stored = receipt ? undefined : options.configure ? undefined : readPrivateJson(installationFile);
  const target = validateTarget(receipt?.target ?? (options.configure ? { ...options, wranglerProfile: options['wrangler-profile'] } : stored?.target));
  if (!target.url) throw new Error('Configure the existing Chickpea HTTPS origin with --url before upgrading.');
  const targetLock = privateDirectory(path.join(stateRoot, inventoryDigest({ account: target.account, worker: target.worker })));
  const unlock = lockTarget(targetLock);
  const inspectionDirectory = mkdtempSync(path.join(stateRoot, 'inspection-'));
  try {
    const inspectionConfigPath = path.join(inspectionDirectory, 'wrangler.json');
    const inspectionConfig = { name: target.worker, account_id: target.account, compatibility_date: '2026-08-20' };
    writePrivateJson(inspectionConfigPath, inspectionConfig);
    const inspect = () => validateInstallation(wranglerInspector({ root, configPath: inspectionConfigPath, args: wranglerProfileArgs(target), env: targetEnvironment(target) }).inspect());
    const current = inspect();
    if (stored && (stored.schema !== 1 || stored.bindingsDigest !== inventoryDigest(current.resources))) throw new Error('The selected installation resources changed since configuration. Inspect the account and Worker before configuring again.');
    if (options.configure) {
      if (existsSync(installationFile)) throw new Error('This installation name is already configured. Use a new --installation name after reviewing the changed target.');
      const previous = await resolveOfficialRelease(`v${current.version}`);
      if (previous.commit !== current.commit) throw new Error('Serving source does not match the official release. Follow the adoption guide.');
      writePrivateJson(installationFile, { schema: 1, target, bindingsDigest: inventoryDigest(current.resources) });
      console.log(`Configured existing Worker ${target.worker} in account ${target.account} (${target.profile}; Wrangler login: ${target.wranglerProfile ?? 'automatic'}).`);
      return;
    }
    if (!receipt) {
      const destination = await resolveOfficialRelease(options.to);
      const previous = await resolveOfficialRelease(`v${current.version}`);
      if (current.commit !== previous.commit) throw new Error('Installed source does not match its official release tag. Follow the adoption guide.');
      directory = mkdtempSync(path.join(receipts, 'upgrade-'));
      console.log(`Private receipt: ${path.join(directory, 'receipt.json')}`);
      receipt = { schema: 1, id: path.basename(directory), createdAt: new Date().toISOString(), target, previous, destination, stage: 'inspecting' };
      writePrivateJson(path.join(directory, 'receipt.json'), receipt);
      writePrivateJson(path.join(directory, 'installation.json'), current);
      fetchReleaseSource(path.join(directory, 'previous'), previous);
      fetchReleaseSource(path.join(directory, 'destination'), destination);
    }
    const initial = readPrivateJson(path.join(directory, 'installation.json'));
    const previousRoot = path.join(directory, 'previous');
    const destinationRoot = path.join(directory, 'destination');
    // Verify retained source again on every retry/recovery, before running any
    // dependency or build command from it. Missing partial downloads stop.
    const previous = verifyReleaseSource(previousRoot, receipt.previous);
    const destination = verifyReleaseSource(destinationRoot, receipt.destination);
    assertCompatibleRelease(previous.manifest, destination.manifest);
    if (destination.manifest.recovery === TRANSPORT_RECOVERY) {
      if (!receipt.recovery) {
        if (readEvent(directory)?.knownVersions?.length) throw new Error('Deployed upgrade is missing its recovery authority. Preserve the receipt.');
        receipt.recovery = createRecoveryAuthority();
        writePrivateJson(path.join(directory, 'receipt.json'), receipt);
      }
      validateRecoveryAuthority(receipt.recovery);
    }
    inspectionConfig.d1_databases = [{ binding: 'AUTH_DB', database_name: 'chickpea-auth-db', database_id: initial.databaseId,
      migrations_dir: path.join(previousRoot, 'migrations/better-auth') }];
    writePrivateJson(inspectionConfigPath, inspectionConfig);
    schemaInspection(previousRoot, inspectionConfigPath, target);
    const receiptPath = path.join(directory, 'receipt.json');
    const contextPath = path.join(directory, 'context.json');
    const save = (value) => writePrivateJson(receiptPath, { ...value, updatedAt: new Date().toISOString() });
    const sourceRoot = (source) => source.commit === receipt.previous.commit ? previousRoot : destinationRoot;
    const deployEnvironment = () => ({ ...targetEnvironment(target, { deploy: true }), CHICKPEA_UPGRADE_CONTEXT: contextPath });
    const writeContext = (source, installation) => writePrivateJson(contextPath, { schema: 1, target, installation, source, sourceRoot: sourceRoot(source), ...(source.commit === receipt.destination.commit && receipt.recovery ? { recovery: receipt.recovery } : {}) });
    const prepare = async (source, installation) => {
      const checkout = sourceRoot(source);
      verifyReleaseSource(checkout, source);
      // Build retained releases with their authored name: v0.1.0's size check
      // assumes that output directory. Retarget only generated configuration,
      // leaving verified source, compiled app identity, and DO classes intact.
      const buildEnvironment = targetEnvironment(target, { build: true });
      await npm(['ci', '--no-audit', '--no-fund'], checkout, buildEnvironment);
      await npm(['run', 'build'], checkout, buildEnvironment);
      const configPath = builtWorkerConfigPath(checkout);
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.name = target.worker;
      config.topLevelName = target.worker;
      overlayInstallation(config, installation, target);
      // Preserve the overlay only in the generated artifact, never tracked source.
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      writeContext(source, installation);
      await subprocess(process.execPath, [path.join(root, 'scripts/deploy-with-epilogue.mjs'), '--skip-build', '--preflight-only', ...wranglerProfileArgs(target)], checkout, deployEnvironment());
    };
    if (options.preflight) {
      await prepare(receipt.destination, current);
      save({ ...receipt, stage: 'prepared' });
      console.log(`Preflight passed for ${target.worker}: v${current.version} → ${receipt.destination.tag}. No deployment was attempted.\nReceipt: ${receiptPath}`);
      return;
    }
    const result = await executePreparedUpgrade({ receipt, initial, direction: options.recover ? 'recover' : receipt.direction ?? 'upgrade', inspect,
      readEvent: () => readEvent(directory), save, prepare,
      recoverDelivery: (installation) => requestDeliveryRecovery({ url: target.url,
        workerVersion: installation.workerVersion, capability: validateRecoveryAuthority(receipt.recovery).capability }),
      confirm: async (source, installation, direction) => {
        console.log(`\n${direction === 'recover' ? 'Recover previous code' : 'Upgrade'}: ${target.worker}\nCloudflare account: ${target.account}\nProfile: ${target.profile}\nWrangler login: ${target.wranglerProfile ?? 'automatic'}\nChickpea URL: ${target.url}\nServing: v${installation.version} (${installation.commit.slice(0, 12)})\nDestination: ${source.tag} (${source.commit.slice(0, 12)})\nExisting data and credential roots will be retained. This is not a data backup.\nReceipt: ${receiptPath}`);
        if (!process.stdin.isTTY) throw new Error('Interactive confirmation is required. Run this command in your terminal.');
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { return (await input.question(`Type ${target.worker} to continue: `)).trim() === target.worker; }
        finally { input.close(); }
      },
      deploy: async (source, installation) => {
        writeContext(source, installation);
        await subprocess(process.execPath, [path.join(root, 'scripts/deploy-with-epilogue.mjs'), '--skip-build', ...wranglerProfileArgs(target)], sourceRoot(source), deployEnvironment());
      },
    });
    console.log(`Upgrade ${result}. Receipt: ${receiptPath}`);
  } finally {
    rmSync(inspectionDirectory, { recursive: true, force: true });
    unlock();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Upgrade failed. Preserve its private receipt.'); process.exitCode = 1; });
