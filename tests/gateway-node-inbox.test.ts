import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigStoreLogic } from '../src/config/store.ts';
import {
  closeNodeStateStores,
  getNodeGatewayInboxStore,
  readRuntimeDrainStatus,
} from '../src/config/state-backend.ts';
import { SettingsStoreLogic } from '../src/config/settings-store.ts';
import { GatewayInboxStoreLogic } from '../src/slack/gateway/inbox.ts';
import { GATEWAY_BINDING_SETTING } from '../src/slack/gateway/settings.ts';
import { SqliteGatewayInboxStore } from '../src/slack/gateway/node-inbox-store.ts';
import { NodeGatewayInboxWorker } from '../src/slack/gateway/node-runtime.ts';
import type {
  GatewayEventDelivery,
  GatewayInboundDelivery,
  GatewayWorkspaceBinding,
} from '../src/slack/gateway/protocol.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const NOW = 1_777_000_000_000;

test('Node gateway admission atomically validates authority and survives a lost receipt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-gateway-'));
  const path = join(directory, 'state.db');
  seedGatewayBinding(path);
  let inbox: SqliteGatewayInboxStore | undefined = new SqliteGatewayInboxStore(path);
  try {
    const delivery = eventDelivery('delivery:Ev_NODE', 'original body');
    assert.equal(inbox.admit(delivery), 'accepted');

    const inspection = openStateDb(path);
    try {
      const saved = inspection.get(
        'SELECT status, payload_json FROM gateway_inbox WHERE id = ?',
        delivery.deliveryId,
      );
      assert.equal(saved?.status, 'pending');
      assert.match(String(saved?.payload_json), /original body/);
    } finally {
      inspection.close();
    }

    // Simulate a lost receipt and process restart. The changed retry body must
    // neither replace the saved payload nor create a second row.
    inbox.close();
    inbox = new SqliteGatewayInboxStore(path);
    assert.equal(inbox.admit(eventDelivery(delivery.deliveryId, 'changed retry body')), 'duplicate');
    const claimed = inbox.claimPending(1);
    assert.equal(claimed.length, 1);
    assert.deepEqual(claimed[0]?.delivery, delivery);
    assert.equal(inbox.complete(delivery.deliveryId), true);
    assert.deepEqual(inbox.runtimeDrainCounts(), {
      pendingGatewayInboxDeliveries: 0,
      inFlightGatewayInboxDeliveries: 0,
      recoveryRequiredGatewayInboxDeliveries: 0,
    });

    const completed = openStateDb(path);
    try {
      const row = completed.get(
        'SELECT status, payload_json, payload_bytes FROM gateway_inbox WHERE id = ?',
        delivery.deliveryId,
      );
      assert.equal(row?.status, 'completed');
      assert.equal(row?.payload_json, null);
      assert.equal(row?.payload_bytes, 0);
    } finally {
      completed.close();
    }
  } finally {
    inbox?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Node gateway admission rejects cross-workspace, replaced, and revoked authority', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-gateway-auth-'));
  const path = join(directory, 'state.db');
  seedGatewayBinding(path);
  const inbox = new SqliteGatewayInboxStore(path);
  try {
    assert.equal(
      inbox.admit({
        ...eventDelivery('delivery:Ev_WRONG_WORKSPACE', 'wrong'),
        workspaceId: 'T_OTHER',
        envelope: {
          ...eventDelivery('delivery:Ev_WRONG_WORKSPACE', 'wrong').envelope,
          workspaceId: 'T_OTHER',
        },
      }),
      'rejected',
    );
    assert.equal(
      inbox.admit({ ...eventDelivery('delivery:Ev_WRONG_BINDING', 'wrong'), bindingId: 'binding_old' }),
      'rejected',
    );

    const db = openStateDb(path);
    try {
      const config = new ConfigStoreLogic(db);
      const current = config.getWorkspaceInstallation('T_TEST')!;
      config.updateWorkspaceInstallation('T_TEST', { health: 'revoked' }, current.revision);
    } finally {
      db.close();
    }
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_REVOKED', 'wrong')), 'rejected');
    assert.equal(inbox.runtimeDrainCounts().pendingGatewayInboxDeliveries, 0);
  } finally {
    inbox.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Node gateway inbox durably dedupes and drains both interaction delivery kinds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-gateway-interactions-'));
  const path = join(directory, 'state.db');
  seedGatewayBinding(path);
  const inbox = new SqliteGatewayInboxStore(path);
  const deliveries: GatewayInboundDelivery[] = [
    {
      protocolVersion: 1,
      kind: 'interaction.agent_selected',
      deliveryId: 'selection_delivery',
      bindingId: 'binding_test',
      workspaceId: 'T_TEST',
      userId: 'U_TEST',
      agentId: 'agent_support',
    },
    {
      protocolVersion: 1,
      kind: 'interaction.channel_agent_add',
      deliveryId: 'channel_setup_delivery',
      bindingId: 'binding_test',
      workspaceId: 'T_TEST',
      userId: 'U_TEST',
      channelId: 'C_PRIVATE',
      setupId: '019f12cc-87e1-7000-8123-123456789abc',
      agentId: 'agent_support',
    },
  ];
  try {
    for (const delivery of deliveries) {
      assert.equal(inbox.admit(delivery), 'accepted');
      assert.equal(inbox.admit(delivery), 'duplicate');
    }
    for (const delivery of deliveries) {
      const claimed = inbox.claimPending(1)[0];
      assert.deepEqual(claimed?.delivery, delivery);
      assert.equal(inbox.complete(delivery.deliveryId), true);
    }

    const db = openStateDb(path);
    try {
      for (const delivery of deliveries) {
        const row = db.get(
          'SELECT status, payload_json, payload_bytes FROM gateway_inbox WHERE id = ?',
          delivery.deliveryId,
        );
        assert.equal(row?.status, 'completed');
        assert.equal(row?.payload_json, null);
        assert.equal(row?.payload_bytes, 0);
      }
    } finally {
      db.close();
    }
  } finally {
    inbox.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Node gateway inbox reclaims an expired file-backed lease after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-gateway-lease-'));
  const path = join(directory, 'state.db');
  seedGatewayBinding(path);
  let inbox: SqliteGatewayInboxStore | undefined = new SqliteGatewayInboxStore(path);
  const delivery = eventDelivery('delivery:Ev_LEASE_RESTART', 'body');
  try {
    assert.equal(inbox.admit(delivery), 'accepted');
    assert.equal(inbox.claimPending(1)[0]?.attempts, 1);
    inbox.close();
    inbox = undefined;

    const db = openStateDb(path);
    try {
      db.run(
        'UPDATE gateway_inbox SET lease_until = 0 WHERE id = ?',
        delivery.deliveryId,
      );
    } finally {
      db.close();
    }

    inbox = new SqliteGatewayInboxStore(path);
    const reclaimed = inbox.claimPending(1)[0];
    assert.equal(reclaimed?.id, delivery.deliveryId);
    assert.equal(reclaimed?.attempts, 2);
    assert.equal(inbox.complete(delivery.deliveryId), true);
  } finally {
    inbox?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Node runtime drain status reports persisted gateway inbox states', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-gateway-drain-'));
  const path = join(directory, 'state.db');
  const previous = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = path;
  seedGatewayBinding(path);
  try {
    const inbox = getNodeGatewayInboxStore();
    inbox.admit(eventDelivery('delivery:Ev_DRAIN', 'body'));
    let status = await readRuntimeDrainStatus();
    assert.equal(status.categories.pendingGatewayInboxDeliveries, 1);
    assert.equal(status.categories.inFlightGatewayInboxDeliveries, 0);

    const claimed = inbox.claimPending(1)[0]!;
    status = await readRuntimeDrainStatus();
    assert.equal(status.categories.pendingGatewayInboxDeliveries, 0);
    assert.equal(status.categories.inFlightGatewayInboxDeliveries, 1);

    inbox.markRecoveryRequired(claimed.id, 'test_recovery');
    status = await readRuntimeDrainStatus();
    assert.equal(status.categories.inFlightGatewayInboxDeliveries, 0);
    assert.equal(status.categories.recoveryRequiredGatewayInboxDeliveries, 1);
  } finally {
    closeNodeStateStores();
    if (previous === undefined) delete process.env.SLACK_STATE_DB_PATH;
    else process.env.SLACK_STATE_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Node gateway worker retries without acknowledging completion and scrubs after success', async () => {
  const db = openStateDb(':memory:');
  const inbox = new GatewayInboxStoreLogic(db);
  const delivery = eventDelivery('delivery:Ev_RETRY_WORKER', 'sensitive');
  inbox.admit(delivery);
  const timers: Array<() => void> = [];
  let attempts = 0;
  const worker = new NodeGatewayInboxWorker({
    getStore: () => workerInbox(inbox),
    processDelivery: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary');
      return 'accepted';
    },
    retryMs: 5,
    setTimer: ((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    onError: () => {},
  });
  try {
    worker.start();
    await spin();
    assert.equal(attempts, 1);
    assert.equal(db.get(
      'SELECT status, attempts FROM gateway_inbox WHERE id = ?',
      delivery.deliveryId,
    )?.status, 'pending');
    assert.equal(timers.length, 1);

    timers.shift()!();
    await spin();
    assert.equal(attempts, 2);
    const completed = db.get(
      'SELECT status, attempts, payload_json, payload_bytes FROM gateway_inbox WHERE id = ?',
      delivery.deliveryId,
    );
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.attempts, 2);
    assert.equal(completed?.payload_json, null);
    assert.equal(completed?.payload_bytes, 0);
  } finally {
    await worker.stop();
    db.close();
  }
});

test('Node gateway shutdown waits for the active delivery before its database may close', async () => {
  const db = openStateDb(':memory:');
  const inbox = new GatewayInboxStoreLogic(db);
  const delivery = eventDelivery('delivery:Ev_SHUTDOWN', 'body');
  inbox.admit(delivery);
  let release!: (outcome: 'accepted') => void;
  const active = new Promise<'accepted'>((resolve) => {
    release = resolve;
  });
  let processing = false;
  const worker = new NodeGatewayInboxWorker({
    getStore: () => workerInbox(inbox),
    processDelivery: async () => {
      processing = true;
      return active;
    },
  });
  worker.start();
  await spin();
  assert.equal(processing, true);
  assert.equal(db.get(
    'SELECT status FROM gateway_inbox WHERE id = ?',
    delivery.deliveryId,
  )?.status, 'in_flight');

  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await spin();
  assert.equal(stopped, false);
  release('accepted');
  await stopping;
  assert.equal(db.get(
    'SELECT status FROM gateway_inbox WHERE id = ?',
    delivery.deliveryId,
  )?.status, 'completed');
  db.close();
});

function seedGatewayBinding(path: string): void {
  const db = openStateDb(path);
  try {
    const binding: GatewayWorkspaceBinding = {
      bindingId: 'binding_test',
      deploymentId: 'deployment_test',
      workspaceId: 'T_TEST',
      appId: 'A_TEST',
      clientId: 'client_test',
      botUserId: 'B_TEST',
      installerSlackUserId: 'U_INSTALLER',
      sessionUrl: 'wss://gateway.test/session',
      installedAt: NOW,
    };
    const config = new ConfigStoreLogic(db);
    const installation = config.ensureWorkspaceInstallation({
      workspaceId: binding.workspaceId,
      transportMode: 'gateway',
      teamId: binding.workspaceId,
      appId: binding.appId,
      botUserId: binding.botUserId,
      gatewayBindingId: binding.bindingId,
    });
    config.updateWorkspaceInstallation(
      binding.workspaceId,
      { health: 'healthy' },
      installation.revision,
    );
    new SettingsStoreLogic(db).setSetting(GATEWAY_BINDING_SETTING, JSON.stringify(binding));
  } finally {
    db.close();
  }
}

function eventDelivery(deliveryId: string, text: string): GatewayEventDelivery {
  return {
    protocolVersion: 1,
    kind: 'event.deliver',
    deliveryId,
    bindingId: 'binding_test',
    workspaceId: 'T_TEST',
    envelope: {
      workspaceId: 'T_TEST',
      eventId: deliveryId.slice('delivery:'.length),
      eventTime: NOW,
      event: {
        type: 'app_mention',
        channel: 'C_TEST',
        user: 'U_TEST',
        ts: '1.1',
        event_ts: '1.1',
        text,
      },
    },
  };
}

async function spin(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function workerInbox(inbox: GatewayInboxStoreLogic) {
  return {
    admit: inbox.admit.bind(inbox),
    deliveryIsCurrent: () => true,
    claimPending: inbox.claimPending.bind(inbox),
    complete: inbox.complete.bind(inbox),
    retryOrRecover: inbox.retryOrRecover.bind(inbox),
    markRecoveryRequired: inbox.markRecoveryRequired.bind(inbox),
    hasPending: inbox.hasPending.bind(inbox),
  };
}
