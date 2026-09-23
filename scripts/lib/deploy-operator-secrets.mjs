/**
 * Operator-supplied Worker secrets for a guarded deployment.
 *
 * A QA lane sometimes needs a provider credential that the product reads from
 * the environment, for example BROWSERBASE_API_KEY. Uploading it with the
 * Wrangler secret command outside the wrapper creates a new live Worker
 * version behind the lane registry's back, and every later guarded deploy and
 * attestation then refuses with a serving-version mismatch. Carrying the
 * secret inside the wrapper's own `--secrets-file` keeps one version per
 * deploy, so the receipt and the live Worker stay identical.
 *
 * The file is an owner-only JSON object of string values in an owner-only
 * directory. Names are plain environment identifiers. The wrapper's managed
 * authority names cannot be overridden here.
 */
import { isAbsolute } from 'node:path';

import { readPrivateJson } from './upgrade-receipt.mjs';

export const OPERATOR_SECRETS_ENV = 'CHICKPEA_DEPLOY_SECRETS_FILE';

const NAME = /^[A-Z][A-Z0-9_]*$/;
const MAX_SECRETS = 32;
const MAX_VALUE_LENGTH = 4096;
const RESERVED_PREFIXES = ['CHICKPEA_'];

export function readOperatorSecretsFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error(`${OPERATOR_SECRETS_ENV} must be an absolute path to an owner-only JSON file.`);
  }
  if (!isAbsolute(filePath)) {
    throw new Error(`${OPERATOR_SECRETS_ENV} must be an absolute path.`);
  }
  // Both the file and its directory must be private and owner-controlled.
  const parsed = readPrivateJson(filePath, { label: OPERATOR_SECRETS_ENV });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${OPERATOR_SECRETS_ENV} must contain one JSON object of string values.`);
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error(`${OPERATOR_SECRETS_ENV} names no secrets.`);
  if (entries.length > MAX_SECRETS) throw new Error(`${OPERATOR_SECRETS_ENV} names too many secrets.`);
  const secrets = {};
  for (const [name, value] of entries) {
    if (!NAME.test(name)) throw new Error(`${OPERATOR_SECRETS_ENV}: "${name}" is not a valid secret name.`);
    if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new Error(`${OPERATOR_SECRETS_ENV}: "${name}" is managed by the deployment wrapper and cannot be supplied here.`);
    }
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_VALUE_LENGTH) {
      throw new Error(`${OPERATOR_SECRETS_ENV}: "${name}" must be a non-empty string.`);
    }
    secrets[name] = value;
  }
  return secrets;
}

/** Merge wrapper-generated secrets with operator secrets; the wrapper's win. */
export function mergeDeploymentSecrets(generated, operator) {
  const merged = { ...(operator ?? {}) };
  for (const [name, value] of Object.entries(generated ?? {})) merged[name] = value;
  return merged;
}
