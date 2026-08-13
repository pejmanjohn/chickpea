#!/usr/bin/env node
/**
 * Prove the app's full turn policy works completely offline under the built
 * Node server with zero external traffic. This is a focused, fast feedback
 * loop alongside the broader parity suite.
 *
 * One built Flue server + one in-memory fake Slack/provider backend. The fake's
 * behavior knobs are reconfigured in-process between scenarios (the same knobs
 * are also exposed over `POST /__config` for direct harness control), and
 * each scenario uses a distinct event id / message ts so the process-local claim
 * store does not dedupe across scenarios.
 *
 * Checks:
 *   1. signed url_verification -> 200 + challenge echoed
 *   2. tampered signature      -> 401, no wire calls
 *   3. mention full turn       -> conversations.history (24h window), status
 *      set then cleared, ONE streamed final (startStream+stopStream) carrying
 *      the stub reply marker
 *   4. status rejected         -> a durable plain progress post precedes the
 *      final, final still delivered, no status retry storm
 *   5. provider 500            -> durable operator-recovery state after the
 *      bounded Flue reattachment budget, no misleading Slack final, no raw
 *      provider error marker, status cleared
 *   6. NET_GUARD_LOG empty     -> zero external traffic across all scenarios
 *
 * A suitable Node >= 22.19 builds and spawns the Flue server; the shared
 * harness resolves a free port itself:
 *   node scripts/verify-flue-offline-turn.mjs
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

const EXEC_CHANNEL = 'C_EXEC';
const ROOT_THREAD_TS = '1782770400.000100';

// Load the TypeScript fake backend through tsx's runtime loader.
const { FakeSlackBackend, STUB_REPLY_MARKER, RAW_PROVIDER_ERROR_MARKER, isMarkdownPost } =
  await loadFake();

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-net-guard-')), 'external-hosts.log');
const stateDbPath = join(mkdtempSync(join(tmpdir(), 'flue-offline-state-')), 'state.db');

const appMention = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'app-mention.json'), 'utf8'),
);

/** Clone the base mention fixture with per-scenario overrides (fresh dedupe keys). */
function craftMention({ eventId, ts }) {
  return {
    ...appMention,
    event_id: eventId,
    event: { ...appMention.event, ts, event_ts: ts },
  };
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForRecoveryRequired(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const count = Number(
        db.prepare(
          `SELECT COUNT(*) AS count FROM turn_jobs
           WHERE delivered = 0 AND status = 'recovery_required'`,
        ).get()?.count ?? 0,
      );
      if (count > 0) return count;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return 0;
}

const backend = new FakeSlackBackend({
  slack: {
    // The runtime now revalidates the selected Slack identity's workspace and
    // channel membership immediately before model work. Keep the offline wire
    // fixture explicit so this gate exercises that preflight instead of being
    // rejected before context hydration.
    channels: [
      {
        id: EXEC_CHANNEL,
        name: 'exec-briefing',
        isMember: true,
        teamId: 'T_DEMO',
      },
    ],
    channelMembers: {
      [EXEC_CHANNEL]: ['U_ALICE', 'U_BOT'],
    },
    workspaceUsers: [
      { id: 'U_ALICE', teamId: 'T_DEMO' },
      { id: 'U_BOT', teamId: 'T_DEMO', isBot: true, isAppUser: true },
    ],
  },
});
const fake = await backend.listen();
console.log(`fake Slack/provider backend listening at ${fake.url}`);

let child;
let getServerOutput = () => '';
try {
  const serverEntry = await buildNodeServer();
  console.log(`built node server; node ${assertNodeVersion()}`);
  await seedOfflineDemoChannelConfig(stateDbPath);

  const port = await getFreePort();
  const spawned = spawnServer({
    serverEntry,
    port,
    fakeUrl: fake.url,
    netGuardLog,
    // Pin an in-memory DB so this single-process offline gate stays
    // deterministic across runs (no cross-run accumulation in ./tmp/flue.db).
    env: { TAG_DB_PATH: ':memory:', SLACK_STATE_DB_PATH: stateDbPath },
  });
  child = spawned.child;
  const { baseUrl, eventsUrl, getOutput } = spawned;
  getServerOutput = getOutput;
  await waitForReady(child, eventsUrl, getOutput);
  console.log(`flue node server ready at ${baseUrl}`);

  // Check 1: signed url_verification echoes the challenge.
  {
    const response = await postSignedEvent(eventsUrl, {
      type: 'url_verification',
      challenge: 'offline-turn-challenge',
    });
    const passed =
      response.status === 200 &&
      typeof response.body === 'object' &&
      response.body !== null &&
      response.body.challenge === 'offline-turn-challenge';
    record(
      'url_verification signed -> 200 + challenge echoed',
      passed,
      `status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }

  // Check 2: tampered signature is rejected before the events callback.
  {
    const wireBefore = backend.wireLog.length;
    const response = await postSignedEvent(eventsUrl, appMention, { tamper: true });
    await backend.quiesce();
    const passed = response.status === 401 && backend.wireLog.length === wireBefore;
    record(
      'tampered signature -> 401, no wire calls',
      passed,
      `status=${response.status} newWireCalls=${backend.wireLog.length - wireBefore}`,
    );
  }

  // Check 3: signed app_mention drives one full offline turn — hydration,
  // status set->clear, and a single streamed final with the stub marker.
  {
    backend.reset();
    backend.configure({ slack: { rejectSetStatus: false }, provider: { mode: 'ok' } });
    const response = await postSignedEvent(eventsUrl, appMention);
    const finals = await waitForFinals(backend, 1, 15_000);
    const [final] = finals;

    const historyCalls = backend.callsOfMethod('conversations.history');
    const history = historyCalls[0];
    const windowSeconds = history
      ? Math.round(Number(history.body.latest) - Number(history.body.oldest))
      : -1;
    const startStreams = backend
      .callsOfMethod('chat.startStream')
      .filter((entry) => typeof entry.body.markdown_text === 'string');
    const stopStreams = backend.callsOfMethod('chat.stopStream');
    const statuses = backend.statusCalls();
    const nonEmpty = statuses.filter((entry) => String(entry.body.status) !== '');
    const lastStatus = statuses.at(-1);

    const passed =
      response.status === 200 &&
      finals.length === 1 &&
      final !== undefined &&
      final.channel === EXEC_CHANNEL &&
      final.threadTs === ROOT_THREAD_TS &&
      final.text.includes(STUB_REPLY_MARKER) &&
      historyCalls.length === 1 &&
      Number(history.body.limit) <= 50 &&
      windowSeconds === 86_400 &&
      startStreams.length === 1 &&
      stopStreams.length === 1 &&
      nonEmpty.length >= 1 &&
      lastStatus !== undefined &&
      String(lastStatus.body.status) === '';
    record(
      'mention full turn -> history(24h) + status set/clear + one streamed final',
      passed,
      `finals=${finals.length} history=${historyCalls.length} window=${windowSeconds}s ` +
        `startStream=${startStreams.length} stopStream=${stopStreams.length} ` +
        `nonEmptyStatus=${nonEmpty.length} lastStatus="${String(lastStatus?.body.status)}"`,
    );
  }

  // Check 4: status rejection falls back to a durable progress post before the
  // final and does not storm setStatus.
  {
    backend.reset();
    backend.configure({ slack: { rejectSetStatus: true }, provider: { mode: 'ok' } });
    await postSignedEvent(
      eventsUrl,
      craftMention({ eventId: 'Ev_OFFLINE_REJECT', ts: '1782770910.000100' }),
    );
    const finals = await waitForFinals(backend, 1, 15_000);
    const [final] = finals;

    const progressPosts = backend.progressPosts();
    const firstProgressIndex = backend.wireLog.findIndex(
      (entry) => entry.method === 'chat.postMessage' && !isMarkdownPost(entry.body),
    );
    const nonEmpty = backend
      .statusCalls()
      .filter((entry) => String(entry.body.status) !== '');

    const passed =
      finals.length === 1 &&
      final !== undefined &&
      progressPosts.length >= 1 &&
      firstProgressIndex >= 0 &&
      firstProgressIndex < final.index &&
      nonEmpty.length <= 2;
    record(
      'status rejected -> durable progress post precedes the final',
      passed,
      `finals=${finals.length} progressPosts=${progressPosts.length} ` +
        `progressIndex=${firstProgressIndex} finalIndex=${final?.index} nonEmptyStatus=${nonEmpty.length}`,
    );
  }

  // Check 5: provider 500 exhausts the bounded Flue reattachment budget into
  // explicit operator recovery. A dispatched turn must not be replaced with
  // a second run or a misleading generic final.
  {
    backend.reset();
    backend.configure({ slack: { rejectSetStatus: false }, provider: { mode: 'http_500' } });
    await postSignedEvent(
      eventsUrl,
      craftMention({ eventId: 'Ev_OFFLINE_500', ts: '1782770920.000100' }),
    );
    const recoveryRequired = await waitForRecoveryRequired(stateDbPath, 40_000);
    const finals = backend.finals();
    const lastStatus = backend.statusCalls().at(-1);
    const slackWire = JSON.stringify(backend.wireLog);

    const passed =
      recoveryRequired === 1 &&
      finals.length === 0 &&
      !slackWire.includes(RAW_PROVIDER_ERROR_MARKER) &&
      lastStatus !== undefined &&
      String(lastStatus.body.status) === '';
    record(
      'provider 500 -> durable recovery state, status cleared, no raw error leak',
      passed,
      `recoveryRequired=${recoveryRequired} finals=${finals.length} ` +
        `rawLeak=${slackWire.includes(RAW_PROVIDER_ERROR_MARKER)} ` +
        `lastStatus="${String(lastStatus?.body.status)}"`,
    );
  }

  // Check 6: zero external traffic across every scenario above.
  {
    const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
    record(
      'NET_GUARD_LOG empty -> zero external traffic',
      attempted === '',
      attempted === '' ? 'no external hosts attempted' : `attempted: ${attempted}`,
    );
  }

} catch (error) {
  record('verification harness', false, error instanceof Error ? error.message : String(error));
} finally {
  if (child) {
    await stopChild(child);
  }
  await backend.close();
}

const failed = results.filter((result) => !result.passed);
if (failed.length > 0) {
  const output = getServerOutput().trim();
  if (output) console.error(`\nNode server output:\n${output}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
