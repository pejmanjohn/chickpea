import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { init, instrument, useModel, type ConversationStreamChunk } from '@flue/runtime';
import { agentStreamPath, handleAgentConversationRead } from '@flue/runtime/internal';
import { sqlite, start } from '@flue/runtime/node';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';
import { createBoundedAgentReplyReader } from '../src/slack/bounded-agent-observation.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import {
  observeSlackAnswerStep, slackToolBoundaryFoldInterceptor, useSlackFollowUpFold, type LateFoldRequest,
} from '../src/slack/follow-up-fold.ts';
import { HostReleaseRelay } from '../src/slack/host-release-relay.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

/**
 * The finish check's gate after an interrupted answer, through the real Flue:
 * the Agent object streams an answer past the host release hold, its run is
 * cut mid-step, and a new instance resumes it as Flue's continuation of the
 * durable partial. A message sent during the continuation must wait for its
 * own turn, as during any released answer, even when the continuation alone
 * is under the hold. Folding it would make the model write a new final step,
 * and the relay would delete the answer Slack already shows.
 */

const MODEL = 'faux/interrupted-answer';
const PERSON = 'U_PERSON';
const GENERATION = 'gen-interrupted-answer';
const HOLD_CHARS = 400;
const PARTIAL = 'The launch note covers the new pricing tiers, the onboarding changes and the support hours. '.repeat(40).trim();
const CONTINUATION = ' Support hours stay the same.';
const LATE = 'Also mention the pricing change.';
const CUT_AFTER_CHARS = HOLD_CHARS + 50;

function openScenario() {
  const conversation = { workspaceId: 'T_CUT', channelId: 'C_CUT', threadTs: '1800000003.000100' };
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_CUT', channelId: 'C_CUT', agentId: 'agent_cut', model: MODEL,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_cut', kind: 'user', revision: 1, name: 'Cut', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  const clock = { now: 1_800_000_000_000 };
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => clock.now);
  let sequence = 200;
  const enqueue = (id: string, text: string) => {
    const messageTs = `1800000003.000${sequence++}`;
    turns.enqueue({
      id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, runId: `run_${id}`, assignment,
      turn: {
        ...conversation, eventId: `Ev_${messageTs}`, text, userId: PERSON, messageTs,
        source: 'implicit_thread_reply', contextMode: 'thread', channelType: 'channel',
        requesterTimezone: 'America/Los_Angeles',
      },
    });
    clock.now += 1;
  };
  enqueue('head', 'Draft the launch note.');
  const head = turns.runnerView('head').job!;
  turns.freezeRuntimePlan('head', compileRuntimePlanV2({ turn: head.turn, assignment, instructions: 'Help.', memoryEpoch: 1 }));
  turns.prepareFlueDispatch('head', `Draft the launch note.\n\n${serializeCurrentRequestEnvelope(
    '', false, PERSON, head.turn.messageTs, { schemaVersion: 2, progressiveStreamingOffered: true },
  )}`, { generation: GENERATION });
  const calls: LateFoldRequest[] = [];
  return {
    turns,
    calls,
    envelope: turns.getDispatchEnvelope('head')!,
    arrive: enqueue,
    fold(request: LateFoldRequest) {
      calls.push(request);
      return Promise.resolve(turns.fold(request));
    },
    close: () => db.close(),
  };
}

let scenario: ReturnType<typeof openScenario>;

function AnswerProbe({ id }: { id: string }) {
  useModel(MODEL);
  useSlackFollowUpFold({
    instanceId: id, blocked: () => false, fold: (request) => scenario.fold(request),
    answerRelease: async () => ({ holdChars: HOLD_CHARS }),
  });
}

function dispatchState(turns: TurnJobStoreLogic, envelope: ReturnType<TurnJobStoreLogic['getDispatchEnvelope']>) {
  const state: SlackFlueDispatchState = {
    prepare: () => envelope!,
    recordReceipt: (receipt) => turns.recordFlueReceipt('head', receipt),
    recordSettlement: (settlement) => turns.recordFlueSettlement('head', settlement),
    reconcileExistingInstance: () => { throw new Error('Unexpected incarnation conflict.'); },
    markRecoveryRequired: (reason) => { throw new Error(`Unexpected recovery: ${reason}`); },
  };
  return state;
}

test('a message sent while a resumed answer finishes waits, when the answer streamed past the hold before the cut', { timeout: 60_000 }, async (t) => {
  scenario = openScenario();
  const persistence = sqlite();
  let stores: Awaited<ReturnType<typeof persistence.connect>> | undefined;
  const db = {
    migrate: () => persistence.migrate?.(),
    connect: async () => (stores = await persistence.connect()),
    // The database outlives the cut instance, as an Agent object's storage does.
    close: () => {},
  };
  let streamed = 0;
  let cut: () => void = () => {};
  const cutPoint = new Promise<void>((resolve) => { cut = resolve; });
  const stopInstrumentation = instrument({
    interceptor: slackToolBoundaryFoldInterceptor,
    observe(event) {
      observeSlackAnswerStep(event);
      if (event.type === 'text_delta') {
        streamed += event.text.length;
        if (streamed >= CUT_AFTER_CHARS) cut();
      }
    },
    dispose() {},
  });
  const faux = fauxProvider({ models: [{ id: 'interrupted-answer' }], tokensPerSecond: 200 });
  faux.setResponses([
    fauxAssistantMessage(PARTIAL),
    () => {
      scenario.arrive('late', LATE);
      return fauxAssistantMessage(CONTINUATION);
    },
    fauxAssistantMessage('A launch note that mentions the pricing change.'),
  ]);
  const { envelope } = scenario;
  const state = dispatchState(scenario.turns, envelope);
  const observeReply = createBoundedAgentReplyReader({
    agentName: CHICKPEA_SLACK_AGENT_NAME,
    resolveRoute: () => (request) => handleAgentConversationRead({
      store: stores!.conversationStreamStore,
      path: agentStreamPath(CHICKPEA_SLACK_AGENT_NAME, envelope!.instanceId),
      request,
    }),
    pollIntervalMs: 20,
  });
  const prompt = (signal: AbortSignal, onConversationChunk?: (chunk: ConversationStreamChunk, submissionId: string) => void) =>
    promptSlackThreadAgent({
      handle: init(AnswerProbe, { id: envelope!.instanceId }),
      state,
      message: 'Draft the launch note.',
      turnId: 'head',
      conversationKey: envelope!.instanceId,
      requestedModel: MODEL,
      observationSignal: signal,
      observeReply,
      ...(onConversationChunk ? { onConversationChunk } : {}),
    });
  try {
    const cutInstance = await start({ agents: [{ agent: AnswerProbe, name: CHICKPEA_SLACK_AGENT_NAME }], providers: [faux.provider], db });
    const firstObservation = new AbortController();
    const first = prompt(firstObservation.signal).catch(() => undefined);
    await cutPoint;
    firstObservation.abort();
    await first;
    await cutInstance.stop();
    assert.equal(faux.state.callCount, 1, 'the run was cut during its first step');
    // The new instance starts once the cut one's claim on the run has lapsed (Flue's 30 s lease).
    const realNow = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => realNow() + 31_000);

    const effects: string[] = [];
    let relay: HostReleaseRelay | undefined;
    const resumed = await start({ agents: [{ agent: AnswerProbe, name: CHICKPEA_SLACK_AGENT_NAME }], providers: [faux.provider], db });
    try {
      const result = await prompt(new AbortController().signal, (chunk, submissionId) => {
        relay ??= new HostReleaseRelay({
          submissionId, holdChars: HOLD_CHARS, initial: { status: 'unresolved' },
          modelIntent: {
            initial: { status: 'unresolved' },
            transition: async (intent) => { effects.push(`intent:${intent.kind}`); },
          },
          append: async () => { effects.push('append'); },
          invalidate: async (reason) => { effects.push(`invalidate:${reason}`); },
          retire: async (late) => { effects.push(`retire:${late}`); },
        });
        relay.onEvent(chunk);
      });
      await relay?.closeAndDrain();
      assert.ok(effects.includes('intent:requested'), `the host released the answer before the cut: ${effects.join(', ')}`);
      assert.equal(faux.state.callCount, 2, 'the cut step, then its continuation');
      assert.ok(result.text.endsWith(CONTINUATION.trim()), result.text);
      assert.deepEqual(scenario.calls, [], 'no would-stop call takes the message');
      assert.equal(scenario.turns.runnerView('late').job!.fold, undefined, 'it waits for its own turn');
      assert.deepEqual(effects.filter((effect) => effect.startsWith('retire')), [], 'the released answer stays in Slack');
    } finally {
      await resumed.stop();
    }
  } finally {
    await stopInstrumentation();
    persistence.close?.();
    scenario.close();
  }
});
