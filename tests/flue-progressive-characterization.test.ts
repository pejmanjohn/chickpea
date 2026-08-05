import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  init,
  useDataWriter,
  useModel,
  useTool,
  type AgentInstanceHandle,
  type AgentReply,
  type ConversationStreamChunk,
  type DispatchReceipt,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

const MODEL = 'faux/characterization';

function ProgressiveProbe() {
  useModel(MODEL);
  return 'Return the scripted synthetic response.';
}

function ToolProbe() {
  useModel(MODEL);
  useTool({
    name: 'lookup',
    description: 'Return one synthetic lookup result.',
    input: v.object({ query: v.string() }),
    output: v.string(),
    run: ({ data }) => ({ output: `synthetic:${data.query}` }),
  });
  return 'Use the scripted tool response.';
}

function StructuredProbe() {
  useModel(MODEL);
  const writeResult = useDataWriter('result', {
    schema: v.object({ answer: v.string() }),
  });
  useTool({
    name: 'submit_result',
    description: 'Submit one synthetic structured result.',
    input: v.object({ answer: v.string() }),
    output: v.string(),
    run: ({ data }) => {
      writeResult(data);
      return { output: 'recorded', terminate: true };
    },
  });
  return 'Submit the scripted structured result.';
}

interface TimedChunk {
  chunk: ConversationStreamChunk;
  atMs: number;
}

async function capture(
  handle: AgentInstanceHandle,
  receipt: DispatchReceipt,
): Promise<{ reply: AgentReply; events: TimedChunk[] }> {
  const startedAt = performance.now();
  const events: TimedChunk[] = [];
  const reply = await handle.read(receipt, {
    onEvent(chunk) {
      events.push({ chunk, atMs: performance.now() - startedAt });
    },
  });
  return { reply, events };
}

function messageIdsFor(events: readonly TimedChunk[], submissionId: string): string[] {
  return [
    ...new Set(events.flatMap(({ chunk }) =>
      chunk.type === 'message-started' && chunk.submissionId === submissionId
        ? [chunk.messageId]
        : []
    )),
  ];
}

function textEventsFor(
  events: readonly TimedChunk[],
  messageId: string,
): Array<TimedChunk & { chunk: Extract<ConversationStreamChunk, { type: 'message-delta' }> }> {
  return events.flatMap((event) =>
    event.chunk.type === 'message-delta' &&
      event.chunk.messageId === messageId &&
      event.chunk.kind === 'text'
      ? [event as TimedChunk & {
          chunk: Extract<ConversationStreamChunk, { type: 'message-delta' }>;
        }]
      : []
  );
}

function eventIdentity(events: readonly TimedChunk[]): unknown[] {
  return events.map(({ chunk }) => chunk);
}

test(
  'Flue 2 receipt-scoped chunks expose a safe progressive subset and explicit terminal-only cases',
  { timeout: 30_000 },
  async () => {
    const faux = fauxProvider({
      models: [{ id: 'characterization', reasoning: true }],
      tokensPerSecond: 12,
      tokenSize: { min: 2, max: 2 },
    });
    const flue = await start({
      agents: [
        { agent: ProgressiveProbe, name: 'progressive-characterization' },
        { agent: ToolProbe, name: 'tool-characterization' },
        { agent: StructuredProbe, name: 'structured-characterization' },
      ],
      providers: [faux.provider],
    });

    try {
      const progressiveText = [
        'A synthetic delayed answer arrives in durable pieces.',
        '',
        '```ts',
        'const safe = true;',
        'console.log(safe);',
        '```',
        '',
        'The final sentence remains part of the same answer.',
      ].join('\n');
      faux.setResponses([fauxAssistantMessage(progressiveText)]);
      const progressive = init(ProgressiveProbe, { id: 'progressive-prefix' });
      const progressiveReceipt = await progressive.dispatch('produce synthetic text');
      const firstRead = await capture(progressive, progressiveReceipt);
      const messageIds = messageIdsFor(firstRead.events, progressiveReceipt.submissionId);
      assert.deepEqual(messageIds.length, 1);
      const textEvents = textEventsFor(firstRead.events, messageIds[0]!);
      assert.ok(textEvents.length > 1);
      assert.ok(new Set(textEvents.map(({ chunk }) => chunk.position.batch)).size > 1);

      let accumulated = '';
      for (const { chunk } of textEvents) {
        accumulated += chunk.delta;
        assert.ok(firstRead.reply.text.startsWith(accumulated));
      }
      assert.equal(accumulated, firstRead.reply.text);
      assert.equal(firstRead.reply.text, progressiveText);
      const completed = firstRead.events.find(({ chunk }) =>
        chunk.type === 'message-completed' && chunk.messageId === messageIds[0]
      );
      assert.ok(completed);
      assert.ok(
        completed.atMs - textEvents[0]!.atMs >= 500,
        'the first safe source chunk must leave a meaningful pre-completion relay window',
      );

      const providerCallsAfterFirstRead = faux.state.callCount;
      const replay = await capture(progressive, progressiveReceipt);
      assert.equal(replay.reply.text, firstRead.reply.text);
      assert.deepEqual(eventIdentity(replay.events), eventIdentity(firstRead.events));
      assert.equal(faux.state.callCount, providerCallsAfterFirstRead);

      faux.setResponses([
        fauxAssistantMessage('first sequential answer'),
        fauxAssistantMessage('second sequential answer'),
      ]);
      const sequential = init(ProgressiveProbe, { id: 'sequential-continuity' });
      const sequentialOne = await sequential.dispatch('first root');
      const sequentialOneRead = await capture(sequential, sequentialOne);
      const sequentialTwo = await sequential.dispatch('second root');
      const sequentialTwoRead = await capture(sequential, sequentialTwo);
      assert.equal(
        messageIdsFor(sequentialOneRead.events, sequentialOne.submissionId).length,
        1,
      );
      assert.equal(
        messageIdsFor(sequentialTwoRead.events, sequentialTwo.submissionId).length,
        1,
      );
      assert.equal(sequentialOneRead.reply.text, 'first sequential answer');
      assert.equal(sequentialTwoRead.reply.text, 'second sequential answer');

      faux.setResponses([
        fauxAssistantMessage(
          'A concurrent synthetic answer stays active long enough for the second root to join.',
        ),
      ]);
      const concurrent = init(ProgressiveProbe, { id: 'concurrent-continuity' });
      const hostReceipt = await concurrent.dispatch('host root');
      const joinedReceipt = await concurrent.dispatch('joined root');
      const [hostRead, joinedRead] = await Promise.all([
        capture(concurrent, hostReceipt),
        capture(concurrent, joinedReceipt),
      ]);
      assert.equal(hostRead.reply.text, joinedRead.reply.text);
      assert.equal(messageIdsFor(joinedRead.events, joinedReceipt.submissionId).length, 0);
      assert.equal(messageIdsFor(joinedRead.events, hostReceipt.submissionId).length, 1);
      const joinedSettlement = joinedRead.events.find(({ chunk }) =>
        chunk.type === 'submission-settled' &&
        chunk.submissionId === joinedReceipt.submissionId
      )?.chunk;
      assert.ok(joinedSettlement?.type === 'submission-settled');
      assert.equal(joinedSettlement.answeredBySubmissionId, hostReceipt.submissionId);

      faux.setResponses([
        fauxAssistantMessage([
          fauxThinking('synthetic private reasoning'),
          fauxText('public synthetic answer'),
        ]),
      ]);
      const reasoning = init(ProgressiveProbe, { id: 'reasoning-separation' });
      const reasoningReceipt = await reasoning.dispatch('separate reasoning');
      const reasoningRead = await capture(reasoning, reasoningReceipt);
      const reasoningMessageId = messageIdsFor(
        reasoningRead.events,
        reasoningReceipt.submissionId,
      )[0]!;
      assert.ok(reasoningRead.events.some(({ chunk }) =>
        chunk.type === 'message-delta' && chunk.kind === 'reasoning'
      ));
      assert.equal(
        textEventsFor(reasoningRead.events, reasoningMessageId)
          .map(({ chunk }) => chunk.delta)
          .join(''),
        reasoningRead.reply.text,
      );
      assert.doesNotMatch(reasoningRead.reply.text, /private reasoning/);

      faux.setResponses([
        fauxAssistantMessage(
          [fauxText('Synthetic pre-tool text. '), fauxToolCall('lookup', { query: 'account' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Synthetic final answer.'),
      ]);
      const tool = init(ToolProbe, { id: 'tool-pretext' });
      const toolReceipt = await tool.dispatch('use the synthetic tool');
      const toolRead = await capture(tool, toolReceipt);
      const toolMessageId = messageIdsFor(toolRead.events, toolReceipt.submissionId)[0]!;
      const rawToolText = textEventsFor(toolRead.events, toolMessageId)
        .map(({ chunk }) => chunk.delta)
        .join('');
      assert.ok(toolRead.events.some(({ chunk }) => chunk.type === 'tool-input'));
      assert.ok(toolRead.events.some(({ chunk }) => chunk.type === 'tool-output'));
      assert.notEqual(rawToolText, toolRead.reply.text);
      assert.equal(
        toolRead.reply.text,
        'Synthetic pre-tool text. \n\nSynthetic final answer.',
      );

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('submit_result', { answer: '42' })], {
          stopReason: 'toolUse',
        }),
      ]);
      const structured = init(StructuredProbe, { id: 'structured-only' });
      const structuredReceipt = await structured.dispatch('submit synthetic structure');
      const structuredRead = await capture(structured, structuredReceipt);
      assert.equal(structuredRead.reply.text, '');
      assert.deepEqual(structuredRead.reply.data, { result: [{ answer: '42' }] });
      assert.ok(structuredRead.events.some(({ chunk }) => chunk.type === 'data-part'));
      assert.equal(
        structuredRead.events.filter(({ chunk }) =>
          chunk.type === 'message-delta' && chunk.kind === 'text'
        ).length,
        0,
      );

      assert.ok(firstRead.events.some(({ chunk }) => chunk.type === 'conversation-reset'));
      assert.ok(firstRead.events.every(({ chunk }) =>
        Number.isInteger(chunk.position.batch) && Number.isInteger(chunk.position.index)
      ));
    } finally {
      await flue.stop();
    }
  },
);
