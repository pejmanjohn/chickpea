import type { WorkspaceManagementService } from './service.ts';
import {
  ManagementError,
  type ManagementActorContext,
  type ManagementOperation,
} from './types.ts';

export const WORKSPACE_MANAGEMENT_TOOL_NAMES = [
  'inspect_workspace',
  'apply_workspace_changes',
  'confirm_workspace_change',
  'undo_workspace_change',
  'get_operation',
] as const;

export type WorkspaceManagementToolName = typeof WORKSPACE_MANAGEMENT_TOOL_NAMES[number];

const TOOL_DESCRIPTIONS: Record<WorkspaceManagementToolName, string> = {
  inspect_workspace: 'Inspect the current non-secret Chickpea Agents, Channels, placements, and revisions.',
  apply_workspace_changes: 'Apply one or more typed Chickpea workspace changes with durable idempotency and per-item outcomes.',
  confirm_workspace_change: 'Confirm one requester- and client-bound destructive or capability-expanding change proposal.',
  undo_workspace_change: 'Undo one eligible operation at the exact resulting revision.',
  get_operation: 'Read the durable result of one operation or confirmation proposal owned by the requester.',
};

export function workspaceManagementToolDescription(name: WorkspaceManagementToolName): string {
  return TOOL_DESCRIPTIONS[name];
}

export type WorkspaceManagementToolArguments = {
  inspect_workspace: Record<never, never>;
  apply_workspace_changes: { idempotencyKey: string; operations: ManagementOperation[] };
  confirm_workspace_change: { proposalId: string };
  undo_workspace_change: { operationId: string; idempotencyKey: string };
  get_operation: { operationId: string };
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
