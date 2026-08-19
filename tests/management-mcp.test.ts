import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { MANAGEMENT_OPERATION_KINDS } from '../src/management/schemas.ts';
import { WORKSPACE_MANAGEMENT_TOOL_NAMES } from '../src/management/tool-adapter.ts';
import {
  createManagementAdapterFixture,
  initialManagementBundle,
} from './helpers/management-adapter-fixture.ts';

test('public MCP exposes the compact workspace contract and applies an initial Agent bundle', async () => {
  const f = await createManagementAdapterFixture('mcp');
  try {
    const principal: McpAuthenticatedPrincipal = {
      betterAuthUserId: f.admin.binding.betterAuthUserId,
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      role: 'admin',
      clientId: 'client_codex',
    };
    const handler = createMcpHandler(
      () => createWorkspaceManagementMcpServer({ principal, service: f.service }),
      { legacy: 'stateless' },
    );

    const tools = await mcpCall(handler.fetch, 'tools/list', {});
    assert.deepEqual(
      (tools.result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name),
      WORKSPACE_MANAGEMENT_TOOL_NAMES,
    );
    const resources = await mcpCall(handler.fetch, 'resources/list', {});
    assert.deepEqual(
      (resources.result as { resources: Array<{ uri: string }> }).resources.map(({ uri }) => uri),
      ['chickpea://workspace', 'chickpea://schema/operations'],
    );
    const schema = await mcpCall(handler.fetch, 'resources/read', {
      uri: 'chickpea://schema/operations',
    });
    const schemaText = (schema.result as {
      contents: Array<{ text: string }>;
    }).contents[0]!.text;
    assert.deepEqual(JSON.parse(schemaText).operationKinds, MANAGEMENT_OPERATION_KINDS);

    const workspaceId = f.owner.user.slackTeamId;
    const applied = await mcpCall(handler.fetch, 'tools/call', {
      name: 'apply_workspace_changes',
      arguments: {
        idempotencyKey: 'mcp-initial-bundle',
        operations: initialManagementBundle(workspaceId, 'C_RESEARCH_MCP'),
      },
    });
    const toolResult = JSON.parse((applied.result as {
      content: Array<{ text: string }>;
    }).content[0]!.text);
    assert.equal(toolResult.ok, true);
    assert.deepEqual(
      toolResult.result.outcomes.map(({ disposition }: { disposition: string }) => disposition),
      ['applied', 'applied', 'applied'],
    );
    assert.equal((await f.config.getAssignment(workspaceId, 'C_RESEARCH_MCP'))?.agentId, 'agent_research');
    assert.equal(toolResult.result.activation, 'next_turn');
    assert.doesNotMatch(JSON.stringify(toolResult), /authorization|bearerToken|clientSecret|refreshToken/i);

    const forgedActor = await mcpCall(handler.fetch, 'tools/call', {
      name: 'inspect_workspace',
      arguments: { userId: f.owner.user.id },
    });
    assert.equal((forgedActor.result as { isError?: boolean }).isError, true);
  } finally {
    f.close();
  }
});

async function mcpCall(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}:${JSON.stringify(params)}`, method, params }),
  }));
  assert.equal(response.status, 200);
  const body = await response.text();
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, `MCP response did not contain an SSE data event: ${body}`);
  return JSON.parse(data.slice('data: '.length));
}
