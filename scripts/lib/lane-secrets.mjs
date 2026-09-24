/**
 * Standing provider keys for QA lanes.
 *
 * Every registered lane should serve with the same provider keys, and those
 * keys must outlive any one installation: lanes are sometimes rebuilt from a
 * fresh install. The operator keeps them in one owner-only dotenv file outside
 * Git (default `~/.chickpea/qa-secrets.env`). Each guarded deploy to a claimed
 * lane reads it and carries the keys in the wrapper's atomic secrets file, the
 * same path as `CHICKPEA_DEPLOY_SECRETS_FILE`, so a rebuilt lane regains them
 * on its first deploy.
 *
 * A plain name is shared by every lane. `<LANE>__NAME` (for example
 * `COBALT__OPENAI_API_KEY`) overrides it for one lane. Empty values are
 * skipped, so a partly filled template is harmless. Only the Worker
 * environment names below are uploaded; other names (such as a connector token
 * that belongs in the database) stay in the file for a separate seeding step.
 * Names and short fingerprints are reported; values never are.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QA_LANES } from './qa-lanes.mjs';
import { assertPrivatePath } from './upgrade-receipt.mjs';

export const LANE_SECRETS_FILE_ENV = 'CHICKPEA_LANE_SECRETS_FILE';
export const LANE_SECRETS_TOGGLE_ENV = 'CHICKPEA_LANE_SECRETS';
export const LANE_SECRET_TARGETS = QA_LANES;
export const LANE_CREDENTIALS_DIR_ENV = 'CHICKPEA_LANE_CREDENTIALS_DIR';
export const LANE_SEED_TOKEN_BINDING = 'CHICKPEA_ENV_SEED_TOKEN';

// Provider keys the product reads from the Worker environment.
export const LANE_WORKER_SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'BROWSERBASE_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
];

// Keys tied to one lane's own provider project. Each lane is registered with
// its own Composio project and auth configs, so a shared value would point
// every lane at one project; only `<LANE>__NAME` is uploaded for these.
export const LANE_ONLY_SECRET_NAMES = ['COMPOSIO_API_KEY'];

const LABEL = 'The lane secrets file';
const NAME = /^[A-Z][A-Z0-9_]*$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_VALUE_LENGTH = 4096;

export function defaultLaneSecretsFile(env = process.env) {
  const explicit = env[LANE_SECRETS_FILE_ENV]?.trim();
  return explicit || path.join(homedir(), '.chickpea', 'qa-secrets.env');
}

/** Parse KEY=VALUE lines. Errors cite line numbers, never values. */
export function parseLaneSecrets(text) {
  const entries = new Map();
  text.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(line);
    if (!match) throw new Error(`${LABEL} has an unreadable line ${index + 1}; expected NAME=value.`);
    const name = match[1];
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else if (value.includes(' #')) {
      value = value.slice(0, value.indexOf(' #')).trim();
    }
    if (!NAME.test(name)) throw new Error(`${LABEL}: "${name}" on line ${index + 1} is not an upper-case name.`);
    if (entries.has(name)) throw new Error(`${LABEL} names "${name}" twice.`);
    if (value.length > MAX_VALUE_LENGTH) throw new Error(`${LABEL}: "${name}" is too long.`);
    entries.set(name, value);
  });
  return entries;
}

/**
 * Resolve the Worker secrets one lane receives. Returns undefined when the
 * file is absent or turned off, so lanes without it deploy exactly as before.
 */
export function resolveLaneSecrets(target, { env = process.env, file = defaultLaneSecretsFile(env) } = {}) {
  if (!laneSecretsEnabled(target, env)) return undefined;
  const entries = readLaneSecretEntries({ env, file });
  if (!entries) return undefined;
  const prefixes = LANE_SECRET_TARGETS.map((lane) => `${lane.toUpperCase()}__`);
  const own = `${target.toUpperCase()}__`;
  const secrets = {};
  const report = [];
  for (const name of LANE_WORKER_SECRET_NAMES) {
    const override = entries.get(`${own}${name}`);
    const shared = entries.get(name);
    const [value, source] = override ? [override, `${target} override`] : [shared, 'shared'];
    if (!value) continue;
    secrets[name] = value;
    report.push({ name, source, fingerprint: fingerprint(value) });
  }
  const warnings = [];
  for (const name of LANE_ONLY_SECRET_NAMES) {
    const override = entries.get(`${own}${name}`);
    if (override) {
      secrets[name] = override;
      report.push({ name, source: `${target} override`, fingerprint: fingerprint(override) });
    } else if (entries.get(name)) {
      warnings.push(`shared ${name} ignored; set ${own}${name} to this lane's own key`);
    }
  }
  // Names the file holds for this lane that never become Worker secrets (for
  // example keys `npm run lane:seed` reads). Another lane's names, and any
  // name that still carries a `PREFIX__` after this lane's own is removed,
  // are not this lane's to report.
  const held = [...entries.entries()]
    .filter(([, value]) => value)
    .map(([name]) => name)
    .map((name) => (name.startsWith(own) ? name.slice(own.length) : name))
    .filter((name, index, all) => !prefixes.some((prefix) => name.startsWith(prefix))
      && !name.includes('__')
      && !LANE_WORKER_SECRET_NAMES.includes(name) && !LANE_ONLY_SECRET_NAMES.includes(name)
      && all.indexOf(name) === index);
  return { file, secrets, report, held, warnings };
}

export function laneSecretsEnabled(target, env = process.env) {
  return LANE_SECRET_TARGETS.includes(target) && env[LANE_SECRETS_TOGGLE_ENV]?.trim() !== 'off';
}

/**
 * Read and validate the whole file. Returns undefined when the default file
 * is absent; an explicitly named file must exist.
 */
export function readLaneSecretEntries({ env = process.env, file = defaultLaneSecretsFile(env) } = {}) {
  if (!path.isAbsolute(file)) throw new Error(`${LANE_SECRETS_FILE_ENV} must be an absolute path.`);
  if (!existsSync(file)) {
    if (env[LANE_SECRETS_FILE_ENV]?.trim()) throw new Error(`${LABEL} named by ${LANE_SECRETS_FILE_ENV} does not exist.`);
    return undefined;
  }
  assertPrivatePath(path.dirname(file), { directory: true, label: LABEL });
  const stat = assertPrivatePath(file, { label: LABEL });
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${LABEL} exceeds its size limit.`);
  const entries = parseLaneSecrets(readFileSync(file, 'utf8'));
  const prefixes = LANE_SECRET_TARGETS.map((lane) => `${lane.toUpperCase()}__`);
  for (const name of entries.keys()) {
    const scoped = /^([A-Z0-9]+)__/u.exec(name);
    if (scoped && !prefixes.includes(`${scoped[1]}__`)) {
      throw new Error(`${LABEL}: "${name}" uses an unknown lane prefix. Use ${prefixes.join(', ')}.`);
    }
  }
  return entries;
}

/** A lane's value for one name: its `LANE__NAME` override, else the shared value. */
export function laneSecretValue(entries, target, name) {
  return entries.get(`${target.toUpperCase()}__${name}`) || entries.get(name) || undefined;
}

export function laneCredentialsDirectory(env = process.env) {
  return env[LANE_CREDENTIALS_DIR_ENV]?.trim() || path.join(homedir(), '.chickpea', 'lane-credentials');
}

function laneSeedTokenFile(target, env) {
  return path.join(laneCredentialsDirectory(env), `${target}-seed.json`);
}

const SEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SEED_LABEL = 'The lane seed token file';

/** The lane's seed token, or undefined before its first guarded deploy. */
export function readLaneSeedToken(target, { env = process.env } = {}) {
  if (!LANE_SECRET_TARGETS.includes(target)) throw new Error(`Unknown lane "${target}".`);
  const file = laneSeedTokenFile(target, env);
  if (!existsSync(file)) return undefined;
  assertPrivatePath(path.dirname(file), { directory: true, label: SEED_LABEL });
  assertPrivatePath(file, { label: SEED_LABEL });
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { parsed = undefined; }
  if (parsed?.target !== target || !SEED_TOKEN.test(parsed?.seedToken ?? '')) {
    throw new Error(`${SEED_LABEL} for ${target} is malformed. Preserve it and investigate before redeploying.`);
  }
  return parsed.seedToken;
}

/**
 * Keep one seed token per lane in the operator's owner-only lane credential
 * directory, creating it on the lane's first guarded deploy. The deploy
 * uploads it as CHICKPEA_ENV_SEED_TOKEN so `npm run lane:seed` can reach the
 * lane's seed route; the value is never printed.
 */
export function ensureLaneSeedToken(target, { env = process.env, randomBytes = nodeRandomBytes } = {}) {
  if (!laneSecretsEnabled(target, env)) return undefined;
  const existing = readLaneSeedToken(target, { env });
  if (existing) return existing;
  const directory = laneCredentialsDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivatePath(directory, { directory: true, label: SEED_LABEL });
  const seedToken = Buffer.from(randomBytes(32)).toString('base64url');
  writeFileSync(laneSeedTokenFile(target, env), `${JSON.stringify({
    schemaVersion: 'chickpea-lane-seed-token/v1',
    target,
    seedToken,
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return seedToken;
}

/** A short, non-reversible marker for comparing a key across lanes. */
export function fingerprint(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

export function describeLaneSecrets(resolved) {
  if (!resolved) return undefined;
  const uploaded = resolved.report.length === 0
    ? 'no provider keys set'
    : resolved.report.map((entry) => `${entry.name} (${entry.source}, ${entry.fingerprint})`).join(', ');
  const held = resolved.held.length ? `; held (not Worker secrets): ${resolved.held.join(', ')}` : '';
  const warnings = resolved.warnings?.length ? `; WARNING: ${resolved.warnings.join('; ')}` : '';
  return `Lane secrets from ${resolved.file}: ${uploaded}${held}${warnings}`;
}

// Preview without deploying: `node scripts/lib/lane-secrets.mjs <lane>...`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lanes = process.argv.slice(2);
  try {
    for (const lane of lanes.length ? lanes : LANE_SECRET_TARGETS) {
      if (!LANE_SECRET_TARGETS.includes(lane)) throw new Error(`Unknown lane "${lane}". Use ${LANE_SECRET_TARGETS.join(', ')}.`);
      const resolved = resolveLaneSecrets(lane);
      console.log(`${lane}: ${resolved ? describeLaneSecrets(resolved) : `no lane secrets file (${defaultLaneSecretsFile()})`}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
