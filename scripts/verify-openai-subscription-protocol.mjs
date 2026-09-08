import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  OPENAI_SUBSCRIPTION_ENDPOINTS,
  OPENAI_SUBSCRIPTION_MODELS,
  buildOpenAiSubscriptionHeaders,
  exchangeOpenAiDeviceAuthorization,
  pollOpenAiDeviceAuthorization,
  startOpenAiDeviceAuthorization,
} from '../src/openai-subscription/protocol.ts';

const live = process.argv.includes('--live');

if (!live) {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
  assert.equal(
    dependencyNames.some((name) => /codex|app-server/i.test(name)),
    false,
    'the direct adapter must not introduce a Codex/app-server dependency',
  );
  assert.equal(OPENAI_SUBSCRIPTION_ENDPOINTS.responses.startsWith('https://chatgpt.com/'), true);
  assert.equal(OPENAI_SUBSCRIPTION_MODELS.length > 0, true);
  console.log('[openai-subscription] offline protocol contract verified');
  process.exit(0);
}

const pending = await startOpenAiDeviceAuthorization();
console.log(`[openai-subscription] Open ${pending.verificationUri}`);
console.log(`[openai-subscription] Enter code: ${pending.userCode}`);
console.log('[openai-subscription] Waiting for authorization; no credentials will be written to disk.');

let approved;
while (Date.now() < pending.expiresAt) {
  await new Promise((resolve) => setTimeout(resolve, pending.intervalMs + 3000));
  const status = await pollOpenAiDeviceAuthorization(pending);
  if (status.state === 'approved') {
    approved = status;
    break;
  }
}
assert.ok(approved, 'device authorization expired before approval');

const tokens = await exchangeOpenAiDeviceAuthorization(approved);
const sessionId = randomUUID();
const response = await fetch(OPENAI_SUBSCRIPTION_ENDPOINTS.responses, {
  method: 'POST',
  redirect: 'manual',
  headers: buildOpenAiSubscriptionHeaders({
    accessToken: tokens.accessToken,
    accountId: tokens.accountId,
    sessionId,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
  }),
  body: JSON.stringify({
    model: process.env.OPENAI_SUBSCRIPTION_TEST_MODEL ?? OPENAI_SUBSCRIPTION_MODELS[0],
    instructions: 'Return exactly CHICKPEA_SUBSCRIPTION_OK and nothing else.',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Run the compatibility check.' }],
      },
    ],
    stream: true,
    store: false,
  }),
});
assert.equal(response.url.startsWith('https://chatgpt.com/'), true);
assert.equal(response.ok, true, `Codex Responses compatibility failed with HTTP ${response.status}`);
const body = await response.text();
assert.match(body, /CHICKPEA_SUBSCRIPTION_OK|response\.completed/);
console.log('[openai-subscription] live originator, device auth, and Responses compatibility verified');
