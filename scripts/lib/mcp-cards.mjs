import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Builds the ChatGPT Agent card: one self-contained HTML document, its script
 * and styles inline, because an MCP App's CSP blocks external files. Hosts
 * cache a card by its URI, so `publishAgentCard` gives every change a new
 * version in published.json instead of editing a published one.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CARD = join(ROOT, 'src', 'mcp-cards', 'agent-card');
export const PUBLISHED_PATH = join(CARD, 'published.json');

export function readPublished() {
  return JSON.parse(readFileSync(PUBLISHED_PATH, 'utf8'));
}

export function assetPath(version) {
  return `mcp-cards/agent-card-v${version}.html.txt`;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function buildAgentCard(version) {
  const script = await build({
    entryPoints: [join(CARD, 'main.ts')],
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
  const cardStyles = readFileSync(join(CARD, 'card.css'), 'utf8');
  const js = script.outputFiles[0].text.replaceAll('</script', '<\\/script');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Chickpea Agent card</title>',
    `<style>${hostStyles}\n${cardStyles}</style></head>`,
    `<body><div id="card"></div><script>${js}</script></body>`,
    '</html>',
    '',
  ].join('\n');
}

/**
 * The card for the newest published version, or, when the source changed
 * since, the next version with its hash appended to published.json.
 */
export async function publishAgentCard() {
  const published = readPublished();
  const latest = published.at(-1);
  const current = await buildAgentCard(latest.version);
  if (latest.sha256 === sha256(current)) return { version: latest.version, html: current, published };
  const version = latest.version + 1;
  const html = await buildAgentCard(version);
  return { version, html, published: [...published, { version, sha256: sha256(html) }] };
}
