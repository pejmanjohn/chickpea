import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  changeSetAccessFits,
  KEY_DETAILS_CHARACTER_BUDGET,
} from '../src/management/change-set-presentation.ts';
import { formatMarkdownChangeSetProposal } from '../src/management/markdown-presentation.ts';
import {
  formatSlackChangeSetProposal,
  SLACK_PRESENTATION_DIALECT,
} from '../src/management/slack-presentation.ts';
import { summarizeTextChange } from '../src/management/text-changes.ts';
import type { ManagementChangeSetPreview } from '../src/management/types.ts';
import {
  longSkillEdits,
  rewordItems,
  rewordMarker,
  syntheticItem,
  syntheticParagraph,
  syntheticSection,
  syntheticSkill,
} from './helpers/synthetic-skill.ts';

const SLACK_APPROVAL = 'Reply `approve` to apply these exact changes, or tell me what to adjust.';
const SKILL = syntheticSkill();
const DESCRIPTION = 'Prepare the weekly operations review. Use it when someone asks for the review, the ' +
  'leadership summary, or the status of any review area. It reads the tracker export, compares it with ' +
  "last week's notes, lists every owner, date, and status that changed, and drafts the summary in the house " +
  'style. It does not send anything; the person reviews and posts the summary. It works for one area or for ' +
  'all of them, and it says which areas had no changes.';
const BASE_SKILL = { name: 'weekly-review', description: DESCRIPTION, instructions: SKILL, enabled: true };

function agentEdit(before: Record<string, unknown>, after: Record<string, unknown>): ManagementChangeSetPreview {
  const research = { name: 'Research', slackPresence: { normalizedHandle: 'research' } };
  return {
    summary: '1 reviewed workspace change',
    changes: [{
      itemId: 'edit',
      operationKind: 'update_agent',
      target: 'agent:agent_research',
      before: { ...research, ...before },
      after: { ...research, ...after },
    }],
    missingSetup: [],
  };
}

function skillEdit(before: Partial<typeof BASE_SKILL>, after: Partial<typeof BASE_SKILL>): ManagementChangeSetPreview {
  return agentEdit({ skills: [{ ...BASE_SKILL, ...before }] }, { skills: [{ ...BASE_SKILL, ...after }] });
}

const KEY_DETAILS =
  /^((?:[•-] .*\n)*\n?)(?:(?:And (\d+) more changes?|(Only spacing or line breaks change))\. )?Approval applies the full (\w+)\.$/gm;

/** What a person reads: Slack shows `&amp;`, `&lt;` and `&gt;` as the characters. */
function visible(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

interface KeyDetails {
  text: string;
  listed: string[];
  unlisted: number;
  spacingOnly: boolean;
  noun: string;
}

function keyDetails(text: string): KeyDetails[] {
  return Array.from(text.matchAll(KEY_DETAILS), (match) => ({
    text: match[0],
    listed: match[1]!.split('\n').filter(Boolean),
    unlisted: Number(match[2] ?? 0),
    spacingOnly: match[3] !== undefined,
    noun: match[4]!,
  }));
}

/**
 * The one key-details block for `noun` fits the budget, lists the first
 * change, and lists or counts every change.
 */
function assertAccounted(text: string, noun: string, before: string, after: string): KeyDetails {
  const blocks = keyDetails(text).filter((block) => block.noun === noun);
  assert.equal(blocks.length, 1, text);
  const block = blocks[0]!;
  const length = visible(block.text).length;
  assert.ok(length <= KEY_DETAILS_CHARACTER_BUDGET, `${length} characters\n${block.text}`);
  const changes = summarizeTextChange(before, after);
  if (changes.length === 0) {
    assert.ok(block.spacingOnly, block.text);
  } else {
    assert.ok(block.listed.length > 0, block.text);
    assert.equal(block.listed.length + block.unlisted, changes.length, 'every change is listed or counted');
  }
  return block;
}

/** The Slack and Markdown previews say the same thing once bold, bullets and escaping are set aside. */
function assertSameFacts(preview: ManagementChangeSetPreview): void {
  const body = (text: string) => text.split('\n').slice(1, -1).join('\n');
  const slack = visible(body(formatSlackChangeSetProposal(preview)).replace(/^• /gm, '- '));
  const markdown = body(formatMarkdownChangeSetProposal(preview)).replaceAll('**', '*');
  assert.equal(markdown, slack);
}

function slackSkillPreview(part: string, ...lines: string[]): string {
  return [
    '*Proposed changes*',
    '*Research — Skill: weekly-review*',
    '*Replace*',
    `*${part}*`,
    ...lines,
    '',
    SLACK_APPROVAL,
  ].join('\n');
}

const reworded = (step: number) =>
  `“…against the tracker and ${rewordMarker(step)} to the on-call lead.”`;

const SKILL_CASES: ReadonlyArray<{
  name: string;
  part: 'Instructions' | 'Description';
  before?: string;
  after: string;
  lines: string[];
}> = [{
  name: 'an edit near the end of an 11,000-character skill',
  part: 'Instructions',
  after: rewordItems(SKILL, [13]),
  lines: [
    `• Under “Step 13: Review area 13”, changes wording to: ${reworded(13)}`,
    '',
    'Approval applies the full instructions.',
  ],
}, {
  name: 'an edit at the start',
  part: 'Instructions',
  after: SKILL.replace('Use this skill', 'Always use this skill'),
  lines: [
    '• At the start, changes wording to: “Always use this skill to prepare…”',
    '',
    'Approval applies the full instructions.',
  ],
}, {
  name: 'several scattered edits',
  part: 'Instructions',
  after: rewordItems(SKILL, [2, 5, 8, 11, 14]),
  lines: [
    `• Under “Step 2: Review area 2”, changes wording to: ${reworded(2)}`,
    `• Under “Step 5: Review area 5”, changes wording to: ${reworded(5)}`,
    `• Under “Step 8: Review area 8”, changes wording to: ${reworded(8)}`,
    '',
    'And 2 more changes. Approval applies the full instructions.',
  ],
}, {
  name: 'a whole new section',
  part: 'Instructions',
  after: SKILL.replace(syntheticSection(8), `${syntheticSection(15, 'Archive the review')}${syntheticSection(8)}`),
  lines: [
    '• Adds a new section, “Step 15: Archive the review”: “Area 15 covers the work that moved since the last ' +
      'review. Read the tracker…” (about 140 words)',
    '',
    'Approval applies the full instructions.',
  ],
}, {
  name: 'a removed section',
  part: 'Instructions',
  after: SKILL.replace(syntheticSection(6), ''),
  lines: [
    '• Removes the section “Step 6: Review area 6” (about 140 words)',
    '',
    'Approval applies the full instructions.',
  ],
}, {
  name: 'a one-word edit inside a long paragraph',
  part: 'Instructions',
  after: SKILL.replace(syntheticParagraph(9), syntheticParagraph(9).replace("last week's", "last month's")),
  lines: [
    "• Under “Step 9: Review area 9”, changes wording to: “…compare it with last month's notes, and write down…”",
    '',
    'Approval applies the full instructions.',
  ],
}, {
  name: 'a change to spacing and line breaks only',
  part: 'Instructions',
  after: SKILL.replaceAll('\n\n', '\n\n\n').replaceAll('- Check', '  - Check').replaceAll('\n', '\r\n'),
  lines: ['Only spacing or line breaks change. Approval applies the full instructions.'],
}, {
  name: 'an edit to a long description alone',
  part: 'Description',
  after: DESCRIPTION.replace('It does not send anything', 'It never sends anything'),
  lines: [
    '• Changes wording to: “…the house style. It never sends anything; the person reviews…”',
    '',
    'Approval applies the full description.',
  ],
}];

for (const { name, part, before, after, lines } of SKILL_CASES) {
  test(`a replaced skill shows the key details of ${name}`, () => {
    const field = part === 'Instructions' ? 'instructions' : 'description';
    const was = before ?? BASE_SKILL[field];
    const preview = skillEdit({ [field]: was }, { [field]: after });
    const slack = formatSlackChangeSetProposal(preview);

    assert.equal(slack, slackSkillPreview(part, ...lines));
    assertAccounted(slack, field, was, after);
    assertAccounted(formatMarkdownChangeSetProposal(preview), field, was, after);
    assertSameFacts(preview);
  });
}

test('the edit that motivated key details sits past the first 1,600 characters', () => {
  assert.ok(SKILL.length > 11_000, String(SKILL.length));
  assert.ok(SKILL.indexOf(syntheticItem(13, 3)) > 1_600);
});

test('scattered edits past the listed three are each counted, not dropped', () => {
  const steps = [2, 5, 8, 11, 14];
  const after = rewordItems(SKILL, steps);
  const changes = summarizeTextChange(SKILL, after);
  assert.equal(changes.length, steps.length);
  steps.forEach((step, index) => {
    const change = changes[index]!;
    assert.ok(change.quote.includes(rewordMarker(step)), change.quote);
    assert.deepEqual(change.kind === 'text' ? change.place : undefined,
      { kind: 'heading', heading: `Step ${step}: Review area ${step}` });
  });
  const [block] = keyDetails(formatSlackChangeSetProposal(skillEdit({}, { instructions: after })));
  assert.equal(block?.listed.length, 3);
  assert.equal(block?.unlisted, 2);
});

test('a short value keeps Before and After', () => {
  const preview = skillEdit(
    { description: 'Prepare the weekly operations review.' },
    { description: 'Prepare the weekly and monthly operations review.' },
  );
  assert.equal(formatSlackChangeSetProposal(preview), slackSkillPreview(
    'Description',
    '*Before*',
    '> Prepare the weekly operations review.',
    '*After*',
    '> Prepare the weekly and monthly operations review.',
  ));
  assertSameFacts(preview);

  const instructions = agentEdit(
    { instructions: 'Answer in short sentences.\nCite sources.' },
    { instructions: 'Answer in short sentences.\nCite primary sources.' },
  );
  assert.match(
    formatSlackChangeSetProposal(instructions),
    /^\*Research — Instructions\*\n\*Before\*\n> Answer in short sentences\.\n> Cite sources\.\n\*After\*\n/m,
  );
  assert.equal(keyDetails(formatSlackChangeSetProposal(instructions)).length, 0);
});

function singleChange(change: ManagementChangeSetPreview['changes'][number]): ManagementChangeSetPreview {
  return { summary: '1 reviewed workspace change', changes: [change], missingSetup: [] };
}

test('Agent instructions, memory and a schedule task show key details by their own noun', () => {
  const memory = Array.from({ length: 12 }, (_, index) =>
    `- Topic ${index + 1}: prefers primary sources and recent papers.`).join('\n');
  const editedMemory = memory.replace('7: prefers primary sources and recent papers', '7: prefers primary sources and preprints');
  const task = Array.from({ length: 6 }, (_, index) =>
    `Step ${index + 1}: read queue ${index + 1} and note anything waiting more than a day.`).join('\n');
  const editedTask = `${task}\nPost the summary in #ops by 9 AM.`;
  const cases = [{
    preview: agentEdit({ instructions: SKILL }, { instructions: rewordItems(SKILL, [13]) }),
    heading: 'Research — Instructions',
    noun: 'instructions',
    before: SKILL,
    after: rewordItems(SKILL, [13]),
    bullet: `• Under “Step 13: Review area 13”, changes wording to: ${reworded(13)}`,
  }, {
    preview: singleChange({
      itemId: 'memory',
      operationKind: 'update_agent_memory',
      target: 'agent:agent_research',
      before: { agentId: 'agent_research', body: memory, revision: 2 },
      after: { agentId: 'agent_research', body: editedMemory, revision: 3 },
      statement: { kind: 'update_agent_memory', agent: { name: 'Research', handle: 'research' } },
    }),
    heading: 'Research — Memory',
    noun: 'memory',
    before: memory,
    after: editedMemory,
    bullet: '• Changes wording to: “- Topic 7: prefers primary sources and preprints.”',
  }, {
    preview: singleChange({
      itemId: 'routine',
      operationKind: 'save_routine',
      target: 'routine:routine_triage',
      before: { name: 'Morning triage', taskText: task },
      after: { name: 'Morning triage', taskText: editedTask },
    }),
    heading: 'Morning triage — Task',
    noun: 'task',
    before: task,
    after: editedTask,
    bullet: '• At the end, adds: “Post the summary in #ops by 9 AM.”',
  }];

  for (const { preview, heading, noun, before, after, bullet } of cases) {
    const slack = formatSlackChangeSetProposal(preview);
    assert.ok(slack.includes(`*${heading}*\n${bullet}\n\nApproval applies the full ${noun}.`), slack);
    assert.doesNotMatch(slack, /\*Before\*|\*After\*/);
    assertAccounted(slack, noun, before, after);
    assertSameFacts(preview);
  }
});

const docs = {
  id: 'mcp_docs',
  displayName: 'Docs',
  url: 'https://mcp.docs.example.test/mcp',
  transport: 'streamable-http',
  authMode: 'none',
  headerNames: [],
  allowedTools: ['search', 'export_all'],
  enabled: true,
};

const billing = {
  id: 'api_billing',
  displayName: 'Billing',
  allowedHosts: ['billing.example.test'],
  pathPrefixes: ['/v1/'],
  headerName: 'Authorization',
  headerValuePrefix: 'Bearer ',
  allowedMethods: ['GET', 'POST'],
  enabled: true,
};

test('new connections lead a preview that many long skill edits push past the Slack limit', () => {
  const skills = longSkillEdits();
  const preview = agentEdit(
    { mcpServers: [], apiConnections: [], skills: skills.before },
    { mcpServers: [docs], apiConnections: [billing], skills: skills.after },
  );
  const slack = formatSlackChangeSetProposal(preview);

  assert.ok(slack.length <= SLACK_PRESENTATION_DIALECT.textLimit, String(slack.length));
  assert.match(slack, /Preview truncated to fit Slack/);
  assert.ok(slack.startsWith([
    '*Proposed changes*',
    'Add *Docs* to *Research* (@research).',
    'Server URL: `https://mcp.docs.example.test/mcp`.',
    'Authentication: None.',
    'Allowed tools: `search`, `export_all`.',
    '',
    'Add *Billing* to *Research* (@research).',
    'Allowed hosts: `billing.example.test`.',
    'Path prefixes: `/v1/`.',
    'Methods: `GET`, `POST`.',
    '',
    '*Research — Skill: review-1*',
  ].join('\n')), slack.slice(0, 800));
  const blocks = keyDetails(slack);
  assert.ok(blocks.length >= 10, `${blocks.length} whole skill edits shown`);
  for (const block of blocks) {
    assert.ok(block.text.length <= KEY_DETAILS_CHARACTER_BUDGET, block.text);
    assert.equal(block.listed.length + block.unlisted, 3);
  }
  assert.equal(changeSetAccessFits(preview, SLACK_PRESENTATION_DIALECT), true);
});

test('Slack escaping changes neither which changes are listed nor what a person reads', () => {
  const line = (index: number) =>
    `- <${index}> & <a> & <b> & <c> & <d> & <e> & <f> & <g> & <h> & <i> & <j> & <k> & <l> & <m>`;
  const before = ['## R&D <ops> & <infra> & <tools>', ...Array.from({ length: 9 }, (_, index) => line(index))].join('\n');
  const after = [1, 4, 7].reduce((text, index) => text.replace(line(index), `${line(index)}${' & <x>'.repeat(20)}`), before);
  const preview = skillEdit({ instructions: before }, { instructions: after });

  const slack = assertAccounted(formatSlackChangeSetProposal(preview), 'instructions', before, after);
  const markdown = assertAccounted(formatMarkdownChangeSetProposal(preview), 'instructions', before, after);
  assert.equal(slack.listed.length, markdown.listed.length);
  assert.match(slack.text, /^• Under “R&amp;D &lt;ops&gt; &amp; &lt;infra&gt; &amp; &lt;tools&gt;”, adds: “…/);
  assertSameFacts(preview);
});

test('the longest possible bullet still leaves the first change listed within the budget', () => {
  const heading = '🧾'.repeat(60);
  const word = '😀'.repeat(200);
  const text = (last: string) =>
    [`## ${heading}`, ...Array.from({ length: 8 }, (_, index) => `${index} ${word} ${word}`), last].join('\n');
  const before = text(`${word} ${word}`);
  const after = text(`${word}x ${word}`);

  for (const format of [formatSlackChangeSetProposal, formatMarkdownChangeSetProposal]) {
    const block = assertAccounted(format(skillEdit({ instructions: before }, { instructions: after })), 'instructions', before, after);
    assert.equal(block.listed.length, 1);
  }
});
