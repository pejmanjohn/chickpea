import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import {
  bash, init, instrument, useAgentFinish, useModel, useSandbox, useTool,
  type ConversationStreamChunk, type FlueEventContext, type FlueObservation,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { Bash, InMemoryFs } from 'just-bash';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  assertArtifactDeliveryAllowed, bindCurrentRequestConversation, memoryToolPolicyInterceptor, observeMemoryToolPolicy,
  serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';
import { createWorkspaceArtifactTool, type ArtifactDestinationBinding } from '../src/sandbox/artifact-tool.ts';
import {
  parseSlackArtifactReceipts, SLACK_ARTIFACT_RECEIPTS_DATA_NAME, useSlackArtifactReceipts,
} from '../src/slack/artifact-receipts.ts';
import {
  COMPLETE_FILE_DELIVERY_TOOL, useFileDeliveryCompletion, type FileDeliveryState,
} from '../src/slack/file-delivery-completion.ts';
import { createSlackStreamAnswerTool, SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';
import {
  bindFileDeliveryCheck, observePresentationToolPolicy, presentationToolPolicyInterceptor,
} from '../src/slack/presentation-tool-policy.ts';

const CONVERSATION = { workspaceId: 'TSTREAM', channelId: 'CSTREAM', threadTs: '1789230000.000100' };
const ACTOR = 'USTREAM';
const MESSAGE_TS = '1789230000.000200';
const AGENT: CustomAgentConfig = {
  id: 'file-streaming-probe', kind: 'user', revision: 1, name: 'File streaming probe',
  instructions: 'Finish the requested task.', enabled: true, model: 'faux/file-streaming',
  skills: [], mcpServers: [], apiConnections: [], repositories: [],
};
const PLAN = compileRuntimePlanV2({
  turn: { ...CONVERSATION, eventId: 'ESTREAM', text: 'Prepare the answer.',
    userId: ACTOR, messageTs: MESSAGE_TS, source: 'app_mention', contextMode: 'thread' },
  assignment: { ...CONVERSATION, agentId: AGENT.id, agent: AGENT, model: AGENT.model!,
    modelAttribution: { source: 'workspace_default', providerId: 'faux', workspaceDefaultRevision: 1 } },
  instructions: AGENT.instructions, memoryEpoch: 1, effectiveConnections: [],
});
const call = (name: string, args: Record<string, unknown> = {}) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

test('file reconciliation preserves the distinction between scratch work and an upload attempt', { timeout: 30_000 }, async (t) => {
  const faux = fauxProvider({ models: [{ id: 'file-streaming' }], tokensPerSecond: 100_000 });
  let stages = 0;
  let streamRuns = 0;
  let connectedMutationRuns = 0;
  let finalState: FileDeliveryState | undefined;
  let repairRequest: { event: FlueObservation; context: FlueEventContext } | undefined;
  function Probe() {
    useModel(AGENT.model!);
    bindCurrentRequestConversation(CONVERSATION);
    const { accumulator, writeReceipts } = useSlackArtifactReceipts();
    const completion = useFileDeliveryCompletion(PLAN, (ids) => {
      writeReceipts({ schemaVersion: 1, receipts: accumulator.remove(ids) });
    });
    useAgentFinish(() => { finalState = completion.state(); });
    const binding: ArtifactDestinationBinding = {
      channel: CONVERSATION.channelId, threadTs: CONVERSATION.threadTs, sandboxKind: 'bash',
      async stageArtifact(artifact) {
        stages++;
        const fileId = `FSTREAM${String(stages).padStart(4, '0')}`;
        writeReceipts({ schemaVersion: 1, receipts: accumulator.add({
          schemaVersion: 2, fileId, filename: artifact.filename, byteLength: artifact.bytes.byteLength,
          kind: artifact.kind, stagedAt: 1, completedAt: 2,
          permalink: `https://example.slack.com/files/${ACTOR}/${fileId}/${artifact.filename}`,
          destination: { ...CONVERSATION, agentId: AGENT.id },
        }) });
        return { attached: true, byteLength: artifact.bytes.byteLength, fileId };
      },
    };
    useSandbox(completion.wrapSandbox(bash(() => new Bash({ fs: new InMemoryFs() }))));
    useTool(createWorkspaceArtifactTool(binding, completion.deliver));
    useTool(completion.tool(binding));
    const stream = createSlackStreamAnswerTool();
    useTool({ ...stream, run() { streamRuns++; return stream.run(); } });
    useTool({ name: 'connected_mutation', description: 'Perform a synthetic connected-service mutation.',
      run() { connectedMutationRuns++; return { output: 'Synthetic mutation completed.' }; } });
  }
  const dispose = instrument({
    interceptor: (operation, context, next) => memoryToolPolicyInterceptor(operation, context,
      () => presentationToolPolicyInterceptor(operation, context, next)),
    observe(event, context) {
      observeMemoryToolPolicy(event, context);
      observePresentationToolPolicy(event, context);
      if (event.type === 'turn_request' && event.purpose === 'agent' &&
          event.request.input.messages.some((message) => message.role === 'user' &&
            JSON.stringify(message.content).includes('slack_file_delivery_check'))) {
        repairRequest = { event, context };
      }
    },
    dispose() {},
  });
  const runtime = await start({ agents: [{ agent: Probe, name: CHICKPEA_SLACK_AGENT_NAME }], providers: [faux.provider] });
  let sequence = 0;
  async function run(responses: Parameters<typeof faux.setResponses>[0]) {
    stages = 0;
    streamRuns = 0;
    connectedMutationRuns = 0;
    finalState = undefined;
    repairRequest = undefined;
    faux.setResponses(responses);
    const before = faux.state.callCount;
    const handle = init(Probe, { id: `file-streaming-${++sequence}` });
    const receipt = await handle.dispatch({ message: {
      kind: 'signal', type: 'slack.message', tagName: 'slack_message',
      body: `Prepare the answer.\n\n${serializeCurrentRequestEnvelope('', false, ACTOR, MESSAGE_TS, { progressiveStreamingOffered: true })}`,
      attributes: { ...CONVERSATION, slackUserId: ACTOR, messageTs: MESSAGE_TS },
    } });
    const events: ConversationStreamChunk[] = [];
    const reply = await handle.read(receipt, { onEvent: (chunk) => { events.push(chunk); } });
    return { handle, receipt, reply, events, calls: faux.state.callCount - before };
  }
  function streamErrors(events: ConversationStreamChunk[]) {
    const calls = new Set(events.flatMap((event) => event.type === 'tool-input' && event.toolName === SLACK_STREAM_ANSWER_TOOL_NAME
      ? [event.toolCallId] : []));
    return events.filter((event) => event.type === 'tool-output-error' && calls.has(event.toolCallId));
  }
  try {
    await t.test('bash scratch followed by an empty completion can still declare a streamed answer', async () => {
      const { reply, events, calls } = await run([
        call('bash', { command: "printf 'temporary calculation' > scratch.txt" }),
        call(COMPLETE_FILE_DELIVERY_TOOL, { files: [] }),
        call(SLACK_STREAM_ANSWER_TOOL_NAME), fauxAssistantMessage('Here is the complete answer.'),
      ]);
      assert.equal(calls, 4);
      assert.equal(stages, 0);
      assert.equal(streamRuns, 1);
      assert.equal(streamErrors(events).length, 0);
      assert.equal(reply.text, 'Here is the complete answer.');
      assert.equal(finalState?.stagingAttempted, false);
      assert.equal(parseSlackArtifactReceipts(reply.data?.[SLACK_ARTIFACT_RECEIPTS_DATA_NAME]).length, 0);
    });

    await t.test('a prepared upload survives repair and keeps streaming forbidden on read replay', async () => {
      const { reply, events, calls, handle, receipt } = await run([
        call('write', { path: 'summary.csv', content: 'check,status\ninstall,passed\n' }),
        call('post_artifact', { path: 'summary.csv', filename: 'summary.csv' }),
        call('bash', { command: "printf 'temporary calculation' > scratch.txt" }),
        fauxAssistantMessage('The summary is ready.'),
        call('connected_mutation'),
        call(COMPLETE_FILE_DELIVERY_TOOL, { files: [] }),
        call(SLACK_STREAM_ANSWER_TOOL_NAME), fauxAssistantMessage('Attached the completed summary.'),
      ]);
      assert.equal(calls, 8);
      assert.equal(stages, 1);
      assert.equal(streamRuns, 0);
      assert.equal(connectedMutationRuns, 0);
      const mutation = events.find((event) => event.type === 'tool-input' && event.toolName === 'connected_mutation');
      assert.ok(mutation?.type === 'tool-input');
      assert.ok(events.some((event) => event.type === 'tool-output-error' && event.toolCallId === mutation.toolCallId));
      assert.equal(streamErrors(events).length, 1);
      assert.equal(finalState?.stagingAttempted, true);
      assert.equal(finalState?.repairRequested, true);
      assert.deepEqual(parseSlackArtifactReceipts(reply.data?.[SLACK_ARTIFACT_RECEIPTS_DATA_NAME])
        .map((file) => file.filename), ['summary.csv']);
      const callsAfter = faux.state.callCount;
      const replayEvents: ConversationStreamChunk[] = [];
      assert.deepEqual(await handle.read(receipt, { onEvent: (chunk) => { replayEvents.push(chunk); } }), reply);
      assert.deepEqual(replayEvents, events);
      assert.equal(streamErrors(replayEvents).length, 1);
      assert.equal(faux.state.callCount, callsAfter);
      assert.equal(stages, 1);

      // A resumed attempt has a fresh policy cell. Its newest user signal is
      // the correction, so old upload calls need not remain in that slice.
      // Rebind the persisted completion fact before consulting that history.
      assert.ok(repairRequest);
      const restored = finalState;
      assert.ok(restored);
      const context = { agentName: CHICKPEA_SLACK_AGENT_NAME };
      const operation = { type: 'agent', operationId: 'restored-response', operationKind: 'prompt' } as const;
      await memoryToolPolicyInterceptor(operation, context, () => presentationToolPolicyInterceptor(operation, context, async () => {
        bindCurrentRequestConversation(CONVERSATION);
        bindFileDeliveryCheck(() => false, () => restored.stagingAttempted);
        observeMemoryToolPolicy(repairRequest!.event, repairRequest!.context);
        assertArtifactDeliveryAllowed();
        observePresentationToolPolicy(repairRequest!.event, repairRequest!.context);
        await assert.rejects(() => presentationToolPolicyInterceptor({
          type: 'tool', toolName: SLACK_STREAM_ANSWER_TOOL_NAME, toolCallId: 'restored-stream',
        }, context, async () => { throw new Error('A restored upload must never reach the stream tool.'); }),
        { name: 'SlackPresentationToolUnavailableError' });
      }));
    });
  } finally {
    await runtime.stop();
    await dispose();
  }
});
