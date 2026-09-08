#!/usr/bin/env node
/**
 * Offline multi-provider verification through Flue's registry.
 *
 * The SAME signed app_mention fixture is answered through every current
 * API-backed provider route in the built app. The only ingress is the same
 * signed Slack channel used in production; Flue 2 has no mounted direct-agent
 * HTTP route.
 *
 * This offline harness intentionally runs against local fake provider
 * endpoints, and every corresponding assertion is explicitly labeled STUB.
 *
 * Offline and net-guarded. Assertion summaries are printed to stdout; the
 * harness does not write repository artifacts.
 *
 * Run with Node 24.x (see .nvmrc):
 *   node scripts/verify-providers.mjs
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  assertNodeVersion,
  buildNodeServer,
  getFreePort,
  loadFake,
  postSignedEvent,
  seedOfflineDemoChannelConfig,
  seedOfflineSlackAuthority,
  spawnServer,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const APP_MENTION = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'app-mention.json'), 'utf8'));

const ANTHROPIC_MARKER = 'ANTHROPIC_STUB_REPLY::haiku-4-5::exec-priorities-ack';
const OPENAI_MARKER = 'OPENAI_STUB_REPLY::gpt-4.1-mini::exec-priorities-ack';
const OPENROUTER_MARKER = 'OPENROUTER_STUB_REPLY::gpt-4.1::exec-priorities-ack';
const WORKERS_AI_MARKER = 'WORKERS_AI_STUB_REPLY::glm-5.2::exec-priorities-ack';

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runProvider({ serverEntry, fake, backend, netGuardLog, model, replyText, env }) {
  backend.reset();
  backend.configure({ provider: { mode: 'ok', replyText } });
  // Channels are fail-closed and the install seed no longer includes the
  // TDEMO demo assignments, so the C_EXEC mention fixture needs an explicitly
  // seeded state DB (a ':memory:' transcript DB would derive an unseedable
  // ':memory:' state store).
  const stateDbPath = join(mkdtempSync(join(tmpdir(), 'flue-prov-state-')), 'state.db');
  const keyringPath = `${stateDbPath}.credential-keyring.json`;
  await seedOfflineDemoChannelConfig(stateDbPath);
  const port = await getFreePort();
  await seedOfflineSlackAuthority({
    stateDbPath,
    keyringPath,
    canonicalOrigin: `http://127.0.0.1:${port}`,
    teamId: 'TDEMO',
    slackUserId: 'UOWNER01',
    appId: 'ADEMO',
    botUserId: 'UBOT',
  });
  const spawned = spawnServer({
    serverEntry,
    port,
    fakeUrl: fake.url,
    netGuardLog,
    env: {
      TAG_DB_PATH: ':memory:',
      SLACK_STATE_DB_PATH: stateDbPath,
      CHICKPEA_CREDENTIAL_KEYRING_PATH: keyringPath,
      CHICKPEA_AUTH_SECRET: '9d'.repeat(32),
      SLACK_TAG_MODEL: model,
      ...env,
    },
  });
  try {
    await waitForReady(spawned.child, spawned.eventsUrl, spawned.getOutput);
    await postSignedEvent(spawned.eventsUrl, APP_MENTION);
    await waitForFinals(backend, 1, 20_000);
  } finally {
    await stopChild(spawned.child);
  }
  const finalText = backend.finals().at(-1)?.text ?? '';
  const providerCalls = backend.providerCalls();
  return {
    finalText,
    wireMethods: providerCalls.map((call) => call.method),
    serverOutput: spawned.getOutput(),
  };
}

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-prov-guard-')), 'external-hosts.log');
const { FakeSlackBackend } = await loadFake();
const backend = new FakeSlackBackend({
  slack: {
    // The runtime revalidates the selected Slack identity's workspace and
    // channel membership immediately before model work. Keep the signed
    // C_EXEC fixture explicit so these checks reach each provider route.
    channels: [
      {
        id: 'C_EXEC',
        name: 'exec-briefing',
        isMember: true,
        teamId: 'TDEMO',
      },
    ],
    channelMembers: {
      C_EXEC: ['U_ALICE', 'UBOT'],
    },
    workspaceUsers: [
      { id: 'U_ALICE', teamId: 'TDEMO' },
      { id: 'UBOT', teamId: 'TDEMO', isBot: true, isAppUser: true },
    ],
  },
  provider: { mode: 'ok' },
});
const fake = await backend.listen();
console.log(`fake backend listening at ${fake.url}`);

try {
  const serverEntry = await buildNodeServer();
  console.log(`built node server; node ${assertNodeVersion()}`);

  // --- anthropic (STUB: local fake endpoint) — anthropic-messages wire protocol. ---
  const anthropic = await runProvider({
    serverEntry,
    fake,
    backend,
    netGuardLog,
    model: 'anthropic/claude-haiku-4-5',
    replyText: ANTHROPIC_MARKER,
    // Point the anthropic provider at the fake; a dummy key satisfies the SDK
    // and the fake ignores it.
    env: { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'offline-stub-key' },
  });
  record(
    'anthropic (STUB): final on the wire carries the anthropic stub reply',
    anthropic.finalText.includes(ANTHROPIC_MARKER),
    `wire=${anthropic.wireMethods.join(',')} markerInFinal=${anthropic.finalText.includes(ANTHROPIC_MARKER)}`,
  );
  record(
    'anthropic (STUB): request used the anthropic-messages wire protocol',
    anthropic.wireMethods.includes('messages'),
    `wireMethods=${anthropic.wireMethods.join(',')}`,
  );

  // --- openai (STUB: local fake endpoint) — openai-responses wire protocol. ---
  const openai = await runProvider({
    serverEntry,
    fake,
    backend,
    netGuardLog,
    model: 'openai/gpt-4.1-mini',
    replyText: OPENAI_MARKER,
    env: {
      OPENAI_BASE_URL: `${fake.url}/openai/v1`,
      OPENAI_API_KEY: 'offline-stub-key',
    },
  });
  record(
    'openai (STUB): final on the wire carries the OpenAI stub reply',
    openai.finalText.includes(OPENAI_MARKER),
    `wire=${openai.wireMethods.join(',')} markerInFinal=${openai.finalText.includes(OPENAI_MARKER)}`,
  );
  record(
    'openai (STUB): request used the openai-responses wire protocol',
    openai.wireMethods.includes('responses'),
    `wireMethods=${openai.wireMethods.join(',')}`,
  );

  // --- openrouter (STUB: local fake endpoint) — openai-completions wire protocol. ---
  const openrouter = await runProvider({
    serverEntry,
    fake,
    backend,
    netGuardLog,
    model: 'openrouter/openai/gpt-4.1',
    replyText: OPENROUTER_MARKER,
    env: {
      OPENROUTER_BASE_URL: `${fake.url}/openrouter/v1`,
      OPENROUTER_API_KEY: 'offline-stub-key',
    },
  });
  record(
    'openrouter (STUB): final on the wire carries the OpenRouter stub reply',
    openrouter.finalText.includes(OPENROUTER_MARKER),
    `wire=${openrouter.wireMethods.join(',')} markerInFinal=${openrouter.finalText.includes(OPENROUTER_MARKER)}`,
  );
  record(
    'openrouter (STUB): request used the openai-completions wire protocol',
    openrouter.wireMethods.includes('chat/completions'),
    `wireMethods=${openrouter.wireMethods.join(',')}`,
  );

  // --- cloudflare-workers-ai (STUB: local fake endpoint) — openai-completions. ---
  const workersAi = await runProvider({
    serverEntry,
    fake,
    backend,
    netGuardLog,
    model: 'cloudflare-workers-ai/@cf/zai-org/glm-5.2',
    replyText: WORKERS_AI_MARKER,
    // Point workers-ai at the fake's openai-completions surface; dummy token.
    env: {
      CLOUDFLARE_WORKERS_AI_BASE_URL: `${fake.url}/v1`,
      CLOUDFLARE_API_TOKEN: 'offline-stub-key',
      CLOUDFLARE_ACCOUNT_ID: 'offline-stub-account',
    },
  });
  record(
    'cloudflare-workers-ai (STUB): final on the wire carries the workers-ai stub reply',
    workersAi.finalText.includes(WORKERS_AI_MARKER),
    `wire=${workersAi.wireMethods.join(',')} markerInFinal=${workersAi.finalText.includes(WORKERS_AI_MARKER)}`,
  );
  record(
    'cloudflare-workers-ai (STUB): request used the openai-completions wire protocol',
    workersAi.wireMethods.includes('chat/completions'),
    `wireMethods=${workersAi.wireMethods.join(',')}`,
  );

  // --- Net guard. ---
  const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  record('NET_GUARD_LOG empty -> zero external traffic', attempted === '', attempted || 'none');

} catch (error) {
  record('providers harness', false, error instanceof Error ? error.stack : String(error));
} finally {
  await backend.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
