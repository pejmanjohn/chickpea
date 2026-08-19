import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal, McpRequestHandler } from '../auth/mcp-oauth-routes.ts';
import {
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getMemoryStateStore,
  getRoutineStore,
  getSettingsStore,
  getUsageStore,
  getWorkStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  deleteProviderApiKey,
  describeProviderKeySources,
} from '../config/provider-keys.ts';
import {
  applyWorkspaceChangesZodSchema,
  confirmWorkspaceChangeZodSchema,
  getOperationZodSchema,
  inspectWorkspaceZodSchema,
  inspectMemoryZodSchema,
  inspectRoutinesZodSchema,
  MANAGEMENT_OPERATION_KINDS,
  revokeSetupLinkZodSchema,
  undoWorkspaceChangeZodSchema,
} from './schemas.ts';
import { WorkspaceManagementService } from './service.ts';
import { resolveEligibleSlackInvitee } from './slack-directory.ts';
import {
  invokeWorkspaceManagementTool,
  workspaceManagementToolDescription,
  WORKSPACE_MANAGEMENT_TOOL_NAMES,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolResult,
} from './tool-adapter.ts';
import type { ManagementActorContext, ManagementOperation } from './types.ts';

const SERVER_INFO = { name: 'chickpea-workspace', version: '1.0.0' } as const;
export interface WorkspaceManagementMcpServerInput {
  principal: McpAuthenticatedPrincipal;
  service: WorkspaceManagementService;
}

export function createWorkspaceManagementMcpHandler(
  principal: McpAuthenticatedPrincipal,
  env?: PlatformEnv,
  setupBaseUrl?: string,
): McpRequestHandler {
  const settings = getSettingsStore(env);
  const identity = getIdentityStore(env);
  const service = new WorkspaceManagementService({
    identity,
    config: getConfigStore(env),
    management: getManagementStore(env),
    memory: getMemoryStateStore(env),
    routines: getRoutineStore(env),
    work: getWorkStore(env),
    routineSchedulingAvailable: isCloudflareTarget(),
    ...(setupBaseUrl ? { setupBaseUrl } : {}),
    providerCredentialSource: async (providerId) =>
      (await describeProviderKeySources(env, settings))[providerId],
    removeProviderCredential: async (providerId) =>
      (await deleteProviderApiKey(providerId, env, settings, getUsageStore(env))).source,
    resolveSlackInvitee: (slackUserId) =>
      resolveEligibleSlackInvitee(slackUserId, env, identity),
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
  const server = new McpServer(SERVER_INFO);
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

  server.registerResource('operation-schema', 'chickpea://schema/operations', {
    title: 'Chickpea management operation inventory',
    description: 'Stable operation and tool names supported by this management contract.',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({
        schemaVersion: 1,
        tools: WORKSPACE_MANAGEMENT_TOOL_NAMES,
        operationKinds: MANAGEMENT_OPERATION_KINDS,
        activation: 'next_turn',
        confirmation: 'Use proposalId with confirm_workspace_change.',
      }),
    }],
  }));

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
