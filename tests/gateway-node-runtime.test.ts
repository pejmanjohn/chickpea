import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NodeGatewayInboxWorker,
  refreshNodeGatewaySession,
  startNodeGatewayRuntime,
  startNodeGatewaySession,
  stopNodeGatewayRuntime,
  stopNodeGatewaySession,
} from '../src/slack/gateway/node-runtime.ts';
import type { GatewayEventDelivery } from '../src/slack/gateway/protocol.ts';

test.afterEach(async () => {
  await stopNodeGatewayRuntime();
});

test('Node gateway startup retries after an initial state read failure', async () => {
  await stopNodeGatewayRuntime();
  let reads = 0;
  let starts = 0;
  let stopped = 0;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const dependencies = {
    isCloudflare: () => false,
    readBinding: async () => {
      reads += 1;
      if (reads === 1) throw new Error('state temporarily unavailable');
      return '{"bindingId":"binding_test"}';
    },
    createRunner: () => ({
      start: async () => {
        starts += 1;
        return true;
      },
      stop: () => { stopped += 1; },
    }),
    getInbox: () => emptyInbox,
    createInboxWorker: () => idleWorker(),
    setTimer: ((callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    onError: () => {},
  };
  try {
    await startNodeGatewayRuntime(undefined, dependencies);
    await spin();
    assert.equal(reads, 1);
    assert.equal(timers[0]?.delay, 5_000);
    timers[0]!.callback();
    await spin();
    assert.equal(reads, 2);
    assert.equal(starts, 1);
  } finally {
    stopNodeGatewaySession();
  }
  assert.equal(stopped, 1);
});

test('Node gateway advertises durable admission only after save-before-receipt is available', async () => {
  await stopNodeGatewayRuntime();
  const saved: string[] = [];
  const inbox = {
    ...emptyInbox,
    admit: (delivery: GatewayEventDelivery) => {
      saved.push(delivery.deliveryId);
      return 'accepted' as const;
    },
  };
  let admission:
    | ((delivery: GatewayEventDelivery) => Promise<'accepted' | 'duplicate' | 'rejected'>)
    | undefined;
  let capabilities: readonly string[] | undefined;
  await startNodeGatewayRuntime(undefined, {
    isCloudflare: () => false,
    readBinding: async () => '{"bindingId":"binding_test"}',
    getInbox: () => inbox,
    createInboxWorker: () => idleWorker(),
    createRunner: (_env, input) => {
      admission = input.onEvent;
      capabilities = input.capabilities;
      return { start: async () => true, stop() {} };
    },
  });
  await spin();

  assert.deepEqual(capabilities, ['durable_admission_v1']);
  const outcome = await admission!(eventDelivery('delivery:Ev_DURABLE'));
  assert.deepEqual(saved, ['delivery:Ev_DURABLE']);
  assert.equal(outcome, 'accepted');
});

test('Node gateway rejects a receipt when durable admission fails', async () => {
  await stopNodeGatewayRuntime();
  let admission:
    | ((delivery: GatewayEventDelivery) => Promise<'accepted' | 'duplicate' | 'rejected'>)
    | undefined;
  await startNodeGatewayRuntime(undefined, {
    isCloudflare: () => false,
    readBinding: async () => '{"bindingId":"binding_test"}',
    getInbox: () => ({
      ...emptyInbox,
      admit: () => {
        throw new Error('disk full');
      },
    }),
    createInboxWorker: () => idleWorker(),
    createRunner: (_env, input) => {
      admission = input.onEvent;
      return { start: async () => true, stop() {} };
    },
  });
  await spin();

  await assert.rejects(admission!(eventDelivery('delivery:Ev_FULL')), /disk full/);
});

test('stopping during binding lookup fences the stale start and permits a clean restart', async () => {
  await stopNodeGatewayRuntime();
  let release!: (binding: string) => void;
  const binding = new Promise<string>((resolve) => {
    release = resolve;
  });
  let created = 0;
  const dependencies = {
    isCloudflare: () => false,
    getInbox: () => emptyInbox,
    createInboxWorker: () => idleWorker(),
    createRunner: () => {
      created += 1;
      return { start: async () => true, stop() {} };
    },
  };
  await startNodeGatewayRuntime(undefined, {
    ...dependencies,
    readBinding: async () => binding,
  });
  stopNodeGatewaySession();
  release('{"bindingId":"binding_test"}');
  await spin();
  assert.equal(created, 0);

  startNodeGatewaySession(undefined, {
    ...dependencies,
    readBinding: async () => '{"bindingId":"binding_test"}',
  });
  await spin();
  assert.equal(created, 1);
});

test('binding refresh retires the old callback even when the binding ID is reused', async () => {
  await stopNodeGatewayRuntime();
  const admissions: Array<
    (delivery: GatewayEventDelivery) => Promise<'accepted' | 'duplicate' | 'rejected'>
  > = [];
  const stopped: number[] = [];
  let admitted = 0;
  let installedAt = 100;
  const dependencies = {
    isCloudflare: () => false,
    readBinding: async () => JSON.stringify({
      bindingId: 'binding_test',
      deploymentId: 'deployment_test',
      workspaceId: 'T_TEST',
      appId: 'A_TEST',
      clientId: 'client_test',
      botUserId: 'B_TEST',
      installedAt,
    }),
    getInbox: () => ({
      ...emptyInbox,
      admit: (_delivery: GatewayEventDelivery, expectedBinding?: string) => {
        if (!expectedBinding || JSON.parse(expectedBinding).installedAt !== installedAt) {
          return 'rejected' as const;
        }
        admitted += 1;
        return 'accepted' as const;
      },
    }),
    createInboxWorker: () => idleWorker(),
    createRunner: (_env: unknown, input: {
      onEvent(delivery: GatewayEventDelivery): Promise<'accepted' | 'duplicate' | 'rejected'>;
    }) => {
      const index = admissions.length;
      admissions.push(input.onEvent);
      return {
        start: async () => true,
        stop: () => { stopped.push(index); },
      };
    },
  };
  await startNodeGatewayRuntime(undefined, dependencies);
  await spin();
  installedAt = 200;
  assert.equal(
    await admissions[0]!(eventDelivery('delivery:Ev_PRE_REFRESH_WINDOW')),
    'rejected',
  );
  assert.equal(admitted, 0);
  refreshNodeGatewaySession(undefined, dependencies);
  await spin();

  assert.equal(admissions.length, 2);
  assert.deepEqual(stopped, [0]);
  assert.equal(await admissions[0]!(eventDelivery('delivery:Ev_OLD_SOCKET')), 'rejected');
  assert.equal(await admissions[1]!(eventDelivery('delivery:Ev_NEW_SOCKET')), 'accepted');
  assert.equal(admitted, 1);
});

test('production quiescing blocks incidental session restarts until a deliberate runtime start', async () => {
  await stopNodeGatewayRuntime();
  let created = 0;
  const dependencies = {
    isCloudflare: () => false,
    readBinding: async () => '{"bindingId":"binding_test"}',
    getInbox: () => emptyInbox,
    createInboxWorker: () => idleWorker(),
    createRunner: () => {
      created += 1;
      return { start: async () => true, stop() {} };
    },
  };
  await startNodeGatewayRuntime(undefined, dependencies);
  await spin();
  assert.equal(created, 1);

  await stopNodeGatewayRuntime();
  startNodeGatewaySession(undefined, dependencies);
  await spin();
  assert.equal(created, 1);

  await startNodeGatewayRuntime(undefined, dependencies);
  await spin();
  assert.equal(created, 2);
});

test('a retained socket callback cannot admit after runtime shutdown begins', async () => {
  await stopNodeGatewayRuntime();
  let admitted = 0;
  let admission:
    | ((delivery: GatewayEventDelivery) => Promise<'accepted' | 'duplicate' | 'rejected'>)
    | undefined;
  const inbox = {
    ...emptyInbox,
    admit: () => {
      admitted += 1;
      return 'accepted' as const;
    },
  };
  await startNodeGatewayRuntime(undefined, {
    isCloudflare: () => false,
    readBinding: async () => '{"bindingId":"binding_test"}',
    getInbox: () => inbox,
    createInboxWorker: () => idleWorker(),
    createRunner: (_env, input) => {
      admission = input.onEvent;
      return { start: async () => true, stop() {} };
    },
  });
  await spin();
  await stopNodeGatewayRuntime();

  assert.equal(await admission!(eventDelivery('delivery:Ev_AFTER_STOP')), 'rejected');
  assert.equal(admitted, 0);
});

test('startup drains stale accepted rows even when no binding remains', async () => {
  await stopNodeGatewayRuntime();
  let recoveryRequired = 0;
  let claimed = false;
  const staleInbox = {
    ...emptyInbox,
    deliveryIsCurrent: () => false,
    claimPending: () => {
      if (claimed) return [];
      claimed = true;
      return [{ id: 'delivery:Ev_STALE', delivery: eventDelivery('delivery:Ev_STALE'), attempts: 1 }];
    },
    markRecoveryRequired: () => {
      recoveryRequired += 1;
      return true;
    },
  };
  let runners = 0;
  await startNodeGatewayRuntime(undefined, {
    isCloudflare: () => false,
    readBinding: async () => undefined,
    getInbox: () => staleInbox,
    createInboxWorker: () => new NodeGatewayInboxWorker({
      getStore: () => staleInbox,
      processDelivery: async () => assert.fail('stale authority must not dispatch'),
    }),
    createRunner: () => {
      runners += 1;
      return { start: async () => true, stop() {} };
    },
  });
  await spin();
  assert.equal(recoveryRequired, 1);
  assert.equal(runners, 0);
});

const emptyInbox = {
  admit: () => 'accepted' as const,
  deliveryIsCurrent: () => true,
  claimPending: () => [],
  complete: () => true,
  retryOrRecover: () => 'pending' as const,
  markRecoveryRequired: () => true,
  hasPending: () => false,
};

function idleWorker(): NodeGatewayInboxWorker {
  return new NodeGatewayInboxWorker({
    getStore: () => emptyInbox,
    processDelivery: async () => 'accepted',
  });
}

function eventDelivery(deliveryId: string): GatewayEventDelivery {
  return {
    protocolVersion: 1,
    kind: 'event.deliver',
    deliveryId,
    bindingId: 'binding_test',
    workspaceId: 'T_TEST',
    envelope: {
      workspaceId: 'T_TEST',
      eventId: deliveryId.slice('delivery:'.length),
      eventTime: 1_777_000_000,
      event: {
        type: 'app_mention',
        channel: 'C_TEST',
        user: 'U_TEST',
        ts: '1.1',
        event_ts: '1.1',
        text: 'hello',
      },
    },
  };
}

async function spin(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
