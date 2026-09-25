#!/usr/bin/env node
/**
 * Private operator files for Claude Code cloud sessions.
 *
 * The guarded deploy and the lane tooling read owner-only files that exist
 * only on the maintainer's machine: the lane secrets file, the lane credential
 * files, and the seed manifest. A cloud session starts from a fresh VM whose
 * only configuration is environment variables, so the SessionStart hook
 * (scripts/cloud-session-start.sh) runs this script to write those files from
 * base64 variables, at the paths the readers already use:
 *
 *   CHICKPEA_QA_SECRETS_ENV_B64    ~/.chickpea/qa-secrets.env
 *   CHICKPEA_LANE_CREDENTIALS_B64  ~/.chickpea/lane-credentials/<lane>-live.json
 *                                  and <lane>-seed.json, from one JSON object
 *                                  keyed by file name
 *   CHICKPEA_QA_SEED_JSON_B64      ~/.chickpea/qa-seed.json
 *
 * It writes only when CLAUDE_CODE_REMOTE=true. An absent or empty variable is
 * skipped without a word. A present but malformed one fails the session
 * start, naming the variable and never its value. Each file is checked by the
 * reader that will consume it before it lands, written 0600 under a 0700
 * directory, and rechecked with assertPrivatePath afterwards, so the readers
 * accept it exactly as they accept the maintainer's own files. Output names
 * files and counts only.
 *
 *   node scripts/cloud-private-home.mjs           # cloud session: write the files
 *   node scripts/cloud-private-home.mjs encode    # maintainer: print the variables
 *
 * `encode` reads the maintainer's own files and prints NAME=value lines for
 * the cloud environment's variables. Those lines carry the secrets: paste them
 * into the environment and keep them out of shells, logs, and Git. Line breaks
 * inside a value are ignored, so a wrapped base64 value is fine.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultSeedManifest, parseManifest } from './lane-seed.mjs';
import {
  defaultLaneSecretsFile,
  LANE_CREDENTIALS_DIR_ENV,
  laneCredentialsDirectory,
  parseLaneSecrets,
  readLaneSecretEntries,
  readLaneSeedToken,
} from './lib/lane-secrets.mjs';
import { QA_LANES } from './lib/qa-lanes.mjs';
import { assertPrivatePath } from './lib/upgrade-receipt.mjs';

export const REMOTE_SESSION_ENV = 'CLAUDE_CODE_REMOTE';
export const QA_SECRETS_ENV_VARIABLE = 'CHICKPEA_QA_SECRETS_ENV_B64';
export const LANE_CREDENTIALS_VARIABLE = 'CHICKPEA_LANE_CREDENTIALS_B64';
export const QA_SEED_JSON_VARIABLE = 'CHICKPEA_QA_SEED_JSON_B64';
export const LANE_CREDENTIAL_FILE = new RegExp(`^(${QA_LANES.join('|')})-(live|seed)\\.json$`, 'u');

const PREFIX = 'cloud-private-home';
const MAX_ENCODED_LENGTH = 1024 * 1024;
const SECRETS_LABEL = 'The lane secrets file';
const CREDENTIALS_LABEL = 'The lane credentials directory';
const MANIFEST_LABEL = 'The seed manifest';
const USAGE = [
  'Usage: node scripts/cloud-private-home.mjs [encode]',
  '  (no argument)  In a Claude Code cloud session (CLAUDE_CODE_REMOTE=true), write the',
  `                 operator's private ~/.chickpea files from ${QA_SECRETS_ENV_VARIABLE},`,
  `                 ${LANE_CREDENTIALS_VARIABLE}, and ${QA_SEED_JSON_VARIABLE}.`,
  '  encode         Print those variables from the files on this machine (carries secrets).',
].join('\n');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Decode one base64 variable to text. Undefined when absent or blank; throws naming the variable, never the value. */
export function decodeVariable(env, name) {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const compact = String(raw).replace(/\s+/gu, '');
  if (compact === '') return undefined;
  if (compact.length > MAX_ENCODED_LENGTH) throw new Error(`${name} exceeds its size limit.`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact) || compact.length % 4 !== 0) throw new Error(`${name} is not base64.`);
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64') !== compact) throw new Error(`${name} is not base64.`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${name} does not decode to UTF-8 text.`); }
  if (text.includes('\0')) throw new Error(`${name} decodes to binary, not text.`);
  return text;
}

function withVariable(name, work) {
  try {
    return work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith(name) ? message : `${name}: ${message}`);
  }
}

/**
 * Stage text as a 0600 temporary file beside its destination. `validate` sees
 * the temporary path, so a file its reader rejects never lands; `commit`
 * renames it into place and rechecks it. Refuses a symlink or a shared
 * directory rather than following it.
 */
function stagePrivateText(file, text, { label, validate, report }) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivatePath(directory, { directory: true, label });
  if (existsSync(file)) assertPrivatePath(file, { label });
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const discard = () => { if (existsSync(temporary)) unlinkSync(temporary); };
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    validate?.(temporary);
  } catch (error) {
    discard();
    throw error;
  }
  return {
    discard,
    commit: () => {
      renameSync(temporary, file);
      assertPrivatePath(file, { label });
      return `wrote ${file}${report ? ` (${report})` : ''}`;
    },
  };
}

/** The bundle behind CHICKPEA_LANE_CREDENTIALS_B64: a JSON object keyed by lane credential file name. */
export function parseLaneCredentialBundle(text) {
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error(`${LANE_CREDENTIALS_VARIABLE} is not readable JSON.`); }
  if (!isPlainObject(bundle)) throw new Error(`${LANE_CREDENTIALS_VARIABLE} must be a JSON object keyed by file name.`);
  Object.keys(bundle).forEach((name, index) => {
    if (!LANE_CREDENTIAL_FILE.test(name)) {
      throw new Error(`${LANE_CREDENTIALS_VARIABLE}: entry ${index + 1} is not a lane credential file name (<lane>-live.json or <lane>-seed.json for ${QA_LANES.join(', ')}).`);
    }
    if (!isPlainObject(bundle[name])) throw new Error(`${LANE_CREDENTIALS_VARIABLE}: ${name} must be a JSON object.`);
  });
  return bundle;
}

/** The reader's view of one credential file in `directory`; throws without echoing values. */
function validateLaneCredential(name, value, directory) {
  const [, lane, kind] = LANE_CREDENTIAL_FILE.exec(name);
  if (kind === 'seed') {
    try {
      readLaneSeedToken(lane, { env: { [LANE_CREDENTIALS_DIR_ENV]: directory } });
    } catch {
      throw new Error(`${LANE_CREDENTIALS_VARIABLE}: ${name} is not a lane seed token file (target "${lane}" and a seedToken).`);
    }
    return;
  }
  // resolveLaneAuthorityCredentials reads `origin` and `authorityReadToken`.
  const origin = typeof value.origin === 'string' ? value.origin.trim() : '';
  const token = typeof value.authorityReadToken === 'string' ? value.authorityReadToken.trim() : '';
  let url;
  try { url = new URL(origin); } catch { url = undefined; }
  if (!url || !/^https?:$/u.test(url.protocol) || !token) {
    throw new Error(`${LANE_CREDENTIALS_VARIABLE}: ${name} needs an http(s) origin and an authorityReadToken.`);
  }
}

function stageSecretsEnv(env, text) {
  const entries = parseLaneSecrets(text);
  return stagePrivateText(defaultLaneSecretsFile(env), text, {
    label: SECRETS_LABEL,
    validate: (temporary) => readLaneSecretEntries({ env: {}, file: temporary }),
    report: `${entries.size} names`,
  });
}

/**
 * Stage every credential file in a private sibling directory, where the real
 * readers validate them at their expected names; `commit` moves them in.
 */
function stageLaneCredentials(env, bundle) {
  const names = Object.keys(bundle).sort();
  const directory = laneCredentialsDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivatePath(directory, { directory: true, label: CREDENTIALS_LABEL });
  const staging = path.join(path.dirname(directory), `.${path.basename(directory)}.${randomBytes(8).toString('hex')}.tmp`);
  mkdirSync(staging, { mode: 0o700 });
  const discard = () => rmSync(staging, { recursive: true, force: true });
  try {
    for (const name of names) {
      writeFileSync(path.join(staging, name), `${JSON.stringify(bundle[name], null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    }
    for (const name of names) validateLaneCredential(name, bundle[name], staging);
    for (const name of names) {
      if (existsSync(path.join(directory, name))) assertPrivatePath(path.join(directory, name), { label: CREDENTIALS_LABEL });
    }
  } catch (error) {
    discard();
    throw error;
  }
  return {
    discard,
    commit: () => {
      try {
        for (const name of names) {
          const file = path.join(directory, name);
          renameSync(path.join(staging, name), file);
          assertPrivatePath(file, { label: CREDENTIALS_LABEL });
        }
      } finally {
        discard();
      }
      return `wrote ${names.join(', ')} in ${directory}`;
    },
  };
}

function stageSeedManifest(text) {
  const connections = parseManifest(text);
  return stagePrivateText(defaultSeedManifest(), text, { label: MANIFEST_LABEL, report: `${connections.length} connections` });
}

/**
 * Write the private files a cloud session's environment carries. Every
 * variable is decoded, parsed, and staged past its reader before any file
 * lands, so one malformed variable refuses the whole step and leaves nothing
 * behind. Returns the lines to report.
 */
export function materializePrivateHome(env = process.env) {
  const written = [];
  if (env[REMOTE_SESSION_ENV] !== 'true') return { remote: false, written };
  const secretsText = withVariable(QA_SECRETS_ENV_VARIABLE, () => {
    const text = decodeVariable(env, QA_SECRETS_ENV_VARIABLE);
    if (text !== undefined) parseLaneSecrets(text);
    return text;
  });
  const bundle = withVariable(LANE_CREDENTIALS_VARIABLE, () => {
    const text = decodeVariable(env, LANE_CREDENTIALS_VARIABLE);
    return text === undefined ? undefined : parseLaneCredentialBundle(text);
  });
  const manifestText = withVariable(QA_SEED_JSON_VARIABLE, () => {
    const text = decodeVariable(env, QA_SEED_JSON_VARIABLE);
    if (text !== undefined) parseManifest(text);
    return text;
  });
  const staged = [];
  try {
    if (secretsText !== undefined) staged.push(withVariable(QA_SECRETS_ENV_VARIABLE, () => stageSecretsEnv(env, secretsText)));
    if (bundle !== undefined && Object.keys(bundle).length > 0) {
      staged.push(withVariable(LANE_CREDENTIALS_VARIABLE, () => stageLaneCredentials(env, bundle)));
    }
    if (manifestText !== undefined) staged.push(withVariable(QA_SEED_JSON_VARIABLE, () => stageSeedManifest(manifestText)));
    for (const stage of staged) written.push(stage.commit());
  } finally {
    for (const stage of staged) stage.discard();
  }
  return { remote: true, written };
}

/** NAME=value lines for the cloud environment, from this machine's private files. */
export function encodePrivateHome(env = process.env) {
  const lines = [];
  const encode = (text) => Buffer.from(text, 'utf8').toString('base64');
  const secretsFile = defaultLaneSecretsFile(env);
  if (existsSync(secretsFile)) {
    readLaneSecretEntries({ env, file: secretsFile });
    lines.push(`${QA_SECRETS_ENV_VARIABLE}=${encode(readFileSync(secretsFile, 'utf8'))}`);
  }
  const directory = laneCredentialsDirectory(env);
  if (existsSync(directory)) {
    assertPrivatePath(directory, { directory: true, label: CREDENTIALS_LABEL });
    const bundle = {};
    for (const name of readdirSync(directory).filter((entry) => LANE_CREDENTIAL_FILE.test(entry)).sort()) {
      const file = path.join(directory, name);
      assertPrivatePath(file, { label: CREDENTIALS_LABEL });
      try { bundle[name] = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not readable JSON.`); }
    }
    parseLaneCredentialBundle(JSON.stringify(bundle));
    for (const name of Object.keys(bundle)) validateLaneCredential(name, bundle[name], directory);
    if (Object.keys(bundle).length > 0) lines.push(`${LANE_CREDENTIALS_VARIABLE}=${encode(JSON.stringify(bundle))}`);
  }
  const manifest = defaultSeedManifest();
  if (existsSync(manifest)) {
    const text = readFileSync(manifest, 'utf8');
    parseManifest(text);
    lines.push(`${QA_SEED_JSON_VARIABLE}=${encode(text)}`);
  }
  return lines;
}

export function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  const [command, ...rest] = argv;
  if (rest.length > 0 || (command !== undefined && command !== 'encode')) { console.error(USAGE); return 2; }
  try {
    if (command === 'encode') {
      const lines = encodePrivateHome();
      if (lines.length === 0) {
        console.error(`${PREFIX}: no private files under ${path.join(homedir(), '.chickpea')} to encode.`);
        return 1;
      }
      console.error(`${PREFIX}: the lines below carry secrets; paste them into the cloud environment's variables and discard them.`);
      console.log(lines.join('\n'));
      return 0;
    }
    for (const line of materializePrivateHome().written) console.log(`${PREFIX}: ${line}`);
    return 0;
  } catch (error) {
    console.error(`${PREFIX}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
