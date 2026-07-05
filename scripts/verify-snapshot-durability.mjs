#!/usr/bin/env node
/**
 * Proves per-thread config snapshots survive a process restart.
 *
 * Flow (offline, fake Slack/provider):
 *   1. Boot the built app on DB_A + STATE_A.
 *   2. Patch the assigned profile to instructions A through /admin/api/*.
 *   3. First turn in a Slack thread writes the thread snapshot.
 *   4. Patch the profile to instructions B through /admin/api/*.
 *   5. SIGKILL, restart on the same DB_A + STATE_A.
 *   6. Follow up in the same thread. The provider request must still carry A,
 *      while the admin effective config reports B for future threads.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  assertNodeVersion,
  buildNodeServer,
  delay,
  getFreePort,
  loadFake,
  postSignedEvent,
  seedOfflineDemoChannelConfig,
  spawnServer,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const INTERNAL_TOKEN = 'snapshot-internal-token';
const ADMIN_TOKEN = 'snapshot-admin-token';
const EXEC_CHANNEL = 'C_EXEC';
const ROOT_TS = '1782772000.000100';
const ALPHA = 'SNAPSHOT_SCRIPT_ALPHA: original instructions for this thread.';
const BETA = 'SNAPSHOT_SCRIPT_BETA: edited instructions for future threads.';
const ARTIFACT_DIR = join(REPO_ROOT, 'docs', 'decisions', 'artifacts', 'snapshot-activation');

const logLines = [];
const results = [];

function log(line) {
  logLines.push(line);
  console.log(line);
}

function record(name, passed, detail) {
  results.push({ name, passed });
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function mention({ eventId, ts, threadTs, text }) {
  return {
    token: 'verification-token-not-a-secret',
    team_id: 'T_DEMO',
    api_app_id: 'A_DEMO',
    event_id: eventId,
    event_time: 1782772000,
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: 'U_ALICE',
      text,
      ts,
      channel: EXEC_CHANNEL,
      event_ts: ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
  };
}

async function startServer({ serverEntry, fakeUrl, dbPath, stateDbPath, netGuardLog }) {
  const port = await getFreePort();
  const server = spawnServer({
    serverEntry,
    port,
    fakeUrl,
    netGuardLog,
    env: {
      FLUE_DB_PATH: dbPath,
      SLACK_STATE_DB_PATH: stateDbPath,
      FLUE_AGENT_API_TOKEN: INTERNAL_TOKEN,
      FLUE_ADMIN_TOKEN: ADMIN_TOKEN,
      SLACK_FLUE_MODEL: 'local-stub/snapshot-durability',
    },
  });
  try {
    await waitForReady(server.child, server.eventsUrl, server.getOutput);
  } catch (error) {
    await stopChild(server.child);
    throw error;
  }
  return server;
}

async function adminRequest(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${ADMIN_TOKEN}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function patchInstructions(baseUrl, instructions) {
  return adminRequest(baseUrl, '/admin/api/agents/agent_exec_brief', {
    method: 'PATCH',
    body: JSON.stringify({ instructions }),
  });
}

async function effectiveConfig(baseUrl) {
  return adminRequest(
    baseUrl,
    `/admin/api/effective-config?workspaceId=T_DEMO&channelId=${EXEC_CHANNEL}`,
  );
}

async function waitForProviderCalls(backend, minCalls, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.providerCalls().length >= minCalls) {
      return backend.providerCalls();
    }
    await delay(200);
  }
  return backend.providerCalls();
}

function providerBodyText(call) {
  return JSON.stringify(call?.body ?? {});
}

function writeArtifact(fileName, content) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, fileName), content);
}

const { FakeSlackBackend } = await loadFake();
const backend = new FakeSlackBackend({ provider: { mode: 'ok', replyText: 'snapshot durability ok' } });

const dbDir = mkdtempSync(join(tmpdir(), 'flue-snapshot-db-'));
const dbPath = join(dbDir, 'flue.db');
const stateDbPath = join(dbDir, 'state.db');
const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-snapshot-guard-')), 'external-hosts.log');
let firstProviderBody = '';
let secondProviderBody = '';
let effectiveBeforeRestart;
let effectiveAfterRestart;

try {
  const fake = await backend.listen();
  const serverEntry = await buildNodeServer('dist-snapshot');
  log(`built node server: ${serverEntry}`);
  log(`node ${assertNodeVersion()}  DB=${dbPath}  STATE=${stateDbPath}`);
  log(`fake backend listening at ${fake.url}`);
  await seedOfflineDemoChannelConfig(stateDbPath);

  let server = await startServer({ serverEntry, fakeUrl: fake.url, dbPath, stateDbPath, netGuardLog });
  const patchA = await patchInstructions(server.baseUrl, ALPHA);
  record('admin patch writes initial instructions', patchA.status === 200, `status=${patchA.status}`);

  await postSignedEvent(
    server.eventsUrl,
    mention({
      eventId: 'Ev_SNAPSHOT_DUR_T1',
      ts: ROOT_TS,
      text: '<@U_BOT> start this snapshot durability thread',
    }),
  );
  await waitForFinals(backend, 1, 15_000);
  const firstCalls = await waitForProviderCalls(backend, 1);
  firstProviderBody = providerBodyText(firstCalls.at(-1));
  const firstHasAlpha = firstProviderBody.includes(ALPHA);
  const firstHasBeta = firstProviderBody.includes(BETA);
  record(
    'pre-restart provider request carries the initial instructions',
    firstHasAlpha && !firstHasBeta,
    `alpha=${firstHasAlpha} beta=${firstHasBeta}`,
  );

  const patchB = await patchInstructions(server.baseUrl, BETA);
  effectiveBeforeRestart = await effectiveConfig(server.baseUrl);
  const effectiveHasBeta = JSON.stringify(effectiveBeforeRestart.body).includes(BETA);
  record(
    'admin edit changes effective config for future threads',
    patchB.status === 200 && effectiveBeforeRestart.status === 200 && effectiveHasBeta,
    `patchStatus=${patchB.status} effectiveStatus=${effectiveBeforeRestart.status} beta=${effectiveHasBeta}`,
  );

  await stopChild(server.child);
  log('server SIGKILLed after writing the snapshot and editing config');

  backend.reset();
  server = await startServer({ serverEntry, fakeUrl: fake.url, dbPath, stateDbPath, netGuardLog });
  effectiveAfterRestart = await effectiveConfig(server.baseUrl);
  await postSignedEvent(
    server.eventsUrl,
    mention({
      eventId: 'Ev_SNAPSHOT_DUR_T2',
      ts: '1782772001.000100',
      threadTs: ROOT_TS,
      text: '<@U_BOT> continue after restart',
    }),
  );
  await waitForFinals(backend, 1, 15_000);
  const secondCalls = await waitForProviderCalls(backend, 1);
  secondProviderBody = providerBodyText(secondCalls.at(-1));
  const secondHasAlpha = secondProviderBody.includes(ALPHA);
  const secondHasBeta = secondProviderBody.includes(BETA);
  const restartedEffectiveHasBeta = JSON.stringify(effectiveAfterRestart.body).includes(BETA);
  await stopChild(server.child);

  record(
    'post-restart same-thread provider request still carries initial instructions',
    secondHasAlpha && !secondHasBeta,
    `alpha=${secondHasAlpha} beta=${secondHasBeta}`,
  );
  record(
    'post-restart admin effective config still carries edited instructions',
    effectiveAfterRestart.status === 200 && restartedEffectiveHasBeta,
    `status=${effectiveAfterRestart.status} beta=${restartedEffectiveHasBeta}`,
  );
  log(`matching pre/post-restart instruction marker: ${firstHasAlpha ? 'ALPHA' : 'missing'} -> ${secondHasAlpha ? 'ALPHA' : 'missing'}`);

  const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  record('NET_GUARD_LOG empty -> zero external traffic', attempted === '', attempted || 'none');
} catch (error) {
  record('snapshot durability harness', false, error instanceof Error ? error.stack : String(error));
} finally {
  await backend.close();
}

const failed = results.filter((result) => !result.passed);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeArtifact('snapshot-durability-run.log', `${logLines.join('\n')}\n`);
writeArtifact(
  'snapshot-durability-provider-bodies.json',
  `${JSON.stringify(
    {
      preRestartProviderBody: firstProviderBody,
      postRestartProviderBody: secondProviderBody,
      effectiveBeforeRestart: effectiveBeforeRestart?.body,
      effectiveAfterRestart: effectiveAfterRestart?.body,
    },
    null,
    2,
  )}\n`,
);

process.exit(failed.length === 0 ? 0 : 1);
