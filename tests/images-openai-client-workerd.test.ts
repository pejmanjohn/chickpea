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
const WORKER_FIXTURE = join(ROOT, 'tests', 'fixtures', 'images', 'openai-client-worker.ts');

/**
 * The images client only ever runs in a Worker on the Cloudflare target, and
 * its live failures are invisible from outside: a bare `unavailable` could be
 * `redirect: 'error'` being refused by the runtime, `response.url` coming back
 * empty, a multipart body the runtime will not build, or the deadline race
 * never releasing. This pins each of those under real workerd.
 */
test('the images client and its fetch primitives behave under workerd', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-images-workerd-'));
  const configPath = join(root, 'wrangler.json');
  const port = await availablePort();
  const stubPort = await availablePort();
  const seen: Array<{ path: string; contentType: string; body: string }> = [];
  const stub = await startStub(stubPort, seen);
  const productionConfig = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const compatibilityDate = productionConfig.match(
    /"compatibility_date"\s*:\s*"([^"]+)"/,
  )?.[1];
  const compatibilityFlagsSource = productionConfig.match(
    /"compatibility_flags"\s*:\s*\[([\s\S]*?)\]/,
  )?.[1] ?? '';
  const compatibilityFlags = [...compatibilityFlagsSource.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]!)
    // The stub is loopback on purpose; production's public-only fetch flag
    // would reject it before any primitive was exercised.
    .filter((flag) => flag !== 'global_fetch_strictly_public');
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-images-workerd-probe',
    main: WORKER_FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
  }, null, 2));

  let worker: WorkerHandle | undefined;
  try {
    worker = startWorker(configPath, port);
    const workerUrl = new URL(`http://127.0.0.1:${port}`);
    workerUrl.searchParams.set('stub_url', `http://127.0.0.1:${stubPort}`);
    const probes = await waitForWorker(worker, workerUrl.toString());

    // The live `unavailable` came from here: workerd throws on the init
    // itself, before the request leaves, so every image call failed as an
    // unreachable provider without a single log line.
    const refused = probes.redirectErrorAccepted as { threw?: string; message?: string };
    assert.equal(refused.threw, 'TypeError');
    assert.match(String(refused.message), /must be one of "follow" or "manual"/);
    // `manual` is accepted and still exposes the redirect by status, which is
    // what the client's off-host guard now refuses on.
    assert.deepEqual(probes.redirectManualAccepted, {
      status: 200, url: `http://127.0.0.1:${stubPort}/ok`,
    });
    assert.deepEqual(probes.redirectManualExposesRedirect, {
      status: 302, redirected: false, url: `http://127.0.0.1:${stubPort}/redirect`,
    });
    assert.equal((probes.responseUrlPopulated as { hasUrl: boolean }).hasUrl, true);

    assert.deepEqual(probes.generateSucceeds, {
      ok: true, byteLength: 4, appliedFormat: 'jpeg', appliedSize: '1024x1024',
    });
    assert.deepEqual(probes.editSendsMultipart, {
      ok: true, byteLength: 4, appliedFormat: 'jpeg', appliedSize: '1024x1024',
    });
    const multipart = seen.find((entry) => entry.path === '/multipart-echo');
    assert.ok(multipart, 'the edit call must reach the stub');
    assert.match(multipart.contentType, /^multipart\/form-data; boundary=/);
    for (const field of ['model', 'prompt', 'input_fidelity', 'output_format', 'image[]']) {
      assert.ok(multipart.body.includes(`name="${field}"`), field);
    }
    assert.ok(multipart.body.includes('filename="image-1.png"'));

    // Both abort routes release the lane with a typed outcome rather than
    // hanging or escaping as an untyped throw.
    assert.deepEqual(probes.deadlineAborts, {
      ok: false, reason: 'timeout', detail: 'deadline_exceeded',
    });
    assert.deepEqual(probes.callerAbortStops, {
      ok: false, reason: 'timeout', detail: 'aborted',
    });
    assert.deepEqual(probes.base64DecodeWorks, { length: 4, first: 0, last: 3 });
  } finally {
    if (worker) await stopWorker(worker);
    await new Promise<void>((resolve, reject) => stub.close((error) =>
      error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

const IMAGE_B64 = 'AAECAw==';

async function startStub(
  port: number,
  seen: Array<{ path: string; contentType: string; body: string }>,
): Promise<Server> {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const body = await new Promise<string>((resolve, reject) => {
      let text = '';
      request.setEncoding('latin1');
      request.on('data', (chunk) => { text += String(chunk); });
      request.once('end', () => resolve(text));
      request.once('error', reject);
    });
    seen.push({
      path: url.pathname,
      contentType: String(request.headers['content-type'] ?? ''),
      body,
    });
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/ok` });
      response.end();
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }, 5_000);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      data: [{ b64_json: IMAGE_B64 }],
      size: '1024x1024',
      output_format: 'jpeg',
    }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

interface WorkerHandle {
  child: ChildProcess;
  output: () => string;
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

async function waitForWorker(
  handle: WorkerHandle,
  origin: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    try {
      const response = await fetch(origin);
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
