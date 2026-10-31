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

/** ChatGPT's own document, which authenticates by private_key_jwt. */
export const CHATGPT_DOCUMENT = { url: 'https://chatgpt.com/oauth/client.json', body: fixture('chatgpt.json') } as const;

const JSON_UTF8 = 'application/json; charset=utf-8';

function onPort(listed: string, port: number): string {
  const url = new URL(listed);
  url.port = String(port);
  return url.href;
}

/** Other published public-client documents, byte for byte and with the headers their hosts send. */
export const PUBLIC_CLIENT_DOCUMENTS = {
  vscode: {
    url: 'https://vscode.dev/oauth/client-metadata.json',
    served: { body: fixture('vscode.json'), headers: { 'content-type': JSON_UTF8, 'cache-control': 'no-store,no-cache,max-age=0' } },
    redirect: 'http://127.0.0.1:33418/',
  },
  vscodeInsiders: {
    url: 'https://insiders.vscode.dev/oauth/client-metadata.json',
    served: { body: fixture('vscode-insiders.json'), headers: { 'content-type': JSON_UTF8, 'cache-control': 'no-store,no-cache,max-age=0' } },
    redirect: 'http://127.0.0.1:33418/',
  },
  zed: {
    url: 'https://zed.dev/oauth/client-metadata.json',
    served: { body: fixture('zed.json'), headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=0, must-revalidate' } },
    redirect: onPort('http://127.0.0.1/callback', 50113),
  },
  goose: {
    url: 'https://goose-docs.ai/oauth/client-metadata.json',
    served: { body: fixture('goose.json'), headers: { 'content-type': JSON_UTF8, 'cache-control': 'max-age=600' } },
    redirect: onPort('http://[::1]/oauth_callback', 50114),
  },
} as const;

/** Cursor's document, which lists a redirect on grok.com beside its own. */
export const CURSOR_DOCUMENT = { url: 'https://cursor.com/oauth/mcp-client.json', body: fixture('cursor.json') } as const;

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
