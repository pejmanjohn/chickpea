import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  slackBotIdentityInfo,
  slackIdentityAuthTest,
} from '../src/slack/credentials.ts';

test('bounded Slack identity helpers degrade when Slack never settles', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => new Promise<Response>(() => {});

    const startedAt = Date.now();
    const identity = await slackBotIdentityInfo('xoxb-timeout', 'U_BOT', { timeoutMs: 20 });
    assert.equal(identity.ok, false);
    assert.equal(identity.error, 'slack_request_timeout');
    assert.ok(Date.now() - startedAt < 250, 'deadline should bound a fetch that never settles');

    const auth = await slackIdentityAuthTest('xoxb-timeout', { timeoutMs: 20 });
    assert.equal(auth.ok, false);
    assert.equal(auth.error, 'slack_request_timeout');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
