import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { init, useModel, useTool } from '@flue/runtime';
import { agentStreamPath, handleAgentConversationRead } from '@flue/runtime/internal';
import { sqlite, start } from '@flue/runtime/node';
import * as v from 'valibot';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';
import {
  agentObjectRoute,
  createBoundedAgentReplyReader,
  type AgentObjectNamespace,
} from '../src/slack/bounded-agent-observation.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

/**
 * The Agent object's run is cut mid-step and resumes on a new instance, as on
 * Cloudflare on 2026-11-11: the runner's read that was in flight at the cut
 * never answered, and the resumed run settled 15 s later. The runner must
 * deliver the resumed run's answer as soon as it settles, not when the stuck
 * read finally fails minutes later.
 */

const MODEL = 'faux/interrupted-run';
const PERSON = 'U_PERSON';

function InterruptProbe() {
  useModel(MODEL);
  useTool({
    name: 'inspect',
    description: 'Inspect the workspace.',
    input: v.strictObject({ step: v.number() }),
    run: ({ data }) => ({ output: `step ${data.step} inspected` }),
  });
}

function openEnvelope(): { envelope: FlueDispatchEnvelopeV1; close(): void } {
  const conversation = { workspaceId: 'T_CUT', channelId: 'C_CUT', threadTs: '1800000002.000100' };
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_CUT', channelId: 'C_CUT', agentId: 'agent_cut', model: MODEL,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_cut', kind: 'user', revision: 1, name: 'Cut', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => 1_800_000_000_000);
  const turn = {
    ...conversation, eventId: 'Ev_head', text: 'Propose the workspace change.', userId: PERSON,
    messageTs: '1800000002.000200', source: 'implicit_thread_reply' as const, contextMode: 'thread' as const,
    channelType: 'channel' as const, requesterTimezone: 'America/Los_Angeles',
  };
  turns.enqueue({ id: 'head', evtKey: 'evt:head', msgKey: 'msg:head', runId: 'run_head', turn, assignment });
  turns.freezeRuntimePlan('head', compileRuntimePlanV2({ turn, assignment, instructions: 'Help.', memoryEpoch: 1 }));
  turns.prepareFlueDispatch('head', `Propose the workspace change.\n\n${serializeCurrentRequestEnvelope(
    '', false, PERSON, turn.messageTs, { schemaVersion: 2 },
  )}`, { generation: 'gen-interrupted-run' });
  return { envelope: turns.getDispatchEnvelope('head')!, close: () => db.close() };
}

function dispatchState(envelope: FlueDispatchEnvelopeV1): SlackFlueDispatchState {
  return {
    prepare: () => envelope,
    recordReceipt: (receipt) => receipt,
    recordSettlement: (settlement) => settlement,
    reconcileExistingInstance: () => { throw new Error('Unexpected incarnation conflict.'); },
    markRecoveryRequired: (reason) => { throw new Error(`Unexpected recovery: ${reason}`); },
  };
}

/**
 * The thread's Agent object as the runner's stubs reach it. A stub is bound
 * to the instance that was live when it was made. `cutNextRead` replaces the
 * live instance during the next read: that read, and every later one through
 * a stub of the cut instance, never answers.
 */
function agentObjectInstances(serve: (request: Request) => Promise<Response>) {
  let live = 0;
  let stubs = 0;
  let cut: (() => void) | undefined;
  const never = new Promise<Response>(() => {});
  const namespace: AgentObjectNamespace = {
    idFromName: (name) => name,
    get: () => {
      stubs += 1;
      const instance = live;
      return {
        fetch: async (request) => {
          if (instance !== live) return never;
          if (cut) {
            live += 1;
            cut();
            cut = undefined;
            return never;
          }
          return serve(request);
        },
      };
    },
  };
  return {
    namespace,
    stubs: () => stubs,
    cutNextRead: () => new Promise<void>((resolve) => { cut = resolve; }),
  };
}

test('the runner delivers a resumed run\'s answer when its read was cut with the Agent object', { timeout: 30_000 }, async () => {
  const faux = fauxProvider({ models: [{ id: 'interrupted-run' }], tokensPerSecond: 100_000 });
  const persistence = sqlite();
  let stores: Awaited<ReturnType<typeof persistence.connect>> | undefined;
  const runtime = await start({
    agents: [{ agent: InterruptProbe, name: CHICKPEA_SLACK_AGENT_NAME }],
    providers: [faux.provider],
    db: {
      migrate: () => persistence.migrate?.(),
      connect: async () => (stores = await persistence.connect()),
      close: () => persistence.close?.(),
    },
  });
  const { envelope, close } = openEnvelope();
  const agentObject = agentObjectInstances((request) => handleAgentConversationRead({
    store: stores!.conversationStreamStore,
    path: agentStreamPath(CHICKPEA_SLACK_AGENT_NAME, envelope.instanceId),
    request,
  }));
  let answeredAt: number | undefined;
  faux.setResponses([
    async () => {
      await agentObject.cutNextRead();
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'network connection lost' });
    },
    fauxAssistantMessage([fauxText('Checking.'), fauxToolCall('inspect', { step: 1 })], { stopReason: 'toolUse' }),
    () => {
      answeredAt = Date.now();
      return fauxAssistantMessage('Proposed the change.');
    },
  ]);
  const observation = new AbortController();
  try {
    const reply = promptSlackThreadAgent({
      handle: init(InterruptProbe, { id: envelope.instanceId }),
      state: dispatchState(envelope),
      message: 'Propose the workspace change.',
      turnId: 'head',
      conversationKey: envelope.instanceId,
      requestedModel: MODEL,
      observationSignal: observation.signal,
      observeReply: createBoundedAgentReplyReader({
        agentName: CHICKPEA_SLACK_AGENT_NAME,
        resolveRoute: (instanceId) => agentObjectRoute(agentObject.namespace, instanceId),
        stalledReadMs: 500,
      }),
    });
    const pickupWindowMs = 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const missed = new Promise<undefined>((resolve) => {
      const waitForAnswer = () => {
        timer = answeredAt === undefined
          ? setTimeout(waitForAnswer, 50)
          : setTimeout(resolve, pickupWindowMs, undefined);
      };
      waitForAnswer();
    });
    const outcome = await Promise.race([reply, missed]).finally(() => clearTimeout(timer));
    if (!outcome) {
      assert.fail(`the runner missed the resumed run's answer for ${pickupWindowMs} ms after its last step`);
    }
    assert.equal(outcome.text, 'Proposed the change.');
    assert.equal(faux.state.callCount, 3, 'the cut step, then the resumed run\'s two steps');
    assert.ok(agentObject.stubs() > 1, 'the runner reached the resumed instance through a new stub');
  } finally {
    observation.abort();
    close();
    await runtime.stop();
  }
});
