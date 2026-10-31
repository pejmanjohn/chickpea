import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  init, instrument, useDelivery, useModel, useTool,
  type AgentProps, type DeliveredMessage, type FlueExecutionInterceptor, type LlmMessage,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  bindCurrentRequestConversation, currentRequestEnvelopeText, memoryToolPolicyInterceptor,
  observeMemoryToolPolicy, serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';
import { RunReviewCollector } from '../src/review/collector.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import {
  slackToolBoundaryFoldInterceptor, useSlackFollowUpFold, type LateFoldRequest,
} from '../src/slack/follow-up-fold.ts';
import {
  followUpSignalMessages, MAX_TURN_FOLD_CYCLES, TOOL_BOUNDARY_PULL_INTERVAL_MS,
} from '../src/slack/follow-ups.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';
import { registerSlackStatusTurn } from '../src/slack/status-registry.ts';
import { SLACK_ASK_USER_TOOL_NAME } from '../src/slack/ui/presentation-tools.ts';
import type { TurnFoldClaim, TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { editTurnJobId } from '../src/slack/edits.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';

/**
 * Steering C through the real Flue harness: a message the person sends while
 * the Agent runs tools reaches the model right after that tool batch, as part
 * of the same response, through the state store's own fold.
 */

const MODEL = 'faux/tool-boundary-fold';
const PERSON = 'U_PERSON';
const GENERATION = 'gen-tool-boundary-fold';
const NOW = 1_800_000_000_000;
const LATE = 'Also mention the pricing change.';

interface Scenario {
  plan: RuntimePlanV2;
  instanceId: string;
  turns: TurnJobStoreLogic;
  /** Every call the Agent made to the store. */
  calls: LateFoldRequest[];
  /** Admit a message the person sent now, queued behind the running head. */
  arrive(id: string, text: string): void;
  /** Admit the person's edit of the head's message, as edit admission writes it. */
  editHead(text: string): void;
  fold(request: LateFoldRequest): Promise<TurnFoldClaim | undefined>;
  close(): void;
}

interface ModelRequest {
  /** User messages that carry LATE (a fold carries it in its body). */
  late: number;
  /** Text of each tool result the model reads, with whether it is an error. */
  toolResults: { text: string; isError: boolean }[];
}

let scenario: Scenario;
let deliveries: DeliveredMessage[] = [];
let requests: ModelRequest[] = [];
/** Runs at the start of `work` step `step`, before its delay. */
let onTool: (step: number) => Promise<void> | void = () => {};
let toolDelayMs: (step: number) => number = () => 0;
/** How far `performance.now()` runs ahead of real time, so a test crosses the check interval without waiting. */
let elapsedMs = 0;
/** The next tool boundary comes past the check interval (TOOL_BOUNDARY_PULL_INTERVAL_MS). */
function pastInterval(): void {
  elapsedMs += TOOL_BOUNDARY_PULL_INTERVAL_MS;
}

function PullProbe({ id }: AgentProps) {
  useModel(MODEL);
  bindCurrentRequestConversation(scenario.plan.conversation);
  deliveries.push(useDelivery());
  useSlackFollowUpFold({ instanceId: id, blocked: () => false, fold: (request) => scenario.fold(request) });
  useTool({
    name: 'work',
    description: 'Do one step of work.',
    input: v.strictObject({ step: v.number() }),
    async run({ data }) {
      await onTool(data.step);
      const delay = toolDelayMs(data.step);
      if (delay) await sleep(delay);
      return { output: `done ${data.step}` };
    },
  });
  useTool({
    name: SLACK_STREAM_ANSWER_TOOL_NAME,
    description: 'Declare that the final answer streams to Slack.',
    input: v.strictObject({}),
    async run() {
      await onTool(0);
      return { output: 'streaming' };
    },
  });
  useTool({
    name: SLACK_ASK_USER_TOOL_NAME,
    description: 'Ask the person a question; the answer arrives as the next message.',
    input: v.strictObject({}),
    async run() {
      await onTool(0);
      return { output: 'asked' };
    },
  });
}

let thread = 0;

function openScenario(options: { failFold?: boolean } = {}): Scenario {
  thread += 1;
  const threadTs = `1800002${String(thread).padStart(3, '0')}.000100`;
  const conversation = { workspaceId: 'T_PULL', channelId: 'C_PULL', threadTs };
  const turn = (messageTs: string, text: string): NormalizedSlackTurn => ({
    ...conversation, eventId: `Ev_${messageTs}`, text, userId: PERSON, messageTs,
    source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel',
    requesterTimezone: 'America/Los_Angeles',
  });
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_PULL', channelId: 'C_PULL', agentId: 'agent_pull', model: MODEL,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_pull', kind: 'user', revision: 1, name: 'Pull', instructions: 'Help.', enabled: true,
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
  };
  enqueue('head', 'Draft the launch note.');
  const head = turns.runnerView('head').job!;
  const plan = compileRuntimePlanV2({ turn: head.turn, assignment, instructions: 'Help.', memoryEpoch: 1 });
  turns.freezeRuntimePlan('head', plan);
  turns.prepareFlueDispatch('head', `Draft the launch note.\n\n${serializeCurrentRequestEnvelope(
    '', false, PERSON, head.turn.messageTs, { schemaVersion: 2 },
  )}`, { generation: GENERATION });
  const calls: LateFoldRequest[] = [];
  return {
    plan,
    instanceId: turns.getFrozenRuntimePlan('head')!.instanceId,
    turns,
    calls,
    arrive: enqueue,
    editHead(text) {
      const editedTs = `${threadTs.split('.')[0]}.000${sequence++}`;
      const id = editTurnJobId(head.turn.channelId, head.turn.messageTs, editedTs);
      turns.enqueue({
        id, evtKey: `evt:Ev_${editedTs}`, msgKey: id, assignment,
        turn: { ...head.turn, text, eventId: `Ev_${editedTs}`, edit: { editedTs, previousText: head.turn.text } },
      });
      clock.now += 1;
    },
    async fold(request) {
      calls.push(request);
      if (options.failFold) throw new Error('state store unavailable');
      return turns.fold(request);
    },
    close: () => db.close(),
  };
}

function dispatchState(turns: TurnJobStoreLogic): SlackFlueDispatchState {
  const envelope = turns.getDispatchEnvelope('head')!;
  return {
    prepare: () => envelope,
    recordReceipt: (receipt) => turns.recordFlueReceipt('head', receipt),
    recordSettlement: (settlement) => turns.recordFlueSettlement('head', settlement),
    reconcileExistingInstance: () => { throw new Error('Unexpected incarnation conflict.'); },
    markRecoveryRequired: (reason) => { throw new Error(`Unexpected recovery: ${reason}`); },
  };
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === 'string' ? content
    : content.flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : []).join('\n');
}

const answer = (text: string) => fauxAssistantMessage(text);
const work = (...steps: number[]) => fauxAssistantMessage(
  [fauxText(`Working on step ${steps.join(' and ')}.`), ...steps.map((step) => fauxToolCall('work', { step }))],
  { stopReason: 'toolUse' },
);
const streamAnswer = () =>
  fauxAssistantMessage([fauxToolCall(SLACK_STREAM_ANSWER_TOOL_NAME, {})], { stopReason: 'toolUse' });
const askUser = () =>
  fauxAssistantMessage([fauxToolCall(SLACK_ASK_USER_TOOL_NAME, {})], { stopReason: 'toolUse' });
const providerError = () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 service unavailable' });
/** A model step that runs as the person sends `text`. */
function arrivesDuring(id: string, text: string, step: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep {
  return () => {
    scenario.arrive(id, text);
    return step;
  };
}
/** The person sends LATE while `work` step `step` runs. */
function arrivesInTool(step: number, id = 'late', text = LATE) {
  return (running: number) => {
    if (running === step) scenario.arrive(id, text);
  };
}

test('messages sent while the Agent runs tools reach the model after that tool batch', { timeout: 60_000 }, async (t) => {
  const faux = fauxProvider({ models: [{ id: 'tool-boundary-fold' }], tokensPerSecond: 100_000 });
  const observation = createWorkModelInvocationInterceptor({
    resolveTarget: async (instanceId, submissionId) => ({
      generation: GENERATION, turnJobId: 'head', instanceId, submissionId,
    }),
  });
  const interceptor: FlueExecutionInterceptor = (operation, context, next) =>
    memoryToolPolicyInterceptor(operation, context, () => observation(operation, context, () =>
      slackToolBoundaryFoldInterceptor(operation, context, next)));
  const stopInstrumentation = instrument({
    interceptor,
    observe(event, context) {
      observeMemoryToolPolicy(event, context);
      if (event.type !== 'turn_request' || event.purpose !== 'agent') return;
      const messages: readonly LlmMessage[] = event.request.input.messages;
      requests.push({
        late: messages.filter((message) => message.role === 'user' && textOf(message.content).includes(LATE)).length,
        toolResults: messages.flatMap((message) => message.role === 'toolResult'
          ? [{ text: textOf(message.content), isError: message.isError }] : []),
      });
    },
    dispose() {},
  });
  const realNow = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => realNow() + elapsedMs);
  const runtime = await start({
    agents: [{ agent: PullProbe, name: CHICKPEA_SLACK_AGENT_NAME }],
    providers: [faux.provider],
  });

  async function run(responses: FauxResponseStep[]) {
    deliveries = [];
    requests = [];
    faux.setResponses(responses);
    const statuses: string[] = [];
    let review: RunReviewCollector | undefined;
    const { instanceId } = scenario;
    const statusTurn = registerSlackStatusTurn(instanceId, {
      setStatus: async (update) => { statuses.push(update.text); return true; },
    }, { generation: GENERATION, observedMinIntervalMs: 0 });
    try {
      const result = await promptSlackThreadAgent({
        handle: init(PullProbe, { id: instanceId }),
        state: dispatchState(scenario.turns),
        message: 'Draft the launch note.',
        turnId: 'head', conversationKey: instanceId, requestedModel: MODEL,
        onConversationChunk: (chunk, submissionId) => {
          review ??= new RunReviewCollector(submissionId, 'head');
          review.ingest(chunk);
        },
      });
      await statusTurn.drain();
      return { result, statuses, review };
    } finally {
      statusTurn.close();
      onTool = () => {};
      toolDelayMs = () => 0;
    }
  }

  /** Each fold once: every later render of the response delivers the joined one again. */
  const folds = () => [...new Map(deliveries.flatMap((delivery) =>
    delivery.kind === 'signal' && delivery.type === 'slack.message' && followUpSignalMessages(delivery.body) !== undefined
      ? [[delivery.body, delivery] as const] : [])).values()];
  const calls = () => scenario.calls.map(({ phase, received, take }) => ({ phase, received, take }));
  const lateSeen = () => requests.map((request) => request.late);

  try {
    await t.test('a message sent during the first batch is in the very next model request', async () => {
      scenario = openScenario();
      try {
        onTool = (step) => {
          pastInterval();
          arrivesInTool(1)(step);
        };
        toolDelayMs = () => 20;
        const { result, statuses, review } = await run([
          work(1), work(2), work(3), answer('A launch note that mentions the pricing change.'),
        ]);
        assert.deepEqual(lateSeen(), [0, 1, 1, 1], 'read once, from the request right after batch 1');
        assert.equal(result.text, 'A launch note that mentions the pricing change.', 'only the final step posts');
        assert.deepEqual(calls(), [
          { phase: 'turn', received: 0, take: true },
          { phase: 'turn', received: 1, take: true },
          { phase: 'turn', received: 1, take: true },
          { phase: 'finish', received: 1, take: true },
        ], 'one call per batch; the next one confirms');
        assert.deepEqual(statuses, ['Reading 1 new message…']);

        const late = scenario.turns.runnerView('late').job!;
        assert.equal(late.fold?.received, true);
        assert.equal(late.fold?.toolBoundary, true);
        assert.equal(scenario.turns.readThrough('head'), late.turn.messageTs, 'the reading tools treat it as read');
        assert.deepEqual(review?.followUps(), [{ userId: PERSON, messageTs: late.turn.messageTs, text: LATE }],
          'the help-improve copy keeps the joined message');

        assert.equal(folds().length, 1);
        const [fold] = folds();
        const original = deliveries[0]!;
        assert.ok(fold?.kind === 'signal' && original.kind === 'signal');
        assert.match(fold.body, /^While you were working, <@U_PERSON> sent another message in this thread:\n\n- \[.+ role=human\] U_PERSON: Also mention the pricing change\.\n\nThese arrived while you were working\. .+ take them into account before you continue\./);
        assert.equal(currentRequestEnvelopeText(fold.body), currentRequestEnvelopeText(original.body));
        assert.deepEqual(fold.attributes, {
          ...original.attributes,
          requesterText: `Draft the launch note.\n\n${LATE}`,
        }, 'the head\'s identity: every reader of the turn job still reads the head');
        const last = deliveries.at(-1)!;
        assert.equal(last.kind === 'signal' ? last.attributes?.turnJobId : undefined, 'head');

        scenario.turns.markDelivered('head');
        assert.equal(scenario.turns.runnerView('late').status, 'done', 'it ends with this reply');
      } finally {
        scenario.close();
      }
    });

    await t.test('in a parallel batch the check waits for the batch\'s last call', async () => {
      scenario = openScenario();
      try {
        toolDelayMs = (step) => step === 2 ? 120 : 0;
        onTool = async (step) => {
          if (step === 3) pastInterval();
          if (step !== 2) return;
          await sleep(40);
          scenario.arrive('late', LATE);
        };
        await run([work(1, 2), work(3), answer('Done.')]);
        assert.deepEqual(lateSeen(), [0, 1, 1], 'the message the slow call overlapped reaches the next request');
        assert.deepEqual(calls(), [
          { phase: 'turn', received: 0, take: true },
          { phase: 'turn', received: 1, take: true },
          { phase: 'finish', received: 1, take: true },
        ], 'one call for the two-call batch');
      } finally {
        scenario.close();
      }
    });

    await t.test('tool-boundary checks start at most once per interval, the first boundary always checking', async () => {
      scenario = openScenario();
      try {
        onTool = (step) => {
          if (step === 2) scenario.arrive('late', LATE);
          if (step === 4) pastInterval();
        };
        await run([work(1), work(2), work(3), work(4), answer('Done.')]);
        assert.deepEqual(calls(), [
          { phase: 'turn', received: 0, take: true },
          { phase: 'turn', received: 0, take: true },
          { phase: 'finish', received: 1, take: true },
        ], 'one call for the three quick batches, the next once the interval passed');
        assert.deepEqual(lateSeen(), [0, 0, 0, 0, 1], 'the message sent during batch 2 is read after batch 4');
      } finally {
        scenario.close();
      }
    });

    await t.test('after stream_answer nothing is pulled: the message waits for its own turn', async () => {
      scenario = openScenario();
      try {
        onTool = (step) => { if (step === 0) scenario.arrive('late', LATE); };
        const { result } = await run([streamAnswer(), answer('Streamed answer.')]);
        assert.equal(result.text, 'Streamed answer.');
        assert.deepEqual(scenario.calls, []);
        assert.deepEqual(lateSeen(), [0, 0]);
        assert.equal(scenario.turns.runnerView('late').job!.fold, undefined);
      } finally {
        scenario.close();
      }
    });

    await t.test('after a posted question neither check takes a message: the reply is finished and can do no more work', async () => {
      scenario = openScenario();
      try {
        onTool = (step) => { if (step === 0) scenario.arrive('during_question', LATE); };
        const { result } = await run([
          askUser(),
          arrivesDuring('while_answering', 'Use the new logo.', answer('Which launch do you mean?')),
        ]);
        assert.equal(result.text, 'Which launch do you mean?');
        assert.deepEqual(scenario.calls, [], 'no tool-boundary call after the question, and no would-stop call');
        assert.deepEqual(lateSeen(), [0, 0]);
        assert.deepEqual(['during_question', 'while_answering'].map((id) => scenario.turns.runnerView(id).job!.fold), [undefined, undefined],
          'both wait for a turn of their own');
      } finally {
        scenario.close();
      }
    });

    await t.test('tool-boundary and would-stop folds count one sequence, and neither takes a message twice', async () => {
      scenario = openScenario();
      try {
        onTool = arrivesInTool(1, 'during_tools', 'Use the new logo.');
        const { result, statuses } = await run([
          work(1),
          arrivesDuring('while_answering', LATE, answer('A launch note.')),
          answer('A launch note with the new logo that mentions the pricing change.'),
        ]);
        assert.equal(result.text, 'A launch note with the new logo that mentions the pricing change.');
        assert.deepEqual(calls(), [
          { phase: 'turn', received: 0, take: true },
          { phase: 'finish', received: 1, take: true },
          { phase: 'finish', received: 2, take: true },
        ]);
        assert.deepEqual(['during_tools', 'while_answering'].map((id) => scenario.turns.runnerView(id).job!.fold?.cycle), [1, 2]);
        assert.deepEqual(folds().map((fold) => followUpSignalMessages(fold.body)?.map((message) => message.text)), [
          ['Use the new logo.'],
          [LATE],
        ]);
        assert.match(folds()[1]!.body, /\n\nYour draft reply has not been sent\./, 'the would-stop copy');
        assert.deepEqual(statuses, ['Reading 1 new message…']);
      } finally {
        scenario.close();
      }
    });

    await t.test('a provider error after a pulled message never shows it twice', async () => {
      scenario = openScenario();
      try {
        onTool = arrivesInTool(1);
        const { result } = await run([work(1), providerError(), work(2), answer('Done.')]);
        assert.equal(result.text, 'Done.');
        assert.ok(lateSeen().every((count) => count <= 1), `seen per request: ${lateSeen().join(',')}`);
        assert.equal(lateSeen().at(-1), 1);
      } finally {
        scenario.close();
      }
    });

    await t.test(`after ${MAX_TURN_FOLD_CYCLES} tool-boundary folds the rest waits for the would-stop`, async () => {
      scenario = openScenario();
      try {
        const batches = MAX_TURN_FOLD_CYCLES + 1;
        onTool = (step) => {
          pastInterval();
          scenario.arrive(`late_${step}`, `Addition ${step}.`);
        };
        await run([
          ...Array.from({ length: batches }, (_, index) => work(index + 1)), answer('Draft.'), answer('Done.'),
        ]);
        const turnCalls = calls().filter(({ phase }) => phase === 'turn');
        assert.deepEqual(turnCalls.map(({ received }) => received), Array.from({ length: MAX_TURN_FOLD_CYCLES }, (_, index) => index));
        assert.deepEqual(calls().filter(({ phase }) => phase === 'finish'), [
          { phase: 'finish', received: MAX_TURN_FOLD_CYCLES, take: true },
          { phase: 'finish', received: MAX_TURN_FOLD_CYCLES + 1, take: true },
        ], 'the would-stop takes the last message');
        assert.equal(scenario.turns.runnerView(`late_${batches}`).job!.fold?.cycle, MAX_TURN_FOLD_CYCLES + 1);
      } finally {
        scenario.close();
      }
    });

    await t.test('an edit of the message the Agent is answering reaches it after the tool batch, as an edit note', async () => {
      scenario = openScenario();
      const edited = 'Draft the launch note for partners.';
      try {
        onTool = (step) => {
          pastInterval();
          if (step === 1) scenario.editHead(edited);
        };
        toolDelayMs = () => 20;
        const { statuses, review } = await run([work(1), work(2), answer('A launch note for partners.')]);
        assert.deepEqual(statuses, ['Reading 1 edited message…']);
        assert.equal(folds().length, 1);
        const [fold] = folds();
        assert.ok(fold?.kind === 'signal');
        assert.match(fold.body, /^While you were working, <@U_PERSON> edited a message you already read in this thread \(the edited message keeps its time, and its new text replaces what you read\):\n\n- \[.+ role=human edited\] U_PERSON: Draft the launch note for partners\.\n\nBefore the edit, that message read:\n\n- \[.+ role=human\] U_PERSON: Draft the launch note\.\n\nThese arrived while you were working\./);
        const headTs = scenario.turns.runnerView('head').job!.turn.messageTs;
        assert.deepEqual(followUpSignalMessages(fold.body), [
          { userId: PERSON, messageTs: headTs, text: edited, edit: { previousText: 'Draft the launch note.' } },
        ]);
        assert.deepEqual(review?.followUps().map(({ text }) => text), [edited], 'the help-improve copy keeps the new text');
      } finally {
        scenario.close();
      }
    });

    await t.test('a failed store call leaves the tool result as it was', async () => {
      scenario = openScenario({ failFold: true });
      try {
        onTool = arrivesInTool(1);
        const { result } = await run([work(1), answer('Done.')]);
        assert.equal(result.text, 'Done.');
        assert.deepEqual(requests[1]?.toolResults, [{ text: JSON.stringify('done 1'), isError: false }]);
        assert.deepEqual(calls().map(({ phase }) => phase), ['turn', 'finish']);
        assert.equal(folds().length, 0);
      } finally {
        scenario.close();
      }
    });
  } finally {
    await runtime.stop();
    await stopInstrumentation();
  }
});
