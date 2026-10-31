import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  init, instrument, useModel, useTool,
  type AgentProps, type FlueExecutionInterceptor, type LlmMessage,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';
import type { WebClient } from '@slack/web-api';
import * as v from 'valibot';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  bindCurrentRequestConversation, memoryToolPolicyInterceptor, observeMemoryToolPolicy,
  serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';
import { SlackAgentViewPresentation } from '../src/slack/agent-view-presentation.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import { slackToolBoundaryFoldInterceptor, useSlackFollowUpFold } from '../src/slack/follow-up-fold.ts';
import {
  MID_RUN_REPLY_GUIDANCE, SLACK_REPLY_IN_THREAD_TOOL_NAME, TOOL_BOUNDARY_PULL_INTERVAL_MS,
} from '../src/slack/follow-ups.ts';
import { createMidRunReplyHandler, useSlackMidRunReplyTool } from '../src/slack/midrun-reply.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';
import { localSlackPresentationStatePort } from '../src/slack/presentation-state-port.ts';
import {
  observePresentationToolPolicy, presentationToolPolicyInterceptor,
} from '../src/slack/presentation-tool-policy.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { registerSlackStatusTurn } from '../src/slack/status-registry.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { WebClientPresenter } from '../src/slack/web-client-presenter.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';

/**
 * Steering C6 through the real Flue harness: a teammate's question read at a
 * tool boundary gets one short threaded reply from the Agent, posted by the
 * turn's presenter as the Agent, while the work goes on to one final reply.
 */

const MODEL = 'faux/midrun-reply';
const REQUESTER = 'U_REQUESTER';
const TEAMMATE = 'U_TEAMMATE';
const GENERATION = 'gen-midrun-reply';
const NOW = 1_800_000_000_000;
const PERSONA = { name: 'Atlas', avatarUrl: 'https://example.test/atlas.png', avatarRevision: 1 };
const QUESTION = 'Which repo are you using?';

interface Scenario {
  plan: RuntimePlanV2;
  instanceId: string;
  turns: TurnJobStoreLogic;
  presentations: SlackRunPresentationStoreLogic;
  view: SlackAgentViewPresentation;
  presenter: WebClientPresenter;
  /** Every chat.postMessage the presenter sent. */
  posts: Record<string, unknown>[];
  /** The teammate's message, admitted now behind the running head; returns its ts. */
  ask(): string;
  close(): void;
}

let scenario: Scenario;
/** Tools offered, and tool results read, at each model request. */
let requests: { tools: string[]; guided: boolean; toolResults: { text: string; isError: boolean }[] }[] = [];
let onTool: () => void = () => {};
let elapsedMs = 0;

function ReplyProbe({ id }: AgentProps) {
  useModel(MODEL);
  bindCurrentRequestConversation(scenario.plan.conversation);
  const followUps = useSlackFollowUpFold({
    instanceId: id,
    blocked: () => false,
    fold: async (request) => scenario.turns.fold(request),
  });
  useTool({
    name: 'work',
    description: 'Do one step of work.',
    input: v.strictObject({ step: v.number() }),
    async run({ data }) {
      onTool();
      return { output: `done ${data.step}` };
    },
  });
  useTool({
    name: SLACK_STREAM_ANSWER_TOOL_NAME,
    description: 'Declare that the final answer streams to Slack.',
    input: v.strictObject({}),
    output: v.string(),
    run: () => ({ output: 'streaming' }),
  });
  useSlackMidRunReplyTool(followUps);
}

let thread = 0;

function openScenario(options: { envelopeVersion?: 1 | 2 } = {}): Scenario {
  thread += 1;
  const threadTs = `1800003${String(thread).padStart(3, '0')}.000100`;
  const conversation = { workspaceId: 'T_REPLY', channelId: 'C_REPLY', threadTs };
  let sequence = 200;
  const turn = (userId: string, text: string): NormalizedSlackTurn => ({
    ...conversation, eventId: `Ev_${sequence}`, text, userId, messageTs: `${threadTs.split('.')[0]}.000${sequence++}`,
    source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel', requesterTimezone: 'UTC',
  });
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_REPLY', channelId: 'C_REPLY', agentId: 'agent_atlas', model: MODEL,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_atlas', kind: 'user', revision: 1, name: 'Atlas', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  const clock = { now: NOW };
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => clock.now);
  const enqueue = (id: string, userId: string, text: string): TurnJob => {
    const job: TurnJob = { id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, runId: `run_${id}`, turn: turn(userId, text), assignment };
    turns.enqueue(job);
    clock.now += 1;
    return job;
  };
  const head = enqueue('head', REQUESTER, 'Fix the login bug.');
  const plan = compileRuntimePlanV2({ turn: head.turn, assignment, instructions: 'Help.', memoryEpoch: 1 });
  turns.freezeRuntimePlan('head', plan);
  turns.prepareFlueDispatch('head', `Fix the login bug.\n\n${serializeCurrentRequestEnvelope(
    '', false, REQUESTER, head.turn.messageTs,
    { schemaVersion: options.envelopeVersion ?? 2, progressiveStreamingOffered: true },
  )}`, { generation: GENERATION });

  const presentations = new SlackRunPresentationStoreLogic(db, () => NOW + elapsedMs);
  presentations.create({
    runId: 'run_head', turnJobId: 'head', bindingId: 'binding_head', workBindingGeneration: 1, runFencingToken: 0,
    root: { ...conversation, requesterUserId: REQUESTER }, schemaVersion: 3,
    owner: { kind: 'selected_agent', persona: PERSONA }, sessionGeneration: 1,
  });
  const posts: Record<string, unknown>[] = [];
  const client = {
    chat: {
      async postMessage(input: Record<string, unknown>) {
        posts.push(input);
        return { ok: true, ts: `1800009999.00${posts.length}` };
      },
    },
  } as unknown as WebClient;
  return {
    plan,
    instanceId: turns.getFrozenRuntimePlan('head')!.instanceId,
    turns,
    presentations,
    view: new SlackAgentViewPresentation({
      client,
      state: localSlackPresentationStatePort({ presentations, matchFlueObservation: () => undefined }),
      runId: 'run_head',
      runFencingToken: 0,
      footer: { agentName: PERSONA.name, agentId: 'agent_atlas' },
    }),
    presenter: new WebClientPresenter(client, {
      channelId: 'C_REPLY', threadTs, agentName: PERSONA.name,
      visibleOwner: { kind: 'selected_agent', persona: PERSONA }, agentId: 'agent_atlas',
    }),
    posts,
    ask: () => enqueue('question', TEAMMATE, QUESTION).turn.messageTs,
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
const work = (step: number) => fauxAssistantMessage(
  [fauxText(`Working on step ${step}.`), fauxToolCall('work', { step })], { stopReason: 'toolUse' },
);
const streamAnswer = () =>
  fauxAssistantMessage([fauxToolCall(SLACK_STREAM_ANSWER_TOOL_NAME, {})], { stopReason: 'toolUse' });
/** The model answers the teammate's question, by the ts it read in its fold. */
const replyTo = (messageTs: () => string, text: string): FauxResponseStep => () => fauxAssistantMessage(
  [fauxToolCall(SLACK_REPLY_IN_THREAD_TOOL_NAME, { message_ts: messageTs(), text })], { stopReason: 'toolUse' },
);

test('the Agent answers a question it read at a tool boundary in the thread, and keeps working', { timeout: 60_000 }, async (t) => {
  const faux = fauxProvider({ models: [{ id: 'midrun-reply' }], tokensPerSecond: 100_000 });
  const observation = createWorkModelInvocationInterceptor({
    resolveTarget: async (instanceId, submissionId) => ({
      generation: GENERATION, turnJobId: 'head', instanceId, submissionId,
    }),
  });
  // The production order (src/app.ts): the fold runs inside the presentation policy.
  const interceptor: FlueExecutionInterceptor = (operation, context, next) =>
    memoryToolPolicyInterceptor(operation, context, () =>
      presentationToolPolicyInterceptor(operation, context, () =>
        slackToolBoundaryFoldInterceptor(operation, context, () => observation(operation, context, next))));
  const stopInstrumentation = instrument({
    interceptor,
    observe(event, context) {
      observeMemoryToolPolicy(event, context);
      observePresentationToolPolicy(event, context);
      if (event.type !== 'turn_request' || event.purpose !== 'agent') return;
      const messages: readonly LlmMessage[] = event.request.input.messages;
      requests.push({
        tools: (event.request.input.tools ?? []).map((tool) => tool.name),
        guided: messages.some((message) => message.role === 'user' && textOf(message.content).includes(MID_RUN_REPLY_GUIDANCE)),
        toolResults: messages.flatMap((message) => message.role === 'toolResult'
          ? [{ text: textOf(message.content), isError: message.isError }] : []),
      });
    },
    dispose() {},
  });
  const realNow = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => realNow() + elapsedMs);
  const runtime = await start({
    agents: [{ agent: ReplyProbe, name: CHICKPEA_SLACK_AGENT_NAME }],
    providers: [faux.provider],
  });

  async function run(responses: FauxResponseStep[]) {
    requests = [];
    faux.setResponses(responses);
    const { instanceId, view, presenter } = scenario;
    // As run-turn registers the live turn: its presenter posts the reply.
    const statusTurn = registerSlackStatusTurn(instanceId, { setStatus: async () => true }, {
      generation: GENERATION,
      midRunReply: createMidRunReplyHandler({
        presentation: view,
        post: (text) => presenter.postMidRunReply(text),
        now: () => NOW + elapsedMs,
      }),
    });
    try {
      const result = await promptSlackThreadAgent({
        handle: init(ReplyProbe, { id: instanceId }),
        state: dispatchState(scenario.turns),
        message: 'Fix the login bug.',
        turnId: 'head', conversationKey: instanceId, requestedModel: MODEL,
      });
      await statusTurn.prepareFinal();
      return result;
    } finally {
      statusTurn.close();
      onTool = () => {};
    }
  }
  const lastToolResult = () => requests.at(-1)!.toolResults.at(-1)!;

  try {
    await t.test('one threaded reply as the Agent, then one final reply', async () => {
      scenario = openScenario();
      try {
        let questionTs = '';
        onTool = () => {
          elapsedMs += TOOL_BOUNDARY_PULL_INTERVAL_MS;
          if (!questionTs) questionTs = scenario.ask();
        };
        const result = await run([
          work(1),
          replyTo(() => questionTs, 'I am using **acme/web**.'),
          work(2),
          answer('Fixed the login bug in acme/web.'),
        ]);
        assert.equal(result.text, 'Fixed the login bug in acme/web.', 'the final reply is only the last step');
        assert.equal(scenario.posts.length, 1, 'one mid-run post');
        const [post] = scenario.posts;
        assert.equal(post!.thread_ts, scenario.plan.conversation.threadTs);
        assert.equal(post!.username, PERSONA.name, 'the final reply\'s sender');
        assert.equal(post!.icon_url, PERSONA.avatarUrl);
        assert.deepEqual(post!.blocks, [{ type: 'markdown', text: 'I am using **acme/web**.' }], 'no footer');
        assert.equal(requests[2]?.toolResults.at(-1)?.text,
          JSON.stringify('Posted in the thread. Keep working; your final reply still answers the whole request.'));
        assert.ok(requests.every((request) => request.tools.includes(SLACK_REPLY_IN_THREAD_TOOL_NAME)));

        const presentation = scenario.presentations.get('run_head');
        assert.ok(presentation?.schemaVersion === 3);
        assert.deepEqual(presentation.midRunReplies?.map(({ messageTs, posted }) => ({ messageTs, posted })),
          [{ messageTs: questionTs, posted: true }], 'what the stop note counts as repliesPosted: 1');
      } finally {
        scenario.close();
      }
    });

    await t.test('the question folds with the guidance, and a second reply to it is refused', async () => {
      scenario = openScenario();
      try {
        let questionTs = '';
        onTool = () => {
          elapsedMs += TOOL_BOUNDARY_PULL_INTERVAL_MS;
          if (!questionTs) questionTs = scenario.ask();
        };
        await run([
          work(1),
          replyTo(() => questionTs, 'acme/web.'),
          replyTo(() => questionTs, 'Still acme/web.'),
          answer('Done.'),
        ]);
        assert.equal(scenario.posts.length, 1);
        assert.match(lastToolResult().text, /Not posted: you already replied to that message\./);
        assert.deepEqual(requests.map((request) => request.guided), [false, true, true, true],
          'the model reads the guidance with the question');
      } finally {
        scenario.close();
      }
    });

    await t.test('after stream_answer the reply is refused and nothing posts', async () => {
      scenario = openScenario();
      try {
        let questionTs = '';
        onTool = () => {
          elapsedMs += TOOL_BOUNDARY_PULL_INTERVAL_MS;
          if (!questionTs) questionTs = scenario.ask();
        };
        await run([work(1), streamAnswer(), replyTo(() => questionTs, 'acme/web.'), answer('Done.')]);
        assert.deepEqual(scenario.posts, []);
        assert.equal(lastToolResult().isError, true);
        assert.match(lastToolResult().text, /declared answer-only delivery/);
      } finally {
        scenario.close();
      }
    });

    await t.test('a response that cannot read messages mid-run refuses every reply', async () => {
      scenario = openScenario({ envelopeVersion: 1 });
      try {
        let questionTs = '';
        onTool = () => {
          elapsedMs += TOOL_BOUNDARY_PULL_INTERVAL_MS;
          if (!questionTs) questionTs = scenario.ask();
        };
        await run([work(1), replyTo(() => questionTs, 'acme/web.'), answer('Done.')]);
        assert.deepEqual(scenario.posts, []);
        assert.match(lastToolResult().text, /Not posted: that ts is not a message that arrived while you worked\./);
        assert.deepEqual(requests.map((request) => request.guided), [false, false, false]);
      } finally {
        scenario.close();
      }
    });
  } finally {
    await runtime.stop();
    await stopInstrumentation();
  }
});
