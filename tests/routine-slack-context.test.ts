import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canManageRoutineChannel,
  isRoutineSlackTurn,
  parseSlackChannelMention,
} from '../src/routines/slack-context.ts';

test('channel mentions parse exactly', () => {
  assert.equal(parseSlackChannelMention('<#C_TEST|support>'), 'C_TEST');
  assert.equal(parseSlackChannelMention('<#C_TEST>'), 'C_TEST');
  assert.equal(parseSlackChannelMention('C_TEST'), undefined);
});

test('routine handling admits channel mentions and their implicit thread replies only', () => {
  const base = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', userId: 'U_MEMBER', eventId: 'Ev_TEST',
    text: '!routines confirm token', messageTs: '1.1', threadTs: '1.0',
    contextMode: 'thread' as const,
  };
  assert.equal(isRoutineSlackTurn({ ...base, source: 'app_mention' }), true);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'implicit_thread_reply' }), true);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'implicit_thread_reply', channelType: 'im' }), false);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'dm_message', channelType: 'im' }), false);
});

test('mentioned-channel controls require current bot and actor membership', async () => {
  const priorToken = process.env.SLACK_BOT_TOKEN;
  const priorApi = process.env.SLACK_API_URL;
  const priorFetch = globalThis.fetch;
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_API_URL = 'https://slack.invalid/api/';
  let members = ['U_MEMBER', 'U_BOT'];
  globalThis.fetch = async (request) => {
    const path = new URL(String(request)).pathname;
    const body = path.endsWith('/auth.test')
      ? { ok: true, team_id: 'T_TEST', user_id: 'U_BOT' }
      : path.endsWith('/conversations.info')
        ? {
            ok: true,
            channel: {
              id: 'C_OTHER', name: 'other', team_id: 'T_TEST', is_member: true,
              is_private: true, is_archived: false, is_frozen: false,
            },
          }
        : {
            ok: true,
            members,
            response_metadata: { next_cursor: '' },
          };
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    assert.equal(
      await canManageRoutineChannel('T_TEST', 'C_OTHER', 'U_MEMBER', undefined),
      true,
    );
    members = ['U_BOT'];
    assert.equal(
      await canManageRoutineChannel('T_TEST', 'C_OTHER', 'U_MEMBER', undefined),
      false,
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = priorToken;
    if (priorApi === undefined) delete process.env.SLACK_API_URL;
    else process.env.SLACK_API_URL = priorApi;
  }
});
