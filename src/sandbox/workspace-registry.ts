import { AsyncLocalStorage } from 'node:async_hooks';

import type { FlueExecutionInterceptor } from '@flue/runtime';

import { MANAGED_SUBMISSION_AGENT_NAMES } from '../agents/names.ts';
import type { WorkspaceSession } from './workspace-session.ts';

interface RegisteredWorkspace {
  session: WorkspaceSession;
  /**
   * Ends this request's use of the workspace (revoke egress, checkpoint).
   * Absent when another owner ends the turn: while the Slack relay prepares
   * and ends the default workspace's turn, the registry only shares it.
   */
  end?: () => Promise<void>;
}

/** The coding workspaces one agent submission has touched, by workspace name. */
export class WorkspaceTurnRegistry {
  private readonly workspaces = new Map<string, RegisteredWorkspace>();

  register(session: WorkspaceSession, end?: () => Promise<void>): void {
    this.workspaces.set(session.name, { session, ...(end ? { end } : {}) });
  }

  get(name: string): WorkspaceSession | undefined {
    return this.workspaces.get(name)?.session;
  }

  list(): WorkspaceSession[] {
    return [...this.workspaces.values()].map(({ session }) => session);
  }

  /**
   * End every workspace this submission owns. Best effort and exhaustive: one
   * failed end never skips another, and nothing here fails the submission.
   */
  async drain(): Promise<void> {
    const owned = [...this.workspaces.values()].flatMap(({ end }) => (end ? [end] : []));
    this.workspaces.clear();
    const results = await Promise.allSettled(owned.map((end) => end()));
    if (results.some((result) => result.status === 'rejected')) {
      console.warn('[chickpea] coding workspace turn end did not complete');
    }
  }
}

const activeRegistry = new AsyncLocalStorage<WorkspaceTurnRegistry>();

/** This submission's registry, or undefined outside a managed agent submission. */
export function currentWorkspaceRegistry(): WorkspaceTurnRegistry | undefined {
  return activeRegistry.getStore();
}

/** Run `work` with a fresh registry and drain it however `work` settles. */
export async function runWithWorkspaceRegistry<T>(work: () => Promise<T>): Promise<T> {
  const registry = new WorkspaceTurnRegistry();
  try {
    return await activeRegistry.run(registry, work);
  } finally {
    await registry.drain();
  }
}

/**
 * Scope one registry to each managed agent submission. The sandbox factory
 * (called once at initialization) and every tool call run inside this
 * submission's async context, so the attached container and the workspace
 * tools share one activation per workspace, and re-renders on every model
 * call find the same session.
 */
export const workspaceRegistryInterceptor: FlueExecutionInterceptor = (
  operation,
  context,
  next,
) => {
  if (
    operation.type === 'agent' &&
    activeRegistry.getStore() === undefined &&
    context.agentName !== undefined &&
    (MANAGED_SUBMISSION_AGENT_NAMES as readonly string[]).includes(context.agentName)
  ) {
    return runWithWorkspaceRegistry(next);
  }
  return next();
};
