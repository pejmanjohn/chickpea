import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { installationOwnershipOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { closeNodeStateStores, getIdentityStore, type PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SqliteSlackStateStore } from '../src/slack/claim-store.ts';
import {
  askOwnersForCredits,
  CREDITS_ASK_ADMIN_ACTION,
  CREDITS_ASK_ADMIN_BLOCK,
  CREDITS_ASK_CONFIRMATION_TEXT,
  CREDITS_ASK_UNREACHABLE_TEXT,
  CREDITS_OWNER_HINT_TEXT,
  creditsAskOwnerDmText,
  creditsExhaustedComponents,
  parseCreditsAskAction,
  type CreditsAskAction,
  type CreditsAskClient,
} from '../src/slack/credits-ask.ts';
import { AgentPromptFailure } from '../src/slack/flue-dispatch.ts';
import { parsePrivateChannelSetupAction } from '../src/slack/private-channel-setup.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { parseSlackUiBlockAction } from '../src/slack/ui/interaction-payload.ts';
import { CREDITS_EXHAUSTED_TEXT } from '../src/slack/web-client-presenter.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * A hosted turn that stops because the installation is out of credits offers
 * its requester an "Ask an admin" button. A click DMs each active Owner at
 * most once an hour and redraws the reply with a confirmation. Standalone
 * never shows any of it.
 */

const TEAM = 'TCREDITS1';
const CHANNEL = 'CCREDITS1';
const REPLY_TS = '1800000000.000600';
const THREAD_TS = '1800000000.000100';
const HOUR_MS = 3_600_000;
const HOSTED_ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_credits' });

const ASSIGNMENT: ResolvedAssignment = {
  workspaceId: TEAM,
  channelId: 'DCREDITS1',
  agentId: 'agent_credits',
  model: 'local-stub/credits',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_credits', kind: 'user', revision: 1, name: 'Credits Agent', instructions: 'Answer directly.',
    enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
};

function dmTurn(messageTs: string, userId: string): NormalizedSlackTurn {
  return {
    workspaceId: TEAM, channelId: ASSIGNMENT.channelId, channelType: 'im',
    eventId: `Ev_CREDITS_${messageTs}`, text: 'Summarize the plan.', userId,
    messageTs, threadTs: messageTs, source: 'dm_message', contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

/** Local state for a turn, with its installation; returns the identity store the turn reads. */
async function turnState(t: TestContext): Promise<IdentityStore> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-credits-turn-'));
  const statePath = join(directory, 'state.sqlite');
  const keys = ['SLACK_STATE_DB_PATH', 'TAG_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = statePath;
  closeNodeStateStores();
  resetInstallationAdmissionForTests();
  configureInstallationAdmission(async () => 'admitted');
  t.after(() => {
    resetInstallationAdmissionForTests();
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  const config = new SqliteConfigStore(statePath, { agents: [] });
  await config.createAgent(ASSIGNMENT.agent);
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: TEAM, transportMode: 'direct', defaultAgentId: ASSIGNMENT.agentId,
    teamId: TEAM, botUserId: 'UCHICKPEA',
  });
  await config.updateWorkspaceInstallation(TEAM, { health: 'healthy' }, installation.revision);
  config.close();
  return getIdentityStore();
}

let turnCount = 0;

/**
 * Runs one turn that fails out of credits on a durable presentation and
 * returns every Slack write. `streamRejected`: Slack refuses the stream, so the
 * reply is posted as one message instead.
 */
async function outOfCreditsTurn(
  t: TestContext,
  env: PlatformEnv | undefined,
  requester: string,
  options: { streamRejected?: boolean; failure?: AgentPromptFailure } = {},
) {
  turnCount += 1;
  const turn = dmTurn(`18000000${String(turnCount).padStart(2, '0')}.000100`, requester);
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: ASSIGNMENT, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  t.after(() => { db.close(); work.close(); });
  const store = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3, runId, turnJobId: `turn_${runId}`, bindingId: `binding_${runId}`,
    workBindingGeneration: 1, runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Credits Agent', avatarUrl: 'https://chickpea.example/assets/agents/credits/avatar/1', avatarRevision: 1,
    } },
    sessionGeneration,
    currentActivity: {
      kind: 'preparing', action: 'Preparing', object: 'your request', generation: sessionGeneration, sequence: 1,
      operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
    root: {
      workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs, requesterUserId: turn.userId,
    },
  });
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const record = (method: string) => async (input: Record<string, unknown>) => {
    calls.push({ method, input });
    return { ok: true, ts: REPLY_TS, channel: turn.channelId };
  };
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }), setTitle: async () => ({ ok: true }) } },
    conversations: {
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: options.streamRejected
        ? async () => {
            throw Object.assign(new Error('An API error occurred: not_allowed'), {
              code: 'slack_webapi_platform_error', data: { ok: false, error: 'not_allowed' },
            });
          }
        : record('chat.startStream'),
      appendStream: record('chat.appendStream'),
      stopStream: record('chat.stopStream'), postMessage: record('chat.postMessage'),
      update: record('chat.update'), delete: record('chat.delete'), postEphemeral: record('chat.postEphemeral'),
    },
  } as unknown as WebClient;
  const state = {
    getRunPresentation: (id: string) => store.get(id),
    getLatestThreadSessionGeneration: (root: Parameters<typeof store.getLatestThreadSessionGeneration>[0]) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<typeof store.transition>[0]) => store.transition(input),
    reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
  const installation = installationOwnershipOf(env);
  const runtimePlan = compileRuntimePlanV2({
    ...(installation ? { installation } : {}),
    turn, assignment: ASSIGNMENT, instructions: 'Answer directly.', memoryEpoch: 1,
  });
  await runTurn(turn, ASSIGNMENT, env, {
    client, runId, turnId: `turn_${runId}`, presentationState: state, statusRegistry: new SlackStatusRegistry(),
    workStore: work, usageRecordingEnabled: false,
    runtimePlanDecision: { runtimePlan, instanceId: deriveRuntimePlanInstanceId(runtimePlan) },
    agentPrompt: async () => { throw options.failure ?? new AgentPromptFailure('credits-exhausted'); },
  });
  return calls;
}

type Block = Record<string, unknown>;

function writtenBlocks(calls: Array<{ input: Record<string, unknown> }>): Block[] {
  return calls.flatMap(({ input }) => Array.isArray(input.blocks) ? input.blocks as Block[] : []);
}

/** The reply's text as a reader sees it: streamed, or in a content block. */
function visibleTexts(calls: Array<{ input: Record<string, unknown> }>): unknown[] {
  return calls.flatMap(({ input }) => [
    input.markdown_text,
    ...(Array.isArray(input.chunks) ? (input.chunks as Block[]).map((chunk) => chunk.text) : []),
    ...(Array.isArray(input.blocks) ? (input.blocks as Block[]) : [])
      .filter((block) => block.type === 'markdown' || block.type === 'section')
      .map((block) => typeof block.text === 'string' ? block.text : (block.text as Block | undefined)?.text),
  ]);
}

function buttons(blocks: Block[]): Block[] {
  return blocks.flatMap((block) => block.type === 'actions' ? block.elements as Block[] : [])
    .filter((element) => element.type === 'button');
}

function contextTexts(blocks: Block[]): string[] {
  return blocks.flatMap((block) => block.type === 'context' ? block.elements as Block[] : [])
    .map((element) => String(element.text));
}

test('a hosted member\'s out-of-credits reply shows the text and one Ask an admin button', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER1' });
  const streamed = await outOfCreditsTurn(t, HOSTED_ENV, 'UMEMBER1');
  const posted = await outOfCreditsTurn(t, HOSTED_ENV, 'UMEMBER1', { streamRejected: true });
  assert.deepEqual(posted.map(({ method }) => method), ['chat.postMessage']);
  for (const calls of [streamed, posted]) {
    assert.ok(visibleTexts(calls).includes(CREDITS_EXHAUSTED_TEXT),
      'the out-of-credits text is shown, not only kept as fallback text');
    const blocks = writtenBlocks(calls);
    assert.deepEqual(buttons(blocks), [{
      type: 'button',
      action_id: CREDITS_ASK_ADMIN_ACTION,
      text: { type: 'plain_text', text: 'Ask an admin', emoji: false },
      value: TEAM,
    }]);
    assert.equal(contextTexts(blocks).includes(CREDITS_OWNER_HINT_TEXT), false);
  }
});

test('a hosted Owner\'s out-of-credits reply has no button, only the Owner hint', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  const blocks = writtenBlocks(await outOfCreditsTurn(t, HOSTED_ENV, 'UOWNER1'));
  assert.deepEqual(buttons(blocks), []);
  assert.ok(contextTexts(blocks).includes(
    "You're an Owner, so you can add extra usage or upgrade in Chickpea.",
  ), JSON.stringify(blocks));
});

test('a standalone out-of-credits reply shows neither the button nor the Owner hint', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER1' });
  for (const requester of ['UMEMBER1', 'UOWNER1']) {
    const calls = await outOfCreditsTurn(t, undefined, requester);
    const written = JSON.stringify(calls);
    assert.ok(written.includes(CREDITS_EXHAUSTED_TEXT), 'the failure is still told');
    assert.equal(written.includes(CREDITS_ASK_ADMIN_ACTION), false);
    assert.equal(written.includes(CREDITS_OWNER_HINT_TEXT), false);
  }
});

test('a hosted turn that fails for another reason offers no button', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER1' });
  const calls = await outOfCreditsTurn(t, HOSTED_ENV, 'UMEMBER1', { failure: new AgentPromptFailure('provider') });
  assert.ok(calls.length > 0, 'the failure is still told');
  assert.equal(JSON.stringify(calls).includes(CREDITS_ASK_ADMIN_ACTION), false);
});

/** An identity with active Owners UOWNER1 and UOWNER2, a suspended Owner UOWNER3, and member UMEMBER1. */
async function workspace(t: TestContext) {
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => identity.close());
  const first = await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  const promote = async (slackUserId: string, patch: { status?: 'suspended' } = {}) => {
    const { resolution } = await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId });
    await identity.updateMembershipAuthority({
      membershipId: resolution.membership.id, role: 'owner', actorMembershipId: first.membership.id,
      correlationId: `promote_${slackUserId}`, authenticationSurface: 'better_auth', reasonCode: 'credits_test',
    });
    if (patch.status) {
      await identity.updateMembershipAuthority({
        membershipId: resolution.membership.id, status: patch.status, actorMembershipId: first.membership.id,
        correlationId: `suspend_${slackUserId}`, authenticationSurface: 'better_auth', reasonCode: 'credits_test',
      });
    }
  };
  await promote('UOWNER2');
  await promote('UOWNER3', { status: 'suspended' });
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER1' });
  return identity;
}

/** A Slack that records every write; `failDms` refuses every DM. */
function slack(options: { failDms?: boolean } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const record = (method: string) => async (input: Record<string, unknown>) => {
    calls.push({ method, input });
    if (method === 'conversations.open') {
      if (options.failDms) throw new Error('cannot_dm');
      return { ok: true, channel: { id: `D${String(input.users).slice(1)}` } };
    }
    return { ok: true, ts: '1800000099.000100' };
  };
  const client = {
    conversations: { open: record('conversations.open') },
    chat: {
      postMessage: record('chat.postMessage'),
      update: record('chat.update'),
      postEphemeral: record('chat.postEphemeral'),
    },
  } as unknown as CreditsAskClient;
  const of = (method: string) => calls.filter((call) => call.method === method).map(({ input }) => input);
  return { client, calls, of };
}

const FOOTER: Block = { type: 'context', elements: [{ type: 'mrkdwn', text: 'Credits Agent' }] };

/** The reply as Slack echoes it in a click: its text, the button, and the footer. */
async function replyBlocks(): Promise<Block[]> {
  const components = await creditsExhaustedComponents({
    env: HOSTED_ENV,
    identity: {
      resolveSlackIdentity: async () => undefined,
      listMemberships: async () => [],
      listExternalIdentities: async () => [],
    },
    workspaceId: TEAM,
    userId: 'UMEMBER1',
  });
  assert.ok(components);
  return [{ type: 'rich_text', elements: [] }, ...components.blocks, FOOTER];
}

async function clickPayload(patch: {
  user?: string; value?: string; actionId?: string; container?: Record<string, unknown>; channel?: string;
  blocks?: Block[];
} = {}) {
  return {
    type: 'block_actions', api_app_id: 'AHOSTED1', trigger_id: 'trigger1',
    team: { id: TEAM }, user: { id: patch.user ?? 'UMEMBER1' }, channel: { id: patch.channel ?? CHANNEL },
    container: { type: 'message', channel_id: CHANNEL, message_ts: REPLY_TS, ...patch.container },
    message: {
      ts: REPLY_TS, thread_ts: THREAD_TS, text: CREDITS_EXHAUSTED_TEXT, blocks: patch.blocks ?? await replyBlocks(),
    },
    actions: [{
      action_id: patch.actionId ?? CREDITS_ASK_ADMIN_ACTION, block_id: CREDITS_ASK_ADMIN_BLOCK, type: 'button',
      value: patch.value ?? TEAM, action_ts: '1800000001.000100',
    }],
  };
}

async function click(user = 'UMEMBER1'): Promise<CreditsAskAction> {
  const action = parseCreditsAskAction(await clickPayload({ user }));
  assert.ok(action);
  return action;
}

test('a click DMs each active Owner once and swaps only the button for a confirmation', async (t) => {
  const identity = await workspace(t);
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const { client, of } = slack();
  const action = await click();
  assert.equal(await askOwnersForCredits(action, { identity, claims, client }), 'asked');

  assert.deepEqual(of('conversations.open').map(({ users }) => users).sort(), ['UOWNER1', 'UOWNER2']);
  const dm = '<@UMEMBER1> asked you to add usage to Chickpea. ' +
    'A request in <#CCREDITS1> stopped because this workspace has used all of its plan\'s usage.';
  assert.deepEqual(
    of('chat.postMessage').sort((a, b) => String(a.channel).localeCompare(String(b.channel))),
    [{ channel: 'DOWNER1', text: dm }, { channel: 'DOWNER2', text: dm }],
  );
  const before = action.message.blocks;
  assert.deepEqual(of('chat.update'), [{
    channel: CHANNEL,
    ts: REPLY_TS,
    text: CREDITS_EXHAUSTED_TEXT,
    blocks: [
      before[0],
      {
        type: 'context',
        elements: [{ type: 'plain_text', text: "I asked this workspace's Owners to add usage.", emoji: false }],
      },
      FOOTER,
    ],
  }]);
  assert.deepEqual(of('chat.postEphemeral'), []);
  assert.equal(creditsAskOwnerDmText('UMEMBER1', 'DCREDITS1'),
    '<@UMEMBER1> asked you to add usage to Chickpea. ' +
    'A request in a direct message stopped because this workspace has used all of its plan\'s usage.');
});

test('Owners are asked at most once an hour per installation', async (t) => {
  const identity = await workspace(t);
  const start = Math.floor(1_800_000_000_000 / HOUR_MS) * HOUR_MS + 50 * 60_000;
  let now = start;
  const claims = new SqliteSlackStateStore(':memory:', () => now);
  t.after(() => claims.close());
  const { client, of } = slack();
  const ask = async () => askOwnersForCredits(await click(), { identity, claims, client, now: () => now });

  assert.equal(await ask(), 'asked');
  assert.equal(of('chat.postMessage').length, 2);

  now = start + 1_000;
  assert.equal(await ask(), 'already_asked');
  assert.equal(of('chat.postMessage').length, 2, 'a second click sends nothing');
  assert.ok(contextTexts(of('chat.update')[1]!.blocks as Block[]).includes(CREDITS_ASK_CONFIRMATION_TEXT),
    'the second clicker also sees the confirmation');

  now = start + 59 * 60_000;
  assert.equal(Math.floor(now / HOUR_MS), Math.floor(start / HOUR_MS) + 1, 'the clock hour turned');
  assert.equal(await ask(), 'already_asked');
  assert.equal(of('chat.postMessage').length, 2, '59 minutes later, across the hour, sends nothing');

  now = start + 2 * HOUR_MS;
  assert.equal(await ask(), 'asked');
  assert.equal(of('chat.postMessage').length, 4, 'two hours later the Owners are asked again');
});

test('an Owner who clicks is told privately and nothing is sent', async (t) => {
  const identity = await workspace(t);
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const { client, calls } = slack();
  assert.equal(await askOwnersForCredits(await click('UOWNER1'), { identity, claims, client }), 'owner');
  assert.deepEqual(calls, [{
    method: 'chat.postEphemeral',
    input: { channel: CHANNEL, user: 'UOWNER1', text: CREDITS_OWNER_HINT_TEXT, thread_ts: THREAD_TS },
  }]);
});

test('with no reachable Owner the clicker is told, and a later click can still ask', async (t) => {
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => identity.close());
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const failed = 'I couldn\'t reach this workspace\'s Owners. Try again in a few minutes.';
  assert.equal(failed, CREDITS_ASK_UNREACHABLE_TEXT);

  const nobody = slack();
  assert.equal(await askOwnersForCredits(await click(), { identity, claims, client: nobody.client }), 'unreachable');
  assert.deepEqual(nobody.calls, [{
    method: 'chat.postEphemeral',
    input: { channel: CHANNEL, user: 'UMEMBER1', text: failed, thread_ts: THREAD_TS },
  }], 'the button stays');

  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  const refused = slack({ failDms: true });
  assert.equal(await askOwnersForCredits(await click(), { identity, claims, client: refused.client }), 'unreachable');
  assert.deepEqual(refused.of('chat.postEphemeral').map(({ text }) => text), [failed]);
  assert.deepEqual(refused.of('chat.update'), []);

  const reachable = slack();
  assert.equal(await askOwnersForCredits(await click(), { identity, claims, client: reachable.client }), 'asked');
  assert.deepEqual(reachable.of('chat.postMessage').map(({ channel }) => channel), ['DOWNER1']);
});

test('a click whose identity read fails tells the clicker and sends nothing', async (t) => {
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const down = async () => { throw new Error('identity_unavailable'); };
  const { client, calls } = slack();
  const identity = { resolveSlackIdentity: down, listMemberships: down, listExternalIdentities: down };
  assert.equal(await askOwnersForCredits(await click(), { identity, claims, client }), 'unreachable');
  assert.deepEqual(calls, [{
    method: 'chat.postEphemeral',
    input: { channel: CHANNEL, user: 'UMEMBER1', text: CREDITS_ASK_UNREACHABLE_TEXT, thread_ts: THREAD_TS },
  }]);
});

test('a reply whose echoed blocks lack its text gets the confirmation privately instead', async (t) => {
  const identity = await workspace(t);
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const { client, of } = slack();
  const blocks = (await replyBlocks()).slice(1);
  const action = parseCreditsAskAction(await clickPayload({ blocks }));
  assert.ok(action);
  assert.equal(await askOwnersForCredits(action, { identity, claims, client }), 'asked');
  assert.deepEqual(of('chat.update'), []);
  assert.deepEqual(of('chat.postEphemeral').map(({ text }) => text), [CREDITS_ASK_CONFIRMATION_TEXT]);
});

test('the click parser accepts only this installation\'s own button on a shared message', async () => {
  const valid = await clickPayload();
  assert.deepEqual(parseCreditsAskAction(valid), {
    workspaceId: TEAM,
    userId: 'UMEMBER1',
    channelId: CHANNEL,
    messageTs: REPLY_TS,
    threadTs: THREAD_TS,
    message: { text: CREDITS_EXHAUSTED_TEXT, blocks: valid.message.blocks },
  });
  assert.equal(parseSlackUiBlockAction(valid), undefined, 'the host UI parser never claims it');
  assert.equal(parsePrivateChannelSetupAction(valid), undefined);

  assert.equal(parseCreditsAskAction(await clickPayload({ value: 'TOTHERTEAM' })), undefined, 'another team\'s value');
  assert.equal(parseCreditsAskAction(await clickPayload({ container: { is_ephemeral: true } })), undefined, 'ephemeral');
  assert.equal(parseCreditsAskAction(await clickPayload({ channel: 'COTHER1' })), undefined, 'channel mismatch');
  for (const actionId of ['chickpea.ui.v1.ask_admin', 'chickpea.private_channel_setup.v1.add', 'ask_admin']) {
    assert.equal(parseCreditsAskAction(await clickPayload({ actionId })), undefined, actionId);
  }
  assert.equal(parseCreditsAskAction({ ...valid, actions: [...valid.actions, ...valid.actions] }), undefined);
});
