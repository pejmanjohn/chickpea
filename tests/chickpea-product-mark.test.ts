import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';

import {
  renderAdminPage,
  renderSlackManualSetupPage,
  renderSlackSignInPage,
} from '../src/admin/page.ts';
import {
  CHICKPEA_FAVICON_DATA_URL,
  CHICKPEA_MARK_DATA_URL,
  CHICKPEA_WORDMARK_DATA_URL,
} from '../src/brand/chickpea-mark.ts';
import { buildSlackAppManifest, slackManifestPrefillUrl } from '../src/slack/app-manifest.ts';

async function dataUrlBytes(dataUrl: string): Promise<Buffer> {
  return Buffer.from(await (await fetch(dataUrl)).arrayBuffer());
}

const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: true, palette: false };

async function derivative(source: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(source)
    .resize(width, height, { fit: 'fill' })
    .png(PNG_OPTIONS)
    .toBuffer();
}

test('the same Chickpea mark and colorable wordmark are embedded across product surfaces', async () => {
  const manifest = buildSlackAppManifest({
    kind: 'workspace_app',
    origin: 'https://chickpea.example',
  });
  const surfaces = [
    renderSlackSignInPage('/admin'),
    renderSlackManualSetupPage({
      destination: '/admin/onboarding',
      manifest,
      manifestPrefillUrl: slackManifestPrefillUrl(manifest),
    }),
    renderAdminPage(),
  ];

  assert.equal(
    surfaces[2]?.split(CHICKPEA_MARK_DATA_URL).length,
    4,
    'Admin embeds the mark only for the large favicon and two progressive-render lockups',
  );
  assert.match(surfaces[2] ?? '', /\.brand-home\s*\{[^}]*color:\s*inherit/s);
  assert.match(surfaces[2] ?? '', /\.primary-shell-brand\s*\{[^}]*color:\s*var\(--text\)/s);

  for (const html of surfaces) {
    assert.ok(html.includes(`href="${CHICKPEA_FAVICON_DATA_URL}"`));
    assert.ok(html.includes(`sizes="128x128" href="${CHICKPEA_MARK_DATA_URL}"`));
    assert.ok(html.includes(`src="${CHICKPEA_MARK_DATA_URL}"`));
    assert.ok(html.includes(CHICKPEA_WORDMARK_DATA_URL));
    assert.match(html, /class="brand-wordmark"/);
    assert.match(html, /\.brand-wordmark\s*\{[^}]*background-color:\s*currentColor/s);
    assert.match(html, /-webkit-mask:\s*var\(--chickpea-wordmark-image\)/);
    assert.match(html, /(?:^|[;{])\s*mask:\s*var\(--chickpea-wordmark-image\)/s);
    const wordmarkRule = html.match(/\.brand-wordmark\s*\{([^}]*)\}/s)?.[1] ?? '';
    assert.doesNotMatch(wordmarkRule, /(?:^|;)\s*color\s*:/);
    assert.match(wordmarkRule, /print-color-adjust:\s*exact/);
    assert.doesNotMatch(html, /class="(?:auth-)?brand-name">Chickpea<\/span>/);
    assert.doesNotMatch(html, /class="auth-brand" aria-label="Chickpea"/);
    assert.doesNotMatch(html, /type="image\/svg\+xml"|<svg class="(?:auth-brand-mark|pea)"/);
  }

  const markMaster = await readFile(new URL('../assets/chickpea-mark.png', import.meta.url));
  const mark128 = await readFile(new URL('../assets/chickpea-mark-128.png', import.meta.url));
  const favicon32 = await readFile(new URL('../assets/chickpea-favicon-32.png', import.meta.url));
  const wordmarkMaster = await readFile(
    new URL('../assets/chickpea-wordmark-mask.png', import.meta.url),
  );
  const wordmark512 = await readFile(
    new URL('../assets/chickpea-wordmark-512.png', import.meta.url),
  );
  assert.deepEqual(mark128, await derivative(markMaster, 128, 128));
  assert.deepEqual(favicon32, await derivative(markMaster, 32, 32));
  assert.deepEqual(wordmark512, await derivative(wordmarkMaster, 512, 126));
  assert.deepEqual(await dataUrlBytes(CHICKPEA_MARK_DATA_URL), mark128);
  assert.deepEqual(await dataUrlBytes(CHICKPEA_FAVICON_DATA_URL), favicon32);
  assert.deepEqual(await dataUrlBytes(CHICKPEA_WORDMARK_DATA_URL), wordmark512);
  assert.ok(CHICKPEA_WORDMARK_DATA_URL.length < 40_000, 'runtime wordmark stays compact');

  const metadata = await sharp(wordmarkMaster).metadata();
  assert.equal(metadata.hasAlpha, true, 'wordmark master must preserve alpha transparency');
  const alpha = (await sharp(wordmarkMaster).ensureAlpha().stats()).channels[3];
  assert.ok(alpha, 'wordmark master must expose an alpha channel');
  assert.equal(alpha.min, 0, 'wordmark master must contain transparent pixels');
  assert.equal(alpha.max, 255, 'wordmark master must contain opaque pixels');
});
