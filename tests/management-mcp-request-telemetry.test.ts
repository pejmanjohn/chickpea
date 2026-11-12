import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler, McpServer, type Transport } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import {
  createWorkspaceManagementMcpServer,
} from '../src/management/mcp.ts';
import { observeMcpRequests } from '../src/management/mcp-request-telemetry.ts';
import { AGENT_AUTHORING_GUIDE_URI, DISCOVERY_GUIDE_URI } from '../src/management/agent-authoring/index.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
const SECRET_VALUE = 'sentinel-value-7f3a9c';
const SECRET_KEY = 'sentinelKey7f3a9c';

type Metric = Record<string, unknown>;

async function harness(t: TestContext, suffix: string) {
  const f = await createManagementAdapterFixture(suffix);
  t.after(() => f.close());
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: f.admin.binding.betterAuthUserId!,
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    role: 'admin',
    clientId: 'client_request_telemetry',
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service: f.service }),
    { legacy: 'stateless' },
  );
  const metrics: Metric[] = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if (record && typeof record === 'object') metrics.push(record as Metric);
  });
  return { fetch: handler.fetch, metrics, principal };
}

function headers(protocol: string, method: string, name?: string): Record<string, string> {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': protocol,
    ...(protocol === MODERN ? { 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) } : {}),
  };
}

async function post(
  fetch: (request: Request) => Promise<Response>,
  protocol: string,
  method: string,
  params: Record<string, unknown>,
  options: { notification?: boolean; name?: string } = {},
): Promise<Response> {
  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: headers(protocol, method, options.name),
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(options.notification ? {} : { id: `req-${method}` }),
      method,
      params: protocol === MODERN ? {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      } : params,
    }),
  }));
  await response.text();
  return response;
}

const requestMetrics = (metrics: Metric[]) => metrics.filter((m) => m.event === 'mcp.request');
const events = (metrics: Metric[], event: string) => metrics.filter((m) => m.event === event);

function assertNoValues(metrics: Metric[], principal: McpAuthenticatedPrincipal): void {
  const serialized = JSON.stringify(metrics);
  for (const forbidden of [
    SECRET_VALUE, SECRET_KEY, 'req-',
    principal.userId, principal.membershipId, principal.organizationId, principal.clientId,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}: ${serialized}`);
  }
}

for (const protocol of [LEGACY, MODERN]) {
  test(`a schema-invalid tools/call emits the refusal and a refused request metric (${protocol})`, async (t) => {
    const { fetch, metrics, principal } = await harness(t, `refused-${protocol}`);

    const response = await post(fetch, protocol, 'tools/call', {
      name: 'cancel_setup_link',
      arguments: { setupToken: 'op_valid', sendNewLink: SECRET_VALUE, [SECRET_KEY]: SECRET_VALUE },
    }, { name: 'cancel_setup_link' });
    assert.equal(response.status, 200);

    assert.deepEqual(events(metrics, 'tool.call'), [], 'the handler never ran');
    const [refusal, ...extraRefusals] = events(metrics, 'tool.validation_failure');
    assert.deepEqual(extraRefusals, []);
    assert.equal(refusal?.surface, 'mcp');
    assert.equal(refusal?.tool, 'cancel_setup_link');
    assert.equal(refusal?.code, 'validation_failed');
    assert.ok(Array.isArray(refusal?.fields) && refusal.fields.includes('sendNewLink'), JSON.stringify(refusal));
    assert.ok(Array.isArray(refusal?.validationCodes) && refusal.validationCodes.length > 0);

    const [request, ...extraRequests] = requestMetrics(metrics);
    assert.deepEqual(extraRequests, []);
    assert.equal(request?.method, 'tools/call');
    assert.equal(request?.tool, 'cancel_setup_link');
    assert.equal(request?.outcome, 'input_refused');
    assert.equal(typeof request?.durationMs, 'number');
    assertNoValues(metrics, principal);
  });

  test(`a valid tools/call emits tool.call and a success request metric (${protocol})`, async (t) => {
    const { fetch, metrics, principal } = await harness(t, `valid-${protocol}`);

    await post(fetch, protocol, 'tools/call', { name: 'get_workspace', arguments: {} }, {
      name: 'get_workspace',
    });

    const [call] = events(metrics, 'tool.call');
    assert.equal(call?.tool, 'get_workspace');
    assert.equal(call?.outcome, 'success');
    assert.deepEqual(events(metrics, 'tool.validation_failure'), []);
    const [request, ...extra] = requestMetrics(metrics);
    assert.deepEqual(extra, []);
    assert.equal(request?.method, 'tools/call');
    assert.equal(request?.tool, 'get_workspace');
    assert.equal(request?.outcome, 'success');
    assert.equal(typeof request?.durationMs, 'number');
    assertNoValues(metrics, principal);
  });
}

test('a refused record key is written as *, never as the key itself', async (t) => {
  // No 5.0 input takes a record, so a server of the test's own observes one.
  const policies = z.strictObject({ policies: z.record(z.string(), z.strictObject({ effect: z.enum(['read', 'write']) })) });
  class Observed extends McpServer {
    override connect(transport: Transport): Promise<void> {
      observeMcpRequests(transport, { record_tool: policies });
      return super.connect(transport);
    }
  }
  const { fetch } = createMcpHandler(() => {
    const server = new Observed({ name: 'records', version: '0' });
    server.registerTool('record_tool', { inputSchema: policies }, async () => ({ content: [] }));
    return server;
  }, { legacy: 'stateless' });
  const metrics: Metric[] = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if (record && typeof record === 'object') metrics.push(record as Metric);
  });

  await post(fetch, LEGACY, 'tools/call', {
    name: 'record_tool',
    arguments: { policies: { [SECRET_KEY]: { effect: SECRET_VALUE } } },
  });

  const [refusal] = events(metrics, 'tool.validation_failure');
  assert.ok(Array.isArray(refusal?.fields), JSON.stringify(refusal));
  assert.ok(refusal.fields.includes('policies.*.effect'));
  assert.equal(refusal.fields.some((field: string) => field.includes(SECRET_KEY)), false);
  assert.equal(requestMetrics(metrics)[0]?.outcome, 'input_refused');
  assert.equal(JSON.stringify(metrics).includes(SECRET_KEY) || JSON.stringify(metrics).includes(SECRET_VALUE), false);
});

test('a tools/call whose handler fails is a tool error, not a refusal', async (t) => {
  const { fetch, metrics, principal } = await harness(t, 'tool-error');

  await post(fetch, LEGACY, 'tools/call', {
    name: 'get_setup_status',
    arguments: { setupToken: 'op_missing' },
  });

  const [call] = events(metrics, 'tool.call');
  assert.equal(call?.outcome, 'error');
  assert.deepEqual(events(metrics, 'tool.validation_failure'), []);
  const [request] = requestMetrics(metrics);
  assert.equal(request?.tool, 'get_setup_status');
  assert.equal(request?.outcome, 'tool_error');
  assertNoValues(metrics, principal);
});

test('an unknown tool is a JSON-RPC error and its name is not recorded', async (t) => {
  const { fetch, metrics, principal } = await harness(t, 'unknown-tool');

  await post(fetch, LEGACY, 'tools/call', { name: SECRET_KEY, arguments: {} });

  const [request] = requestMetrics(metrics);
  assert.equal(request?.method, 'tools/call');
  assert.equal(request?.tool, 'other');
  assert.equal(request?.outcome, 'jsonrpc_error');
  assert.equal(request?.errorCode, '-32602');
  assertNoValues(metrics, principal);
});

test('resources/read names a static Chickpea guide, or a removed resource, and nothing else', async (t) => {
  const { fetch, metrics, principal } = await harness(t, 'resources');

  await post(fetch, LEGACY, 'resources/read', { uri: AGENT_AUTHORING_GUIDE_URI });
  await post(fetch, LEGACY, 'resources/read', { uri: DISCOVERY_GUIDE_URI });
  await post(fetch, LEGACY, 'resources/read', { uri: `chickpea://agent/${SECRET_KEY}` });

  const [guide, discovery, unknown, ...extra] = requestMetrics(metrics);
  assert.deepEqual(extra, []);
  assert.equal(guide?.method, 'resources/read');
  assert.equal(guide?.resource, AGENT_AUTHORING_GUIDE_URI, 'a read of the removed coding-agent guide still counts by its URI');
  assert.equal(guide?.outcome, 'jsonrpc_error');
  assert.equal(discovery?.resource, DISCOVERY_GUIDE_URI);
  assert.equal(discovery?.outcome, 'success');
  assert.equal(unknown?.method, 'resources/read');
  assert.equal(unknown?.resource, 'other');
  assert.equal(unknown?.outcome, 'jsonrpc_error');
  assertNoValues(metrics, principal);
});

test('initialize, tools/list, and notifications each emit a request metric', async (t) => {
  const { fetch, metrics, principal } = await harness(t, 'lifecycle');

  await post(fetch, LEGACY, 'initialize', {
    protocolVersion: LEGACY,
    capabilities: {},
    clientInfo: { name: SECRET_VALUE, version: '1.0.0' },
  });
  const notified = await post(fetch, LEGACY, 'notifications/initialized', {}, { notification: true });
  assert.equal(notified.status, 202);
  await post(fetch, LEGACY, 'tools/list', {});

  assert.deepEqual(
    requestMetrics(metrics).map(({ method, outcome }) => ({ method, outcome })),
    [
      { method: 'initialize', outcome: 'success' },
      { method: 'notifications/initialized', outcome: 'received' },
      { method: 'tools/list', outcome: 'success' },
    ],
  );
  assertNoValues(metrics, principal);
});

test('each message of a JSON-RPC batch gets its own request metric', async (t) => {
  const { fetch, metrics, principal } = await harness(t, 'batch');

  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: headers('2025-03-26', 'tools/list'),
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 'req-a', method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 'req-b',
        method: 'tools/call',
        params: { name: 'get_setup_status', arguments: { setupToken: SECRET_VALUE.repeat(40) } },
      },
    ]),
  }));
  await response.text();

  assert.deepEqual(
    requestMetrics(metrics).map(({ method, tool, outcome }) => ({ method, tool, outcome }))
      .sort((a, b) => String(a.method).localeCompare(String(b.method))),
    [
      { method: 'tools/call', tool: 'get_setup_status', outcome: 'input_refused' },
      { method: 'tools/list', tool: undefined, outcome: 'success' },
    ],
  );
  assertNoValues(metrics, principal);
});

test('a request still pending when the connection closes is abandoned', (t) => {
  const metrics: Metric[] = [];
  t.mock.method(console, 'info', (record: Metric) => metrics.push(record));
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async () => {} };
  observeMcpRequests(transport, {});

  transport.onmessage?.({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
  transport.onclose?.();
  transport.onclose?.();

  assert.deepEqual(
    requestMetrics(metrics).map(({ method, outcome }) => ({ method, outcome })),
    [{ method: 'tools/list', outcome: 'abandoned' }],
  );
});

async function postAs(
  fetch: (request: Request) => Promise<Response>,
  input: { protocol: string; method: string; params: Record<string, unknown>; userAgent?: string; clientName?: string },
): Promise<void> {
  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      ...headers(input.protocol, input.method, typeof input.params.name === 'string' ? input.params.name : undefined),
      ...(input.userAgent ? { 'user-agent': input.userAgent } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `req-${input.method}`,
      method: input.method,
      params: input.protocol === MODERN ? {
        ...input.params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': input.protocol,
          'io.modelcontextprotocol/clientCapabilities': {},
          ...(input.clientName ? { 'io.modelcontextprotocol/clientInfo': { name: input.clientName, version: '1.0.0' } } : {}),
        },
      } : input.params,
    }),
  }));
  await response.text();
}

test('every request metric names its client by clientInfo.name, as a closed token', async (t) => {
  const { fetch, metrics, principal } = await harness(t, 'client-label');
  const initialize = (name: string) => ({
    protocolVersion: LEGACY,
    capabilities: {},
    clientInfo: { name, version: '1.0.0' },
  });

  // initialize carries clientInfo; on the stateless legacy door later messages
  // carry only the User-Agent, which repeats it for these clients.
  await postAs(fetch, { protocol: LEGACY, method: 'initialize', params: initialize('openai-mcp'), userAgent: 'python-httpx/0.27' });
  await postAs(fetch, { protocol: LEGACY, method: 'tools/list', params: {}, userAgent: 'openai-mcp/1.0.0' });
  await postAs(fetch, { protocol: LEGACY, method: 'tools/list', params: {}, userAgent: 'openai-mcp/1.0.0 (Codex)' });
  await postAs(fetch, { protocol: LEGACY, method: 'tools/list', params: {}, userAgent: 'codex-mcp-client/0.160.1' });
  await postAs(fetch, { protocol: LEGACY, method: 'initialize', params: initialize('claude-code') });
  await postAs(fetch, { protocol: LEGACY, method: 'tools/list', params: {}, userAgent: 'claude-code/2.1.0 (external, cli)' });
  await postAs(fetch, { protocol: LEGACY, method: 'initialize', params: initialize(SECRET_VALUE) });
  await postAs(fetch, { protocol: LEGACY, method: 'tools/list', params: {}, userAgent: `${SECRET_KEY}/1.0` });
  await postAs(fetch, { protocol: LEGACY, method: 'tools/list', params: {} });
  // The 2026-07-28 era carries clientInfo on every request.
  await postAs(fetch, { protocol: MODERN, method: 'tools/list', params: {}, clientName: 'chickpea-cli', userAgent: 'node' });

  assert.deepEqual(requestMetrics(metrics).map(({ method, client }) => ({ method, client })), [
    { method: 'initialize', client: 'openai-mcp' },
    { method: 'tools/list', client: 'openai-mcp' },
    { method: 'tools/list', client: 'openai-mcp-codex' },
    { method: 'tools/list', client: 'codex-mcp-client' },
    { method: 'initialize', client: 'claude-code' },
    { method: 'tools/list', client: 'claude-code' },
    { method: 'initialize', client: 'other' },
    { method: 'tools/list', client: 'other' },
    { method: 'tools/list', client: 'unknown' },
    { method: 'tools/list', client: 'chickpea-cli' },
  ]);
  assertNoValues(metrics, principal);
});
