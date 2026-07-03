#!/usr/bin/env node
/**
 * Stage-4 gate (c): model-invoked, assignment-scoped tool with an honest deny.
 *
 * The `lookup_channel_brief` tool closes over the ASSIGNED channel (Flue's
 * trusted-closure authorization). The model picks the `channelId` argument, but
 * the app enforces the policy. Two turns, both driven by a scripted stub that
 * makes the model genuinely emit a tool call:
 *
 *   ALLOWED   — the model calls the tool for the assigned channel (C_EXEC). The
 *               tool returns the brief; the final relays it. The second provider
 *               request carries the brief as a real `tool` result (not a
 *               model-fabricated answer).
 *   FORBIDDEN — the model calls the tool for C_FORBIDDEN. The app throws an
 *               honest, non-leaking denial; that error comes back as a tool
 *               result and the final relays the denial — never the brief.
 *
 * Offline, net-guarded, stub provider. Saves the two wire transcripts to
 * docs/decisions/artifacts/g-port-stage4/tool-policy-{allowed,denied}.json.
 *
 * Run with Node >= 22.19:
 *   node scripts/verify-tool-policy.mjs
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
  loadTsModule,
  postSignedEvent,
  spawnServer,
  stage4ArtifactPath,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const EXEC_CHANNEL = 'C_EXEC';
const INTERNAL_TOKEN = 'tool-policy-internal-token';
// Trigger words and the brief text are imported from the app/fake below (not
// re-typed) so this gate can't silently drift from the real seed + stub.
const DENIAL_TEXT = 'Denied: lookup_channel_brief is restricted to the assigned channel.';

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function mention({ eventId, ts, text }) {
  return {
    token: 'verification-token-not-a-secret',
    team_id: 'T_DEMO',
    api_app_id: 'A_DEMO',
    event_id: eventId,
    event_time: 1782770400,
    type: 'event_callback',
    event: { type: 'app_mention', user: 'U_ALICE', text, ts, channel: EXEC_CHANNEL, event_ts: ts },
  };
}

/** Provider request bodies that carry a `tool` role message (a real tool result). */
function toolResultMessages(providerCalls) {
  const found = [];
  for (const call of providerCalls) {
    const messages = Array.isArray(call.body?.messages) ? call.body.messages : [];
    for (const message of messages) {
      if (message?.role === 'tool') {
        found.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
      }
    }
  }
  return found;
}

function transcript(turn, backend) {
  return {
    turn,
    slackFinals: backend.finals().map((final) => ({ channel: final.channel, text: final.text })),
    providerRequests: backend.providerCalls().map((call) => ({
      method: call.method,
      messages: call.body?.messages ?? [],
    })),
    toolResultsOnWire: toolResultMessages(backend.providerCalls()),
  };
}

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-tool-guard-')), 'external-hosts.log');
const { FakeSlackBackend, TOOL_TRIGGER, TOOL_TRIGGER_FORBIDDEN } = await loadFake();
const { seededChannelBriefs } = await loadTsModule('src/config/seed.ts');
const BRIEF_TEXT = seededChannelBriefs[EXEC_CHANNEL];
const backend = new FakeSlackBackend({ provider: { mode: 'ok', toolChannelId: EXEC_CHANNEL } });
const fake = await backend.listen();
console.log(`fake backend listening at ${fake.url}`);

let child;
try {
  const serverEntry = await buildNodeServer();
  console.log(`built node server; node ${assertNodeVersion()}`);

  const port = await getFreePort();
  const spawned = spawnServer({
    serverEntry,
    port,
    fakeUrl: fake.url,
    netGuardLog,
    env: {
      FLUE_DB_PATH: ':memory:',
      FLUE_AGENT_API_TOKEN: INTERNAL_TOKEN,
      SLACK_FLUE_MODEL: 'local-stub/parity-stub-1',
    },
  });
  child = spawned.child;
  await waitForReady(child, spawned.eventsUrl, spawned.getOutput);

  // --- ALLOWED turn: tool call for the assigned channel. ---
  backend.reset();
  await postSignedEvent(
    spawned.eventsUrl,
    mention({
      eventId: 'Ev_TOOL_ALLOW',
      ts: '1782770700.000100',
      text: `<@U_BOT> ${TOOL_TRIGGER} and summarize our channel brief`,
    }),
  );
  await waitForFinals(backend, 1, 15_000);
  const allowed = transcript('allowed', backend);
  writeFileSync(stage4ArtifactPath('tool-policy-allowed.json'), `${JSON.stringify(allowed, null, 2)}\n`);

  const allowedFinal = backend.finals().at(-1)?.text ?? '';
  const allowedToolResults = toolResultMessages(backend.providerCalls());
  record(
    'ALLOWED: final relays the brief content',
    allowedFinal.includes(BRIEF_TEXT),
    `finals=${backend.finals().length} briefInFinal=${allowedFinal.includes(BRIEF_TEXT)}`,
  );
  record(
    'ALLOWED: provider wire shows a real tool result carrying the brief (not fabricated)',
    backend.providerCalls().length === 2 && allowedToolResults.some((content) => content.includes(BRIEF_TEXT)),
    `providerCalls=${backend.providerCalls().length} toolResults=${allowedToolResults.length}`,
  );

  // --- FORBIDDEN turn: tool call for an unassigned channel → honest deny. ---
  backend.reset();
  await postSignedEvent(
    spawned.eventsUrl,
    mention({
      eventId: 'Ev_TOOL_DENY',
      ts: '1782770800.000100',
      text: `<@U_BOT> ${TOOL_TRIGGER_FORBIDDEN} and read another channel`,
    }),
  );
  await waitForFinals(backend, 1, 15_000);
  const denied = transcript('denied', backend);
  writeFileSync(stage4ArtifactPath('tool-policy-denied.json'), `${JSON.stringify(denied, null, 2)}\n`);

  const deniedFinal = backend.finals().at(-1)?.text ?? '';
  const deniedToolResults = toolResultMessages(backend.providerCalls());
  // Scan the ENTIRE denied-turn wire log — every Slack call and every provider
  // request body, i.e. exactly the data just written to tool-policy-denied.json —
  // not just the final Slack text. This is what actually backs the "brief never
  // leaks" claim.
  const deniedWireLog = JSON.stringify(denied);
  record(
    'FORBIDDEN: final relays the honest denial',
    deniedFinal.includes(DENIAL_TEXT),
    `denialInFinal=${deniedFinal.includes(DENIAL_TEXT)}`,
  );
  record(
    'FORBIDDEN: brief never leaks anywhere on the wire (Slack calls + provider requests)',
    !deniedWireLog.includes(BRIEF_TEXT),
    `briefLeaked=${deniedWireLog.includes(BRIEF_TEXT)}`,
  );
  record(
    'FORBIDDEN: the denial arrived as a real tool result on the provider wire',
    deniedToolResults.some((content) => content.includes(DENIAL_TEXT)),
    `toolResults=${deniedToolResults.length}`,
  );

  // --- Net guard. ---
  const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  record('NET_GUARD_LOG empty -> zero external traffic', attempted === '', attempted || 'none');
} catch (error) {
  record('tool-policy harness', false, error instanceof Error ? error.stack : String(error));
} finally {
  if (child) {
    await stopChild(child);
  }
  await backend.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
