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
} from '../src/config/types.ts';
import type { IdentityStore, RecordIdentityAuthAuditInput } from '../src/identity/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { configurationTokenKey, saveConfigurationToken, type SecretDeps } from '../src/slack/agent-apps/secrets.ts';
import { AgentSlackApps } from '../src/slack/agent-apps/service.ts';
import { FINISH_APP_ACTION } from '../src/slack/agent-apps/pages.ts';
import { AGENT_SLACK_APPS_SETTING_KEY, readAgentSlackAppsSetting } from '../src/slack/agent-apps/setting.ts';
import { type AgentAppSlackApi, SlackRefused, SlackUnavailable } from '../src/slack/agent-apps/slack-api.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { refuseLikeSlack } from './helpers/slack-manifest-rules.ts';

const TOKEN = 'admin-token';
const TEAM = 'T_TEST';
const OWNER = 'UOWNER';
const NOW = 1_800_000_000_000;
const PASTED = 'xoxe-1-pasted-refresh-token-0000';
const PASTED_AGAIN = 'xoxe-1-pasted-again-token-0000';
const PASTED_THIRD = 'xoxe-1-pasted-third-token-0000';
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
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
  exchange?: AgentAppSlackApi['exchange'] | undefined;
  now: number;
  auditFails: boolean;
}

async function adminApp(t: TestContext, options: { role?: AuthPrincipal['role']; machine?: boolean; port?: boolean; permissionMissing?: boolean } = {}) {
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
    uninstall: async () => { throw new Error('unexpected uninstall'); },
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
  const service = new AgentSlackApps({
    env: HOSTED, stores: { config, settings }, host: HOST, slack, keyring: generateCredentialKeyring('k1'), armSwitch: async () => undefined,
    now: () => script.now,
    transport: {
      disableUserGroup: async (id) => { calls.push(`disable:${id}`); return { id, name: 'x', handle: 'x', disabled: true }; },
      enableUserGroup: async (id) => { calls.push(`enable:${id}`); return { id, name: 'x', handle: 'x', disabled: false }; },
      openDirectConversation: async (user) => { calls.push(`dm:${user}`); return { id: `D_${user}`, private: true, member: true, archived: false }; },
      postMessage: async (input) => { calls.push(`post:${input.channelId}`); texts.push(input.text); return { channelId: input.channelId, ts: '1.0' }; },
    },
    userGroupPermissionMissing: async () => options.permissionMissing ?? false,
  });
  configureAgentSlackApps(options.port === false ? undefined : HOST);
  const app = createAdminRoutes({
    store: config, settings,
    agentSlackApps: async () => service,
    ...testAdminAuthority(TOKEN, undefined, people(audits, () => script.auditFails), principal(options.role ?? 'owner', options.machine)),
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
  return { request, json, form, service, calls, texts, audits: ours, config, settings, script };
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
  assert.deepEqual(await off.json(), { setting: { mode: 'shared', changedBy: OWNER, changedAt: NOW + 5_000 } });
  assert.deepEqual(owner.audits().map((audit) => [audit.action, audit.reasonCode]), [
    ['agent_apps.mode_changed', 'own_app'],
    ['agent_apps.mode_changed', 'shared'],
  ], 'one record per change, none for the mode already stored');
});

test('setting the default mode on a workspace that never chose one stores nothing', async (t) => {
  const owner = await adminApp(t);
  const response = await owner.request(`${API}/mode`, owner.json('PUT', { mode: 'shared' }));
  assert.deepEqual(await response.json(), { setting: { mode: 'shared', changedBy: null, changedAt: null } });
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

test("the old token page's removal says what each removal did, and claims nothing when no token is held", async (t) => {
  const page = '/admin/api/agents/agent_support/slack-app/token';
  const sentence = async (response: Response) => /<p>([^<]*)<\/p>/.exec(await response.text())?.[1]?.replaceAll('&#39;', "'");
  const owner = await adminApp(t);
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  assert.equal(await sentence(await owner.request(page, owner.form({ action: 'remove' }))),
    'Chickpea deleted its copy of your configuration token and retired that token at Slack.');
  assert.equal(await sentence(await owner.request(page, owner.form({ action: 'remove' }))),
    'Chickpea holds no configuration token for this workspace.');

  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED_AGAIN }))).status, 200);
  owner.script.rotate = async () => { throw new SlackUnavailable('tooling.tokens.rotate', 'network_error'); };
  assert.equal(await sentence(await owner.request(page, owner.form({ action: 'remove' }))),
    "Chickpea deleted its copy of your configuration token, but Slack didn't confirm the token stopped working, so Slack may still accept it.");
  assert.equal(await sentence(await owner.request(page, owner.form({ action: 'remove' }))),
    'Chickpea holds no configuration token for this workspace.', 'a removal resubmitted after an unconfirmed one is no assurance');
  assert.deepEqual(owner.audits().map((audit) => [audit.action, audit.reasonCode]), [
    ['agent_apps.token_pasted', undefined],
    ['agent_apps.token_removed', 'discarded'],
    ['agent_apps.token_removed', 'none'],
    ['agent_apps.token_pasted', undefined],
    ['agent_apps.token_removed', 'unconfirmed'],
    ['agent_apps.token_removed', 'none'],
  ]);
});

test('a token pasted over a stored one retires the stored one at Slack before the new one is kept', async (t) => {
  const owner = await adminApp(t);
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED }))).status, 200);
  assert.equal((await owner.request(`${API}/token`, owner.json('PUT', { refreshToken: PASTED_AGAIN }))).status, 200);
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
    agent_attention: { state: 'needs_attention', reason: 'create_refused' },
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
  assert.match(url.searchParams.get('state')!, /^agent_support\.[a-f0-9-]{36}$/);
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
  assert.deepEqual(listed.agents.find((row) => row.id === 'agent_support')?.slack, { state: 'needs_attention', reason: 'config_token_needed' });
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
  assert.deepEqual(await result.json(), { setting: { mode: 'shared', changedBy: OWNER, changedAt: NOW } });
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
