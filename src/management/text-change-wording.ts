import type { TextChange, TextChangePlace } from './text-changes.ts';

/**
 * One key detail of a long text edit as a sentence, the same words on every
 * surface: a Slack or MCP approval preview and the ChatGPT Agent card.
 * `quoted` wraps quoted text with the surface's escaping.
 */
export function describeTextChange(change: TextChange, quoted: (text: string) => string): string {
  const size = change.quotedWhole ? '' : ` (${formatWordCount(change.words)})`;
  if (change.kind === 'section') {
    const sentence = change.action === 'adds'
      ? `Adds a new section, ${quoted(change.heading)}${change.quote ? `: ${quoted(change.quote)}` : ''}`
      : `Removes the section ${quoted(change.heading)}`;
    return `${sentence}${size}`;
  }
  const verb = TEXT_CHANGE_VERBS[change.action];
  const place = placeLead(change.place, quoted);
  const lead = place ? `${place}, ${verb}` : `${verb[0]!.toUpperCase()}${verb.slice(1)}`;
  return `${lead}: ${quoted(change.quote)}${size}`;
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
