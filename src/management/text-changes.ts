/**
 * The key details of an edit to a long text: where each change sits and one
 * short quote of it. An approval preview lists these instead of the whole
 * text. Pure, with no wording or escaping of any surface.
 */

/** Longest quote, before its ellipses. */
export const QUOTE_MAX_CHARACTERS = 80;
/** Unchanged words a quote keeps on each side of a change. */
export const QUOTE_CONTEXT_WORDS = 4;
/** Longest heading named as a change's place or section. */
export const HEADING_MAX_CHARACTERS = 40;
/**
 * Most line edits the diff searches. Past it, the changed middle of the text
 * reads as one change, so a full rewrite costs bounded time and memory.
 */
export const EDIT_DISTANCE_LIMIT = 2_000;

/** Where a change sits. */
export type TextChangePlace =
  | { kind: 'heading'; heading: string }
  | { kind: 'start' }
  | { kind: 'end' }
  /** No heading above it and at neither end, or the text was empty before or after. */
  | { kind: 'none' };

interface Excerpt {
  /** One short quote, whitespace collapsed, cut at word boundaries with "…". */
  quote: string;
  /** Words changed: the new side for adds and changes, the old side for removes. */
  words: number;
  /** Whether the quote holds every changed word. */
  quotedWhole: boolean;
}

export type TextChange =
  /** A whole section, from its heading through its body. A removed section quotes nothing. */
  | Excerpt & { kind: 'section'; action: 'adds' | 'removes'; heading: string }
  | Excerpt & { kind: 'text'; action: 'adds' | 'removes' | 'changes'; place: TextChangePlace };

/** Old lines [oldStart, oldEnd) became new lines [newStart, newEnd). */
export interface LineHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface Heading {
  text: string;
  /** 1 to 6 for `#` headings; a bold line ranks below them all. */
  level: number;
}

interface TextLine {
  /** The line with its whitespace collapsed. */
  text: string;
  heading?: Heading;
}

/** Lines [start, end) of one side. */
interface LineSpan {
  lines: readonly TextLine[];
  start: number;
  end: number;
}

/** A word, or a whole heading line, so a change to a heading's markup still differs. */
interface Token {
  raw: string;
  shown: string;
  line: number;
}

const ATX_HEADING = /^(#{1,6}) (.+?)(?: #+)?$/;
const BOLD_HEADING = /^(?:\*\*([^*]+)\*\*|__([^_]+)__):?$/;
const BOLD_HEADING_LEVEL = 7;
const FENCE = /^(`{3,}|~{3,})/;

/**
 * Changes in document order. Differences in spacing and line breaks are left
 * out, so an empty result for two different texts means only those differ.
 */
export function summarizeTextChange(before: string, after: string): TextChange[] {
  const old = readLines(before);
  const next = readLines(after);
  const located = old.length > 0 && next.length > 0;
  return diffLines(old.map(({ text }) => text), next.map(({ text }) => text)).flatMap((hunk) => {
    const removed = sectionStarts(old, hunk.oldStart, hunk.oldEnd);
    const added = sectionStarts(next, hunk.newStart, hunk.newEnd);
    const edit = describeEdit(
      { lines: old, start: hunk.oldStart, end: removed[0] ?? hunk.oldEnd },
      { lines: next, start: hunk.newStart, end: added[0] ?? hunk.newEnd },
      located,
    );
    return [
      ...(edit ? [edit] : []),
      ...removed.map((start, index) =>
        describeSection('removes', { lines: old, start, end: removed[index + 1] ?? hunk.oldEnd })),
      ...added.map((start, index) =>
        describeSection('adds', { lines: next, start, end: added[index + 1] ?? hunk.newEnd })),
    ];
  });
}

/** A shortest line edit script as hunks, or one hunk over the changed middle past `EDIT_DISTANCE_LIMIT`. */
export function diffLines(before: readonly string[], after: readonly string[]): LineHunk[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  if (start === oldEnd && start === newEnd) return [];
  const middle = { oldStart: start, oldEnd, newStart: start, newEnd };
  if (start === oldEnd || start === newEnd) return [middle];
  const script = editScript(before.slice(start, oldEnd), after.slice(start, newEnd));
  return script ? scriptHunks(script, start) : [middle];
}

function readLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let fence: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const marker = FENCE.exec(line)?.[1];
    const heading = fence === undefined && marker === undefined ? readHeading(line) : undefined;
    if (fence === undefined) fence = marker;
    else if (marker === line && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    lines.push(heading ? { text: line, heading } : { text: line });
  }
  return lines;
}

function readHeading(line: string): Heading | undefined {
  const atx = ATX_HEADING.exec(line);
  const bold = atx ? undefined : BOLD_HEADING.exec(line);
  const text = (atx?.[2] ?? bold?.[1] ?? bold?.[2])
    ?.replace(/^[*_]+|[*_]+$/g, '').replace(/:$/, '').trim();
  if (!text) return undefined;
  return { text, level: atx ? atx[1]!.length : BOLD_HEADING_LEVEL };
}

/**
 * The headings in a hunk that open a whole section of their own: each holds
 * a body line before the next heading of its rank or above. Only the highest
 * rank among them splits the hunk, so a new section's subsections stay in it.
 */
function sectionStarts(lines: readonly TextLine[], start: number, end: number): number[] {
  const opening: Array<{ index: number; level: number }> = [];
  for (let index = start; index < end; index += 1) {
    const heading = lines[index]!.heading;
    if (heading && holdsBody(lines, index + 1, end, heading.level)) opening.push({ index, level: heading.level });
  }
  const level = opening.reduce((highest, heading) => Math.min(highest, heading.level), Infinity);
  return opening.filter((heading) => heading.level === level).map(({ index }) => index);
}

function holdsBody(lines: readonly TextLine[], start: number, end: number, level: number): boolean {
  for (let index = start; index < end; index += 1) {
    const heading = lines[index]!.heading;
    if (!heading) return true;
    if (heading.level <= level) return false;
  }
  return false;
}

/** The part of a hunk before its first section: a word diff of its old and new lines. */
function describeEdit(old: LineSpan, next: LineSpan, located: boolean): TextChange | undefined {
  const oldTokens = tokens(old);
  const newTokens = tokens(next);
  let prefix = 0;
  while (
    prefix < oldTokens.length && prefix < newTokens.length && oldTokens[prefix]!.raw === newTokens[prefix]!.raw
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldTokens.length - prefix && suffix < newTokens.length - prefix &&
    oldTokens[oldTokens.length - 1 - suffix]!.raw === newTokens[newTokens.length - 1 - suffix]!.raw
  ) suffix += 1;
  const oldChangeEnd = oldTokens.length - suffix;
  const newChangeEnd = newTokens.length - suffix;
  if (prefix === oldChangeEnd && prefix === newChangeEnd) return undefined;
  const action = prefix === newChangeEnd ? 'removes' : prefix === oldChangeEnd ? 'adds' : 'changes';
  const span = action === 'removes' ? old : next;
  const side = action === 'removes' ? oldTokens : newTokens;
  const changeEnd = side.length - suffix;
  const place = located
    ? placeOf(
      span.lines,
      side[prefix]!.line,
      span.start === 0 && prefix === 0,
      span.end === span.lines.length && changeEnd === side.length,
    )
    : { kind: 'none' as const };
  return { kind: 'text', action, place, ...excerpt(side, prefix, changeEnd) };
}

/** A section runs from its heading line at `start` to `end`. */
function describeSection(action: 'adds' | 'removes', section: LineSpan): TextChange {
  const heading = shorten(section.lines[section.start]!.heading!.text, HEADING_MAX_CHARACTERS);
  const body = tokens({ ...section, start: section.start + 1 });
  return action === 'adds'
    ? { kind: 'section', action, heading, ...excerpt(body, 0, body.length) }
    : { kind: 'section', action, heading, quote: '', words: countWords(body), quotedWhole: false };
}

function tokens({ lines, start, end }: LineSpan): Token[] {
  const result: Token[] = [];
  for (let line = start; line < end; line += 1) {
    const { text, heading } = lines[line]!;
    if (heading) {
      result.push({ raw: text, shown: heading.text, line });
    } else {
      for (const word of text.split(' ')) result.push({ raw: word, shown: word, line });
    }
  }
  return result;
}

function placeOf(lines: readonly TextLine[], line: number, atStart: boolean, atEnd: boolean): TextChangePlace {
  for (let index = line - 1; index >= 0; index -= 1) {
    const heading = lines[index]!.heading;
    if (heading) return { kind: 'heading', heading: shorten(heading.text, HEADING_MAX_CHARACTERS) };
  }
  if (atStart || lines.slice(line).some(({ heading }) => heading)) return { kind: 'start' };
  return atEnd ? { kind: 'end' } : { kind: 'none' };
}

/**
 * Tokens [from, to) changed. The quote opens a few words before the change
 * and drops that lead-in before it would push the first changed word out.
 */
function excerpt(side: readonly Token[], from: number, to: number): Excerpt {
  const shown = side.map((token) => token.shown);
  const width = (start: number, end: number) => shown.slice(start, end).join(' ').length;
  const words = countWords(side.slice(from, to));
  let start = Math.max(0, from - QUOTE_CONTEXT_WORDS);
  while (start < from && width(start, from + 1) > QUOTE_MAX_CHARACTERS) start += 1;
  const lead = start > 0 ? '…' : '';
  if (width(start, start + 1) > QUOTE_MAX_CHARACTERS) {
    return { quote: `${lead}${cut(shown[start]!, QUOTE_MAX_CHARACTERS)}…`, words, quotedWhole: false };
  }
  const last = Math.min(side.length, to + QUOTE_CONTEXT_WORDS);
  let end = start + 1;
  while (end < last && width(start, end + 1) <= QUOTE_MAX_CHARACTERS) end += 1;
  return {
    quote: `${lead}${shown.slice(start, end).join(' ')}${end < side.length ? '…' : ''}`,
    words,
    quotedWhole: end >= to,
  };
}

function countWords(side: readonly Token[]): number {
  return side.reduce((count, token) => count + token.shown.split(' ').length, 0);
}

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = '';
  for (const word of text.split(' ')) {
    const longer = kept ? `${kept} ${word}` : word;
    if (longer.length > limit) break;
    kept = longer;
  }
  return `${kept || cut(text, limit)}…`;
}

function cut(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join('');
}

interface EditScript {
  removed: Uint8Array;
  added: Uint8Array;
}

/**
 * Myers' O((N+M)D) shortest edit script. `frontiers[d][i]` is the furthest
 * old index reached with d edits on diagonal 2i - d.
 */
function editScript(before: readonly string[], after: readonly string[]): EditScript | undefined {
  const limit = Math.min(before.length + after.length, EDIT_DISTANCE_LIMIT);
  const frontiers: Int32Array[] = [];
  for (let edits = 0; edits <= limit; edits += 1) {
    const previous = frontiers[edits - 1];
    const frontier = new Int32Array(edits + 1);
    frontiers.push(frontier);
    for (let index = 0; index <= edits; index += 1) {
      const diagonal = 2 * index - edits;
      let x = previous === undefined
        ? 0
        : insertsHere(previous, index, edits) ? previous[index]! : previous[index - 1]! + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier[index] = x;
      if (x >= before.length && y >= after.length) return backtrack(frontiers, before.length, after.length);
    }
  }
  return undefined;
}

/** Whether the best path onto diagonal 2i - d comes down from diagonal 2i - d + 1, inserting a line. */
function insertsHere(previous: Int32Array, index: number, edits: number): boolean {
  return index === 0 || (index !== edits && previous[index - 1]! < previous[index]!);
}

function backtrack(frontiers: readonly Int32Array[], oldLength: number, newLength: number): EditScript {
  const removed = new Uint8Array(oldLength);
  const added = new Uint8Array(newLength);
  let x = oldLength;
  let y = newLength;
  for (let edits = frontiers.length - 1; edits > 0; edits -= 1) {
    const previous = frontiers[edits - 1]!;
    const diagonal = x - y;
    const index = (diagonal + edits) / 2;
    if (insertsHere(previous, index, edits)) {
      x = previous[index]!;
      y = x - diagonal - 1;
      added[y] = 1;
    } else {
      x = previous[index - 1]!;
      y = x - diagonal + 1;
      removed[x] = 1;
    }
  }
  return { removed, added };
}

function scriptHunks({ removed, added }: EditScript, offset: number): LineHunk[] {
  const hunks: LineHunk[] = [];
  let x = 0;
  let y = 0;
  const removes = () => x < removed.length && removed[x] === 1;
  const adds = () => y < added.length && added[y] === 1;
  while (x < removed.length || y < added.length) {
    if (!removes() && !adds()) {
      x += 1;
      y += 1;
      continue;
    }
    const oldStart = x;
    const newStart = y;
    while (removes() || adds()) {
      while (removes()) x += 1;
      while (adds()) y += 1;
    }
    hunks.push({ oldStart: oldStart + offset, oldEnd: x + offset, newStart: newStart + offset, newEnd: y + offset });
  }
  return hunks;
}
