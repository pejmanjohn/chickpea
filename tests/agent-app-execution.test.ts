import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { EncryptedCredentialStore } from '../src/config/settings-store.ts';
import { closeNodeStateStores, getSettingsStore, resolveStores, type AppStores, type PlatformEnv } from '../src/config/state-backend.ts';
import type { AgentAppLifecycle, AgentSlackPresence, CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { AgentSlackApps, type AgentAppTransport, withAgentAppExecution } from '../src/slack/agent-apps/index.ts';
import { saveConfigurationToken, writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { type AgentAppSlackApi, createAgentAppSlackApi, SlackUnavailable } from '../src/slack/agent-apps/slack-api.ts';
import { AgentPresenceError } from '../src/slack/agent-presence/errors.ts';
import { selectSlackPresentationOwner } from '../src/slack/claim-store.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  SlackInstallationUnavailableError,
  type SlackInstallationExecutionContext,
} from '../src/slack/installation-execution.ts';
import { invalidateSlackInstallationCredentialCache } from '../src/slack/installation-credentials.ts';
import { turnReplySender, type RunTurnOptions } from '../src/slack/run-turn.ts';
import { toContextMessages } from '../src/slack/thread-context.ts';
import { executeTurnJob, type TurnExecutionOptions, type TurnExecutionPorts } from '../src/slack/turn-executor.ts';
import type { PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { WebClient } from '@slack/web-api';

const TEAM = 'TTENANT1';
const APP_ID = 'A0AGENT1';
const AGENT_BOT = 'xoxb-agent-bot';
const AGENT_BOT_USER = 'UAGENTBOT';
const NOW = Date.now() - 60_000;
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};
const LIVE: AgentAppLifecycle = {
  state: 'active', at: NOW, app: { appId: APP_ID, clientId: '1.client' }, icon: 'agent_avatar',
  botUserId: AGENT_BOT_USER, installedAt: NOW, installedBy: 'U1',
};
const REMOVED: AgentAppLifecycle = {
  state: 'needs_attention', at: NOW, startedBy: 'U1', reason: 'app_removed', resume: 'icon_set', app: { appId: APP_ID, clientId: '1.client' },
};

function appPresence(app: AgentAppLifecycle): AgentSlackPresence {
  return {
    kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
    avatar: { kind: 'generated', revision: 1, seed: 'support' }, app, released: { userGroupId: 'SSUPPORT' },
  };
}

function agent(id: string, name: string, presence: AgentSlackPresence): CustomAgentConfig {
  return {
    id, kind: 'user', revision: 1, name, instructions: `You are ${name}.`, enabled: true, lifecycle: 'active',
    editPolicy: 'creator_and_admins', configurationGeneration: 1, slackPresence: presence,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

const groupPresence: AgentSlackPresence = {
  requestedHandle: 'finance', normalizedHandle: 'finance', desiredState: 'active', health: 'healthy',
  avatar: { kind: 'generated', revision: 1, seed: 'finance' }, userGroupId: 'SFINANCE',
};

interface Harness {
  env: PlatformEnv;
  stores: AppStores;
  baseCalls: string[];
  base: SlackInstallationExecutionContext;
  resolve: ReturnType<typeof withAgentAppExecution>;
  storeApp(app: AgentAppLifecycle, options?: { botToken?: string | undefined }): Promise<void>;
}

async function withHarness(t: TestContext, run: (h: Harness) => Promise<void>): Promise<void> {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-agent-app-exec-'));
  process.env.TAG_DB_PATH = ':memory:';
  process.env.SLACK_STATE_DB_PATH = ':memory:';
  process.env.CHICKPEA_AUTH_DB_PATH = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
  configureAgentSlackApps(HOST);
  t.after(() => {
    configureAgentSlackApps(undefined);
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_tenant_a' });
  const stores = resolveStores(env);
  const support = await stores.config.createAgent(agent('agent_support', 'Support', groupPresence));
  await stores.config.createAgent(agent('agent_finance', 'Finance', groupPresence));
  await stores.config.ensureWorkspaceInstallation({ workspaceId: TEAM, teamId: TEAM, transportMode: 'direct', defaultAgentId: support.id, runtimeContract: 'chickpea-v1' });
  const baseCalls: string[] = [];
  const base: SlackInstallationExecutionContext = {
    workspaceId: TEAM, transportMode: 'direct', sharedAppReads: false, botToken: 'xoxb-main-bot', botUserId: 'UBOT', client: {} as WebClient,
  };
  const resolve = withAgentAppExecution(async (workspaceId) => { baseCalls.push(workspaceId); return base; }, env);
  await run({
    env, stores, baseCalls, base, resolve,
    async storeApp(app, options = {}) {
      const current = await stores.config.getAgent('agent_support');
      await stores.config.updateAgent(current.id, { slackPresence: appPresence(app) }, current.revision);
      if (!('botToken' in options) || options.botToken) {
        await writeAppSecrets(
          { credentials: stores.settings as unknown as EncryptedCredentialStore, keyring: loadCredentialKeyring(), slack: createAgentAppSlackApi() },
          APP_ID, current.id, { clientSecret: 'cs', signingSecret: 'ss', ...(options.botToken === undefined && 'botToken' in options ? {} : { botToken: options.botToken ?? AGENT_BOT }) }, null,
        );
      }
    },
  });
}

test("a turn of an Agent with a live app runs as that Agent's own bot, cached per Agent", async (t) => withHarness(t, async (h) => {
  await h.storeApp(LIVE);
  const context = await h.resolve(TEAM, 'agent_support');
  assert.equal(context.botToken, AGENT_BOT);
  assert.equal(context.botUserId, AGENT_BOT_USER);
  assert.equal(context.displayName, 'Support');
  assert.equal(context.transportMode, 'direct');
  assert.ok(context.client, "the Agent's own client");
  assert.deepEqual(h.baseCalls, [TEAM], "the installation's own resolution runs first, and its refusals would stand");
  assert.equal(await h.resolve(TEAM, 'agent_support'), context, 'resolved once per Agent');

  assert.equal(await h.resolve(TEAM, 'agent_finance'), h.base, 'a user-group Agent answers as the installation bot');
  assert.equal(await h.resolve(TEAM, CHICKPEA_AGENT_ID), h.base);
  assert.equal(await h.resolve(TEAM), h.base, 'a resolution without an Agent is the base');
  assert.deepEqual(h.baseCalls, [TEAM, TEAM, TEAM, TEAM]);
}));

test('a broken app never answers as Chickpea: the turn is unavailable', async (t) => withHarness(t, async (h) => {
  await h.storeApp(REMOVED, { botToken: undefined });
  await assert.rejects(() => h.resolve(TEAM, 'agent_support'), (error: unknown) =>
    error instanceof SlackInstallationUnavailableError && error.reasonCode === 'agent_app_unavailable' && error.retryable === false);
  assert.deepEqual(h.baseCalls, []);

  await h.storeApp(LIVE, { botToken: undefined });
  await assert.rejects(() => h.resolve(TEAM, 'agent_support'), (error: unknown) =>
    error instanceof SlackInstallationUnavailableError && error.reasonCode === 'agent_app_unavailable');
  assert.deepEqual(h.baseCalls, [], 'a live record without a token still never falls back to the installation bot');
}));

test('a store that cannot be read fails the turn rather than answering as the installation bot', async (t) => withHarness(t, async (h) => {
  await h.storeApp(LIVE);
  const getAgent = h.stores.config.getAgent.bind(h.stores.config);
  h.stores.config.getAgent = async () => { throw new Error('store unreachable'); };
  await assert.rejects(() => h.resolve(TEAM, 'agent_support'), /store unreachable/);
  assert.deepEqual(h.baseCalls, []);
  h.stores.config.getAgent = getAgent;
  assert.equal((await h.resolve(TEAM, 'agent_support')).botToken, AGENT_BOT, 'a failed lookup is not cached');
}));

test("the installation's own refusal wins over a live app: a revoked or gated installation runs no Agent bot", async (t) => withHarness(t, async (h) => {
  await h.storeApp(LIVE);
  const refused = withAgentAppExecution(async (workspaceId) => {
    h.baseCalls.push(workspaceId);
    throw new SlackInstallationUnavailableError(workspaceId, 'installation_revoked');
  }, h.env);
  await assert.rejects(() => refused(TEAM, 'agent_support'), (error: unknown) =>
    error instanceof SlackInstallationUnavailableError && error.reasonCode === 'installation_revoked');
  assert.deepEqual(h.baseCalls, [TEAM], 'the installation is checked before the Agent bot is considered');
  await assert.rejects(() => refused(TEAM, 'agent_support'), (error: unknown) =>
    error instanceof SlackInstallationUnavailableError && error.reasonCode === 'installation_revoked', 'a refusal is not cached as a context');
}));

test("one realm read timeout during an app Agent's DM turn retries the turn instead of parking it for recovery", async (t) => withHarness(t, async (h) => {
  await h.storeApp(LIVE);
  // The store's facade forwards a patch to its logic object; deleting it restores the method.
  const settings = getSettingsStore(h.env) as unknown as Record<string, unknown>;
  settings.getEncryptedCredentialRevision = async () => {
    delete settings.getEncryptedCredentialRevision;
    throw new Error('realm read timed out');
  };
  const calls: string[] = [];
  const contexts: Array<SlackInstallationExecutionContext | undefined> = [];
  const retries: Array<number | undefined> = [];
  const record = (name: string) => async () => { calls.push(name); };
  const ports = {
    env: h.env,
    turnJobs: {
      recordAttempt: record('recordAttempt'), markRecoveryRequired: record('markRecoveryRequired'),
      markDelivered: record('markDelivered'), markError: record('markError'), recordInteractionIntent: record('recordInteractionIntent'),
    },
    slack: { setActiveWork: record('setActiveWork'), release: record('release') },
    config: {}, presentationState: { getRunPresentation: async () => undefined }, settingsStore: { getSetting: async () => undefined },
    usageStore: {}, workStore: {}, appStores: {}, managementApproval: () => ({}), telemetry: { capture: () => undefined },
    resolveInstallation: h.resolve, sandboxBinding: () => undefined,
    runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
      contexts.push(options.installationContext);
      await options.onDelivered?.('completed' as never);
    },
  } as unknown as TurnExecutionPorts;
  const options: TurnExecutionOptions = { latency: { lane: 'cloudflare', executor: 'alarm' }, onRetry: (afterMs) => { retries.push(afterMs); } };
  const job = {
    id: 'turn_dm', evtKey: 'evt:dm', msgKey: 'msg:dm',
    turn: { workspaceId: TEAM, channelId: 'D1', channelType: 'im', threadTs: '1.1', messageTs: '1.1', userId: 'U1', text: 'hello', source: 'dm_message', eventId: 'Ev1' },
    assignment: { agentId: 'agent_support' }, executionAuthority: 'legacy', attempts: 0, progress: {},
  } as unknown as PendingTurnJob;

  assert.equal(await executeTurnJob(job, ports, options), false, 'the turn waits for its retry');
  assert.deepEqual(retries, [0], 'a retry is asked for');
  assert.equal(calls.length, 0, 'the turn is not parked in recovery');

  assert.equal(await executeTurnJob(job, ports, options), true, 'the retry answers');
  assert.equal(contexts[0]?.botToken, AGENT_BOT, "as the Agent's own bot");
  assert.equal(calls.includes('markRecoveryRequired'), false);
}));

test("Slack not answering an archive's uninstall leaves the Agent answering as its own bot, and archiving again finishes", async (t) => withHarness(t, async (h) => {
  await h.storeApp(LIVE);
  const uninstalls: string[] = [];
  const deletes: string[] = [];
  let unavailable = 1;
  const slack = {
    rotate: async () => ({ accessToken: 'xoxe.xoxp-1-access', refreshToken: 'xoxe-1-refresh-2', teamId: TEAM, expiresAt: Date.now() + 12 * 3_600_000 }),
    uninstall: async ({ botToken }: { botToken: string }) => {
      uninstalls.push(botToken);
      if (unavailable > 0) { unavailable -= 1; throw new SlackUnavailable('apps.uninstall', 'http_502'); }
      return 'removed' as const;
    },
    delete: async (_token: string, appId: string) => { deletes.push(appId); return 'deleted' as const; },
  } as unknown as AgentAppSlackApi;
  const keyring = loadCredentialKeyring();
  assert.equal(await saveConfigurationToken(
    { credentials: h.stores.settings as unknown as EncryptedCredentialStore, keyring, slack }, TEAM, 'xoxe-1-pasted-token-0000',
  ), 'saved');
  const posted: string[] = [];
  const transport = {
    disableUserGroup: async () => assert.fail('no user group is touched'),
    enableUserGroup: async () => assert.fail('no user group is touched'),
    openDirectConversation: async (userId: string) => ({ id: `D_${userId}`, private: true, member: true, archived: false }),
    postMessage: async (input: { channelId: string; text: string }) => { posted.push(input.text); return { channelId: input.channelId, ts: '1.0' }; },
  } as unknown as AgentAppTransport;
  const service = new AgentSlackApps({
    env: h.env, stores: { config: h.stores.config, settings: h.stores.settings as AppStores['settings'] & EncryptedCredentialStore },
    host: HOST, transport, slack, keyring,
  });

  const live = await h.stores.config.getAgent('agent_support');
  await assert.rejects(() => service.retire(live), (error: unknown) =>
    error instanceof AgentPresenceError &&
    error.message === "Chickpea couldn't remove Support's Slack app, so Support is not archived. Try again in a minute.");
  const kept = (await h.stores.config.getAgent('agent_support')).slackPresence;
  assert.deepEqual(kept?.kind === 'agent_app' && kept.app, LIVE, 'the app is live as it was');
  assert.equal(kept?.desiredState, 'active');
  assert.equal(kept?.health, 'healthy');
  assert.equal((await h.resolve(TEAM, 'agent_support')).botToken, AGENT_BOT, "the Agent still answers as its own bot");
  assert.deepEqual(posted, [], 'a Slack that did not answer is not news for the Owner');
  assert.deepEqual(deletes, []);

  const retired = await service.retire(await h.stores.config.getAgent('agent_support'));
  assert.equal(retired.outcome, 'removed', 'archiving again finishes');
  assert.deepEqual(uninstalls, [AGENT_BOT, AGENT_BOT], 'the uninstall was retried');
  assert.deepEqual(deletes, [APP_ID]);
  assert.equal(retired.agent.slackPresence?.kind, undefined, 'the handle is back with its user group');
}));

test('without the port the resolver is the base resolver, even for an Agent whose record names an app', async (t) => withHarness(t, async (h) => {
  await h.storeApp(LIVE);
  configureAgentSlackApps(undefined);
  assert.equal(await h.resolve(TEAM, 'agent_support'), h.base);
  assert.deepEqual(h.baseCalls, [TEAM]);
}));

test('a live Agent app owns its presentation by name only, and replies carry no persona override', () => {
  const owner = selectSlackPresentationOwner({
    installationHealth: 'healthy', agentId: 'agent_support', agentName: 'Support', conversationKind: 'channel',
    avatarUrl: 'https://core.test/avatar.png', slackPresence: appPresence(LIVE),
  });
  assert.deepEqual(owner, { kind: 'agent_app', agentName: 'Support' });
  const broken = selectSlackPresentationOwner({
    installationHealth: 'healthy', agentId: 'agent_support', agentName: 'Support', conversationKind: 'channel',
    avatarUrl: 'https://core.test/avatar.png', slackPresence: { ...appPresence(REMOVED), health: 'needs_attention' },
  });
  assert.deepEqual(broken, { kind: 'chickpea' });
  const grouped = selectSlackPresentationOwner({
    installationHealth: 'healthy', agentId: 'agent_finance', agentName: 'Finance', conversationKind: 'channel',
    avatarUrl: 'https://core.test/finance.png', slackPresence: groupPresence,
  });
  assert.equal(grouped.kind, 'selected_agent');

  const assignment = { agentId: 'agent_support', agent: agent('agent_support', 'Support', appPresence(LIVE)) } as unknown as ResolvedAssignment;
  assert.deepEqual(turnReplySender(assignment, owner, 'https://core.test/avatar.png'), { agentName: 'Support' });
  assert.deepEqual(turnReplySender(assignment, { kind: 'chickpea' }, 'https://core.test/avatar.png'), { agentName: 'Chickpea' });
});

test("an app Agent's earlier reply reads as its own in thread context", () => {
  const rows = toContextMessages([
    { ts: '1.1', user: 'U1', text: 'hi' },
    { ts: '1.2', user: AGENT_BOT_USER, bot_id: 'BAGENT', text: 'hello from Support' },
    { ts: '1.3', user: 'UBOT', bot_id: 'BMAIN', text: 'hello from Chickpea' },
  ], { botUserId: AGENT_BOT_USER });
  assert.deepEqual(rows.map((row) => [row.ts, row.role]), [['1.1', 'human'], ['1.2', 'agent'], ['1.3', 'app']]);
});
