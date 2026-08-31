import type { WorkspaceManagementService } from './service.ts';
import { AgentPresenceError } from '../slack/agent-presence/errors.ts';
import {
  ChickpeaHandoffRequired,
  ManagementError,
  type ManagementActorContext,
  type ManageAgentSkillAction,
  type ManagementOperation,
  type PrepareConnectorSetupInput,
  type ManagementRoutineInspectionInput,
} from './types.ts';
import type { PreviewWorkspaceRecipeInput } from './recipes.ts';
import { emitManagementMetric } from './telemetry.ts';
import type { AgentAuthoringReason } from './agent-authoring/index.ts';
import {
  genericSemanticDescriptor,
  semanticInvocationFact,
  unknownSemanticDescriptor,
  type SemanticActivityDescriptor,
  type SemanticInvocationFact,
} from '../activity/semantic.ts';

export const WORKSPACE_MANAGEMENT_TOOL_NAMES = [
  'inspect_workspace',
  'prepare_connector_setup',
  'discover_slack_channels',
  'test_mcp_connection',
  'inspect_memory',
  'inspect_routines',
  'export_workspace_recipe',
  'preview_workspace_recipe',
  'propose_skill_import',
  'import_skill',
  'manage_agent_skill',
  'propose_workspace_changes',
  'apply_workspace_changes',
  'confirm_workspace_change',
  'undo_workspace_change',
  'get_operation',
  'revoke_setup_link',
] as const;

export type WorkspaceManagementToolName = typeof WORKSPACE_MANAGEMENT_TOOL_NAMES[number];

const WORKSPACE_MANAGEMENT_SEMANTICS: Record<
  WorkspaceManagementToolName,
  SemanticActivityDescriptor
> = {
  inspect_workspace: genericSemanticDescriptor('workspace'),
  prepare_connector_setup: unknownSemanticDescriptor(),
  discover_slack_channels: unknownSemanticDescriptor(),
  test_mcp_connection: unknownSemanticDescriptor(),
  inspect_memory: unknownSemanticDescriptor(),
  inspect_routines: unknownSemanticDescriptor(),
  export_workspace_recipe: unknownSemanticDescriptor(),
  preview_workspace_recipe: unknownSemanticDescriptor(),
  import_skill: unknownSemanticDescriptor(),
  manage_agent_skill: unknownSemanticDescriptor(),
  propose_skill_import: unknownSemanticDescriptor(),
  propose_workspace_changes: unknownSemanticDescriptor(),
  apply_workspace_changes: unknownSemanticDescriptor(),
  confirm_workspace_change: unknownSemanticDescriptor(),
  undo_workspace_change: unknownSemanticDescriptor(),
  get_operation: unknownSemanticDescriptor(),
  revoke_setup_link: unknownSemanticDescriptor(),
};

export function workspaceManagementSemanticDescriptor(
  name: WorkspaceManagementToolName,
): SemanticActivityDescriptor {
  return { ...WORKSPACE_MANAGEMENT_SEMANTICS[name] };
}

/**
 * The already-normalized tool name selects a closed activity fact.
 * Operation arguments and bodies never enter the emitted value.
 */
export function workspaceManagementSemanticInvocation(
  toolCallId: string,
  name: WorkspaceManagementToolName,
): SemanticInvocationFact {
  return semanticInvocationFact(toolCallId, workspaceManagementSemanticDescriptor(name));
}

const TOOL_DESCRIPTIONS: Record<WorkspaceManagementToolName, string> = {
  inspect_workspace: 'Inspect current non-secret Chickpea Agents, skills, connections, repositories, Channels, provider availability, and Owner-only team authority. Required before recommending specific capabilities for Agent design or answering what services an Agent can use.',
  prepare_connector_setup: 'Create a safe browser handoff URL for connecting one catalog service to an editable Agent. Set ownerKind to "member" for a personal connection or "team" for a team-owned connection. The resulting connection belongs only to that Agent. In a specific Agent Slack conversation, agentId may be omitted to target that Agent.',
  discover_slack_channels: 'Discover Channels in the connected Slack workspace before publishing a Chickpea Agent.',
  test_mcp_connection: 'Test one saved Agent MCP connection with its write-only credentials and return a sanitized result plus discovered tools.',
  inspect_memory: 'Inspect the single durable memory body owned by one Agent.',
  inspect_routines: 'Inspect routine schedules and safely projected content for one workspace, Channel, current one-to-one DM, or routine. In a DM, omit channelId so the server derives the private conversation from the trusted Slack origin.',
  export_workspace_recipe: 'Export selected Agents and their connection requirements as a versioned, secret-free portable recipe.',
  preview_workspace_recipe: 'Preview a portable recipe against live workspace state and compile chosen outcomes into ordinary typed changes.',
  import_skill: 'Install one exact public GitHub-hosted SKILL.md on an editable Agent when its source appears in the authenticated current requester message. The service pins the inspected commit, applies one bounded scriptless skill immediately, and returns a receipt plus undo. If the source has several skills, ask the requester to post the chosen candidate sourceUrl. For different same-name content, follow the exact replacement clarification returned by the tool before retrying with replaceExisting true. Do not add another approval step.',
  manage_agent_skill: 'Enable, disable, or remove one named existing Agent skill immediately. The narrow authenticated tool resolves current Agent state, verifies authority and the exact current command on Slack, preserves every other skill, and returns a receipt plus undo without a proposal. An authenticated MCP invocation is already the exact typed command. Use it instead of propose_workspace_changes or a model-authored skills array.',
  propose_skill_import: 'Resolve one public GitHub-hosted SKILL.md inside the trusted management service and create the normal requester-bound review for adding or replacing it on an editable Agent. Prefer a direct GitHub skill-directory URL. If selection is required, ask the requester to choose one returned candidate and call this tool again with that candidate’s sourceUrl as source. Show presentation.slack verbatim and wait for explicit approval; this tool never installs the skill by itself.',
  propose_workspace_changes: 'Create the one read-only, exact, requester-bound review for a consequential edit. Agent creation is not valid here: create one standalone base Agent immediately with apply_workspace_changes. Read chickpea://guide/agent-authoring/v1 first. Do not ask for permission before proposing and do not place another prose approval gate before or after the returned preview. Show presentation.slack verbatim; keep proposalId as opaque control data for confirm_workspace_change.',
  apply_workspace_changes: 'Apply typed Chickpea workspace changes with durable idempotency and per-item outcomes. One sufficiently understood base Agent must be created immediately as a standalone create_agent operation; do not propose it or ask for confirmation. Keep capability and follow-on operations separate. Other confirmation-required operations return one bound proposal; never add a separate conversational approval gate around it.',
  confirm_workspace_change: 'Confirm one requester- and client-bound destructive or capability-expanding change proposal. After this tool returns, always send visible final text with the terminal status and what changed or why nothing changed; never end on the tool call or progress UI.',
  undo_workspace_change: 'Undo one eligible operation at the exact resulting revision. A trusted connector call immediately reverses an exact manage_agent_skill receipt; other inverses still use consequence-based policy.',
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
  import_skill: {
    agentId?: string | undefined;
    source: string;
    skillName?: string | undefined;
    replaceExisting?: boolean | undefined;
    idempotencyKey: string;
    guideVersion: string;
  };
  manage_agent_skill: {
    agentId?: string | undefined;
    action: ManageAgentSkillAction;
    skillName: string;
    idempotencyKey: string;
  };
  propose_skill_import: {
    agentId?: string | undefined;
    source: string;
    skillName?: string | undefined;
    idempotencyKey: string;
    guideVersion: string;
  };
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
      case 'import_skill': {
        const value = args as WorkspaceManagementToolArguments['import_skill'];
        return service.importSkill({
          context,
          source: value.source,
          idempotencyKey: value.idempotencyKey,
          guideVersion: value.guideVersion,
          ...(value.agentId ? { agentId: value.agentId } : {}),
          ...(value.skillName ? { skillName: value.skillName } : {}),
          ...(value.replaceExisting !== undefined
            ? { replaceExisting: value.replaceExisting }
            : {}),
        });
      }
      case 'manage_agent_skill': {
        const value = args as WorkspaceManagementToolArguments['manage_agent_skill'];
        return service.manageAgentSkill({
          context,
          action: value.action,
          skillName: value.skillName,
          idempotencyKey: value.idempotencyKey,
          ...(value.agentId ? { agentId: value.agentId } : {}),
        });
      }
      case 'propose_skill_import': {
        const value = args as WorkspaceManagementToolArguments['propose_skill_import'];
        return service.proposeSkillImport({
          context,
          source: value.source,
          idempotencyKey: value.idempotencyKey,
          guideVersion: value.guideVersion,
          ...(value.agentId ? { agentId: value.agentId } : {}),
          ...(value.skillName ? { skillName: value.skillName } : {}),
        });
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
