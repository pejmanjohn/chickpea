import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error Executable helpers are JavaScript, shared with the verifiers.
import { reserveVerificationPort } from '../scripts/lib/verification-ports.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'store-fallback', 'store-fallback-worker.ts');

/**
 * Two platform facts store admission rests on, in real workerd at the
 * production compatibility date. A1: a Worker that calls a method a Durable
 * Object's code lacks gets a rejected promise, not a throw, and the object
 * runs nothing for it (withStoreFallback). A2: an object's method stops when
 * the Worker invocation that called it ends, unless the object holds it with
 * its own waitUntil, as TagStateStore.admitSlackDelivery does.
 */
test("a missing method rejects and runs nothing; a method outlives its caller only when its object holds it", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-store-fallback-'));
  const configPath = join(root, 'wrangler.json');
  const port = await reserveVerificationPort();
  const productionConfig = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const compatibilityDate = productionConfig.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-store-fallback',
    main: FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    durable_objects: { bindings: [
      { name: 'OLD_STORE', class_name: 'OldStore' },
      { name: 'NEW_STORE', class_name: 'NewStore' },
    ] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['OldStore', 'NewStore'] }],
  }, null, 2));

  let worker: WorkerHandle | undefined;
  try {
    worker = startWorker(configPath, port);
    await waitForWorker(worker, `http://127.0.0.1:${port}/`);
    const response = await fetch(`http://127.0.0.1:${port}/missing-method`);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const probe = JSON.parse(body) as {
      threw?: string;
      rejected?: { name: string; message: string };
      before: number;
      after: number;
      fallback: { value: string; fellBack?: string };
      afterFallback: number;
      answered: { value: string; fellBack?: string };
      ranOnNew: number;
    };
    assert.equal(probe.threw, undefined, 'the call returns a promise; it does not throw');
    assert.equal(probe.rejected?.name, 'TypeError');
    assert.match(probe.rejected?.message ?? '', /does not implement/, 'workerd names the missing method');
    assert.equal(probe.after, probe.before, 'the object ran nothing for the call');
    assert.deepEqual(probe.fallback, { value: 'old', fellBack: 'method_missing' }, 'the helper fell back, once');
    assert.equal(probe.afterFallback, probe.before + 1, 'only the fallback ran');
    assert.deepEqual(probe.answered, { value: 'new' }, 'a store that has the method answers, with no fallback');
    assert.equal(probe.ranOnNew, 1);

    // A2: the Worker that made the call ends before the store's method does.
    const abandoned = async (held: boolean) => {
      const token = `t${held ? 'held' : 'plain'}${Date.now()}`;
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/abandon?token=${token}${held ? '&held=1' : ''}`)).text(), 'left');
      const written = async () => ((await (await fetch(`http://127.0.0.1:${port}/written?token=${token}`)).json()) as { written: boolean }).written;
      assert.equal(await written(), false, 'the method was still waiting when its caller ended');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return written();
    };
    assert.equal(await abandoned(false), false, 'a method its object does not hold stops with its caller');
    assert.equal(await abandoned(true), true, "a method held by its object's waitUntil runs to its end");
  } finally {
    if (worker) await stopWorker(worker);
    rmSync(root, { recursive: true, force: true });
  }
});

interface WorkerHandle { child: ChildProcess; output(): string }

function startWorker(configPath: string, port: number): WorkerHandle {
  const child = spawn(WRANGLER, ['dev', '--config', configPath, '--port', String(port), '--inspector-port', '0'], {
    cwd: ROOT,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  return { child, output: () => output };
}

async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { handle.child.kill('SIGKILL'); resolve(); }, 5_000);
    handle.child.once('exit', () => { clearTimeout(timeout); resolve(); });
    handle.child.kill('SIGTERM');
  });
}

async function waitForWorker(handle: WorkerHandle, origin: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wrangler dev did not become ready:\n${handle.output()}`);
}
