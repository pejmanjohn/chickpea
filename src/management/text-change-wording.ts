import type { ChangeWindow, TextChange, TextChangePlace } from './text-changes.ts';

/**
 * One key detail of a long text edit as a sentence, the same words on every
 * surface: a Slack or MCP approval preview and the ChatGPT Agent card.
 * `quoted` wraps quoted text with the surface's escaping.
 */
export function describeTextChange(change: TextChange, quoted: (text: string) => string): string {
  const size = change.quotedWhole ? '' : ` (${formatWordCount(change.words)})`;
  return `${sentence(change, change.quote, quoted)}${size}`;
}

/** The longest changed span a surface with room shows whole, in characters. */
export const CHANGED_SPAN_MAX = 600;
/** How much of a longer span shows at each end. */
export const CHANGED_SPAN_END = 250;

/**
 * The same sentence with the changed words in its quote, for a surface with
 * room: the unchanged words around them go first, the trailing ones before
 * the leading, until it fits in `max` characters. A changed span of up to
 * `CHANGED_SPAN_MAX` characters is never cut, so it may run past `max`. A
 * longer one, such as a full rewrite, shows its first and last
 * `CHANGED_SPAN_END` characters, cut at a word where one is near, with a
 * line between them that counts the rest.
 */
export function describeWholeTextChange(
  change: TextChange,
  window: ChangeWindow,
  quoted: (text: string) => string,
  max: number,
): string {
  const changed = shortSpan(window.changed);
  const lead = window.lead ? window.lead.split(' ') : [];
  const trail = window.trail ? window.trail.split(' ') : [];
  const fitted = () => [lead.join(' '), changed, trail.join(' ')].filter(Boolean).join(' ');
  while (fitted().length > max && trail.length > 0) trail.pop();
  while (fitted().length > max && lead.length > 0) lead.shift();
  const before = window.moreBefore || lead.length < countSplit(window.lead) ? '…' : '';
  const after = window.moreAfter || trail.length < countSplit(window.trail) ? '…' : '';
  return sentence(change, `${before}${fitted()}${after}`, quoted);
}

/** A span past `CHANGED_SPAN_MAX` as its two ends and a count of what is between them. */
function shortSpan(changed: string): string {
  const characters = Array.from(changed);
  if (characters.length <= CHANGED_SPAN_MAX) return changed;
  let head = characters.slice(0, CHANGED_SPAN_END).join('');
  let tail = characters.slice(-CHANGED_SPAN_END).join('');
  // Whole words at the cut, unless the end is one long word.
  if (head.includes(' ')) head = head.slice(0, head.lastIndexOf(' '));
  if (tail.includes(' ')) tail = tail.slice(tail.indexOf(' ') + 1);
  const left = characters.length - Array.from(head).length - Array.from(tail).length;
  return `${head}\n… ${left.toLocaleString('en-US')} more characters changed …\n${tail}`;
}

function countSplit(words: string): number {
  return words ? words.split(' ').length : 0;
}

function sentence(change: TextChange, quote: string, quoted: (text: string) => string): string {
  if (change.kind === 'section') {
    return change.action === 'adds'
      ? `Adds a new section, ${quoted(change.heading)}${quote ? `: ${quoted(quote)}` : ''}`
      : `Removes the section ${quoted(change.heading)}`;
  }
  const verb = TEXT_CHANGE_VERBS[change.action];
  const place = placeLead(change.place, quoted);
  const lead = place ? `${place}, ${verb}` : `${verb[0]!.toUpperCase()}${verb.slice(1)}`;
  return `${lead}: ${quoted(quote)}`;
}

const TEXT_CHANGE_VERBS = { adds: 'adds', removes: 'removes', changes: 'changes wording to' } as const;

function placeLead(place: TextChangePlace, quoted: (text: string) => string): string | undefined {
  switch (place.kind) {
    case 'heading':
      return `Under ${quoted(place.heading)}`;
    case 'start':
      return 'At the start';
    case 'end':
      return 'At the end';
    case 'none':
      return undefined;
  }
}

/** Exact below ten; otherwise about, to the nearest ten below 1,000 and the nearest hundred from there. */
function formatWordCount(words: number): string {
  if (words < 10) return `${words} ${words === 1 ? 'word' : 'words'}`;
  const rounded = words < 1_000 ? Math.round(words / 10) * 10 : Math.round(words / 100) * 100;
  return `about ${rounded.toLocaleString('en-US')} words`;
}
