import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  publishActivityStatus,
} from '../src/slack/activity-publisher.ts';
import { relayObservedStatus } from '../src/slack/status-relay.ts';
import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';

const GENERATION = 'msg:C_CHAN:1782770400.000100 / retry=1';

async function withCloudflareUserAgent<T>(run: () => Promise<T>): Promise<T> {
  const prototype = Object.getPrototypeOf(globalThis.navigator) as object;
  const original = Object.getOwnPropertyDescriptor(prototype, 'userAgent');
  Object.defineProperty(prototype, 'userAgent', {
    configurable: true,
    enumerable: true,
    value: 'Cloudflare-Workers',
  });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(prototype, 'userAgent', original);
  }
}

async function withActivityObservation<T>(
  instanceId: string,
  submissionId: string,
  generation: string,
  run: () => Promise<T>,
): Promise<T> {
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => ({
      turnJobId: generation,
      instanceId,
      submissionId,
      generation,
    }),
  });
  return interceptor(
    { type: 'agent', operationId: 'status-test', operationKind: 'prompt' },
    { instanceId, submissionId, agentName: 'chickpea-slack-v2' },
    run,
  );
}

test('Cloudflare activity relays coalesce stale queued detail before reaching the state DO', async () => {
  await withCloudflareUserAgent(() => withActivityObservation(
    'relay-order-thread',
    'submission-relay-order',
    GENERATION,
    async () => {
    const first = Promise.withResolvers<void>();
    const firstStarted = Promise.withResolvers<void>();
    const secondFinished = Promise.withResolvers<void>();
    const calls: Array<{ instanceId: string; submissionId: string; statusText: string }> = [];
    const stub = {
      async observedStatus(instanceId: string, submissionId: string, statusText: string) {
        calls.push({ instanceId, submissionId, statusText });
        if (calls.length === 1) {
          firstStarted.resolve();
          await first.promise;
        } else {
          secondFinished.resolve();
        }
        return { ok: true as const, value: null };
      },
    };
    const env = {
      TAG_STATE: {
        getByName(name: string) {
          assert.equal(name, 'singleton');
          return stub;
        },
      },
    };

    publishActivityStatus('relay-order-thread', { text: 'is thinking through the request' }, env);
    publishActivityStatus('relay-order-thread', { text: 'is loading a skill' }, env);
    publishActivityStatus('relay-order-thread', { text: 'is using Cloudflare Docs' }, env);

    await firstStarted.promise;
    await Promise.resolve();
    assert.deepEqual(calls, [
      {
        instanceId: 'relay-order-thread',
        submissionId: 'submission-relay-order',
        statusText: 'is thinking through the request',
      },
    ]);

    first.resolve();
    await secondFinished.promise;
    assert.deepEqual(calls, [
      {
        instanceId: 'relay-order-thread',
        submissionId: 'submission-relay-order',
        statusText: 'is thinking through the request',
      },
      {
        instanceId: 'relay-order-thread',
        submissionId: 'submission-relay-order',
        statusText: 'is using Cloudflare Docs',
      },
    ]);
    },
  ));
});

test('a failed Cloudflare activity relay does not block the next update', async () => {
  await withCloudflareUserAgent(() => withActivityObservation(
    'relay-retry-thread',
    'submission-relay-retry',
    GENERATION,
    async () => {
    const secondFinished = Promise.withResolvers<void>();
    const calls: string[] = [];
    const env = {
      TAG_STATE: {
        getByName() {
          return {
            async observedStatus(
              _instanceId: string,
              submissionId: string,
              statusText: string,
            ) {
              assert.equal(submissionId, 'submission-relay-retry');
              calls.push(statusText);
              if (calls.length === 1) throw new Error('transient RPC failure');
              secondFinished.resolve();
              return { ok: true as const, value: null };
            },
          };
        },
      },
    };

    publishActivityStatus('relay-retry-thread', { text: 'is loading a skill' }, env);
    publishActivityStatus('relay-retry-thread', { text: 'is using a connection' }, env);

    await secondFinished.promise;
    assert.deepEqual(calls, ['is loading a skill', 'is using a connection']);
    },
  ));
});

test('Cloudflare relay remains best-effort when the state binding is missing', async () => {
  await withCloudflareUserAgent(async () => {
    await assert.doesNotReject(
      relayObservedStatus(
        'missing-binding-thread',
        GENERATION,
        'is using a connection',
        {},
      ),
    );
  });
});
