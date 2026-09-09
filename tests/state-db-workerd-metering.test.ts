import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { meterMaintenance } from './fixtures/state-db/maintenance-meter.ts';
import { stateSchemaFingerprint } from '../src/state/schema-lifecycle.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'state-db', 'metering-worker.ts');

interface Measurement { label: string; rowsRead: number; rowsWritten: number; rows: number }
interface Probe {
  results: Measurement[];
  nested: { innerError: string; rows: number[] };
  bootstrap: {
    installError: string;
    installedTableExists: boolean;
    markerInstalled: boolean;
    markerTableRows: number;
    priorValue: string;
  };
  maintenance: ReturnType<typeof meterMaintenance>;
  localVersionId: string | null;
}

/**
 * Learning test against real workerd through the real adapter: explicit
 * sqlite_master probes are metered as full scans, a primary-key read is one
 * row, nested transactions are savepoints whose caught inner throw rolls back
 * only the inner work, and a thrown schema install discards its tables, rows,
 * nested seed and marker while prior schema and data survive untouched.
 */
test('Durable Objects SQLite meters schema probes as scans and installs atomically over nested savepoints', {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-state-db-metering-'));
  const configPath = join(root, 'wrangler.json');
  const port = await availablePort();
  const productionConfig = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const compatibilityDate = productionConfig.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-state-db-metering',
    main: FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    durable_objects: { bindings: [{ name: 'METERING', class_name: 'MeteringStore' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['MeteringStore'] }],
    version_metadata: { binding: 'CF_VERSION_METADATA' },
  }, null, 2));

  let worker: WorkerHandle | undefined;
  try {
    worker = startWorker(configPath, port);
    const probe = await waitForWorker(worker, `http://127.0.0.1:${port}/`);
    const repeated = await fetch(`http://127.0.0.1:${port}/`);
    assert.ok(repeated.ok);
    assert.deepEqual(await repeated.json(), probe, 'retry returns the persisted report without reseeding');
    const m = probe.maintenance;
    assert.equal(m.failedInstallRollback, true);
    assert.deepEqual(m.indexed.result, m.baseline.result);
    assert.deepEqual(m.reinstalled.result, m.baseline.result);
    assert.ok(m.indexed.reads <= 100, `idle maintenance reads: ${m.indexed.reads}`);
    assert.ok(m.baseline.reads > 10_000, `baseline scans: ${m.baseline.reads}`);
    assert.ok(m.missing.reads <= 2);
    assert.equal(m.indexed.writes, m.baseline.writes);
    assert.ok(m.turnLifecycle.writes < 100, `turn lifecycle writes: ${m.turnLifecycle.writes}`);
    assert.ok(m.runLifecycle.writes < 200, `run lifecycle writes: ${m.runLifecycle.writes}`);
    assert.equal(m.runLifecycle.result, 'succeeded');
    assert.equal(m.baselineRunLifecycle.result, 'succeeded');
    assert.ok(m.runLifecycle.writes - m.baselineRunLifecycle.writes <= 16, 'bounded routine index write amplification');
    assert.ok(m.turnLifecycle.writes - m.baselineTurnLifecycle.writes <= 4, 'bounded turn index write amplification');
    for (const name of ['routine_runs_status_finished_idx', 'slack_run_presentations_hard_expiry_idx']) {
      assert.equal(m.builds.find((b) => b.name === name)?.writes, 1_001, `${name} build writes`);
    }
    console.info('[learning] actual store maintenance', JSON.stringify(m));
    const byLabel = new Map(probe.results.map((entry) => [entry.label, entry]));
    const read = (label: string) => {
      const entry = byLabel.get(label);
      assert.ok(entry, `missing measurement ${label}`);
      return entry.rowsRead;
    };
    console.info('[learning] workerd rows read', JSON.stringify({
      ...Object.fromEntries(probe.results.map((entry) => [entry.label, entry.rowsRead])),
      nested: probe.nested,
      bootstrap: probe.bootstrap,
      localVersionId: probe.localVersionId,
    }));
    // The construction-time probes the old init issued 45 times per cold start.
    assert.ok(read('sqlite_master_by_name') >= 100, 'a by-name sqlite_master probe scans the schema table');
    assert.ok(read('pragma_foreign_key_check') >= 500, 'foreign_key_check reads every foreign-keyed row');
    assert.ok(read('count_left_join_scan') >= 500, 'the integrity COUNT joins scan the ledger');
    // The warm attach's only metered reads.
    assert.ok(read('pk_lookup') <= 2, 'a primary-key read is metered as at most one row plus its index');
    // Native nesting: a caught inner throw rolls back only the inner insert.
    assert.equal(probe.nested.innerError, 'inner');
    assert.deepEqual(probe.nested.rows, [1, 3]);
    // Install atomicity: a thrown install discards its DDL, rows, nested seed
    // and marker together, and leaves prior schema and data untouched.
    assert.equal(probe.bootstrap.installError, 'bootstrap');
    assert.equal(probe.bootstrap.installedTableExists, false);
    assert.equal(probe.bootstrap.markerInstalled, false);
    assert.equal(probe.bootstrap.markerTableRows, 0);
    assert.equal(probe.bootstrap.priorValue, 'before');
    // Local wrangler dev presents a real-looking random upload id, which is
    // why the fingerprint also requires a released build identity.
    assert.equal(
      stateSchemaFingerprint(probe.localVersionId ?? undefined, { version: 'development', sourceCommit: null }),
      undefined,
      `a development build must never attach, even with local id ${probe.localVersionId}`,
    );
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

async function waitForWorker(handle: WorkerHandle, origin: string): Promise<Probe> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    let response: Response | undefined;
    try {
      response = await fetch(origin);
    } catch {
      // Not ready yet.
    }
    if (response?.ok) return await response.json() as Probe;
    if (response?.status === 500) {
      throw new Error(`Metering fixture failed: ${await response.text()}\n${handle.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wrangler dev did not become ready:\n${handle.output()}`);
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
