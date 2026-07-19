import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { SqliteConfigStore } from '../../src/config/store.ts';
import { FakeSlackBackend } from './fake-slack.ts';
import {
  PARITY_SIGNING_SECRET,
  signSlackRequest,
  type Lane,
  type LaneInstance,
  type ScenarioLaneConfig,
} from './lane.ts';

/**
 * Lane B drives the REAL Flue app end-to-end over HTTP.
 *
 * The Flue app is built ONCE to `dist-node/server.mjs` (`flue build --target
 * node`, git-ignored, isolated from the cloudflare `dist/`), and every scenario
 * gets a FRESH `node dist-node/server.mjs` process on its own random port wired
 * to a fresh `FakeSlackBackend`. Fresh processes are required: scenarios reuse
 * event ids / channels and the Flue claim store + session registry are
 * process-local, so a shared process would cross-contaminate dedupe state.
 *
 * Node for build + spawn is `FLUE_NODE_BIN ?? process.execPath`; Flue needs
 * Node >= 22.19, so the adapter validates the version and fails with a message
 * naming `FLUE_NODE_BIN` when it is too old.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FLUE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'flue');
const DIST_NODE_DIR = join(REPO_ROOT, 'dist-node');
const SERVER_ENTRY = join(DIST_NODE_DIR, 'server.mjs');
const EVENTS_PATH = '/channels/slack/events';
const ADMIN_TOKEN = 'parity-admin-token';

const MIN_NODE: readonly number[] = [22, 19, 0];

/** Idle/cap windows for `quiesce()`, tuned per scenario transport realities. */
const NORMAL_IDLE_MS = 1000;
const NORMAL_CAP_MS = 20_000;
// A provider-500 turn retries the transient 5xx up to 3× with exponential
// backoff (~2s, ~3.5s, ~7s gaps; ~14s total — see @flue/runtime
// modelRetryDelayMs). The idle window must sit comfortably above the largest
// inter-call gap so the retry pause is never mistaken for wire-idle, with a
// generous cap for the whole turn plus one idle window.
const PROVIDER_FAILURE_IDLE_MS = 12_000;
const PROVIDER_FAILURE_CAP_MS = 60_000;

let buildPromise: Promise<void> | undefined;

export const laneB: Lane = {
  name: 'lane-b',
  async start(config: ScenarioLaneConfig): Promise<LaneInstance> {
    const nodeBin = process.env.FLUE_NODE_BIN ?? process.execPath;
    assertNodeVersion(nodeBin);
    await ensureBuilt(nodeBin);

    const backend = new FakeSlackBackend({
      ...(config.slack ? { slack: config.slack } : {}),
      ...(config.provider ? { provider: config.provider } : {}),
    });
    const fake = await backend.listen();
    let configDir: string | undefined;
    const configEnv: Record<string, string> = {};
    if (config.configSeed) {
      configDir = mkdtempSync(join(tmpdir(), 'chickpea-parity-config-'));
      const configDbPath = join(configDir, 'state.db');
      const store = new SqliteConfigStore(configDbPath, config.configSeed);
      store.close();
      configEnv.SLACK_STATE_DB_PATH = configDbPath;
    }

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const eventsUrl = `${baseUrl}${EVENTS_PATH}`;

    // `undefined` (omitted) → default bot id; `null` → boot WITHOUT a bot id.
    // An explicitly-empty SLACK_BOT_USER_ID is the Flue channel's fail-closed
    // knob (skips the auth.test fallback that would otherwise resolve U_BOT).
    const slackBotUserId =
      config.botUserId === undefined ? 'U_BOT' : (config.botUserId ?? '');

    // Scrub ambient provider credentials so provider-key availability never
    // leaks from a developer/CI shell into scenarios. Scenario model routing is
    // explicit via pinned local-stub models, with SLACK_TAG_MODEL left only for
    // the one unpinned fallback scenario.
    const ambientEnv = { ...process.env };
    delete ambientEnv.ANTHROPIC_API_KEY;
    delete ambientEnv.ANTHROPIC_BASE_URL;
    delete ambientEnv.CLOUDFLARE_API_TOKEN;
    delete ambientEnv.CLOUDFLARE_ACCOUNT_ID;
    delete ambientEnv.CLOUDFLARE_WORKERS_AI_BASE_URL;

    const child = spawn(nodeBin, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...ambientEnv,
        PORT: String(port),
        SLACK_SIGNING_SECRET: PARITY_SIGNING_SECRET,
        SLACK_BOT_TOKEN: 'test-bot-token',
        SLACK_API_URL: `${fake.url}/api/`,
        LOCAL_STUB_URL: `${fake.url}/v1`,
        SLACK_TAG_MODEL: 'local-stub/parity-stub-1',
        SLACK_BOT_USER_ID: slackBotUserId,
        // Pin the internal agent token so the in-process channel → agent hop
        // and its guarded route agree deterministically.
        TAG_AGENT_API_TOKEN: 'parity-internal-token',
        TAG_ADMIN_TOKEN: ADMIN_TOKEN,
        // `src/db.ts` uses file-backed persistence by default. Every Lane B
        // scenario spawns a fresh process, so pin
        // an in-memory DB to keep each scenario's conversation state isolated
        // (a shared file would cross-contaminate).
        TAG_DB_PATH: ':memory:',
        ...configEnv,
        ...(config.env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverOutput = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });

    try {
      await waitForReady(child, eventsUrl, () => serverOutput);
    } catch (error) {
      await stopChild(child);
      await backend.close();
      if (configDir) rmSync(configDir, { recursive: true, force: true });
      throw error;
    }

    const providerFailure = config.provider?.mode === 'http_500';
    const idleMs = providerFailure ? PROVIDER_FAILURE_IDLE_MS : NORMAL_IDLE_MS;
    const capMs = providerFailure ? PROVIDER_FAILURE_CAP_MS : NORMAL_CAP_MS;

    return {
      backend,
      async postEvent(payload, opts) {
        const { headers, body } = await signedInit(payload, opts?.tamper === true);
        const response = await fetch(eventsUrl, { method: 'POST', headers, body });
        return responseResult(response);
      },
      async adminRequest(path, init = {}) {
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${ADMIN_TOKEN}`);
        if (init.body !== undefined && !headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
        const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
        return responseResult(response);
      },
      quiesce: () => backend.quiesce(idleMs, capMs),
      async stop() {
        await stopChild(child);
        await backend.close();
        if (configDir) rmSync(configDir, { recursive: true, force: true });
      },
    };
  },
};

/**
 * Reuse the shared Slack v0 request signer (tests/parity/lane.ts, lane-agnostic),
 * then flatten the Request into a fetch init. The body is read back from the
 * signed Request verbatim (`request.text()`) so the exact bytes the HMAC was
 * computed over are what we POST — no re-serialization drift.
 */
async function signedInit(
  payload: unknown,
  tamper: boolean,
): Promise<{ headers: Record<string, string>; body: string }> {
  const request = signSlackRequest(payload, tamper ? { tamper: true } : {});
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await request.text();
  return { headers, body };
}

async function responseResult(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function ensureBuilt(nodeBin: string): Promise<void> {
  if (!buildPromise) {
    buildPromise = buildNodeTarget(nodeBin);
  }
  return buildPromise;
}

/** `flue build --target node --output dist-node`, run once via `nodeBin`. */
function buildNodeTarget(nodeBin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FLUE_BIN, ['build', '--target', 'node', '--output', 'dist-node'], {
      cwd: REPO_ROOT,
      // The flue bin is `#!/usr/bin/env node`; prefix PATH so its shebang picks
      // up the validated Node (>=22.19) rather than the default local Node.
      env: { ...process.env, PATH: `${dirname(nodeBin)}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`flue build --target node failed (exit ${code}):\n${output}`));
      }
    });
  });
}

function assertNodeVersion(nodeBin: string): void {
  let raw: string;
  try {
    raw = execFileSync(nodeBin, ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(
      `Lane B could not run \`${nodeBin} --version\`. Set FLUE_NODE_BIN to a Node ` +
        `>= 22.19 binary. Cause: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parts = raw.replace(/^v/, '').split('.').map((piece) => Number(piece));
  if (compareVersion(parts, MIN_NODE) < 0) {
    throw new Error(
      `Lane B needs Node >= 22.19 to build and run the Flue app, but ${nodeBin} is ` +
        `${raw}. Set FLUE_NODE_BIN to a newer Node (e.g. FLUE_NODE_BIN=/path/to/node npm test).`,
    );
  }
}

function compareVersion(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
        } else {
          resolve(port);
        }
      });
    });
  });
}

/** Poll a signed url_verification (no wire calls) until the server answers 200. */
async function waitForReady(
  child: ChildProcess,
  eventsUrl: string,
  getOutput: () => string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Lane B server exited early (exit ${child.exitCode}):\n${getOutput()}`,
      );
    }
    try {
      const { headers, body } = await signedInit(
        { type: 'url_verification', challenge: 'lane-b-ready' },
        false,
      );
      const response = await fetch(eventsUrl, { method: 'POST', headers, body });
      await response.text();
      if (response.status === 200) {
        return;
      }
    } catch {
      // Server not accepting connections yet.
    }
    await delay(200);
  }
  throw new Error(`Lane B server never became ready:\n${getOutput()}`);
}

function stopChild(child: ChildProcess): Promise<void> {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
