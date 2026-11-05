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
import { OUT_OF_USAGE_CAUSE_KINDS, type PlatformFundingRefusal } from '../src/config/platform-funding.ts';
import { closeNodeStateStores, getIdentityStore, type PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SqliteSlackStateStore } from '../src/slack/claim-store.ts';
import {
  CREDITS_ASK_ADMIN_ACTION,
  CREDITS_ASK_ADMIN_BLOCK,
  DAILY_LIMIT_ASK_ACTION,
  fundingRefusalText,
  OUT_OF_USAGE_TEXT,
  parseCreditsAskAction,
  type CreditsAskAction,
} from '../src/slack/credits-ask.ts';
import {
  askOwnersForCredits,
  CREDITS_ASK_UNREACHABLE_TEXT,
  creditsAskOwnerDmText,
  fundingRefusalReply,
  postPrivateNote,
  type CreditsAskClient,
  type CreditsAskDeps,
} from '../src/slack/funding-refusal-reply.ts';
import { AgentPromptFailure } from '../src/slack/flue-dispatch.ts';
import { parsePrivateChannelSetupAction } from '../src/slack/private-channel-setup.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { parseSlackUiBlockAction } from '../src/slack/ui/interaction-payload.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * A hosted turn that stops because the installation is out of usage, or at a
 * daily limit, gets the same thread reply for every role: why, the Owners'
 * names and an Ask an Owner button. An Owner who asked also gets a private
 * reply with the cause and Plan page buttons. A Member's click DMs each
 * active Owner at most once in two clock hours and redraws the reply with
 * whom it asked. Standalone never shows any of it.
 */

const TEAM = 'TCREDITS1';
const CHANNEL = 'CCREDITS1';
const REPLY_TS = '1800000000.000600';
const THREAD_TS = '1800000000.000100';
const HOUR_MS = 3_600_000;
const HOSTED_ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_credits' });
const RESUMES_AT = Date.UTC(2026, 10, 5);
const RESUMES = '<!date^1793836800^{date_short_pretty} at {time}|Nov 5, 2026 at 00:00 UTC>';
const WORKSPACE_LIMIT = { kind: 'daily_limit', scope: 'workspace', resumesAt: RESUMES_AT } as const;
const FLEET_LIMIT = { ...WORKSPACE_LIMIT, scope: 'fleet' } as const;
const DAILY_LIMIT = new AgentPromptFailure(WORKSPACE_LIMIT);
const PUBLIC_URL = 'https://admin.chickpea.example';
const plan = (step: string) => `${PUBLIC_URL}/admin/plan?step=${step}`;
const AT_LIMIT = { kind: 'credits_exhausted', cause: { kind: 'top_up_limit', limitCents: 5_000 } } as const;

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
  const config = new SqliteConfigStore(statePath, agentRoutineDeletion, { agents: [] });
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
  options: {
    streamRejected?: boolean; failure?: AgentPromptFailure; setupWake?: NormalizedSlackTurn['setupWake']; publicUrl?: string;
  } = {},
) {
  turnCount += 1;
  const turn: NormalizedSlackTurn = {
    ...dmTurn(`18000000${String(turnCount).padStart(2, '0')}.000100`, requester),
    ...(options.setupWake ? { setupWake: options.setupWake } : {}),
  };
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
    workStore: work, usageRecordingEnabled: false, publicUrl: options.publicUrl ?? null,
    runtimePlanDecision: { runtimePlan, instanceId: deriveRuntimePlanInstanceId(runtimePlan) },
    agentPrompt: async () => { throw options.failure ?? new AgentPromptFailure('credits-exhausted'); },
  });
  return Object.assign(calls, { threadTs: turn.threadTs });
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

const ASK_BUTTON = (actionId: string, value: string) => ({
  type: 'button', action_id: actionId, text: { type: 'plain_text', text: 'Ask an Owner', emoji: false }, value,
});

/** The Owner's private reply as Slack is sent it: the text, then a Plan page button for each step. */
function ownerNote(text: string, steps: Array<[label: string, step: string]>): { text: string; blocks: Block[] } {
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: steps.map(([label, step], index) => ({
          type: 'button', action_id: `chickpea.credits.v1.plan.${step}`, url: plan(step),
          text: { type: 'plain_text', text: label, emoji: false },
          ...(index === 0 ? { style: 'primary' } : {}),
        })),
      },
    ],
  };
}

async function named(identity: IdentityStore, slackUserId: string, displayName: string): Promise<void> {
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId, displayName });
}

test('a hosted member\'s out-of-usage reply names the Owners, offers one Ask an Owner button, and tells nothing private', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  await named(identity, 'UOWNER1', 'Pejman');
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER1' });
  const failure = new AgentPromptFailure(AT_LIMIT);
  const streamed = await outOfCreditsTurn(t, HOSTED_ENV, 'UMEMBER1', { failure, publicUrl: PUBLIC_URL });
  const posted = await outOfCreditsTurn(t, HOSTED_ENV, 'UMEMBER1', { failure, publicUrl: PUBLIC_URL, streamRejected: true });
  assert.deepEqual(posted.map(({ method }) => method), ['chat.postMessage'], 'one reply, and no private one');
  for (const calls of [streamed, posted]) {
    assert.ok(visibleTexts(calls).includes(OUT_OF_USAGE_TEXT), 'the text is shown, not only kept as fallback text');
    const blocks = writtenBlocks(calls);
    assert.deepEqual(buttons(blocks), [ASK_BUTTON(CREDITS_ASK_ADMIN_ACTION, TEAM)], 'the button carries no private cause');
    assert.ok(contextTexts(blocks).includes('Owners: Pejman.'), JSON.stringify(blocks));
    assert.doesNotMatch(JSON.stringify(calls), /\$50|top-up|limit/i, 'shared channels can include people outside the company');
    assert.equal(calls.some(({ method }) => method === 'chat.postEphemeral'), false);
  }
});

test('a hosted Owner gets the same reply, then a private one in the thread with the cause and Plan page buttons', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  await named(identity, 'UOWNER1', 'Pejman');
  const owner = 'Auto top-up reached its $50 limit for this month. Raise the limit or upgrade, then send this again.';
  for (const streamRejected of [false, true]) {
    const calls = await outOfCreditsTurn(t, HOSTED_ENV, 'UOWNER1', {
      failure: new AgentPromptFailure(AT_LIMIT), publicUrl: PUBLIC_URL, streamRejected,
    });
    const note = calls.at(-1)!;
    assert.equal(note.method, 'chat.postMessage', 'a DM holds only the Owner and the Agent, so the reply is ordinary');
    const { username, icon_url: _icon, ...sent } = note.input;
    assert.equal(username, 'Credits Agent', 'as the Agent that was asked');
    assert.deepEqual(sent, { channel: ASSIGNMENT.channelId, thread_ts: calls.threadTs, ...ownerNote(owner, [
      ['Raise limit', 'raise-limit'], ['Upgrade plan', 'upgrade'],
    ]) });
    const reply = calls.slice(0, -1);
    assert.ok(visibleTexts(reply).includes(OUT_OF_USAGE_TEXT), JSON.stringify(visibleTexts(reply)));
    assert.ok(contextTexts(writtenBlocks(reply)).includes('Owners: Pejman.'));
    assert.deepEqual(buttons(writtenBlocks(reply)), [ASK_BUTTON(CREDITS_ASK_ADMIN_ACTION, TEAM)], 'the same button as everyone');
    assert.doesNotMatch(JSON.stringify(reply), /\$50|top-up/i);
  }
});

test('a setup\'s wake that runs out of usage still says the connection is connected', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  const notice = '✅ Knowledge Base is now connected to Credits Agent.';
  const calls = await outOfCreditsTurn(t, HOSTED_ENV, 'UOWNER1', {
    setupWake: { setupOperationId: 'setup_kb', notice },
  });
  assert.ok(visibleTexts(calls).includes(`${notice}\n\n${OUT_OF_USAGE_TEXT}`), JSON.stringify(visibleTexts(calls)));
  const plain = await outOfCreditsTurn(t, HOSTED_ENV, 'UOWNER1');
  assert.ok(!visibleTexts(plain).some((text) => String(text).includes(notice)), 'a person\'s own turn carries no notice');
});

test('a standalone out-of-usage reply shows neither the button nor a private reply', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER1' });
  for (const requester of ['UMEMBER1', 'UOWNER1']) {
    const calls = await outOfCreditsTurn(t, undefined, requester, { publicUrl: PUBLIC_URL, streamRejected: true });
    const written = JSON.stringify(calls);
    assert.ok(written.includes(OUT_OF_USAGE_TEXT), 'the failure is still told');
    assert.equal(written.includes(CREDITS_ASK_ADMIN_ACTION), false);
    assert.equal(written.includes('Add usage or upgrade'), false);
    assert.deepEqual(calls.map(({ method }) => method), ['chat.postMessage']);
  }
});

test('a hosted member\'s daily-limit reply says when the limit resets and offers its own Ask an Owner button', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER1' });
  const reply = "This workspace has reached today's free trial limit, so I can't start this one. " +
    `The limit resets ${RESUMES}, or an Owner can choose a plan to continue now.`;
  assert.equal(fundingRefusalText(WORKSPACE_LIMIT), reply);
  const streamed = await outOfCreditsTurn(t, HOSTED_ENV, 'UMEMBER1', { failure: DAILY_LIMIT });
  const posted = await outOfCreditsTurn(t, HOSTED_ENV, 'UMEMBER1', { failure: DAILY_LIMIT, streamRejected: true });
  assert.deepEqual(posted.map(({ method }) => method), ['chat.postMessage']);
  for (const calls of [streamed, posted]) {
    assert.ok(visibleTexts(calls).includes(reply), JSON.stringify(visibleTexts(calls)));
    assert.deepEqual(buttons(writtenBlocks(calls)), [ASK_BUTTON(DAILY_LIMIT_ASK_ACTION, `${TEAM}:workspace:1793836800`)]);
    assert.equal(JSON.stringify(calls).includes(OUT_OF_USAGE_TEXT), false);
  }
  assert.equal(posted[0]!.input.text, "This workspace has reached today's free trial limit, so I can't start this one. " +
    'The limit resets Nov 5, 2026 at 00:00 UTC, or an Owner can choose a plan to continue now.',
  'a notification shows the time\'s fallback, not the date token');
});

test('a hosted member paused by the fleet limit is not told the workspace reached its own', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  await identity.provisionSlackMember({ slackTeamId: TEAM, slackUserId: 'UMEMBER1' });
  const reply = "Chickpea has paused free trial usage for now, so I can't start this one. " +
    `Trials resume ${RESUMES}, or an Owner can choose a plan to continue now.`;
  assert.equal(fundingRefusalText(FLEET_LIMIT), reply);
  const calls = await outOfCreditsTurn(t, HOSTED_ENV, 'UMEMBER1', { failure: new AgentPromptFailure(FLEET_LIMIT) });
  assert.ok(visibleTexts(calls).includes(reply), JSON.stringify(visibleTexts(calls)));
  assert.equal(JSON.stringify(calls).includes('This workspace has reached'), false);
  assert.deepEqual(buttons(writtenBlocks(calls)).map(({ value }) => value), [`${TEAM}:fleet:1793836800`]);
});

test('a hosted Owner at the daily limit gets the same reply and a private one to choose a plan', async (t) => {
  const identity = await turnState(t);
  await createSlackOwner(identity, { teamId: TEAM, userId: 'UOWNER1' });
  const calls = await outOfCreditsTurn(t, HOSTED_ENV, 'UOWNER1', { failure: DAILY_LIMIT, publicUrl: PUBLIC_URL });
  assert.ok(visibleTexts(calls).includes(fundingRefusalText(WORKSPACE_LIMIT)));
  assert.deepEqual(buttons(writtenBlocks(calls.slice(0, -1))), [ASK_BUTTON(DAILY_LIMIT_ASK_ACTION, `${TEAM}:workspace:1793836800`)]);
  const { username: _username, icon_url: _icon, channel: _channel, thread_ts: _thread, ...note } = calls.at(-1)!.input;
  assert.deepEqual(note, ownerNote('Plans have no daily limit. Choose one to continue now.', [['Choose a plan', 'choose']]));
});

test('a daily-limit reply with no button still keeps its date token live', async (t) => {
  await turnState(t);
  for (const streamRejected of [false, true]) {
    const calls = await outOfCreditsTurn(t, undefined, 'UMEMBER1', { failure: DAILY_LIMIT, streamRejected });
    assert.ok(visibleTexts(calls).includes(fundingRefusalText(WORKSPACE_LIMIT)), JSON.stringify(calls));
    assert.equal(JSON.stringify(calls).includes('&lt;!date'), false);
    assert.equal(JSON.stringify(calls).includes(DAILY_LIMIT_ASK_ACTION), false);
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

/** Reads no one: no requester role and no Owners. */
const NO_ONE = {
  resolveSlackIdentity: async () => undefined,
  listMemberships: async () => [],
  listExternalIdentities: async () => [],
  getUser: async () => undefined,
};

/** Reads the requester as an active Owner. */
const AN_OWNER = {
  ...NO_ONE,
  resolveSlackIdentity: async () => ({ membership: { role: 'owner', status: 'active' } }) as never,
};

test('every cause has its own public words, which name no amount, card or failure, and a button that carries only them', async () => {
  const causes = {
    plan_used: OUT_OF_USAGE_TEXT,
    top_up_limit: OUT_OF_USAGE_TEXT,
    top_up_declined: OUT_OF_USAGE_TEXT,
    top_up_unconfirmed: OUT_OF_USAGE_TEXT,
    trial_used: "This workspace's free trial usage is used up, so I can't start this one. Once an Owner chooses a plan, send it again.",
    trial_ended: "This workspace's free trial has ended, so I can't start this one. Once an Owner chooses a plan, send it again.",
    own_key_tasks_used: "This workspace has used this month's tasks, so I can't do this one. I can still chat. " +
      'Once an Owner adds more, send it again.',
    own_key_no_plan: "This workspace needs a plan for tasks, so I can't do this one. I can still chat. " +
      'Once an Owner chooses a plan, send it again.',
  } satisfies Record<(typeof OUT_OF_USAGE_CAUSE_KINDS)[number], string>;
  assert.deepEqual(Object.keys(causes).sort(), [...OUT_OF_USAGE_CAUSE_KINDS].sort(), 'every cause is covered');
  for (const [kind, words] of Object.entries(causes)) {
    const refusal = {
      kind: 'credits_exhausted', cause: { kind, limitCents: 5_000, plansFromCents: 2_500, bonusPercent: 20 },
    } as PlatformFundingRefusal;
    assert.equal(fundingRefusalText(refusal), words, kind);
    assert.doesNotMatch(words, /\$|card|bank|declin|top-up|limit/i, kind);
    const reply = await fundingRefusalReply({ env: HOSTED_ENV, identity: NO_ONE, workspaceId: TEAM, userId: 'UMEMBER1', refusal });
    assert.ok(reply);
    assert.equal(reply.ownerNote, undefined, 'a Member gets no private reply');
    const [button] = buttons(reply.components.blocks);
    assert.equal(button!.value, words === OUT_OF_USAGE_TEXT ? TEAM : `${TEAM}:${kind}`, `only the public words' cause: ${kind}`);
    const clicked = parseCreditsAskAction(await clickPayload({ value: String(button!.value) }));
    assert.equal(fundingRefusalText(clicked!.refusal), words, `a click reads back the reply's own words: ${kind}`);
  }
  assert.equal(fundingRefusalText({ kind: 'credits_exhausted' }), OUT_OF_USAGE_TEXT, 'a host that gives no cause');
});

test('the Owner\'s private reply gives each cause and its Plan page buttons, with any amount the host gave', async () => {
  const cases: Array<[PlatformFundingRefusal, string, Array<[string, string]>]> = [
    [{ kind: 'credits_exhausted' }, 'Add usage or upgrade, then send this again.',
      [['Add usage', 'add'], ['Upgrade plan', 'upgrade']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'plan_used' } }, 'Add usage or upgrade, then send this again.',
      [['Add usage', 'add'], ['Upgrade plan', 'upgrade']]],
    [AT_LIMIT, 'Auto top-up reached its $50 limit for this month. Raise the limit or upgrade, then send this again.',
      [['Raise limit', 'raise-limit'], ['Upgrade plan', 'upgrade']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'top_up_limit' } },
      'Auto top-up reached its monthly limit. Raise the limit or upgrade, then send this again.',
      [['Raise limit', 'raise-limit'], ['Upgrade plan', 'upgrade']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'top_up_declined' } },
      "Auto top-up couldn't charge your card. Update it or add usage, then send this again.",
      [['Update card', 'card'], ['Add usage', 'add']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'top_up_unconfirmed' } },
      'Your bank needs you to confirm the auto top-up charge. Confirm it or add usage, then send this again.',
      [['Confirm payment', 'card'], ['Add usage', 'add']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'trial_used', plansFromCents: 2_500, bonusPercent: 20 } },
      'Choose a plan, then send this again. Plans start at $25 a month and include 20% more usage than they cost.',
      [['Choose a plan', 'choose']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'trial_ended', plansFromCents: 2_500 } },
      'Choose a plan, then send this again. Plans start at $25 a month.', [['Choose a plan', 'choose']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'trial_ended' } }, 'Choose a plan, then send this again.',
      [['Choose a plan', 'choose']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'own_key_tasks_used' } }, 'Add usage or upgrade, then send this again.',
      [['Add usage', 'add'], ['Upgrade plan', 'upgrade']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'own_key_no_plan', plansFromCents: 10_000 } },
      'Tasks need a plan when this workspace uses its own API key. Plans with your own key start at $100 a month.',
      [['Choose the $100 plan', 'choose']]],
    [{ kind: 'credits_exhausted', cause: { kind: 'own_key_no_plan' } },
      'Tasks need a plan when this workspace uses its own API key.', [['Choose a plan', 'choose']]],
    [WORKSPACE_LIMIT, 'Plans have no daily limit. Choose one to continue now.', [['Choose a plan', 'choose']]],
    [FLEET_LIMIT, 'Plans have no daily limit. Choose one to continue now.', [['Choose a plan', 'choose']]],
  ];
  for (const [refusal, text, steps] of cases) {
    const reply = await fundingRefusalReply({
      env: HOSTED_ENV, identity: AN_OWNER, workspaceId: TEAM, userId: 'UOWNER1', refusal, publicUrl: PUBLIC_URL,
    });
    assert.deepEqual(reply?.ownerNote, ownerNote(text, steps), text);
  }
  const unlinked = await fundingRefusalReply({
    env: HOSTED_ENV, identity: AN_OWNER, workspaceId: TEAM, userId: 'UOWNER1', refusal: AT_LIMIT,
  });
  assert.deepEqual(unlinked?.ownerNote?.blocks.map(({ type }) => type), ['section'], 'without Admin\'s origin, no buttons');
});

test('a private note is an ephemeral message in a channel\'s thread, and an ordinary reply in a DM', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const chat = {
    postEphemeral: async (input: Record<string, unknown>) => { calls.push(['postEphemeral', input]); return { ok: true }; },
    postMessage: async (input: Record<string, unknown>) => { calls.push(['postMessage', input]); return { ok: true }; },
  } as never;
  const note = { text: 'Only you.', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Only you.' } }] };
  await postPrivateNote(chat, { channelId: CHANNEL, userId: 'UOWNER1', threadTs: THREAD_TS, persona: { username: 'Support' } }, note);
  await postPrivateNote(chat, { channelId: 'DCREDITS1', userId: 'UOWNER1', threadTs: THREAD_TS }, { text: 'Only you.', blocks: [] });
  assert.deepEqual(calls, [
    ['postEphemeral', { channel: CHANNEL, thread_ts: THREAD_TS, text: 'Only you.', blocks: note.blocks, username: 'Support', user: 'UOWNER1' }],
    ['postMessage', { channel: 'DCREDITS1', thread_ts: THREAD_TS, text: 'Only you.' }],
  ]);
});

/** An identity with active Owners UOWNER1 (Pejman) and UOWNER2 (Sam), a suspended Owner UOWNER3, and member UMEMBER1. */
async function workspace(t: TestContext, options: { names?: boolean } = {}) {
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
  if (options.names !== false) {
    await named(identity, 'UOWNER1', 'Pejman');
    await named(identity, 'UOWNER2', 'Sam');
    await named(identity, 'UOWNER3', 'Lee');
  }
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
async function replyBlocks(refusal: PlatformFundingRefusal = { kind: 'credits_exhausted' }): Promise<Block[]> {
  const reply = await fundingRefusalReply({ env: HOSTED_ENV, identity: NO_ONE, workspaceId: TEAM, userId: 'UMEMBER1', refusal });
  assert.ok(reply);
  return [{ type: 'rich_text', elements: [] }, ...reply.components.blocks, FOOTER];
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
      ts: REPLY_TS, thread_ts: THREAD_TS, text: OUT_OF_USAGE_TEXT, blocks: patch.blocks ?? await replyBlocks(),
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

/** The host's answer now, with the cause the thread reply left out. */
const now = (refusal: PlatformFundingRefusal | undefined): Pick<CreditsAskDeps, 'currentRefusal' | 'publicUrl'> => ({
  currentRefusal: async () => refusal, publicUrl: PUBLIC_URL,
});

const byChannel = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a.channel).localeCompare(String(b.channel));

test('a Member\'s click DMs each active Owner with the cause\'s Plan page buttons, and names them in the reply', async (t) => {
  const identity = await workspace(t);
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const { client, of } = slack();
  const action = await click();
  assert.equal(await askOwnersForCredits(action, { identity, claims, client, ...now(AT_LIMIT) }), 'asked');

  assert.deepEqual(of('conversations.open').map(({ users }) => users).sort(), ['UOWNER1', 'UOWNER2']);
  const dm = ownerNote(
    "<@UMEMBER1> asked you to add usage for a request in <#CCREDITS1>. This workspace is out of usage, so it didn't run.",
    [['Raise limit', 'raise-limit'], ['Upgrade plan', 'upgrade']],
  );
  assert.deepEqual(of('chat.postMessage').sort(byChannel), [{ channel: 'DOWNER1', ...dm }, { channel: 'DOWNER2', ...dm }]);
  assert.equal(creditsAskOwnerDmText('UMEMBER1', 'DCREDITS1', AT_LIMIT),
    "<@UMEMBER1> asked you to add usage for a request in a direct message. This workspace is out of usage, so it didn't run.");
  const before = action.message.blocks;
  assert.deepEqual(of('chat.update'), [{
    channel: CHANNEL,
    ts: REPLY_TS,
    text: OUT_OF_USAGE_TEXT,
    blocks: [
      before[0],
      {
        type: 'context',
        elements: [{ type: 'plain_text', text: "✓ I asked Pejman and Sam. Send this again once they've added usage.", emoji: false }],
      },
      FOOTER,
    ],
  }]);
  assert.deepEqual(of('chat.postEphemeral'), []);
});

test('a click whose Owners Slack never named asks them by role, and a host that does not say keeps the reply\'s words', async (t) => {
  const identity = await workspace(t, { names: false });
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const { client, of } = slack();
  assert.equal(await askOwnersForCredits(await click(), { identity, claims, client, ...now(undefined) }), 'asked');
  assert.deepEqual([...new Set(of('chat.postMessage').map(({ blocks }) => JSON.stringify(buttons(blocks as Block[]))))],
    [JSON.stringify(ownerNote('', [['Add usage', 'add'], ['Upgrade plan', 'upgrade']]).blocks[1]!.elements)]);
  assert.ok(contextTexts(of('chat.update')[0]!.blocks as Block[])
    .includes("✓ I asked this workspace's Owners. Send this again once they've added usage."));
});

test('a daily-limit click DMs the Owners when the limit resets and an Owner\'s own click gets the private reply', async (t) => {
  const identity = await workspace(t);
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const { client, of } = slack();
  const blocks = await replyBlocks(WORKSPACE_LIMIT);
  const [button] = buttons(blocks);
  const action = parseCreditsAskAction(await clickPayload({
    actionId: String(button!.action_id), value: String(button!.value), blocks,
  }));
  assert.ok(action);
  assert.deepEqual(action.refusal, WORKSPACE_LIMIT);
  assert.equal(await askOwnersForCredits(action, { identity, claims, client, ...now(WORKSPACE_LIMIT) }), 'asked');

  const dm = ownerNote('<@UMEMBER1> asked you to choose a plan for a request in <#CCREDITS1>. ' +
    `This workspace reached today's free trial limit, so it didn't run. The limit resets ${RESUMES}.`, [['Choose a plan', 'choose']]);
  assert.deepEqual(of('chat.postMessage').sort(byChannel), [{ channel: 'DOWNER1', ...dm }, { channel: 'DOWNER2', ...dm }]);
  assert.deepEqual(of('chat.update').map(({ blocks: updated }) => updated), [[
    blocks[0],
    { type: 'context', elements: [{ type: 'plain_text', text: "✓ I asked Pejman and Sam. Send this again once they've chosen a plan.", emoji: false }] },
    FOOTER,
  ]]);

  const owner = slack();
  const ownerClick = parseCreditsAskAction(await clickPayload({
    user: 'UOWNER1', actionId: String(button!.action_id), value: String(button!.value), blocks,
  }));
  assert.ok(ownerClick);
  assert.equal(await askOwnersForCredits(ownerClick, { identity, claims, client: owner.client, ...now(WORKSPACE_LIMIT) }), 'owner');
  assert.deepEqual(owner.calls, [{ method: 'chat.postEphemeral', input: {
    channel: CHANNEL, thread_ts: THREAD_TS, user: 'UOWNER1',
    ...ownerNote('Plans have no daily limit. Choose one to continue now.', [['Choose a plan', 'choose']]),
  } }]);
});

test('a fleet-limit click DMs the Owners that trial usage is paused, not that the workspace hit its limit', async (t) => {
  const identity = await workspace(t);
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const { client, of } = slack();
  const blocks = await replyBlocks(FLEET_LIMIT);
  const [button] = buttons(blocks);
  const action = parseCreditsAskAction(await clickPayload({
    actionId: String(button!.action_id), value: String(button!.value), blocks,
  }));
  assert.ok(action);
  assert.deepEqual(action.refusal, FLEET_LIMIT);
  assert.equal(await askOwnersForCredits(action, { identity, claims, client }), 'asked');
  const dm = '<@UMEMBER1> asked you to choose a plan for a request in <#CCREDITS1>. ' +
    `Chickpea has paused free trial usage for now, so it didn't run. Trials resume ${RESUMES}.`;
  assert.deepEqual([...new Set(of('chat.postMessage').map(({ text }) => text))], [dm]);
  assert.deepEqual(of('chat.postMessage').map(({ blocks: sent }) => (sent as Block[]).map(({ type }) => type)),
    [['section'], ['section']], 'without Admin\'s origin the DM has no buttons');
});

test('Owners are asked at most once in two clock hours per installation, and a later click is told so honestly', async (t) => {
  const identity = await workspace(t);
  const start = Math.floor(1_800_000_000_000 / HOUR_MS) * HOUR_MS + 50 * 60_000;
  let at = start;
  const claims = new SqliteSlackStateStore(':memory:', () => at);
  t.after(() => claims.close());
  const { client, of } = slack();
  const ask = async () => askOwnersForCredits(await click(), { identity, claims, client, now: () => at });
  const throttled = "Pejman and Sam were asked in the last two hours. Send this again once they've added usage.";

  assert.equal(await ask(), 'asked');
  assert.equal(of('chat.postMessage').length, 2);

  at = start + 1_000;
  assert.equal(await ask(), 'already_asked');
  assert.equal(of('chat.postMessage').length, 2, 'a second click sends nothing');
  assert.equal(of('chat.update').length, 1, 'and does not claim it asked');
  assert.deepEqual(of('chat.postEphemeral').at(-1), {
    channel: CHANNEL, thread_ts: THREAD_TS, user: 'UMEMBER1', text: throttled,
    blocks: [{ type: 'context', elements: [{ type: 'plain_text', text: throttled, emoji: false }] }],
  });

  at = start + 59 * 60_000;
  assert.equal(Math.floor(at / HOUR_MS), Math.floor(start / HOUR_MS) + 1, 'the clock hour turned');
  assert.equal(await ask(), 'already_asked');
  assert.equal(of('chat.postMessage').length, 2, '59 minutes later, across the hour, sends nothing');

  at = start + 2 * HOUR_MS;
  assert.equal(await ask(), 'asked');
  assert.equal(of('chat.postMessage').length, 4, 'two hours later the Owners are asked again');
});

test('an Owner who clicks gets the private reply with the cause now, and no Owner is messaged', async (t) => {
  const identity = await workspace(t);
  const claims = new SqliteSlackStateStore(':memory:');
  t.after(() => claims.close());
  const declined = { kind: 'credits_exhausted', cause: { kind: 'top_up_declined' } } as const;
  const { client, calls } = slack();
  assert.equal(await askOwnersForCredits(await click('UOWNER1'), { identity, claims, client, ...now(declined) }), 'owner');
  assert.deepEqual(calls, [{ method: 'chat.postEphemeral', input: {
    channel: CHANNEL, thread_ts: THREAD_TS, user: 'UOWNER1',
    ...ownerNote("Auto top-up couldn't charge your card. Update it or add usage, then send this again.",
      [['Update card', 'card'], ['Add usage', 'add']]),
  } }]);

  const unread = slack();
  const down = { publicUrl: PUBLIC_URL, currentRefusal: async () => { throw new Error('ledger_unavailable'); } };
  assert.equal(await askOwnersForCredits(await click('UOWNER1'), { identity, claims, client: unread.client, ...down }), 'owner');
  assert.equal(unread.calls[0]!.input.text, 'Add usage or upgrade, then send this again.', 'the reply\'s own words stand in');
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
  const identity = { resolveSlackIdentity: down, listMemberships: down, listExternalIdentities: down, getUser: down };
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
  assert.deepEqual(of('chat.postEphemeral').map(({ text }) => text),
    ["✓ I asked Pejman and Sam. Send this again once they've added usage."]);
});

test('the click parser accepts only this installation\'s own button on a shared message', async () => {
  const valid = await clickPayload();
  assert.deepEqual(parseCreditsAskAction(valid), {
    refusal: { kind: 'credits_exhausted' },
    workspaceId: TEAM,
    userId: 'UMEMBER1',
    channelId: CHANNEL,
    messageTs: REPLY_TS,
    threadTs: THREAD_TS,
    message: { text: OUT_OF_USAGE_TEXT, blocks: valid.message.blocks },
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

  assert.deepEqual(parseCreditsAskAction(await clickPayload({ value: `${TEAM}:trial_used` }))?.refusal,
    { kind: 'credits_exhausted', cause: { kind: 'trial_used' } }, 'a cause the reply already named');
  for (const value of [`${TEAM}:top_up_declined`, `${TEAM}:top_up_limit`, `${TEAM}:plan_used`, `${TEAM}:`, `${TEAM}:toString`]) {
    assert.equal(parseCreditsAskAction(await clickPayload({ value })), undefined, `a button never carries ${value}`);
  }

  const dailyLimit = (value: string, actionId = DAILY_LIMIT_ASK_ACTION) => clickPayload({ actionId, value });
  assert.deepEqual(parseCreditsAskAction(await dailyLimit(`${TEAM}:workspace:1793836800`))?.refusal, WORKSPACE_LIMIT);
  assert.deepEqual(parseCreditsAskAction(await dailyLimit(`${TEAM}:fleet:1793836800`))?.refusal, FLEET_LIMIT);
  for (const value of [
    'TOTHERTEAM:workspace:1793836800', TEAM, `${TEAM}:`, `${TEAM}:1793836800`, `${TEAM}:team:1793836800`,
    `${TEAM}:workspace:`, `${TEAM}:workspace:0`, `${TEAM}:fleet:-1`, `${TEAM}:fleet:1.5`, `${TEAM}:workspace:soon`,
    `${TEAM}:workspace:1793836800:1`, `${TEAM}:workspace:1793836800000000`, ` ${TEAM}:workspace:1793836800`,
  ]) {
    assert.equal(parseCreditsAskAction(await dailyLimit(value)), undefined, value);
  }
  assert.equal(parseCreditsAskAction(await dailyLimit(`${TEAM}:workspace:1793836800`, CREDITS_ASK_ADMIN_ACTION)),
    undefined, 'the credits button carries no daily limit');
});
