import { type Context, type ExecutionContext, Hono } from 'hono';

import { onDemand } from '../runtime/on-demand.ts';

/**
 * Routes whose module loads on the first request to one of `paths` and never
 * at Worker startup. Every module the entry imports statically loads before a
 * Durable Object's constructor runs, so a request-only surface mounts through
 * this and a Slack turn never pays for it. The loaded sub-app answers the
 * request itself, so `paths` must cover every route it registers.
 */
export function lazyRoutes(name: string, paths: readonly string[], load: () => Promise<Hono>): Hono {
  const routes = onDemand(name, load);
  const app = new Hono();
  const handle = async (c: Context): Promise<Response> =>
    (await routes.load()).fetch(c.req.raw, c.env, executionContext(c));
  for (const path of paths) app.all(path, handle);
  return app;
}

/** Hono's getter throws where the request has no ExecutionContext (Node, tests). */
function executionContext(c: Context): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
