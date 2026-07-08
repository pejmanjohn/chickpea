/**
 * Cloudflare-target smoke gate: builds the CF bundle, boots it under a real
 * workerd (`wrangler dev`) against the in-memory fake Slack + fake provider
 * backend, and drives the FULL first-run story — no Slack credentials in the
 * environment, everything through the /admin Slack-connection wizard — then
 * SIGNED Slack events end-to-end. Asserts the parts of the port that only
 * workerd can prove:
 *
 *   1. the DO-backed config store seeds and serves /admin/api/agents,
 *   2. the app boots healthy with NO Slack creds: events fail closed (401)
 *      and the wizard GET reports missing credentials + a manifest deep-link
 *      carrying this install's substituted request_url,
 *   3. the wizard POST validates the pasted token against (fake) Slack
 *      auth.test and persists token/secret/bot-user-id in the DO settings,
 *   4. a signed synthetic app_mention verifies against the STORED signing
 *      secret, is admitted, and the turn delivers a final to (fake) Slack
 *      through the in-process dispatch + waitUntil path,
 *   5. an identical redelivery is deduped by the DO claim store,
 *   6. a workerd RESTART (same --persist-to) still dedupes the original
 *      event, still verifies with the stored secret, and still admits an
 *      implicit thread reply — Durable Object state survives the process,
 *   7. a tampered signature is rejected (the stored secret is really used).
 *
 * No secrets, no external traffic: every outbound URL points at 127.0.0.1.
 * Exit 0 on success, 1 with diagnostics on failure. SMOKE_SKIP_BUILD=1 reuses
 * an existing dist-cf (iteration speed); CI should run the full build.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT,
  SIGNING_SECRET,
  EVENTS_PATH,
  assertNodeVersion,
  getFreePort,
  loadFake,
  postSignedEvent,
  delay,
} from './lib/offline-harness.mjs';

const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
const CF_BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'flue-build-cf.mjs');
const CF_OUTPUT_DIR = join(REPO_ROOT, 'dist-cf');
const CF_WRANGLER_CONFIG = join(CF_OUTPUT_DIR, 'tag_team', 'wrangler.json');
const PERSIST_DIR = join(REPO_ROOT, '.wrangler-state');
const ADMIN_TOKEN = 'test-token';
const WORKSPACE = 'T_SMOKE';
const CHANNEL = 'C_SMOKE';
const MENTION_TS = '1782770400.000100';
const PORT = Number(process.env.SMOKE_WRANGLER_PORT ?? 8788);

// Slow-turn case: a distinct channel + thread whose provider is held open past
// the old ~30s waitUntil horizon, proving the DO alarm relay delivers anyway.
const SLOW_CHANNEL = 'C_SMOKE_SLOW';
const SLOW_MENTION_TS = '1782771000.000100';
// >35s so the turn outlives the ~30s cancellation a real deploy's events-
// invocation waitUntil would hit. Overridable for iteration; keep it above 35s.
const SLOW_TURN_DELAY_MS = Number(process.env.SMOKE_SLOW_TURN_DELAY_MS ?? 36_000);

const failures = [];
function check(ok, label, detail = '') {
  const status = ok ? 'ok  ' : 'FAIL';
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function buildCloudflareTarget() {
  if (process.env.SMOKE_SKIP_BUILD === '1' && existsSync(CF_WRANGLER_CONFIG)) {
    console.log('• SMOKE_SKIP_BUILD=1 — reusing existing dist-cf build');
    return;
  }
  console.log('• building Cloudflare target (flue-build-cf → dist-cf)…');
  const result = spawnSync(process.execPath, [CF_BUILD_SCRIPT, '--output', 'dist-cf'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`flue:build:cf failed (exit ${result.status})`);
  }
}

function verifyBuildArtifacts() {
  const config = JSON.parse(readFileSync(CF_WRANGLER_CONFIG, 'utf8'));
  const doBindings = config.durable_objects?.bindings ?? [];
  check(
    doBindings.some((b) => b.name === 'TAG_STATE' && b.class_name === 'TagStateStore'),
    'built wrangler.json carries the TAG_STATE binding',
  );
  check(
    doBindings.some((b) => String(b.class_name ?? '').startsWith('Flue')),
    'built wrangler.json carries the Flue agent DO bindings',
  );
  const tags = (config.migrations ?? []).map((m) => m.tag);
  check(
    tags.includes('v1') && tags.includes('v2'),
    'built wrangler.json migrations include v1 and v2',
    tags.join(','),
  );
  const redirect = join(REPO_ROOT, '.wrangler', 'deploy', 'config.json');
  const redirectBody = existsSync(redirect) ? readFileSync(redirect, 'utf8') : '';
  check(redirectBody.includes('dist-cf'), '.wrangler/deploy/config.json points into dist-cf');
  check(existsSync(join(REPO_ROOT, 'src', 'db.ts')), 'src/db.ts restored after the CF build');
}

function writeDevVars(fakeUrl) {
  // wrangler dev reads .dev.vars from the directory of the config file it was
  // given. dist-cf is disposable build output, so writing here never touches a
  // developer's real .dev.vars in the repo root.
  //
  // Deliberately NO Slack credentials here: this smoke runs the real deploy
  // story — the app boots credential-less and the /admin wizard stores the
  // bot token, signing secret, and bot user id into the DO settings store.
  writeFileSync(
    join(CF_OUTPUT_DIR, 'tag_team', '.dev.vars'),
    [
      `TAG_ADMIN_TOKEN=${ADMIN_TOKEN}`,
      `SLACK_API_URL=${fakeUrl}/api/`,
      `LOCAL_STUB_URL=${fakeUrl}/v1`,
      '',
    ].join('\n'),
  );
}

function spawnWranglerDev() {
  const child = spawn(
    WRANGLER_BIN,
    [
      'dev',
      '--config',
      CF_WRANGLER_CONFIG,
      '--port',
      String(PORT),
      // OUTSIDE dist-cf on purpose: a rebuild wipes the build output, and local
      // DO state must survive it (and the restart half of this smoke).
      '--persist-to',
      PERSIST_DIR,
    ],
    { cwd: REPO_ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { child, getOutput: () => output };
}

function stopWrangler(handle) {
  return new Promise((resolve) => {
    const { child } = handle;
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const settle = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(settle);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function adminFetch(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
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

/** Ready = the admin API answers from the DO-backed store (workerd + DO up). */
async function waitForAdminReady(handle, baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (exit ${handle.child.exitCode}):\n${handle.getOutput()}`);
    }
    try {
      const { status, body } = await adminFetch(baseUrl, '/admin/api/agents');
      if (status === 200 && Array.isArray(body?.agents)) {
        return body.agents;
      }
    } catch {
      // not accepting connections yet
    }
    await delay(300);
  }
  throw new Error(`wrangler dev never became ready:\n${handle.getOutput()}`);
}

function mentionEvent(eventId = 'Ev_SMOKE_MENTION_1') {
  return {
    token: 'verification-token-not-a-secret',
    team_id: WORKSPACE,
    api_app_id: 'A_SMOKE',
    event_id: eventId,
    event_time: 1782770400,
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: 'U_ALICE',
      text: '<@U_BOT> smoke: please draft a short reply',
      ts: MENTION_TS,
      channel: CHANNEL,
      event_ts: MENTION_TS,
    },
  };
}

function slowMentionEvent(eventId = 'Ev_SMOKE_SLOW_1') {
  return {
    token: 'verification-token-not-a-secret',
    team_id: WORKSPACE,
    api_app_id: 'A_SMOKE',
    event_id: eventId,
    event_time: 1782771000,
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: 'U_ALICE',
      text: '<@U_BOT> slow: take as long as you need',
      ts: SLOW_MENTION_TS,
      channel: SLOW_CHANNEL,
      event_ts: SLOW_MENTION_TS,
    },
  };
}

function threadReplyEvent() {
  return {
    token: 'verification-token-not-a-secret',
    team_id: WORKSPACE,
    api_app_id: 'A_SMOKE',
    event_id: 'Ev_SMOKE_REPLY_1',
    event_time: 1782770460,
    type: 'event_callback',
    event: {
      type: 'message',
      channel: CHANNEL,
      user: 'U_ALICE',
      text: 'smoke: continue from the prior answer',
      ts: '1782770460.000200',
      event_ts: '1782770460.000200',
      thread_ts: MENTION_TS,
      channel_type: 'channel',
    },
  };
}

async function waitForFinalCount(backend, minFinals, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.finals().length >= minFinals) {
      return backend.finals();
    }
    await delay(150);
  }
  return backend.finals();
}

async function main() {
  assertNodeVersion();
  buildCloudflareTarget();
  console.log('• verifying build artifacts…');
  verifyBuildArtifacts();
  if (failures.length > 0) {
    throw new Error('build artifacts failed verification');
  }

  // Fresh local DO state every run: the seeding + dedupe assertions assume a
  // first-boot Durable Object.
  rmSync(PERSIST_DIR, { recursive: true, force: true });

  const { FakeSlackBackend, STUB_REPLY_MARKER } = await loadFake();
  // The fake reports this workspace identity from auth.test (so the wizard
  // persists it) and serves these channels from conversations.list/info (so the
  // Add-channel proxy and the assignment-PUT validation have real fixtures).
  const backend = new FakeSlackBackend({
    slack: {
      identity: { teamId: WORKSPACE, teamName: 'Smoke Workspace' },
      channels: [
        { id: CHANNEL, name: 'smoke-mentions', isMember: true },
        { id: SLOW_CHANNEL, name: 'smoke-slow', isMember: true },
        { id: 'C_SMOKE_EXTRA', name: 'general', isMember: false },
      ],
    },
  });
  const fakePort = await getFreePort();
  const fake = await backend.listen(fakePort);
  console.log(`• fake Slack + provider backend on ${fake.url}`);
  writeDevVars(fake.url);

  const baseUrl = `http://127.0.0.1:${PORT}`;
  const eventsUrl = `${baseUrl}${EVENTS_PATH}`;
  let wrangler = spawnWranglerDev();

  try {
    console.log('• waiting for wrangler dev (round 1)…');
    const agents = await waitForAdminReady(wrangler, baseUrl);
    const agentIds = agents.map((agent) => agent.id).sort();
    check(
      agentIds.includes('agent_default'),
      'DO-backed config store served the seeded agent',
      agentIds.join(','),
    );

    // --- First-run wizard flow (no Slack creds anywhere yet) ---------------

    // The app is up and serving /admin, but events must fail closed until
    // the wizard stores a signing secret.
    const preWizard = await postSignedEvent(eventsUrl, mentionEvent('Ev_SMOKE_PRE_WIZARD'));
    check(
      preWizard.status === 401,
      'events fail closed (401) before the wizard stores creds',
      `HTTP ${preWizard.status}`,
    );

    const wizard = await adminFetch(baseUrl, '/admin/api/slack-connection');
    check(wizard.status === 200, 'wizard GET served', `HTTP ${wizard.status}`);
    const wizardCreds = wizard.body?.credentials ?? {};
    check(
      wizardCreds.botToken === 'missing' &&
        wizardCreds.signingSecret === 'missing' &&
        wizardCreds.botUserId === 'missing',
      'wizard reports all credentials missing on first run',
      JSON.stringify(wizardCreds),
    );
    const expectedRequestUrl = `${baseUrl}/channels/slack/events`;
    check(
      wizard.body?.requestUrl === expectedRequestUrl,
      'wizard derived the events request URL from the admin request',
      String(wizard.body?.requestUrl),
    );
    check(
      typeof wizard.body?.manifestUrl === 'string' &&
        wizard.body.manifestUrl.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=') &&
        wizard.body.manifestUrl.includes(encodeURIComponent(expectedRequestUrl)),
      'manifest deep-link carries the substituted request_url',
    );

    // Paste-back: validated live against the fake Slack's auth.test, then
    // persisted in the DO settings store (bot user id comes from auth.test).
    const saved = await adminFetch(baseUrl, '/admin/api/slack-connection', {
      method: 'POST',
      body: JSON.stringify({ botToken: 'xoxb-test', signingSecret: SIGNING_SECRET }),
    });
    check(
      saved.status === 200 && saved.body?.ok === true,
      'wizard POST validated the token via fake Slack auth.test',
      `HTTP ${saved.status}`,
    );
    check(
      saved.body?.botUserId === 'U_BOT',
      'wizard stored the auth.test bot user id',
      String(saved.body?.botUserId),
    );
    const postWizard = await adminFetch(baseUrl, '/admin/api/slack-connection');
    const postWizardCreds = postWizard.body?.credentials ?? {};
    check(
      postWizardCreds.botToken === 'stored' &&
        postWizardCreds.signingSecret === 'stored' &&
        postWizardCreds.botUserId === 'stored',
      'wizard reports stored credentials after the save',
      JSON.stringify(postWizardCreds),
    );
    // The wizard persisted the connected workspace identity from auth.test.
    check(
      postWizard.body?.teamId === WORKSPACE,
      'wizard persisted the connected team id',
      String(postWizard.body?.teamId),
    );

    // --- Add-channel proxy: server-side conversations.list through workerd ---
    const channels = await adminFetch(baseUrl, '/admin/api/slack-channels');
    check(channels.status === 200, 'slack-channels proxy served', `HTTP ${channels.status}`);
    const channelIds = (channels.body?.channels ?? []).map((channel) => channel.id);
    check(
      channelIds.includes(CHANNEL) && channelIds.includes(SLOW_CHANNEL),
      'slack-channels proxy returns the fake fixture channels',
      channelIds.join(','),
    );
    check(
      channels.body?.teamId === WORKSPACE,
      'slack-channels proxy reports the connected team id',
      String(channels.body?.teamId),
    );

    // --- Turn flow, verifying against the STORED signing secret ------------

    // Pin the smoke channel to the local-stub provider through the REAL admin
    // API (config writes go through the DO like any operator edit would).
    const patch = await adminFetch(baseUrl, '/admin/api/agents/agent_default', {
      method: 'PATCH',
      body: JSON.stringify({ model: 'local-stub/smoke-model' }),
    });
    check(patch.status === 200, 'admin PATCH pinned the agent model', `HTTP ${patch.status}`);
    // A channel whose workspace does NOT match the connected team is rejected
    // at the API — the exact miss that let a wrong-workspace channel through.
    const mismatch = await adminFetch(baseUrl, '/admin/api/assignments', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: 'T_WRONG_WS',
        channelId: CHANNEL,
        agentId: 'agent_default',
        enabled: true,
      }),
    });
    check(
      mismatch.status === 400 && mismatch.body?.error === 'workspace_mismatch',
      'mismatched-workspace assignment rejected (400 workspace_mismatch)',
      `HTTP ${mismatch.status} ${mismatch.body?.error ?? ''}`,
    );

    const put = await adminFetch(baseUrl, '/admin/api/assignments', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        channelId: CHANNEL,
        agentId: 'agent_default',
        enabled: true,
      }),
    });
    check(put.status === 200, 'admin PUT created the channel assignment', `HTTP ${put.status}`);

    // Signature is enforced from the WIZARD-STORED secret: tampered → rejected.
    const tampered = await postSignedEvent(eventsUrl, mentionEvent('Ev_SMOKE_TAMPERED'), {
      tamper: true,
    });
    check(
      tampered.status === 401 || tampered.status === 400 || tampered.status === 403,
      'tampered signature is rejected (stored secret enforced)',
      `HTTP ${tampered.status}`,
    );

    // The real turn: signed app_mention → admission → in-process dispatch →
    // agent DO → local-stub provider → final delivered to fake Slack.
    const turnStartedAt = Date.now();
    const admission = await postSignedEvent(eventsUrl, mentionEvent());
    check(
      admission.status === 200 || admission.status === 202,
      'signed app_mention admitted',
      `HTTP ${admission.status}`,
    );
    const finals = await waitForFinalCount(backend, 1, 90_000);
    const turnWallTimeMs = Date.now() - turnStartedAt;
    check(finals.length === 1, 'turn delivered exactly one final', `${finals.length} finals`);
    check(
      Boolean(finals[0]?.text.includes(STUB_REPLY_MARKER)),
      'final carries the stub provider reply',
    );
    check(finals[0]?.channel === CHANNEL, 'final landed in the mention channel');
    console.log(`• measured turn wall-time: ${turnWallTimeMs}ms (signed POST → final on the wire)`);

    // Dedupe: the identical event (same event_id, same channel:ts) must not
    // produce a second final. quiesce() lets any wrongly-admitted turn surface.
    const redelivery = await postSignedEvent(eventsUrl, mentionEvent());
    check(
      redelivery.status === 200 || redelivery.status === 202,
      'identical redelivery acked',
      `HTTP ${redelivery.status}`,
    );
    await backend.quiesce(1500, 15_000);
    check(
      backend.finals().length === 1,
      'identical redelivery deduped by the DO claim store',
      `${backend.finals().length} finals`,
    );

    // Restart workerd on the SAME persist dir: claims, the thread registry,
    // and the config all live in the state DO's SQLite and must survive.
    console.log('• restarting wrangler dev (persistence round)…');
    await stopWrangler(wrangler);
    wrangler = spawnWranglerDev();
    await waitForAdminReady(wrangler, baseUrl);

    // The wizard-stored credentials live in the DO's SQLite: a fresh isolate
    // (empty resolver cache) must still see them.
    const restartWizard = await adminFetch(baseUrl, '/admin/api/slack-connection');
    const restartCreds = restartWizard.body?.credentials ?? {};
    check(
      restartCreds.botToken === 'stored' && restartCreds.signingSecret === 'stored',
      'stored Slack credentials survived the restart',
      JSON.stringify(restartCreds),
    );

    const postRestartRedelivery = await postSignedEvent(eventsUrl, mentionEvent());
    check(
      postRestartRedelivery.status === 200 || postRestartRedelivery.status === 202,
      'post-restart redelivery acked',
      `HTTP ${postRestartRedelivery.status}`,
    );
    await backend.quiesce(1500, 15_000);
    check(
      backend.finals().length === 1,
      'post-restart redelivery still deduped (claims persisted)',
      `${backend.finals().length} finals`,
    );

    const replyStartedAt = Date.now();
    const reply = await postSignedEvent(eventsUrl, threadReplyEvent());
    check(
      reply.status === 200 || reply.status === 202,
      'implicit thread reply admitted post-restart',
      `HTTP ${reply.status}`,
    );
    const replyFinals = await waitForFinalCount(backend, 2, 90_000);
    check(
      replyFinals.length === 2,
      'thread registry persisted across restart (reply turn delivered)',
      `${replyFinals.length} finals in ${Date.now() - replyStartedAt}ms`,
    );

    // --- Slow-turn case: DO alarm relay past the old ~30s waitUntil horizon ---
    //
    // The provider now holds its SSE response open for SLOW_TURN_DELAY_MS
    // (>35s) — longer than a real deploy's events-invocation waitUntil survives
    // (tail-log-confirmed death at ~29.5s). Under the relay the events handler
    // only enqueues (fast ack) and the state DO's alarm() runs the turn with the
    // platform's 15-minute budget, so the final still lands. miniflare does not
    // enforce the 30s cap, so this proves the relay PATH works end-to-end for a
    // long turn; the cancellation it replaces is doc/tail-log-backed.
    console.log(`• slow-turn case: provider will hold ${SLOW_TURN_DELAY_MS}ms before replying…`);
    backend.configure({ provider: { delayMs: SLOW_TURN_DELAY_MS } });
    const slowAssign = await adminFetch(baseUrl, '/admin/api/assignments', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        channelId: SLOW_CHANNEL,
        agentId: 'agent_default',
        enabled: true,
      }),
    });
    check(slowAssign.status === 200, 'admin PUT created the slow-turn assignment', `HTTP ${slowAssign.status}`);

    const finalsBeforeSlow = backend.finals().length;
    const slowStartedAt = Date.now();
    const slowAdmission = await postSignedEvent(eventsUrl, slowMentionEvent());
    const slowAckMs = Date.now() - slowStartedAt;
    check(
      slowAdmission.status === 200 || slowAdmission.status === 202,
      'slow-turn mention admitted',
      `HTTP ${slowAdmission.status}`,
    );
    // The events ack must return FAST: the turn runs in the alarm, not inline.
    // A ~SLOW_TURN_DELAY_MS ack here would mean the handler blocked on the turn.
    check(
      slowAckMs < 10_000,
      'events ack returned before the turn ran (enqueued, not inline)',
      `${slowAckMs}ms`,
    );

    const slowFinals = await waitForFinalCount(backend, finalsBeforeSlow + 1, 120_000);
    const slowDeliveryMs = Date.now() - slowStartedAt;
    check(
      slowFinals.length === finalsBeforeSlow + 1,
      'slow turn delivered its final via the DO alarm relay',
      `${slowFinals.length - finalsBeforeSlow} new final(s) in ${slowDeliveryMs}ms`,
    );
    const slowFinal = slowFinals[slowFinals.length - 1];
    check(
      Boolean(slowFinal?.text.includes(STUB_REPLY_MARKER)),
      'slow-turn final carries the stub provider reply (not the failure text)',
    );
    check(slowFinal?.channel === SLOW_CHANNEL, 'slow-turn final landed in the slow channel');
    check(
      slowDeliveryMs > 35_000,
      'slow-turn delivery exceeded the old ~30s waitUntil ceiling',
      `${slowDeliveryMs}ms`,
    );
    console.log(
      `• measured slow-turn delivery: ${slowDeliveryMs}ms (fast ack ${slowAckMs}ms; provider held ${SLOW_TURN_DELAY_MS}ms)`,
    );

    // Claims settle: the completed slow turn keeps its claim, so an identical
    // redelivery is deduped. Reset the provider delay first so a wrongly-
    // admitted redelivery would deliver fast (and be caught) instead of hanging.
    backend.configure({ provider: { delayMs: 0 } });
    const slowRedelivery = await postSignedEvent(eventsUrl, slowMentionEvent());
    check(
      slowRedelivery.status === 200 || slowRedelivery.status === 202,
      'slow-turn redelivery acked',
      `HTTP ${slowRedelivery.status}`,
    );
    await backend.quiesce(1500, 15_000);
    check(
      backend.finals().length === finalsBeforeSlow + 1,
      'slow-turn redelivery deduped (claims settled after the alarm ran)',
      `${backend.finals().length - finalsBeforeSlow} new final(s)`,
    );

    if (failures.length > 0) {
      throw new Error(`assertions failed: ${failures.join('; ')}`);
    }
    console.log(
      `\nPASS cf-smoke — turn wall-time ${turnWallTimeMs}ms; slow-turn delivery ${slowDeliveryMs}ms`,
    );
  } catch (err) {
    console.error(`\nFAIL cf-smoke: ${err instanceof Error ? err.message : String(err)}`);
    console.error('\n--- wrangler dev output (tail) ---');
    console.error(wrangler.getOutput().split('\n').slice(-60).join('\n'));
    console.error('\n--- fake Slack wire log (methods) ---');
    console.error(backend.wireLog.map((entry) => `${entry.kind}:${entry.method}`).join('\n'));
    process.exitCode = 1;
  } finally {
    await stopWrangler(wrangler);
    await fake.close();
    await backend.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
