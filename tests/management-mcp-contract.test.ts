import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import {
  withManagementAdapterFixture,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';

function mcpHandler(f: ManagementAdapterFixture) {
  return createMcpHandler(() => createWorkspaceManagementMcpServer({
    principal: {
      betterAuthUserId: f.owner.binding.betterAuthUserId!,
      userId: f.owner.user.id,
      membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId,
      role: 'owner',
      clientId: 'first-ask-mcp',
    },
    service: f.service,
    baseUrl: 'http://localhost',
  }), { legacy: 'stateless' });
}

function createAgentCall(firstAsk: string) {
  return {
    name: 'apply_workspace_changes',
    arguments: {
      idempotencyKey: `first-ask-${firstAsk.length}`,
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        firstAsk,
        agent: {
          id: `agent_first_ask_${firstAsk.length}`,
          name: 'CRM Desk',
          instructions: 'Answer from the CRM.',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      }],
    },
  };
}

test('create_agent over MCP refuses a firstAsk longer than 200 characters, and takes and stores one of 200', () =>
  withManagementAdapterFixture('first-ask-mcp', async (f) => {
    const handler = mcpHandler(f);
    const listed = await mcpCall(handler.fetch, 'tools/list', {}) as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    const apply = JSON.stringify(listed.tools.find(({ name }) => name === 'apply_workspace_changes')?.inputSchema);
    assert.match(apply, /"firstAsk":\{[^}]*"maxLength":200/, 'clients see the bound before they call');

    const tooLong = await mcpCall(handler.fetch, 'tools/call', createAgentCall('a'.repeat(201))) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.content[0]!.text, /^Input validation error: .*firstAsk/);
    assert.match(tooLong.content[0]!.text, /200/);
    await assert.rejects(f.config.getAgent('agent_first_ask_201'), 'nothing is created');

    const longest = await mcpCall(handler.fetch, 'tools/call', createAgentCall('a'.repeat(200))) as {
      structuredContent: { ok: boolean; result: { operationId: string } };
    };
    assert.equal(longest.structuredContent.ok, true, JSON.stringify(longest));
    const welcome = await f.management.getOutboxForOperation(longest.structuredContent.result.operationId);
    assert.ok(welcome && 'kind' in welcome.receipt && welcome.receipt.kind === 'agent_created_welcome');
    assert.equal(welcome.receipt.firstAsk, 'a'.repeat(200));
    assert.equal(await f.config.getAgentFirstAsk('agent_first_ask_200'), 'a'.repeat(200));
  }));

async function mcpCall(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  }));
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const json = body.trimStart().startsWith('{')
    ? body
    : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
  return (JSON.parse(json) as { result: unknown }).result;
}
