import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  mintSetupCapability,
  setupCapabilityUrl,
} from '../../src/auth/setup-capability.mjs';

export const LOCAL_WORKER_LANE_SCHEMA = 'chickpea-local-worker-lane/v1';
export const LOCAL_WORKER_RUNTIME = 'cloudflare-vite/workerd';
export const LOCAL_WORKER_TRANSPORT = 'slack-http-events';
export const DEFAULT_LOCAL_WORKER_MODEL = 'cloudflare/@cf/openai/gpt-oss-120b';

const LANE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TUNNEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SLACK_ID_PATTERN = /^[A-Z][A-Z0-9]{2,63}$/;

function requiredText(value, label) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

export function validateLocalLaneName(value) {
  const lane = requiredText(value, 'Local lane');
  if (!LANE_PATTERN.test(lane)) {
    throw new Error('Local lane must start with a lowercase letter and use only lowercase letters, numbers, and dashes.');
  }
  return lane;
}

export function validateTunnelName(value) {
  const tunnel = requiredText(value, 'Tunnel name');
  if (!TUNNEL_PATTERN.test(tunnel)) {
    throw new Error('Tunnel name must use only letters, numbers, dashes, and underscores.');
  }
  return tunnel;
}

export function validateLocalPublicUrl(value) {
  const raw = requiredText(value, 'Public URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Public URL must be a valid HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Public URL must be a credential-free HTTPS origin without a query or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (url.pathname !== '/') throw new Error('Public URL must not include a path.');
  return url.origin;
}

export function validateLocalPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('Local port must be an integer from 1024 through 65535.');
  }
  return port;
}

export function resolveLocalLanePaths(projectRoot, laneValue) {
  const lane = validateLocalLaneName(laneValue);
  const root = path.resolve(projectRoot, '.wrangler-state', 'local', lane);
  return {
    lane,
    root,
    manifest: path.join(root, 'lane.json'),
    state: path.join(root, 'state'),
    devVars: path.join(root, 'dev.vars'),
    setupLink: path.join(root, 'setup-link.txt'),
    metrics: path.join(root, 'metrics.jsonl'),
    wranglerConfig: path.join(root, 'wrangler.local.json'),
    worktreeDevVars: path.resolve(projectRoot, '.dev.vars'),
  };
}

export function localD1DatabaseId(projectRoot, laneValue) {
  const lane = validateLocalLaneName(laneValue);
  const digest = createHash('sha256')
    .update(`${path.resolve(projectRoot)}\0${lane}`)
    .digest('hex')
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}

export function localLaneLockPath(publicUrl) {
  const digest = createHash('sha256').update(validateLocalPublicUrl(publicUrl)).digest('hex').slice(0, 20);
  return path.join(tmpdir(), `chickpea-local-worker-${digest}.lock`);
}

export function createLocalLaneManifest(input) {
  const projectRoot = path.resolve(requiredText(input.projectRoot, 'Project root'));
  const paths = resolveLocalLanePaths(projectRoot, input.lane);
  return {
    schemaVersion: LOCAL_WORKER_LANE_SCHEMA,
    lane: paths.lane,
    runtime: LOCAL_WORKER_RUNTIME,
    transport: LOCAL_WORKER_TRANSPORT,
    publicUrl: validateLocalPublicUrl(input.publicUrl),
    tunnelName: validateTunnelName(input.tunnelName),
    port: validateLocalPort(input.port ?? 8787),
    owningWorktree: projectRoot,
    statePath: paths.state,
    d1DatabaseId: localD1DatabaseId(projectRoot, paths.lane),
    model: DEFAULT_LOCAL_WORKER_MODEL,
    createdAt: input.createdAt ?? new Date().toISOString(),
    slack: null,
  };
}

export function validateLocalLaneManifest(value, projectRoot, expectedLane) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== LOCAL_WORKER_LANE_SCHEMA) {
    throw new Error('Local lane manifest is missing or has an unsupported schema.');
  }
  const lane = validateLocalLaneName(value.lane);
  if (expectedLane && lane !== validateLocalLaneName(expectedLane)) {
    throw new Error(`Local lane manifest selects ${lane}, not ${expectedLane}.`);
  }
  const owner = path.resolve(requiredText(value.owningWorktree, 'Owning worktree'));
  const actualRoot = path.resolve(projectRoot);
  if (owner !== actualRoot) {
    throw new Error(`Local lane ${lane} belongs to ${owner}, not ${actualRoot}.`);
  }
  const paths = resolveLocalLanePaths(actualRoot, lane);
  if (path.resolve(requiredText(value.statePath, 'State path')) !== paths.state) {
    throw new Error(`Local lane ${lane} state does not belong to its owning worktree.`);
  }
  const d1DatabaseId = localD1DatabaseId(actualRoot, lane);
  if (value.runtime !== LOCAL_WORKER_RUNTIME || value.transport !== LOCAL_WORKER_TRANSPORT) {
    throw new Error(`Local lane ${lane} runtime or Slack transport has drifted.`);
  }
  if (value.model !== DEFAULT_LOCAL_WORKER_MODEL) {
    throw new Error(`Local lane ${lane} model reference has drifted.`);
  }
  if (value.d1DatabaseId !== d1DatabaseId) {
    throw new Error(`Local lane ${lane} D1 identity does not belong to its owning worktree.`);
  }
  const manifest = {
    ...value,
    lane,
    runtime: LOCAL_WORKER_RUNTIME,
    transport: LOCAL_WORKER_TRANSPORT,
    publicUrl: validateLocalPublicUrl(value.publicUrl),
    tunnelName: validateTunnelName(value.tunnelName),
    port: validateLocalPort(value.port),
    owningWorktree: owner,
    statePath: paths.state,
    d1DatabaseId,
    model: DEFAULT_LOCAL_WORKER_MODEL,
  };
  if (manifest.slack !== null) {
    const workspaceId = requiredText(manifest.slack?.workspaceId, 'Slack workspace ID');
    const appId = requiredText(manifest.slack?.appId, 'Slack app ID');
    if (!SLACK_ID_PATTERN.test(workspaceId) || !SLACK_ID_PATTERN.test(appId)) {
      throw new Error('Slack workspace and app IDs must be immutable Slack IDs.');
    }
    manifest.slack = {
      workspaceId,
      workspaceLabel: requiredText(manifest.slack.workspaceLabel, 'Slack workspace label'),
      appId,
      appLabel: requiredText(manifest.slack.appLabel, 'Slack app label'),
    };
  }
  return manifest;
}

export function readLocalLaneManifest(projectRoot, lane) {
  const paths = resolveLocalLanePaths(projectRoot, lane);
  if (!existsSync(paths.manifest)) {
    throw new Error(`Local lane ${paths.lane} is not initialized in this worktree.`);
  }
  return validateLocalLaneManifest(
    JSON.parse(readFileSync(paths.manifest, 'utf8')),
    projectRoot,
    paths.lane,
  );
}

export async function initializeLocalLane(input) {
  const manifest = createLocalLaneManifest(input);
  const paths = resolveLocalLanePaths(manifest.owningWorktree, manifest.lane);
  if (existsSync(paths.manifest)) {
    const existing = readLocalLaneManifest(manifest.owningWorktree, manifest.lane);
    const same = ['publicUrl', 'tunnelName', 'port', 'owningWorktree', 'statePath']
      .every((key) => existing[key] === manifest[key]);
    if (!same) {
      throw new Error(`Local lane ${manifest.lane} already exists with different immutable coordinates.`);
    }
    ensureWorktreeDevVarsLink(paths);
    return { manifest: existing, paths, created: false };
  }

  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const setup = await mintSetupCapability();
  const authSecret = randomBytes(32).toString('base64url');
  const credentialKey = randomBytes(32).toString('base64url');
  const devVars = [
    `CHICKPEA_AUTH_SECRET=${authSecret}`,
    'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID=key_v1',
    `CHICKPEA_CREDENTIAL_KEY_KEY_V1=${credentialKey}`,
    `CHICKPEA_SETUP_CAPABILITY_DIGEST=${setup.digest}`,
    `CHICKPEA_SETUP_CAPABILITY_ISSUED_AT=${setup.issuedAt}`,
    `SLACK_TAG_PUBLIC_URL=${manifest.publicUrl}`,
    'CHICKPEA_TELEMETRY_ENVIRONMENT=development',
    '',
  ].join('\n');
  writePrivateFile(paths.devVars, devVars);
  writePrivateFile(paths.setupLink, `${setupCapabilityUrl(manifest.publicUrl, setup.capability)}\n`);
  writePrivateFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  ensureWorktreeDevVarsLink(paths);
  return { manifest, paths, created: true };
}

export function bindLocalLaneSlack(projectRoot, lane, slack) {
  const manifest = readLocalLaneManifest(projectRoot, lane);
  const next = validateLocalLaneManifest({ ...manifest, slack }, projectRoot, lane);
  if (manifest.slack && (
    manifest.slack.workspaceId !== next.slack.workspaceId ||
    manifest.slack.appId !== next.slack.appId
  )) {
    throw new Error(
      `Local lane ${manifest.lane} is already bound to a different immutable Slack workspace/app pair.`,
    );
  }
  const paths = resolveLocalLanePaths(projectRoot, lane);
  writePrivateFile(paths.manifest, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function renewLocalLaneSetup(projectRoot, lane) {
  const manifest = readLocalLaneManifest(projectRoot, lane);
  const paths = resolveLocalLanePaths(projectRoot, lane);
  const setup = await mintSetupCapability();
  const current = readFileSync(paths.devVars, 'utf8');
  const replacements = new Map([
    ['CHICKPEA_SETUP_CAPABILITY_DIGEST', setup.digest],
    ['CHICKPEA_SETUP_CAPABILITY_ISSUED_AT', String(setup.issuedAt)],
  ]);
  writePrivateFile(paths.devVars, replaceDevVars(current, replacements));
  writePrivateFile(paths.setupLink, `${setupCapabilityUrl(manifest.publicUrl, setup.capability)}\n`);
  return { manifest, paths };
}

export async function relocateUnboundLocalLane(projectRoot, lane, input) {
  const manifest = readLocalLaneManifest(projectRoot, lane);
  if (manifest.slack !== null) {
    throw new Error(`Local lane ${manifest.lane} is already Slack-bound; create a new lane instead of changing its endpoint.`);
  }
  const next = validateLocalLaneManifest({
    ...manifest,
    publicUrl: input.publicUrl,
    tunnelName: input.tunnelName ?? manifest.tunnelName,
  }, projectRoot, lane);
  const paths = resolveLocalLanePaths(projectRoot, lane);
  const current = readFileSync(paths.devVars, 'utf8');
  const setup = await mintSetupCapability();
  const devVars = replaceDevVars(current, new Map([
    ['CHICKPEA_SETUP_CAPABILITY_DIGEST', setup.digest],
    ['CHICKPEA_SETUP_CAPABILITY_ISSUED_AT', String(setup.issuedAt)],
    ['SLACK_TAG_PUBLIC_URL', next.publicUrl],
  ]));
  writePrivateFile(paths.devVars, devVars);
  writePrivateFile(paths.setupLink, `${setupCapabilityUrl(next.publicUrl, setup.capability)}\n`);
  writePrivateFile(paths.manifest, `${JSON.stringify(next, null, 2)}\n`);
  ensureWorktreeDevVarsLink(paths);
  return { manifest: next, paths };
}

export function ensureWorktreeDevVarsLink(paths) {
  const expected = path.relative(path.dirname(paths.worktreeDevVars), paths.devVars);
  if (existsSync(paths.worktreeDevVars)) {
    const stat = lstatSync(paths.worktreeDevVars);
    if (!stat.isSymbolicLink() || readlinkSync(paths.worktreeDevVars) !== expected) {
      throw new Error(`Refusing to replace existing ${paths.worktreeDevVars}; preserve or relocate it first.`);
    }
    return;
  }
  symlinkSync(expected, paths.worktreeDevVars);
}

export function worktreeDevVarsLinkStatus(paths) {
  const expected = path.relative(path.dirname(paths.worktreeDevVars), paths.devVars);
  if (!existsSync(paths.worktreeDevVars)) return 'missing';
  const stat = lstatSync(paths.worktreeDevVars);
  if (!stat.isSymbolicLink()) return 'conflict';
  return readlinkSync(paths.worktreeDevVars) === expected ? 'ready' : 'conflict';
}

export function localWorkerViteSettings(env = process.env) {
  const lane = env.CHICKPEA_LOCAL_LANE?.trim();
  if (!lane) return undefined;
  return {
    lane: validateLocalLaneName(lane),
    publicUrl: validateLocalPublicUrl(env.CHICKPEA_LOCAL_PUBLIC_URL),
    tunnelName: validateTunnelName(env.CHICKPEA_LOCAL_TUNNEL_NAME),
    statePath: path.resolve(requiredText(env.CHICKPEA_LOCAL_STATE_PATH, 'Local state path')),
    d1DatabaseId: requiredText(env.CHICKPEA_LOCAL_D1_DATABASE_ID, 'Local D1 database ID'),
    port: validateLocalPort(env.CHICKPEA_LOCAL_PORT),
    sourceSha: requiredText(env.CHICKPEA_LOCAL_SOURCE_SHA, 'Local source SHA'),
  };
}

export function createLocalTimingObserver(file, lane, sourceSha, startedAt) {
  let buffer = '';
  let startupRecorded = false;
  let reloadStartedAt = null;
  let hotUpdateStartedAt = null;
  const observe = (chunk) => {
    buffer += stripAnsi(String(chunk));
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const ready = line.match(/ready in\s+(\d+)\s+ms/i);
      if (!startupRecorded && ready) {
        startupRecorded = true;
        writeFileSync(file, `${JSON.stringify({
          kind: 'startup', lane, sourceSha,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          viteReportedMs: Number(ready[1]),
        })}\n`, { flag: 'a', mode: 0o600 });
      }
      if (line.includes('changed, restarting server')) reloadStartedAt = Date.now();
      if (reloadStartedAt !== null && line.includes('server restarted')) {
        writeFileSync(file, `${JSON.stringify({
          kind: 'reload', lane, sourceSha,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - reloadStartedAt,
        })}\n`, { flag: 'a', mode: 0o600 });
        reloadStartedAt = null;
      }
      if (hotUpdateStartedAt !== null && /\bhmr update\b|\bhot updated\b/i.test(line)) {
        writeFileSync(file, `${JSON.stringify({
          kind: 'reload', lane, sourceSha,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - hotUpdateStartedAt,
          mode: 'hot-update',
        })}\n`, { flag: 'a', mode: 0o600 });
        hotUpdateStartedAt = null;
      }
    }
  };
  observe.noteSourceChange = (at = Date.now()) => {
    hotUpdateStartedAt = at;
  };
  return observe;
}

function writePrivateFile(file, contents) {
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function replaceDevVars(current, replacements) {
  const seen = new Set();
  const lines = current.trimEnd().split('\n').map((line) => {
    const separator = line.indexOf('=');
    const name = separator === -1 ? line : line.slice(0, separator);
    if (!replacements.has(name)) return line;
    seen.add(name);
    return `${name}=${replacements.get(name)}`;
  });
  for (const [name, value] of replacements) {
    if (!seen.has(name)) lines.push(`${name}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}
