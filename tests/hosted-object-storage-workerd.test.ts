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
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'object-host', 'object-host-worker.ts');

interface ObjectState { tables: string[]; entries: number; alarm: number | null }
interface Probe {
  seeded: ObjectState;
  paged: { text: string; pages: number };
  whole: { text: string; pages: number };
  refused: string;
  afterRefusal: ObjectState;
  erased: { erased: boolean };
  afterErase: ObjectState;
  reexported: { text: string; pages: number };
}

/**
 * The host functions over real workerd Durable Object storage, at the
 * production compatibility date and installation tenancy: an export reads
 * every SQL table (one without a rowid) and key-value entry, pages
 * concatenate to the whole, another installation is refused, and erasing
 * removes every table, entry and the alarm.
 */
test('host functions export, refuse and erase a real Durable Object\'s storage', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-object-host-'));
  const configPath = join(root, 'wrangler.json');
  const port = await reserveVerificationPort();
  const productionConfig = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const compatibilityDate = productionConfig.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-object-host',
    main: FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    vars: { CHICKPEA_TENANCY: 'installation' },
    durable_objects: { bindings: [{ name: 'PROBE', class_name: 'ProbeObject' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ProbeObject'] }],
  }, null, 2));

  let worker: WorkerHandle | undefined;
  try {
    worker = startWorker(configPath, port);
    await waitForWorker(worker, `http://127.0.0.1:${port}/`);
    const response = await fetch(`http://127.0.0.1:${port}/probe`);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const probe = JSON.parse(body) as Probe;

    assert.deepEqual(probe.seeded.tables, ['keyed', 'transcript']);
    assert.equal(probe.seeded.entries, 2);
    assert.ok(probe.seeded.alarm !== null);

    // Local workerd's own `__miniflare_do_name` table is exported like any other; deployed storage has none.
    const records = probe.whole.text.trim().split('\n').map((line) => JSON.parse(line))
      .filter((record) => !String(record.table ?? '').startsWith('__miniflare'));
    assert.equal(probe.whole.pages, 1);
    assert.ok(probe.paged.pages > 2, `small pages split the object (${probe.paged.pages})`);
    assert.equal(probe.paged.text, probe.whole.text, 'pages concatenate to the whole export');
    assert.deepEqual(records.filter((record) => record.t === 'table').map((record) => record.table), ['keyed', 'transcript']);
    const rows = (table: string) => records.filter((record) => record.t === 'row' && record.table === table);
    assert.equal(rows('transcript').length, 40);
    assert.equal(rows('keyed').length, 40);
    assert.deepEqual(rows('transcript')[1].row.image, { $bytes: Buffer.from([1, 255]).toString('base64') });
    assert.deepEqual(rows('keyed').slice(0, 2).map((record) => [record.row.a, record.row.b]), [['k0', 0], ['k0', 3]],
      'a table without a rowid is read in primary key order');
    assert.deepEqual(records.filter((record) => record.t === 'kv'), [
      { t: 'kv', key: 'flue:wake', value: { at: { $date: '2027-01-15T08:00:00.000Z' }, seen: { $map: [['a', 1]] } } },
      { t: 'kv', key: 'plain', value: 'value' },
    ]);

    assert.match(probe.refused, /another installation/);
    assert.deepEqual(probe.afterRefusal, probe.seeded);

    assert.deepEqual(probe.erased, { erased: true });
    assert.deepEqual(probe.afterErase, { tables: [], entries: 0, alarm: null });
    assert.deepEqual(probe.reexported.text.trim().split('\n').map((line) => JSON.parse(line))
      .filter((record) => !String(record.table ?? '').startsWith('__miniflare')).map((record) => record.t), ['object']);
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
