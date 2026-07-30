import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';
import { activityStatusTraceHeaders } from '../src/slack/activity-publisher.ts';

const correlation = {
  runId: 'run_invocation_boundary',
  runExecutionId: 'execution_invocation_boundary',
  mode: 'enforce' as const,
};

test('the first Flue model operation marks invocation before provider execution exactly once', async () => {
  const events: string[] = [];
  const interceptor = createWorkModelInvocationInterceptor(async () => {
    events.push('marked');
  });
  const traceCarrier = activityStatusTraceHeaders('generation-model', correlation);
  await interceptor(
    { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
    { traceCarrier },
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
  const interceptor = createWorkModelInvocationInterceptor(async () => { marks += 1; });
  const traceCarrier = activityStatusTraceHeaders('generation-init', correlation);
  await assert.rejects(
    () => interceptor(
      { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
      { traceCarrier },
      async () => { throw new Error('policy rejected'); },
    ),
    /policy rejected/,
  );
  assert.equal(marks, 0);
});

test('ledger authority fails closed when its invocation marker cannot persist', async () => {
  let providerCalls = 0;
  const interceptor = createWorkModelInvocationInterceptor(async () => {
    throw new Error('marker unavailable');
  });
  const traceCarrier = activityStatusTraceHeaders('generation-enforce', correlation);
  await assert.rejects(
    () => interceptor(
      { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
      { traceCarrier },
      () => interceptor({ type: 'model', turnId: 'turn-1' }, {}, async () => {
        providerCalls += 1;
      }),
    ),
    /marker unavailable/,
  );
  assert.equal(providerCalls, 0);
});
