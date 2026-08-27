import type { WorkspaceManagementService } from './service.ts';
import { AgentPresenceError } from '../slack/agent-presence/errors.ts';
import {
  ChickpeaHandoffRequired,
  ManagementError,
  type ManagementActorContext,
  type ManagementOperation,
  type PrepareConnectorSetupInput,
  type ManagementRoutineInspectionInput,
} from './types.ts';
import type { PreviewWorkspaceRecipeInput } from './recipes.ts';
import { emitManagementMetric } from './telemetry.ts';
import type { AgentAuthoringReason } from './agent-authoring/index.ts';

export const WORKSPACE_MANAGEMENT_TOOL_NAMES = [
  'inspect_workspace',
  'prepare_connector_setup',
  'discover_slack_channels',
  'test_mcp_connection',
  'inspect_memory',
  'inspect_routines',
  'export_workspace_recipe',
  'preview_workspace_recipe',
  'propose_workspace_changes',
  'apply_workspace_changes',
  'confirm_workspace_change',
  'undo_workspace_change',
  'get_operation',
  'revoke_setup_link',
] as const;

export type WorkspaceManagementToolName = typeof WORKSPACE_MANAGEMENT_TOOL_NAMES[number];

const TOOL_DESCRIPTIONS: Record<WorkspaceManagementToolName, string> = {
  inspect_workspace: 'Inspect current non-secret Chickpea Agents, skills, connections, repositories, Channels, provider availability, and Owner-only team authority. Required before recommending specific capabilities for Agent design or answering what services an Agent can use.',
  prepare_connector_setup: 'Create a safe browser handoff URL for adding a catalog connector to an editable Agent. Set ownerKind to "member" for a personal connection or "team" for a shared connection. In a specific Agent Slack conversation, agentId may be omitted to target that Agent.',
  discover_slack_channels: 'Discover Channels in the connected Slack workspace before publishing a Chickpea Agent.',
  test_mcp_connection: 'Test one saved Agent MCP connection with its write-only credentials and return a sanitized result plus discovered tools.',
  inspect_memory: 'Inspect the single durable memory body owned by one Agent.',
  inspect_routines: 'Inspect routine schedules and safely projected content for one workspace, Channel, current one-to-one DM, or routine. In a DM, omit channelId so the server derives the private conversation from the trusted Slack origin.',
  export_workspace_recipe: 'Export selected Agents and their connection requirements as a versioned, secret-free portable recipe.',
  preview_workspace_recipe: 'Preview a portable recipe against live workspace state and compile chosen outcomes into ordinary typed changes.',
  propose_workspace_changes: 'Create a read-only, exact, requester-bound Agent configuration proposal. Read chickpea://guide/agent-authoring/v1 before proposing creation or a complex edit. Show the returned presentation.slack verbatim as the human-facing preview; it clearly marks any Slack truncation while confirmation retains the full frozen proposal. Keep proposalId as opaque control data for confirm_workspace_change; do not use it as the human-facing proposal.',
  apply_workspace_changes: 'Apply one or more typed Chickpea workspace changes with durable idempotency and per-item outcomes.',
  confirm_workspace_change: 'Confirm one requester- and client-bound destructive or capability-expanding change proposal. After this tool returns, always send visible final text with the terminal status and what changed or why nothing changed; never end on the tool call or progress UI.',
  undo_workspace_change: 'Undo one eligible operation at the exact resulting revision.',
  get_operation: 'Read the durable result of one operation or confirmation proposal owned by the requester.',
  revoke_setup_link: 'Revoke one unused requester-owned setup link and optionally issue a fresh 24-hour link.',
};

export function workspaceManagementToolDescription(name: WorkspaceManagementToolName): string {
  return TOOL_DESCRIPTIONS[name];
}

export type WorkspaceManagementToolArguments = {
  inspect_workspace: Record<never, never>;
  prepare_connector_setup: Omit<PrepareConnectorSetupInput, 'agentId'> & {
    agentId?: string | undefined;
  };
  discover_slack_channels: { refresh?: boolean | undefined };
  test_mcp_connection: { agentId: string; connectionId: string };
  inspect_memory: { agentId: string };
  inspect_routines: ManagementRoutineInspectionInput;
  export_workspace_recipe: { agentIds?: string[] | undefined };
  preview_workspace_recipe: PreviewWorkspaceRecipeInput;
  propose_workspace_changes: {
    idempotencyKey: string;
    guideVersion: string;
    authoringReason: AgentAuthoringReason;
    operations: ManagementOperation[];
  };
  apply_workspace_changes: { idempotencyKey: string; operations: ManagementOperation[] };
  confirm_workspace_change: { proposalId: string };
  undo_workspace_change: { operationId: string; idempotencyKey: string };
  get_operation: { operationId: string };
  revoke_setup_link: { setupOperationId: string; reissue?: boolean | undefined };
};

export type WorkspaceManagementToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface WorkspaceManagementToolAdapterInput {
  service: WorkspaceManagementService;
  resolveContext(): Promise<ManagementActorContext>;
}

/** Transport-neutral invocation seam shared by MCP and Flue tool adapters. */
export async function invokeWorkspaceManagementTool<TName extends WorkspaceManagementToolName>(
  input: WorkspaceManagementToolAdapterInput,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<WorkspaceManagementToolResult> {
  const startedAt = Date.now();
  let surface = 'unknown';
  try {
    const context = await input.resolveContext();
    surface = context.origin.kind;
    const result = await executeWorkspaceManagementTool(
      input.service,
      context,
      name,
      args,
    );
    emitManagementMetric('tool.call', {
      surface,
      tool: name,
      outcome: 'success',
      durationMs: Date.now() - startedAt,
    });
    return success(result);
  } catch (error) {
    if (error instanceof ChickpeaHandoffRequired) {
      emitManagementMetric('tool.call', {
        surface,
        tool: name,
        outcome: 'success',
        reason: 'chickpea_handoff',
        durationMs: Date.now() - startedAt,
      });
      return success(error.handoff);
    }
    const result = failure(error);
    if (!(error instanceof ManagementError) && !(error instanceof AgentPresenceError)) {
      console.warn('[chickpea:management] unexpected tool failure', JSON.stringify({
        tool: name,
        errorName: error instanceof Error ? error.name : typeof error,
        message: safeUnexpectedErrorMessage(error),
      }));
    }
    emitManagementMetric('tool.call', {
      surface,
      tool: name,
      outcome: 'error',
      reason: error instanceof ManagementError || error instanceof AgentPresenceError
        ? error.code
        : 'management_error',
      durationMs: Date.now() - startedAt,
    });
    return result;
  }
}

function safeUnexpectedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/(?:xox[a-z]-|sk-|gh[opusr]_)[^\s"']+/gi, '[credential]')
    .slice(0, 240);
}

async function executeWorkspaceManagementTool<TName extends WorkspaceManagementToolName>(
  service: WorkspaceManagementService,
  context: ManagementActorContext,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<unknown> {
  switch (name) {
      case 'inspect_workspace':
        return service.inspectWorkspace(context);
      case 'prepare_connector_setup': {
        const value = args as WorkspaceManagementToolArguments['prepare_connector_setup'];
        const agentId = value.agentId ??
          (context.origin.kind === 'slack' ? context.origin.agentId : undefined);
        if (!agentId) {
          throw new ManagementError(
            'invalid_request',
            'Choose an Agent before preparing connector setup.',
          );
        }
        return service.prepareConnectorSetup(context, {
          agentId,
          connector: value.connector,
          ownerKind: value.ownerKind,
        });
      }
      case 'discover_slack_channels': {
        const value = args as WorkspaceManagementToolArguments['discover_slack_channels'];
        return service.discoverSlackChannels(context, value.refresh ?? false);
      }
      case 'test_mcp_connection': {
        const value = args as WorkspaceManagementToolArguments['test_mcp_connection'];
        return service.testMcpConnection(context, value.agentId, value.connectionId);
      }
      case 'inspect_memory': {
        const value = args as WorkspaceManagementToolArguments['inspect_memory'];
        return service.inspectMemory(context, value.agentId);
      }
      case 'inspect_routines': {
        const value = args as WorkspaceManagementToolArguments['inspect_routines'];
        return service.inspectRoutines(context, value);
      }
      case 'export_workspace_recipe': {
        const value = args as WorkspaceManagementToolArguments['export_workspace_recipe'];
        return service.exportRecipe(context, value);
      }
      case 'preview_workspace_recipe': {
        const value = args as WorkspaceManagementToolArguments['preview_workspace_recipe'];
        return service.previewRecipe(context, value);
      }
      case 'propose_workspace_changes': {
        const value = args as WorkspaceManagementToolArguments['propose_workspace_changes'];
        return service.proposeWorkspaceChanges({ context, ...value });
      }
      case 'apply_workspace_changes': {
        const value = args as WorkspaceManagementToolArguments['apply_workspace_changes'];
        return service.applyWorkspaceChanges({ context, ...value });
      }
      case 'confirm_workspace_change': {
        const value = args as WorkspaceManagementToolArguments['confirm_workspace_change'];
        return service.confirmWorkspaceChange({ context, ...value });
      }
      case 'undo_workspace_change': {
        const value = args as WorkspaceManagementToolArguments['undo_workspace_change'];
        return service.undoWorkspaceChange({ context, ...value });
      }
      case 'get_operation': {
        const value = args as WorkspaceManagementToolArguments['get_operation'];
        const operation = await service.getOperation(context, value.operationId);
        return { operation: operation ?? null };
      }
      case 'revoke_setup_link': {
        const value = args as WorkspaceManagementToolArguments['revoke_setup_link'];
        return service.revokeSetupLink(
          context,
          value.setupOperationId,
          value.reissue ?? false,
        );
      }
  }
}

function success(result: unknown): WorkspaceManagementToolResult {
  return { ok: true, result };
}

function failure(error: unknown): WorkspaceManagementToolResult {
  if (error instanceof ManagementError || error instanceof AgentPresenceError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }
  return {
    ok: false,
    error: { code: 'management_error', message: 'The workspace management request failed.' },
  };
}
