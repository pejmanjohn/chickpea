import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { AgentAppLifecycle, AttachedAgentApp, CustomAgentConfig } from '../src/config/types.ts';
import { asUserGroup } from './helpers/user-group-presence.ts';
import type { AgentSlackAppsHost } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, type AgentAppTransport } from '../src/slack/agent-apps/index.ts';
import { deleteAppSecrets, readAppSecrets, saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { type AgentAppSlackApi, SlackRefused } from '../src/slack/agent-apps/slack-api.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SlackTransportError, type SlackTransport, type SlackUserGroup } from '../src/slack/transport/types.ts';
import { captureSlackRefusals } from './helpers/agent-app-refusals.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const APP = { appId: 'A0APP1', clientId: '1.client' };
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });
const ARCHIVED_LEFT = "Support is archived and its Slack app is removed from this workspace. Chickpea couldn't delete the app itself, so delete Support in Your Apps in Slack.";
const ARCHIVED_INSTALLED = "Support is archived. Chickpea couldn't remove its Slack app from this workspace, so delete Support in Your Apps in Slack.";
const WAITING: AttachedAgentApp = {
  state: 'awaiting_consent', at: NOW, startedBy: 'UOWNER', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D_UOWNER', ts: '1.0' },
};
const LIVE: AgentAppLifecycle = { state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: NOW, installedBy: 'UOWNER' };

class FakeSlack implements AgentAppSlackApi {
  rotations = 0;
  uninstalls: Array<{ clientId: string; clientSecret: string; botToken: string }> = [];
  deletes: Array<{ token: string; appId: string }> = [];
  refuseUninstall: string | undefined;
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
    if (this.refuseUninstall) throw new SlackRefused('apps.uninstall', this.refuseUninstall);
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

class Crash extends Error {
  readonly name = 'Crash';
}

/** The operator lines for an app Chickpea would not touch because its record names another Agent. */
function recordRefusals(t: TestContext): unknown[] {
  const lines: unknown[] = [];
  const warn = console.warn.bind(console);
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    if ((args[0] as { event?: unknown } | undefined)?.event === 'chickpea.agent_app.record_refused') lines.push(args[0]);
    else warn(...args);
  });
  return lines;
}

/**
 * `recordAgentId` writes the app's record as that Agent's. `attached` keeps the Agent on its user group with
 * that app record attached to it, instead of the app holding the handle.
 */
async function fixture(
  t: TestContext,
  options: { token?: boolean; botToken?: boolean; app?: AgentAppLifecycle; recordAgentId?: string; attached?: AttachedAgentApp } = {},
) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
    slackPresence: options.attached
      ? { ...asUserGroup(created.slackPresence), app: options.attached }
      : {
        kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
        avatar: created.slackPresence!.avatar, app: options.app ?? LIVE, released: { userGroupId: 'S1' },
      },
  }, created.revision);
  const keyring = generateCredentialKeyring('k1');
  const slack = new FakeSlack();
  const secrets = { credentials: settings, keyring, slack };
  await writeAppSecrets(secrets, APP.appId, options.recordAgentId ?? agent.id, { clientSecret: 'client-secret', signingSecret: 'signing-secret', ...(options.botToken === false ? {} : { botToken: 'xoxb-agent' }) }, null);
  if (options.token !== false) assert.equal(await saveConfigurationToken(secrets, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  const transport = new FakeTransport();
  const clock = { now: NOW };
  const service = new AgentSlackApps({ env: ENV, stores: { config, settings }, host: HOST, transport, slack, keyring, now: () => clock.now });
  /** What each finished retirement reported, as tenant end would see it. */
  const retirements: string[] = [];
  const reconciler = new AgentPresenceReconciler({
    config, transport: transport as unknown as SlackTransport, announce: null, now: () => clock.now,
    agentApps: {
      retire: async (current) => {
        const retired = await service.retire(current);
        retirements.push(retired.outcome);
        return retired.agent;
      },
      bringBotIn: async () => { throw new Error('archive brings no bot in'); },
    },
  });
  return { config, settings, secrets, slack, transport, clock, service, reconciler, agent, retirements };
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
  const refusals = captureSlackRefusals(t);
  const f = await fixture(t);
  f.slack.refuseUninstall = 'invalid_client_id';
  await assert.rejects(() => f.reconciler.archive('agent_support'), (error: unknown) =>
    error instanceof AgentPresenceError &&
    error.message === "Chickpea couldn't remove Support's Slack app, so Support is not archived. Try again in a minute.");
  assert.deepEqual(refusals.map(({ step, agentId, appId, code }) => ({ step, agentId, appId, code })), [
    { step: 'uninstall', agentId: 'agent_support', appId: APP.appId, code: 'invalid_client_id' },
  ]);
  const agent = await f.config.getAgent('agent_support');
  assert.equal(agent.lifecycle, 'active');
  const presence = agent.slackPresence;
  assert.equal(presence?.kind, 'agent_app');
  assert.equal(presence?.kind === 'agent_app' && presence.app.state === 'needs_attention' && presence.app.reason, 'uninstall_failed');
  assert.deepEqual(f.slack.deletes, []);
  assert.ok((await readAppSecrets(f.secrets, APP.appId))?.secrets.botToken, 'the token is kept for the retry');
  assert.deepEqual(f.transport.posted, [{
    channelId: 'D_UOWNER', text: "Chickpea couldn't remove Support's Slack app, so Support is not archived. Try again in a minute.",
  }], 'the Owner is told, since Support no longer answers');

  f.slack.refuseUninstall = undefined;
  const archived = await f.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived', 'Try again through archive finishes it');
  assert.equal(f.slack.uninstalls.length, 1);
});

test('Slack limiting the uninstall refuses the archive for now and leaves the app live, with nothing for the Owner', async (t) => {
  const f = await fixture(t);
  f.slack.refuseUninstall = 'ratelimited';
  await assert.rejects(() => f.reconciler.archive('agent_support'), AgentPresenceError);
  const agent = await f.config.getAgent('agent_support');
  assert.equal(agent.lifecycle, 'active');
  assert.deepEqual(agent.slackPresence?.kind === 'agent_app' && agent.slackPresence.app, LIVE, 'the app is live as it was');
  assert.deepEqual(f.transport.posted, []);

  f.slack.refuseUninstall = undefined;
  assert.equal((await f.reconciler.archive('agent_support')).lifecycle, 'archived');
  assert.equal(f.slack.uninstalls.length, 1);
});

test('Slack limiting the delete refuses the archive for now instead of leaving the app behind', async (t) => {
  const refusals = captureSlackRefusals(t);
  const f = await fixture(t);
  f.slack.refuseDelete = 'ratelimited';
  await assert.rejects(() => f.reconciler.archive('agent_support'), AgentPresenceError);
  assert.deepEqual(refusals.map(({ step, appId, code }) => ({ step, appId, code })), [{ step: 'delete', appId: APP.appId, code: 'ratelimited' }]);
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
  assert.deepEqual(f.transport.posted[0]!.text, ARCHIVED_LEFT, 'the app was uninstalled, so only its definition is left');
  assert.deepEqual(f.retirements, ['uninstalled_left_definition']);
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

test('an archive with no record for a live app, or one that cannot be opened, calls Slack for nothing, finishes, and tells the Owner the app is still installed', async (t) => {
  for (const record of ['missing', 'unreadable'] as const) {
    const f = await fixture(t);
    const stored = await readAppSecrets(f.secrets, APP.appId);
    assert.ok(stored);
    if (record === 'missing') await deleteAppSecrets(f.secrets, APP.appId, stored.revision);
    else await writeAppSecrets({ ...f.secrets, keyring: generateCredentialKeyring('k2') }, APP.appId, 'agent_support', stored.secrets, stored.revision);
    const warn = t.mock.method(console, 'warn', () => undefined);
    const archived = await f.reconciler.archive('agent_support');
    warn.mock.restore();
    assert.equal(archived.lifecycle, 'archived', record);
    assert.deepEqual([f.slack.uninstalls, f.slack.deletes], [[], []], `${record}: no uninstall and no delete`);
    assert.equal(f.slack.rotations, 1, `${record}: the configuration token is not even refreshed`);
    assert.deepEqual(f.transport.posted, [{ channelId: 'D_UOWNER', text: ARCHIVED_INSTALLED }], record);
    assert.deepEqual(f.retirements, ['left_for_owner'], `${record}: tenant end never reports the bot's access as removed`);
    assert.equal(archived.slackPresence?.userGroupId, 'S1');
  }
});

test('an archive with no record for an app that was never allowed tells the Owner only its definition is left', async (t) => {
  const f = await fixture(t, { botToken: false, app: { state: 'awaiting_consent', at: NOW, startedBy: 'UOWNER', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.0' } } });
  await deleteAppSecrets(f.secrets, APP.appId, (await readAppSecrets(f.secrets, APP.appId))!.revision);
  const archived = await f.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.deepEqual([f.slack.uninstalls, f.slack.deletes], [[], []]);
  assert.deepEqual(f.transport.posted, [{ channelId: 'D_UOWNER', text: ARCHIVED_LEFT }], 'an app never installed is not in the workspace');
  assert.deepEqual(f.retirements, ['uninstalled_left_definition']);
});

test("an archive whose app record names another Agent calls Slack for nothing, leaves that record, finishes, and tells the Owner", async (t) => {
  const lines = recordRefusals(t);
  for (const [botToken, uses] of [[true, ['uninstall', 'delete']], [false, ['delete']]] as const) {
    const f = await fixture(t, { botToken, recordAgentId: 'agent_default' });
    const stored = await readAppSecrets(f.secrets, APP.appId);
    const archived = await f.reconciler.archive('agent_support');
    assert.equal(archived.lifecycle, 'archived', `${uses[0]}: the archive finishes`);
    assert.deepEqual([f.slack.uninstalls, f.slack.deletes], [[], []], `${uses[0]}: nothing reaches Slack`);
    assert.equal(f.slack.rotations, 1, `${uses[0]}: the configuration token is not even refreshed`);
    assert.deepEqual(await readAppSecrets(f.secrets, APP.appId), stored, "the other Agent's record is untouched");
    assert.deepEqual(f.transport.posted, [{ channelId: 'D_UOWNER', text: ARCHIVED_INSTALLED }]);
    assert.deepEqual(f.retirements, ['left_for_owner']);
    assert.equal(archived.slackPresence?.userGroupId, 'S1');
    assert.deepEqual(lines.splice(0), uses.map((use) => ({
      event: 'chickpea.agent_app.record_refused', use, agentId: 'agent_support', appId: APP.appId, recordAgentId: 'agent_default',
    })));
  }
});

test('an archive that stopped after the delete removed the record, before it was committed, finishes on the next try without calling Slack again', async (t) => {
  const f = await fixture(t);
  let crashNextCommit = false;
  const deleteRevision = f.settings.deleteEncryptedCredentialRevision.bind(f.settings);
  f.settings.deleteEncryptedCredentialRevision = async (...args: Parameters<typeof deleteRevision>) => {
    const deleted = await deleteRevision(...args);
    crashNextCommit = true;
    return deleted;
  };
  const updateAgent = f.config.updateAgent.bind(f.config);
  f.config.updateAgent = async (...args: Parameters<typeof updateAgent>) => {
    if (crashNextCommit) { crashNextCommit = false; throw new Crash('before the deleted commit'); }
    return updateAgent(...args);
  };
  await assert.rejects(() => f.reconciler.archive('agent_support'), Crash);
  assert.equal(await readAppSecrets(f.secrets, APP.appId), undefined);
  const presence = (await f.config.getAgent('agent_support')).slackPresence;
  assert.equal(presence?.kind === 'agent_app' && presence.app.state === 'uninstalling' && presence.app.next, 'delete');
  assert.equal(f.slack.deletes.length, 1);

  const archived = await f.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.equal(f.slack.deletes.length, 1, 'the app is deleted once');
  assert.equal(f.slack.uninstalls.length, 1);
  assert.equal(archived.slackPresence?.userGroupId, 'S1');
  assert.deepEqual(f.transport.posted, [{ channelId: 'D_UOWNER', text: ARCHIVED_INSTALLED }], 'with no record left, Chickpea cannot tell the app is gone');
});

// Defects caught: archive finding an app by kind, so an app record attached to the user group is left behind with
// its app in Slack; and a retire that rewrites the group instead of only dropping the record.
test('archiving a user-group Agent with an app record attached retires that app, then archives the group as before', async (t) => {
  const f = await fixture(t, { attached: WAITING, botToken: false });
  const group = f.agent.slackPresence;
  const archived = await f.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.deepEqual(f.slack.uninstalls, [], 'an app never allowed has no bot to uninstall');
  assert.deepEqual(f.slack.deletes.map((call) => call.appId), [APP.appId]);
  assert.equal(await readAppSecrets(f.secrets, APP.appId), undefined);
  assert.deepEqual(f.retirements, ['removed']);
  const { app: _app, ...groupAlone } = group!;
  assert.deepEqual(archived.slackPresence, { ...groupAlone, desiredState: 'disabled', health: 'healthy', observedAt: NOW },
    'the group is archived as any user group is, with nothing of the app left');
  assert.deepEqual(f.transport.posted, []);
});

// Defects caught: a tenant end or archive that, with Slack refusing the delete, deletes the record anyway or
// rewrites the group; the attached record is left for the Owner as an app record is.
test("an attached app whose delete Slack refuses is left for the Owner, who is told, and the group is archived", async (t) => {
  const f = await fixture(t, { attached: WAITING, botToken: false });
  f.slack.refuseDelete = 'invalid_app';
  const capture = captureSlackRefusals(t);
  const archived = await f.reconciler.archive('agent_support');
  assert.equal(archived.lifecycle, 'archived');
  assert.equal(archived.slackPresence?.app, undefined);
  assert.equal(archived.slackPresence?.userGroupId, 'S1');
  assert.deepEqual(f.retirements, ['uninstalled_left_definition']);
  assert.deepEqual(f.transport.posted.map((message) => message.text), [ARCHIVED_LEFT]);
  assert.equal(capture.length, 1);
});

// Defects caught: the double-start guard reading the presence's kind, so a second start of an Agent whose app is
// attached to its group creates a second app.
test('a start for an Agent with an app record attached to its group is refused as already started, and changes nothing', async (t) => {
  const f = await fixture(t, { attached: WAITING });
  const outcome = await f.service.start('agent_support', 'UOWNER');
  assert.equal(outcome.kind, 'already_started');
  assert.deepEqual((await f.config.getAgent('agent_support')).slackPresence, f.agent.slackPresence);
  assert.deepEqual(f.slack.uninstalls, []);
  assert.deepEqual(f.slack.deletes, []);
  assert.deepEqual(f.transport.posted, []);
});
