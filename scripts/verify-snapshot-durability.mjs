#!/usr/bin/env node
/**
 * Helper invoked by verify-durability.mjs to prove live Agent config survives
 * a process restart. It remains directly runnable for focused diagnosis.
 *
 * Flow (offline, fake Slack/provider):
 *   1. Boot the built app on DB_A + STATE_A.
 *   2. Patch the assigned profile to instructions A through /admin/api/*.
 *   3. First turn in a Slack thread uses instructions A.
 *   4. Patch the Agent to instructions B through /admin/api/*.
 *   5. SIGKILL, restart on the same DB_A + STATE_A.
 *   6. Follow up in the same thread. The provider request and Admin effective
 *      config must both carry B because Agent edits apply on the next message.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertNodeVersion,
  buildNodeServer,
  delay,
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

const WORKSPACE = 'TDEMO123';
const APP_ID = 'ADEMO123';
const BOT_USER_ID = 'UBOT1234';
const ACTOR_USER_ID = 'UALICE01';
const EXEC_CHANNEL = 'CEXEC123';
const ROOT_TS = '1782772000.000100';
const ALPHA = 'SNAPSHOT_SCRIPT_ALPHA: original instructions for this thread.';
const BETA = 'SNAPSHOT_SCRIPT_BETA: edited instructions for the live Agent.';

const results = [];
let personalToken = '';

function log(line) {
  console.log(line);
}

function record(name, passed, detail) {
  results.push({ name, passed });
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function mention({ eventId, ts, threadTs, text }) {
  return {
    token: 'verification-token-not-a-secret',
    team_id: WORKSPACE,
    api_app_id: APP_ID,
    event_id: eventId,
    event_time: 1782772000,
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: ACTOR_USER_ID,
      text,
      ts,
      channel: EXEC_CHANNEL,
      event_ts: ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
  };
}

async function startServer({ serverEntry, fakeUrl, dbPath, stateDbPath, keyringPath, netGuardLog, port = undefined }) {
  const resolvedPort = port ?? await getFreePort();
  const server = spawnServer({
    serverEntry,
    port: resolvedPort,
    fakeUrl,
    netGuardLog,
    env: {
      TAG_DB_PATH: dbPath,
      SLACK_STATE_DB_PATH: stateDbPath,
      CHICKPEA_CREDENTIAL_KEYRING_PATH: keyringPath,
      CHICKPEA_AUTH_SECRET: '9d'.repeat(32),
      SLACK_TAG_MODEL: 'local-stub/snapshot-durability',
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
  headers.set('authorization', `Bearer ${personalToken}`);
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
  const current = await adminRequest(baseUrl, '/admin/api/agents/agent_default');
  if (current.status !== 200 || typeof current.body?.agent?.revision !== 'number') {
    return current;
  }
  return adminRequest(baseUrl, '/admin/api/agents/agent_default', {
    method: 'PATCH',
    body: JSON.stringify({
      expectedRevision: current.body.agent.revision,
      instructions,
    }),
  });
}

async function effectiveConfig(baseUrl) {
  return adminRequest(
    baseUrl,
    `/admin/api/effective-config?workspaceId=${WORKSPACE}&channelId=${EXEC_CHANNEL}`,
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

const { FakeSlackBackend } = await loadFake();
const backend = new FakeSlackBackend({
  slack: {
    identity: { appId: APP_ID, teamId: WORKSPACE, botUserId: BOT_USER_ID },
    channels: [{ id: EXEC_CHANNEL, name: 'exec', isMember: true, teamId: WORKSPACE }],
    channelMembers: { [EXEC_CHANNEL]: [ACTOR_USER_ID, BOT_USER_ID] },
    workspaceUsers: [
      { id: ACTOR_USER_ID, teamId: WORKSPACE },
      { id: BOT_USER_ID, teamId: WORKSPACE, isBot: true, isAppUser: true },
    ],
  },
  provider: { mode: 'ok', replyText: 'snapshot durability ok' },
});

const dbDir = mkdtempSync(join(tmpdir(), 'flue-snapshot-db-'));
const dbPath = join(dbDir, 'flue.db');
const stateDbPath = join(dbDir, 'state.db');
const keyringPath = join(dbDir, 'credential-keyring.json');
const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-snapshot-guard-')), 'external-hosts.log');
let firstProviderBody = '';
let secondProviderBody = '';
let effectiveBeforeRestart;
let effectiveAfterRestart;

try {
  const fake = await backend.listen();
  const serverEntry = await buildNodeServer();
  log(`built node server: ${serverEntry}`);
  log(`node ${assertNodeVersion()}  DB=${dbPath}  STATE=${stateDbPath}`);
  log(`fake backend listening at ${fake.url}`);
  await seedOfflineDemoChannelConfig(stateDbPath, { workspaceId: WORKSPACE, channelId: EXEC_CHANNEL });
  const initialPort = await getFreePort();
  personalToken = await seedOfflineSlackAuthority({
    stateDbPath,
    keyringPath,
    canonicalOrigin: `http://127.0.0.1:${initialPort}`,
    teamId: WORKSPACE,
    slackUserId: ACTOR_USER_ID,
    appId: APP_ID,
    botUserId: BOT_USER_ID,
  });

  let server = await startServer({
    serverEntry, fakeUrl: fake.url, dbPath, stateDbPath, keyringPath, netGuardLog, port: initialPort,
  });
  const patchA = await patchInstructions(server.baseUrl, ALPHA);
  record('admin patch writes initial instructions', patchA.status === 200, `status=${patchA.status}`);

  await postSignedEvent(
    server.eventsUrl,
    mention({
      eventId: 'Ev_SNAPSHOT_DUR_T1',
      ts: ROOT_TS,
      text: `<@${BOT_USER_ID}> start this snapshot durability thread`,
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
  log('server SIGKILLed after the first turn and Agent edit');

  backend.reset();
  server = await startServer({ serverEntry, fakeUrl: fake.url, dbPath, stateDbPath, keyringPath, netGuardLog });
  effectiveAfterRestart = await effectiveConfig(server.baseUrl);
  await postSignedEvent(
    server.eventsUrl,
    mention({
      eventId: 'Ev_SNAPSHOT_DUR_T2',
      ts: '1782772001.000100',
      threadTs: ROOT_TS,
      text: `<@${BOT_USER_ID}> continue after restart`,
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
    'post-restart same-thread provider request carries current Agent instructions',
    !secondHasAlpha && secondHasBeta,
    `alpha=${secondHasAlpha} beta=${secondHasBeta}`,
  );
  record(
    'post-restart admin effective config still carries edited instructions',
    effectiveAfterRestart.status === 200 && restartedEffectiveHasBeta,
    `status=${effectiveAfterRestart.status} beta=${restartedEffectiveHasBeta}`,
  );
  log(
    `matching pre/post-restart instruction marker: ` +
      `${firstHasAlpha ? 'ALPHA' : 'missing'} -> ${secondHasBeta ? 'BETA' : 'missing'}`,
  );

  const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  record('NET_GUARD_LOG empty -> zero external traffic', attempted === '', attempted || 'none');
} catch (error) {
  record('live Agent durability harness', false, error instanceof Error ? error.stack : String(error));
} finally {
  await backend.close();
  rmSync(dbDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.passed);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
