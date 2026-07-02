#!/usr/bin/env node
/**
 * Stage-4 gate (a): restart durability via file-backed `src/db.ts`.
 *
 * Proves the Flue lane's headline gain over the hand-rolled lane: conversation
 * state survives a process restart. The hand-rolled lane keeps thread state in
 * a process-local Map, so a redelivery after a crash forgets the thread. The
 * Flue lane persists the agent transcript to SQLite (db.ts), so a second turn
 * in the same thread — served by a BRAND NEW process on the same DB file —
 * replays the first turn's assistant reply from durable storage.
 *
 * Flow (all offline, net-guarded, stub provider):
 *   1. server1 on DB_A: T1 signed mention, stub replyText = DURABILITY_MARKER.
 *      SIGKILL server1.
 *   2. server2 on DB_A (fresh process, same DB): T2 signed mention in the SAME
 *      thread. Assert (i) T2 delivers a final on the wire; (ii) T2's provider
 *      request replays the marker (T1's assistant reply, loaded from the DB);
 *      (iii) GET .../{thread}?view=history returns BOTH turns. Save artifacts.
 *   3. NEGATIVE CONTROL — server3 on a DIFFERENT fresh DB_B: the same follow-up
 *      turn's provider request must NOT contain the marker (no shared durable
 *      storage → no replay). This proves the assertion measures durability.
 *
 * Run with Node >= 22.19:
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/verify-durability.mjs
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const DURABILITY_MARKER = 'DURABILITY_MARKER_ALPHA';
const INTERNAL_TOKEN = 'durability-internal-token';
const EXEC_CHANNEL = 'C_EXEC';
const ROOT_TS = '1782770400.000100';
const THREAD_KEY = `T_DEMO:${EXEC_CHANNEL}:${ROOT_TS}`;
const ARTIFACT_DIR = join(REPO_ROOT, 'docs', 'decisions', 'artifacts', 'g-port-stage4');

const logLines = [];
function log(line) {
  logLines.push(line);
  console.log(line);
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A signed app_mention in C_EXEC. `threadTs` set → threaded follow-up (same key). */
function mention({ eventId, ts, threadTs }) {
  return {
    token: 'verification-token-not-a-secret',
    team_id: 'T_DEMO',
    api_app_id: 'A_DEMO',
    event_id: eventId,
    event_time: 1782770400,
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: 'U_ALICE',
      text: '<@U_BOT> please use channel context and draft an exec summary',
      ts,
      channel: EXEC_CHANNEL,
      event_ts: ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
  };
}

async function runServerTurn({ serverEntry, fakeUrl, dbPath, netGuardLog, payload }) {
  const port = await getFreePort();
  const { child, baseUrl, eventsUrl, getOutput } = spawnServer({
    serverEntry,
    port,
    fakeUrl,
    netGuardLog,
    env: {
      FLUE_DB_PATH: dbPath,
      FLUE_AGENT_API_TOKEN: INTERNAL_TOKEN,
      SLACK_FLUE_MODEL: 'local-stub/parity-stub-1',
    },
  });
  try {
    await waitForReady(child, eventsUrl, getOutput);
    await postSignedEvent(eventsUrl, payload);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return { child, baseUrl, eventsUrl };
}

const { FakeSlackBackend } = await loadFake();
const backend = new FakeSlackBackend({ provider: { mode: 'ok', replyText: DURABILITY_MARKER } });
const fake = await backend.listen();
log(`fake backend listening at ${fake.url}`);

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-dur-guard-')), 'external-hosts.log');
const dbA = join(mkdtempSync(join(tmpdir(), 'flue-dur-dbA-')), 'flue.db');
const dbB = join(mkdtempSync(join(tmpdir(), 'flue-dur-dbB-')), 'flue.db');

let historyTranscript;
try {
  const serverEntry = await buildNodeServer();
  log(`built node server: ${serverEntry}`);
  log(`node ${assertNodeVersion()}  DB_A=${dbA}  DB_B=${dbB}`);

  // --- Turn 1 on DB_A, then kill the process. ---
  {
    const { child } = await runServerTurn({
      serverEntry,
      fakeUrl: fake.url,
      dbPath: dbA,
      netGuardLog,
      payload: mention({ eventId: 'Ev_DUR_T1', ts: ROOT_TS }),
    });
    const finals = await waitForFinals(backend, 1, 15_000);
    const t1Final = finals.at(-1);
    await stopChild(child);
    record(
      'T1 delivers a final carrying the durability marker, then server SIGKILLed',
      finals.length === 1 && !!t1Final && t1Final.text.includes(DURABILITY_MARKER),
      `finals=${finals.length} markerInFinal=${!!t1Final && t1Final.text.includes(DURABILITY_MARKER)}`,
    );
  }

  // --- Turn 2 on DB_A: fresh process, same DB. Marker must replay. ---
  backend.reset();
  {
    const { child, baseUrl } = await runServerTurn({
      serverEntry,
      fakeUrl: fake.url,
      dbPath: dbA,
      netGuardLog,
      payload: mention({ eventId: 'Ev_DUR_T2', ts: '1782770500.000100', threadTs: ROOT_TS }),
    });
    const finals = await waitForFinals(backend, 1, 15_000);
    const t2Final = finals.at(-1);

    const providerCalls = backend.providerCalls();
    const providerReplaysMarker = providerCalls.some((call) =>
      JSON.stringify(call.body).includes(DURABILITY_MARKER),
    );

    // Read the durable transcript through the authenticated history view.
    const historyUrl = `${baseUrl}/agents/slack-thread/${encodeURIComponent(THREAD_KEY)}?view=history`;
    const historyResponse = await fetch(historyUrl, {
      headers: { 'x-flue-internal-token': INTERNAL_TOKEN },
    });
    historyTranscript = await historyResponse.text();
    const markerCount = (historyTranscript.match(new RegExp(DURABILITY_MARKER, 'g')) || []).length;

    await stopChild(child);

    record(
      'T2 (new process, same DB) delivers a final',
      finals.length === 1 && !!t2Final,
      `finals=${finals.length}`,
    );
    record(
      'T2 provider request REPLAYS the marker from durable storage',
      providerReplaysMarker,
      `providerCalls=${providerCalls.length} replaysMarker=${providerReplaysMarker}`,
    );
    record(
      'history view returns BOTH turns (marker present >= 2x) with the internal token',
      historyResponse.status === 200 && markerCount >= 2,
      `status=${historyResponse.status} markerOccurrences=${markerCount}`,
    );
  }

  // --- Negative control: follow-up on a DIFFERENT fresh DB → no replay. ---
  backend.reset();
  {
    const { child } = await runServerTurn({
      serverEntry,
      fakeUrl: fake.url,
      dbPath: dbB,
      netGuardLog,
      payload: mention({ eventId: 'Ev_DUR_NEG', ts: '1782770600.000100', threadTs: ROOT_TS }),
    });
    const finals = await waitForFinals(backend, 1, 15_000);
    const providerCalls = backend.providerCalls();
    const providerHasMarker = providerCalls.some((call) =>
      JSON.stringify(call.body).includes(DURABILITY_MARKER),
    );
    await stopChild(child);
    record(
      'NEGATIVE CONTROL: fresh DB → provider request does NOT contain the marker',
      finals.length === 1 && !providerHasMarker,
      `finals=${finals.length} markerLeaked=${providerHasMarker}`,
    );
  }

  // --- Net guard: zero external traffic. ---
  {
    const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
    record('NET_GUARD_LOG empty -> zero external traffic', attempted === '', attempted || 'none');
  }
} catch (error) {
  record('durability harness', false, error instanceof Error ? error.stack : String(error));
} finally {
  await backend.close();
}

// Persist artifacts (contain no secrets — offline stub run).
if (historyTranscript !== undefined) {
  try {
    writeFileSync(
      join(ARTIFACT_DIR, 'durability-transcript.json'),
      `${JSON.stringify(JSON.parse(historyTranscript), null, 2)}\n`,
    );
  } catch {
    writeFileSync(join(ARTIFACT_DIR, 'durability-transcript.json'), historyTranscript);
  }
}
const failed = results.filter((result) => !result.passed);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync(join(ARTIFACT_DIR, 'durability-run.log'), `${logLines.join('\n')}\n`);
process.exit(failed.length === 0 ? 0 : 1);
