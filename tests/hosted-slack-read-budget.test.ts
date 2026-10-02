import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { classifyCandidateTurn } from '../src/channels/slack.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import { createGatewaySlackWebClient } from '../src/slack/gateway/web-client.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeSlackInstallationCredentials,
} from '../src/slack/installation-credentials.ts';
import { resolveSlackInstallationExecutionContext } from '../src/slack/installation-execution.ts';
import {
  localSlackPresentationStatePort,
  slackPresentationStatePort,
} from '../src/slack/presentation-state-port.ts';
import { sharesSlackAppReadBudget } from '../src/slack/read-budget.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { hydrateTurnSlackContext } from '../src/slack/turn-context-reads.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { PACED_SLACK_READ_LIMIT } from '../src/slack/web-client-context.ts';

/**
 * The host's one Slack app is not on the Marketplace, so every hosted
 * installation reads history and replies on the shared budget: one read per
 * minute per method per workspace, 15 messages a page. The choice follows
 * the installation, not its transport.
 */

const HOSTED = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_tenant_a' });
const ROOT = '1000.000100';

function turn(patch: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'C1', eventId: 'Ev1', text: 'What did we decide?', userId: 'U1',
    messageTs: '1010.000100', threadTs: ROOT, source: 'implicit_thread_reply', contextMode: 'thread',
    ...patch,
  };
}

/** A Slack client whose replies record each page request. */
function repliesClient() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    conversations: {
      async replies(args: Record<string, unknown>) {
        calls.push(args);
        return {
          ok: true,
          messages: [
            { type: 'message', user: 'U2', ts: ROOT, text: 'root' },
            { type: 'message', user: 'U2', ts: '1005.000100', thread_ts: ROOT, text: 'middle' },
          ],
          response_metadata: { next_cursor: 'more' },
        };
      },
      async history() { return { ok: true, messages: [] }; },
    },
  };
}

/** A shared budget that records each reservation and grants it. */
function budget() {
  const reserved: string[] = [];
  return {
    reserved,
    async reserveSlackRead(workspaceId: string, method: string) {
      reserved.push(`${workspaceId}:${method}`);
      return { outcome: 'reserved' as const, budgetVersion: 1 };
    },
    async applySlackReadCooldown() { return { cooldownUntil: 0, budgetVersion: 1 }; },
  };
}

function withProcessTenancy(t: TestContext, value: string | undefined) {
  const previous = process.env.CHICKPEA_TENANCY;
  if (value === undefined) delete process.env.CHICKPEA_TENANCY;
  else process.env.CHICKPEA_TENANCY = value;
  t.after(() => {
    if (previous === undefined) delete process.env.CHICKPEA_TENANCY;
    else process.env.CHICKPEA_TENANCY = previous;
  });
}

test('every installation of a deployment serving many shares its app\'s read budget', (t) => {
  const gatewayClient = createGatewaySlackWebClient({} as GatewayDeploymentClient);
  assert.equal(sharesSlackAppReadBudget({ transportMode: 'direct' }), false, 'a customer\'s own app');
  assert.equal(sharesSlackAppReadBudget({ transportMode: 'direct', env: {} }), false);
  assert.equal(sharesSlackAppReadBudget({ transportMode: 'gateway' }), true, 'the shared gateway app');
  assert.equal(sharesSlackAppReadBudget({ transportMode: 'direct', env: HOSTED }), true, 'a hosted installation');
  assert.equal(sharesSlackAppReadBudget({ env: HOSTED, client: {} }), true);
  // Without a transport, the client's own marker decides, as before.
  assert.equal(sharesSlackAppReadBudget({ client: gatewayClient }), true);
  assert.equal(sharesSlackAppReadBudget({ client: {} }), false);
  // A caller with no env still gates on a deployment that declares tenancy.
  withProcessTenancy(t, 'installation');
  assert.equal(sharesSlackAppReadBudget({ client: {} }), true);
  assert.equal(sharesSlackAppReadBudget({ transportMode: 'direct' }), true);
});

test('the turn reader pages a hosted installation\'s thread from the budget, 15 rows at a time', async () => {
  const hosted = repliesClient();
  const state = budget();
  const context = await hydrateTurnSlackContext({
    client: hosted as never, turn: turn(), sharedAppReads: true, state,
  });
  assert.deepEqual(state.reserved, ['T1:conversations.replies']);
  assert.equal(hosted.calls.length, 1, 'one capped page, not the whole thread');
  assert.equal(hosted.calls[0]?.limit, PACED_SLACK_READ_LIMIT);
  assert.equal(context.truncated, true);

  // Standalone direct is unchanged: large pages, no budget.
  const standalone = repliesClient();
  const unpaced = budget();
  await hydrateTurnSlackContext({ client: standalone as never, turn: turn(), sharedAppReads: false, state: unpaced });
  assert.deepEqual(unpaced.reserved, []);
  assert.equal(standalone.calls[0]?.limit, 200);
});

test('a hosted candidate classifier leaves the shared read to its turn', async (t) => {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = ':memory:';
  closeNodeStateStores();
  const config = new SqliteConfigStore(':memory:');
  t.after(() => {
    config.close();
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  const agent = await config.createAgent({
    id: 'agent_classifier', name: 'Classifier', instructions: '', enabled: true, lifecycle: 'active',
    creatorMembershipId: 'owner', editPolicy: 'creator_and_admins', skills: [], mcpServers: [],
    apiConnections: [], repositories: [],
  });
  const assignment = { workspaceId: 'T1', channelId: 'C1', agentId: agent.id, agent, runtimeContract: 'chickpea-v1' as const };
  const classify = async () => ({ intent: { disposition: 'reply' as const, reason: 'substantive_request' as const }, failed: false });
  const hosted = repliesClient();
  await classifyCandidateTurn(turn(), assignment, HOSTED, hosted as never, {
    config, classify, installation: { transportMode: 'direct', botUserId: 'UBOT' },
  });
  assert.equal(hosted.calls.length, 0, 'the turn spends the one read a minute, not its classifier');

  const standalone = repliesClient();
  await classifyCandidateTurn(turn(), assignment, undefined, standalone as never, {
    config, classify, installation: { transportMode: 'direct', botUserId: 'UBOT' },
  });
  assert.ok(standalone.calls.length > 0, 'a customer\'s own app still classifies with context');
});

test('a hosted turn reads its thread on the budget, whatever its transport', async (t) => {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = ':memory:';
  closeNodeStateStores();
  t.after(() => {
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  const replies = repliesClient();
  const client = {
    ...replies,
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      startStream: async () => ({ ok: true, ts: 'final-ts' }),
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true, channel: 'C1', ts: 'final-ts' }),
    },
  } as unknown as WebClient;
  const config = resolveStores().config;
  const agent = await config.createAgent({
    id: 'agent_reader', name: 'Reader', instructions: '', enabled: true, lifecycle: 'active',
    creatorMembershipId: 'owner', editPolicy: 'creator_and_admins', skills: [], mcpServers: [],
    apiConnections: [], repositories: [], model: 'local-stub/reader',
  });
  await runTurn({ ...turn(), interactionIntent: { disposition: 'reply', reason: 'substantive_request' } }, {
    workspaceId: 'T1', channelId: 'C1', agentId: agent.id, agent, runtimeContract: 'legacy', model: 'local-stub/reader',
  }, undefined, {
    installationContext: {
      workspaceId: 'T1', transportMode: 'direct', sharedAppReads: true, botToken: 'xoxb-hosted',
      botUserId: 'UBOT', client,
    },
    replayText: 'Done.',
    usageRecordingEnabled: false,
  });
  assert.equal(replies.calls.length, 1);
  assert.equal(replies.calls[0]?.limit, PACED_SLACK_READ_LIMIT);
});

test('the execution context reports whether an installation shares the app\'s budget', async (t) => {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH', 'CHICKPEA_CREDENTIAL_KEYRING_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-read-budget-'));
  for (const key of keys.slice(0, 3)) process.env[key] = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'keyring.json');
  const previousFetch = globalThis.fetch;
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
  t.after(() => {
    globalThis.fetch = previousFetch;
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  const stores = resolveStores();
  await writeSlackInstallationCredentials({ state: stores.identity, keyring: loadCredentialKeyring() },
    WORKSPACE_SLACK_INSTALLATION_ID, null, {
      botToken: 'xoxb-own-app', signingSecret: 'secret', botUserId: 'UBOT', appId: 'A1', teamId: 'T1',
    });
  await stores.config.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'direct', teamId: 'T1', appId: 'A1', botUserId: 'UBOT',
  });
  globalThis.fetch = (async () => Response.json({
    ok: true, team_id: 'T1', user_id: 'UBOT', app_id: 'A1', bot_id: 'BBOT',
  })) as unknown as typeof fetch;
  const context = await resolveSlackInstallationExecutionContext('T1');
  assert.equal(context.sharedAppReads, false, 'a customer\'s own app reads with its own limits');
});

test('a hosted turn without a resolved context gates its reads from the deployment', async (t) => {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = ':memory:';
  closeNodeStateStores();
  t.after(() => {
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  const replies = repliesClient();
  const client = {
    ...replies,
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      startStream: async () => ({ ok: true, ts: 'final-ts' }),
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true, channel: 'C1', ts: 'final-ts' }),
    },
  } as unknown as WebClient;
  const config = resolveStores().config;
  const agent = await config.createAgent({
    id: 'agent_reader', name: 'Reader', instructions: '', enabled: true, lifecycle: 'active',
    creatorMembershipId: 'owner', editPolicy: 'creator_and_admins', skills: [], mcpServers: [],
    apiConnections: [], repositories: [], model: 'local-stub/reader',
  });
  await runTurn({ ...turn(), interactionIntent: { disposition: 'reply', reason: 'substantive_request' } }, {
    workspaceId: 'T1', channelId: 'C1', agentId: agent.id, agent, runtimeContract: 'legacy', model: 'local-stub/reader',
  }, HOSTED, { client, replayText: 'Done.', usageRecordingEnabled: false });
  assert.equal(replies.calls.length, 1);
  assert.equal(replies.calls[0]?.limit, PACED_SLACK_READ_LIMIT);
});

test('a hosted installation\'s presentation ports carry its workspace read budget', async (t) => {
  const presentations = new SlackRunPresentationStoreLogic(openStateDb(':memory:'));
  const local = (sharedReadsEnv?: Record<string, unknown>) => localSlackPresentationStatePort({
    presentations, matchFlueObservation: () => undefined, ...(sharedReadsEnv ? { sharedReadsEnv } : {}),
  });
  assert.equal(local().sharedSlackReads, undefined, 'a runner\'s own store holds no shared budget');
  assert.equal(local({}).sharedSlackReads, undefined);
  const hosted = local(HOSTED).sharedSlackReads;
  assert.ok(hosted);
  assert.equal((await hosted.reserveSlackRead!('T1', 'conversations.replies')).outcome, 'reserved');
  assert.equal((await hosted.reserveSlackRead!('T1', 'conversations.replies')).outcome, 'exhausted',
    'the same workspace row the turn reads book from');

  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = ':memory:';
  closeNodeStateStores();
  t.after(() => {
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  const state = resolveStores().slackState;
  assert.ok(slackPresentationStatePort(state, HOSTED)?.sharedSlackReads);
  assert.equal(slackPresentationStatePort(state)?.sharedSlackReads, undefined);
  assert.equal(slackPresentationStatePort(state, {})?.sharedSlackReads, undefined);
});
