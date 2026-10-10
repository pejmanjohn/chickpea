import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { AgentAppLifecycle, CustomAgentConfig } from '../src/config/types.ts';
import type { AgentSlackAppsHost } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, type AgentAppTransport } from '../src/slack/agent-apps/index.ts';
import { readAppSecrets, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { type AgentAppSlackApi, SlackRefused } from '../src/slack/agent-apps/slack-api.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SlackTransportError, type SlackTransport, type SlackUserGroup } from '../src/slack/transport/types.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const APP = { appId: 'A0APP1', clientId: '1.client' };
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });
const LIVE: AgentAppLifecycle = { state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: NOW, installedBy: 'UOWNER' };

class FakeSlack implements AgentAppSlackApi {
  rotations = 0;
  uninstalls: Array<{ clientId: string; clientSecret: string; botToken: string }> = [];
  deletes: Array<{ token: string; appId: string }> = [];
  refuseUninstall = false;
  refuseDelete: string | undefined;
  async rotate() {
    this.rotations += 1;
    return { accessToken: `xoxe.xoxp-1-access-${this.rotations}`, refreshToken: `xoxe-1-refresh-${this.rotations}`, teamId: TEAM, expiresAt: NOW + 12 * 3_600_000 };
  }
  async create(): Promise<never> { throw new Error('not in this unit'); }
  async update(): Promise<never> { throw new Error('not in this unit'); }
  async setIcon(): Promise<never> { throw new Error('not in this unit'); }
  async exchange(): Promise<never> { throw new Error('not in this unit'); }
  async uninstall(input: { clientId: string; clientSecret: string; botToken: string }) {
    if (this.refuseUninstall) throw new SlackRefused('apps.uninstall', 'invalid_client_id');
    this.uninstalls.push(input);
    return 'removed' as const;
  }
  async delete(token: string, appId: string) {
    if (this.refuseDelete) throw new SlackRefused('apps.manifest.delete', this.refuseDelete);
    this.deletes.push({ token, appId });
    return 'deleted' as const;
  }
}

class FakeTransport implements AgentAppTransport {
  groups = new Map<string, SlackUserGroup>([['S1', { id: 'S1', name: 'Support', handle: 'support', disabled: true }]]);
  enabled: string[] = [];
  posted: Array<{ channelId: string; text: string }> = [];
  async disableUserGroup(id: string) { const g = this.groups.get(id)!; g.disabled = true; return { ...g }; }
  async enableUserGroup(id: string) { const g = this.groups.get(id); if (!g) throw new SlackTransportError('usergroups.enable', 'no_such_subteam'); g.disabled = false; this.enabled.push(id); return { ...g }; }
  async lookupUserGroup(id: string) { const g = this.groups.get(id); return g ? { ...g } : undefined; }
  async openDirectConversation(userId: string) { return { id: `D_${userId}`, private: true, member: true, archived: false }; }
  async postMessage(input: { channelId: string; text: string }) { this.posted.push({ channelId: input.channelId, text: input.text }); return { channelId: input.channelId, ts: `${this.posted.length}.0` }; }
}

async function fixture(t: TestContext, options: { token?: boolean; botToken?: boolean; app?: AgentAppLifecycle } = {}) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  const created = await config.createAgent({
    id: 'agent_support', kind: 'user', revision: 1, name: 'Support', instructions: 'You are Support.', enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: { requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'x' }, userGroupId: 'S1' },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  } satisfies CustomAgentConfig);
  const fallback = await config.createAgent({
    id: 'agent_default', kind: 'user', revision: 1, name: 'Default', instructions: 'You are Default.', enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: { requestedHandle: 'default', normalizedHandle: 'default', desiredState: 'unpublished', health: 'unpublished', avatar: { kind: 'generated', revision: 1, seed: 'd' } },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  } satisfies CustomAgentConfig);
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: fallback.id, runtimeContract: 'chickpea-v1' });
  const agent = await config.updateAgent(created.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: created.slackPresence!.avatar, app: options.app ?? LIVE, released: { userGroupId: 'S1' },
    },
  }, created.revision);
  const keyring = generateCredentialKeyring('k1');
  const slack = new FakeSlack();
  const secrets = { credentials: settings, keyring, slack };
  await writeAppSecrets(secrets, APP.appId, agent.id, { clientSecret: 'client-secret', signingSecret: 'signing-secret', ...(options.botToken === false ? {} : { botToken: 'xoxb-agent' }) }, null);
  if (options.token !== false) assert.equal(await saveConfigurationToken(secrets, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  const transport = new FakeTransport();
  const clock = { now: NOW };
  const service = new AgentSlackApps({ env: ENV, stores: { config, settings }, host: HOST, transport, slack, keyring, now: () => clock.now });
  const reconciler = new AgentPresenceReconciler({
    config, transport: transport as unknown as SlackTransport, announce: null, now: () => clock.now,
    agentApps: { retire: async (current) => (await service.retire(current)).agent },
  });
  return { config, settings, secrets, slack, transport, clock, service, reconciler, agent };
}

test('archiving an Agent app uninstalls, deletes with a rotated token, hands the handle back disabled, and restore brings it back', async (t) => {
  const f = await fixture(t);
  f.clock.now = NOW + 13 * 3_600_000;
  const archived = await f.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.deepEqual(f.slack.uninstalls, [{ clientId: APP.clientId, clientSecret: 'client-secret', botToken: 'xoxb-agent' }]);
  assert.deepEqual(f.slack.deletes, [{ token: 'xoxe.xoxp-1-access-2', appId: APP.appId }], 'the delete used a token rotated for it');
  assert.equal(await readAppSecrets(f.secrets, APP.appId), undefined, 'the realm key is gone');
  const presence = archived.slackPresence;
  assert.equal(presence?.kind, undefined);
  assert.equal(presence?.userGroupId, 'S1');
  assert.equal(presence?.desiredState, 'disabled');
  assert.equal(f.transport.groups.get('S1')?.disabled, true);
  assert.deepEqual(f.transport.posted, [], 'nothing to tell the Owner when the app is gone cleanly');

  const restored = await f.reconciler.restore('agent_support');
  assert.equal(restored.lifecycle, 'active');
  assert.deepEqual(f.transport.enabled, ['S1'], '@support is back as its user group');
  assert.equal(restored.slackPresence?.health, 'healthy');
});

test('a refused uninstall refuses the archive and leaves the Agent unarchived with its app recorded', async (t) => {
  const f = await fixture(t);
  f.slack.refuseUninstall = true;
  await assert.rejects(() => f.reconciler.archive('agent_support'), (error: unknown) =>
    error instanceof AgentPresenceError &&
    error.message === "Chickpea couldn't remove Support's Slack app, so Support is not archived. Try again in a minute.");
  const agent = await f.config.getAgent('agent_support');
  assert.equal(agent.lifecycle, 'active');
  const presence = agent.slackPresence;
  assert.equal(presence?.kind, 'agent_app');
  assert.equal(presence?.kind === 'agent_app' && presence.app.state === 'needs_attention' && presence.app.reason, 'uninstall_failed');
  assert.deepEqual(f.slack.deletes, []);
  assert.ok((await readAppSecrets(f.secrets, APP.appId))?.secrets.botToken, 'the token is kept for the retry');

  f.slack.refuseUninstall = false;
  const archived = await f.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived', 'Try again through archive finishes it');
  assert.equal(f.slack.uninstalls.length, 1);
});

test('Slack limiting the delete refuses the archive for now instead of leaving the app behind', async (t) => {
  const f = await fixture(t);
  f.slack.refuseDelete = 'ratelimited';
  await assert.rejects(() => f.reconciler.archive('agent_support'), AgentPresenceError);
  const presence = (await f.config.getAgent('agent_support')).slackPresence;
  assert.equal(presence?.kind === 'agent_app' && presence.app.state === 'uninstalling' && presence.app.next, 'delete');
  assert.deepEqual(f.transport.posted, [], 'nobody is told to delete it by hand');
  assert.ok(await readAppSecrets(f.secrets, APP.appId), 'the secrets wait for the delete');

  f.slack.refuseDelete = undefined;
  assert.equal((await f.reconciler.archive('agent_support')).lifecycle, 'archived');
  assert.deepEqual(f.slack.deletes.map(({ appId }) => appId), [APP.appId]);
});

test('without a configuration token the definition is left for the Owner, who is told, and the Agent is still archived', async (t) => {
  const f = await fixture(t, { token: false });
  const archived = await f.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.equal(f.slack.uninstalls.length, 1);
  assert.deepEqual(f.slack.deletes, []);
  assert.deepEqual(f.transport.posted.map((m) => m.channelId), ['D_UOWNER']);
  assert.match(f.transport.posted[0]!.text, /Support is archived and its Slack app is removed from this workspace\. Chickpea couldn't delete the app itself, so delete Support in Your Apps in Slack\./);
  assert.equal(await readAppSecrets(f.secrets, APP.appId), undefined);
  assert.equal(archived.slackPresence?.userGroupId, 'S1');
});

test('an app without a bot token skips the uninstall; a create still settling refuses the archive', async (t) => {
  const waiting = await fixture(t, { botToken: false, app: { state: 'awaiting_consent', at: NOW, startedBy: 'UOWNER', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.0' } } });
  const archived = await waiting.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.deepEqual(waiting.slack.uninstalls, []);
  assert.equal(waiting.slack.deletes.length, 1);

  const settling = await fixture(t, { app: { state: 'creating', at: NOW, startedBy: 'UOWNER', manifestFingerprint: 'f' } });
  await assert.rejects(() => settling.reconciler.archive('agent_support'), AgentPresenceError);
  assert.equal((await settling.config.getAgent('agent_support')).lifecycle, 'active');
  settling.clock.now = NOW + 60_000;
  const later = await settling.reconciler.archive('agent_support');
  assert.equal(later.lifecycle, 'archived', 'a stale create is let go without an app to delete');
  assert.deepEqual(settling.slack.deletes, []);
});
