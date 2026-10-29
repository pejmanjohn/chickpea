import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal, McpRequestHandler } from '../auth/mcp-oauth-routes.ts';
import {
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  applyWorkspaceChangesZodSchema,
  importSkillZodSchema,
  manageAgentSkillZodSchema,
  confirmWorkspaceChangeZodSchema,
  getOperationZodSchema,
  inspectWorkspaceZodSchema,
  listMcpClientsZodSchema,
  prepareConnectorSetupZodSchema,
  prepareProviderSetupZodSchema,
  discoverSlackChannelsZodSchema,
  testConnectionZodSchema,
  inspectMemoryZodSchema,
  inspectRoutinesZodSchema,
  exportRecipeZodSchema,
  previewRecipeZodSchema,
  MCP_MANAGEMENT_OPERATION_KINDS,
  revokeMcpClientZodSchema,
  revokeSetupLinkZodSchema,
  undoWorkspaceChangeZodSchema,
} from './schemas.ts';
import { AGENT_AUTHORING_GUIDE_URI } from './agent-authoring/index.ts';
import { codingAgentAuthoringGuideResource } from './agent-authoring/mcp-guide.ts';
import { WorkspaceManagementService } from './service.ts';
import { workspaceManagementInstructions } from './instructions.ts';
import {
  registerWorkspaceManagementPrompts,
  WORKSPACE_MANAGEMENT_PROMPT_NAMES,
} from './prompts.ts';
import { createLiveWorkspaceManagementService } from './live-service.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import {
  invokeWorkspaceManagementTool,
  workspaceManagementToolDescription,
  type WorkspaceManagementToolName,
  type WorkspaceManagementToolResult,
} from './tool-adapter.ts';
import type { ManagementActorContext, ManagementOperation } from './types.ts';

export const WORKSPACE_MANAGEMENT_SERVER_INFO = {
  name: 'chickpea-workspace',
  version: '4.0.0',
} as const;
/** The coding-agent door has no propose tools: it acts with the person's Admin authority. */
export const WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES = [
  'inspect_workspace',
  'prepare_connector_setup',
  'prepare_provider_setup',
  'discover_slack_channels',
  'test_connection',
  'inspect_memory',
  'inspect_routines',
  'export_workspace_recipe',
  'preview_workspace_recipe',
  'import_skill',
  'manage_agent_skill',
  'apply_workspace_changes',
  'confirm_workspace_change',
  'undo_workspace_change',
  'get_operation',
  'revoke_setup_link',
  'list_mcp_clients',
  'revoke_mcp_client',
] as const satisfies readonly WorkspaceManagementToolName[];
const READ_ONLY = { readOnlyHint: true } as const;
/** destructiveHint defaults to true, so a write the person need not confirm says false. */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
export const WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI =
  'chickpea://schema/operations/v2' as const;
export const WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI =
  AGENT_AUTHORING_GUIDE_URI;
interface WorkspaceManagementMcpServerInput {
  principal: McpAuthenticatedPrincipal;
  service: WorkspaceManagementService;
  /** Public base URL of this deployment, used to make the Admin links in `instructions` real. */
  baseUrl?: string;
  /** This deployment's env: instructions and prompts name only the Settings sections its Admin shows. */
  env?: PlatformEnv;
}

export function createWorkspaceManagementMcpHandler(
  principal: McpAuthenticatedPrincipal,
  env?: PlatformEnv,
  setupBaseUrl?: string,
  productTelemetry?: ProductTelemetryCapture,
): McpRequestHandler {
  const service = createLiveWorkspaceManagementService(env, {
    overrides: {
      ...(setupBaseUrl ? { setupBaseUrl } : {}),
      ...(productTelemetry ? { productTelemetry } : {}),
    },
  });
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({
      principal,
      service,
      ...(setupBaseUrl ? { baseUrl: setupBaseUrl } : {}),
      ...(env ? { env } : {}),
    }),
    { legacy: 'stateless' },
  );
  return handler.fetch;
}

export function createWorkspaceManagementMcpServer(
  input: WorkspaceManagementMcpServerInput,
): McpServer {
  const server = new McpServer(WORKSPACE_MANAGEMENT_SERVER_INFO, {
    instructions: workspaceManagementInstructions(input.baseUrl, input.env),
  });
  const adapter = {
    service: input.service,
    resolveContext: async () => mcpActorContext(input.principal),
  };

  server.registerTool('inspect_workspace', {
    title: 'Inspect Chickpea workspace',
    description: workspaceManagementToolDescription('inspect_workspace', 'mcp'),
    inputSchema: inspectWorkspaceZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_workspace',
    args,
  )));

  server.registerTool('prepare_connector_setup', {
    title: 'Prepare Agent connector setup',
    description: workspaceManagementToolDescription('prepare_connector_setup', 'mcp'),
    inputSchema: prepareConnectorSetupZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'prepare_connector_setup',
    args,
  )));

  server.registerTool('prepare_provider_setup', {
    title: 'Prepare model provider key setup',
    description: workspaceManagementToolDescription('prepare_provider_setup', 'mcp'),
    inputSchema: prepareProviderSetupZodSchema,
    annotations: { ...WRITE, idempotentHint: false },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'prepare_provider_setup',
    args,
  )));

  server.registerTool('discover_slack_channels', {
    title: 'Discover Slack Channels',
    description: workspaceManagementToolDescription('discover_slack_channels', 'mcp'),
    inputSchema: discoverSlackChannelsZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'discover_slack_channels',
    args,
  )));

  server.registerTool('test_connection', {
    title: 'Test saved connection',
    description: workspaceManagementToolDescription('test_connection', 'mcp'),
    inputSchema: testConnectionZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'test_connection',
    args,
  )));

  server.registerTool('inspect_memory', {
    title: 'Inspect Chickpea memory',
    description: workspaceManagementToolDescription('inspect_memory', 'mcp'),
    inputSchema: inspectMemoryZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_memory',
    args,
  )));

  server.registerTool('inspect_routines', {
    title: 'Inspect Chickpea routines',
    description: workspaceManagementToolDescription('inspect_routines', 'mcp'),
    inputSchema: inspectRoutinesZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_routines',
    args,
  )));

  server.registerTool('export_workspace_recipe', {
    title: 'Export Chickpea workspace recipe',
    description: workspaceManagementToolDescription('export_workspace_recipe', 'mcp'),
    inputSchema: exportRecipeZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'export_workspace_recipe',
    args,
  )));

  server.registerTool('preview_workspace_recipe', {
    title: 'Preview Chickpea workspace recipe',
    description: workspaceManagementToolDescription('preview_workspace_recipe', 'mcp'),
    inputSchema: previewRecipeZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'preview_workspace_recipe',
    args,
  )));

  server.registerTool('import_skill', {
    title: 'Install GitHub skill',
    description: workspaceManagementToolDescription('import_skill', 'mcp'),
    inputSchema: importSkillZodSchema,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'import_skill',
    args,
  )));

  server.registerTool('manage_agent_skill', {
    title: 'Manage an installed Agent skill',
    description: workspaceManagementToolDescription('manage_agent_skill', 'mcp'),
    inputSchema: manageAgentSkillZodSchema,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'manage_agent_skill',
    args,
  )));

  server.registerTool('apply_workspace_changes', {
    title: 'Apply Chickpea workspace changes',
    description: workspaceManagementToolDescription('apply_workspace_changes', 'mcp'),
    inputSchema: applyWorkspaceChangesZodSchema,
    annotations: WRITE,
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
    description: workspaceManagementToolDescription('confirm_workspace_change', 'mcp'),
    inputSchema: confirmWorkspaceChangeZodSchema,
    annotations: { ...WRITE, destructiveHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'confirm_workspace_change',
    args,
  )));

  server.registerTool('undo_workspace_change', {
    title: 'Undo Chickpea workspace change',
    description: workspaceManagementToolDescription('undo_workspace_change', 'mcp'),
    inputSchema: undoWorkspaceChangeZodSchema,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'undo_workspace_change',
    args,
  )));

  server.registerTool('get_operation', {
    title: 'Get Chickpea operation',
    description: workspaceManagementToolDescription('get_operation', 'mcp'),
    inputSchema: getOperationZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'get_operation',
    args,
  )));

  server.registerTool('revoke_setup_link', {
    title: 'Revoke Chickpea setup link',
    description: workspaceManagementToolDescription('revoke_setup_link', 'mcp'),
    inputSchema: revokeSetupLinkZodSchema,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'revoke_setup_link',
    args,
  )));

  server.registerTool('list_mcp_clients', {
    title: 'List connected MCP clients',
    description: workspaceManagementToolDescription('list_mcp_clients', 'mcp'),
    inputSchema: listMcpClientsZodSchema,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'list_mcp_clients',
    args,
  )));

  server.registerTool('revoke_mcp_client', {
    title: 'Revoke a connected MCP client',
    description: workspaceManagementToolDescription('revoke_mcp_client', 'mcp'),
    inputSchema: revokeMcpClientZodSchema,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'revoke_mcp_client',
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
        tools: WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES,
        prompts: WORKSPACE_MANAGEMENT_PROMPT_NAMES,
        operationKinds: MCP_MANAGEMENT_OPERATION_KINDS,
        activation: 'next_turn',
        confirmation: 'Only a destructive change returns confirmation_required, with presentation.markdown and a proposalId. Pass the proposalId to confirm_workspace_change after the person agrees.',
      }),
    }],
  }));

  server.registerResource(
    'agent-authoring-guide',
    WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI,
    {
      title: 'Chickpea Agent-authoring guide',
      description: 'Versioned guidance for exploring, creating, and editing Chickpea Agents, written for a coding agent on this connection. Pass its version as guideVersion.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(codingAgentAuthoringGuideResource()),
      }],
    }),
  );

  registerWorkspaceManagementPrompts(server, input.baseUrl, input.env);

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
