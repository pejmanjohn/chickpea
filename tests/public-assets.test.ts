import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { createPublicAssetRoutes } from '../src/assets/routes.ts';
import { PUBLIC_ASSET_PATHS } from '../src/assets/public-assets.ts';
import { readPublicAsset } from '../src/assets/read.node.ts';
import { onboardingAssetBytes } from '../src/admin/onboarding-assets.ts';
import { CONNECTOR_LOGOS } from '../src/config/connector-logos.ts';

test('Cloudflare build publishes only runtime images', { skip: !existsSync('dist-cf/client') }, async () => {
  const files = (await readdir('dist-cf/client', { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== '.assetsignore')
    .map((entry) => `${entry.parentPath}/${entry.name}`.replace(/^dist-cf\/client\//, ''));
  assert.deepEqual(files.sort(), [...PUBLIC_ASSET_PATHS].sort());
  for (const path of files) {
    assert.deepEqual(await readFile(`dist-cf/client/${path}`), await readFile(`assets/${path}`), path);
  }
});

test('every public image is served byte-identically without authentication', async () => {
  const app = createPublicAssetRoutes();
  for (const path of PUBLIC_ASSET_PATHS) {
    const response = await app.request(`/${path}?v=cache-key`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), path.endsWith('.webp') ? 'image/webp' : 'image/png');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(`assets/${path}`), path);
  }
});

test('asset reads reject unknown and traversal paths', async () => {
  const app = createPublicAssetRoutes();
  for (const path of ['../package.json', '/chickpea-mark-128.png', 'onboarding/missing.webp', 'onboarding/%2e%2e/package.json']) {
    await assert.rejects(readPublicAsset(path), /Unknown public asset/);
    assert.equal((await app.request(`/${path}`)).status, 404, path);
  }
});

test('existing onboarding URLs still return the same static bytes', async () => {
  const bytes = await onboardingAssetBytes('ready.webp');
  assert.ok(bytes);
  assert.deepEqual(Buffer.from(bytes), await readFile('assets/onboarding/ready.webp'));
  assert.equal(await onboardingAssetBytes('../chickpea-mark.png'), undefined);
});

test('raster connector icons reference served static assets rather than data URLs', async () => {
  const app = createPublicAssetRoutes();
  const raster = Object.values(CONNECTOR_LOGOS).filter((logo) => logo.raster);
  assert.equal(raster.length, 9);
  for (const logo of raster) {
    const src = logo.svg.match(/src="([^"]+)"/)?.[1];
    assert.ok(src);
    assert.ok(src.startsWith('/connectors/'));
    assert.equal((await app.request(src)).status, 200);
  }
});
