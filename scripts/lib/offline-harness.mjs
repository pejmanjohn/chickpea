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
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FLUE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'flue');
export const NET_GUARD = join(REPO_ROOT, 'scripts', 'net-guard.mjs');
export const SIGNING_SECRET = 'test-signing-secret';
export const EVENTS_PATH = '/channels/slack/events';
const MIN_NODE = [22, 19, 0];

/** Load an arbitrary repo-relative TypeScript module through tsx's runtime loader. */
export async function loadTsModule(relativePath) {
  const { register } = await import('tsx/esm/api');
  const unregister = register();
  const mod = await import(join(REPO_ROOT, relativePath));
  unregister();
  return mod;
}

/** Load the TypeScript fake backend through tsx's runtime loader. */
export function loadFake() {
  return loadTsModule('tests/parity/fake-slack.ts');
}

export async function seedOfflineDemoChannelConfig(stateDbPath) {
  const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
  const { seededAgents, seededAssignments, demoChannelAssignments } =
    await loadTsModule('src/config/seed.ts');

  const store = new SqliteConfigStore(stateDbPath, {
    agents: seededAgents,
    // The T_DEMO fixtures are no longer part of the install seed; the offline
    // harnesses opt back into them here, on top of the real seed (the '*/*'
    // DM wildcard), from the single fixture source in src/config/seed.ts.
    assignments: [...demoChannelAssignments, ...seededAssignments],
  });
  store.close();
}

export function assertNodeVersion() {
  const raw = execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim();
  const parts = raw.replace(/^v/, '').split('.').map((piece) => Number(piece));
  for (let i = 0; i < MIN_NODE.length; i += 1) {
    if ((parts[i] ?? 0) !== MIN_NODE[i]) {
      if ((parts[i] ?? 0) < MIN_NODE[i]) {
        throw new Error(
          `This script needs Node >= 22.19 to build/run Flue, but ${process.execPath} is ${raw}. ` +
            'Re-run it with a newer Node first on PATH (e.g. PATH=/path/to/node-22.19+/bin:$PATH); ' +
            'FLUE_NODE_BIN only affects the parity test suite, not these scripts.',
        );
      }
      break;
    }
  }
  return raw;
}

/** `flue build --target node --output <outputDir>`; resolves to the server entry.
 * Defaults to `dist/` (git-ignored, the canonical `flue:build` output). */
export function buildNodeServer(outputDir = 'dist') {
  return new Promise((resolve, reject) => {
    const child = spawn(FLUE_BIN, ['build', '--target', 'node', '--output', outputDir], {
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
        : reject(new Error(`flue build --target node failed (exit ${code}):\n${output}`)),
    );
  });
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
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
  const child = spawn(process.execPath, [serverEntry], {
    cwd: REPO_ROOT,
    env: {
      ...ambientEnv,
      PORT: String(port),
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      SLACK_BOT_TOKEN: 'test-bot-token',
      SLACK_BOT_USER_ID: 'U_BOT',
      SLACK_API_URL: `${fakeUrl}/api/`,
      LOCAL_STUB_URL: `${fakeUrl}/v1`,
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
