import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  completeAgentWelcomeDelivery,
  completeSettledAgentWelcomeHandoff,
  deliverManagementReceiptToSlack,
  drainManagementReceiptOutbox,
} from '../src/management/receipts.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type {
  ManagementAgentCreatedWelcome,
  ManagementReceiptOutboxRecord,
  OwedAgentWelcomeInput,
} from '../src/management/types.ts';
import { agentPresenceAnnouncements } from '../src/slack/agent-presence/announcements.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import type { SlackTransport, SlackUserGroup } from '../src/slack/transport/types.ts';

const NOW = 1_800_000_000_000;
const WORKSPACE = 'T1';
const CREATION_THREAD = {
  kind: 'thread' as const, workspaceId: WORKSPACE, channelId: 'D_PEJ', threadTs: '1800000000.000100',
};

const COLLIDED_HANDLE_WELCOME: ManagementReceiptOutboxRecord = {
  outboxId: 'agent_welcome_op_help',
  operationId: 'op_help',
  destination: CREATION_THREAD,
  receipt: {
    kind: 'agent_created_welcome',
    creationOperationId: 'op_help',
    turnJobId: 'turn_help',
    agentId: 'agent_help',
    agentName: 'Support',
    agentHandle: 'support',
    agentDescription: 'Answers support questions.',
    requesterMembershipId: 'membership_pej',
    surface: 'direct',
    persona: { name: 'Support', avatarUrl: 'https://avatars.example/help.png' },
    publication: { status: 'partial', incomplete: ['slack_presence'] },
    viewAgentUrl: 'https://example.test/admin/agents/agent_help',
  },
  status: 'pending',
  attempts: 0,
  nextAttemptAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

function agentWhoseHandleCollided(): CustomAgentConfig {
  return {
    id: 'agent_help',
    kind: 'user',
    revision: 1,
    name: 'Support',
    description: 'Answers support questions.',
    instructions: 'You are Support.',
    enabled: true,
    lifecycle: 'needs_attention',
    creatorMembershipId: 'membership_pej',
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    slackPresence: {
      requestedHandle: 'support',
      normalizedHandle: 'support',
      desiredState: 'active',
      health: 'needs_attention',
      errorCode: 'handle_collision',
      errorDetail: '@support is already in use.',
      avatar: { kind: 'generated', revision: 1, seed: 'agent_help' },
    },
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
}

function fixture() {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const groups: SlackUserGroup[] = [];
  const group = (id: string) => {
    const found = groups.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Unknown group ${id}`);
    return found;
  };
  const transport = {
    mode: 'direct',
    async listUserGroups() { return groups.map((candidate) => ({ ...candidate })); },
    async lookupUserGroup(id: string) {
      const found = groups.find((candidate) => candidate.id === id);
      return found ? { ...found } : undefined;
    },
    async createUserGroup(input: { name: string; handle: string; description?: string }) {
      const created: SlackUserGroup = {
        id: `S_${input.handle.toUpperCase()}`,
        name: input.name,
        handle: input.handle,
        ...(input.description ? { description: input.description } : {}),
        disabled: false,
        updatedAt: Math.floor(NOW / 1_000),
      };
      groups.push(created);
      return { ...created };
    },
    async updateUserGroup(id: string, patch: Partial<SlackUserGroup>) {
      return { ...Object.assign(group(id), patch) };
    },
    async enableUserGroup(id: string) {
      return { ...Object.assign(group(id), { disabled: false }) };
    },
    async postMessage(): Promise<never> {
      throw new Error('the owed welcome goes through the outbox, never the transport');
    },
  } as unknown as SlackTransport;
  const releases: OwedAgentWelcomeInput[] = [];
  const reconciler = new AgentPresenceReconciler({
    config,
    transport,
    now: () => NOW,
    announce: agentPresenceAnnouncements({
      transport,
      welcomeOnJoin: async () => true,
      avatarUrl: () => undefined,
      management: {
        queueOwedAgentWelcome: async (input) => {
          releases.push(input);
          return management.queueOwedAgentWelcome(input);
        },
      },
      now: () => NOW + 10,
    }),
  });
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      async postMessage(input: Record<string, unknown>) {
        posts.push(input);
        return { ok: true, ts: `1800000000.${String(posts.length + 1).padStart(6, '0')}` };
      },
    },
  } as unknown as WebClient;
  const drain = () => drainManagementReceiptOutbox({
    management,
    now: () => NOW + 20,
    onDeliveredSettled: (record) => completeSettledAgentWelcomeHandoff(record, config, management),
    deliver: (record) => deliverManagementReceiptToSlack(record, {
      identity: { async listExternalIdentities() { return []; } },
      resolveInstallation: async (workspaceId) => ({
        workspaceId, transportMode: 'direct', sharedAppReads: false, botUserId: 'U_BOT', client,
      }),
      onDelivered: (delivered, delivery) => completeAgentWelcomeDelivery(delivered, delivery, config),
    }),
  });
  return {
    config, management, reconciler, releases, posts, drain,
    close() { config.close(); management.close(); },
  };
}

test('the welcome Chickpea posted for an Agent is posted again by that Agent once its handle is live', async () => {
  const f = fixture();
  try {
    await f.config.ensureWorkspaceInstallation({
      workspaceId: WORKSPACE, transportMode: 'direct', teamId: WORKSPACE, appId: 'A1', botUserId: 'U_BOT',
    });
    await f.config.createAgent(agentWhoseHandleCollided());
    await f.management.putOutbox(COLLIDED_HANDLE_WELCOME);

    assert.deepEqual(await f.drain(), { delivered: 1, retried: 0, failed: 0 });
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0]!.username, undefined, 'the fallback posts as Chickpea');
    assert.match(
      String(f.posts[0]!.text),
      /^Created \*Support\* \(@support\), but I couldn’t finish its Slack identity\./,
    );
    assert.equal(
      await f.config.getAgentThreadRoute(WORKSPACE, 'D_PEJ', CREATION_THREAD.threadTs),
      undefined,
      'the creation thread stays with Chickpea',
    );

    const stuck = await f.config.getAgent('agent_help');
    await f.config.updateAgent(
      'agent_help',
      { slackPresence: { ...stuck.slackPresence!, requestedHandle: 'help' } },
      stuck.revision,
    );
    const live = await f.reconciler.retry('agent_help');
    assert.equal(live.slackPresence?.health, 'healthy');
    assert.equal(live.slackPresence?.userGroupId, 'S_HELP');
    assert.deepEqual(f.releases, [
      { agentId: 'agent_help', agentName: 'Support', agentHandle: 'help', at: NOW + 10 },
    ]);
    const owed = await f.management.getOutboxForOperation('agent_welcome_op_help_published');
    assert.equal(owed?.status, 'pending');
    assert.equal(welcomeOf(owed).fallbackOutboxId, 'agent_welcome_op_help');

    assert.deepEqual(await f.drain(), { delivered: 1, retried: 0, failed: 0 });
    assert.equal(f.posts.length, 2);
    const welcome = f.posts[1]!;
    assert.equal(welcome.username, 'Support');
    assert.equal(welcome.icon_url, 'https://avatars.example/help.png');
    assert.equal(welcome.channel, 'D_PEJ');
    assert.equal(welcome.thread_ts, CREATION_THREAD.threadTs);
    assert.match(String(welcome.text), /^Hi — I’m \*Support\* \(@help\)\. Answers support questions\./);
    assert.doesNotMatch(String(welcome.text), /couldn’t finish/);
    assert.ok(String(welcome.text).endsWith('<https://example.test/admin/agents/agent_help|View Agent>'));
    const settled = await f.management.getOutboxForOperation('agent_welcome_op_help_published');
    assert.equal(settled?.status, 'delivered');
    assert.equal(welcomeOf(settled).deliveryPersona, 'agent');
    assert.equal(
      (await f.config.getAgentThreadRoute(WORKSPACE, 'D_PEJ', CREATION_THREAD.threadTs))?.agentId,
      'agent_help',
      'the creation thread is handed to the Agent',
    );
    const context = await f.config.listSlackPublicContext(WORKSPACE, 'D_PEJ', CREATION_THREAD.threadTs);
    assert.deepEqual(
      context.map(({ role, agentId, messageTs }) => ({ role, agentId, messageTs })),
      [{ role: 'agent', agentId: 'agent_help', messageTs: welcomeTs(f.posts.length) }],
    );

    await f.reconciler.retry('agent_help');
    assert.equal(f.releases.length, 1, 'an Agent that was already live announces nothing');

    const healthy = await f.config.getAgent('agent_help');
    await f.config.updateAgent(
      'agent_help',
      { slackPresence: { ...healthy.slackPresence!, health: 'needs_attention' } },
      healthy.revision,
    );
    await f.reconciler.retry('agent_help');
    assert.equal(f.releases.length, 2, 'a handle live again is announced again');
    assert.deepEqual(await f.drain(), { delivered: 0, retried: 0, failed: 0 }, 'but owes nothing more');
    assert.equal(f.posts.length, 2);
  } finally {
    f.close();
  }
});

function welcomeTs(postCount: number): string {
  return `1800000000.${String(postCount + 1).padStart(6, '0')}`;
}

function welcomeOf(record: ManagementReceiptOutboxRecord | undefined): ManagementAgentCreatedWelcome {
  assert.ok(record && 'kind' in record.receipt && record.receipt.kind === 'agent_created_welcome');
  return record.receipt;
}
