#!/usr/bin/env node
/**
 * Prove runtime-editable agent config works without a restart and without
 * external network access.
 *
 * Flow:
 *   1. build the real Flue Node target,
 *   2. boot one server process against fake Slack + local-stub provider,
 *   3. create an agent and channel assignment through /admin/api/*,
 *   4. send a signed Slack mention in the newly assigned channel,
 *   5. assert the provider request carries the new model, instructions, and
 *      channel addendum, and that Slack receives the final reply.
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
  spawnServer,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const ADMIN_TOKEN = 'agent-config-admin-token';
const NEW_CHANNEL = 'C_NEW';
const NEW_THREAD_TS = '1782771200.000100';
const AGENT_ID = 'agent_runtime_config';
const MODEL_SPECIFIER = 'local-stub/agent-config-model';
const PROVIDER_MODEL = 'agent-config-model';
const INSTRUCTIONS_MARKER = 'AGENT_CONFIG_INSTRUCTIONS_MARKER';
const ADDENDUM_MARKER = 'AGENT_CONFIG_ADDENDUM_MARKER';

const { FakeSlackBackend, STUB_REPLY_MARKER } = await loadFake();
const appMention = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'app-mention.json'), 'utf8'),
);

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-agent-config-net-')), 'external.log');
const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function postAdminJson(baseUrl, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function mentionForNewChannel() {
  return {
    ...appMention,
    event_id: 'Ev_AGENT_CONFIG_NEW',
    event: {
      ...appMention.event,
      channel: NEW_CHANNEL,
      ts: NEW_THREAD_TS,
      event_ts: NEW_THREAD_TS,
      text: '<@U_BOT> prove runtime agent config',
    },
  };
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

const backend = new FakeSlackBackend();
let fake;
try {
  fake = await backend.listen();
  console.log(`fake Slack/provider backend listening at ${fake.url}`);
} catch (error) {
  // No in-process fallback here on purpose: a fallback that hand-simulates the
  // agent hop produces PASS lines indistinguishable from real-server evidence
  // (reviewed out 2026-07-05). Sandboxes that deny loopback listen cannot run
  // this verifier; fail loudly instead of fabricating a green gate.
  if (error && typeof error === 'object' && error.syscall === 'listen') {
    console.error(
      `verify-agent-config: loopback listen denied (${error.code}). This verifier ` +
        'needs a real server on 127.0.0.1 and has no weaker fallback — run it in an ' +
        'environment that allows loopback listeners.',
    );
    process.exit(1);
  }
  throw error;
}

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
      TAG_DB_PATH: ':memory:',
      TAG_ADMIN_TOKEN: ADMIN_TOKEN,
    },
  });
  child = spawned.child;
  const { baseUrl, eventsUrl, getOutput } = spawned;
  await waitForReady(child, eventsUrl, getOutput);
  console.log(`flue node server ready at ${baseUrl}`);

  const createAgent = await postAdminJson(baseUrl, 'POST', '/admin/api/agents', {
    id: AGENT_ID,
    name: 'Runtime Config Agent',
    instructions: `${INSTRUCTIONS_MARKER}: answer through the runtime-created agent.`,
    enabled: true,
    model: MODEL_SPECIFIER,
  });
  record(
    'POST /admin/api/agents creates runtime agent',
    createAgent.status === 201 && createAgent.body?.agent?.id === AGENT_ID,
    `status=${createAgent.status} body=${JSON.stringify(createAgent.body)}`,
  );

  const putAssignment = await postAdminJson(baseUrl, 'PUT', '/admin/api/assignments', {
    workspaceId: 'T_DEMO',
    channelId: NEW_CHANNEL,
    agentId: AGENT_ID,
    enabled: true,
    channelPromptAddendum: `${ADDENDUM_MARKER}: prefer the fresh channel assignment.`,
  });
  record(
    'PUT /admin/api/assignments creates addendum-bearing channel assignment',
    putAssignment.status === 200 &&
      putAssignment.body?.assignment?.channelPromptAddendum?.includes(ADDENDUM_MARKER),
    `status=${putAssignment.status} body=${JSON.stringify(putAssignment.body)}`,
  );

  backend.reset();
  const response = await postSignedEvent(eventsUrl, mentionForNewChannel());
  const finals = await waitForFinals(backend, 1, 15_000);
  const final = finals.at(-1);
  const provider = backend.providerCalls().at(-1);
  const serializedProvider = JSON.stringify(provider?.body ?? {});

  record(
    'signed mention in new channel returns 200',
    response.status === 200,
    `status=${response.status} body=${JSON.stringify(response.body)}`,
  );
  record(
    'provider request uses runtime-created agent model',
    provider?.body?.model === PROVIDER_MODEL,
    `model=${String(provider?.body?.model)}`,
  );
  record(
    'provider request contains runtime-created instructions and channel addendum',
    serializedProvider.includes(INSTRUCTIONS_MARKER) &&
      serializedProvider.includes(ADDENDUM_MARKER),
    `instructions=${serializedProvider.includes(INSTRUCTIONS_MARKER)} ` +
      `addendum=${serializedProvider.includes(ADDENDUM_MARKER)}`,
  );
  record(
    'Slack final reply lands in the new channel',
    finals.length === 1 &&
      final?.channel === NEW_CHANNEL &&
      final?.threadTs === NEW_THREAD_TS &&
      final?.text.includes(STUB_REPLY_MARKER),
    `finals=${finals.length} channel=${String(final?.channel)} thread=${String(final?.threadTs)}`,
  );

  const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  record(
    'NET_GUARD_LOG empty -> zero external traffic',
    attempted === '',
    attempted === '' ? 'no external hosts attempted' : `attempted: ${attempted}`,
  );
} catch (error) {
  record('verification harness', false, error instanceof Error ? error.message : String(error));
} finally {
  if (child) {
    await stopChild(child);
  }
  await backend.close();
}

finish();
