import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRIVATE_CHANNEL_SETUP_ADD_ACTION,
  PRIVATE_CHANNEL_SETUP_AGAIN_ACTION,
  PRIVATE_CHANNEL_SETUP_AGENT_ACTION,
  PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK,
  parsePrivateChannelSetupAction,
  parsePrivateChannelSetupAgainAction,
  privateChannelSetupCard,
  privateChannelSetupReply,
  type PrivateChannelSetupOutcome,
  type SetupCardReply,
} from '../src/slack/private-channel-setup.ts';
import { PrivateChannelSetupError } from '../src/slack/private-channel-setup-service.ts';

function actionPayload(agentId: string | null = 'agent_ops'): Record<string, any> {
  return {
    type: 'block_actions',
    api_app_id: 'A_TEST',
    team: { id: 'T_TEST' },
    user: { id: 'U_INVITER' },
    channel: { id: 'C_PRIVATE' },
    container: { type: 'message', channel_id: 'C_PRIVATE', is_ephemeral: true },
    actions: [{ action_id: PRIVATE_CHANNEL_SETUP_ADD_ACTION, value: 'setup_123', action_ts: '1789270000.000001' }],
    state: { values: { [PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK]: {
      [PRIVATE_CHANNEL_SETUP_AGENT_ACTION]: {
        type: 'static_select', selected_option: agentId === null ? null : { value: agentId },
      },
    } } },
  };
}

test('private setup Add uses exactly the selected state and private message coordinates', () => {
  const parsed = parsePrivateChannelSetupAction(actionPayload());
  assert.equal(parsed?.agentId, 'agent_ops');
  assert.equal(parsed?.setupId, 'setup_123');
  assert.equal(parsed?.channelId, 'C_PRIVATE');
  assert.equal(parsed?.userId, 'U_INVITER');
  assert.equal(parsed?.workspaceId, 'T_TEST');
  assert.ok(parsed?.deliveryId);
  assert.deepEqual(parsePrivateChannelSetupAction(actionPayload()), parsed);
  assert.equal(parsePrivateChannelSetupAction(actionPayload('x'.repeat(128)))?.agentId, 'x'.repeat(128));
  assert.equal(parsePrivateChannelSetupAction(actionPayload(null))?.agentId, null);
});

const RESPONSE_URL = 'https://hooks.slack.com/actions/T_TEST/1789270000123/AbC_def-123';

test('Add keeps a response_url only when it is Slack\'s own action endpoint; any other is dropped, not refused', () => {
  const kept = { ...actionPayload(), response_url: RESPONSE_URL };
  assert.equal(parsePrivateChannelSetupAction(kept)?.responseUrl, RESPONSE_URL);
  const gov = 'https://hooks.slack-gov.com/actions/T_TEST/1789270000123/AbC';
  assert.equal(parsePrivateChannelSetupAction({ ...actionPayload(), response_url: gov })?.responseUrl, gov);
  for (const responseUrl of [
    'https://hooks.example.com/actions/T_TEST/1789270000123/AbC',
    'https://hooks.slack.com.example.com/actions/T_TEST/1789270000123/AbC',
    'http://hooks.slack.com/actions/T_TEST/1789270000123/AbC',
    `${RESPONSE_URL}?next=https://example.com`,
    `${RESPONSE_URL}#fragment`,
    'https://user:secret@hooks.slack.com/actions/T_TEST/1789270000123/AbC',
    'https://hooks.slack.com/services/T_TEST/1789270000123/AbC',
    'https://hooks.slack.com/actions/T_TEST/1789270000123',
    `${RESPONSE_URL}/extra`,
    42,
  ]) {
    const parsed = parsePrivateChannelSetupAction({ ...actionPayload(), response_url: responseUrl });
    assert.equal(parsed?.agentId, 'agent_ops', String(responseUrl));
    assert.equal(parsed && 'responseUrl' in parsed, false, String(responseUrl));
  }
});

function againPayload(): Record<string, any> {
  return {
    type: 'block_actions',
    team: { id: 'T_TEST' },
    user: { id: 'U_INVITER' },
    channel: { id: 'C_PRIVATE' },
    container: { type: 'message', channel_id: 'C_PRIVATE', is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: PRIVATE_CHANNEL_SETUP_AGAIN_ACTION, value: 'setup_123', action_ts: '1789270000.000002' }],
  };
}

test('Add another Agent parses only from the inviter\'s own ephemeral card, with Slack\'s response_url', () => {
  assert.deepEqual(parsePrivateChannelSetupAgainAction(againPayload()), {
    workspaceId: 'T_TEST',
    userId: 'U_INVITER',
    channelId: 'C_PRIVATE',
    setupId: 'setup_123',
    deliveryId: 'setup:T_TEST:U_INVITER:C_PRIVATE:setup_123:1789270000.000002',
    responseUrl: RESPONSE_URL,
  });
  assert.equal(parsePrivateChannelSetupAction(againPayload()), undefined);
  assert.equal(parsePrivateChannelSetupAgainAction(actionPayload()), undefined);
  const refused: Array<[string, (payload: Record<string, any>) => void]> = [
    ['no response_url', (payload) => { delete payload.response_url; }],
    ['another host', (payload) => { payload.response_url = 'https://hooks.example.com/actions/T_TEST/1/AbC'; }],
    ['http', (payload) => { payload.response_url = RESPONSE_URL.replace('https:', 'http:'); }],
    ['a query', (payload) => { payload.response_url = `${RESPONSE_URL}?x=1`; }],
    ['credentials', (payload) => { payload.response_url = RESPONSE_URL.replace('https://', 'https://u:p@'); }],
    ['a public message', (payload) => { payload.container.is_ephemeral = false; }],
    ['another channel', (payload) => { payload.container.channel_id = 'C_OTHER'; }],
    ['two actions', (payload) => { payload.actions.push({ ...payload.actions[0] }); }],
    ['an unsafe setup', (payload) => { payload.actions[0].value = '-setup'; }],
    ['a malformed action_ts', (payload) => { payload.actions[0].action_ts = 'now'; }],
    ['another event type', (payload) => { payload.type = 'view_submission'; }],
  ];
  for (const [name, change] of refused) {
    const payload = againPayload();
    change(payload);
    assert.equal(parsePrivateChannelSetupAgainAction(payload), undefined, name);
  }
});

test('each setup outcome maps to one reply: finished cards are replaced, usable ones answered beside', () => {
  const adminUrl = 'https://chickpea.example/admin/agents';
  const direct = { adminUrl, againSetupId: 'setup_123' };
  const summary = (reply: SetupCardReply) => reply.kind === 'replace'
    ? { kind: reply.kind, fallback: reply.fallback, text: reply.message.text,
        buttons: reply.message.blocks.flatMap((block) => block.elements as Array<Record<string, any>> ?? [])
          .filter((element) => element.type === 'button').map((button) => button.text.text) }
    : reply;
  const removed = 'This Agent is no longer available in this channel. Open Chickpea to add an Agent to this channel. ' +
    `<${adminUrl}|Open Chickpea>`;
  const recovery = 'This setup could not finish. Open Chickpea, choose the Agent, and retry adding this channel. ' +
    `<${adminUrl}|Open Chickpea>`;
  const cases: Array<[PrivateChannelSetupOutcome, ReturnType<typeof summary>]> = [
    [{ kind: 'completed', agentId: 'agent_ops', handle: 'ops', replayed: true }, { kind: 'replace', fallback: 'text',
      text: 'Added @ops to this private channel. Mention @ops to start a conversation.',
      buttons: ['Add another Agent', 'Open Chickpea'] }],
    [{ kind: 'in_progress' }, { kind: 'notice', text: 'This Agent is being added. Click Add again in a moment to check.' }],
    [{ kind: 'choose' }, { kind: 'notice', text: 'Choose an Agent in the setup card, then click Add.' }],
    [{ kind: 'no_longer_added' }, { kind: 'replace', fallback: 'text', text: removed, buttons: ['Choose an Agent'] }],
    [{ kind: 'recovery_required', message: 'ignored' }, { kind: 'replace', fallback: 'text', text: recovery, buttons: [] }],
    [{ kind: 'missing' }, { kind: 'replace', fallback: 'text',
      text: `This setup card has expired. Open Chickpea to add an Agent to this channel. <${adminUrl}|Open Chickpea>`, buttons: [] }],
    [{ kind: 'failed', error: new PrivateChannelSetupError('stale') }, { kind: 'replace', fallback: 'text',
      text: `This setup card is no longer current. Open Chickpea to add an Agent to this channel. <${adminUrl}|Open Chickpea>`,
      buttons: ['Choose an Agent'] }],
    [{ kind: 'failed', error: new PrivateChannelSetupError('unavailable') }, { kind: 'replace', fallback: 'text',
      text: `This setup card has already been used. Open Chickpea to add an Agent to this channel. <${adminUrl}|Open Chickpea>`,
      buttons: ['Choose an Agent'] }],
    [{ kind: 'failed', error: new PrivateChannelSetupError('unverifiable') },
      { kind: 'notice', text: 'I couldn’t check this Agent right now. Click Add again in a moment.' }],
    [{ kind: 'failed', error: new PrivateChannelSetupError('agent_off', 'Ops is off.') }, { kind: 'notice', text: 'Ops is off.' }],
    [{ kind: 'failed', error: new PrivateChannelSetupError('forbidden') }, { kind: 'silent' }],
    [{ kind: 'failed', error: new Error('slack down') }, { kind: 'notice', text: recovery }],
    [{ kind: 'begun', setupId: 'setup_456', agents: [], choicesTruncated: false }, { kind: 'replace', fallback: 'card',
      text: 'Open Chickpea to create or manage Agents for this private channel.', buttons: ['Open Chickpea'] }],
  ];
  for (const [outcome, expected] of cases) {
    assert.deepEqual(summary(privateChannelSetupReply(outcome, direct)), expected, outcome.kind);
  }
  const gateway = privateChannelSetupReply({ kind: 'completed', agentId: 'agent_ops', handle: 'ops', replayed: false }, {});
  assert.deepEqual(summary(gateway), { kind: 'replace', fallback: 'text',
    text: 'Added @ops to this private channel. Mention @ops to start a conversation.', buttons: [] },
  'a card that cannot be replaced gets no button to click');
});

test('select-only, conflicting channel, public container and ambiguous Add cannot attach', () => {
  const selected = actionPayload();
  selected.actions[0].action_id = PRIVATE_CHANNEL_SETUP_AGENT_ACTION;
  assert.equal(parsePrivateChannelSetupAction(selected), undefined);
  const publicCard = actionPayload();
  publicCard.container.is_ephemeral = false;
  assert.equal(parsePrivateChannelSetupAction(publicCard), undefined);
  const wrongChannel = actionPayload();
  wrongChannel.container.channel_id = 'C_OTHER';
  assert.equal(parsePrivateChannelSetupAction(wrongChannel), undefined);
  const duplicate = actionPayload();
  duplicate.actions.push({ ...duplicate.actions[0] });
  assert.equal(parsePrivateChannelSetupAction(duplicate), undefined);
  const noState = actionPayload();
  delete noState.state;
  assert.equal(parsePrivateChannelSetupAction(noState), undefined);
  const missingChoice = actionPayload();
  delete missingChoice.state.values[PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK];
  assert.equal(parsePrivateChannelSetupAction(missingChoice), undefined);
  const invalid = actionPayload('agent with spaces');
  assert.equal(parsePrivateChannelSetupAction(invalid), undefined);
  assert.equal(parsePrivateChannelSetupAction(actionPayload('_agent')), undefined);
  const invalidSetup = actionPayload();
  invalidSetup.actions[0].value = '-setup';
  assert.equal(parsePrivateChannelSetupAction(invalidSetup), undefined);
});

test('setup card leaves choice unselected, limits Slack fields and provides Admin fallback', () => {
  const card = privateChannelSetupCard({
    setupId: 'setup_123',
    agents: Array.from({ length: 101 }, (_, i) => ({ id: `agent_${i}`, name: '🌱'.repeat(100), handle: `agent_${i}` })),
    adminUrl: 'https://example.com/admin',
  });
  const block = card.blocks.find((item) => item.block_id === PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK)!;
  const select = (block.elements as Array<Record<string, any>>)[0]!;
  assert.equal(select.type, 'static_select');
  assert.equal(select.options.length, 100);
  assert.equal(select.initial_option, undefined);
  assert.ok(select.options.every((option: any) => [...option.text.text].length <= 75));
  assert.match(card.text, /Choose an Agent/);
  assert.match(JSON.stringify(card.blocks), /Chickpea/);
  assert.match(JSON.stringify(card.blocks), /https:\/\/example.com\/admin/);
  const add = card.blocks.flatMap((item) => item.elements as Array<Record<string, any>> ?? [])
    .find((item) => item.action_id === PRIVATE_CHANNEL_SETUP_ADD_ACTION)!;
  assert.equal(add.value, 'setup_123');
  assert.equal(add.text.text, 'Add');
});

test('invalid fallback URL is omitted and empty card has no Add action', () => {
  const card = privateChannelSetupCard({ setupId: 'setup_123', agents: [], adminUrl: 'javascript:alert(1)' });
  assert.doesNotMatch(JSON.stringify(card), /javascript:|action_id/);
  assert.match(card.text, /Chickpea/);
});
