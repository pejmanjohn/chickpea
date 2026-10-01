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

/** Why a lane has no token, when the file holds one under the shared name by mistake. */
export function readbackTokenHint(entries) {
  return entries?.get(READBACK_TOKEN_NAME) ? ` A shared ${READBACK_TOKEN_NAME} is ignored; name it <LANE>__${READBACK_TOKEN_NAME}.` : '';
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
      let body;
      try { body = await response.json(); } catch { fail('SLACK_HTTP', `${method} returned a non-JSON body.`); }
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
    // Every page starts with the thread's root; keep it once.
    messages.push(...(body.messages ?? []).filter((message) => page === 0 || message.ts !== threadTs));
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
  if (!found) fail('MESSAGE_NOT_FOUND', 'No message with that timestamp is visible to the test account. If it is a thread reply, copy its link from the thread view, which carries thread_ts.');
  return { channel, message: normalizeMessage(found) };
}

/** Top-level messages of a conversation in a window, newest first as Slack returns them. */
export async function readHistory(call, { channel, oldest, latest, limit = 50 }) {
  const body = await call('conversations.history', { channel, oldest, latest, limit: Math.min(200, Math.max(1, limit)) });
  return { channel, messages: (body.messages ?? []).map(normalizeMessage) };
}

// ---------------------------------------------------------------------------
// Storing a lane's token, run by the maintainer once per lane.
//
// The token is read from the readback app's own OAuth page in the lane's
// browser daemon, checked against the lane's workspace, and written to the lane
// secrets file. Only its fingerprint is ever reported.

export const READBACK_APP_NAME = 'Chickpea QA Readback';

// Expressions evaluated in the lane browser page; constants, never built from input.
export const APP_LIST_EXPRESSION = `[...document.querySelectorAll('a[href*="/apps/A"]')].map((a) => ({ href: a.getAttribute('href'), row: (a.closest('tr') || a).innerText.replace(/\\s+/g, ' ').trim() }))`;
export const APP_TOKEN_EXPRESSION = `(() => { const m = location.pathname.match(/app-settings\\/(T[A-Z0-9]+)\\/(A[A-Z0-9]+)\\/oauth/); const v = [...document.querySelectorAll('input')].map((i) => i.value || '').find((x) => /^xoxp-/.test(x)); return { team: m ? m[1] : null, app: m ? m[2] : null, token: v || null }; })()`;

/** Find this lane's readback app in the Slack app console, by name and workspace. */
export async function findReadbackApp({ probePage, port, workspaceLabel }) {
  const page = await probePage({
    port, url: 'https://api.slack.com/apps',
    extract: APP_LIST_EXPRESSION,
    settledWhen: (p) => Array.isArray(p.extra) && p.extra.length > 0,
  });
  const rows = Array.isArray(page.extra) ? page.extra : [];
  const match = rows.find((row) => row.row.startsWith(`${READBACK_APP_NAME} ${workspaceLabel} `));
  const appId = match?.href?.match(/\/apps\/(A[A-Z0-9]+)/u)?.[1];
  if (!appId) fail('READBACK_APP_NOT_FOUND', `No "${READBACK_APP_NAME}" app for ${workspaceLabel} in this lane browser. Create it from the manifest first.`);
  return appId;
}

/** Read the app's user token from its OAuth page; refuse a page for another workspace. */
export async function readAppToken({ probePage, port, appId, teamId }) {
  const page = await probePage({
    port, url: `https://api.slack.com/apps/${appId}/oauth`,
    extract: APP_TOKEN_EXPRESSION,
    settledWhen: (p) => Boolean(p.extra?.token),
  });
  const found = page.extra ?? {};
  if (found.app !== appId || found.team !== teamId) fail('READBACK_APP_MISMATCH', 'The app page does not belong to this lane\'s workspace.');
  if (!found.token) fail('READBACK_NOT_INSTALLED', 'The app has no user token yet. Install it to the workspace first.');
  return found.token;
}

/** Find, read, check and store one lane's token. Returns only what is safe to print. */
export async function storeLaneToken({ lane, registration, port, probePage, fetchImpl, writeSecret, fingerprint }) {
  if (!registration?.workspaceId || !registration?.workspaceLabel) fail('LANE_NOT_REGISTERED', `${lane} has no registered workspace.`);
  const appId = await findReadbackApp({ probePage, port, workspaceLabel: registration.workspaceLabel });
  const token = await readAppToken({ probePage, port, appId, teamId: registration.workspaceId });
  const who = await whoami(slackClient(token, fetchImpl ? { fetchImpl } : {}), registration.workspaceId);
  if (who.matchesLane !== true) fail('READBACK_WRONG_WORKSPACE', 'The token reads a different workspace than this lane.');
  writeSecret(`${lane.toUpperCase()}__${READBACK_TOKEN_NAME}`, token);
  return { lane, stored: true, appId, workspace: registration.workspaceLabel, fingerprint: fingerprint(token) };
}
