import type { WorkspaceManagementService } from './service.ts';
import {
  ManagementError,
  type ManagementActorContext,
  type ManagementOperation,
  type ManagementRoutineInspectionInput,
} from './types.ts';
import type { MemoryOwnerRef } from '../memory/types.ts';
import type { PreviewWorkspaceRecipeInput } from './recipes.ts';

export const WORKSPACE_MANAGEMENT_TOOL_NAMES = [
  'inspect_workspace',
  'inspect_memory',
  'inspect_routines',
  'export_workspace_recipe',
  'preview_workspace_recipe',
  'apply_workspace_changes',
  'confirm_workspace_change',
  'undo_workspace_change',
  'get_operation',
  'revoke_setup_link',
] as const;

export type WorkspaceManagementToolName = typeof WORKSPACE_MANAGEMENT_TOOL_NAMES[number];

const TOOL_DESCRIPTIONS: Record<WorkspaceManagementToolName, string> = {
  inspect_workspace: 'Inspect current non-secret Chickpea Agents, skills, connections, repositories, Channels, provider availability, and Owner-only team authority.',
  inspect_memory: 'Inspect one Agent or Channel memory owner and its versioned entries.',
  inspect_routines: 'Inspect routine schedules and safely projected content for one workspace, Channel, or routine.',
  export_workspace_recipe: 'Export selected Agents and their Channel intent as a versioned, secret-free portable recipe.',
  preview_workspace_recipe: 'Preview a portable recipe against live workspace state and compile chosen outcomes into ordinary typed changes.',
  apply_workspace_changes: 'Apply one or more typed Chickpea workspace changes with durable idempotency and per-item outcomes.',
  confirm_workspace_change: 'Confirm one requester- and client-bound destructive or capability-expanding change proposal.',
  undo_workspace_change: 'Undo one eligible operation at the exact resulting revision.',
  get_operation: 'Read the durable result of one operation or confirmation proposal owned by the requester.',
  revoke_setup_link: 'Revoke one unused requester-owned setup link and optionally issue a fresh 24-hour link.',
};

export function workspaceManagementToolDescription(name: WorkspaceManagementToolName): string {
  return TOOL_DESCRIPTIONS[name];
}

export type WorkspaceManagementToolArguments = {
  inspect_workspace: Record<never, never>;
  inspect_memory: MemoryOwnerRef;
  inspect_routines: ManagementRoutineInspectionInput;
  export_workspace_recipe: { agentIds?: string[] | undefined };
  preview_workspace_recipe: PreviewWorkspaceRecipeInput;
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
  try {
    const context = await input.resolveContext();
    switch (name) {
      case 'inspect_workspace':
        return success(await input.service.inspectWorkspace(context));
      case 'inspect_memory': {
        const value = args as WorkspaceManagementToolArguments['inspect_memory'];
        return success(await input.service.inspectMemory(context, value));
      }
      case 'inspect_routines': {
        const value = args as WorkspaceManagementToolArguments['inspect_routines'];
        return success(await input.service.inspectRoutines(context, value));
      }
      case 'export_workspace_recipe': {
        const value = args as WorkspaceManagementToolArguments['export_workspace_recipe'];
        return success(await input.service.exportRecipe(context, value));
      }
      case 'preview_workspace_recipe': {
        const value = args as WorkspaceManagementToolArguments['preview_workspace_recipe'];
        return success(await input.service.previewRecipe(context, value));
      }
      case 'apply_workspace_changes': {
        const value = args as WorkspaceManagementToolArguments['apply_workspace_changes'];
        return success(await input.service.applyWorkspaceChanges({ context, ...value }));
      }
      case 'confirm_workspace_change': {
        const value = args as WorkspaceManagementToolArguments['confirm_workspace_change'];
        return success(await input.service.confirmWorkspaceChange({ context, ...value }));
      }
      case 'undo_workspace_change': {
        const value = args as WorkspaceManagementToolArguments['undo_workspace_change'];
        return success(await input.service.undoWorkspaceChange({ context, ...value }));
      }
      case 'get_operation': {
        const value = args as WorkspaceManagementToolArguments['get_operation'];
        const operation = await input.service.getOperation(context, value.operationId);
        return success({ operation: operation ?? null });
      }
      case 'revoke_setup_link': {
        const value = args as WorkspaceManagementToolArguments['revoke_setup_link'];
        return success(await input.service.revokeSetupLink(
          context,
          value.setupOperationId,
          value.reissue ?? false,
        ));
      }
    }
  } catch (error) {
    return failure(error);
  }
}

function success(result: unknown): WorkspaceManagementToolResult {
  return { ok: true, result };
}

function failure(error: unknown): WorkspaceManagementToolResult {
  if (error instanceof ManagementError) {
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
