import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { AgentPresenceError, agentPresenceRecovery } from '../src/slack/agent-presence/errors.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import {
  createDirectSlackTransportFromClient,
  type DirectSlackApiClient,
} from '../src/slack/transport/direct.ts';

type Credential = 'bot' | 'owner';
type Input = Record<string, unknown> | undefined;

interface FakeGroup {
  id: string;
  name: string;
  handle: string;
  description: string;
  date_update: number;
  date_delete: number;
}

class FakeSlackWorkspace {
  readonly calls: string[] = [];
  readonly refusals: Record<Credential, Record<string, string>> = { bot: {}, owner: {} };
  readonly groups: FakeGroup[] = [];
  private readonly channel = { id: 'C_SUPPORT', name: 'support', is_private: false, is_member: true, is_archived: false };

  client(credential: Credential): DirectSlackApiClient {
    const method = (name: string, answer: (input: Input) => Record<string, unknown>) => async (input?: Input) => {
      this.calls.push(`${credential}:${name}`);
      const code = this.refusals[credential][name];
      if (code) {
        throw Object.assign(new Error(`An API error occurred: ${code}`), {
          code: 'slack_webapi_platform_error', data: { ok: false, error: code },
        });
      }
      return { ok: true, ...answer(input) };
    };
    const group = (input: Input) => this.groups.find(({ id }) => id === input?.usergroup)!;
    return {
      users: {
        info: method('users.info', () => ({})),
        conversations: method('users.conversations', () => ({
          channels: [this.channel], response_metadata: { next_cursor: '' },
        })),
      },
      conversations: {
        info: method('conversations.info', () => ({ channel: this.channel })),
        join: method('conversations.join', () => ({ channel: this.channel })),
        list: method('conversations.list', () => ({ channels: [this.channel], response_metadata: { next_cursor: '' } })),
        members: method('conversations.members', () => ({ members: ['UADA'], response_metadata: { next_cursor: '' } })),
        open: method('conversations.open', () => ({})),
      },
      usergroups: {
        list: method('usergroups.list', (input) => ({
          usergroups: this.groups.filter((candidate) => input?.include_disabled || candidate.date_delete === 0),
        })),
        create: method('usergroups.create', (input) => {
          const created: FakeGroup = {
            id: `S${this.groups.length + 1}`, name: String(input?.name), handle: String(input?.handle),
            description: String(input?.description ?? ''), date_update: 1, date_delete: 0,
          };
          this.groups.push(created);
          return { usergroup: created };
        }),
        update: method('usergroups.update', (input) => ({ usergroup: Object.assign(group(input), { date_update: 2 }) })),
        disable: method('usergroups.disable', (input) => ({ usergroup: Object.assign(group(input), { date_delete: 3 }) })),
        enable: method('usergroups.enable', (input) => ({ usergroup: Object.assign(group(input), { date_delete: 0 }) })),
      },
      views: { publish: method('views.publish', () => ({})) },
      chat: { postMessage: method('chat.postMessage', () => ({})) },
    };
  }

  userGroupCalls(name: string): string[] {
    return this.calls.filter((call) => call.endsWith(`:${name}`));
  }
}

function agent(): CustomAgentConfig {
  return {
    id: 'agent_support', kind: 'user', revision: 1, name: 'Support', instructions: 'You are Support.',
    enabled: true, lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'unpublished', health: 'unpublished',
      avatar: { kind: 'generated', revision: 1, seed: 'agent_support' },
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

async function agentPublishedWhereSlackRefusesTheBot(t: TestContext) {
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'info', () => undefined);
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  t.after(() => config.close());
  const slack = new FakeSlackWorkspace();
  slack.refusals.bot['usergroups.disable'] = 'permission_denied';
  slack.refusals.bot['usergroups.enable'] = 'permission_denied';
  const reconciler = new AgentPresenceReconciler({
    config,
    transport: createDirectSlackTransportFromClient(slack.client('bot'), slack.client('owner')),
    announce: null,
  });
  await config.createAgent(agent());
  await reconciler.publish({
    workspaceId: 'TACME', agentId: 'agent_support', channelId: 'C_SUPPORT',
    actorMembershipId: 'membership_ada', actorSlackUserId: 'UADA',
  });
  await config.deleteAgentChannelGrant('TACME', 'C_SUPPORT', 'agent_support');
  return { config, slack, reconciler };
}

test('an archive the bot may not perform finishes through the installing Owner, and restore enables through it', async (t) => {
  const { slack, reconciler } = await agentPublishedWhereSlackRefusesTheBot(t);

  const archived = await reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.equal(archived.slackPresence?.desiredState, 'disabled');
  assert.equal(archived.slackPresence?.errorCode, undefined);
  assert.notEqual(archived.slackPresence?.health, 'needs_attention');
  assert.equal(slack.groups[0]?.date_delete, 3, 'Slack holds the user group disabled');
  assert.deepEqual(slack.userGroupCalls('usergroups.disable'), ['owner:usergroups.disable']);

  const restored = await reconciler.restore('agent_support');
  assert.equal(restored.lifecycle, 'active');
  assert.equal(restored.slackPresence?.desiredState, 'active');
  assert.equal(slack.groups[0]?.date_delete, 0, 'Slack holds the user group enabled');
  assert.deepEqual(slack.userGroupCalls('usergroups.enable'), ['owner:usergroups.enable']);
  assert.deepEqual(slack.calls.filter((call) => call.startsWith('bot:usergroups.')), [],
    'the bot never asks Slack about user groups while the Owner answers');
});

test('a revoked Owner token falls back to the bot, whose denial keeps today\'s archive recovery', async (t) => {
  const { config, slack, reconciler } = await agentPublishedWhereSlackRefusesTheBot(t);
  slack.refusals.owner['usergroups.list'] = 'token_revoked';
  slack.refusals.owner['usergroups.disable'] = 'token_revoked';

  let denial: unknown;
  await assert.rejects(reconciler.archive('agent_support'), (error: unknown) => {
    denial = error;
    return error instanceof AgentPresenceError && error.code === 'user_group_policy_denied';
  });
  assert.deepEqual(slack.userGroupCalls('usergroups.disable'), ['owner:usergroups.disable', 'bot:usergroups.disable']);
  assert.equal(slack.groups[0]?.date_delete, 0, 'the user group is still active');

  const saved = await config.getAgent('agent_support');
  assert.equal(saved.slackPresence?.errorCode, 'user_group_policy_denied');
  assert.equal(saved.slackPresence?.desiredState, 'disabled');
  assert.deepEqual(agentPresenceRecovery(denial as AgentPresenceError, saved), {
    title: 'Slack could not finish archiving @support',
    explanation: 'The Agent is not archived yet because its Slack handle could not be disabled. Retry will finish archiving it, without reactivating the handle. If you chose a replacement default Agent, it is already in place.',
    steps: [
      'Ask an authorized Slack Workspace Owner or Admin to deactivate the @support user group: in Slack, open Directories → User Groups, select @support, and deactivate it from its ⋮ menu.',
      'Come back here and select Retry to finish archiving the Agent.',
    ],
    actionLabel: 'Retry',
    actionKind: 'retry',
  });
});
