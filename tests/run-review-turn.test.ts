import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { AgentInstanceHandle, ConversationStreamChunk } from '@flue/runtime';
import type { WebClient } from '@slack/web-api';

import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { installationOwnershipOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { closeNodeStateStores, type PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { configureRunReview } from '../src/review/port.ts';
import type { RunReviewRecordV1 } from '../src/review/record.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import {
  AgentPromptFailure,
  promptSlackThreadAgent,
  type AgentDispatchResult,
  type SlackFlueDispatchState,
} from '../src/slack/flue-dispatch.ts';
import { runTurn, type RunTurnOptions } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

/**
 * A hosted Slack turn whose installation has "Help improve Chickpea" on is
 * copied once when it settles, after its Slack writes. Replays, endings that
 * settle nothing, shared channels and standalone are not copied.
 */

const TEAM = 'TREVIEW1';
const INSTALLATION = 'inst_review_turn';
const HOSTED = { CHICKPEA_TENANCY: 'installation' };
const HOSTED_ENV = scopeInstallationEnv(HOSTED, { installationId: INSTALLATION });

const ASSIGNMENT: ResolvedAssignment = {
  workspaceId: TEAM,
  channelId: 'DREVIEW1',
  agentId: 'agent_review',
  model: 'local-stub/review',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_review', kind: 'user', revision: 1, name: 'Review Agent', instructions: 'Answer directly.',
    enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
};

const ANSWER: AgentDispatchResult = {
  text: 'Here is the plan.',
  requestedModel: null,
  returnedModel: { provider: 'local-stub', id: 'review-1' },
  reportedUsage: null,
  usageCompleteness: 'not_reported',
};

async function turnState(t: TestContext): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-review-turn-'));
  const statePath = join(directory, 'state.sqlite');
  const keys = ['SLACK_STATE_DB_PATH', 'TAG_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = statePath;
  closeNodeStateStores();
  resetInstallationAdmissionForTests();
  configureInstallationAdmission(async () => 'admitted');
  t.after(() => {
    configureRunReview(undefined);
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
}

/** Slack writes, delivery tombstones and copies, in the order they happened. */
const events: string[] = [];

function reviewPort(capturing = true) {
  const records: Array<{ installationId: string; record: RunReviewRecordV1 }> = [];
  let asked = 0;
  configureRunReview({
    enabled: async () => capturing,
    setEnabled: async (_id, change) => change.enabled,
    capturing: async () => {
      asked += 1;
      return capturing;
    },
    record: async (installationId, record) => {
      events.push('record');
      records.push({ installationId, record });
    },
    privacyUrl: 'https://chickpea.example/privacy',
  });
  return { records, asked: () => asked };
}

let turnCount = 0;

function dmTurn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  turnCount += 1;
  const messageTs = `18200000${String(turnCount).padStart(2, '0')}.000100`;
  return {
    workspaceId: TEAM, channelId: ASSIGNMENT.channelId, channelType: 'im',
    eventId: `Ev_REVIEW_${turnCount}`, text: 'Summarize the plan for <@U012ABCDEF3>.', userId: 'UMEMBER12',
    messageTs, threadTs: messageTs, source: 'dm_message', contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
    ...overrides,
  };
}

function slackClient(calls: string[]): WebClient {
  const record = (method: string) => async () => {
    calls.push(method);
    events.push(method);
    return { ok: true, ts: '1820000000.000600', channel: ASSIGNMENT.channelId };
  };
  return {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }), setTitle: async () => ({ ok: true }) } },
    conversations: {
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: record('chat.startStream'), appendStream: record('chat.appendStream'),
      stopStream: record('chat.stopStream'), postMessage: record('chat.postMessage'),
      update: record('chat.update'), delete: record('chat.delete'), postEphemeral: record('chat.postEphemeral'),
    },
  } as unknown as WebClient;
}

/** One turn through runTurn on the legacy presenter; returns its Slack writes and delivery outcomes. */
async function reviewedTurn(
  env: PlatformEnv | undefined,
  extra: Partial<RunTurnOptions> & { turn?: NormalizedSlackTurn; assignment?: ResolvedAssignment; ids?: boolean } = {},
) {
  const { turn: givenTurn, assignment = ASSIGNMENT, ids = true, ...options } = extra;
  const turn = givenTurn ?? dmTurn();
  const installation = installationOwnershipOf(env);
  const runtimePlan = compileRuntimePlanV2({
    ...(installation ? { installation } : {}),
    turn, assignment, instructions: 'Answer directly.', memoryEpoch: 1,
  });
  const calls: string[] = [];
  const delivered: Array<string | undefined> = [];
  await runTurn(turn, assignment, env, {
    client: slackClient(calls),
    ...(ids ? { turnId: `turn_${turn.eventId}`, runId: `run_${turn.eventId}` } : {}),
    statusRegistry: new SlackStatusRegistry(),
    usageRecordingEnabled: false,
    runtimePlanDecision: { runtimePlan, instanceId: deriveRuntimePlanInstanceId(runtimePlan) },
    flueDispatch: {} as SlackFlueDispatchState,
    agentPrompt: async () => ANSWER,
    onDelivered: (outcome) => {
      events.push('delivered');
      delivered.push(outcome);
    },
    ...options,
  });
  return { turn, calls, delivered };
}

/** The real dispatch over a handle whose reply streams a tool call and its answer. */
function streamedReply(name: string): Partial<RunTurnOptions> {
  const submissionId = `sub_${name}`;
  let instanceId = '';
  const flueDispatch: SlackFlueDispatchState = {
    prepare: async (message) => ({
      schemaVersion: 1, agentName: 'chickpea-slack-v2', instanceId, uid: null,
      message: { kind: 'user', body: message }, initialData: { schemaVersion: 2 }, idempotencyKey: `turn_${name}`,
    }) as unknown as FlueDispatchEnvelopeV1,
    reconcileExistingInstance: async () => { throw new Error('the first dispatch is admitted'); },
    recordReceipt: async (receipt) => receipt,
    recordSettlement: async (settlement) => settlement,
    markRecoveryRequired: async () => {},
  };
  const receipt = { submissionId, acceptedAt: new Date().toISOString(), uid: `uid_${name}` };
  const handle = {
    dispatch: async () => receipt,
    read: async (_receipt: unknown, options?: { onEvent?: (chunk: ConversationStreamChunk) => void }) => {
      let index = 0;
      const emit = (chunk: Record<string, unknown>) => options?.onEvent?.({
        conversationId: 'c', position: { batch: 1, index: index++ }, ...chunk,
      } as ConversationStreamChunk);
      emit({ type: 'message-started', messageId: 'earlier', submissionId: 'sub_earlier' });
      emit({ type: 'message-delta', messageId: 'earlier', kind: 'text', delta: 'An earlier answer.' });
      emit({ type: 'message-started', messageId: 'response', submissionId });
      emit({
        type: 'tool-input', messageId: 'response', toolCallId: 'call_1', toolName: 'read_slack_thread',
        input: { limit: 5 },
      });
      emit({ type: 'tool-output', toolCallId: 'call_1', output: { author: { kind: 'person', id: 'U012ABCDEF3' } } });
      emit({ type: 'message-delta', messageId: 'response', kind: 'text', delta: 'Here is the plan.' });
      emit({ type: 'message-completed', messageId: 'response' });
      return { text: 'Here is the plan.', data: {}, submissionId };
    },
    abort: async () => {},
  } as unknown as AgentInstanceHandle;
  return {
    flueDispatch,
    agentPrompt: (input) => {
      instanceId = deriveRuntimePlanInstanceId(input.runtimePlan!);
      return promptSlackThreadAgent({ ...input, handle });
    },
  };
}

test('a settled hosted turn is copied once, last, with the steps its stream showed', async (t) => {
  await turnState(t);
  const port = reviewPort();
  events.length = 0;
  const { turn, calls, delivered } = await reviewedTurn(HOSTED_ENV, streamedReply('streamed'));
  assert.deepEqual(delivered, ['succeeded']);
  assert.ok(calls.length > 0, 'the reply reached Slack');
  assert.equal(events.at(-1), 'record', `the copy is made after every Slack write: ${events.join(', ')}`);
  assert.ok(events.indexOf('delivered') < events.indexOf('record'));
  assert.equal(port.records.length, 1);
  const [{ installationId, record }] = port.records as [typeof port.records[number]];
  assert.equal(installationId, INSTALLATION);
  assert.equal(record.runId, `run_${turn.eventId}`);
  assert.equal(record.surface, 'dm');
  assert.equal(record.agentId, 'agent_review');
  assert.equal(record.outcome, 'succeeded');
  assert.equal(record.source, 'stream');
  assert.equal(record.answer, 'Here is the plan.');
  assert.match(record.trigger.author, /^u_[0-9a-f]{20}$/);
  assert.match(record.trigger.text, /^Summarize the plan for <@u_[0-9a-f]{20}>\.$/);
  assert.deepEqual(record.steps.map((step) => step.kind === 'tool' ? step.name : step.text), [
    'read_slack_thread', 'Here is the plan.',
  ]);
  const serialized = JSON.stringify(record);
  for (const id of ['U012ABCDEF3', 'UMEMBER12', TEAM, ASSIGNMENT.channelId, turn.messageTs]) {
    assert.equal(serialized.includes(id), false, `${id} is not in the copy`);
  }
});

test('a failed Agent run is copied with its error; delivery and telemetry outcomes are unchanged', async (t) => {
  await turnState(t);
  t.mock.method(console, 'error', () => undefined);
  const port = reviewPort();
  const { delivered } = await reviewedTurn(HOSTED_ENV, {
    agentPrompt: async () => { throw new AgentPromptFailure('provider'); },
  });
  assert.deepEqual(delivered, ['failed']);
  assert.equal(port.records.length, 1);
  assert.equal(port.records[0]?.record.outcome, 'failed');
  assert.deepEqual(port.records[0]?.record.error, {
    class: 'AgentPromptFailure', message: 'agent prompt failed (provider)',
  });
});

test('a recovered answer after a failed read is copied as succeeded, though delivery reports no outcome', async (t) => {
  await turnState(t);
  t.mock.method(console, 'error', () => undefined);
  const port = reviewPort();
  const { delivered } = await reviewedTurn(HOSTED_ENV, {
    agentPrompt: async () => { throw new AgentPromptFailure('agent'); },
    beforeDelivery: async () => 'Opened the pull request.',
  });
  assert.deepEqual(delivered, [undefined]);
  assert.equal(port.records.length, 1);
  assert.equal(port.records[0]?.record.outcome, 'succeeded');
  assert.equal(port.records[0]?.record.answer, 'Opened the pull request.');
});

test('a replay, a shared channel, a turn with no run or turn ID, a host not capturing, and standalone copy nothing', async (t) => {
  await turnState(t);
  const port = reviewPort();
  await reviewedTurn(HOSTED_ENV, { replayText: 'Here is the plan.' });
  await reviewedTurn(HOSTED_ENV, { turn: dmTurn({ sharedChannel: true }) });
  await reviewedTurn(HOSTED_ENV, { ids: false });
  assert.equal(port.asked(), 0, 'none asks the host');
  await reviewedTurn(undefined);
  assert.equal(port.asked(), 0, 'standalone has no installation to ask about');
  assert.deepEqual(port.records, []);

  const off = reviewPort(false);
  await reviewedTurn(HOSTED_ENV);
  assert.equal(off.asked(), 1);
  assert.deepEqual(off.records, []);

  configureRunReview(undefined);
  const { delivered } = await reviewedTurn(HOSTED_ENV);
  assert.deepEqual(delivered, ['succeeded'], 'a hosted deployment with no port is unchanged');
});

test('a Channel turn asks the host for a session only when admission read its Channel as unshared', async (t) => {
  await turnState(t);
  t.mock.method(console, 'warn', () => undefined);
  const port = reviewPort();
  const assignment = { ...ASSIGNMENT, channelId: 'CREVIEW1' };
  const channelTurn = (sharedChannel?: boolean) => dmTurn({
    channelId: 'CREVIEW1', channelType: 'channel', source: 'agent_mention', contextMode: 'thread',
    ...(sharedChannel === undefined ? {} : { sharedChannel }),
  });
  // This harness's Channel memory cannot reach Slack, so each turn ends
  // before its prompt; whether a session started is what the gate decides.
  await reviewedTurn(HOSTED_ENV, { turn: channelTurn(true), assignment });
  await reviewedTurn(HOSTED_ENV, { turn: channelTurn(), assignment });
  assert.equal(port.asked(), 0, 'shared, or never read, fails closed before asking the host');
  await reviewedTurn(HOSTED_ENV, { turn: channelTurn(false), assignment });
  assert.equal(port.asked(), 1, 'an unshared Channel is eligible');
});

test('a group DM is copied only once admission read it unshared, like a Channel', async (t) => {
  await turnState(t);
  t.mock.method(console, 'warn', () => undefined);
  const port = reviewPort();
  const assignment = { ...ASSIGNMENT, channelId: 'GREVIEW1' };
  const groupTurn = (sharedChannel?: boolean) => dmTurn({
    channelId: 'GREVIEW1', channelType: 'mpim',
    ...(sharedChannel === undefined ? {} : { sharedChannel }),
  });
  await reviewedTurn(HOSTED_ENV, { turn: groupTurn(), assignment });
  assert.equal(port.asked(), 0, 'a group DM whose sharing was never read is not copied');
  await reviewedTurn(HOSTED_ENV, { turn: groupTurn(false), assignment });
  assert.equal(port.asked(), 1, 'an unshared group DM is eligible');
});

test('a Channel mention copies the name and size of the file it carried, never its URL or ID', async (t) => {
  await turnState(t);
  const port = reviewPort();
  const channelId = 'CREVIEW2';
  const config = new SqliteConfigStore(process.env.TAG_DB_PATH!, { agents: [] });
  await config.putAgentChannelGrant({
    workspaceId: TEAM, channelId, agentId: ASSIGNMENT.agentId, status: 'active',
    createdByMembershipId: 'membership_owner', channelLabel: 'team', channelIsPrivate: false,
  });
  config.close();
  const turn = dmTurn({
    channelId, channelType: 'channel', source: 'app_mention', contextMode: 'channel_history',
    text: '<@UCHICKPEA> what does this report say?', sharedChannel: false,
    attachments: [{ fileId: 'F0REPORT1' }], attachmentIntake: { status: 'ok', count: 1 },
  });
  const file = {
    id: 'F0REPORT1', name: 'q3-report.pdf', filetype: 'pdf', size: 48_213,
    url_private: 'https://files.slack.com/files-pri/TREVIEW1-F0REPORT1/q3-report.pdf',
  };
  const triggerRow = { type: 'message', user: 'UMEMBER12', ts: turn.messageTs, text: turn.text, files: [file] };
  const base = slackClient([]);
  const client = {
    ...base,
    auth: { test: async () => ({ ok: true, user_id: 'UCHICKPEA' }) },
    users: { info: async ({ user }: { user: string }) => ({ ok: true, user: { id: user, team_id: TEAM, deleted: false, is_bot: false } }) },
    conversations: {
      ...base.conversations,
      info: async () => ({ ok: true, channel: { id: channelId, context_team_id: TEAM, name: 'team', is_channel: true, is_member: true } }),
      members: async () => ({ ok: true, members: ['UMEMBER12', 'UCHICKPEA'], response_metadata: { next_cursor: '' } }),
      // Slack returns the trigger row only to a read that includes `latest`.
      history: async ({ inclusive }: { inclusive?: boolean }) => ({ ok: true, messages: inclusive ? [triggerRow] : [] }),
    },
  } as unknown as WebClient;
  const { delivered } = await reviewedTurn(HOSTED_ENV, {
    turn, client, assignment: { ...ASSIGNMENT, channelId },
  });
  assert.deepEqual(delivered, ['succeeded']);
  assert.equal(port.records.length, 1);
  const [{ record }] = port.records as [typeof port.records[number]];
  assert.equal(record.surface, 'channel');
  assert.deepEqual(record.trigger.files, [{ name: 'q3-report.pdf', size: 48_213 }]);
  const serialized = JSON.stringify(record);
  for (const value of ['F0REPORT1', 'files.slack.com', channelId]) {
    assert.equal(serialized.includes(value), false, `${value} is not in the copy`);
  }
});

test('a settlement replayed from its checkpoint is copied from one bounded history read', async (t) => {
  await turnState(t);
  const port = reviewPort();
  const requests: string[] = [];
  const submissionId = 'sub_checkpoint';
  const turn = dmTurn();
  const env = scopeInstallationEnv({
    ...HOSTED,
    [CHICKPEA_SLACK_AGENT_BINDING]: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          requests.push(new URL(request.url).search);
          return Response.json({
            v: 1, conversationId: 'c', offset: '4', settlements: [{ submissionId, outcome: 'completed' }],
            messages: [
              { id: 'prompt', role: 'user', purpose: 'user', display: 'visible', submissionId, parts: [{ type: 'text', text: 'the whole prompt', state: 'done' }] },
              {
                id: 'response', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId,
                parts: [
                  { type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 'call_1', state: 'output-available', input: {}, output: 'ok' },
                  { type: 'text', text: 'Here is the plan.', state: 'done' },
                ],
              },
            ],
          });
        },
      }),
    },
  }, { installationId: INSTALLATION });
  const { delivered } = await reviewedTurn(env, {
    turn,
    flueDispatch: {
      dispatchEnvelope: { instanceId: 'instance_checkpoint' } as FlueDispatchEnvelopeV1,
      dispatchReceipt: { submissionId, acceptedAt: new Date().toISOString(), uid: 'uid_checkpoint' },
      flueSettlement: { outcome: 'completed', settledAt: Date.now(), result: ANSWER },
    } as unknown as SlackFlueDispatchState,
    // The real dispatch: a saved settlement returns before any observation.
    agentPrompt: promptSlackThreadAgent,
  });
  assert.deepEqual(delivered, ['succeeded']);
  assert.deepEqual(requests, ['?view=history&limit=20']);
  assert.equal(port.records.length, 1);
  assert.equal(port.records[0]?.record.source, 'history');
  assert.equal(port.records[0]?.record.model, 'local-stub/review-1');
  assert.deepEqual(port.records[0]?.record.steps, [
    { kind: 'tool', name: 'web_fetch', input: '{}', output: 'ok' },
    { kind: 'text', text: 'Here is the plan.' },
  ]);
});
