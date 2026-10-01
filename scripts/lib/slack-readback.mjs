/**
 * Exact Slack readback for gateway QA lanes.
 *
 * Gateway lanes run on the shared Chickpea app, whose token never reaches the
 * verifier, so a message could only be judged from the rendered client. Each
 * lane workspace instead gets its own read-only app (the manifest in
 * qa/live/operator/slack-readback-app.json), created inside that workspace and
 * installed by the lane's test account. Being internal to its workspace, it
 * keeps Slack's normal history limits. Its user token lives in the lane secrets
 * file as `<LANE>__SLACK_READBACK_TOKEN`; that name is never uploaded to a
 * Worker. This module only reads: it calls read methods, never prints the
 * token, and reports Slack error codes rather than response bodies.
 */
import { QA_LANES } from './qa-lanes.mjs';

export const READBACK_TOKEN_NAME = 'SLACK_READBACK_TOKEN';
const API = 'https://slack.com/api/';
const READ_METHODS = new Set(['auth.test', 'conversations.replies', 'conversations.history', 'conversations.info', 'users.info', 'bots.info', 'files.info']);
const MAX_PAGES = 20;

export class SlackReadbackError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
const fail = (code, message) => { throw new SlackReadbackError(code, message); };

const HINTS = {
  not_authed: 'The readback token is missing or empty.',
  invalid_auth: 'The readback token was revoked or belongs to no workspace. Reinstall the app and replace the token.',
  token_revoked: 'The readback token was revoked. Reinstall the app and replace the token.',
  account_inactive: 'The test account behind the readback token is deactivated.',
  missing_scope: 'The readback app lacks a scope. Update it from the manifest and reinstall.',
  channel_not_found: 'The test account cannot see that conversation. Use a channel it has joined or a DM it is part of.',
  not_in_channel: 'The test account is not a member of that channel.',
  thread_not_found: 'No thread with that timestamp in that conversation.',
};

/** The lane's own token; a shared value would read the wrong workspace, so it is never used. */
export function readbackToken(entries, lane) {
  if (!QA_LANES.includes(lane)) fail('INVALID_LANE', `Choose a lane: ${QA_LANES.join(', ')}.`);
  const value = entries?.get(`${lane.toUpperCase()}__${READBACK_TOKEN_NAME}`);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * A message link in any form Slack shows: an archives permalink
 * (`/archives/C…/p1700000000123456`, optionally `?thread_ts=…`), or a client
 * URL (`/client/T…/C…/thread/C…-1700000000.123456`). Returns the channel, the
 * message ts and the thread ts.
 */
export function parseMessageLink(link) {
  let url;
  try { url = new URL(link); } catch { fail('INVALID_LINK', 'Give a Slack message link.'); }
  if (!/(^|\.)slack\.com$/u.test(url.hostname)) fail('INVALID_LINK', 'The link is not a Slack link.');
  const archive = url.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/u);
  if (archive) {
    const ts = `${archive[2]}.${archive[3]}`;
    const thread = url.searchParams.get('thread_ts');
    return { channel: archive[1], ts, threadTs: thread && /^\d{10}\.\d{6}$/u.test(thread) ? thread : ts };
  }
  const client = url.pathname.match(/^\/client\/[TE][A-Z0-9]+\/([CDG][A-Z0-9]+)\/thread\/([CDG][A-Z0-9]+)-(\d{10}\.\d{6})\/?$/u);
  if (client && client[1] === client[2]) return { channel: client[1], ts: client[3], threadTs: client[3] };
  return fail('INVALID_LINK', 'Use a message permalink (Copy link) or a thread URL from the Slack client.');
}

export function slackClient(token, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!token) fail('NO_READBACK_TOKEN', 'This lane has no readback token. Set it up as hosts.md describes.');
  return async function call(method, params = {}) {
    if (!READ_METHODS.has(method)) fail('METHOD_NOT_ALLOWED', `${method} is not a readback method.`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(`${API}${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429 && attempt === 0) {
        await sleep(Math.min(60, Number(response.headers.get('retry-after')) || 5) * 1000);
        continue;
      }
      if (!response.ok) fail('SLACK_HTTP', `Slack answered HTTP ${response.status} to ${method}.`);
      const body = await response.json();
      if (body?.ok !== true) {
        const code = typeof body?.error === 'string' ? body.error : 'unknown_error';
        fail('SLACK_ERROR', `${method} returned ${code}. ${HINTS[code] ?? ''}`.trim());
      }
      return body;
    }
    return fail('SLACK_RATE_LIMITED', `${method} stayed rate limited.`);
  };
}

/** The fields a verifier compares: who posted, what, where, and what is attached. */
export function normalizeMessage(message) {
  return {
    ts: message.ts,
    threadTs: message.thread_ts ?? null,
    subtype: message.subtype ?? null,
    user: message.user ?? null,
    botId: message.bot_id ?? null,
    appId: message.app_id ?? message.bot_profile?.app_id ?? null,
    sender: message.bot_profile?.name ?? message.username ?? null,
    customName: message.username ?? null,
    text: message.text ?? '',
    blocks: message.blocks ?? [],
    files: (message.files ?? []).map((file) => ({ id: file.id, name: file.name ?? null, title: file.title ?? null, mimetype: file.mimetype ?? null, size: file.size ?? null, owner: file.user ?? null })),
    edited: message.edited ? { user: message.edited.user ?? null, ts: message.edited.ts } : null,
    replyCount: message.reply_count ?? null,
    reactions: (message.reactions ?? []).map((reaction) => ({ name: reaction.name, count: reaction.count })),
  };
}

/** Who the token reads as, and whether that is the lane's own workspace. */
export async function whoami(call, expectedTeamId) {
  const body = await call('auth.test');
  return { teamId: body.team_id, team: body.team, userId: body.user_id, user: body.user, matchesLane: expectedTeamId ? body.team_id === expectedTeamId : null };
}

/** Every message of the thread, root first, across pages. */
export async function readThread(call, { channel, threadTs }) {
  const messages = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await call('conversations.replies', { channel, ts: threadTs, limit: 200, cursor });
    messages.push(...(body.messages ?? []));
    cursor = body.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return { channel, threadTs, messages: messages.map(normalizeMessage) };
}

/** One message by link, from its thread when it has one. */
export async function readMessage(call, link) {
  const { channel, ts, threadTs } = parseMessageLink(link);
  const body = threadTs !== ts
    // Slack puts the thread's root first in every replies page, so leave room for it.
    ? await call('conversations.replies', { channel, ts: threadTs, latest: ts, oldest: ts, inclusive: true, limit: 10 })
    : await call('conversations.history', { channel, latest: ts, oldest: ts, inclusive: true, limit: 1 });
  const found = (body.messages ?? []).find((message) => message.ts === ts);
  if (!found) fail('MESSAGE_NOT_FOUND', 'No message with that timestamp is visible to the test account.');
  return { channel, message: normalizeMessage(found) };
}

/** Top-level messages of a conversation in a window, newest first as Slack returns them. */
export async function readHistory(call, { channel, oldest, latest, limit = 50 }) {
  const body = await call('conversations.history', { channel, oldest, latest, limit: Math.min(200, Math.max(1, limit)) });
  return { channel, messages: (body.messages ?? []).map(normalizeMessage) };
}
