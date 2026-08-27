import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  publishActivityStatus,
} from '../src/slack/activity-publisher.ts';
import { activityStatus, type TypedActivityStatus } from '../src/activity/status.ts';
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
    const calls: Array<{
      instanceId: string;
      submissionId: string;
      status: TypedActivityStatus;
    }> = [];
    const stub = {
      async observedStatus(instanceId: string, submissionId: string, status: TypedActivityStatus) {
        calls.push({ instanceId, submissionId, status });
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

    publishActivityStatus(
      'relay-order-thread',
      activityStatus('preparing', 'Preparing', 'your request'),
      env,
    );
    publishActivityStatus(
      'relay-order-thread',
      activityStatus('reading', 'Loading', 'a skill'),
      env,
    );
    publishActivityStatus(
      'relay-order-thread',
      activityStatus('checking', 'Checking', 'Cloudflare Docs'),
      env,
    );

    await firstStarted.promise;
    await Promise.resolve();
    assert.deepEqual(calls, [
      {
        instanceId: 'relay-order-thread',
        submissionId: 'submission-relay-order',
        status: activityStatus('preparing', 'Preparing', 'your request'),
      },
    ]);

    first.resolve();
    await secondFinished.promise;
    assert.deepEqual(calls, [
      {
        instanceId: 'relay-order-thread',
        submissionId: 'submission-relay-order',
        status: activityStatus('preparing', 'Preparing', 'your request'),
      },
      {
        instanceId: 'relay-order-thread',
        submissionId: 'submission-relay-order',
        status: activityStatus('checking', 'Checking', 'Cloudflare Docs'),
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
    const calls: TypedActivityStatus[] = [];
    const env = {
      TAG_STATE: {
        getByName() {
          return {
            async observedStatus(
              _instanceId: string,
              submissionId: string,
              status: TypedActivityStatus,
            ) {
              assert.equal(submissionId, 'submission-relay-retry');
              calls.push(status);
              if (calls.length === 1) throw new Error('transient RPC failure');
              secondFinished.resolve();
              return { ok: true as const, value: null };
            },
          };
        },
      },
    };

    publishActivityStatus(
      'relay-retry-thread',
      activityStatus('reading', 'Loading', 'a skill'),
      env,
    );
    publishActivityStatus(
      'relay-retry-thread',
      activityStatus('checking', 'Checking', 'a connection'),
      env,
    );

    await secondFinished.promise;
    assert.deepEqual(calls, [
      activityStatus('reading', 'Loading', 'a skill'),
      activityStatus('checking', 'Checking', 'a connection'),
    ]);
    },
  ));
});

test('Cloudflare relay remains best-effort when the state binding is missing', async () => {
  await withCloudflareUserAgent(async () => {
    await assert.doesNotReject(
      relayObservedStatus(
        'missing-binding-thread',
        GENERATION,
        activityStatus('checking', 'Checking', 'a connection'),
        {},
      ),
    );
  });
});

test('Cloudflare relay keeps distinct typed updates on one coordinate through the state sink', async () => {
  await withCloudflareUserAgent(() => withActivityObservation(
    'typed-relay-thread',
    'submission-typed-relay',
    GENERATION,
    async () => {
      const delivered = Promise.withResolvers<void>();
      const persisted: TypedActivityStatus[] = [];
      const env = {
        TAG_STATE: {
          getByName() {
            return {
              async observedStatus(
                instanceId: string,
                submissionId: string,
                status: TypedActivityStatus,
              ) {
                assert.equal(instanceId, 'typed-relay-thread');
                assert.equal(submissionId, 'submission-typed-relay');
                persisted.push(structuredClone(status));
                if (persisted.length === 2) delivered.resolve();
                return { ok: true as const, value: null };
              },
            };
          },
        },
      };
      const first = activityStatus('reading', 'Reading', 'a workspace file');
      const second = activityStatus('updating', 'Editing', 'a workspace file');

      publishActivityStatus('typed-relay-thread', first, env);
      publishActivityStatus('typed-relay-thread', second, env);

      await delivered.promise;
      assert.deepEqual(persisted, [first, second]);
    },
  ));
});
