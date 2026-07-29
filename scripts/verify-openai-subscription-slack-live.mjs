#!/usr/bin/env node
/**
 * Opt-in live acceptance check for Chickpea's signed Slack-event path using a
 * previously authorized Node settings database. Slack is a loopback fake, but
 * the selected profile, provider routing, ChatGPT request, and final Slack
 * delivery are the real product path.
 *
 * The temporary state database receives only the credential-boundary settings
 * needed for this run and is deleted on exit. No token, account id, prompt, or
 * model output is printed. An intentionally invalid Platform key and a network
 * allowlist make any API-billing fallback fail closed.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  assertNodeVersion,
  buildNodeServer,
  getFreePort,
  loadFake,
  loadTsModule,
  postSignedEvent,
  seedOfflineDemoChannelConfig,
  spawnServer,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const EXPECTED_MARKER = 'CHICKPEA_SLACK_SUBSCRIPTION_OK';
const APP_MENTION_FIXTURE = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'app-mention.json'), 'utf8'),
);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value?.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(value, next);
    index += 1;
  } else {
    args.set(value, true);
  }
}

if (args.has('--help')) {
  console.log(
    'Usage: npm run verify:openai-subscription-slack:live -- --live --source-state-db <path>',
  );
  console.log(
    'Uses fake Slack, calls the real ChatGPT subscription endpoint, and consumes subscription quota.',
  );
  process.exit(0);
}

assert.equal(args.has('--live'), true, 'refusing model traffic without the explicit --live flag');
const sourceStatePath = String(args.get('--source-state-db') ?? '');
assert.ok(sourceStatePath, '--source-state-db is required');
assert.equal(existsSync(sourceStatePath), true, 'authorized source settings database not found');
assert.equal(
  process.env.TAG_OPENAI_SUBSCRIPTION_ENABLED,
  '1',
  'TAG_OPENAI_SUBSCRIPTION_ENABLED must be exactly 1',
);

const guardDir = mkdtempSync(join(tmpdir(), 'chickpea-subscription-slack-live-'));
const stateDbPath = join(guardDir, 'state.db');
const netGuardLog = join(guardDir, 'external-hosts.log');
let backend;
let spawned;

try {
  await seedOfflineDemoChannelConfig(stateDbPath);

  const [{ SqliteConfigStore }, { SqliteSettingsStore }, { openAiSubscriptionSettingKeys }] =
    await Promise.all([
      loadTsModule('src/config/store.ts'),
      loadTsModule('src/config/settings-store.ts'),
      loadTsModule('src/openai-subscription/credentials.ts'),
    ]);

  const config = new SqliteConfigStore(stateDbPath);
  const sourceSettings = new SqliteSettingsStore(sourceStatePath);
  const targetSettings = new SqliteSettingsStore(stateDbPath);
  try {
    await config.updateAgent('agent_default', {
      instructions: `For this compatibility check, return exactly ${EXPECTED_MARKER} and nothing else.`,
      model: 'openai/gpt-5.3-codex-spark',
      openaiAuthMethod: 'subscription',
    });

    const keys = openAiSubscriptionSettingKeys();
    const boundaryKeys = [keys.tokens, keys.identityKey, keys.status];
    const boundaryValues = await sourceSettings.getSettings(boundaryKeys);
    assert.equal(
      boundaryValues.every((value) => typeof value === 'string' && value.length > 0),
      true,
      'source database does not contain a complete connected subscription credential',
    );
    await targetSettings.applySettingsPatch({
      set: boundaryKeys.map((key, index) => ({ key, value: boundaryValues[index] })),
      delete: [keys.pending, keys.refreshLease],
    });
  } finally {
    config.close();
    sourceSettings.close();
    targetSettings.close();
  }

  const { FakeSlackBackend } = await loadFake();
  backend = new FakeSlackBackend({ provider: { mode: 'ok' } });
  const fake = await backend.listen();
  const serverEntry = await buildNodeServer();
  const port = await getFreePort();
  spawned = spawnServer({
    serverEntry,
    port,
    fakeUrl: fake.url,
    netGuardLog,
    env: {
      TAG_DB_PATH: ':memory:',
      SLACK_STATE_DB_PATH: stateDbPath,
      TAG_AGENT_API_TOKEN: 'subscription-slack-live-internal-token',
      TAG_OPENAI_SUBSCRIPTION_ENABLED: '1',
      OPENAI_API_KEY: 'sk-chickpea-intentionally-invalid-no-fallback',
      NET_GUARD_ALLOW: 'chatgpt.com,auth.openai.com',
    },
  });

  await waitForReady(spawned.child, spawned.eventsUrl, spawned.getOutput);
  const event = structuredClone(APP_MENTION_FIXTURE);
  event.event.text = `<@U_BOT> Return exactly ${EXPECTED_MARKER} and nothing else.`;
  const accepted = await postSignedEvent(spawned.eventsUrl, event);
  assert.equal(accepted.status, 200, 'signed Slack event was not accepted');

  const finals = await waitForFinals(backend, 1, 90_000);
  const finalText = finals.at(-1)?.text ?? '';
  assert.match(finalText, new RegExp(EXPECTED_MARKER), 'real subscription reply was not delivered');
  assert.equal(finalText.includes('STUB_REPLY'), false, 'fake provider answered instead of ChatGPT');
  assert.equal(
    finalText.startsWith('I reached the Slack thread'),
    false,
    'sanitized provider failure was delivered instead of the model response',
  );

  const blocked = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  const allowed = existsSync(`${netGuardLog}.allowed`)
    ? readFileSync(`${netGuardLog}.allowed`, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  assert.equal(blocked, '', 'the product attempted an unexpected external request');
  assert.equal(allowed.includes('chatgpt.com'), true, 'no ChatGPT subscription request was observed');
  assert.equal(allowed.includes('api.openai.com'), false, 'Platform API fallback was observed');
  assert.equal(
    allowed.every((host) => host === 'chatgpt.com' || host === 'auth.openai.com'),
    true,
    'the subscription turn contacted an unexpected external host',
  );

  console.log(JSON.stringify({
    ok: true,
    surface: 'signed_slack_event',
    providerAuthRoute: 'openai_subscription',
    delivery: 'fake_slack',
    destination: 'chatgpt.com',
    apiFallbackObserved: false,
    finalChars: finalText.length,
    node: assertNodeVersion(),
  }));
} finally {
  if (spawned) await stopChild(spawned.child);
  if (backend) await backend.close();
  rmSync(guardDir, { recursive: true, force: true });
}
