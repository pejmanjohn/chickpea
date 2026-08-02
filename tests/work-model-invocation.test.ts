import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';

const correlation = {
  runId: 'run_invocation_boundary',
  runExecutionId: 'execution_invocation_boundary',
  mode: 'enforce' as const,
};

const target = {
  turnJobId: 'turn_invocation_boundary',
  instanceId: `agent_${'a'.repeat(40)}`,
  submissionId: 'submission_invocation_boundary',
  generation: 'turn_invocation_boundary',
  workCorrelation: correlation,
};

const context = {
  instanceId: target.instanceId,
  submissionId: target.submissionId,
  agentName: 'chickpea-slack-v2',
};

test('the first Flue model operation marks invocation before provider execution exactly once', async () => {
  const events: string[] = [];
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => target,
    markInvocation: async () => {
      events.push('marked');
    },
  });
  await interceptor(
    { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
    context,
    async () => {
      await interceptor({ type: 'model', turnId: 'turn-1' }, {}, async () => {
        events.push('provider-1');
      });
      await interceptor({ type: 'model', turnId: 'turn-1' }, {}, async () => {
        events.push('provider-2');
      });
    },
  );
  assert.deepEqual(events, ['marked', 'provider-1', 'provider-2']);
});

test('agent initialization failures remain not submitted', async () => {
  let marks = 0;
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => target,
    markInvocation: async () => { marks += 1; },
  });
  await assert.rejects(
    () => interceptor(
      { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
      context,
      async () => { throw new Error('policy rejected'); },
    ),
    /policy rejected/,
  );
  assert.equal(marks, 0);
});

test('ledger authority fails closed when its invocation marker cannot persist', async () => {
  let providerCalls = 0;
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => target,
    markInvocation: async () => {
      throw new Error('marker unavailable');
    },
  });
  await assert.rejects(
    () => interceptor(
      { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
      context,
      () => interceptor({ type: 'model', turnId: 'turn-1' }, {}, async () => {
        providerCalls += 1;
      }),
    ),
    /marker unavailable/,
  );
  assert.equal(providerCalls, 0);
});
