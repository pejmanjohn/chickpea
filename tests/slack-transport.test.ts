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
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
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
  assert.equal(await transport.channelHasMember('C123', 'U123'), true);
  assert.equal((await transport.openDirectConversation('U123')).id, 'D123');
  assert.deepEqual(await transport.joinPublicChannel('C123'), {
    id: 'C123',
    name: 'support',
    private: false,
    member: true,
    archived: false,
  });

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
  }), { channelId: 'C123', ts: '1700.2' });

  assert.deepEqual(calls.map((entry) => entry.method), [
    'users.info',
    'conversations.info',
    'conversations.members',
    'conversations.open',
    'conversations.join',
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
  });
  assert.equal(transport.mode, 'direct');
  assert.deepEqual(Object.keys(transport).sort(), [
    'channelHasMember',
    'createUserGroup',
    'disableUserGroup',
    'enableUserGroup',
    'joinPublicChannel',
    'listUserGroups',
    'lookupChannel',
    'lookupMember',
    'mode',
    'openDirectConversation',
    'postMessage',
    'publishAppHome',
    'updateUserGroup',
  ]);
  assert.doesNotMatch(JSON.stringify(transport), /xoxb|token|client/i);
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

test('workspace installation selects one transport mode at the runtime edge', () => {
  const direct = stubTransport('direct');
  const gateway = stubTransport('gateway');
  const installation = (transportMode: 'direct' | 'gateway'): WorkspaceInstallation => ({
    workspaceId: 'T123',
    revision: 1,
    transportMode,
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
          profile: { display_name: 'Ada Lovelace', email: 'ada@example.com' },
        },
      }),
    },
    conversations: {
      info: (input) => call('conversations.info', input, { ok: true, channel }),
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
    channelHasMember: unsupported,
    openDirectConversation: unsupported,
    joinPublicChannel: unsupported,
    listUserGroups: unsupported,
    createUserGroup: unsupported,
    updateUserGroup: unsupported,
    disableUserGroup: unsupported,
    enableUserGroup: unsupported,
    publishAppHome: unsupported,
    postMessage: unsupported,
  };
}
