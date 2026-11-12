import { CONFIRMATION_LIFETIME_MS } from '../../src/management/mcp-v5/changes.ts';
import type { WorkspaceManagementService } from '../../src/management/service.ts';
import {
  invokeWorkspaceManagementTool,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolName,
  type WorkspaceManagementToolResult,
} from '../../src/management/tool-adapter.ts';
import { ManagementError, type ManagementActorContext } from '../../src/management/types.ts';
import { AgentPresenceError } from '../../src/slack/agent-presence/errors.ts';

/**
 * A service call's result in the `{ ok, result | error }` shape the Slack
 * door's tools return, for a test that reaches the service directly, as a
 * 5.0 tool and the Slack host's approval do, and reads that shape.
 */
export async function serviceResult(call: () => Promise<unknown>): Promise<WorkspaceManagementToolResult> {
  try {
    return { ok: true, result: await call() };
  } catch (error) {
    if (!(error instanceof ManagementError || error instanceof AgentPresenceError)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof ManagementError && error.links ? { links: error.links } : {}),
      },
    };
  }
}

/**
 * Confirms a held change through the service, as 5.0's confirm_change and the
 * Slack host's approval do. `confirmed`, which only 5.0's summary reads, is
 * left out.
 */
export function confirmThroughService(
  service: WorkspaceManagementService,
  context: ManagementActorContext | (() => Promise<ManagementActorContext>),
  proposalId: string,
): Promise<WorkspaceManagementToolResult> {
  return serviceResult(async () => {
    const actor = typeof context === 'function' ? await context() : context;
    const { confirmed: _confirmed, ...result } = await service.confirmWorkspaceChange({ context: actor, proposalId });
    return result;
  });
}

/**
 * A management tool call as its door makes it since contract 5.0.0. Slack's
 * goes through the tool adapter. An MCP caller's apply or undo goes to the
 * service as a 5.0 write sends it, with a confirmation that expires: the 4.x
 * tools that sent one without are gone, and a set they left reads as expired.
 */
export async function invokeAsDoor<TName extends WorkspaceManagementToolName>(
  input: { service: WorkspaceManagementService; resolveContext(): Promise<ManagementActorContext> },
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<WorkspaceManagementToolResult> {
  const context = await input.resolveContext();
  if (context.origin.kind === 'mcp' && name === 'apply_workspace_changes') {
    const { idempotencyKey, operations } = args as WorkspaceManagementToolArguments['apply_workspace_changes'];
    return serviceResult(() => input.service.applyWorkspaceChanges({
      context, idempotencyKey, operations, confirmationLifetimeMs: CONFIRMATION_LIFETIME_MS,
    }));
  }
  if (context.origin.kind === 'mcp' && name === 'undo_workspace_change') {
    const { operationId, idempotencyKey } = args as WorkspaceManagementToolArguments['undo_workspace_change'];
    return serviceResult(() => input.service.undoWorkspaceChange({
      context, operationId, idempotencyKey, confirmationLifetimeMs: CONFIRMATION_LIFETIME_MS,
    }));
  }
  return invokeWorkspaceManagementTool(input, name, args);
}
