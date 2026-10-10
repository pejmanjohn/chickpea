import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { renderSlackJourneyPage, renderSlackManualSetupPage } from '../src/admin/page.ts';
import { ADMIN_FONTS, FONT_ASSET_PATHS, fontFaceCss } from '../src/assets/fonts.ts';
import { PUBLIC_ASSET_PATHS } from '../src/assets/public-assets.ts';
import { buildSlackAppManifest, slackManifestPrefillUrl } from '../src/slack/app-manifest.ts';

const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: 'https://chickpea.example' });
const stylesheets = async () => ({
  journey: renderSlackJourneyPage({ surface: 's', eyebrow: 'E', title: 'T', body: '' }),
  guide: renderSlackManualSetupPage({
    state: 'awaiting_app_creation', destination: '/admin', manifest, manifestPrefillUrl: slackManifestPrefillUrl(manifest),
  }),
  admin: await readFile('assets/admin-ui/admin.css', 'utf8'),
});

function faces(css: string) {
  return [...css.matchAll(/@font-face\{([^}]*)\}/g)].map(([, body]) => ({
    family: /font-family:"([^"]+)"/.exec(body!)![1]!,
    weight: Number(/font-weight:(\d+)/.exec(body!)![1]),
    display: /font-display:(\w+)/.exec(body!)?.[1],
    url: /src:url\(([^)]+)\) format\("woff2"\)/.exec(body!)?.[1],
  }));
}

function weights(css: string): Record<string, number[]> {
  const byFamily: Record<string, Set<number>> = {};
  for (const { family, weight } of faces(css)) (byFamily[family] ??= new Set()).add(weight);
  return Object.fromEntries(Object.entries(byFamily).map(([family, set]) => [family, [...set].sort((a, b) => a - b)]));
}

test('Chickpea serves its own type: every face names a font file it publishes, and nothing loads type from elsewhere', async () => {
  for (const [name, css] of Object.entries(await stylesheets())) {
    assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|@import/, name);
    const declared = faces(css);
    assert.ok(declared.length > 0, `${name} declares its faces`);
    for (const { url, display } of declared) {
      assert.equal(display, 'swap', `${name}: text shows at once in a fallback face`);
      assert.ok(url?.startsWith('/') && PUBLIC_ASSET_PATHS.includes(url.slice(1)), `${name}: ${url} is a public asset`);
      assert.equal((await readFile(`assets${url}`)).subarray(0, 4).toString('latin1'), 'wOF2', `${url} is a WOFF2 font`);
    }
  }
  assert.ok(FONT_ASSET_PATHS.every((path) => PUBLIC_ASSET_PATHS.includes(path)));
});

test('each page keeps the weights it always loaded, one face per weight', async () => {
  const { journey, guide, admin } = await stylesheets();
  assert.deepEqual(weights(journey), { 'Baloo 2': [600, 700, 800], Quicksand: [500, 600, 700] });
  const adminWeights = { 'Baloo 2': [500, 600, 700, 800], Quicksand: [400, 500, 600, 700], 'JetBrains Mono': [400, 500] };
  assert.deepEqual(weights(guide), adminWeights);
  assert.deepEqual(weights(admin), adminWeights);
  assert.ok(admin.startsWith(`${fontFaceCss(ADMIN_FONTS)}\n`), 'Admin\'s stylesheet opens with the faces the pages declare');
});

test('every font family ships with its licence beside its files', async () => {
  for (const dir of new Set(FONT_ASSET_PATHS.map((path) => dirname(path)))) {
    const licence = await readFile(`assets/${dir}/OFL.txt`, 'utf8');
    assert.match(licence, /^\uFEFF?Copyright /, dir);
    assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/, dir);
  }
});
