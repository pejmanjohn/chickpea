#!/usr/bin/env node
/**
 * Offline production-process proof for the Node routine scheduler.
 *
 * Builds the real Node artifacts, starts scripts/start-node.mjs with an
 * explicit environment file, and uses isolated SQLite plus loopback-only fake
 * Slack and model services. The net guard rejects and records external fetches.
 *
 * Checks:
 *   1. a due one-time schedule executes and delivers exactly once;
 *   2. a clean restart runs a heartbeat without replaying that occurrence;
 *   3. a second process cannot use the same state database;
 *   4. a hard restart during a held model call reattaches the persisted
 *      admission/receipt and produces one final delivery.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVENTS_PATH,
  NET_GUARD,
  REPO_ROOT,
  assertNodeVersion,
  buildNodeServer,
  delay,
  getFreePort,
  loadFake,
  loadTsModule,
  seedOfflineDemoChannelConfig,
  seedOfflineSlackAuthority,
  waitForReady,
} from './lib/offline-harness.mjs';

const WORKSPACE_ID = 'TDEMO';
const CHANNEL_ID = 'C_EXEC';
const USER_ID = 'U_ALICE';
const BOT_USER_ID = 'UBOT';
const AGENT_ID = 'agent_default';
const RESULT_MARKER = 'node-schedule-process-proof';
const TERMINAL_STATUSES = new Set(['succeeded', 'no_op', 'failed', 'skipped']);
const POLL_INTERVAL_MS = 100;

assertNodeVersion();
const directory = mkdtempSync(join(tmpdir(), 'chickpea-node-scheduler-offline-'));
const statePath = join(directory, 'state.sqlite');
const transcriptPath = join(directory, 'transcripts.sqlite');
const authPath = join(directory, 'auth.sqlite');
const keyringPath = join(directory, 'credential-keyring.json');
const netGuardLog = join(directory, 'external-fetch.log');
const environmentKeys = [
  'SLACK_STATE_DB_PATH',
  'TAG_DB_PATH',
  'CHICKPEA_CREDENTIAL_KEYRING_PATH',
  'CHICKPEA_DISABLE_TELEMETRY',
];
const priorEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
Object.assign(process.env, {
  SLACK_STATE_DB_PATH: statePath,
  TAG_DB_PATH: transcriptPath,
  CHICKPEA_CREDENTIAL_KEYRING_PATH: keyringPath,
  CHICKPEA_DISABLE_TELEMETRY: 'true',
});

let SqliteRoutineStore;
let SqliteConfigStore;
let SqliteIdentityStore;
let backend;
let fake;
const providerCalls = [];
let holdProvider = false;
let provider;
async function handleProviderRequest(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  providerCalls.push({ path: request.url, model: body.model, held: holdProvider });
  if (holdProvider) return;
  const resultTool = body.tools?.find((tool) =>
    tool.function?.name === 'submit_routine_result');
  if (!resultTool) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Expected routine result tool.' } }));
    return;
  }
  const base = {
    id: 'chatcmpl-node-scheduler-offline',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model: body.model,
  };
  const args = JSON.stringify({ outcome: 'succeeded', message: RESULT_MARKER });
  const events = [
    {
      ...base,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_node_scheduler_offline',
            type: 'function',
            function: { name: 'submit_routine_result', arguments: args },
          }],
        },
        finish_reason: null,
      }],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    {
      ...base,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}
let providerUrl;

let store;
const ownedRuns = new Set();

function pass(name, detail) {
  console.log(`PASS  ${name} — ${detail}`);
}

function writeRuntimeEnvironment(port, suffix) {
  const origin = `http://127.0.0.1:${port}`;
  const file = join(directory, `runtime-${suffix}.env`);
  const values = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    TAG_DB_PATH: transcriptPath,
    SLACK_STATE_DB_PATH: statePath,
    CHICKPEA_CREDENTIAL_KEYRING_PATH: keyringPath,
    CHICKPEA_AUTH_DB_PATH: authPath,
    CHICKPEA_AUTH_SECRET: '9d'.repeat(32),
    CHICKPEA_GATEWAY_URL: '',
    SLACK_TAG_PUBLIC_URL: origin,
    SLACK_API_URL: `${fake.url}/api/`,
    LOCAL_STUB_URL: providerUrl,
    SLACK_TAG_MODEL: 'local-stub/parity-stub-1',
    CHICKPEA_DISABLE_TELEMETRY: 'true',
    DO_NOT_TRACK: '1',
  };
  writeFileSync(
    file,
    `${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`,
    { mode: 0o600 },
  );
  return { file, origin };
}

function scrubbedChildEnvironment() {
  const env = { ...process.env };
  const scrubbedPrefixes = [
    'ANTHROPIC_', 'CHICKPEA_', 'CLOUDFLARE_', 'COMPOSIO_', 'GITHUB_',
    'LOCAL_STUB_', 'OPENAI_', 'OPENROUTER_', 'SLACK_',
  ];
  for (const key of Object.keys(env)) {
    if (scrubbedPrefixes.some((prefix) => key.startsWith(prefix)) ||
        ['HOST', 'NODE_ENV', 'PORT', 'TAG_DB_PATH', 'NET_GUARD_ALLOW', 'NODE_OPTIONS'].includes(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    NODE_OPTIONS: `--import ${NET_GUARD}`,
    NET_GUARD_LOG: netGuardLog,
  };
}

function launch(environmentFile, origin) {
  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'scripts/start-node.mjs'), '--env-file', environmentFile],
    {
      cwd: REPO_ROOT,
      env: scrubbedChildEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const run = { child, output: () => output, origin };
  ownedRuns.add(run);
  return run;
}

async function waitForExit(run, timeoutMs = 10_000) {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return;
  let timeout;
  try {
    await Promise.race([
      once(run.child, 'exit'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Owned Node process did not stop.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function stop(run, signal = 'SIGTERM') {
  if (!run) return;
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill(signal);
  await waitForExit(run);
  ownedRuns.delete(run);
}

async function poll(label, run, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    if (run?.child.exitCode !== null) {
      throw new Error(`${label}: Node process exited early (${run.child.exitCode}).\n${run.output()}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${label}: timed out.\n${run?.output() ?? ''}`);
}

async function waitForHeartbeat(run) {
  await poll('startup routine heartbeat', run, () =>
    /event: 'routine\.heartbeat'/.test(run.output()));
}

async function seedSchedule(routineId) {
  const now = Date.now();
  const routine = await store.save({
    actorId: USER_ID,
    actorClass: 'member',
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    draft: {
      action: 'create',
      routineId,
      definition: {
        name: 'Offline Node schedule',
        description: 'Production-process scheduler verification.',
        taskText: `Submit ${RESULT_MARKER} as the final routine result.`,
        triggerKind: 'once',
        scheduleInput: 'Now',
        scheduleJson: JSON.stringify({ version: 1, kind: 'once', at: now }),
        timezone: 'UTC',
        outputPolicy: 'post',
        authorityMode: 'live_channel_v1',
      },
      nextRunAt: now,
      projectedDailyStarts: 0,
      reservations: [{ windowStart: now, count: 1 }],
    },
    idempotencyKey: `offline:create:${routineId}`,
  });
  const identity = new SqliteIdentityStore(statePath);
  const config = new SqliteConfigStore(statePath);
  try {
    const actor = await identity.resolveSlackIdentity(WORKSPACE_ID, USER_ID);
    assert(actor?.membership?.id, 'Offline Slack member was not seeded.');
    await config.putAgentScheduleReference({
      scheduleId: routine.id,
      agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      channelId: CHANNEL_ID,
      destinationKind: 'channel',
      destinationBindingDigest: null,
      createdByMembershipId: actor.membership.id,
      runsAsMembershipId: actor.membership.id,
      authorityReceiptId: `receipt_${routineId}`,
      requiredConnectionAccountIds: [],
      boundRoutineVersion: routine.authorityBindingVersion ?? routine.version,
      state: 'active',
    });
  } finally {
    config.close();
    identity.close();
  }
  return routine;
}

function deliveredMarkers() {
  return backend.callsOfMethod('chat.postMessage').filter((call) =>
    JSON.stringify(call.body).includes(RESULT_MARKER));
}

let failure;
try {
  const fakeModule = await loadFake();
  ({ SqliteRoutineStore } = await loadTsModule('src/routines/store.ts'));
  ({ SqliteConfigStore } = await loadTsModule('src/config/store.ts'));
  ({ SqliteIdentityStore } = await loadTsModule('src/identity/store.ts'));
  backend = new fakeModule.FakeSlackBackend({
    slack: {
      channels: [{ id: CHANNEL_ID, name: 'node-schedules', isMember: true, teamId: WORKSPACE_ID }],
      channelMembers: { [CHANNEL_ID]: [USER_ID, BOT_USER_ID] },
      workspaceUsers: [
        { id: USER_ID, teamId: WORKSPACE_ID },
        { id: BOT_USER_ID, teamId: WORKSPACE_ID, isBot: true, isAppUser: true },
      ],
    },
  });
  provider = createServer(handleProviderRequest);
  fake = await backend.listen();
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  await buildNodeServer();
  await seedOfflineDemoChannelConfig(statePath);
  store = new SqliteRoutineStore(statePath);

  const port = await getFreePort();
  const primaryEnvironment = writeRuntimeEnvironment(port, 'primary');
  await seedOfflineSlackAuthority({
    stateDbPath: statePath,
    keyringPath,
    canonicalOrigin: primaryEnvironment.origin,
    teamId: WORKSPACE_ID,
    slackUserId: USER_ID,
    appId: 'ADEMO',
    botUserId: BOT_USER_ID,
  });
  const config = new SqliteConfigStore(statePath);
  try {
    await config.updateAgent(AGENT_ID, { model: 'local-stub/parity-stub-1' });
  } finally {
    config.close();
  }

  const firstRoutine = await seedSchedule('routine_node_once');
  let run = launch(primaryEnvironment.file, primaryEnvironment.origin);
  await waitForReady(run.child, `${run.origin}${EVENTS_PATH}`, run.output);
  const firstOccurrence = await poll('first scheduled occurrence', run, async () => {
    const [occurrence] = await store.listRuns({ routineId: firstRoutine.id });
    return occurrence && TERMINAL_STATUSES.has(occurrence.status) ? occurrence : undefined;
  });
  assert.equal(firstOccurrence.status, 'succeeded', JSON.stringify(firstOccurrence));
  assert.equal(deliveredMarkers().length, 1);
  assert.equal((await store.getRoutine(firstRoutine.id)).state, 'completed');
  pass('due schedule delivered once', `occurrence=${firstOccurrence.id}`);

  const secondPort = await getFreePort();
  const secondEnvironment = writeRuntimeEnvironment(secondPort, 'overlap');
  const overlap = launch(secondEnvironment.file, secondEnvironment.origin);
  await waitForExit(overlap);
  ownedRuns.delete(overlap);
  assert.equal(overlap.child.exitCode, 1);
  assert.match(overlap.output(), /Another Chickpea Node process is already using/);
  assert.doesNotMatch(overlap.output(), /listening/i);
  pass('second process excluded', 'rejected before app startup');

  await stop(run);
  run = launch(primaryEnvironment.file, primaryEnvironment.origin);
  await waitForReady(run.child, `${run.origin}${EVENTS_PATH}`, run.output);
  await waitForHeartbeat(run);
  assert.equal((await store.listRuns({ routineId: firstRoutine.id })).length, 1);
  assert.equal(deliveredMarkers().length, 1);
  pass('clean restart did not duplicate delivery', `occurrence=${firstOccurrence.id}`);
  await stop(run);

  const crashRoutine = await seedSchedule('routine_node_crash');
  holdProvider = true;
  run = launch(primaryEnvironment.file, primaryEnvironment.origin);
  await waitForReady(run.child, `${run.origin}${EVENTS_PATH}`, run.output);
  const inFlight = await poll('persisted in-flight scheduled dispatch', run, async () => {
    const [occurrence] = await store.listRuns({ routineId: crashRoutine.id });
    const receipt = occurrence &&
      (await store.listAdmissions(occurrence.id)).at(-1)?.flueAgentReceipt;
    return receipt && providerCalls.some((call) => call.held) ? occurrence : undefined;
  });
  const admissionsBefore = await store.listAdmissions(inFlight.id);
  assert(admissionsBefore.at(-1)?.flueAgentReceipt, 'Persisted Flue receipt was not observed.');
  await stop(run, 'SIGKILL');

  holdProvider = false;
  run = launch(primaryEnvironment.file, primaryEnvironment.origin);
  await waitForReady(run.child, `${run.origin}${EVENTS_PATH}`, run.output);
  const recovered = await poll('recovered scheduled occurrence', run, async () => {
    const occurrence = await store.getRun(inFlight.id);
    return occurrence && TERMINAL_STATUSES.has(occurrence.status) ? occurrence : undefined;
  }, 45_000);
  const admissionsAfter = await store.listAdmissions(inFlight.id);
  assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered));
  assert.equal((await store.listRuns({ routineId: crashRoutine.id })).length, 1);
  assert.equal(admissionsAfter.length, admissionsBefore.length);
  assert.deepEqual(
    admissionsAfter.at(-1)?.flueAgentReceipt,
    admissionsBefore.at(-1)?.flueAgentReceipt,
  );
  assert.equal(deliveredMarkers().length, 2);
  pass('hard restart reattached persisted admission', `occurrence=${recovered.id}`);
  await stop(run);

  const blocked = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  assert.equal(blocked, '');
  pass('network guard stayed empty', 'zero external fetch attempts');
} catch (error) {
  failure = error;
} finally {
  for (const run of ownedRuns) await stop(run, 'SIGKILL').catch(() => undefined);
  store?.close();
  if (provider?.listening) {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
  await backend?.close();
  for (const [key, value] of priorEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
}

if (failure) {
  console.error(failure instanceof Error ? failure.stack : String(failure));
  process.exitCode = 1;
}
