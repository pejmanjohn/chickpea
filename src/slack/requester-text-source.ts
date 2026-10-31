/**
 * Who wrote a turn's requester text when the person did not type it: the
 * host's description of a click or form answer, or Chickpea's note that a
 * connection setup finished. No check that needs the person's own typed
 * words reads text with a source.
 */
export type RequesterTextSource = 'click' | 'setup';

const SOURCES: ReadonlySet<unknown> = new Set<RequesterTextSource>(['click', 'setup']);

export function isRequesterTextSource(value: unknown): value is RequesterTextSource {
  return SOURCES.has(value);
}
