import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigStoreLogic } from '../src/config/store.ts';
import {
  AWAITING_OWN_APP,
  type AgentAppLifecycle,
  type AgentAppPresence,
  type AgentAppSwitchProgress,
  type AgentCreateInput,
  type AgentSlackPresence,
  type UserGroupPresence,
  agentAppIsLive,
  answeringUserGroupId,
  appRecordOf,
} from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { agentAppBots } from '../src/slack/agent-app-bots.ts';
import { AgentPresenceReconciler, repairMentionedAgentUserGroup } from '../src/slack/agent-presence/reconciler.ts';
import type { SlackTransport } from '../src/slack/transport/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

/**
 * The stored shapes that let an Agent keep its user group while an app record
 * is attached to it. Every record stored before them reads exactly as it did,
 * pinned here with the literal JSON earlier code wrote.
 */

const NOW = 1_800_000_000_000;
const AVATAR = { kind: 'generated', revision: 1, seed: 'agent_support' } as const;
const APP = { appId: 'A0APP1', clientId: '1.client' };
const BASE = { requestedHandle: 'support', normalizedHandle: 'support', avatar: AVATAR };

function agent(id: string): AgentCreateInput {
  return { id, name: 'Support', instructions: 'Help.', enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [] };
}

function store() {
  const db = openStateDb(':memory:');
  const config = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
  config.createAgent(agent('agent_support'));
  return {
    config,
    /** What the store reads back for `json` as written by any earlier code. */
    read(json: string): AgentSlackPresence | undefined {
      db.run('UPDATE config_agents SET slack_presence_json = ? WHERE id = ?', json, 'agent_support');
      return config.getAgent('agent_support').slackPresence;
    },
    /**
     * `presence` as the store's own writer stores it, over the avatar the store assigned, and what it reads back.
     * The store owns a generated avatar, so the written avatar is the one it holds.
     */
    roundTrip<P extends AgentSlackPresence>(presence: P): { written: P; read: AgentSlackPresence | undefined } {
      const current = config.getAgent('agent_support');
      const written = { ...presence, avatar: current.slackPresence!.avatar };
      config.updateAgent('agent_support', { slackPresence: written }, current.revision);
      return { written, read: config.getAgent('agent_support').slackPresence };
    },
    close: () => db.close(),
  };
}

const WAITING: AgentAppLifecycle = {
  state: 'awaiting_consent', at: NOW, startedBy: 'UOWNER', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.0' },
};
const LIVE: AgentAppLifecycle = {
  state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: NOW, installedBy: 'UOWNER',
};

// Defects caught: a reader that changes what a stored user group means (its group, its paid-plan state, a field
// dropped or added), or that reads an earlier record as carrying an app.
test('a user group stored today, with or without its group, reads exactly as written and has no app record', () => {
  const s = store();
  try {
    const withGroup = { ...BASE, desiredState: 'active', health: 'healthy', userGroupId: 'S1', observedAt: NOW };
    const freePlan = {
      ...BASE, desiredState: 'active', health: 'needs_attention', errorCode: 'paid_plan_required',
      errorDetail: 'Slack user groups require a paid Slack plan.',
    };
    const typed = { ...withGroup, kind: 'user_group' };
    for (const stored of [withGroup, freePlan, typed]) {
      const read = s.read(JSON.stringify(stored));
      assert.deepEqual(read, stored);
      assert.equal(appRecordOf(read), undefined);
      assert.equal(agentAppIsLive(read), false);
    }
    assert.equal(answeringUserGroupId(s.read(JSON.stringify(withGroup))), 'S1');
    assert.equal(answeringUserGroupId(s.read(JSON.stringify(freePlan))), undefined);
  } finally {
    s.close();
  }
});

// Defects caught: an `agent_app` record of any lifecycle state read with other flags than its lifecycle gives, with
// a field added (such as `answers` or `switchProgress` defaulted in), or with its released group lost.
test('an Agent app stored today reads as before in every lifecycle state, with and without its released group', () => {
  const s = store();
  const states: Array<[AgentAppLifecycle, 'active' | 'disabled', 'healthy' | 'pending' | 'needs_attention']> = [
    [{ state: 'releasing_handle', at: NOW, startedBy: 'UOWNER' }, 'active', 'pending'],
    [{ state: 'creating', at: NOW, startedBy: 'UOWNER', manifestFingerprint: 'f1' }, 'active', 'pending'],
    [{ state: 'created', at: NOW, startedBy: 'UOWNER', app: APP }, 'active', 'pending'],
    [{ state: 'urls_set', at: NOW, startedBy: 'UOWNER', app: APP }, 'active', 'pending'],
    [{ state: 'icon_set', at: NOW, startedBy: 'UOWNER', app: APP, icon: 'default_avatar' }, 'active', 'pending'],
    [WAITING, 'active', 'pending'],
    [LIVE, 'active', 'healthy'],
    [{ state: 'uninstalling', at: NOW, startedBy: 'UOWNER', app: APP, botUserId: 'UBOT', next: 'uninstall' }, 'disabled', 'pending'],
    [{ state: 'needs_attention', at: NOW, startedBy: 'UOWNER', reason: 'app_removed', resume: 'icon_set', app: APP }, 'active', 'needs_attention'],
    [{ state: 'needs_attention', at: NOW, startedBy: 'UOWNER', reason: 'uninstall_failed', resume: 'uninstalling', app: APP }, 'disabled', 'needs_attention'],
  ];
  try {
    for (const [app, desiredState, health] of states) {
      for (const released of [undefined, { userGroupId: 'S1' }, { userGroupId: 'S1', desiredState: 'active', health: 'healthy' }]) {
        const stored = { kind: 'agent_app', ...BASE, desiredState: 'active', health: 'healthy', app, ...(released ? { released } : {}) };
        const read = s.read(JSON.stringify(stored));
        assert.deepEqual(read, { ...stored, desiredState, health }, `${app.state}, released ${JSON.stringify(released)}`);
        assert.deepEqual(appRecordOf(read), app);
        assert.equal(answeringUserGroupId(read), undefined, 'a released group answers only when its record says so');
      }
    }
  } finally {
    s.close();
  }
});

// Defects caught: an Allow link opened before per-Owner consent was stored, lost or read as nobody's, or as another
// Owner's.
test("a record stored with the single consent field reads as that one Owner's open link", () => {
  const s = store();
  try {
    const consent = { nonceDigest: 'digest1', owner: 'UOWNER', expiresAt: NOW + 900_000 };
    const read = s.read(JSON.stringify({ kind: 'agent_app', ...BASE, desiredState: 'active', health: 'pending', app: { ...WAITING, consent } }));
    assert.deepEqual(appRecordOf(read), { ...WAITING, consents: { UOWNER: { nonceDigest: 'digest1', expiresAt: NOW + 900_000 } } });
    const { written, read: again } = s.roundTrip(read!);
    assert.deepEqual(appRecordOf(again), appRecordOf(written), 'and it is written back in the new shape');
  } finally {
    s.close();
  }
});

// Defects caught: a new shape the store's writer or reader drops, rewrites, or derives flags for.
test('each new shape round-trips through the store', () => {
  const s = store();
  try {
    const consents = { UOWNER: { nonceDigest: 'd1', expiresAt: NOW + 1 }, UOWNER2: { nonceDigest: 'd2', expiresAt: NOW + 2 } };
    const attached: UserGroupPresence = { ...BASE, desiredState: 'active', health: 'healthy', userGroupId: 'S1', app: { ...WAITING, consents } };
    const removed: UserGroupPresence = {
      ...BASE, desiredState: 'active', health: 'healthy', userGroupId: 'S1',
      app: { state: 'needs_attention', at: NOW, startedBy: 'UOWNER', reason: 'app_removed', resume: 'icon_set', app: APP },
    };
    const notInSlackYet: UserGroupPresence = {
      ...BASE, desiredState: 'active', health: 'pending', errorCode: AWAITING_OWN_APP,
      app: { state: 'creating', at: NOW, startedBy: 'UOWNER', manifestFingerprint: 'f1' },
    };
    const answering: AgentAppPresence = {
      kind: 'agent_app', ...BASE, desiredState: 'active', health: 'healthy', app: { ...LIVE, switchProgress: 'live' },
      released: { userGroupId: 'S1', desiredState: 'active', health: 'healthy', answers: true },
    };
    for (const presence of [attached, removed, notInSlackYet, answering]) {
      const { written, read } = s.roundTrip(presence);
      assert.deepEqual(read, written);
    }
    const progress: AgentAppSwitchProgress[] = ['live', 'group_pending', 'bring_in_pending', 'owner_told', 'done'];
    for (const switchProgress of progress) {
      const { written, read } = s.roundTrip({ ...answering, app: { ...LIVE, switchProgress } });
      assert.deepEqual(read, written);
    }
    const { read } = s.roundTrip(notInSlackYet);
    assert.equal(appRecordOf(read)?.state, 'creating');
    assert.equal(read?.errorCode, 'awaiting_own_app');
    assert.equal(answeringUserGroupId(read), undefined, 'an Agent not in Slack yet has no group to route');
  } finally {
    s.close();
  }
});

// Defects caught: an accessor that finds the record in one home only, or invents one for a plain user group.
test('the app record is found in either home, and a plain user group has none', () => {
  const group: UserGroupPresence = { ...BASE, desiredState: 'active', health: 'healthy', userGroupId: 'S1' };
  const app: AgentAppPresence = { kind: 'agent_app', ...BASE, desiredState: 'active', health: 'healthy', app: LIVE };
  assert.equal(appRecordOf({ ...group, app: WAITING }), WAITING);
  assert.equal(appRecordOf(app), LIVE);
  assert.equal(appRecordOf(group), undefined);
  assert.equal(appRecordOf(undefined), undefined);
  assert.equal(agentAppIsLive({ ...group, app: WAITING }), false, 'an attached record never speaks for the Agent');
  assert.equal(answeringUserGroupId({ ...group, app: WAITING }), 'S1', 'the group keeps routing while an app is attached');
});

// Defects caught: a read boundary that lets a user group carry a live app or a released group, or that keeps
// a record that is not a lifecycle at all; any of them would let a reader treat the group as an app Agent.
test('a user group stored with a live app, a released group, or a malformed record reads without them', () => {
  const s = store();
  try {
    const group = { ...BASE, desiredState: 'active', health: 'healthy', userGroupId: 'S1' };
    assert.deepEqual(s.read(JSON.stringify({ ...group, app: LIVE })), group);
    assert.deepEqual(s.read(JSON.stringify({ ...group, released: { userGroupId: 'S2', answers: true } })), group);
    assert.deepEqual(s.read(JSON.stringify({ ...group, app: 'A0APP1' })), group);
    assert.deepEqual(s.read(JSON.stringify({ ...group, app: { appId: 'A0APP1' } })), group);
    const answers = s.read(JSON.stringify({
      kind: 'agent_app', ...BASE, desiredState: 'active', health: 'healthy', app: LIVE, released: { userGroupId: 'S1', answers: 'yes' },
    }));
    assert.equal(answeringUserGroupId(answers), undefined, 'only `answers: true` routes the released group');
  } finally {
    s.close();
  }
});

// Defects caught: the bot list reading apps by kind, so a removed app's bot that Slack still delivers for no
// longer reads as its Agent's once the record sits on the group.
test("an attached record that names its bot keeps that bot its Agent's; one that names none lists nothing", () => {
  const group: UserGroupPresence = { ...BASE, desiredState: 'active', health: 'healthy', userGroupId: 'S1' };
  const removing = { ...group, app: { state: 'uninstalling', at: NOW, startedBy: 'UOWNER', app: APP, botUserId: 'UBOT', next: 'delete' } } satisfies UserGroupPresence;
  assert.deepEqual(agentAppBots([{ id: 'agent_support', slackPresence: removing }]), [{ agentId: 'agent_support', botUserId: 'UBOT' }]);
  assert.deepEqual(agentAppBots([{ id: 'agent_support', slackPresence: { ...group, app: WAITING } }]), []);
  assert.deepEqual(agentAppBots([{ id: 'agent_support', slackPresence: group }]), []);
});

/** Every Slack call fails the test. */
function slackThatRefuses(): SlackTransport & { calls: string[] } {
  const calls: string[] = [];
  return new Proxy({ mode: 'direct', calls } as SlackTransport & { calls: string[] }, {
    get(target, name) {
      if (name in target) return target[name as keyof typeof target];
      return () => { calls.push(String(name)); throw new Error(`unexpected Slack call ${String(name)}`); };
    },
  });
}

// Defects caught: directory repair or the reconciler binding, creating or rewriting a group for an app Agent whose
// released group still answers.
test('repair and the reconciler never create or rebind a group for an app Agent whose released group answers', async () => {
  const s = store();
  try {
    const answering: AgentAppPresence = {
      kind: 'agent_app', ...BASE, desiredState: 'active', health: 'healthy', app: LIVE,
      released: { userGroupId: 'S1', answers: true },
    };
    const { read: stored } = s.roundTrip(answering);
    const { config } = s;
    config.putAgentChannelGrant({
      workspaceId: 'TACME', channelId: 'C1', agentId: 'agent_support', status: 'active',
      createdByMembershipId: 'membership_ada', channelIsPrivate: false,
    }, 0);
    for (const userGroupId of ['S1', 'SRECREATED']) {
      const result = await repairMentionedAgentUserGroup({
        workspaceId: 'TACME', channelId: 'C1', userGroupId, config: config as never,
        transport: {
          async lookupUserGroup() { return { id: userGroupId, name: 'Support', handle: 'support', disabled: false, updatedAt: NOW / 1000 }; },
        },
        now: () => NOW,
      });
      assert.deepEqual(result, { kind: 'unknown' }, userGroupId);
    }
    const transport = slackThatRefuses();
    const reconciler = new AgentPresenceReconciler({ config: config as never, transport, announce: null, now: () => NOW });
    assert.deepEqual((await reconciler.reconcile('agent_support')).slackPresence, stored);
    assert.deepEqual((await reconciler.retry('agent_support')).slackPresence, stored);
    assert.deepEqual(config.getAgent('agent_support').slackPresence, stored);
    assert.deepEqual(transport.calls, []);
  } finally {
    s.close();
  }
});
