import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentFailureDiagnosticsInterceptor } from '../src/slack/agent-failure-diagnostics.ts';
import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { opaqueId } from '../src/work/admission.ts';

const operation = { type: 'agent', operationId: 'private-submission', operationKind: 'prompt' } as const;
const context = { agentName: CHICKPEA_SLACK_AGENT_NAME, submissionId: 'private-submission' };

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
