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
const WORKER_FIXTURE = join(ROOT, 'tests', 'fixtures', 'composio', 'sdk-import-worker.ts');

test('the real Composio SDK imports and constructs inside workerd', {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-composio-workerd-'));
  const configPath = join(root, 'wrangler.json');
  const port = await availablePort();
  const backendPort = await availablePort();
  const backendRequests: StubRequest[] = [];
  const backend = await startBackendStub(backendPort, backendRequests);
  const productionConfig = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const compatibilityDate = productionConfig.match(
    /"compatibility_date"\s*:\s*"([^"]+)"/,
  )?.[1];
  const compatibilityFlagsSource = productionConfig.match(
    /"compatibility_flags"\s*:\s*\[([\s\S]*?)\]/,
  )?.[1] ?? '';
  const compatibilityFlags = [...compatibilityFlagsSource.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]!)
    // The smoke backend is intentionally loopback; production's public-only
    // fetch flag would correctly reject the fixture before exercising the SDK.
    .filter((flag) => flag !== 'global_fetch_strictly_public');
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-composio-workerd-smoke',
    main: WORKER_FIXTURE,
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
  }, null, 2));

  let worker: WorkerHandle | undefined;
  try {
    worker = startWorker(configPath, port);
    const workerUrl = new URL(`http://127.0.0.1:${port}`);
    workerUrl.searchParams.set('backend_url', `http://127.0.0.1:${backendPort}`);
    const response = await waitForWorker(worker, workerUrl.toString());
    assert.deepEqual(response, {
      imported: true,
      linkId: 'ca_workerd_smoke',
      redirectUrl: 'https://connect.composio.dev/link/lk_workerd_smoke',
      directSuccessful: true,
      directLogId: 'log_workerd_smoke',
      directResultKeys: ['emailAddress'],
      providerVersion: '20260817_00',
      sheetsDirectSuccessful: true,
      sheetsDirectResultKeys: ['spreadsheets'],
      sheetsProviderVersion: '20260813_00',
      sessionId: 'trs_workerd_smoke',
      executeCancellation: 'ComposioRequestCancelledError',
    });
    assert.deepEqual(
      backendRequests.map(({ method, path }) => ({ method, path })),
      [
        { method: 'GET', path: '/api/v3.1/connected_accounts' },
        { method: 'POST', path: '/api/v3.1/connected_accounts/link' },
        { method: 'GET', path: '/api/v3.1/tools/GMAIL_GET_PROFILE' },
        { method: 'POST', path: '/api/v3.1/tools/execute/GMAIL_GET_PROFILE' },
        { method: 'GET', path: '/api/v3.1/tools/GOOGLESHEETS_SEARCH_SPREADSHEETS' },
        { method: 'POST', path: '/api/v3.1/tools/execute/GOOGLESHEETS_SEARCH_SPREADSHEETS' },
        { method: 'POST', path: '/api/v3.1/tool_router/session' },
      ],
    );
    assert.deepEqual(backendRequests[1]?.body, {
      auth_config_id: 'ac_workerd_smoke',
      user_id: 'chickpea:membership:workerd_smoke',
      callback_url: 'https://example.test/composio/return',
    });
    assert.equal(backendRequests[2]?.query.get('version'), '20260817_00');
    assert.deepEqual(backendRequests[3]?.body, {
      connected_account_id: 'ca_workerd_smoke',
      arguments: {},
      user_id: 'chickpea:membership:workerd_smoke',
      version: '20260817_00',
    });
    assert.equal(backendRequests[4]?.query.get('version'), '20260813_00');
    assert.deepEqual(backendRequests[5]?.body, {
      connected_account_id: 'ca_sheets_workerd_smoke',
      arguments: {
        query: 'Chickpea canary',
        max_results: 5,
        include_trashed: false,
      },
      user_id: 'chickpea:membership:workerd_smoke',
      version: '20260813_00',
    });
    assert.deepEqual(backendRequests[6]?.body, {
      user_id: 'chickpea:membership:workerd_smoke',
      connected_accounts: { gmail: ['ca_workerd_smoke'] },
      toolkits: { enable: ['gmail'] },
      tools: { gmail: { enable: ['GMAIL_GET_PROFILE'] } },
      manage_connections: { enable: false },
      workbench: { enable: false },
      preload: { tools: 'all' },
      search: { enable: false },
      execute: { enable_multi_execute: false },
    });
  } finally {
    if (worker) await stopWorker(worker);
    await new Promise<void>((resolve, reject) => backend.close((error) =>
      error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

async function startBackendStub(port: number, requests: StubRequest[]): Promise<Server> {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const bodyText = await new Promise<string>((resolve, reject) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.once('end', () => resolve(body));
      request.once('error', reject);
    });
    const observed: StubRequest = {
      method: request.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      ...(bodyText ? { body: JSON.parse(bodyText) as unknown } : {}),
    };
    requests.push(observed);

    let result: unknown;
    if (observed.method === 'GET' && observed.path === '/api/v3.1/connected_accounts') {
      result = { current_page: 1, items: [], total_items: 0, total_pages: 0 };
    } else if (observed.method === 'POST' &&
        observed.path === '/api/v3.1/connected_accounts/link') {
      result = {
        connected_account_id: 'ca_workerd_smoke',
        expires_at: '2026-08-23T12:00:00Z',
        link_token: 'lk_workerd_smoke',
        redirect_url: 'https://connect.composio.dev/link/lk_workerd_smoke',
      };
    } else if (observed.method === 'GET' &&
        observed.path === '/api/v3.1/tools/GMAIL_GET_PROFILE') {
      result = {
        available_versions: ['20260817_00'],
        deprecated: {
          available_versions: ['20260817_00'],
          displayName: 'Get Gmail profile',
          is_deprecated: false,
          toolkit: { logo: '' },
          version: '20260817_00',
        },
        description: 'Get Gmail profile',
        input_parameters: { type: 'object', properties: {} },
        is_deprecated: false,
        name: 'Get Gmail profile',
        no_auth: false,
        output_parameters: { type: 'object', properties: {} },
        scope_requirements: null,
        scopes: [],
        slug: 'GMAIL_GET_PROFILE',
        tags: [],
        toolkit: { logo: '', name: 'Gmail', slug: 'gmail' },
        version: '20260817_00',
      };
    } else if (observed.method === 'POST' &&
        observed.path === '/api/v3.1/tools/execute/GMAIL_GET_PROFILE') {
      result = {
        data: { emailAddress: 'workerd@example.test' },
        error: null,
        successful: true,
        log_id: 'log_workerd_smoke',
      };
    } else if (observed.method === 'GET' &&
        observed.path === '/api/v3.1/tools/GOOGLESHEETS_SEARCH_SPREADSHEETS') {
      result = {
        available_versions: ['20260813_00'],
        deprecated: {
          available_versions: ['20260813_00'],
          displayName: 'Search spreadsheets',
          is_deprecated: false,
          toolkit: { logo: '' },
          version: '20260813_00',
        },
        description: 'Search spreadsheets',
        input_parameters: { type: 'object', properties: {} },
        is_deprecated: false,
        name: 'Search spreadsheets',
        no_auth: false,
        output_parameters: { type: 'object', properties: {} },
        scope_requirements: null,
        scopes: [],
        slug: 'GOOGLESHEETS_SEARCH_SPREADSHEETS',
        tags: [],
        toolkit: { logo: '', name: 'Google Sheets', slug: 'googlesheets' },
        version: '20260813_00',
      };
    } else if (observed.method === 'POST' &&
        observed.path === '/api/v3.1/tools/execute/GOOGLESHEETS_SEARCH_SPREADSHEETS') {
      result = {
        data: { spreadsheets: [{ id: 'sheet_workerd_smoke' }] },
        error: null,
        successful: true,
        log_id: 'log_sheets_workerd_smoke',
      };
    } else if (observed.method === 'POST' &&
        observed.path === '/api/v3.1/tool_router/session') {
      const input = observed.body as Record<string, unknown>;
      result = {
        config: {
          execute: input.execute ?? {},
          preload: { tools: [] },
          search: input.search ?? {},
          user_id: input.user_id,
          connected_accounts: input.connected_accounts,
          manage_connections: input.manage_connections,
          toolkits: input.toolkits,
          tools: input.tools,
          workbench: input.workbench,
        },
        config_version: 1,
        mcp: { type: 'http', url: 'https://mcp.composio.dev/trs_workerd_smoke' },
        session_id: 'trs_workerd_smoke',
        tool_router_tools: ['GMAIL_GET_PROFILE'],
        warnings: [],
      };
    } else {
      response.statusCode = 404;
      result = { error: 'not_found' };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
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
  const child = spawn(WRANGLER, ['dev', '--config', configPath, '--port', String(port)], {
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
): Promise<{
  imported: boolean;
  linkId: string;
  redirectUrl: string | null;
  directSuccessful: boolean;
  directLogId: string;
  directResultKeys: string[];
  providerVersion: string;
  sheetsDirectSuccessful: boolean;
  sheetsDirectResultKeys: string[];
  sheetsProviderVersion: string;
  sessionId: string;
  executeCancellation: string;
}> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) {
        return await response.json() as {
          imported: boolean;
          linkId: string;
          redirectUrl: string | null;
          directSuccessful: boolean;
          directLogId: string;
          directResultKeys: string[];
          providerVersion: string;
          sheetsDirectSuccessful: boolean;
          sheetsDirectResultKeys: string[];
          sheetsProviderVersion: string;
          sessionId: string;
          executeCancellation: string;
        };
      }
    } catch {
      // Keep waiting for workerd to bind the requested port.
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
