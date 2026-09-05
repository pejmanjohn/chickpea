#!/usr/bin/env node
/**
 * LIVE companion to verify-providers.mjs: the SAME signed app_mention fixture
 * answered through the built app by REAL model providers. Slack stays fake
 * (SLACK_API_URL → loopback backend); the net-guard allows ONLY the named
 * provider host per run and logs it, so the checks prove (a) live provider
 * traffic happened and (b) zero Slack egress and zero other external traffic.
 *
 * Runs whichever supported providers have credentials in the environment:
 *   - anthropic:              ANTHROPIC_API_KEY
 *   - openai:                 OPENAI_API_KEY
 *   - openrouter:             OPENROUTER_API_KEY
 *   - cloudflare-workers-ai:  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
 * A provider without credentials is reported as SKIPPED; the script fails if
 * NO provider could run live, or if any attempted run fails.
 *
 * Results stay in stdout; this opt-in verifier never writes credentials,
 * replies, or provenance artifacts into the repository.
 *
 * Typical invocation with the Node 24 baseline from .nvmrc on PATH; creds via env, never printed:
 *   set -a; source .env.slack.local; set +a
 *   node scripts/verify-providers-live.mjs
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
  spawnServer,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const APP_MENTION = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'app-mention.json'), 'utf8'),
);

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const PROVIDERS = [
  {
    id: 'anthropic',
    model: 'anthropic/claude-haiku-4-5',
    liveHost: 'api.anthropic.com',
    hasCreds: () => Boolean(process.env.ANTHROPIC_API_KEY),
    missing: 'ANTHROPIC_API_KEY absent',
    env: () => ({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
  },
  {
    id: 'openai',
    model: 'openai/gpt-5.6-luna',
    liveHost: 'api.openai.com',
    hasCreds: () => Boolean(process.env.OPENAI_API_KEY),
    missing: 'OPENAI_API_KEY absent',
    env: () => ({ OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
  },
  {
    id: 'openrouter',
    model: 'openrouter/openai/gpt-4.1',
    liveHost: 'openrouter.ai',
    hasCreds: () => Boolean(process.env.OPENROUTER_API_KEY),
    missing: 'OPENROUTER_API_KEY absent',
    env: () => ({ OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }),
  },
  {
    id: 'cloudflare-workers-ai',
    model: 'cloudflare-workers-ai/@cf/zai-org/glm-5.2',
    liveHost: 'api.cloudflare.com',
    hasCreds: () =>
      Boolean(process.env.CLOUDFLARE_API_TOKEN) && Boolean(process.env.CLOUDFLARE_ACCOUNT_ID),
    missing: 'CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID absent',
    env: () => ({
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
      // Empty string = unset in app.ts (`||`), overriding any stub base URL.
      CLOUDFLARE_WORKERS_AI_BASE_URL: '',
    }),
  },
];

async function runLiveProvider(provider, serverEntry, fake, backend) {
  backend.reset();
  const guardDir = mkdtempSync(join(tmpdir(), `flue-live-${provider.id}-`));
  const netGuardLog = join(guardDir, 'external-hosts.log');
  // Channels are fail-closed and the install seed no longer includes the
  // TDEMO demo assignments, so the C_EXEC mention fixture needs an explicitly
  // seeded state DB (a ':memory:' transcript DB would derive an unseedable
  // ':memory:' state store).
  const stateDbPath = join(guardDir, 'state.db');
  await seedOfflineDemoChannelConfig(stateDbPath);
  const port = await getFreePort();
  const spawned = spawnServer({
    serverEntry,
    port,
    fakeUrl: fake.url,
    netGuardLog,
    env: {
      TAG_DB_PATH: ':memory:',
      SLACK_STATE_DB_PATH: stateDbPath,
      SLACK_TAG_MODEL: provider.model,
      NET_GUARD_ALLOW: provider.liveHost,
      // The harness default points LOCAL_STUB_URL at the fake; that is fine —
      // the model id selects the live provider, not the stub.
      ...provider.env(),
    },
  });
  const startedAt = Date.now();
  try {
    await waitForReady(spawned.child, spawned.eventsUrl, spawned.getOutput);
    await postSignedEvent(spawned.eventsUrl, APP_MENTION);
    await waitForFinals(backend, 1, 90_000);
  } finally {
    await stopChild(spawned.child);
  }
  const finalText = backend.finals().at(-1)?.text ?? '';
  const blocked = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  const allowedLog = existsSync(`${netGuardLog}.allowed`)
    ? readFileSync(`${netGuardLog}.allowed`, 'utf8').trim()
    : '';
  const liveHits = allowedLog ? allowedLog.split('\n').filter(Boolean) : [];
  return {
    finalText,
    blocked,
    liveHits,
    elapsedMs: Date.now() - startedAt,
    serverOutput: spawned.getOutput(),
  };
}

const { FakeSlackBackend } = await loadFake();
const backend = new FakeSlackBackend({
  slack: {
    // Slack stays fake in this live-provider verifier, but identity preflight
    // is real. Make the signed C_EXEC fixture a member of the demo workspace.
    channels: [
      {
        id: 'C_EXEC',
        name: 'exec-briefing',
        isMember: true,
        teamId: 'TDEMO',
      },
    ],
  },
  provider: { mode: 'ok' },
});
const fake = await backend.listen();
console.log(`fake Slack backend listening at ${fake.url}`);

let ranLive = 0;
try {
  const serverEntry = await buildNodeServer();
  console.log(`built node server; node ${assertNodeVersion()}`);
  console.log(`credential-gated live matrix: ${PROVIDERS.map((provider) => provider.id).join(', ')}`);

  for (const provider of PROVIDERS) {
    if (!provider.hasCreds()) {
      console.log(`SKIP  ${provider.id}: ${provider.missing}`);
      continue;
    }
    const run = await runLiveProvider(provider, serverEntry, fake, backend);
    // A real reply must not be a stub marker NOR the sanitized provider-failure
    // final (which is what gets delivered when the live call errors out).
    const delivered =
      run.finalText.length > 0 &&
      !run.finalText.includes('STUB_REPLY') &&
      !run.finalText.startsWith('I reached the Slack thread');
    const wentLive = run.liveHits.length > 0;
    const noLeaks = run.blocked === '';
    record(
      `${provider.id} (LIVE): real model reply delivered on the Slack wire`,
      delivered,
      `finalChars=${run.finalText.length} latencyMs=${run.elapsedMs}`,
    );
    record(
      `${provider.id} (LIVE): traffic reached ${provider.liveHost} and nothing else external`,
      wentLive && noLeaks,
      `liveHits=${run.liveHits.length} blocked=${run.blocked || 'none'}`,
    );
    if (delivered && wentLive && noLeaks) {
      ranLive += 1;
    } else if (!delivered) {
      const tail = run.serverOutput.split('\n').slice(-8).join('\n');
      console.error(`--- ${provider.id} server output (tail) ---\n${tail}`);
    }
  }

  record('at least one provider ran LIVE', ranLive > 0, `liveProviders=${ranLive}`);
} catch (error) {
  record('live providers harness', false, error instanceof Error ? error.stack : String(error));
} finally {
  await backend.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
