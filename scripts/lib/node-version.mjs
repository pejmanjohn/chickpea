import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One reproducible baseline. Later Node 24 updates are supported, not a matrix.
export const NODE_BASELINE = readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim();
export const NODE_ENGINE = `>=${NODE_BASELINE} <25`;
export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match || Number(match[1]) !== 24) return false;
  const parts = match.slice(1).map(Number), minimum = NODE_BASELINE.split('.').map(Number);
  return parts[1] > minimum[1] || (parts[1] === minimum[1] && parts[2] >= minimum[2]);
}

export function assertNodeVersion(version = process.version, { baseline = false } = {}) {
  if (!isSupportedNodeVersion(version) || (baseline && version.replace(/^v/, '') !== NODE_BASELINE)) {
    throw new Error(`Chickpea requires Node ${baseline ? NODE_BASELINE : `24.x (${NODE_ENGINE})`}; found ${version}. Run nvm install && nvm use from the repository, or put Node ${NODE_BASELINE} first on PATH.`);
  }
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertNodeVersion(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
