// Shared by tests/deploy-with-epilogue*.test.ts.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Release tooling JavaScript helper.
import { validateInstallation } from '../scripts/lib/upgrade-installation.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { writePrivateJson } from '../scripts/lib/upgrade-receipt.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'deploy-with-epilogue.mjs');
const PROFILE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'cloudflare-deployment-profile.mjs');
const CAPABILITY_SCRIPT = path.join(PROJECT_ROOT, 'src', 'auth', 'setup-capability.mjs');
const ACTIVATION_SCRIPT = path.join(PROJECT_ROOT, 'src', 'auth', 'deployment-activation.mjs');
export const AUTH_MIGRATIONS = [
  '0001_better_auth.sql',
  '0002_mcp_oauth.sql',
].map((name) => path.join(PROJECT_ROOT, 'migrations', 'better-auth', name));

export function createHarness() {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-deploy-wrapper-'));
  const scriptsDir = path.join(root, 'scripts');
  const scriptsLibDir = path.join(scriptsDir, 'lib');
  const authDir = path.join(root, 'src', 'auth');
  const releaseDir = path.join(root, 'src', 'release');
  const authMigrationsDir = path.join(root, 'migrations', 'better-auth');
  const wranglerDir = path.join(root, 'node_modules', 'wrangler', 'bin');
  const logPath = path.join(root, 'commands.log');
  const secretCapturePath = path.join(root, 'secret-capture.json');
  const npmStub = path.join(root, 'fake-npm.mjs');
  const wranglerStub = path.join(wranglerDir, 'wrangler.js');
  const timeoutStub = path.join(root, 'fake-inspection-timeout.mjs');

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(scriptsLibDir, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  mkdirSync(path.join(root, 'src', 'config'), { recursive: true });
  copyFileSync(path.join(PROJECT_ROOT, 'src/config/qa-targets.ts'), path.join(root, 'src/config/qa-targets.ts'));
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(authMigrationsDir, { recursive: true });
  mkdirSync(wranglerDir, { recursive: true });
  for (const name of ['upgrade-source.mjs', 'build-identity.mjs', 'built-worker-config.mjs', 'inspect-deployment.mjs', 'auth-schema.mjs', 'upgrade-installation.mjs', 'upgrade-receipt.mjs', 'release-manifest.mjs', 'sandbox-deploy-preflight.mjs', 'deploy-operator-secrets.mjs', 'lane-secrets.mjs', 'qa-lanes.mjs']) {
    copyFileSync(path.join(PROJECT_ROOT, 'scripts/lib', name), path.join(scriptsLibDir, name));
  }
  copyFileSync(DEPLOY_SCRIPT, path.join(scriptsDir, 'deploy-with-epilogue.mjs'));
  copyFileSync(PROFILE_SCRIPT, path.join(scriptsDir, 'cloudflare-deployment-profile.mjs'));
  copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'worker-artifact.mjs'), path.join(scriptsDir, 'worker-artifact.mjs'));
  symlinkSync(path.join(PROJECT_ROOT, 'node_modules', 'typescript'), path.join(root, 'node_modules', 'typescript'), 'dir');
  copyFileSync(CAPABILITY_SCRIPT, path.join(authDir, 'setup-capability.mjs'));
  copyFileSync(ACTIVATION_SCRIPT, path.join(authDir, 'deployment-activation.mjs'));
  copyFileSync(path.join(PROJECT_ROOT, 'src', 'release', 'upgrade-compatibility.mjs'), path.join(releaseDir, 'upgrade-compatibility.mjs'));
  writeFileSync(path.join(scriptsLibDir, 'cloudflare-account-preflight.mjs'), `
    import { appendFileSync, existsSync, readFileSync } from 'node:fs';
    export async function preflightCloudflareAccount(options) {
      if (process.env.DEPLOY_TEST_ACCOUNT_LOG === '1') appendFileSync(process.env.DEPLOY_TEST_LOG, 'account-preflight:' + options.configPath + '\\n');
      if (process.env.DEPLOY_TEST_SUBDOMAIN_MISSING === '1') throw new Error('Workers.dev registration is missing for the selected account.');
      const config = existsSync(options.configPath) ? JSON.parse(readFileSync(options.configPath, 'utf8')) : {};
      return { workersDev: config.workers_dev !== false, accountId: process.env.CLOUDFLARE_ACCOUNT_ID || 'a'.repeat(32) };
    }
    export function assertCloudflareAccountConfig() {}
  `);
  writeFileSync(path.join(scriptsLibDir, 'environment-preflight.mjs'), `
    import { appendFileSync, writeFileSync } from 'node:fs';
    let calls = 0;
    export async function preflightEnvironmentMutation(target, options = {}) {
      calls += 1;
      appendFileSync(process.env.DEPLOY_TEST_LOG, 'environment-preflight:' + calls + ':' + target + '\\n');
      if (process.env.DEPLOY_TEST_LOG_PROVIDER_CONTEXT === '1') {
        appendFileSync(process.env.DEPLOY_TEST_LOG, 'environment-provider:' + JSON.stringify(options.providerContext || []) + '\\n');
      }
      if (Number(process.env.DEPLOY_TEST_ENV_PREFLIGHT_FAIL_AT) === calls) {
        throw new Error('environment preflight changed');
      }
      return {
        schemaVersion: 'chickpea-environment-mutation-preflight/v1', target,
        claim: { leaseNonce: 'nonce', claimedRevision: 'revision' },
        registration: { workerName: 'chickpea-' + target, authDatabaseId: 'test-database-id', providerAuthConfigId: 'standard-' + target },
        deploymentMetadata: { target, sourceDirty: false, baselineDigest: 'sha256:test' },
      };
    }
    export async function resumeEnvironmentDeployment(target, options = {}) {
      if (process.env.DEPLOY_TEST_ENV_RESUME !== '1') return null;
      appendFileSync(process.env.DEPLOY_TEST_LOG, 'environment-resume:' + target + ':' + JSON.stringify(options.providerContext || []) + '\\n');
      const preflight = {
        schemaVersion: 'chickpea-environment-mutation-preflight/v1', target,
        claim: { leaseNonce: 'nonce', claimedRevision: 'revision' },
        registration: { workerName: 'chickpea-' + target, authDatabaseId: 'test-database-id', providerAuthConfigId: 'standard-' + target },
        deploymentMetadata: { target, sourceDirty: false, baselineDigest: 'sha256:test' },
      };
      return {
        schemaVersion: 'chickpea-environment-deployment-resume/v1',
        preflight,
        mutationLease: { schemaVersion: 'chickpea-environment-mutation-lease/v1', target },
      };
    }
    export async function recheckResumedEnvironmentDeployment(resumed, options = {}) {
      appendFileSync(process.env.DEPLOY_TEST_LOG, 'environment-resume-recheck:' + resumed.preflight.target + ':' + JSON.stringify(options.providerContext || []) + '\\n');
      return resumed;
    }
    export function assertSameEnvironmentMutationAuthority(_before, after) { return after; }
    export function recheckEnvironmentMutationAuthority(preflight) {
      calls += 1;
      appendFileSync(process.env.DEPLOY_TEST_LOG, 'environment-preflight:' + calls + ':' + preflight.target + '\\n');
      if (Number(process.env.DEPLOY_TEST_ENV_PREFLIGHT_FAIL_AT) === calls) {
        throw new Error('environment preflight changed');
      }
      return preflight;
    }
    export function environmentDeploymentMetadataBindings(metadata) {
      return { CHICKPEA_ENV_TARGET: metadata.target, CHICKPEA_ENV_SOURCE_DIRTY: 'false' };
    }
    export function beginEnvironmentDeployment(preflight) {
      appendFileSync(process.env.DEPLOY_TEST_LOG, 'environment-begin:' + preflight.target + '\\n');
      return { schemaVersion: 'chickpea-environment-mutation-lease/v1', target: preflight.target };
    }
    export async function completeEnvironmentDeployment(_preflight, options) {
      appendFileSync(process.env.DEPLOY_TEST_LOG, 'environment-complete:' + options.deployedVersion + '\\n');
      if (process.env.DEPLOY_TEST_LOG_MUTATION_LEASE === '1') {
        appendFileSync(process.env.DEPLOY_TEST_LOG, 'environment-complete-lease:' + Boolean(options.mutationLease) + '\\n');
      }
      if (process.env.DEPLOY_TEST_ENV_POST_DRIFT === '1') throw new Error('POST_DEPLOY_VERSION_DRIFT');
      if (process.env.DEPLOY_TEST_ENV_RECEIPT) writeFileSync(process.env.DEPLOY_TEST_ENV_RECEIPT, 'receipt\\n');
    }
  `);
  writeFileSync(path.join(scriptsLibDir, 'qa-candidate.mjs'), `
    import { appendFileSync } from 'node:fs';
    let rechecks = 0;
    export function admitQaCandidate() {
      if (process.env.DEPLOY_TEST_SOURCE_LOG === '1') appendFileSync(process.env.DEPLOY_TEST_LOG, 'source-admission\\n');
      if (process.env.DEPLOY_TEST_SOURCE_REFUSED === '1') throw new Error('QA_SOURCE_BEHIND_MAIN');
      return { approvedTip: 'a'.repeat(40), trackingMatchesRemote: true };
    }
    export function recheckQaCandidate() {
      rechecks += 1;
      if (process.env.DEPLOY_TEST_SOURCE_LOG === '1') appendFileSync(process.env.DEPLOY_TEST_LOG, 'source-recheck:' + rechecks + '\\n');
      if (Number(process.env.DEPLOY_TEST_SOURCE_CHANGE_AT) === rechecks) throw new Error('QA_SOURCE_CHANGED');
    }
  `);
  for (const migrationPath of AUTH_MIGRATIONS) {
    copyFileSync(migrationPath, path.join(authMigrationsDir, path.basename(migrationPath)));
  }

  const commandLogger = (label: string) => `
    import { appendFileSync } from 'node:fs';
    appendFileSync(
      process.env.DEPLOY_TEST_LOG,
      ${JSON.stringify(label)} + ':' + JSON.stringify(process.argv.slice(2)) + '\\n',
    );
  `;
  writeFileSync(timeoutStub, `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      const phase = process.env.DEPLOY_TEST_TIMEOUT_INSPECTION;
      const isTarget = phase === 'status'
        ? args?.[1] === 'deployments' && args?.[2] === 'status'
        : args?.[1] === 'versions' && args?.[2] === 'view';
      if (!isTarget) return originalSpawnSync(command, args, options);
      // Prove the wrapper supplies a bounded timeout without racing Node's
      // process startup against a 100ms wall clock in the parallel suite.
      assert.equal(options.timeout, 30_000);
      appendFileSync(process.env.DEPLOY_TEST_LOG,
        'wrangler:' + JSON.stringify(args.slice(1)) + '\\n');
      return {
        error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        status: null, signal: 'SIGTERM', stdout: '', stderr: '',
      };
    };
    syncBuiltinESMExports();
  `);
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
      import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
      import { appendFileSync as appendLog } from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const args = process.argv.slice(2);
      const counter = (name) => {
        const file = path.join(process.cwd(), name + '.count');
        const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
        writeFileSync(file, String(count + 1));
        return count;
      };
      if (args[0] === 'auth' && args[1] === 'list') {
        process.stdout.write(process.env.DEPLOY_TEST_AUTH_LIST || 'No profiles found.');
        process.exit(0);
      }
      if (args[0] === 'containers' && args[1] === 'list') {
        const mode = process.env.DEPLOY_TEST_CONTAINERS_ACCESS || 'ok';
        if (mode === 'scope') {
          process.stderr.write("✘ You don't have 'containers:write' in your list of scopes\\n");
          process.stdout.write('┌─┬─┐\\n│ Scope │ Description │\\n│ account:read │ read │\\n│ user:read │ read │\\n│ workers:write │ w │\\n│ d1:write │ w │\\n│ offline_access │ refresh │\\n');
          process.stderr.write("✘ You need 'containers:write', try logging in again or creating an appropiate API token\\n");
          process.exit(1);
        }
        if (mode === 'denied') {
          process.stderr.write('Authentication error [code: 10000]');
          process.exit(1);
        }
        const sequence = JSON.parse(process.env.DEPLOY_TEST_CONTAINER_APPS_SEQUENCE || '[[{"name":"chickpea-sandbox","state":"active"}]]');
        process.stdout.write(JSON.stringify(sequence[Math.min(counter('containers-list'), sequence.length - 1)]));
        process.exit(0);
      }
      if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'list') {
        appendLog(process.env.DEPLOY_TEST_LOG, 'r2-account:' + (process.env.CLOUDFLARE_ACCOUNT_ID || '') + '\\n');
        if (process.env.DEPLOY_TEST_R2_ACCESS === 'disabled') {
          process.stderr.write('✘ [ERROR] A request to the Cloudflare API (/accounts/' + 'a'.repeat(32) + '/r2/buckets) failed.\\n\\n  Please enable R2 through the Cloudflare Dashboard. [code: 10042]\\n');
          process.exit(1);
        }
        process.stdout.write('Listing buckets...\\n');
        process.exit(0);
      }
      if (args[0] === 'containers' && args[1] === 'build') {
        if (counter('containers-build') < Number(process.env.DEPLOY_TEST_CONTAINER_BUILD_FAILS || 0)) {
          process.stderr.write('ERROR: failed to solve: DeadlineExceeded: context deadline exceeded\\n');
          process.exit(1);
        }
        const tag = args[args.indexOf('--tag') + 1];
        process.stdout.write('Image does not exist remotely, pushing: registry.cloudflare.com/' + 'a'.repeat(32) + '/' + tag + '\\n');
        process.exit(0);
      }
      if (args[0] === 'deploy') {
        const built = path.join(process.cwd(), 'dist-cf', 'chickpea', 'wrangler.json');
        const image = existsSync(built) ? JSON.parse(readFileSync(built, 'utf8')).containers?.[0]?.image : undefined;
        if (image && !image.startsWith('/')) appendLog(process.env.DEPLOY_TEST_LOG, 'deploy-image:' + image + '\\n');
        if (image && !image.startsWith('/')) {
          const buckets = JSON.parse(readFileSync(built, 'utf8')).r2_buckets ?? [];
          appendLog(process.env.DEPLOY_TEST_LOG, 'deploy-r2:' + JSON.stringify(buckets.map((entry) => entry.binding)) + '\\n');
        }
        if (process.env.DEPLOY_TEST_DEPLOY_UPLOADED === '1') process.stdout.write('Uploaded chickpea (1.00 sec)\\n');
        // Wrangler provisions new bindings after the asset upload and before
        // the script upload; this is the 2026-09-23 R2 failure shape.
        if (process.env.DEPLOY_TEST_DEPLOY_R2_DISABLED === '1') {
          process.stdout.write('Uploaded 1 of 3 assets\\nUploaded 3 of 3 assets\\n✨ Success! Uploaded 3 files (0.91 sec)\\n');
          process.stderr.write('✘ [ERROR] A request to the Cloudflare API (/accounts/' + 'a'.repeat(32) + '/r2/buckets) failed.\\n\\n  Please enable R2 through the Cloudflare Dashboard. [code: 10042]\\n');
          process.exit(1);
        }
      }
      if (args[0] === 'secret' && args[1] === 'list') {
        if (process.env.DEPLOY_TEST_SECRET_LIST_NOT_FOUND === '1' ||
            (!Object.hasOwn(process.env, 'DEPLOY_TEST_SECRET_LIST') &&
             process.env.DEPLOY_TEST_WORKER_EXISTS !== '1' &&
             process.env.DEPLOY_TEST_SECRET_LIST_DENIED !== '1')) {
          process.stderr.write('Worker "chickpea" not found.');
          process.exit(1);
        }
        if (process.env.DEPLOY_TEST_SECRET_LIST_DENIED === '1') {
          process.stderr.write('Authentication error [code: 10000]');
          process.exit(1);
        }
        const eventPath = path.join(process.cwd(), 'deployment.json');
        if (process.env.DEPLOY_TEST_EMPTY_SECRET_LIST_AFTER_UPLOAD === '1' && existsSync(eventPath) &&
            JSON.parse(readFileSync(eventPath, 'utf8')).stage === 'uploaded') {
          process.stdout.write('[]');
          process.exit(0);
        }
        process.stdout.write(process.env.DEPLOY_TEST_SECRET_LIST || '[]');
        process.exit(0);
      }
      if (args[0] === 'deployments' && args[1] === 'status' && args.includes('--json')) {
        let statusPayload = process.env.DEPLOY_TEST_DEPLOYMENT_STATUS;
        if (process.env.DEPLOY_TEST_DEPLOYMENT_STATUS_SEQUENCE) {
          const sequence = JSON.parse(process.env.DEPLOY_TEST_DEPLOYMENT_STATUS_SEQUENCE);
          const counterPath = process.env.DEPLOY_TEST_DEPLOYMENT_STATUS_COUNTER;
          const count = counterPath && existsSync(counterPath)
            ? Number(readFileSync(counterPath, 'utf8'))
            : 0;
          statusPayload = JSON.stringify(sequence[Math.min(count, sequence.length - 1)]);
          if (counterPath) writeFileSync(counterPath, String(count + 1));
        }
        process.stdout.write(statusPayload || JSON.stringify({
          versions: [{ version_id: 'deployed-version', percentage: 100 }],
        }));
        process.exit(0);
      }
      if (args[0] === 'versions' && args[1] === 'view' && args.includes('--json')) {
        const views = process.env.DEPLOY_TEST_VERSION_VIEWS
          ? JSON.parse(process.env.DEPLOY_TEST_VERSION_VIEWS)
          : {};
        process.stdout.write(JSON.stringify(views[args[2]] || {
          resources: { bindings: [
            {
              name: 'AUTH_DB',
              type: 'd1',
              id: process.env.DEPLOY_TEST_DEPLOYED_AUTH_DB_ID || 'test-database-id',
              database_id: process.env.DEPLOY_TEST_DEPLOYED_AUTH_DB_ID || 'test-database-id',
            },
            ...(process.env.CHICKPEA_DEPLOY_TARGET ? [
              { name: 'CHICKPEA_SETUP_CAPABILITY_DIGEST', type: 'plain_text', text: 'P'.repeat(43) },
              { name: 'CHICKPEA_SETUP_CAPABILITY_ISSUED_AT', type: 'plain_text', text: '1788289200000' },
            ] : []),
          ] },
        }));
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
      if (args[0] === 'd1' && args[1] === 'execute' && args.includes('--json')) {
        if (process.env.DEPLOY_TEST_AUTH_SCHEMA_INSPECTION_FAIL === '1') {
          process.stderr.write('schema inspection denied');
          process.exit(1);
        }
        if (process.env.DEPLOY_TEST_AUTH_SCHEMA) {
          process.stdout.write(process.env.DEPLOY_TEST_AUTH_SCHEMA);
          process.exit(0);
        }
        const configPath = args[args.indexOf('--config') + 1];
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const authDb = config.d1_databases.find((entry) => entry.binding === 'AUTH_DB');
        const database = new DatabaseSync(':memory:');
        const migrationDirectory = path.resolve(path.dirname(configPath), authDb.migrations_dir);
        for (const migrationName of readdirSync(migrationDirectory)
          .filter((name) => name.endsWith('.sql')).sort()) {
          database.exec(readFileSync(path.join(migrationDirectory, migrationName), 'utf8'));
        }
        const query = args[args.indexOf('--command') + 1];
        const results = database.prepare(query).all();
        database.close();
        process.stdout.write(JSON.stringify([{ results, success: true }]));
        process.exit(0);
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
      if (args[0] === 'versions' && args[1] === 'upload') process.stdout.write('Worker Version ID: new-upgrade-version\\n');
      if (args[0] === 'deploy') process.stdout.write('Current Version ID: deployed-version\\n');
      if (args[0] === 'versions' && args[1] === 'deploy' && process.env.DEPLOY_TEST_ACTIVATION_FAIL === '1') process.exit(1);
      if (args[0] === 'deploy' && process.env.DEPLOY_TEST_DEPLOY_STATUS) {
        process.exit(Number(process.env.DEPLOY_TEST_DEPLOY_STATUS));
      }
    `,
  );
  writeFileSync(path.join(root, 'Dockerfile'), 'FROM docker.io/cloudflare/sandbox:0.12.4\nEXPOSE 3000\n');
  const dockerStub = path.join(root, 'fake-docker.mjs');
  writeFileSync(dockerStub, `#!${process.execPath}
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    appendFileSync(process.env.DEPLOY_TEST_LOG, 'docker:' + JSON.stringify(args) + '\\n');
    if (args[0] === 'info') process.exit(process.env.DEPLOY_TEST_DOCKER_DOWN === '1' ? 1 : 0);
    if (args[0] === 'pull') {
      const file = path.join(path.dirname(process.env.DEPLOY_TEST_LOG), 'docker-pull.count');
      const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
      writeFileSync(file, String(count + 1));
      process.exit(count < Number(process.env.DEPLOY_TEST_DOCKER_PULL_FAILS || 0) ? 1 : 0);
    }
  `, { mode: 0o755 });
  writeFileSync(
    path.join(root, 'slack-app-manifest.json'),
    JSON.stringify({ features: { agent_view: { agent_description: 'Test agent' } } }),
  );

  const harness = {
    root,
    dockerStub,
    logPath,
    secretCapturePath,
    npmStub,
    timeoutStub,
    script: path.join(scriptsDir, 'deploy-with-epilogue.mjs'),
  };
  writeCutoverArtifact(harness);
  return harness;
}

export function runHarness(
  harness: ReturnType<typeof createHarness>,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  timeout?: number,
) {
  const env = { ...process.env };
  Object.assign(env, envOverrides);
  const nodeArgs = env.DEPLOY_TEST_TIMEOUT_INSPECTION
    ? ['--import', harness.timeoutStub, harness.script, ...args]
    : [harness.script, ...args];
  return spawnSync(process.execPath, nodeArgs, {
    cwd: harness.root,
    encoding: 'utf8',
    timeout,
    env: {
      ...env,
      DEPLOY_TEST_LOG: harness.logPath,
      DEPLOY_TEST_SECRET_CAPTURE: harness.secretCapturePath,
      DEPLOY_TEST_DEPLOYMENT_STATUS_COUNTER:
        env.DEPLOY_TEST_DEPLOYMENT_STATUS_COUNTER ?? path.join(harness.root, 'deployment-status-count'),
      DEPLOY_TEST_READINESS_BASE_URL:
        env.DEPLOY_TEST_READINESS_BASE_URL ?? 'https://chickpea.test',
      DEPLOY_TEST_READINESS_STATUSES: env.DEPLOY_TEST_READINESS_STATUSES ?? '204',
      // The harness is a self-hoster machine unless a test says otherwise:
      // no claimed-lane registry, so an unnamed deploy is the ordinary one.
      CHICKPEA_ENVIRONMENT_ROOT:
        env.CHICKPEA_ENVIRONMENT_ROOT ?? path.join(harness.root, 'no-lane-registry'),
      // Never read the operator's real lane secrets file from a test.
      CHICKPEA_LANE_SECRETS: env.CHICKPEA_LANE_SECRETS ?? 'off',
      CHICKPEA_LANE_CREDENTIALS_DIR:
        env.CHICKPEA_LANE_CREDENTIALS_DIR ?? path.join(harness.root, 'lane-credentials'),
      npm_execpath: harness.npmStub,
    },
  });
}

export function prepareUpgrade(harness: ReturnType<typeof createHarness>) {
  const configPath = path.join(harness.root, 'dist-cf/chickpea/wrangler.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.vars.CHICKPEA_APP_VERSION = '0.1.1';
  config.vars.CHICKPEA_SOURCE_COMMIT = 'b'.repeat(40);
  writeFileSync(configPath, JSON.stringify(config));
  const secretNames = ['CHICKPEA_AUTH_SECRET', 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID', 'CHICKPEA_CREDENTIAL_KEY_KEY_V1'];
  const bindings = [
    ...secretNames.map((name) => ({ name, type: 'secret_text' })),
    { name: 'AUTH_DB', type: 'd1', id: 'test-database-id' },
    ...config.durable_objects.bindings.map((binding: any) => ({ ...binding, type: 'durable_object_namespace', namespace_id: `ns-${binding.name}` })),
    { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
    ...Object.entries({ CHICKPEA_APP_VERSION: '0.1.0', CHICKPEA_SOURCE_COMMIT: 'a'.repeat(40), CHICKPEA_SETUP_CAPABILITY_DIGEST: 'P'.repeat(43), CHICKPEA_SETUP_CAPABILITY_ISSUED_AT: '1788289200000', DO_NOT_TRACK: '1', SLACK_TAG_LEDGER_CANARY_CHANNELS: '' }).map(([name, text]) => ({ name, text, type: 'plain_text' })),
  ];
  const installation = validateInstallation({ exists: true, secretNames, bindings, versions: [{ version_id: 'deployed-version', percentage: 100 }], fingerprint: 'deployed-version:100' });
  const contextPath = path.join(harness.root, 'upgrade-context.json');
  writePrivateJson(contextPath, { schema: 1, target: { account: 'a'.repeat(32), worker: 'chickpea', profile: 'core', url: 'https://chickpea.test' }, installation, source: { version: '0.1.1', commit: 'b'.repeat(40) } });
  return {
    CHICKPEA_UPGRADE_CONTEXT: contextPath, CHICKPEA_DEPLOY_TARGET: 'production', CHICKPEA_DEPLOY_PROFILE: 'core',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), WRANGLER_CI_OVERRIDE_NAME: 'chickpea',
    DEPLOY_TEST_SECRET_LIST: JSON.stringify(secretNames.map((name) => ({ name }))),
    DEPLOY_TEST_VERSION_VIEWS: JSON.stringify({ 'deployed-version': { resources: { bindings } } }),
  };
}

export function commands(logPath: string): string[] {
  return readFileSync(logPath, 'utf8').trim().split('\n');
}

export function writeCutoverArtifact(
  harness: ReturnType<typeof createHarness>,
  options: {
    cron?: boolean;
    routineAgents?: boolean;
    selector?: string;
    completeCanary?: boolean;
    missingBinding?: string;
    deletedClasses?: string[];
    compatibilityDate?: string;
    publicGlobalFetch?: boolean;
    tracing?: boolean;
    cloudflareTracer?: boolean;
    sandboxCommandRedaction?: boolean;
    agentViewArtifact?: boolean;
    versionMetadata?: boolean;
    databaseId?: string;
    profile?: 'core' | 'sandbox';
    workerName?: string;
    target?: 'amber' | 'cobalt' | 'violet';
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
  const target = options.target;
  const config = {
    name: options.workerName ?? (target ? `chickpea-${target}-live` : 'chickpea'),
    main: 'index.js',
    compatibility_date: options.compatibilityDate ?? '2026-06-01',
    compatibility_flags: options.publicGlobalFetch === false
      ? ['nodejs_compat']
      : ['nodejs_compat', 'global_fetch_strictly_public'],
    observability: { enabled: true, traces: { enabled: options.tracing ?? true } },
    ...(options.versionMetadata === false
      ? {}
      : { version_metadata: { binding: 'CF_VERSION_METADATA' } }),
    vars: {
      SLACK_TAG_LEDGER_CANARY_CHANNELS: options.selector ?? '',
      ...(target ? {
        CHICKPEA_DEPLOY_TARGET: target,
        CHICKPEA_TELEMETRY_ENVIRONMENT: 'test',
        CHICKPEA_AUTH_DB_SCHEMA_GENERATION: '0002_mcp_oauth',
        CHICKPEA_DURABLE_OBJECT_SCHEMA_GENERATION: 'v9',
        CHICKPEA_DEPLOY_SCHEMA_GENERATION: 'd1:0002_mcp_oauth;do:v9',
        CHICKPEA_DEPLOY_STATE_MODE: options.databaseId ? 'permanent' : 'disposable',
      } : {}),
    },
    triggers: { crons: options.cron === false ? [] : ['* * * * *'] },
    durable_objects: { bindings: [
      { name: 'TAG_STATE', class_name: 'TagStateStore' },
      ...(profile === 'sandbox' ? [sandboxBinding] : []),
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
      database_name: target ? `chickpea-auth-db-${target}-live` : 'chickpea-auth-db',
      database_id: options.databaseId ?? 'test-database-id',
      migrations_dir: '../../migrations/better-auth',
    }],
    workflows: [],
    ...(profile === 'sandbox'
      ? { containers: [sandboxContainer], r2_buckets: [{ binding: 'BACKUP_BUCKET' }] }
      : {}),
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
      { tag: 'v8', deleted_classes: ['AuthGuard'] },
      { tag: 'v9', new_sqlite_classes: ['SlackGatewaySession'] },
    ],
  };
  writeFileSync(path.join(builtDir, 'wrangler.json'), JSON.stringify(config));
  const rootConfig = structuredClone(config);
  if (target) {
    rootConfig.name = 'chickpea';
    rootConfig.d1_databases[0]!.database_name = 'chickpea-auth-db';
    rootConfig.d1_databases[0]!.database_id = '';
    delete rootConfig.vars.CHICKPEA_DEPLOY_TARGET;
    delete rootConfig.vars.CHICKPEA_AUTH_DB_SCHEMA_GENERATION;
    delete rootConfig.vars.CHICKPEA_DURABLE_OBJECT_SCHEMA_GENERATION;
    delete rootConfig.vars.CHICKPEA_DEPLOY_SCHEMA_GENERATION;
    delete rootConfig.vars.CHICKPEA_DEPLOY_STATE_MODE;
    delete rootConfig.vars.CHICKPEA_TELEMETRY_ENVIRONMENT;
  }
  writeFileSync(path.join(harness.root, 'wrangler.jsonc'), JSON.stringify(rootConfig));
  const canarySeams = options.completeCanary === false
    ? 'SLACK_TAG_LEDGER_CANARY_CHANNELS'
    : 'SLACK_TAG_LEDGER_CANARY_CHANNELS delivery_receipt_persist_unknown slack_agent_bindings';
  writeFileSync(
    path.join(builtDir, 'index.js'),
    `compose({heartbeat:a,maintenance:b}); async function a(){await scheduler.heartbeat();} async function b(){await state.maintainWork();}\n` +
      `// chickpea.response-metadata chickpea-slack-v2 ` +
      `${options.cloudflareTracer === false ? '' : '@flue/runtime/cloudflare-tracing '} ` +
      `${options.sandboxCommandRedaction === false ? '' : 'FLUE_PRIVATE_SANDBOX_COMMAND_V1 '} ` +
      `${options.routineAgents === false ? '' : 'chickpea-routine-intent-v2 chickpea-routine-execution-v2 '} ` +
      `${options.agentViewArtifact === false ? '' : 'agent_view agent_description '} ` +
      canarySeams,
  );
}

export function writeRoutineArtifact(
  harness: ReturnType<typeof createHarness>,
  options: { cron?: boolean; routineAgents?: boolean } = {},
) {
  writeCutoverArtifact(harness, options);
}

export function writeCanaryArtifact(
  harness: ReturnType<typeof createHarness>,
  options: { selector?: string; complete?: boolean } = {},
) {
  writeCutoverArtifact(harness, {
    selector: options.selector ?? 'T_ACME/C_AGENT_TEST',
    ...(options.complete === undefined ? {} : { completeCanary: options.complete }),
  });
}

export function sandboxHarness(context: { after(fn: () => void): void }) {
  const harness = createHarness();
  context.after(() => rmSync(harness.root, { recursive: true, force: true }));
  writeCutoverArtifact(harness, { profile: 'sandbox' });
  return harness;
}

export function sandboxEnv(harness: ReturnType<typeof createHarness>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CHICKPEA_DEPLOY_PROFILE: 'sandbox',
    WRANGLER_DOCKER_BIN: harness.dockerStub,
    DEPLOY_TEST_SANDBOX_RETRY_MS: '1',
    DEPLOY_TEST_URL: 'https://chickpea.example.workers.dev',
    CLOUDFLARE_API_TOKEN: '',
    CF_API_TOKEN: '',
    ...extra,
  };
}
