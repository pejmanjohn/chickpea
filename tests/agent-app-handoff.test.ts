import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { AWAITING_OWN_APP, type AgentSlackPresence, type CustomAgentConfig, appRecordOf } from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps, withAgentSlackAppHandoff } from '../src/slack/agent-apps/host.ts';
import { createAgentSlackAppRoutes } from '../src/slack/agent-apps/routes.ts';
import { saveConfigurationToken } from '../src/slack/agent-apps/secrets.ts';
import { AgentSlackApps } from '../src/slack/agent-apps/service.ts';
import { type AgentAppSlackApi, AmbiguousEffect, SlackRefused } from '../src/slack/agent-apps/slack-api.ts';
import { writeAgentSlackAppsSetting } from '../src/slack/agent-apps/setting.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { JOURNEY_PAGE_CASES } from './helpers/journey-page-cases.ts';
import { refuseLikeSlack } from './helpers/slack-manifest-rules.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const OWNER = 'UOWNER';
const ORIGIN = 'https://core.test';
const ADD = '/channels/slack/agent-apps/add';
const HOST: AgentSlackAppsHost = {
  requestUrls: (installationId, appId) => ({
    events: `https://cloud.test/channels/slack/agent-apps/${installationId}/${appId}/tok/events`,
    interactions: `https://cloud.test/channels/slack/agent-apps/${installationId}/${appId}/tok/interactions`,
  }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
  addUrl: (agentId) => `https://cloud.test/slack/agent-apps/add/${agentId}`,
};
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });
const AS_OWNER = withAgentSlackAppHandoff(ENV, { kind: 'owner', slackUserId: OWNER });

/** Slack's app API as these tests need it, refusing what Slack refuses. */
class FakeSlack implements AgentAppSlackApi {
  created: string[] = [];
  refuseCreate: string | undefined;
  ambiguousCreate = false;
  rotations = 0;
  async rotate(refreshToken: string) {
    assert.match(refreshToken, /^xoxe-1-/);
    this.rotations += 1;
    return { accessToken: `xoxe.xoxp-1-access-${this.rotations}`, refreshToken: `xoxe-1-refresh-${this.rotations}`, teamId: TEAM, expiresAt: NOW + 12 * 3_600_000 };
  }
  async create(_token: string, manifest: Parameters<AgentAppSlackApi['create']>[1]) {
    refuseLikeSlack('apps.manifest.create', manifest);
    if (this.refuseCreate) throw new SlackRefused('apps.manifest.create', this.refuseCreate);
    if (this.ambiguousCreate) throw new AmbiguousEffect('apps.manifest.create', 'network_error');
    const n = this.created.length + 1;
    this.created.push(manifest.display_information.name);
    return { appId: `A0APP${n}`, clientId: `${n}.client`, clientSecret: `client-secret-${n}`, signingSecret: `signing-secret-${n}` };
  }
  async definedBotScopes() { return [...AGENT_APP_BOT_SCOPES]; }
  async update(_token: string, _appId: string, manifest: Parameters<AgentAppSlackApi['update']>[2]) {
    refuseLikeSlack('apps.manifest.update', manifest);
  }
  async setIcon() {}
  async exchange(input: Parameters<AgentAppSlackApi['exchange']>[0]) {
    const appId = `A0APP${input.clientId.split('.')[0]}`;
    return { botToken: 'xoxb-agent', botUserId: 'UBOTAGENT', teamId: TEAM, appId, installerUserId: OWNER, scopes: [...AGENT_APP_BOT_SCOPES] };
  }
  async uninstall() { return 'removed' as const; }
  async delete() { return 'deleted' as const; }
  async botInstalled(): Promise<never> { throw new Error('not in this unit'); }
}

interface Fixture {
  config: SqliteConfigStore;
  settings: SqliteSettingsStore;
  slack: FakeSlack;
  service: AgentSlackApps;
  posted: Array<{ channelId: string; text: string; blocks: unknown[] }>;
  /** Refuse the next N posts of Chickpea's bot, as Slack does when it limits a bot. */
  refusePosts: { count: number };
  audits: Array<[string, string]>;
  request: (path: string, init?: RequestInit, env?: object) => Promise<Response>;
}

/** An Agent not in Slack yet, waiting for its own app; `presence` replaces that where a test needs another. */
function agentConfig(id: string, name: string, handle: string, presence?: (base: AgentSlackPresence) => AgentSlackPresence): CustomAgentConfig {
  const waiting: AgentSlackPresence = {
    requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'unpublished',
    errorCode: AWAITING_OWN_APP, avatar: { kind: 'generated', revision: 1, seed: id },
  };
  return {
    id, kind: 'user', revision: 1, name, description: `${name} helps.`, instructions: `You are ${name}.`, enabled: true,
    lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: presence ? presence(waiting) : waiting,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

/** The same Agent in Slack through Chickpea's user group. */
const inGroup = (userGroupId: string) => ({ errorCode: _waiting, ...base }: AgentSlackPresence): AgentSlackPresence =>
  ({ ...base, health: 'healthy', userGroupId }) as AgentSlackPresence;

async function fixture(t: TestContext, options: { token?: boolean; placed?: string[]; adminUnknown?: boolean } = {}): Promise<Fixture> {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  configureAgentSlackApps(HOST);
  t.after(() => { config.close(); settings.close(); configureAgentSlackApps(undefined); });
  const support = await config.createAgent(agentConfig('agent_support', 'Support', 'support'));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  const slack = new FakeSlack();
  const keyring = generateCredentialKeyring('k1');
  if (options.token !== false) {
    assert.equal(await saveConfigurationToken({ credentials: settings, keyring, slack }, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  }
  const posted: Fixture['posted'] = [];
  const refusePosts = { count: 0 };
  const audits: Fixture['audits'] = [];
  const service = new AgentSlackApps({
    env: ENV, stores: { config, settings }, host: HOST, slack, keyring, now: () => NOW,
    publicOrigin: async () => options.adminUnknown ? undefined : ORIGIN, armSwitch: async () => undefined,
    memberInSlack: async (id) => ({ membershipId: id, slackUserId: id, role: 'owner' }),
    ...(options.placed ? { placeInSlack: async (agentId: string) => { options.placed!.push(agentId); } } : {}),
    transport: {
      disableUserGroup: async (id) => ({ id, name: 'x', handle: 'x', disabled: true }),
      enableUserGroup: async (id) => ({ id, name: 'x', handle: 'x', disabled: false }),
      listUserGroups: async () => [],
      updateUserGroup: async () => { throw new Error('not in this unit'); },
      lookupChannel: async () => { throw new Error('no Channels here'); },
      joinPublicChannel: async () => { throw new Error('no Channels here'); },
      channelHasMember: async () => { throw new Error('no Channels here'); },
      openDirectConversation: async (user) => ({ id: `D_${user}`, private: true, member: true, archived: false }),
      postMessage: async (input) => {
        if (refusePosts.count > 0) { refusePosts.count -= 1; throw new SlackTransportError('chat.postMessage', 'ratelimited'); }
        posted.push({ channelId: input.channelId, text: input.text, blocks: input.blocks ?? [] });
        return { channelId: input.channelId, ts: `${posted.length}.0` };
      },
    },
  });
  const app = createAgentSlackAppRoutes({
    service: async () => service,
    audit: async (_env, slackUserId, outcome) => { audits.push([slackUserId, outcome]); },
  });
  return {
    config, settings, slack, service, posted, refusePosts, audits,
    request: async (path, init = {}, env = AS_OWNER) => app.request(path, init, env),
  };
}

const press = (f: Fixture, agentId = 'agent_support', env: object = AS_OWNER) =>
  f.request(`${ADD}/${agentId}`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }, env);

/** The words on a page, without its markup, styles and scripts. */
function words(html: string): string {
  return html.replace(/<span aria-hidden="true">[^<]*<\/span>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function headline(html: string): string {
  return words(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
}

/** The page's one primary action: a gold link or button, as its label and where it goes. */
function primary(html: string): { label: string; href: string | undefined } | undefined {
  const actions = html.match(/<div class="auth-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const first = actions.match(/<(a|button) class="auth-(?:link|button)"([^>]*)>([\s\S]*?)<\/\1>/);
  if (!first) return undefined;
  return { label: words(first[3]!), href: first[2]!.match(/href="([^"]*)"/)?.[1]?.replace(/&amp;/g, '&') };
}

const appsMade = (f: Fixture) => f.slack.created.length;
const recordOf = async (f: Fixture, agentId = 'agent_support') => appRecordOf((await f.config.getAgent(agentId)).slackPresence);

// Defects caught: a link preview, a prefetch or a second open creating an app; a page that creates nothing for an
// Owner or lets anyone else see the Agent.
test('opening the hand-off page creates nothing, for an Owner, for anyone else, and opened twice', async (t) => {
  const f = await fixture(t);
  const member = withAgentSlackAppHandoff(ENV, { kind: 'delivery', agentId: 'agent_support', appId: 'A0X', signingSecret: 's' });
  for (const env of [AS_OWNER, ENV, member, AS_OWNER]) {
    await f.request(`${ADD}/agent_support`, {}, env);
  }
  assert.equal(appsMade(f), 0);
  assert.equal(await recordOf(f), undefined, 'no record is started');
  assert.deepEqual(f.posted, [], 'nobody is messaged');

  const page = await f.request(`${ADD}/agent_support`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(headline(html), 'Adding Support to Slack');
  assert.match(html, /<form id="agent-app-press" method="post">/, 'the page presses by posting to its own address');
  assert.match(html, /<div class="journey-later"><div class="auth-actions"><form id="agent-app-press"/,
    "Continue shows only after a few seconds, so a click cannot cut the page's own press short");
  assert.match(html, /\.journey-later\{animation:journey-reveal 0s 4s both\}@keyframes journey-reveal\{from\{visibility:hidden\}to\{visibility:visible\}\}/);
  const nonce = page.headers.get('content-security-policy')?.match(/'nonce-([a-f0-9]+)'/)?.[1];
  assert.ok(nonce && html.includes(`<script nonce="${nonce}">document.forms['agent-app-press'].submit();</script>`), 'and submits it by itself');
  assert.match(page.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/slack\.com https:\/\/\*\.slack\.com;/,
    "its answer may go on to Slack, and to the workspace's own address Slack redirects to");
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.deepEqual(primary(html), { label: 'Continue to Slack', href: undefined }, 'Continue is the same press');

  const nobody = await f.request(`${ADD}/agent_support`, {}, ENV);
  assert.equal(nobody.status, 403);
  const refused = await nobody.text();
  assert.equal(headline(refused), 'A workspace Owner adds Agents to Slack');
  assert.doesNotMatch(words(refused), /Support/, "anyone but an Owner learns nothing about the Agent");
  assert.doesNotMatch(refused, /<form/, 'and gets no press');
  assert.doesNotMatch(refused, /<ol class="onboarding-orientation"/, 'a page about no Agent draws no step bar');

  configureAgentSlackApps(undefined);
  assert.equal((await f.request(`${ADD}/agent_support`)).status, 404, 'without the port the route does not exist');
  assert.equal((await press(f)).status, 404);
});

test("the press is the Owner's: without the Owner hand-off, or from another site, it creates nothing", async (t) => {
  const f = await fixture(t);
  const nobody = await press(f, 'agent_support', ENV);
  assert.equal(nobody.status, 403);
  assert.equal(headline(await nobody.text()), 'A workspace Owner adds Agents to Slack');

  const forged = await f.request(`${ADD}/agent_support`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(forged.status, 200);
  const page = await forged.text();
  assert.equal(headline(page), 'Adding Support to Slack', 'another site gets the page');
  assert.doesNotMatch(page, /<script nonce=/, 'which does not press by itself: only Continue does');
  assert.doesNotMatch(page, /class="journey-later"/, 'so Continue shows at once');
  assert.doesNotMatch(forged.headers.get('content-security-policy') ?? '', /nonce/);
  assert.equal(appsMade(f), 0);
  assert.equal(await recordOf(f), undefined);
  assert.deepEqual(f.audits, []);
});

// Defects caught: two presses (a double click, a reload, Continue after the page's own press) making two apps.
test("an Owner's press creates the app and goes straight to Slack's Allow; pressing again makes no second app", async (t) => {
  const f = await fixture(t);
  const first = await press(f);
  assert.equal(first.status, 303);
  const url = new URL(first.headers.get('location')!);
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), HOST.redirectUri);
  assert.match(url.searchParams.get('state')!, /^agent_support\.[a-f0-9-]{36}\.slack$/, 'the state says the press came from Slack');
  assert.equal(appsMade(f), 1);
  assert.deepEqual(f.audits, [[OWNER, 'authorize']], "the Owner's press is recorded as Admin's Start is");
  assert.deepEqual(f.posted, [], "no message asks the Owner to choose Allow: their browser is already on Slack's screen");

  const again = await press(f);
  assert.equal(again.status, 303, 'a second press opens Slack again');
  assert.equal(appsMade(f), 1, 'and creates nothing');
  const opening = await f.request(`${ADD}/agent_support`);
  assert.equal(headline(await opening.text()), 'Adding Support to Slack');
  assert.equal(appsMade(f), 1);
});

// Defects caught: an Owner sent to Slack's Allow screen also messaged to choose Allow, so they got two messages for
// one add; a record an earlier build left waiting to post that message never finishing; Slack's own Try again, which
// sends no browser anywhere, leaving the Owner with no way to Allow.
test("a record left waiting to post the Allow message finishes: a press goes to Slack with no message, Slack's Try again posts it", async (t) => {
  for (const finish of ['press', 'try_again'] as const) {
    const f = await fixture(t);
    t.mock.method(console, 'error', () => undefined);
    // As the build before this one leaves it: Slack refused its Allow message, after making the app.
    f.refusePosts.count = 1;
    await assert.rejects(f.service.start('agent_support', OWNER));
    assert.equal((await recordOf(f))?.state, 'icon_set', 'waiting at the message');
    assert.equal(appsMade(f), 1);

    if (finish === 'press') {
      const finished = await press(f);
      assert.equal(finished.status, 303);
      assert.match(finished.headers.get('location')!, /^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
      assert.deepEqual(f.posted, [], 'the press sends the Owner to Slack, and asks nothing else of them');
    } else {
      await f.service.retry('agent_support', OWNER);
      assert.match(f.posted.at(-1)?.text ?? '', /Support's Slack app is ready\. Choose Allow/, 'the message is the only way to Allow');
    }
    assert.equal((await recordOf(f))?.state, 'awaiting_consent', finish);
    assert.equal(appsMade(f), 1, 'one app');
  }
});

// Defects caught: a press answered with JSON or a raw code; a refusal whose page offers a way that cannot work.
test("each press outcome that stops short of Slack's Allow renders its own page with one way forward", async (t) => {
  const cases: Array<[string, (f: Fixture) => Promise<void>, number, string, string, string | undefined]> = [
    ['no token', async () => undefined, 409, 'Slack needs one token first', 'Add the token', `${ORIGIN}/admin/destinations/slack/connection/token`],
    ['limit', async (f) => { f.slack.refuseCreate = 'managed_app_limit_reached'; }, 409, "This workspace may have reached Slack's app limit", 'Open Your Apps in Slack', 'https://api.slack.com/apps'],
    ['refused', async (f) => { f.slack.refuseCreate = 'invalid_manifest'; }, 502, "Adding Support to Slack didn't finish", 'Try again', undefined],
    ['ambiguous', async (f) => { f.slack.ambiguousCreate = true; }, 409, "Slack may have created Support's app", 'Open Your Apps in Slack', 'https://api.slack.com/apps'],
  ];
  for (const [name, arrange, status, title, action, href] of cases) {
    const f = await fixture(t, { token: name !== 'no token' });
    await arrange(f);
    const response = await press(f);
    assert.equal(response.status, status, name);
    const html = await response.text();
    assert.equal(headline(html), title, name);
    assert.deepEqual(primary(html), { label: action, href }, name);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', `${name}: a page, never JSON`);
    if (name === 'refused') assert.match(words(html), /check that your workspace allows new apps/, 'only a refused create names the workspace setting');
  }
});

test("an Agent that already has its own app, or is archived or unknown, gets the Added or can't-add page and nothing starts", async (t) => {
  const f = await fixture(t);
  await f.config.createAgent(agentConfig('agent_live', 'Live', 'live', ({ requestedHandle, normalizedHandle, avatar }) => ({
    kind: 'agent_app', requestedHandle, normalizedHandle, avatar, desiredState: 'active', health: 'healthy',
    app: { state: 'active', at: NOW, app: { appId: 'A0LIVE', clientId: '9.c' }, icon: 'agent_avatar', botUserId: 'UBOTLIVE', installedAt: NOW, installedBy: OWNER },
  })));
  await f.config.createAgent({ ...agentConfig('agent_gone', 'Gone', 'gone'), lifecycle: 'archived' });
  for (const open of [(id: string) => f.request(`${ADD}/${id}`), (id: string) => press(f, id)]) {
    const live = await open('agent_live');
    const html = await live.text();
    assert.equal(headline(html), 'Live is already in Slack');
    assert.deepEqual(primary(html), { label: 'Open Live in Slack', href: `https://slack.com/app_redirect?app=A0LIVE&team=${TEAM}` });
    for (const id of ['agent_gone', 'agent_nobody']) {
      const gone = await open(id);
      assert.equal(gone.status, 404);
      assert.equal(headline(await gone.text()), "This Agent can't be added to Slack");
    }
  }
  assert.equal(appsMade(f), 0);
});

// Defects caught: two Agents both given the same handle in Slack, one through its own app; the refusal of a taken
// handle told as a broken app.
test('Start refuses a handle another Agent in Slack holds, before anything is written', async (t) => {
  const f = await fixture(t);
  await f.config.createAgent(agentConfig('agent_group', 'Help Desk', 'support', inGroup('S9')));
  const response = await press(f);
  assert.equal(response.status, 409);
  const html = await response.text();
  assert.equal(headline(html), 'Another Agent uses @support');
  assert.deepEqual(primary(html), { label: 'Rename Support', href: `${ORIGIN}/admin/agents/agent_support` });
  assert.equal(await recordOf(f), undefined, 'no creating record is written');
  assert.equal((await f.config.getAgent('agent_support')).revision, 1, 'nothing about the Agent is written at all');
  assert.deepEqual(f.posted, [], 'the page says it; nobody is messaged');
  assert.equal(appsMade(f), 0);
  assert.deepEqual(await f.service.press('agent_support', OWNER, 'admin').then((outcome) => [outcome.kind, 'agent' in outcome && outcome.agent.id]),
    ['handle_taken', 'agent_support'], "Admin's API gets the code and the Agent");

  // An Agent with an app on its way holds the handle too.
  await f.config.updateAgent('agent_group', { slackPresence: { ...agentConfig('x', 'x', 'support').slackPresence!, app: { state: 'creating', at: NOW, startedBy: OWNER, manifestFingerprint: 'f' } } as AgentSlackPresence }, 1);
  assert.equal((await f.service.start('agent_support', OWNER)).kind, 'handle_taken');
});

const creatingRecord = (id: string) =>
  ({ ...agentConfig(id, 'x', 'support').slackPresence!, app: { state: 'creating', at: NOW, startedBy: OWNER, manifestFingerprint: 'f' } }) as AgentSlackPresence;

// Defects caught: two Starts on two Agents with one handle both passing the check at Start and both creating, in
// either order or with one Agent's record written while the other's create is already with Slack.
test('two Starts on two Agents with one handle make one app, in either order: the create step checks again', async (t) => {
  for (const [first, second] of [['agent_zeta', 'agent_support'], ['agent_support', 'agent_zeta']] as const) {
    const f = await fixture(t);
    await f.config.createAgent(agentConfig('agent_zeta', 'Zeta', 'support'));
    // Both pass the check at Start: each writes `creating` before the other's create runs.
    await f.config.updateAgent('agent_support', { slackPresence: creatingRecord('agent_support') }, 1);
    await f.config.updateAgent('agent_zeta', { slackPresence: creatingRecord('agent_zeta') }, 1);

    const stopped = await f.service.advance(first, { wroteCreating: true });
    const went = await f.service.advance(second, { wroteCreating: true });

    assert.equal(appsMade(f), 1, `${first} first: one app`);
    assert.equal(stopped.withdrawn, 'handle_taken', `${first} sees the other's record and stops, whichever ID is smaller`);
    assert.equal(await recordOf(f, first), undefined, 'as it was before the press');
    assert.equal(appRecordOf(went.agent.slackPresence)?.state, 'awaiting_consent');
    const stoppedName = first === 'agent_zeta' ? 'Zeta' : 'Support';
    assert.match(f.posted.map((message) => message.text).join('\n'),
      new RegExp(`Another Agent is using @(?:\u2060)?support in Slack, or is being added with it, so Chickpea didn't create ${stoppedName}'s app`));
    assert.equal((await press(f, first)).status, 409, 'and a press on it now finds the handle held');
    assert.equal(appsMade(f), 1);
  }
});

test("a Start whose record is written while another Agent's create is with Slack stops: one app, not two", async (t) => {
  const f = await fixture(t);
  const zetaCreated = await f.config.createAgent(agentConfig('agent_zeta', 'Zeta', 'support'));
  // Support (the smaller ID) passed its check at Start before Zeta wrote anything, and writes `creating` only once
  // Zeta's create step has checked and is asking Slack.
  const create = f.slack.create.bind(f.slack);
  let supportStopped: Awaited<ReturnType<AgentSlackApps['advance']>> | undefined;
  f.slack.create = async (token, manifest) => {
    if (manifest.display_information.name === 'Zeta' && !supportStopped) {
      await f.config.updateAgent('agent_support', { slackPresence: creatingRecord('agent_support') }, 1);
      supportStopped = await f.service.advance('agent_support', { wroteCreating: true });
    }
    return create(token, manifest);
  };
  await f.config.updateAgent('agent_zeta', { slackPresence: creatingRecord('agent_zeta') }, zetaCreated.revision);
  const zeta = await f.service.advance('agent_zeta', { wroteCreating: true });

  assert.deepEqual(f.slack.created, ['Zeta'], 'one app');
  assert.equal(supportStopped?.withdrawn, 'handle_taken', 'the later record sees the one already with Slack');
  assert.equal(await recordOf(f, 'agent_support'), undefined);
  assert.equal(appRecordOf(zeta.agent.slackPresence)?.state, 'awaiting_consent');
});

async function allowFrom(f: Fixture, state: string): Promise<Response> {
  return f.service.completeConsent(new URLSearchParams({ code: 'code-1', state }), OWNER);
}

// Defects caught: an Owner who pressed in Admin dropped into Slack with no word in Admin; a state from the build
// before this one failing to complete; a made-up landing value sending the Owner anywhere.
test("Slack's Allow lands where the press came from: Slack, or Admin's Slack connection", async (t) => {
  for (const [from, landing] of [
    ['slack', 'https://slack.com/app_redirect?app=A0APP1&team=TACME'],
    ['admin', `${ORIGIN}/admin/destinations/slack/connection`],
    ['', 'https://slack.com/app_redirect?app=A0APP1&team=TACME'],
    ['evil', 'https://slack.com/app_redirect?app=A0APP1&team=TACME'],
  ] as const) {
    const f = await fixture(t);
    const opened = await f.service.press('agent_support', OWNER, from === 'admin' ? 'admin' : 'slack');
    assert.equal(opened.kind, 'authorize');
    const sent = new URL(opened.kind === 'authorize' ? opened.url : '').searchParams.get('state')!;
    const [agentId, nonce] = sent.split('.');
    // `''` is a state as the build before this one wrote it: Agent and nonce only.
    const state = from === '' ? `${agentId}.${nonce}` : from === 'evil' ? `${agentId}.${nonce}.evil` : sent;
    const landed = await allowFrom(f, state);
    assert.equal(landed.status, 303, from);
    assert.equal(landed.headers.get('location'), landing, from || 'previous form');
    assert.equal((await recordOf(f))?.state, 'active', `${from || 'previous form'}: the Allow completes`);
  }
});

test('from Admin with no Admin address to go back to, the Owner lands on the Added page', async (t) => {
  const f = await fixture(t, { adminUnknown: true });
  const opened = await f.service.press('agent_support', OWNER, 'admin');
  const landed = await allowFrom(f, new URL(opened.kind === 'authorize' ? opened.url : '').searchParams.get('state')!);
  assert.equal(landed.status, 200);
  const html = await landed.text();
  assert.equal(headline(html), 'Support is in Slack');
  assert.deepEqual(primary(html), { label: 'Open Support in Slack', href: `https://slack.com/app_redirect?app=A0APP1&team=${TEAM}` });
  assert.match(html, /<a class="auth-text-link" href="\/admin">Back to Chickpea Admin<\/a>/);
});

// A user-group Agent is in Slack already: a link never starts its move, which only Admin's Start does.
test("the hand-off never starts a move: an Agent that answers through Chickpea's handle is already in Slack", async (t) => {
  const f = await fixture(t);
  const agent = await f.config.getAgent('agent_support');
  const { errorCode: _waiting, ...presence } = agent.slackPresence!;
  await f.config.updateAgent('agent_support', { slackPresence: { ...presence, userGroupId: 'S1', health: 'healthy' } as AgentSlackPresence }, agent.revision);
  for (const response of [await f.request(`${ADD}/agent_support`), await press(f)]) {
    const html = await response.text();
    assert.equal(headline(html), 'Support is already in Slack');
    assert.match(words(html), /People can already mention @support in Slack\./);
  }
  assert.equal(await recordOf(f), undefined);
  assert.equal(appsMade(f), 0);
});

// Defects caught (finding 3): a start that stopped before Slack made an app could not be cancelled, so in `shared`
// mode the Agent had neither a group nor an app.
test('Cancel withdraws a start that stopped before any app was made, and back in shared mode the Agent is placed', async (t) => {
  const placed: string[] = [];
  const f = await fixture(t, { placed });
  f.slack.refuseCreate = 'invalid_manifest';
  assert.equal((await f.service.press('agent_support', OWNER, 'admin')).kind, 'needs_attention');
  assert.deepEqual((await recordOf(f)) && { ...(await recordOf(f)) }, { state: 'needs_attention', at: NOW, startedBy: OWNER, reason: 'create_refused', resume: 'creating' });
  await writeAgentSlackAppsSetting(f.settings, { mode: 'shared', changedBy: OWNER, changedAt: NOW });

  const cancelled = await f.service.cancel('agent_support', OWNER);

  assert.deepEqual(cancelled.kind === 'cancelled' && cancelled.app, 'none', 'Cancel says no app existed, never that one was deleted');
  assert.equal(await recordOf(f), undefined, 'the record is gone');
  assert.equal(appsMade(f), 0, 'nothing existed in Slack, so nothing was deleted there');
  assert.deepEqual(placed, ['agent_support'], 'it gets its user group, as every waiting Agent does in shared mode');
  assert.deepEqual(await f.service.cancel('agent_support', OWNER), { kind: 'not_waiting' });
});

test('Cancel after a create Slack never answered says an app may exist, for the Owner to delete', async (t) => {
  const f = await fixture(t);
  f.slack.ambiguousCreate = true;
  assert.equal((await f.service.press('agent_support', OWNER, 'admin')).kind, 'needs_attention');
  const cancelled = await f.service.cancel('agent_support', OWNER);
  assert.deepEqual(cancelled.kind === 'cancelled' && cancelled.app, 'left_for_owner');
  assert.equal(await recordOf(f), undefined);
});

// Defect caught: Cancel deleting an app Slack made before Allow with no record of that app naming this Agent.
test('Cancel of a start that stopped after Slack made an app with no record of its own deletes nothing: the app is left for the Owner', async (t) => {
  const f = await fixture(t);
  const agent = await f.config.getAgent('agent_support');
  await f.config.updateAgent('agent_support', {
    slackPresence: { ...agent.slackPresence!, app: { state: 'needs_attention', at: NOW, startedBy: OWNER, reason: 'urls_refused', resume: 'created', app: { appId: 'A0X', clientId: '1.c' } } } as AgentSlackPresence,
  }, agent.revision);
  const cancelled = await f.service.cancel('agent_support', OWNER);
  assert.deepEqual(cancelled.kind === 'cancelled' && cancelled.app, 'left_for_owner');
  assert.equal(await recordOf(f), undefined);
});

// Defects caught: Try again after Slack's permission screen leading to the Allow link, which answers the same expired
// page when the record no longer waits for Allow (a start cancelled in Admin, then an old Slack tab).
test("every Try again after Slack's permission screen goes to the hand-off page; another person and no Agent go to Admin", async (t) => {
  const f = await fixture(t);
  const opened = await f.service.press('agent_support', OWNER, 'slack');
  const state = new URL(opened.kind === 'authorize' ? opened.url : '').searchParams.get('state')!;
  const handoff = HOST.addUrl('agent_support');
  for (const [name, pending, href] of [
    ['cancelled', f.service.completeConsent(new URLSearchParams({ error: 'access_denied', state }), OWNER), handoff],
    ['another', f.service.completeConsent(new URLSearchParams({ code: 'c', state }), 'UOTHER'), `${ORIGIN}/admin`],
    ['unnamed', f.service.completeConsent(new URLSearchParams({ code: 'c', state: 'garbage' }), OWNER), `${ORIGIN}/admin`],
  ] as const) {
    const html = await (await pending).text();
    assert.equal(primary(html)?.href, href, name);
    if (name === 'unnamed') assert.doesNotMatch(html, /<ol class="onboarding-orientation"/, 'a page about no Agent draws no step bar');
  }

  assert.equal((await f.service.cancel('agent_support', OWNER)).kind, 'cancelled');
  const expired = await (await allowFrom(f, state)).text();
  assert.equal(headline(expired), 'That link expired');
  assert.equal(primary(expired)?.href, handoff);
  assert.equal(headline(await (await f.request(`${ADD}/agent_support`)).text()), 'Adding Support to Slack', 'where the press starts again');
});

// Defects caught: an Owner shown an internal ID, a code, a nonce or a Slack ID on a page meant only to say what to do.
test('every page shows its headline, the Agent and one action, and nothing internal', async (t) => {
  const f = await fixture(t);
  const opened = await f.service.press('agent_support', OWNER, 'slack');
  const state = new URL(opened.kind === 'authorize' ? opened.url : '').searchParams.get('state')!;
  const pages: Array<[string, Response | Promise<Response>]> = [
    ['opening', f.request(`${ADD}/agent_support`)],
    ['cancelled', f.service.completeConsent(new URLSearchParams({ error: 'access_denied', state }), OWNER)],
    ['expired', f.service.completeConsent(new URLSearchParams({ code: 'c', state: `agent_support.${crypto.randomUUID()}` }), OWNER)],
    ['unnamed', f.service.completeConsent(new URLSearchParams({ code: 'c', state: 'garbage' }), OWNER)],
    ['another', f.service.completeConsent(new URLSearchParams({ code: 'c', state }), 'UOTHER')],
  ];
  const nonce = state.split('.')[1]!;
  for (const [name, pending] of pages) {
    const html = await (await pending).text();
    assert.ok(headline(html), `${name}: a headline`);
    assert.equal((html.match(/class="auth-(?:link|button)"/g) ?? []).length, 1, `${name}: one primary action`);
    for (const internal of ['agent_support', 'A0APP1', TEAM, nonce, OWNER, 'inst_a']) {
      assert.equal(words(html).includes(internal), false, `${name}: no ${internal} on screen`);
    }
  }
});

test("the other Slack journey pages render exactly as before the Agent app pages joined the shared component", () => {
  const expected: Record<string, string> = {
    plain: '29d873fcc608500fb4246089b1003117502d62ea8ea17b2ae3c766f9d118a3f7',
    everything: '615af7ddd417f439c7391c55b3c393aaf8fb54625e20ae71eeb10ea036fa7959',
    'empty status': 'b7667c1bfe54adbcd95d6bf43fcbe6b1bbf5dadbb562c4a4554e1a8ea4059eb1',
    scene: '7fd454e3dfd9875f1bbf1ff9c8a534a088a9013235ecdef8ee254ffc2a26aaeb',
    handoff: '5076e904070d393c7cc65cfee74fa0086e4737f7db820eb4a8289d586103c593',
    'sign-in': '1641eda6244f49f3c6cbe92e723f752c73743fe93b2bb7f94d6130bb745470d1',
    'access denied': '65fbaae9b54663bcf0d4ee7fca8c24f83bcac56cf4318f10d6ba1ee602a055f2',
    'owner complete': '59d54a5584c466b1e94cfc84220855326ee6932911b162e420e7e5321fe69603',
    invitation: '3561813e88031b2d33ebf05245de625b0a98f793b2eb6e83af14a81fc158db0d',
    'invitation mismatch': 'c1697f4e4dba217d6ab3921d10544a95673a90d465c7fea5bc0c95c5771b0915',
    'invitation complete': 'd5b951df9c4e9c51dcf169bb236f41be1eeab9355e845c7b4af58e1a8d5df2bd',
    'invitation unavailable': '8758a40de0c3bb044c59235d39a0e5b06f34c47ada504ccd17ee9b938ee360f5',
    'https required': '134400cb3daa9c0756ad932aebcefd91fd926cff3e6e3586c6c124af61a5ed86',
  };
  for (const [name, render] of JOURNEY_PAGE_CASES) {
    const html = render();
    assert.equal(createHash('sha256').update(html).digest('hex'), expected[name], name);
    assert.doesNotMatch(html, /journey-agent|journey-steps|journey-next/, `${name}: none of the Agent app styles`);
  }
});

// Defects caught: the removal message's Add button, now the hand-off link, stopping at "needs attention" for an app
// Slack removed while it held the handle, where the Allow link it replaced offered Slack's Allow again.
test("a removed app is added back from the hand-off, whichever presence holds the handle, with no new app", async (t) => {
  const f = await fixture(t);
  const agent = await f.config.getAgent('agent_support');
  const { requestedHandle, normalizedHandle, avatar } = agent.slackPresence!;
  await f.config.updateAgent('agent_support', {
    slackPresence: {
      kind: 'agent_app', requestedHandle, normalizedHandle, avatar, desiredState: 'active', health: 'needs_attention',
      app: { state: 'needs_attention', at: NOW, startedBy: OWNER, reason: 'app_removed', resume: 'icon_set', app: { appId: 'A0OLD', clientId: '7.c' }, icon: 'agent_avatar' },
    },
  }, agent.revision);

  const page = words(await (await f.request(`${ADD}/agent_support`)).text());
  assert.doesNotMatch(page, /Creating Support's Slack app/, 'the app exists, so the page does not say it is creating one');
  assert.match(page, /Created Support's Slack app Opening Slack's permission screen…/);

  const response = await press(f);

  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('client_id'), '7.c', "Slack's Allow for the same app");
  assert.equal((await recordOf(f))?.state, 'awaiting_consent');
  assert.equal(appsMade(f), 0);
  assert.deepEqual(f.posted, [], 'the Owner is on Slack\'s screen already, so no message asks them to choose Allow');
});
