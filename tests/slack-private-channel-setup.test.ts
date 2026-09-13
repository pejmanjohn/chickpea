import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRIVATE_CHANNEL_SETUP_ADD_ACTION,
  PRIVATE_CHANNEL_SETUP_AGENT_ACTION,
  PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK,
  parsePrivateChannelSetupAction,
  privateChannelSetupCard,
} from '../src/slack/private-channel-setup.ts';

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
