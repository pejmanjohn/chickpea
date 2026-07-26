#!/usr/bin/env node
/**
 * Restart-durability verification via file-backed `src/db.ts`.
 *
 * Proves conversation state survives a process restart. The app persists the
 * agent transcript to SQLite (db.ts), so a second turn in the same thread —
 * served by a BRAND NEW process on the same DB file — replays the first turn's
 * assistant reply from durable storage.
 *
 * Flow (all offline, net-guarded, stub provider):
 *   1. server1 on DB_A: T1 signed mention, stub replyText = DURABILITY_MARKER.
 *      SIGKILL server1.
 *   2. server2 on DB_A (fresh process, same DB): T2 signed mention in the SAME
 *      thread. Assert (i) T2 delivers a final on the wire; (ii) T2's provider
 *      request replays the marker (T1's assistant reply, loaded from the DB);
 *      (iii) GET .../{thread}?view=history returns BOTH turns.
 *   3. NEGATIVE CONTROL — server3 on a DIFFERENT fresh DB_B: the same follow-up
 *      turn's provider request must NOT contain the marker (no shared durable
 *      storage → no replay). This proves the assertion measures durability.
 *   4. DURABLE CLAIMS + THREAD REGISTRY (SqliteSlackStateStore, sibling
 *      `<db>.state` file): on yet another fresh process sharing DB_A,
 *      (i) a byte-identical redelivery of T1's event_id posts NO new final;
 *      (ii) a new-event_id message with T1's (channel, ts) posts NO new final;
 *      (iii) an implicit (mention-free) thread reply IS admitted and answered —
 *      the joined thread survived the restart. Negative control on DB_B: the
 *      same implicit reply produces nothing (thread never started there).
 *   5. Run the focused snapshot helper: edit profile config after a thread's
 *      first turn, restart, and prove that thread keeps its frozen config while
 *      future threads see the edit.
 *
 * Run with Node >= 22.19:
 *   node scripts/verify-durability.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  assertNodeVersion,
  buildNodeServer,
  delay,
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

const DURABILITY_MARKER = 'DURABILITY_MARKER_ALPHA';
const INTERNAL_TOKEN = 'durability-internal-token';
const EXEC_CHANNEL = 'C_EXEC';
const ROOT_TS = '1782770400.000100';
const THREAD_KEY = `T_DEMO:${EXEC_CHANNEL}:${ROOT_TS}:memory-e1`;

function log(line) {
  console.log(line);
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A signed mention-free channel thread reply (implicit continuation). */
function threadReply({ eventId, ts, threadTs }) {
  return {
    token: 'verification-token-not-a-secret',
    team_id: 'T_DEMO',
    api_app_id: 'A_DEMO',
    event_id: eventId,
    event_time: 1782770400,
    type: 'event_callback',
    event: {
      type: 'message',
      channel_type: 'channel',
      user: 'U_ALICE',
      text: 'and what changed since the summary?',
      ts,
      channel: EXEC_CHANNEL,
      event_ts: ts,
      thread_ts: threadTs,
    },
  };
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
      TAG_DB_PATH: dbPath,
      // Pin the state DB to the seeded `${dbPath}.state` explicitly: spawnServer
      // forwards ambient process.env, so an exported SLACK_STATE_DB_PATH (e.g.
      // from a live-Slack shell) would otherwise redirect every server here to
      // the operator's live state store and merge the three "isolated" DBs.
      SLACK_STATE_DB_PATH: `${dbPath}.state`,
      TAG_AGENT_API_TOKEN: INTERNAL_TOKEN,
      SLACK_TAG_MODEL: 'local-stub/parity-stub-1',
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
const backend = new FakeSlackBackend({
  slack: {
    identity: { teamId: 'T_DEMO' },
    channels: [{ id: EXEC_CHANNEL, name: 'exec', isMember: true }],
    channelMembers: { [EXEC_CHANNEL]: ['U_ALICE', 'U_BOT'] },
    workspaceUsers: [
      { id: 'U_ALICE', teamId: 'T_DEMO' },
      { id: 'U_BOT', teamId: 'T_DEMO', isBot: true, isAppUser: true },
    ],
  },
  provider: { mode: 'ok', replyText: DURABILITY_MARKER },
});
const fake = await backend.listen();
log(`fake backend listening at ${fake.url}`);

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-dur-guard-')), 'external-hosts.log');
const dbA = join(mkdtempSync(join(tmpdir(), 'flue-dur-dbA-')), 'flue.db');
const dbB = join(mkdtempSync(join(tmpdir(), 'flue-dur-dbB-')), 'flue.db');
// dbC is reserved for the thread-registry negative control: no turn ever runs
// on it before the implicit reply (dbB already saw a mention with ROOT_TS as
// its thread key, which would legitimately register the thread there).
const dbC = join(mkdtempSync(join(tmpdir(), 'flue-dur-dbC-')), 'flue.db');

try {
  const serverEntry = await buildNodeServer();
  log(`built node server: ${serverEntry}`);
  log(`node ${assertNodeVersion()}  DB_A=${dbA}  DB_B=${dbB}`);
  await seedOfflineDemoChannelConfig(`${dbA}.state`);
  await seedOfflineDemoChannelConfig(`${dbB}.state`);
  await seedOfflineDemoChannelConfig(`${dbC}.state`);

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
    const historyTranscript = await historyResponse.text();
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

  // --- Durable claims + registry: yet another fresh process on DB_A. ---
  backend.reset();
  {
    const { child, eventsUrl } = await runServerTurn({
      serverEntry,
      fakeUrl: fake.url,
      dbPath: dbA,
      netGuardLog,
      // Byte-identical redelivery of T1's event (same event_id, same ts).
      payload: mention({ eventId: 'Ev_DUR_T1', ts: ROOT_TS }),
    });
    await delay(4000);
    const afterRedelivery = backend.finals().length;
    record(
      'DURABLE CLAIMS: redelivered event_id after restart posts NO new final',
      afterRedelivery === 0,
      `finals=${afterRedelivery}`,
    );

    // New event_id, same (channel, message-ts): the msg: claim must hold.
    const twin = await postSignedEvent(eventsUrl, mention({ eventId: 'Ev_DUR_TWIN', ts: ROOT_TS }));
    await delay(4000);
    const afterTwin = backend.finals().length;
    record(
      'DURABLE CLAIMS: new event_id with the same (channel, ts) posts NO new final',
      twin.status === 200 && afterTwin === 0,
      `ackStatus=${twin.status} finals=${afterTwin}`,
    );

    // Mention-free thread reply: the durable registry admits it post-restart.
    await postSignedEvent(
      eventsUrl,
      threadReply({ eventId: 'Ev_DUR_IMPL', ts: '1782770700.000100', threadTs: ROOT_TS }),
    );
    const implicitFinals = await waitForFinals(backend, 1, 15_000);
    await stopChild(child);
    record(
      'DURABLE REGISTRY: implicit thread reply IS admitted after restart (one final)',
      implicitFinals.length === 1,
      `finals=${implicitFinals.length}`,
    );
  }

  // --- Registry negative control: implicit reply on untouched DB_C → silence. ---
  backend.reset();
  {
    const { child } = await runServerTurn({
      serverEntry,
      fakeUrl: fake.url,
      dbPath: dbC,
      netGuardLog,
      payload: threadReply({ eventId: 'Ev_DUR_IMPL_NEG', ts: '1782770800.000100', threadTs: ROOT_TS }),
    });
    await delay(4000);
    const finals = backend.finals().length;
    await stopChild(child);
    record(
      'NEGATIVE CONTROL: implicit reply on a DB whose thread never started posts NO final',
      finals === 0,
      `finals=${finals}`,
    );
  }

  // --- Memory state: additive upgrade, restart, compatibility open, scrub. ---
  {
    const { SqliteMemoryStateStore } = await loadTsModule('src/memory/store.ts');
    const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
    const memoryPath = `${dbA}.state`;
    const memorySentinel = 'MEMORY_DURABILITY_SENTINEL_ALPHA';
    const priorLegacyFlag = process.env.SLACK_TAG_MEMORY_ENABLED;
    process.env.SLACK_TAG_MEMORY_ENABLED = 'false';
    let memoryStore;
    try {
      memoryStore = new SqliteMemoryStateStore(memoryPath);
      const publicStore = await memoryStore.ensurePublicStore('T_DEMO');
      await memoryStore.observeChannelScope({
        workspaceId: 'T_DEMO',
        channelId: EXEC_CHANNEL,
        privacy: 'public',
        displayName: 'exec',
        observedAt: Date.now(),
      });
      await memoryStore.createEntry({
        entryId: 'mem_durability_sentinel',
        storeId: publicStore.storeId,
        workspaceId: 'T_DEMO',
        sourceChannelId: EXEC_CHANNEL,
        slug: 'durability-sentinel',
        description: 'Restart durability proof.',
        type: 'fact',
        body: memorySentinel,
        actorId: 'U_ALICE',
        actorClass: 'member',
        idempotencyKey: 'memory:durability:create',
      });
      memoryStore.close();
      memoryStore = undefined;

      // A config-only open stands in for rollback code that knows nothing about
      // the additive memory tables: it must boot and leave them untouched.
      const configOnly = new SqliteConfigStore(memoryPath, { agents: [], assignments: [] });
      await configOnly.listAgents();
      configOnly.close();

      memoryStore = new SqliteMemoryStateStore(memoryPath);
      const restarted = await memoryStore.getEntry('mem_durability_sentinel');
      record(
        'MEMORY DURABILITY: create survives close/restart and legacy false is inert',
        restarted?.body === memorySentinel && restarted.version === 1,
        `status=${String(restarted?.status)} version=${String(restarted?.version)}`,
      );
      await memoryStore.forgetEntry({
        entryId: 'mem_durability_sentinel',
        expectedVersion: 1,
        actorId: 'operator',
        actorClass: 'operator',
        idempotencyKey: 'memory:durability:forget',
      });
      memoryStore.close();
      memoryStore = undefined;

      memoryStore = new SqliteMemoryStateStore(memoryPath);
      const forgotten = await memoryStore.getEntry('mem_durability_sentinel');
      const revisions = await memoryStore.listRevisions('mem_durability_sentinel');
      memoryStore.close();
      memoryStore = undefined;
      record(
        'MEMORY DURABILITY: forget survives restart and removes recoverable revision content',
        forgotten?.status === 'forgotten' && forgotten.body === '' && forgotten.description === '' &&
          revisions.every((revision) => revision.body === null && revision.description === null),
        `status=${String(forgotten?.status)} revisions=${revisions.length}`,
      );
      record(
        'MEMORY DURABILITY: deleted sentinel is absent from the raw state file',
        !readFileSync(memoryPath).toString('latin1').includes(memorySentinel),
      );
    } finally {
      memoryStore?.close();
      if (priorLegacyFlag === undefined) delete process.env.SLACK_TAG_MEMORY_ENABLED;
      else process.env.SLACK_TAG_MEMORY_ENABLED = priorLegacyFlag;
    }
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

log('\nRunning snapshot-freeze restart verification...');
const snapshotRun = spawnSync(
  process.execPath,
  [join(REPO_ROOT, 'scripts', 'verify-snapshot-durability.mjs')],
  {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  },
);
record(
  'SNAPSHOT DURABILITY: frozen thread config survives a process restart',
  snapshotRun.status === 0,
  snapshotRun.error
    ? snapshotRun.error.message
    : `exit=${snapshotRun.status ?? 'signal'}${snapshotRun.signal ? ` signal=${snapshotRun.signal}` : ''}`,
);

const failed = results.filter((result) => !result.passed);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
