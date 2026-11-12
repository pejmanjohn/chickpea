import type { WorkspaceManagementService } from '../../src/management/service.ts';
import type { WorkspaceManagementToolResult } from '../../src/management/tool-adapter.ts';
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
