import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MCP_SERVER_NAME } from '../src/management/connect.ts';
import { FIRST_TEAMMATE_STARTERS } from '../src/management/first-teammate.ts';

// The install guides on `main` are live product copy (chickpea.co/install.md
// redirects to them). After the connect step, the installing coding agent
// designs and creates the first teammate over MCP and proves it in Slack;
// nobody is handed to Slack to ask for one. These checks keep that step in
// both guides and keep its starter list byte-aligned with the catalog the
// Slack path and the `new-agent` prompt offer.

const GUIDES = {
  cloudflare: 'INSTALL_CHICKPEA_CLOUDFLARE.md',
  node: 'INSTALL_CHICKPEA_NODE.md',
} as const;

const TEAMMATE_HEADING = /^## (?:9\. )?Create the first teammate$/m;
const OPENING_QUESTION = 'What should your first teammate do for your team?';

async function guide(name: keyof typeof GUIDES): Promise<string> {
  return readFile(new URL(`../${GUIDES[name]}`, import.meta.url), 'utf8');
}

/** One `## ` section: from its heading to the next `## ` heading. */
function section(text: string, heading: RegExp): string {
  const start = text.search(heading);
  assert.ok(start >= 0, `section heading ${heading}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^## /m);
  return next >= 0 ? text.slice(start, start + 1 + next) : text.slice(start);
}

for (const name of Object.keys(GUIDES) as Array<keyof typeof GUIDES>) {
  test(`${GUIDES[name]}: the install ends with the first-teammate conversation, not a Slack hand-over`, async () => {
    const text = await guide(name);
    assert.match(text, TEAMMATE_HEADING);
    assert.doesNotMatch(text, /Help me create my first teammate/);
    assert.doesNotMatch(text, /ask (?:for|Chickpea for) a first teammate/i);
    // The connect step comes first and no longer claims to own the teammate.
    const connectAt = text.search(/^## (?:8\. )?Connect this coding agent$/m);
    const teammateAt = text.search(TEAMMATE_HEADING);
    assert.ok(connectAt >= 0 && connectAt < teammateAt, 'connect step precedes the first teammate');
    assert.doesNotMatch(text, /this guide already covers the first teammate/);
  });

  test(`${GUIDES[name]}: the step asks, offers the catalog verbatim, and never invents`, async () => {
    const step = section(await guide(name), TEAMMATE_HEADING);
    assert.match(step, new RegExp(`^> ${OPENING_QUESTION.replace(/[?]/g, '\\?')}$`, 'm'));
    assert.match(step, /never (?:as a table and never )?one (?:you|it) invents?/);
    assert.match(step, /the three that fit best/);
    assert.match(step, /nothing to connect/);
    const rows = step.split('\n').filter((line) => /^\d+\. @/.test(line));
    assert.equal(rows.length, FIRST_TEAMMATE_STARTERS.length, 'one line per starter');
    FIRST_TEAMMATE_STARTERS.forEach((starter, index) => {
      assert.equal(rows[index], `${index + 1}. @${starter.handle}: ${starter.pitch}`);
    });
    assert.match(step, /keeps its catalog name and handle\s+and uses these instructions unchanged/);
    const instructionRows = step.split('\n').filter((line) => /^- `@/.test(line));
    assert.equal(instructionRows.length, FIRST_TEAMMATE_STARTERS.length, 'one instruction line per starter');
    FIRST_TEAMMATE_STARTERS.forEach((starter, index) => {
      assert.equal(instructionRows[index], `- \`@${starter.handle}\` (${starter.name}): ${starter.instructions}`);
    });
    assert.match(step, /nothing is created while\s+that\s+is still open/);
    assert.match(step, /(?:If they|If you) decline a teammate or stop answering/);
    assert.match(step, /`inspect_workspace` again before/);
  });

  test(`${GUIDES[name]}: creation goes over MCP and verification is a real Slack reply`, async () => {
    const step = section(await guide(name), TEAMMATE_HEADING);
    assert.match(step, /chickpea:\/\/guide\/agent-authoring\/v1/);
    assert.match(step, /`apply_workspace_changes` in\s+that same\s+turn with exactly one\s+`create_agent` operation and nothing else/);
    assert.match(step, /(?:Do not add|no)\s+Channel reach,\s+connections,\s+repositories,\s+or schedules unless (?:the user|you) asked/);
    assert.match(step, /in\s+that same\s+turn/);
    assert.match(step, /say\s+"create it" or confirm a second time/);
    assert.match(step, /duplicate[- ]identity/i);
    assert.match(step, /do(?:es)? not retry unchanged/);
    assert.match(step, /whichever links (?:the result\s+returned|it received)/);
    assert.match(step, /never constructs? one/);
    assert.match(step, /Slack handle\s+needs attention/);
    assert.match(step, /created with its handle pending/);
    assert.match(step, /(?:request it for\s+this exact message|asks for approval first)/);
    assert.match(step, /A created Agent is not a\s+verified teammate/);
    assert.match(step, /`links\.admin`/);
    assert.match(step, /`links\.slack`/);
    assert.match(step, /mentions the new `@handle`/);
    assert.match(step, /substantive reply from the new Agent/);
    assert.match(step, /[Tt]he tool\s+result is not a\s+reply/);
    assert.match(step, /created but not verified/);
    assert.match(step, /two parts on separate lines/);
    assert.match(step, /created \(/);
    assert.match(step, /verified \(/);
    assert.match(step, new RegExp(`\`/mcp__${MCP_SERVER_NAME}__new-agent\``));
    assert.doesNotMatch(step, /through Slack instead\. [A-Z]/, 'the Slack fallback is refused, not offered');
    assert.match(step, /[Dd]o(?:es)? not create the teammate through Slack instead/);
  });
}

test('INSTALL_CHICKPEA_CLOUDFLARE.md: step 6 carries the use case to step 9 and the hand-over reports the teammate', async () => {
  const text = await guide('cloudflare');
  const stepSix = section(text, /^## 6\. Complete the first conversation in Slack$/m);
  assert.match(stepSix, /created from this conversation in step 9/);
  assert.match(stepSix, /Do not\s+create a teammate through Slack/);
  const stepEight = section(text, /^## 8\. Connect this coding agent$/m);
  assert.match(stepEight, /step 9 of this guide covers the first teammate/);
  const handOver = section(text, /^## Hand over$/m);
  assert.match(handOver, /first teammate from step 9 as two separate lines/);
  assert.match(handOver, /created, with its\s+`@handle` and the links the result returned/);
  assert.match(handOver, /verified, with whether a\s+real reply was observed/);
  assert.match(handOver, /Create\s+another teammate for us/);
  assert.match(handOver, /"Create our first teammate" if step 9 was\s+skipped/);
  const stepNine = section(text, TEAMMATE_HEADING);
  assert.match(stepNine, /only after\s+step 8 reported the connection as tested/);
  assert.match(handOver, new RegExp(`\`/mcp__${MCP_SERVER_NAME}__new-agent\``));
  assert.match(handOver, /Help\s+me update this Chickpea installation/);
  assert.match(text, /creating their first\s+teammate from this conversation in step 9/);
});
