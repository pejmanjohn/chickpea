import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AgentBotInviteProbeMethod,
  type AgentBotInviteProbeReceipt,
  type AgentBotInviteProbeSpec,
  inviteSequence,
  SlackAgentBotInviteProbe,
} from '../qa/live/probes/slack-agent-bot-invites.ts';

const spec: AgentBotInviteProbeSpec = { workspaceId: 'TQA', channelIds: ['CQA', 'GQA'], botUserIds: ['UAPPBOT'] };
const auth = { ok: true, team_id: 'TQA', bot_id: 'BQA' };
const response = (data: unknown) => new Response(JSON.stringify(data));

test('invite probe verifies the bot workspace and refuses overrides, undeclared Channels and people before dispatch', async () => {
  const calls: string[] = [];
  const probe = new SlackAgentBotInviteProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: async (url) => { calls.push(String(url)); return response(auth); } });
  await assert.rejects(probe.call('unverified', 'conversations.invite', { channel: 'CQA', users: 'UAPPBOT' }, spec), /Verify bot workspace/);
  await probe.call('auth', 'auth.test', {}, spec);
  for (const [method, input] of [
    ['conversations.invite', { channel: 'COTHER', users: 'UAPPBOT' }],
    ['conversations.invite', { channel: 'CQA', users: 'UPERSON' }],
    ['conversations.invite', { channel: 'CQA', users: 'UAPPBOT,UPERSON' }],
    ['conversations.invite', { channel: 'CQA', users: 'UAPPBOT', force: true }],
    ['conversations.invite', { channel: 'CQA' }],
    ['conversations.kick', { channel: 'CQA', user: 'UPERSON' }],
    ['conversations.members', { channel: 'CQA', limit: 1_000 }],
    ['conversations.info', { channel: 'CQA', token: 'override' }],
    ['conversations.archive', { channel: 'CQA' }],
  ] as const) {
    await assert.rejects(probe.call('invalid', method as AgentBotInviteProbeMethod, input, spec),
      (error: Error) => !/attempt ID/.test(error.message), `${method} ${JSON.stringify(input)}`);
  }
  await assert.rejects(probe.call('other-workspace', 'conversations.info', { channel: 'CQA' }, { ...spec, workspaceId: 'TOTHER' }));
  assert.equal(calls.length, 1, 'only auth.test went out');
});

test('invite probe records dispatch before an invite, never retries an unknown outcome, and keeps the token out of receipts', async () => {
  const receipts: AgentBotInviteProbeReceipt[] = [];
  let calls = 0;
  const probe = new SlackAgentBotInviteProbe({ token: 'xoxb-test-only', record: async (r) => { receipts.push(r); }, fetch: async () => {
    calls++;
    assert.equal(receipts.at(-1)?.phase, 'dispatching');
    if (calls === 1) return response(auth);
    throw new Error('Possible accepted invite; error includes xoxb-test-only');
  } });
  await probe.call('auth', 'auth.test', {}, spec);
  const unknown = await probe.call('invite', 'conversations.invite', { channel: 'CQA', users: 'UAPPBOT' }, spec);
  assert.equal(unknown.phase, 'unknown');
  assert.equal(JSON.stringify(receipts).includes('xoxb-test-only'), false);
  await assert.rejects(probe.call('invite', 'conversations.invite', { channel: 'CQA', users: 'UAPPBOT' }, spec), /new, reconciled/);
  assert.equal(calls, 2);
});

function slackFor(answers: { invite: unknown }): { fetch: typeof fetch; methods: string[] } {
  const methods: string[] = [];
  let invited = false;
  return {
    methods,
    fetch: async (url) => {
      const method = String(url).split('/').at(-1)!;
      methods.push(method);
      if (method === 'auth.test') return response(auth);
      if (method === 'conversations.info') return response({ ok: true, channel: { id: 'CQA', is_member: true } });
      if (method === 'conversations.members') return response({ ok: true, members: invited ? ['UBOT', 'UAPPBOT'] : ['UBOT'] });
      if (method === 'conversations.invite') {
        if (invited) return response({ ok: false, error: 'already_in_channel' });
        invited = (answers.invite as { ok?: unknown }).ok === true;
        return response(answers.invite);
      }
      return response({ ok: true });
    },
  };
}

test("the invite sequence removes only a bot its own invite added", async () => {
  const accepted = slackFor({ invite: { ok: true, channel: { id: 'CQA' } } });
  const run = { id: 'run1', channelId: 'CQA', botUserId: 'UAPPBOT' };
  const receipts = await inviteSequence(new SlackAgentBotInviteProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: accepted.fetch }), spec, run);
  assert.deepEqual(accepted.methods, [
    'auth.test', 'conversations.info', 'conversations.members', 'conversations.invite',
    'conversations.members', 'conversations.invite', 'conversations.kick',
  ]);
  assert.equal(receipts.find((receipt) => receipt.attemptId === 'run1-invite-again')?.response?.error, 'already_in_channel');

  const refused = slackFor({ invite: { ok: false, error: 'app_cannot_join_channel' } });
  await inviteSequence(new SlackAgentBotInviteProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: refused.fetch }), spec, run);
  assert.equal(refused.methods.includes('conversations.kick'), false, 'a refused invite added nothing to remove');
});
