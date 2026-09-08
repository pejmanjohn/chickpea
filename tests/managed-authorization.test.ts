import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  beginManagedAuthorization,
  abandonManagedAuthorization,
  abandonStaleManagedAuthorization,
  finalizeManagedAuthorization,
  assertManagedAuthorizationProvider,
  inspectManagedAuthorization,
  inspectManagedAuthorizationForCleanup,
  inspectStaleManagedAuthorization,
  recordManagedAuthorizationAccount,
  recordManagedAuthorizationRequest,
} from '../src/connections/managed-authorization.ts';

const INPUT = {
  workspaceId: 'T_TEST',
  agentId: 'agent_support',
  actorMembershipId: 'membership_owner',
  ownerKind: 'team' as const,
  providerId: 'google',
  adapterId: 'composio',
  toolkit: 'gmail',
  label: 'Gmail',
  principalRef: 'chickpea:organization:org_test',
  allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
  bindingCapabilities: ['gmail.messages.search'],
  providerGeneration: 7,
  providerLineage: 'a'.repeat(24),
};
const MANAGED_AUTHORIZATION_TTL_MS = 30 * 60_000;
const MANAGED_AUTHORIZATION_STALE_GRACE_MS = 10 * 60_000;

test('managed authorization binds a browser secret to one active member attempt', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const started = await beginManagedAuthorization({
      settings,
      input: INPUT,
      now: () => 1_000,
      randomSecret: () => 'a'.repeat(64),
    });

    assert.equal(started.browserSecret, 'a'.repeat(64));
    const inspected = await inspectManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      now: () => 1_001,
    });
    assert.equal(inspected.status, 'pending');
    assert.equal(inspected.principalRef, INPUT.principalRef);
    assert.deepEqual(inspected.allowedCapabilities, INPUT.allowedCapabilities);
    assert.doesNotThrow(() => assertManagedAuthorizationProvider(inspected, {
      generation: 7,
      lineage: 'a'.repeat(24),
    }));
    assert.throws(
      () => assertManagedAuthorizationProvider(inspected, {
        generation: 8,
        lineage: 'b'.repeat(24),
      }),
      /stale managed authorization provider/,
    );

    await assert.rejects(
      beginManagedAuthorization({
        settings,
        input: { ...INPUT, toolkit: 'googlecalendar', label: 'Google Calendar' },
        now: () => 1_002,
        randomSecret: () => 'b'.repeat(64),
      }),
      /already in progress/,
    );
    assert.equal((await inspectManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      now: () => 1_003,
    })).toolkit, 'gmail');

    await assert.rejects(
      inspectManagedAuthorization({
        settings,
        actorMembershipId: INPUT.actorMembershipId,
        browserSecret: 'b'.repeat(64),
        now: () => 1_001,
      }),
      /invalid managed authorization attempt/,
    );
  } finally {
    settings.close();
  }
});

test('an unparseable stored attempt is preserved with a bounded reconciliation event', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => { errors.push(message); });
  try {
    const key = await authorizationSettingKey(INPUT.actorMembershipId);
    const malformed = JSON.stringify({
      version: 2,
      adapterId: 'composio',
      authorizationRef: 'ca_pending_upgrade',
      accountRef: 'ca_authorized_upgrade',
    });
    await settings.setSetting(key, malformed);

    await assert.rejects(
      beginManagedAuthorization({
        settings,
        input: INPUT,
        now: () => 1_500,
        randomSecret: () => 'b'.repeat(64),
      }),
      /requires operator recovery/,
    );
    assert.equal(await settings.getSetting(key), malformed);
    assert.deepEqual(errors.map((message) => JSON.parse(message)), [{
      event: 'chickpea.managed_connection.invalid_authorization_attempt_blocked',
      authorizationRef: 'ca_pending_upgrade',
      accountRef: 'ca_authorized_upgrade',
      adapterId: 'composio',
    }]);
  } finally {
    settings.close();
  }
});

test('managed authorization records the remote account before local finalization and is replay-safe', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const started = await beginManagedAuthorization({
      settings,
      input: INPUT,
      now: () => 2_000,
      randomSecret: () => 'c'.repeat(64),
    });
    await assert.rejects(
      recordManagedAuthorizationAccount({
        settings,
        actorMembershipId: INPUT.actorMembershipId,
        browserSecret: started.browserSecret,
        accountRef: 'ca_test',
        toolkit: 'gmail',
        now: () => 2_001,
      }),
      /replayed managed authorization attempt/,
    );
    await recordManagedAuthorizationRequest({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_test',
      now: () => 2_001,
    });
    const authorized = await recordManagedAuthorizationAccount({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      accountRef: 'ca_test',
      toolkit: 'gmail',
      now: () => 2_001,
    });
    assert.equal(authorized.status, 'authorized');
    assert.equal(authorized.accountRef, 'ca_test');

    const retried = await recordManagedAuthorizationAccount({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      accountRef: 'ca_test',
      toolkit: 'gmail',
      now: () => 2_002,
    });
    assert.equal(retried.status, 'authorized');
    await assert.rejects(
      recordManagedAuthorizationAccount({
        settings,
        actorMembershipId: INPUT.actorMembershipId,
        browserSecret: started.browserSecret,
        accountRef: 'ca_competing',
        toolkit: 'gmail',
        now: () => 2_002,
      }),
      /replayed managed authorization attempt/,
    );

    await finalizeManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      now: () => 2_002,
    });
    await assert.rejects(
      inspectManagedAuthorization({
        settings,
        actorMembershipId: INPUT.actorMembershipId,
        browserSecret: started.browserSecret,
        now: () => 2_003,
      }),
      /invalid managed authorization attempt/,
    );
  } finally {
    settings.close();
  }
});

test('a rejected remote redemption can abandon the exact attempt and unblock retry', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const started = await beginManagedAuthorization({
      settings,
      input: INPUT,
      now: () => 2_500,
      randomSecret: () => 'e'.repeat(64),
    });
    await abandonManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      now: () => 2_501,
    });
    const retried = await beginManagedAuthorization({
      settings,
      input: { ...INPUT, toolkit: 'googlecalendar', label: 'Google Calendar' },
      now: () => 2_502,
      randomSecret: () => 'f'.repeat(64),
    });
    assert.equal(retried.attempt.toolkit, 'googlecalendar');
  } finally {
    settings.close();
  }
});

test('managed reconnect attempts preserve bindings instead of carrying replacement capabilities', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const invalidSettings = new SqliteSettingsStore(':memory:');
  const { bindingCapabilities: _bindingCapabilities, ...reconnectInput } = INPUT;
  try {
    const started = await beginManagedAuthorization({
      settings,
      input: { ...reconnectInput, connectionAccountId: 'connection_existing' },
      now: () => 2_750,
      randomSecret: () => '7'.repeat(64),
    });
    assert.equal(started.attempt.bindingCapabilities, undefined);
    await assert.rejects(
      beginManagedAuthorization({
        settings: invalidSettings,
        input: {
          ...reconnectInput,
          connectionAccountId: 'connection_existing',
          bindingCapabilities: ['gmail.messages.search'],
        },
        now: () => 2_750,
        randomSecret: () => '8'.repeat(64),
      }),
      /managed authorization input is invalid/,
    );
  } finally {
    settings.close();
    invalidSettings.close();
  }
});

test('managed authorization rejects expiration and remote toolkit substitution', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const started = await beginManagedAuthorization({
      settings,
      input: INPUT,
      now: () => 3_000,
      randomSecret: () => 'd'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_drive',
      now: () => 3_001,
    });
    await assert.rejects(
      recordManagedAuthorizationAccount({
        settings,
        actorMembershipId: INPUT.actorMembershipId,
        browserSecret: started.browserSecret,
        accountRef: 'ca_drive',
        toolkit: 'googledrive',
        now: () => 3_001,
      }),
      /toolkit did not match/,
    );
    await assert.rejects(
      inspectManagedAuthorization({
        settings,
        actorMembershipId: INPUT.actorMembershipId,
        browserSecret: started.browserSecret,
        now: () => 3_000 + MANAGED_AUTHORIZATION_TTL_MS,
      }),
      /expired managed authorization attempt/,
    );
  } finally {
    settings.close();
  }
});

test('an expired authorized attempt remains browser-bound for remote cleanup', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const started = await beginManagedAuthorization({
      settings,
      input: INPUT,
      now: () => 4_000,
      randomSecret: () => '1'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_expired_cleanup',
      now: () => 4_001,
    });
    await recordManagedAuthorizationAccount({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      accountRef: 'ca_expired_cleanup',
      toolkit: 'gmail',
      now: () => 4_001,
    });
    const expiredAt = 4_000 + MANAGED_AUTHORIZATION_TTL_MS;
    const cleanup = await inspectManagedAuthorizationForCleanup({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      now: () => expiredAt,
    });
    assert.equal(cleanup.accountRef, 'ca_expired_cleanup');
    await assert.rejects(
      beginManagedAuthorization({
        settings,
        input: { ...INPUT, toolkit: 'googlecalendar', label: 'Google Calendar' },
        now: () => expiredAt,
        randomSecret: () => '2'.repeat(64),
      }),
      /already in progress/,
    );
    assert.equal((await inspectManagedAuthorizationForCleanup({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      now: () => expiredAt,
    })).accountRef, 'ca_expired_cleanup');
    await abandonManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      now: () => expiredAt,
      allowExpired: true,
    });
    await assert.rejects(
      inspectManagedAuthorizationForCleanup({
        settings,
        actorMembershipId: INPUT.actorMembershipId,
        browserSecret: started.browserSecret,
        now: () => expiredAt,
      }),
      /invalid managed authorization attempt/,
    );
  } finally {
    settings.close();
  }
});

test('an authorized attempt becomes server-recoverable only after the stale grace window', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const startedAt = 5_000;
    const started = await beginManagedAuthorization({
      settings,
      input: INPUT,
      now: () => startedAt,
      randomSecret: () => '3'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_stale_cleanup',
      now: () => startedAt + 1,
    });
    await recordManagedAuthorizationAccount({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      accountRef: 'ca_stale_cleanup',
      toolkit: 'gmail',
      now: () => startedAt + 1,
    });
    const expiresAt = startedAt + MANAGED_AUTHORIZATION_TTL_MS;
    assert.equal(await inspectStaleManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      now: () => expiresAt + MANAGED_AUTHORIZATION_STALE_GRACE_MS - 1,
    }), undefined);
    assert.equal((await inspectStaleManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      now: () => expiresAt + MANAGED_AUTHORIZATION_STALE_GRACE_MS,
    }))?.accountRef, 'ca_stale_cleanup');
    await abandonStaleManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      now: () => expiresAt + MANAGED_AUTHORIZATION_STALE_GRACE_MS,
    });
    await abandonStaleManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      now: () => expiresAt + MANAGED_AUTHORIZATION_STALE_GRACE_MS,
    });
    assert.equal(await inspectStaleManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      now: () => expiresAt + MANAGED_AUTHORIZATION_STALE_GRACE_MS,
    }), undefined);
  } finally {
    settings.close();
  }
});

test('a pending Connect Link with a remote reference cannot be overwritten before stale cleanup', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const startedAt = 6_000;
    const started = await beginManagedAuthorization({
      settings,
      input: INPUT,
      now: () => startedAt,
      randomSecret: () => '4'.repeat(64),
    });
    await recordManagedAuthorizationRequest({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      browserSecret: started.browserSecret,
      authorizationRef: 'ca_pending_cleanup',
      now: () => startedAt + 1,
    });
    const expiresAt = startedAt + MANAGED_AUTHORIZATION_TTL_MS;
    await assert.rejects(
      beginManagedAuthorization({
        settings,
        input: { ...INPUT, toolkit: 'googlecalendar', label: 'Google Calendar' },
        now: () => expiresAt,
        randomSecret: () => '5'.repeat(64),
      }),
      /already in progress/,
    );
    assert.equal(await inspectStaleManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      now: () => expiresAt + MANAGED_AUTHORIZATION_STALE_GRACE_MS - 1,
    }), undefined);
    assert.equal((await inspectStaleManagedAuthorization({
      settings,
      actorMembershipId: INPUT.actorMembershipId,
      now: () => expiresAt + MANAGED_AUTHORIZATION_STALE_GRACE_MS,
    }))?.authorizationRef, 'ca_pending_cleanup');
  } finally {
    settings.close();
  }
});

async function authorizationSettingKey(actorMembershipId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(actorMembershipId),
  ));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `connections.managed.authorization.${hex.slice(0, 32)}`;
}
