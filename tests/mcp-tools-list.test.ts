import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createMcpConnection, type McpConnectionDefinition } from '@flue/runtime';

import type { RuntimePlanMcpConnectionV2 } from '../src/agents/runtime-plan.ts';
import { resolveRuntimePlanMcpConnections } from '../src/config/profile-mcp.ts';
import {
  META_ADS_ACCOUNT_HELPER,
  META_ADS_APPROVED_ACCOUNT_SCOPE,
  META_ADS_FIELD_HELPER,
} from '../src/config/meta-ads-policy.ts';
import { META_ADS_ACCOUNT_HELPER_DESCRIPTION } from '../src/config/meta-ads-response.ts';
import { closeNodeStateStores, getConfigStore } from '../src/config/state-backend.ts';
import type { McpConnectionConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

// Synthetic tool names only. `alpha`, `beta`, and `gamma` are granted; the
// server stops listing `beta` and starts listing `extra`, which nobody granted.
const GRANT = ['alpha', 'beta', 'gamma'];
const URL_ = 'https://mcp.example.com/mcp';

type Wire = 'json' | 'sse';
type Rpc = { jsonrpc: '2.0'; id?: number; method: string; params?: { cursor?: string; name?: string } };
type ListedTool = string | Record<string, unknown>;

function listedTool(tool: ListedTool): Record<string, unknown> {
  return typeof tool === 'string'
    ? { name: tool, description: `The ${tool} tool.`, inputSchema: { type: 'object', properties: {} } }
    : tool;
}

function pageResult(pages: readonly (readonly ListedTool[])[], cursor: string | undefined): Record<string, unknown> {
  const index = cursor === undefined ? 0 : Number(cursor.replace('page-', ''));
  return {
    tools: pages[index]!.map(listedTool),
    ...(index + 1 < pages.length ? { nextCursor: `page-${index + 1}` } : {}),
  };
}

function initializeResult(params: Record<string, unknown> | undefined) {
  return {
    protocolVersion: params?.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'synthetic-tools', version: '1.0.0' },
  };
}

/** A Streamable HTTP server that answers each POST in JSON or as one SSE event. */
function streamableServer(wire: Wire, listing: (rpc: Rpc) => unknown) {
  const calls: string[] = [];
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as Rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let payload: unknown;
    if (rpc.method === 'initialize') {
      payload = { jsonrpc: '2.0', id: rpc.id, result: initializeResult(rpc.params as Record<string, unknown>) };
    } else if (rpc.method === 'tools/list') {
      payload = listing(rpc);
    } else if (rpc.method === 'tools/call') {
      calls.push(String(rpc.params?.name));
      payload = { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'done' }] } };
    } else {
      throw new Error(`Unexpected synthetic MCP request: ${rpc.method}`);
    }
    return wire === 'sse'
      ? new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      : Response.json(payload);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function pagedServer(wire: Wire, pages: readonly (readonly ListedTool[])[]) {
  return streamableServer(wire, (rpc) => ({
    jsonrpc: '2.0', id: rpc.id, result: pageResult(pages, rpc.params?.cursor),
  }));
}

/**
 * A legacy SSE server: every answer arrives on the GET event stream, pushed
 * before the POST's 202 returns, as a fast server can.
 */
function legacySseServer(tools: readonly ListedTool[]) {
  const encoder = new TextEncoder();
  let push: ((text: string) => void) | undefined;
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(encoder.encode(text));
          push('event: endpoint\ndata: /messages?session=synthetic\n\n');
        },
        cancel() {
          push = undefined;
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    const rpc = await request.json() as Rpc;
    if (rpc.id !== undefined) {
      const result = rpc.method === 'initialize'
        ? initializeResult(rpc.params as Record<string, unknown>)
        : rpc.method === 'tools/list'
          ? { tools: tools.map(listedTool) }
          : { content: [{ type: 'text', text: 'done' }] };
      push?.(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
    }
    return new Response('Accepted', { status: 202 });
  }) as typeof globalThis.fetch;
  return { fetch };
}

function connectionConfig(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  const allowedTools = overrides.allowedTools ?? GRANT;
  return {
    id: 'srv',
    credentialRef: 'connection_44444444444444444444444444444444',
    displayName: 'Example Tools',
    url: URL_,
    transport: 'streamable-http',
    authMode: 'none',
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: '',
    discoveredTools: allowedTools.map((name) => ({ name })),
    allowedTools,
    ...overrides,
  };
}

/**
 * Store an Agent with one MCP connection, then mount its runtime-plan
 * declaration against `fetch`, the way a Slack turn does.
 */
async function withRuntimeConnection<T>(
  connection: McpConnectionConfig,
  fetch: typeof globalThis.fetch,
  run: (definition: McpConnectionDefinition) => Promise<T>,
  declaration: Partial<RuntimePlanMcpConnectionV2> = {},
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-mcp-tools-list-'));
  try {
    return await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      const agentId = 'agent_mcp_tools_list';
      const created = await getConfigStore().createAgent({
        id: agentId, name: 'Tool drift', instructions: 'Use the granted tools.',
        enabled: true, skills: [], mcpServers: [connection], apiConnections: [], repositories: [],
      });
      const stored = created.mcpServers[0]!;
      const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
        id: stored.id,
        url: stored.url,
        transport: stored.transport,
        credentialRef: stored.credentialRef!,
        authMode: 'none',
        headerNames: [],
        optional: true,
        allowedTools: [...stored.allowedTools],
        ...declaration,
      }], undefined, undefined, { createGuardedFetch: () => fetch });
      assert.ok(definition);
      return await run(definition);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function mountedNames(definition: McpConnectionDefinition): Promise<string[]> {
  const connection = await createMcpConnection(definition);
  try {
    return connection.tools.map(({ name }) => name);
  } finally {
    await connection.close();
  }
}

function captureMissingTools(t: TestContext): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const info = console.info.bind(console);
  t.mock.method(console, 'info', (event: unknown, ...rest: unknown[]) => {
    if ((event as { event?: string } | undefined)?.event === 'chickpea.mcp.tools_missing') {
      events.push(event as Record<string, unknown>);
      return;
    }
    if ((event as { event?: string } | undefined)?.event === 'chickpea.mcp.http') return;
    info(event, ...rest);
  });
  return events;
}

for (const wire of ['json', 'sse'] as const) {
  test(`a granted tool the server stopped listing leaves the rest mounted in grant order (${wire})`, async (t) => {
    const missing = captureMissingTools(t);
    const server = pagedServer(wire, [['gamma', 'extra', 'alpha']]);
    await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
      assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__gamma']);
    });
    assert.deepEqual(missing, [{
      event: 'chickpea.mcp.tools_missing', connectionId: 'srv', missing: ['beta'], listedCount: 3,
    }]);
  });
}

test('a grant split across two pages mounts what each page lists and reports what is missing after the last', async (t) => {
  const missing = captureMissingTools(t);
  const server = pagedServer('sse', [['extra', 'gamma'], ['alpha']]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__gamma', 'mcp__srv__alpha']);
  });
  assert.deepEqual(missing, [{
    event: 'chickpea.mcp.tools_missing', connectionId: 'srv', missing: ['beta'], listedCount: 3,
  }]);
});

test('a full listing logs nothing and mounts the whole grant in grant order', async (t) => {
  const missing = captureMissingTools(t);
  const server = pagedServer('json', [['gamma', 'beta', 'alpha']]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__beta', 'mcp__srv__gamma']);
  });
  assert.deepEqual(missing, []);
});

test('a connection that lists none of its grant fails with a reason a person can act on', async (t) => {
  const missing = captureMissingTools(t);
  for (const wire of ['json', 'sse'] as const) {
    const server = pagedServer(wire, [['extra']]);
    await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
      await assert.rejects(
        createMcpConnection(definition),
        /^Error: Example Tools no longer offers any of the tools this Agent may use\./,
      );
    });
  }
  assert.deepEqual(missing, []);
});

test('the legacy SSE transport mounts only granted tools the server still lists', async () => {
  const server = legacySseServer(['extra', 'alpha']);
  await withRuntimeConnection(connectionConfig({ transport: 'sse' }), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha']);
  });
});

test('the legacy SSE transport never mounts an ungranted tool', async () => {
  const server = legacySseServer(['extra', 'beta', 'alpha', 'gamma']);
  await withRuntimeConnection(connectionConfig({ transport: 'sse' }), server.fetch, async (definition) => {
    assert.deepEqual(await mountedNames(definition), ['mcp__srv__alpha', 'mcp__srv__beta', 'mcp__srv__gamma']);
  });
});

test('a malformed tool listing fails the connection closed', async () => {
  for (const wire of ['json', 'sse'] as const) {
    const server = streamableServer(wire, (rpc) => ({
      jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'alpha' }, 'beta'] },
    }));
    await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
      await assert.rejects(createMcpConnection(definition), /Example Tools tool discovery returned an unsupported response/);
    });
  }
});

test('a JSON-RPC error answer to tools/list passes through untouched', async () => {
  const error = { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found' } };
  const server = streamableServer('json', () => error);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    const response = await definition.fetch!(URL_, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    assert.deepEqual(await response.json(), error);
  });
});

test('a tool call for a listed but ungranted tool is refused before it leaves Chickpea', async () => {
  const server = pagedServer('json', [['alpha', 'extra']]);
  await withRuntimeConnection(connectionConfig(), server.fetch, async (definition) => {
    await assert.rejects(definition.fetch!(URL_, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'extra', arguments: {} } }),
    }), /not selected for this Agent/);
  });
  assert.deepEqual(server.calls, []);
});

const metaHelperSchema = {
  propertyNames: ['advertiser_request', 'client_conversation_id'],
  accountFields: [],
  ambiguous: false,
  fingerprint: 'c'.repeat(64),
};
const metaScope = { [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['123450001'] };

test("Meta's account helper keeps its rewritten contract when another granted Meta tool disappears", async () => {
  const providerHelper = {
    name: META_ADS_ACCOUNT_HELPER,
    description: 'Provider pagination instructions.',
    inputSchema: { type: 'object', properties: { advertiser_request: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { accounts: { type: 'array' } }, required: ['accounts'] },
  };
  const server = pagedServer('json', [[providerHelper, 'ads_synthetic_unreviewed']]);
  const grant = [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER];
  const meta = connectionConfig({
    id: 'meta', url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads', displayName: 'Meta Ads',
    allowedTools: grant,
    discoveredTools: grant.map((name) => ({ name, inputSchema: metaHelperSchema })),
    toolPolicies: Object.fromEntries(grant.map((name) => [name, { effect: 'read' as const, argumentConstraints: metaScope }])),
  });
  await withRuntimeConnection(meta, server.fetch, async (definition) => {
    const connection = await createMcpConnection(definition);
    try {
      assert.deepEqual(connection.tools.map(({ name }) => name), [`mcp__meta__${META_ADS_ACCOUNT_HELPER}`]);
      assert.equal(connection.tools[0]!.description, META_ADS_ACCOUNT_HELPER_DESCRIPTION);
    } finally {
      await connection.close();
    }
    const listing = await definition.fetch!('https://mcp.facebook.com/ads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const { result } = await listing.json() as { result: { tools: Array<Record<string, unknown>> } };
    assert.deepEqual(result.tools.map(({ name }) => name), [META_ADS_ACCOUNT_HELPER]);
    assert.deepEqual((result.tools[0]!.outputSchema as { required: string[] }).required, ['ad_accounts']);
  }, {
    readOnlyTools: grant,
    toolArgumentConstraints: Object.fromEntries(grant.map((name) => [name, metaScope])),
  });
});
