import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { init, useModel, useTool, type ConversationStreamChunk } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

/**
 * A retried provider error through the real Flue: every step after the error
 * starts with a conversation reset instead of `message-started`, and Slack
 * still gets only the final step, not the narration before it.
 */

const MODEL = 'faux/retried-step';
const PERSON = 'U_PERSON';

function RetryProbe() {
  useModel(MODEL);
  useTool({
    name: 'work',
    description: 'Do one step of the work.',
    input: v.strictObject({ step: v.number() }),
    run: ({ data }) => ({ output: `step ${data.step} done` }),
  });
}

function openEnvelope(): { envelope: FlueDispatchEnvelopeV1; close(): void } {
  const conversation = { workspaceId: 'T_RETRY', channelId: 'C_RETRY', threadTs: '1800000001.000100' };
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_RETRY', channelId: 'C_RETRY', agentId: 'agent_retry', model: MODEL,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_retry', kind: 'user', revision: 1, name: 'Retry', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  const db = openStateDb(':memory:');
  const turns = new TurnJobStoreLogic(db, () => 1_800_000_000_000);
  const turn = {
    ...conversation, eventId: 'Ev_head', text: 'Draft the launch note.', userId: PERSON,
    messageTs: '1800000001.000200', source: 'implicit_thread_reply' as const, contextMode: 'thread' as const,
    channelType: 'channel' as const, requesterTimezone: 'America/Los_Angeles',
  };
  turns.enqueue({ id: 'head', evtKey: 'evt:head', msgKey: 'msg:head', runId: 'run_head', turn, assignment });
  turns.freezeRuntimePlan('head', compileRuntimePlanV2({ turn, assignment, instructions: 'Help.', memoryEpoch: 1 }));
  turns.prepareFlueDispatch('head', `Draft the launch note.\n\n${serializeCurrentRequestEnvelope(
    '', false, PERSON, turn.messageTs, { schemaVersion: 2 },
  )}`, { generation: 'gen-retried-step' });
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

const work = (step: number) =>
  fauxAssistantMessage([fauxText(`Working on step ${step}.`), fauxToolCall('work', { step })], { stopReason: 'toolUse' });
const providerError = () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 service unavailable' });

test('a retried provider error mid-response still delivers only the final step', { timeout: 30_000 }, async () => {
  const faux = fauxProvider({ models: [{ id: 'retried-step' }], tokensPerSecond: 100_000 });
  const runtime = await start({
    agents: [{ agent: RetryProbe, name: CHICKPEA_SLACK_AGENT_NAME }],
    providers: [faux.provider],
  });
  const { envelope, close } = openEnvelope();
  const recoveries: unknown[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => {
    if (args[0] === '[chickpea] interrupted answer recovered') recoveries.push(args[1]);
    else info(...args);
  };
  try {
    const responses: FauxResponseStep[] = [work(1), providerError(), work(2), fauxAssistantMessage('Done.')];
    faux.setResponses(responses);
    const chunks: ConversationStreamChunk[] = [];
    const result = await promptSlackThreadAgent({
      handle: init(RetryProbe, { id: envelope.instanceId }), state: dispatchState(envelope),
      message: 'Draft the launch note.', turnId: 'head', conversationKey: envelope.instanceId,
      requestedModel: MODEL, onConversationChunk: (chunk) => { chunks.push(chunk); },
    });

    assert.equal(faux.state.callCount, 4, 'the failed call was retried once');
    const resets = chunks.filter((chunk) => chunk.type === 'conversation-reset').length;
    assert.ok(resets > 1, 'Flue replaced a later step start with a conversation reset');
    assert.equal(result.text, 'Done.');
    assert.deepEqual(recoveries, [], 'no interrupted answer was recovered');
  } finally {
    console.info = info;
    close();
    await runtime.stop();
  }
});
