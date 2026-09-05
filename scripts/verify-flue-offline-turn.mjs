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
 *   4. status rejected         -> final still delivered, no legacy progress
 *      post fallback, no status retry storm
 *   5. provider 500            -> one sanitized Slack failure, no raw provider
 *      error marker, status cleared when one was set
 *   6. NET_GUARD_LOG empty     -> zero external traffic across all scenarios
 *
 * A suitable Node 24.x (see .nvmrc) builds and spawns the Flue server; the shared
 * harness resolves a free port itself:
 *   node scripts/verify-flue-offline-turn.mjs
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
  loadTsModule,
  postSignedEvent,
  seedOfflineDemoChannelConfig,
  seedOfflineSlackAuthority,
  spawnServer,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const EXEC_CHANNEL = 'C_EXEC';
const ROOT_THREAD_TS = '1782770400.000100';

// Load the TypeScript fake backend through tsx's runtime loader.
const { FakeSlackBackend, STUB_REPLY_MARKER, RAW_PROVIDER_ERROR_MARKER } =
  await loadFake();
const { AGENT_FAILURE_TEXT } = await loadTsModule('src/slack/web-client-presenter.ts');

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-net-guard-')), 'external-hosts.log');
const stateDbPath = join(mkdtempSync(join(tmpdir(), 'flue-offline-state-')), 'state.db');
const keyringPath = `${stateDbPath}.credential-keyring.json`;

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
        teamId: 'TDEMO',
      },
    ],
    channelMembers: {
      [EXEC_CHANNEL]: ['U_ALICE', 'UBOT'],
    },
    workspaceUsers: [
      { id: 'U_ALICE', teamId: 'TDEMO' },
      { id: 'UBOT', teamId: 'TDEMO', isBot: true, isAppUser: true },
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
    // Pin an in-memory DB so this single-process offline gate stays
    // deterministic across runs (no cross-run accumulation in ./tmp/flue.db).
    env: {
      TAG_DB_PATH: ':memory:',
      SLACK_STATE_DB_PATH: stateDbPath,
      CHICKPEA_CREDENTIAL_KEYRING_PATH: keyringPath,
      CHICKPEA_AUTH_SECRET: '9d'.repeat(32),
    },
  });
  child = spawned.child;
  const { baseUrl, eventsUrl, getOutput } = spawned;
  getServerOutput = getOutput;
  await waitForReady(child, eventsUrl, getOutput);
  console.log(`flue node server ready at ${baseUrl}`);

  // Exercise the built, composed Node app, including its global middleware
  // and route ordering, not just the isolated public-assets router.
  const { PUBLIC_ASSET_PATHS } = await loadTsModule('src/assets/public-assets.ts');
  for (const assetPath of PUBLIC_ASSET_PATHS) {
    const response = await fetch(`${baseUrl}/${assetPath}`);
    if (response.status !== 200 ||
        !Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(REPO_ROOT, 'assets', assetPath)))) {
      throw new Error(`Built Node public asset failed: ${assetPath} (HTTP ${response.status})`);
    }
  }
  record('built Node app serves every public image without authentication', true,
    `${PUBLIC_ASSET_PATHS.length} byte-identical images`);

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

  // Check 4: status rejection latches native semantic activity off without
  // reviving the legacy chat-message progress fallback or storming setStatus.
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
    const nonEmpty = backend
      .statusCalls()
      .filter((entry) => String(entry.body.status) !== '');

    const passed =
      finals.length === 1 &&
      final !== undefined &&
      progressPosts.length === 0 &&
      nonEmpty.length <= 2;
    record(
      'status rejected -> final delivered without legacy progress fallback',
      passed,
      `finals=${finals.length} progressPosts=${progressPosts.length} ` +
        `finalIndex=${final?.index} nonEmptyStatus=${nonEmpty.length}`,
    );
  }

  // Check 5: provider failures produce one static, sanitized Slack final. The
  // teammate should not see raw provider details or a status left spinning.
  {
    backend.reset();
    backend.configure({ slack: { rejectSetStatus: false }, provider: { mode: 'http_500' } });
    await postSignedEvent(
      eventsUrl,
      craftMention({ eventId: 'Ev_OFFLINE_500', ts: '1782770920.000100' }),
    );
    const finals = await waitForFinals(backend, 1, 15_000);
    const [final] = finals;
    const lastStatus = backend.statusCalls().at(-1);
    const statusCleared = lastStatus === undefined || String(lastStatus.body.status) === '';
    const slackWire = JSON.stringify(backend.wireLog);
    const statusSettled = lastStatus === undefined || String(lastStatus.body.status) === '';

    const passed =
      finals.length === 1 &&
      final?.text === AGENT_FAILURE_TEXT &&
      !slackWire.includes(RAW_PROVIDER_ERROR_MARKER) &&
      statusCleared;
    record(
      'provider 500 -> one sanitized final, status cleared, no raw error leak',
      passed,
      `finals=${finals.length} sanitized=${final?.text === AGENT_FAILURE_TEXT} ` +
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
