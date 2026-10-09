import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { EncryptedCredentialStore } from '../src/config/settings-store.ts';
import { closeNodeStateStores, resolveStores, type AppStores, type PlatformEnv } from '../src/config/state-backend.ts';
import type { AgentAppLifecycle, AgentSlackPresence, CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import { withAgentAppExecution } from '../src/slack/agent-apps/index.ts';
import { writeAppSecrets } from '../src/slack/agent-apps/secrets.ts';
import { createAgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { selectSlackPresentationOwner } from '../src/slack/claim-store.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  SlackInstallationUnavailableError,
  type SlackInstallationExecutionContext,
} from '../src/slack/installation-execution.ts';
import { invalidateSlackInstallationCredentialCache } from '../src/slack/installation-credentials.ts';
import { turnReplySender } from '../src/slack/run-turn.ts';
import { toContextMessages } from '../src/slack/thread-context.ts';
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
