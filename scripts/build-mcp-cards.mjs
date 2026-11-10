import { readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assetPath, PUBLISHED_PATH, publishAgentCard } from './lib/mcp-cards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version, html, published } = await publishAgentCard();
const target = join(ROOT, 'assets', assetPath(version));
mkdirSync(dirname(target), { recursive: true });
for (const file of readdirSync(dirname(target))) {
  if (file.startsWith('agent-card-v') && join(dirname(target), file) !== target) rmSync(join(dirname(target), file));
}
writeFileSync(target, html);
writeFileSync(PUBLISHED_PATH, `${JSON.stringify(published, null, 2)}\n`);
console.log(`Agent card v${version}: assets/${assetPath(version)} (${html.length} bytes)`);
