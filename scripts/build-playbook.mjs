#!/usr/bin/env node
/**
 * `npm run playbook:build`: writes src/management/playbook/playbook.json from
 * the Markdown beside it. The Markdown is the source: the plugin's skills
 * vendor those files from a pinned commit, and the Worker reads the JSON,
 * because Node and the Worker build both import JSON and neither imports
 * Markdown. tests/management-mcp-v5-guide.test.ts fails while the two differ.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAYBOOK_DIR = fileURLToPath(new URL('../src/management/playbook/', import.meta.url));
export const PLAYBOOK_JSON = path.join(PLAYBOOK_DIR, 'playbook.json');

/** Each `.md` file in `directory` by its name without `.md`, in name order. */
function markdownFiles(directory) {
  return Object.fromEntries(readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => [file.slice(0, -'.md'.length), readFileSync(path.join(directory, file), 'utf8')]));
}

/** The sections (one per topic) and the partials they include, exactly as the files hold them. */
export function readPlaybook(directory = PLAYBOOK_DIR) {
  return { sections: markdownFiles(directory), partials: markdownFiles(path.join(directory, 'partials')) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const playbook = readPlaybook();
  writeFileSync(PLAYBOOK_JSON, `${JSON.stringify(playbook, null, 2)}\n`);
  const sizes = Object.entries(playbook.sections).map(([name, text]) => `${name} ${text.length}`).join(', ');
  console.log(`playbook.json: ${Object.keys(playbook.sections).length} sections (${sizes}), ${Object.keys(playbook.partials).length} partials`);
}
