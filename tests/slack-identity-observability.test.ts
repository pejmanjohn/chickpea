import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  recordSlackIdentityOperationalEvent,
} from '../src/slack/identity-observability.ts';
import { captureSlackIdentityOperationalEvents } from './helpers/slack-identity-observability.ts';

test('Slack identity operational events are structured, content-free, and searchable', async () => {
  const captured = await captureSlackIdentityOperationalEvents(() => {
    recordSlackIdentityOperationalEvent({
      operation: 'egress_unavailable',
      identityId: 'slack_identity_finance',
      appId: 'A0FINANCE',
      lifecycle: 'connected',
      outcome: 'operator_repair',
      failureClass: 'not_in_channel',
      fallbackPrevented: true,
      botToken: 'xoxb-must-not-appear',
      messageText: 'private Slack content must not appear',
    } as never);
  });

  assert.equal(captured.events.length, 1);
  assert.deepEqual(captured.events[0], {
    operation: 'egress_unavailable',
    identityId: 'slack_identity_finance',
    appId: 'A0FINANCE',
    lifecycle: 'connected',
    outcome: 'operator_repair',
    failureClass: 'not_in_channel',
    fallbackPrevented: true,
  });
  assert.doesNotMatch(captured.serialized, /xoxb-|private Slack content|botToken|messageText/);
});

test('Slack identity operational events replace unsafe metadata instead of logging it', async () => {
  const captured = await captureSlackIdentityOperationalEvents(() => {
    recordSlackIdentityOperationalEvent({
      operation: 'binding_rejected',
      identityId: 'slack_identity_finance\nsecret',
      appId: 'A0FINANCE<script>',
      lifecycle: 'connected',
      outcome: 'rejected',
      failureClass: 'workspace mismatch with content',
    });
  });

  assert.deepEqual(captured.events[0], {
    operation: 'binding_rejected',
    identityId: 'invalid_metadata',
    appId: 'invalid_metadata',
    lifecycle: 'connected',
    outcome: 'rejected',
    failureClass: 'invalid_metadata',
  });
});
