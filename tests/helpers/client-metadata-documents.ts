import { readFileSync } from 'node:fs';

import type { ClientMetadataFetch } from '../../src/auth/mcp-client-metadata.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/mcp-client-metadata/${name}`, import.meta.url), 'utf8');

/** Claude's published Client ID Metadata Documents, byte for byte as claude.ai serves them. */
export const CLAUDE_DOCUMENTS = {
  claude: { url: 'https://claude.ai/oauth/mcp-oauth-client-metadata', body: fixture('claude.json') },
  claudeCode: { url: 'https://claude.ai/oauth/claude-code-client-metadata', body: fixture('claude-code.json') },
} as const;

/** Codex's published Client ID Metadata Document, byte for byte as chatgpt.com serves it. */
export const CODEX_DOCUMENT = { url: 'https://chatgpt.com/oauth/codex/client.json', body: fixture('codex.json') } as const;

export type ServedDocument = string | { body: string; status?: number; headers?: Record<string, string> } | (() => never);

/**
 * A metadata-document host: each URL answers its body as claude.ai and
 * chatgpt.com do (JSON, five minutes fresh) unless the entry says otherwise,
 * or throws as a failed connection does; any other URL answers 404. Entries
 * are read per request, so a test can change them. `requests` lists every URL
 * asked for.
 */
export function metadataDocumentServer(served: Record<string, ServedDocument>) {
  const requests: string[] = [];
  const fetch: ClientMetadataFetch = async (input, init) => {
    const { url } = new Request(input, init);
    requests.push(url);
    const entry = served[url];
    if (entry === undefined) return new Response('Not Found', { status: 404 });
    if (typeof entry === 'function') return entry();
    const { body, status = 200, headers = {} } = typeof entry === 'string' ? { body: entry } : entry;
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', ...headers },
    });
  };
  return { fetch, requests };
}
