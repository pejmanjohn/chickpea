import { Hono } from 'hono';
import { readPublicAsset } from '#chickpea-assets';

import { PUBLIC_ASSET_PATHS } from './public-assets.ts';

export function createPublicAssetRoutes(): Hono {
  const app = new Hono();
  for (const path of PUBLIC_ASSET_PATHS) {
    app.get(`/${path}`, async (c) => {
      if (path === 'chickpea-chatgpt-connect.mjs') c.header('Content-Disposition', 'attachment; filename="chickpea-chatgpt-connect.mjs"');
      c.header('Content-Type', publicAssetContentType(path));
      c.header('Cache-Control', 'public, max-age=3600');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body((await readPublicAsset(path)).buffer);
    });
  }
  return app;
}

function publicAssetContentType(path: string): string {
  if ((path.endsWith('.js') || path.endsWith('.mjs'))) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.woff2')) return 'font/woff2';
  return 'image/png';
}
