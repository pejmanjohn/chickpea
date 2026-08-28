/**
 * Cloudflare-target smoke gate: builds the CF bundle, boots it under a real
 * workerd (`wrangler dev`) against the in-memory fake Slack + fake provider
 * backend, and drives the full Slack-native first-run story — programmatic app
 * creation, confidential bot OAuth, signed Events proof, first-Owner OIDC —
 * then signed Slack events end-to-end. Asserts the parts that only
 * workerd can prove:
 *
 *   1. a deploy-minted setup capability creates no person or browser session,
 *      while exact installer OIDC creates the first Owner and session last,
 *   2. the DO-backed config store seeds and serves /admin/api/agents,
 *   3. the app boots healthy with no Slack installation and Events fail closed,
 *   4. app creation, bot install, issued scopes, directory/channel probes,
 *      separately signed Events proof, and OIDC all use the exact fake realm,
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
 * Exit 0 on success, 1 with diagnostics on failure. The default/core run
 * builds and structurally validates Sandbox before rebuilding and booting core;
 * SMOKE_SKIP_BUILD=1 is available only to an explicit Sandbox-profile run that
 * reuses an existing dist-cf artifact for iteration speed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
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
import {
  classifyCloudflareDeploymentProfile,
  resolveCloudflareDeploymentProfile,
} from './cloudflare-deployment-profile.mjs';
import {
  mintSetupCapability,
  SETUP_CAPABILITY_DIGEST_BINDING,
  SETUP_CAPABILITY_ISSUED_AT_BINDING,
} from '../src/auth/setup-capability.mjs';

const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
const CF_OUTPUT_DIR = join(REPO_ROOT, 'dist-cf');
const CF_WRANGLER_CONFIG = join(CF_OUTPUT_DIR, 'chickpea', 'wrangler.json');
const CF_SMOKE_WRANGLER_CONFIG = join(CF_OUTPUT_DIR, 'chickpea', 'wrangler.smoke.json');
const CF_AI_SMOKE_CONFIG = join(CF_OUTPUT_DIR, 'chickpea', 'wrangler.ai-smoke.json');
const PERSIST_DIR = join(REPO_ROOT, '.wrangler-state');
const AUTH_SECRET = '9d'.repeat(32);
const PUBLIC_ORIGIN = 'https://chickpea-smoke.invalid';
const WORKSPACE = 'T0SMOKE';
const APP_ID = 'A0SMOKE';
const BOT_USER_ID = 'UBOTSMOKE';
const OWNER_USER_ID = 'UOWNERSMOKE';
const ONBOARDING_DM_CHANNEL = 'DSMOKEONBOARDING';
const OAUTH_CLIENT_ID = '123456.789012';
const OAUTH_CLIENT_SECRET = 'fake-confidential-client-secret';
const OAUTH_CONFIGURATION_TOKEN = 'xoxe.fake-workerd-configuration-token';
const OAUTH_BOT_TOKEN = 'xoxb-fake-workerd-bot-token';
const CHANNEL = 'C0SMOKE';
const AI_CHANNEL = 'C0SMOKEAI';
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
const RETIRED_AUTH_CLASSES = ['AuthGuard'];

// Slow-turn case: a distinct channel + thread whose provider is held open past
// the old ~30s waitUntil horizon, proving the DO alarm relay delivers anyway.
const SLOW_CHANNEL = 'C0SMOKESLOW';
const SLOW_MENTION_TS = '1782771000.000100';
// >35s so the turn outlives the ~30s cancellation a real deploy's events-
// invocation waitUntil would hit. Overridable for iteration; keep it above 35s.
const SLOW_TURN_DELAY_MS = Number(process.env.SMOKE_SLOW_TURN_DELAY_MS ?? 36_000);

const failures = [];
let adminCookie = '';
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

function buildCloudflareTarget(profile, { reuseExisting = false } = {}) {
  if (reuseExisting && process.env.SMOKE_SKIP_BUILD === '1' && existsSync(CF_WRANGLER_CONFIG)) {
    console.log(`• SMOKE_SKIP_BUILD=1 — reusing existing ${profile} dist-cf build`);
    return;
  }
  console.log(`• building ${profile} Cloudflare target (Vite → dist-cf)…`);
  const result = spawnSync('npm', ['run', 'flue:build:cf'], {
    cwd: REPO_ROOT,
    env: { ...process.env, CHICKPEA_DEPLOY_PROFILE: profile },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${profile} flue:build:cf failed (exit ${result.status})`);
  }
}

function verifyBuildArtifacts(expectedProfile = resolveCloudflareDeploymentProfile()) {
  const config = JSON.parse(readFileSync(CF_WRANGLER_CONFIG, 'utf8'));
  let actualProfile;
  try {
    actualProfile = classifyCloudflareDeploymentProfile(config);
  } catch (error) {
    check(false, `built wrangler.json has an exact ${expectedProfile} deployment profile`, String(error));
  }
  check(
    actualProfile === expectedProfile,
    `built wrangler.json matches the requested ${expectedProfile} deployment profile`,
    `generated ${actualProfile ?? 'invalid'}`,
  );
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
  if (expectedProfile === 'sandbox') {
    check(
      doBindings.some((b) => b.name === 'SANDBOX' && b.class_name === 'Sandbox'),
      'Sandbox build carries the reviewed Sandbox DO binding',
    );
  } else {
    check(
      !doBindings.some((b) => b.name === 'SANDBOX' || b.class_name === 'Sandbox'),
      'core build carries no Sandbox DO binding',
    );
    check((config.containers ?? []).length === 0, 'core build declares no Container application');
  }
  const authDb = (config.d1_databases ?? []).find((binding) => binding.binding === 'AUTH_DB');
  check(
    Boolean(authDb) && String(authDb.migrations_dir ?? '').endsWith('migrations/better-auth'),
    'built wrangler.json carries AUTH_DB reviewed migrations',
  );
  const migrations = config.migrations ?? [];
  const tags = migrations.map((migration) => migration.tag);
  check(
    sameArray(tags, ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']),
    'built wrangler.json migrations use the exact append-only v1 through v9 chain',
    tags.join(','),
  );
  const sandboxMigration = migrations.find((migration) => migration.tag === 'v3');
  check(
    sameArray(sandboxMigration?.new_sqlite_classes ?? [], ['Sandbox']),
    'built wrangler.json preserves the v3 Sandbox class migration in every deployment profile',
  );
  const reset = migrations.find((migration) => migration.tag === 'v6');
  check(
    sameArray(
      [...(reset?.deleted_classes ?? [])].sort(),
      [...BETA_FLUE_CLASSES].sort(),
    ),
    'v6 deletes exactly the four beta Flue classes',
  );
  const authGuardMigration = migrations.find((migration) => migration.tag === 'v7');
  check(
    sameArray(authGuardMigration?.new_sqlite_classes ?? [], RETIRED_AUTH_CLASSES),
    'v7 preserves the AuthGuard SQLite class history',
  );
  const authGuardRetirement = migrations.find((migration) => migration.tag === 'v8');
  check(
    sameArray(authGuardRetirement?.deleted_classes ?? [], RETIRED_AUTH_CLASSES),
    'v8 retires exactly the AuthGuard class',
  );
  const gatewaySessionMigration = migrations.find((migration) => migration.tag === 'v9');
  check(
    sameArray(gatewaySessionMigration?.new_sqlite_classes ?? [], ['SlackGatewaySession']),
    'v9 adds exactly the outbound shared-app gateway session class',
  );
  if (expectedProfile === 'sandbox') {
    const sandboxContainer = (config.containers ?? []).find(
      (container) => container.class_name === 'Sandbox',
    );
    check(
      sandboxContainer?.instance_type === 'standard-1' && sandboxContainer?.max_instances === 25,
      'Sandbox build keeps the bounded multi-thread capacity',
      sandboxContainer
        ? `${sandboxContainer.instance_type} / ${sandboxContainer.max_instances} max instances`
        : 'missing',
    );
  }
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
    config.version_metadata?.binding === 'CF_VERSION_METADATA',
    'built wrangler.json carries the Worker version metadata binding',
  );
  check(
    sameArray(config.triggers?.crons ?? [], ['* * * * *']),
    'built wrangler.json carries exactly one heartbeat Cron Trigger',
  );
  check(
    !Object.hasOwn(config.vars ?? {}, 'TAG_OPENAI_SUBSCRIPTION_ENABLED'),
    'built artifact exposes no OpenAI Subscription preview gate',
  );
  check(
    Object.keys(config.vars ?? {}).length === 0,
    'built artifact exposes no customer-editable runtime defaults',
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
  check(
    bundle.includes('routine_schedule_actions') &&
      bundle.includes('manage_scheduled_work') &&
      bundle.includes('slackScheduleActionInvoke') &&
      bundle.includes('retryDueSlackScheduleActions'),
    'built Worker carries the durable schedule-action ledger, tool, RPC, and alarm recovery path',
  );
}

function writeSmokeWranglerConfigs(setup) {
  const productionConfig = JSON.parse(readFileSync(CF_WRANGLER_CONFIG, 'utf8'));
  // The production AI binding accepts the turn's AbortSignal directly. Our
  // local stand-in crosses a service-RPC boundary, so opt only the disposable
  // smoke workers into serializing that otherwise-identical argument.
  const smokeCompatibilityFlags = [
    ...new Set([...(productionConfig.compatibility_flags ?? []), AI_SMOKE_RPC_FLAG]),
  ];
  const smokeConfig = {
    ...productionConfig,
    d1_databases: (productionConfig.d1_databases ?? []).map((database) =>
      database.binding === 'AUTH_DB'
        ? { ...database, database_id: '00000000-0000-0000-0000-000000000001' }
        : database),
    vars: {
      ...(productionConfig.vars ?? {}),
      [SETUP_CAPABILITY_DIGEST_BINDING]: setup.digest,
      [SETUP_CAPABILITY_ISSUED_AT_BINDING]: String(setup.issuedAt),
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
  // A Sandbox-profile structure smoke never calls the coding tier, and local
  // Wrangler may invoke Docker despite dev.enable_containers=false. Core has
  // no declaration; for Sandbox only, omit it from this disposable copy after
  // the exact production shape was asserted above.
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
  // Deliberately no Slack app/bot credentials here: the smoke runs the real
  // app-creation and OAuth journey. Only the independent deployment keyring
  // and local provider/API endpoints are target configuration.
  writeFileSync(
    join(CF_OUTPUT_DIR, 'chickpea', '.dev.vars'),
    [
      `CHICKPEA_AUTH_SECRET=${AUTH_SECRET}`,
      'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID=key_v1',
      `CHICKPEA_CREDENTIAL_KEY_KEY_V1=${Buffer.alloc(32, 7).toString('base64url')}`,
      `SLACK_TAG_PUBLIC_URL=${PUBLIC_ORIGIN}`,
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

function applyLocalAuthMigrations() {
  const result = spawnSync(
    WRANGLER_BIN,
    [
      'd1',
      'migrations',
      'apply',
      'AUTH_DB',
      '--local',
      '--persist-to',
      PERSIST_DIR,
      '--config',
      CF_SMOKE_WRANGLER_CONFIG,
    ],
    { cwd: REPO_ROOT, env: { ...process.env, CI: '1' }, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`local AUTH_DB migrations failed (exit ${result.status})`);
  }
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
  const method = String(init.method ?? 'GET').toUpperCase();
  const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(adminCookie ? { cookie: adminCookie } : {}),
      'content-type': 'application/json',
      ...(mutation ? { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-origin' } : {}),
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

async function adminPageHtml(baseUrl, path = '/admin') {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: adminCookie ? { cookie: adminCookie } : {},
  });
  return response.text();
}

function formHeaders() {
  return {
    origin: PUBLIC_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded',
  };
}

async function postForm(baseUrl, path, fields, cookie = '') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...formHeaders(), ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  });
}

function responseCookie(response, prefix) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''];
  for (const value of values) {
    for (const candidate of value.split(/,(?=\s*[^;,]+=)/)) {
      const cookie = candidate.trim().split(';', 1)[0] ?? '';
      if (cookie.startsWith(prefix)) return cookie;
    }
  }
  return '';
}

function slackAuthorizationUrlFromHandoff(html) {
  const encoded = /data-slack-authorization-link href="([^"]+)"/.exec(html)?.[1];
  return new URL(encoded ? encoded.replaceAll('&amp;', '&') : 'about:blank');
}

async function completeSlackNativeSetup(baseUrl, eventsUrl, setup, backend) {
  const setupPage = await fetch(`${baseUrl}/admin/setup`);
  const setupHtml = await setupPage.text();
  check(
    setupPage.status === 200 &&
      setupHtml.includes('Resume private setup') &&
      setupHtml.includes('/admin/setup/client.js') &&
      !/password|ownerEmail|sign up/i.test(setupHtml) &&
      !setupHtml.includes(setup.capability),
    'fresh setup renders only the private Slack journey without password or capability echo',
    `HTTP ${setupPage.status}`,
  );
  const opened = await postForm(baseUrl, '/admin/setup', {
    action: 'open', capability: setup.capability, destination: '/admin/channels',
  });
  const openedHtml = await opened.text();
  check(
    opened.status === 200 && openedHtml.includes('data-primary-action="gateway-install"') &&
      openedHtml.includes('Add to Slack') &&
      openedHtml.includes('Use your own Slack app instead') &&
      openedHtml.includes('Generate an App Configuration token in Slack') &&
      openedHtml.includes('href="/admin/setup/manual"'),
    'deploy capability leads with Add to Slack and keeps both customer-owned fallbacks',
    `HTTP ${opened.status}`,
  );

  const manualOpened = await postForm(baseUrl, '/admin/setup/manual', {
    action: 'open', capability: setup.capability, destination: '/admin/onboarding',
  });
  const manualHtml = await manualOpened.text();
  const manualAsset = await fetch(`${baseUrl}/admin/assets/onboarding/create-workspace.webp`);
  const manualAssetBytes = new Uint8Array(await manualAsset.arrayBuffer());
  check(
    manualOpened.status === 200 &&
      manualHtml.includes('Create Chickpea') &&
      manualHtml.includes('Finish creating Chickpea') &&
      manualHtml.includes('Verify Event URL') &&
      manualHtml.includes('Add app credentials') &&
      !manualHtml.includes(setup.capability) &&
      manualAsset.status === 200 &&
      manualAsset.headers.get('content-type') === 'image/webp' &&
      new TextDecoder().decode(manualAssetBytes.slice(0, 4)) === 'RIFF' &&
      manualAssetBytes.byteLength > 10_000,
    'separate manual journey restores its historical screens and public screenshot assets',
    `page HTTP ${manualOpened.status}; asset HTTP ${manualAsset.status}`,
  );

  const created = await postForm(baseUrl, '/admin/setup', {
    action: 'create', capability: setup.capability, destination: '/admin/channels',
    configurationToken: OAUTH_CONFIGURATION_TOKEN,
  });
  const createdHtml = await created.text();
  check(
    created.status === 200 && createdHtml.includes('Continue to Slack') &&
      !createdHtml.includes(OAUTH_CONFIGURATION_TOKEN) &&
      !createdHtml.includes(OAUTH_CLIENT_SECRET),
    'programmatic app creation records write-only app credentials and advances setup',
    `HTTP ${created.status}`,
  );

  const providerCallsBeforeInstall = backend.providerCalls().length;
  const preInstall = await postSignedEvent(eventsUrl, mentionEvent('Ev_SMOKE_PRE_INSTALL'));
  await backend.quiesce();
  check(
    preInstall.status === 200 && backend.providerCalls().length === providerCallsBeforeInstall &&
      backend.finals().length === 0,
    'app-stage signing acknowledges Slack but rejects Agent work before bot OAuth',
    `HTTP ${preInstall.status}`,
  );

  const installStart = await postForm(baseUrl, '/auth/slack/install/start', {
    capability: setup.capability, destination: '/admin/channels',
  });
  const installAuthorization = slackAuthorizationUrlFromHandoff(await installStart.text());
  const installCookie = responseCookie(installStart, '__Secure-chickpea_slack_install=');
  check(
    installStart.status === 200 && installAuthorization.origin === 'https://slack.com' &&
      Boolean(installAuthorization.searchParams.get('state')) && Boolean(installCookie),
    'bot OAuth start uses a narrow browser cookie and Slack authorization state',
    `HTTP ${installStart.status}`,
  );
  const installState = installAuthorization.searchParams.get('state') ?? '';
  const installCallback = await fetch(
    `${baseUrl}/auth/slack/install/callback?state=${encodeURIComponent(installState)}&code=bot-smoke-code`,
    { redirect: 'manual', headers: { cookie: installCookie } },
  );
  check(
    installCallback.status === 303 &&
      installCallback.headers.get('location')?.includes('slack_install=waiting_events'),
    'confidential bot exchange validates app/team/bot/scopes/directory/channel before waiting on Events',
    `HTTP ${installCallback.status} location=${installCallback.headers.get('location')}`,
  );

  const challenge = await postSignedEvent(eventsUrl, {
    type: 'url_verification', challenge: 'cf-smoke-oauth-proof',
    api_app_id: APP_ID, team_id: WORKSPACE,
  });
  check(
    challenge.status === 200 && challenge.body?.challenge === 'cf-smoke-oauth-proof',
    'a separately signed URL verification promotes only the exact OAuth candidate',
    `HTTP ${challenge.status}`,
  );
  let finalized;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await delay(500);
    finalized = await postForm(baseUrl, '/auth/slack/install/finalize', {
      capability: setup.capability, destination: '/admin/channels',
    });
    if (finalized.headers.get('location')?.includes('slack_install=bot_installed')) break;
  }
  check(
    finalized?.status === 303 && finalized.headers.get('location')?.includes('slack_install=bot_installed'),
    'exact signed Events proof finalizes the encrypted bot credential revision',
    `HTTP ${String(finalized?.status)} location=${String(finalized?.headers.get('location'))}`,
  );

  const ownerStart = await postForm(baseUrl, '/auth/slack/oidc/start', {
    purpose: 'first_owner', capability: setup.capability, destination: '/admin/channels',
  });
  const ownerAuthorization = slackAuthorizationUrlFromHandoff(await ownerStart.text());
  const ownerCookie = responseCookie(ownerStart, '__Secure-chickpea_slack_oidc=');
  const state = ownerAuthorization.searchParams.get('state') ?? '';
  const nonce = ownerAuthorization.searchParams.get('nonce') ?? '';
  check(
    ownerStart.status === 200 && ownerAuthorization.origin === 'https://slack.com' &&
      ownerAuthorization.searchParams.get('team') === WORKSPACE && Boolean(ownerCookie) &&
      state.length >= 32 && nonce.length >= 32,
    'first-Owner OIDC is exact-team and independently state/nonce/browser bound',
    `HTTP ${ownerStart.status}`,
  );
  const ownerCallback = await fetch(
    `${baseUrl}/auth/slack/oidc/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(`oidc.${nonce}`)}`,
    { headers: { cookie: ownerCookie } },
  );
  const ownerCallbackBody = await ownerCallback.text();
  adminCookie = responseCookie(ownerCallback, 'better-auth.session_token=') ||
    responseCookie(ownerCallback, '__Secure-better-auth.session_token=');
  const callbackCookieNames = (typeof ownerCallback.headers.getSetCookie === 'function'
    ? ownerCallback.headers.getSetCookie()
    : [ownerCallback.headers.get('set-cookie') ?? ''])
    .map((value) => value.trim().split('=', 1)[0])
    .filter(Boolean)
    .join(',');
  check(
    ownerCallback.status === 200 && Boolean(adminCookie) &&
      ownerCallbackBody.includes('You’re the first Owner'),
    'exact installer OIDC creates the first Owner and only then issues a Better Auth session',
    `HTTP ${ownerCallback.status} cookies=${callbackCookieNames || 'none'} session=${Boolean(adminCookie)} ownerPage=${ownerCallbackBody.includes('You’re the first Owner')}`,
  );

  const unauthenticated = await fetch(`${baseUrl}/admin/api/agents`);
  check(
    unauthenticated.status === 401,
    'Admin APIs still fail closed without the Slack-established browser session',
    `HTTP ${unauthenticated.status}`,
  );
}

async function completeSlackLogin(baseUrl) {
  const start = await postForm(baseUrl, '/auth/slack/oidc/start', {
    purpose: 'login', destination: '/admin',
  });
  const authorization = slackAuthorizationUrlFromHandoff(await start.text());
  const oidcCookie = responseCookie(start, '__Secure-chickpea_slack_oidc=');
  const state = authorization.searchParams.get('state') ?? '';
  const nonce = authorization.searchParams.get('nonce') ?? '';
  if (start.status !== 200 || !oidcCookie || state.length < 32 || nonce.length < 32) {
    throw new Error(`fresh Slack login did not start (HTTP ${start.status})`);
  }
  const callback = await fetch(
    `${baseUrl}/auth/slack/oidc/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(`oidc.${nonce}`)}`,
    { redirect: 'manual', headers: { cookie: oidcCookie } },
  );
  const session = responseCookie(callback, 'better-auth.session_token=') ||
    responseCookie(callback, '__Secure-better-auth.session_token=');
  if (callback.status !== 303 || callback.headers.get('location') !== '/admin' || !session) {
    throw new Error(`fresh Slack login did not issue a session (HTTP ${callback.status})`);
  }
  return session;
}

async function renderAdminWithWorkerdState(baseUrl, path = '/admin') {
  const html = await adminPageHtml(baseUrl, path);
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
    const method = String(options.method ?? 'GET').toUpperCase();
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    return fetch(url, {
      ...options,
      headers: {
        ...(adminCookie ? { cookie: adminCookie } : {}),
        ...(mutation ? { origin: baseUrl, 'sec-fetch-site': 'same-origin' } : {}),
        ...(options.headers ?? {}),
      },
    });
  };
  const location = {
    pathname: path,
    search: '',
    hash: '',
    href: `${baseUrl}${path}`,
  };
  const history = {
    pushState(_state, _title, next) {
      location.pathname = String(next).split(/[?#]/, 1)[0];
    },
    replaceState(_state, _title, next) {
      location.pathname = String(next).split(/[?#]/, 1)[0];
    },
  };
  vm.runInNewContext(
    script,
    {
      document,
      fetch: authenticatedFetch,
      console,
      URLSearchParams,
      location,
      history,
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
    if (
      app.innerHTML.length > 0 &&
      !app.innerHTML.includes('Loading setup&hellip;') &&
      !app.innerHTML.includes('Loading Slack setup&hellip;')
    ) {
      return { html: app.innerHTML, listeners };
    }
    await delay(10);
  }
  throw new Error(`admin inline script did not render within ${timeoutMs}ms`);
}

/** Ready = the public setup page answers from the DO-backed store (workerd + DO up). */
async function waitForSetupReady(handle, baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (exit ${handle.child.exitCode}):\n${handle.getOutput()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/admin/setup`);
      if (response.status === 200) return;
    } catch {
      // not accepting connections yet
    }
    await delay(300);
  }
  throw new Error(`wrangler dev never exposed setup:\n${handle.getOutput()}`);
}

/** Ready after setup = the authenticated Admin API answers with the persisted session. */
async function waitForAdminReady(handle, baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (exit ${handle.child.exitCode}):\n${handle.getOutput()}`);
    }
    try {
      const { status, body } = await adminFetch(baseUrl, '/admin/api/agents');
      if (status === 200 && Array.isArray(body?.agents)) return body.agents;
    } catch {
      // not accepting connections yet
    }
    await delay(300);
  }
  throw new Error(`wrangler dev never restored the authenticated Admin API:\n${handle.getOutput()}`);
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
    api_app_id: APP_ID,
    event_id: eventId,
    event_time: 1782770400,
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: OWNER_USER_ID,
      text: `<@${BOT_USER_ID}> smoke: please draft a short reply`,
      ts: MENTION_TS,
      channel: CHANNEL,
      event_ts: MENTION_TS,
    },
  };
}

function onboardingDmEvent() {
  const ts = '1782770399.000001';
  return {
    token: 'verification-token-not-a-secret',
    team_id: WORKSPACE,
    api_app_id: APP_ID,
    event_id: 'Ev_SMOKE_ONBOARDING_DM_1',
    event_time: 1782770399,
    type: 'event_callback',
    event: {
      type: 'message',
      channel_type: 'im',
      user: OWNER_USER_ID,
      text: 'Give me three useful ways you can help me.',
      ts,
      channel: ONBOARDING_DM_CHANNEL,
      event_ts: ts,
    },
  };
}

function memoryRememberEvent() {
  return {
    ...mentionEvent('Ev_SMOKE_MEMORY_1'),
    event: {
      ...mentionEvent('Ev_SMOKE_MEMORY_1').event,
      text: `<@${BOT_USER_ID}> !remember release-guidance — Use the release checklist.\nRun focused tests before release.`,
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
      text: `<@${BOT_USER_ID}> privacy smoke: answer through the Workers AI binding`,
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
    api_app_id: APP_ID,
    event_id: eventId,
    event_time: 1782771000,
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: OWNER_USER_ID,
      text: `<@${BOT_USER_ID}> slow: take as long as you need`,
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
    api_app_id: APP_ID,
    event_id: 'Ev_SMOKE_REPLY_1',
    event_time: 1782770460,
    type: 'event_callback',
    event: {
      type: 'message',
      channel: CHANNEL,
      user: OWNER_USER_ID,
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
      personalToken: process.env.CHICKPEA_PERSONAL_TOKEN,
    });
    console.log('PASS cf-smoke drain — every runtime work category is zero');
    return;
  }
  assertNodeVersion();
  const requestedProfile = resolveCloudflareDeploymentProfile();
  const buildAndVerify = (profile, options) => {
    buildCloudflareTarget(profile, options);
    console.log(`• verifying ${profile} build artifacts…`);
    verifyBuildArtifacts(profile);
    if (failures.length > 0) {
      throw new Error(`${profile} build artifacts failed verification`);
    }
  };
  if (requestedProfile === 'core') {
    // The core workerd scenario is the normal smoke target, but it cannot
    // validate the optional overlay after its own rebuild. Validate the real
    // generated Sandbox artifact first, then rebuild core for local boot.
    buildAndVerify('sandbox');
    buildAndVerify('core');
  } else {
    // An explicit Sandbox smoke retains its one-deployment-profile behavior, including
    // the documented iteration-only reuse path.
    buildAndVerify('sandbox', { reuseExisting: true });
  }
  const setup = await mintSetupCapability();
  writeSmokeWranglerConfigs(setup);

  // Fresh local DO state every run: the seeding + dedupe assertions assume a
  // first-boot Durable Object.
  rmSync(PERSIST_DIR, { recursive: true, force: true });
  applyLocalAuthMigrations();

  const { FakeSlackBackend, FAKE_PROVIDER_KEYS, STUB_REPLY_MARKER } = await loadFake();
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'cf-smoke-rs256', alg: 'RS256', use: 'sig',
  };
  // The fake provides the exact confidential bot/OIDC exchanges plus the
  // directory/channel truth checks consumed by the built Worker.
  const backend = new FakeSlackBackend({
    slack: {
      identity: {
        appId: APP_ID,
        botUserId: BOT_USER_ID,
        teamId: WORKSPACE,
        teamName: 'Smoke Workspace',
      },
      oauth: {
        appId: APP_ID,
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
        configurationToken: OAUTH_CONFIGURATION_TOKEN,
        signingSecret: SIGNING_SECRET,
        botToken: OAUTH_BOT_TOKEN,
        installerUserId: OWNER_USER_ID,
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
        publicJwk,
      },
      channels: [
        { id: CHANNEL, name: 'smoke-mentions', isMember: true, teamId: WORKSPACE },
        { id: AI_CHANNEL, name: 'smoke-workers-ai', isMember: true, teamId: WORKSPACE },
        { id: SLOW_CHANNEL, name: 'smoke-slow', isMember: true, teamId: WORKSPACE },
        { id: 'C0SMOKEEXTRA', name: 'general', isMember: false, teamId: WORKSPACE },
      ],
      channelMembers: {
        [CHANNEL]: [OWNER_USER_ID, BOT_USER_ID],
        [AI_CHANNEL]: [OWNER_USER_ID, BOT_USER_ID],
        [SLOW_CHANNEL]: [OWNER_USER_ID, BOT_USER_ID],
      },
      workspaceUsers: [
        { id: OWNER_USER_ID, teamId: WORKSPACE },
        { id: BOT_USER_ID, teamId: WORKSPACE, isBot: true, isAppUser: true },
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
    await waitForSetupReady(wrangler, baseUrl);
    await completeSlackNativeSetup(baseUrl, eventsUrl, setup, backend);
    const agentsResult = await adminFetch(baseUrl, '/admin/api/agents');
    if (agentsResult.status !== 200 || !Array.isArray(agentsResult.body?.agents)) {
      throw new Error(`authenticated Admin API did not become ready (HTTP ${agentsResult.status})`);
    }
    const agents = agentsResult.body.agents;
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
    const drainStatus = await runDrainCheck({ baseUrl, sessionCookie: adminCookie });
    check(
      drainStatus.drained,
      'runtime drain endpoint reaches the initialized TagStateStore aggregate',
      JSON.stringify(drainStatus.categories),
    );

    const wireBeforeHeartbeat = backend.wireLog.length;
    const heartbeat = await fetch(`${baseUrl}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
    await delay(100);
    const scheduledWork = await adminFetch(baseUrl, '/admin/api/audit/scheduled_work/routines');
    check(
      heartbeat.status === 200 && backend.wireLog.length === wireBeforeHeartbeat,
      'empty permanent heartbeat performs no Slack or model work',
      `HTTP ${heartbeat.status} wireDelta=${backend.wireLog.length - wireBeforeHeartbeat}`,
    );
    check(
      scheduledWork.status === 200 &&
        scheduledWork.body?.capability?.reason === 'enabled' &&
        scheduledWork.body?.capability?.enabled === true &&
        Array.isArray(scheduledWork.body?.routines) &&
        scheduledWork.body.routines.length === 0,
      'Scheduled Work reports the Cloudflare capability as permanently enabled',
      `HTTP ${scheduledWork.status} reason=${String(scheduledWork.body?.capability?.reason)}`,
    );

    // --- Slack-native first Owner state ------------------------------------

    const team = await adminFetch(baseUrl, '/admin/api/team');
    check(
      team.status === 200 && !('soleOwnerWarning' in (team.body ?? {})) &&
        team.body?.members?.length === 1 && team.body?.members?.[0]?.slackUserId === OWNER_USER_ID,
      'first OIDC admission creates one exact Owner without obsolete enrollment state',
      `HTTP ${team.status} members=${String(team.body?.members?.length)}`,
    );
    const connectedAdmin = await renderAdminWithWorkerdState(baseUrl, '/admin/onboarding');
    check(
      connectedAdmin.html.includes('Choose your model provider') &&
        connectedAdmin.html.includes('data-action="onboarding-provider-continue"') &&
        !connectedAdmin.html.includes('Choose where Chickpea should start'),
      'fresh Slack-native onboarding resumes at provider selection without a channel picker',
    );
    check(
      connectedAdmin.html.length > 0 &&
        !/password|sign up|forgot/i.test(connectedAdmin.html),
      'authenticated onboarding exposes no password-era affordance',
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
    const smokeAgent = {
      id: 'agent_cf_smoke',
      name: 'CF Smoke Agent',
      instructions: 'Answer only from the CF smoke gate fixture.',
      enabled: true,
      model: 'anthropic/claude-sonnet-4-6',
      mcpServers: smokeConnections,
    };
    const agentCreate = await adminFetch(baseUrl, '/admin/api/agents', {
      method: 'POST',
      body: JSON.stringify(smokeAgent),
    });
    check(
      agentCreate.status === 201 &&
        agentCreate.body?.agent?.id === 'agent_cf_smoke' &&
        agentCreate.body?.agent?.model === 'anthropic/claude-sonnet-4-6',
      'Agent create endpoint saves an explicit model pin',
      `HTTP ${agentCreate.status}`,
    );
    const createdAgent = await adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke');
    check(
      createdAgent.status === 200 &&
        createdAgent.body?.agent?.model === 'anthropic/claude-sonnet-4-6',
      'Agent create round-trips through the Agent GET endpoint',
      `HTTP ${createdAgent.status}`,
    );

    // Two writes in parallel exercise the atomic settings-set merge through a
    // real Durable Object RPC. Delete + recreate then probes both sources: if
    // either merge entry were lost, its old credential would still read stored.
    const [linearSecrets, githubSecrets] = await Promise.all([
      adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke/mcp/secrets/linear-mcp', {
        method: 'PUT',
        body: JSON.stringify({
          bearerToken: 'linear-smoke-token',
          headers: { 'X-Linear-Key': 'linear-smoke-key' },
          headerNames: ['X-Linear-Key'],
        }),
      }),
      adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke/mcp/secrets/github-mcp', {
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
    const deleteSmokeAgent = await adminFetch(
      baseUrl,
      '/admin/api/agents/agent_cf_smoke',
      { method: 'DELETE' },
    );
    check(
      deleteSmokeAgent.status === 204,
      'Agent deletion consumes the durable MCP secret inventory',
      `HTTP ${deleteSmokeAgent.status}`,
    );
    const recreateSmokeAgent = await adminFetch(baseUrl, '/admin/api/agents', {
      method: 'POST',
      body: JSON.stringify(smokeAgent),
    });
    const [linearSources, githubSources] = await Promise.all([
      adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke/mcp/secrets/linear-mcp', {
        method: 'PUT',
        body: JSON.stringify({ headerNames: ['X-Linear-Key'] }),
      }),
      adminFetch(baseUrl, '/admin/api/agents/agent_cf_smoke/mcp/secrets/github-mcp', {
        method: 'PUT',
        body: JSON.stringify({ headerNames: ['X-GitHub-Key'] }),
      }),
    ]);
    check(
      recreateSmokeAgent.status === 201 &&
        linearSources.body?.bearer === 'missing' &&
        linearSources.body?.headers?.['X-Linear-Key'] === 'missing' &&
        githubSources.body?.bearer === 'missing' &&
        githubSources.body?.headers?.['X-GitHub-Key'] === 'missing',
      'Agent deletion cleared both parallel MCP credential scopes',
      `HTTP ${recreateSmokeAgent.status}/${linearSources.status}/${githubSources.status}`,
    );
    const cleanupSmokeAgent = await adminFetch(
      baseUrl,
      '/admin/api/agents/agent_cf_smoke',
      { method: 'DELETE' },
    );
    check(
      cleanupSmokeAgent.status === 204,
      'recreated MCP smoke Agent cleans up',
      `HTTP ${cleanupSmokeAgent.status}`,
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
    const mismatch = await adminFetch(baseUrl, '/admin/api/agents/agent_default/channels', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'T0WRONG',
        channelId: CHANNEL,
      }),
    });
    check(
      mismatch.status === 403 && mismatch.body?.error === 'forbidden',
      'mismatched-workspace Agent publication is forbidden',
      `HTTP ${mismatch.status} ${mismatch.body?.error ?? ''}`,
    );

    const put = await adminFetch(baseUrl, '/admin/api/agents/agent_default/channels', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        channelId: CHANNEL,
      }),
    });
    check(
      put.status === 201 && put.body?.grant?.status === 'active',
      'Agent publication created the active Channel grant and Slack handle',
      `HTTP ${put.status}`,
    );
    const onboardingBeforeProvider = await adminFetch(baseUrl, '/admin/api/onboarding');
    check(
      onboardingBeforeProvider.status === 200 && onboardingBeforeProvider.body?.stage === 'choose_provider',
      'onboarding resumes at provider selection after Slack connects',
      `HTTP ${onboardingBeforeProvider.status} stage=${String(onboardingBeforeProvider.body?.stage)}`,
    );
    const onboardingBeforeTry = await adminFetch(baseUrl, '/admin/api/onboarding/provider', {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision: onboardingBeforeProvider.body?.revision,
        providerId: 'cloudflare',
      }),
    });
    check(
      onboardingBeforeTry.status === 200 && onboardingBeforeTry.body?.stage === 'choose_model',
      'provider selection advances onboarding to model selection',
      `HTTP ${onboardingBeforeTry.status} stage=${String(onboardingBeforeTry.body?.stage)}`,
    );
    const onboardingWorkspaceDefault = await adminFetch(baseUrl, '/admin/api/workspace-model-default');
    const onboardingTry = await adminFetch(baseUrl, '/admin/api/onboarding/try', {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision: onboardingBeforeTry.body?.revision,
        modelId: 'cloudflare/@cf/zai-org/glm-5.2',
        expectedDefaultRevision: onboardingWorkspaceDefault.body?.workspaceDefault?.revision,
      }),
    });
    check(
      onboardingTry.status === 200 &&
        onboardingTry.body?.stage === 'try' &&
        onboardingTry.body?.agentId === 'agent_chickpea' &&
        onboardingTry.body?.slackAppId === APP_ID,
      'model selection activates Chickpea and advances onboarding to its Slack DM',
      `HTTP ${onboardingTry.status} stage=${String(onboardingTry.body?.stage)}`,
    );
    const onboardingDmAdmission = await postSignedEvent(eventsUrl, onboardingDmEvent());
    check(
      onboardingDmAdmission.status === 200 || onboardingDmAdmission.status === 202,
      'plain installer DM admitted without an @Chickpea mention',
      `HTTP ${onboardingDmAdmission.status}`,
    );
    const onboardingFinals = await waitForFinalCount(backend, 1, 90_000);
    check(
      onboardingFinals.some((final) => final.channel === ONBOARDING_DM_CHANNEL),
      'Chickpea delivered the onboarding reply in the installer DM',
    );
    const completedOnboarding = await adminFetch(baseUrl, '/admin/api/onboarding');
    check(
      completedOnboarding.status === 200 && completedOnboarding.body?.stage === 'complete',
      'a delivered installer DM completes onboarding',
      `HTTP ${completedOnboarding.status} stage=${String(completedOnboarding.body?.stage)}`,
    );
    backend.reset();

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
    const aiPut = await adminFetch(baseUrl, '/admin/api/agents/agent_default/channels', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        channelId: AI_CHANNEL,
      }),
    });
    check(
      aiPut.status === 201 && aiPut.body?.grant?.status === 'active',
      'Agent publication granted the Workers AI smoke Channel',
      `HTTP ${aiPut.status}`,
    );
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
      body: JSON.stringify({
        expectedRevision: aiPut.body?.agent?.revision ?? defaultAgent.revision,
        model: 'local-stub/smoke-model',
      }),
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
      memoryFinals.length === 2 && Boolean(memoryFinals[1]?.text.includes('Saved Agent memory (revision 1).')),
      'explicit Memory command persisted to the Agent memory and returned a receipt',
      memoryFinals[1]?.text ?? 'no memory receipt',
    );
    const memoryPath = '/admin/api/agents/agent_default/memory';
    const agentMemory = await adminFetch(baseUrl, memoryPath);
    check(
      agentMemory.status === 200 && agentMemory.body?.memory?.agentId === 'agent_default' &&
        agentMemory.body?.memory?.revision === 1 &&
        String(agentMemory.body?.memory?.body ?? '').includes('Use the release checklist.'),
      'workerd Admin Memory API exposes the one Agent-owned body',
      `memory=${agentMemory.status} revision=${String(agentMemory.body?.memory?.revision)}`,
    );
    const memoryEditBody = JSON.stringify({
      expectedRevision: 1,
      body: 'Run focused tests and the workerd smoke before release.',
    });
    const memoryEdit = await adminFetch(
      baseUrl,
      memoryPath,
      {
        method: 'PUT',
        body: memoryEditBody,
      },
    );
    const memoryConflict = await adminFetch(
      baseUrl,
      memoryPath,
      {
        method: 'PUT',
        body: memoryEditBody,
      },
    );
    check(
      memoryEdit.status === 200 && memoryEdit.body?.memory?.revision === 2 &&
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

    const persistedSession = await adminFetch(baseUrl, '/admin/api/team');
    check(
      persistedSession.status === 200 && persistedSession.body?.members?.[0]?.slackUserId === OWNER_USER_ID,
      'the original Slack-established session and exact Owner survived the workerd restart',
      `HTTP ${persistedSession.status}`,
    );
    adminCookie = await completeSlackLogin(baseUrl);
    const freshSession = await adminFetch(baseUrl, '/admin/api/team');
    check(
      freshSession.status === 200 && freshSession.body?.viewer?.role === 'owner',
      'a fresh post-restart Slack OIDC session resolves the same live Owner authority',
      `HTTP ${freshSession.status} role=${String(freshSession.body?.viewer?.role)}`,
    );
    const restartMemory = await adminFetch(baseUrl, memoryPath);
    check(
      restartMemory.status === 200 && restartMemory.body?.memory?.revision === 2 &&
        restartMemory.body?.memory?.body === 'Run focused tests and the workerd smoke before release.',
      'Agent memory and revision survived the workerd restart',
      `HTTP ${restartMemory.status} revision=${String(restartMemory.body?.memory?.revision)}`,
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
    const slowGrant = await adminFetch(baseUrl, '/admin/api/agents/agent_default/channels', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        channelId: SLOW_CHANNEL,
      }),
    });
    check(
      slowGrant.status === 201 && slowGrant.body?.grant?.status === 'active',
      'Agent publication granted the slow-turn Channel',
      `HTTP ${slowGrant.status}`,
    );

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
