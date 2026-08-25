import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  GatewayInboxCapacityError,
  GatewayInboxStoreLogic,
} from '../src/slack/gateway/inbox.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { GatewayEventDelivery } from '../src/slack/gateway/protocol.ts';

const NOW = 1_777_000_000_000;

test('gateway inbox keeps an accepted pending event claimable after close and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-gateway-inbox-'));
  const path = join(directory, 'state.db');
  let db: ReturnType<typeof openStateDb> | undefined = openStateDb(path);
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => NOW);
    const first = eventDelivery('delivery:Ev_RETRY', 'first body');

    assert.equal(inbox.admit(first), 'accepted');
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_RETRY', 'changed retry body')), 'duplicate');

    db.close();
    db = undefined;

    db = openStateDb(path);
    const reopened = new GatewayInboxStoreLogic(db, () => NOW);
    const row = db.get(
      'SELECT payload_json, status, attempts FROM gateway_inbox WHERE id = ?',
      first.deliveryId,
    );
    assert.match(String(row?.payload_json), /first body/);
    assert.doesNotMatch(String(row?.payload_json), /changed retry body/);
    assert.equal(row?.status, 'pending');
    assert.equal(row?.attempts, 0);
    const claimed = reopened.claimPending(1);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.id, first.deliveryId);
    assert.equal(claimed[0]?.delivery.kind, 'event.deliver');
    if (claimed[0]?.delivery.kind !== 'event.deliver') assert.fail('expected event delivery');
    const claimedEvent = claimed[0].delivery.envelope.event;
    assert.equal(claimedEvent.type, 'app_mention');
    if (claimedEvent.type !== 'app_mention') assert.fail('expected app mention');
    assert.equal(claimedEvent.text, 'first body');
    assert.equal(claimed[0]?.attempts, 1);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gateway inbox enforces row capacity before accepting another body', () => {
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => NOW, {
      maxActiveRows: 1,
      maxActiveBytes: 1_048_576,
    });
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_ONE', 'first')), 'accepted');
    assert.throws(
      () => inbox.admit(eventDelivery('delivery:Ev_TWO', 'second')),
      GatewayInboxCapacityError,
    );
    assert.equal(db.get('SELECT COUNT(*) AS count FROM gateway_inbox')?.count, 1);
  } finally {
    db.close();
  }
});

test('gateway inbox rejects an over-budget body without evicting accepted pending work', () => {
  const db = openStateDb(':memory:');
  try {
    const first = eventDelivery('delivery:Ev_ONE', 'first');
    const firstBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
    const inbox = new GatewayInboxStoreLogic(db, () => NOW, {
      maxActiveRows: 2,
      maxActiveBytes: firstBytes,
      maxInFlight: 2,
    });
    assert.equal(inbox.admit(first), 'accepted');
    assert.throws(
      () => inbox.admit(eventDelivery('delivery:Ev_TWO', 'second')),
      GatewayInboxCapacityError,
    );
    const retained = db.get(
      'SELECT payload_json, status FROM gateway_inbox WHERE id = ?',
      first.deliveryId,
    );
    assert.match(String(retained?.payload_json), /first/);
    assert.equal(retained?.status, 'pending');
  } finally {
    db.close();
  }
});

test('gateway inbox bounds in-flight work, scrubs completion, and retains dedup identity', () => {
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => NOW, { maxInFlight: 1 });
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_ONE', 'first')), 'accepted');
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_TWO', 'second')), 'accepted');

    const claimed = inbox.claimPending(10);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.attempts, 1);
    assert.equal(inbox.complete(claimed[0]!.id), true);

    const completed = db.get(
      'SELECT payload_json, payload_bytes, status FROM gateway_inbox WHERE id = ?',
      claimed[0]!.id,
    );
    assert.equal(completed?.payload_json, null);
    assert.equal(completed?.payload_bytes, 0);
    assert.equal(completed?.status, 'completed');
    assert.equal(inbox.admit(eventDelivery(claimed[0]!.id, 'late retry')), 'duplicate');
  } finally {
    db.close();
  }
});

test('gateway inbox bounds attempts and scrubs recovery-required bodies', () => {
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => NOW, { maxAttempts: 2 });
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_FAIL', 'sensitive')), 'accepted');
    const first = inbox.claimPending(1)[0]!;
    assert.equal(inbox.retryOrRecover(first.id, 'transient_failure'), 'pending');
    const second = inbox.claimPending(1)[0]!;
    assert.equal(inbox.retryOrRecover(second.id, 'transient_failure'), 'recovery_required');

    const row = db.get(
      'SELECT payload_json, payload_bytes, status, recovery_reason FROM gateway_inbox WHERE id = ?',
      second.id,
    );
    assert.equal(row?.payload_json, null);
    assert.equal(row?.payload_bytes, 0);
    assert.equal(row?.status, 'recovery_required');
    assert.equal(row?.recovery_reason, 'transient_failure');
  } finally {
    db.close();
  }
});

test('gateway inbox ages abandoned accepted work into body-free recovery state', () => {
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => now, { maxActiveAgeMs: 1_000 });
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_STALE', 'sensitive')), 'accepted');
    now += 1_001;
    assert.equal(inbox.maintain().agedToRecovery, 1);

    const row = db.get(
      'SELECT payload_json, status, recovery_reason FROM gateway_inbox WHERE id = ?',
      'delivery:Ev_STALE',
    );
    assert.equal(row?.payload_json, null);
    assert.equal(row?.status, 'recovery_required');
    assert.equal(row?.recovery_reason, 'active_age_exceeded');
  } finally {
    db.close();
  }
});

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
