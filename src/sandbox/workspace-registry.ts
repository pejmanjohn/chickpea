import { AsyncLocalStorage } from 'node:async_hooks';

import type { FlueExecutionInterceptor } from '@flue/runtime';

import { MANAGED_SUBMISSION_AGENT_NAMES } from '../agents/names.ts';
import type { WorkspaceSession } from './workspace-session.ts';

/** The registry key of a workspace name at a retirement generation. */
export function workspaceRegistryKey(name: string, generation: number): string {
  return generation === 0 ? name : `${name}#${generation}`;
}

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
export type WorkspaceSessionFactory = () => Promise<{ session: WorkspaceSession; end: () => Promise<void> } | undefined>;

/**
 * The coding workspaces one agent submission has touched, by key: the
 * workspace name, qualified by its retirement generation when it has one, so
 * a workspace retired mid-submission keeps its turn end beside its successor.
 */
export class WorkspaceTurnRegistry {
  private readonly workspaces = new Map<string, RegisteredWorkspace>();
  private readonly pending = new Map<string, Promise<WorkspaceSession | undefined>>();

  register(session: WorkspaceSession, end?: () => Promise<void>, key: string = session.name): void {
    this.workspaces.set(key, { session, ...(end ? { end } : {}) });
  }

  get(key: string): WorkspaceSession | undefined {
    return this.workspaces.get(key)?.session;
  }

  /**
   * The workspace registered under `key`, or one created now by `create`.
   * Creation builds only a handle: nothing reaches the Sandbox Durable Object
   * until a tool opens it. Concurrent callers share one creation, and a
   * failed or empty creation is retried by the next caller.
   */
  resolve(key: string, create: WorkspaceSessionFactory): Promise<WorkspaceSession | undefined> {
    const registered = this.get(key);
    if (registered) return Promise.resolve(registered);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = create().then((created) => {
        if (!created) return undefined;
        this.register(created.session, created.end, key);
        return created.session;
      }).finally(() => {
        this.pending.delete(key);
      });
      this.pending.set(key, pending);
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
 * submission's async context, so the workspace tools share one activation
 * per workspace, and re-renders on every model call find the same session.
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
