import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { AgentAppLifecycle, CustomAgentConfig } from '../src/config/types.ts';
import type { AgentSlackAppsHost } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, type AgentAppTransport } from '../src/slack/agent-apps/index.ts';
import { readAppSecrets, saveConfigurationToken } from '../src/slack/agent-apps/secrets.ts';
import {
  type AgentAppSlackApi,
  AmbiguousEffect,
  SlackRefused,
  type CreatedAgentApp,
  type SlackManifestProblem,
} from '../src/slack/agent-apps/slack-api.ts';
import { AGENT_APP_BOT_EVENTS, type SlackAppCreateManifest, type SlackAppManifest } from '../src/slack/app-manifest.ts';
import { uploadAgentAvatar } from '../src/slack/agent-presence/avatar-assets.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { AGENT_APP_BOT_SCOPES } from '../src/slack/scopes.ts';
import { SlackTransportError, type SlackUserGroup } from '../src/slack/transport/types.ts';
import { escapeMrkdwn } from '../src/slack/ui/text.ts';
import { captureSlackRefusals } from './helpers/agent-app-refusals.ts';
import { refuseLikeSlack } from './helpers/slack-manifest-rules.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const OWNER = 'UOWNER';
const HOST: AgentSlackAppsHost = {
  requestUrls: (installationId, appId) => ({
    events: `https://cloud.test/channels/slack/agent-apps/${installationId}/${appId}/tok/events`,
    interactions: `https://cloud.test/channels/slack/agent-apps/${installationId}/${appId}/tok/interactions`,
  }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });

class Crash extends Error {
  readonly name = 'Crash';
}

/** Counts every external call across Slack and the main bot; crashes right after the k-th one completes. */
class ExternalCalls {
  count = 0;
  crashAfter: number | undefined;
  log: string[] = [];
  async through<T>(name: string, call: () => Promise<T>): Promise<T> {
    const result = await call();
    this.count += 1;
    this.log.push(name);
    if (this.crashAfter !== undefined && this.count === this.crashAfter) throw new Crash(`after ${name}`);
    return result;
  }
}

class FakeSlack implements AgentAppSlackApi {
  created: CreatedAgentApp[] = [];
  manifests: SlackAppCreateManifest[] = [];
  updates: Array<{ appId: string; manifest: SlackAppManifest }> = [];
  icons: Array<{ appId: string; px: number }> = [];
  deleted: string[] = [];
  refuseCreate: SlackRefused | string | undefined;
  refuseUpdate: SlackRefused | undefined;
  refuseIcon: SlackRefused | undefined;
  refuseDelete: SlackRefused | undefined;
  ambiguousCreate = false;
  rotations = 0;
  /** Slack sends url_verification to an Events URL as it saves it; the host answers only with the app's stored signing secret. */
  verifyEventsUrl: (appId: string) => Promise<void> = async () => undefined;
  constructor(private readonly calls: ExternalCalls) {}
  async rotate(refreshToken: string) {
    this.rotations += 1;
    assert.match(refreshToken, /^xoxe-1-/);
    return { accessToken: `xoxe.xoxp-1-access-${this.rotations}`, refreshToken: `xoxe-1-refresh-${this.rotations}`, teamId: TEAM, expiresAt: NOW + 12 * 3_600_000 };
  }
  create(token: string, manifest: SlackAppCreateManifest) {
    return this.calls.through('create', async () => {
      assert.match(token, /^xoxe\.xoxp-1-access-/);
      this.manifests.push(manifest);
      refuseLikeSlack('apps.manifest.create', manifest);
      if (this.refuseCreate instanceof SlackRefused) throw this.refuseCreate;
      if (this.refuseCreate) throw new SlackRefused('apps.manifest.create', this.refuseCreate);
      if (this.ambiguousCreate) throw new AmbiguousEffect('apps.manifest.create', 'network_error');
      const n = this.created.length + 1;
      const created = { appId: `A0APP${n}`, clientId: `${n}.client`, clientSecret: `client-secret-${n}`, signingSecret: `signing-secret-${n}` };
      this.created.push(created);
      return created;
    });
  }
  update(_token: string, appId: string, manifest: SlackAppManifest) {
    return this.calls.through('update', async () => {
      refuseLikeSlack('apps.manifest.update', manifest);
      if (this.refuseUpdate) throw this.refuseUpdate;
      await this.verifyEventsUrl(appId);
      this.updates.push({ appId, manifest });
    });
  }
  setIcon(_token: string, appId: string, png: Uint8Array) {
    return this.calls.through('setIcon', async () => {
      if (this.refuseIcon) throw this.refuseIcon;
      this.icons.push({ appId, px: pngWidth(png) });
    });
  }
  async exchange(): Promise<never> { throw new Error('not in this unit'); }
  async uninstall(): Promise<never> { throw new Error('not in this unit'); }
  delete(_token: string, appId: string) {
    return this.calls.through('delete', async () => {
      if (this.refuseDelete) throw this.refuseDelete;
      this.deleted.push(appId);
      return 'deleted' as const;
    });
  }
}

interface Posted { channelId: string; text: string; blocks: unknown[]; idempotencyKey: string | undefined }

class FakeTransport implements AgentAppTransport {
  disabled: string[] = [];
  refuseDisable = false;
  posted: Posted[] = [];
  constructor(private readonly calls: ExternalCalls) {}
  disableUserGroup(id: string) {
    return this.calls.through('disableUserGroup', async (): Promise<SlackUserGroup> => {
      if (this.refuseDisable) throw new SlackTransportError('usergroups.disable', 'permission_denied');
      if (this.disabled.includes(id)) throw new SlackTransportError('usergroups.disable', 'already_disabled');
      this.disabled.push(id);
      return { id, name: 'Support', handle: 'support', disabled: true };
    });
  }
  async enableUserGroup(id: string): Promise<SlackUserGroup> {
    this.disabled = this.disabled.filter((candidate) => candidate !== id);
    return { id, name: 'Support', handle: 'support', disabled: false };
  }
  openDirectConversation(userId: string) {
    return this.calls.through('openDirectConversation', async () => ({ id: `D_${userId}`, private: true, member: true, archived: false }));
  }
  postMessage(input: { channelId: string; text: string; blocks?: unknown[]; idempotencyKey?: string }) {
    return this.calls.through('postMessage', async () => {
      const existing = this.posted.findIndex((message) => message.idempotencyKey !== undefined && message.idempotencyKey === input.idempotencyKey);
      if (existing >= 0) return { channelId: input.channelId, ts: `${existing + 1}.0` };
      this.posted.push({ channelId: input.channelId, text: input.text, blocks: input.blocks ?? [], idempotencyKey: input.idempotencyKey });
      return { channelId: input.channelId, ts: `${this.posted.length}.0` };
    });
  }
}

function agent(id: string, name: string, handle: string, userGroupId?: string): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, description: `${name} helps customers.`, instructions: `You are ${name}.`, enabled: true,
    lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: {
      requestedHandle: handle, normalizedHandle: handle, desiredState: userGroupId ? 'active' : 'unpublished',
      health: userGroupId ? 'healthy' : 'unpublished', avatar: { kind: 'generated', revision: 1, seed: id },
      ...(userGroupId ? { userGroupId } : {}),
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

/** A valid grayscale PNG of `px` by `px`, enough for a raster sniff and the IHDR read. */
function png(px: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeBytes = new TextEncoder().encode(type);
    const body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes); body.set(data, typeBytes.length);
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(body, 4);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(body) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, px); view.setUint32(4, px); ihdr[8] = 8; ihdr[9] = 0;
  const raw = new Uint8Array((px + 1) * px);
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { total.set(part, offset); offset += part.length; }
  return total;
}

function pngWidth(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
}

interface Fixture {
  config: SqliteConfigStore;
  settings: SqliteSettingsStore;
  slack: FakeSlack;
  transport: FakeTransport;
  calls: ExternalCalls;
  service: AgentSlackApps;
  clock: { now: number };
  realmWrites: string[];
  crashRealmWriteOnce: boolean;
  /** The signing secret the host could read for each app when Slack verified its Events URL. */
  signingSecretsAtUpdate: Array<string | undefined>;
}

async function fixture(t: TestContext, options: { token?: boolean; avatarPx?: number; userGroupId?: string | undefined } = {}): Promise<Fixture> {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { config.close(); settings.close(); });
  const support = await config.createAgent(agent('agent_support', 'Support', 'support', 'userGroupId' in options ? options.userGroupId : 'S1'));
  await config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  if (options.avatarPx) {
    await uploadAgentAvatar({ config, settings, agentId: support.id, bytes: png(options.avatarPx), contentType: 'image/png', publicOrigin: 'https://core.test' });
  }
  const calls = new ExternalCalls();
  const slack = new FakeSlack(calls);
  const transport = new FakeTransport(calls);
  const keyring = generateCredentialKeyring('k1');
  const clock = { now: NOW };
  const f: Fixture = {
    config, settings, slack, transport, calls, clock, realmWrites: [], crashRealmWriteOnce: false, signingSecretsAtUpdate: [],
    service: undefined as unknown as AgentSlackApps,
  };
  slack.verifyEventsUrl = async (appId) => {
    f.signingSecretsAtUpdate.push((await readAppSecrets({ credentials: settings, keyring, slack }, appId))?.secrets.signingSecret);
  };
  const realm = Object.assign(Object.create(settings) as SqliteSettingsStore, {
    replaceEncryptedCredentialRevision: async (input: Parameters<SqliteSettingsStore['replaceEncryptedCredentialRevision']>[0]) => {
      if (input.key.startsWith('agent-slack-app.')) {
        const current = await config.getAgent('agent_support');
        f.realmWrites.push(current.slackPresence?.kind === 'agent_app' ? current.slackPresence.app.state : 'user_group');
        if (f.crashRealmWriteOnce) { f.crashRealmWriteOnce = false; throw new Crash('before the realm write'); }
      }
      return settings.replaceEncryptedCredentialRevision(input);
    },
  });
  if (options.token !== false) {
    assert.equal(await saveConfigurationToken({ credentials: settings, keyring, slack }, TEAM, 'xoxe-1-pasted-token-0000'), 'saved');
  }
  f.service = new AgentSlackApps({
    env: ENV, stores: { config, settings: realm }, host: HOST, transport, slack, keyring,
    now: () => clock.now, publicOrigin: async () => 'https://core.test',
  });
  return f;
}

async function appOf(f: Fixture): Promise<AgentAppLifecycle | undefined> {
  const presence = (await f.config.getAgent('agent_support')).slackPresence;
  return presence?.kind === 'agent_app' ? presence.app : undefined;
}

function buttonUrls(message: Posted): string[] {
  const actions = message.blocks.find((block) => (block as { type: string }).type === 'actions') as { elements: Array<{ url?: string }> } | undefined;
  return actions?.elements.map((element) => element.url ?? '').filter(Boolean) ?? [];
}

test('a start frees the handle, creates without URLs, stores the secrets, adds the URLs, sets the icon and asks the Owner', async (t) => {
  const f = await fixture(t);
  const outcome = await f.service.start('agent_support', OWNER);
  assert.equal(outcome.kind, 'started');
  assert.deepEqual(f.calls.log, ['disableUserGroup', 'create', 'update', 'setIcon', 'openDirectConversation', 'postMessage']);
  assert.deepEqual(f.transport.disabled, ['S1']);

  const [createManifest] = f.slack.manifests;
  assert.ok(createManifest);
  assert.deepEqual(Object.keys(createManifest.settings).sort(), ['is_mcp_enabled', 'org_deploy_enabled', 'socket_mode_enabled', 'token_rotation_enabled'],
    'create carries neither event subscriptions nor interactivity');
  assert.deepEqual(createManifest.oauth_config.redirect_urls, [HOST.redirectUri]);
  assert.deepEqual(createManifest.oauth_config.scopes, { bot: [...AGENT_APP_BOT_SCOPES] });
  assert.equal(createManifest.display_information.name, 'Support');
  assert.equal(createManifest.features.bot_user.display_name, 'support', "the bot is named by the Agent's handle");
  assert.equal(createManifest.features.app_home.home_tab_enabled, false);

  assert.deepEqual(f.realmWrites, ['created'], 'the record commits before the realm write');
  assert.deepEqual((await readAppSecrets({ credentials: f.settings, keyring: f.service['secrets'].keyring, slack: f.slack }, 'A0APP1'))?.secrets, {
    clientSecret: 'client-secret-1', signingSecret: 'signing-secret-1',
  });
  assert.deepEqual(f.signingSecretsAtUpdate, ['signing-secret-1'], 'the signing secret is stored before the update that sets the Events URL');

  const [update] = f.slack.updates;
  assert.ok(update);
  assert.equal(update.appId, 'A0APP1');
  const { event_subscriptions: subscriptions, interactivity, ...unchanged } = update.manifest.settings;
  assert.deepEqual(subscriptions, { request_url: HOST.requestUrls('inst_a', 'A0APP1').events, bot_events: [...AGENT_APP_BOT_EVENTS] });
  assert.deepEqual(interactivity, { is_enabled: true, request_url: HOST.requestUrls('inst_a', 'A0APP1').interactions });
  assert.deepEqual({ ...update.manifest, settings: unchanged }, createManifest, 'the update repeats everything the create set');

  assert.deepEqual(f.slack.icons, [{ appId: 'A0APP1', px: 512 }]);
  const app = await appOf(f);
  assert.equal(app?.state, 'awaiting_consent');
  assert.equal(app?.state === 'awaiting_consent' && app.icon, 'agent_avatar');
  assert.deepEqual(app?.state === 'awaiting_consent' ? app.allowDm : undefined, { channelId: `D_${OWNER}`, ts: '1.0' });
  const [dm] = f.transport.posted;
  assert.equal(dm?.channelId, `D_${OWNER}`);
  assert.equal(dm?.text, escapeMrkdwn("Support's Slack app is ready. Choose Allow to add it to this workspace. After that, people can message @support directly and mention it in channels it's in."));
  assert.deepEqual(buttonUrls(dm!), [HOST.allowUrl('agent_support')]);
  const presence = (await f.config.getAgent('agent_support')).slackPresence;
  assert.equal(presence?.desiredState, 'active');
  assert.equal(presence?.health, 'pending');
  assert.deepEqual(presence?.kind === 'agent_app' ? presence.released : undefined, { userGroupId: 'S1' });
  assert.equal(JSON.stringify(presence).includes('secret'), false, 'no secret in presence');
});

test('a 256 px avatar uploads the 512 px default instead', async (t) => {
  const f = await fixture(t, { avatarPx: 256 });
  await f.service.start('agent_support', OWNER);
  assert.deepEqual(f.slack.icons, [{ appId: 'A0APP1', px: 512 }]);
  const app = await appOf(f);
  assert.equal(app?.state === 'awaiting_consent' && app.icon, 'default_avatar');
});

test('an Agent without a user group skips the release, and without a token nothing starts', async (t) => {
  const bare = await fixture(t, { userGroupId: undefined });
  assert.equal((await bare.service.start('agent_support', OWNER)).kind, 'started');
  assert.deepEqual(bare.calls.log, ['create', 'update', 'setIcon', 'openDirectConversation', 'postMessage']);
  const noToken = await fixture(t, { token: false });
  assert.deepEqual(await noToken.service.start('agent_support', OWNER), { kind: 'token_needed' });
  assert.deepEqual(noToken.calls.log, []);
  assert.equal((await noToken.config.getAgent('agent_support')).slackPresence?.kind, undefined);
});

test('a crash after any external call reruns to the same end with one create and one message', async (t) => {
  const clean = await fixture(t);
  await clean.service.start('agent_support', OWNER);
  const cleanApp = await appOf(clean);
  const total = clean.calls.count;
  assert.equal(total, 6);
  for (let k = 1; k <= total; k += 1) {
    const f = await fixture(t);
    f.calls.crashAfter = k;
    await assert.rejects(() => f.service.start('agent_support', OWNER), Crash, `crash after call ${k}`);
    f.calls.crashAfter = undefined;
    await f.service.advance('agent_support');
    if (k === 2) {
      assert.equal((await appOf(f))?.state, 'creating', 'within the settle window nothing creates again');
      f.clock.now = NOW + 60_000;
      await f.service.advance('agent_support');
      const app = await appOf(f);
      assert.equal(app?.state === 'needs_attention' && app.reason, 'ambiguous_create', `after call ${k}`);
      assert.equal(f.slack.created.length, 1, `after call ${k}`);
      assert.match(f.transport.posted[0]?.text ?? '', /Slack may have created an app for Support/);
      continue;
    }
    assert.deepEqual(await appOf(f), cleanApp, `after call ${k}`);
    assert.equal(f.slack.created.length, 1, `one create after call ${k}`);
    assert.equal(f.transport.posted.length, 1, `one Allow message after call ${k}`);
    assert.deepEqual(f.transport.disabled, ['S1'], `one group after call ${k}`);
  }
});

test('a record without secrets older than a minute deletes the recorded app and creates again', async (t) => {
  const f = await fixture(t);
  f.crashRealmWriteOnce = true;
  await assert.rejects(() => f.service.start('agent_support', OWNER), Crash);
  assert.equal((await appOf(f))?.state, 'created');
  await f.service.advance('agent_support');
  assert.equal((await appOf(f))?.state, 'created', 'within the settle window another run may still be writing');
  assert.deepEqual(f.slack.deleted, []);
  f.clock.now = NOW + 60_000;
  await f.service.advance('agent_support');
  assert.deepEqual(f.slack.deleted, ['A0APP1']);
  assert.equal(f.slack.created.length, 2);
  const app = await appOf(f);
  assert.equal(app?.state, 'awaiting_consent');
  assert.equal(app?.state === 'awaiting_consent' && app.app.appId, 'A0APP2');
  assert.deepEqual(f.signingSecretsAtUpdate, ['signing-secret-2'], 'only the recreated app, with its secret stored, gets its URLs');
  const deps = { credentials: f.settings, keyring: f.service['secrets'].keyring, slack: f.slack };
  assert.equal(await readAppSecrets(deps, 'A0APP1'), undefined);
  assert.equal((await readAppSecrets(deps, 'A0APP2'))?.secrets.signingSecret, 'signing-secret-2');
});

test('two concurrent starts make one app', async (t) => {
  const f = await fixture(t);
  const outcomes = await Promise.all([f.service.start('agent_support', OWNER), f.service.start('agent_support', 'UOWNER2')]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ['already_started', 'started']);
  assert.equal(f.slack.created.length, 1);
  assert.equal(f.transport.posted.length, 1);
  assert.equal((await appOf(f))?.state, 'awaiting_consent');
});

test('each refusal lands in attention with its message, and Try again resumes from the right step', async (t) => {
  const refused = await fixture(t);
  refused.slack.refuseCreate = 'invalid_manifest';
  await refused.service.start('agent_support', OWNER);
  let app = await appOf(refused);
  assert.equal(app?.state === 'needs_attention' && app.reason, 'create_refused');
  assert.equal(refused.transport.posted[0]?.text, "Slack didn't finish Support's app. Choose Try again. If it keeps happening, check that your workspace allows new apps.");
  refused.slack.refuseCreate = undefined;
  await refused.service.retry('agent_support', 'UOWNER2');
  app = await appOf(refused);
  assert.equal(app?.state, 'awaiting_consent');
  assert.equal(app?.state === 'awaiting_consent' && app.startedBy, 'UOWNER2');
  assert.deepEqual(refused.transport.disabled, ['S1'], 'the handle is released once');
  assert.equal(refused.transport.posted[1]?.channelId, 'D_UOWNER2', 'the Owner who retried is asked to allow');

  const busy = await fixture(t);
  busy.slack.refuseCreate = 'ratelimited';
  await busy.service.start('agent_support', OWNER);
  app = await appOf(busy);
  assert.equal(app?.state === 'needs_attention' && app.reason, 'slack_busy');
  assert.equal(busy.transport.posted[0]?.text, 'Slack is limiting how fast apps are set up. Wait a minute, then choose Try again.');

  const ambiguous = await fixture(t);
  ambiguous.slack.ambiguousCreate = true;
  await ambiguous.service.start('agent_support', OWNER);
  app = await appOf(ambiguous);
  assert.equal(app?.state === 'needs_attention' && app.reason, 'ambiguous_create');
  assert.deepEqual(buttonUrls(ambiguous.transport.posted[0]!), ['https://api.slack.com/apps']);
  ambiguous.slack.ambiguousCreate = false;
  await ambiguous.service.advance('agent_support');
  assert.equal(ambiguous.slack.manifests.length, 1, 'ambiguity never retries by itself');

  const handle = await fixture(t);
  handle.transport.refuseDisable = true;
  await handle.service.start('agent_support', OWNER);
  app = await appOf(handle);
  assert.equal(app?.state === 'needs_attention' && app.reason, 'handle_release_failed');
  assert.equal(handle.transport.posted[0]?.text, escapeMrkdwn("Chickpea couldn't free the name @support in Slack, so it didn't create Support's app. In Chickpea Admin, choose Update in Slack, then choose Try again."));
  assert.deepEqual(handle.slack.manifests, [], 'no create without the handle');
  handle.transport.refuseDisable = false;
  await handle.service.retry('agent_support', OWNER);
  assert.equal((await appOf(handle))?.state, 'awaiting_consent');
});

test('a spent configuration token stops the sequence and sends the Owner to the token page', async (t) => {
  const f = await fixture(t);
  f.clock.now = NOW + 13 * 3_600_000;
  f.slack.rotate = async () => { throw new SlackRefused('tooling.tokens.rotate', 'invalid_refresh_token'); };
  await f.service.start('agent_support', OWNER);
  const app = await appOf(f);
  assert.equal(app?.state === 'needs_attention' && app.reason, 'config_token_needed');
  assert.equal(f.transport.posted[0]?.text, 'Chickpea needs a new Slack refresh token to finish Support\'s app.');
  assert.deepEqual(buttonUrls(f.transport.posted[0]!), ['https://core.test/admin/agents/agent_support/slack-app']);
  assert.deepEqual(f.slack.manifests, []);
});

test('a refused create logs its step, Agent, code and pointers for the operator; the Owner sees only Try again', async (t) => {
  const refusals = captureSlackRefusals(t);
  const f = await fixture(t);
  const problem: SlackManifestProblem = { message: 'Must be a valid bot display name', pointer: '/features/bot_user/display_name' };
  f.slack.refuseCreate = new SlackRefused('apps.manifest.create', 'invalid_manifest', [problem]);
  await f.service.start('agent_support', OWNER);
  assert.deepEqual(refusals, [{
    event: 'chickpea.agent_app.slack_refused', step: 'create', agentId: 'agent_support', appId: null, code: 'invalid_manifest', errors: [problem],
  }]);
  assert.deepEqual(f.transport.posted.map((message) => message.text), [
    "Slack didn't finish Support's app. Choose Try again. If it keeps happening, check that your workspace allows new apps.",
  ]);
  assert.doesNotMatch(JSON.stringify(f.transport.posted), /invalid_manifest|display_name/, 'the Owner never sees the refusal');
  assert.doesNotMatch(JSON.stringify(refusals), /xox|secret/i, 'no token or secret in the log');
});

test('refusals at the other steps log too, each with the app it concerns', async (t) => {
  const refusals = captureSlackRefusals(t);
  const update = await fixture(t);
  update.slack.refuseUpdate = new SlackRefused('apps.manifest.update', 'invalid_manifest', [{ message: 'Invalid URL', pointer: '/settings/event_subscriptions/request_url' }]);
  await update.service.start('agent_support', OWNER);
  const icon = await fixture(t);
  icon.slack.refuseIcon = new SlackRefused('apps.icon.set', 'invalid_dimensions');
  await icon.service.start('agent_support', OWNER);
  const handle = await fixture(t);
  handle.transport.refuseDisable = true;
  await handle.service.start('agent_support', OWNER);
  const spent = await fixture(t);
  spent.clock.now = NOW + 13 * 3_600_000;
  spent.slack.rotate = async () => { throw new SlackRefused('tooling.tokens.rotate', 'invalid_refresh_token'); };
  await spent.service.start('agent_support', OWNER);
  assert.equal(await spent.service.pasteConfigurationToken('xoxe-1-pasted-again-0000'), 'rejected');
  const orphan = await fixture(t);
  orphan.crashRealmWriteOnce = true;
  await assert.rejects(() => orphan.service.start('agent_support', OWNER), Crash);
  orphan.clock.now = NOW + 60_000;
  orphan.slack.refuseDelete = new SlackRefused('apps.manifest.delete', 'invalid_app_id');
  await orphan.service.advance('agent_support');

  assert.deepEqual(refusals.map(({ step, agentId, appId, code, errors }) => ({ step, agentId, appId, code, errors })), [
    { step: 'update', agentId: 'agent_support', appId: 'A0APP1', code: 'invalid_manifest', errors: [{ message: 'Invalid URL', pointer: '/settings/event_subscriptions/request_url' }] },
    { step: 'icon', agentId: 'agent_support', appId: 'A0APP1', code: 'invalid_dimensions', errors: [] },
    { step: 'release_handle', agentId: 'agent_support', appId: null, code: 'permission_denied', errors: [] },
    { step: 'rotate', agentId: null, appId: null, code: 'invalid_refresh_token', errors: [] },
    { step: 'rotate', agentId: null, appId: null, code: 'invalid_refresh_token', errors: [] },
    { step: 'delete', agentId: 'agent_support', appId: 'A0APP1', code: 'invalid_app_id', errors: [] },
  ]);
  const app = await appOf(icon);
  assert.equal(app?.state === 'awaiting_consent' && app.icon, 'not_set', 'a refused icon does not stop the app');
});
