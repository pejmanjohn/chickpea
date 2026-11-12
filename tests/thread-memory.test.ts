/**
 * The Agent's memory rides in a thread's prompts (src/memory/thread-memory.ts):
 * the host's rule for when a prompt carries it, the Agent object's fallback
 * across real Flue turns, then the real Slack Agent's provider request
 * bodies around a memory change. Every memory here is synthetic.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { fauxAssistantMessage, fauxProvider, normalizeContext, type Context } from '@earendil-works/pi-ai';
import { init, instrument, useDelivery, useInstruction, useModel, type AgentProps } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileAgentRunPlan, type AgentRunPlanParts } from '../src/agents/run-plan-resolution.ts';
import { compileRuntimePlanV2, deriveRuntimePlanInstanceId, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { ChickpeaSlack } from '../src/agents/slack-thread.ts';
import { createSlackTurnInput, rememberInProcessTurnInput } from '../src/agents/turn-input.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { preloadAllConnectorDetails } from '../src/connections/catalog/index.ts';
import { agentMemoryPromptBlock } from '../src/memory/runtime.ts';
import { forgetThreadCompaction, threadCompactionInstrumentation } from '../src/memory/thread-compaction.ts';
import {
  PROMPT_MEMORY_BLOCK_BYTES,
  promptMemory,
  useThreadMemoryInstruction,
} from '../src/memory/thread-memory.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';
import type { SlackThreadContinuation } from '../src/slack/turn-job-types.ts';
import { ADVISORY_MEMORY_FINAL_CHECK, REPLACES_EARLIER_MEMORY, promptMemoryText } from '../src/slack/web-client-context.ts';
import { installStubMcpServer, type StubMcpServer } from './helpers/stub-mcp-server.ts';
import { MCP_TOOLS, MCP_URL, withTestRunLane } from './helpers/test-run-lane.ts';

const block = (body: string) => agentMemoryPromptBlock(body)!;
const LARGE = block(Array.from({ length: 40 }, (_, index) => `## Entry ${index}\n${'A synthetic fact. '.repeat(30)}`).join('\n\n'));

const AGENT: CustomAgentConfig = {
  id: 'agent_thread_memory', kind: 'user', revision: 1, name: 'Memory', instructions: 'Answer.', enabled: true,
  model: 'openai/gpt-5.4-mini', skills: [], mcpServers: [], apiConnections: [], repositories: [],
};

function planAt(memoryEpoch: number): RuntimePlanV2 {
  return compileRuntimePlanV2({
    turn: {
      workspaceId: 'T_MEM', channelId: 'C_MEM', eventId: 'E_MEM', text: 'Hi', userId: 'U_MEM',
      messageTs: '1788000000.000200', threadTs: '1788000000.000100', source: 'app_mention', contextMode: 'thread',
    },
    assignment: {
      workspaceId: 'T_MEM', channelId: 'C_MEM', agentId: AGENT.id, agent: AGENT, runtimeContract: 'chickpea-v1',
      ownerIncarnation: 1, model: AGENT.model!, modelAttribution: { source: 'pinned', providerId: 'openai' },
    },
    instructions: AGENT.instructions,
    memoryEpoch,
  });
}

const previousAt = (memoryEpoch: number): SlackThreadContinuation =>
  ({ messageTs: '1788000000.000100', runtimePlan: planAt(memoryEpoch) });

test('a prompt carries the memory on the thread\'s first turn and on the first turn after it changed', () => {
  const memory = block('## Tone\nAnswer in two sentences.');
  assert.deepEqual(promptMemory({ block: memory, memoryEpoch: 1, previous: undefined }), { placement: 'prompt', replacesEarlier: false });
  assert.deepEqual(promptMemory({ block: memory, memoryEpoch: 1, previous: previousAt(1) }), { placement: 'held' });
  assert.deepEqual(promptMemory({ block: memory, memoryEpoch: 2, previous: previousAt(1) }), { placement: 'prompt', replacesEarlier: true });
  assert.deepEqual(promptMemory({ block: memory, memoryEpoch: 2, previous: { messageTs: '1788000000.000100' } }),
    { placement: 'prompt', replacesEarlier: true }, 'an unreadable previous plan counts as a change');
});

test('an emptied memory is cleared once, and an Agent without memory sends nothing', () => {
  assert.deepEqual(promptMemory({ block: undefined, memoryEpoch: 1, previous: undefined }), { placement: 'none' });
  assert.deepEqual(promptMemory({ block: undefined, memoryEpoch: 1, previous: previousAt(1) }), { placement: 'none' });
  assert.deepEqual(promptMemory({ block: undefined, memoryEpoch: 3, previous: previousAt(2) }), { placement: 'cleared' });
});

test('a large memory enters a thread\'s prompt once; its later changes ride in the instructions', () => {
  assert.ok(Buffer.byteLength(LARGE) > PROMPT_MEMORY_BLOCK_BYTES);
  assert.deepEqual(promptMemory({ block: LARGE, memoryEpoch: 1, previous: undefined }), { placement: 'prompt', replacesEarlier: false });
  assert.deepEqual(promptMemory({ block: LARGE, memoryEpoch: 2, previous: previousAt(1) }), { placement: 'instructions' });
  assert.deepEqual(promptMemory({ block: LARGE, memoryEpoch: 2, previous: previousAt(2) }), { placement: 'held' });
});

test('the prompt\'s memory keeps the block\'s wording and its final response check', () => {
  const memory = block('Invoices are due Fridays.');
  assert.equal(promptMemoryText(memory), `${memory}\n\n${ADVISORY_MEMORY_FINAL_CHECK}`);
  assert.equal(promptMemoryText(memory, true), `${REPLACES_EARLIER_MEMORY}\n${memory}\n\n${ADVISORY_MEMORY_FINAL_CHECK}`);
});

let probeBlock: string | undefined;

/** A thread Agent object whose staged memory is `probeBlock`, compacting once its context passes 5,000 tokens. */
function MemoryProbe({ id }: AgentProps) {
  useModel('faux/thread-memory', { compaction: { reserveTokens: 95_000, keepRecentTokens: 50 } });
  const instruction = useThreadMemoryInstruction(id, probeBlock, useDelivery().body);
  if (instruction) useInstruction(instruction);
  return 'Answer the question.';
}

/**
 * One turn: the memory the host stages, whether the host put it in the
 * prompt, the question's padding in characters (about four a token), and
 * the answer's length.
 */
type Turn = { memory: string | undefined; prompt?: 'first' | 'change'; padding?: number; answer?: number };

/**
 * Each turn as one dispatch to one instance: every agent request as the
 * model saw it, and the order of turns and summaries. `evicted`: the
 * object's process is gone between turns, so only persistent state remains.
 */
async function runThread(thread: Turn[], evicted = false): Promise<{ requests: Context[]; order: string[] }> {
  const faux = fauxProvider({ models: [{ id: 'thread-memory', contextWindow: 100_000 }] });
  const requests: Context[] = [];
  const order: string[] = [];
  faux.setResponses(Array.from({ length: thread.length * 3 }, () => (context: Context) => {
    if (JSON.stringify(context.messages[0]).includes('context summarization assistant')) {
      order.push('summary');
      return fauxAssistantMessage('## Goal\nSynthetic summary.');
    }
    order.push(`turn ${requests.length + 1}`);
    requests.push(structuredClone(context));
    return fauxAssistantMessage(`Answer ${requests.length}. ${'a'.repeat(thread[requests.length - 1]?.answer ?? 0)}`);
  }));
  const uninstall = instrument(threadCompactionInstrumentation);
  const flue = await start({ agents: [{ agent: MemoryProbe, name: CHICKPEA_SLACK_AGENT_NAME }], providers: [faux.provider] });
  try {
    const id = `thread-memory-probe-${Date.now()}-${Math.random()}`;
    const handle = init(MemoryProbe, { id });
    for (const [index, turn] of thread.entries()) {
      probeBlock = turn.memory;
      const memory = turn.prompt && turn.memory ? `\n\n${promptMemoryText(turn.memory, turn.prompt === 'change')}` : '';
      const padding = turn.padding ? ` ${'z'.repeat(turn.padding)}` : '';
      await handle.read(await handle.dispatch({ message: `Question ${index + 1}${padding}${memory}` }));
      if (evicted) forgetThreadCompaction(id);
    }
  } finally {
    await flue.stop();
    await uninstall();
  }
  return { requests, order };
}

const systemOf = (context: Context) => JSON.stringify(context.messages.filter(({ role }) => role === 'system'));

for (const evicted of [false, true]) {
  test(`real Flue turns${evicted ? ', the object evicted between turns' : ''}: the instructions carry no memory while the thread holds it, and carry it after a compaction until a prompt does`, async () => {
    const first = block('Invoices are due Fridays.');
    const second = block('Invoices are due Mondays.');
    const thread: Turn[] = [
      // The two padded questions pass the threshold together, and the summary takes both.
      { memory: first, prompt: 'first', padding: 16_000 },
      { memory: first, padding: 8_000, answer: 400 },
      { memory: first },
      { memory: first },
      // A prompt can carry an unchanged block again, as after an unreadable previous plan.
      { memory: first, prompt: 'change' },
      { memory: first },
      { memory: second, prompt: 'change' },
      { memory: second },
    ];
    const { requests, order } = await runThread(thread, evicted);
    assert.equal(requests.length, 8, 'one agent request a turn');
    assert.ok(order.indexOf('summary') > order.indexOf('turn 2') && order.indexOf('summary') < order.indexOf('turn 3'),
      'the second turn compacted the thread');
    assert.equal(order.lastIndexOf('summary') < order.indexOf('turn 3'), true, 'and only then');
    assert.deepEqual(requests.map((context) => systemOf(context).includes('Invoices are due')),
      [false, false, true, true, false, false, false, false],
      'held, held, then the instructions after the compaction, until a prompt carries the block again');
    assert.equal(systemOf(requests[1]!), systemOf(requests[0]!), 'an unchanged turn keeps the system prompt');
    assert.equal(systemOf(requests[3]!), systemOf(requests[2]!), 'the fallback keeps one system prompt across turns');
    assert.equal(systemOf(requests[4]!), systemOf(requests[0]!), 'back to the memory-free system prompt');
    assert.ok(systemOf(requests[2]!).includes(JSON.stringify(promptMemoryText(first)).slice(1, -1)),
      'the instruction is the block and its final response check, as before');
  });
}

test('real Flue turns: a thread whose transcript never read the memory, and a large change, keep it in the instructions', async () => {
  const memory = block('Invoices are due Fridays.');
  const { requests } = await runThread([{ memory }, { memory }, { memory: LARGE }]);
  assert.deepEqual(requests.map((context) => systemOf(context).includes('Invoices are due Fridays.')), [true, true, false],
    'a thread from before this release, or one an older host prompted, reads memory from its instructions');
  assert.ok(systemOf(requests[2]!).includes('## Entry 39'), 'a large change rides in the instructions');
});

let mcp: StubMcpServer;
before(async () => {
  await preloadAllConnectorDetails();
  mcp = installStubMcpServer(MCP_URL, Object.values(MCP_TOOLS));
});
after(() => mcp.restore());

/** The request body the Anthropic Messages API would get for one captured model request. */
async function anthropicBody(context: Context): Promise<{ system: unknown; tools: unknown; messages: unknown[] }> {
  const { stream } = await import('@earendil-works/pi-ai/api/anthropic-messages');
  const model = {
    id: 'claude-opus-5-5', name: 'Claude Opus 5.5', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000,
  } as const;
  let body: unknown;
  // The payload is captured as it would be sent; the request itself never leaves.
  await stream(model as never, normalizeContext(context), {
    apiKey: 'sk-ant-test',
    onPayload: (payload: unknown) => {
      body = payload;
      throw new Error('captured');
    },
  }).result();
  assert.ok(body, 'the request body was built');
  return body as { system: unknown; tools: unknown; messages: unknown[] };
}

/** A body without its cache markers, which move to each request's newest block. */
function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, unmarked(item)]));
}

test('the Slack Agent\'s requests around a memory change keep the system prompt and tools byte for byte, and only append', async () => {
  await withTestRunLane(async (lane) => {
    const parts = await lane.parts();
    const { modelCredential: _credential, ...assignment } = parts.assignment;
    const renderable: AgentRunPlanParts = { ...parts, assignment };
    const turns = [
      { messageTs: '1793440000.000100', memoryEpoch: 1, memory: block('## Orders\nOrders ship on Fridays.'), replacesEarlier: false },
      { messageTs: '1793440000.000300', memoryEpoch: 2, memory: block('## Orders\nOrders ship on Mondays.'), replacesEarlier: true },
    ];
    const plans = turns.map(({ messageTs, memoryEpoch }) => compileAgentRunPlan(renderable, {
      turn: { ...lane.turn, messageTs, eventId: `Ev_${messageTs}` }, instructions: 'Answer questions about orders.', memoryEpoch,
    }));
    const instanceId = deriveRuntimePlanInstanceId(plans[0]!);
    assert.equal(deriveRuntimePlanInstanceId(plans[1]!), instanceId, 'one thread, one instance');

    const faux = fauxProvider({ models: [{ id: 'test-run' }] });
    const seen: Context[] = [];
    faux.setResponses(plans.map(() => (context: Context) => {
      seen.push(structuredClone(context));
      return fauxAssistantMessage('Order 42 ships soon.');
    }));
    const flue = await start({ agents: [{ agent: ChickpeaSlack, name: CHICKPEA_SLACK_AGENT_NAME }], providers: [faux.provider] });
    try {
      const handle = init(ChickpeaSlack, { id: instanceId });
      for (const [index, { messageTs, memory, replacesEarlier }] of turns.entries()) {
        const turnJobId = `turn_memory_${index + 1}`;
        const { turn } = lane;
        rememberInProcessTurnInput(createSlackTurnInput({ turnJobId, instanceId, runtimePlan: plans[index]!, memoryBlock: memory }));
        const question = `Where is order ${42 + index}?`;
        // As assembleSlackPrompt places it: after the Slack context, before the current request.
        const body = [
          'Current Slack thread context (same Slack root as this request):', '', promptMemoryText(memory, replacesEarlier), '',
          `Current Slack request: ${question}`, '',
          serializeCurrentRequestEnvelope(question, true, turn.userId, messageTs, { schemaVersion: 2, progressiveStreamingOffered: false }),
        ].join('\n');
        await handle.read(await handle.dispatch({
          message: {
            kind: 'signal', type: 'slack.message', tagName: 'slack_message', body,
            attributes: {
              workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs, slackUserId: turn.userId,
              eventId: `Ev_${messageTs}`, messageTs, turnJobId, conversationKind: 'im', requesterText: question,
            },
          },
          ...(index === 0 ? { initialData: plans[0] } : {}),
        } as Parameters<typeof handle.dispatch>[0]));
      }
    } finally {
      await flue.stop();
    }
    assert.equal(seen.length, 2);
    const [earlier, later] = await Promise.all(seen.map(anthropicBody));
    assert.equal(JSON.stringify(later!.system), JSON.stringify(earlier!.system), 'the system prompt, byte for byte');
    assert.equal(JSON.stringify(later!.tools), JSON.stringify(earlier!.tools), 'the tools, byte for byte');
    assert.doesNotMatch(JSON.stringify(earlier!.system), /<agent_memory>|Orders ship on/, 'no memory in the system prompt');
    assert.deepEqual(unmarked(later!.messages.slice(0, earlier!.messages.length)), unmarked(earlier!.messages),
      'the earlier turn is a prefix of the later request');
    const appended = later!.messages.slice(earlier!.messages.length);
    assert.equal(appended.length, 2, 'the earlier answer and the new message, with no narration of changed instructions or tools');
    assert.doesNotMatch(JSON.stringify(appended), /System instructions updated|signal type=\\"resources\\"/);
    assert.match(JSON.stringify(appended), /replaces earlier Agent memory blocks[\s\S]*Orders ship on Mondays\./);
    assert.match(JSON.stringify(earlier!.messages), /Orders ship on Fridays\./);
  });
});
