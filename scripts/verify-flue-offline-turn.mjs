#!/usr/bin/env node
/**
 * Stage-2 gate: prove one full Slack turn works completely offline under
 * `flue dev --target node` with zero external traffic.
 *
 * Checks:
 *   1. signed url_verification -> 200 + challenge echoed
 *   2. tampered signature      -> 401, no wire calls
 *   3. signed app_mention      -> 200, exactly ONE chat.postMessage final in
 *      C_EXEC thread 1782770400.000100 containing the stub reply marker
 *   4. NET_GUARD_LOG empty     -> zero external traffic
 *   5. direct POST to the internal agent endpoint without the internal
 *      token  -> 401 (proves the agent route is not reachable unauthenticated)
 *
 * Run with Node >= 22.19 (flue requirement):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/verify-flue-offline-turn.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FLUE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'flue');
const NET_GUARD = join(REPO_ROOT, 'scripts', 'net-guard.mjs');
const PORT = 3599;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const EVENTS_URL = `${BASE_URL}/channels/slack/events`;
const SIGNING_SECRET = 'test-signing-secret';
const EXEC_CHANNEL = 'C_EXEC';
const ROOT_THREAD_TS = '1782770400.000100';

// Load the Stage-0 fake backend (TypeScript) through tsx's runtime loader.
const { register } = await import('tsx/esm/api');
const unregister = register();
const { FakeSlackBackend, STUB_REPLY_MARKER } = await import(
  join(REPO_ROOT, 'tests', 'parity', 'fake-slack.ts')
);
unregister();

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-net-guard-')), 'external-hosts.log');

const appMention = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'app-mention.json'), 'utf8'),
);

function signedHeaders(rawBody, { tamper = false } = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  let digest = createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');
  if (tamper) {
    const last = digest.at(-1);
    digest = `${digest.slice(0, -1)}${last === '0' ? '1' : '0'}`;
  }
  return {
    'content-type': 'application/json',
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': `v0=${digest}`,
  };
}

async function postSignedEvent(payload, opts = {}) {
  const rawBody = JSON.stringify(payload);
  const response = await fetch(EVENTS_URL, {
    method: 'POST',
    headers: signedHeaders(rawBody, opts),
    body: rawBody,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const backend = new FakeSlackBackend();
const fake = await backend.listen();
console.log(`fake Slack/provider backend listening at ${fake.url}`);

const child = spawn(FLUE_BIN, ['dev', '--target', 'node', '--port', String(PORT)], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ''}`,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_TOKEN: 'test-bot-token',
    SLACK_BOT_USER_ID: 'U_BOT',
    SLACK_API_URL: `${fake.url}/api/`,
    LOCAL_STUB_URL: `${fake.url}/v1`,
    SLACK_FLUE_MODEL: 'local-stub/parity-stub-1',
    NET_GUARD_LOG: netGuardLog,
    NODE_OPTIONS: `--import ${NET_GUARD}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
child.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
child.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`flue dev exited early (code ${child.exitCode}):\n${serverOutput}`);
    }
    try {
      // The dev server accepts requests before the in-memory runtime finishes
      // loading (503 runtime_unavailable). Ready = any non-503 HTTP response.
      const response = await fetch(`${BASE_URL}/`, { method: 'GET' });
      if (response.status !== 503) {
        return;
      }
    } catch {
      // not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`flue dev never became ready:\n${serverOutput}`);
}

try {
  await waitForReady();
  console.log(`flue dev ready at ${BASE_URL}`);

  // Check 1: signed url_verification echoes the challenge.
  {
    const response = await postSignedEvent({
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
    const response = await postSignedEvent(appMention, { tamper: true });
    await backend.quiesce();
    const passed = response.status === 401 && backend.wireLog.length === wireBefore;
    record(
      'tampered signature -> 401, no wire calls',
      passed,
      `status=${response.status} newWireCalls=${backend.wireLog.length - wireBefore}`,
    );
  }

  // Check 3: signed app_mention drives one full offline turn.
  {
    const response = await postSignedEvent(appMention);
    await backend.quiesce();
    const posts = backend.callsOfMethod('chat.postMessage');
    const finalPost = posts[0];
    const passed =
      response.status === 200 &&
      posts.length === 1 &&
      finalPost !== undefined &&
      finalPost.body.channel === EXEC_CHANNEL &&
      finalPost.body.thread_ts === ROOT_THREAD_TS &&
      String(finalPost.body.text ?? '').includes(STUB_REPLY_MARKER);
    record(
      'signed app_mention -> 200 + exactly one final chat.postMessage with stub marker',
      passed,
      `status=${response.status} posts=${posts.length} body=${JSON.stringify(finalPost?.body ?? null)}`,
    );
  }

  // Check 4: zero external traffic.
  {
    const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
    record(
      'NET_GUARD_LOG empty -> zero external traffic',
      attempted === '',
      attempted === '' ? 'no external hosts attempted' : `attempted: ${attempted}`,
    );
  }

  // Check 5: the internal agent endpoint rejects direct callers that don't
  // present the internal token (Finding 2 — the channel's self-call is
  // signature-verified upstream on /channels/slack/events; this endpoint has
  // no other gate, so it must reject unauthenticated requests on its own).
  {
    const response = await fetch(`${BASE_URL}/agents/slack-thread/some-id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'unauthenticated probe' }),
    });
    const text = await response.text();
    record(
      'unauthenticated POST /agents/slack-thread/:id -> 401',
      response.status === 401,
      `status=${response.status} body=${text}`,
    );
  }
} catch (error) {
  record('verification harness', false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill('SIGKILL');
  await backend.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
