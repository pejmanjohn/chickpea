import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FlueObservation } from '@flue/runtime';
import { agentFailureDiagnosticsInterceptor, observeAgentResultDiagnostics } from '../src/slack/agent-failure-diagnostics.ts';
import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { opaqueId } from '../src/work/admission.ts';

const operation = { type: 'agent', operationId: 'private-submission', operationKind: 'prompt' } as const;
const context = { agentName: CHICKPEA_SLACK_AGENT_NAME, submissionId: 'private-submission' };

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
      requestedMaxTokens: null, outputTokens: 256,
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
    terminalEvent({ isError: true }),
  ]) observeAgentResultDiagnostics(event, context);
  observeAgentResultDiagnostics(terminalEvent(), { ...context, agentName: 'other-agent' });
  assert.equal(logger.mock.callCount(), 0);
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
    outputTokens: null, hasThinking: false, hasToolCalls: false,
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
