import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal, McpRequestHandler } from '../auth/mcp-oauth-routes.ts';
import {
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  applyWorkspaceChangesZodSchema,
  proposeWorkspaceChangesZodSchema,
  confirmWorkspaceChangeZodSchema,
  getOperationZodSchema,
  inspectWorkspaceZodSchema,
  prepareConnectorSetupZodSchema,
  discoverSlackChannelsZodSchema,
  testMcpConnectionZodSchema,
  inspectMemoryZodSchema,
  inspectRoutinesZodSchema,
  exportRecipeZodSchema,
  previewRecipeZodSchema,
  MANAGEMENT_OPERATION_KINDS,
  revokeSetupLinkZodSchema,
  undoWorkspaceChangeZodSchema,
} from './schemas.ts';
import {
  AGENT_AUTHORING_GUIDE,
  AGENT_AUTHORING_GUIDE_DIGEST,
  AGENT_AUTHORING_GUIDE_URI,
  AGENT_AUTHORING_GUIDE_VERSION,
  AGENT_SKILL_CREATION_GUIDE,
} from './agent-authoring/index.ts';
import { WorkspaceManagementService } from './service.ts';
import { createLiveWorkspaceManagementService } from './live-service.ts';
import {
  invokeWorkspaceManagementTool,
  workspaceManagementToolDescription,
  WORKSPACE_MANAGEMENT_TOOL_NAMES,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolResult,
} from './tool-adapter.ts';
import type { ManagementActorContext, ManagementOperation } from './types.ts';

export const WORKSPACE_MANAGEMENT_SERVER_INFO = {
  name: 'chickpea-workspace',
  version: '2.1.0',
} as const;
export const WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI =
  'chickpea://schema/operations/v2' as const;
export const WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI =
  AGENT_AUTHORING_GUIDE_URI;
export interface WorkspaceManagementMcpServerInput {
  principal: McpAuthenticatedPrincipal;
  service: WorkspaceManagementService;
}

export function createWorkspaceManagementMcpHandler(
  principal: McpAuthenticatedPrincipal,
  env?: PlatformEnv,
  setupBaseUrl?: string,
): McpRequestHandler {
  const service = createLiveWorkspaceManagementService(env, {
    ...(setupBaseUrl ? { overrides: { setupBaseUrl } } : {}),
  });
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service }),
    { legacy: 'stateless' },
  );
  return handler.fetch;
}

export function createWorkspaceManagementMcpServer(
  input: WorkspaceManagementMcpServerInput,
): McpServer {
  const server = new McpServer(WORKSPACE_MANAGEMENT_SERVER_INFO);
  const adapter = {
    service: input.service,
    resolveContext: async () => mcpActorContext(input.principal),
  };

  server.registerTool('inspect_workspace', {
    title: 'Inspect Chickpea workspace',
    description: workspaceManagementToolDescription('inspect_workspace'),
    inputSchema: inspectWorkspaceZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_workspace',
    args,
  )));

  server.registerTool('prepare_connector_setup', {
    title: 'Prepare Agent connector setup',
    description: workspaceManagementToolDescription('prepare_connector_setup'),
    inputSchema: prepareConnectorSetupZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'prepare_connector_setup',
    args,
  )));

  server.registerTool('discover_slack_channels', {
    title: 'Discover Slack Channels',
    description: workspaceManagementToolDescription('discover_slack_channels'),
    inputSchema: discoverSlackChannelsZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'discover_slack_channels',
    args,
  )));

  server.registerTool('test_mcp_connection', {
    title: 'Test saved MCP connection',
    description: workspaceManagementToolDescription('test_mcp_connection'),
    inputSchema: testMcpConnectionZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'test_mcp_connection',
    args,
  )));

  server.registerTool('inspect_memory', {
    title: 'Inspect Chickpea memory',
    description: workspaceManagementToolDescription('inspect_memory'),
    inputSchema: inspectMemoryZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_memory',
    args,
  )));

  server.registerTool('inspect_routines', {
    title: 'Inspect Chickpea routines',
    description: workspaceManagementToolDescription('inspect_routines'),
    inputSchema: inspectRoutinesZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_routines',
    args,
  )));

  server.registerTool('export_workspace_recipe', {
    title: 'Export Chickpea workspace recipe',
    description: workspaceManagementToolDescription('export_workspace_recipe'),
    inputSchema: exportRecipeZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'export_workspace_recipe',
    args,
  )));

  server.registerTool('preview_workspace_recipe', {
    title: 'Preview Chickpea workspace recipe',
    description: workspaceManagementToolDescription('preview_workspace_recipe'),
    inputSchema: previewRecipeZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'preview_workspace_recipe',
    args,
  )));

  server.registerTool('propose_workspace_changes', {
    title: 'Propose Chickpea workspace changes',
    description: workspaceManagementToolDescription('propose_workspace_changes'),
    inputSchema: proposeWorkspaceChangesZodSchema,
    annotations: { readOnlyHint: true, idempotentHint: false },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'propose_workspace_changes',
    { ...args, operations: args.operations as ManagementOperation[] },
  )));

  server.registerTool('apply_workspace_changes', {
    title: 'Apply Chickpea workspace changes',
    description: workspaceManagementToolDescription('apply_workspace_changes'),
    inputSchema: applyWorkspaceChangesZodSchema,
    annotations: { idempotentHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'apply_workspace_changes',
    {
      idempotencyKey: args.idempotencyKey,
      operations: args.operations as ManagementOperation[],
    },
  )));

  server.registerTool('confirm_workspace_change', {
    title: 'Confirm Chickpea workspace change',
    description: workspaceManagementToolDescription('confirm_workspace_change'),
    inputSchema: confirmWorkspaceChangeZodSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'confirm_workspace_change',
    args,
  )));

  server.registerTool('undo_workspace_change', {
    title: 'Undo Chickpea workspace change',
    description: workspaceManagementToolDescription('undo_workspace_change'),
    inputSchema: undoWorkspaceChangeZodSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'undo_workspace_change',
    args,
  )));

  server.registerTool('get_operation', {
    title: 'Get Chickpea operation',
    description: workspaceManagementToolDescription('get_operation'),
    inputSchema: getOperationZodSchema,
    annotations: { readOnlyHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'get_operation',
    args,
  )));

  server.registerTool('revoke_setup_link', {
    title: 'Revoke Chickpea setup link',
    description: workspaceManagementToolDescription('revoke_setup_link'),
    inputSchema: revokeSetupLinkZodSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'revoke_setup_link',
    args,
  )));

  server.registerResource('workspace', 'chickpea://workspace', {
    title: 'Current Chickpea workspace',
    description: 'Current non-secret Agent and Channel configuration for the authenticated workspace.',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(await invokeWorkspaceManagementTool(
        adapter,
        'inspect_workspace',
        {},
      )),
    }],
  }));

  server.registerResource('operation-schema', WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI, {
    title: 'Chickpea management operation inventory',
    description: 'Stable operation and tool names supported by this management contract.',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({
        schemaVersion: 2,
        tools: WORKSPACE_MANAGEMENT_TOOL_NAMES,
        operationKinds: MANAGEMENT_OPERATION_KINDS,
        activation: 'next_turn',
        confirmation: 'Use proposalId with confirm_workspace_change.',
      }),
    }],
  }));

  server.registerResource(
    'agent-authoring-guide',
    WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI,
    {
      title: 'Chickpea Agent-authoring guide',
      description: 'Canonical versioned guidance for exploring, creating, and editing Chickpea Agents.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          version: AGENT_AUTHORING_GUIDE_VERSION,
          digest: AGENT_AUTHORING_GUIDE_DIGEST,
          guide: AGENT_AUTHORING_GUIDE,
          files: { 'skill-creation.md': AGENT_SKILL_CREATION_GUIDE },
        }),
      }],
    }),
  );

  return server;
}

function mcpActorContext(principal: McpAuthenticatedPrincipal): ManagementActorContext {
  return {
    userId: principal.userId,
    membershipId: principal.membershipId,
    organizationId: principal.organizationId,
    origin: { kind: 'mcp', clientId: principal.clientId },
  };
}

function mcpResult(result: WorkspaceManagementToolResult) {
  const text = JSON.stringify(result);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: result,
    ...(result.ok ? {} : { isError: true }),
  };
}

export type { WorkspaceManagementToolArguments };
