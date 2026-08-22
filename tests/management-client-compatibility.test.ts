import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { validatePublicMcpClientRegistration } from '../src/auth/mcp-oauth.ts';
import {
  createWorkspaceManagementMcpServer,
  WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI,
  WORKSPACE_MANAGEMENT_SERVER_INFO,
} from '../src/management/mcp.ts';
import { MANAGEMENT_OPERATION_KINDS } from '../src/management/schemas.ts';
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
      betterAuthUserId: f.admin.binding.betterAuthUserId!,
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      role: 'admin',
      clientId: 'client_compatibility',
    };
    const agent = await f.config.createAgent({
      id: 'agent_mcp_connector',
      name: 'MCP Connector Agent',
      creatorMembershipId: f.admin.membership.id,
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Use configured connectors.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
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

      if (client.protocol !== '2026-07-28') {
        const initialized = await mcpCall(handler.fetch, client.protocol, 'initialize', {
          protocolVersion: client.protocol,
          capabilities: {},
          clientInfo: { name: client.name, version: '1.0.0' },
        });
        assert.equal((initialized.result as {
          serverInfo: { version: string };
        }).serverInfo.version, WORKSPACE_MANAGEMENT_SERVER_INFO.version, client.name);
      }

      const listed = await mcpCall(handler.fetch, client.protocol, 'tools/list', {});
      const listedTools = (listed.result as {
        tools: Array<{ name: string; inputSchema?: { required?: string[] } }>;
      }).tools;
      assert.deepEqual(
        listedTools.map(({ name }) => name),
        WORKSPACE_MANAGEMENT_TOOL_NAMES,
        client.name,
      );
      assert.ok(
        listedTools.find(({ name }) => name === 'prepare_connector_setup')
          ?.inputSchema?.required?.includes('agentId'),
        `${client.name} must require an explicit Agent for connector setup`,
      );
      const inspected = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'inspect_workspace',
        arguments: {},
      });
      const inspectedResult = JSON.parse((inspected.result as {
        content: Array<{ text: string }>;
      }).content[0]!.text);
      assert.equal(inspectedResult.ok, true, client.name);
      assert.ok(
        inspectedResult.result.connectors.some((connector: { id: string }) => connector.id === 'gmail'),
        `${client.name} should discover the connector catalog`,
      );

      const connectorHandoff = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'prepare_connector_setup',
        arguments: { agentId: agent.id, connector: 'Gmail', ownerKind: 'member' },
      });
      const connectorResult = JSON.parse((connectorHandoff.result as {
        content: Array<{ text: string }>;
      }).content[0]!.text) as { ok: boolean; result: { handoffUrl: string } };
      assert.equal(connectorResult.ok, true, client.name);
      assert.equal(
        new URL(connectorResult.result.handoffUrl).pathname,
        '/admin/agents/agent_mcp_connector/connections/new/gmail/member',
        client.name,
      );

      const missingAgent = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'prepare_connector_setup',
        arguments: { connector: 'Gmail' },
      });
      assert.equal((missingAgent.result as { isError?: boolean }).isError, true, client.name);

      const operationSchema = await mcpCall(handler.fetch, client.protocol, 'resources/read', {
        uri: WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI,
      });
      const resource = (operationSchema.result as {
        contents: Array<{ uri: string; text: string }>;
      }).contents[0]!;
      assert.equal(resource.uri, WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI);
      const contract = JSON.parse(resource.text) as {
        schemaVersion: number;
        operationKinds: string[];
      };
      assert.equal(contract.schemaVersion, 2);
      assert.deepEqual(contract.operationKinds, MANAGEMENT_OPERATION_KINDS);
    }
  } finally {
    f.close();
  }
});

test('workspace management MCP publishes the version 2 server contract', () => {
  assert.deepEqual(WORKSPACE_MANAGEMENT_SERVER_INFO, {
    name: 'chickpea-workspace',
    version: '2.0.0',
  });
  assert.match(WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI, /\/v2$/);
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
      ...(protocol === '2026-07-28' && method === 'resources/read' && typeof params.uri === 'string'
        ? { 'mcp-name': params.uri }
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
