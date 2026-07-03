#!/usr/bin/env node
/**
 * LIVE companion to verify-providers.mjs: the SAME signed app_mention fixture
 * answered through the Flue lane by REAL model providers. Slack stays fake
 * (SLACK_API_URL → loopback backend); the net-guard allows ONLY the named
 * provider host per run and logs it, so the artifacts prove (a) live provider
 * traffic happened and (b) zero Slack egress and zero other external traffic.
 *
 * Runs whichever providers have credentials in the environment:
 *   - anthropic:            ANTHROPIC_API_KEY  (catalog default base URL)
 *   - cloudflare-workers-ai: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
 * A provider without credentials is reported as SKIPPED; the script fails if
 * NO provider could run live, or if any attempted run fails.
 *
 * On success, overwrites the STUB-labeled Stage-4 artifacts with LIVE ones:
 *   docs/decisions/artifacts/g-port-stage4/provider-{anthropic,workers-ai}-reply.md
 *
 * Typical invocation (Node >= 22.19 on PATH; creds via env, never printed):
 *   set -a; source .env.slack.local; set +a
 *   node scripts/verify-providers-live.mjs
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
    artifact: 'provider-anthropic-reply.md',
    wireNote:
      'catalog `anthropic` provider, default live base URL (`https://api.anthropic.com`), anthropic-messages protocol',
    hasCreds: () => Boolean(process.env.ANTHROPIC_API_KEY),
    missing: 'ANTHROPIC_API_KEY absent',
    env: () => ({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
  },
  {
    id: 'cloudflare-workers-ai',
    model: 'cloudflare-workers-ai/@cf/zai-org/glm-5.2',
    liveHost: 'api.cloudflare.com',
    artifact: 'provider-workers-ai-reply.md',
    wireNote:
      'registerProvider baseUrl `https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1`, openai-completions protocol',
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
  const port = await getFreePort();
  const spawned = spawnServer({
    serverEntry,
    port,
    fakeUrl: fake.url,
    netGuardLog,
    env: {
      FLUE_DB_PATH: ':memory:',
      FLUE_AGENT_API_TOKEN: 'providers-live-internal-token',
      SLACK_FLUE_MODEL: provider.model,
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

function writeLiveArtifact(provider, run) {
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    stage4ArtifactPath(provider.artifact),
    [
      `# Provider reply — ${provider.id} (LIVE)`,
      '',
      `- **Provenance:** LIVE model call on ${today} via \`scripts/verify-providers-live.mjs\`.`,
      `  Net-guard allowlisted ONLY \`${provider.liveHost}\`; the run logged`,
      `  ${run.liveHits.length} allowed request(s) to it and blocked zero other external hosts,`,
      '  so Slack traffic stayed entirely on the loopback fake.',
      `- **Model:** \`${provider.model}\` (via \`SLACK_FLUE_MODEL\`).`,
      `- **Provider wiring:** ${provider.wireNote}.`,
      '- **Routing:** the SAME `app-mention.json` fixture, answered through the Flue',
      '  lane by swapping only `SLACK_FLUE_MODEL`.',
      `- **End-to-end turn latency (spawn→final):** ${run.elapsedMs}ms.`,
      '',
      '## Reply delivered on the Slack wire',
      '',
      '```',
      run.finalText,
      '```',
    ].join('\n') + '\n',
  );
}

const { FakeSlackBackend } = await loadFake();
const backend = new FakeSlackBackend({ provider: { mode: 'ok' } });
const fake = await backend.listen();
console.log(`fake Slack backend listening at ${fake.url}`);

let ranLive = 0;
try {
  const serverEntry = await buildNodeServer();
  console.log(`built node server; node ${assertNodeVersion()}`);

  for (const provider of PROVIDERS) {
    if (!provider.hasCreds()) {
      console.log(`SKIP  ${provider.id}: ${provider.missing} — STUB artifact left in place`);
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
      writeLiveArtifact(provider, run);
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
