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
    name: 'create_agent',
    arguments: {
      agentId: `agent_first_ask_${firstAsk.length}`,
      name: 'CRM Desk',
      instructions: 'Answer from the CRM.',
      firstAsk,
      idempotencyKey: `first-ask-${firstAsk.length}`,
    },
  };
}

test('create_agent over MCP refuses a firstAsk longer than 200 characters, and takes and stores one of 200', () =>
  withManagementAdapterFixture('first-ask-mcp', async (f) => {
    const handler = mcpHandler(f);
    const listed = await mcpCall(handler.fetch, 'tools/list', {}) as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    const create = JSON.stringify(listed.tools.find(({ name }) => name === 'create_agent')?.inputSchema);
    assert.match(create, /"firstAsk":\{[^}]*"maxLength":200/, 'clients see the bound before they call');

    const tooLong = await mcpCall(handler.fetch, 'tools/call', createAgentCall('a'.repeat(201))) as {
      isError?: boolean;
      structuredContent: { error: { code: string; nextStep: string } };
    };
    assert.equal(tooLong.isError, true);
    assert.equal(tooLong.structuredContent.error.code, 'invalid_input');
    assert.match(tooLong.structuredContent.error.nextStep, /firstAsk/);
    assert.match(tooLong.structuredContent.error.nextStep, /200/);
    await assert.rejects(f.config.getAgent('agent_first_ask_201'), 'nothing is created');

    const longest = await mcpCall(handler.fetch, 'tools/call', createAgentCall('a'.repeat(200))) as {
      isError?: boolean;
      structuredContent: { status: string };
    };
    assert.equal(longest.isError, undefined, JSON.stringify(longest));
    assert.equal(longest.structuredContent.status, 'done', JSON.stringify(longest));
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
