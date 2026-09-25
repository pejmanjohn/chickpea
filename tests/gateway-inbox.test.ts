import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  GATEWAY_INBOX_ORPHAN_GRACE_MS,
  GatewayInboxCapacityError,
  GatewayInboxStoreLogic,
  gatewayDeliveryRetryDelayMs,
} from '../src/slack/gateway/inbox.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type {
  GatewayEventDelivery,
  GatewayPrivateChannelSetupDelivery,
} from '../src/slack/gateway/protocol.ts';

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

test('gateway inbox durably carries setup coordinates and scrubs them on completion', () => {
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => NOW);
    const delivery = setupDelivery('setup_delivery');
    assert.equal(inbox.admit(delivery), 'accepted');
    assert.equal(inbox.admit({ ...delivery, agentId: null }), 'duplicate');
    const [claimed] = inbox.claimPending(1);
    assert.equal(claimed?.delivery.kind, 'interaction.channel_agent_add');
    assert.deepEqual(claimed?.delivery, delivery);
    assert.equal(inbox.complete(delivery.deliveryId), true);
    assert.equal(db.get(
      'SELECT payload_json FROM gateway_inbox WHERE id = ?',
      delivery.deliveryId,
    )?.payload_json, null);
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

test('unexpired terminal tombstones are never evicted to admit a new delivery', () => {
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => now, {
      maxTotalRows: 2,
      maxActiveRows: 2,
      maxInFlight: 2,
      dedupRetentionMs: 1_000,
    });
    for (const id of ['delivery:Ev_OLD', 'delivery:Ev_RECENT']) {
      assert.equal(inbox.admit(eventDelivery(id, id)), 'accepted');
      assert.equal(inbox.complete(inbox.claimPending(1)[0]!.id), true);
    }

    assert.throws(
      () => inbox.admit(eventDelivery('delivery:Ev_NEW', 'new body')),
      GatewayInboxCapacityError,
    );
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_RECENT', 'retry body')), 'duplicate');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM gateway_inbox')?.count, 2);

    now += 1_000;
    assert.equal(inbox.maintain().tombstonesPurged, 0);
    now += 1;
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_NEW', 'new body')), 'accepted');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM gateway_inbox')?.count, 1);
    const active = db.get(
      "SELECT status, payload_json FROM gateway_inbox WHERE id = 'delivery:Ev_NEW'",
    );
    assert.equal(active?.status, 'pending');
    assert.match(String(active?.payload_json), /new body/);
  } finally {
    db.close();
  }
});

test('completed delivery identity remains body-free and deduplicates for 48 hours', () => {
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => now);
    const id = 'delivery:Ev_DELAYED_RETRY';
    assert.equal(inbox.admit(eventDelivery(id, 'sensitive body')), 'accepted');
    assert.equal(inbox.complete(inbox.claimPending(1)[0]!.id), true);
    assert.equal(db.get(
      'SELECT payload_json FROM gateway_inbox WHERE id = ?',
      id,
    )?.payload_json, null);

    now += 24 * 60 * 60_000 + 1;
    assert.equal(inbox.admit(eventDelivery(id, 'retry after one day')), 'duplicate');
    now = NOW + 48 * 60 * 60_000;
    assert.equal(inbox.maintain().tombstonesPurged, 0);
    assert.equal(inbox.admit(eventDelivery(id, 'retry at boundary')), 'duplicate');
    now += 1;
    assert.equal(inbox.maintain().tombstonesPurged, 1);
    assert.equal(inbox.admit(eventDelivery(id, 'new after expiry')), 'accepted');
  } finally {
    db.close();
  }
});

test('gateway inbox bounds attempts and scrubs recovery-required bodies', () => {
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => now, {
      maxAttempts: 2,
      dedupRetentionMs: 1_000,
    });
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

    now += 1_000;
    assert.equal(inbox.maintain().tombstonesPurged, 0);
    assert.equal(inbox.admit(eventDelivery(second.id, 'retry at boundary')), 'duplicate');
    now += 1;
    assert.equal(inbox.maintain().tombstonesPurged, 1);
    assert.equal(inbox.admit(eventDelivery(second.id, 'new after expiry')), 'accepted');
  } finally {
    db.close();
  }
});

test('a rate-limited delivery backs off without blocking later deliveries', () => {
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => now);
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_LIMITED', 'first')), 'accepted');
    now += 1;
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_NEXT', 'second')), 'accepted');
    const limited = inbox.claimPending(1)[0]!;
    assert.equal(limited.id, 'delivery:Ev_LIMITED');
    const rateLimited = new SlackTransportError('users.info', 'gateway_rate_limited', {
      retryable: true, effectOutcome: 'failed',
    });
    const delay = gatewayDeliveryRetryDelayMs(limited.attempts, rateLimited);
    assert.equal(delay, 5_000);
    assert.equal(inbox.retryOrRecover(limited.id, 'delivery_processing_failed', delay), 'pending');
    // Ev_NEXT is due now; the limited row reports its due time for the wake.
    assert.equal(inbox.hasPending(), true);
    assert.equal(inbox.nextPendingDueAt(), now + 5_000);

    // The later delivery is claimable; the limited one waits out its delay.
    assert.deepEqual(inbox.claimPending(16).map((item) => item.id), ['delivery:Ev_NEXT']);
    inbox.complete('delivery:Ev_NEXT');
    now += 4_999;
    assert.equal(inbox.hasPending(), false, 'only a backing-off row remains: nothing to poll');
    assert.equal(inbox.nextPendingDueAt(), now + 1);
    assert.deepEqual(inbox.claimPending(16), []);
    now += 1;
    assert.equal(inbox.hasPending(), true);
    assert.equal(inbox.nextPendingDueAt(), undefined);
    const retried = inbox.claimPending(16);
    assert.deepEqual(retried.map((item) => item.id), ['delivery:Ev_LIMITED']);
    assert.equal(retried[0]?.attempts, 2);
  } finally {
    db.close();
  }
});

test('gateway delivery retry delay backs off only retryable dependency failures', () => {
  const limited = new SlackTransportError('users.info', 'gateway_rate_limited', { retryable: true });
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => gatewayDeliveryRetryDelayMs(attempt, limited)),
    [5_000, 10_000, 20_000, 40_000, 60_000]);
  const hinted = new SlackTransportError('users.info', 'gateway_rate_limited', {
    retryable: true, retryAfterMs: 30_000,
  });
  assert.equal(gatewayDeliveryRetryDelayMs(1, hinted), 30_000);
  const longHint = new SlackTransportError('users.info', 'ratelimited', {
    retryable: true, retryAfterMs: 600_000,
  });
  assert.equal(gatewayDeliveryRetryDelayMs(1, longHint), 60_000);
  // A Durable Object disconnect marks itself retryable.
  assert.equal(gatewayDeliveryRetryDelayMs(1, Object.assign(new Error('reset'), { retryable: true })), 5_000);
  assert.equal(gatewayDeliveryRetryDelayMs(1, new SlackTransportError('users.info', 'user_not_found', {
    retryable: false,
  })), 0);
  assert.equal(gatewayDeliveryRetryDelayMs(1, new Error('bug')), 0);
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

test('gateway inbox reclaims expired leases and scrubs the body at the attempt cap', () => {
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => now, {
      maxAttempts: 2,
      leaseMs: 100,
    });
    assert.equal(inbox.admit(eventDelivery('delivery:Ev_LEASE', 'sensitive')), 'accepted');
    assert.equal(inbox.claimPending(1)[0]?.attempts, 1);

    now += 101;
    assert.equal(inbox.maintain().expiredLeasesRecovered, 1);
    const reclaimed = db.get(
      "SELECT status, payload_json FROM gateway_inbox WHERE id = 'delivery:Ev_LEASE'",
    );
    assert.equal(reclaimed?.status, 'pending');
    assert.match(String(reclaimed?.payload_json), /sensitive/);
    assert.equal(inbox.claimPending(1)[0]?.attempts, 2);

    now += 101;
    assert.equal(inbox.maintain().agedToRecovery, 1);
    const capped = db.get(
      "SELECT status, payload_json, payload_bytes, recovery_reason FROM gateway_inbox WHERE id = 'delivery:Ev_LEASE'",
    );
    assert.equal(capped?.status, 'recovery_required');
    assert.equal(capped?.payload_json, null);
    assert.equal(capped?.payload_bytes, 0);
    assert.equal(capped?.recovery_reason, 'attempt_limit_exceeded');
  } finally {
    db.close();
  }
});

test('a lease held by a replaced drainer is reclaimed after 10 s, not after the lease time', () => {
  // Before: a state store reset left the delivery leased for the full 2 min
  // (Amber run 3: receipt to admission 121 s). Now the next instance
  // reclaims it once the claim is 10 s old (one overlapping network call of
  // the replaced instance), on its first drain after that.
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const before = new GatewayInboxStoreLogic(db, () => now, {}, { leaseOwner: 'instance-a' });
    assert.equal(before.admit(eventDelivery('delivery:Ev_RESET', 'body')), 'accepted');
    assert.equal(before.claimPending(1)[0]?.attempts, 1);
    // The instance is replaced mid-delivery: its drain never completes.
    const after = new GatewayInboxStoreLogic(db, () => now, {}, { leaseOwner: 'instance-b' });
    assert.equal(after.hasOrphanedLease(), true, 'the fresh instance wakes for it at once');
    now += GATEWAY_INBOX_ORPHAN_GRACE_MS - 1;
    assert.equal(after.claimPending(1).length, 0, 'a claim under 10 s old is left to its call');
    now += 1;
    const reclaimed = after.claimPending(1);
    assert.equal(reclaimed.length, 1, 'claimable 10 000 ms after the claim');
    assert.equal(reclaimed[0]?.attempts, 2, 'the interrupted claim still counts as an attempt');
    assert.equal(db.get("SELECT recovery_reason AS r FROM gateway_inbox")?.r, 'lease_orphaned');
    assert.equal(after.hasOrphanedLease(), false);
    // The legacy time-only store (no owner) would still be waiting.
    const legacy = openStateDb(':memory:');
    try {
      const a = new GatewayInboxStoreLogic(legacy, () => NOW);
      a.admit(eventDelivery('delivery:Ev_RESET', 'body'));
      a.claimPending(1);
      assert.equal(new GatewayInboxStoreLogic(legacy, () => NOW + 119_999).claimPending(1).length, 0);
      assert.equal(new GatewayInboxStoreLogic(legacy, () => NOW + 120_000).claimPending(1).length, 1);
    } finally {
      legacy.close();
    }
  } finally {
    db.close();
  }
});

test('a live drainer keeps its own lease: a delivery is never claimed twice', () => {
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const inbox = new GatewayInboxStoreLogic(db, () => now, { leaseMs: 1_000 }, { leaseOwner: 'instance-a' });
    inbox.admit(eventDelivery('delivery:Ev_LIVE', 'body'));
    assert.equal(inbox.claimPending(1).length, 1);
    now += 999;
    assert.equal(inbox.maintain().orphanedLeasesRecovered, 0);
    assert.equal(inbox.claimPending(1).length, 0, 'the same instance does not reclaim its live lease');
    assert.equal(inbox.hasOrphanedLease(), false);
    assert.equal(inbox.complete('delivery:Ev_LIVE'), true);
    // A completed delivery stays completed for a later instance too.
    const next = new GatewayInboxStoreLogic(db, () => now, {}, { leaseOwner: 'instance-b' });
    assert.equal(next.claimPending(1).length, 0);
    assert.equal(next.admit(eventDelivery('delivery:Ev_LIVE', 'body')), 'duplicate');
  } finally {
    db.close();
  }
});

test('a lease from before owners were recorded, or at the attempt cap, follows the same rules', () => {
  const db = openStateDb(':memory:');
  try {
    const old = new GatewayInboxStoreLogic(db, () => NOW, { maxAttempts: 2 });
    old.admit(eventDelivery('delivery:Ev_OLD', 'first'));
    old.admit(eventDelivery('delivery:Ev_CAP', 'second'));
    old.claimPending(2);
    db.run("UPDATE gateway_inbox SET attempts = 2 WHERE id = 'delivery:Ev_CAP'");
    const current = new GatewayInboxStoreLogic(
      db, () => NOW + GATEWAY_INBOX_ORPHAN_GRACE_MS, { maxAttempts: 2 }, { leaseOwner: 'instance-b' },
    );
    const result = current.maintain();
    assert.equal(result.orphanedLeasesRecovered, 1, 'an owner-less in-flight lease is orphaned');
    assert.equal(result.agedToRecovery, 1, 'an orphan at the attempt cap is parked, not retried');
    const capped = db.get(
      "SELECT status, payload_json, recovery_reason FROM gateway_inbox WHERE id = 'delivery:Ev_CAP'",
    );
    assert.equal(capped?.status, 'recovery_required');
    assert.equal(capped?.payload_json, null);
    assert.equal(capped?.recovery_reason, 'attempt_limit_exceeded');
    assert.deepEqual(current.claimPending(2).map((item) => item.id), ['delivery:Ev_OLD']);
  } finally {
    db.close();
  }
});

test('a retry backoff and an orphaned lease stay distinct states across a reset', () => {
  let now = NOW;
  const db = openStateDb(':memory:');
  try {
    const before = new GatewayInboxStoreLogic(db, () => now, {}, { leaseOwner: 'instance-a' });
    before.admit(eventDelivery('delivery:Ev_BACKOFF', 'rate limited'));
    before.admit(eventDelivery('delivery:Ev_ORPHAN', 'in flight'));
    assert.equal(before.claimPending(2).length, 2);
    // One delivery hit a rate limit and backs off 10 s; the other is still
    // in flight when the instance is replaced.
    assert.equal(before.retryOrRecover('delivery:Ev_BACKOFF', 'delivery_dependency_retryable', 40_000), 'pending');
    const after = new GatewayInboxStoreLogic(db, () => now, {}, { leaseOwner: 'instance-b' });
    assert.equal(after.hasOrphanedLease(), true);
    now += GATEWAY_INBOX_ORPHAN_GRACE_MS;
    assert.deepEqual(after.claimPending(2).map((item) => item.id), ['delivery:Ev_ORPHAN'],
      'the orphan is reclaimed; the backoff is kept, not cut short by the reset');
    assert.equal(after.nextPendingDueAt(), NOW + 40_000);
    const backoff = db.get("SELECT status, lease_until, recovery_reason FROM gateway_inbox WHERE id = 'delivery:Ev_BACKOFF'");
    assert.equal(backoff?.status, 'pending');
    assert.equal(backoff?.lease_until, NOW + 40_000);
    assert.equal(backoff?.recovery_reason, 'delivery_dependency_retryable');
    now = NOW + 40_000;
    assert.deepEqual(after.claimPending(2).map((item) => item.id), ['delivery:Ev_BACKOFF']);
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

function setupDelivery(deliveryId: string): GatewayPrivateChannelSetupDelivery {
  return {
    protocolVersion: 1,
    kind: 'interaction.channel_agent_add',
    deliveryId,
    bindingId: 'binding_test',
    workspaceId: 'T_TEST',
    userId: 'U_TEST',
    channelId: 'C_PRIVATE',
    setupId: '019f12cc-87e1-7000-8123-123456789abc',
    agentId: 'agent_support',
  };
}
