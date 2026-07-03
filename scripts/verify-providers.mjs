#!/usr/bin/env node
/**
 * Stage-4 gate (b): multi-provider answering through Flue's registry.
 *
 * The SAME signed app_mention fixture is answered twice through the Flue lane —
 * once via the `anthropic` provider (anthropic-messages wire protocol) and once
 * via `cloudflare-workers-ai` (openai-completions wire protocol) — proving one
 * agent reaches two providers by only swapping SLACK_FLUE_MODEL.
 *
 * PROVENANCE (honest live-vs-stub): this offline harness intentionally runs
 * against local fake provider endpoints. Replies must stay labeled STUB unless
 * a future operator wires live credentials and records fresh live evidence.
 * A clearly labeled stub is acceptable here; a mislabeled one is not.
 *
 * Offline, net-guarded. Saves labeled replies to
 * docs/decisions/artifacts/g-port-stage4/provider-{anthropic,workers-ai}-reply.md
 *
 * Run with Node >= 22.19:
 *   node scripts/verify-providers.mjs
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  assertNodeVersion,
  buildNodeServer,
  getFreePort,
  loadFake,
  postSignedEvent,
  spawnServer,
  stage4ArtifactPath,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const APP_MENTION = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'app-mention.json'), 'utf8'));

const ANTHROPIC_MARKER = 'ANTHROPIC_STUB_REPLY::haiku-4-5::exec-priorities-ack';
const WORKERS_AI_MARKER = 'WORKERS_AI_STUB_REPLY::glm-5.2::exec-priorities-ack';

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runProvider({ serverEntry, fake, backend, netGuardLog, model, replyText, env }) {
  backend.reset();
  backend.configure({ provider: { mode: 'ok', replyText } });
  const port = await getFreePort();
  const spawned = spawnServer({
    serverEntry,
    port,
    fakeUrl: fake.url,
    netGuardLog,
    env: {
      FLUE_DB_PATH: ':memory:',
      FLUE_AGENT_API_TOKEN: 'providers-internal-token',
      SLACK_FLUE_MODEL: model,
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
const backend = new FakeSlackBackend({ provider: { mode: 'ok' } });
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

  // --- Artifacts. ---
  writeFileSync(
    stage4ArtifactPath('provider-anthropic-reply.md'),
    [
      '# Provider reply — anthropic (STUB)',
      '',
      '- **Provenance:** STUB. The harness points `ANTHROPIC_BASE_URL` at a',
      '  local fake provider endpoint and uses a dummy SDK key that the fake ignores.',
      '  No external Anthropic call is expected during this offline check.',
      '- **Model:** `anthropic/claude-haiku-4-5` (via `SLACK_FLUE_MODEL`).',
      '- **Provider wire protocol:** `POST <base>/v1/messages` streaming SSE',
      `  (\`message_start\` → \`content_block_delta\` → \`message_stop\`). Wire methods observed: \`${anthropic.wireMethods.join(', ')}\`.`,
      '- **Routing:** the SAME `app-mention.json` fixture, answered through the Flue',
      '  lane by swapping only `SLACK_FLUE_MODEL`.',
      '',
      '## Reply delivered on the Slack wire',
      '',
      '```',
      anthropic.finalText,
      '```',
    ].join('\n') + '\n',
  );
  writeFileSync(
    stage4ArtifactPath('provider-workers-ai-reply.md'),
    [
      '# Provider reply — cloudflare-workers-ai (STUB)',
      '',
      '- **Provenance:** STUB. The harness points `CLOUDFLARE_WORKERS_AI_BASE_URL`',
      '  at a local fake OpenAI-compatible endpoint and uses a dummy token that',
      '  the fake ignores. No external Cloudflare call is expected during this',
      '  offline check.',
      '- **Model:** `cloudflare-workers-ai/@cf/zai-org/glm-5.2` (via `SLACK_FLUE_MODEL`).',
      '- **Provider wire protocol:** `POST <base>/v1/chat/completions` streaming SSE',
      `  (OpenAI chat.completion.chunk deltas). Wire methods observed: \`${workersAi.wireMethods.join(', ')}\`.`,
      '- **Routing:** the SAME `app-mention.json` fixture, answered through the Flue',
      '  lane by swapping only `SLACK_FLUE_MODEL`.',
      '',
      '## Reply delivered on the Slack wire',
      '',
      '```',
      workersAi.finalText,
      '```',
    ].join('\n') + '\n',
  );
} catch (error) {
  record('providers harness', false, error instanceof Error ? error.stack : String(error));
} finally {
  await backend.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
