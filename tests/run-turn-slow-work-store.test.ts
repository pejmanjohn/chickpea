import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { hasDeliveredOnboardingReply } from '../src/admin/onboarding-proof.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import type { WorkStore } from '../src/work/types.ts';

/**
 * Hosted run 9b: onboarding's Try DM got its reply, but the step never
 * completed. A thread runner reaches the Work store over state-store RPC; one
 * write there outlived the legacy observer's 100 ms budget, every later stage
 * was skipped, and the Run never settled as delivered, which is the proof the
 * Try step reads. The reply must not wait for that write, and the Run must
 * still settle once it lands.
 */

const assignment: ResolvedAssignment = {
  workspaceId: 'T_TRY_SLOW',
  channelId: 'D_TRY_SLOW',
  agentId: 'agent_try_slow',
  model: 'local-stub/try-slow',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_try_slow',
    kind: 'user',
    revision: 1,
    name: 'Try Guide',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-try-slow-'));
const statePath = join(stateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const store = new SqliteConfigStore(statePath, { agents: [] });
  await store.createAgent(assignment.agent);
  const installation = await store.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await store.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  store.close();
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

test('a Try DM reply settles its Run although the Work store outlived the observer budget', async (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const tryStartedAt = Date.now();
  const result = await runSlowDmTurn('1790000300.000100', {
    disposition: 'reply', reason: 'substantive_request',
  });
  try {
    assert.equal(result.answers.length, 1);
    assert.match(result.answers[0]!, /planner/);
    assert.equal(result.delivered, 1);
    const run = await result.work.getRun(result.runId);
    assert.equal(run?.status, 'settled');
    assert.equal(run?.terminalDisposition, 'succeeded');
    assert.equal(run?.deliveryStatus, 'delivered');
    assert.equal(run?.deliveryRef, `slack:${assignment.channelId}:1790000300.000200`);
    assert.equal(
      await hasDeliveredOnboardingReply(result.work, {
        workspaceId: assignment.workspaceId,
        slackUserId: result.userId,
        tryStartedAt,
      }),
      true,
      'onboarding Try sees the delivered reply',
    );
    assert.equal(result.recordedBeforeReturn, true, 'the turn records its Work before it returns');
  } finally {
    result.close();
  }
});

test('a reaction-only DM settles its execution and Run behind a slow Work store', async (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const result = await runSlowDmTurn('1790000400.000100', {
    disposition: 'react_only', reason: 'pure_ack', reaction: 'appreciation', target: 'trigger',
  });
  try {
    assert.deepEqual(result.answers, ['reaction']);
    const run = await result.work.getRun(result.runId);
    assert.equal(run?.status, 'settled');
    assert.equal(run?.deliveryStatus, 'delivered');
    assert.equal(run?.deliveryMethod, 'slack_reaction_add');
    const [execution] = await result.work.listRunExecutions(result.runId);
    assert.equal(execution?.outcome, 'succeeded', 'the queued execution is settled too');
    assert.equal(execution?.modelInvocationStatus, 'not_invoked');
    assert.equal(result.recordedBeforeReturn, true);
  } finally {
    result.close();
  }
});

/**
 * One DM turn whose prepared-input write is held until its answer is in Slack
 * and then lands a little later, like a thread runner's state-store call that
 * outlives the observer budget.
 */
async function runSlowDmTurn(
  messageTs: string,
  interactionIntent: NormalizedSlackTurn['interactionIntent'],
) {
  const turn: NormalizedSlackTurn = {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    channelType: 'im',
    eventId: `Ev_TRY_SLOW_${messageTs}`,
    text: interactionIntent?.disposition === 'react_only'
      ? 'thanks'
      : 'Hi Chickpea. What is a good first teammate for us?',
    userId: 'U_TRY_OWNER',
    messageTs,
    threadTs: messageTs,
    source: 'dm_message',
    contextMode: 'thread',
    ...(interactionIntent ? { interactionIntent } : {}),
  };
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;

  let answered!: () => void;
  const answerInSlack = new Promise<void>((resolve) => { answered = resolve; });
  let preparedLanded = false;
  const slowStore = new Proxy(work, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property !== 'prepareRunInput') return value.bind(target);
      return async (...args: Parameters<WorkStore['prepareRunInput']>) => {
        await answerInSlack;
        await new Promise((resolve) => setTimeout(resolve, 150));
        const prepared = await target.prepareRunInput(...args);
        preparedLanded = true;
        return prepared;
      };
    },
  }) as WorkStore;

  const db = openStateDb(':memory:');
  const presentations = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(messageTs.replace('.', ''));
  presentations.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Try Guide',
      avatarUrl: 'https://chickpea.example/assets/agents/try/avatar/1',
      avatarRevision: 1,
    } },
    sessionGeneration,
    currentActivity: {
      kind: 'preparing', action: 'Preparing', object: 'your request', generation: sessionGeneration,
      sequence: 1, operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
    root: {
      workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs,
      requesterUserId: turn.userId,
    },
  });
  const answers: string[] = [];
  const answer = (text: string) => {
    answers.push(text);
    assert.equal(preparedLanded, false, 'the answer does not wait for the slow write');
    answered();
  };
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    auth: { test: async () => ({ ok: true, user_id: 'U_CHICKPEA' }) },
    users: { info: async () => ({ ok: true, user: { id: turn.userId, team_id: turn.workspaceId } }) },
    conversations: {
      info: async () => ({
        ok: true,
        channel: { id: turn.channelId, is_im: true, user: turn.userId, context_team_id: turn.workspaceId },
      }),
      members: async () => ({ ok: true, members: [turn.userId, 'U_CHICKPEA'] }),
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    reactions: {
      add: async () => {
        answer('reaction');
        return { ok: true };
      },
    },
    chat: {
      startStream: async (input: { chunks?: Array<{ text?: string }> }) => {
        answer(input.chunks?.map((chunk) => chunk.text ?? '').join('') ?? '');
        return { ok: true, ts: '1790000300.000200' };
      },
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: { text?: string }) => {
        answer(input.text ?? '');
        return { ok: true, ts: '1790000300.000200' };
      },
    },
  } as unknown as WebClient;
  const state = {
    getRunPresentation: (id: string) => presentations.get(id),
    getLatestThreadSessionGeneration: (
      root: Parameters<typeof presentations.getLatestThreadSessionGeneration>[0],
    ) => presentations.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<typeof presentations.transition>[0]) =>
      presentations.transition(input),
    reserveSlackAppend: (workspaceId: string) => presentations.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      presentations.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
  let delivered = 0;
  const close = () => {
    db.close();
    work.close();
  };
  try {
    await runTurn(turn, assignment, undefined, {
      client,
      runId,
      turnId: `turn_${runId}`,
      presentationState: state,
      workStore: slowStore,
      usageRecordingEnabled: false,
      onDelivered: () => { delivered += 1; },
      agentPrompt: async () => ({
        text: 'Start with a planner who turns requests into tasks.',
        requestedModel: assignment.model ?? null,
        returnedModel: null,
        reportedUsage: null,
        usageCompleteness: 'not_reported' as const,
      }),
    });
    const recordedBeforeReturn = preparedLanded;
    // A write the turn left behind still lands; read the Run after it has.
    for (let waited = 0; !preparedLanded && waited < 2_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { work, runId, userId: turn.userId, answers, delivered, recordedBeforeReturn, close };
  } catch (error) {
    close();
    throw error;
  }
}
