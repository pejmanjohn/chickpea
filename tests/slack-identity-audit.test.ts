import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditStoreLogic } from '../src/audit/store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

test('Slack identity audit events are allowlisted, idempotent, and content-free', async () => {
  const db = openStateDb(':memory:');
  const store = new AuditStoreLogic(db);
  try {
    const input = {
      eventId: 'audit_slack_identity_dm_2',
      domain: 'slack_identity' as const,
      eventType: 'slack_identity.dm_binding_changed',
      outcome: 'success' as const,
      actorClass: 'admin',
      actorId: 'request_admin_123',
      subjectId: 'slack_identity_default',
      subjectVersion: 2,
      createdAt: 1_800_000_000_000,
      metadataJson: JSON.stringify({
        operation: 'dm_binding_changed',
        priorLifecycle: 'connected',
        newLifecycle: 'connected',
        requestId: 'request_admin_123',
      }),
      idempotencyKey: 'slack_identity:slack_identity_default:dm_binding_changed:2:success',
    };

    const first = store.appendIdempotent(input);
    const replay = store.appendIdempotent({
      ...input,
      eventId: 'audit_slack_identity_dm_replay',
    });
    assert.equal(replay.eventId, first.eventId);
    assert.equal(store.list({ domain: 'slack_identity' }).length, 1);
    assert.doesNotMatch(JSON.stringify(first), /xox[bp]-|signing.secret|message text/i);

    await assert.rejects(
      async () => store.appendIdempotent({
        ...input,
        eventId: 'audit_slack_identity_bad_type',
        eventType: 'slack_identity.secret_dumped',
        idempotencyKey: 'slack_identity:bad-type',
      }),
      /allowlisted/i,
    );
    await assert.rejects(
      async () => store.appendIdempotent({
        ...input,
        eventId: 'audit_slack_identity_bad_shape',
        metadataJson: JSON.stringify({
          operation: 'dm_binding_changed',
          priorLifecycle: 'connected',
          newLifecycle: 'connected',
          requestId: 'request_admin_123',
          botToken: 'xoxb-must-not-appear',
        }),
        idempotencyKey: 'slack_identity:bad-shape',
      }),
      /metadata shape/i,
    );
  } finally {
    db.close();
  }
});

test('Slack identity retention clears only its actors at 30 days and events at 90 days', async () => {
  const now = 1_800_000_000_000;
  const db = openStateDb(':memory:');
  const store = new AuditStoreLogic(db);
  try {
    const append = (domain: 'slack_identity' | 'memory', ageDays: number, suffix: string) =>
      store.append({
        eventId: `audit_${suffix}`,
        domain,
        eventType: domain === 'slack_identity'
          ? 'slack_identity.refreshed'
          : 'memory.created',
        outcome: 'success',
        actorClass: 'admin',
        actorId: `actor_${suffix}`,
        subjectId: `subject_${suffix}`,
        subjectVersion: 1,
        createdAt: now - ageDays * DAY_MS,
        metadataJson: domain === 'slack_identity'
          ? JSON.stringify({
              operation: 'refreshed',
              priorLifecycle: 'connected',
              newLifecycle: 'connected',
              requestId: `request_${suffix}`,
            })
          : '{}',
        idempotencyKey: `audit:${suffix}`,
      });

    append('slack_identity', 31, 'identity_31d');
    append('slack_identity', 91, 'identity_91d');
    append('memory', 31, 'memory_31d');

    assert.equal(store.clearExpiredActorIdsForDomain('slack_identity', now - 30 * DAY_MS), 2);
    assert.equal(store.deleteBefore('slack_identity', now - 90 * DAY_MS), 1);
    const identityEvents = store.list({ domain: 'slack_identity' });
    assert.equal(identityEvents.length, 1);
    assert.equal(identityEvents[0]?.actorId, null);
    const memoryEvents = store.list({ domain: 'memory' });
    assert.equal(memoryEvents[0]?.actorId, 'actor_memory_31d');
  } finally {
    db.close();
  }
});
