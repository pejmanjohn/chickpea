import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { ADMIN_ROUTE_PATHS } from '../src/admin/route-paths.ts';
import { createAdminRoutes } from '../src/admin/routes.ts';
import { betterAuthPublicRouteKeys } from '../src/auth/better-auth-routes.ts';
import { createBetterAuthRuntimeRoutes } from '../src/auth/better-auth-runtime.ts';
import { createMcpOAuthRuntimeRoutes } from '../src/auth/mcp-oauth-routes.ts';
import { BETTER_AUTH_PUBLIC_PATHS, MCP_OAUTH_PATHS } from '../src/auth/public-auth-paths.ts';
import { lazyRoutes } from '../src/http/lazy-routes.ts';
import { createConnectRoutes } from '../src/management/connect-routes.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';

/** A request path a registered route pattern answers: `:param` and `*` become one segment. */
function examplePath(pattern: string): string {
  return pattern.replace(/:[^/]+/g, 'x').replace(/\*/g, 'x');
}

/** app.ts mounts each of these lazily; the module must register nothing outside its mount paths. */
const SURFACES = [
  { name: 'Better Auth', paths: BETTER_AUTH_PUBLIC_PATHS, routes: () => createBetterAuthRuntimeRoutes() },
  { name: 'MCP OAuth', paths: MCP_OAUTH_PATHS, routes: () => createMcpOAuthRuntimeRoutes() },
  { name: 'Admin', paths: ADMIN_ROUTE_PATHS, routes: () => createAdminRoutes() },
  { name: 'setup', paths: ADMIN_ROUTE_PATHS, routes: () => createManagementSetupRoutes() },
  { name: 'connect', paths: ADMIN_ROUTE_PATHS, routes: () => createConnectRoutes() },
];

for (const surface of SURFACES) {
  test(`the lazy ${surface.name} mount covers every route its module registers`, async () => {
    const mount = lazyRoutes(surface.name, surface.paths, async () => new Hono().all('*', (c) => c.text('mounted')));
    const app = new Hono().route('/', mount);
    for (const route of surface.routes().routes) {
      // Admin's catch-all middlewares run on its own paths only.
      if (route.path === '/*') continue;
      const method = route.method === 'ALL' ? 'POST' : route.method;
      const response = await app.request(examplePath(route.path), { method });
      assert.equal(response.status, 200, `${method} ${route.path} is registered outside the lazy mount`);
    }
  });
}

test('the lazy Better Auth mount answers every route of the public handler\'s own table', async () => {
  // The runtime module registers its routes from the same path list the mount uses, so this
  // checks the handler's deny-by-default route table instead, which the list must cover.
  const mount = lazyRoutes('Better Auth', BETTER_AUTH_PUBLIC_PATHS, async () => new Hono().all('*', (c) => c.text('mounted')));
  const app = new Hono().route('/', mount);
  const keys = betterAuthPublicRouteKeys();
  assert.ok(keys.length >= 13, 'the public route table is the one under test');
  for (const key of keys) {
    const [method, path] = key.split(' ') as [string, string];
    const response = await app.request(path, { method });
    assert.equal(response.status, 200, `${key} is outside the lazy Better Auth mount`);
  }
});

test('a lazy mount leaves its neighbours alone and loads its module once, on the first matching request', async () => {
  let loads = 0;
  const mount = lazyRoutes('probe', ['/mcp', '/auth/mcp/*'], async () => {
    loads += 1;
    return new Hono().all('*', (c) => c.text(`mounted ${c.req.path}`));
  });
  const app = new Hono().route('/', mount).post('/channels/slack/events', (c) => c.text('slack'));
  assert.equal(await (await app.request('/channels/slack/events', { method: 'POST' })).text(), 'slack');
  for (const path of ['/mcpx', '/mcp/x', '/auth/mcpx', '/auth/mc']) {
    assert.equal((await app.request(path)).status, 404, `${path} is not behind the mount`);
  }
  assert.equal(loads, 0, 'nothing matched, so the module did not load');
  assert.equal(await (await app.request('/mcp', { method: 'POST' })).text(), 'mounted /mcp');
  assert.equal(await (await app.request('/auth/mcp/login')).text(), 'mounted /auth/mcp/login');
  assert.equal(await (await app.request('/mcp', { method: 'POST' })).text(), 'mounted /mcp');
  assert.equal(loads, 1, 'three matching requests shared one load');
});
