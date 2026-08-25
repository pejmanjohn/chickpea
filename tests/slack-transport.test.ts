import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WorkspaceInstallation } from '../src/config/types.ts';
import {
  createDirectSlackTransportFromClient,
  type DirectSlackApiClient,
} from '../src/slack/transport/direct.ts';
import {
  SlackTransportError,
  selectSlackTransport,
  type SlackTransport,
} from '../src/slack/transport/types.ts';
import { createGatewaySlackTransport } from '../src/slack/transport/gateway.ts';
import { slackClientMessageId } from '../src/slack/transport/message-id.ts';

interface RecordedCall {
  method: string;
  input: Record<string, unknown> | undefined;
}

test('direct transport maps Slack operations without exposing credentials or a raw client', async () => {
  const calls: RecordedCall[] = [];
  const client = fakeClient(calls);
  const transport = createDirectSlackTransportFromClient(client);

  assert.deepEqual(await transport.lookupMember('U123'), {
    id: 'U123',
    teamId: 'T123',
    name: 'ada',
    handle: 'ada',
    displayName: 'Ada Lovelace',
    realName: 'Augusta Ada King',
    email: 'ada@example.com',
    avatarUrl: 'https://avatars.slack-edge.com/ada.png',
    deleted: false,
    bot: false,
    appUser: false,
    restricted: false,
    ultraRestricted: false,
    stranger: false,
  });
  assert.deepEqual(await transport.lookupChannel('C123'), {
    id: 'C123',
    name: 'support',
    private: false,
    member: true,
    archived: false,
  });
  assert.deepEqual(await transport.listChannels(), {
    channels: [{
      id: 'C123', name: 'support', private: false, member: true, archived: false,
    }],
    truncated: false,
  });
  assert.deepEqual([...(await transport.listMemberChannels('U123'))], ['C123']);
  assert.equal(await transport.channelHasMember('C123', 'U123'), true);
  assert.equal((await transport.openDirectConversation('U123')).id, 'D123');
  assert.deepEqual(await transport.joinPublicChannel('C123'), {
    id: 'C123',
    name: 'support',
    private: false,
    member: true,
    archived: false,
  });

  assert.equal((await transport.lookupUserGroup('S123'))?.handle, 'support');
  assert.equal(await transport.lookupUserGroup('S404'), undefined);
  assert.deepEqual(await transport.listUserGroups({ includeDisabled: true }), [
    {
      id: 'S123',
      name: 'Support Triage',
      handle: 'support',
      description: 'Support Agent',
      disabled: false,
      updatedAt: 42,
    },
  ]);
  assert.equal((await transport.createUserGroup({
    name: 'Support Triage', handle: 'support', description: 'Support Agent',
  })).id, 'S123');
  assert.equal((await transport.updateUserGroup('S123', { handle: 'help' })).handle, 'help');
  assert.equal((await transport.disableUserGroup('S123')).disabled, true);
  assert.equal((await transport.enableUserGroup('S123')).disabled, false);

  const view = { type: 'home', blocks: [] } as Parameters<SlackTransport['publishAppHome']>[0]['view'];
  assert.deepEqual(await transport.publishAppHome({ userId: 'U123', view }), {
    viewId: 'V123', hash: 'hash-1',
  });
  assert.deepEqual(await transport.postMessage({
    channelId: 'C123',
    threadTs: '1700.1',
    text: 'Handled',
    persona: { name: 'Support Triage', avatarUrl: 'https://cdn.example/avatar.png' },
    idempotencyKey: 'interaction:selection-one',
  }), { channelId: 'C123', ts: '1700.2' });

  assert.deepEqual(calls.map((entry) => entry.method), [
    'users.info',
    'conversations.info',
    'conversations.list',
    'users.conversations',
    'conversations.members',
    'conversations.open',
    'conversations.join',
    'usergroups.list',
    'usergroups.list',
    'usergroups.list',
    'usergroups.create',
    'usergroups.update',
    'usergroups.disable',
    'usergroups.enable',
    'views.publish',
    'chat.postMessage',
  ]);
  assert.deepEqual(calls.at(-1)?.input, {
    channel: 'C123',
    thread_ts: '1700.1',
    text: 'Handled',
    username: 'Support Triage',
    icon_url: 'https://cdn.example/avatar.png',
    client_msg_id: slackClientMessageId('interaction:selection-one'),
  });
  assert.equal(transport.mode, 'direct');
  assert.deepEqual(Object.keys(transport).sort(), [
    'channelHasMember',
    'createUserGroup',
    'disableUserGroup',
    'enableUserGroup',
    'joinPublicChannel',
    'listChannels',
    'listMemberChannels',
    'listUserGroups',
    'lookupChannel',
    'lookupMember',
    'lookupUserGroup',
    'mode',
    'openDirectConversation',
    'postMessage',
    'publishAppHome',
    'updateUserGroup',
  ]);
  assert.doesNotMatch(JSON.stringify(transport), /xoxb|token|client/i);
});

test('gateway transport resolves a user group only by authenticated Slack id', async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const transport = createGatewaySlackTransport({
    workspaceId: 'T123',
    async call(operation, input) {
      calls.push({ operation, input });
      return {
        usergroups: [
          { id: 'SOTHER', name: 'Other', handle: 'forged-label', date_update: 40 },
          { id: 'STARGET', name: 'Target', handle: 'trusted-handle', date_update: 42 },
        ],
      };
    },
  });
  assert.equal((await transport.lookupUserGroup('STARGET'))?.handle, 'trusted-handle');
  assert.equal(await transport.lookupUserGroup('SMISSING'), undefined);
  assert.deepEqual(calls, [
    { operation: 'usergroups.list', input: { include_disabled: true } },
    { operation: 'usergroups.list', input: { include_disabled: true } },
  ]);
});

test('gateway transport forwards a stable Slack message identity for retries', async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const transport = createGatewaySlackTransport({
    workspaceId: 'T123',
    async call(operation, input) {
      calls.push({ operation, input });
      return { channel: 'D123', ts: '1700.2' };
    },
  });

  await transport.postMessage({
    channelId: 'D123',
    text: 'Agent is ready.',
    idempotencyKey: 'interaction:selection-one',
  });
  assert.deepEqual(calls, [{
    operation: 'chat.postMessage',
    input: {
      channel: 'D123',
      text: 'Agent is ready.',
      client_msg_id: slackClientMessageId('interaction:selection-one'),
    },
  }]);
  assert.match(slackClientMessageId('interaction:selection-one'), /^[0-9a-f-]{36}$/);
});

test('gateway transport follows Slack cursors for Channels and membership', async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const transport = createGatewaySlackTransport({
    workspaceId: 'T123',
    async call(operation, input) {
      calls.push({ operation, input });
      if (operation === 'conversations.list') {
        return input.cursor === 'channels-next'
          ? {
              channels: [{ id: 'C2', name: 'zeta', is_member: true }],
              response_metadata: { next_cursor: '' },
            }
          : {
              channels: [{ id: 'C1', name: 'alpha', is_member: true }],
              response_metadata: { next_cursor: 'channels-next' },
            };
      }
      if (operation === 'conversations.members') {
        return input.cursor === 'members-next'
          ? { members: ['U_TARGET'], response_metadata: { next_cursor: '' } }
          : { members: ['U_OTHER'], response_metadata: { next_cursor: 'members-next' } };
      }
      if (operation === 'users.conversations') {
        return input.cursor === 'user-channels-next'
          ? {
              channels: [{ id: 'C2' }],
              response_metadata: { next_cursor: '' },
            }
          : {
              channels: [{ id: 'C1' }],
              response_metadata: { next_cursor: 'user-channels-next' },
            };
      }
      throw new Error(`Unexpected ${operation}`);
    },
  });

  assert.deepEqual(await transport.listChannels(), {
    channels: [
      { id: 'C1', name: 'alpha', private: false, member: true, archived: false },
      { id: 'C2', name: 'zeta', private: false, member: true, archived: false },
    ],
    truncated: false,
  });
  assert.deepEqual([...(await transport.listMemberChannels('U_TARGET'))], ['C1', 'C2']);
  assert.equal(await transport.channelHasMember('C1', 'U_TARGET'), true);
  assert.deepEqual(calls.map(({ input }) => input.cursor ?? null), [
    null,
    'channels-next',
    null,
    'user-channels-next',
    null,
    'members-next',
  ]);
});

test('gateway transport reads the connected Slack workspace identity', async () => {
  const transport = createGatewaySlackTransport({
    workspaceId: 'T123',
    async call(operation, input) {
      assert.equal(operation, 'auth.test');
      assert.deepEqual(input, {});
      return { team_id: 'T123', team: 'Acme Inc', user_id: 'UBOT' };
    },
  });

  assert.deepEqual(await transport.getWorkspaceInfo?.(), {
    teamId: 'T123',
    teamName: 'Acme Inc',
  });
});

test('direct transport follows Slack cursors for Channels and membership', async () => {
  const calls: RecordedCall[] = [];
  const client = fakeClient(calls);
  client.conversations.list = async (input) => {
    calls.push({ method: 'conversations.list', input });
    return input?.cursor === 'channels-next'
      ? {
          ok: true,
          channels: [{ id: 'C2', name: 'zeta', is_member: true }],
          response_metadata: { next_cursor: '' },
        }
      : {
          ok: true,
          channels: [{ id: 'C1', name: 'alpha', is_member: true }],
          response_metadata: { next_cursor: 'channels-next' },
        };
  };
  client.conversations.members = async (input) => {
    calls.push({ method: 'conversations.members', input });
    return input?.cursor === 'members-next'
      ? { ok: true, members: ['U_TARGET'], response_metadata: { next_cursor: '' } }
      : { ok: true, members: ['U_OTHER'], response_metadata: { next_cursor: 'members-next' } };
  };
  client.users.conversations = async (input) => {
    calls.push({ method: 'users.conversations', input });
    return input?.cursor === 'user-channels-next'
      ? {
          ok: true,
          channels: [{ id: 'C2' }],
          response_metadata: { next_cursor: '' },
        }
      : {
          ok: true,
          channels: [{ id: 'C1' }],
          response_metadata: { next_cursor: 'user-channels-next' },
        };
  };
  const transport = createDirectSlackTransportFromClient(client);

  assert.deepEqual(await transport.listChannels(), {
    channels: [
      { id: 'C1', name: 'alpha', private: false, member: true, archived: false },
      { id: 'C2', name: 'zeta', private: false, member: true, archived: false },
    ],
    truncated: false,
  });
  assert.deepEqual([...(await transport.listMemberChannels('U_TARGET'))], ['C1', 'C2']);
  assert.equal(await transport.channelHasMember('C1', 'U_TARGET'), true);
  assert.deepEqual(calls.map(({ input }) => input?.cursor ?? null), [
    null,
    'channels-next',
    null,
    'user-channels-next',
    null,
    'members-next',
  ]);
});

test('direct transport turns Slack failures into stable capability errors', async () => {
  const client = fakeClient([], {
    usergroupsCreate: { ok: false, error: 'permission_denied' },
  });
  const transport = createDirectSlackTransportFromClient(client);

  await assert.rejects(
    () => transport.createUserGroup({ name: 'Support', handle: 'support' }),
    (error: unknown) => {
      assert.ok(error instanceof SlackTransportError);
      assert.equal(error.operation, 'usergroups.create');
      assert.equal(error.code, 'permission_denied');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('direct transport omits persona fields when posting as the base Slack app', async () => {
  const calls: RecordedCall[] = [];
  const transport = createDirectSlackTransportFromClient(fakeClient(calls));

  await transport.postMessage({ channelId: 'D123', text: 'Start a thread with @sprout.' });

  assert.deepEqual(calls.at(-1)?.input, {
    channel: 'D123',
    text: 'Start a thread with @sprout.',
  });
});

test('workspace installation selects one transport mode at the runtime edge', () => {
  const direct = stubTransport('direct');
  const gateway = stubTransport('gateway');
  const installation = (transportMode: 'direct' | 'gateway'): WorkspaceInstallation => ({
    workspaceId: 'T123',
    revision: 1,
    transportMode,
    runtimeContract: 'legacy',
    defaultAgentId: 'agent_default',
    health: 'healthy',
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(selectSlackTransport(installation('direct'), { direct, gateway }), direct);
  assert.equal(selectSlackTransport(installation('gateway'), { direct, gateway }), gateway);
});

function fakeClient(
  calls: RecordedCall[],
  overrides: { usergroupsCreate?: Record<string, unknown> } = {},
): DirectSlackApiClient {
  const call = async (
    method: string,
    input: Record<string, unknown> | undefined,
    result: Record<string, unknown>,
  ) => {
    calls.push({ method, input });
    return result;
  };
  const group = (handle = 'support', disabled = false) => ({
    id: 'S123', name: 'Support Triage', handle, description: 'Support Agent',
    date_update: 42, date_delete: disabled ? 43 : 0,
  });
  const channel = {
    id: 'C123', name: 'support', is_private: false, is_member: true, is_archived: false,
  };
  return {
    users: {
      info: (input) => call('users.info', input, {
        ok: true,
        user: {
          id: 'U123', team_id: 'T123', name: 'ada', deleted: false, is_bot: false,
          is_app_user: false, is_stranger: false,
          is_restricted: false, is_ultra_restricted: false,
          profile: {
            display_name: 'Ada Lovelace', real_name: 'Augusta Ada King',
            email: 'ada@example.com', image_192: 'https://avatars.slack-edge.com/ada.png',
          },
        },
      }),
      conversations: (input) => call('users.conversations', input, {
        ok: true,
        channels: [channel],
        response_metadata: { next_cursor: '' },
      }),
    },
    conversations: {
      info: (input) => call('conversations.info', input, { ok: true, channel }),
      list: (input) => call('conversations.list', input, {
        ok: true, channels: [channel], response_metadata: { next_cursor: '' },
      }),
      members: (input) => call('conversations.members', input, {
        ok: true, members: ['U123'], response_metadata: { next_cursor: '' },
      }),
      open: (input) => call('conversations.open', input, {
        ok: true,
        channel: {
          id: 'D123', is_im: true, is_private: true, is_member: true, is_archived: false,
        },
      }),
      join: (input) => call('conversations.join', input, { ok: true, channel }),
    },
    usergroups: {
      list: (input) => call('usergroups.list', input, { ok: true, usergroups: [group()] }),
      create: (input) => call(
        'usergroups.create', input, overrides.usergroupsCreate ?? { ok: true, usergroup: group() },
      ),
      update: (input) => call('usergroups.update', input, {
        ok: true, usergroup: group(String(input?.handle ?? 'support')),
      }),
      disable: (input) => call('usergroups.disable', input, {
        ok: true, usergroup: group('support', true),
      }),
      enable: (input) => call('usergroups.enable', input, {
        ok: true, usergroup: group('support', false),
      }),
    },
    views: {
      publish: (input) => call('views.publish', input as unknown as Record<string, unknown>, {
        ok: true, view: { id: 'V123', hash: 'hash-1' },
      }),
    },
    chat: {
      postMessage: (input) => call('chat.postMessage', input, {
        ok: true, channel: 'C123', ts: '1700.2',
      }),
    },
  };
}

function stubTransport(mode: 'direct' | 'gateway'): SlackTransport {
  const unsupported = async (): Promise<never> => { throw new Error('unused'); };
  return {
    mode,
    lookupMember: unsupported,
    lookupChannel: unsupported,
    listChannels: unsupported,
    listMemberChannels: unsupported,
    channelHasMember: unsupported,
    openDirectConversation: unsupported,
    joinPublicChannel: unsupported,
    lookupUserGroup: unsupported,
    listUserGroups: unsupported,
    createUserGroup: unsupported,
    updateUserGroup: unsupported,
    disableUserGroup: unsupported,
    enableUserGroup: unsupported,
    publishAppHome: unsupported,
    postMessage: unsupported,
  };
}
