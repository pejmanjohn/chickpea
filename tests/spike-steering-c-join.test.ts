import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import {
  init, instrument, useAgentFinish, useAgentStart, useDelivery, useDispatchMessage, useModel, usePersistentState,
  useTool, AgentRunError,
  type AgentProps, type ConversationStreamChunk, type DeliveredMessage, type DeliveredMessageInput,
  type DispatchReceipt, type LlmMessage,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  bindCurrentRequestConversation, currentRequestEnvelopeText, parseCurrentRequestEnvelope,
  serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';
import { RunReviewCollector } from '../src/review/collector.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import { frameFoldedMessages, followUpSignalBody, MAX_FOLD_CYCLES } from '../src/slack/follow-ups.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';
import { ReceiptScopedTextRelay } from '../src/slack/progressive-relay.ts';
import type { FlueDispatchEnvelopeV1, TurnFoldClaim, TurnFoldRequest, TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic, turnJobGate } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

/**
 * SPIKE (steering C, never merged): how should a message that arrives while
 * the Agent works reach the model at the next tool boundary?
 *
 * - pull: the Agent asks the state store after each tool batch (inside the
 *   batch's tool run, since Flue forbids dispatch during render) and
 *   self-dispatches a `slack.message` signal with the head's attributes
 *   through useDispatchMessage(); Flue joins it at the batch's turn_end.
 * - push: the host claims the member in the store and dispatches it into the
 *   busy instance with the head's attributes and a `join:<member>` key.
 *
 * Every number lands in `report` and, with SPIKE_OUT set, in that JSON file.
 * Assertions pin what the first run measured, so a rerun shows drift.
 */

const MODEL = 'faux/steering-c-join';
const PERSON = 'U_PERSON';
const GENERATION = 'gen-steering-c-join';
const NOW = 1_800_000_000_000;
/** ChickpeaSlack's CURRENT_SLACK_TURN_STATE_NAME (src/agents/slack-thread.ts), copied to avoid loading that module. */
const CURRENT_SLACK_TURN_STATE_NAME = 'chickpeaSlackTurn';
const LATE_TEXT = 'Also mention the pricing change.';

type Door = 'pull' | 'push';
type JoinMessage = Extract<DeliveredMessageInput, { kind: 'signal' }>;

interface Join {
  door: Door;
  members: string[];
  receipt: DispatchReceipt;
  dispatchedAt: number;
}

interface Scenario {
  plan: RuntimePlanV2;
  instanceId: string;
  turns: TurnJobStoreLogic;
  head: JoinMessage;
  arrive(id: string, text: string): void;
  close(): void;
}

interface Probe {
  door: Door;
  /** Called at the start of each `work` / stream_answer run. */
  onTool?: (step: number) => Promise<void> | void;
  toolDelayMs: (step: number) => number;
  /** Extra latency inside the copied ChickpeaSlack start hook (0 = the real hook). */
  startHookDelayMs: number;
  /** Push only: dispatch under the member's own attributes instead of the head's. */
  memberAttributes: boolean;
  /** Pull only: ignore the stream gate (to show it is necessary). */
  ignoreStreamGate: boolean;
  /** Fold cycles this response appended or joined (pull + would-stop share it). */
  cycles: number;
  streamDeclared: boolean;
  storeCalls: { phase: 'tool' | 'finish' | 'host'; take: boolean; received: number; ms: number }[];
  joins: Join[];
  /** Would-stop appends by the pull door's finish hook (B's copy). */
  appends: { at: number; body: string }[];
  renders: { at: number; delivery: DeliveredMessage }[];
  starts: { at: number; turnJobId: string | undefined; envelopeTurn: string | undefined; joinedBody: boolean; ms: number }[];
  toolEnds: { step: number; at: number }[];
  arrivals: { id: string; at: number }[];
  /** Push confirms: submissions whose input record the host saw appended. */
  appended: Set<string>;
}

let scenario: Scenario;
let probe: Probe;
let hostHandle: ReturnType<typeof init>;
const report: Record<string, unknown> = {};
const now = () => performance.now();

function freshProbe(door: Door, overrides: Partial<Probe> = {}): Probe {
  return {
    door, toolDelayMs: () => 0, startHookDelayMs: 0, memberAttributes: false, ignoreStreamGate: false,
    cycles: 0, streamDeclared: false, storeCalls: [], joins: [], appends: [], renders: [], starts: [],
    toolEnds: [], arrivals: [], appended: new Set(), ...overrides,
  };
}

/** The tool-boundary copy: B's heading and rows (so the collector parser still reads them), no "draft". */
function toolBoundaryBody(claim: TurnFoldClaim, envelope: string): string {
  return [
    `While you were working, <@${PERSON}> sent ${claim.messages.length === 1 ? 'another message' : `${claim.messages.length} more messages`} in this thread:`,
    frameFoldedMessages(claim.messages, 'America/Los_Angeles'),
    'Read these with the request above, in order, since a later message may correct or add to an earlier one. Take them into account in the rest of your work. When you finish, write your final message as the complete reply to the whole request, not only to these messages.',
    envelope,
  ].join('\n\n');
}

function joinMessage(claim: TurnFoldClaim, memberAttributes = false): JoinMessage {
  const { head } = scenario;
  const envelope = currentRequestEnvelopeText(head.body)!;
  const member = claim.messages[0]!;
  return {
    kind: 'signal', type: 'slack.message', tagName: 'slack_message',
    attributes: {
      ...head.attributes,
      requesterText: claim.requesterText,
      ...(memberAttributes ? { turnJobId: member.turnJobId, messageTs: member.messageTs, eventId: `Ev_${member.messageTs}` } : {}),
    },
    body: toolBoundaryBody(claim, envelope),
  };
}

async function storeFold(phase: Probe['storeCalls'][number]['phase'], request: Extract<TurnFoldRequest, { phase: 'finish' }>) {
  const began = now();
  const claim = scenario.turns.fold(request);
  probe.storeCalls.push({ phase, take: request.take, received: request.received, ms: now() - began });
  return claim;
}

/** The pull door: one store call per tool batch, then a self-dispatch Flue joins at turn_end. */
async function pullAtBoundary(id: string, dispatch: (message: DeliveredMessageInput) => Promise<DispatchReceipt>) {
  const take = (probe.ignoreStreamGate || !probe.streamDeclared) && probe.cycles < MAX_FOLD_CYCLES;
  if (!take && probe.cycles === 0) return;
  const claim = await storeFold('tool', { phase: 'finish', headId: 'head', instanceId: id, received: probe.cycles, take });
  if (!claim.messages.length) return;
  const dispatchedAt = now();
  const receipt = await dispatch(joinMessage(claim));
  probe.cycles += 1;
  probe.joins.push({ door: 'pull', members: claim.messages.map((m) => m.turnJobId), receipt, dispatchedAt });
}

/** The push door: the host claims the member in the store and dispatches it into the busy instance. */
async function hostPush() {
  const claim = await storeFold('host', {
    phase: 'finish', headId: 'head', instanceId: scenario.instanceId, received: probe.cycles, take: true,
  });
  if (!claim.messages.length) return;
  const members = claim.messages.map((m) => m.turnJobId);
  const dispatchedAt = now();
  const receipt = await hostHandle.dispatch({
    message: joinMessage(claim, probe.memberAttributes),
    idempotencyKey: `join:${members.join('+')}`,
  });
  probe.cycles += 1;
  probe.joins.push({ door: 'push', members, receipt, dispatchedAt });
}

function JoinProbe({ id }: AgentProps) {
  useModel(MODEL);
  bindCurrentRequestConversation(scenario.plan.conversation);
  const delivery = useDelivery();
  probe.renders.push({ at: now(), delivery });
  // ChickpeaSlack's own render-input start hook (useSlackTurnRenderInput), copied.
  const [current, setCurrent] = usePersistentState<{ turnJobId?: string }>(CURRENT_SLACK_TURN_STATE_NAME, {});
  const delivered = delivery.kind === 'signal' && delivery.type === 'slack.message'
    ? delivery.attributes?.turnJobId : undefined;
  useAgentStart(async () => {
    const began = now();
    if (probe.startHookDelayMs) await sleep(probe.startHookDelayMs);
    if (delivered && current.turnJobId !== delivered) setCurrent({ turnJobId: delivered });
    probe.starts.push({
      at: began, turnJobId: delivered,
      envelopeTurn: delivery.kind === 'signal' ? parseCurrentRequestEnvelope(delivery.body)?.slackMessageTs : undefined,
      joinedBody: delivery.body.startsWith('While you were working'),
      ms: now() - began,
    });
  });
  const dispatch = useDispatchMessage();
  // Per render, so per tool batch: the first tool of a batch to finish asks.
  const batch = { asked: false };
  const boundary = async () => {
    if (probe.door !== 'pull' || batch.asked) return;
    batch.asked = true;
    await pullAtBoundary(id, dispatch);
  };
  useTool({
    name: 'work',
    description: 'Do one step of work.',
    input: v.strictObject({ step: v.number() }),
    async run({ data }) {
      await probe.onTool?.(data.step);
      const delay = probe.toolDelayMs(data.step);
      if (delay) await sleep(delay);
      await boundary();
      probe.toolEnds.push({ step: data.step, at: now() });
      return { output: `done ${data.step}` };
    },
  });
  useTool({
    name: SLACK_STREAM_ANSWER_TOOL_NAME,
    description: 'Declare that the final answer streams to Slack.',
    input: v.strictObject({}),
    async run() {
      probe.streamDeclared = true;
      await probe.onTool?.(0);
      await boundary();
      probe.toolEnds.push({ step: 0, at: now() });
      return { output: 'streaming' };
    },
  });
  if (probe.door === 'pull') {
    // B's would-stop fold (src/slack/follow-up-fold.ts), sharing the pull door's cycle counter.
    useAgentFinish(async ({ append }) => {
      const take = probe.cycles < MAX_FOLD_CYCLES && !probe.streamDeclared;
      if (!take && probe.cycles === 0) return;
      const claim = await storeFold('finish', { phase: 'finish', headId: 'head', instanceId: id, received: probe.cycles, take });
      if (!claim.messages.length) return;
      const body = followUpSignalBody({
        messages: claim.messages, userId: PERSON, timezone: 'America/Los_Angeles',
        envelope: currentRequestEnvelopeText(scenario.head.body)!,
      });
      append({
        kind: 'signal', type: 'slack.message', tagName: 'slack_message',
        attributes: { ...scenario.head.attributes, requesterText: claim.requesterText }, body,
      });
      probe.cycles += 1;
      probe.appends.push({ at: now(), body });
    });
  }
}

let thread = 0;

function openScenario(): Scenario {
  thread += 1;
  const threadTs = `1800001${String(thread).padStart(3, '0')}.000100`;
  const conversation = { workspaceId: 'T_JOIN', channelId: 'C_JOIN', threadTs };
  const turn = (messageTs: string, text: string): NormalizedSlackTurn => ({
    ...conversation, eventId: `Ev_${messageTs}`, text, userId: PERSON, messageTs,
    source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel',
    requesterTimezone: 'America/Los_Angeles',
  });
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_JOIN', channelId: 'C_JOIN', agentId: 'agent_join', model: MODEL,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_join', kind: 'user', revision: 1, name: 'Join', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  const clock = { now: NOW };
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => clock.now);
  let sequence = 200;
  const enqueue = (id: string, text: string) => {
    const queued: TurnJob = {
      id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, runId: `run_${id}`,
      turn: turn(`${threadTs.split('.')[0]}.000${sequence++}`, text), assignment,
    };
    turns.enqueue(queued);
    clock.now += 1;
    return queued;
  };
  const head = enqueue('head', 'Draft the launch note.');
  const plan = compileRuntimePlanV2({ turn: head.turn, assignment, instructions: 'Help.', memoryEpoch: 1 });
  turns.freezeRuntimePlan('head', plan);
  turns.prepareFlueDispatch('head', `Draft the launch note.\n\n${serializeCurrentRequestEnvelope(
    '', false, PERSON, head.turn.messageTs, { schemaVersion: 2 },
  )}`, { generation: GENERATION });
  const envelope = turns.getDispatchEnvelope('head')!;
  assert.equal(envelope.schemaVersion, 2);
  return {
    plan,
    instanceId: envelope.instanceId,
    turns,
    head: envelope.message as JoinMessage,
    arrive: (id, text) => {
      enqueue(id, text);
      probe.arrivals.push({ id, at: now() });
    },
    close: () => db.close(),
  };
}

function storeState(envelope: FlueDispatchEnvelopeV1, turns: TurnJobStoreLogic): SlackFlueDispatchState {
  return {
    prepare: () => envelope,
    recordReceipt: (receipt) => turns.recordFlueReceipt('head', receipt),
    recordSettlement: (settlement) => turns.recordFlueSettlement('head', settlement),
    reconcileExistingInstance: () => { throw new Error('Unexpected incarnation conflict.'); },
    markRecoveryRequired: (reason) => { throw new Error(`Unexpected recovery: ${reason}`); },
  };
}

function userText(message: LlmMessage): string | undefined {
  if (message.role !== 'user') return undefined;
  return typeof message.content === 'string' ? message.content : message.content
    .flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

function assistantText(message: LlmMessage): string | undefined {
  if (message.role !== 'assistant') return undefined;
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
}

interface ModelRequest {
  at: number;
  /** User-role `slack_message` signals, in order. */
  slack: string[];
  /** User messages carrying LATE_TEXT (a join carries it in its body and its requesterText attribute). */
  lateCount: number;
  /** role:text of the last three messages. */
  tail: string[];
}

let requests: ModelRequest[] = [];

const answer = (text: string) => fauxAssistantMessage(text);
const work = (step: number, narration = `Working on step ${step}.`) =>
  fauxAssistantMessage([fauxText(narration), fauxToolCall('work', { step })], { stopReason: 'toolUse' });
const streamAnswer = () => fauxAssistantMessage([fauxToolCall(SLACK_STREAM_ANSWER_TOOL_NAME, {})], { stopReason: 'toolUse' });
const providerError = (message: string) => fauxAssistantMessage('', { stopReason: 'error', errorMessage: message });
/** A model step during which the person sends LATE_TEXT (and, under push, the host joins it). */
function arrivesDuring(step: ReturnType<typeof fauxAssistantMessage>, id = 'late', text = LATE_TEXT): FauxResponseStep {
  return async () => {
    scenario.arrive(id, text);
    if (probe.door === 'push') await hostPush();
    return step;
  };
}
/** Tool step `n` runs while the person sends LATE_TEXT (and, under push, the host joins it). */
function arrivesInTool(n: number, id = 'late', text = LATE_TEXT) {
  return async (step: number) => {
    if (step !== n) return;
    scenario.arrive(id, text);
    if (probe.door === 'push') await hostPush();
  };
}

/** The index (1-based model request) where LATE_TEXT first reached the model. */
const landedAt = () => {
  const index = requests.findIndex((request) => request.lateCount > 0);
  return index < 0 ? undefined : index + 1;
};

test('spike: steering C join doors (pull vs push)', { timeout: 180_000 }, async (t) => {
  const faux = fauxProvider({ models: [{ id: 'steering-c-join' }], tokensPerSecond: 100_000 });
  const stopInstrumentation = instrument({
    interceptor: (_operation, _context, next) => next(),
    observe(event) {
      if (event.type !== 'turn_request' || event.purpose !== 'agent') return;
      const messages = event.request.input.messages;
      const texts = messages.flatMap((message) => {
        const text = userText(message);
        return text === undefined ? [] : [text];
      });
      requests.push({
        at: now(),
        slack: texts.filter((text) => text.startsWith('<slack_message ')),
        lateCount: texts.filter((text) => text.includes(LATE_TEXT)).length,
        tail: messages.slice(-3).map((message) =>
          `${message.role}:${(userText(message) ?? assistantText(message) ?? '').slice(0, 90).replace(/\n/g, ' ')}`),
      });
    },
    dispose() {},
  });
  const runtime = await start({
    agents: [{ agent: JoinProbe, name: CHICKPEA_SLACK_AGENT_NAME }],
    providers: [faux.provider],
  });

  interface RelayCapture { appended: string[]; intents: string[]; invalidations: string[] }

  async function run(responses: FauxResponseStep[], options: { relay?: boolean } = {}) {
    requests = [];
    faux.setResponses(responses);
    const callsBefore = faux.state.callCount;
    const chunks: { chunk: ConversationStreamChunk; submissionId: string }[] = [];
    let review: RunReviewCollector | undefined;
    const relay: RelayCapture = { appended: [], intents: [], invalidations: [] };
    hostHandle = init(JoinProbe, { id: scenario.instanceId });
    const envelope = scenario.turns.getDispatchEnvelope('head')!;
    const began = now();
    let result: Awaited<ReturnType<typeof promptSlackThreadAgent>> | undefined;
    let error: unknown;
    try {
      result = await promptSlackThreadAgent({
        handle: hostHandle, state: storeState(envelope, scenario.turns), message: 'Draft the launch note.',
        turnId: 'head', conversationKey: scenario.instanceId, requestedModel: MODEL,
        ...(options.relay ? {
          prepareProgressiveRelay: async ({ receipt }: { receipt: { submissionId: string } }) => new ReceiptScopedTextRelay({
            submissionId: receipt.submissionId,
            mode: 'final_answer',
            modelIntent: { initial: { status: 'unresolved' }, async transition(intent) { relay.intents.push(intent.kind); } },
            async append(chunk) { relay.appended.push(chunk.delta); },
            async invalidate(reason) { relay.invalidations.push(reason); },
          }),
        } : {}),
        onConversationChunk: (chunk, submissionId) => {
          chunks.push({ chunk, submissionId });
          review ??= new RunReviewCollector(submissionId);
          review.ingest(chunk);
          // Push confirm: the host sees a joined member's input record appended.
          if (chunk.type === 'message-appended' && chunk.message.submissionId &&
              probe.joins.some((join) => join.door === 'push' && join.receipt.submissionId === chunk.message.submissionId) &&
              !probe.appended.has(chunk.message.submissionId)) {
            probe.appended.add(chunk.message.submissionId);
            void storeFold('host', {
              phase: 'finish', headId: 'head', instanceId: scenario.instanceId, received: probe.appended.size, take: false,
            });
          }
        },
      });
    } catch (caught) {
      error = caught;
    }
    const hostSubmissionId = scenario.turns.getFlueReceipt('head')?.submissionId ?? review?.submissionId;
    const joinedRecords = chunks.flatMap(({ chunk }) => chunk.type === 'message-appended' &&
      chunk.message.role === 'system' && chunk.message.signal?.tagName === 'slack_message' &&
      chunk.message.parts.some((part) => part.type === 'text' && part.text.startsWith('While you were working'))
      ? [{ submissionId: chunk.message.submissionId, id: chunk.message.id,
          turnJobId: chunk.message.signal?.attributes?.turnJobId }] : []);
    return {
      result, error, chunks, review, relay, hostSubmissionId, joinedRecords,
      modelCalls: faux.state.callCount - callsBefore, ms: now() - began,
    };
  }

  /** What an observer reading a join's own submission (runTurn for the member) gets. */
  async function readJoin(join: Join) {
    try {
      const reply = await hostHandle.read(join.receipt);
      return { outcome: 'completed', text: reply.text, submissionId: reply.submissionId };
    } catch (error) {
      return { outcome: error instanceof AgentRunError ? error.outcome : 'threw', text: String(error) };
    }
  }

  /** Same, through promptSlackThreadAgent (TerminalStepText) keyed on the join's receipt. */
  async function observeJoinAsTurn(join: Join) {
    const envelope = scenario.turns.getDispatchEnvelope('head')!;
    const state: SlackFlueDispatchState = {
      dispatchEnvelope: { ...envelope, idempotencyKey: `join:${join.members.join('+')}` },
      dispatchReceipt: { ...scenario.turns.getFlueReceipt('head')!, submissionId: join.receipt.submissionId },
      prepare: () => envelope,
      recordReceipt: (receipt) => receipt,
      recordSettlement: (settlement) => settlement,
      reconcileExistingInstance: () => { throw new Error('Unexpected incarnation conflict.'); },
      markRecoveryRequired: (reason) => { throw new Error(`Unexpected recovery: ${reason}`); },
    };
    try {
      const result = await promptSlackThreadAgent({
        handle: hostHandle, state, message: LATE_TEXT, turnId: join.members[0]!,
        conversationKey: scenario.instanceId, requestedModel: MODEL,
      });
      return { text: result.text };
    } catch (error) {
      return { error: String(error) };
    }
  }

  const doors: Door[] = ['pull', 'push'];
  const scripted = (fn: (door: Door) => Promise<void>) => async () => {
    for (const door of doors) {
      scenario = openScenario();
      try {
        await fn(door);
      } finally {
        scenario.close();
      }
    }
  };

  try {
    await t.test('Q1-Q4, Q9: a message sent during tool batch 1 joins the next model request', scripted(async (door) => {
      probe = freshProbe(door, { onTool: arrivesInTool(1), toolDelayMs: () => 20 });
      const out = await run([work(1), work(2), work(3), answer('A launch note that mentions the pricing change.')]);
      assert.equal(out.error, undefined, String(out.error));
      const join = probe.joins[0]!;
      const startsAfterJoin = probe.starts.filter((s) => s.joinedBody);
      const rendersAfterJoin = probe.renders.filter((r) => r.at > join.dispatchedAt);
      const lastDelivery = probe.renders.at(-1)!.delivery;
      const late = scenario.turns.runnerView('late').job!;
      const receivedBeforeDelivery = late.fold?.received;
      scenario.turns.markDelivered('head');
      const lateAfter = scenario.turns.runnerView('late');
      const joinRead = await readJoin(join);
      const joinObserved = await observeJoinAsTurn(join);
      const hostSubmission = out.hostSubmissionId;
      const measured = {
        modelCalls: out.modelCalls,
        landedAtRequest: landedAt(),
        lateCountPerRequest: requests.map((r) => r.lateCount),
        joinedStartHooks: startsAfterJoin.map(({ turnJobId, envelopeTurn }) => ({ turnJobId, envelopeTurn })),
        useDeliveryAfterJoin: {
          turnJobId: lastDelivery.kind === 'signal' ? lastDelivery.attributes?.turnJobId : undefined,
          envelopeMessageTs: lastDelivery.kind === 'signal' ? parseCurrentRequestEnvelope(lastDelivery.body)?.slackMessageTs : undefined,
          headMessageTs: scenario.head.attributes?.messageTs,
          rendersAfterJoin: rendersAfterJoin.length,
          bodyIsJoin: lastDelivery.body.startsWith('While you were working'),
        },
        hostReplyText: out.result?.text,
        joinReadText: joinRead,
        joinObservedAsTurn: joinObserved,
        storeCalls: probe.storeCalls.map(({ phase, take, received }) => ({ phase, take, received })),
        lateFoldBeforeDelivery: { role: late.fold?.role, received: receivedBeforeDelivery },
        lateAfterMarkDelivered: { status: lateAfter.status, role: lateAfter.job?.fold?.role, cleanupPending: lateAfter.cleanupPending },
        joinedRecordSubmission: out.joinedRecords.map((r) => r.submissionId),
        joinedRecordTurnJobIdAttribute: out.joinedRecords.map((r) => r.turnJobId),
        hostSubmissionId: hostSubmission,
        joinReceiptSubmissionId: join.receipt.submissionId,
        collectorFollowUps: out.review?.followUps() ?? [],
        hostSawAppendedFromJoin: probe.appended.has(join.receipt.submissionId),
      };
      report[`q1_${door}`] = measured;
      assert.equal(measured.landedAtRequest, 2, `${door}: the join reaches the request right after batch 1`);
      assert.equal(measured.useDeliveryAfterJoin.turnJobId, 'head');
      assert.equal(measured.hostReplyText, 'A launch note that mentions the pricing change.');
    }));

    await t.test('Q2b: push under the member\'s own attributes moves every turnJobId reader', async () => {
      scenario = openScenario();
      try {
        probe = freshProbe('push', { onTool: arrivesInTool(1), memberAttributes: true });
        const out = await run([work(1), work(2), answer('Done.')]);
        const last = probe.renders.at(-1)!.delivery;
        report.q2b_push_member_attributes = {
          error: out.error === undefined ? undefined : String(out.error),
          useDeliveryTurnJobId: last.kind === 'signal' ? last.attributes?.turnJobId : undefined,
          persistedCurrentTurnAfter: probe.starts.map((s) => s.turnJobId),
        };
      } finally {
        scenario.close();
      }
    });

    await t.test('Q1b: pull misses a message that arrives after its batch already asked (parallel tools)', scripted(async (door) => {
      // Batch 1 runs work(1) (fast, asks first under pull) and work(2) (slow; the message arrives inside it).
      probe = freshProbe(door, {
        toolDelayMs: (step) => step === 2 ? 120 : 0,
        onTool: async (step) => {
          if (step !== 2) return;
          await sleep(40);
          scenario.arrive('late', LATE_TEXT);
          if (door === 'push') await hostPush();
        },
      });
      const out = await run([
        fauxAssistantMessage([fauxToolCall('work', { step: 1 }), fauxToolCall('work', { step: 2 })], { stopReason: 'toolUse' }),
        work(3), work(4), answer('Done.'),
      ]);
      report[`q1b_${door}`] = {
        error: out.error === undefined ? undefined : String(out.error),
        landedAtRequest: landedAt(),
        toolEnds: probe.toolEnds.map((e) => e.step),
        storeCalls: probe.storeCalls.length,
      };
    }));

    await t.test('Q5a: provider error on the turn after a join (join queued during a tool)', scripted(async (door) => {
      probe = freshProbe(door, { onTool: arrivesInTool(1) });
      const out = await run([work(1), providerError('503 service unavailable'), work(2), answer('Done.')]);
      report[`q5a_${door}`] = {
        error: out.error === undefined ? undefined : String(out.error),
        modelCalls: out.modelCalls,
        lateCountPerRequest: requests.map((r) => r.lateCount),
        hostReplyText: out.result?.text,
      };
    }));

    await t.test('Q5b: provider error on the model turn during which the join is queued', scripted(async (door) => {
      probe = freshProbe(door);
      const out = await run([work(1), arrivesDuring(providerError('503 service unavailable')), work(2), answer('Done.')]);
      const during = requests.map((r) => r.lateCount);
      const tails = requests.map((r) => r.tail);
      // The next submission rebuilds context from canonical records only.
      requests = [];
      faux.setResponses([answer('Next.')]);
      await hostHandle.read(await hostHandle.dispatch({ message: { kind: 'user', body: 'Next question.' } }));
      report[`q5b_${door}`] = {
        error: out.error === undefined ? undefined : String(out.error),
        modelCalls: out.modelCalls,
        lateCountPerRequest: during,
        tails,
        nextSubmissionLateCount: requests.map((r) => r.lateCount),
        hostReplyText: out.result?.text,
      };
    }));

    await t.test('Q5d: provider error and retry with no message (control for the reply text)', scripted(async (door) => {
      probe = freshProbe(door);
      const out = await run([work(1), providerError('503 service unavailable'), work(2), answer('Done.')]);
      report[`q5d_${door}`] = {
        modelCalls: out.modelCalls, hostReplyText: out.result?.text,
        chunkTypes: out.chunks.map(({ chunk }) => chunk.type === 'message-started' || chunk.type === 'message-completed'
          ? `${chunk.type}:${chunk.messageId.slice(-6)}` : chunk.type === 'message-appended'
            ? `appended:${chunk.message.role}${chunk.message.role === 'system' ? `/${chunk.message.purpose}/${chunk.message.display}` : ''}`
            : chunk.type).filter((type) => type !== 'message-delta'),
      };
    }));

    await t.test('Q5c: same as Q5b with no error (control)', scripted(async (door) => {
      probe = freshProbe(door);
      await run([work(1), arrivesDuring(work(2)), work(3), answer('Done.')]);
      report[`q5c_${door}`] = { lateCountPerRequest: requests.map((r) => r.lateCount), landedAtRequest: landedAt() };
    }));

    await t.test('Q4b: a host that fails settles the join failed', scripted(async (door) => {
      probe = freshProbe(door, { onTool: arrivesInTool(1) });
      const out = await run([work(1), providerError('400 invalid request: bad schema')]);
      const join = probe.joins[0];
      const joinRead = join ? await readJoin(join) : undefined;
      const late = scenario.turns.runnerView('late').job!;
      scenario.turns.markError('head');
      const released = scenario.turns.runnerView('late').job!;
      report[`q4b_${door}`] = {
        afterHeadError: { role: released.fold?.role, gate: turnJobGate(released) },
        hostError: out.error === undefined ? undefined : String(out.error).slice(0, 160),
        joinRead,
        lateFold: late.fold && { role: late.fold.role, received: late.fold.received },
        headSettlement: scenario.turns.getFlueSettlement('head')?.outcome,
        joinKey: join && (door === 'push' ? `join:${join.members.join('+')}` : '(none: useDispatchMessage takes no key)'),
      };
    }));

    await t.test('Q6: a message sent while the model writes its text-only answer', async () => {
      for (const door of doors) {
        for (const second of ['complete', 'delta'] as const) {
          scenario = openScenario();
          try {
            probe = freshProbe(door);
            const out = await run([
              work(1),
              arrivesDuring(answer('A launch note.')),
              answer(second === 'complete' ? 'A launch note that mentions the pricing change.' : 'Pricing changed too.'),
            ]);
            const asked = requests.at(-1);
            report[`q6_${door}_${second}`] = {
              error: out.error === undefined ? undefined : String(out.error),
              modelCalls: out.modelCalls,
              hostReplyText: out.result?.text,
              lastRequestTail: asked?.tail,
              joinKind: probe.joins.length ? 'join' : probe.appends.length ? 'finish-append' : 'none',
              bodyCopy: (probe.joins.length
                ? '(tool-boundary copy) ' + toolBoundaryBody({ messages: [], requesterText: '' }, '').split('\n\n')[2]
                : probe.appends[0]?.body.split('\n\n')[2]),
            };
          } finally {
            scenario.close();
          }
        }
      }
    });

    await t.test('Q7: stream gate', async () => {
      const cases = [
        ['during_declaration_tool', () => [streamAnswer(), answer('Streamed answer.')], true],
        ['during_streamed_text', () => [streamAnswer(), arrivesDuring(answer('Streamed answer.')), answer('Second answer.')], false],
      ] as const;
      for (const door of doors) {
        for (const ignoreStreamGate of door === 'pull' ? [false, true] : [false]) {
          for (const [name, script, inTool] of cases) {
            scenario = openScenario();
            try {
              probe = freshProbe(door, { ignoreStreamGate, ...(inTool ? { onTool: arrivesInTool(0) } : {}) });
              const out = await run([...script()], { relay: true });
              report[`q7_${door}${ignoreStreamGate ? '_nogate' : ''}_${name}`] = {
                error: out.error === undefined ? undefined : String(out.error),
                joins: probe.joins.length,
                appends: probe.appends.length,
                lateCountPerRequest: requests.map((r) => r.lateCount),
                relayAppended: out.relay.appended.join(''),
                relayIntents: out.relay.intents,
                relayInvalidations: out.relay.invalidations,
                hostReplyText: out.result?.text,
                lateFold: scenario.turns.runnerView('late').job?.fold?.role ?? 'none (waits for its own turn)',
              };
            } finally {
              scenario.close();
            }
          }
        }
      }
    });

    await t.test('Q8: cost and latency', async () => {
      // Store calls per response, 10 tool batches, no arrivals.
      for (const door of doors) {
        scenario = openScenario();
        try {
          probe = freshProbe(door);
          await run([...Array.from({ length: 10 }, (_, i) => work(i + 1)), answer('Done.')]);
          report[`q8_calls_${door}`] = {
            storeCalls: probe.storeCalls.length,
            byPhase: probe.storeCalls.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.phase]: (acc[c.phase] ?? 0) + 1 }), {}),
            inMemoryStoreMsP50: median(probe.storeCalls.map((c) => c.ms)),
          };
        } finally {
          scenario.close();
        }
      }
      // Latency: the message arrives 10 ms into a 200 ms tool; time to the model request that reads it.
      const samples: Record<string, number[]> = {};
      for (const door of doors) {
        for (const hookDelay of [0, 250]) {
          for (let i = 0; i < 5; i += 1) {
            scenario = openScenario();
            try {
              probe = freshProbe(door, {
                startHookDelayMs: hookDelay,
                toolDelayMs: (step) => step === 1 ? 200 : 0,
                onTool: async (step) => {
                  if (step !== 1) return;
                  setTimeout(() => {
                    scenario.arrive('late', LATE_TEXT);
                    if (door === 'push') void hostPush();
                  }, 10);
                },
              });
              await run([work(1), work(2), answer('Done.')]);
              const arrival = probe.arrivals[0]!.at;
              const batchEnd = probe.toolEnds.find((e) => e.step === 1)!.at;
              const seen = requests.find((r) => r.lateCount > 0)!.at;
              (samples[`${door}_hook${hookDelay}_arrivalToModel`] ??= []).push(seen - arrival);
              (samples[`${door}_hook${hookDelay}_batchEndToModel`] ??= []).push(seen - batchEnd);
              const joinStart = probe.starts.find((s) => s.joinedBody);
              if (joinStart) (samples[`${door}_hook${hookDelay}_startHookMs`] ??= []).push(joinStart.ms);
            } finally {
              scenario.close();
            }
          }
        }
        // Control: no arrival, the same 200 ms batch.
        for (let i = 0; i < 5; i += 1) {
          scenario = openScenario();
          try {
            probe = freshProbe(door, { toolDelayMs: (step) => step === 1 ? 200 : 0 });
            await run([work(1), work(2), answer('Done.')]);
            const batchEnd = probe.toolEnds.find((e) => e.step === 1)!.at;
            const next = requests[1]!.at;
            (samples[`${door}_nojoin_batchEndToModel`] ??= []).push(next - batchEnd);
          } finally {
            scenario.close();
          }
        }
      }
      report.q8_latency_ms = Object.fromEntries(Object.entries(samples).map(([key, values]) =>
        [key, { p50: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) }]));
    });
  } finally {
    await runtime.stop();
    await stopInstrumentation();
    if (process.env.SPIKE_OUT) writeFileSync(process.env.SPIKE_OUT, `${JSON.stringify(report, null, 2)}\n`);
    else console.log(JSON.stringify(report, null, 2));
  }
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
