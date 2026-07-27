#!/usr/bin/env node
/**
 * Proves the runtime seams Chickpea's routine scheduler depends on against a
 * real locally-hosted workerd. The fixture is deliberately isolated from the
 * product app so a Flue or Wrangler upgrade can fail this gate before routine
 * state is admitted in production.
 *
 * No credentials and no external traffic are used. The fixture never prompts
 * a model; its AI binding exists only because Flue's generated workflow
 * runtime expects the normal Cloudflare shape.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  assertNodeVersion,
  delay,
  getFreePort,
} from './lib/offline-harness.mjs';

const FIXTURE_ROOT = join(REPO_ROOT, 'scripts', 'fixtures', 'routines-runtime-spike');
const FLUE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'flue');
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
const INTERNAL_TOKEN = 'routine-spike-internal-token';
const INTERNAL_HEADERS = { 'x-routine-spike-token': INTERNAL_TOKEN };

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  [ok] ${message}`);
}

function buildFixture(outputDir) {
  const result = spawnSync(
    FLUE_BIN,
    ['build', '--target', 'cloudflare', '--root', FIXTURE_ROOT, '--output', outputDir],
    { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `routine runtime fixture build failed (exit ${result.status ?? 'unknown'}):\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
}

function inspectBuild(outputDir) {
  const builtRoot = join(outputDir, 'chickpea_routines_runtime_spike');
  const configPath = join(builtRoot, 'wrangler.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const bundle = readFileSync(join(builtRoot, 'index.js'), 'utf8');
  const bindings = config.durable_objects?.bindings ?? [];

  check(config.triggers?.crons?.includes('* * * * *'), 'generated config preserves the heartbeat cron');
  check(
    bindings.some(
      (binding) =>
        binding.name === 'FLUE_ROUTINE_SPIKE_WORKFLOW' &&
        binding.class_name === 'FlueRoutineSpikeWorkflow',
    ),
    'generated config includes the workflow Durable Object',
  );
  check(
    bindings.some(
      (binding) =>
        binding.name === 'ROUTINE_STATE_SPIKE' && binding.class_name === 'RoutineStateSpike',
    ),
    'generated config preserves the product-state Durable Object',
  );
  check(
    (config.migrations ?? []).some(
      (migration) =>
        migration.tag === 'v1' &&
        migration.new_sqlite_classes?.includes('FlueRoutineSpikeWorkflow') &&
        migration.new_sqlite_classes?.includes('RoutineStateSpike'),
    ),
    'generated config preserves the workflow migration',
  );
  check(
    bundle.includes('ROUTINE_SPIKE_RECEIPT') && bundle.includes('async scheduled(controller)'),
    'generated Worker composes the authored scheduled handler',
  );

  return configPath;
}

function startWrangler(configPath, persistDir, port) {
  const child = spawn(
    WRANGLER_BIN,
    [
      'dev',
      '--config',
      configPath,
      '--port',
      String(port),
      '--local',
      '--persist-to',
      persistDir,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Wrangler starts workerd grandchildren. Give this disposable harness a
      // process group so cleanup cannot orphan either Wrangler or workerd and
      // keep this Node process alive through inherited output pipes.
      detached: process.platform !== 'win32',
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { child, getOutput: () => output };
}

async function stopWrangler(handle) {
  const child = handle.child;
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
  await Promise.race([exited, delay(3_000)]);
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group exited */ }
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitForReady(handle, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler exited before readiness:\n${handle.getOutput()}`);
    }
    if (handle.getOutput().includes('Ready on http://')) return;
    await delay(100);
  }
  throw new Error(`wrangler did not become ready:\n${handle.getOutput()}`);
}

async function readJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function trigger(baseUrl) {
  const response = await fetch(`${baseUrl}/cdn-cgi/handler/scheduled`);
  check(response.status === 200 && (await response.text()) === 'ok', 'workerd accepts a scheduled tick');
}

async function waitForRuns(baseUrl, minimum, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await readJson(`${baseUrl}/spike/runs`, { headers: INTERNAL_HEADERS });
    if (response.status === 200 && response.body.runs?.length >= minimum) return response.body.runs;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${minimum} routine-spike runs`);
}

async function verifyRuntime(baseUrl, handle) {
  const hiddenList = await fetch(`${baseUrl}/spike/runs`);
  check(hiddenList.status === 404, 'internal run inspection fails closed without its token');

  const state = await readJson(`${baseUrl}/spike/state`, {
    method: 'POST',
    headers: { ...INTERNAL_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ suffix: 'parity', at: Date.now() }),
  });
  const statePassed =
    state.status === 200 &&
    state.body.routineId === 'routine_workerd_parity' &&
    state.body.version === 1 &&
    state.body.revisionCount === 1 &&
    state.body.auditCount === 1;
  if (!statePassed) {
    throw new Error(`DO state parity failed (${state.status}): ${JSON.stringify(state.body)}`);
  }
  check(true, 'production RoutineStoreLogic preserves definition, revision, and audit atomicity on DO SQLite');

  await trigger(baseUrl);
  const firstRuns = await waitForRuns(baseUrl, 1);
  const firstRunId = firstRuns[0]?.runId;
  check(typeof firstRunId === 'string' && firstRunId.startsWith('run_'), 'invoke returns a Flue runId');

  const first = await readJson(`${baseUrl}/spike/runs/${firstRunId}`, {
    headers: INTERNAL_HEADERS,
  });
  check(first.status === 200 && first.body.status === 'completed', 'getRun exposes terminal workflow state');
  check(
    first.body.input?.occurrenceId === first.body.result?.occurrenceId,
    'the Workflow receives the exact admitted occurrence input',
  );
  check(
    first.body.result?.initializerRunId === firstRunId,
    'the Agent initializer recovers the current workflow run by runId',
  );

  await trigger(baseUrl);
  const secondRuns = await waitForRuns(baseUrl, 2);
  check(
    new Set(secondRuns.map((run) => run.runId)).size === 2,
    'each scheduled tick creates an independent Workflow run',
  );

  const workflowRoute = await fetch(`${baseUrl}/workflows/routine-spike`, { method: 'POST' });
  const runRoute = await fetch(`${baseUrl}/runs/${firstRunId}?meta`);
  const agentRoute = await fetch(`${baseUrl}/agents/routine-spike-executor/${firstRunId}`);
  check(workflowRoute.status === 404, 'the generated workflow admission route stays closed');
  check(runRoute.status === 404, 'the generated run-inspection route stays closed');
  check(agentRoute.status === 404, 'the private Workflow Agent route stays closed');

  const receipts = [...handle.getOutput().matchAll(/ROUTINE_SPIKE_RECEIPT\s+([^\r\n]+)/g)].map(
    (match) => JSON.parse(match[1]),
  );
  check(receipts.length >= 2, 'the scheduler records a receipt for every admission');
  check(
    receipts.every(
      (receipt) =>
        receipt.listed === true &&
        receipt.recordVisible === true &&
        Number.isFinite(receipt.visibilityMs) &&
        receipt.visibilityMs <= 5_000,
    ),
    'listRuns/getRun reconcile every admission within the bounded visibility window',
  );
  console.log(`  [info] observed run visibility: ${receipts.map((r) => `${r.visibilityMs}ms`).join(', ')}`);
}

async function main() {
  console.log(`routine runtime spike (${assertNodeVersion()})`);
  const tempRoot = mkdtempSync(join(tmpdir(), 'chickpea-routines-spike-'));
  let handle;
  try {
    const outputDir = join(tempRoot, 'build');
    buildFixture(outputDir);
    const configPath = inspectBuild(outputDir);
    const port = await getFreePort();
    handle = startWrangler(configPath, join(tempRoot, 'state'), port);
    await waitForReady(handle);
    try {
      await verifyRuntime(`http://127.0.0.1:${port}`, handle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\nwrangler output:\n${handle.getOutput()}`);
    }
  } finally {
    if (handle) await stopWrangler(handle);
    rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log('routine runtime spike passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
