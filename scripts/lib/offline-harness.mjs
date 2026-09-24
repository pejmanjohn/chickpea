/**
 * Shared support for the offline verification scripts.
 *
 * Each verifier builds the real Flue app for the Node target, spawns the
 * built `server.mjs` against an in-memory fake Slack + fake provider backend,
 * and drives signed Slack events over real HTTP — all with a net-guard that
 * blocks (and logs) any non-loopback fetch. No secrets, no external traffic.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveVerificationPort } from './verification-ports.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'vite');
export const NET_GUARD = join(REPO_ROOT, 'scripts', 'net-guard.mjs');
export const SIGNING_SECRET = 'test-signing-secret';
export const EVENTS_PATH = '/channels/slack/events';
export { assertNodeVersion } from './node-version.mjs';
let tsLoaderReady;

/** Load an arbitrary repo-relative TypeScript module through tsx's runtime loader. */
export async function loadTsModule(relativePath) {
  // These standalone verifiers own their process. Keep one loader for its
  // lifetime: unregistering between overlapping import graphs can leave the
  // Node 22 ESM loader spinning. Sharing the promise also serializes first use.
  tsLoaderReady ??= import('tsx/esm/api').then(({ register }) => { register(); });
  await tsLoaderReady;
  return import(join(REPO_ROOT, relativePath));
}

/** Load the TypeScript fake backend through tsx's runtime loader. */
export function loadFake() {
  return loadTsModule('tests/parity/fake-slack.ts');
}

export async function seedOfflineDemoChannelConfig(stateDbPath, options = {}) {
  const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
  const { createDemoStarterAgent, demoAgentChannelGrants } =
    await loadTsModule('src/config/seed.ts');

  const demoGrants = options.workspaceId && options.channelId
    ? [{
        ...demoAgentChannelGrants.find((grant) => grant.channelId === 'C_EXEC'),
        workspaceId: options.workspaceId,
        channelId: options.channelId,
      }]
    : demoAgentChannelGrants;

  const store = new SqliteConfigStore(stateDbPath, {
    agents: [createDemoStarterAgent()],
    grants: demoGrants,
  });
  for (const grant of demoGrants) {
    // The offline verifiers exercise the granted default Agent through base-app
    // mentions (history read, status, streamed final). That is the legacy
    // routing contract; on chickpea-v1 a base mention routes to the Chickpea
    // system principal instead. Pin the contract the scenarios assert.
    await store.ensureWorkspaceInstallation({
      workspaceId: grant.workspaceId,
      transportMode: 'direct',
      runtimeContract: 'legacy',
      defaultAgentId: grant.agentId,
      teamId: grant.workspaceId,
    });
  }
  store.close();
}

/**
 * Seed one file-backed Slack-native Owner, personal token, and encrypted
 * workspace-default installation for offline Node verifiers. This mirrors the
 * post-OAuth authority shape without adding a product bootstrap backdoor.
 */
export async function seedOfflineSlackAuthority({
  stateDbPath,
  keyringPath,
  canonicalOrigin,
  teamId = 'TDEMO123',
  slackUserId = 'UALICE01',
  appId = 'ADEMO123',
  botUserId = 'UBOT1234',
  botToken = 'test-bot-token',
  signingSecret = SIGNING_SECRET,
}) {
  const { SqliteIdentityStore } = await loadTsModule('src/identity/store.ts');
  const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
  const { PersonalTokenService } = await loadTsModule('src/auth/personal-token.ts');
  const ownerModule = await loadTsModule('tests/helpers/slack-owner.ts');
  const keyringModule = await loadTsModule('src/slack/credential-keyring.ts');
  const credentialsModule = await loadTsModule('src/slack/installation-credentials.ts');
  const { WORKSPACE_SLACK_INSTALLATION_ID } = await loadTsModule('src/config/types.ts');
  const scopesModule = await loadTsModule('src/slack/scopes.ts');
  const identity = new SqliteIdentityStore(stateDbPath);
  try {
    const owner = await ownerModule.createSlackOwner(identity, {
      teamId,
      userId: slackUserId,
      suffix: 'offline_verifier',
    });
    const control = await identity.getAuthControl();
    if (!control) throw new Error('offline Slack authority did not activate auth control');
    await identity.updateAuthControl({
      expectedRevision: control.revision,
      canonicalAdminOrigin: canonicalOrigin,
    });
    const keyring = keyringModule.loadOrCreateNodeCredentialKeyring({ path: keyringPath });
    const dependencies = { state: identity, keyring };
    const app = await credentialsModule.stageSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      identityClass: 'workspace_installation',
      purpose: 'app_credentials',
      expectedActiveRevision: null,
      appId,
      secrets: { clientId: 'offline.client', clientSecret: 'offline-client-secret', signingSecret },
    });
    await credentialsModule.promoteSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      candidateRevision: app.revision,
      expectedActiveRevision: null,
    });
    const connected = await credentialsModule.stageSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      identityClass: 'workspace_installation',
      purpose: 'connected_credentials',
      expectedActiveRevision: app.revision,
      appId,
      teamId,
      botUserId,
      grantedScopes: [...scopesModule.REQUIRED_SLACK_BOT_SCOPES],
      validatedAt: Date.now(),
      secrets: {
        clientId: 'offline.client', clientSecret: 'offline-client-secret', signingSecret, botToken,
      },
    });
    await credentialsModule.promoteSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID,
      candidateRevision: connected.revision,
      expectedActiveRevision: app.revision,
    });
    const config = new SqliteConfigStore(stateDbPath);
    try {
      const installation = await config.ensureWorkspaceInstallation({
        workspaceId: teamId,
        transportMode: 'direct',
        teamId,
        appId,
        botUserId,
      });
      await config.updateWorkspaceInstallation(teamId, {
        health: 'healthy',
      }, installation.revision);
    } finally {
      config.close();
    }
    return (await new PersonalTokenService(identity).create(owner.user.id, 'Offline verifier')).token;
  } finally {
    identity.close();
  }
}

/** `vite build --config vite.node.config.ts --outDir <outputDir>`; resolves to the server entry.
 * Defaults to `dist/` (git-ignored, the canonical `flue:build` output). */
export function buildNodeServer(outputDir = 'dist') {
  // verify:regression builds dist/ once and then runs these proofs together;
  // concurrent rebuilds of the same directory would race.
  if (outputDir === 'dist' && process.env.CHICKPEA_NODE_BUILD_READY === '1') {
    const entry = join(REPO_ROOT, 'dist', 'server.mjs');
    return existsSync(entry) ? Promise.resolve(entry)
      : Promise.reject(new Error('CHICKPEA_NODE_BUILD_READY is set but dist/server.mjs is missing; run npm run flue:build first.'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(VITE_BIN, ['build', '--config', 'vite.node.config.ts', '--outDir', outputDir], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve(join(REPO_ROOT, outputDir, 'server.mjs'))
        : reject(new Error(`Vite Node build failed (exit ${code}):\n${output}`)),
    );
  });
}

/** A loopback port reserved for this process; see verification-ports.mjs. */
export function getFreePort() {
  return reserveVerificationPort();
}

export function signedHeaders(rawBody, { tamper = false } = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  let digest = createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex');
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

export async function postSignedEvent(eventsUrl, payload, opts = {}) {
  const rawBody = JSON.stringify(payload);
  const response = await fetch(eventsUrl, {
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

/**
 * Spawn a built Flue server. `env` is merged last (so callers set provider
 * routing, TAG_DB_PATH, tokens, etc.). Returns the child + an output getter
 * and the base URL / events URL.
 */
export function spawnServer({ serverEntry, port, fakeUrl, netGuardLog, env = {} }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  // Scrub ambient provider credentials so the offline gates stay hermetic.
  // Model routing should come from explicit local-stub pins, with
  // SLACK_TAG_MODEL available only for unpinned fallback probes. A script that
  // intends to exercise a provider passes its own values via `env`, which
  // spreads after (and therefore overrides) this scrub.
  const ambientEnv = { ...process.env };
  delete ambientEnv.ANTHROPIC_API_KEY;
  delete ambientEnv.ANTHROPIC_BASE_URL;
  delete ambientEnv.CLOUDFLARE_API_TOKEN;
  delete ambientEnv.CLOUDFLARE_ACCOUNT_ID;
  delete ambientEnv.CLOUDFLARE_WORKERS_AI_BASE_URL;
  delete ambientEnv.OPENAI_API_KEY;
  delete ambientEnv.OPENAI_BASE_URL;
  delete ambientEnv.OPENROUTER_API_KEY;
  delete ambientEnv.OPENROUTER_BASE_URL;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: REPO_ROOT,
    env: {
      ...ambientEnv,
      PORT: String(port),
      SLACK_API_URL: `${fakeUrl}/api/`,
      LOCAL_STUB_URL: `${fakeUrl}/v1`,
      CHICKPEA_DISABLE_TELEMETRY: 'true',
      SLACK_TAG_MODEL: 'local-stub/parity-stub-1',
      ...(netGuardLog ? { NET_GUARD_LOG: netGuardLog, NODE_OPTIONS: `--import ${NET_GUARD}` } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { child, baseUrl, eventsUrl: `${baseUrl}${EVENTS_PATH}`, getOutput: () => output };
}

export async function waitForReady(child, eventsUrl, getOutput, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (exit ${child.exitCode}):\n${getOutput()}`);
    }
    try {
      const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'ready' });
      const response = await fetch(eventsUrl, {
        method: 'POST',
        headers: signedHeaders(rawBody),
        body: rawBody,
      });
      await response.text();
      if (response.status === 200) {
        return;
      }
    } catch {
      // not accepting connections yet
    }
    await delay(200);
  }
  throw new Error(`server never became ready:\n${getOutput()}`);
}

/**
 * Allocate a port, spawn the server on it, and wait until it answers.
 *
 * `getFreePort` reserves a port from a range no other verification process or
 * outgoing connection should take, then bind-probes it; a foreign service can
 * still appear before the child binds. When the child exits with EADDRINUSE,
 * stop it and try again on a fresh port instead of failing the whole
 * verification. Any other startup failure propagates unchanged.
 */
export async function spawnReadyServer(options, {
  attempts = 3,
  allocatePort = getFreePort,
  start = spawnServer,
  ready = waitForReady,
  stop = stopChild,
  log = (line) => console.log(line),
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const port = await allocatePort();
    const server = start({ ...options, port });
    try {
      await ready(server.child, server.eventsUrl, server.getOutput);
      return { ...server, port };
    } catch (error) {
      await stop(server.child);
      if (attempt >= attempts || !isPortCollision(error)) throw error;
      log(`[offline-harness] port ${port} was taken before the server bound it; retrying on a fresh port (${attempt}/${attempts - 1})`);
    }
  }
}

function isPortCollision(error) {
  return /EADDRINUSE/.test(String(error?.message ?? error));
}

export function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const settle = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(settle);
      resolve();
    });
    child.kill('SIGKILL');
  });
}

export async function waitForFinals(backend, minFinals, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.finals().length >= minFinals) {
      return backend.finals();
    }
    await delay(200);
  }
  return backend.finals();
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
