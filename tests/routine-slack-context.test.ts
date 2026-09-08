import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebClient } from '@slack/web-api';

import { shouldHandleRoutineCommandTurn } from '../src/routines/commands.ts';
import {
  canManageRoutineChannel,
  isRoutineSlackTurn,
  parseSlackChannelMention,
  resolveRoutineSourceVisibility,
} from '../src/routines/slack-context.ts';

test('channel mentions parse exactly', () => {
  assert.equal(parseSlackChannelMention('<#C_TEST|support>'), 'C_TEST');
  assert.equal(parseSlackChannelMention('<#C_TEST>'), 'C_TEST');
  assert.equal(parseSlackChannelMention('C_TEST'), undefined);
});

test('routine handling admits Channels and one-to-one DMs but never group DMs', () => {
  const base = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', userId: 'U_MEMBER', eventId: 'Ev_TEST',
    text: '!routines confirm token', messageTs: '1.1', threadTs: '1.0',
    contextMode: 'thread' as const,
  };
  assert.equal(isRoutineSlackTurn({ ...base, source: 'app_mention' }), true);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'implicit_thread_reply' }), true);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'agent_mention' }), true);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'implicit_thread_reply', channelType: 'im' }), true);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'dm_message', channelType: 'im' }), true);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'agent_mention', channelType: 'im' }), true);
  assert.equal(isRoutineSlackTurn({ ...base, source: 'dm_message', channelType: 'mpim' }), false);
});

test('only exact Routine commands bypass the interactive Agent authoring loop', () => {
  const base = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', userId: 'U_MEMBER', eventId: 'Ev_TEST',
    messageTs: '1.1', threadTs: '1.0', source: 'app_mention' as const,
    contextMode: 'thread' as const,
  };
  assert.equal(shouldHandleRoutineCommandTurn({
    ...base,
    text: 'Every weekday at 9 AM, summarize support and post it here.',
  }), false);
  assert.equal(shouldHandleRoutineCommandTurn({
    ...base,
    text: 'Remember that Acme renews September 30. Every Monday, check renewal risk.',
  }), false);
  assert.equal(shouldHandleRoutineCommandTurn({
    ...base,
    text: '!routines pause routine_one',
  }), true);
  assert.equal(shouldHandleRoutineCommandTurn({
    ...base,
    source: 'agent_mention',
    text: '<!subteam^S012345|@sprout>: !routines help',
  }, { agentUserGroupId: 'S012345' }), true);
  assert.equal(shouldHandleRoutineCommandTurn({
    ...base,
    source: 'agent_mention',
    text: '<!subteam^S999999|@oncall>: !routines help',
  }, { agentUserGroupId: 'S012345' }), false);
  assert.equal(shouldHandleRoutineCommandTurn({
    ...base,
    source: 'dm_message', channelType: 'im',
    text: '!routines pause routine_one',
  }), true);
});

test('mentioned-channel controls require current bot and actor membership', async () => {
  const priorToken = process.env.SLACK_BOT_TOKEN;
  const priorApi = process.env.SLACK_API_URL;
  const priorFetch = globalThis.fetch;
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_API_URL = 'https://slack.invalid/api/';
  let members = ['U_MEMBER', 'UBOT'];
  globalThis.fetch = async (request) => {
    const path = new URL(String(request)).pathname;
    const body = path.endsWith('/auth.test')
      ? { ok: true, team_id: 'T_TEST', user_id: 'UBOT' }
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
      await canManageRoutineChannel('T_TEST', 'C_OTHER', 'U_MEMBER', undefined, 'xoxb-test'),
      true,
    );
    members = ['UBOT'];
    assert.equal(
      await canManageRoutineChannel('T_TEST', 'C_OTHER', 'U_MEMBER', undefined, 'xoxb-test'),
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

test('routine channel authorization uses an explicitly admitted identity token', async () => {
  const priorToken = process.env.SLACK_BOT_TOKEN;
  const priorApi = process.env.SLACK_API_URL;
  const priorFetch = globalThis.fetch;
  process.env.SLACK_BOT_TOKEN = 'xoxb-workspace-default';
  process.env.SLACK_API_URL = 'https://slack.invalid/api/';
  const authorizations: string[] = [];
  globalThis.fetch = async (request, init) => {
    authorizations.push(String(new Headers(init?.headers).get('authorization')));
    const path = new URL(String(request)).pathname;
    const body = path.endsWith('/auth.test')
      ? { ok: true, team_id: 'T_TEST', user_id: 'UBOT' }
      : path.endsWith('/conversations.info')
        ? {
            ok: true,
            channel: {
              id: 'C_TEST', name: 'test', team_id: 'T_TEST', is_member: true,
              is_private: false, is_archived: false, is_frozen: false,
            },
          }
        : { ok: true, members: ['U_MEMBER', 'UBOT'], response_metadata: { next_cursor: '' } };
    return new Response(JSON.stringify(body));
  };
  try {
    assert.equal(
      await canManageRoutineChannel(
        'T_TEST',
        'C_TEST',
        'U_MEMBER',
        undefined,
        'xoxb-finance',
      ),
      true,
    );
    assert.ok(authorizations.every((value) => value === 'Bearer xoxb-finance'));
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = priorToken;
    if (priorApi === undefined) delete process.env.SLACK_API_URL;
    else process.env.SLACK_API_URL = priorApi;
  }
});

test('shared-gateway routine authorization uses its credential-free Slack client', async () => {
  const client = {
    auth: { test: async () => ({ ok: true, team_id: 'T_TEST', user_id: 'UBOT' }) },
    conversations: {
      info: async () => ({
        ok: true,
        channel: {
          id: 'C_TEST', name: 'test', team_id: 'T_TEST', is_member: true,
          is_private: true, is_archived: false, is_frozen: false,
          is_shared: false, is_ext_shared: false, is_org_shared: false,
          is_pending_ext_shared: false, is_im: false, is_mpim: false,
        },
      }),
      members: async () => ({
        ok: true,
        members: ['U_MEMBER', 'UBOT'],
        response_metadata: { next_cursor: '' },
      }),
    },
  } as unknown as WebClient;
  assert.equal(
    await canManageRoutineChannel('T_TEST', 'C_TEST', 'U_MEMBER', undefined, undefined, client),
    true,
  );
  assert.equal(
    await resolveRoutineSourceVisibility('T_TEST', 'C_TEST', undefined, undefined, client),
    'private',
  );
});
