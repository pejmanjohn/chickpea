import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import type {
  AgentAppLifecycle,
  AgentAppPresence,
  CustomAgentConfig,
  UserGroupPresence,
} from '../src/config/types.ts';
import { agentMayAskTeammates, agentSlackHandle } from '../src/slack/agent-asks.ts';
import { agentAppIsLive, normalizeAgentAppPresence } from '../src/slack/agent-apps/index.ts';
import type { AgentPresenceAnnouncements } from '../src/slack/agent-presence/announcements.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import {
  AgentPresenceReconciler,
  repairMentionedAgentUserGroup,
} from '../src/slack/agent-presence/reconciler.ts';
import type { SlackTransport } from '../src/slack/transport/types.ts';

const NOW = 1_800_000_000_000;
const APP = { appId: 'A0C8APP', clientId: '1.2' };
const ACTIVE: AgentAppLifecycle = {
  state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: NOW, installedBy: 'UOWNER',
};

function agent(id: string, name: string, presence: CustomAgentConfig['slackPresence']): CustomAgentConfig {
  return {
    id,
    kind: 'user',
    revision: 1,
    name,
    instructions: `You are ${name}.`,
    enabled: true,
    lifecycle: 'active',
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    ...(presence ? { slackPresence: presence } : {}),
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
}

function userGroup(handle: string, userGroupId?: string): UserGroupPresence {
  return {
    requestedHandle: handle,
    normalizedHandle: handle,
    desiredState: userGroupId ? 'active' : 'unpublished',
    health: userGroupId ? 'healthy' : 'unpublished',
    avatar: { kind: 'generated', revision: 1, seed: handle },
    ...(userGroupId ? { userGroupId } : {}),
  };
}

function agentApp(handle: string, app: AgentAppLifecycle, extra: Partial<AgentAppPresence> = {}): AgentAppPresence {
  return normalizeAgentAppPresence({
    kind: 'agent_app',
    requestedHandle: handle,
    normalizedHandle: handle,
    desiredState: 'active',
    health: 'pending',
    avatar: { kind: 'generated', revision: 1, seed: handle },
    app,
    ...extra,
  });
}

/** Creates the Agent, then writes `presence` over the avatar the store assigned at creation. */
async function storeAgent(
  config: SqliteConfigStore,
  id: string,
  name: string,
  presence: UserGroupPresence | AgentAppPresence,
): Promise<UserGroupPresence | AgentAppPresence> {
  const created = await config.createAgent(agent(id, name, presence));
  const written = { ...presence, avatar: created.slackPresence!.avatar };
  await config.updateAgent(id, { slackPresence: written }, created.revision);
  return written;
}

/** The reconciler swallows a failing announcement, so record calls instead of throwing. */
function announcementRecorder(): AgentPresenceAnnouncements & { announced: string[] } {
  const announced: string[] = [];
  return new Proxy({ announced } as AgentPresenceAnnouncements & { announced: string[] }, {
    get(target, name) {
      if (name === 'announced') return target.announced;
      return async () => { announced.push(String(name)); };
    },
  });
}

/** Every Slack call fails the test; the methods a test allows are given explicitly. */
function slackThatRefuses(allowed: Partial<SlackTransport> = {}): SlackTransport & { calls: string[] } {
  const calls: string[] = [];
  return new Proxy({ mode: 'direct', calls, ...allowed } as SlackTransport & { calls: string[] }, {
    get(target, name) {
      if (name in target) return target[name as keyof typeof target];
      return () => { calls.push(String(name)); throw new Error(`unexpected Slack call ${String(name)}`); };
    },
  });
}

test('stored presence without a kind reads back exactly as written', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const written = await storeAgent(config, 'agent_support', 'Support', userGroup('support', 'S1'));
    const read = (await config.getAgent('agent_support')).slackPresence;
    assert.deepEqual(read, written);
    assert.equal('kind' in read!, false);
  } finally {
    config.close();
  }
});

test('an Agent app presence round-trips through the store', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const written = await storeAgent(config, 'agent_support', 'Support', agentApp('support', ACTIVE, { released: { userGroupId: 'S1' } }));
    const read = (await config.getAgent('agent_support')).slackPresence;
    assert.deepEqual(read, written);
    assert.equal(agentAppIsLive(read), true);
  } finally {
    config.close();
  }
});

test('a stored health never outranks the lifecycle it summarizes', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const stale: AgentAppPresence = {
      ...agentApp('support', {
        state: 'needs_attention', at: NOW, startedBy: 'UOWNER', reason: 'app_removed', resume: 'icon_set', app: APP,
      }),
      desiredState: 'active',
      health: 'healthy',
    };
    await storeAgent(config, 'agent_support', 'Support', stale);
    const read = (await config.getAgent('agent_support')).slackPresence;
    assert.equal(read?.health, 'needs_attention');
    assert.equal(read?.desiredState, 'active');
    assert.equal(agentAppIsLive(read), false);

    const uninstalling = agentApp('support', { state: 'uninstalling', at: NOW, startedBy: 'UOWNER', app: APP, next: 'delete' });
    assert.equal(uninstalling.desiredState, 'disabled');
    assert.equal(uninstalling.health, 'pending');
    const removing = agentApp('support', {
      state: 'needs_attention', at: NOW, startedBy: 'UOWNER', reason: 'uninstall_failed', resume: 'uninstalling', app: APP,
    });
    assert.equal(removing.desiredState, 'disabled');
  } finally {
    config.close();
  }
});

test('reconciling, retrying or publishing an Agent app never touches Slack user groups', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const transport = slackThatRefuses({
    async lookupChannel() { return { id: 'C_SUPPORT', name: 'support', private: false, member: true, archived: false }; },
    async channelHasMember() { return true; },
  });
  try {
    const presence = await storeAgent(config, 'agent_support', 'Support', agentApp('support', ACTIVE));
    const announce = announcementRecorder();
    const reconciler = new AgentPresenceReconciler({ config, transport, announce, now: () => NOW });
    assert.deepEqual((await reconciler.reconcile('agent_support')).slackPresence, presence);
    assert.deepEqual((await reconciler.retry('agent_support')).slackPresence, presence);
    const published = await reconciler.publish({
      workspaceId: 'TACME',
      agentId: 'agent_support',
      channelId: 'C_SUPPORT',
      actorMembershipId: 'membership_ada',
      actorSlackUserId: 'UADA',
    });
    assert.equal(published.grant.status, 'active');
    assert.deepEqual(published.agent.slackPresence, presence);
    assert.deepEqual(transport.calls, []);
    assert.deepEqual(announce.announced, []);
  } finally {
    config.close();
  }
});

test('a live Agent app is addressed by its bot user, a waiting one not at all, and both may ask', () => {
  const app = agent('agent_support', 'Support', agentApp('support', ACTIVE));
  const waiting = agent('agent_billing', 'Billing', agentApp('billing', {
    state: 'needs_attention', at: NOW, startedBy: 'UOWNER', reason: 'app_removed', resume: 'icon_set', app: APP,
  }));
  const group = agent('agent_finance', 'Finance', userGroup('finance', 'S2'));
  assert.deepEqual(agentSlackHandle(app), { handle: 'support', botUserId: 'UBOT' });
  assert.equal(agentSlackHandle(waiting), undefined);
  assert.deepEqual(agentSlackHandle(group), { handle: 'finance', userGroupId: 'S2' });
  assert.equal(agentMayAskTeammates(app), true);
  assert.equal(agentMayAskTeammates(group), true);
});

test('directory repair never writes a user group onto an Agent app', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    const presence = await storeAgent(config, 'agent_support', 'Support', agentApp('support', ACTIVE));
    await config.putAgentChannelGrant({
      workspaceId: 'TACME', channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
      createdByMembershipId: 'membership_ada', channelIsPrivate: false,
    }, 0);
    const result = await repairMentionedAgentUserGroup({
      workspaceId: 'TACME',
      channelId: 'C_SUPPORT',
      userGroupId: 'SRECREATED',
      config,
      transport: {
        async lookupUserGroup() {
          return { id: 'SRECREATED', name: 'Support', handle: 'support', disabled: false, updatedAt: NOW / 1000 };
        },
      },
      now: () => NOW,
    });
    assert.deepEqual(result, { kind: 'unknown' });
    assert.deepEqual((await config.getAgent('agent_support')).slackPresence, presence);
  } finally {
    config.close();
  }
});

test('archiving an Agent app retires the app first, and refuses without a host for it', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    await storeAgent(config, 'agent_support', 'Support', agentApp('support', ACTIVE, { released: { userGroupId: 'S1' } }));
    const transport = slackThatRefuses();
    await assert.rejects(
      () => new AgentPresenceReconciler({ config, transport, announce: null, now: () => NOW }).archive('agent_support'),
      (error: unknown) => error instanceof AgentPresenceError && error.code === 'slack_operation_failed' &&
        error.message === "Chickpea couldn't remove Support's Slack app, so Support is not archived. Try again in a minute.",
    );
    assert.equal((await config.getAgent('agent_support')).lifecycle, 'active');
    assert.deepEqual(transport.calls, []);

    const retired: string[] = [];
    const withHost = slackThatRefuses({
      async lookupUserGroup(id: string) {
        return { id, name: 'Support', handle: 'support', disabled: true, updatedAt: NOW / 1000 };
      },
    });
    const announce = announcementRecorder();
    const archived = await new AgentPresenceReconciler({
      config,
      transport: withHost,
      announce,
      now: () => NOW,
      agentApps: {
        async retire(current) {
          retired.push(current.id);
          return config.updateAgent(current.id, { slackPresence: { ...userGroup('support', 'S1'), desiredState: 'disabled' } }, current.revision);
        },
      },
    }).archive('agent_support');
    assert.deepEqual(retired, ['agent_support']);
    assert.equal(archived.lifecycle, 'archived');
    assert.equal(archived.slackPresence?.kind, undefined);
    assert.equal(archived.slackPresence?.userGroupId, 'S1');
    assert.equal(archived.slackPresence?.desiredState, 'disabled');
    assert.deepEqual(withHost.calls, []);
    assert.deepEqual(announce.announced, []);
  } finally {
    config.close();
  }
});
