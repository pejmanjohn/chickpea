import { McpServer, createMcpHandler, type Transport } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import { knownMcpCardClient } from '../auth/mcp-client-name.ts';
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
import { codingAgentAuthoringGuideResource } from './agent-authoring/mcp-guide.ts';
import { WorkspaceManagementService } from './service.ts';
import { WORKSPACE_MANAGEMENT_INSTRUCTIONS } from './instructions.ts';
import {
  registerWorkspaceManagementPrompts,
  WORKSPACE_MANAGEMENT_PROMPT_NAMES,
} from './prompts.ts';
import { createLiveWorkspaceManagementService } from './live-service.ts';
import { playbookSection } from './playbook/index.ts';
import { observeMcpRequests } from './mcp-request-telemetry.ts';
import {
  CARD_REFUSAL_TOOL_NAMES,
  FIVE_ZERO_TOOL_INPUT_SCHEMAS,
  FIVE_ZERO_TOOL_NAMES,
  registerFiveZeroTools,
  type FiveZeroToolName,
} from './mcp-v5/tools.ts';
import { declaresCards, withCardSessions } from './mcp-v5/card-host.ts';
import { registerCards } from './mcp-v5/cards.ts';
import { shapeFiveZeroResults } from './mcp-v5/transport.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import {
  invokeWorkspaceManagementTool,
  type WorkspaceManagementToolName,
  type WorkspaceManagementToolResult,
} from './tool-adapter.ts';
import type { ManagementActorContext, ManagementOperation } from './types.ts';

export const WORKSPACE_MANAGEMENT_SERVER_INFO = {
  name: 'chickpea-workspace',
  version: '4.6.0',
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
type V4ToolName = typeof WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES[number];

/**
 * The day 4.5 deprecated the 4.x tools. They keep working unchanged until
 * 5.0.0 removes them, at least 14 days after 4.5 reaches production.
 */
export const V4_TOOLS_DEPRECATED_ON = '2026-11-09';

/** The 5.0 tools that replace each 4.x tool, which its one-line description names. */
export const V4_TOOL_REPLACEMENTS = {
  inspect_workspace: ['get_workspace', 'list_agents', 'get_agent', 'list_services', 'list_models', 'list_members', 'list_slack_channels'],
  prepare_connector_setup: ['connect_service', 'reconnect_service'],
  prepare_provider_setup: ['connect_model_provider'],
  discover_slack_channels: ['list_slack_channels'],
  test_connection: ['check_agent'],
  // No 5.0 tool takes a key: the setup page asks for it and checks it.
  save_connection_key: ['connect_service', 'reconnect_service'],
  try_connection: ['connect_service'],
  inspect_memory: ['get_agent_memory'],
  inspect_routines: ['list_schedules'],
  export_workspace_recipe: ['export_agents'],
  preview_workspace_recipe: ['create_agent', 'update_agent'],
  import_skill: ['import_skill_from_github'],
  upload_skills: ['upload_skill_files'],
  manage_agent_skill: ['set_agent_skill'],
  apply_workspace_changes: ['create_agent', 'update_agent'],
  confirm_workspace_change: ['confirm_change'],
  undo_workspace_change: ['undo_change'],
  get_operation: ['get_setup_status'],
  revoke_setup_link: ['cancel_setup_link'],
  list_mcp_clients: ['list_connected_apps'],
  revoke_mcp_client: ['disconnect_app'],
} as const satisfies Record<V4ToolName, readonly FiveZeroToolName[]>;

/** Where a bare list of tools would mislead, the words that say how they replace it. */
const V4_REPLACEMENT_WORDS: Partial<Record<V4ToolName, string>> = {
  apply_workspace_changes: 'one tool per change, such as create_agent or update_agent',
  get_operation: 'get_setup_status for a setup link, or send a change again with its idempotencyKey for its result',
  try_connection: 'connect_service, whose setup page checks the key',
};

/** A 4.x tool's whole description in 4.5: the date and its replacement, in one line. */
export function deprecatedToolDescription(name: V4ToolName): string {
  const tools: readonly string[] = V4_TOOL_REPLACEMENTS[name];
  const replacement = V4_REPLACEMENT_WORDS[name] ??
    (tools.length === 1 ? tools[0]! : `${tools.slice(0, -1).join(', ')} or ${tools.at(-1)!}`);
  return `Deprecated ${V4_TOOLS_DEPRECATED_ON}: use ${replacement}.`;
}

/** Every tool `tools/list` shows, in order: the 4.x tools, then the 5.0 tools 4.3 to 4.5 add. */
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
  /**
   * The 4.x tools, and the prompts and guides that script them, which a
   * client that draws cards never gets.
   */
  readonly v4Only: Array<{ remove(): void }> = [];

  constructor(private readonly clientId: string, private readonly cardSession: boolean) {
    super(WORKSPACE_MANAGEMENT_SERVER_INFO, { instructions: WORKSPACE_MANAGEMENT_INSTRUCTIONS });
  }

  /** A known OAuth card client stays one even when its session or capabilities are missing. */
  cardHost(): boolean {
    return knownMcpCardClient(this.clientId) || this.cardSession || declaresCards(this.server.getClientCapabilities());
  }

  override connect(transport: Transport): Promise<void> {
    // A 4.x change hands the model a token that confirms without the
    // person's press, and 5.0 covers every 4.x tool, so a card host gets
    // only 5.0, and no prompt or guide that tells its model to call a 4.x
    // tool. Its capabilities are known here, after everything registers.
    const hidesV4 = this.cardHost();
    if (hidesV4) for (const registered of this.v4Only.splice(0)) registered.remove();
    // Shaped first, so the request metric reads each result as the tool made it: a refusal
    // that leaves a card session as a result still counts as a refusal.
    shapeFiveZeroResults(
      transport,
      FIVE_ZERO_TOOL_NAME_SET,
      { session: () => this.cardHost(), tools: CARD_REFUSAL_TOOL_NAMES },
      hidesV4 ? WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAME_SET : undefined,
    );
    observeMcpRequests(transport, { ...MCP_TOOL_INPUT_SCHEMAS, ...FIVE_ZERO_TOOL_INPUT_SCHEMAS });
    return super.connect(transport);
  }
}

const WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAME_SET = new Set<string>(WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES);

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
  /** The client declared cards at `initialize` (mcp-v5/card-host.ts). */
  cardSession?: boolean;
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
  return workspaceManagementMcpFetch({
    principal,
    service,
    ...(setupBaseUrl ? { baseUrl: setupBaseUrl } : {}),
    ...(env ? { env } : {}),
  });
}

/** One request to the server, which learns from its session whether the client draws cards. */
export function workspaceManagementMcpFetch(
  input: Omit<WorkspaceManagementMcpServerInput, 'cardSession'>,
): McpRequestHandler {
  return (request) => withCardSessions(request, (served, cardSession) => createMcpHandler(
    () => createWorkspaceManagementMcpServer({ ...input, cardSession }),
    { legacy: 'stateless' },
  ).fetch(served));
}

export function createWorkspaceManagementMcpServer(
  input: WorkspaceManagementMcpServerInput,
): McpServer {
  const server = new ObservedMcpServer(input.principal.clientId, input.cardSession === true);
  const adapter = {
    service: input.service,
    resolveContext: async () => mcpActorContext(input.principal),
  };

  server.v4Only.push(server.registerTool('inspect_workspace', {
    title: 'Inspect Chickpea workspace',
    description: deprecatedToolDescription('inspect_workspace'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.inspect_workspace,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_workspace',
    args,
  ))));

  server.v4Only.push(server.registerTool('prepare_connector_setup', {
    title: 'Prepare Agent connector setup',
    description: deprecatedToolDescription('prepare_connector_setup'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.prepare_connector_setup,
    // Each call issues a new setup link, as prepare_provider_setup does.
    annotations: { ...WRITE, idempotentHint: false },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'prepare_connector_setup',
    args,
  ))));

  server.v4Only.push(server.registerTool('prepare_provider_setup', {
    title: 'Prepare model provider key setup',
    description: deprecatedToolDescription('prepare_provider_setup'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.prepare_provider_setup,
    annotations: { ...WRITE, idempotentHint: false },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'prepare_provider_setup',
    args,
  ))));

  server.v4Only.push(server.registerTool('discover_slack_channels', {
    title: 'Discover Slack Channels',
    description: deprecatedToolDescription('discover_slack_channels'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.discover_slack_channels,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'discover_slack_channels',
    args,
  ))));

  server.v4Only.push(server.registerTool('test_connection', {
    title: 'Test saved connection',
    description: deprecatedToolDescription('test_connection'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.test_connection,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'test_connection',
    args,
  ))));

  server.v4Only.push(server.registerTool('save_connection_key', {
    title: 'Save connection key',
    description: deprecatedToolDescription('save_connection_key'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.save_connection_key,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'save_connection_key',
    args,
  ))));

  server.v4Only.push(server.registerTool('try_connection', {
    title: 'Try connection settings',
    description: deprecatedToolDescription('try_connection'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.try_connection,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'try_connection',
    args,
  ))));

  server.v4Only.push(server.registerTool('inspect_memory', {
    title: 'Inspect Chickpea memory',
    description: deprecatedToolDescription('inspect_memory'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.inspect_memory,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_memory',
    args,
  ))));

  server.v4Only.push(server.registerTool('inspect_routines', {
    title: 'Inspect Chickpea routines',
    description: deprecatedToolDescription('inspect_routines'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.inspect_routines,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'inspect_routines',
    args,
  ))));

  server.v4Only.push(server.registerTool('export_workspace_recipe', {
    title: 'Export Chickpea workspace recipe',
    description: deprecatedToolDescription('export_workspace_recipe'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.export_workspace_recipe,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'export_workspace_recipe',
    args,
  ))));

  server.v4Only.push(server.registerTool('preview_workspace_recipe', {
    title: 'Preview Chickpea workspace recipe',
    description: deprecatedToolDescription('preview_workspace_recipe'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.preview_workspace_recipe,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'preview_workspace_recipe',
    args,
  ))));

  server.v4Only.push(server.registerTool('import_skill', {
    title: 'Install GitHub skill',
    description: deprecatedToolDescription('import_skill'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.import_skill,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'import_skill',
    args,
  ))));

  server.v4Only.push(server.registerTool('upload_skills', {
    title: 'Upload skill files',
    description: deprecatedToolDescription('upload_skills'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.upload_skills,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'upload_skills',
    args,
  ))));

  server.v4Only.push(server.registerTool('manage_agent_skill', {
    title: 'Manage an installed Agent skill',
    description: deprecatedToolDescription('manage_agent_skill'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.manage_agent_skill,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'manage_agent_skill',
    args,
  ))));

  server.v4Only.push(server.registerTool('apply_workspace_changes', {
    title: 'Apply Chickpea workspace changes',
    description: deprecatedToolDescription('apply_workspace_changes'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.apply_workspace_changes,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'apply_workspace_changes',
    {
      idempotencyKey: args.idempotencyKey,
      operations: args.operations as ManagementOperation[],
    },
  ))));

  server.v4Only.push(server.registerTool('confirm_workspace_change', {
    title: 'Confirm Chickpea workspace change',
    description: deprecatedToolDescription('confirm_workspace_change'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.confirm_workspace_change,
    annotations: { ...WRITE, destructiveHint: true },
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'confirm_workspace_change',
    args,
  ))));

  server.v4Only.push(server.registerTool('undo_workspace_change', {
    title: 'Undo Chickpea workspace change',
    description: deprecatedToolDescription('undo_workspace_change'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.undo_workspace_change,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'undo_workspace_change',
    args,
  ))));

  server.v4Only.push(server.registerTool('get_operation', {
    title: 'Get Chickpea operation',
    description: deprecatedToolDescription('get_operation'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.get_operation,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'get_operation',
    args,
  ))));

  server.v4Only.push(server.registerTool('revoke_setup_link', {
    title: 'Revoke Chickpea setup link',
    description: deprecatedToolDescription('revoke_setup_link'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.revoke_setup_link,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'revoke_setup_link',
    args,
  ))));

  server.v4Only.push(server.registerTool('list_mcp_clients', {
    title: 'List connected MCP clients',
    description: deprecatedToolDescription('list_mcp_clients'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.list_mcp_clients,
    annotations: READ_ONLY,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'list_mcp_clients',
    args,
  ))));

  server.v4Only.push(server.registerTool('revoke_mcp_client', {
    title: 'Revoke a connected MCP client',
    description: deprecatedToolDescription('revoke_mcp_client'),
    inputSchema: MCP_TOOL_INPUT_SCHEMAS.revoke_mcp_client,
    annotations: WRITE,
  }, async (args) => mcpResult(await invokeWorkspaceManagementTool(
    adapter,
    'revoke_mcp_client',
    args,
  ))));

  registerFiveZeroTools(server, {
    service: input.service,
    context: adapter.resolveContext,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.env ? { env: input.env } : {}),
  }, () => server.cardHost());
  registerCards(server, input.baseUrl);

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

  server.v4Only.push(server.registerResource('operation-schema', WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI, {
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
        deprecated: Object.fromEntries(WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES.map((name) =>
          [name, { since: V4_TOOLS_DEPRECATED_ON, replacedBy: V4_TOOL_REPLACEMENTS[name] }])),
        activation: 'next_turn',
        confirmation: 'Only a destructive change returns confirmation_required, with presentation.markdown and a proposalId. Pass the proposalId to confirm_workspace_change after the person agrees.',
      }),
    }],
  })));

  // Written for the 4.x tools throughout, and pinned by its digest.
  server.v4Only.push(server.registerResource(
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
  ));

  // The playbook's research section, under the URI /connect.md and the docs name.
  server.registerResource('discovery-guide', DISCOVERY_GUIDE_URI, {
    title: 'Find the first Chickpea Agent',
    description: 'Read before you propose an Agent whose job the person has not named: how to find one in their own work and propose one specific Agent. The same text as get_guide with topic research.',
    mimeType: 'text/markdown',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: playbookSection('research').guide }],
  }));

  server.v4Only.push(...registerWorkspaceManagementPrompts(server, input.baseUrl, input.env));

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
