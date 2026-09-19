import { Hono, type Context } from 'hono';

import { requestOrigin } from '../http/request-origin.ts';
import {
  CONNECT_MARKDOWN_PATH,
  CONNECT_PAGE_PATH,
  connectMarkdown,
  connectOrigin,
  connectPageHtml,
} from './connect.ts';

/**
 * Public, unauthenticated connect surface: `GET /connect.md` for the coding
 * agent and `GET /connect` for the person. Both render from the request's
 * public origin so the URLs inside are real for this deployment. They work
 * before Slack setup is finished; the guide itself explains that `/mcp`
 * answers 404 until then.
 */
export function createConnectRoutes(): Hono {
  const app = new Hono();

  app.get(CONNECT_MARKDOWN_PATH, (c) => {
    const origin = resolveOrigin(c);
    if (!origin) return c.notFound();
    publicHeaders(c);
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    return c.body(connectMarkdown(origin));
  });

  app.get(CONNECT_PAGE_PATH, (c) => {
    const origin = resolveOrigin(c);
    if (!origin) return c.notFound();
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    publicHeaders(c);
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    c.header('X-Frame-Options', 'DENY');
    return c.body(connectPageHtml(origin, nonce));
  });

  return app;
}

function resolveOrigin(c: Context): string | undefined {
  return connectOrigin(requestOrigin(c));
}

function publicHeaders(c: Context): void {
  // Content depends only on the public origin, so short shared caching is
  // safe; a changed SLACK_TAG_PUBLIC_URL or host shows up within minutes. On
  // Node the origin can also come from the forwarded headers, so a shared
  // cache must key on them too, or one caller's forwarded host would be
  // served to everyone behind the same Host for five minutes.
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Vary', 'Host, X-Forwarded-Host, X-Forwarded-Proto');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
}
