import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Composio } from '@composio/core';

import { verifyComposioWebhook } from '../src/connections/composio-webhook.ts';

async function signature(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(message),
  ));
  return Buffer.from(bytes).toString('base64');
}

test('Composio expired-account webhooks require the raw signed body and return a narrow lifecycle event', async () => {
  const now = 1_800_000_000_000;
  const timestamp = String(now / 1_000);
  const webhookId = 'msg_test';
  const eventId = 'evt_test';
  const secret = 'whsec_test';
  const body = JSON.stringify({
    id: eventId,
    timestamp: new Date(now).toISOString(),
    type: 'composio.connected_account.expired',
    metadata: { project_id: 'project_test', org_id: 'org_test' },
    data: {
      id: 'ca_expired', user_id: 'chickpea:membership:member_test', status: 'EXPIRED',
      toolkit: { slug: 'GMAIL' }, auth_config: {}, state: {}, data: {}, params: {},
      created_at: new Date(now - 1_000).toISOString(), updated_at: new Date(now).toISOString(),
      status_reason: 'refresh_failed', is_disabled: false,
    },
  });
  const signed = await signature(secret, `${webhookId}.${timestamp}.${body}`);

  assert.deepEqual(await verifyComposioWebhook({
    rawBody: body,
    webhookId,
    webhookTimestamp: timestamp,
    webhookSignature: `v1,wrong v1,${signed}`,
    secret,
    now: () => now,
  }), { kind: 'expired_account', accountRef: 'ca_expired', toolkit: 'gmail' });

  await assert.rejects(
    verifyComposioWebhook({
      rawBody: `${body} `,
      webhookId,
      webhookTimestamp: timestamp,
      webhookSignature: `v1,${signed}`,
      secret,
      now: () => now,
    }),
    /signature is invalid/,
  );
});

test('Composio webhooks reject stale timestamps', async () => {
  const now = 1_800_000_000_000;
  const timestamp = String(now / 1_000 - 301);
  const body = JSON.stringify({
    id: 'msg_test', timestamp: new Date(now).toISOString(),
    type: 'composio.trigger.message', metadata: {}, data: {},
  });
  const signed = await signature('secret', `msg_test.${timestamp}.${body}`);
  await assert.rejects(
    verifyComposioWebhook({
      rawBody: body, webhookId: 'msg_test', webhookTimestamp: timestamp,
      webhookSignature: `v1,${signed}`, secret: 'secret', now: () => now,
    }),
    /timestamp is invalid/,
  );
});

test('signed Composio event types outside Chickpea expiry handling are acknowledged', async () => {
  const now = 1_800_000_000_000;
  const timestamp = String(now / 1_000);
  const webhookId = 'msg_trigger_test';
  const body = JSON.stringify({
    id: 'evt_trigger_test', timestamp: new Date(now).toISOString(),
    type: 'composio.trigger.message', metadata: {}, data: {},
  });
  const signed = await signature('secret', `${webhookId}.${timestamp}.${body}`);

  assert.deepEqual(await verifyComposioWebhook({
    rawBody: body, webhookId, webhookTimestamp: timestamp,
    webhookSignature: `v1,${signed}`, secret: 'secret', now: () => now,
  }), { kind: 'ignored', type: 'composio.trigger.message' });
});

test('webhook secret derivation matches the official Composio SDK', async () => {
  const now = 1_800_000_000_000;
  const timestamp = String(now / 1_000);
  const webhookId = 'msg_sdk_conformance';
  // Deliberately looks encoded: Composio's SDK treats the complete dashboard
  // value as the raw UTF-8 HMAC key, including the whsec_ prefix.
  const secret = 'whsec_dGVzdC1rZXk=';
  const body = JSON.stringify({
    id: 'evt_sdk_conformance',
    timestamp: new Date(now).toISOString(),
    type: 'composio.connected_account.expired',
    metadata: { project_id: 'project_test', org_id: 'org_test' },
    data: {
      id: 'ca_sdk_conformance', user_id: 'chickpea:membership:member_test', status: 'EXPIRED',
      toolkit: { slug: 'gmail' }, auth_config: {}, state: {}, data: {}, params: {},
      created_at: new Date(now - 1_000).toISOString(), updated_at: new Date(now).toISOString(),
      status_reason: 'refresh_failed', is_disabled: false,
    },
  });
  const signed = await signature(secret, `${webhookId}.${timestamp}.${body}`);
  const composio = new Composio({ apiKey: 'test-key', allowTracking: false });

  const sdkResult = await composio.triggers.verifyWebhook({
    id: webhookId,
    timestamp,
    payload: body,
    signature: `v1,${signed}`,
    secret,
    tolerance: 0,
  });
  assert.equal(sdkResult.version, 'V3');
  assert.equal(
    'id' in sdkResult.rawPayload ? sdkResult.rawPayload.id : undefined,
    'evt_sdk_conformance',
  );
  assert.deepEqual(await verifyComposioWebhook({
    rawBody: body,
    webhookId,
    webhookTimestamp: timestamp,
    webhookSignature: `v1,${signed}`,
    secret,
    now: () => now,
  }), { kind: 'expired_account', accountRef: 'ca_sdk_conformance', toolkit: 'gmail' });
});
