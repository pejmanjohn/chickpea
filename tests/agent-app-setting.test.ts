import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  AWAITING_OWN_APP,
  type AgentAppLifecycle,
  type AgentSlackPresence,
  type CustomAgentConfig,
  appRecordOf,
} from '../src/config/types.ts';
import type { IdentityStore, RecordIdentityAuthAuditInput } from '../src/identity/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { configurationTokenKey, readAppSecrets, saveConfigurationToken, type SecretDeps, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { AgentSlackApps } from '../src/slack/agent-apps/service.ts';
import { FINISH_APP_ACTION } from '../src/slack/agent-apps/pages.ts';
import { AGENT_SLACK_APPS_SETTING_KEY, readAgentSlackAppsSetting } from '../src/slack/agent-apps/setting.ts';
import { type AgentAppSlackApi, SlackRefused, SlackUnavailable } from '../src/slack/agent-apps/slack-api.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AgentPresenceReconciler, agentCreatorInSlack } from '../src/slack/agent-presence/reconciler.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { refuseLikeSlack } from './helpers/slack-manifest-rules.ts';
import { SlackTransportError, type SlackTransport, type SlackUserGroup } from '../src/slack/transport/types.ts';

const TOKEN = 'admin-token';
const TEAM = 'T_TEST';
const OWNER = 'UOWNER';
const NOW = 1_800_000_000_000;
const PASTED = 'xoxe-1-pasted-refresh-token-0000';
const PASTED_AGAIN = 'xoxe-1-pasted-again-token-0000';
const PASTED_THIRD = 'xoxe-1-pasted-third-token-0000';
const ADMIN_ORIGIN = 'https://core.test';
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
  addUrl: (agentId) => `https://cloud.test/slack/agent-apps/add/${agentId}`,
};
const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });
const API = '/admin/api/slack-apps';
const APP = { appId: 'A0APP9', clientId: '9.client' };
const AVATAR = { kind: 'generated' as const, revision: 1, seed: 's' };

function principal(role: AuthPrincipal['role'], machine = false): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_test', role,
    authenticatorKind: machine ? 'personal_token' : 'test_slack_session', credentialId: `credential_${role}`,
    correlationId: `request_${role}`, machine,
  };
}

function people(audits: RecordIdentityAuthAuditInput[], auditFails: () => boolean): IdentityStore {
  return {
    getMembership: async (id: string) => ({ id, userId: id.replace('membership_', 'user_'), status: 'active' }),
    getUser: async (id: string) => ({ id, displayName: id, slackUserId: id.replace('user_', 'U').toUpperCase(), slackTeamId: TEAM }),
    recordAuthAudit: async (input: RecordIdentityAuthAuditInput) => {
      if (auditFails() && input.action.startsWith('agent_apps.')) throw new Error('audit store unavailable');
      audits.push(input);
    },
  } as unknown as IdentityStore;
}

function group(handle: string, extra: Partial<AgentSlackPresence> = {}): AgentSlackPresence {
  return { requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy', avatar: AVATAR, userGroupId: `S_${handle}`, ...extra } as AgentSlackPresence;
}

const notInSlack = (handle: string): AgentSlackPresence => ({
  requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'pending', avatar: AVATAR, errorCode: AWAITING_OWN_APP,
});

function ownApp(handle: string, app: AgentAppLifecycle): AgentSlackPresence {
  return { kind: 'agent_app', requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy', avatar: AVATAR, app };
}

function agent(id: string, name: string, slackPresence: AgentSlackPresence): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, instructions: `You are ${name}.`, enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1, slackPresence,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

interface SlackScript {
  rotate?: AgentAppSlackApi['rotate'] | undefined;
  /** Every refresh token Slack rotated; Slack refuses each one after that. */
  spent: string[];
  deleted: string[];
  created: number;
  update?: 'unanswered' | undefined;
  delete?: 'unanswered' | 'refused' | undefined;
  uninstall?: 'refused' | 'answered' | undefined;
  /** Slack's answer to the next create, as an `ok: false` code. */
  createRefusal?: string | undefined;
  exchange?: AgentAppSlackApi['exchange'] | undefined;
  now: number;
  auditFails: boolean;
}

/**
 * Chickpea's bot and an Agent app's bot in one workspace, refusing as Slack
 * refuses: a taken handle; a private Channel a bot is not in is
 * `channel_not_found`; a private or archived Channel cannot be joined; and a
 * member check is answered from who is in the Channel.
 */
function slackWorkspace() {
  const BOT = 'UBOT';
  const groups: SlackUserGroup[] = [];
  const created: string[] = [];
  const joined: string[] = [];
  const appBotIn = new Set<string>();
  const channels = new Map<string, { private: boolean; archived: boolean; members: Set<string> }>();
  const seen = (id: string, bot: (channel: { members: Set<string> }) => boolean) => {
    const channel = channels.get(id);
    if (!channel || (channel.private && !bot(channel))) throw new SlackTransportError('conversations.info', 'channel_not_found');
    return channel;
  };
  const join = (id: string, bot: (channel: { members: Set<string> }) => boolean, add: (channel: { members: Set<string> }) => void) => {
    const channel = seen(id, bot);
    if (channel.private) throw new SlackTransportError('conversations.join', 'method_not_supported_for_channel_type');
    if (channel.archived) throw new SlackTransportError('conversations.join', 'is_archived');
    add(channel);
    return { id, name: id.toLowerCase(), private: false, member: true, archived: false };
  };
  const chickpeaIn = (channel: { members: Set<string> }) => channel.members.has(BOT);
  const required = (id: string, operation: string) => {
    const group = groups.find((candidate) => candidate.id === id);
    if (!group) throw new SlackTransportError(operation, 'no_such_subteam');
    return group;
  };
  const transport = {
    mode: 'direct',
    listUserGroups: async () => groups.map((group) => ({ ...group })),
    lookupUserGroup: async (id: string) => groups.find((group) => group.id === id),
    createUserGroup: async (input: { name: string; handle: string; description?: string }) => {
      if (groups.some((group) => group.handle === input.handle)) throw new SlackTransportError('usergroups.create', 'name_already_exists');
      const group: SlackUserGroup = { id: `S${groups.length + 1}`, disabled: false, ...input };
      groups.push(group);
      created.push(input.handle);
      return { ...group };
    },
    updateUserGroup: async (id: string, patch: Partial<SlackUserGroup>) => ({ ...Object.assign(required(id, 'usergroups.update'), patch) }),
    enableUserGroup: async (id: string) => ({ ...Object.assign(required(id, 'usergroups.enable'), { disabled: false }) }),
    disableUserGroup: async (id: string) => ({ ...Object.assign(required(id, 'usergroups.disable'), { disabled: true }) }),
    lookupChannel: async (id: string) => {
      const channel = seen(id, chickpeaIn);
      return { id, name: id.toLowerCase(), private: channel.private, member: chickpeaIn(channel), archived: channel.archived };
    },
    channelHasMember: async (id: string, user: string) => seen(id, chickpeaIn).members.has(user),
    joinPublicChannel: async (id: string) => join(id, chickpeaIn, (channel) => { channel.members.add(BOT); joined.push(id); }),
    openDirectConversation: async (user: string) => ({ id: `D_${user}`, private: true, member: true, archived: false }),
    postMessage: async (input: { channelId: string }) => ({ channelId: input.channelId, ts: '1.0' }),
  } as unknown as SlackTransport;
  const appBot = {
    lookupChannel: async (id: string) => {
      const channel = seen(id, () => appBotIn.has(id));
      return { id, private: channel.private, member: appBotIn.has(id), archived: channel.archived };
    },
    joinPublicChannel: async (id: string) => join(id, () => appBotIn.has(id), () => appBotIn.add(id)),
  };
  const channel = (id: string, options: { private?: boolean; archived?: boolean; members: string[] }) =>
    channels.set(id, { private: options.private ?? false, archived: options.archived ?? false, members: new Set(options.members) });
  return { transport, appBot, created, joined, appBotIn, channel, groups };
}

async function adminApp(t: TestContext, options: {
  role?: AuthPrincipal['role']; machine?: boolean; port?: boolean; permissionMissing?: boolean;
  slack?: ReturnType<typeof slackWorkspace>;
} = {}) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); configureAgentSlackApps(undefined); });
  const support = await config.createAgent(agent('agent_support', 'Support', group('support')));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  let rotations = 0;
  const script: SlackScript = { spent: [], deleted: [], created: 0, now: NOW, auditFails: false };
  const slack: AgentAppSlackApi = {
    rotate: async (refreshToken) => {
      if (script.spent.includes(refreshToken)) throw new SlackRefused('tooling.tokens.rotate', 'invalid_refresh_token');
      let rotated;
      if (script.rotate) {
        rotated = await script.rotate(refreshToken);
      } else {
        rotations += 1;
        rotated = { accessToken: `xoxe.xoxp-1-access-${rotations}`, refreshToken: `xoxe-1-rotated-${rotations}-0000`, teamId: TEAM, expiresAt: NOW + 12 * 3_600_000 };
      }
      script.spent.push(refreshToken);
      return rotated;
    },
    create: async (_token, manifest) => {
      refuseLikeSlack('apps.manifest.create', manifest);
      if (script.createRefusal) throw new SlackRefused('apps.manifest.create', script.createRefusal);
      script.created += 1;
      return { appId: `A0APP${script.created}`, clientId: `${script.created}.client`, clientSecret: 'cs', signingSecret: 'ss' };
    },
    update: async (_token, _appId, manifest) => {
      if (script.update === 'unanswered') throw new SlackUnavailable('apps.manifest.update', 'network_error');
      refuseLikeSlack('apps.manifest.update', manifest);
    },
    setIcon: async () => undefined,
    exchange: async (input) => {
      if (!script.exchange) throw new Error('unexpected exchange');
      return script.exchange(input);
    },
    uninstall: async () => {
      if (script.uninstall === undefined) throw new Error('unexpected uninstall');
      if (script.uninstall === 'refused') throw new SlackRefused('apps.uninstall', 'invalid_auth');
      return 'removed';
    },
    delete: async (_token, appId) => {
      if (script.delete === 'unanswered') throw new SlackUnavailable('apps.manifest.delete', 'network_error');
      if (script.delete === 'refused') throw new SlackRefused('apps.manifest.delete', 'app_not_found');
      script.deleted.push(appId);
      return 'deleted';
    },
  };
  const calls: string[] = [];
  const texts: string[] = [];
  const audits: RecordIdentityAuthAuditInput[] = [];
  const identity = people(audits, () => script.auditFails);
  const keyring = generateCredentialKeyring('k1');
  const secrets: SecretDeps = { credentials: settings, keyring, slack, now: () => script.now };
  const service: AgentSlackApps = new AgentSlackApps({
    env: HOSTED, stores: { config, settings }, host: HOST, slack, keyring, armSwitch: async () => undefined,
    now: () => script.now, publicOrigin: async () => ADMIN_ORIGIN,
    transport: {
      disableUserGroup: async (id) => { calls.push(`disable:${id}`); return { id, name: 'x', handle: 'x', disabled: true }; },
      enableUserGroup: async (id) => { calls.push(`enable:${id}`); return { id, name: 'x', handle: 'x', disabled: false }; },
      openDirectConversation: async (user) => { calls.push(`dm:${user}`); return { id: `D_${user}`, private: true, member: true, archived: false }; },
      postMessage: async (input) => { calls.push(`post:${input.channelId}`); texts.push(input.text); return { channelId: input.channelId, ts: '1.0' }; },
      lookupChannel: async (id) => { if (!options.slack) throw new Error('no Channels here'); return options.slack.transport.lookupChannel(id); },
      joinPublicChannel: async (id) => { if (!options.slack) throw new Error('no Channels here'); return options.slack.transport.joinPublicChannel(id); },
    },
    ...(options.slack ? { appBot: () => options.slack!.appBot } : {}),
    userGroupPermissionMissing: async () => options.permissionMissing ?? false,
    placeInSlack: async (agentId) => {
      if (!options.slack) return;
      await presence().placeInSlack(agentId, await agentCreatorInSlack(identity, await config.getAgent(agentId)));
    },
  });
  /** The reconciler as Admin builds it, on the same Slack. */
  const presence = () => new AgentPresenceReconciler({
    config, transport: options.slack!.transport, announce: null,
    agentApps: {
      retire: async (current) => (await service.retire(current)).agent,
      bringBotIn: async () => undefined,
      ownAppMode: async () => (await readAgentSlackAppsSetting(settings)).mode === 'own_app',
    },
  });
  configureAgentSlackApps(options.port === false ? undefined : HOST);
  const app = createAdminRoutes({
    store: config, settings,
    agentSlackApps: async () => service,
    ...(options.slack ? { slackTransport: options.slack.transport } : {}),
    ...testAdminAuthority(TOKEN, undefined, identity, principal(options.role ?? 'owner', options.machine)),
  });
  const request = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    app.request(path, { ...init, headers: { ...testAdminHeaders(TOKEN), ...(init.headers as Record<string, string> | undefined), ...headers } }, HOSTED);
  const json = (method: string, body?: unknown): RequestInit => ({
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { 'content-type': 'application/json' },
  });
  const form = (fields: Record<string, string>): RequestInit => ({
    method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const ours = () => audits.filter((audit) => audit.action.startsWith('agent_apps.'));
  return { request, json, form, service, calls, texts, audits: ours, config, settings, script, presence, secrets };
}

/** Every console line written while `run` runs, so a test can show a secret never reaches one. */
async function consoleLines<T>(run: () => Promise<T>): Promise<{ result: T; lines: string }> {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const original = methods.map((method) => console[method]);
  const lines: string[] = [];
  for (const method of methods) console[method] = (...args: unknown[]) => { lines.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); };
  try {
    return { result: await run(), lines: lines.join('\n') };
  } finally {
    methods.forEach((method, index) => { console[method] = original[index]!; });
  }
}

test('the setting reads as shared when absent or unreadable, and stores who changed it and when', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  assert.deepEqual(await readAgentSlackAppsSetting(settings), { mode: 'shared' });
  await settings.setSetting(AGENT_SLACK_APPS_SETTING_KEY, '{"mode":"sideways"}');
  assert.deepEqual(await readAgentSlackAppsSetting(settings), { mode: 'shared' }, 'an unknown mode is not a reason to change behavior');
  await settings.setSetting(AGENT_SLACK_APPS_SETTING_KEY, JSON.stringify({ mode: 'own_app', changedBy: OWNER, changedAt: NOW }));
  assert.deepEqual(await readAgentSlackAppsSetting(settings), { mode: 'own_app', changedBy: OWNER, changedAt: NOW });
});

test('only an Owner signed in as themselves reads or changes anything, and only with the port', async (t) => {
  const routes: Array<[string, RequestInit]> = [];
  const build = (app: Awaited<ReturnType<typeof adminApp>>) => {
    routes.length = 0;
    routes.push(
      [API, {}],
      [`${API}/mode`, app.json('PUT', { mode: 'own_app' })],
      [`${API}/token`, app.json('PUT', { refreshToken: PASTED })],
      [`${API}/token`, app.json('DELETE')],
      [`${API}/agents/agent_support/start`, app.json('POST', {})],
      [`${API}/agents/agent_support/cancel`, app.json('POST', {})],
    );
    return routes;
  };
  for (const [label, options, status] of [
    ['an Admin', { role: 'admin' as const }, 403],
    ['a Member', { role: 'member' as const }, 403],
    ["an Owner's personal token", { machine: true }, 403],
    ['a deployment without the port', { port: false }, 404],
  ] as const) {
    const app = await adminApp(t, options);
    for (const [path, init] of build(app)) {
      const response = await app.request(path, init);
      assert.equal(response.status, status, `${label}: ${init.method ?? 'GET'} ${path}`);
      assert.equal((await response.text()).includes(PASTED), false);
    }
    assert.deepEqual(await readAgentSlackAppsSetting(app.settings), { mode: 'shared' });
    assert.equal(await app.settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), undefined);
    assert.deepEqual(app.calls, []);
  }
});

test("a change without Admin's request protection never reaches a route", async (t) => {
  const owner = await adminApp(t);
  for (const [path, init] of [
    [`${API}/mode`, owner.json('PUT', { mode: 'own_app' })],
    [`${API}/token`, owner.json('PUT', { refreshToken: PASTED })],
    [`${API}/token`, owner.json('DELETE')],
    [`${API}/agents/agent_support/start`, owner.json('POST', {})],
    [`${API}/agents/agent_support/cancel`, owner.json('POST', {})],
  ] as const) {
    const foreign = await owner.request(path, init, { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' });
    assert.equal(foreign.status, 403, `cross-origin ${init.method} ${path}`);
    if (init.method === 'DELETE') continue;
    const form = await owner.request(path, { method: init.method!, body: 'mode=own_app', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415, `a form ${init.method} ${path}`);
  }
  assert.deepEqual(await readAgentSlackAppsSetting(owner.settings), { mode: 'shared' });
  assert.deepEqual(owner.calls, []);
});

test('an Owner turns the mode on and off; a bad mode, or the mode already stored, changes nothing', async (t) => {
  const owner = await adminApp(t);
  const read = await owner.request(API);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await read.json() as { setting: unknown }).setting, { mode: 'shared', changedBy: null, changedAt: null });

  const on = await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'own_app' }));
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { setting: { mode: 'own_app', changedBy: OWNER, changedAt: NOW } });
  assert.equal((await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'everything' }))).status, 400);
  assert.equal((await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'shared', extra: 1 }))).status, 400);
  assert.deepEqual(await readAgentSlackAppsSetting(owner.settings), { mode: 'own_app', changedBy: OWNER, changedAt: NOW });

  owner.script.now = NOW + 5_000;
  const same = await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'own_app' }));
  assert.equal(same.status, 200);
  assert.deepEqual(await same.json(), { setting: { mode: 'own_app', changedBy: OWNER, changedAt: NOW } }, 'who chose it and when stay as they were');
  assert.deepEqual(await readAgentSlackAppsSetting(owner.settings), { mode: 'own_app', changedBy: OWNER, changedAt: NOW });

  const off = await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'shared' }));
  assert.deepEqual(await off.json(), { setting: { mode: 'shared', changedBy: OWNER, changedAt: NOW + 5_000 }, waiting: [] });
  assert.deepEqual(owner.audits().map((audit) => [audit.action, audit.reasonCode]), [
    ['agent_apps.mode_changed', 'own_app'],
    ['agent_apps.mode_changed', 'shared'],
  ], 'one record per change, none for the mode already stored');
});

test('setting the default mode on a workspace that never chose one stores nothing', async (t) => {
  const owner = await adminApp(t);
  const response = await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'shared' }));
  assert.deepEqual(await response.json(), { setting: { mode: 'shared', changedBy: null, changedAt: null }, waiting: [] });
  assert.equal(await owner.settings.getSetting(AGENT_SLACK_APPS_SETTING_KEY), undefined);
  assert.deepEqual(owner.audits(), []);
});

test('each paste outcome answers as the token page does, and the token never leaves the request', async (t) => {
  const owner = await adminApp(t);
  const paste = (refreshToken: string) => owner.request(`${API}/token`, owner.json('PUT', { refreshToken }));
  const { lines } = await consoleLines(async () => {
    const access = await paste('xoxe.xoxp-1-access-token-0000');
    assert.equal(access.status, 400);
    assert.deepEqual(await access.json(), { error: 'not_refresh_token' });

    owner.script.rotate = async () => { throw new SlackRefused('tooling.tokens.rotate', 'invalid_refresh_token'); };
    const rejected = await paste(PASTED);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'rejected' });

    owner.script.rotate = async () => ({ accessToken: 'xoxe.xoxp-1-other', refreshToken: 'xoxe-1-other-0000', teamId: 'T_OTHER', expiresAt: NOW + 3_600_000 });
    const other = await paste('xoxe-1-other-team-token-0000');
    assert.equal(other.status, 400);
    assert.deepEqual(await other.json(), { error: 'other_workspace' });

    owner.script.rotate = async () => { throw new SlackUnavailable('tooling.tokens.rotate', 'network_error'); };
    const down = await paste(PASTED);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { error: 'slack_down' });
    assert.equal(await owner.settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), undefined, 'nothing is stored on any refusal');

    owner.script.rotate = undefined;
    const saved = await paste(PASTED);
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert.deepEqual(JSON.parse(body), { token: { stored: true, pastedBy: OWNER, pastedAt: NOW } });
    for (const secret of [PASTED, 'xoxe-1-rotated-1-0000', 'xoxe.xoxp-1-access-1']) assert.equal(body.includes(secret), false);

    const read = await (await owner.request(API)).text();
    assert.deepEqual(JSON.parse(read).token, { stored: true, pastedBy: OWNER, pastedAt: NOW });
    for (const secret of [PASTED, 'xoxe-1-rotated-1-0000', 'xoxe.xoxp-1-access-1']) assert.equal(read.includes(secret), false);
  });
  for (const secret of [PASTED, 'xoxe-1-rotated', 'xoxe.xoxp-1-access', 'xoxe-1-other']) assert.equal(lines.includes(secret), false, `${secret} is never logged`);
  assert.deepEqual(owner.calls, [], 'a paste starts no app');
  assert.deepEqual(owner.audits().map((audit) => audit.action), ['agent_apps.token_pasted'], 'only the paste that stored a token is recorded');
});

test('removing the token spends it with one rotation and discards the result; a second remove is harmless', async (t) => {
  const owner = await adminApp(t);
  const spent: string[] = [];
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  owner.script.rotate = async (refreshToken) => {
    spent.push(refreshToken);
    return { accessToken: 'xoxe.xoxp-1-discarded', refreshToken: 'xoxe-1-discarded-0000', teamId: TEAM, expiresAt: NOW + 3_600_000 };
  };
  const { result: removed, lines } = await consoleLines(async () => owner.request(`${API}/token`, owner.json('DELETE')));
  assert.equal(removed.status, 200);
  const body = await removed.text();
  assert.deepEqual(JSON.parse(body), { token: { stored: false }, removed: 'discarded' });
  assert.deepEqual(spent, ['xoxe-1-rotated-1-0000'], 'the stored refresh token is rotated once');
  assert.equal(await owner.settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), undefined, 'and nothing replaces it');
  for (const secret of ['xoxe-1-discarded-0000', 'xoxe.xoxp-1-discarded', 'xoxe-1-rotated-1-0000']) {
    assert.equal(body.includes(secret), false);
    assert.equal(lines.includes(secret), false);
  }
  assert.equal(/your apps/i.test(body), false, 'the answer never sends the Owner to Your Apps');

  const again = await owner.request(`${API}/token`, owner.json('DELETE'));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { token: { stored: false }, removed: 'none' }, 'a second removal makes no claim about Slack');
  assert.equal(spent.length, 1, 'nothing left to rotate');
  assert.deepEqual(owner.audits().map((audit) => [audit.action, audit.reasonCode]), [
    ['agent_apps.token_pasted', undefined],
    ['agent_apps.token_removed', 'discarded'],
    ['agent_apps.token_removed', 'none'],
  ]);
});

test('a rotation Slack refuses or does not answer still deletes the stored copy, and says Slack may still accept it', async (t) => {
  for (const failure of [new SlackRefused('tooling.tokens.rotate', 'invalid_refresh_token'), new SlackUnavailable('tooling.tokens.rotate', 'network_error')]) {
    const owner = await adminApp(t);
    assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
    owner.script.rotate = async () => { throw failure; };
    const { result: removed, lines } = await consoleLines(async () => owner.request(`${API}/token`, owner.json('DELETE')));
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { token: { stored: false }, removed: 'unconfirmed' });
    assert.equal(await owner.settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), undefined);
    assert.equal(lines.includes('xoxe-1-rotated-1-0000'), false);
    const again = await owner.request(`${API}/token`, owner.json('DELETE'));
    assert.deepEqual(await again.json(), { token: { stored: false }, removed: 'none' }, 'a second removal never reads as confirmation');
  }
});

// Defects caught: Slack asked to retire the stored pair before the pasted one is kept, so a request that ends there
// leaves the pasted token spent and nothing new stored.
test('a token pasted over a stored one keeps the new pair first, then retires the stored one at Slack', async (t) => {
  const owner = await adminApp(t);
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  const key = configurationTokenKey(TEAM);
  const first = (await owner.settings.getEncryptedCredentialRevision(key))?.revision;
  let storedWhenRetired: string | undefined;
  owner.script.rotate = async (refreshToken) => {
    if (refreshToken === 'xoxe-1-rotated-1-0000') storedWhenRetired = (await owner.settings.getEncryptedCredentialRevision(key))?.revision;
    return { accessToken: 'xoxe.xoxp-1-access-2', refreshToken: `xoxe-1-rotated-${owner.script.spent.length + 1}-0000`, teamId: TEAM, expiresAt: NOW + 12 * 3_600_000 };
  };
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED_AGAIN }))).status, 200);
  owner.script.rotate = undefined;
  assert.ok(storedWhenRetired && storedWhenRetired !== first, 'the new pair was already kept when the old one was retired');
  assert.deepEqual(owner.script.spent, [PASTED, PASTED_AGAIN, 'xoxe-1-rotated-1-0000'], 'the earlier pair is spent, its result dropped');
  assert.equal((await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}))).status, 200, 'the new pair works');

  // Slack refusing the earlier pair does not stop the paste.
  owner.script.spent.push('xoxe-1-rotated-2-0000');
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED_THIRD }))).status, 200);
  assert.deepEqual(JSON.parse(await (await owner.request(API)).text()).token, { stored: true, pastedBy: OWNER, pastedAt: NOW });
});

test('the read lists each user Agent with its name, handle, avatar, Channels and Slack state', async (t) => {
  const owner = await adminApp(t);
  const { config } = owner;
  const at = NOW - 1_000;
  const states: Array<[string, AgentSlackPresence]> = [
    ['agent_new', notInSlack('newbie')],
    ['agent_creating', group('creating', { app: { state: 'creating', at, startedBy: OWNER, manifestFingerprint: 'f' } })],
    ['agent_waiting', group('waiting', { app: { state: 'awaiting_consent', at, startedBy: OWNER, app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.0' } } })],
    ['agent_switching', ownApp('switching', { state: 'active', at, app: APP, icon: 'agent_avatar', botUserId: 'UBOT1', installedAt: at, installedBy: OWNER, switchProgress: 'group_pending' })],
    ['agent_own', ownApp('own', { state: 'active', at, app: { appId: 'A0OWN', clientId: '2.c' }, icon: 'agent_avatar', botUserId: 'UBOT2', installedAt: at, installedBy: OWNER })],
    ['agent_attention', group('attention', { app: { state: 'needs_attention', at, startedBy: OWNER, reason: 'create_refused', resume: 'creating' } })],
  ];
  for (const [id, presence] of states) {
    const created = await config.createAgent(agent(id, id.replace('agent_', ''), group(id.replace('agent_', ''))));
    await config.updateAgent(id, { slackPresence: presence }, created.revision);
  }
  await config.putAgentChannelGrant({ workspaceId: TEAM, channelId: 'C1', agentId: 'agent_support', status: 'active', createdByMembershipId: 'm', channelLabel: 'support', channelIsPrivate: false });
  await config.putAgentChannelGrant({ workspaceId: TEAM, channelId: 'G2', agentId: 'agent_support', status: 'pending', createdByMembershipId: 'm', channelIsPrivate: true });
  const archived = await config.createAgent({ ...agent('agent_gone', 'Gone', group('gone')), lifecycle: 'archived' });
  assert.equal(archived.lifecycle, 'archived');

  const body = await (await owner.request(API)).json() as { agents: Array<{ id: string; name: string; handle: string; avatarUrl: string | null; slack: unknown; channels: unknown }> };
  const byId = new Map(body.agents.map((row) => [row.id, row]));
  assert.equal(byId.has('agent_gone'), false, 'an archived Agent is not listed');
  assert.deepEqual(byId.get('agent_support'), {
    id: 'agent_support', name: 'Support', handle: 'support', avatarUrl: 'http://localhost/assets/i/inst_a/agents/agent_support/avatar/1',
    slack: { state: 'user_group' },
    channels: [
      { id: 'C1', name: 'support', private: false, status: 'active' },
      { id: 'G2', name: null, private: true, status: 'pending' },
    ],
  });
  assert.deepEqual(Object.fromEntries(states.map(([id]) => [id, byId.get(id)?.slack])), {
    agent_new: { state: 'not_in_slack' },
    agent_creating: { state: 'creating' },
    agent_waiting: { state: 'waiting_for_allow' },
    agent_switching: { state: 'switching' },
    agent_own: { state: 'own_app' },
    agent_attention: { state: 'needs_attention', reason: 'create_refused', cancellable: true },
  });
  assert.match(byId.get('agent_new')!.avatarUrl!, /^http:\/\/localhost\/assets\/i\/inst_a\/agents\/agent_new\/avatar\/\d+$/,
    'a generated avatar is served by Admin itself');
});

test('Start moves a user-group Agent: the group keeps answering and the press leads straight to Allow', async (t) => {
  const owner = await adminApp(t);
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  const started = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(started.status, 200);
  const body = await started.json() as { next: string; authorizeUrl: string; agent: { slack: unknown } };
  assert.equal(body.next, 'authorize');
  assert.deepEqual(body.agent.slack, { state: 'waiting_for_allow' });
  const url = new URL(body.authorizeUrl);
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), '1.client');
  assert.equal(url.searchParams.get('redirect_uri'), HOST.redirectUri);
  assert.match(url.searchParams.get('state')!, /^agent_support\.[a-f0-9-]{36}\.admin$/, 'the state says the press came from Admin');
  const presence = (await owner.config.getAgent('agent_support')).slackPresence;
  assert.equal(presence?.kind, undefined, 'still a user-group Agent');
  assert.equal(presence?.userGroupId, 'S_support');
  assert.equal(presence?.app?.state, 'awaiting_consent');
  if (presence?.app?.state === 'awaiting_consent') assert.deepEqual(Object.keys(presence.app.consents ?? {}), [OWNER], "the nonce is the pressing Owner's");
  assert.equal(owner.calls.some((call) => call.startsWith('disable:')), false, 'the group is never turned off before Allow');

  const again = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(again.status, 200, 'a second press leads to Allow again');
  assert.equal(owner.script.created, 1, 'two presses create one app');
});

test('Start adds a not-in-Slack-yet Agent the same way', async (t) => {
  const owner = await adminApp(t);
  const created = await owner.config.createAgent(agent('agent_new', 'Newbie', group('newbie')));
  await owner.config.updateAgent('agent_new', { slackPresence: notInSlack('newbie') }, created.revision);
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  const started = await owner.request(`${API}/agents/agent_new/start`, owner.json('POST', {}));
  assert.equal(started.status, 200);
  assert.equal((await started.json() as { next: string }).next, 'authorize');
  const presence = (await owner.config.getAgent('agent_new')).slackPresence;
  assert.equal(presence?.userGroupId, undefined);
  assert.equal(presence?.errorCode, AWAITING_OWN_APP, 'still not in Slack until Allow');
  assert.equal(presence?.app?.state, 'awaiting_consent');
});

test("Start with no token changes nothing; with one Slack refuses, the Agent's record needs attention and the Owner is messaged; the mode stays", async (t) => {
  const owner = await adminApp(t);
  await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'own_app' }));
  const before = await owner.config.getAgent('agent_support');
  const none = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(none.status, 409);
  assert.deepEqual(await none.json(), { error: 'token_needed' });
  assert.deepEqual((await owner.config.getAgent('agent_support')).slackPresence, before.slackPresence);
  assert.equal(owner.script.created, 0);
  assert.deepEqual(owner.calls, [], 'no token: no Slack message');

  // The stored access token is about to expire, and Slack refuses the refresh token behind it.
  owner.script.rotate = async () => ({ accessToken: 'xoxe.xoxp-1-short', refreshToken: 'xoxe-1-short-0000', teamId: TEAM, expiresAt: NOW + 60_000 });
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  owner.script.rotate = async () => { throw new SlackRefused('tooling.tokens.rotate', 'invalid_refresh_token'); };
  const refused = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'token_needed' });
  assert.equal(owner.script.created, 0);
  assert.equal((await readAgentSlackAppsSetting(owner.settings)).mode, 'own_app', 'the mode stays on');
  const refusedPresence = (await owner.config.getAgent('agent_support')).slackPresence;
  assert.equal(refusedPresence?.userGroupId, 'S_support', 'the group still answers');
  assert.deepEqual(refusedPresence?.app && { state: refusedPresence.app.state, reason: 'reason' in refusedPresence.app ? refusedPresence.app.reason : undefined },
    { state: 'needs_attention', reason: 'config_token_needed' }, "a refused token is recorded on the Agent's record");
  const listed = await (await owner.request(API)).json() as { agents: Array<{ id: string; slack: unknown }> };
  assert.deepEqual(listed.agents.find((row) => row.id === 'agent_support')?.slack, { state: 'needs_attention', reason: 'config_token_needed', cancellable: true },
    'no app was made, so Cancel is offered');
  assert.deepEqual(owner.calls, ['dm:UOWNER', 'post:D_UOWNER'], 'and the Owner is asked in Slack for a new token');

  owner.script.rotate = undefined;
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED_AGAIN }))).status, 200);
  const retried = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(retried.status, 200, 'with a new token the next press goes on');
  assert.equal((await retried.json() as { next: string }).next, 'authorize');
  assert.equal(owner.script.created, 1);
});

test("Cancel deletes an app waiting for Allow and leaves the Agent's user group as it was; anything else is refused", async (t) => {
  const owner = await adminApp(t);
  const before = (await owner.config.getAgent('agent_support')).slackPresence;
  assert.equal((await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}))).status, 409, 'nothing to cancel');
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  assert.equal((await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}))).status, 200);
  const cancelled = await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
  assert.equal(cancelled.status, 200);
  const body = await cancelled.json() as { agent: { slack: unknown }; app: string };
  assert.deepEqual(body.agent.slack, { state: 'user_group' });
  assert.equal(body.app, 'deleted');
  assert.deepEqual(owner.script.deleted, ['A0APP1']);
  assert.deepEqual((await owner.config.getAgent('agent_support')).slackPresence, before);
  assert.equal(owner.calls.some((call) => call.startsWith('disable:') || call.startsWith('enable:')), false);
});

// Defects caught: a start that stopped before Slack made any app offered no Cancel; Cancel answering that an app was
// deleted when none existed, or saying nothing when Slack may have made one Chickpea never heard of.
test('Cancel withdraws a start that stopped before Slack made any app, and says no app existed or that one may', async (t) => {
  const owner = await adminApp(t);
  const cases = [
    ['create_refused', 'none'], ['slack_busy', 'none'], ['config_token_needed', 'none'], ['ambiguous_create', 'left_for_owner'],
  ] as const;
  for (const [reason, app] of cases) {
    const current = await owner.config.getAgent('agent_support');
    await owner.config.updateAgent('agent_support', {
      slackPresence: { ...group('support'), app: { state: 'needs_attention', at: NOW, startedBy: OWNER, reason, resume: 'creating' } },
    }, current.revision);
    const listed = await (await owner.request(API)).json() as { agents: Array<{ id: string; slack: unknown }> };
    assert.deepEqual(listed.agents.find((row) => row.id === 'agent_support')?.slack, { state: 'needs_attention', reason, cancellable: true }, reason);
    const cancelled = await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
    assert.equal(cancelled.status, 200, reason);
    const body = await cancelled.json() as { agent: { slack: unknown }; app: string };
    assert.equal(body.app, app, reason);
    assert.deepEqual(body.agent.slack, { state: 'user_group' }, `${reason}: the group answers as before`);
  }
  assert.deepEqual(owner.script.deleted, [], 'nothing is deleted in Slack');
  assert.equal(owner.audits().filter((audit) => audit.action === 'agent_apps.cancelled').map((audit) => audit.reasonCode).join(), 'none,none,none,left_for_owner');

  // Once Slack has made the app, Cancel is not offered and is refused: that app is removed only from Allow. The second
  // record is one no transition writes today; a record that holds an app is never withdrawn, whatever it would resume.
  for (const [reason, resume] of [['config_token_needed', 'created'], ['create_refused', 'creating']] as const) {
    const current = await owner.config.getAgent('agent_support');
    await owner.config.updateAgent('agent_support', {
      slackPresence: { ...group('support'), app: { state: 'needs_attention', at: NOW, startedBy: OWNER, reason, resume, app: APP } },
    }, current.revision);
    const listed = await (await owner.request(API)).json() as { agents: Array<{ id: string; slack: unknown }> };
    assert.deepEqual(listed.agents.find((row) => row.id === 'agent_support')?.slack, { state: 'needs_attention', reason }, resume);
    assert.equal((await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}))).status, 409, resume);
    assert.equal(appRecordOf((await owner.config.getAgent('agent_support')).slackPresence)?.state, 'needs_attention', `${resume}: the record stays`);
  }
});

const CREATOR = 'membership_ada';
const CREATOR_SLACK = 'UADA';

/** An Owner's Admin in a workspace that gives each new Agent its own app, with a token pasted. */
async function ownAppWorkspace(t: TestContext) {
  const slack = slackWorkspace();
  const owner = await adminApp(t, { slack });
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  assert.equal((await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'own_app' }))).status, 200);
  return { owner, slack };
}

/** Ada creates Newbie, which waits for its own app, and asks for #sales at creation, as creation's publish does. */
async function newbieAskingForSales(f: Awaited<ReturnType<typeof ownAppWorkspace>>, channel: Parameters<ReturnType<typeof slackWorkspace>['channel']>[1] = { members: [CREATOR_SLACK] }) {
  f.slack.channel('CSALES', channel);
  await f.owner.config.createAgent({ ...agent('agent_new', 'Newbie', notInSlack('newbie')), creatorMembershipId: CREATOR, model: 'local-stub/newbie' });
  await f.owner.presence().retry('agent_new');
  await f.owner.presence().publish({
    workspaceId: TEAM, agentId: 'agent_new', channelId: 'CSALES', actorMembershipId: CREATOR, actorSlackUserId: CREATOR_SLACK,
    keepPendingUntilInSlack: true,
  });
  const grant = (await f.owner.config.listAgentChannelGrants(TEAM, 'CSALES'))[0];
  assert.deepEqual(grant && [grant.status, grant.createdByMembershipId], ['pending', CREATOR], "Ada's Channel waits for Newbie's own app");
}

/** The Owner presses Start in Admin, chooses Allow in Slack, and the switch job runs. */
async function addToSlack(owner: Awaited<ReturnType<typeof adminApp>>, agentId: string): Promise<void> {
  const started = await owner.request(`${API}/agents/${agentId}/start`, owner.json('POST', {}));
  assert.equal(started.status, 200, await started.clone().text());
  await allowAndSwitch(owner, agentId, (await started.json() as { authorizeUrl: string }).authorizeUrl);
}

async function allowAndSwitch(owner: Awaited<ReturnType<typeof adminApp>>, agentId: string, authorizeUrl: string): Promise<void> {
  const waiting = appRecordOf((await owner.config.getAgent(agentId)).slackPresence);
  assert.equal(waiting?.state, 'awaiting_consent');
  const appId = waiting?.state === 'awaiting_consent' ? waiting.app.appId : '';
  owner.script.exchange = async () => ({
    botToken: `xoxb-${agentId}`, botUserId: 'UBOTNEW', teamId: TEAM, appId, installerUserId: OWNER, scopes: [...AGENT_APP_BOT_SCOPES],
  });
  const callback = new URLSearchParams({ code: 'code-1', state: new URL(authorizeUrl).searchParams.get('state')! });
  const landed = await owner.service.completeConsent(callback, OWNER);
  assert.equal(landed.status, 303, 'the Allow went through');
  assert.equal(landed.headers.get('location'), `${ADMIN_ORIGIN}/admin/destinations/slack/connection`, 'a press in Admin lands back in Admin');
  assert.equal(await owner.service.continueSwitch(agentId), 'done');
}

const grantOf = async (owner: Awaited<ReturnType<typeof adminApp>>, channelId: string, agentId = 'agent_new') =>
  (await owner.config.listAgentChannelGrants(TEAM, channelId)).find((grant) => grant.agentId === agentId);

// Defects caught: an edit or Retry re-stamping the creator's pending Channel with the editor, so the switch skips it,
// or failing the edit because the editor is not in a Channel they never chose.
test("an Owner who is not in the creator's Channel renames the waiting Agent; Allow still makes that Channel its own", async (t) => {
  const f = await ownAppWorkspace(t);
  await newbieAskingForSales(f);
  const before = await f.owner.config.getAgent('agent_new');

  const renamed = await f.owner.request('/admin/api/agents/agent_new', {
    method: 'PATCH', body: JSON.stringify({ expectedRevision: before.revision, name: 'Newbie Two' }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await renamed.json() as { presenceRecovery: unknown }).presenceRecovery, null, 'the edit asks nobody to join anything');
  const waiting = await grantOf(f.owner, 'CSALES');
  assert.deepEqual([waiting?.status, waiting?.createdByMembershipId], ['pending', CREATOR], 'still the creator’s');

  await addToSlack(f.owner, 'agent_new');
  assert.equal((await grantOf(f.owner, 'CSALES'))?.status, 'active');
  assert.deepEqual(f.slack.joined, ['CSALES'], "Chickpea's bot joins too, as an add to a public Channel brings it in");
  assert.ok(f.slack.appBotIn.has('CSALES'), "and the Agent's own bot");
});

// Defects caught: a private Channel's grant activated with nothing said; an archived Channel's grant activated.
test('after Allow, a private creator Channel is granted and named as answering through Chickpea, and an archived one is dropped', async (t) => {
  const f = await ownAppWorkspace(t);
  await newbieAskingForSales(f, { private: true, members: [CREATOR_SLACK, 'UBOT'] });
  f.slack.channel('COLD', { members: [CREATOR_SLACK] });
  await f.owner.presence().publish({
    workspaceId: TEAM, agentId: 'agent_new', channelId: 'COLD', actorMembershipId: CREATOR, actorSlackUserId: CREATOR_SLACK,
    keepPendingUntilInSlack: true,
  });
  f.slack.channel('COLD', { archived: true, members: [CREATOR_SLACK] });

  await addToSlack(f.owner, 'agent_new');
  assert.equal((await grantOf(f.owner, 'CSALES'))?.status, 'active');
  assert.equal(await grantOf(f.owner, 'COLD'), undefined, "an archived Channel's wait is dropped");
  assert.deepEqual([f.slack.joined, [...f.slack.appBotIn]], [[], []], 'nobody joins a private Channel by themselves');
  assert.match(f.owner.texts.at(-1)!, /In <#CSALES> it keeps answering through Chickpea until someone there adds it\./);
  assert.equal(f.owner.texts.at(-1)!.includes('COLD'), false);
});

// Defects caught: a wait made active in a private Channel Chickpea's bot has since been removed from, where nothing
// answers, with the Owner told the Agent answers through Chickpea there.
test("after Allow, a creator's private Channel Chickpea's bot is no longer in stays waiting and is not named", async (t) => {
  const f = await ownAppWorkspace(t);
  await newbieAskingForSales(f, { private: true, members: [CREATOR_SLACK, 'UBOT'] });
  f.slack.channel('CSALES', { private: true, members: [CREATOR_SLACK] });

  await addToSlack(f.owner, 'agent_new');
  assert.equal((await grantOf(f.owner, 'CSALES'))?.status, 'pending');
  assert.equal(f.owner.texts.at(-1)!.includes('CSALES'), false);
});

// Defects caught: back to shared choosing Agents by a marker; the creator's Channel left pending for good; a reconcile
// that stopped partway never repaired; the setting route answering nothing about who still waits.
test('back to shared, each Agent in Slack nowhere gets a group and its creator’s Channel; apps and the token stay', async (t) => {
  const f = await ownAppWorkspace(t);
  await newbieAskingForSales(f);
  // A reconcile that failed once (here a taken handle elsewhere) must not hide an Agent from the next press.
  await f.owner.config.createAgent(agent('agent_lost', 'Lost', { ...notInSlack('lost'), errorCode: 'rate_limited', health: 'needs_attention' }));
  f.slack.groups.push({ id: 'S_TAKEN', name: 'Taken', handle: 'taken', disabled: false });
  await f.owner.config.createAgent(agent('agent_taken', 'Taken', notInSlack('taken')));
  const live = ownApp('own', { state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOT9', installedAt: NOW, installedBy: OWNER });
  const own = (await f.owner.config.createAgent(agent('agent_own', 'Own', live))).slackPresence;

  const off = await f.owner.request(`${API}/mode`, f.owner.json('PUT', { mode: 'shared' }));
  assert.equal(off.status, 200);
  const body = await off.json() as { setting: { mode: string }; waiting: Array<{ id: string; slack: unknown }> };
  assert.equal(body.setting.mode, 'shared');
  assert.deepEqual(body.waiting.map((row) => [row.id, row.slack]), [['agent_taken', { state: 'not_in_slack' }]], 'the press says who still waits');
  assert.deepEqual(f.slack.created.sort(), ['lost', 'newbie']);
  assert.ok((await f.owner.config.getAgent('agent_new')).slackPresence?.userGroupId);
  assert.equal((await grantOf(f.owner, 'CSALES'))?.status, 'active', "Ada's Channel ends as her add at creation would have");
  assert.deepEqual(f.slack.joined, ['CSALES']);
  assert.deepEqual((await f.owner.config.getAgent('agent_own')).slackPresence, own, 'an Agent with a live app keeps it');
  assert.equal((await (await f.owner.request(API)).json() as { token: { stored: boolean } }).token.stored, true, 'the token stays');

  // The handle is freed in Slack; pressing again, unchanged, repairs what the first press could not.
  f.slack.groups.splice(f.slack.groups.findIndex((group) => group.id === 'S_TAKEN'), 1);
  const again = await f.owner.request(`${API}/mode`, f.owner.json('PUT', { mode: 'shared' }));
  assert.deepEqual((await again.json() as { waiting: unknown[] }).waiting, []);
  assert.ok((await f.owner.config.getAgent('agent_taken')).slackPresence?.userGroupId);
});

// Defects caught (finding 1): back in `shared` mode, an Agent whose group Slack refused was still kept waiting with no
// failure recorded, so Admin showed no cause and no recovery, and a taken handle offered no suggestions.
test('back to shared, a group Slack refuses is recorded on the Agent with its cause and suggestions, as for any Agent', async (t) => {
  const f = await ownAppWorkspace(t);
  f.slack.groups.push({ id: 'S_TAKEN', name: 'Taken', handle: 'taken', disabled: false });
  await f.owner.config.createAgent(agent('agent_taken', 'Taken', notInSlack('taken')));
  await f.owner.presence().retry('agent_taken').catch(() => undefined);
  assert.equal((await f.owner.config.getAgent('agent_taken')).slackPresence?.errorCode, AWAITING_OWN_APP, 'while each Agent is its own app, it waits');

  await f.owner.request(`${API}/mode`, f.owner.json('PUT', { mode: 'shared' }));

  const taken = await f.owner.config.getAgent('agent_taken');
  assert.equal(taken.lifecycle, 'needs_attention');
  assert.equal(taken.slackPresence?.health, 'needs_attention');
  assert.equal(taken.slackPresence?.errorCode, 'handle_collision');
  assert.match(taken.slackPresence?.errorDetail ?? '', /@taken is already in use/);
  assert.ok((taken.slackPresence?.handleSuggestions ?? []).length > 0, 'the taken handle carries its suggestions');
});

// Defects caught: a Start whose write lands after the flip listed the Agent ending with the group and the app record but
// the creator's Channel never active, because the switch then sees a released group.
test('a Start that lands while back to shared is reconciling still ends with the creator’s Channel active', async (t) => {
  const f = await ownAppWorkspace(t);
  await newbieAskingForSales(f);
  const list = f.owner.service.userAgents.bind(f.owner.service);
  let pressed = false;
  f.owner.service.userAgents = async () => {
    const listed = await list();
    if (!pressed) {
      pressed = true;
      assert.equal((await f.owner.service.start('agent_new', OWNER)).kind, 'started', "the Owner's Start lands after the list");
    }
    return listed;
  };
  assert.equal((await f.owner.request(`${API}/mode`, f.owner.json('PUT', { mode: 'shared' }))).status, 200);
  const both = (await f.owner.config.getAgent('agent_new')).slackPresence;
  assert.ok(both?.userGroupId, 'the group answers meanwhile');
  assert.equal(both?.app?.state, 'awaiting_consent');
  assert.equal((await grantOf(f.owner, 'CSALES'))?.status, 'active');

  await allowAndSwitch(f.owner, 'agent_new', (await (await f.owner.request(`${API}/agents/agent_new/start`, f.owner.json('POST', {}))).json() as { authorizeUrl: string }).authorizeUrl);
  assert.equal((await grantOf(f.owner, 'CSALES'))?.status, 'active');
  assert.ok(f.slack.appBotIn.has('CSALES'));
});

// Defects caught: an Agent skipped by back to shared because its app was on its way, then cancelled, left with no group.
test('a Cancel that finishes after the workspace went back to shared gives the Agent its group and its creator’s Channel', async (t) => {
  const f = await ownAppWorkspace(t);
  await newbieAskingForSales(f);
  const started = await f.owner.request(`${API}/agents/agent_new/start`, f.owner.json('POST', {}));
  assert.equal(started.status, 200);
  const off = await f.owner.request(`${API}/mode`, f.owner.json('PUT', { mode: 'shared' }));
  assert.deepEqual((await off.json() as { waiting: unknown[] }).waiting, [], 'an Agent whose app is on its way is not in Slack nowhere');
  assert.deepEqual(f.slack.created, []);

  assert.equal((await f.owner.request(`${API}/agents/agent_new/cancel`, f.owner.json('POST', {}))).status, 200);
  const after = (await f.owner.config.getAgent('agent_new')).slackPresence;
  assert.ok(after?.userGroupId, 'the Cancel ends with the Agent in Slack through its group');
  assert.equal(after?.app, undefined);
  assert.equal((await grantOf(f.owner, 'CSALES'))?.status, 'active');
});

// Defects caught: Admin's Channel add for an Agent not in Slack yet answered with a Retry that cannot work, or writing
// a pending grant; Admin's restore of an Agent with no group archiving it again, or answering a restore that happened
// as a failure.
test("Admin refuses a Channel add for an Agent not in Slack yet with nothing to retry, and a restore leaves one not in Slack yet", async (t) => {
  const f = await ownAppWorkspace(t);
  f.slack.channel('CSALES', { members: [OWNER] });
  await f.owner.config.createAgent({ ...agent('agent_new', 'Newbie', notInSlack('newbie')), model: 'local-stub/newbie' });
  const added = await f.owner.request('/admin/api/agents/agent_new/channels', f.owner.json('POST', { workspaceId: TEAM, channelId: 'CSALES' }));
  assert.equal(added.status, 409);
  const body = await added.json() as { error: string; message: string; recovery: Record<string, unknown> };
  assert.equal(body.error, 'not_in_slack_yet');
  assert.equal(body.message, "Newbie isn't in Slack yet. A workspace Owner needs to add it first.");
  assert.deepEqual(body.recovery, {
    title: "Newbie isn't in Slack yet",
    explanation: "Newbie isn't in Slack yet. A workspace Owner needs to add it first.",
    steps: ['Ask a workspace Owner to add it to Slack, then add it to the Channel.'],
    actionKind: 'none',
  });
  assert.deepEqual(await f.owner.config.listAgentChannelGrants(), []);

  // Its handle is taken in Slack meanwhile: a restore that asked Slack for a group would fail on it.
  f.slack.groups.push({ id: 'S_TAKEN', name: 'Taken', handle: 'taken', disabled: false });
  const old = await f.owner.config.createAgent({
    ...agent('agent_old', 'Taken', { requestedHandle: 'taken', normalizedHandle: 'taken', desiredState: 'disabled', health: 'unpublished', avatar: AVATAR }),
    model: 'local-stub/old',
  });
  const archived = await f.owner.config.archiveAgent(old.id, { expectedRevision: old.revision, expectedCredentialIncarnation: old.credentialIncarnation! });
  const restored = await f.owner.request('/admin/api/agents/agent_old/restore', f.owner.json('POST', { expectedRevision: archived.revision }));
  assert.equal(restored.status, 200, await restored.clone().text());
  const back = await f.owner.config.getAgent('agent_old');
  assert.equal(back.lifecycle, 'active', 'the restore stands, and is not archived again');
  assert.deepEqual([back.slackPresence?.errorCode, back.slackPresence?.desiredState], [AWAITING_OWN_APP, 'active'], 'it is not in Slack yet');
});

// Defects caught: a resumed create Slack refused for the app limit answered 202 creating for an Agent nothing creates.
test('a Start that resumes a stopped record and meets the app limit answers app_limit, with nothing left behind', async (t) => {
  const owner = await adminApp(t);
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  owner.script.createRefusal = 'internal_error';
  const first = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(first.status, 409);
  assert.equal((await first.json() as { error: string }).error, 'needs_attention');

  owner.script.createRefusal = 'managed_app_limit_reached';
  const second = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: 'app_limit' });
  assert.equal((await owner.config.getAgent('agent_support')).slackPresence?.app, undefined, 'no record is left');
  assert.equal(owner.script.created, 0);
});

/** Start for agent_support with a stored token, up to Allow. */
async function waitingForAllow(owner: Awaited<ReturnType<typeof adminApp>>): Promise<string> {
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  const started = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(started.status, 200);
  return (await started.json() as { authorizeUrl: string }).authorizeUrl;
}

test('an Allow that lands between Cancel reading the Agent and writing it wins: the app stays live and nothing is deleted', async (t) => {
  const owner = await adminApp(t);
  const authorizeUrl = await waitingForAllow(owner);
  owner.script.exchange = async () => ({
    botToken: 'xoxb-agent-1', botUserId: 'UBOT1', teamId: TEAM, appId: 'A0APP1', installerUserId: OWNER, scopes: [...AGENT_APP_BOT_SCOPES],
  });

  // The Allow completes after Cancel read the Agent and just before Cancel's first write of it.
  const { config } = owner;
  const write = config.updateAgent.bind(config);
  let allowed: AgentSlackPresence | undefined;
  let allowing = false;
  config.updateAgent = async (...args: Parameters<typeof config.updateAgent>) => {
    if (!allowed && !allowing) {
      allowing = true;
      const callback = new URLSearchParams({ code: 'code-1', state: new URL(authorizeUrl).searchParams.get('state')! });
      const done = await owner.service.completeConsent(callback, OWNER);
      assert.equal(done.status, 303, 'the Allow went through');
      allowed = (await config.getAgent('agent_support')).slackPresence;
    }
    return write(...args);
  };
  const cancelled = await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
  assert.equal(cancelled.status, 409);
  assert.deepEqual(await cancelled.json(), { error: 'not_waiting' });
  assert.deepEqual(owner.script.deleted, [], 'no apps.manifest.delete');
  const after = (await owner.config.getAgent('agent_support')).slackPresence;
  assert.equal(after?.kind, 'agent_app');
  assert.equal(after?.app?.state, 'active');
  assert.deepEqual(after, allowed, "the Agent's presence is as the Allow left it");
});

test("Cancel never applies to an app that holds the Agent's handle, even one waiting for Allow again", async (t) => {
  const owner = await adminApp(t);
  await waitingForAllow(owner);
  const { config } = owner;
  const waiting = (await config.getAgent('agent_support')).slackPresence!;
  // Between Cancel's read and its write, the Agent's own app went live, Slack removed it, and an Owner chose Allow again.
  const allowedAgain = ownApp('support', waiting.app!);
  const write = config.updateAgent.bind(config);
  let moved: AgentSlackPresence | undefined;
  config.updateAgent = async (...args: Parameters<typeof config.updateAgent>) => {
    if (!moved) {
      const current = await config.getAgent('agent_support');
      moved = (await write('agent_support', { slackPresence: allowedAgain }, current.revision)).slackPresence;
    }
    return write(...args);
  };
  const cancelled = await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
  assert.equal(cancelled.status, 409);
  assert.deepEqual(await cancelled.json(), { error: 'not_waiting' });
  assert.deepEqual(owner.script.deleted, []);
  assert.equal(moved?.kind, 'agent_app');
  assert.deepEqual((await config.getAgent('agent_support')).slackPresence, moved);
});

test('a Start that Slack left partway is resumed by the next press, which still creates one app', async (t) => {
  const owner = await adminApp(t);
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  owner.script.update = 'unanswered';
  const first = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(first.status, 202);
  assert.deepEqual((await first.json() as { agent: { slack: unknown } }).agent.slack, { state: 'creating' });
  assert.equal((await owner.config.getAgent('agent_support')).slackPresence?.app?.state, 'created');

  owner.script.update = undefined;
  const second = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(second.status, 200, 'the record goes on from where it stopped');
  const body = await second.json() as { next: string; agent: { slack: unknown } };
  assert.equal(body.next, 'authorize');
  assert.deepEqual(body.agent.slack, { state: 'waiting_for_allow' });
  assert.equal(owner.script.created, 1, 'two presses, one app');
});

test("a Cancel Slack left partway reads as cancelling, the group keeps answering, and the next Cancel finishes it", async (t) => {
  const owner = await adminApp(t);
  const before = (await owner.config.getAgent('agent_support')).slackPresence;
  await waitingForAllow(owner);
  owner.script.delete = 'unanswered';
  const first = await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: 'slack_unavailable' });
  const listed = await (await owner.request(API)).json() as { agents: Array<{ id: string; slack: unknown }> };
  assert.deepEqual(listed.agents.find((row) => row.id === 'agent_support')?.slack, { state: 'cancelling' });
  const pending = (await owner.config.getAgent('agent_support')).slackPresence;
  assert.equal(pending?.userGroupId, 'S_support');
  assert.equal(pending?.desiredState, 'active', 'the group keeps answering');

  owner.script.delete = undefined;
  const second = await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { agent: (await (await owner.request(API)).json() as { agents: unknown[] }).agents[0], app: 'deleted' });
  assert.deepEqual(owner.script.deleted, ['A0APP1']);
  assert.deepEqual((await owner.config.getAgent('agent_support')).slackPresence, before);
});

test('a Start on an unfinished Cancel finishes the removal and creates nothing', async (t) => {
  const owner = await adminApp(t);
  await waitingForAllow(owner);
  owner.script.delete = 'unanswered';
  assert.equal((await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}))).status, 503);

  const stillDown = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(stillDown.status, 409);
  assert.deepEqual(await stillDown.json(), { error: 'cancelling', agent: (await (await owner.request(API)).json() as { agents: unknown[] }).agents[0] });

  owner.script.delete = undefined;
  const finished = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(finished.status, 409);
  const body = await finished.json() as { error: string; agent: { slack: unknown } };
  assert.equal(body.error, 'cancelling');
  assert.deepEqual(body.agent.slack, { state: 'user_group' }, 'the state the press reached');
  assert.deepEqual(owner.script.deleted, ['A0APP1']);
  assert.equal(owner.script.created, 1, 'no new app');
  assert.equal((await owner.config.getAgent('agent_support')).slackPresence?.app, undefined);
});

test("Cancel says when the app was left for the Owner to delete; a Cancel finished later never sends the archive message", async (t) => {
  const left = await adminApp(t);
  await waitingForAllow(left);
  left.script.delete = 'refused';
  const cancelled = await left.request(`${API}/agents/agent_support/cancel`, left.json('POST', {}));
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json() as { app: string }).app, 'left_for_owner');
  assert.match(left.texts.at(-1)!, /keeps answering as it did before/);

  const later = await adminApp(t);
  await waitingForAllow(later);
  later.script.delete = 'unanswered';
  assert.equal((await later.request(`${API}/agents/agent_support/cancel`, later.json('POST', {}))).status, 503);
  later.script.delete = 'refused';
  // The Home tab's Finish removing, a later run than the Cancel's.
  await later.service.retry('agent_support', OWNER);
  assert.equal((await later.config.getAgent('agent_support')).slackPresence?.app, undefined);
  const told = later.texts.at(-1)!;
  assert.match(told, /keeps answering as it did before/);
  assert.equal(/archived/.test(told), false, 'the Agent is not archived, and the message never says so');
});

// Defects caught: a Cancel whose uninstall Slack refused sent the archive message, its next Cancel answered not_waiting,
// and a Start that finished it answered that an app was being created.
test('a Cancel whose uninstall Slack refuses stays a Cancel: never "archived", picked up by the next Cancel, and Start answers cancelling', async (t) => {
  const owner = await adminApp(t);
  await waitingForAllow(owner);
  // An Allow stored the app's bot token and did not commit: removing the app now starts with its uninstall.
  const stored = await readAppSecrets(owner.secrets, 'A0APP1');
  await writeAppSecrets(owner.secrets, 'A0APP1', 'agent_support', { ...stored!.secrets, botToken: 'xoxb-half-allowed' }, stored!.revision);
  owner.script.uninstall = 'refused';
  owner.script.delete = undefined;

  const cancelled = await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
  assert.equal(cancelled.status, 503);
  const listed = async () => (await (await owner.request(API)).json() as { agents: Array<{ id: string; slack: unknown }> })
    .agents.find((row) => row.id === 'agent_support')?.slack;
  assert.deepEqual(await listed(), { state: 'cancelling' });
  assert.match(owner.texts.at(-1)!, /^Chickpea couldn(&#39;|')t finish removing the Slack app it made for Support\. Choose Try again in a minute\. Support keeps answering as it did before\.$/);

  const started = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(started.status, 409);
  assert.equal((await started.json() as { error: string }).error, 'cancelling');
  assert.equal(owner.script.created, 1, 'nothing new is created');

  owner.script.uninstall = 'answered';
  const again = await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
  assert.equal(again.status, 200, 'the next Cancel picks the removal up');
  assert.deepEqual(owner.script.deleted, ['A0APP1']);
  assert.equal((await owner.config.getAgent('agent_support')).slackPresence?.app, undefined);
  assert.equal(owner.texts.some((text) => /archived/.test(text)), false, 'no message says archived');
});

test("the Home tab's row for an unfinished Cancel says removing stopped partway, with a button that finishes it", async (t) => {
  const owner = await adminApp(t);
  await waitingForAllow(owner);
  owner.script.delete = 'unanswered';
  assert.equal((await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}))).status, 503);
  const agentNow = await owner.config.getAgent('agent_support');
  const fresh = JSON.stringify((await owner.service.homeRows([agentNow], { role: 'owner' })).get('agent_support')).replaceAll('\u2060', '');
  assert.match(fresh, /Removing the Slack app Chickpea made for @support\./);
  assert.equal(fresh.includes('Setting up'), false);

  owner.script.now = NOW + 3 * 60_000;
  const row = (await owner.service.homeRows([agentNow], { role: 'owner' })).get('agent_support') as Array<Record<string, any>>;
  assert.equal(row[0]!.elements[0].text.replaceAll('\u2060', ''), 'Removing the Slack app Chickpea made for @support stopped partway.');
  assert.equal(row[1]!.elements[0].text.text, 'Finish removing');
  assert.equal(row[1]!.elements[0].action_id, FINISH_APP_ACTION);
  assert.equal(row[1]!.elements[0].value, 'agent_support');
});

test('each change is recorded once with its outcome and never a token; a failed record never fails the request', async (t) => {
  const owner = await adminApp(t);
  await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'own_app' }));
  await waitingForAllow(owner);
  await owner.request(`${API}/agents/agent_support/cancel`, owner.json('POST', {}));
  await owner.request(`${API}/token`, owner.json('DELETE'));
  assert.deepEqual(owner.audits().map((audit) => [audit.action, audit.reasonCode, audit.outcome, audit.userId, audit.membershipId]), [
    ['agent_apps.mode_changed', 'own_app', 'success', 'user_owner', 'membership_owner'],
    ['agent_apps.token_pasted', undefined, 'success', 'user_owner', 'membership_owner'],
    ['agent_apps.started', 'authorize', 'success', 'user_owner', 'membership_owner'],
    ['agent_apps.cancelled', 'deleted', 'success', 'user_owner', 'membership_owner'],
    ['agent_apps.token_removed', 'discarded', 'success', 'user_owner', 'membership_owner'],
  ]);
  const recorded = JSON.stringify(owner.audits());
  for (const secret of [PASTED, 'xoxe-1-rotated', 'xoxe.xoxp-1-access', 'xoxe-1']) assert.equal(recorded.includes(secret), false);

  owner.script.auditFails = true;
  const { result, lines } = await consoleLines(async () => owner.request(`${API}/mode`, owner.json('PUT', { mode: 'shared' })));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { setting: { mode: 'shared', changedBy: OWNER, changedAt: NOW }, waiting: [] });
  assert.match(lines, /"event":"audit_unavailable"/);
  assert.match(lines, /"action":"agent_apps.mode_changed"/);
});

test('a stored token that cannot be opened makes Start ask for a token at once, with no record and no Slack message', async (t) => {
  const owner = await adminApp(t);
  const elsewhere: SecretDeps = {
    credentials: owner.settings, keyring: generateCredentialKeyring('another-key'), now: () => NOW,
    slack: { rotate: async () => ({ accessToken: 'xoxe.xoxp-1-x', refreshToken: 'xoxe-1-x-0000', teamId: TEAM, expiresAt: NOW + 12 * 3_600_000 }) },
  };
  assert.equal(await saveConfigurationToken(elsewhere, TEAM, PASTED), 'saved');
  const before = (await owner.config.getAgent('agent_support')).slackPresence;
  const started = await owner.request(`${API}/agents/agent_support/start`, owner.json('POST', {}));
  assert.equal(started.status, 409);
  assert.deepEqual(await started.json(), { error: 'token_needed' });
  assert.deepEqual((await owner.config.getAgent('agent_support')).slackPresence, before);
  assert.deepEqual(owner.calls, []);
  assert.equal(owner.script.created, 0);
});
