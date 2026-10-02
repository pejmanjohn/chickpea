/** What an error, or a Flue failure record, may carry that a detector reads. */
export interface ErrorChainLink {
  readonly message?: unknown;
  readonly type?: unknown;
  readonly code?: unknown;
  readonly reasonCode?: unknown;
}

/**
 * Whether an error, or one it carries as its `cause` (at most five deep, and
 * never round a cycle), satisfies `test`. A Flue submission's failure reaches
 * Core as such a chain of plain records, with the original error's code
 * surviving only as text in a message.
 */
export function errorChainIncludes(error: unknown, test: (link: ErrorChainLink) => boolean): boolean {
  const seen = new Set<unknown>();
  for (let current = error, depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (test(current as ErrorChainLink)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
