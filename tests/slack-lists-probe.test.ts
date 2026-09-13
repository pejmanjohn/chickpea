import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackListsProbe, type ListsProbeMethod, type ListsProbeReceipt, type ListsProbeSpec } from '../qa/live/probes/slack-lists.ts';

const spec: ListsProbeSpec = { workspaceId: 'TQA', listIds: ['FQA'], userIds: ['UQA'], channelIds: ['CQA'], cleanupItemIds: ['RecQA'] };
const auth = { ok: true, team_id: 'TQA', bot_id: 'BQA' };
const response = (data: unknown) => new Response(JSON.stringify(data));

test('probe verifies bot workspace and rejects authority overrides and undeclared fixtures before dispatch', async () => {
  const calls: string[] = [];
  const probe = new SlackListsProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: async url => { calls.push(String(url)); return response(auth); } });
  await assert.rejects(probe.call('unverified', 'slackLists.items.list', { list_id: 'FQA', limit: 5 }, spec), /Verify bot workspace/);
  await probe.call('auth', 'auth.test', {}, spec);
  for (const [method, input] of [
    ['slackLists.items.list', { list_id: 'FOTHER', limit: 5 }],
    ['slackLists.items.create', { list_id: 'FQA', token: 'override' }],
    ['slackLists.items.create', { list_id: 'FQA', initial_fields: [{ user: ['UOTHER'] }] }],
    ['slackLists.access.set', { list_id: 'FQA', channel_ids: ['COTHER'], access_level: 'write' }],
    ['slackLists.access.set', { list_id: 'FQA', user_ids: ['UQA'], access_level: 'owner' }],
    ['slackLists.items.delete', { list_id: 'FQA', id: 'RecOTHER' }],
    ['slackLists.create', { copy_from_list_id: 'FQA' }],
    ['slackLists.items.list', { list_id: 'FQA', limit: 51 }],
    ['files.delete', { file: 'FQA' }],
  ] as const) {
    await assert.rejects(probe.call('invalid', method as ListsProbeMethod, input, spec));
  }
  await assert.rejects(probe.call('other-workspace', 'slackLists.items.list', { list_id: 'FQA', limit: 1 }, { ...spec, workspaceId: 'TOTHER' }));
  assert.equal(calls.length, 1);
});

test('probe records dispatch before a write, never retries an unknown outcome, and refuses replay', async () => {
  const receipts: ListsProbeReceipt[] = [];
  let calls = 0;
  const probe = new SlackListsProbe({ token: 'xoxb-test-only', record: async r => { receipts.push(r); }, fetch: async () => {
    calls++;
    assert.equal(receipts.at(-1)?.phase, 'dispatching');
    if (calls === 1) return response(auth);
    throw new Error('Possible accepted write; error includes xoxb-test-only');
  } });
  await probe.call('auth', 'auth.test', {}, spec);
  assert.equal((await probe.call('create', 'slackLists.items.create', { list_id: 'FQA' }, spec)).phase, 'unknown');
  await assert.rejects(probe.call('create', 'slackLists.items.create', { list_id: 'FQA' }, spec));
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(receipts).includes('xoxb-test-only'), false);
});

test('failed dispatch receipt prevents the HTTP call; failed reauthentication revokes the verified workspace', async () => {
  let calls = 0;
  const blocked = new SlackListsProbe({ token: 'xoxb-test-only', record: async () => { throw new Error('Disk unavailable'); }, fetch: async () => { calls++; return response(auth); } });
  await assert.rejects(blocked.call('auth', 'auth.test', {}, spec), /Disk unavailable/);
  assert.equal(calls, 0);
  const probe = new SlackListsProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: async () => response(++calls === 1 ? auth : { ok: false, error: 'token_revoked' }) });
  await probe.call('auth1', 'auth.test', {}, spec);
  await probe.call('auth2', 'auth.test', {}, spec);
  await assert.rejects(probe.call('write', 'slackLists.create', { name: 'QA' }, spec), /Verify bot workspace/);
});

test('classic helpers use form parameters while Lists keep typed JSON fields and record Slack rate limits', async () => {
  const requests: RequestInit[] = [];
  const probe = new SlackListsProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: async (_url, init) => {
    requests.push(init!);
    return requests.length === 1 ? response(auth) : new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 429, headers: { 'Retry-After': '30', 'x-oauth-scopes': 'lists:read,lists:write' } });
  } });
  await probe.call('auth', 'auth.test', {}, spec);
  await probe.call('user', 'users.info', { user: 'UQA' }, spec);
  const result = await probe.call('read', 'slackLists.items.list', { list_id: 'FQA', include_list: true, limit: 2 }, spec);
  assert.equal(requests[1]?.body, 'user=UQA');
  assert.equal(JSON.parse(String(requests[2]?.body)).include_list, true);
  assert.equal(result.status, 429);
  assert.equal(result.retryAfter, '30');
  assert.deepEqual(result.scopes, ['lists:read', 'lists:write']);
  assert.equal(requests.length, 3);
});
