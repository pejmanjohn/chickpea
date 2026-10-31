import { Hono, type Context } from 'hono';

import { requestOrigin } from '../http/request-origin.ts';
import { chatgptConnectMarkdown } from './chatgpt-connect.ts';
import {
  CONNECT_MARKDOWN_PATH,
  CONNECT_PAGE_PATH,
  MANAGED_SIGN_IN_RETURN_PATH,
  connectMarkdown,
  connectOrigin,
  connectPageHtml,
} from './connect.ts';
import { renderManagedSignInReturnPage } from './connector-landing-page.ts';

/**
 * Public, unauthenticated connect surface: `GET /connect.md` for the coding
 * agent and `GET /connect` for the person. Both render from the request's
 * public origin so the URLs inside are real for this deployment. They work
 * before Slack setup is finished; the guide itself explains that `/mcp`
 * answers 404 until then. The managed sign-in return page lives here too:
 * a hosted deployment mounts these routes ahead of its per-installation
 * routing, so the page needs no session there either.
 */
export function createConnectRoutes(): Hono {
  const app = new Hono();

  app.get('/connect-chatgpt.md', (c) => {
    const origin = resolveOrigin(c);
    if (!origin) return c.notFound();
    publicHeaders(c);
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    return c.body(chatgptConnectMarkdown(origin));
  });

  app.get(CONNECT_MARKDOWN_PATH, (c) => {
    const origin = resolveOrigin(c);
    if (!origin) return c.notFound();
    publicHeaders(c);
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    return c.body(connectMarkdown(origin, c.env as Record<string, unknown> | undefined));
  });

  app.get(CONNECT_PAGE_PATH, (c) => {
    const origin = resolveOrigin(c);
    if (!origin) return c.notFound();
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    publicHeaders(c);
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; script-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    c.header('X-Frame-Options', 'DENY');
    return c.body(connectPageHtml(origin, nonce));
  });

  // Static: the provider appends its own query (status, account), and none
  // of it is read. No Cross-Origin-Opener-Policy, so arriving here forces no
  // browsing context switch that could cost the tab its script-opened status
  // and with it window.close().
  app.get(MANAGED_SIGN_IN_RETURN_PATH, (c) => {
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; script-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    return c.html(renderManagedSignInReturnPage(nonce));
  });

  return app;
}

function resolveOrigin(c: Context): string | undefined {
  return connectOrigin(requestOrigin(c));
}

function publicHeaders(c: Context): void {
  // Content depends only on the public origin and the deployment's fixed
  // tenancy, so short shared caching is safe; a changed SLACK_TAG_PUBLIC_URL
  // or host shows up within minutes. On Node the origin can also come from
  // the forwarded headers, so a shared cache must key on them too, or one
  // caller's forwarded host would be served to everyone behind the same Host
  // for five minutes.
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Vary', 'Host, X-Forwarded-Host, X-Forwarded-Proto');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
}
