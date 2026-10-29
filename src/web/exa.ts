import * as v from 'valibot';

import { envValue } from '../config/env-value.ts';
import { readBoundedText } from '../http/bounded-body.ts';
import { WEB_SEARCH_EXCERPT_CHARS, WEB_SEARCH_RESULTS, type WebSearchHit, type WebSearchProvider } from './search.ts';

/** The deployment secret that turns web search on: a Worker secret on Cloudflare, an env var on Node. */
export const WEB_SEARCH_KEY_ENV = 'EXA_API_KEY';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
/** Five results of 2,000 characters each, with Exa's metadata around them. */
const MAX_RESPONSE_BYTES = 512 * 1024;

const ExaSearchResponse = v.object({
  results: v.array(v.object({
    url: v.string(),
    title: v.optional(v.nullable(v.string())),
    text: v.optional(v.nullable(v.string())),
  })),
});

class ExaSearchError extends Error {}

/** Whether the deployment can search, for freezing the capability into a turn's plan. */
export function webSearchConfigured(env: Record<string, unknown> | undefined): boolean {
  return envValue(env, WEB_SEARCH_KEY_ENV) !== undefined;
}

/**
 * Exa's search, with each result's page text, or undefined when the
 * deployment has no key. The key goes only in Exa's `x-api-key` header.
 */
export function webSearchProvider(
  env: Record<string, unknown> | undefined,
  options: { fetch?: typeof fetch } = {},
): WebSearchProvider | undefined {
  const apiKey = envValue(env, WEB_SEARCH_KEY_ENV);
  if (!apiKey) return undefined;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async search(query, signal): Promise<WebSearchHit[]> {
      const response = await send(EXA_SEARCH_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query,
          numResults: WEB_SEARCH_RESULTS,
          contents: { text: { maxCharacters: WEB_SEARCH_EXCERPT_CHARS } },
        }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ExaSearchError(`Exa answered HTTP ${response.status}`);
      }
      const body = await readBoundedText(response, {
        maxBytes: MAX_RESPONSE_BYTES,
        onOversize: () => new ExaSearchError('Exa answered with too much'),
        signal,
      });
      const parsed = v.safeParse(ExaSearchResponse, JSON.parse(body));
      if (!parsed.success) throw new ExaSearchError('Exa answered in an unknown shape');
      return parsed.output.results.map(({ url, title, text }) => ({ url, title: title ?? '', text: text ?? '' }));
    },
  };
}
