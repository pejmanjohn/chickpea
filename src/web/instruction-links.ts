import { requesterTypedUrls } from '../slack/typed-urls.ts';

/** A host, and the paths on it, that a URL the model writes may take (`admitWebUrl`). */
export interface InstructionLinkSpace {
  host: string;
  pathPrefixes: readonly string[];
}

/**
 * How the identity line opens (`runtimeIdentityInstruction`). In every run's
 * instructions it follows the saved instructions, and what follows it
 * (names, handles, teammates) is not reviewed text.
 */
export const IDENTITY_OPENING = 'You are assigned to Slack workspace ';

/**
 * The text a run reads links from: everything before the first identity
 * line, or nothing without one. Saved instructions that hold that sentence
 * themselves are cut there too, in a run and in the review of a save
 * (`addedInstructionLinks`), so both read the same text. Were the review to
 * read past the cut, a link label closed after it could hide a link the run
 * then reads.
 */
export function textBeforeIdentityLine(instructions: string): string | undefined {
  const end = instructions.indexOf(IDENTITY_OPENING);
  return end < 0 ? undefined : instructions.slice(0, end);
}

/**
 * Each link in an Agent's saved instructions, and the pages below its path,
 * so an Agent told to answer from a docs site can open it. A link's own
 * path, not its host, is its space, as a connection's is. Admission still
 * refuses any URL that is not public https.
 */
export function instructionLinkSpaces(instructions: string): InstructionLinkSpace[] {
  return requesterTypedUrls(instructions).map((url) => ({ host: url.hostname, pathPrefixes: [url.pathname] }));
}

/** The links a run would read from these saved instructions. */
function runLinks(saved: string): URL[] {
  return requesterTypedUrls(textBeforeIdentityLine(saved) ?? saved);
}

/**
 * The links `after` holds that no link in `before`, and no URL in `vouched`,
 * already covers: the reach a save of `after` would add.
 */
export function addedInstructionLinks(before: string, after: string, vouched: readonly URL[] = []): string[] {
  const known = [...runLinks(before), ...vouched];
  return [...new Set(runLinks(after)
    .filter((link) => !known.some((url) => covers(url, link)))
    .map(({ href }) => href))];
}

/** Same origin, and `link`'s path at or below `url`'s, segment by segment, as `matchesEgressPrefix` reads it. */
function covers(url: URL, link: URL): boolean {
  if (url.origin !== link.origin) return false;
  const base = url.pathname.replace(/\/+$/, '');
  return base === '' || link.pathname === base || link.pathname.startsWith(`${base}/`);
}
