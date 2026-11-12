import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { createMemoryWriteChain, executeSlackMemoryUpdate } from '../src/management/slack-memory-actions.ts';
import { resolveSlackManagementActor } from '../src/management/slack-tools.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { parseCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { SlackArtifactReceipt } from '../src/slack/artifact-receipts.ts';
import type { AgentDispatchResult } from '../src/slack/flue-dispatch.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { AGENT_FAILURE_TEXT } from '../src/slack/web-client-presenter.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

import { createManagementAdapterFixture, type ManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

/**
 * An Agent with memory streams its answer like any other, including a turn
 * that writes its own memory. Memory another writer changes during the turn
 * still fails the delivery lease: the streamed text is replaced by the
 * failure notice.
 */

const assignment: ResolvedAssignment = {
  workspaceId: 'T_MEMSTREAM',
  channelId: 'D_MEMSTREAM',
  agentId: 'agent_memstream',
  model: 'local-stub/memstream',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_memstream',
    kind: 'user',
    revision: 1,
    name: 'Memory Agent',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

const MEMORY = 'The team stand-up is at 9:30 on Tuesdays.';
const ANSWER = 'Your stand-up is at 9:30 on Tuesdays.\nBring the sprint notes.\n';

const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-memory-streaming-'));
let previousStatePath: string | undefined;

before(() => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = join(stateDirectory, 'state.sqlite');
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

function dmTurn(messageTs: string, requester?: { userId: string; actorMembershipId: string }): NormalizedSlackTurn {
  return {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    channelType: 'im',
    eventId: `Ev_MEMSTREAM_${messageTs}`,
    text: 'When is our stand-up?',
    userId: requester?.userId ?? 'U_REQUESTER',
    ...(requester ? { actorMembershipId: requester.actorMembershipId } : {}),
    messageTs,
    threadTs: messageTs,
    source: 'dm_message',
    contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

/** With a management fixture, the turn can write its own memory and delivery can verify the receipt. */
async function harness(turn: NormalizedSlackTurn, memoryBody: string, fixture?: ManagementAdapterFixture) {
  const config = fixture?.config ?? new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [assignment.agent] });
  const agent = fixture
    ? await fixture.config.createAgent({
        ...assignment.agent, creatorMembershipId: fixture.admin.membership.id, editPolicy: 'creator_and_admins',
      })
    : assignment.agent;
  const resolved: ResolvedAssignment = { ...assignment, agent };
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await config.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  const memory = fixture?.memory ?? new SqliteMemoryStateStore(':memory:');
  if (memoryBody) {
    await memory.putAgentMemory({ agentId: assignment.agentId, body: memoryBody, expectedRevision: 0 });
  }
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: resolved, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const turnJobId = `turn_${runId}`;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3,
    runId,
    turnJobId,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: assignment.agent.name,
      avatarUrl: 'https://chickpea.example/assets/agents/memstream/avatar/1',
      avatarRevision: 1,
    } },
    sessionGeneration,
    currentActivity: {
      kind: 'preparing', action: 'Preparing', object: 'your request', generation: sessionGeneration,
      sequence: 1, operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
    root: {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      requesterUserId: turn.userId,
    },
  });
  const slack: Array<{ method: string; input: Record<string, unknown> }> = [];
  const record = (method: string, result: Record<string, unknown> = {}) =>
    async (input: Record<string, unknown>) => {
      slack.push({ method, input });
      return { ok: true, ...result };
    };
  // Younger than the age at which a stream is retired before Slack seals it.
  const streamTs = `${Math.floor(Date.now() / 1000)}.000500`;
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: {
      setStatus: async () => ({ ok: true }),
      setTitle: async () => ({ ok: true }),
    } },
    conversations: {
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: record('chat.startStream', { ts: streamTs }),
      appendStream: record('chat.appendStream'),
      stopStream: record('chat.stopStream'),
      update: record('chat.update'),
      delete: record('chat.delete'),
      postMessage: record('chat.postMessage', { ts: `${turn.messageTs.split('.')[0]}.000600` }),
    },
  } as unknown as WebClient;
  const runtimePlan = compileRuntimePlanV2({
    turn,
    assignment: resolved,
    instructions: assignment.agent.instructions,
    memoryEpoch: 1,
  });
  const instanceId = deriveRuntimePlanInstanceId(runtimePlan);
  const state = {
    getRunPresentation: (id: string) => store.get(id),
    getLatestThreadSessionGeneration: (root: Parameters<typeof store.getLatestThreadSessionGeneration>[0]) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<typeof store.transition>[0]) => store.transition(input),
    reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: (matchedInstanceId: string, submissionId?: string) => ({
      turnJobId,
      instanceId: matchedInstanceId,
      ...(submissionId ? { submissionId } : {}),
      generation: turnJobId,
    }),
  };
  const outcomes: Array<string | undefined> = [];
  const run = (
    agentPrompt: NonNullable<Parameters<typeof runTurn>[3]>['agentPrompt'],
    extra: Partial<NonNullable<Parameters<typeof runTurn>[3]>> = {},
  ) =>
    runTurn(turn, resolved, undefined, {
      ...extra,
      client,
      runId,
      turnId: turnJobId,
      workStore: work,
      presentationState: state,
      runtimePlanDecision: { runtimePlan, instanceId },
      progressiveAttributionProven: true,
      usageRecordingEnabled: false,
      appStores: (fixture
        ? { config, memory, identity: fixture.identity, management: fixture.management }
        : { config, memory, identity: {} }) as never,
      ...(fixture
        ? { managementApproval: {
            identity: fixture.identity, config: fixture.config, management: fixture.management, service: fixture.service,
          } }
        : {}),
      onDelivered: (outcome) => { outcomes.push(outcome); },
      ...(agentPrompt ? { agentPrompt } : {}),
    });
  const close = () => {
    if (fixture) fixture.close();
    else { config.close(); memory.close(); }
    work.close();
    db.close();
  };
  return { config, memory, store, runId, turnJobId, instanceId, slack, streamTs, outcomes, run, close };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Stream `text` as the Agent's declared answer, through the turn's own relay. */
async function streamAnswer(
  h: Harness,
  input: Parameters<NonNullable<Parameters<typeof runTurn>[3]>['agentPrompt'] & {}>[0],
  text: string,
): Promise<void> {
  const relay = await input.prepareProgressiveRelay?.({
    instanceId: h.instanceId,
    receipt: { submissionId: 'submission_memstream', acceptedAt: '2026-11-06T12:00:00.000Z', uid: 'uid_memstream' },
  });
  assert.ok(relay, 'the turn opens a streaming relay');
  relay.onEvent({
    type: 'message-started', conversationId: 'conversation',
    submissionId: 'submission_memstream', messageId: 'message_memstream',
    position: { batch: 1, index: 0 },
  });
  relay.onEvent({
    type: 'tool-input', conversationId: 'conversation', messageId: 'message_memstream',
    toolCallId: 'stream_call_1', toolName: 'stream_answer', input: {},
    position: { batch: 2, index: 0 },
  });
  relay.onEvent({
    type: 'tool-output', conversationId: 'conversation', toolCallId: 'stream_call_1',
    output: 'Delivery preference noted. Continue with the answer.',
    position: { batch: 3, index: 0 },
  });
  relay.onEvent({
    type: 'message-delta', conversationId: 'conversation', messageId: 'message_memstream',
    kind: 'text', delta: text, position: { batch: 4, index: 0 },
  });
  relay.onEvent({
    type: 'message-completed', conversationId: 'conversation', messageId: 'message_memstream',
    position: { batch: 5, index: 0 },
  });
  await relay.closeAndDrain();
}

function answerResult(text: string): AgentDispatchResult {
  return {
    text,
    requestedModel: assignment.model ?? null,
    returnedModel: null,
    reportedUsage: null,
    usageCompleteness: 'not_reported',
  };
}

/** Markdown the stream showed: its start and append chunks, in order. */
function streamedText(h: Harness): string {
  return h.slack
    .filter(({ method }) => method === 'chat.startStream' || method === 'chat.appendStream')
    .flatMap(({ input }) => (input.chunks ?? []) as Array<{ type: string; text?: string }>)
    .filter((chunk) => chunk.type === 'markdown_text')
    .map((chunk) => chunk.text ?? '')
    .join('');
}

for (const [label, memoryBody] of [['with memory', MEMORY], ['without memory', '']] as const) {
  test(`an Agent ${label} is offered streaming and streams its answer`, async () => {
    const turn = dmTurn(memoryBody ? '1790200001.000100' : '1790200002.000100');
    const h = await harness(turn, memoryBody);
    try {
      let prompt: { message: string; memoryBlock?: string } | undefined;
      await h.run(async (input) => {
        prompt = { message: input.message, ...(input.memoryBlock ? { memoryBlock: input.memoryBlock } : {}) };
        await streamAnswer(h, input, ANSWER);
        return answerResult(ANSWER);
      });
      assert.deepEqual(h.store.get(h.runId)?.progressiveEligibility, {
        status: 'frozen', allowed: true, reason: 'safe_early_release',
      });
      const envelope = parseCurrentRequestEnvelope(prompt?.message ?? '');
      assert.equal(envelope?.schemaVersion, 2);
      assert.equal(envelope.progressiveStreamingOffered, true, 'the Agent may declare a streamed answer');
      assert.equal(envelope.memoryInfluenced, memoryBody !== '');
      assert.equal(prompt?.memoryBlock?.includes(MEMORY) ?? false, memoryBody !== '',
        'memory reaches the Agent as before');
      assert.ok(streamedText(h).startsWith('Your stand-up is at 9:30'), 'the answer streamed');
      assert.deepEqual(h.slack.map(({ method }) => method).filter((method) =>
        method === 'chat.update' || method === 'chat.delete' || method === 'chat.postMessage'), [],
      'the stream closes as the reply: nothing replaced or posted beside it');
      assert.deepEqual(h.outcomes, ['succeeded']);
      const stored = h.store.get(h.runId);
      assert.equal(stored?.stream.state, 'finalized');
      assert.equal(stored?.stream.presentationOutcome, 'progressive');
    } finally { h.close(); }
  });
}

/** The lease failed after the answer streamed: the notice replaced the streamed message, nothing else posted. */
function assertStreamCorrectedToFailure(h: Harness, warnings: unknown[]): void {
  assert.ok(streamedText(h).startsWith('Your stand-up is at 9:30'), 'the answer had streamed');
  const update = h.slack.find(({ method }) => method === 'chat.update');
  assert.ok(update, 'the streamed message is replaced');
  assert.equal(update.input.ts, h.streamTs, 'on the streamed message itself');
  const stop = h.slack.find(({ method }) => method === 'chat.stopStream');
  assert.ok(stop && !('chunks' in stop.input), 'the stream stops without the rest of the answer');
  assert.ok(h.slack.indexOf(stop) < h.slack.indexOf(update));
  assert.ok(String(update.input.text).includes(AGENT_FAILURE_TEXT), `the notice replaces it: ${String(update.input.text)}`);
  assert.doesNotMatch(JSON.stringify(update.input), /stand-up|sprint notes/, 'no part of the answer survives');
  assert.deepEqual(h.slack.filter(({ method }) => method === 'chat.postMessage'), [], 'no second message');
  assert.deepEqual(h.outcomes, ['failed']);
  assert.ok(warnings.some((warning) =>
    (warning as { reason?: string } | undefined)?.reason === 'memory_delivery_lease_rejected'),
  'the operator line names the lease');
  assert.equal(h.store.get(h.runId)?.stream.presentationOutcome, 'corrected');
}

test('memory another writer forgets mid-turn fails the lease: the failure notice replaces the streamed answer', async () => {
  const turn = dmTurn('1790200003.000100');
  const h = await harness(turn, MEMORY);
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
  try {
    await h.run(async (input) => {
      await streamAnswer(h, input, ANSWER);
      // An Owner saves an empty body in Admin while the answer streams.
      const live = await h.memory.getAgentMemory(assignment.agentId);
      await h.memory.putAgentMemory({ agentId: assignment.agentId, body: '', expectedRevision: live.revision });
      return answerResult(ANSWER);
    });
    assertStreamCorrectedToFailure(h, warnings);
  } finally {
    console.warn = warn;
    h.close();
  }
});

/** The turn's own write, as the `update_agent_memory` tool applies it, with the receipt delivery verifies. */
async function writeOwnMemory(
  f: ManagementAdapterFixture,
  h: Harness,
  turn: NormalizedSlackTurn,
  expectedRevision: number,
  body: string,
): Promise<NonNullable<AgentDispatchResult['memoryUpdate']>> {
  const signal = {
    agentId: assignment.agentId,
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    conversationKind: 'im' as const,
    slackUserId: turn.userId,
    eventId: turn.eventId,
    messageTs: turn.messageTs,
    turnJobId: h.turnJobId,
    requesterText: turn.text,
  };
  const { receipt } = await executeSlackMemoryUpdate({
    signal,
    data: { expectedRevision, body },
    // The injected revision: the body the harness saved before the turn.
    chain: createMemoryWriteChain(h.turnJobId, 1, undefined),
    apply: async (args) => ({ ok: true, result: await f.service.applyWorkspaceChanges({
      context: await resolveSlackManagementActor(signal, f.identity), ...args,
    }) }),
  });
  assert.ok(receipt, 'the write applied');
  return receipt;
}

function ownWriteTurn(f: ManagementAdapterFixture, messageTs: string): NormalizedSlackTurn {
  return dmTurn(messageTs, { userId: f.admin.binding.slackUserId, actorMembershipId: f.admin.membership.id });
}

test('a turn that writes its own memory streams its answer and closes the stream as the reply', async () => {
  const f = await createManagementAdapterFixture('memstream-own-write', {}, { teamId: assignment.workspaceId });
  const turn = ownWriteTurn(f, '1790200004.000100');
  const h = await harness(turn, MEMORY, f);
  try {
    await h.run(async (input) => {
      const memoryUpdate = await writeOwnMemory(f, h, turn, 1, `${MEMORY}\nBring the sprint notes.`);
      await streamAnswer(h, input, ANSWER);
      return { ...answerResult(ANSWER), memoryUpdate };
    });
    assert.ok(streamedText(h).startsWith('Your stand-up is at 9:30'), 'the answer streamed');
    assert.deepEqual(h.slack.map(({ method }) => method).filter((method) =>
      method === 'chat.update' || method === 'chat.delete' || method === 'chat.postMessage'), [],
    'the stream closes as the reply: nothing replaced or posted beside it');
    assert.deepEqual(h.outcomes, ['succeeded']);
    assert.equal(h.store.get(h.runId)?.stream.presentationOutcome, 'progressive');
    const saved = await f.memory.getAgentMemory(assignment.agentId);
    assert.equal(saved.revision, 2, 'the own write stands');
  } finally { h.close(); }
});

test('an own write over memory another writer changed fails the lease: the failure notice replaces the streamed answer', async () => {
  const f = await createManagementAdapterFixture('memstream-stale-write', {}, { teamId: assignment.workspaceId });
  const turn = ownWriteTurn(f, '1790200005.000100');
  const h = await harness(turn, MEMORY, f);
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
  try {
    await h.run(async (input) => {
      // An Owner forgets everything in Admin before the turn's own write lands.
      await f.memory.putAgentMemory({ agentId: assignment.agentId, body: '', expectedRevision: 1 });
      const memoryUpdate = await writeOwnMemory(f, h, turn, 2, 'Use readable dates.');
      await streamAnswer(h, input, ANSWER);
      return { ...answerResult(ANSWER), memoryUpdate };
    });
    assertStreamCorrectedToFailure(h, warnings);
  } finally {
    console.warn = warn;
    h.close();
  }
});

// Incident 2026-11-12: a run made an external write and finished its answer
// without touching memory. Another run of the same Agent saved memory
// meanwhile, and the delivery lease posted the generic failure instead.
test('memory another writer appends while a run answers never holds back its answer, table, or file', async (t) => {
  const turn = dmTurn('1790200007.000100');
  const h = await harness(turn, MEMORY);
  const warnings: unknown[] = [];
  t.mock.method(console, 'warn', (line: unknown) => { warnings.push(line); });
  const file: SlackArtifactReceipt = {
    schemaVersion: 2, fileId: 'F0SYNTH01', filename: 'draft-outline.md', kind: 'file', byteLength: 512,
    stagedAt: 1_790_200_007_000, completedAt: 1_790_200_007_500,
    permalink: 'https://synthetic.slack.com/files/U0SYNTH/F0SYNTH01/draft-outline.md',
    destination: {
      workspaceId: assignment.workspaceId, agentId: assignment.agentId,
      channelId: assignment.channelId, threadTs: turn.threadTs,
    },
  };
  const table = {
    caption: 'Synthetic draft sections', presentation: 'static' as const,
    columns: [{ header: 'Section' }, { header: 'Status' }],
    rows: [['Overview', 'Drafted'], ['Audience', 'Drafted'], ['Steps', 'Drafted'], ['Examples', 'Drafted'],
      ['Limits', 'Drafted'], ['Related', 'Drafted'], ['Review', 'Pending']],
  };
  try {
    await h.run(async (input) => {
      const relay = await input.prepareProgressiveRelay?.({
        instanceId: h.instanceId,
        receipt: { submissionId: 'submission_memstream_incident', acceptedAt: '2026-11-12T01:28:35.000Z', uid: 'uid_incident' },
      });
      relay?.onEvent({
        type: 'message-started', conversationId: 'conversation',
        submissionId: 'submission_memstream_incident', messageId: 'message_incident', position: { batch: 1, index: 0 },
      });
      relay?.onEvent({
        type: 'tool-input', conversationId: 'conversation', messageId: 'message_incident',
        toolCallId: 'connection_call_1', toolName: 'connection_request',
        input: { method: 'POST', path: '/synthetic/drafts' }, position: { batch: 2, index: 0 },
      });
      relay?.onEvent({
        type: 'tool-output', conversationId: 'conversation', toolCallId: 'connection_call_1',
        output: '{"status":201,"id":"draft_synthetic"}', position: { batch: 3, index: 0 },
      });
      // Another run of this Agent saves its memory while this one answers.
      const live = await h.memory.getAgentMemory(assignment.agentId);
      await h.memory.putAgentMemory({
        agentId: assignment.agentId, body: `${MEMORY}\n\nThe sprint review is on Fridays.`, expectedRevision: live.revision,
      });
      await relay?.closeAndDrain();
      return { ...answerResult(ANSWER), tablePresentations: [table], artifacts: [file] };
    });
    const slack = JSON.stringify(h.slack);
    assert.deepEqual(h.outcomes, ['succeeded'], `the answer delivers: ${slack}`);
    assert.ok(slack.includes('Your stand-up is at 9:30'), 'the answer reached Slack');
    assert.ok(slack.includes('Synthetic draft sections') && slack.includes('Overview'), 'with its table');
    assert.ok(slack.includes('F0SYNTH01'), 'with its file');
    assert.equal(slack.includes(AGENT_FAILURE_TEXT), false, 'no failure notice');
    assert.equal(slack.includes('_Corrected_'), false, 'nothing replaced the answer');
    assert.deepEqual(warnings.filter((line) =>
      (line as { event?: string } | undefined)?.event === 'chickpea.turn.agent_failure'), [], 'no operator failure line');
    const saved = await h.memory.getAgentMemory(assignment.agentId);
    assert.equal(saved.revision, 2, "the other run's save stands");
  } finally { h.close(); }
});

// Defect caught: the reply's stream opened as the native task card, and the
// turn's answer_release record says it carried none, so retirements on such
// streams cannot be counted apart.
test("a turn whose reply stream opens as the task card says so on its answer_release record", async (t) => {
  const turn = dmTurn('1790200006.000100');
  const h = await harness(turn, '');
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if ((record as { event?: unknown } | undefined)?.event === 'answer_release') {
      logs.push(record as Record<string, unknown>);
    }
  });
  try {
    const transition = (mutation: Parameters<typeof h.store.transition>[0]['mutation']) => {
      const current = h.store.get(h.runId)!;
      const result = h.store.transition({
        runId: h.runId, workBindingGeneration: 1, runFencingToken: 0,
        expectedProjectionVersion: current.projectionVersion, expectedStreamState: current.stream.state, mutation,
      });
      assert.equal(result.outcome, 'applied');
      return result.outcome === 'applied' ? result.presentation : undefined;
    };
    const planned = transition({ kind: 'adopt_plan', taskLabels: ['Read the calendar', 'Write the answer'] });
    assert.ok(planned?.plan);
    transition({ kind: 'transition_task', taskId: planned.plan.tasks[0]!.id, to: 'in_progress' });
    const submissionId = 'submission_memstream_card';
    await h.run(async (input) => {
      const relay = await input.prepareProgressiveRelay?.({
        instanceId: h.instanceId,
        receipt: { submissionId, acceptedAt: '2026-11-06T12:00:00.000Z', uid: 'uid_memstream_card' },
      });
      input.onConversationChunk?.({
        type: 'message-started', conversationId: 'conversation', submissionId,
        messageId: 'message_memstream_card', position: { batch: 1, index: 0 },
      }, submissionId);
      await relay?.closeAndDrain();
      return answerResult(ANSWER);
    }, { turnLatency: { lane: 'cloudflare', executor: 'runner' } });
    const start = h.slack.find(({ method }) => method === 'chat.startStream');
    assert.ok(JSON.stringify(start?.input.chunks).includes('task_update'), 'the stream opened as the task card');
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.taskCardStream, true);
  } finally { h.close(); }
});
