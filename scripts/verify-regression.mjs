#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegressionPlan, REGRESSION_AREAS } from './lib/regression-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseRegressionArgs(argv) {
  const options = { mode: 'changed', areas: [], planOnly: false, base: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan') { options.planOnly = true; continue; }
    if (!['--mode', '--area', '--base'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
    if (arg === '--mode') options.mode = value;
    if (arg === '--area') options.areas.push(value);
    if (arg === '--base') options.base = value;
  }
  return options;
}

export function regressionEnvironment(env = process.env) {
  const clean = { ...env };
  // Do not let a QA deploy/local lane's selectors stamp offline build artifacts.
  for (const key of Object.keys(clean)) {
    if (/^(?:CHICKPEA_DEPLOY_|CHICKPEA_LOCAL_|CHICKPEA_ENV_|WRANGLER_CI_|WORKERS_CI|CLOUDFLARE_ENV$)/.test(key)) delete clean[key];
  }
  return {
    ...clean, DO_NOT_TRACK: '1', TAG_REQUIRE_LOOPBACK: '1',
    TAG_DB_PATH: ':memory:', SLACK_STATE_DB_PATH: ':memory:', CHICKPEA_AUTH_DB_PATH: ':memory:',
  };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed; supply a valid --base or explicit --area`);
  return result.stdout.trimEnd();
}

function changedFiles(base) {
  // Branch changes plus staged, unstaged, and untracked source. A passed base
  // is resolved to a commit first, never interpreted as a shell command.
  let revision;
  if (base) revision = git(['rev-parse', '--verify', `${base}^{commit}`]);
  else {
    const reference = spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' });
    if (reference.status !== 0) throw new Error('No origin/main comparison available; supply --base or --area');
    revision = reference.stdout.trim();
  }
  return [...new Set([
    ...git(['diff', '--name-only', '-z', '--no-renames', revision, '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
}

export function runRegressionSteps(steps, run) {
  const results = [];
  for (const step of steps) {
    const started = Date.now();
    const status = run(step);
    results.push({ ...step, status, durationMs: Date.now() - started });
    if (status !== 0) break; // Preserve the first failure; never rerun to green.
  }
  return results;
}

export function main(argv) {
  try {
    if (argv.includes('--help')) {
      console.log(`Usage: npm run verify:regression -- [--mode changed|regression|release] [--area NAME] [--base REF] [--plan]\nAreas: ${Object.keys(REGRESSION_AREAS).join(', ')}\n--area may repeat and selects explicit scope; otherwise changed mode includes branch and uncommitted changes.`);
      return 0;
    }
    const options = parseRegressionArgs(argv);
    const files = options.mode === 'changed' && (options.areas.length === 0 || options.base)
      ? changedFiles(options.base) : [];
    const testFiles = readdirSync(path.join(ROOT, 'tests'), { recursive: true })
      .map(String).filter((file) => file.endsWith('.test.ts'))
      .map((file) => `tests/${file.replaceAll('\\', '/')}`);
    const plan = createRegressionPlan({ ...options, files, testFiles });
    console.log(JSON.stringify(plan, null, 2));
    if (options.planOnly) return 0;
    if (options.mode === 'release' && git(['status', '--porcelain']).length > 0) {
      throw new Error('Release checks require clean committed source; verify:oss-export archives HEAD. Use changed or regression for working changes.');
    }
    if (plan.steps.length && !existsSync(path.join(ROOT, 'node_modules', 'tsx'))) throw new Error('Run npm ci first with the repository Node version.');
    const scratch = mkdtempSync(path.join(tmpdir(), 'chickpea-regression-'));
    const env = {
      ...regressionEnvironment(),
      npm_config_cache: path.join(scratch, 'npm-cache'),
      WRANGLER_LOG_PATH: path.join(scratch, 'wrangler.log'),
    };
    if (plan.steps.length) {
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import {createServer} from 'node:net'; const server=createServer(); server.on('error',()=>process.exit(2)); server.listen(0,'127.0.0.1',()=>server.close());",
      ], { cwd: ROOT, env, timeout: 5_000, stdio: 'ignore' });
      if (probe.status !== 0) throw new Error('LOOPBACK_UNAVAILABLE: these checks need local test servers. Run in an execution environment that permits loopback; do not disable or skip the checks.');
    }
    const results = runRegressionSteps(plan.steps, (step) => {
      const args = step.kind === 'npm'
        ? [process.env.npm_execpath, 'run', step.script]
        : step.kind === 'tests'
          ? ['--test', '--import', 'tsx', ...step.files]
          : [step.file];
      // npm supplies its executable path on every platform. Direct node users
      // can use PATH without enabling a shell for any user input.
      const directNpm = step.kind === 'npm' && !process.env.npm_execpath;
      const result = spawnSync(directNpm ? 'npm' : process.execPath,
        directNpm ? ['run', step.script] : args,
        { cwd: ROOT, env, stdio: 'inherit' });
      return result.status ?? 1;
    });
    const passed = results.length === plan.steps.length && results.every(({ status }) => status === 0);
    console.log(JSON.stringify({ result: plan.steps.length === 0 ? 'no_runtime_changes' : passed ? 'pass' : 'fail', results, coverage: plan.coverage }, null, 2));
    return passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
