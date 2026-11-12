import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  diffLines,
  EDIT_DISTANCE_LIMIT,
  HEADING_MAX_CHARACTERS,
  QUOTE_MAX_CHARACTERS,
  summarizeTextChange,
  textChangeWindows,
  type LineHunk,
  type TextChange,
} from '../src/management/text-changes.ts';
import { CHANGED_SPAN_END, CHANGED_SPAN_MAX, describeWholeTextChange } from '../src/management/text-change-wording.ts';
import {
  rewordItems,
  rewordMarker,
  syntheticItem,
  syntheticParagraph,
  syntheticSection,
  syntheticSkill,
} from './helpers/synthetic-skill.ts';

/** Copies the unchanged runs of `before` and takes each hunk's lines from `after`. */
function applyHunks(before: readonly string[], after: readonly string[], hunks: readonly LineHunk[]): string[] {
  const result: string[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const hunk of hunks) {
    assert.ok(hunk.oldStart >= oldIndex && hunk.newStart >= newIndex, 'hunks are ordered');
    assert.equal(hunk.oldStart - oldIndex, hunk.newStart - newIndex, 'unchanged runs line up');
    result.push(...before.slice(oldIndex, hunk.oldStart), ...after.slice(hunk.newStart, hunk.newEnd));
    oldIndex = hunk.oldEnd;
    newIndex = hunk.newEnd;
  }
  return [...result, ...before.slice(oldIndex)];
}

function longestCommonSubsequence(before: readonly string[], after: readonly string[]): number {
  const lengths = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let x = 1; x <= before.length; x += 1) {
    for (let y = 1; y <= after.length; y += 1) {
      lengths[x]![y] = before[x - 1] === after[y - 1]
        ? lengths[x - 1]![y - 1]! + 1
        : Math.max(lengths[x - 1]![y]!, lengths[x]![y - 1]!);
    }
  }
  return lengths[before.length]![after.length]!;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test('the line diff turns old into new with a shortest edit script', () => {
  const random = seededRandom(20261031);
  const lines = (length: number) => Array.from({ length }, () => 'abc'[Math.floor(random() * 3)]!);
  for (let run = 0; run < 2_000; run += 1) {
    const before = lines(Math.floor(random() * 10));
    const after = lines(Math.floor(random() * 10));
    const hunks = diffLines(before, after);
    const label = `${before.join('')} -> ${after.join('')}`;
    assert.deepEqual(applyHunks(before, after, hunks), after, label);
    const edits = hunks.reduce((count, hunk) => count + hunk.oldEnd - hunk.oldStart + hunk.newEnd - hunk.newStart, 0);
    assert.equal(edits, before.length + after.length - 2 * longestCommonSubsequence(before, after), label);
    assert.ok(hunks.every((hunk) => hunk.oldEnd > hunk.oldStart || hunk.newEnd > hunk.newStart), label);
  }
});

test('past the edit limit the changed middle is one hunk that still applies', () => {
  const half = EDIT_DISTANCE_LIMIT / 2 + 100;
  const before = ['same start', ...Array.from({ length: half }, (_, index) => `old ${index}`), 'same end'];
  const after = ['same start', ...Array.from({ length: half }, (_, index) => `new ${index}`), 'same end'];
  const hunks = diffLines(before, after);
  assert.deepEqual(hunks, [{ oldStart: 1, oldEnd: half + 1, newStart: 1, newEnd: half + 1 }]);
  assert.deepEqual(applyHunks(before, after, hunks), after);

  const long = Array.from({ length: 5_000 }, (_, index) => `line ${index}`);
  const sparse = long.map((line, index) => index % 1_500 === 700 ? `${line} edited` : line);
  assert.equal(diffLines(long, sparse).length, 3, 'a few edits in a long text stay exact');
});

test('spacing, indentation, blank lines and rewrapping are not changes', () => {
  const skill = syntheticSkill();
  const respaced = skill
    .replaceAll('\n\n', '\n\n\n')
    .replaceAll('- Check', '  -   Check')
    .replaceAll('\n', ' \r\n')
    .replace(syntheticSection(4).split('\n')[2]!, syntheticSection(4).split('\n')[2]!.replace(', compare', ',\ncompare'));
  assert.notEqual(respaced, skill);
  assert.deepEqual(summarizeTextChange(skill, respaced), []);
});

test('an edit near the end of a long text is found under its heading', () => {
  const skill = syntheticSkill();
  const edited = rewordItems(skill, [13]);
  assert.ok(skill.length > 11_000);
  assert.deepEqual(summarizeTextChange(skill, edited), [{
    kind: 'text',
    action: 'changes',
    place: { kind: 'heading', heading: 'Step 13: Review area 13' },
    quote: `…against the tracker and ${rewordMarker(13)} to the on-call lead.`,
    words: 10,
    quotedWhole: true,
  }]);
});

test('a heading markup change is listed, while a heading inside a code fence places nothing', () => {
  assert.deepEqual(
    summarizeTextChange('# Setup\nInstall the tools.', '## Setup\nInstall the tools.').map(({ action }) => action),
    ['changes'],
  );
  assert.deepEqual(
    summarizeTextChange('**Setup**\nInstall the tools.', 'Setup\nInstall the tools.').map(({ action }) => action),
    ['changes'],
  );

  const fenced = (command: string) =>
    ['## Deploy', 'Run these steps.', '```sh', '# not a heading', command, '```', 'Then report back.'].join('\n');
  const [change] = summarizeTextChange(fenced('npm run deploy'), fenced('npm run deploy -- --dry-run'));
  assert.deepEqual(change && 'place' in change ? change.place : undefined, { kind: 'heading', heading: 'Deploy' });
});

test('a new section keeps its subsections, and a removed one counts its words', () => {
  const skill = syntheticSkill(3);
  const appendix = '\n## Appendix\n\n### Archive\n- Move finished reviews to the archive folder.\n### Tags\n- Tag them with the week.\n';
  const [added, ...rest] = summarizeTextChange(skill, `${skill}${appendix}`);
  assert.deepEqual(rest, []);
  assert.equal(added?.kind, 'section');
  assert.equal(added?.action, 'adds');
  assert.ok(added?.kind === 'section' && added.heading === 'Appendix');
  assert.equal(added?.words, 16);

  const removed = summarizeTextChange(skill, skill.replace(syntheticSection(2), ''));
  assert.deepEqual(removed, [{
    kind: 'section',
    action: 'removes',
    heading: 'Step 2: Review area 2',
    quote: '',
    words: syntheticSection(2).split('\n').slice(1).join(' ').split(/\s+/).filter(Boolean).length,
    quotedWhole: false,
  }]);
});

test('a place reads as the start, the end, or nowhere in a text without headings', () => {
  const paragraph = Array.from({ length: 6 }, (_, index) => `Sentence ${index} of a plain note.`).join('\n');
  const place = (before: string, after: string) => {
    const [change, ...rest] = summarizeTextChange(before, after);
    assert.deepEqual(rest, []);
    return change?.kind === 'text' ? change.place.kind : change?.kind;
  };
  assert.equal(place(paragraph, `Opening line.\n${paragraph}`), 'start');
  assert.equal(place(paragraph, `${paragraph}\nClosing line.`), 'end');
  assert.equal(place(paragraph, paragraph.replace('Sentence 3 of', 'Sentence 3 in')), 'none');
  assert.equal(place('', paragraph), 'none', 'a first value has no place');
  assert.equal(place(syntheticSkill(2), syntheticSkill(2).replace('Use this skill', 'Always use this skill')), 'start');
});

test('quotes and headings stay short, and a word longer than a quote is cut', () => {
  const title = 'A heading far longer than any preview should repeat in full';
  const before = `## ${title}\n${'word '.repeat(300)}`;
  const changes: TextChange[] = [
    ...summarizeTextChange(before, before.replace('word word word', 'term term term')),
    ...summarizeTextChange('Short.', 'x'.repeat(5_000)),
    ...summarizeTextChange('', `## ${title}\n${'detail '.repeat(200)}`),
  ];
  assert.equal(changes.length, 3);
  for (const change of changes) {
    assert.ok(change.quote.length <= QUOTE_MAX_CHARACTERS + 2, change.quote);
    const heading = change.kind === 'section' ? change.heading : change.place.kind === 'heading' ? change.place.heading : '';
    assert.ok(heading.length <= HEADING_MAX_CHARACTERS + 1, heading);
  }
  assert.equal(changes[1]?.quote, `${'x'.repeat(QUOTE_MAX_CHARACTERS)}…`);
  assert.equal(changes[1]?.quotedWhole, false);
  assert.ok(changes[0]?.kind === 'text' && changes[0].place.kind === 'heading' &&
    changes[0].place.heading === 'A heading far longer than any preview…');
});

test('a heading that is a long run of emphasis markers reads in linear time', () => {
  const heading = `# x${'*'.repeat(100_000)}x`;
  const started = performance.now();
  const [change] = summarizeTextChange(`${heading}\nOld line.`, `${heading}\nNew line.`);
  assert.ok(performance.now() - started < 1_000, 'a backtracking trim takes seconds here');
  assert.equal(change?.kind === 'text' ? change.place.kind : undefined, 'heading');
});

test('a heading whose section runs on past the change is an edit, not a whole section', () => {
  const skill = syntheticSkill(8);
  const heading = '## Step 6: Review area 6';
  const opening = `${heading}\n\n${syntheticParagraph(6)}\n`;
  const describe = (after: string) => summarizeTextChange(skill, after).map((change) =>
    change.kind === 'section' ? `${change.action} section ${change.heading}` : `${change.action} ${change.place.kind}`);

  assert.deepEqual(describe(skill.replace(opening, '')), ['removes heading'], 'the items stay, now under Step 5');
  assert.deepEqual(
    describe(skill.replace(heading, '## Step 6: Review area six').replace(syntheticParagraph(6), 'Area 6 now covers more.')),
    ['changes heading'],
  );
  assert.deepEqual(
    describe(skill.replace(syntheticItem(6, 4), `## Step 6b: Extra\n- New item.\n${syntheticItem(6, 4)}`)),
    ['adds heading'],
    'the new heading takes over items 6.4 to 6.6',
  );
  assert.deepEqual(describe(skill.replace(syntheticSection(6), '')), ['removes section Step 6: Review area 6']);
  assert.deepEqual(
    describe(skill.replace(syntheticSection(6), `${syntheticSection(6)}${syntheticSection(9, 'Archive')}`)),
    ['adds section Step 9: Archive'],
  );
});

// Mutation proof: a window that cuts the changed words, or drops the leading words before the trailing ones, fails here.
test('a change\'s window holds every changed word; fitting it drops the trailing words, then the leading ones', () => {
  const before = 'one two three four five six seven eight nine ten';
  const changed = 'a very long replacement that runs well past any quote';
  const after = `one two three four five ${changed} eight nine ten`;
  const [entry] = textChangeWindows(before, after);
  assert.deepEqual(entry!.window, {
    lead: 'two three four five', changed, trail: 'eight nine ten', moreBefore: true, moreAfter: false,
  });
  assert.deepEqual(summarizeTextChange(before, after), [(({ window: _window, ...change }) => change)(entry!)], 'the quotes are unchanged');
  const quoted = (text: string) => `“${text}”`;
  const { window, ...change } = entry!;
  assert.equal(describeWholeTextChange(change, window!, quoted, 500), `Changes wording to: “…two three four five ${changed} eight nine ten”`);
  assert.equal(describeWholeTextChange(change, window!, quoted, changed.length + 6), `Changes wording to: “…five ${changed}…”`);
  assert.equal(describeWholeTextChange(change, window!, quoted, 5), `Changes wording to: “…${changed}…”`, 'never shorter than the change');
});

test('a changed span of 600 characters shows whole; a longer one shows its two ends and counts the rest', () => {
  const quoted = (text: string) => `“${text}”`;
  const whole = (before: string, after: string) => textChangeWindows(before, after)
    .map(({ window, ...change }) => describeWholeTextChange(change, window!, quoted, 240));
  const span = (length: number) => 'abcd '.repeat(length / 5 + 1).slice(0, length - 1) + 'z';
  const around = (changed: string) => `aa bb cc dd ${changed} ee ff gg hh`;

  const exact = span(CHANGED_SPAN_MAX);
  assert.equal(exact.length, 600);
  assert.deepEqual(whole(around('old'), around(exact)), [`Changes wording to: “…${exact}…”`], 'exactly 600: every changed character');

  const over = span(CHANGED_SPAN_MAX + 1);
  const [cut] = whole(around('old'), around(over));
  const [head, line, tail] = cut!.slice('Changes wording to: “…'.length, -'…”'.length).split('\n');
  assert.equal(over.startsWith(head!) && over.endsWith(tail!), true, 'its own first and last words');
  assert.equal(head!.length <= CHANGED_SPAN_END && tail!.length <= CHANGED_SPAN_END, true);
  assert.equal(line, `… ${over.length - head!.length - tail!.length} more characters changed …`);
  assert.equal(/ $|^ /.test(head! + tail!), false, 'cut at a word');

  // A full rewrite of long instructions: one long line, and many lines.
  const words = (prefix: string) => Array.from({ length: 16_000 }, (_, index) => `${prefix}${index}`).join(' ');
  const [oneLine] = whole(words('word'), words('term'));
  assert.equal(oneLine!.length < 600, true, `${oneLine!.length} characters`);
  assert.match(oneLine!, /^At the start, changes wording to: “term0 term1 .+\n… 148,\d{3} more characters changed …\n.+ term15999”$/s);
  const lines = (text: (index: number) => string) => Array.from({ length: 5_000 }, (_, index) => text(index)).join('\n');
  const rewritten = whole(lines((index) => `Line ${index} says something fairly ordinary here.`), lines((index) => `Totally different ${index * 7} content appears on this row.`));
  assert.equal(rewritten.length, 1);
  assert.equal(rewritten[0]!.length < 600, true, `${rewritten[0]!.length} characters`);
  assert.match(rewritten[0]!, /changes wording to: “Totally different 0 .+\n… 262,\d{3} more characters changed …\n.+ on this row\.”$/s);

  // Counted and cut by character, never through a surrogate pair; one long word has no word to cut at.
  const emoji = '👋'.repeat(700);
  const [pictures] = whole('hi', emoji);
  assert.equal(pictures, `At the start, changes wording to: “${'👋'.repeat(250)}\n… 200 more characters changed …\n${'👋'.repeat(250)}”`);
});
