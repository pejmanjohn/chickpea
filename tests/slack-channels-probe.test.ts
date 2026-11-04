import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SlackChannelsProbe,
  type ChannelsProbeMethod,
  type ChannelsProbeReceipt,
  type ChannelsProbeSpec,
} from '../qa/live/probes/slack-channels.ts';

const spec: ChannelsProbeSpec = {
  workspaceId: 'TQA', runNamePrefix: 'qa-probe-run1-', readableChannelIds: ['CQA'], runChannelIds: ['CRUN'], userIds: ['UQA', 'UQB'],
};
const auth = { ok: true, team_id: 'TQA', bot_id: 'BQA' };
const response = (data: unknown) => new Response(JSON.stringify(data));

test('channel probe verifies the bot workspace and refuses overrides, foreign names, channels and people before dispatch', async () => {
  const calls: string[] = [];
  const probe = new SlackChannelsProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: async (url) => { calls.push(String(url)); return response(auth); } });
  await assert.rejects(probe.call('unverified', 'conversations.info', { channel: 'CQA' }, spec), /Verify bot workspace/);
  await probe.call('auth', 'auth.test', {}, spec);
  for (const [method, input] of [
    ['conversations.create', { name: 'acme-renewal', is_private: true }],
    ['conversations.create', { name: 'qa-probe-run1-x', team_id: 'TOTHER' }],
    ['conversations.invite', { channel: 'CQA', users: 'UQA' }],
    ['conversations.invite', { channel: 'CRUN', users: 'UQA,UOTHER' }],
    ['conversations.invite', { channel: 'CRUN', users: 'UQA', force: true }],
    ['conversations.archive', { channel: 'CQA' }],
    ['chat.postMessage', { channel: 'CQA', text: 'x' }],
    ['conversations.setPurpose', { purpose: 'x' }],
    ['conversations.members', { channel: 'COTHER' }],
    ['users.info', { user: 'UOTHER' }],
    ['conversations.kick', { channel: 'CRUN', user: 'UQA' }],
  ] as const) {
    await assert.rejects(probe.call('invalid', method as ChannelsProbeMethod, input, spec),
      (error: Error) => !/attempt ID/.test(error.message), `${method} ${JSON.stringify(input)}`);
  }
  await assert.rejects(probe.call('other-workspace', 'conversations.info', { channel: 'CQA' }, { ...spec, workspaceId: 'TOTHER' }));
  assert.equal(calls.length, 1);
});

test('channel probe records dispatch before a write, never retries an unknown outcome, and keeps the token out of receipts', async () => {
  const receipts: ChannelsProbeReceipt[] = [];
  let calls = 0;
  const probe = new SlackChannelsProbe({ token: 'xoxb-test-only', record: async (r) => { receipts.push(r); }, fetch: async () => {
    calls++;
    assert.equal(receipts.at(-1)?.phase, 'dispatching');
    if (calls === 1) return response(auth);
    throw new Error('Possible accepted write; error includes xoxb-test-only');
  } });
  await probe.call('auth', 'auth.test', {}, spec);
  const unknown = await probe.call('create', 'conversations.create', { name: 'qa-probe-run1-private', is_private: true }, spec);
  assert.equal(unknown.phase, 'unknown');
  assert.equal(JSON.stringify(receipts).includes('xoxb-test-only'), false);
  await assert.rejects(probe.call('create', 'conversations.create', { name: 'qa-probe-run1-private', is_private: true }, spec), /new, reconciled/);
  assert.equal(calls, 2);
});

test('channel probe sends form fields, as the tool\'s Slack client does', async () => {
  const bodies: { method: string; type: string | null; body: string }[] = [];
  const probe = new SlackChannelsProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: async (url, init) => {
    bodies.push({ method: String(url).split('/').at(-1)!, type: new Headers(init?.headers).get('content-type'), body: String(init?.body) });
    return response(bodies.length === 1 ? auth : { ok: true });
  } });
  await probe.call('auth', 'auth.test', {}, spec);
  await probe.call('invite', 'conversations.invite', { channel: 'CRUN', users: 'UQA,UQB' }, spec);
  await probe.call('archive', 'conversations.archive', { channel: 'CRUN' }, spec);
  assert.deepEqual(bodies.slice(1).map(({ method, type, body }) => [method, type, body]), [
    ['conversations.invite', 'application/x-www-form-urlencoded', 'channel=CRUN&users=UQA%2CUQB'],
    ['conversations.archive', 'application/x-www-form-urlencoded', 'channel=CRUN'],
  ]);
});
