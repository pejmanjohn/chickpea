import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { SignJWT } from 'jose';

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

/** ChatGPT's own document, which authenticates by private_key_jwt against `keysUrl`. */
export const CHATGPT_DOCUMENT = {
  url: 'https://chatgpt.com/oauth/client.json',
  body: fixture('chatgpt.json'),
  callback: 'https://chatgpt.com/connector_platform_oauth_redirect',
  keysUrl: 'https://chatgpt.com/oauth/jwks.json',
} as const;

export const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Claims and header of one client assertion; omitted claims are ChatGPT's own, valid for a minute. */
export interface AssertionShape {
  aud: string;
  iss?: string;
  sub?: string;
  exp?: number | undefined;
  iat?: number;
  jti?: string;
  alg?: 'RS256' | 'HS256' | 'none';
  kid?: string;
}

/**
 * A key pair a client signs its assertions with, as ChatGPT does: RS256 under
 * a key ID, issuer and subject its client ID, a fresh `jti` each time.
 * `keySet` is what its `jwks_uri` serves.
 */
export function assertionSigner(clientId: string = CHATGPT_DOCUMENT.url, kid = 'cimd-20260428030119') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keySet = { keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid }] };
  async function assertion(shape: AssertionShape): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const claims = {
      iss: shape.iss ?? clientId, sub: shape.sub ?? clientId, aud: shape.aud,
      ...('exp' in shape ? (shape.exp === undefined ? {} : { exp: shape.exp }) : { exp: now + 60 }),
      iat: shape.iat ?? now, jti: shape.jti ?? randomUUID(),
    };
    const alg = shape.alg ?? 'RS256';
    if (alg === 'none') return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.`;
    // The algorithm-confusion forgery: an HMAC keyed with the published key set.
    if (alg === 'HS256') return new SignJWT(claims).setProtectedHeader({ alg, kid: shape.kid ?? kid }).sign(new TextEncoder().encode(JSON.stringify(keySet)));
    return new SignJWT(claims).setProtectedHeader({ alg, kid: shape.kid ?? kid }).sign(privateKey);
  }
  return { clientId, kid, keySet, assertion };
}

export type AssertionSigner = ReturnType<typeof assertionSigner>;

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
