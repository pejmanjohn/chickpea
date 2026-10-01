import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { normalizeMessage, parseMessageLink, readMessage, readThread, readbackToken, slackClient } from '../scripts/lib/slack-readback.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { main, parseArguments } from '../scripts/lane-slack.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { checkReadback } from '../scripts/lib/kickoff-doctor.mjs';

const TOKEN = 'xoxp-test-readback-token-value';

function fakeSlack(handlers: Record<string, (params: URLSearchParams, calls: number) => object | { status: number, retryAfter?: string }>) {
  const seen: { method: string, params: URLSearchParams, auth: string | null }[] = [];
  const counts: Record<string, number> = {};
  const fetchImpl = async (url: string, init: any) => {
    const method = url.replace('https://slack.com/api/', '');
    const params = new URLSearchParams(init.body);
    seen.push({ method, params, auth: init.headers.Authorization });
    counts[method] = (counts[method] ?? 0) + 1;
    const result: any = handlers[method]?.(params, counts[method]) ?? { ok: false, error: 'unknown_method' };
    if (result.status) return new Response('', { status: result.status, headers: result.retryAfter ? { 'retry-after': result.retryAfter } : {} });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, seen };
}

test('message links in permalink and client form resolve to channel, message and thread', () => {
  assert.deepEqual(parseMessageLink('https://lane.slack.com/archives/C0ABC12345/p1790000000123456'),
    { channel: 'C0ABC12345', ts: '1790000000.123456', threadTs: '1790000000.123456' });
  assert.deepEqual(parseMessageLink('https://lane.slack.com/archives/C0ABC12345/p1790000009000001?thread_ts=1790000000.123456&cid=C0ABC12345'),
    { channel: 'C0ABC12345', ts: '1790000009.000001', threadTs: '1790000000.123456' });
  assert.deepEqual(parseMessageLink('https://app.slack.com/client/T0LANE/C0ABC12345/thread/C0ABC12345-1790000000.123456'),
    { channel: 'C0ABC12345', ts: '1790000000.123456', threadTs: '1790000000.123456' });
  assert.deepEqual(parseMessageLink('https://lane.slack.com/archives/D0DM12345/p1790000000123456?thread_ts=bogus'),
    { channel: 'D0DM12345', ts: '1790000000.123456', threadTs: '1790000000.123456' }, 'a malformed thread_ts falls back to the message');
  assert.throws(() => parseMessageLink('https://app.slack.com/client/T0LANE/C0ONE12345/thread/C0TWO12345-1790000000.123456'), /INVALID_LINK/);
  assert.throws(() => parseMessageLink('https://example.com/archives/C0ABC12345/p1790000000123456'), /INVALID_LINK: The link is not a Slack link/);
  assert.throws(() => parseMessageLink('https://lane.slack.com/team/U123'), /INVALID_LINK: Use a message permalink/);
});

test('the client sends the token only as a header, reads only, and explains Slack errors', async () => {
  const slack = fakeSlack({
    'auth.test': () => ({ ok: true, team_id: 'T0LANE', team: 'Lane', user_id: 'U0QA', user: 'qa' }),
    'conversations.history': (_params, calls) => (calls === 1 ? { status: 429, retryAfter: '0' } : { ok: false, error: 'not_in_channel' }),
  });
  const call = slackClient(TOKEN, { fetchImpl: slack.fetchImpl, sleep: async () => {} });
  assert.equal((await call('auth.test')).team_id, 'T0LANE');
  assert.equal(slack.seen[0]?.auth, `Bearer ${TOKEN}`);
  assert.ok(slack.seen.every((entry) => !entry.params.toString().includes(TOKEN)), 'the token never travels in the body');
  await assert.rejects(call('chat.postMessage', { channel: 'C1', text: 'x' }), /METHOD_NOT_ALLOWED/);
  await assert.rejects(call('conversations.history', { channel: 'C1' }), /SLACK_ERROR: conversations.history returned not_in_channel\. The test account is not a member/);
  assert.equal(slack.seen.filter((entry) => entry.method === 'conversations.history').length, 2, 'one retry after a rate limit');
  assert.throws(() => slackClient(undefined), /NO_READBACK_TOKEN/);
});

test('readback normalizes sender, files and edits, pages through threads, and finds a reply by link', async () => {
  const reply = { ts: '1790000005.000002', thread_ts: '1790000000.123456', bot_id: 'B0CHICK', bot_profile: { name: 'Chickpea', app_id: 'A0CHICK' }, username: 'Calendar QA', text: 'Done.', blocks: [{ type: 'rich_text' }], files: [{ id: 'F1', name: 'chart.png', mimetype: 'image/png', size: 10, user: 'U0BOT' }], edited: { user: 'U0BOT', ts: '1790000006.000000' } };
  assert.deepEqual(normalizeMessage(reply), {
    ts: '1790000005.000002', threadTs: '1790000000.123456', subtype: null, user: null, botId: 'B0CHICK', appId: 'A0CHICK',
    sender: 'Chickpea', customName: 'Calendar QA', text: 'Done.', blocks: [{ type: 'rich_text' }],
    files: [{ id: 'F1', name: 'chart.png', title: null, mimetype: 'image/png', size: 10, owner: 'U0BOT' }],
    edited: { user: 'U0BOT', ts: '1790000006.000000' }, replyCount: null, reactions: [],
  });
  const root = { ts: '1790000000.123456', user: 'U0QA', text: '<@U0AGENT> hello', reply_count: 1 };
  const slack = fakeSlack({
    'conversations.replies': (params) => (params.get('cursor')
      ? { ok: true, messages: [root, reply] }
      : params.get('latest') ? { ok: true, messages: [root, reply] } : { ok: true, messages: [root], response_metadata: { next_cursor: 'page2' } }),
  });
  const call = slackClient(TOKEN, { fetchImpl: slack.fetchImpl });
  const thread = await readThread(call, { channel: 'C0ABC12345', threadTs: '1790000000.123456' });
  assert.deepEqual(thread.messages.map((m: any) => m.ts), ['1790000000.123456', '1790000005.000002'], 'the root repeated on a later page is kept once');
  const one = await readMessage(call, 'https://lane.slack.com/archives/C0ABC12345/p1790000005000002?thread_ts=1790000000.123456');
  assert.equal(one.message.sender, 'Chickpea');
  assert.equal(one.message.customName, 'Calendar QA');
});

test('a lane reads only its own token, and the CLI never prints it', async (context) => {
  const entries = new Map([['AMBER__SLACK_READBACK_TOKEN', TOKEN], ['SLACK_READBACK_TOKEN', 'xoxp-shared-wrong']]);
  assert.equal(readbackToken(entries, 'amber'), TOKEN);
  assert.equal(readbackToken(entries, 'cobalt'), undefined, 'a shared value would read the wrong workspace');
  assert.throws(() => parseArguments(['teal', 'whoami']), /Choose a lane/);
  assert.throws(() => parseArguments(['amber', 'thread']), /thread needs a message link/);
  assert.throws(() => parseArguments(['amber', 'message', 'https://x.slack.com/archives/C1/p1790000000123456', '--since', 'x']), /inapplicable/);
  const slack = fakeSlack({
    'auth.test': () => ({ ok: true, team_id: 'T0OTHER', team: 'Other', user_id: 'U0QA', user: 'qa' }),
    'conversations.history': () => ({ ok: true, messages: [{ ts: '1790000000.123456', user: 'U0QA', text: 'hi' }] }),
  });
  let out = '', err = '';
  const io = { stdout: { write: (v: string) => { out += v; } }, stderr: { write: (v: string) => { err += v; } }, fetchImpl: slack.fetchImpl,
    readEntries: () => entries, readRegistry: () => ({ targets: { amber: { workspaceId: 'T0LANE' } } }) };
  assert.equal(await main(['amber', 'whoami'], io), 1, 'a token from another workspace is refused');
  assert.match(err, /different workspace/);
  const dir = mkdtempSync(path.join(tmpdir(), 'lane-slack-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  out = ''; err = '';
  const file = path.join(dir, 'readback.json');
  assert.equal(await main(['amber', 'message', 'https://lane.slack.com/archives/C0ABC12345/p1790000000123456', '--out', file], io), 0, err);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).message.text, 'hi');
  assert.ok(![out, err, readFileSync(file, 'utf8')].some((text) => text.includes(TOKEN)));
  assert.equal(await main(['cobalt', 'whoami'], io), 1);
  assert.match(err, /NO_READBACK_TOKEN: .*A shared SLACK_READBACK_TOKEN is ignored; name it <LANE>__SLACK_READBACK_TOKEN/);
  out = '';
  assert.equal(await main(['amber', 'history', 'C0ABC12345', '--since', '2026-10-01T00:00:00Z', '--limit', '5'], io), 0, err);
  const history = slack.seen.filter((entry) => entry.method === 'conversations.history').at(-1)!;
  assert.equal(history.params.get('oldest'), String(Date.parse('2026-10-01T00:00:00Z') / 1000) + '.000000');
  assert.equal(history.params.get('limit'), '5');
  assert.equal(JSON.parse(out).messages[0].text, 'hi');
  assert.equal(await main(['amber', 'history', 'C0ABC12345', '--limit', '500'], io), 2);
  assert.equal(await main(['amber', 'message', 'https://lane.slack.com/archives/C0ABC12345/p1790000000123456', '--out', path.join(process.cwd(), 'readback.json')], io), 1, 'evidence inside the checkout is refused');
});

test('the kickoff doctor reports whether a lane has a working readback token', async () => {
  const ok = fakeSlack({ 'auth.test': () => ({ ok: true, team_id: 'T0LANE' }) });
  const entries = new Map([['AMBER__SLACK_READBACK_TOKEN', TOKEN]]);
  assert.deepEqual(await checkReadback({ lane: 'amber', registration: { workspaceId: 'T0LANE' }, entries, fetchImpl: ok.fetchImpl }), { state: 'ok' });
  assert.deepEqual(await checkReadback({ lane: 'amber', registration: { workspaceId: 'T0ELSE' }, entries, fetchImpl: ok.fetchImpl }), { state: 'other_workspace' });
  assert.deepEqual(await checkReadback({ lane: 'cobalt', registration: {}, entries }), { state: 'missing' });
  const revoked = fakeSlack({ 'auth.test': () => ({ ok: false, error: 'token_revoked' }) });
  const result = await checkReadback({ lane: 'amber', registration: { workspaceId: 'T0LANE' }, entries, fetchImpl: revoked.fetchImpl });
  assert.equal(result.state, 'error');
  assert.match(result.error, /token_revoked/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  const offline = await checkReadback({ lane: 'amber', registration: { workspaceId: 'T0LANE' }, entries, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(offline, { state: 'error', error: 'TypeError' });
  const html = await checkReadback({ lane: 'amber', registration: { workspaceId: 'T0LANE' }, entries, fetchImpl: async () => new Response('<html>', { status: 200 }) });
  assert.deepEqual(html, { state: 'error', error: 'SLACK_HTTP' });
});
