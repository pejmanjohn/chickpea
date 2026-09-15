import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const WORKER_FIXTURE = join(ROOT, 'tests', 'fixtures', 'meta-ads', 'write-guard-worker.ts');

test('Meta Ads ownership preflight works under workerd and keeps failures fail-closed', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-meta-ads-guard-workerd-'));
  const configPath = join(root, 'wrangler.json');
  const workerPort = await availablePort();
  const stubPort = await availablePort();
  const productionConfig = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const compatibilityDate = productionConfig.match(
    /"compatibility_date"\s*:\s*"([^"]+)"/,
  )?.[1];
  const flagsSource = productionConfig.match(
    /"compatibility_flags"\s*:\s*\[([\s\S]*?)\]/,
  )?.[1] ?? '';
  const compatibilityFlags = [...flagsSource.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]!)
    // The synthetic Graph boundary is deliberately loopback.
    .filter((flag) => flag !== 'global_fetch_strictly_public');
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-meta-ads-guard-workerd-probe',
    main: WORKER_FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
  }, null, 2));

  const stub = await startStub(stubPort);
  const worker = startWorker(configPath, workerPort);
  try {
    const matching = await requestCase(worker, workerPort, stubPort, 'matching');
    assert.deepEqual(matching, {
      ok: true,
      mutationDispatched: true,
      delegateCalls: 1,
      delegateInput: {
        url: 'https://graph.facebook.com/v26.0/987654321?fields=id%2Caccount_id%2Cconfigured_status',
        method: 'GET',
        redirect: 'manual',
        authorization: 'Bearer synthetic-workerd-token',
      },
    });

    for (const mode of ['redirect', 'wrong-owner', 'missing-status']) {
      const blocked = await requestCase(worker, workerPort, stubPort, mode);
      assert.equal(blocked.ok, false, mode);
      assert.equal(blocked.mutationDispatched, false, mode);
      assert.equal(blocked.delegateCalls, 1, mode);
      assert.match(String(blocked.errorMessage), /could not verify/, mode);
    }

    const active = await requestCase(worker, workerPort, stubPort, 'active');
    assert.equal(active.ok, false);
    assert.equal(active.mutationDispatched, false);
    assert.equal(active.delegateCalls, 1);
    assert.match(String(active.errorMessage), /may pause an active campaign/);
  } finally {
    await stopWorker(worker);
    await new Promise<void>((resolve, reject) => stub.close((error) =>
      error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

async function startStub(port: number): Promise<Server> {
  const server = createHttpServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, {
        location: 'https://graph.facebook.com/v26.0/987654321?fields=id%2Caccount_id%2Cconfigured_status',
      });
      response.end();
      return;
    }
    const owner = request.url === '/wrong-owner' ? '999' : '123';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: '987654321', account_id: owner,
      ...(request.url === '/missing-status' ? {} : {
        configured_status: request.url === '/active' ? 'ACTIVE' : 'PAUSED',
      }),
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

interface WorkerHandle {
  child: ChildProcess;
  output(): string;
}

function startWorker(configPath: string, port: number): WorkerHandle {
  const child = spawn(
    WRANGLER,
    ['dev', '--config', configPath, '--port', String(port), '--inspector-port', '0'],
    { cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  return { child, output: () => output };
}

async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      handle.child.kill('SIGKILL');
      resolve();
    }, 5_000);
    handle.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    handle.child.kill('SIGTERM');
  });
}

async function requestCase(
  handle: WorkerHandle,
  workerPort: number,
  stubPort: number,
  mode: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  const url = new URL(`http://127.0.0.1:${workerPort}/`);
  url.searchParams.set('stub_url', `http://127.0.0.1:${stubPort}`);
  url.searchParams.set('mode', mode);
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch {
      // wrangler is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev never served the probe:\n${handle.output()}`);
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close(() => reject(new Error('no port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
