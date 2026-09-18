import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { CONNECT_CLIENTS, MCP_SERVER_NAME } from '../src/management/connect.ts';

// The install guides on `main` are what chickpea.co/install.md and
// install-mac.md redirect to, so their connect step is product copy that runs
// the same day it merges. These checks keep it a required step and keep its
// fallback table (for releases that predate `/connect.md`) aligned with the
// server's own client list.

const GUIDES = {
  cloudflare: 'INSTALL_CHICKPEA_CLOUDFLARE.md',
  node: 'INSTALL_CHICKPEA_NODE.md',
} as const;

const PLACEHOLDER_URL = 'https://<deployment>/mcp';

async function guide(name: keyof typeof GUIDES): Promise<string> {
  return readFile(new URL(`../${GUIDES[name]}`, import.meta.url), 'utf8');
}

const CONNECT_HEADING = /^## (?:8\. )?Connect this coding agent$/m;

/** The connect section alone: from its heading to the next `## ` heading. */
function connectSection(text: string): string {
  const start = text.search(CONNECT_HEADING);
  assert.ok(start >= 0, 'connect section heading');
  const rest = text.slice(start + 1);
  const next = rest.search(/^## /m);
  return next >= 0 ? text.slice(start, start + 1 + next) : text.slice(start);
}

for (const name of Object.keys(GUIDES) as Array<keyof typeof GUIDES>) {
  test(`${GUIDES[name]}: connecting this coding agent is a required step`, async () => {
    const text = await guide(name);
    assert.match(text, CONNECT_HEADING);
    assert.doesNotMatch(text, /Optional: connect a coding agent/);
    for (const line of text.split('\n')) {
      if (/MCP server|coding[- ]agent/i.test(line)) {
        assert.doesNotMatch(line, /\boptional\b/i, `MCP is described as optional: ${line}`);
      }
    }
  });

  test(`${GUIDES[name]}: the step points at /connect.md and proves the connection`, async () => {
    const step = connectSection(await guide(name));
    assert.match(step, /https:\/\/<deployment>\/connect\.md/);
    assert.match(step, /steps 1\s+to 5/);
    assert.match(step, /answers 404/);
    assert.match(step, /`inspect_workspace`\s+without\s+making\s+changes/);
    assert.match(step, /three\s+parts\s+on\s+separate\s+lines/);
    assert.match(step, /configured\s+\(/);
    assert.match(step, /signed\s+in\s+\(/);
    assert.match(step, /tested\s+\(/);
    assert.match(step, /needs\s+a\s+restart/);
    assert.match(step, /[Nn]ever\s+creates?,\s+cop(?:y|ies),\s+or\s+pastes?\s+a\s+bearer\s+token/);
    assert.match(step, /\*\*Settings → MCP\*\*/);
  });

  test(`${GUIDES[name]}: the fallback table matches CONNECT_CLIENTS`, async () => {
    const step = connectSection(await guide(name));
    const rows = step.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Client') && !line.startsWith('| ---'));
    assert.equal(rows.length, CONNECT_CLIENTS.length, 'one table row per client');
    for (const client of CONNECT_CLIENTS) {
      const row = rows.find((line) => line.startsWith(`| ${client.title} |`));
      assert.ok(row, `row for ${client.title}`);
      assert.ok(row.startsWith(`| ${client.title} | ${client.where} | `), `${client.title} row names where the configuration lives`);
      const snippet = client.snippet(PLACEHOLDER_URL);
      const expected = client.language === 'json'
        ? [JSON.stringify(JSON.parse(snippet))]
        : snippet.split('\n');
      for (const piece of expected) {
        assert.ok(row.includes(`\`${piece}\``), `${client.title} row carries ${piece}`);
      }
    }
    assert.match(step, new RegExp(`server name \`${MCP_SERVER_NAME}\``));
  });
}

test('SETUP_AGENT.md: step 9 no longer calls the MCP connection optional', async () => {
  const text = await readFile(new URL('../SETUP_AGENT.md', import.meta.url), 'utf8');
  const step = text.split('\n').find((line) => line.startsWith('9. '));
  assert.ok(step, 'step 9 exists');
  assert.doesNotMatch(step, /\boptional\b/i);
  assert.match(step, /management MCP server/);
});
