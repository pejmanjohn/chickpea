import { z } from 'zod';

import { ADMIN_PATH, adminOrigin } from '../admin-links.ts';
import { offNextStep, type ChangeResult } from './changes.ts';
import { mcpErrorText, openOutputSchema, type McpToolError } from './conventions.ts';
import { cardRefusalOutput } from './schemas.ts';

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
  // Only a body that says how small it is gets read twice; an upload never does.
  const length = Number(request.headers.get('content-length') ?? Number.NaN);
  if (!(length <= MAX_INITIALIZE_BYTES)) return false;
  const text = await request.clone().text().catch(() => '');
  if (text.length > MAX_INITIALIZE_BYTES || !text.includes('"initialize"')) return false;
  try {
    const message = JSON.parse(text) as { method?: unknown; params?: { capabilities?: unknown } };
    return message.method === 'initialize' && declaresCards(message.params?.capabilities);
  } catch {
    return false;
  }
}

/**
 * A refusal on a card session, as a result. ChatGPT answers a card's call
 * whose result has `isError` with a JSON-RPC error that keeps only the text,
 * inside its own wrapper (probe 12), so a card could never read the code or
 * the sentence. The text leads with the refusal and its code, so the model
 * still learns the call was refused.
 */
export function cardRefusal(error: McpToolError) {
  return {
    content: [{ type: 'text' as const, text: `Refused (${error.code}): ${mcpErrorText(error)}` }],
    structuredContent: { error },
    isError: false as const,
  };
}

let refusalSchema: Record<string, unknown> | undefined;

/**
 * A tool's output schema on a card session, when its refusals are results:
 * its own output, or the refusal. A result's `structuredContent` must match
 * the schema a client listed, and a client may check it.
 */
export function withRefusalOutput(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...own } = schema;
  refusalSchema ??= openOutputSchema(z.toJSONSchema(cardRefusalOutput, { io: 'output', target: 'draft-2020-12' }) as Record<string, unknown>);
  const { $schema: _same, ...refusal } = refusalSchema;
  return { ...$schema === undefined ? {} : { $schema }, type: 'object', anyOf: [own, refusal] };
}

/** Tokens a card holds instead of the model: confirm and undo. */
export interface HeldTokens {
  confirmToken?: string;
  undoToken?: string;
}

/**
 * What a card host's model hears with a result a card shows, when the card
 * waits for the person's press. The card changes when they press, and the
 * model's own words would not, so it says one sentence and waits instead of
 * listing what the card shows.
 */
export const CARD_WAITS = 'The card shows this to the person, and it waits for them to act on it there. Reply in one short sentence that says what they can do: don\'t restate what the card shows, don\'t name its buttons, and don\'t say whether anything was created, saved, connected or changed, because the card replaces itself when they press. Then wait for them.';

/**
 * What a card host's model hears with a result a card shows that waits for
 * no press, such as a created Agent: the job goes on, so a stop here would
 * leave the person to restart it.
 */
export const CARD_SHOWS_IT = 'The card shows this to the person, and it waits for nothing. Don\'t restate what it shows or name its buttons. Carry on with the job.';

/**
 * What a card host's model hears with a result a card shows that leaves the
 * person a question no card asks, such as an Agent like the new one existing
 * already. The result's own next step follows it: carrying on would answer
 * the question for them.
 */
export const CARD_SHOWS_QUESTION = 'The card shows this to the person. Don\'t restate what it shows or name its buttons.';

/**
 * What a card host's model hears when its own update_agent waits for a
 * confirmation: no card draws that result, and only a card asks a card
 * host's person to confirm, so the change goes through the preview's card.
 */
export const CONFIRM_ON_A_PREVIEW = 'Nothing has changed. On this client only a card asks the person to confirm, and none shows this one. Call propose_agent_change with the same change, and its card asks them.';

/**
 * A result as a card host's model sees it: no token it could use without
 * the person's press, and words that send the person to the card, or,
 * should the host fail to draw it, to Admin or to a new chat. `drawn`: a
 * card draws this tool's result, so the model is told the card shows it,
 * in the result's next step and in a text block before its JSON, and
 * whether to wait for a press or carry on. A result no card draws keeps
 * its own next step and names no card: a card that called the tool reads
 * only its tokens, and the model that called it sees no card.
 */
export function forCardHost(
  result: Record<string, unknown>,
  baseUrl: string | undefined,
  drawn: boolean,
): { structured: Record<string, unknown>; held?: HeldTokens; lead?: string } {
  const change = result as Partial<ChangeResult>;
  const confirmToken = change.confirmation?.confirmToken;
  const { undoToken } = change;
  const shows = drawn && cardActsOn(change);
  if (confirmToken === undefined && undoToken === undefined && !shows) return { structured: result };
  const lead = waitsForPress(result) ? CARD_WAITS
    : asksThePerson(change) ? [CARD_SHOWS_QUESTION, change.nextStep].filter(Boolean).join(' ')
      : CARD_SHOWS_IT;
  const { undoToken: _undo, ...rest } = change;
  const structured: Partial<ChangeResult> = rest;
  if (confirmToken !== undefined) {
    const { confirmToken: _confirm, ...confirmation } = change.confirmation!;
    structured.confirmation = confirmation;
    structured.summary = shows
      ? `Nothing has changed yet. ${elsewhere(confirmation.inAdmin, change.agent?.links?.admin ?? workspaceAdmin(baseUrl))}`
      : 'Nothing has changed yet.';
  }
  if (shows) {
    structured.nextStep = [
      lead,
      confirmToken !== undefined ? 'Only the card can confirm it: it holds the confirmToken.' : undefined,
      undoToken !== undefined ? 'They can undo it on the card.' : undefined,
      change.status === 'done' && change.agent?.status === 'off' ? offNextStep(change.agent.name) : undefined,
    ].filter(Boolean).join(' ');
  }
  const held = { ...confirmToken !== undefined ? { confirmToken } : {}, ...undoToken !== undefined ? { undoToken } : {} };
  return {
    structured,
    ...Object.keys(held).length ? { held } : {},
    ...shows ? { lead } : {},
  };
}

/** A setup link with no setupToken is not Chickpea's page for one connection: the card cannot open it, so the model gives it. */
function cardActsOn(result: Partial<ChangeResult>): boolean {
  return !(result.status === 'needs_setup' && !result.setup?.setupToken);
}

/**
 * The card waits for the person's press: a proposal, whose Create or Save
 * makes it (`create` or `save` holds the call); a change to confirm; or a
 * setup link to open (one the card can open, by `cardActsOn`). Any other
 * card shows what is already done.
 */
function waitsForPress(result: Record<string, unknown>): boolean {
  const { status, confirmation } = result as Partial<ChangeResult>;
  return 'create' in result || 'save' in result
    || confirmation?.confirmToken !== undefined
    || status === 'needs_setup';
}

/** Nothing was done, and the result's next step has the model ask the person which way to go. */
function asksThePerson({ status }: Partial<ChangeResult>): boolean {
  return status === 'similar_agent_exists' || status === 'needs_choice';
}

/** Where else the person can make the change, should the card not show: only a way that exists. */
function elsewhere(inAdmin: boolean, admin: string | undefined): string {
  if (!inAdmin) return 'Confirm on the card. If the card doesn\'t show, ask again in a new chat.';
  return `Confirm on the card, or in Admin${admin ? `: ${admin}` : ''}.`;
}

function workspaceAdmin(baseUrl: string | undefined): string | undefined {
  const origin = adminOrigin(baseUrl);
  return origin && `${origin}${ADMIN_PATH}`;
}
