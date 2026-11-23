import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { AgentAppLifecycle, CustomAgentConfig } from '../src/config/types.ts';
import type { AgentSlackAppsHost } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, type AgentAppTransport } from '../src/slack/agent-apps/service.ts';
import { readAppSecrets, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { type AgentAppSwitchJob, CONSENT_TTL_MS } from '../src/slack/agent-apps/service.ts';
import { type AgentAppGrant, type AgentAppSlackApi, SlackRefused, SlackUnavailable } from '../src/slack/agent-apps/slack-api.ts';
import { sha256Hex } from '../src/security/digest.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { captureSlackRefusals } from './helpers/agent-app-refusals.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const OWNER = 'UOWNER';
const APP = { appId: 'A0APP1', clientId: '1.client' };
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });

class FakeSlack implements AgentAppSlackApi {
  exchanges: Array<{ clientId: string; clientSecret: string; code: string; redirectUri: string }> = [];
  uninstalls = 0;
  grant: Partial<AgentAppGrant> = {};
  fail: Error | undefined;
  refuseUninstall: SlackRefused | undefined;
  async rotate(): Promise<never> { throw new Error('not in this unit'); }
  async create(): Promise<never> { throw new Error('not in this unit'); }
  async update(): Promise<never> { throw new Error('not in this unit'); }
  async setIcon(): Promise<never> { throw new Error('not in this unit'); }
  async exchange(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }) {
    this.exchanges.push(input);
    if (this.fail) throw this.fail;
    return {
      botToken: 'xoxb-agent', botUserId: 'UBOT', teamId: TEAM, appId: APP.appId, installerUserId: OWNER,
      scopes: [...AGENT_APP_BOT_SCOPES], ...this.grant,
    };
  }
  async uninstall() {
    this.uninstalls += 1;
    if (this.refuseUninstall) throw this.refuseUninstall;
    return 'removed' as const;
  }
  async delete(): Promise<never> { throw new Error('not in this unit'); }
}

interface Posted { channelId: string; text: string; idempotencyKey: string | undefined }

const transport = (posted: Posted[]): AgentAppTransport => ({
  async disableUserGroup(): Promise<never> { throw new Error('not in this unit'); },
  async enableUserGroup(): Promise<never> { throw new Error('not in this unit'); },
  async openDirectConversation(userId: string) { return { id: `D_${userId}`, private: true, member: true, archived: false }; },
  async postMessage(input: { channelId: string; text: string; idempotencyKey?: string }) {
    posted.push({ channelId: input.channelId, text: input.text, idempotencyKey: input.idempotencyKey });
    return { channelId: input.channelId, ts: `${posted.length}.0` };
  },
});

function waiting(startedBy = OWNER): AgentAppLifecycle {
  return { state: 'awaiting_consent', at: NOW, startedBy, app: APP, icon: 'agent_avatar', allowDm: { channelId: `D_${startedBy}`, ts: '1.0' } };
}

async function fixture(t: TestContext, app: AgentAppLifecycle = waiting()) {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  const created = await config.createAgent({
    id: 'agent_support', kind: 'user', revision: 1, name: 'Support', instructions: 'You are Support.', enabled: true,
    lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: { requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'x' }, userGroupId: 'S1' },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  } satisfies CustomAgentConfig);
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: created.id, runtimeContract: 'chickpea-v1' });
  await config.updateAgent(created.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'pending',
      avatar: created.slackPresence!.avatar, app, released: { userGroupId: 'S1' },
    },
  }, created.revision);
  const keyring = generateCredentialKeyring('k1');
  const slack = new FakeSlack();
  const secrets = { credentials: settings, keyring, slack };
  await writeAppSecrets(secrets, APP.appId, created.id, { clientSecret: 'client-secret-1', signingSecret: 'signing-secret-1' }, null);
  const posted: Posted[] = [];
  const clock = { now: NOW };
  const armed: AgentAppSwitchJob[] = [];
  const service = new AgentSlackApps({
    env: ENV, stores: { config, settings }, host: HOST, transport: transport(posted), slack, keyring, now: () => clock.now,
    armSwitch: async (job) => { armed.push(job); },
  });
  return { config, settings, secrets, slack, posted, clock, service, armed };
}

/** The sentence on a notice page, with its HTML entities decoded. */
function pageText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function appOf(config: SqliteConfigStore): Promise<AgentAppLifecycle | undefined> {
  const presence = (await config.getAgent('agent_support')).slackPresence;
  return presence?.kind === 'agent_app' ? presence.app : undefined;
}

/** Opens Allow as `owner` and returns the state Slack would send back. */
async function open(f: Awaited<ReturnType<typeof fixture>>, owner = OWNER): Promise<string> {
  const response = await f.service.allow('agent_support', owner);
  assert.equal(response.status, 303);
  const url = new URL(response.headers.get('location')!);
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), APP.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), HOST.redirectUri);
  assert.equal(url.searchParams.get('scope'), AGENT_APP_BOT_SCOPES.join(','));
  return url.searchParams.get('state')!;
}

test('Allow records a fresh consent and sends the Owner to Slack; the nonce never lands in the record', async (t) => {
  const f = await fixture(t);
  const state = await open(f);
  const app = await appOf(f.config);
  assert.equal(app?.state, 'awaiting_consent');
  const consents = app?.state === 'awaiting_consent' ? app.consents : undefined;
  assert.deepEqual(Object.keys(consents ?? {}), [OWNER]);
  assert.equal(consents?.[OWNER]?.expiresAt, NOW + CONSENT_TTL_MS);
  assert.equal(JSON.stringify(app).includes(state.split('.')[1]!), false, 'only a digest of the nonce is stored');
  const again = await open(f);
  assert.notEqual(again, state, 'opening Allow again replaces the nonce');
});

test('a valid callback activates the app, stores the bot token, arms the switch, and sends the Owner to the Agent', async (t) => {
  const f = await fixture(t);
  const state = await open(f);
  const response = await f.service.completeConsent(new URLSearchParams({ code: 'code-1', state }), OWNER);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `https://slack.com/app_redirect?app=${APP.appId}&team=${TEAM}`);
  assert.deepEqual(f.slack.exchanges, [{ clientId: APP.clientId, clientSecret: 'client-secret-1', code: 'code-1', redirectUri: HOST.redirectUri }]);
  const app = await appOf(f.config);
  assert.equal(app?.state, 'active');
  assert.equal(app?.state === 'active' && app.botUserId, 'UBOT');
  assert.equal(app?.state === 'active' && app.installedBy, OWNER);
  assert.equal((await readAppSecrets(f.secrets, APP.appId))?.secrets.botToken, 'xoxb-agent');
  assert.equal(app?.state === 'active' && app.switchProgress, 'group_pending', 'the switch is left to its job');
  assert.deepEqual(f.posted, [], 'the callback tells nobody: the switch job does, once it is done');
  assert.deepEqual(f.armed, [{ agentId: 'agent_support', appId: APP.appId, installedAt: NOW, teamId: TEAM, ownerSlackUserId: OWNER }]);
  const presence = (await f.config.getAgent('agent_support')).slackPresence;
  assert.equal(presence?.health, 'healthy');
  assert.equal(presence?.desiredState, 'active');

  const replay = await f.service.completeConsent(new URLSearchParams({ code: 'code-1', state }), OWNER);
  assert.equal(replay.status, 409);
  assert.equal(f.slack.exchanges.length, 1, 'a replay exchanges nothing');
  assert.deepEqual(f.posted, [], 'a replay posts nothing');
  assert.equal(f.armed.length, 1, 'and arms nothing');
});

test('a bad, expired or reused state, another Owner, or a cancelled grant are refused before any exchange', async (t) => {
  const f = await fixture(t);
  const state = await open(f);
  const refused = async (query: Record<string, string>, owner: string, status: number) => {
    const response = await f.service.completeConsent(new URLSearchParams(query), owner);
    assert.equal(response.status, status, JSON.stringify(query));
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    return pageText(await response.text());
  };
  /** The page's one paragraph is the whole sentence, with a tag's space on each side. */
  const says = (page: string, sentence: string) => assert.ok(page.includes(` ${sentence} `), page);
  const nameless = 'That link has expired. Open your messages with Chickpea and choose Allow again.';
  says(await refused({ code: 'c', state: 'garbage' }, OWNER, 410), nameless);
  says(
    await refused({ code: 'c', state: `agent_support.${crypto.randomUUID()}` }, OWNER, 410),
    'That link has expired. Choose Allow Support in Slack again from your messages with Chickpea.',
  );
  says(await refused({ code: 'c', state: `agent_other.${state.split('.')[1]}` }, OWNER, 410), nameless);
  assert.match(await refused({ code: 'c', state }, 'UOWNER2', 403), /Only the Owner who started this can finish it/);
  f.clock.now = NOW + CONSENT_TTL_MS;
  assert.match(await refused({ code: 'c', state }, OWNER, 410), /That link has expired/);
  f.clock.now = NOW;
  assert.deepEqual(f.slack.exchanges, []);

  assert.match(await refused({ error: 'access_denied', state }, OWNER, 200), /Support wasn't added/);
  const app = await appOf(f.config);
  assert.equal(app?.state === 'awaiting_consent' && app.consents, undefined, 'a cancelled grant clears the consent');
  assert.match(await refused({ code: 'c', state }, OWNER, 410), /That link has expired/, 'the cleared consent cannot be reused');
  assert.deepEqual(f.slack.exchanges, []);
  assert.equal(f.posted.length, 0);
});

test('a grant for the wrong workspace, app or person, or with missing permissions, is undone', async (t) => {
  for (const [grant, status, pattern] of [
    [{ teamId: 'TOTHER' }, 409, /different Slack workspace/],
    [{ appId: 'A0OTHER' }, 403, /Only the Owner who started this/],
    [{ installerUserId: 'UMEMBER' }, 403, /Only the Owner who started this/],
    [{ scopes: AGENT_APP_BOT_SCOPES.slice(1) }, 409, /needs every permission it asked for/],
  ] as const) {
    const f = await fixture(t);
    f.slack.grant = grant;
    const state = await open(f);
    const response = await f.service.completeConsent(new URLSearchParams({ code: 'c', state }), OWNER);
    assert.equal(response.status, status, JSON.stringify(grant));
    assert.match(pageText(await response.text()), pattern);
    assert.equal(f.slack.uninstalls, 1, `the grant is undone for ${JSON.stringify(grant)}`);
    const app = await appOf(f.config);
    assert.equal(app?.state, 'awaiting_consent');
    assert.equal(app?.state === 'awaiting_consent' && app.consents, undefined);
    assert.equal((await readAppSecrets(f.secrets, APP.appId))?.secrets.botToken, undefined, 'no bot token is kept');
    assert.equal(f.posted.length, 0);
  }
});

test('a grant missing only channels:join, as from an app made before Chickpea asked for it, is kept; missing anything more is undone', async (t) => {
  const withoutJoin = AGENT_APP_BOT_SCOPES.filter((scope) => scope !== 'channels:join');
  const older = await fixture(t);
  older.slack.grant = { scopes: withoutJoin };
  const response = await older.service.completeConsent(new URLSearchParams({ code: 'c', state: await open(older) }), OWNER);
  assert.equal(response.status, 303);
  assert.equal(older.slack.uninstalls, 0, 'the grant stands');
  assert.equal((await appOf(older.config))?.state, 'active');
  assert.equal((await readAppSecrets(older.secrets, APP.appId))?.secrets.botToken, 'xoxb-agent');

  const less = await fixture(t);
  less.slack.grant = { scopes: withoutJoin.slice(1) };
  const refused = await less.service.completeConsent(new URLSearchParams({ code: 'c', state: await open(less) }), OWNER);
  assert.equal(refused.status, 409);
  assert.match(pageText(await refused.text()), /needs every permission it asked for/);
  assert.equal(less.slack.uninstalls, 1);
});

test('an undo Slack refuses is logged, and the Owner still gets the page', async (t) => {
  const refusals = captureSlackRefusals(t);
  const f = await fixture(t);
  f.slack.grant = { teamId: 'TOTHER' };
  f.slack.refuseUninstall = new SlackRefused('apps.uninstall', 'invalid_client_id');
  const state = await open(f);
  const response = await f.service.completeConsent(new URLSearchParams({ code: 'c', state }), OWNER);
  assert.match(pageText(await response.text()), /different Slack workspace/);
  assert.deepEqual(refusals.map(({ step, agentId, appId, code }) => ({ step, agentId, appId, code })), [
    { step: 'uninstall', agentId: 'agent_support', appId: APP.appId, code: 'invalid_client_id' },
  ]);
});

test("Slack refusing the code expires the link, and Slack not answering says so", async (t) => {
  const refusals = captureSlackRefusals(t);
  const refused = await fixture(t);
  refused.slack.fail = new SlackRefused('oauth.v2.access', 'invalid_code');
  const state = await open(refused);
  assert.equal((await refused.service.completeConsent(new URLSearchParams({ code: 'c', state }), OWNER)).status, 410);
  assert.deepEqual(refusals.map(({ step, agentId, appId, code }) => ({ step, agentId, appId, code })), [
    { step: 'exchange', agentId: 'agent_support', appId: APP.appId, code: 'invalid_code' },
  ]);
  const down = await fixture(t);
  down.slack.fail = new SlackUnavailable('oauth.v2.access', 'network_error');
  const downState = await open(down);
  const response = await down.service.completeConsent(new URLSearchParams({ code: 'c', state: downState }), OWNER);
  assert.equal(response.status, 503);
  assert.match(pageText(await response.text()), /Slack didn't answer/);
  assert.equal((await appOf(down.config))?.state, 'awaiting_consent');
});

test("app secrets that can't be opened answer the callback with the expired page, logged for the operator, and exchange nothing", async (t) => {
  const f = await fixture(t);
  const state = await open(f);
  const rekeyed = new AgentSlackApps({
    env: ENV, stores: { config: f.config, settings: f.settings }, host: HOST, transport: transport(f.posted), slack: f.slack,
    keyring: generateCredentialKeyring('k2'), now: () => f.clock.now, armSwitch: async () => undefined,
  });
  const warn = t.mock.method(console, 'warn', () => undefined);
  const response = await rekeyed.completeConsent(new URLSearchParams({ code: 'c', state }), OWNER);
  assert.equal(response.status, 410);
  assert.match(pageText(await response.text()), /That link has expired\. Choose Allow Support in Slack again/);
  assert.deepEqual(f.slack.exchanges, []);
  assert.equal((await appOf(f.config))?.state, 'awaiting_consent');
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [`[chickpea] agent_app_secrets_unreadable {"appId":"${APP.appId}"}`]);
});

test("a callback for an app whose record names another Agent exchanges nothing, keeps that record, and answers with the expired page", async (t) => {
  const f = await fixture(t);
  const state = await open(f);
  const stored = await readAppSecrets(f.secrets, APP.appId);
  assert.ok(stored);
  await writeAppSecrets(f.secrets, APP.appId, 'agent_other', stored.secrets, stored.revision);
  const warn = t.mock.method(console, 'warn', () => undefined);
  const response = await f.service.completeConsent(new URLSearchParams({ code: 'c', state }), OWNER);
  assert.equal(response.status, 410);
  assert.deepEqual(f.slack.exchanges, []);
  assert.equal((await readAppSecrets(f.secrets, APP.appId))?.agentId, 'agent_other');
  assert.equal((await appOf(f.config))?.state, 'awaiting_consent');
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [{
    event: 'chickpea.agent_app.record_refused', use: 'exchange', agentId: 'agent_support', appId: APP.appId, recordAgentId: 'agent_other',
  }]);
});

test('Allow from a removed app resumes the sequence first, and an active app says so', async (t) => {
  const active = await fixture(t, { state: 'active', at: NOW, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: NOW, installedBy: OWNER });
  const response = await active.service.allow('agent_support', OWNER);
  assert.equal(response.status, 409);
  assert.match(pageText(await response.text()), /Support already has its own Slack app/);
  const notStarted = await fixture(t, { state: 'created', at: NOW, startedBy: OWNER, app: APP });
  assert.equal((await notStarted.service.allow('agent_support', OWNER)).status, 410);
});

// Defects caught: a second Owner's Allow overwriting the first Owner's open link, one Owner's cancel spending
// another's, and an expired link kept forever beside a fresh one.
test("each Owner holds one open Allow link: another Owner's open or cancel leaves it, and expired ones are dropped", async (t) => {
  const f = await fixture(t);
  const first = await open(f, OWNER);
  const second = await open(f, 'UOWNER2');
  let app = await appOf(f.config);
  assert.deepEqual(Object.keys(app?.state === 'awaiting_consent' ? app.consents ?? {} : {}).sort(), [OWNER, 'UOWNER2']);
  assert.match(pageText(await (await f.service.completeConsent(new URLSearchParams({ code: 'c', state: first }), 'UOWNER2')).text()),
    /Only the Owner who started this can finish it/, "a link is its own Owner's, even beside the other Owner's");
  const cancelled = await f.service.completeConsent(new URLSearchParams({ error: 'access_denied', state: second }), 'UOWNER2');
  assert.equal(cancelled.status, 200);
  app = await appOf(f.config);
  assert.deepEqual(Object.keys(app?.state === 'awaiting_consent' ? app.consents ?? {} : {}), [OWNER], "the other Owner's cancel spends only theirs");

  f.clock.now = NOW + CONSENT_TTL_MS;
  await open(f, 'UOWNER2');
  app = await appOf(f.config);
  assert.deepEqual(Object.keys(app?.state === 'awaiting_consent' ? app.consents ?? {} : {}), ['UOWNER2'], 'an expired link is dropped at the next open');
  assert.match(pageText(await (await f.service.completeConsent(new URLSearchParams({ code: 'c', state: first }), OWNER)).text()), /That link has expired/);
  assert.deepEqual(f.slack.exchanges, []);
});

// Defects caught: an Allow link opened before per-Owner consent, stored with the single field, no longer completing.
test('an Allow link stored with the single consent field still completes for its Owner', async (t) => {
  const nonce = crypto.randomUUID();
  const consent = { nonceDigest: await sha256Hex(nonce), owner: OWNER, expiresAt: NOW + CONSENT_TTL_MS };
  const f = await fixture(t, { ...waiting(), consent } as unknown as AgentAppLifecycle);
  const response = await f.service.completeConsent(new URLSearchParams({ code: 'code-1', state: `agent_support.${nonce}` }), OWNER);
  assert.equal(response.status, 303);
  assert.equal((await appOf(f.config))?.state, 'active');
});
