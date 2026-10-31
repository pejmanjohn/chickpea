import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error Executable helpers are JavaScript, shared with the verifiers.
import { reserveVerificationPort } from '../scripts/lib/verification-ports.mjs';
import { CLAUDE_DOCUMENTS } from './helpers/client-metadata-documents.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const WORKER_FIXTURE = join(ROOT, 'tests', 'fixtures', 'mcp-client-metadata', 'document-worker.ts');
const MIGRATIONS = join(ROOT, 'migrations', 'better-auth');
const CLAUDE = CLAUDE_DOCUMENTS.claude.url;
const DOCUMENT_PATH = new URL(CLAUDE).pathname;
const MOVED_PATH = '/oauth/moved-client-metadata';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/**
 * Better Auth's metadata-document plugin asks its transport for
 * `redirect: "error"`, a mode Node accepts and workerd refuses with a throw
 * the plugin reports as a network failure, so only workerd shows the sign-in.
 */
test('Claude\'s metadata document resolves under workerd, and a redirecting document is refused', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-cimd-workerd-'));
  const persistTo = join(root, 'persist');
  const configPath = join(root, 'wrangler.json');
  const port = await reserveVerificationPort() as number;
  const documentPort = await reserveVerificationPort() as number;
  const origin = `http://127.0.0.1:${port}`;
  const documents = await startDocumentServer(documentPort);
  const productionConfig = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const compatibilityDate = productionConfig.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  const flagsSource = productionConfig.match(/"compatibility_flags"\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-cimd-workerd-probe',
    main: WORKER_FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: [...flagsSource.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1]!)
      // The document server is loopback on purpose; production's public-only
      // fetch flag would refuse it before the transport was exercised.
      .filter((flag) => flag !== 'global_fetch_strictly_public'),
    vars: { DOCUMENT_HOST: `http://127.0.0.1:${documentPort}` },
    d1_databases: [{
      binding: 'AUTH_DB',
      database_name: 'chickpea-cimd-workerd',
      database_id: '00000000-0000-0000-0000-000000000545',
      migrations_dir: MIGRATIONS,
    }],
  }, null, 2));

  let worker: WorkerHandle | undefined;
  try {
    const migrated = spawnSync(WRANGLER, [
      'd1', 'migrations', 'apply', 'AUTH_DB', '--local', '--persist-to', persistTo, '--config', configPath,
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1' } });
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    worker = startWorker(configPath, persistTo, port);
    await waitForWorker(worker, origin);

    const signIn = await authorize(origin, CLAUDE);
    assert.equal(signIn.status, 302, signIn.body);
    const login = new URL(signIn.location!, origin);
    assert.equal(login.pathname, '/auth/mcp/login');
    assert.equal(login.searchParams.get('client_id'), CLAUDE);
    assert.deepEqual(documents.requests, [{ path: DOCUMENT_PATH, accept: 'application/json' }]);
    assert.deepEqual(await (await fetch(`${origin}/test/clients`)).json(), [
      { clientId: CLAUDE, clientDiscoveryId: 'cimd', name: 'Claude' },
    ]);

    const moved = await authorize(origin, `https://claude.ai${MOVED_PATH}`);
    assert.equal(moved.status, 400);
    assert.deepEqual(JSON.parse(moved.body), {
      error: 'invalid_client',
      error_description: 'Metadata document fetch returned HTTP 302',
    });
    assert.deepEqual(documents.requests.slice(1), [{ path: MOVED_PATH, accept: 'application/json' }],
      'the redirect is not followed');
    assert.equal((await (await fetch(`${origin}/test/clients`)).json() as unknown[]).length, 1);
  } finally {
    if (worker) await stopWorker(worker);
    await new Promise<void>((resolve) => documents.server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

/** A signed-out browser navigation to authorize; Node's fetch would announce itself as a script. */
function authorize(origin: string, clientId: string) {
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK,
    scope: 'chickpea:workspace', state: 'client-state', resource: `${origin}/mcp`,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
  });
  return new Promise<{ status: number; location: string | undefined; body: string }>((resolve, reject) => {
    get(`${origin}/api/auth/oauth2/authorize?${query}`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += String(chunk); });
      response.once('end', () => resolve({ status: response.statusCode!, location: response.headers.location, body }));
    }).once('error', reject);
  });
}

/** `requests` lists only the two document paths: other checkouts share the port range, and a stray request can reach it. */
async function startDocumentServer(port: number) {
  const requests: Array<{ path: string; accept: IncomingHttpHeaders['accept'] }> = [];
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://document.test').pathname;
    if (path === DOCUMENT_PATH) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
      response.end(CLAUDE_DOCUMENTS.claude.body);
    } else if (path === MOVED_PATH) {
      response.writeHead(302, { location: DOCUMENT_PATH });
      response.end();
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    requests.push({ path, accept: request.headers.accept });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, requests };
}

interface WorkerHandle {
  child: ChildProcess;
  output(): string;
}

function startWorker(configPath: string, persistTo: string, port: number): WorkerHandle {
  const child = spawn(WRANGLER, [
    'dev', '--config', configPath, '--port', String(port), '--persist-to', persistTo, '--inspector-port', '0',
  ], { cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function waitForWorker(handle: WorkerHandle, origin: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {
      // workerd has not bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wrangler dev never served the probe:\n${handle.output()}`);
}
