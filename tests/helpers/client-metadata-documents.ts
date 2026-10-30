import { readFileSync } from 'node:fs';

import type { ClientMetadataFetch } from '../../src/auth/mcp-client-metadata.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/mcp-client-metadata/${name}`, import.meta.url), 'utf8');

/** Claude's published Client ID Metadata Documents, byte for byte as claude.ai serves them. */
export const CLAUDE_DOCUMENTS = {
  claude: { url: 'https://claude.ai/oauth/mcp-oauth-client-metadata', body: fixture('claude.json') },
  claudeCode: { url: 'https://claude.ai/oauth/claude-code-client-metadata', body: fixture('claude-code.json') },
} as const;

type Served = { body: string; status?: number; headers?: Record<string, string> };

/**
 * A metadata-document host: each URL answers its body as claude.ai does
 * (JSON, five minutes fresh) unless the entry says otherwise; any other URL
 * answers 404. `requests` lists every URL asked for, in order.
 */
export function metadataDocumentServer(served: Record<string, string | Served>) {
  const requests: string[] = [];
  const fetch: ClientMetadataFetch = async (input, init) => {
    const { url } = new Request(input, init);
    requests.push(url);
    const entry = served[url];
    if (entry === undefined) return new Response('Not Found', { status: 404 });
    const { body, status = 200, headers = {} } = typeof entry === 'string' ? { body: entry } : entry;
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', ...headers },
    });
  };
  return { fetch, requests };
}
