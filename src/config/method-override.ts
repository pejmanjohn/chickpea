/** Headers some servers honour in place of the request method. */
const METHOD_OVERRIDE_HEADERS: readonly string[] = ['x-http-method-override', 'x-http-method', 'x-method-override'];

/**
 * Whether a request asks the server to treat it as another method: a
 * method-override header, or a `_method` query parameter, each in any case.
 */
export function overridesMethod(url: URL, headerNames: Iterable<string>): boolean {
  return [...headerNames].some((name) => METHOD_OVERRIDE_HEADERS.includes(name.toLowerCase())) ||
    [...url.searchParams.keys()].some((key) => key.toLowerCase() === '_method');
}
