import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlueEventContext, FlueExecutionContext, FlueObservation } from '@flue/runtime';
import type { SecureFetch } from 'just-bash';
import { MANAGED_SUBMISSION_AGENT_NAMES } from '../src/agents/names.ts';
import { createScopedFetch } from '../src/config/egress.ts';
import { resolveRuntimePlanMcpConnections } from '../src/config/profile-mcp.ts';
import { createManagedConnectionTools } from '../src/connections/managed-tools.ts';
import {
  assertArtifactDeliveryAllowed,
  memoryToolPolicyInterceptor,
  observeMemoryToolPolicy,
  serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';

async function submission<T>(agentName: string, request: string, run: (context: FlueExecutionContext) => Promise<T>) {
  const context = { agentName, submissionId: 'capability-permissions' };
  return memoryToolPolicyInterceptor(
    { type: 'agent', operationId: 'capability-permissions', operationKind: 'prompt' }, context,
    async () => {
      observeMemoryToolPolicy({ type: 'turn_request', purpose: 'agent', request: {
        input: { messages: [{ role: 'user', content: serializeCurrentRequestEnvelope(request, false) }] },
      } } as unknown as FlueObservation, context as unknown as FlueEventContext);
      return run(context);
    },
  );
}

for (const agentName of MANAGED_SUBMISSION_AGENT_NAMES) {
  test(`${agentName}: custom tool capabilities do not depend on request or tool-name verbs`, async () => {
    const id = 'connection_0123456789abcdef0123456789abcdef';
    for (const request of [
      'give me an update on TOEFL bookings in 5 minutes',
      'Provide an update on TOEFL sales bookings using read-only SQL Dash queries; use America/Los_Angeles for today and whole-dollar formatting.',
      'Yes, use the details we agreed on.',
    ]) {
      await submission(agentName, request, async (context) => {
        for (const tool of ['run_query', 'get_query', 'send_message', 'delete_record']) {
          assert.equal(await memoryToolPolicyInterceptor(
            { type: 'tool', toolCallId: tool, toolName: `mcp__${id}__${tool}` }, context,
            async () => 'approved tool executed',
          ), 'approved tool executed');
        }
      });
    }
  });

  test(`${agentName}: REST enforces selected methods and scopes rather than request words`, async () => {
    const calls: string[] = [];
    const delegate: SecureFetch = async (url) => { calls.push(url); return {} as Awaited<ReturnType<SecureFetch>>; };
    const scoped = createScopedFetch({
      scopes: [
        { prefixes: ['https://api.example.com/read'], methods: new Set(['GET', 'HEAD']), delegate },
        { prefixes: ['https://api.example.com/write'], methods: new Set(['GET', 'POST', 'DELETE']), delegate },
      ], baseDelegate: delegate, baseMethods: new Set(['GET', 'HEAD']),
    });
    await submission(agentName, 'Yes, use the details we agreed on.', async () => {
      await scoped('https://api.example.com/write/items', { method: 'POST' });
      await scoped('https://api.example.com/write/items/1', { method: 'DELETE' });
      for (const url of ['https://api.example.com/read/items', 'https://api.example.com/writer/items', 'https://other.example.com/write/items']) {
        await assert.rejects(scoped(url, { method: 'POST' }), { name: 'MethodNotAllowedError' });
      }
    });
    assert.deepEqual(calls, ['https://api.example.com/write/items', 'https://api.example.com/write/items/1']);
  });

  test(`${agentName}: selected managed writes reach provider; unselected capabilities are not mounted`, async () => {
    let calls = 0;
    const tools = createManagedConnectionTools({
      workspaceId: 'T_FIXTURE', agentId: 'agent_fixture', actorMembershipId: 'membership_fixture',
      connections: [{ id: 'connection_fixture', providerId: 'google', adapterId: 'composio', toolkit: 'googlesheets', allowedCapabilities: ['sheets.values.update'] }],
      resolvePlatformEnv: async () => undefined,
      resolveProviders: async () => { calls++; throw new Error('provider-boundary-reached'); },
    });
    assert.deepEqual(tools.map(t => t.name), ['google_sheets_update_values']);
    await submission(agentName, 'Yes, use the details we agreed on.', async () => {
      await assert.rejects((tools[0]!.run as (input: unknown) => Promise<unknown>)({
        data: { spreadsheetId: 'fixture-sheet', range: 'Fixture!B3', values: [['after']] },
      }), /provider-boundary-reached/);
    });
    assert.equal(calls, 1);
  });
}

test('MCP mount retains the selected tool list and explicit argument restrictions', async () => {
  const [connection] = resolveRuntimePlanMcpConnections('missing-agent', [{
    id: 'connection_fixture', url: 'https://mcp.example.com/mcp', transport: 'streamable-http',
    authMode: 'none', headerNames: [], optional: true, allowedTools: ['run_query'],
    toolArgumentConstraints: { run_query: { data_source: ['postgres'] } },
  }]);
  assert.deepEqual(connection!.tools, ['run_query']);
  await assert.rejects(connection!.fetch!('https://mcp.example.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'unselected_tool', arguments: {},
    } }),
  }), /not selected/);
  await assert.rejects(connection!.fetch!('https://mcp.example.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'run_query', arguments: { data_source: 'redshift', sql_text: 'SELECT 1' },
    } }),
  }), /approved value/);
});

test('connector permission does not bypass the separate artifact delivery contract', async () => {
  for (const agentName of MANAGED_SUBMISSION_AGENT_NAMES) {
    await submission(agentName, 'Read today’s bookings.', async () => {
      assert.throws(assertArtifactDeliveryAllowed, { name: 'CurrentRequestSideEffectDeniedError' });
    });
    await submission(agentName, 'Create a report file.', async () => {
      assert.doesNotThrow(assertArtifactDeliveryAllowed);
    });
  }
});


test('MCP outbound allowlist applies without argument constraints and rejects batch bypasses', async () => {
  const [connection] = resolveRuntimePlanMcpConnections('missing-agent', [{
    id: 'connection_fixture', url: 'https://mcp.example.com/mcp', transport: 'streamable-http',
    authMode: 'none', headerNames: [], optional: true, allowedTools: ['run_query'],
  }]);
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unselected_tool', arguments: {} } };
  for (const [body, error] of [[call, /not selected/], [[call], /Invalid MCP/], [null, /Invalid MCP/]] as const) {
    await assert.rejects(connection!.fetch!('https://mcp.example.com/mcp', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }), error);
  }
});
