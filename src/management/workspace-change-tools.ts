import { useAgentFinish, usePersistentState } from '@flue/runtime';

import { AGENT_AUTHORING_SKILL_NAME } from './agent-authoring/index.ts';
import type { WorkspaceManagementToolName } from './tool-adapter.ts';

/**
 * The management tools that propose, apply, undo, and read back workspace
 * configuration changes, which carry most of the management schema bytes. A
 * Slack thread mounts them once agent-authoring is active in it, or for one
 * turn the host signals, as their own capability segment (shared-prefix.ts),
 * so a turn that changes nothing sends a smaller prompt.
 */
export const WORKSPACE_CHANGE_TOOL_NAMES = [
  'propose_workspace_changes',
  'apply_workspace_changes',
  'undo_workspace_change',
  'get_operation',
] as const satisfies readonly WorkspaceManagementToolName[];

/** Tells the model why the change tools may be missing from its tool list and how to get them. */
export const WORKSPACE_CHANGE_TOOLS_INSTRUCTION = 'The tools propose_workspace_changes, apply_workspace_changes, undo_workspace_change, and get_operation load when you activate agent-authoring, so activate it before you need one of them.';

/** Persistent state: the thread mounts the change tools on every later render. */
export const WORKSPACE_CHANGE_TOOLS_STATE_NAME = 'chickpeaWorkspaceChangeTools';

const MAX_ACTIVATED_INSTANCES = 512;

/** Instances whose model activated agent-authoring in this process, until their response keeps the tools. */
const activatedInstances = new Set<string>();

/**
 * A Flue `tool_start` observation of the model activating agent-authoring:
 * the instance's next render mounts the change tools, which the provider
 * request then adds inline after the cached prefix.
 */
export function noteAgentAuthoringActivation(event: {
  type: string;
  instanceId?: string | undefined;
  toolName?: string | undefined;
  args?: unknown;
}): void {
  if (event.type !== 'tool_start' || event.toolName !== 'activate_skill' || typeof event.instanceId !== 'string') return;
  const { args } = event;
  if (typeof args !== 'object' || args === null || !('name' in args) || args.name !== AGENT_AUTHORING_SKILL_NAME) return;
  activatedInstances.add(event.instanceId);
  if (activatedInstances.size > MAX_ACTIVATED_INSTANCES) {
    const oldest = activatedInstances.values().next();
    if (!oldest.done) activatedInstances.delete(oldest.value);
  }
}

/**
 * Whether this render mounts the change tools. Once agent-authoring is
 * activated in a thread they stay mounted for the rest of it, so no later
 * render withdraws them: the response that activated it keeps them when it
 * finishes. `signaled`, the host's signal on the turn's delivery (Clef read a
 * configuration change, or a change set waits on the requester), mounts them
 * from the turn's first request in the same position, so the request carries
 * the shared management shape. It keeps nothing: the thread keeps them only
 * if the model activates agent-authoring.
 */
export function useWorkspaceChangeToolsMounted(instanceId: string, signaled = false): boolean {
  const [kept, keep] = usePersistentState<boolean>(WORKSPACE_CHANGE_TOOLS_STATE_NAME, false);
  if (kept) return true;
  if (!activatedInstances.has(instanceId)) return signaled;
  useAgentFinish(() => {
    keep(true);
    activatedInstances.delete(instanceId);
  });
  return true;
}
