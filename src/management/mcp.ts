import { McpServer, createMcpHandler, type Transport } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import type { McpAuthenticatedPrincipal, McpRequestHandler } from '../auth/mcp-oauth-routes.ts';
import {
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  applyWorkspaceChangesZodSchema,
  importSkillZodSchema,
  uploadSkillsZodSchema,
  manageAgentSkillZodSchema,
  confirmWorkspaceChangeZodSchema,
  getOperationZodSchema,
  inspectWorkspaceZodSchema,
  listMcpClientsZodSchema,
  prepareConnectorSetupZodSchema,
  prepareProviderSetupZodSchema,
  discoverSlackChannelsZodSchema,
  testConnectionZodSchema,
  saveConnectionKeyZodSchema,
  tryConnectionZodSchema,
  inspectMemoryZodSchema,
  inspectRoutinesZodSchema,
  exportRecipeZodSchema,
  previewRecipeZodSchema,
  MANAGEMENT_OPERATION_SCHEMA_URI,
  MCP_MANAGEMENT_OPERATION_KINDS,
  revokeMcpClientZodSchema,
  revokeSetupLinkZodSchema,
  undoWorkspaceChangeZodSchema,
} from './schemas.ts';
import { AGENT_AUTHORING_GUIDE_URI, DISCOVERY_GUIDE_URI } from './agent-authoring/index.ts';
import { DISCOVERY_GUIDE } from './agent-authoring/discovery-guide.ts';
import { codingAgentAuthoringGuideResource } from './agent-authoring/mcp-guide.ts';
import { WorkspaceManagementService } from './service.ts';
import { workspaceManagementInstructions } from './instructions.ts';
import {
  registerWorkspaceManagementPrompts,
  WORKSPACE_MANAGEMENT_PROMPT_NAMES,
} from './prompts.ts';
import { createLiveWorkspaceManagementService } from './live-service.ts';
import { observeMcpRequests } from './mcp-request-telemetry.ts';
import {
  FIVE_ZERO_TOOL_INPUT_SCHEMAS,
  FIVE_ZERO_TOOL_NAMES,
  registerFiveZeroTools,
} from './mcp-v5/tools.ts';
import { shapeFiveZeroResults } from './mcp-v5/transport.ts';
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
  version: '4.4.0',
} as const;
/**
 * The 4.x tools, backed by the shared tool adapter. The coding-agent door has
 * no propose_workspace_changes: it acts with the person's Admin authority.
 */
export const WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES = [
  'inspect_workspace',
  'prepare_connector_setup',
  'prepare_provider_setup',
  'discover_slack_channels',
  'test_connection',
  'save_connection_key',
  'try_connection',
  'inspect_memory',
  'inspect_routines',
  'export_workspace_recipe',
  'preview_workspace_recipe',
  'import_skill',
  'upload_skills',
  'manage_agent_skill',
  'apply_workspace_changes',
  'confirm_workspace_change',
  'undo_workspace_change',
  'get_operation',
  'revoke_setup_link',
  'list_mcp_clients',
  'revoke_mcp_client',
] as const satisfies readonly WorkspaceManagementToolName[];
/** Every tool `tools/list` shows, in order: the 4.x tools, then the 5.0 tools 4.3 and 4.4 add. */
export const WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES: readonly string[] = [
  ...WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES,
  ...FIVE_ZERO_TOOL_NAMES,
];
const FIVE_ZERO_TOOL_NAME_SET: ReadonlySet<string> = new Set(FIVE_ZERO_TOOL_NAMES);
/** One schema per 4.x MCP tool, shared by registration and request telemetry. */
const MCP_TOOL_INPUT_SCHEMAS = {
  inspect_workspace: inspectWorkspaceZodSchema,
  prepare_connector_setup: prepareConnectorSetupZodSchema,
  prepare_provider_setup: prepareProviderSetupZodSchema,
  discover_slack_channels: discoverSlackChannelsZodSchema,
  test_connection: testConnectionZodSchema,
  save_connection_key: saveConnectionKeyZodSchema,
  try_connection: tryConnectionZodSchema,
  inspect_memory: inspectMemoryZodSchema,
  inspect_routines: inspectRoutinesZodSchema,
  export_workspace_recipe: exportRecipeZodSchema,
  preview_workspace_recipe: previewRecipeZodSchema,
  import_skill: importSkillZodSchema,
  upload_skills: uploadSkillsZodSchema,
  manage_agent_skill: manageAgentSkillZodSchema,
  apply_workspace_changes: applyWorkspaceChangesZodSchema,
  confirm_workspace_change: confirmWorkspaceChangeZodSchema,
  undo_workspace_change: undoWorkspaceChangeZodSchema,
  get_operation: getOperationZodSchema,
  revoke_setup_link: revokeSetupLinkZodSchema,
  list_mcp_clients: listMcpClientsZodSchema,
  revoke_mcp_client: revokeMcpClientZodSchema,
} as const satisfies Record<(typeof WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES)[number], z.ZodType>;

/**
 * Each transport this server connects reports an `mcp.request` metric per
 * message, and gives 5.0 results the shape the SDK cannot express.
 */
class ObservedMcpServer extends McpServer {
  override connect(transport: Transport): Promise<void> {
    observeMcpRequests(transport, { ...MCP_TOOL_INPUT_SCHEMAS, ...FIVE_ZERO_TOOL_INPUT_SCHEMAS });
    shapeFiveZeroResults(transport, FIVE_ZERO_TOOL_NAME_SET);
    return super.connect(transport);
  }
}

const READ_ONLY = { readOnlyHint: true } as const;
/** destructiveHint defaults to true, so a write the person need not confirm says false. */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
export const WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI = MANAGEMENT_OPERATION_SCHEMA_URI;
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
  const server = new ObservedMcpServer(WORKSPACE_MANAGEMENT_SERVER_INFO, {
    instructions: workspaceManagementInstructions(input.baseUrl, input.env),
  });
  const adapter = {
    service: input.service,
    resolveContext: async () => mcpActorContext(input.principal),
  };

  server.registerTool('inspect_workspace', {
    title: 'Inspect Chickpea workspace',
    description: workspaceManagementToolDescription('inspect_workspace', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.inspect_workspace,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_workspace',
    args,
  )));

  server.registerTool('prepare_connector_setup', {
    title: 'Prepare Agent connector setup',
    description: workspaceManagementToolDescription('prepare_connector_setup', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.prepare_connector_setup,
    // Each call issues a new setup link, as prepare_provider_setup does.
    annotations: { ...WRITE, idempotentHint: false },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'prepare_connector_setup',
    args,
  )));

  server.registerTool('prepare_provider_setup', {
    title: 'Prepare model provider key setup',
    description: workspaceManagementToolDescription('prepare_provider_setup', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.prepare_provider_setup,
    annotations: { ...WRITE, idempotentHint: false },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'prepare_provider_setup',
    args,
  )));

  server.registerTool('discover_slack_channels', {
    title: 'Discover Slack Channels',
    description: workspaceManagementToolDescription('discover_slack_channels', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.discover_slack_channels,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'discover_slack_channels',
    args,
  )));

  server.registerTool('test_connection', {
    title: 'Test saved connection',
    description: workspaceManagementToolDescription('test_connection', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.test_connection,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'test_connection',
    args,
  )));

  server.registerTool('save_connection_key', {
    title: 'Save connection key',
    description: workspaceManagementToolDescription('save_connection_key', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.save_connection_key,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'save_connection_key',
    args,
  )));

  server.registerTool('try_connection', {
    title: 'Try connection settings',
    description: workspaceManagementToolDescription('try_connection', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.try_connection,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'try_connection',
    args,
  )));

  server.registerTool('inspect_memory', {
    title: 'Inspect Chickpea memory',
    description: workspaceManagementToolDescription('inspect_memory', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.inspect_memory,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_memory',
    args,
  )));

  server.registerTool('inspect_routines', {
    title: 'Inspect Chickpea routines',
    description: workspaceManagementToolDescription('inspect_routines', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.inspect_routines,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_routines',
    args,
  )));

  server.registerTool('export_workspace_recipe', {
    title: 'Export Chickpea workspace recipe',
    description: workspaceManagementToolDescription('export_workspace_recipe', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.export_workspace_recipe,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'export_workspace_recipe',
    args,
  )));

  server.registerTool('preview_workspace_recipe', {
    title: 'Preview Chickpea workspace recipe',
    description: workspaceManagementToolDescription('preview_workspace_recipe', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.preview_workspace_recipe,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'preview_workspace_recipe',
    args,
  )));

  server.registerTool('import_skill', {
    title: 'Install GitHub skill',
    description: workspaceManagementToolDescription('import_skill', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.import_skill,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'import_skill',
    args,
  )));

  server.registerTool('upload_skills', {
    title: 'Upload skill files',
    description: workspaceManagementToolDescription('upload_skills', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.upload_skills,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'upload_skills',
    args,
  )));

  server.registerTool('manage_agent_skill', {
    title: 'Manage an installed Agent skill',
    description: workspaceManagementToolDescription('manage_agent_skill', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.manage_agent_skill,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'manage_agent_skill',
    args,
  )));

  server.registerTool('apply_workspace_changes', {
    title: 'Apply Chickpea workspace changes',
    description: workspaceManagementToolDescription('apply_workspace_changes', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.apply_workspace_changes,
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
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.confirm_workspace_change,
    annotations: { ...WRITE, destructiveHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'confirm_workspace_change',
    args,
  )));

  server.registerTool('undo_workspace_change', {
    title: 'Undo Chickpea workspace change',
    description: workspaceManagementToolDescription('undo_workspace_change', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.undo_workspace_change,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'undo_workspace_change',
    args,
  )));

  server.registerTool('get_operation', {
    title: 'Get Chickpea operation',
    description: workspaceManagementToolDescription('get_operation', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.get_operation,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'get_operation',
    args,
  )));

  server.registerTool('revoke_setup_link', {
    title: 'Revoke Chickpea setup link',
    description: workspaceManagementToolDescription('revoke_setup_link', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.revoke_setup_link,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'revoke_setup_link',
    args,
  )));

  server.registerTool('list_mcp_clients', {
    title: 'List connected MCP clients',
    description: workspaceManagementToolDescription('list_mcp_clients', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.list_mcp_clients,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'list_mcp_clients',
    args,
  )));

  server.registerTool('revoke_mcp_client', {
    title: 'Revoke a connected MCP client',
    description: workspaceManagementToolDescription('revoke_mcp_client', 'mcp'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.revoke_mcp_client,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'revoke_mcp_client',
    args,
  )));

  registerFiveZeroTools(server, {
    service: input.service,
    context: adapter.resolveContext,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.env ? { env: input.env } : {}),
  });

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

  server.registerResource('discovery-guide', DISCOVERY_GUIDE_URI, {
    title: 'Find the first Chickpea Agent',
    description: 'Read before you propose an Agent whose job the person has not named: how to research their recent work on this machine and propose one specific Agent.',
    mimeType: 'text/markdown',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: DISCOVERY_GUIDE }],
  }));

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
