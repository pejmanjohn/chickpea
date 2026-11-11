import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Builds the ChatGPT cards: each one self-contained HTML document, its script
 * and styles inline, because an MCP App's CSP blocks external files. Hosts
 * cache a card by its URI, so `publishCard` never edits a released version:
 * a change to one publishes the next version in published.json. Until the
 * coordinator marks the newest version `released`, when it pins it to
 * production, a change rebuilds that version in place.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CARDS = join(ROOT, 'src', 'mcp-cards');
export const PUBLISHED_PATH = join(CARDS, 'published.json');

/** Each card's page title. */
export const CARD_TITLES = {
  'agent-card': 'Chickpea Agent card',
  'connect-card': 'Chickpea connect card',
  'health-card': 'Chickpea health card',
};

export function readPublished() {
  return JSON.parse(readFileSync(PUBLISHED_PATH, 'utf8'));
}

export function assetPath(card, version) {
  return `mcp-cards/${card}-v${version}.html.txt`;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function buildCard(card, version) {
  const script = await build({
    entryPoints: [join(CARDS, card, 'main.ts')],
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    legalComments: 'none',
    define: { CARD_VERSION: String(version) },
    logLevel: 'silent',
  });
  const hostStyles = readFileSync(createRequire(import.meta.url).resolve('@openai/mcp-extensions/app/styles.css'), 'utf8');
  const cardStyles = readFileSync(join(CARDS, 'card.css'), 'utf8');
  const js = script.outputFiles[0].text.replaceAll('</script', '<\\/script');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${CARD_TITLES[card]}</title>`,
    `<style>${hostStyles}\n${cardStyles}</style></head>`,
    `<body><div id="card"></div><script>${js}</script></body>`,
    '</html>',
    '',
  ].join('\n');
}

/**
 * The card's newest version when its page is unchanged. When it changed:
 * that version rebuilt in place while it is unreleased, or else the next
 * version, appended unreleased to the card's list in published.json.
 */
export async function publishCard(card, { published = readPublished(), build = buildCard } = {}) {
  const versions = published[card] ?? [];
  const latest = versions.at(-1);
  if (latest) {
    const current = await build(card, latest.version);
    if (latest.sha256 === sha256(current)) return { card, version: latest.version, html: current, published };
    if (!latest.released) {
      const rebuilt = { version: latest.version, sha256: sha256(current), released: false };
      return { card, version: latest.version, html: current, published: { ...published, [card]: [...versions.slice(0, -1), rebuilt] } };
    }
  }
  const version = (latest?.version ?? 0) + 1;
  const html = await build(card, version);
  return { card, version, html, published: { ...published, [card]: [...versions, { version, sha256: sha256(html), released: false }] } };
}

/**
 * Writes a card and the list of versions. Every older file stays as it was:
 * a chat drawn with a released card asks for that one again.
 */
export function saveCard({ card, version, html, published }, { assets = join(ROOT, 'assets'), publishedPath = PUBLISHED_PATH } = {}) {
  const target = join(assets, assetPath(card, version));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
  writeFileSync(publishedPath, `${JSON.stringify(published, null, 2)}\n`);
  return target;
}
