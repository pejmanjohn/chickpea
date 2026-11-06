import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler, type Transport } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import {
  createWorkspaceManagementMcpServer,
  WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI,
} from '../src/management/mcp.ts';
import { observeMcpRequests } from '../src/management/mcp-request-telemetry.ts';
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
      name: 'revoke_setup_link',
      arguments: { setupOperationId: 'op_valid', reissue: SECRET_VALUE, [SECRET_KEY]: SECRET_VALUE },
    }, { name: 'revoke_setup_link' });
    assert.equal(response.status, 200);

    assert.deepEqual(events(metrics, 'tool.call'), [], 'the handler never ran');
    const [refusal, ...extraRefusals] = events(metrics, 'tool.validation_failure');
    assert.deepEqual(extraRefusals, []);
    assert.equal(refusal?.surface, 'mcp');
    assert.equal(refusal?.tool, 'revoke_setup_link');
    assert.equal(refusal?.code, 'validation_failed');
    assert.ok(Array.isArray(refusal?.fields) && refusal.fields.includes('reissue'), JSON.stringify(refusal));
    assert.ok(Array.isArray(refusal?.validationCodes) && refusal.validationCodes.length > 0);

    const [request, ...extraRequests] = requestMetrics(metrics);
    assert.deepEqual(extraRequests, []);
    assert.equal(request?.method, 'tools/call');
    assert.equal(request?.tool, 'revoke_setup_link');
    assert.equal(request?.outcome, 'input_refused');
    assert.equal(typeof request?.durationMs, 'number');
    assertNoValues(metrics, principal);
  });

  test(`a valid tools/call emits tool.call and a success request metric (${protocol})`, async (t) => {
    const { fetch, metrics, principal } = await harness(t, `valid-${protocol}`);

    await post(fetch, protocol, 'tools/call', { name: 'inspect_workspace', arguments: {} }, {
      name: 'inspect_workspace',
    });

    const [call] = events(metrics, 'tool.call');
    assert.equal(call?.tool, 'inspect_workspace');
    assert.equal(call?.outcome, 'success');
    assert.deepEqual(events(metrics, 'tool.validation_failure'), []);
    const [request, ...extra] = requestMetrics(metrics);
    assert.deepEqual(extra, []);
    assert.equal(request?.method, 'tools/call');
    assert.equal(request?.tool, 'inspect_workspace');
    assert.equal(request?.outcome, 'success');
    assert.equal(typeof request?.durationMs, 'number');
    assertNoValues(metrics, principal);
  });
}

test('a tools/call whose handler fails is a tool error, not a refusal', async (t) => {
  const { fetch, metrics, principal } = await harness(t, 'tool-error');

  await post(fetch, LEGACY, 'tools/call', {
    name: 'get_operation',
    arguments: { operationId: 'op_missing' },
  });

  const [call] = events(metrics, 'tool.call');
  assert.equal(call?.outcome, 'error');
  assert.deepEqual(events(metrics, 'tool.validation_failure'), []);
  const [request] = requestMetrics(metrics);
  assert.equal(request?.tool, 'get_operation');
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

test('resources/read names a static Chickpea guide and nothing else', async (t) => {
  const { fetch, metrics, principal } = await harness(t, 'resources');

  await post(fetch, LEGACY, 'resources/read', { uri: WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI });
  await post(fetch, LEGACY, 'resources/read', { uri: `chickpea://agent/${SECRET_KEY}` });

  const [guide, unknown, ...extra] = requestMetrics(metrics);
  assert.deepEqual(extra, []);
  assert.equal(guide?.method, 'resources/read');
  assert.equal(guide?.resource, WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI);
  assert.equal(guide?.outcome, 'success');
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
        params: { name: 'get_operation', arguments: { operationId: SECRET_VALUE.repeat(40) } },
      },
    ]),
  }));
  await response.text();

  assert.deepEqual(
    requestMetrics(metrics).map(({ method, tool, outcome }) => ({ method, tool, outcome }))
      .sort((a, b) => String(a.method).localeCompare(String(b.method))),
    [
      { method: 'tools/call', tool: 'get_operation', outcome: 'input_refused' },
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
