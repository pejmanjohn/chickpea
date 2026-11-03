/**
 * The request-only authentication surfaces app.ts mounts lazily. Each list
 * covers every route its module registers (tests/lazy-routes.test.ts holds
 * them to that), so the module loads on the first such request in an isolate
 * and never at Worker startup; a Slack turn needs neither.
 */

/** Better Auth's public paths (auth/better-auth-runtime.ts). */
export const BETTER_AUTH_PUBLIC_PATHS = [
  '/api/auth/*',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server/api/auth',
] as const;

/** The MCP resource and its sign-in and consent pages (auth/mcp-oauth-routes.ts). */
export const MCP_OAUTH_PATHS = ['/mcp', '/auth/mcp/*'] as const;
