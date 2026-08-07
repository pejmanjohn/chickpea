/**
 * Cloudflare-target smoke gate: builds the CF bundle, boots it under a real
 * workerd (`wrangler dev`) against the in-memory fake Slack + fake provider
 * backend, and drives the FULL first-run story — no Slack credentials in the
 * environment, everything through the /admin Slack-connection wizard — then
 * SIGNED Slack events end-to-end. Asserts the parts of the port that only
 * workerd can prove:
 *
 *   1. recovery-backed Access setup is resumable, persists pending identity
 *      state, and refuses to activate without a valid signed assertion,
 *   2. the DO-backed config store seeds and serves /admin/api/agents,
 *   3. the app boots healthy with NO Slack creds: events fail closed (401)
 *      and the wizard GET reports missing credentials + a manifest deep-link
 *      carrying this install's substituted request_url,
 *   4. the wizard POST validates the pasted token against (fake) Slack
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
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

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
import { runDrainCheck } from './lib/cf-drain-check.mjs';

const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
const CF_OUTPUT_DIR = join(REPO_ROOT, 'dist-cf');
const CF_WRANGLER_CONFIG = join(CF_OUTPUT_DIR, 'chickpea', 'wrangler.json');
const CF_SMOKE_WRANGLER_CONFIG = join(CF_OUTPUT_DIR, 'chickpea', 'wrangler.smoke.json');
const CF_AI_SMOKE_CONFIG = join(CF_OUTPUT_DIR, 'chickpea', 'wrangler.ai-smoke.json');
const PERSIST_DIR = join(REPO_ROOT, '.wrangler-state');
const ADMIN_TOKEN = 'test-token';
const RECOVERY_TOKEN = 'smoke-recovery-token-with-at-least-thirty-two-characters';
const ACCESS_ISSUER = 'https://smoke.cloudflareaccess.com';
const ACCESS_AUDIENCE = 'smoke-access-audience';
const WORKSPACE = 'T_SMOKE';
const CHANNEL = 'C_SMOKE';
const AI_CHANNEL = 'C_SMOKE_AI';
const MENTION_TS = '1782770400.000100';
const MEMORY_TS = '1782770450.000100';
const AI_MENTION_TS = '1782770100.000100';
const PORT = Number(process.env.SMOKE_WRANGLER_PORT ?? 8788);
const AI_SMOKE_SERVICE = 'chickpea-ai-smoke-stub';
const AI_SMOKE_REPLY = 'workers-ai-binding-smoke::gateway-disabled';
const AI_SMOKE_RPC_FLAG = 'enable_abortsignal_rpc';
const USAGE_PRE_DELIVERY_BUDGET_MS = 100;
const V2_AGENT_BINDINGS = [
  ['FLUE_CHICKPEA_SLACK_V2_AGENT', 'FlueChickpeaSlackV2Agent'],
  ['FLUE_CHICKPEA_ROUTINE_INTENT_V2_AGENT', 'FlueChickpeaRoutineIntentV2Agent'],
  ['FLUE_CHICKPEA_ROUTINE_EXECUTION_V2_AGENT', 'FlueChickpeaRoutineExecutionV2Agent'],
];
const BETA_FLUE_CLASSES = [
  'FlueRegistry',
  'FlueSlackThreadAgent',
  'FlueRoutineIntentAgent',
  'FlueRoutineWorkflow',
];

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

function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function buildCloudflareTarget() {
  if (process.env.SMOKE_SKIP_BUILD === '1' && existsSync(CF_WRANGLER_CONFIG)) {
    console.log('• SMOKE_SKIP_BUILD=1 — reusing existing dist-cf build');
    return;
  }
  console.log('• building Cloudflare target (Vite → dist-cf)…');
  const result = spawnSync('npm', ['run', 'flue:build:cf'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`flue:build:cf failed (exit ${result.status})`);
  }
}

function verifyBuildArtifacts() {
  const config = JSON.parse(readFileSync(CF_WRANGLER_CONFIG, 'utf8'));
  const artifactRoot = join(CF_OUTPUT_DIR, 'chickpea');
  const bundle = readdirSync(artifactRoot, { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.js'))
    .sort()
    .map((entry) => readFileSync(join(artifactRoot, entry), 'utf8'))
    .join('\n');
  const doBindings = config.durable_objects?.bindings ?? [];
  check(
    doBindings.some((b) => b.name === 'TAG_STATE' && b.class_name === 'TagStateStore'),
    'built wrangler.json carries the TAG_STATE binding',
  );
  for (const [name, className] of V2_AGENT_BINDINGS) {
    check(
      doBindings.some((binding) => binding.name === name && binding.class_name === className),
      `built wrangler.json carries ${name}/${className}`,
    );
  }
  check(
    doBindings.some((b) => b.name === 'SANDBOX' && b.class_name === 'Sandbox'),
    'built wrangler.json carries the Sandbox DO binding',
  );
  const migrations = config.migrations ?? [];
  const tags = migrations.map((migration) => migration.tag);
  check(
    ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'].every((tag) => tags.includes(tag)),
    'built wrangler.json migrations include the append-only v1 through v6 chain',
    tags.join(','),
  );
  const reset = migrations.find((migration) => migration.tag === 'v6');
  check(
    sameArray(
      [...(reset?.deleted_classes ?? [])].sort(),
      [...BETA_FLUE_CLASSES].sort(),
    ),
    'v6 deletes exactly the four beta Flue classes',
  );
  const sandboxContainer = (config.containers ?? []).find(
    (container) => container.class_name === 'Sandbox',
  );
  check(
    sandboxContainer?.instance_type === 'standard-1' && sandboxContainer?.max_instances === 25,
    'built wrangler.json keeps the bounded multi-thread Sandbox capacity',
    sandboxContainer
      ? `${sandboxContainer.instance_type} / ${sandboxContainer.max_instances} max instances`
      : 'missing',
  );
  const redirect = join(REPO_ROOT, '.wrangler', 'deploy', 'config.json');
  const redirectBody = existsSync(redirect) ? readFileSync(redirect, 'utf8') : '';
  check(redirectBody.includes('dist-cf'), '.wrangler/deploy/config.json points into dist-cf');
  check(
    existsSync(join(REPO_ROOT, 'src', 'db.node.ts')) &&
      !existsSync(join(REPO_ROOT, 'src', 'db.ts')),
    'Node-only persistence stays outside Cloudflare auto-discovery',
  );
  check(config.ai?.binding === 'AI', 'built wrangler.json carries the production AI binding');
  check(
    sameArray(config.triggers?.crons ?? [], ['* * * * *']),
    'built wrangler.json carries exactly one heartbeat Cron Trigger',
  );
  check(
    config.vars?.TAG_ROUTINES_ENABLED === '0',
    'routine admission remains off by default in the built artifact',
  );
  check(
    !Object.hasOwn(config.vars ?? {}, 'TAG_OPENAI_SUBSCRIPTION_ENABLED'),
    'built artifact exposes no OpenAI Subscription preview gate',
  );
  check(
    config.vars?.SLACK_TAG_LEDGER_CANARY_CHANNELS === '',
    'interactive ledger admission remains off by default in the built artifact',
  );
  check(
    config.observability?.traces?.enabled === true,
    'built artifact enables Workers Traces for metadata-only Flue spans',
  );
  check(
    bundle.includes('heartbeat: runRoutineHeartbeat') &&
      bundle.includes('maintenance: runWorkMaintenance') &&
      bundle.includes('chickpea-slack-v2') &&
      bundle.includes('chickpea-routine-intent-v2') &&
      bundle.includes('chickpea-routine-execution-v2') &&
      bundle.includes('chickpea.response-metadata') &&
      bundle.includes('@flue/runtime/cloudflare-tracing') &&
      bundle.includes('FLUE_PRIVATE_SANDBOX_COMMAND_V1'),
    'built Worker composes the heartbeat, fresh agents, and content-free tracing',
  );
}

function writeSmokeWranglerConfigs() {
  const productionConfig = JSON.parse(readFileSync(CF_WRANGLER_CONFIG, 'utf8'));
  // The production AI binding accepts the turn's AbortSignal directly. Our
  // local stand-in crosses a service-RPC boundary, so opt only the disposable
  // smoke workers into serializing that otherwise-identical argument.
  const smokeCompatibilityFlags = [
    ...new Set([...(productionConfig.compatibility_flags ?? []), AI_SMOKE_RPC_FLAG]),
  ];
  const smokeConfig = {
    ...productionConfig,
    vars: {
      ...(productionConfig.vars ?? {}),
      // Exercise exactly one internal workspace/channel through the enforced
      // ledger lane while the ordinary and slow channels remain legacy.
      SLACK_TAG_LEDGER_CANARY_CHANNELS: `${WORKSPACE}/${AI_CHANNEL}`,
    },
    dev: { ...(productionConfig.dev ?? {}), enable_containers: false },
    compatibility_flags: smokeCompatibilityFlags,
    services: [
      ...(productionConfig.services ?? []).filter((service) => service.binding !== 'AI'),
      { binding: 'AI', service: AI_SMOKE_SERVICE },
    ],
  };
  // The production container declaration was asserted above. This disposable
  // workerd config never calls the coding tier, and Wrangler 4.103 still tries
  // to invoke Docker despite dev.enable_containers=false, so omit only the
  // smoke copy of the image declaration.
  delete smokeConfig.containers;
  delete smokeConfig.ai;
  writeFileSync(CF_SMOKE_WRANGLER_CONFIG, `${JSON.stringify(smokeConfig, null, 2)}\n`);
  writeFileSync(
    CF_AI_SMOKE_CONFIG,
    `${JSON.stringify(
      {
        name: AI_SMOKE_SERVICE,
        main: '../../scripts/fixtures/cloudflare-ai-binding-smoke.mjs',
        compatibility_date: productionConfig.compatibility_date,
        compatibility_flags: smokeCompatibilityFlags,
        vars: { AI_SMOKE_REPLY },
      },
      null,
      2,
    )}\n`,
  );
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
    join(CF_OUTPUT_DIR, 'chickpea', '.dev.vars'),
    [
      `TAG_ADMIN_TOKEN=${ADMIN_TOKEN}`,
      `CHICKPEA_RECOVERY_TOKEN=${RECOVERY_TOKEN}`,
      `SLACK_API_URL=${fakeUrl}/api/`,
      `LOCAL_STUB_URL=${fakeUrl}/v1`,
      'SLACK_TAG_MODEL=local-stub/smoke-model',
      `ANTHROPIC_API_URL=${fakeUrl}`,
      `OPENAI_API_URL=${fakeUrl}/openai/v1`,
      `OPENROUTER_API_URL=${fakeUrl}/openrouter`,
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
      CF_SMOKE_WRANGLER_CONFIG,
      '--config',
      CF_AI_SMOKE_CONFIG,
      '--port',
      String(PORT),
      // OUTSIDE dist-cf on purpose: a rebuild wipes the build output, and local
      // DO state must survive it (and the restart half of this smoke).
      '--persist-to',
      PERSIST_DIR,
      // This gate verifies the production container declaration above but
      // intentionally runs read-only model turns that never acquire one.
      // Avoid making an unrelated local Docker daemon a prerequisite.
      '--enable-containers=false',
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

async function adminPageHtml(baseUrl) {
  const response = await fetch(`${baseUrl}/admin`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  return response.text();
}

async function configurePendingAccess(baseUrl) {
  const setupPage = await fetch(`${baseUrl}/admin/setup`);
  const setupHtml = await setupPage.text();
  check(
    setupPage.status === 200 &&
      setupHtml.includes('Create Zero Trust organization') &&
      setupHtml.includes('Use an existing Zero Trust organization') &&
      setupHtml.includes(`${baseUrl}/admin/*`) &&
      !setupHtml.includes(RECOVERY_TOKEN),
    'fresh setup renders both Access paths and copyable Admin destinations without echoing recovery',
    `HTTP ${setupPage.status}`,
  );
  const body = new URLSearchParams({
    ownerEmail: 'owner@example.com',
    recoveryToken: RECOVERY_TOKEN,
    issuer: ACCESS_ISSUER,
    audience: ACCESS_AUDIENCE,
  }).toString();
  const configured = await fetch(`${baseUrl}/admin/setup`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });
  check(
    configured.status === 303 && configured.headers.get('location') === '/admin/setup/verify',
    'recovery proof persists Access pending state and advances to verification',
    `HTTP ${configured.status} location=${configured.headers.get('location')}`,
  );
  const resumed = await fetch(`${baseUrl}/admin/setup`);
  const resumedHtml = await resumed.text();
  check(
    resumed.status === 200 && resumedHtml.includes('Configuration saved') &&
      resumedHtml.includes('Verify identity through Access'),
    'interrupted setup resumes at the saved verification step',
    `HTTP ${resumed.status}`,
  );
  const unverified = await fetch(`${baseUrl}/admin/setup/verify`, { redirect: 'manual' });
  check(
    unverified.status === 401,
    'Access activation fails closed without a signed assertion',
    `HTTP ${unverified.status}`,
  );
  const publicGithubCallback = await fetch(
    `${baseUrl}/oauth/github/setup/callback?code=invalid&state=invalid`,
    { redirect: 'manual' },
  );
  check(
    publicGithubCallback.status === 403,
    'public GitHub setup callback reaches its single-use state guard outside Admin auth',
    `HTTP ${publicGithubCallback.status}`,
  );
}

async function renderAdminWithWorkerdState(baseUrl) {
  const html = await adminPageHtml(baseUrl);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) {
    throw new Error('admin page did not include its inline script');
  }
  const app = { innerHTML: '' };
  const elements = new Map([['app', app]]);
  const listeners = {};
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, { innerHTML: '', value: '', disabled: false });
      }
      return elements.get(id);
    },
    querySelector(selector) {
      if (selector === '.main-inner') return app;
      return null;
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };
  const authenticatedFetch = (path, options = {}) => {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    return fetch(url, {
      ...options,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        ...(options.headers ?? {}),
      },
    });
  };
  vm.runInNewContext(
    script,
    {
      document,
      fetch: authenticatedFetch,
      console,
      URLSearchParams,
      FormData: class {
        constructor(form) {
          this.form = form;
        }
        get(name) {
          return this.form?.__formData?.[name] ?? null;
        }
      },
    },
    { filename: 'admin-workerd-inline.js' },
  );
  const timeoutMs = 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app.innerHTML.length > 0) {
      return { html: app.innerHTML, listeners };
    }
    await delay(10);
  }
  throw new Error(`admin inline script did not render within ${timeoutMs}ms`);
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

async function measureRepresentativeStateWrite(baseUrl) {
  const samples = [];
  for (let index = 0; index < 60; index += 1) {
    const startedAt = performance.now();
    const response = await adminFetch(baseUrl, '/admin/api/sandbox/status', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: false,
        allowedHosts: ['registry.npmjs.org'],
        monthlySessionCap: index,
      }),
    });
    if (response.status !== 200) {
      throw new Error(`representative state write failed (HTTP ${response.status})`);
    }
    if (index >= 10) samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  return { count: samples.length, p95 };
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

function memoryRememberEvent() {
  return {
    ...mentionEvent('Ev_SMOKE_MEMORY_1'),
    event: {
      ...mentionEvent('Ev_SMOKE_MEMORY_1').event,
      text: '<@U_BOT> !remember release-guidance — Use the release checklist.\nRun focused tests before release.',
      ts: MEMORY_TS,
      event_ts: MEMORY_TS,
    },
  };
}

function aiMentionEvent() {
  const payload = mentionEvent('Ev_SMOKE_AI_PRIVACY_1');
  return {
    ...payload,
    event: {
      ...payload.event,
      text: '<@U_BOT> privacy smoke: answer through the Workers AI binding',
      ts: AI_MENTION_TS,
      channel: AI_CHANNEL,
      event_ts: AI_MENTION_TS,
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
  const args = process.argv.slice(2);
  if (args.length > 0) {
    if (args.length !== 1 || args[0] !== '--check-drain') {
      throw new Error(`unknown arguments: ${args.join(' ')}`);
    }
    await runDrainCheck({
      baseUrl: process.env.CF_SMOKE_BASE_URL,
      adminToken: process.env.TAG_ADMIN_TOKEN,
    });
    console.log('PASS cf-smoke drain — every runtime work category is zero');
    return;
  }
  assertNodeVersion();
  buildCloudflareTarget();
  console.log('• verifying build artifacts…');
  verifyBuildArtifacts();
  if (failures.length > 0) {
    throw new Error('build artifacts failed verification');
  }
  writeSmokeWranglerConfigs();

  // Fresh local DO state every run: the seeding + dedupe assertions assume a
  // first-boot Durable Object.
  rmSync(PERSIST_DIR, { recursive: true, force: true });

  const { FakeSlackBackend, FAKE_PROVIDER_KEYS, STUB_REPLY_MARKER } = await loadFake();
  // The fake reports this workspace identity from auth.test (so the wizard
  // persists it) and serves these channels from conversations.list/info (so the
  // Add-channel proxy and the assignment-PUT validation have real fixtures).
  const backend = new FakeSlackBackend({
    slack: {
      identity: { teamId: WORKSPACE, teamName: 'Smoke Workspace' },
      channels: [
        { id: CHANNEL, name: 'smoke-mentions', isMember: true, teamId: WORKSPACE },
        { id: AI_CHANNEL, name: 'smoke-workers-ai', isMember: true, teamId: WORKSPACE },
        { id: SLOW_CHANNEL, name: 'smoke-slow', isMember: true, teamId: WORKSPACE },
        { id: 'C_SMOKE_EXTRA', name: 'general', isMember: false, teamId: WORKSPACE },
      ],
      channelMembers: {
        [CHANNEL]: ['U_ALICE', 'U_BOT'],
        [AI_CHANNEL]: ['U_ALICE', 'U_BOT'],
        [SLOW_CHANNEL]: ['U_ALICE', 'U_BOT'],
      },
      workspaceUsers: [
        { id: 'U_ALICE', teamId: WORKSPACE },
        { id: 'U_BOT', teamId: WORKSPACE, isBot: true, isAppUser: true },
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
    await configurePendingAccess(baseUrl);
    const agentIds = agents.map((agent) => agent.id).sort();
    check(
      agentIds.includes('agent_default'),
      'DO-backed config store served the seeded agent',
      agentIds.join(','),
    );
    const defaultAgent = agents.find((agent) => agent.id === 'agent_default');
    check(
      defaultAgent?.model === 'cloudflare/@cf/zai-org/glm-5.2',
      'Cloudflare seed pins Default to the keyless Workers AI model',
      String(defaultAgent?.model),
    );

    const stateWrite = await measureRepresentativeStateWrite(baseUrl);
    check(
      stateWrite.p95 <= USAGE_PRE_DELIVERY_BUDGET_MS,
      'representative Worker → TagStateStore transaction stays inside the usage write budget',
      `p95=${stateWrite.p95.toFixed(2)}ms n=${stateWrite.count} budget=${USAGE_PRE_DELIVERY_BUDGET_MS}ms`,
    );
    const usageSummary = await adminFetch(
      baseUrl,
      `/admin/api/usage/summary?from=${Date.now() - 60_000}&to=${Date.now() + 60_000}`,
    );
    check(
      usageSummary.status === 200 && usageSummary.body?.totals?.operationCount === 0,
      'Usage summary queries the initialized TagStateStore ledger',
      `HTTP ${usageSummary.status} operations=${String(usageSummary.body?.totals?.operationCount)}`,
    );
    const drainStatus = await runDrainCheck({ baseUrl, adminToken: ADMIN_TOKEN });
    check(
      drainStatus.drained,
      'runtime drain endpoint reaches the initialized TagStateStore aggregate',
      JSON.stringify(drainStatus.categories),
    );

    const wireBeforeHeartbeat = backend.wireLog.length;
    const disabledHeartbeat = await fetch(`${baseUrl}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
    await delay(100);
    const scheduledWork = await adminFetch(baseUrl, '/admin/api/audit/scheduled_work/routines');
    check(
      disabledHeartbeat.status === 200 && backend.wireLog.length === wireBeforeHeartbeat,
      'disabled heartbeat performs no Slack or model work',
      `HTTP ${disabledHeartbeat.status} wireDelta=${backend.wireLog.length - wireBeforeHeartbeat}`,
    );
    check(
      scheduledWork.status === 200 &&
        scheduledWork.body?.capability?.reason === 'operator_disabled' &&
        Array.isArray(scheduledWork.body?.routines) &&
        scheduledWork.body.routines.length === 0,
      'Scheduled Work reports the Cloudflare capability as operator-disabled',
      `HTTP ${scheduledWork.status} reason=${String(scheduledWork.body?.capability?.reason)}`,
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
    const firstRunAdmin = await renderAdminWithWorkerdState(baseUrl);
    check(
      firstRunAdmin.html.includes('Connect Slack') &&
        firstRunAdmin.html.includes('Create your Slack app') &&
        firstRunAdmin.html.includes('Events URL (already in the manifest)') &&
        firstRunAdmin.html.includes('data-action="advance-slack-step"'),
      'first-run admin render shows the step-1 Connect stepper',
    );
    check(
      firstRunAdmin.html.length > 0 &&
        !firstRunAdmin.html.includes('Choose where Chickpea answers') &&
        !firstRunAdmin.html.includes('Connected workspace'),
      'first-run admin render does not show the connected funnel',
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
    const connectedAdmin = await renderAdminWithWorkerdState(baseUrl);
    check(
      connectedAdmin.html.includes('Connected workspace') &&
        connectedAdmin.html.includes('Manage where Chickpea answers in Slack.') &&
        connectedAdmin.html.includes('data-action="toggle-add-channel"'),
      'post-wizard admin render shows the connected Slack overview',
    );
    check(
      connectedAdmin.html.length > 0 &&
        !connectedAdmin.html.includes('Connect Slack') &&
        !connectedAdmin.html.includes('class="stepper"'),
      'post-wizard admin render removes the Connect stepper',
    );

    // --- Settings/model-provider screen APIs --------------------------------

    for (const [provider, key] of Object.entries(FAKE_PROVIDER_KEYS)) {
      const savedProvider = await adminFetch(baseUrl, `/admin/api/providers/${provider}/key`, {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      check(
        savedProvider.status === 200 && savedProvider.body?.provider?.status === 'stored',
        `provider-key save validated and stored ${provider}`,
        `HTTP ${savedProvider.status} ${savedProvider.body?.provider?.status ?? ''}`,
      );
    }
    const providers = await adminFetch(baseUrl, '/admin/api/providers');
    const providerSummaries = Object.fromEntries(
      (providers.body?.providers ?? []).map((provider) => [provider.id, provider]),
    );
    check(
      providerSummaries.anthropic?.status === 'stored' && providerSummaries.anthropic?.modelCount === 4,
      'providers GET combines two fake Anthropic models with two catalog models',
      JSON.stringify(providerSummaries.anthropic),
    );
    check(
      providerSummaries.openai?.status === 'stored' && providerSummaries.openai?.modelCount === 5,
      'providers GET combines two fake OpenAI models with three catalog models',
      JSON.stringify(providerSummaries.openai),
    );
    check(
      providerSummaries.openrouter?.status === 'stored' && providerSummaries.openrouter?.modelCount === 2,
      'providers GET reports OpenRouter key stored with two fake models',
      JSON.stringify(providerSummaries.openrouter),
    );

    const seededWorkersFavorites = await adminFetch(baseUrl, '/admin/api/providers/workers-ai/favorites');
    const expectedWorkersSeed = [
      '@cf/zai-org/glm-5.2',
      '@cf/moonshotai/kimi-k2.7-code',
      '@cf/openai/gpt-oss-120b',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
    ];
    check(
      seededWorkersFavorites.status === 200 &&
        sameArray(seededWorkersFavorites.body?.favorites, expectedWorkersSeed),
      'Workers AI favorites GET seeds the four default picker models',
      JSON.stringify(seededWorkersFavorites.body?.favorites),
    );
    const nextWorkersFavorites = ['@cf/zai-org/glm-5.2', '@cf/moonshotai/kimi-k2.7-code'];
    const savedWorkersFavorites = await adminFetch(baseUrl, '/admin/api/providers/workers-ai/favorites', {
      method: 'PUT',
      body: JSON.stringify({ favorites: nextWorkersFavorites }),
    });
    const roundTripWorkersFavorites = await adminFetch(baseUrl, '/admin/api/providers/workers-ai/favorites');
    check(
      savedWorkersFavorites.status === 200 &&
        sameArray(roundTripWorkersFavorites.body?.favorites, nextWorkersFavorites),
      'Workers AI favorites PUT/GET round-trips curated models',
      JSON.stringify(roundTripWorkersFavorites.body?.favorites),
    );
    const nextOpenRouterFavorites = ['anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b-instruct'];
    const savedOpenRouterFavorites = await adminFetch(baseUrl, '/admin/api/providers/openrouter/favorites', {
      method: 'PUT',
      body: JSON.stringify({ favorites: nextOpenRouterFavorites }),
    });
    const roundTripOpenRouterFavorites = await adminFetch(baseUrl, '/admin/api/providers/openrouter/favorites');
    check(
      savedOpenRouterFavorites.status === 200 &&
        sameArray(roundTripOpenRouterFavorites.body?.favorites, nextOpenRouterFavorites),
      'OpenRouter favorites PUT/GET round-trips curated models',
      JSON.stringify(roundTripOpenRouterFavorites.body?.favorites),
    );

    const smokeConnections = [
      {
        id: 'linear-mcp',
        displayName: 'Linear smoke',
        url: 'https://mcp.example.com/linear',
        transport: 'streamable-http',
        authMode: 'bearer',
        headerNames: ['X-Linear-Key'],
        enabled: true,
        lifecycleStatus: 'ready',
        statusText: '',
        discoveredTools: [],
        allowedTools: [],
      },
      {
        id: 'github-mcp',
        displayName: 'GitHub smoke',
        url: 'https://mcp.example.com/github',
        transport: 'streamable-http',
        authMode: 'bearer',
        headerNames: ['X-GitHub-Key'],
        enabled: true,
        lifecycleStatus: 'ready',
        statusText: '',
        discoveredTools: [],
        allowedTools: [],
      },
    ];
    const smokeProfile = {
      id: 'agent_cf_smoke_profile',
      name: 'CF Smoke Profile',
      instructions: 'Answer only from the CF smoke gate fixture.',
      enabled: true,
      model: 'anthropic/claude-sonnet-4-6',
      mcpServers: smokeConnections,
    };
    const profileCreate = await adminFetch(baseUrl, '/admin/api/agents', {
      method: 'POST',
      body: JSON.stringify(smokeProfile),
    });
    check(
      profileCreate.status === 201 &&
        profileCreate.body?.agent?.id === 'agent_cf_smoke_profile' &&
        profileCreate.body?.agent?.model === 'anthropic/claude-sonnet-4-6',
      'profile create endpoint saves an explicit model pin',
      `HTTP ${profileCreate.status}`,
    );
    const createdProfile = await adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke_profile');
    check(
      createdProfile.status === 200 &&
        createdProfile.body?.agent?.model === 'anthropic/claude-sonnet-4-6',
      'profile create round-trips through the profile GET endpoint',
      `HTTP ${createdProfile.status}`,
    );

    // Two writes in parallel exercise the atomic settings-set merge through a
    // real Durable Object RPC. Delete + recreate then probes both sources: if
    // either merge entry were lost, its old credential would still read stored.
    const [linearSecrets, githubSecrets] = await Promise.all([
      adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke_profile/mcp/secrets/linear-mcp', {
        method: 'PUT',
        body: JSON.stringify({
          bearerToken: 'linear-smoke-token',
          headers: { 'X-Linear-Key': 'linear-smoke-key' },
          headerNames: ['X-Linear-Key'],
        }),
      }),
      adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke_profile/mcp/secrets/github-mcp', {
        method: 'PUT',
        body: JSON.stringify({
          bearerToken: 'github-smoke-token',
          headers: { 'X-GitHub-Key': 'github-smoke-key' },
          headerNames: ['X-GitHub-Key'],
        }),
      }),
    ]);
    check(
      linearSecrets.status === 200 && githubSecrets.status === 200,
      'parallel MCP secret writes complete through the DO settings RPC',
      `HTTP ${linearSecrets.status}/${githubSecrets.status}`,
    );
    const deleteSmokeProfile = await adminFetch(
      baseUrl,
      '/admin/api/agents/agent_cf_smoke_profile',
      { method: 'DELETE' },
    );
    check(
      deleteSmokeProfile.status === 204,
      'profile deletion consumes the durable MCP secret inventory',
      `HTTP ${deleteSmokeProfile.status}`,
    );
    const recreateSmokeProfile = await adminFetch(baseUrl, '/admin/api/agents', {
      method: 'POST',
      body: JSON.stringify(smokeProfile),
    });
    const [linearSources, githubSources] = await Promise.all([
      adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke_profile/mcp/secrets/linear-mcp', {
        method: 'PUT',
        body: JSON.stringify({ headerNames: ['X-Linear-Key'] }),
      }),
      adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke_profile/mcp/secrets/github-mcp', {
        method: 'PUT',
        body: JSON.stringify({ headerNames: ['X-GitHub-Key'] }),
      }),
    ]);
    check(
      recreateSmokeProfile.status === 201 &&
        linearSources.body?.bearer === 'missing' &&
        linearSources.body?.headers?.['X-Linear-Key'] === 'missing' &&
        githubSources.body?.bearer === 'missing' &&
        githubSources.body?.headers?.['X-GitHub-Key'] === 'missing',
      'profile deletion cleared both parallel MCP credential scopes',
      `HTTP ${recreateSmokeProfile.status}/${linearSources.status}/${githubSources.status}`,
    );
    const cleanupSmokeProfile = await adminFetch(
      baseUrl,
      '/admin/api/agents/agent_cf_smoke_profile',
      { method: 'DELETE' },
    );
    check(
      cleanupSmokeProfile.status === 204,
      'recreated MCP smoke profile cleans up',
      `HTTP ${cleanupSmokeProfile.status}`,
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

    // Before the local-stub repin, exercise the seeded model through the real
    // built entry and its ambient env.AI registration. The smoke-only binding
    // rejects any non-undefined `gateway` option, so a removed or overwritten
    // `gateway:false` registration produces a provider-failure final instead.
    const aiPut = await adminFetch(baseUrl, '/admin/api/assignments', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        channelId: AI_CHANNEL,
        agentId: 'agent_default',
        enabled: true,
      }),
    });
    check(aiPut.status === 200, 'admin PUT created the Workers AI smoke assignment', `HTTP ${aiPut.status}`);
    const aiAdmission = await postSignedEvent(eventsUrl, aiMentionEvent());
    check(
      aiAdmission.status === 200 || aiAdmission.status === 202,
      'seeded Workers AI mention admitted',
      `HTTP ${aiAdmission.status}`,
    );
    const aiFinals = await waitForFinalCount(backend, 1, 90_000);
    const aiFinal = aiFinals.find((final) => final.channel === AI_CHANNEL);
    const aiBindingProofPassed = Boolean(aiFinal?.text.includes(AI_SMOKE_REPLY));
    check(
      aiBindingProofPassed,
      'built Cloudflare entry resolves env.AI without a default gateway',
      aiFinal?.text ?? 'no Workers AI final',
    );
    const canarySessions = await adminFetch(baseUrl, '/admin/api/sessions?limit=10');
    const canaryRunId = canarySessions.body?.items?.find(
      (item) => item.adapterKind === 'slack' && item.status === 'settled',
    )?.runId;
    const canaryDetail = canaryRunId
      ? await adminFetch(baseUrl, `/admin/api/sessions/${encodeURIComponent(canaryRunId)}`)
      : { status: 0, body: undefined };
    check(
      canarySessions.status === 200 &&
        canaryDetail.status === 200 &&
        canaryDetail.body?.session?.executionAuthority === 'ledger' &&
        canaryDetail.body?.session?.deliveryStatus === 'delivered' &&
        canaryDetail.body?.executions?.length === 1,
      'exact-channel workerd canary executes and settles through ledger authority',
      `list=${canarySessions.status} detail=${canaryDetail.status} authority=${String(canaryDetail.body?.session?.executionAuthority)}`,
    );
    if (!aiBindingProofPassed) {
      throw new Error('Workers AI binding privacy proof failed');
    }
    backend.reset();

    // The remaining durability cases stay on the HTTP fake provider. This
    // model edit still goes through the real admin API and DO-backed store.
    const patch = await adminFetch(baseUrl, '/admin/api/agents/agent_default', {
      method: 'PATCH',
      body: JSON.stringify({ model: 'local-stub/smoke-model' }),
    });
    check(patch.status === 200, 'admin PATCH pinned the agent model', `HTTP ${patch.status}`);

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

    const memoryAdmission = await postSignedEvent(eventsUrl, memoryRememberEvent());
    check(
      memoryAdmission.status === 200 || memoryAdmission.status === 202,
      'explicit Memory command admitted on workerd',
      `HTTP ${memoryAdmission.status}`,
    );
    const memoryFinals = await waitForFinalCount(backend, 2, 90_000);
    check(
      memoryFinals.length === 2 && Boolean(memoryFinals[1]?.text.includes('Saved workspace memory `release-guidance`')),
      'explicit Memory command persisted and returned an attributed receipt',
      memoryFinals[1]?.text ?? 'no memory receipt',
    );
    const memoryScopes = await adminFetch(baseUrl, '/admin/api/audit/memory/scopes');
    const smokeScope = memoryScopes.body?.scopes?.find((scope) => scope.channelId === CHANNEL);
    const memoryFiles = smokeScope
      ? await adminFetch(
          baseUrl,
          `/admin/api/audit/memory/stores/${encodeURIComponent(smokeScope.storeId)}/files` +
            `?sourceChannelId=${encodeURIComponent(CHANNEL)}`,
        )
      : { status: 0, body: undefined };
    const smokeMemoryFile = memoryFiles.body?.files?.find((file) => file.name === 'release-guidance.md');
    check(
      memoryScopes.status === 200 && smokeScope?.privacy === 'public' &&
        memoryFiles.status === 200 && memoryFiles.body?.files?.[0]?.name === 'MEMORY.md' &&
        Boolean(smokeMemoryFile?.entryId),
      'workerd admin Memory API exposes scope, generated index, and saved file',
      `scopes=${memoryScopes.status} files=${memoryFiles.status}`,
    );
    const memoryEditBody = JSON.stringify({
      expectedVersion: 1,
      description: 'Use the full release checklist.',
      type: 'fact',
      body: 'Run focused tests and the workerd smoke before release.',
    });
    const memoryEdit = await adminFetch(
      baseUrl,
      `/admin/api/audit/memory/entries/${encodeURIComponent(smokeMemoryFile?.entryId ?? '')}`,
      {
        method: 'PUT',
        headers: { 'idempotency-key': 'cf-smoke-memory-edit' },
        body: memoryEditBody,
      },
    );
    const memoryConflict = await adminFetch(
      baseUrl,
      `/admin/api/audit/memory/entries/${encodeURIComponent(smokeMemoryFile?.entryId ?? '')}`,
      {
        method: 'PUT',
        headers: { 'idempotency-key': 'cf-smoke-memory-conflict' },
        body: memoryEditBody,
      },
    );
    check(
      memoryEdit.status === 200 && memoryEdit.body?.entry?.version === 2 &&
        memoryConflict.status === 409 && memoryConflict.body?.currentVersion === 2,
      'workerd Memory edit is optimistic and conflict-safe',
      `edit=${memoryEdit.status} conflict=${memoryConflict.status}`,
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
    const restartMemory = await adminFetch(
      baseUrl,
      `/admin/api/audit/memory/entries/${encodeURIComponent(smokeMemoryFile?.entryId ?? '')}`,
    );
    check(
      restartMemory.status === 200 && restartMemory.body?.entry?.version === 2 &&
        restartMemory.body?.entry?.body === 'Run focused tests and the workerd smoke before release.',
      'Memory entry and version survived the workerd restart',
      `HTTP ${restartMemory.status} version=${String(restartMemory.body?.entry?.version)}`,
    );

    const postRestartRedelivery = await postSignedEvent(eventsUrl, mentionEvent());
    check(
      postRestartRedelivery.status === 200 || postRestartRedelivery.status === 202,
      'post-restart redelivery acked',
      `HTTP ${postRestartRedelivery.status}`,
    );
    await backend.quiesce(1500, 15_000);
    check(
      backend.finals().length === 2,
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
    const replyFinals = await waitForFinalCount(backend, 3, 90_000);
    check(
      replyFinals.length === 3,
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
    const chickpeaDiagnostics = wrangler.getOutput()
      .split('\n')
      .filter((line) => line.includes('[chickpea]') || line.includes('[work]'));
    if (chickpeaDiagnostics.length > 0) {
      console.error('\n--- Chickpea diagnostics ---');
      console.error(chickpeaDiagnostics.join('\n'));
    }
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
