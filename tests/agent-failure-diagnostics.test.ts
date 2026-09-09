import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FlueObservation } from '@flue/runtime';
import { agentFailureDiagnosticsInterceptor, observeAgentResultDiagnostics, settlementFailureFacts } from '../src/slack/agent-failure-diagnostics.ts';
import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { opaqueId } from '../src/work/admission.ts';

const operation = { type: 'agent', operationId: 'private-submission', operationKind: 'prompt' } as const;
const context = { agentName: CHICKPEA_SLACK_AGENT_NAME, submissionId: 'private-submission' };

test('durable failure facts retain serialized cause kinds without private error content', () => {
  const cause = { type: 'tool_input_validation', message: 'private SQL and credentials',
    meta: { input: 'private' }, cause: { name: 'Error', message: 'terminated' } };
  const error = new Error('private run', { cause });
  assert.deepEqual(settlementFailureFacts(error), [
    { kind: 'Error' }, { kind: 'tool_input_validation' },
    { kind: 'Error', providerFailureKind: 'stream_terminated' },
  ]);
  assert.deepEqual(settlementFailureFacts({ type: 'private', message: 'private' }), [{ kind: 'unknown' }]);
  assert.deepEqual(settlementFailureFacts({ type: 'operation_failed', meta: {
    reason: 'server_error: private provider response',
  } }), [{ kind: 'operation_failed', providerFailureKind: 'provider_stream_error', providerErrorCode: 'server_error' }]);
  const cyclic = { type: 'internal_error', cause: undefined as unknown };
  cyclic.cause = cyclic;
  assert.equal(settlementFailureFacts(cyclic).length, 1);
  assert.deepEqual(settlementFailureFacts(new Error('Slack terminal delivery requires reconciliation.')), [
    { kind: 'Error', presentationFailureKind: 'terminal_reconciliation' },
  ]);
});

type ModelTurn = Extract<FlueObservation, { type: 'turn' }>;
function terminalEvent(overrides: Partial<ModelTurn> = {}): ModelTurn {
  return {
    type: 'turn', purpose: 'agent', isError: false,
    submissionId: 'private-submission', turnId: 'private-turn', durationMs: 1,
    v: 3, eventIndex: 1, timestamp: '2026-09-03T18:00:00Z',
    request: { providerId: 'cloudflare', providerName: 'private-provider',
      requestedModel: 'private-model', api: 'private-api' },
    response: {
      finishReason: 'length', providerFinishReason: 'length',
      output: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] },
      usage: { input: 200, output: 256, totalTokens: 456, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
    },
    ...overrides,
  };
}

test('empty model completion diagnostics retain finish and token facts but no content', (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  observeAgentResultDiagnostics(terminalEvent(), context);
  assert.deepEqual(logs, [[
    '[chickpea] agent model returned no text:', {
      submissionRef: opaqueId('fluesubmission', 'private-submission'),
      finishReason: 'length', providerFinishReason: 'length',
      requestedMaxTokens: null, inputTokens: 200, cacheReadTokens: 0, outputTokens: 256, hasText: false,
      hasThinking: true, hasToolCalls: false,
    },
  ]]);
  assert.doesNotMatch(JSON.stringify(logs), /private|reasoning/);
});

test('model diagnostics ignore valid text, normal tool calls, compaction and other agents', (t) => {
  const logger = t.mock.method(console, 'error', () => {});
  for (const event of [
    terminalEvent({ response: { finishReason: 'stop', output: {
      role: 'assistant', content: [{ type: 'text', text: 'done' }],
    } } }),
    terminalEvent({ response: { finishReason: 'toolUse', output: {
      role: 'assistant', content: [{ type: 'toolCall', id: 'private', name: 'private', arguments: {} }],
    } } }),
    terminalEvent({ purpose: 'compaction' }),
  ]) observeAgentResultDiagnostics(event, context);
  observeAgentResultDiagnostics(terminalEvent(), { ...context, agentName: 'other-agent' });
  assert.equal(logger.mock.callCount(), 0);
});

test('serialized provider failures retain fixed transport facts without error bodies', (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  for (const [message, expected] of [
    ['OpenAI API error (429): private credential and query', { providerFailureKind: 'http', providerHttpStatus: 429 }],
    ['OpenAI API error (400): private tool input', { providerFailureKind: 'http', providerHttpStatus: 400 }],
    ['429: private response', { providerFailureKind: 'http', providerHttpStatus: 429 }],
    ['503 private response', { providerFailureKind: 'http', providerHttpStatus: 503 }],
    ['Network connection lost.', { providerFailureKind: 'network_connection_lost' }],
    ['Request was aborted.', { providerFailureKind: 'request_aborted' }],
    ['private prose mentioning 429 and Network connection lost.', {}],
    ['OpenAI API error (999): private', {}],
    ['constructor', {}],
  ] as const) {
    observeAgentResultDiagnostics(terminalEvent({ isError: true, response: {
      finishReason: 'error', error: { type: 'unknown', message },
    } }), context);
    const facts = logs.at(-1)![1] as Record<string, unknown>;
    assert.deepEqual(Object.fromEntries(Object.entries(facts).filter(([key]) =>
      key === 'providerFailureKind' || key === 'providerHttpStatus')), expected);
  }
  assert.doesNotMatch(JSON.stringify(logs), /private|credential|query|tool input|Network connection lost/);
});

test('model diagnostics bound arbitrary provider facts and cannot interrupt execution', (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const event = terminalEvent({
    request: { ...terminalEvent().request, maxTokens: Infinity },
    response: { finishReason: 'private', providerFinishReason: 'private',
      usage: { ...terminalEvent().response.usage!, output: -1 } },
  });
  observeAgentResultDiagnostics(event, context);
  assert.deepEqual(logs[0]?.[1], {
    submissionRef: opaqueId('fluesubmission', 'private-submission'),
    finishReason: 'other', providerFinishReason: 'other', requestedMaxTokens: null,
    inputTokens: 200, cacheReadTokens: 0, outputTokens: null, hasText: false, hasThinking: false, hasToolCalls: false,
  });
  t.mock.method(console, 'error', () => { throw new Error('unavailable'); });
  assert.doesNotThrow(() => observeAgentResultDiagnostics(event, context));
});

test('Agent failure diagnostics retain throw-site metadata before Flue replaces unexpected errors', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const cause = Object.assign(new TypeError('private prompt and Bearer secret'), {
    status: 429,
    request: { authorization: 'private credential' },
  });
  cause.stack = 'TypeError: private prompt and Bearer secret\n    at privateFunction (/private/repository/slack-thread-AbCd1234.js:125:42)';
  const error = new Error('private provider response', { cause });
  error.stack = 'Error: private provider response';

  await assert.rejects(
    () => agentFailureDiagnosticsInterceptor(operation, context, async () => { throw error; }),
    (actual) => actual === error,
  );
  assert.deepEqual(logs, [[
    '[chickpea] agent execution failed:',
    {
      submissionRef: opaqueId('fluesubmission', context.submissionId),
      causes: [
        { kind: 'Error', frames: [] },
        {
          kind: 'TypeError', status: 429,
          frames: [{ fileRef: opaqueId('errorfile', 'slack-thread-AbCd1234.js'), line: 125, column: 42 }],
        },
      ],
    },
  ]]);
  assert.doesNotMatch(JSON.stringify(logs), /private|Bearer|secret|credential|slack-thread-AbCd1234/);
});

test('diagnostics bound cyclic causes, discard arbitrary fields, and never replace a failure', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const error = Object.assign(new Error('private'), {
    name: 'private-name', type: 'private-type', code: 'private-code', status: 12_345,
    cause: undefined as unknown,
  });
  error.cause = error;
  error.stack = 'private';
  await assert.rejects(
    () => agentFailureDiagnosticsInterceptor(operation, context, async () => { throw error; }),
    (actual) => actual === error,
  );
  assert.deepEqual(logs[0]?.[1], {
    submissionRef: opaqueId('fluesubmission', context.submissionId),
    causes: [{ kind: 'unknown', frames: [] }],
  });
  t.mock.method(console, 'error', () => { throw new Error('logging unavailable'); });
  await assert.rejects(
    () => agentFailureDiagnosticsInterceptor(operation, context, async () => { throw error; }),
    (actual) => actual === error,
  );
});

test('successful execution and non-root operations do not emit failure diagnostics', async (t) => {
  const logger = t.mock.method(console, 'error', () => {});
  assert.equal(await agentFailureDiagnosticsInterceptor(operation, context, async () => 'done'), 'done');
  for (const [op, ctx] of [
    [{ type: 'model', turnId: 'private' } as const, context],
    [{ ...operation, operationKind: 'task' } as const, context],
    [operation, { ...context, agentName: 'other-agent' }],
  ] as const) {
    const error = new Error('private');
    await assert.rejects(
      () => agentFailureDiagnosticsInterceptor(op, ctx, async () => { throw error; }),
      (actual) => actual === error,
    );
  }
  assert.equal(logger.mock.callCount(), 0);
});

test('diagnostic output is bounded for deep chains, large stacks, and non-Error throws', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  let error = new Error('private');
  for (let depth = 0; depth < 10; depth += 1) {
    error = new Error('private', { cause: error });
    error.stack = 'Error: private\n' + '    at fn (/private/index.js:100:12)\n'.repeat(1_000);
  }
  await assert.rejects(
    () => agentFailureDiagnosticsInterceptor(operation, context, async () => { throw error; }),
    (actual) => actual === error,
  );
  const expectedFrame = { fileRef: opaqueId('errorfile', 'index.js'), line: 100, column: 12 };
  assert.deepEqual(logs[0]?.[1], {
    submissionRef: opaqueId('fluesubmission', context.submissionId),
    causes: Array.from({ length: 4 }, () => ({ kind: 'Error', frames: Array(4).fill(expectedFrame) })),
  });
  await assert.rejects(
    () => agentFailureDiagnosticsInterceptor(operation, context, async () => { throw { message: 'private' }; }),
    (actual) => typeof actual === 'object',
  );
  assert.deepEqual(logs[1]?.[1], {
    submissionRef: opaqueId('fluesubmission', context.submissionId),
    causes: [{ kind: 'non_error', frames: [] }],
  });
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});


test('failed model turns retain bounded facts even after partial text and tools', (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  observeAgentResultDiagnostics(terminalEvent({ isError: true, response: {
    ...terminalEvent().response,
    finishReason: 'error', providerFinishReason: 'private vendor finish',
    output: { role: 'assistant', content: [
      { type: 'text', text: 'private output' },
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'toolCall', id: 'private-id', name: 'private-tool', arguments: { credential: 'private' } },
    ] },
    error: { type: 'cloudflare_ai_binding_error', message: 'private provider body',
      stack: '/private/path', meta: { status: 429, statusText: 'private text', arbitrary: 'private' } },
  } }), context);
  assert.deepEqual(logs, [['[chickpea] agent model turn failed:', {
    submissionRef: opaqueId('fluesubmission', 'private-submission'),
    finishReason: 'error', providerFinishReason: 'other', requestedMaxTokens: null,
    inputTokens: 200, cacheReadTokens: 0, outputTokens: 256,
    hasText: true, hasThinking: true, hasToolCalls: true,
    errorCode: 'cloudflare_ai_binding_error', status: 429,
  }]]);
  assert.doesNotMatch(JSON.stringify(logs), /private|credential|provider body|reasoning/);
});

test('failed finish states are observed without error flags and arbitrary error codes never escape', (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  for (const finishReason of ['error', 'aborted']) {
    observeAgentResultDiagnostics(terminalEvent({ isError: false, response: {
      finishReason, error: { type: 'private type', code: 'private code', message: 'ECONNRESET private body',
        meta: { status: 1000 } },
      usage: { ...terminalEvent().response.usage!, input: NaN, cacheRead: -1, output: Infinity },
    } }), context);
  }
  for (const entry of logs) {
    assert.equal(entry[0], '[chickpea] agent model turn failed:');
    assert.deepEqual({ ...(entry[1] as object), finishReason: 'ignored' }, {
      submissionRef: opaqueId('fluesubmission', 'private-submission'),
      finishReason: 'ignored', providerFinishReason: null, requestedMaxTokens: null,
      inputTokens: null, cacheReadTokens: null, outputTokens: null,
      hasText: false, hasThinking: false, hasToolCalls: false, errorCode: 'other', status: null,
    });
  }
  assert.doesNotMatch(JSON.stringify(logs), /private|ECONNRESET/);
  t.mock.method(console, 'error', () => { throw new Error('private logger failure'); });
  assert.doesNotThrow(() => observeAgentResultDiagnostics(terminalEvent({ isError: true }), context));
});
