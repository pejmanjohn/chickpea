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

/** A workspace the registry creates on first use, with the turn end it owns. */
export type WorkspaceSessionFactory = (
  name: string,
) => Promise<{ session: WorkspaceSession; end: () => Promise<void> } | undefined>;

/** The coding workspaces one agent submission has touched, by workspace name. */
export class WorkspaceTurnRegistry {
  private readonly workspaces = new Map<string, RegisteredWorkspace>();
  private readonly pending = new Map<string, Promise<WorkspaceSession | undefined>>();

  register(session: WorkspaceSession, end?: () => Promise<void>): void {
    this.workspaces.set(session.name, { session, ...(end ? { end } : {}) });
  }

  get(name: string): WorkspaceSession | undefined {
    return this.workspaces.get(name)?.session;
  }

  /**
   * The workspace registered under `name`, or one created now by `create`.
   * Creation builds only a handle: nothing reaches the Sandbox Durable Object
   * until a tool opens it. Concurrent callers share one creation, and a
   * failed or empty creation is retried by the next caller.
   */
  resolve(name: string, create: WorkspaceSessionFactory): Promise<WorkspaceSession | undefined> {
    const registered = this.get(name);
    if (registered) return Promise.resolve(registered);
    let pending = this.pending.get(name);
    if (!pending) {
      pending = create(name).then((created) => {
        if (!created) return undefined;
        this.register(created.session, created.end);
        return created.session;
      }).finally(() => {
        this.pending.delete(name);
      });
      this.pending.set(name, pending);
    }
    return pending;
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
