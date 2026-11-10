import { ADMIN_PATH, adminOrigin } from '../admin-links.ts';
import type { ChangeResult } from './changes.ts';

/**
 * Whether a card draws this connection's results. A client that declares
 * MCP Apps (`extensions["io.modelcontextprotocol/ui"]` with the card's MIME
 * type) gets each card's tokens in the result's `_meta`, which a host hands
 * only to the card and never to its model, so only a press on the card can
 * confirm or undo. Any other client keeps them where its model reads them.
 *
 * In the 2026-07-28 era every request carries the client's capabilities. On
 * the stateless 2025 door only `initialize` does, so its response names a
 * session that says so, and the client sends that session with every later
 * request. A client that sends no session gets today's results.
 */

const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const CARD_MIME_TYPE = 'text/html;profile=mcp-app';
const CARD_SESSION_PREFIX = 'chickpea-cards-';
const SESSION_HEADER = 'mcp-session-id';
/** An `initialize` is a few hundred bytes; a larger body is never one. */
const MAX_INITIALIZE_BYTES = 16_384;

export function declaresCards(capabilities: unknown): boolean {
  const extension = (capabilities as { extensions?: Record<string, { mimeTypes?: unknown } | undefined> } | undefined)
    ?.extensions?.[UI_EXTENSION];
  return Array.isArray(extension?.mimeTypes) && extension.mimeTypes.includes(CARD_MIME_TYPE);
}

/**
 * Serves one request, telling `serve` whether its session draws cards. The
 * SDK's stateless transport ignores a session it did not make, so nothing
 * else changes for a request that carries one.
 */
export async function withCardSessions(
  request: Request,
  serve: (request: Request, cardSession: boolean) => Promise<Response>,
): Promise<Response> {
  const cardSession = request.headers.get(SESSION_HEADER)?.startsWith(CARD_SESSION_PREFIX) === true;
  const opens = !cardSession && await initializeDeclaresCards(request);
  const response = await serve(request, cardSession);
  if (!opens || !response.ok || response.headers.has(SESSION_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.set(SESSION_HEADER, `${CARD_SESSION_PREFIX}${crypto.randomUUID()}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function initializeDeclaresCards(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const text = await request.clone().text().catch(() => '');
  if (text.length > MAX_INITIALIZE_BYTES || !text.includes('"initialize"')) return false;
  try {
    const message = JSON.parse(text) as { method?: unknown; params?: { capabilities?: unknown } };
    return message.method === 'initialize' && declaresCards(message.params?.capabilities);
  } catch {
    return false;
  }
}

/** Tokens a card holds instead of the model: confirm and undo. */
export interface HeldTokens {
  confirmToken?: string;
  undoToken?: string;
}

/**
 * A change result as a card host's model sees it: no token it could use
 * without the person's press, and words that send the person to the card,
 * or to Admin should the host fail to draw it.
 */
export function holdTokens(
  result: Record<string, unknown>,
  baseUrl: string | undefined,
): { structured: Record<string, unknown>; held?: HeldTokens } {
  const change = result as Partial<ChangeResult>;
  const confirmToken = change.confirmation?.confirmToken;
  const { undoToken } = change;
  if (confirmToken === undefined && undoToken === undefined) return { structured: result };
  const { undoToken: _undo, ...rest } = change;
  const structured: Partial<ChangeResult> = rest;
  if (confirmToken !== undefined) {
    const { confirmToken: _confirm, ...confirmation } = change.confirmation!;
    const admin = change.agent?.links?.admin ?? workspaceAdmin(baseUrl);
    structured.confirmation = confirmation;
    structured.summary = `Nothing has changed yet. Confirm on the card above${admin ? `, or in Admin: ${admin}` : ''}.`;
    structured.nextStep = 'The person confirms on the card, which holds the confirmToken. Wait for them.';
  }
  if (undoToken !== undefined) {
    structured.nextStep = [change.nextStep, 'The person can undo it on the card above.'].filter(Boolean).join(' ');
  }
  return {
    structured,
    held: { ...confirmToken !== undefined ? { confirmToken } : {}, ...undoToken !== undefined ? { undoToken } : {} },
  };
}

function workspaceAdmin(baseUrl: string | undefined): string | undefined {
  const origin = adminOrigin(baseUrl);
  return origin && `${origin}${ADMIN_PATH}`;
}
