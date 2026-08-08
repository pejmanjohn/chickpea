import { Hono, type Context } from 'hono';

import {
  joinBootstrapScript,
  renderJoinBootstrapPage,
  renderResetBootstrapPage,
  resetBootstrapScript,
} from './page.ts';

const JOIN_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function createJoinRoutes(): Hono {
  const app = new Hono();

  app.get('/join', (c) => {
    joinHeaders(c);
    return c.html(renderJoinBootstrapPage());
  });

  app.get('/join/bootstrap.js', (c) => {
    joinHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    return c.body(joinBootstrapScript());
  });

  app.get('/reset', (c) => {
    joinHeaders(c);
    return c.html(renderResetBootstrapPage());
  });

  app.get('/reset/bootstrap.js', (c) => {
    joinHeaders(c);
    c.header('Content-Type', 'application/javascript; charset=UTF-8');
    return c.body(resetBootstrapScript());
  });

  return app;
}

function joinHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', JOIN_CSP);
}
