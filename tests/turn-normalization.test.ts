import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeHistoryWindow } from '../src/slack/thread-context.ts';
import { slackThreadKey } from '../src/slack/thread-key.ts';
import { normalizeSlackTurn } from '../src/slack/turn-normalization.ts';
import {
  appHomeMessage,
  appMention as fixture,
  channelThreadMessage,
  dmMessage,
  privateChannelThreadMessage,
  topLevelChannelMessage,
} from './helpers/slack-fixtures.ts';

test('Slack turn normalization classifies mentions, thread replies, DMs, and ignored top-level messages', () => {
  const mention = normalizeSlackTurn(fixture());
  assert.ok(mention.status === 'runnable');
  assert.equal(mention.turn.source, 'app_mention');
  assert.equal(mention.turn.contextMode, 'channel_history');
  assert.equal(slackThreadKey(mention.turn), 'T_DEMO:C_EXEC:1782770400.000100');

  const options = { botUserId: 'U_BOT' };
  const threadReply = normalizeSlackTurn(channelThreadMessage(), options);
  assert.ok(threadReply.status === 'runnable');
  assert.equal(threadReply.turn.source, 'implicit_thread_reply');
  assert.equal(threadReply.turn.contextMode, 'thread');
  assert.equal(slackThreadKey(threadReply.turn), 'T_DEMO:C_EXEC:1782770400.000100');

  const privateChannelThreadReply = normalizeSlackTurn(privateChannelThreadMessage(), options);
  assert.ok(privateChannelThreadReply.status === 'runnable');
  assert.equal(privateChannelThreadReply.turn.source, 'implicit_thread_reply');
  assert.equal(privateChannelThreadReply.turn.channelType, 'group');
  assert.equal(privateChannelThreadReply.turn.contextMode, 'thread');
  assert.equal(
    slackThreadKey(privateChannelThreadReply.turn),
    'T_DEMO:G_PRIVATE:1782770400.000100',
  );

  const privateChannelTopLevel = privateChannelThreadMessage({
    event_id: 'Ev_MSG_PRIVATE_TOP_LEVEL',
  });
  delete privateChannelTopLevel.event.thread_ts;
  const ignoredPrivateChannelTopLevel = normalizeSlackTurn(privateChannelTopLevel, options);
  assert.ok(ignoredPrivateChannelTopLevel.status === 'ignored');
  assert.equal(ignoredPrivateChannelTopLevel.reason, 'top_level_channel_message');

  const dm = normalizeSlackTurn(dmMessage(), options);
  assert.ok(dm.status === 'runnable');
  assert.equal(dm.turn.source, 'dm_message');
  assert.equal(dm.turn.contextMode, 'dm_history');
  assert.equal(slackThreadKey(dm.turn), 'T_DEMO:D_DEMO_DM:dm');

  const appHome = normalizeSlackTurn(appHomeMessage(), options);
  assert.ok(appHome.status === 'runnable');
  assert.equal(appHome.turn.source, 'dm_message');
  assert.equal(appHome.turn.channelType, 'app_home');
  assert.equal(appHome.turn.contextMode, 'dm_history');
  assert.equal(slackThreadKey(appHome.turn), 'T_DEMO:D_DEMO_APP_HOME:dm');

  const topLevel = normalizeSlackTurn(topLevelChannelMessage(), options);
  assert.ok(topLevel.status === 'ignored');
  assert.equal(topLevel.reason, 'top_level_channel_message');

  const missingBotUserId = normalizeSlackTurn(channelThreadMessage());
  assert.ok(missingBotUserId.status === 'ignored');
  assert.equal(missingBotUserId.reason, 'missing_bot_user_id');

  const missingChannelType = channelThreadMessage({ event_id: 'Ev_MSG_NO_CHANNEL_TYPE' });
  delete missingChannelType.event.channel_type;
  const unsupportedChannelType = normalizeSlackTurn(missingChannelType, options);
  assert.ok(unsupportedChannelType.status === 'ignored');
  assert.equal(unsupportedChannelType.reason, 'unsupported_channel_type');

  const groupDm = channelThreadMessage({
    event_id: 'Ev_MSG_GROUP_DM',
    event: { channel: 'G_GROUP_DM', channel_type: 'mpim' },
  });
  const unsupportedGroupDm = normalizeSlackTurn(groupDm, options);
  assert.ok(unsupportedGroupDm.status === 'ignored');
  assert.equal(unsupportedGroupDm.reason, 'unsupported_channel_type');
});

test('natural-language channel history windows do not match adjacent words', () => {
  assert.equal(
    computeHistoryWindow(
      'channel_history',
      'what happened last weekend?',
      '1782770400.000100',
    ).reason,
    'default_24h',
  );
  assert.equal(
    computeHistoryWindow(
      'channel_history',
      'plans for this weekend',
      '1782770400.000100',
    ).reason,
    'default_24h',
  );
  assert.equal(
    computeHistoryWindow('channel_history', 'todays numbers', '1782770400.000100').reason,
    'default_24h',
  );
  assert.equal(
    computeHistoryWindow(
      'channel_history',
      'what happened last week?',
      '1782770400.000100',
    ).reason,
    'last_week',
  );
});
