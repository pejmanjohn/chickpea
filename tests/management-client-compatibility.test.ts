import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { validatePublicMcpClientRegistration } from '../src/auth/mcp-oauth.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { WORKSPACE_MANAGEMENT_TOOL_NAMES } from '../src/management/tool-adapter.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const CLIENTS = [
  { name: 'Codex CLI/Desktop', protocol: '2025-11-25', redirect: 'http://127.0.0.1:47321/callback' },
  { name: 'Claude Code', protocol: '2025-11-25', redirect: 'http://localhost:49321/callback' },
  { name: 'MCP Inspector', protocol: '2026-07-28', redirect: 'https://inspector.example/callback' },
] as const;

test('supported coding clients share public PKCE registration and stateless MCP discovery', async () => {
  const f = await createManagementAdapterFixture('client-matrix');
  try {
    const principal: McpAuthenticatedPrincipal = {
      betterAuthUserId: f.admin.binding.betterAuthUserId,
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      role: 'admin',
      clientId: 'client_compatibility',
    };
    const handler = createMcpHandler(
      () => createWorkspaceManagementMcpServer({ principal, service: f.service }),
      { legacy: 'stateless' },
    );

    for (const client of CLIENTS) {
      assert.equal(validatePublicMcpClientRegistration({
        application_type: client.redirect.startsWith('http://') ? 'native' : 'web',
        client_name: client.name,
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [client.redirect],
        response_types: ['code'],
        scope: 'chickpea:workspace',
        token_endpoint_auth_method: 'none',
      }).ok, true, client.name);

      const listed = await mcpCall(handler.fetch, client.protocol, 'tools/list', {});
      assert.deepEqual(
        (listed.result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name),
        WORKSPACE_MANAGEMENT_TOOL_NAMES,
        client.name,
      );
      const inspected = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'inspect_workspace',
        arguments: {},
      });
      const inspectedResult = JSON.parse((inspected.result as {
        content: Array<{ text: string }>;
      }).content[0]!.text);
      assert.equal(inspectedResult.ok, true, client.name);
    }
  } finally {
    f.close();
  }
});

async function mcpCall(
  fetch: (request: Request) => Promise<Response>,
  protocol: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': protocol,
      ...(protocol === '2026-07-28' ? { 'mcp-method': method } : {}),
      ...(protocol === '2026-07-28' && method === 'tools/call' && typeof params.name === 'string'
        ? { 'mcp-name': params.name }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${protocol}:${method}`,
      method,
      params: protocol === '2026-07-28' ? {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      } : params,
    }),
  }));
  const body = await response.text();
  assert.equal(response.status, 200, body);
  if (body.trimStart().startsWith('{')) return JSON.parse(body);
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, 'MCP response did not contain a JSON or SSE data result.');
  return JSON.parse(data.slice('data: '.length));
}
