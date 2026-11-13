import { requesterTypedUrls } from '../slack/typed-urls.ts';

/** A host, and the paths on it, that a URL the model writes may take (`admitWebUrl`). */
export interface InstructionLinkSpace {
  host: string;
  pathPrefixes: readonly string[];
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

/**
 * The links `after` holds that no link in `before`, and no URL in `vouched`,
 * already covers: the reach a save of `after` would add.
 */
export function addedInstructionLinks(before: string, after: string, vouched: readonly URL[] = []): string[] {
  const known = [...requesterTypedUrls(before), ...vouched];
  return [...new Set(requesterTypedUrls(after)
    .filter((link) => !known.some((url) => covers(url, link)))
    .map(({ href }) => href))];
}

/** Same origin, and `link`'s path at or below `url`'s, segment by segment, as `matchesEgressPrefix` reads it. */
function covers(url: URL, link: URL): boolean {
  if (url.origin !== link.origin) return false;
  const base = url.pathname.replace(/\/+$/, '');
  return base === '' || link.pathname === base || link.pathname.startsWith(`${base}/`);
}
