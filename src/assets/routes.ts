import { Hono } from 'hono';
import { readPublicAsset } from '#chickpea-assets';

import { PUBLIC_ASSET_PATHS } from './public-assets.ts';

export function createPublicAssetRoutes(): Hono {
  const app = new Hono();
  for (const path of PUBLIC_ASSET_PATHS) {
    app.get(`/${path}`, async (c) => {
      c.header('Content-Type', path.endsWith('.webp') ? 'image/webp' : 'image/png');
      c.header('Cache-Control', 'public, max-age=3600');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body((await readPublicAsset(path)).buffer);
    });
  }
  return app;
}
