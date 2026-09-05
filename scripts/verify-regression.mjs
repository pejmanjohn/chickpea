#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegressionPlan, REGRESSION_AREAS } from './lib/regression-plan.mjs';
import { digest, sourceInputs } from './lib/verification-inputs.mjs';
import { evidenceRefs, offlineEvent, readRun, reusableOffline, updateRun } from './lib/verification-record.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseRegressionArgs(argv) {
  const options = { mode: 'changed', areas: [], planOnly: false, base: undefined, record: undefined, reuse: false, timeoutMs: 1_200_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan') { options.planOnly = true; continue; }
    if (arg === '--reuse') { options.reuse = true; continue; }
    if (!['--mode', '--area', '--base', '--record', '--timeout-ms'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
    if (arg === '--mode') options.mode = value;
    if (arg === '--area') options.areas.push(value);
    if (arg === '--base') options.base = value;
    if (arg === '--record') options.record = value;
    if (arg === '--timeout-ms') options.timeoutMs = Number(value);
  }
  if (options.reuse && (!options.record || options.mode === 'release')) throw new Error('--reuse needs --record and is unavailable at the full release checkpoint.');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 3_600_000) throw new Error('--timeout-ms must be 1000..3600000.');
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
      console.log(`Usage: npm run verify:regression -- [--mode changed|regression|release] [--area NAME] [--base REF] [--plan] [--record PRIVATE_RUN] [--reuse] [--timeout-ms MS]\nAreas: ${Object.keys(REGRESSION_AREAS).join(', ')}\n--area may repeat and selects explicit scope; otherwise changed mode includes branch and uncommitted changes.\n--record saves private logs, durations, failures and final release receipts. --reuse accepts only unchanged successful inputs and retained logs; build always runs. Release never reuses steps.`);
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
    if (options.record) {
      const run = readRun(options.record); // Validate before executing any checks.
      if (run.events.some((event) => event.type === 'offline_begin' && !run.events.some((end) => end.type === 'offline_finish' && end.attemptId === event.id))) {
        throw new Error('An offline attempt is still open. Inspect the owning process and log; record offline_interrupted only after its processes have stopped.');
      }
    }
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
    const input = options.record ? sourceInputs(ROOT) : undefined;
    // Include all effective environment values only as a digest; never store secrets.
    // Temporary scratch paths are intentionally excluded from the input identity.
    const fingerprint = options.record ? digest({ source: input.tree, node: process.version,
      config: regressionEnvironment(), inventory: plan.steps, timeoutMs: options.timeoutMs }) : undefined;
    const record = (value) => updateRun(options.record, (run) => offlineEvent(run, value));
    const receiptPlan = options.record ? record({ type: 'offline_plan', source: input, node: process.version, mode: options.mode, steps: plan.steps, fingerprint }) : undefined;
    const results = runRegressionSteps(plan.steps, (step) => {
      const label = step.kind === 'npm' ? `npm:${step.script}` : step.kind === 'node' ? step.file : `tests:${digest(step.files).slice(0, 12)}`;
      const reusable = options.reuse ? reusableOffline(readRun(options.record), label, fingerprint) : undefined;
      if (reusable) {
        record({ type: 'offline_reuse', planId: receiptPlan.id, label, fingerprint, reusedId: reusable.id, priorDurationMs: reusable.durationMs, evidence: reusable.evidence });
        console.log(`Reusing ${label}: receipt ${reusable.id}, original ${reusable.durationMs} ms.`);
        return 0;
      }
      const started = Date.now();
      const attempt = options.record ? record({ type: 'offline_begin', planId: receiptPlan.id, label, fingerprint, node: process.version, source: input, ownerPid: process.pid }) : undefined;
      const log = attempt ? path.join(path.dirname(path.resolve(options.record)), `${attempt.id}.log`) : undefined;
      const fd = log ? openSync(log, 'wx', 0o600) : undefined;
      console.log(`Running ${label}${log ? `; log ${log}` : ''}`);
      const args = step.kind === 'npm'
        ? [process.env.npm_execpath, 'run', step.script]
        : step.kind === 'tests'
          ? ['--test', '--import', 'tsx', ...step.files]
          : [step.file];
      // npm supplies its executable path on every platform. Direct node users
      // can use PATH without enabling a shell for any user input.
      const directNpm = step.kind === 'npm' && !process.env.npm_execpath;
      let result;
      try {
        result = spawnSync(directNpm ? 'npm' : process.execPath,
          directNpm ? ['run', step.script] : args,
          { cwd: ROOT, env, timeout: options.timeoutMs, killSignal: 'SIGKILL', stdio: fd === undefined ? 'inherit' : ['ignore', fd, fd] });
      } finally { if (fd !== undefined) closeSync(fd); }
      const stable = !options.record || sourceInputs(ROOT).tree === input.tree;
      const status = stable ? result.status ?? 1 : 1;
      if (attempt) record({ type: 'offline_finish', planId: receiptPlan.id, attemptId: attempt.id, label, fingerprint, node: process.version,
        result: status === 0 ? 'pass' : 'fail', exitCode: result.status, signal: result.signal,
        category: !stable ? 'inputs_changed' : result.error ? 'infrastructure' : status === 0 ? null : 'unknown',
        durationMs: Date.now() - started, evidence: evidenceRefs([log]) });
      return status;
    });
    const passed = results.length === plan.steps.length && results.every(({ status }) => status === 0)
      && (!options.record || sourceInputs(ROOT).tree === input.tree);
    if (receiptPlan) {
      record({ type: 'offline_summary', planId: receiptPlan.id, result: passed ? 'pass' : 'fail' });
      if (passed && options.mode === 'release') {
        const evidence = readRun(options.record).events.filter((event) => event.type === 'offline_finish' && event.planId === receiptPlan.id).flatMap((event) => event.evidence);
        record({ type: 'checkpoint', result: 'pass', source: input, node: process.version, planId: receiptPlan.id, fingerprint, evidence });
      }
    }
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
