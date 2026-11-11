import { PUBLIC_ASSET_PATHS } from '../assets/public-assets.ts';

/**
 * Every path Admin, the setup links and the connect pages answer
 * (admin/routes.ts, management/setup-routes.ts, management/connect-routes.ts).
 * app.ts mounts the three under these paths and loads them on the first such
 * request in an isolate, never at Worker startup; a Slack turn needs none of
 * them. tests/lazy-routes.test.ts holds each module to this list.
 */
export const ADMIN_ROUTE_PATHS: readonly string[] = [
  '/',
  '/admin',
  '/admin/*',
  '/setup/*',
  '/connect',
  '/connect.md',
  '/connect-chatgpt.md',
  '/managed-connections/return',
  '/oauth/callback',
  '/oauth/api/callback',
  '/oauth/github/setup/callback',
  '/auth/slack/*',
  '/auth/chatgpt-plan/*',
  '/internal/deployment/*',
  '/internal/environment/*',
  '/assets/*',
  '/webhooks/composio',
  '/.well-known/oauth-client-metadata.json',
  ...PUBLIC_ASSET_PATHS.map((path) => `/${path}`),
];
